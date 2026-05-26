/**
 * POST /api/v1/managed_agents/sessions/[session_id]/message_stream
 *
 * Streaming variant of /message. Returns a `text/event-stream` response that
 * forwards opencode bus events for this session in near-realtime, so the UI
 * can render token deltas as the agent loop runs instead of waiting for the
 * full reply to come back over the cross-region link.
 *
 * Wire shape per SSE event:
 *   data: { type: "harness_event", event: <opencode bus event> }   // bus events filtered to this session
 *   data: { type: "ready" }                                         // first event after upstream connected + prompt_async fired
 *   data: { type: "done" }                                          // session.idle observed; client should refresh thread
 *   data: { type: "error", message: <string> }                      // upstream connect / prompt failed
 *
 * Filtering: opencode's /event bus emits global events; we only forward those
 * whose `properties.sessionID` matches this row's harness_session_id. Other
 * sessions' chatter is dropped server-side so we don't leak it to the wrong
 * client and don't waste their downlink.
 *
 * Connection lifecycle:
 *   1. Open SSE upstream to ${sandbox_url}/event.
 *   2. Wait for `server.connected`.
 *   3. POST /session/:id/prompt_async (fire and forget).
 *   4. Forward filtered events until we observe `session.idle` for this id
 *      OR the client disconnects (req.signal aborts) — whichever first.
 *   5. Cancel the upstream stream and the in-flight prompt_async.
 *
 * Hard connect failures and 5xx from prompt_async surface as `error` events
 * and the session is marked dead via the same path used by the blocking
 * /message route.
 */

import { ZodError } from "zod";

