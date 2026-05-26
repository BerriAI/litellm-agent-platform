/**
 * POST /api/v1/managed_agents/sessions/[session_id]/message
 *
 * Forwards a user message to the per-session opencode harness. The session
 * must be `ready` and have both a `sandbox_url` and a `harness_session_id` —
 * any other state means the Fargate task isn't fully wired yet, so we 4xx
 * instead of attempting the call.
 *
 * Durability + recovery (see src/server/sessionStore.ts, rehydrate.ts):
 *   - The user turn is written to the append-only SessionMessage log *before*
 *     the harness call, so a sandbox that dies mid-turn still leaves the
 *     message recoverable (the legacy history snapshot ran only *after* the
 *     reply, losing the turn on crash).
 *   - When the harness is unreachable / the session is dead, instead of just
 *     marking the row `dead` and 502-ing, we transparently rehydrate a fresh
 *     sandbox, replay the thread, re-send this message, and return the real
 *     reply — the dead sandbox is invisible to the user.
 *
 * The `last_seen_at` bump and the legacy history snapshot still run
 * fire-and-forget after the response is queued, off the user-facing path.
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
  prependAgentSystemPrompt,
} from "@/server/harness";
import { registry } from "@/server/metrics";
import { rehydrateSession } from "@/server/rehydrate";
import { safeStopTask } from "@/server/reconcile";
import {
  ensureFlushLoop,
  getCachedSession,
  invalidateSession,
  markSessionSeen,
} from "@/server/sessionCache";
import {
  appendUserMessage,
  completeAssistantMessage,
  markUserMessageFailed,
} from "@/server/sessionStore";
import {
  HttpError,
  httpError,
  SendMessageBody,
  HARNESS_OPENCODE,
  HARNESS_OPENCODE_BRAIN_INLINE,
  type HarnessMessage,
  type HarnessMessagePart,
  type HarnessMessageResponse,
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
    console.log(`[heartbeat] session=${opts.session_id} snapshot msgs=${msgs.length}`);
    await prisma.session.update({
      where: { session_id: opts.session_id },
      data: {
        history: msgs as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn(
      `[heartbeat] session=${opts.session_id} snapshot failed:`,
      err,
    );
  }
}

// Heartbeat cadence while a message turn runs. Short enough that a long
// autonomous turn (10-30 min) checkpoints frequently — both for the reconciler's
// idle timeout and for mid-turn debug visibility if the agent dies.
const MESSAGE_HEARTBEAT_MS = 15_000;

function startHeartbeat(
  session_id: string,
  sandbox_url: string,
  harness_session_id: string,
): NodeJS.Timeout {
  const t = setInterval(() => {
    void prisma.session
      .update({ where: { session_id }, data: { last_seen_at: new Date() } })
      .catch((err) => {
        console.warn(
          `message heartbeat failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    // Snapshot the live thread mid-turn so autonomous long-running turns
    // (10-30 min) leave a partial record in the DB every 15s. Without this,
    // a dead pod mid-task leaves nothing to debug.
    void persistHistorySnapshot({ session_id, sandbox_url, harness_session_id });
  }, MESSAGE_HEARTBEAT_MS);
  return t;
}

// Fire-and-forget the durable assistant write + legacy history snapshot.
// Failures are logged and swallowed — never block the user reply on a persist.
function persistTurn(opts: {
  session_id: string;
  user_message_id: string | null;
  sandbox_url: string;
  harness_session_id: string;
  response: HarnessMessageResponse;
}): void {
  void completeAssistantMessage({
    session_id: opts.session_id,
    user_message_id: opts.user_message_id,
    harness_session_id: opts.harness_session_id,
    response: opts.response,
  });
  void persistHistorySnapshot({
    session_id: opts.session_id,
    sandbox_url: opts.sandbox_url,
    harness_session_id: opts.harness_session_id,
  });
}

// Mark the session dead + stop its pod — the give-up path when auto-recovery
// is impossible or itself fails. Mirrors the pre-recovery behaviour.
async function markSessionDead(session_id: string): Promise<void> {
  invalidateSession(session_id);
  registry.inc("session_death_total", { reason: "sandbox_unreachable" });
  try {
    // updateMany so the status guard is part of the WHERE — avoids racing the
    // reconciler flipping the row first.
    await prisma.session.updateMany({
      where: { session_id, status: "ready" },
      data: {
        status: "dead",
        failure_reason: "sandbox unreachable",
        stopped_at: new Date(),
      },
    });
  } catch (markErr) {
    console.warn(`failed to mark session ${session_id} dead:`, markErr);
  }
  void prisma.session
    .findUnique({ where: { session_id }, select: { task_arn: true } })
    .then((s) => {
      if (s?.task_arn) return safeStopTask(s.task_arn, "sandbox unreachable");
    })
    .catch(() => {});
}

/**
 * A send failed because the sandbox is dead. Rehydrate a fresh one, re-send
 * this message, and return the real reply. Throws if recovery is impossible
 * (so the caller can fall back to marking the session dead + 502).
 */
