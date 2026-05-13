/**
 * Orphan reconciler — periodic sweep that keeps Sandbox CR state and DB
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
import { harnessCreateSession } from "@/server/harness";
import {
  listTaggedTasks,
  readNodePort,
  readPodPhase,
  resolveNodeHost,
  stopTask,
  waitHttpReady,
} from "@/server/k8s";
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
// Returns the most recent timestamp ECS gave us for the task. PENDING /
// PROVISIONING tasks have null `started_at` (ECS only sets it on RUNNING),
// so we fall back to `created_at`. Returning null only when both are null
// means a task that ECS hasn't reported any timestamp for is treated as
// "age unknown" — callers handle that by skipping the kill.
function taskAgeMs(
  task: { created_at: Date | null; started_at: Date | null },
  now: number,
): number | null {
  const ts = task.started_at ?? task.created_at;
  return ts ? now - ts.getTime() : null;
}

async function sweepWarmOrphans(
  warm_tagged: Array<{
    task_arn: string;
    warm_task_id: string | null;
    created_at: Date | null;
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
      // task isn't killed before its row is committed. PENDING tasks have
      // null started_at, so taskAgeMs falls back to created_at; if both
      // are null (age unknown), skip rather than kill.
      const ageMs = taskAgeMs(task, now);
      if (ageMs === null || ageMs < RECONCILE_NEW_TASK_GRACE_MS) continue;
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
      // PENDING tasks have null started_at (ECS only sets it on RUNNING);
      // fall back to created_at so brand-new PENDING tasks aren't insta-
      // killed when a misconfigured worker is pointed at the wrong DB. If
      // both timestamps are null (rare — task too new for ECS to have
      // reported anything), skip the kill.
      const ageMs = taskAgeMs(task, now);
      if (ageMs === null || ageMs < RECONCILE_NEW_TASK_GRACE_MS) {
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

  // Recovery sweep: sessions stuck in `creating` past STUCK_AFTER_MS but
  // whose underlying pod is actually Running can sometimes be finished by
  // re-running the post-pod-ready handoff (NodePort lookup, HTTP probe,
  // harness session create). Runs before the timeout sweep below so a
  // wedged-but-recoverable row gets a chance before it's failed out.
  await recoverStuckCreating();

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

  // Ghost sweep: DB row says ready + has task_arn, but ECS shows no live task
  // (task stopped externally — OOM, manual stop, eviction). Without this the
  // row stays ready forever and send_message hits a dead public IP until the
  // idle window expires. Tasks reappear in listTaggedTasks only while
  // RUNNING/PENDING, so absence here means gone.
  //
  // Exclude STOPPED tasks: a Sandbox CR in Failed/Succeeded phase maps to
  // last_status="STOPPED" in listTaggedTasks. Including those in liveArns
  // would hide OOMKilled pods from the ghost sweep — the session row stays
  // "ready" forever even though the pod is dead.
  const liveArns = new Set(
    tasks
      .filter((t) => t.last_status !== "STOPPED")
      .map((t) => t.task_arn)
      .filter((a): a is string => !!a),
  );
  const readyRows = await prisma.session.findMany({
    where: { status: "ready", task_arn: { not: null } },
  });
  let ghost_killed = 0;
  const ghostGraceCutoff = new Date(now - RECONCILE_NEW_TASK_GRACE_MS);
  for (const s of readyRows) {
    if (!s.task_arn || liveArns.has(s.task_arn)) continue;
    // Same grace window as the orphan branch — avoid racing a task that
    // RunTask just returned for but hasn't shown up in ListTasks yet.
    if (s.created_at > ghostGraceCutoff) continue;
    try {
      // updateMany with `status: "ready"` guard so a row already flipped
      // (e.g. by the message route's inline mark or a prior tick) isn't
      // re-overwritten with our failure_reason.
      const res = await prisma.session.updateMany({
        where: { session_id: s.session_id, status: "ready" },
        data: {
          status: "dead",
          failure_reason: "task disappeared",
          stopped_at: new Date(),
        },
      });
      if (res.count > 0) ghost_killed += 1;
    } catch (e) {
      console.warn(
        `reconcile: failed to mark ghost session ${s.session_id} dead:`,
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
    ghost_killed,
  };
}

async function markFailed(session_id: string, reason: string): Promise<void> {
  await prisma.session
    .update({
      where: { session_id },
      data: { status: "failed", failure_reason: reason },
    })
    .catch(() => {});
}

/**
 * Watchdog: sweep sessions stuck in `creating`. For each, inspect the
 * underlying pod and either (a) recover the row by re-running the harness
 * handoff if the pod is Running and the harness is reachable, or
 * (b) hard-fail it past HARD_FAIL_AFTER_MS so the user isn't left staring
 * at a perpetual spinner. Rows younger than HARD_FAIL_AFTER_MS in a
 * non-terminal-but-not-Running phase are left pending for the next tick.
 */
