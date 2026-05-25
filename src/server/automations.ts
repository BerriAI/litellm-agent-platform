/**
 * Cron-driven automations: scheduled triggers that spawn a session for an
 * agent on a recurring cadence.
 *
 * Two halves live here:
 *   - Cron helpers (validate / compute next fire) used by the API routes when
 *     a user creates or edits an automation. Schedules are 5-field cron
 *     evaluated in UTC.
 *   - `tickAutomations`, called every worker tick (see src/worker/index.ts),
 *     which claims due rows and fires their sessions.
 *
 * Multi-pod safety: claiming uses `SELECT ... FOR UPDATE SKIP LOCKED` inside a
 * transaction that also advances `next_run_at` to the next occurrence before
 * commit. Two pods ticking at the same instant can't double-fire — pod B's
 * SKIP LOCKED skips the row pod A holds, and once pod A commits the row's
 * next_run_at is in the future so it isn't re-claimed. Session bring-up (a
 * 30s+ cold spawn) runs *outside* the transaction so the row lock window stays
 * tiny.
 */

import os from "os";
import type { AutomationRun } from "@prisma/client";
import { Cron } from "croner";
import { prisma } from "@/server/db";
import { env } from "@/server/env";

// Cron expressions are interpreted in UTC so the schedule a user picks means
// the same wall-clock instant regardless of where the worker pod runs.
const CRON_TIMEZONE = "UTC";

// Cap rows claimed per tick so one busy instant can't spawn an unbounded
// number of sandboxes in a single transaction.
const MAX_DUE_PER_TICK = 50;

/** True if `expr` is a cron pattern croner can schedule. */
export function isValidCron(expr: string): boolean {
  try {
    // Constructing throws on an unparseable pattern. No function is passed,
    // so this never schedules a real timer — it's just a parse.
    new Cron(expr, { timezone: CRON_TIMEZONE });
    return true;
  } catch {
    return false;
  }
}

/**
 * Next fire instant strictly after `from` (default now) for `expr`, in UTC.
 * Throws on an invalid pattern — callers validate with `isValidCron` first.
 * Returns null when the pattern has no future occurrence (shouldn't happen
 * for a recurring 5-field cron, but croner allows one-shot patterns).
 */
export function computeNextRunAt(expr: string, from: Date = new Date()): Date | null {
  return new Cron(expr, { timezone: CRON_TIMEZONE }).nextRun(from);
}

// Shape of the rows returned by the raw claim query — snake_case DB columns.
interface DueAutomationRow {
  automation_id: string;
  agent_id: string;
  name: string | null;
  instruction: string;
  cron_expr: string;
}

export interface AutomationTickResult {
  claimed: number;
  fired: number;
  failed: number;
}

// A run that hasn't resolved within this window is marked failed by the
// reconciler — guards against a run stuck `running` forever if its session row
// is deleted or the agent task never settles.
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Spawn a session for one automation via the existing v1 session-create route.
 * Mirrors the integrations dispatcher: an in-process fetch authenticated with
 * MASTER_KEY, so all warm-pool / cold-fallback logic is reused rather than
 * duplicated here. Returns the spawned session id.
 */
