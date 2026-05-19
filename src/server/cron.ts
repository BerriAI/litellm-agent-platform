/**
 * Scheduled-trigger plumbing for Agents.
 *
 * Background: every LAP session is started by an external trigger today —
 * a human in chat, a Slack/Linear webhook, or `POST /agents/{id}/session`.
 * This module adds the missing "run this agent every day at 9am PT" path.
 *
 * Architecture:
 *
 *   1. Each Agent row can carry a standard 5-field cron (`cron_schedule`)
 *      interpreted in `cron_timezone` (IANA name). When set, the worker
 *      computes the next UTC instant the schedule fires and stores it in
 *      `cron_next_fire_at`.
 *
 *   2. The worker's cron tick (`tickCron`) runs alongside `reconcileOrphans`
 *      and `topUpWarmPool`. Every interval it claims-and-fires every Agent
 *      whose `cron_next_fire_at <= now()`, using `SELECT … FOR UPDATE SKIP
 *      LOCKED` so multiple worker pods can run safely without double-firing.
 *
 *   3. For each due agent it creates a Session row tagged `trigger="cron"`,
 *      fires the bring-up exactly the way the HTTP route does (warm-pool
 *      first, fall back to cold), then updates `cron_last_fired_at` and the
 *      next fire instant.
 *
 *   4. Overlap policy: when the previous cron run is still active (status
 *      in {creating, ready}) and `cron_overlap_policy = "skip"`, the next
 *      fire is recomputed and the run is dropped. "queue" / "parallel" are
 *      reserved for a follow-up.
 *
 * Multi-pod safety: `claimDueAgents` is the single source of truth for
 * concurrency. It runs inside a transaction that takes a row-level lock
 * via raw SQL (Prisma's query builder doesn't expose `FOR UPDATE SKIP
 * LOCKED`). Any pod that loses the race for a given row simply moves on.
 */

import { CronExpressionParser } from "cron-parser";
import { Prisma } from "@prisma/client";

import { prisma } from "@/server/db";
import { runBringUpForCron } from "@/server/cron-bringup";
import { claimWarmTask, markClaimedTaskDead, topUpWarmPool } from "@/server/warmPool";
import type { AgentRow } from "@/server/types";

/**
 * Validate a cron string + timezone pair. Throws `Error` with a human-
 * readable message when invalid — callers (API routes) should map that to
 * a 400. Empty / null `schedule` returns null without throwing so the
 * "no schedule" path is callable from the same place.
 */
