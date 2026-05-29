/**
 * Warm pool — pre-provisioned sandbox pods waiting to be claimed by a
 * session create.
 *
 * See ./README.md for the full architecture write-up (lifecycle diagram,
 * configuration, sizing, failure modes, observability).
 *
 * Quick summary
 * -------------
 * `POST /agents/{id}/session` today creates a fresh Sandbox CR in the
 * request: pod schedule + image pull + opencode boot dominate (~10s avg
 * on cached images, longer on first pull). The warm pool runs that work
 * in the background ahead of time — a request that lands while a warm
 * pod is available finishes in ~1.8s.
 *
 * Per-agent: the opencode harness reads `REPO_URL`, `BRANCH`, and
 * `AGENT_PROMPT` from container env at boot, so a warm task launched for
 * agent A cannot serve a request for agent B. Each `WarmTask` row is
 * therefore bound to a single agent.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { registry } from "@/server/metrics";
import {
  runTask,
  stopTask,
  waitHttpReady,
  waitRunningGetUrl,
  ensureWorkspacePvc,
} from "@/server/k8s";
import type { AgentRow, WarmTaskRow } from "@/server/types";

// Per-agent target for regular (non-priority) agents.
const PER_AGENT_TARGET = 1;

// ---------------------------------------------------------------------------
// claimWarmTask — request-path entry point
// ---------------------------------------------------------------------------

/**
 * Atomically claim the oldest warm task for `agent_id`, if any. Uses
 * Postgres `SELECT … FOR UPDATE SKIP LOCKED` so concurrent claims (e.g.
 * a user double-clicking "Create session") cannot hand out the same task
 * twice; the loser sees `null` and falls through to the cold path.
 *
 * Returns the row marked `claimed`, with `task_arn` and `sandbox_url`
 * populated. Caller is responsible for finishing the bring-up
 * (`harnessCreateSession` + optional initial message) and writing the
 * Session row.
 */
