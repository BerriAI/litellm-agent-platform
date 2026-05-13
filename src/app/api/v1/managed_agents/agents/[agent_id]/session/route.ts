/**
 * POST /api/v1/managed_agents/agents/{agent_id}/session
 *
 * Two paths:
 *
 *   warm  — claim a pre-provisioned Fargate task from the pool and run only
 *           the harness handshake (~5s on the happy path).
 *   cold  — fall through to the original RunTask + waits + harness flow
 *           (~30s-8min). Used when the pool is disabled
 *           (`WARM_POOL_SIZE=0`), drained, has no warm task for this
 *           agent's config, or the request carries per-session `env_vars`
 *           that wouldn't be in a warm task's container env.
 *
 * The handler returns the `creating` Session row immediately (~50ms) and
 * runs the bring-up fire-and-forget in the background. The UI polls
 * /sessions/{id} for the `ready` (or `failed`) flip — so a slow cold path
 * doesn't block the response and the user sees the session page right away
 * with a live progress indicator instead of a spinner on the agent page.
 *
 * Either path persists the `creating` row up front so an in-flight failure
 * leaves an auditable row rather than a silently orphaned task. Background
 * failures flip status to `failed` with `failure_reason`.
 *
 * Cold-path bring-up is ported from
 * litellm/proxy/managed_agents_endpoints/endpoints_sessions.py:create_session
 * but stripped of the multi-tenant key minting that lives in the upstream
 * Python proxy.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
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
// Phase marker. Writes the current bring-up phase onto the Session row so the
// UI can render a real progress indicator instead of the wall-clock-driven
// approximation from PR #34. Best-effort: a phase write must never break the
// bring-up itself, so all errors are swallowed (and logged at warn level so a
// systemic DB failure is still visible in the operator logs).
// ---------------------------------------------------------------------------

async function setPhase(
  session_id: string,
  phase: string,
  detail?: string,
): Promise<void> {
  try {
    await prisma.session.update({
      where: { session_id },
      data: { phase, phase_detail: detail ?? null },
    });
  } catch (e) {
    console.warn(
      `setPhase(${session_id}, ${phase}) failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Background bring-up orchestrator.
//
// Wraps the warm/cold + fallback dance that used to live inline in the POST
// handler. Called fire-and-forget so the HTTP response can return the
// `creating` Session row in ~50ms instead of waiting 30s-8min for the
// sandbox to spin up. The UI polls /sessions/{id} for the status flip.
//
// Failures (warm + cold both dead, harness unreachable, network) flip the
// Session row to `failed` with the reason so the client can render it.
// We log too — a silent fire-and-forget is impossible to debug.
// ---------------------------------------------------------------------------

async function runBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  warm: WarmTaskRow | null,
): Promise<void> {
  try {
    let result: BringUpResult;
    if (warm) {
      try {
        result = await warmBringUp(agent, session_id, body, warm);
      } catch (warmErr) {
        // Warm task was claimed but its harness is unreachable (stale
        // sandbox_url, dead container, network drift, etc). Don't bubble
        // the failure to the user — kill the warm row and fall through to
        // a cold spawn. The user pays a slower start instead of a failure.
        const reason =
          warmErr instanceof Error ? warmErr.message : String(warmErr);
        console.warn(
          `warm bring-up failed for warm_task_id=${warm.warm_task_id}: ${reason}; falling back to cold spawn`,
        );
        await markClaimedTaskDead(
          warm.warm_task_id,
          `warm bring-up failed: ${reason}`,
        );
        // Reset the half-claimed Session row so coldBringUp's own
        // claim/update doesn't trip on stale warm fields.
        await prisma.session.update({
          where: { session_id },
          data: { task_arn: null, sandbox_url: null },
        });
        result = await coldBringUp(agent, session_id, body);
      }
    } else {
      result = await coldBringUp(agent, session_id, body);
    }

    // Hand-off succeeded — the Session row owns the ECS task now. Removing
    // the warm row prevents the reconciler from double-stopping it. (Only
    // applies on the success-from-warm path; the fallback already marked it
    // dead, so deleting again is a no-op.)
    if (warm) await deleteClaimedWarmTask(warm.warm_task_id).catch(() => {});

    // Discard the result — the route already returned; the UI polls
    // /sessions/{id} for the `ready` flip.
    void result;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `session create failed: session_id=${session_id} agent_id=${agent.agent_id} reason=${reason}`,
    );
    await prisma.session
      .update({
        where: { session_id },
        data: { status: "failed", failure_reason: reason },
      })
      .catch((dbErr) => {
        // Last-ditch DB write failed — there's nowhere else to surface this,
        // so just log loudly. The orphan reconciler will eventually GC the
        // stuck row.
        console.error(
          `failed to mark session ${session_id} as failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      });
  }
}

// ---------------------------------------------------------------------------
// Cold path — RunTask + waits + harness session.
// ---------------------------------------------------------------------------

async function coldBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
): Promise<BringUpResult> {
  // Local-mode short-circuit: no k8s, no ECS. Point the session at a harness
  // already running on the host (a single harness multiplexes all sessions
  // via its internal sessions map). task_arn='local' is the sentinel the
  // reconciler uses to skip stopTask on these rows.
  if (env.LAP_LOCAL_SANDBOX_URL) {
    const sandbox_url = env.LAP_LOCAL_SANDBOX_URL.replace(/\/+$/, "");
    await setPhase(session_id, "creating_sandbox", "local mode");
    await prisma.session.update({
      where: { session_id },
      data: { task_arn: "local" },
    });
    await setPhase(session_id, "waiting_harness");
    await waitHttpReady(sandbox_url);
    await setPhase(session_id, "harness_ready");
    return finishBringUp(agent, session_id, body, sandbox_url);
  }
  await setPhase(session_id, "creating_sandbox");
  const { task_arn } = await runTask({
    agent,
    session_id,
    env_vars: body.env_vars,
  });
  await prisma.session.update({
    where: { session_id },
    data: { task_arn },
  });
  await setPhase(session_id, "pod_pending");
  const sandbox_url = await waitRunningGetUrl(task_arn, agent);
  await setPhase(session_id, "pod_running");
  await setPhase(session_id, "waiting_harness");
  await waitHttpReady(sandbox_url);
  await setPhase(session_id, "harness_ready");
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
  // Warm path skips creating_sandbox / pod_pending / pod_running /
  // waiting_harness — the pod is already up and the harness is already
  // listening. Jump straight to harness_ready so the UI doesn't briefly
  // pretend a warm session is doing pod scheduling work.
  await setPhase(session_id, "harness_ready");
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
  // Approximation: by the time harnessCreateSession succeeds the container's
  // entrypoint has already cloned the repo. We surface `cloning_repo` here
  // so the UI shows *some* progress between harness_ready and the final
  // `ready` flip even when Phase 3's harness-side reports are unavailable
  // (e.g. PLATFORM_INTERNAL_URL unset, sandbox can't reach the platform).
  // When the harness *does* report, those writes happen earlier and this
  // line is effectively a no-op overwrite with the same value.
  await setPhase(session_id, "cloning_repo");
  const harness_session_id = await harnessCreateSession({
    sandbox_url,
    title: body.title,
    prompt: agent.prompt ?? undefined,
  });
  // Flip status=ready as soon as the harness handshake completes. The
  // sandbox is fully usable at this point — the initial_prompt (if any) is
  // the agent doing its job, not part of bring-up, and it can take minutes.
  // Holding `creating` until the agent finishes makes a healthy session look
  // hung and trips the SESSION_CREATING_TIMEOUT_MS reconciler.
  const updated = await prisma.session.update({
    where: { session_id },
    data: {
      status: "ready",
      // Flip phase to `ready` in the same update so the UI sees both
      // status=ready and phase=ready atomically — avoids a tick where the
      // session is ready but the progress card still renders the previous
      // phase.
      phase: "ready",
      phase_detail: null,
      sandbox_url,
      harness_session_id,
      // Seed the idle clock at ready-transition so the reconciler doesn't
      // count container boot time toward the idle window.
      last_seen_at: new Date(),
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
  // Fire-and-forget the initial agent task. The session is already ready;
  // the caller (and UI) doesn't need to block on the agent loop, which for
  // a shin PR-review prompt is typically 2-15 minutes. On completion we
  // persist the reply; on failure we log + best-effort write the reason.
  // The .catch is critical: an unhandled rejection here would crash the
  // Node process since this promise is no longer awaited.
  if (body.initial_prompt) {
    void runInitialPrompt(agent, session_id, sandbox_url, harness_session_id, body.initial_prompt);
  }
  return { updated, response: null };
}

// ---------------------------------------------------------------------------
// Fire-and-forget runner for the initial agent task. Persists the reply on
// success, logs + persists a failure_reason on error. Never throws — any
// rejection here would be unhandled (the caller doesn't await this).
// ---------------------------------------------------------------------------

async function runInitialPrompt(
  agent: AgentRow,
  session_id: string,
  sandbox_url: string,
  harness_session_id: string,
  initial_prompt: string,
): Promise<void> {
  try {
    const response = await harnessSendMessage({
      sandbox_url,
      harness_session_id,
      model: agent.model,
      parts: expandMessage(initial_prompt),
    });
    await prisma.session.update({
      where: { session_id },
      data: {
        response: response as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `initial_prompt send failed: session_id=${session_id} reason=${reason}`,
    );
    // Best-effort persist. The session itself stays `ready` — the sandbox
    // is healthy; only the initial agent task failed. The UI can surface
    // failure_reason alongside an empty response.
    await prisma.session
      .update({
        where: { session_id },
        data: { failure_reason: `initial_prompt failed: ${reason}` },
      })
      .catch((dbErr) => {
        console.error(
          `failed to record initial_prompt failure for ${session_id}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      });
  }
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

  let session: SessionRow;
  try {
    session = await prisma.session.create({
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
  } catch (e) {
    // Row creation itself failed — we have no Session row to mark failed,
    // so propagate as a 500 the way the old synchronous flow did. Release
    // any warm claim so it isn't orphaned.
    if (warm) {
      await markClaimedTaskDead(
        warm.warm_task_id,
        `session row create failed: ${e instanceof Error ? e.message : String(e)}`,
      ).catch(() => {});
    }
    if (e instanceof HttpError || e instanceof Response) throw e;
    httpError(500, `session create failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Fire-and-forget the bring-up. The Node runtime keeps the promise alive
  // after the response returns (unlike Edge, which terminates the
  // execution context). Render runs this route on Node so the background
  // work continues; nothing inside coldBringUp/warmBringUp reads
  // request-scoped state past this point — they only touch prisma, k8s,
  // and the harness over fetch with their own internal AbortSignals.
  void runBringUp(agent, session.session_id, body, warm);

  // Return the `creating` row immediately. The UI polls /sessions/{id} and
  // flips to the ready/failed view when the background bring-up settles.
  return Response.json(toApiSession(session, null));
});
