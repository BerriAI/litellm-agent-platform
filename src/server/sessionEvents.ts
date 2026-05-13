/**
 * Persistence helpers for the SessionEvent log
 * (managed_agent_session_event table).
 *
 * Writers (the worker SSE subscriber) call appendSessionEvent — atomically
 * assigns the next per-session seq inside a transaction and inserts the row.
 *
 * Readers (API: GET /sessions/{id}/events?since=N&wait=MS) call
 * waitForEventsSince — returns immediately if there are events with seq>since,
 * otherwise short-polls for up to wait_ms before returning whatever it has.
 */
import { prisma } from "./db";
import type { ApiSessionEvent, SessionEvent } from "./types";

const MAX_FETCH = 500;
const POLL_INTERVAL_MS = 250;

interface Row {
  session_id: string;
  seq: number;
  event_type: string;
  payload: unknown;
  ts: Date;
}

function toApi(row: Row): ApiSessionEvent {
  return {
    session_id: row.session_id,
    seq: row.seq,
    event: row.payload as SessionEvent,
    ts: row.ts.toISOString(),
  };
}

// Race on the seq primary key: two concurrent writers can both read the
// same MAX(seq) and try to insert the same seq. We retry on that, capped.
const SEQ_RETRY_LIMIT = 8;

/**
 * Append one event to a session's log. Idempotent: a second/third writer
 * delivering the same event_id collapses to ONE row via
 *   INSERT … ON CONFLICT (session_id, event_id) DO NOTHING
 * Returns the resolved seq — the one that landed, or the existing one if
 * the row was already there.
 *
 * Two unique constraints are in play:
 *   - (session_id, seq) PK — the ordering, retried on conflict
 *   - (session_id, event_id) — the dedupe, swallowed silently
 */
export async function appendSessionEvent(
  session_id: string,
  event: SessionEvent,
): Promise<number> {
  for (let attempt = 0; attempt < SEQ_RETRY_LIMIT; attempt++) {
    const last = await prisma.sessionEvent.findFirst({
      where: { session_id },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    // Raw INSERT … ON CONFLICT lets us treat the (session_id, event_id)
    // collision as success-with-no-write while still surfacing the seq
    // collision so we can retry. RETURNING gives the assigned seq when
    // the insert lands; an empty result means the event_id already
    // existed, in which case we look up the seq it landed under earlier.
    const rows = await prisma.$queryRaw<Array<{ seq: number }>>`
      INSERT INTO "managed_agent_session_event"
        ("session_id", "seq", "event_type", "payload", "event_id", "ts")
      VALUES
        (${session_id}, ${seq}, ${event.type}, ${JSON.stringify(event)}::jsonb,
         ${event.event_id}, NOW())
      ON CONFLICT ("session_id", "event_id") DO NOTHING
      RETURNING "seq"
    `;
    if (rows.length > 0) return rows[0].seq;

    // event_id already there → look up the row that landed and return
    // its seq so callers stay consistent. This is the dedupe success path.
    const existing = await prisma.sessionEvent.findFirst({
      where: { session_id, event_id: event.event_id },
      select: { seq: true },
    });
    if (existing) return existing.seq;

    // Neither path returned a row → we lost the seq race (another writer
    // grabbed our seq with a different event_id). Loop and retry with
    // MAX(seq)+1 recomputed.
  }
  throw new Error(
    `appendSessionEvent: gave up after ${SEQ_RETRY_LIMIT} attempts for session ${session_id}`,
  );
}

/**
 * Fetch all persisted events for a session with seq > `since`, ordered by
 * seq ascending. Capped at MAX_FETCH (500) — callers paginate by passing the
 * last seq back as the next `since`.
 */
export async function getSessionEvents(
  session_id: string,
  since: number,
): Promise<ApiSessionEvent[]> {
  const rows = await prisma.sessionEvent.findMany({
    where: { session_id, seq: { gt: since } },
    orderBy: { seq: "asc" },
    take: MAX_FETCH,
  });
  return rows.map(toApi);
}

/**
 * Long-poll wrapper for getSessionEvents. Returns immediately if there are
 * events with seq > `since`. Otherwise polls every POLL_INTERVAL_MS up to
 * `wait_ms` total, returning as soon as results appear (or [] on timeout).
 */
export async function waitForEventsSince(
  session_id: string,
  since: number,
  wait_ms: number,
): Promise<ApiSessionEvent[]> {
  const initial = await getSessionEvents(session_id, since);
  if (initial.length > 0 || wait_ms <= 0) return initial;

  const deadline = Date.now() + wait_ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const sleep = Math.min(POLL_INTERVAL_MS, remaining);
    if (sleep > 0) {
      await new Promise((r) => setTimeout(r, sleep));
    }
    const rows = await getSessionEvents(session_id, since);
    if (rows.length > 0) return rows;
  }
  return [];
}
