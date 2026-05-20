/**
 * Hot-path session cache. Removes two prisma round-trips from the
 * `POST /sessions/:id/message` flow:
 *
 *   1. `findUnique({include: agent})` -> in-memory map keyed by session_id,
 *      populated on first miss and invalidated on restart / delete.
 *   2. `update({last_seen_at})` -> in-memory `pending` map, batched and
 *      flushed every FLUSH_INTERVAL_MS in a single `updateMany`.
 *
 * Process-local. With multiple web replicas each holds its own cache and
 * its own pending map; the DB writes converge at flush time. The reconciler
 * still reads `last_seen_at` from the DB, so the worst-case staleness for
 * the idle-sweep clock is FLUSH_INTERVAL_MS — well under
 * SESSION_IDLE_TIMEOUT_MS.
 */

import { prisma } from "@/server/db";
import { HARNESS_BRAIN_INLINE } from "@/server/types";

export interface SessionCacheEntry {
  session_id: string;
  agent_id: string;
  agent_model: string;
  harness_id: string;
  sandbox_url: string;
  harness_session_id: string;
  status: string;
}

const FLUSH_INTERVAL_MS = 5_000;
// Bound the cache so a long-running web process with thousands of distinct
// sessions over its lifetime doesn't grow without limit. Soft cap — we drop
// the oldest entry on insert overflow. Live-set fits under this in practice
// (a single user has a handful of active sessions at a time).
const MAX_ENTRIES = 10_000;

const cache = new Map<string, SessionCacheEntry>();
const pendingLastSeen = new Map<string, Date>();

let _flushTimer: NodeJS.Timeout | null = null;

function evictIfFull(): void {
  if (cache.size < MAX_ENTRIES) return;
  // Map iteration order = insertion order. Drop the oldest.
  const oldestKey = cache.keys().next().value;
  if (oldestKey) cache.delete(oldestKey);
}

export function putCachedSession(entry: SessionCacheEntry): void {
  cache.delete(entry.session_id); // re-insert so it becomes "newest"
  evictIfFull();
  cache.set(entry.session_id, entry);
}

export function invalidateSession(session_id: string): void {
  cache.delete(session_id);
  pendingLastSeen.delete(session_id);
}

/**
 * Hydrate the cache from a DB row on first miss. Returns null when the row
 * is absent or not in `ready` state. The route that calls this is the only
 * place we treat non-ready as a 404/409 anyway, so withholding cache for
 * those states keeps the entry from going stale across status flips.
 */
async function hydrate(
  session_id: string,
): Promise<SessionCacheEntry | null> {
  const row = await prisma.session.findUnique({
    where: { session_id },
    include: { agent: true },
  });
  if (!row || row.status !== "ready" || !row.agent) {
    return null;
  }
  // brain-inline sessions never write sandbox_url / harness_session_id to the
  // DB — the in-process brain needs neither. Skip those checks for this
  // harness so that cache misses (process restart, cache eviction) can still
  // hydrate correctly rather than permanently returning null/404.
  const isBrainInline = row.agent.harness_id === HARNESS_BRAIN_INLINE;
  if (!isBrainInline && (!row.sandbox_url || !row.harness_session_id)) {
    return null;
  }
  const entry: SessionCacheEntry = {
    session_id: row.session_id,
    agent_id: row.agent_id,
    agent_model: row.agent.model,
    harness_id: row.agent.harness_id,
    sandbox_url: row.sandbox_url ?? "",
    harness_session_id: row.harness_session_id ?? "",
    status: row.status,
  };
  putCachedSession(entry);
  return entry;
}

export async function getCachedSession(
  session_id: string,
): Promise<SessionCacheEntry | null> {
  const hit = cache.get(session_id);
  if (hit) return hit;
  return hydrate(session_id);
}

/**
 * Record a user message arrival in-memory. The flush loop persists the
 * highest-watermark timestamp per session in a single batch.
 */
export function markSessionSeen(session_id: string, ts: Date = new Date()): void {
  const prev = pendingLastSeen.get(session_id);
  if (!prev || ts.getTime() > prev.getTime()) {
    pendingLastSeen.set(session_id, ts);
  }
}

/**
 * Drain the pending map and write all timestamps in a single transaction.
 * Returns the number of rows updated. Idempotent — safe to call concurrently
 * with itself; we snapshot+clear up front so a slow DB write doesn't drop
 * timestamps from a parallel flush.
 */
export async function flushLastSeen(): Promise<number> {
  if (pendingLastSeen.size === 0) return 0;
  const drained = Array.from(pendingLastSeen.entries());
  pendingLastSeen.clear();

  // One UPDATE per row; Postgres can't bulk-set distinct values per PK in
  // a single statement without a CTE / unnest. Wrap the loop in a single
  // transaction so the round-trip cost amortizes across all entries.
  try {
    await prisma.$transaction(
      drained.map(([session_id, ts]) =>
        prisma.session.update({
          where: { session_id },
          data: { last_seen_at: ts },
        }),
      ),
    );
    return drained.length;
  } catch (err) {
    // Re-stage so the next tick retries. The map is keyed by session_id and
    // markSessionSeen keeps the highest-watermark timestamp per key, so size
    // is bounded by the number of distinct active session ids — not by call
    // volume. MAX_ENTRIES caps the read cache, not pendingLastSeen.
    for (const [sid, ts] of drained) markSessionSeen(sid, ts);
    console.warn(`flushLastSeen failed (${drained.length} entries):`, err);
    return 0;
  }
}

/**
 * Start the periodic flush. Must be called from a long-lived process — for
 * the Next.js web server we hook this off the route module's first import
 * via `ensureFlushLoop()`. The worker has its own reconcile tick and does
 * not need to call this.
 */
export function ensureFlushLoop(intervalMs: number = FLUSH_INTERVAL_MS): void {
  if (_flushTimer !== null) return;
  _flushTimer = setInterval(() => {
    void flushLastSeen();
  }, intervalMs);
  // Don't keep the event loop alive solely for this — when next dev restarts
  // we want the process to exit cleanly.
  if (typeof _flushTimer.unref === "function") _flushTimer.unref();
}