async function spawnAutomationSession(auto: DueAutomationRow): Promise<string> {
  // The worker runs in its own pod — `localhost` is NOT the web server there.
  // Resolve a reachable base URL: explicit BASE_URL, else the cluster-internal
  // Service DNS (PLATFORM_INTERNAL_URL), else the external URL, else localhost
  // for single-process local dev. Without this the worker fetches
  // localhost:3000, gets ECONNREFUSED, and every run fails with "fetch failed".
  const baseUrl =
    process.env.BASE_URL ||
    env.PLATFORM_INTERNAL_URL ||
    env.LAP_BASE_URL ||
    "http://localhost:3000";
  const host = os.hostname();
  console.log("[automation] spawnAutomationSession", { baseUrl, agent_id: auto.agent_id, automation_id: auto.automation_id, pid: process.pid, host });
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/managed_agents/agents/${encodeURIComponent(
    auto.agent_id,
  )}/session`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MASTER_KEY}`,
    },
    body: JSON.stringify({
      initial_prompt: auto.instruction,
      title: `[auto:${baseUrl.replace(/https?:\/\//,'').slice(0,20)}] ${auto.name ?? auto.automation_id.slice(0, 8)}`,
    }),
  });
  console.log("[automation] session create response", { status: res.status, url, automation_id: auto.automation_id });
  if (!res.ok) {
    const body = await res.text();
    console.error("[automation] session create FAILED", { status: res.status, body, url, baseUrl, host, pid: process.pid });
    throw new Error(`session create failed: ${res.status} ${body} [host=${host} pid=${process.pid} baseUrl=${baseUrl}]`);
  }
  // toApiSession renames session_id → id.
  const session = (await res.json()) as { id: string };
  return session.id;
}

/**
 * Fire one automation and record a run. Creates the run row up front (status
 * `running`), then spawns the session and stores its id; on spawn failure the
 * run is marked `failed` immediately. Throws on failure so the caller's
 * Promise.allSettled tally counts it.
 */
async function fireAutomation(
  auto: DueAutomationRow,
  startedAt: Date,
): Promise<void> {
  const run = await prisma.automationRun.create({
    data: {
      automation_id: auto.automation_id,
      agent_id: auto.agent_id,
      status: "running",
      started_at: startedAt,
    },
  });
  try {
    const sessionId = await spawnAutomationSession(auto);
    await prisma.automationRun.update({
      where: { run_id: run.run_id },
      data: { session_id: sessionId },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await prisma.automationRun.update({
      where: { run_id: run.run_id },
      data: { status: "failed", error: reason, finished_at: new Date() },
    });
    throw e;
  }
}

/**
 * Fire one automation immediately, ignoring its schedule — for the UI
 * "Run now" testing button. Records a run exactly like the worker tick would
 * and returns it (running, or failed if the spawn failed). Does NOT touch
 * next_run_at, so the normal schedule continues unaffected. Returns null if
 * the automation doesn't exist.
 */
export async function runAutomationNow(
  automationId: string,
): Promise<AutomationRun | null> {
  const auto = await prisma.automation.findUnique({
    where: { automation_id: automationId },
  });
  if (auto === null) return null;
  const row: DueAutomationRow = {
    automation_id: auto.automation_id,
    agent_id: auto.agent_id,
    name: auto.name,
    instruction: auto.instruction,
    cron_expr: auto.cron_expr,
  };
  try {
    await fireAutomation(row, new Date());
  } catch {
    // fireAutomation already recorded the run as failed; swallow so the
    // caller gets the run row back rather than an exception.
  }
  return prisma.automationRun.findFirst({
    where: { automation_id: automationId },
    orderBy: { started_at: "desc" },
  });
}

/**
 * One worker pass: claim every due automation, advance each to its next
 * occurrence, then fire the sessions. Safe to run concurrently across pods.
 */
export async function tickAutomations(): Promise<AutomationTickResult> {
  // Bind a JS Date rather than SQL now(): next_run_at is a `timestamp`
  // (no tz) that Prisma reads/writes as UTC, so comparing it to a bound Date
  // is unambiguous, whereas `now()` is a timestamptz that Postgres would cast
  // against the session timezone. Reuse the same instant for the due check and
  // the re-anchoring below.
  const now = new Date();
  console.log("[tickAutomations] tick start", { now: now.toISOString(), pid: process.pid, BASE_URL: process.env.BASE_URL, PLATFORM_INTERNAL_URL: process.env.PLATFORM_INTERNAL_URL, LAP_BASE_URL: process.env.LAP_BASE_URL });

  // Claim + advance atomically. The lock is held only for the duration of the
  // next_run_at updates — never across the session spawn below.
  const due = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<DueAutomationRow[]>`
      SELECT automation_id, agent_id, name, instruction, cron_expr
      FROM managed_agent_automation
      WHERE enabled = true
        AND next_run_at IS NOT NULL
        AND next_run_at <= ${now}
      ORDER BY next_run_at ASC
      LIMIT ${MAX_DUE_PER_TICK}
      FOR UPDATE SKIP LOCKED
    `;

    for (const auto of rows) {
      // Re-anchor from `now`, not the missed scheduled time, so a worker that
      // was down doesn't fire a burst of catch-up runs on recovery.
      const nextRunAt = computeNextRunAt(auto.cron_expr, now);
      await tx.automation.update({
        where: { automation_id: auto.automation_id },
        data: {
          last_run_at: now,
          next_run_at: nextRunAt,
          // A cron with no further occurrence (e.g. a date that has now
          // passed) yields a null next_run_at. Disable the row so it doesn't
          // sit "Enabled" forever with no next fire — the worker query filters
          // out null next_run_at, so it'd otherwise be silently stuck.
          ...(nextRunAt === null ? { enabled: false } : {}),
        },
      });
    }
    return rows;
  });

  console.log("[tickAutomations] claimed", { count: due.length, automations: due.map(a => ({ id: a.automation_id, agent: a.agent_id })) });
  if (due.length === 0) return { claimed: 0, fired: 0, failed: 0 };

  // Fire outside the transaction. Failures are isolated per automation —
  // next_run_at was already advanced, so a failed spawn just waits for the
  // next occurrence rather than retrying on the next tick.
  const results = await Promise.allSettled(due.map((a) => fireAutomation(a, now)));
  let fired = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      fired++;
    } else {
      failed++;
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(
        `automation spawn failed: automation_id=${due[i].automation_id} agent_id=${due[i].agent_id} reason=${reason}`,
      );
    }
  }
  return { claimed: due.length, fired, failed };
}