async function recoverStuckCreating(): Promise<void> {
  const STUCK_AFTER_MS = 90_000;
  const HARD_FAIL_AFTER_MS = 600_000;
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
  const stuck = await prisma.session.findMany({
    where: { status: "creating", created_at: { lt: cutoff } },
    select: {
      session_id: true,
      agent_id: true,
      task_arn: true,
      created_at: true,
    },
  });

  let recovered = 0;
  let failed = 0;
  let pending = 0;

  for (const row of stuck) {
    const ageMs = Date.now() - row.created_at.getTime();
    const hardFail = ageMs > HARD_FAIL_AFTER_MS;

    if (!row.task_arn) {
      await markFailed(
        row.session_id,
        `watchdog: no task_arn after ${Math.round(ageMs / 1000)}s`,
      );
      failed++;
      continue;
    }

    let phaseInfo;
    try {
      phaseInfo = await readPodPhase(row.task_arn);
    } catch {
      if (hardFail) {
        await markFailed(
          row.session_id,
          `watchdog: readPodPhase threw after ${Math.round(ageMs / 1000)}s`,
        );
        failed++;
      } else {
        pending++;
      }
      continue;
    }

    if (!phaseInfo || phaseInfo.phase === "Failed") {
      await markFailed(
        row.session_id,
        `watchdog: pod ${row.task_arn} phase=${phaseInfo?.phase ?? "missing"} reason=${phaseInfo?.reason ?? "?"}`,
      );
      failed++;
      continue;
    }

    if (phaseInfo.phase !== "Running") {
      if (hardFail) {
        await markFailed(
          row.session_id,
          `watchdog: pod ${row.task_arn} stuck phase=${phaseInfo.phase} for ${Math.round(ageMs / 1000)}s`,
        );
        failed++;
      } else {
        pending++;
      }
      continue;
    }

    const nodePort = await readNodePort(row.task_arn).catch(() => null);
    if (nodePort === null) {
      if (hardFail) {
        await markFailed(
          row.session_id,
          `watchdog: no NodePort after ${Math.round(ageMs / 1000)}s`,
        );
        failed++;
      } else {
        pending++;
      }
      continue;
    }

    const host = await resolveNodeHost();
    const sandbox_url = `http://${host}:${nodePort}`;

    const probeOk = await waitHttpReady(sandbox_url, 5_000)
      .then(() => true)
      .catch(() => false);
    if (!probeOk) {
      if (hardFail) {
        await markFailed(
          row.session_id,
          `watchdog: harness ${sandbox_url} unresponsive after ${Math.round(ageMs / 1000)}s`,
        );
        failed++;
      } else {
        pending++;
      }
      continue;
    }

    const agent = await prisma.agent.findUnique({
      where: { agent_id: row.agent_id },
    });
    if (!agent) {
      await markFailed(
        row.session_id,
        `watchdog: agent ${row.agent_id} not found`,
      );
      failed++;
      continue;
    }

    try {
      const harness_session_id = await harnessCreateSession({
        sandbox_url,
        title: "default",
      });
      await prisma.session.update({
        where: { session_id: row.session_id },
        data: {
          status: "ready",
          sandbox_url,
          harness_session_id,
          last_seen_at: new Date(),
          phase: "ready",
        },
      });
      console.log(
        `watchdog: recovered ${row.session_id} age=${Math.round(ageMs / 1000)}s`,
      );
      recovered++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await markFailed(
        row.session_id,
        `watchdog: finish threw — ${reason}`,
      );
      failed++;
    }
  }

  if (stuck.length > 0) {
    console.log(
      `watchdog: stuck_creating sweep — checked=${stuck.length} recovered=${recovered} failed=${failed} pending=${pending}`,
    );
  }
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
