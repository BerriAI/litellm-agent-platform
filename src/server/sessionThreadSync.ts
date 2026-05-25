/**
 * Durable-log persistence for the opencode passthrough.
 *
 * The web UI (and the `lap` CLI) talk to the harness through the verbatim
 * `/sessions/:id/opencode/[...path]` proxy using the opencode SDK — they never
 * hit our `/message` route. So the durable conversation log (SessionMessage)
 * has to be populated from that passthrough:
 *
 *   - `recordUserSend` — on a message/prompt_async POST, persist the user turn
 *     before the prompt reaches the harness (durable-before-send).
 *   - `watchEventStreamAndSnapshot` — tee the `/event` SSE; when `session.idle`
 *     fires for this session, snapshot the harness thread into the DB
 *     (history blob + complete the durable user turn with the assistant reply).
 *
 * Everything here is best-effort: persistence must never break the proxy.
 */

import { harnessListMessages } from "@/server/harness";
import { appendUserMessage, syncSessionThread } from "@/server/sessionStore";
import type { HarnessMessagePart } from "@/server/types";

// Parse the opencode send body ({ model, parts }) and persist the user turn as
// `pending` before the prompt is forwarded to the harness. Returns the new
// row's message_id (or null) so the caller can flag it `failed` if the harness
// call errors — otherwise a rejected turn lingers as `pending` and gets
// replayed on the next recovery.
export async function recordUserSend(opts: {
  session_id: string;
  harness_session_id: string;
  body: ArrayBuffer;
}): Promise<string | null> {
  try {
    const text = new TextDecoder().decode(opts.body);
    if (!text) return null;
    const parsed = JSON.parse(text) as { parts?: unknown };
    const parts = Array.isArray(parsed.parts)
      ? (parsed.parts as HarnessMessagePart[])
      : [];
    if (parts.length === 0) return null;
    const row = await appendUserMessage({
      session_id: opts.session_id,
      harness_session_id: opts.harness_session_id,
      parts,
    });
    return row?.message_id ?? null;
  } catch (err) {
    console.warn(`recordUserSend failed for ${opts.session_id}:`, err);
    return null;
  }
}

// Fetch the harness thread and reconcile it into the DB (history + durable log).
export async function snapshotSessionThread(opts: {
  session_id: string;
  sandbox_url: string;
  harness_session_id: string;
}): Promise<void> {
  try {
    const thread = await harnessListMessages({
      sandbox_url: opts.sandbox_url,
      harness_session_id: opts.harness_session_id,
    });
    await syncSessionThread({
      session_id: opts.session_id,
      harness_session_id: opts.harness_session_id,
      thread,
    });
  } catch (err) {
    console.warn(`snapshotSessionThread failed for ${opts.session_id}:`, err);
  }
}

interface BusEvent {
  type?: string;
  properties?: { sessionID?: string };
}

/**
 * Consume a tee'd copy of the `/event` SSE server-side and snapshot the thread
 * each time this session goes idle (one turn finished). Runs for the life of
 * the stream; returns when the client disconnects / the stream ends.
 */
export async function watchEventStreamAndSnapshot(
  stream: ReadableStream<Uint8Array>,
  opts: { session_id: string; sandbox_url: string; harness_session_id: string },
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  // Checkpoint mid-turn every 15s so autonomous long-running turns leave a
  // partial record in the DB if the pod dies before session.idle fires.
  const snapshotInterval = setInterval(() => {
    console.log(`[heartbeat] session=${opts.session_id} mid-turn snapshot`);
    void snapshotSessionThread(opts);
  }, 15_000);

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      // SSE frames are terminated by a blank line.
      for (;;) {
        const idx = pending.indexOf("\n\n");
        if (idx < 0) break;
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trimStart();
          if (!raw) continue;
          let evt: BusEvent;
          try {
            evt = JSON.parse(raw) as BusEvent;
          } catch {
            continue;
          }
          if (
            evt.type === "session.idle" &&
            evt.properties?.sessionID === opts.harness_session_id
          ) {
            // Fire-and-forget — don't stall reading the bus on a DB round-trip.
            void snapshotSessionThread(opts);
          }
        }
      }
    }
  } catch {
    // Stream aborted (client disconnect) or upstream error — nothing to do.
  } finally {
    clearInterval(snapshotInterval);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
