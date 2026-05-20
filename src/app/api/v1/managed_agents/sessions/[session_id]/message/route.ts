/**
 * POST /api/v1/managed_agents/sessions/[session_id]/message
 *
 * Forwards a user message to the per-session opencode harness. The session
 * must be `ready` and have both a `sandbox_url` and a `harness_session_id` —
 * any other state means the Fargate task isn't fully wired yet, so we 4xx
 * instead of attempting the call.
 *
 * The harness reply is returned verbatim (the frontend already understands
 * its shape via `HarnessMessageResponse`). The `last_seen_at` bump and the
 * full-thread history snapshot both run fire-and-forget after the response
 * has been queued back to the client, so the cross-region DB round-trip
 * (Render Oregon ↔ Postgres) doesn't sit on the user-facing critical path.
 * A best-effort drop on either is fine — the reconciler's idle sweep will
 * catch a row whose last_seen_at fell behind by one user turn.
 *
 * Network or 5xx errors from the harness bubble up as a 502 via the generic
 * error handler. On hard connect failures (timeout, refused, DNS) we also
 * mark the session `dead` inline so the UI can surface restart immediately
 * instead of waiting up to RECONCILE_INTERVAL_SECONDS for the ghost sweep.
 */

import { ZodError } from "zod";

import type { Prisma } from "@prisma/client";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  expandMessage,
  harnessListMessages,
  harnessSendMessage,
  isDeadSessionError,
  isHardConnectFailure,
} from "@/server/harness";
import { safeStopTask } from "@/server/reconcile";
import {
  ensureFlushLoop,
  getCachedSession,
  invalidateSession,
  markSessionSeen,
} from "@/server/sessionCache";
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
    await prisma.session.update({
      where: { session_id: opts.session_id },
      data: {
        history: msgs as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn(
      `history snapshot failed for session ${opts.session_id}:`,
      err,
    );
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
      body.attachments,
    );

    let response;
    try {
      response = await harnessSendMessage({
        sandbox_url: cached.sandbox_url,
        harness_session_id: cached.harness_session_id,
        model: cached.agent_model,
        parts,
      });
    } catch (err) {
      // Network failure or 5xx from the sandbox. Re-throw as a 502 so the
      // caller can distinguish "harness unreachable" from a generic 500.
      console.error("harness send_message failed", err);
      if (isHardConnectFailure(err) || isDeadSessionError(err)) {
        // Drop the cache entry up front so concurrent in-flight requests
        // don't keep dialing a dead pod.
        invalidateSession(session_id);
        try {
          // updateMany so the status guard is part of the WHERE — avoids a
          // race with the reconciler flipping the row first.
          await prisma.session.updateMany({
            where: { session_id, status: "ready" },
            data: {
              status: "dead",
              failure_reason: "sandbox unreachable",
              stopped_at: new Date(),
            },
          });
        } catch (markErr) {
          console.warn(
            `failed to mark session ${session_id} dead after connect failure:`,
            markErr,
          );
        }
        // Stop the pod immediately — fire-and-forget, don't block the response
        void prisma.session
          .findUnique({ where: { session_id }, select: { task_arn: true } })
          .then((s) => {
            if (s?.task_arn) return safeStopTask(s.task_arn, "sandbox unreachable");
          })
          .catch(() => {});
      }
      throw new HttpError(502, "harness request failed");
    }

    markSessionSeen(session_id);

    // Fire-and-forget: snapshot the full opencode thread into Session.history
    // so a restarted pod can replay it as the next user message's preamble.
    // Failures are logged and swallowed — never block the user reply on a
    // history persist.
    void persistHistorySnapshot({
      session_id,
      sandbox_url: cached.sandbox_url,
      harness_session_id: cached.harness_session_id,
    });

    return Response.json(response);
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
