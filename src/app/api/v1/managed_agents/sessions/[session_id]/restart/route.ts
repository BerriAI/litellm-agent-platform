/**
 * POST /api/v1/managed_agents/sessions/[session_id]/restart
 *
 * Respawns a Fargate task for a dead/failed session and replays the
 * persisted opencode thread (Session.history, populated after every send
 * by the /message route) as the new harness session's first user message.
 *
 * Why a restart instead of a brand-new session: the row id, agent linkage,
 * and any out-of-band references (UI URLs, audit trail) stay stable, and
 * the prior conversation is preserved in-context so the model can pick up
 * where it left off. The actual sandbox container is fresh — files,
 * processes, and any in-memory tool state from the previous task are
 * gone, which is intentional for safety/cost reasons.
 *
 * State machine:
 *   - reject if status is `creating` (boot already in flight) or `ready`
 *     (nothing to restart — caller should just send a new message).
 *   - flip to `creating`, clear sandbox_url + harness_session_id, kick a
 *     best-effort stopTask on the old task_arn (failures swallowed; the
 *     reconciler will eventually mop up if it's still running).
 *   - mirror the create-session flow: runTask → waitRunningGetIp →
 *     waitHttpReady → harnessCreateSession → harnessSendMessage(history).
 *   - on any failure after the row was flipped to `creating`, mark it
 *     `failed`, stop the new task if we got that far, and return 502.
 */

import { ZodError } from "zod";

