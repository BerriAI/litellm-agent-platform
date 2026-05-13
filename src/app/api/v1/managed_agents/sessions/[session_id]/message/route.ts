/**
 * POST /api/v1/managed_agents/sessions/[session_id]/message
 *
 * Fire-and-forget user-message submission. Appends a `user_message` event to
 * the persisted SessionEvent log, kicks off the harness call asynchronously,
 * and immediately responds 202 with the seq number the caller can use as a
 * cursor against GET /events?since=<seq_started>.
 *
 * The harness call itself (and the assistant_text / tool_call / tool_result
 * events it produces) lands in the same log via the event translator, so
 * the caller's long-poll loop is the single source of truth — there's no
 * separate response body to await here.
 *
 * The session must be `ready` and have both a `sandbox_url` and a
 * `harness_session_id` — any other state means the Fargate task isn't fully
 * wired yet, so we 4xx instead of attempting the call.
 *
 * On hard connect failures (timeout, refused, DNS) inside the deferred
 * harness call we mark the session `dead` so the UI can surface restart
 * immediately instead of waiting for the reconciler's ghost sweep.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { expandMessage, harnessSendMessage } from "@/server/harness";
import {
  ensureFlushLoop,
  getCachedSession,
  invalidateSession,
  markSessionSeen,
} from "@/server/sessionCache";
import { appendSessionEvent } from "@/server/sessionEvents";
import {
  HttpError,
  httpError,
  SendMessageBody,
  type HarnessMessagePart,
} from "@/server/types";

// First import wires the periodic last_seen_at flusher. ensureFlushLoop is
// idempotent so re-imports under HMR don't stack timers.
ensureFlushLoop();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

// undici / Node net error codes that indicate the sandbox host is definitively
// unreachable — TCP-handshake or DNS-resolution failures, not mid-request
// errors. We deliberately exclude codes that fire on transient conditions
// (`ECONNRESET` from a brief container restart or load-balancer teardown,
// `UND_ERR_SOCKET` from a keepalive race) — those would permanently kill a
// recoverable session in <1s, which is worse than letting the reconciler
// catch it one tick later.
const HARD_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function isHardConnectFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string" && HARD_CONNECT_CODES.has(e.code)) return true;
  const cause = e.cause;
  if (cause && typeof cause === "object") {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === "string" && HARD_CONNECT_CODES.has(c)) return true;
  }
  return false;
}

// Fire-and-forget harness call. Runs after the 202 response has already been
// queued to the client. The harness emits BusEvents → the worker translates
// them into SessionEvent rows in the log; nothing on this path needs to
// return a value to the caller.
async function dispatchHarnessSend(opts: {
  session_id: string;
  sandbox_url: string;
  harness_session_id: string;
  agent_model: string;
  parts: HarnessMessagePart[];
}): Promise<void> {
  try {
    await harnessSendMessage({
      sandbox_url: opts.sandbox_url,
      harness_session_id: opts.harness_session_id,
      model: opts.agent_model,
      parts: opts.parts,
    });
  } catch (err) {
    console.error(
      `harness send_message failed for session ${opts.session_id}:`,
      err,
    );
    if (isHardConnectFailure(err)) {
      invalidateSession(opts.session_id);
      try {
        // updateMany so the status guard is part of the WHERE — avoids a
        // race with the reconciler flipping the row first.
        await prisma.session.updateMany({
          where: { session_id: opts.session_id, status: "ready" },
          data: {
            status: "dead",
            failure_reason: "sandbox unreachable",
            stopped_at: new Date(),
          },
        });
      } catch (markErr) {
        console.warn(
          `failed to mark session ${opts.session_id} dead after connect failure:`,
          markErr,
        );
      }
    }
    // Surface the failure to log readers via the event log so the caller's
    // long-poll loop observes it instead of hanging forever.
    try {
      await appendSessionEvent(opts.session_id, {
        event_id: crypto.randomUUID(),
        type: "error",
        message: "harness request failed",
      });
    } catch (logErr) {
      console.warn(
        `failed to record error event for session ${opts.session_id}:`,
        logErr,
      );
    }
  }
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const body = SendMessageBody.parse(await req.json());

    const cached = await getCachedSession(session_id);
    if (!cached) {
      // Cache miss + DB row absent / not ready / not fully provisioned. We
      // collapse the prior 404 / 409 distinction into a single 404 here —
      // callers shouldn't be hitting message on a non-ready session anyway.
      httpError(404, `session ${session_id} not found or not ready`);
    }

    // The zod schema accepts arbitrary `Record<string, unknown>` parts to
    // stay drop-in compatible with the Python harness wire format; the
    // harness itself validates the `type` discriminator, so we trust the
    // shape here and cast to the runtime contract.
    const parts = expandMessage(
      body.text,
      body.parts as HarnessMessagePart[] | undefined,
    );

    // Don't double-write the user_message — the harness's runner.ts emits
    // it as the first SessionEvent of the turn, which the worker subscriber
    // persists. Writing it here too caused two user_message rows per send.
    // Return the current max seq as the cursor so the caller's long-poll
    // picks up the user_message (and the assistant_text that follows) on
    // its first /events?since=<seq_started> call.
    const last = await prisma.sessionEvent.findFirst({
      where: { session_id },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const seq_started = last?.seq ?? 0;

    // Fire-and-forget the actual harness call. The harness emits BusEvents
    // which the worker translates into SessionEvent rows — the caller reads
    // those via /events long-poll, so we never await the response here.
    void dispatchHarnessSend({
      session_id,
      sandbox_url: cached.sandbox_url,
      harness_session_id: cached.harness_session_id,
      agent_model: cached.agent_model,
      parts,
    });

    markSessionSeen(session_id);

    return Response.json(
      { session_id, seq_started, status: "accepted" },
      { status: 202 },
    );
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