export interface AutomationRunReconcileResult {
  resolved: number;
}

/**
 * Resolve `running` automation runs by inspecting their spawned session:
 *   - session produced a reply (`response` set)        → succeeded
 *   - session ended in `failed`/`dead`, or recorded a
 *     `failure_reason`, or its row is gone             → failed
 *   - neither, but the run is older than RUN_TIMEOUT_MS → failed (timed out)
 * Anything else stays `running` for a later tick. Batches the session lookup so
 * this is two queries plus one update per resolved run.
 */
export async function reconcileAutomationRuns(): Promise<AutomationRunReconcileResult> {
  const open = await prisma.automationRun.findMany({ where: { status: "running" } });
  if (open.length === 0) return { resolved: 0 };

  const sessionIds = open
    .map((r) => r.session_id)
    .filter((s): s is string => s !== null);
  const sessions =
    sessionIds.length > 0
      ? await prisma.session.findMany({
          where: { session_id: { in: sessionIds } },
          select: {
            session_id: true,
            status: true,
            response: true,
            failure_reason: true,
          },
        })
      : [];
  const byId = new Map(sessions.map((s) => [s.session_id, s]));

  const nowMs = Date.now();
  let resolved = 0;
  for (const run of open) {
    let status: "succeeded" | "failed" | null = null;
    let error: string | null = null;

    if (run.session_id) {
      const s = byId.get(run.session_id);
      if (!s) {
        status = "failed";
        error = "session no longer exists";
      } else if (s.response !== null) {
        status = "succeeded";
      } else if (s.status === "failed" || s.status === "dead") {
        status = "failed";
        error = s.failure_reason ?? `session ${s.status}`;
      } else if (s.failure_reason !== null) {
        status = "failed";
        error = s.failure_reason;
      }
    }

    if (status === null && nowMs - run.started_at.getTime() > RUN_TIMEOUT_MS) {
      status = "failed";
      error = "timed out";
    }

    if (status !== null) {
      await prisma.automationRun.update({
        where: { run_id: run.run_id },
        data: { status, error, finished_at: new Date() },
      });
      resolved++;
    }
  }
  return { resolved };
}