import type { Prisma } from "@prisma/client";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  runTask,
  stopTask,
  waitHttpReady,
  waitRunningGetUrl,
} from "@/server/k8s";
import { invalidateSession, putCachedSession } from "@/server/sessionCache";
import {
  expandMessage,
  formatHistoryAsText,
  harnessCreateSession,
  harnessDeleteSession,
  harnessSendMessage,
} from "@/server/harness";
import {
  HARNESS_BRAIN_INLINE,
  HttpError,
  httpError,
  toApiSession,
  type HarnessMessage,
  type HarnessMessageResponse,
} from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const row = await prisma.session.findUnique({
      where: { session_id },
      include: { agent: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);

    // `creating` means a previous bring-up is still in flight — racing it
    // with another runTask would orphan the in-flight task. `ready` is OK:
    // users can manually restart a healthy session (e.g. recovering from a
    // wedged opencode harness, or opting into a fresh sandbox while keeping
    // history). The route stops the existing task before spawning a new one.
    if (row.status === "creating") {
      httpError(
        409,
        `session ${session_id} is creating; wait for it to settle before restarting`,
      );
    }

    const agent = row.agent;
    const previousHistory = Array.isArray(row.history)
      ? (row.history as unknown as HarnessMessage[])
      : null;

    // Fast path for brain-inline: delegate to a shared harness server — no K8s pod needed.
    if (agent.harness_id === HARNESS_BRAIN_INLINE) {
      const inlineUrl = process.env.CLAUDE_CODE_INLINE_URL;
      if (!inlineUrl) {
        const updated = await prisma.session.update({
          where: { session_id },
          data: { status: "failed", failure_reason: "CLAUDE_CODE_INLINE_URL not configured" },
        });
        return Response.json({ error: "CLAUDE_CODE_INLINE_URL not configured" }, { status: 503 });
      }

      // Best-effort cleanup: delete the old harness session before creating a
      // fresh one so sessions don't accumulate in the shared harness process
      // across many restart cycles.
      if (row.harness_session_id) {
        await harnessDeleteSession({ sandbox_url: inlineUrl, harness_session_id: row.harness_session_id })
          .catch((err: unknown) => {
            console.warn(`brain-inline restart: failed to delete old harness session ${row.harness_session_id}:`, err);
          });
      }

      const rawFiles = (agent as Record<string, unknown>).sandbox_files;
      const rawProjects = (agent as Record<string, unknown>).projects;
      const projects = Array.isArray(rawProjects) ? rawProjects as Array<{ id: string; name: string; description: string; repo_url?: string }> : [];

      const harness_session_id = await harnessCreateSession({
        sandbox_url: inlineUrl,
        title: "restart",
        files: Array.isArray(rawFiles) ? (rawFiles as import("@/server/types").SandboxFileSpec[]) : undefined,
        sandbox_tools: true,
        projects,
        agent_id: agent.agent_id,
        platform_session_id: session_id,
      });

      const updated = await prisma.session.update({
        where: { session_id },
        data: { status: "ready", failure_reason: null, last_seen_at: new Date(), sandbox_url: inlineUrl, harness_session_id },
      });
      invalidateSession(session_id);
      putCachedSession({
        session_id,
        agent_id: agent.agent_id,
        agent_model: agent.model,
        harness_id: agent.harness_id,
        sandbox_url: inlineUrl,
        harness_session_id,
        status: "ready",
      });

      // Replay history as first message if available
      if (previousHistory && previousHistory.length > 0) {
        const historyText = formatHistoryAsText(previousHistory);
        void harnessSendMessage({
          sandbox_url: inlineUrl,
          harness_session_id,
          model: agent.model,
          parts: expandMessage(historyText),
        }).catch((err: unknown) => {
          console.error(`brain-inline restart history replay failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      return Response.json(toApiSession(updated, null, null, agent.harness_id));
    }

    // Best-effort: try to stop the old task before we forget its ARN. If it's
    // already stopped or the call fails for any reason, swallow — leaving an
    // orphaned task is cheap (the reconciler kills untagged/dead-row tasks)
    // compared to blocking the user-visible restart on it.
    if (row.task_arn) {
      try {
        await stopTask(row.task_arn, "session restart");
      } catch (err) {
        console.warn(
          `restart: stopTask(${row.task_arn}) failed for session ${session_id}:`,
          err,
        );
      }
    }

    // Flip to `creating` up front so concurrent restart calls land on the
    // 409 above, and so an in-flight crash leaves an auditable `creating ->
    // failed` transition rather than a phantom `ready` row.
    await prisma.session.update({
      where: { session_id },
      data: {
        status: "creating",
        sandbox_url: null,
        harness_session_id: null,
        task_arn: null,
        failure_reason: null,
        last_seen_at: new Date(),
      },
    });
    // Drop the hot-path cache so any in-flight message routed at the old
    // sandbox_url falls through to the 404 path instead of dialing a stopped
    // pod. The new entry is re-installed below once the restart succeeds.
    invalidateSession(session_id);

    let new_task_arn: string | null = null;
    try {
      const { task_arn } = await runTask({ agent, session_id });
      new_task_arn = task_arn;
      await prisma.session.update({
        where: { session_id },
        data: { task_arn },
      });

      const sandbox_url = await waitRunningGetUrl(task_arn, agent);
      await prisma.session.update({
        where: { session_id },
        data: { sandbox_url },
      });
      await waitHttpReady(sandbox_url);

      const rawFiles = (agent as Record<string, unknown>).sandbox_files;
      const harness_session_id = await harnessCreateSession({
        sandbox_url,
        title: "restart",
        files: Array.isArray(rawFiles) ? (rawFiles as import("@/server/types").SandboxFileSpec[]) : undefined,
      });
      await prisma.session.update({
        where: { session_id },
        data: { harness_session_id },
      });

      let response: HarnessMessageResponse | null = null;
      if (previousHistory && previousHistory.length > 0) {
        const historyText = formatHistoryAsText(previousHistory);
        response = await harnessSendMessage({
          sandbox_url,
          harness_session_id,
          model: agent.model,
          parts: expandMessage(historyText),
        });
      }

      const updated = await prisma.session.update({
        where: { session_id },
        data: {
          status: "ready",
          // Reset the idle clock at ready-transition: the reconciler should
          // grant a freshly-restarted session a full idle window even if the
          // pre-restart row was about to be reaped.
          last_seen_at: new Date(),
          // Skip the `response` column entirely if no history was replayed,
          // matching the create-session route's handling of `initial_prompt`.
          response: response
            ? (response as unknown as Prisma.InputJsonValue)
            : undefined,
        },
      });
      // Re-warm the cache with the post-restart state so the first message
      // after restart skips DB hydration.
      putCachedSession({
        session_id,
        agent_id: agent.agent_id,
        agent_model: agent.model,
        harness_id: agent.harness_id,
        sandbox_url,
        harness_session_id,
        status: "ready",
      });

      return Response.json(toApiSession(updated, response, null, agent.harness_id));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // Mark failed before attempting cleanup so the row reflects the error
      // even if stopTask itself throws.
      await prisma.session
        .update({
          where: { session_id },
          data: { status: "failed", failure_reason: reason },
        })
        .catch(() => {
          /* best-effort; surface the original failure */
        });
      if (new_task_arn) {
        await stopTask(new_task_arn, "restart failed").catch(() => {
          /* best-effort */
        });
      }
      if (e instanceof HttpError || e instanceof Response) throw e;
      throw new HttpError(502, `session restart failed: ${reason}`);
    }
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
