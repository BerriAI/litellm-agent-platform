/**
 * Worker liveness check used by the session-create + send-message paths.
 *
 * The SessionEvent worker writes to `lap_worker_heartbeat` every 5s. If
 * that row is older than HEARTBEAT_STALE_AFTER_MS we treat the worker as
 * dead — accepting a session create or a message in that state would
 * silently lose the user's events, which is what we just shipped this
 * for. So we refuse with a clear `failure_reason` instead.
 *
 * Bypass: set ALLOW_MISSING_WORKER=true in the env. Useful for
 * standalone unit tests that never bring up a worker.
 */
import { prisma } from "./db";

export const HEARTBEAT_STALE_AFTER_MS = 15_000;

export interface WorkerStatus {
  alive: boolean;
  last_seen_at: string | null;
  stale_ms: number | null;
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  const row = await prisma.workerHeartbeat.findUnique({ where: { id: 1 } });
  if (!row) return { alive: false, last_seen_at: null, stale_ms: null };
  const stale_ms = Date.now() - row.last_seen_at.getTime();
  return {
    alive: stale_ms < HEARTBEAT_STALE_AFTER_MS,
    last_seen_at: row.last_seen_at.toISOString(),
    stale_ms,
  };
}

export class WorkerDeadError extends Error {
  constructor(public status: WorkerStatus) {
    const detail = status.last_seen_at
      ? `last heartbeat ${Math.round((status.stale_ms ?? 0) / 1000)}s ago`
      : "never seen";
    super(
      `worker is not running (${detail}). Start it with: ` +
        `npx tsx src/worker/index.ts`,
    );
    this.name = "WorkerDeadError";
  }
}

/**
 * Throws `WorkerDeadError` when the worker hasn't checked in recently.
 * Callers convert to an HTTP 503 + write the message into the session's
 * `failure_reason` so the UI can render it.
 */
export async function requireFreshWorker(): Promise<void> {
  if (process.env.ALLOW_MISSING_WORKER === "true") return;
  const status = await getWorkerStatus();
  if (!status.alive) throw new WorkerDeadError(status);
}