import { Prisma } from "@prisma/client";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  expandMessage,
  harnessListMessages,
  harnessOpenEventStream,
  harnessPromptAsync,
  isDeadSessionError,
  isHardConnectFailure,
} from "@/server/harness";
import { registry } from "@/server/metrics";
import { safeStopTask } from "@/server/reconcile";
import { invalidateSession } from "@/server/sessionCache";
import {
  HttpError,
  httpError,
  SendMessageBody,
  type HarnessMessagePart,
} from "@/server/types";
async function persistHistorySnapshot(opts: {
  session_id: string;
  sandbox_url: string;
  harness_session_id: string;
}): Promise<void> {
  try {
    const msgs = await harnessListMessages({
      sandbox_url: opts.sandbox_url,
      harness_session_id: opts.harness_session_id,
    });
    console.log(`[heartbeat] session=${opts.session_id} snapshot msgs=${msgs.length}`);
    await prisma.session.update({
      where: { session_id: opts.session_id },
      data: {
        history: msgs as unknown as Prisma.InputJsonValue,
        // Clear pending parts once the full history is snapshotted — the
        // harness now has the canonical record, so the partial cache is stale.
        pending_assistant_parts: Prisma.DbNull,
      },
    });
  } catch (err) {
    console.warn(
      `[heartbeat] session=${opts.session_id} snapshot failed:`,
      err,
    );
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

// Hard upper bound on a single stream. Matches DEFAULT_MESSAGE_TIMEOUT_MS in
// harness.ts — a session.idle that never arrives (hung model call, harness
// crash without bus emit) shouldn't pin the route + an upstream SSE
// connection forever. After this we send `error` and tear down.
const STREAM_MAX_DURATION_MS = 600_000;


interface BusEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown> & { sessionID?: string };
}

function encodeSse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const body = SendMessageBody.parse(await req.json());

    const row = await prisma.session.findUnique({
      where: { session_id },
      include: { agent: true },
    });
    if (!row || row.status !== "ready") {
      httpError(404, `session ${session_id} not found or not ready`);
    }
    if (!row.sandbox_url || !row.harness_session_id) {
      httpError(409, `session ${session_id} is not fully provisioned`);
    }

    const parts = expandMessage(
      body.text,
      body.parts as HarnessMessagePart[] | undefined,
      body.attachments,
    );

    // Bind to locals so TS narrows past the null guard inside the closure.
    const sandbox_url = row.sandbox_url;
    const harness_session_id = row.harness_session_id;
    const model = row.agent.model;

    const upstreamCtl = new AbortController();
    // Tear down the upstream subscription if the client hangs up before
    // session.idle. Without this the SSE connection stays open until the
    // sandbox itself dies.
    req.signal.addEventListener("abort", () => upstreamCtl.abort(), {
      once: true,
    });
    // Belt-and-suspenders deadline. If session.idle never arrives (hung
    // model, harness crash without bus emit) and the client doesn't
    // disconnect, this fires and aborts the upstream subscription. The
    // read loop notices via upstreamCtl.signal and emits `error`+`done`.
    const deadlineTimer = setTimeout(() => {
      upstreamCtl.abort();
    }, STREAM_MAX_DURATION_MS);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown) => {
          try {
            controller.enqueue(encodeSse(payload));
          } catch {
            // Controller already closed (client gone). Swallow.
          }
        };
        const done = () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        let upstream: Response;
        try {
          upstream = await harnessOpenEventStream({
            sandbox_url,
            signal: upstreamCtl.signal,
          });
        } catch (err) {
          console.error("harness event stream open failed", err);
          if (isHardConnectFailure(err) || isDeadSessionError(err)) {
            registry.inc("session_death_total", { reason: "sandbox_unreachable" });
            await prisma.session
              .updateMany({
                where: { session_id, status: "ready" },
                data: {
                  status: "dead",
                  failure_reason: "sandbox unreachable",
                  stopped_at: new Date(),
                },
              })
              .catch(() => {
                /* race with reconciler — fine */
              });
            invalidateSession(session_id);
            if (row.task_arn) void safeStopTask(row.task_arn, "sandbox unreachable").catch(() => {});
          }
          send({ type: "error", message: "harness event stream failed" });
          done();
          return;
        }

        // Fire the prompt; the harness returns 204 and publishes progress on
        // the bus. We notify the client we're live before doing this so it
        // can render the in-progress assistant bubble immediately.
        send({ type: "ready" });

        try {
          await harnessPromptAsync({
            sandbox_url,
            harness_session_id,
            model,
            parts,
          });
        } catch (err) {
          console.error("harness prompt_async failed", err);
          if (isHardConnectFailure(err) || isDeadSessionError(err)) {
            registry.inc("session_death_total", { reason: "sandbox_unreachable" });
            await prisma.session
              .updateMany({
                where: { session_id, status: "ready" },
                data: {
                  status: "dead",
                  failure_reason: "sandbox unreachable",
                  stopped_at: new Date(),
                },
              })
              .catch(() => {
                /* race with reconciler — fine */
              });
            invalidateSession(session_id);
            if (row.task_arn) void safeStopTask(row.task_arn, "sandbox unreachable").catch(() => {});
          }
          send({ type: "error", message: "prompt_async failed" });
          upstreamCtl.abort();
          done();
          return;
        }

        // Checkpoint the harness thread to DB every 15s while the turn runs.
        // Without this, a pod death mid-turn leaves nothing in the DB to debug.
        const snapshotInterval = setInterval(() => {
          void persistHistorySnapshot({ session_id, sandbox_url, harness_session_id });
        }, 15_000);

        // Parse the upstream SSE stream line-by-line. opencode emits one
        // JSON object per `data:` line followed by a blank line — we buffer
        // partial lines in `pending` to handle TCP-level fragmentation.
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";

        // Accumulate message.part.updated events server-side so we can
        // persist a partial turn snapshot when the stream ends. Keyed by
        // partID — same accumulation the client does in partsState — so the
        // last write per part wins and we get the final resolved version.
        const accumulatedParts = new Map<string, HarnessMessagePart>();
        let turnCompleted = false;

        // Whitelist of bus event types that have no `sessionID` in their
        // properties but are still relevant to the client (lifecycle/error
        // signals from the instance bus). Everything else without a sessionID
        // is dropped — opencode emits global chatter (mDNS, server.*, etc.)
        // we don't want to leak across sessions.
        const SESSIONLESS_PASSTHROUGH = new Set([
          "server.connected",
          "server.heartbeat",
        ]);
        const handleBusEvent = (evt: BusEvent) => {
          const sid = evt.properties?.sessionID;
          if (!sid) {
            // No sessionID — only forward known-safe global lifecycle events.
            if (!SESSIONLESS_PASSTHROUGH.has(evt.type)) return false;
            send({ type: "harness_event", event: evt });
            return false;
          }
          if (sid !== harness_session_id) return false;
          // Accumulate the authoritative full-part replacement events so we
          // have a server-side record of what the agent produced, even if the
          // client disconnects before refreshThread runs.
          if (evt.type === "message.part.updated") {
            const part = evt.properties?.part as HarnessMessagePart | undefined;
            const partId = (part as Record<string, unknown> | undefined)?.id;
            if (part && typeof partId === "string") {
              accumulatedParts.set(partId, part);
            }
          }
          send({ type: "harness_event", event: evt });
          // session.idle for this session means the agent loop returned
          // control. Close the stream and let the client refresh.
          if (evt.type === "session.idle") {
            turnCompleted = true;
            send({ type: "done" });
            return true;
          }
          return false;
        };

        try {
          let finished = false;
          while (!finished) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) break;
            pending += decoder.decode(value, { stream: true });
            // SSE frames are terminated by a blank line ("\n\n").
            for (;;) {
              const idx = pending.indexOf("\n\n");
              if (idx < 0) break;
              const frame = pending.slice(0, idx);
              pending = pending.slice(idx + 2);
              for (const line of frame.split(/\r?\n/)) {
                if (!line.startsWith("data:")) continue;
                const raw = line.slice(5).trimStart();
                if (!raw) continue;
                let parsed: BusEvent;
                try {
                  parsed = JSON.parse(raw) as BusEvent;
                } catch {
                  continue;
                }
                if (handleBusEvent(parsed)) {
                  finished = true;
                  break;
                }
              }
              if (finished) break;
            }
          }
        } catch (err) {
          // Reader rejection during shutdown is expected when the client
          // aborts or the max-duration deadline fires; only log when we
          // weren't already tearing down. The deadline path emits its own
          // error frame so the client sees the timeout.
          const errCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "unknown";
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!upstreamCtl.signal.aborted) {
            console.error(
              `[message_stream] upstream SSE dropped unexpectedly` +
              ` session=${session_id} code=${errCode} msg=${errMsg}` +
              ` clientAborted=${req.signal.aborted}`,
              err,
            );
            send({ type: "error", message: "event stream interrupted" });
          } else if (!req.signal.aborted) {
            // Aborted by deadline (not by client). Surface the timeout.
            console.warn(`[message_stream] stream deadline fired session=${session_id}`);
            send({ type: "error", message: "stream timeout" });
          }
        } finally {
          clearInterval(snapshotInterval);
          clearTimeout(deadlineTimer);
          // Release the body reader's lock before aborting the controller
          // so undici tears the upstream socket down cleanly. Without this
          // the ReadableStream stays locked on every normal session.idle
          // exit and the connection sits open until GC.
          try {
            await reader.cancel();
          } catch {
            /* already cancelled or upstream errored */
          }
          upstreamCtl.abort();
          done();

          // Persist the turn result regardless of whether the client stayed
          // connected. Two paths:
          //
          // 1. Normal completion (session.idle fired): snapshot the full
          //    harness thread so dead/restarted pods can replay history,
          //    and clear pending_assistant_parts.
          //
          // 2. Interrupted (client navigated away, deadline, error): save
          //    whatever parts were accumulated so the messages endpoint can
          //    show the partial turn until the harness stores the real one.
          if (turnCompleted) {
            void persistHistorySnapshot({
              session_id,
              sandbox_url,
              harness_session_id,
            });
          } else if (accumulatedParts.size > 0) {
            const partsArray = Array.from(accumulatedParts.values());
            void prisma.session
              .update({
                where: { session_id },
                data: {
                  pending_assistant_parts:
                    partsArray as unknown as Prisma.InputJsonValue,
                },
              })
              .catch((err) => {
                console.warn(
                  `failed to save pending parts for session ${session_id}:`,
                  err,
                );
              });
          }
        }
      },
      cancel() {
        clearTimeout(deadlineTimer);
        upstreamCtl.abort();
      },
    });

    // Best-effort housekeeping mirrors the blocking route. The DB write
    // here is fire-and-forget so the cross-region round-trip doesn't sit
    // on TTFB for the SSE response.
    void prisma.session
      .update({
        where: { session_id },
        data: { last_seen_at: new Date() },
      })
      .catch((err) => {
        console.warn(
          `failed to bump last_seen_at for session ${session_id}:`,
          err,
        );
      });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Match opencode's own SSE response — disables proxy buffering on
        // any nginx/Render edge that respects the hint.
        "x-accel-buffering": "no",
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
