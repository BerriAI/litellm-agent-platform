/**
 * rehydrateSession — bring a fresh sandbox up for an existing session and
 * replay its durable conversation into it, so a dead/reaped sandbox can be
 * recovered without losing the thread.
 *
 * Shared by two callers:
 *   - the explicit /restart route (user clicks "restart"), and
 *   - the /message route's auto-recovery (a dead sandbox is detected on the
 *     next send and recovered transparently).
 *
 * Conversation-only recovery: the new container is fresh — files, processes,
 * and in-memory tool state from the old sandbox are gone (intentional). The
 * thread is replayed from the append-only SessionMessage log (source of
 * truth), falling back to the legacy Session.history blob for older rows.
 *
 * Handles both runtimes: the local-dev `LOCAL_SANDBOX_URL` bypass and the
 * normal K8s runTask path. (The previous inline restart logic only did K8s,
 * which silently broke restart in local dev.)
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import {
  expandMessage,
  formatHistoryAsText,
  harnessCreateSession,
  harnessSendMessage,
} from "@/server/harness";
import { runTask, stopTask, waitHttpReady, waitRunningGetUrl } from "@/server/k8s";
import { invalidateSession, putCachedSession } from "@/server/sessionCache";
import {
  formatSessionMessagesAsText,
  listSessionMessages,
} from "@/server/sessionStore";
import type {
  AgentRow,
  HarnessMessage,
  HarnessMessageResponse,
  SandboxFileSpec,
} from "@/server/types";

export interface RehydrateResult {
  sandbox_url: string;
  harness_session_id: string;
  // Reply to the replayed history, if any was replayed. null when the session
  // had no prior thread to replay.
  response: HarnessMessageResponse | null;
}

export interface RehydrateOpts {
  agent: AgentRow;
  session_id: string;
  // Old task to stop before spawning a fresh one (best-effort).
  oldTaskArn: string | null;
  // Legacy fallback when the durable log is empty (pre-SessionMessage rows).
  previousHistory: HarnessMessage[] | null;
  // Skip this message_id when building the replay context — used by the
  // message route so the just-appended in-flight turn isn't replayed as
  // history *and* re-sent live (which would duplicate it).
  excludeMessageId?: string;
}

// How long a racing caller waits for the winning rehydrate to finish before
// giving up. Generous: a cold k8s bring-up can take minutes.
const CONCURRENT_REHYDRATE_TIMEOUT_MS = 5 * 60_000;
const CONCURRENT_REHYDRATE_POLL_MS = 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Another caller already claimed the rehydrate (the row was `creating`). Poll
 * the row until it settles, so we return the same fresh sandbox instead of
 * racing a second bring-up. Throws if the winner failed or we time out.
 */
async function waitForConcurrentRehydrate(
  session_id: string,
): Promise<RehydrateResult> {
  const deadline = Date.now() + CONCURRENT_REHYDRATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(CONCURRENT_REHYDRATE_POLL_MS);
    const row = await prisma.session.findUnique({
      where: { session_id },
      select: {
        status: true,
        sandbox_url: true,
        harness_session_id: true,
        failure_reason: true,
      },
    });
    if (!row) {
      throw new Error(
        `session ${session_id} vanished while waiting for concurrent rehydrate`,
      );
    }
    if (row.status === "ready" && row.sandbox_url && row.harness_session_id) {
      return {
        sandbox_url: row.sandbox_url,
        harness_session_id: row.harness_session_id,
        response: null,
      };
    }
    if (row.status === "failed" || row.status === "dead") {
      throw new Error(
        `concurrent rehydrate of ${session_id} failed: ${row.failure_reason ?? row.status}`,
      );
    }
  }
  throw new Error(`timed out waiting for concurrent rehydrate of ${session_id}`);
}

// Build the replay text for a session: durable log first, legacy blob second.
async function buildReplayText(
  session_id: string,
  previousHistory: HarnessMessage[] | null,
  excludeMessageId?: string,
): Promise<string | null> {
  const rows = (await listSessionMessages(session_id)).filter(
    (r) => r.message_id !== excludeMessageId,
  );
  if (rows.length > 0) return formatSessionMessagesAsText(rows);
  if (previousHistory && previousHistory.length > 0) {
    return formatHistoryAsText(previousHistory);
  }
  return null;
}

