/**
 * Orphan reconciler — periodic sweep that keeps Fargate task state and DB
 * session rows in agreement. Ported from
 * litellm/proxy/managed_agents_endpoints/lifecycle.py.
 *
 * Two cleanup paths live here:
 *
 * 1. Pre-delete (handler-driven): `stopSessionsForAgent` is called from the
 *    DELETE /agents/:id route to stop live Fargate tasks before the agent row
 *    is removed. DB cascade handles the session rows.
 *
 * 2. Background sweep: `reconcileOrphans` is invoked every
 *    RECONCILE_INTERVAL_SECONDS by src/worker/index.ts. It lists every tagged
 *    Fargate task in the configured cluster and stops anything whose DB row
 *    is missing, dead, or stuck creating past the timeout.
 *
 * The `RECONCILE_NEW_TASK_GRACE_MS` window covers the race between RunTask
 * returning and the session row being committed — without it, freshly
 * launched tasks would be killed seconds after starting.
 */

import { prisma } from "@/server/db";
import { listTaggedTasks, stopTask } from "@/server/fargate";
import {
  RECONCILE_NEW_TASK_GRACE_MS,
  SESSION_CREATING_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  type ReconcileResult,
} from "@/server/types";

const DEAD_STATUSES = new Set(["dead", "failed", "stopped"]);

async function safeStopTask(task_arn: string, reason: string): Promise<void> {
  try {
    await stopTask(task_arn, reason);
  } catch (e) {
    console.warn(
      `reconcile: stopTask failed arn=${task_arn} reason="${reason}":`,
      e,
    );
  }
}

const WARM_DEAD_STATUSES = new Set(["dead", "claimed"]);

/**
 * Stop any Fargate task tagged as a warm pool task whose `WarmTask` row is
 * missing or in a terminal state.
 *
 * Critical guard: a successful claim hands the underlying ECS task off to a
 * Session row but does NOT change the task's ECS tags (only `WarmTask`
 * deletion happens at the DB layer). Without the cross-check below, the
 * reconciler would see a warm-tagged task with no WarmTask row, decide it's
 * an orphan past the grace window, and stop the task that the user is
 * actively using. We resolve the ambiguity by looking up `Session.task_arn`
 * — if any live (non-DEAD) Session owns the task, skip it unconditionally.
 *
 * Brand-new tasks inside the `RECONCILE_NEW_TASK_GRACE_MS` window are also
 * left alone — the provisioner may not have committed the row yet.
 */
