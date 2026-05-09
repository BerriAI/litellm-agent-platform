/**
 * POST /api/v1/managed_agents/agents/{agent_id}/session
 *
 * Two paths:
 *
 *   warm  — claim a pre-provisioned Fargate task from the pool and run only
 *           the harness handshake (~5s on the happy path).
 *   cold  — fall through to the original RunTask + waits + harness flow
 *           (~40s; comment below). Used when the pool is disabled
 *           (`WARM_POOL_SIZE=0`), drained, has no warm task for this
 *           agent's config, or the request carries per-session `env_vars`
 *           that wouldn't be in a warm task's container env.
 *
 * Either way, we persist a `creating` Session row up front so an in-flight
 * failure leaves an auditable row rather than a silently orphaned task.
 *
 * Cold-path comment for context: ~50-120s end-to-end, ported from
 * litellm/proxy/managed_agents_endpoints/endpoints_sessions.py:create_session
 * but stripped of the multi-tenant key minting that lives in the upstream
 * Python proxy.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  runTask,
  waitHttpReady,
  waitRunningGetUrl,
} from "@/server/k8s";
import { putCachedSession } from "@/server/sessionCache";
import {
  expandMessage,
  harnessCreateSession,
  harnessSendMessage,
} from "@/server/harness";
import {
  CreateSessionBody,
  HttpError,
  httpError,
  toApiSession,
  type AgentRow,
  type HarnessMessageResponse,
  type SessionRow,
  type WarmTaskRow,
} from "@/server/types";
import {
  claimWarmTask,
  deleteClaimedWarmTask,
  markClaimedTaskDead,
} from "@/server/warmPool";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

interface BringUpResult {
  updated: SessionRow;
  response: HarnessMessageResponse | null;
}

interface BringUpBody {
  initial_prompt?: string;
  title?: string;
  env_vars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Cold path — RunTask + waits + harness session.
// ---------------------------------------------------------------------------

async function coldBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
): Promise<BringUpResult> {
  const { task_arn } = await runTask({
    agent,
    session_id,
    env_vars: body.env_vars,
  });
  await prisma.session.update({
    where: { session_id },
    data: { task_arn },
  });
  const sandbox_url = await waitRunningGetUrl(task_arn, agent);
  await waitHttpReady(sandbox_url);
  return finishBringUp(agent, session_id, body, sandbox_url);
}

// ---------------------------------------------------------------------------
// Warm path — task already running, just run the harness handshake.
// ---------------------------------------------------------------------------

async function warmBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  warm: WarmTaskRow,
): Promise<BringUpResult> {
  if (!warm.task_arn || !warm.sandbox_url) {
    // claim should have rejected rows in this state, but guard anyway —
    // we never want to write a Session row pointing at empty fields.
    throw new Error(
      `claimed warm task ${warm.warm_task_id} missing task_arn or sandbox_url`,
    );
  }
  // Persist the inherited task_arn immediately so reconcile attribution
  // works even if the harness call below fails.
  await prisma.session.update({
    where: { session_id },
    data: { task_arn: warm.task_arn },
  });
  return finishBringUp(agent, session_id, body, warm.sandbox_url);
}

// ---------------------------------------------------------------------------
// Shared finish — same harness handshake for both paths.
// ---------------------------------------------------------------------------

async function finishBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  sandbox_url: string,
): Promise<BringUpResult> {
  const harness_session_id = await harnessCreateSession({
    sandbox_url,
    title: body.title,
  });
  let response: HarnessMessageResponse | null = null;
  if (body.initial_prompt) {
    response = await harnessSendMessage({
      sandbox_url,
      harness_session_id,
      model: agent.model,
      parts: expandMessage(body.initial_prompt),
    });
  }
  const updated = await prisma.session.update({
    where: { session_id },
    data: {
      status: "ready",
      sandbox_url,
      harness_session_id,
      // Seed the idle clock at ready-transition so the reconciler doesn't
      // count container boot time toward the idle window.
      last_seen_at: new Date(),
      // The harness reply is an opaque blob; Prisma's Json column wants
      // InputJsonValue. Skip the field entirely if no initial_prompt was sent.
      response: response
        ? (response as unknown as Prisma.InputJsonValue)
        : undefined,
    },
  });
  // Pre-warm the message-route cache so the first POST after create skips
  // the hydrate round-trip.
  putCachedSession({
    session_id,
    agent_id: agent.agent_id,
    agent_model: agent.model,
    sandbox_url,
    harness_session_id,
    status: "ready",
  });
  return { updated, response };
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const identity = assertAuth(req);
  const { agent_id } = await ctx.params;
  const body = CreateSessionBody.parse(await req.json().catch(() => ({})));

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  // Per-session `env_vars` are baked in at Fargate launch time. Warm tasks
  // were provisioned without them, so a request that carries env_vars
  // can't be served from the pool — always go cold.
  const hasEnvVars = body.env_vars && Object.keys(body.env_vars).length > 0;
  const warm = hasEnvVars ? null : await claimWarmTask(agent_id);

  const session = await prisma.session.create({
    data: {
      agent_id,
      status: "creating",
      created_by: identity.user_id,
      // Inherit the warm task's ARN so that even if bring-up dies between
      // the claim and the harness handshake, the orphan reconciler can
      // still trace the ECS task back to a Session row.
      ...(warm?.task_arn ? { task_arn: warm.task_arn } : {}),
      ...(warm?.sandbox_url ? { sandbox_url: warm.sandbox_url } : {}),
    },
  });

  try {
    const result = warm
      ? await warmBringUp(agent, session.session_id, body, warm)
      : await coldBringUp(agent, session.session_id, body);

    // Hand-off succeeded — the Session row owns the ECS task now. Removing
    // the warm row prevents the reconciler from double-stopping it.
    if (warm) await deleteClaimedWarmTask(warm.warm_task_id);

    return Response.json(toApiSession(result.updated, result.response));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);

    // Mark the Session row failed so the API caller sees a stable terminal
    // state, and (if we were on the warm path) flag the warm row dead so
    // the reconciler stops the underlying ECS task. The warm task is
    // suspect — handing the same one to another request would just fail
    // again.
    await prisma.session
      .update({
        where: { session_id: session.session_id },
        data: { status: "failed", failure_reason: reason },
      })
      .catch(() => {
        /* best-effort; surface the original failure */
      });
    if (warm) {
      await markClaimedTaskDead(
        warm.warm_task_id,
        `bring-up failed: ${reason}`,
      );
    }

    if (e instanceof HttpError || e instanceof Response) throw e;
    httpError(500, `session create failed: ${reason}`);
  }
});