export function parseCronSpec(
  schedule: string | null | undefined,
  timezone: string,
): { next: Date | null } {
  if (!schedule || schedule.trim() === "") return { next: null };
  // Sanity-check the timezone before passing to cron-parser, which emits a
  // less actionable error for unknown tz strings.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(
      `invalid cron_timezone "${timezone}" — must be an IANA name (e.g. America/Los_Angeles)`,
    );
  }
  let it;
  try {
    it = CronExpressionParser.parse(schedule.trim(), { tz: timezone });
  } catch (e) {
    throw new Error(
      `invalid cron_schedule "${schedule}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return { next: it.next().toDate() };
}

/**
 * Compute the next fire instant relative to a starting point (defaults to
 * now). Used after a successful fire to advance `cron_next_fire_at`, and
 * when an Agent's schedule/timezone is changed via PATCH.
 */
export function computeNextFireAt(
  schedule: string,
  timezone: string,
  after: Date = new Date(),
): Date {
  const it = CronExpressionParser.parse(schedule.trim(), {
    tz: timezone,
    currentDate: after,
  });
  return it.next().toDate();
}

// ---------------------------------------------------------------------------
// claimDueAgents
//
// Inside a transaction, lock + return every Agent that is due to fire right
// now. The `FOR UPDATE SKIP LOCKED` clause is the multi-pod safety net:
//   - "FOR UPDATE" takes a row-level lock so a sibling pod racing the same
//     row blocks instead of double-claiming.
//   - "SKIP LOCKED" makes the sibling pod skip the locked row and move to
//     the next candidate instead of blocking, so a slow fire on pod A
//     doesn't stall pod B.
//
// Callers MUST commit (or rollback) the transaction promptly — the locks
// are held until then. We return rows by id and the caller's tx callback
// updates `cron_next_fire_at` on each within the same tx.
//
// Limit: at most 50 due agents per tick. Anything beyond that gets picked
// up on the next tick. A single tick should not be unbounded — a stuck
// run shouldn't be able to swamp the pool.
// ---------------------------------------------------------------------------

const CRON_BATCH_LIMIT = 50;

interface DueAgent {
  agent_id: string;
  cron_schedule: string;
  cron_timezone: string;
}

async function claimDueAgents(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<DueAgent[]> {
  // Raw query: Prisma's findMany has no FOR UPDATE SKIP LOCKED.
  // Returned columns are intentionally minimal — the full row is loaded
  // separately by the firing code, outside the lock, to keep the lock
  // window as short as possible.
  const rows = await tx.$queryRaw<DueAgent[]>`
    SELECT agent_id, cron_schedule, cron_timezone
    FROM managed_agent
    WHERE cron_enabled = true
      AND cron_schedule IS NOT NULL
      AND cron_next_fire_at IS NOT NULL
      AND cron_next_fire_at <= ${now}
    ORDER BY cron_next_fire_at ASC
    LIMIT ${CRON_BATCH_LIMIT}
    FOR UPDATE SKIP LOCKED
  `;
  return rows;
}

/**
 * Has this agent got a still-active cron-triggered session? Used for the
 * "skip" overlap policy: don't start a new cron run while a previous one
 * is still mid-bring-up or in `ready`.
 *
 * "ready" counts as still-active because a ready session represents the
 * agent loop running through the initial prompt — for a daily report
 * agent, the previous day's run may still be writing output.
 */
async function hasActiveCronRun(agent_id: string): Promise<boolean> {
  const row = await prisma.session.findFirst({
    where: {
      agent_id,
      trigger: "cron",
      status: { in: ["creating", "ready"] },
    },
    select: { session_id: true },
  });
  return row !== null;
}

// ---------------------------------------------------------------------------
// tickCron
//
// One tick of the scheduler. Returns counters so the worker heartbeat can
// log them. Designed to be safe under concurrent invocation from multiple
// worker pods — claimDueAgents is the synchronization point.
// ---------------------------------------------------------------------------

export interface CronTickResult {
  considered: number;
  fired: number;
  skipped_overlap: number;
  errors: number;
}

export async function tickCron(now: Date = new Date()): Promise<CronTickResult> {
  const result: CronTickResult = {
    considered: 0,
    fired: 0,
    skipped_overlap: 0,
    errors: 0,
  };

  // Phase 1: inside a transaction, lock-and-pop the due rows and advance
  // their cron_next_fire_at so a sibling pod won't see them on its next
  // tick. We do NOT do the bring-up inside this transaction — bring-up
  // can take seconds, and holding row locks for that long would serialize
  // unrelated firings and risk hitting Postgres idle_in_transaction
  // timeouts. Instead we collect the (agent_id, intended_fire_at) pairs
  // and run bring-up after the transaction commits.
  let dueAgents: DueAgent[] = [];
  try {
    dueAgents = await prisma.$transaction(async (tx) => {
      const claimed = await claimDueAgents(tx, now);
      if (claimed.length === 0) return [];
      // Advance cron_next_fire_at for each. If a schedule is somehow
      // invalid at this point (e.g. user mutated it to garbage between
      // last fire and this tick), disable it and log; we don't want a
      // malformed schedule to wedge the tick loop.
      for (const a of claimed) {
        try {
          const next = computeNextFireAt(a.cron_schedule, a.cron_timezone, now);
          await tx.agent.update({
            where: { agent_id: a.agent_id },
            data: { cron_next_fire_at: next, cron_last_fired_at: now },
          });
        } catch (e) {
          console.error(
            `cron: disabling agent ${a.agent_id} — invalid schedule at fire time: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          await tx.agent.update({
            where: { agent_id: a.agent_id },
            data: { cron_enabled: false, cron_next_fire_at: null },
          });
        }
      }
      return claimed;
    });
  } catch (e) {
    // Transaction-level failure — log and bail. Next tick will retry.
    console.error(
      `cron: claim transaction failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    result.errors += 1;
    return result;
  }

  result.considered = dueAgents.length;

  // Phase 2: fire each agent outside the transaction. Failures are
  // per-agent — one bad agent must not block the rest of the tick.
  for (const due of dueAgents) {
    try {
      const agent = await prisma.agent.findUnique({
        where: { agent_id: due.agent_id },
      });
      if (agent === null) continue;

      // Overlap policy. "skip" is the only supported value in v1; the
      // column is keyed for future "queue" / "parallel" semantics.
      const policy =
        (agent as unknown as { cron_overlap_policy?: string })
          .cron_overlap_policy ?? "skip";
      if (policy === "skip" && (await hasActiveCronRun(agent.agent_id))) {
        result.skipped_overlap += 1;
        console.log(
          `cron: skipping agent_id=${agent.agent_id} — previous cron run still active`,
        );
        continue;
      }

      await fireCronRun(agent as AgentRow, now);
      result.fired += 1;
    } catch (e) {
      result.errors += 1;
      console.error(
        `cron: fire failed for agent_id=${due.agent_id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return result;
}

/**
 * Create a Session for `agent` tagged trigger="cron" and kick off the
 * bring-up the same way the HTTP route does (warm claim if available,
 * fall back to cold). Returns once the Session row is persisted; the
 * actual sandbox provisioning runs fire-and-forget.
 */
async function fireCronRun(agent: AgentRow, now: Date): Promise<void> {
  const warm = await claimWarmTask(agent.agent_id);
  if (warm) void topUpWarmPool().catch(() => {});

  const initial_prompt = `[cron] scheduled run at ${now.toISOString()}`;

  let session;
  try {
    session = await prisma.session.create({
      data: {
        agent_id: agent.agent_id,
        status: "creating",
        // `created_by` left null for cron-driven runs — there is no
        // human identity to attribute. The session's `trigger="cron"`
        // tag is how the UI identifies these.
        trigger: "cron" as unknown as string,
        ...(warm?.task_arn ? { task_arn: warm.task_arn } : {}),
        ...(warm?.sandbox_url ? { sandbox_url: warm.sandbox_url } : {}),
      } as unknown as Prisma.SessionUncheckedCreateInput,
    });
  } catch (e) {
    if (warm) {
      await markClaimedTaskDead(
        warm.warm_task_id,
        `cron session row create failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      ).catch(() => {});
    }
    throw e;
  }

  void runBringUpForCron(agent, session.session_id, initial_prompt, warm);
}