export async function claimWarmTask(
  agent_id: string,
): Promise<WarmTaskRow | null> {
  if (env.WARM_POOL_SIZE === 0) return null;

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<WarmTaskRow[]>`
      SELECT *
      FROM "managed_agent_warm_task"
      WHERE agent_id = ${agent_id}
        AND status = 'warm'
      ORDER BY ready_at NULLS LAST, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const row = rows[0];
    if (!row) return null;

    return tx.warmTask.update({
      where: { warm_task_id: row.warm_task_id },
      data: { status: "claimed", claimed_at: new Date() },
    });
  });
}

/**
 * Mark a previously claimed warm task as released back to the pool. Only
 * called when the post-claim work (e.g. `harnessCreateSession`) fails —
 * we don't recycle the task, we mark it dead so the reconciler stops the
 * underlying ECS task. The next top-up tick will provision a replacement.
 */
export async function markClaimedTaskDead(
  warm_task_id: string,
  reason: string,
): Promise<void> {
  await prisma.warmTask
    .update({
      where: { warm_task_id },
      data: { status: "dead", failure_reason: reason },
    })
    .catch(() => {
      /* row may already be gone — best effort */
    });
}

/**
 * After a successful claim + harness session, drop the warm row entirely.
 * The Session row owns the task ARN now; keeping the WarmTask row around
 * would risk double-stopping it on reconcile.
 */
export async function deleteClaimedWarmTask(
  warm_task_id: string,
): Promise<void> {
  await prisma.warmTask
    .delete({ where: { warm_task_id } })
    .catch(() => {
      /* row may already be gone — best effort */
    });
}

// ---------------------------------------------------------------------------
// provisionWarmTask — worker-driven
// ---------------------------------------------------------------------------

/**
 * Stand up a single warm Fargate task for `agent_id`. Mirrors the cold
 * bring-up in `route.ts` (runTask → waitRunningGetIp → waitHttpReady) but
 * skips `harnessCreateSession` — that runs at claim time so each session
 * gets a fresh harness session id.
 *
 * Designed to be called fire-and-forget by the worker top-up tick. Errors
 * are caught and the row is marked dead; the reconciler will clean up the
 * ECS task on its next sweep.
 */
export async function provisionWarmTask(agent: AgentRow): Promise<void> {
  const row = await prisma.warmTask.create({
    data: { agent_id: agent.agent_id, status: "provisioning" },
  });

  const start = Date.now();
  try {
    const pvcName = await ensureWorkspacePvc(agent.agent_id);
    if (!agent.workspace_pvc) {
      await prisma.agent.update({ where: { agent_id: agent.agent_id }, data: { workspace_pvc: pvcName } });
      agent.workspace_pvc = pvcName;
    }
    const { task_arn } = await runTask({
      agent,
      warm_task_id: row.warm_task_id,
      workspace_pvc_name: pvcName,
    });
    await prisma.warmTask.update({
      where: { warm_task_id: row.warm_task_id },
      data: { task_arn },
    });

    const sandbox_url = await waitRunningGetUrl(task_arn, agent);
    await waitHttpReady(sandbox_url);

    await prisma.warmTask.update({
      where: { warm_task_id: row.warm_task_id },
      data: { status: "warm", sandbox_url, ready_at: new Date() },
    });

    registry.observe("warm_pool_provision_duration_seconds", {}, (Date.now() - start) / 1000);
    registry.inc("warm_pool_provision_total", { result: "success" });
  } catch (e) {
    registry.inc("warm_pool_provision_total", { result: "failed" });
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      `warmPool: provision failed warm_task_id=${row.warm_task_id} agent_id=${agent.agent_id}: ${reason}`,
    );
    await prisma.warmTask
      .update({
        where: { warm_task_id: row.warm_task_id },
        data: { status: "dead", failure_reason: reason.slice(0, 500) },
      })
      .catch(() => {
        /* best-effort */
      });
  }
}

// ---------------------------------------------------------------------------
// topUpWarmPool — main worker loop
// ---------------------------------------------------------------------------

interface PoolStats {
  total_warm: number;
  total_provisioning: number;
  per_agent: Map<string, { warm: number; provisioning: number }>;
}

async function loadPoolStats(): Promise<PoolStats> {
  const rows = await prisma.warmTask.findMany({
    where: { status: { in: ["warm", "provisioning"] } },
    select: { agent_id: true, status: true },
  });
  const stats: PoolStats = {
    total_warm: 0,
    total_provisioning: 0,
    per_agent: new Map(),
  };
  for (const row of rows) {
    const cur = stats.per_agent.get(row.agent_id) ?? {
      warm: 0,
      provisioning: 0,
    };
    if (row.status === "warm") {
      cur.warm += 1;
      stats.total_warm += 1;
    } else if (row.status === "provisioning") {
      cur.provisioning += 1;
      stats.total_provisioning += 1;
    }
    stats.per_agent.set(row.agent_id, cur);
  }
  return stats;
}

/**
 * Agents whose most-recent session was created in the last
 * `WARM_POOL_RECENT_AGENT_HOURS`, ordered by recency. We only keep warm
 * tasks for these — there's no point burning Fargate hours on agents the
 * user has stopped using.
 */
async function loadRecentAgents(limit: number): Promise<AgentRow[]> {
  const cutoff = new Date(
    Date.now() - env.WARM_POOL_RECENT_AGENT_HOURS * 60 * 60 * 1000,
  );
  // Group by agent_id, latest session per agent. Done via groupBy so we
  // don't pull every session row across the cutoff.
  const groups = await prisma.session.groupBy({
    by: ["agent_id"],
    where: { created_at: { gte: cutoff } },
    _max: { created_at: true },
    orderBy: { _max: { created_at: "desc" } },
    take: limit,
  });
  if (groups.length === 0) return [];
  return prisma.agent.findMany({
    where: { agent_id: { in: groups.map((g) => g.agent_id) } },
  });
}

/**
 * Drive the pool toward target. One pass:
 *   1. Snapshot current pool depth (warm + in-flight).
 *   2. Compute how many more we can fire this tick (capped by both the
 *      per-tick concurrency budget and the absolute size cap).
 *   3. For each recently-active agent under per-agent target, fire one
 *      provisionWarmTask — fire-and-forget so a stuck launch doesn't
 *      block the next agent in line.
 *
 * Returns counts so the worker can log a single line per tick.
 */
export async function topUpWarmPool(): Promise<{
  provisioned: number;
  recycled: number;
  fallback_dead: number;
}> {
  if (env.WARM_POOL_SIZE === 0) {
    return { provisioned: 0, recycled: 0, fallback_dead: 0 };
  }

  // Bookkeeping first — recycle TTL'd rows and dead rows so capacity frees
  // up before we count toward the cap.
  const { recycled, fallback_dead } = await recycleExpired();

  const stats = await loadPoolStats();

  // Priority agent has a dedicated budget that sits outside WARM_POOL_SIZE so
  // it doesn't crowd out the shared pool for other agents.
  // Set WARM_POOL_PRIORITY_AGENT_ID + WARM_POOL_PRIORITY_SIZE to enable.
  const priorityAgentId = env.WARM_POOL_PRIORITY_AGENT_ID;
  const priorityTarget = env.WARM_POOL_PRIORITY_SIZE;
  let provisioned = 0;
  let toFire = env.WARM_POOL_MAX_PROVISIONING;

  if (priorityAgentId && toFire > 0) {
    const cur = stats.per_agent.get(priorityAgentId) ?? { warm: 0, provisioning: 0 };
    const deficit = priorityTarget - cur.warm - cur.provisioning;
    if (deficit > 0) {
      const agent = await prisma.agent.findUnique({ where: { agent_id: priorityAgentId } });
      if (agent) {
        const activeSessions = await prisma.session.count({
          where: {
            agent_id: agent.agent_id,
            status: { in: ["creating", "ready"] },
          },
        });
        if (activeSessions === 0) {
          const fires = Math.min(deficit, toFire);
          for (let i = 0; i < fires; i++) {
            void provisionWarmTask(agent);
            provisioned += 1;
            toFire -= 1;
          }
        }
      }
    }
  }

  // Shared pool for recently-active agents (excluding the priority agent which
  // has its own budget above).
  const sharedWarm = stats.total_warm - (stats.per_agent.get(priorityAgentId ?? "")?.warm ?? 0);
  const sharedProvisioning = stats.total_provisioning - (stats.per_agent.get(priorityAgentId ?? "")?.provisioning ?? 0);
  const remainingBudget = Math.max(
    0,
    env.WARM_POOL_SIZE - sharedWarm - sharedProvisioning,
  );

  if (remainingBudget > 0 && toFire > 0) {
    const candidates = await loadRecentAgents(env.WARM_POOL_SIZE);
    let sharedToFire = Math.min(remainingBudget, toFire);

    for (const agent of candidates) {
      if (sharedToFire === 0) break;
      // Priority agent is handled above — skip it here.
      if (agent.agent_id === priorityAgentId) continue;
      const cur = stats.per_agent.get(agent.agent_id) ?? { warm: 0, provisioning: 0 };
      if (cur.warm + cur.provisioning >= PER_AGENT_TARGET) continue;
      const activeSessions = await prisma.session.count({
        where: {
          agent_id: agent.agent_id,
          status: { in: ["creating", "ready"] },
        },
      });
      if (activeSessions > 0) continue;
      void provisionWarmTask(agent);
      provisioned += 1;
      sharedToFire -= 1;
    }
  }

  return { provisioned, recycled, fallback_dead };
}

// ---------------------------------------------------------------------------
// recycleExpired — TTL + dead-row cleanup
// ---------------------------------------------------------------------------

/**
 * Two cleanup passes:
 *   1. TTL: warm tasks older than `WARM_POOL_TTL_MINUTES` are stopped and
 *      marked dead. This ensures a fresh pool when the harness image or
 *      task definition is updated — operators don't have to drain manually.
 *   2. Dead rows: tasks that already errored out have their underlying
 *      ECS task stopped (best-effort) and the row is removed.
 *
 * Both passes are idempotent — safe to run on every tick.
 */
async function recycleExpired(): Promise<{
  recycled: number;
  fallback_dead: number;
}> {
  const cutoff = new Date(Date.now() - env.WARM_POOL_TTL_MINUTES * 60 * 1000);

  // 1. TTL — warm rows that are too old.
  const expired = await prisma.warmTask.findMany({
    where: { status: "warm", created_at: { lt: cutoff } },
    select: { warm_task_id: true, task_arn: true },
  });
  let recycled = 0;
  for (const row of expired) {
    if (row.task_arn) {
      await stopTask(row.task_arn, "warm pool: TTL expired").catch((e) => {
        console.warn(
          `warmPool: stopTask failed warm_task_id=${row.warm_task_id}:`,
          e,
        );
      });
    }
    await prisma.warmTask
      .update({
        where: { warm_task_id: row.warm_task_id },
        data: { status: "dead", failure_reason: "ttl-expired" },
      })
      .catch(() => {
        /* best-effort */
      });
    recycled += 1;
  }

  // 2. Dead rows — drain the underlying ECS task and delete the row so
  // it stops counting against the (status, created_at) index.
  const dead = await prisma.warmTask.findMany({
    where: { status: "dead" },
    select: { warm_task_id: true, task_arn: true },
  });
  let fallback_dead = 0;
  for (const row of dead) {
    if (row.task_arn) {
      await stopTask(row.task_arn, "warm pool: dead row").catch(() => {
        /* best-effort */
      });
    }
    await prisma.warmTask
      .delete({ where: { warm_task_id: row.warm_task_id } })
      .catch((e: unknown) => {
        // Race with a concurrent delete — Prisma surfaces P2025 for
        // "record not found", which we can ignore.
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2025"
        ) {
          return;
        }
        console.warn(
          `warmPool: delete failed warm_task_id=${row.warm_task_id}:`,
          e,
        );
      });
    fallback_dead += 1;
  }

  return { recycled, fallback_dead };
}