async function recoverAndResend(opts: {
  session_id: string;
  user_message_id: string | null;
  parts: HarnessMessagePart[];
}): Promise<HarnessMessageResponse> {
  const { session_id, user_message_id, parts } = opts;
  // Drop the cache up front so concurrent in-flight requests don't keep
  // dialing the dead pod.
  invalidateSession(session_id);

  const row = await prisma.session.findUnique({
    where: { session_id },
    include: { agent: true },
  });
  if (!row || !row.agent) {
    throw new HttpError(502, "harness request failed");
  }
  const agent = row.agent;
  const previousHistory = Array.isArray(row.history)
    ? (row.history as unknown as HarnessMessage[])
    : null;

  // Bring up a fresh sandbox + replay the thread (excluding this in-flight
  // turn, which we re-send live below). Shared with the /restart route.
  // rehydrateSession self-serializes via a DB-level claim, so concurrent
  // recoveries (same process or another replica) don't spawn duplicate
  // sandboxes — the losers wait for the winner.
  await rehydrateSession({
    agent,
    session_id,
    oldTaskArn: row.task_arn,
    previousHistory,
    excludeMessageId: user_message_id ?? undefined,
  });

  const recovered = await getCachedSession(session_id);
  if (!recovered) {
    throw new HttpError(502, "session recovery failed");
  }

  console.log(`[message] session=${session_id} recovery=complete sandbox_url=${recovered.sandbox_url} harness_session_id=${recovered.harness_session_id}`);
  const hb = startHeartbeat(session_id, recovered.sandbox_url, recovered.harness_session_id);
  let response: HarnessMessageResponse;
  try {
    response = await harnessSendMessage({
      sandbox_url: recovered.sandbox_url,
      harness_session_id: recovered.harness_session_id,
      model: recovered.agent_model,
      parts,
    });
  } finally {
    clearInterval(hb);
  }
  markSessionSeen(session_id);
  persistTurn({
    session_id,
    user_message_id,
    sandbox_url: recovered.sandbox_url,
    harness_session_id: recovered.harness_session_id,
    response,
  });
  return response;
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const body = SendMessageBody.parse(await req.json());

    let cached;
    try {
      cached = await getCachedSession(session_id);
    } catch (dbErr) {
      console.error("getCachedSession DB error for session", session_id, dbErr);
      throw new HttpError(503, "session store temporarily unavailable");
    }
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
    let parts = expandMessage(
      body.text,
      body.parts as HarnessMessagePart[] | undefined,
      body.attachments,
    );

    // First turn only: lead with the agent's system prompt. opencode has no
    // per-session system-prompt API, so this is how the agent's persona/rules
    // reach a shared inline-harness session (see prependAgentSystemPrompt).
    // Costs one extra count + one agent read, and only on turn 1.
    const priorTurns = await prisma.sessionMessage.count({
      where: { session_id },
    });
    if (priorTurns === 0) {
      const agentRow = await prisma.agent.findUnique({
        where: { agent_id: cached.agent_id },
        select: { prompt: true, agent_id: true },
      });
      const isOpencode = cached.harness_id === HARNESS_OPENCODE || cached.harness_id === HARNESS_OPENCODE_BRAIN_INLINE;
      const issueToolName = isOpencode ? "lap-issue-reporter_report_issue" : "report_issue";
      const issueReportingBlock = `\n\n## Issue reporting — MANDATORY\nCall \`${issueToolName}\` immediately (before replying or continuing) whenever:\n- You cannot complete a request because a tool, integration, or permission is missing\n- A sandbox restarts unexpectedly or required binaries/templates are missing\n- A tool returns an error you have to work around (broken API, auth failure, wrong environment)\n- You are about to stop because of a blocker\n\nDo not suggest alternatives first. File the issue, then explain. Always pass session_id=${session_id} and agent_id=${cached.agent_id}. No exceptions.`;
      const promptWithContext = (agentRow?.prompt ?? "") + issueReportingBlock;
      parts = prependAgentSystemPrompt(promptWithContext, parts, session_id);
    }

    // Durably record the user turn *before* dialing the harness so a mid-turn
    // sandbox death still leaves it recoverable. Best-effort: a DB hiccup must
    // not block the message (returns null; the turn just isn't logged).
    const userMsg = await appendUserMessage({
      session_id,
      harness_session_id: cached.harness_session_id,
      parts,
    });

    let response: HarnessMessageResponse;
    console.log(`[message] session=${session_id} sandbox_url=${cached.sandbox_url} harness_session_id=${cached.harness_session_id}`);
    const hb = startHeartbeat(session_id, cached.sandbox_url, cached.harness_session_id);
    try {
      response = await harnessSendMessage({
        sandbox_url: cached.sandbox_url,
        harness_session_id: cached.harness_session_id,
        model: cached.agent_model,
        parts,
      });
    } catch (err) {
      if (isHardConnectFailure(err) || isDeadSessionError(err)) {
        // Dead sandbox — try transparent recovery before giving up.
        console.warn(
          `session ${session_id} sandbox_url=${cached.sandbox_url} sandbox unreachable; attempting auto-recovery`,
        );
        try {
          const recovered = await recoverAndResend({
            session_id,
            user_message_id: userMsg?.message_id ?? null,
            parts,
          });
          return Response.json(recovered);
        } catch (recoveryErr) {
          console.error(
            `auto-recovery failed for session ${session_id}:`,
            recoveryErr,
          );
          await markSessionDead(session_id);
          throw new HttpError(502, "harness request failed");
        }
      }
      // Non-connect failure (harness 4xx/5xx): the sandbox is reachable but the
      // turn errored and won't be retried here, so flag it `failed` (excluded
      // from replay) rather than leaving a phantom unanswered user turn that a
      // later restart would replay. Surface a 502.
      console.error("harness send_message failed", err);
      if (userMsg) void markUserMessageFailed(userMsg.message_id);
      throw new HttpError(502, "harness request failed");
    } finally {
      clearInterval(hb);
    }

    markSessionSeen(session_id);
    persistTurn({
      session_id,
      user_message_id: userMsg?.message_id ?? null,
      sandbox_url: cached.sandbox_url,
      harness_session_id: cached.harness_session_id,
      response,
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
