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

// P2002 = Prisma's unique-constraint violation. Under bursty harness output
// two concurrent appends can both read the same MAX(seq) and race the
// insert; the loser hits the (session_id, seq) unique index and we retry.
const APPEND_RETRY_LIMIT = 8;

/**
 * Append one event to a session's log. Computes the next seq as
 * MAX(seq)+1 and inserts the row. On the rare race where two writers
 * resolve the same seq concurrently, retries up to APPEND_RETRY_LIMIT
 * times. Returns the assigned seq.
 */
export async function appendSessionEvent(
  session_id: string,
  event: SessionEvent,
): Promise<number> {
  for (let attempt = 0; attempt < APPEND_RETRY_LIMIT; attempt++) {
    const last = await prisma.sessionEvent.findFirst({
      where: { session_id },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    try {
      await prisma.sessionEvent.create({
        data: {
          session_id,
          seq,
          event_type: event.type,
          payload: event as unknown as object,
        },
      });
      return seq;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "P2002" && attempt < APPEND_RETRY_LIMIT - 1) continue;
      throw e;
    }
  }
  throw new Error(
    `appendSessionEvent: gave up after ${APPEND_RETRY_LIMIT} attempts for session ${session_id}`,
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