export async function rehydrateSession(
  opts: RehydrateOpts,
): Promise<RehydrateResult> {
  const { agent, session_id } = opts;

  // Atomically claim the session for rehydration. The status guard turns this
  // into a cross-replica lock: only one caller (in this process or any other
  // pod) can flip a non-`creating` row to `creating`. A racing caller sees
  // count 0 and waits for the winner instead of spawning a second sandbox and
  // orphaning the first. An interrupted rehydrate also leaves an auditable
  // `creating -> failed` transition rather than a phantom `ready` row.
  const claim = await prisma.session.updateMany({
    where: { session_id, status: { not: "creating" } },
    data: {
      status: "creating",
      sandbox_url: null,
      harness_session_id: null,
      task_arn: null,
      failure_reason: null,
      last_seen_at: new Date(),
    },
  });
  if (claim.count === 0) {
    return waitForConcurrentRehydrate(session_id);
  }
  invalidateSession(session_id);

  // We own the claim now — best-effort stop of the old task. Leaving an orphan
  // is cheap (the reconciler reaps dead-row tasks); blocking recovery on it is
  // not.
  if (opts.oldTaskArn) {
    try {
      await stopTask(opts.oldTaskArn, "session rehydrate");
    } catch (err) {
      console.warn(
        `rehydrate: stopTask(${opts.oldTaskArn}) failed for ${session_id}:`,
        err,
      );
    }
  }

  const rawFiles = (agent as Record<string, unknown>).sandbox_files;
  const files = Array.isArray(rawFiles)
    ? (rawFiles as SandboxFileSpec[])
    : undefined;

  let new_task_arn: string | null = null;
  try {
    // Bring up the sandbox.
    let sandbox_url: string;
    if (env.LOCAL_SANDBOX_URL) {
      // Local dev: a single long-lived harness process stands in for the pod.
      sandbox_url = env.LOCAL_SANDBOX_URL;
      await waitHttpReady(sandbox_url);
    } else {
      const { task_arn } = await runTask({ agent, session_id });
      new_task_arn = task_arn;
      await prisma.session.update({
        where: { session_id },
        data: { task_arn },
      });
      sandbox_url = await waitRunningGetUrl(task_arn, agent);
      await prisma.session.update({
        where: { session_id },
        data: { sandbox_url },
      });
      await waitHttpReady(sandbox_url);
    }

    const harness_session_id = await harnessCreateSession({
      sandbox_url,
      title: "restart",
      files,
    });

    // Replay the prior thread into the fresh harness session as context.
    let response: HarnessMessageResponse | null = null;
    const replayText = await buildReplayText(
      session_id,
      opts.previousHistory,
      opts.excludeMessageId,
    );
    if (replayText) {
      response = await harnessSendMessage({
        sandbox_url,
        harness_session_id,
        model: agent.model,
        parts: expandMessage(replayText),
      });
    }

    await prisma.session.update({
      where: { session_id },
      data: {
        status: "ready",
        sandbox_url,
        harness_session_id,
        task_arn: new_task_arn,
        // Reset the idle clock so a freshly-recovered session gets a full
        // idle window even if the pre-rehydrate row was about to be reaped.
        last_seen_at: new Date(),
        response: response
          ? (response as unknown as Prisma.InputJsonValue)
          : undefined,
      },
    });
    putCachedSession({
      session_id,
      agent_id: agent.agent_id,
      agent_model: agent.model,
      harness_id: agent.harness_id,
      sandbox_url,
      harness_session_id,
      status: "ready",
      sandboxes: null,
    });

    return { sandbox_url, harness_session_id, response };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Mark failed before cleanup so the row reflects the error even if
    // stopTask itself throws.
    await prisma.session
      .update({
        where: { session_id },
        data: { status: "failed", failure_reason: reason },
      })
      .catch(() => {
        /* best-effort; surface the original failure */
      });
    if (new_task_arn) {
      await stopTask(new_task_arn, "rehydrate failed").catch(() => {});
    }
    throw e;
  }
}