async function sweepWarmOrphans(
  warm_tagged: Array<{
    task_arn: string;
    warm_task_id: string | null;
    started_at: Date | null;
  }>,
  now: number,
): Promise<number> {
  if (warm_tagged.length === 0) return 0;

  // 1. Cross-check Session by task_arn. A claimed-then-handed-off warm task
  // shows up here as a warm-tagged ECS task with no WarmTask row but whose
  // ARN appears on a live Session. We must never stop those.
  const arns = warm_tagged.map((t) => t.task_arn);
  const sessions = arns.length
    ? await prisma.session.findMany({
        where: { task_arn: { in: arns } },
        select: { task_arn: true, status: true },
      })
    : [];
  const liveSessionArns = new Set(
    sessions
      .filter((s) => !DEAD_STATUSES.has(s.status))
      .map((s) => s.task_arn)
      .filter((arn): arn is string => typeof arn === "string"),
  );

  // 2. Batch the WarmTask lookup.
  const ids = warm_tagged
    .map((t) => t.warm_task_id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const rows = ids.length
    ? await prisma.warmTask.findMany({
        where: { warm_task_id: { in: ids } },
      })
    : [];
  const byId = new Map(rows.map((r) => [r.warm_task_id, r]));

  let stopped = 0;
  for (const task of warm_tagged) {
    // Owned by a live Session — task is in use, leave it alone.
    if (liveSessionArns.has(task.task_arn)) continue;

    const wid = task.warm_task_id;
    if (!wid) continue;
    const row = byId.get(wid);

    if (!row) {
      // Row missing — but respect the grace window so a freshly launched
      // task isn't killed before its row is committed.
      const startedAt = task.started_at ? task.started_at.getTime() : null;
      const ageMs = startedAt !== null ? now - startedAt : null;
      if (ageMs !== null && ageMs < RECONCILE_NEW_TASK_GRACE_MS) continue;
      await safeStopTask(task.task_arn, "reconciler: warm orphan");
      stopped += 1;
      continue;
    }
    if (WARM_DEAD_STATUSES.has(row.status)) {
      await safeStopTask(task.task_arn, "reconciler: warm dead");
      stopped += 1;
    }
  }
  return stopped;
}

export async function reconcileOrphans(): Promise<ReconcileResult> {
  const tasks = await listTaggedTasks();
  const managed = tasks.filter((t) => t.session_id);
  const warm_tagged = tasks.filter((t) => t.warm_task_id && !t.session_id);
  const inspected = managed.length;

  let stopped = 0;
  const now = Date.now();

  // Batch the row lookup so we don't issue N queries.
  const sessionIds = managed
    .map((t) => t.session_id)
    .filter((sid): sid is string => typeof sid === "string" && sid.length > 0);
  const rows = sessionIds.length
    ? await prisma.session.findMany({
        where: { session_id: { in: sessionIds } },
      })
    : [];
  const bySessionId = new Map(rows.map((r) => [r.session_id, r]));

  for (const task of managed) {
    const sid = task.session_id as string;
    const row = bySessionId.get(sid);

    if (!row) {
      // Row missing: only stop if the task is older than the grace window.
      const startedAt = task.started_at ? task.started_at.getTime() : null;
      const ageMs = startedAt !== null ? now - startedAt : null;
      if (ageMs !== null && ageMs < RECONCILE_NEW_TASK_GRACE_MS) {
        continue;
      }
      await safeStopTask(task.task_arn, "reconciler: orphan");
      stopped += 1;
      continue;
    }

    if (DEAD_STATUSES.has(row.status)) {
      await safeStopTask(task.task_arn, "reconciler: orphan");
      stopped += 1;
    }
  }

  // Stuck-creating sweep: sessions whose creating window expired never got a
  // ready signal. Mark them failed and stop any associated task.
  const cutoff = new Date(now - SESSION_CREATING_TIMEOUT_MS);
  const stuck = await prisma.session.findMany({
    where: { status: "creating", created_at: { lt: cutoff } },
  });

  let failed_creating = 0;
  for (const s of stuck) {
    if (s.task_arn) {
      await safeStopTask(s.task_arn, "reconciler: creating timeout");
    }
    try {
      await prisma.session.update({
        where: { session_id: s.session_id },
        data: {
          status: "failed",
          failure_reason: "creating timeout",
          stopped_at: new Date(),
        },
      });
      failed_creating += 1;
    } catch (e) {
      console.warn(
        `reconcile: failed to mark session ${s.session_id} failed:`,
        e,
      );
    }
  }

  // Idle sweep: ready sessions with no message activity past the idle window.
  // last_seen_at falls back to created_at if no messages were ever sent.
  const idleCutoff = new Date(now - SESSION_IDLE_TIMEOUT_MS);
  const idle = await prisma.session.findMany({
    where: {
      status: "ready",
      OR: [
        { last_seen_at: { lt: idleCutoff } },
        { AND: [{ last_seen_at: null }, { created_at: { lt: idleCutoff } }] },
      ],
    },
  });

  let idle_killed = 0;
  for (const s of idle) {
    if (s.task_arn) {
      await safeStopTask(s.task_arn, "reconciler: idle timeout");
    }
    try {
      await prisma.session.update({
        where: { session_id: s.session_id },
        data: {
          status: "dead",
          failure_reason: "idle timeout",
          stopped_at: new Date(),
        },
      });
      idle_killed += 1;
    } catch (e) {
      console.warn(
        `reconcile: failed to mark idle session ${s.session_id} dead:`,
        e,
      );
    }
  }

  const warm_orphans_stopped = await sweepWarmOrphans(warm_tagged, now);

  return {
    inspected,
    stopped,
    failed_creating,
    idle_killed,
    warm_orphans_stopped,
  };
}

export async function stopSessionsForAgent(agent_id: string): Promise<number> {
  const sessions = await prisma.session.findMany({
    where: { agent_id, status: { in: ["creating", "ready"] } },
  });
  if (sessions.length === 0) return 0;

  let count = 0;
  for (const s of sessions) {
    if (s.task_arn) {
      await safeStopTask(s.task_arn, "agent deleted");
    }
    try {
      await prisma.session.update({
        where: { session_id: s.session_id },
        data: { status: "dead", stopped_at: new Date() },
      });
      count += 1;
    } catch (e) {
      console.warn(
        `stopSessionsForAgent: failed to mark session ${s.session_id} dead:`,
        e,
      );
    }
  }
  return count;
}
