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

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  expandMessage,
  harnessOpenEventStream,
  harnessPromptAsync,
  isDeadSessionError,
  isHardConnectFailure,
} from "@/server/harness";
import { safeStopTask } from "@/server/reconcile";
import { invalidateSession } from "@/server/sessionCache";
import {
  HttpError,
  httpError,
  SendMessageBody,
  type HarnessMessagePart,
} from "@/server/types";

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

        // Parse the upstream SSE stream line-by-line. opencode emits one
        // JSON object per `data:` line followed by a blank line — we buffer
        // partial lines in `pending` to handle TCP-level fragmentation.
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";

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
          send({ type: "harness_event", event: evt });
          // session.idle for this session means the agent loop returned
          // control. Close the stream and let the client refresh.
          if (evt.type === "session.idle") {
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
          if (!upstreamCtl.signal.aborted) {
            console.error("harness event stream read failed", err);
            send({ type: "error", message: "event stream interrupted" });
          } else if (!req.signal.aborted) {
            // Aborted by deadline (not by client). Surface the timeout.
            send({ type: "error", message: "stream timeout" });
          }
        } finally {
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
