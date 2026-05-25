/**
 * ALL /api/v1/managed_agents/sessions/[session_id]/opencode/[...path]
 *
 * The single backend surface for talking to a session's agent. LAP exposes
 * the pod's opencode server VERBATIM under this per-session base, so the
 * official `@opencode-ai/sdk` (which has opencode's paths hardcoded —
 * `/event`, `/session/:id/message`, …) can be pointed straight at it:
 *
 *   createOpencodeClient({ baseUrl: "…/sessions/:id/opencode" })
 *
 * This replaces the hand-rolled /stream, /message_stream, /events, /message,
 * and /messages routes. LAP keeps doing the only things opencode can't: auth
 * (master-key bearer) and resolving the session → its pod `sandbox_url`. The
 * pod is only reachable from inside the cluster, so the harness needs no
 * additional auth header here (matches the existing harness client).
 *
 * SSE (`GET …/opencode/event`) and JSON (message send / history) both stream
 * through untouched — opencode's wire format IS the contract. The browser can
 * not attach a bearer to its requests, so it goes through the cookie-authed
 * shim at /api/ui/sessions/:id/opencode/[...path], which forwards here.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import {
  expandMessage,
  formatHistoryAsText,
  harnessCreateSession,
  harnessDeleteSession,
  harnessSendMessage,
} from "@/server/harness";
import { inlineHarnessUrl } from "@/server/k8s";
import { getCachedSession, invalidateSession, putCachedSession, type SessionCacheEntry } from "@/server/sessionCache";
import { markUserMessageFailed, formatSessionMessagesAsText, listSessionMessages } from "@/server/sessionStore";
import {
  recordUserSend,
  watchEventStreamAndSnapshot,
} from "@/server/sessionThreadSync";
import {
  HARNESS_BRAIN_INLINE,
  HARNESS_OPENCODE_BRAIN_INLINE,
  HttpError,
  httpError,
  type HarnessMessage,
  type SandboxFileSpec,
} from "@/server/types";

// opencode paths we persist from. The web UI / CLI drive the harness through
// this proxy (never our /message route), so the durable conversation log has to
// be captured here. See src/server/sessionThreadSync.ts.
const SEND_PATH = new RegExp("^session/[^/]+/(message|prompt_async)$");

/**
 * Recover a brain-inline session whose harness-side state was lost (pod
 * restart, rolling deploy). Creates a new harness session on the same inline
 * URL, replays the durable log, updates the DB + cache, and returns the new
 * harness_session_id so the caller can rewrite the request path and retry.
 *
 * Mirrors the logic in restart/route.ts brain-inline fast path.
 */
async function recoverBrainInlineSession(
  session_id: string,
  old_harness_session_id: string,
  harness_id: string,
): Promise<string> {
  const row = await prisma.session.findUnique({
    where: { session_id },
    include: { agent: true },
  });
  if (!row?.agent) throw new HttpError(502, "session not found during recovery");

  const inlineUrl = harness_id === HARNESS_OPENCODE_BRAIN_INLINE
    ? (process.env.OPENCODE_INLINE_URL || null)
    : (process.env.CLAUDE_CODE_INLINE_URL || (env.IN_CLUSTER ? inlineHarnessUrl() : null));
  if (!inlineUrl) {
    const varName = harness_id === HARNESS_OPENCODE_BRAIN_INLINE ? "OPENCODE_INLINE_URL" : "CLAUDE_CODE_INLINE_URL";
    throw new HttpError(503, `${varName} not configured`);
  }

  // Surface harness unavailability as 503 (retryable) not 500 (opaque crash).
  // Callers should retry after a few seconds — pod replacement windows are short.

  console.log(`[opencode-proxy] session=${session_id} recovery=start old_harness_session_id=${old_harness_session_id}`);

  // Best-effort cleanup of the old (now-dead) harness session.
  await harnessDeleteSession({ sandbox_url: inlineUrl, harness_session_id: old_harness_session_id })
    .catch(() => {});

  const rawFiles = (row.agent as Record<string, unknown>).sandbox_files;
  const rawProjects = (row.agent as Record<string, unknown>).projects;
  const projects = Array.isArray(rawProjects)
    ? (rawProjects as Array<{ id: string; name: string; description: string; repo_url?: string }>)
    : [];

  let new_harness_session_id: string;
  try {
    new_harness_session_id = await harnessCreateSession({
      sandbox_url: inlineUrl,
      title: "recovery",
      files: Array.isArray(rawFiles) ? (rawFiles as SandboxFileSpec[]) : undefined,
      sandbox_tools: true,
      projects,
      agent_id: row.agent.agent_id,
      platform_session_id: session_id,
    });
  } catch (e) {
    // Harness unreachable — pod still replacing. Throw 503 so proxy surfaces it
    // as retryable rather than opaque 500.
    throw new HttpError(503, `harness unavailable during recovery (pod replacement in progress): ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`[opencode-proxy] session=${session_id} recovery=session_created new_harness_session_id=${new_harness_session_id}`);

  // Update DB + cache with the new harness_session_id.
  await prisma.session.update({
    where: { session_id },
    data: { harness_session_id: new_harness_session_id, sandbox_url: inlineUrl, last_seen_at: new Date() },
  });
  invalidateSession(session_id);
  putCachedSession({
    session_id,
    agent_id: row.agent.agent_id,
    agent_model: row.agent.model,
    harness_id: row.agent.harness_id,
    sandbox_url: inlineUrl,
    harness_session_id: new_harness_session_id,
    status: "ready",
    sandboxes: null,
  });

  // Replay history fire-and-forget so the first real message sees context.
  void (async () => {
    try {
      const rows = await listSessionMessages(session_id);
      const replayText = rows.length > 0
        ? formatSessionMessagesAsText(rows)
        : Array.isArray(row.history) && row.history.length > 0
          ? formatHistoryAsText(row.history as unknown as HarnessMessage[])
          : null;
      if (replayText) {
        await harnessSendMessage({
          sandbox_url: inlineUrl,
          harness_session_id: new_harness_session_id,
          model: row.agent.model,
          parts: expandMessage(replayText),
        });
        console.log(`[opencode-proxy] session=${session_id} recovery=replay_complete`);
      }
    } catch (err) {
      console.warn(`[opencode-proxy] session=${session_id} recovery replay failed:`, err);
    }
  })();

  return new_harness_session_id;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string; path?: string[] }>;
}

// The SDK can subscribe / send right after createSession, while the pod is
// still pulling images and starting the harness. Wait for `ready` before
// forwarding, matching the old /stream route's behavior.
const READY_WAIT_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 1_000;

/**
 * Resolve the session to its ready cache entry, polling until the pod comes
 * up. Fails fast on terminal states (404 missing, 410 failed/dead) and on the
 * 60s ceiling (504).
 */
async function resolveReady(
  session_id: string,
  signal: AbortSignal,
): Promise<SessionCacheEntry> {
  const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
  for (;;) {
    const cached = await getCachedSession(session_id);
    if (cached) return cached;
    const row = await prisma.session.findUnique({
      where: { session_id },
      select: { status: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);
    if (row.status === "failed" || row.status === "dead") {
      httpError(410, `session ${session_id} is ${row.status}`);
    }
    if (signal.aborted) httpError(503, "client disconnected");
    if (Date.now() >= deadline) {
      httpError(504, `session ${session_id} not ready within 60s`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

async function proxy(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    assertAuth(req);
    const { session_id, path } = await ctx.params;
    const tail = (path ?? []).join("/");
    const search = new URL(req.url).search;

    // Tie the upstream connection to the client's. EventSource / fetch-stream
    // closes on unload; Next forwards that as req.signal abort. Without this,
    // the pod-side SSE stays open until the harness keepalive ceiling.
    const upstreamCtl = new AbortController();
    req.signal.addEventListener("abort", () => upstreamCtl.abort(), {
      once: true,
    });

    const cached = await resolveReady(session_id, req.signal);
    const target = `${cached.sandbox_url}/${tail}${search}`;

    const headers: Record<string, string> = {
      "content-type": req.headers.get("content-type") ?? "application/json",
      accept: req.headers.get("accept") ?? "*/*",
    };
    const init: RequestInit = {
      method: req.method,
      headers,
      signal: upstreamCtl.signal,
      cache: "no-store",
    };
    let bodyBuf: ArrayBuffer | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Buffer the body — opencode message payloads are small JSON (text +
      // optional base64 image parts), and buffering sidesteps undici's
      // half-duplex streaming-body constraints.
      bodyBuf = await req.arrayBuffer();
      init.body = bodyBuf;
    }

    // Persist the user turn before the prompt reaches the harness, so a sandbox
    // that dies mid-turn still leaves it recoverable + visible in the Session
    // Log. The UI never hits our /message route — this proxy is the only place
    // the send is observable. Awaited (one small insert) for durable-before-send.
    let sentUserMsgId: string | null = null;
    if (req.method === "POST" && SEND_PATH.test(tail) && bodyBuf) {
      sentUserMsgId = await recordUserSend({
        session_id,
        harness_session_id: cached.harness_session_id,
        body: bodyBuf,
      });
    }

    // For GET session/:id/message, catch both network failures (unreachable pod)
    // and 404 (pod restarted, session lost from memory) and fall back to the DB
    // history snapshot so the UI can still render the conversation.
    const isMessageHistory =
      req.method === "GET" && new RegExp("^session/[^/]+/message$").test(tail);

    let upstream: Response;
    if (isMessageHistory) {
      try {
        upstream = await fetch(target, init);
      } catch {
        upstream = new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
    } else {
      const isBrainInlineSend =
        (cached.harness_id === HARNESS_BRAIN_INLINE || cached.harness_id === HARNESS_OPENCODE_BRAIN_INLINE) &&
        req.method === "POST" && SEND_PATH.test(tail);

      try {
        upstream = await fetch(target, init);
      } catch (err) {
        // Harness unreachable on a brain-inline send — attempt transparent recovery
        // (create new harness session, replay history, retry with new session id).
        if (isBrainInlineSend) {
          console.warn(`[opencode-proxy] session=${session_id} harness unreachable on send; recovering`);
          try {
            const newHarnessId = await recoverBrainInlineSession(session_id, cached.harness_session_id, cached.harness_id);
            // Re-fetch cache to get the updated sandbox_url (new pod IP/Service DNS).
            const fresh = await getCachedSession(session_id);
            const newSandboxUrl = fresh?.sandbox_url ?? cached.sandbox_url;
            const newTail = tail.replace(cached.harness_session_id, newHarnessId);
            const newTarget = `${newSandboxUrl}/${newTail}${search}`;
            upstream = await fetch(newTarget, { ...init, body: bodyBuf ?? undefined });
            console.log(`[opencode-proxy] session=${session_id} recovery=retry_ok sandbox_url=${newSandboxUrl}`);
          } catch (recoveryErr) {
            console.error(`[opencode-proxy] session=${session_id} recovery failed:`, recoveryErr);
            if (sentUserMsgId) await markUserMessageFailed(sentUserMsgId);
            // Surface retryable errors as-is; fall back to original for hard failures.
            if (recoveryErr instanceof HttpError) throw recoveryErr;
            throw err;
          }
        } else {
          // Non-brain-inline or non-send path: flag the turn and propagate.
          if (sentUserMsgId) await markUserMessageFailed(sentUserMsgId);
          throw err;
        }
      }

      // Harness returned 404 on a brain-inline send = session lost from in-process Map.
      // Recover transparently the same way as a connect failure.
      if (isBrainInlineSend && upstream.status === 404) {
        console.warn(`[opencode-proxy] session=${session_id} harness 404 on send (session Map wiped); recovering`);
        try {
          const newHarnessId = await recoverBrainInlineSession(session_id, cached.harness_session_id, cached.harness_id);
          // Re-fetch cache for the updated sandbox_url after recovery.
          const fresh = await getCachedSession(session_id);
          const newSandboxUrl = fresh?.sandbox_url ?? cached.sandbox_url;
          const newTail = tail.replace(cached.harness_session_id, newHarnessId);
          const newTarget = `${newSandboxUrl}/${newTail}${search}`;
          upstream = await fetch(newTarget, { ...init, body: bodyBuf ?? undefined });
          console.log(`[opencode-proxy] session=${session_id} recovery=retry_ok (was 404) sandbox_url=${newSandboxUrl}`);
        } catch (recoveryErr) {
          console.error(`[opencode-proxy] session=${session_id} recovery failed after 404:`, recoveryErr);
          if (sentUserMsgId) await markUserMessageFailed(sentUserMsgId);
          // Surface retryable errors; fall through otherwise (proxy original 404).
          if (recoveryErr instanceof HttpError) throw recoveryErr;
        }
      }

      // Brain-inline: recover from 404 on GET requests (session lost from harness memory on
      // server restart / rolling deploy). Covers the event stream and any other session-scoped
      // GET. Message history is excluded — it already falls back to the DB snapshot below.
      const isBrainInlineGet =
        (cached.harness_id === HARNESS_BRAIN_INLINE || cached.harness_id === HARNESS_OPENCODE_BRAIN_INLINE) &&
        req.method === "GET" && !isMessageHistory && upstream.status === 404;
      if (isBrainInlineGet) {
        console.warn(`[opencode-proxy] session=${session_id} harness 404 on GET ${tail}; recovering`);
        try {
          const newHarnessId = await recoverBrainInlineSession(session_id, cached.harness_session_id, cached.harness_id);
          const fresh = await getCachedSession(session_id);
          const newSandboxUrl = fresh?.sandbox_url ?? cached.sandbox_url;
          const newTail = tail.replace(cached.harness_session_id, newHarnessId);
          const newTarget = `${newSandboxUrl}/${newTail}${search}`;
          upstream = await fetch(newTarget, init);
          console.log(`[opencode-proxy] session=${session_id} recovery=get_retry_ok tail=${newTail}`);
        } catch (recoveryErr) {
          console.error(`[opencode-proxy] session=${session_id} GET recovery failed:`, recoveryErr);
          if (recoveryErr instanceof HttpError) throw recoveryErr;
          // Fall through — proxy original 404 back to the client.
        }
      }
    }

    // Harness returned 5xx on a message send — check if the session has a stuck
    // turn (last message has a tool call with no step-finish). If so, abort the
    // in-progress run and retry once: this is the canonical recovery from a
    // mid-tool-call harness restart that leaves the session deadlocked.
    const isMessageSend = req.method === "POST" && SEND_PATH.test(tail);
    if (upstream.status >= 500 && isMessageSend) {
      try {
        const historyUrl = `${cached.sandbox_url}/session/${cached.harness_session_id}/message`;
        const historyResp = await fetch(historyUrl, { signal: AbortSignal.timeout(5_000) });
        if (historyResp.ok) {
          const msgs = (await historyResp.json()) as Array<{ parts?: Array<{ type: string }> }>;
          const last = msgs[msgs.length - 1];
          const parts = last?.parts ?? [];
          const hasTool = parts.some((p) => p.type === "tool");
          const hasFinish = parts.some((p) => p.type === "step-finish");
          if (hasTool && !hasFinish) {
            console.warn(`[opencode-proxy] session=${session_id} stuck turn detected (tool no step-finish); aborting`);
            await fetch(`${cached.sandbox_url}/session/${cached.harness_session_id}/abort`, {
              method: "POST",
              signal: AbortSignal.timeout(5_000),
            }).catch(() => {});
            upstream = await fetch(target, { ...init, body: bodyBuf ?? undefined });
            console.log(`[opencode-proxy] session=${session_id} abort+retry status=${upstream.status}`);
          }
        }
      } catch (abortErr) {
        console.warn(`[opencode-proxy] session=${session_id} abort-retry failed:`, abortErr);
      }
    }

    // Non-2xx from the harness (rate limit, bad request, …): same cleanup. The
    // error status is still proxied back to the client below.
    if (sentUserMsgId && !upstream.ok) {
      await markUserMessageFailed(sentUserMsgId);
    }

    // When the harness doesn't know about this session (pod restarted, in-memory
    // state lost) it returns 404 for GET session/:id/message. Fall back to the
    // last-snapshotted history so the UI can still render the conversation.
    if (isMessageHistory && upstream.status === 404) {
      const row = await prisma.session.findUnique({
        where: { session_id },
        select: { history: true },
      });
      if (Array.isArray(row?.history) && (row.history as unknown[]).length > 0) {
        return Response.json(row.history);
      }
    }

    const ct = upstream.headers.get("content-type") ?? "application/json";
    const outHeaders: Record<string, string> = { "content-type": ct };
    if (ct.includes("text/event-stream")) {
      outHeaders["cache-control"] = "no-cache, no-transform";
      outHeaders["connection"] = "keep-alive";
      // Disable proxy buffering on any nginx/Render edge that respects it.
      outHeaders["x-accel-buffering"] = "no";
    }
    // Tee the `/event` bus so we can persist turns server-side: one branch
    // streams to the client untouched, the other is consumed to watch for
    // `session.idle` and snapshot the thread into the durable log + history.
    // This is the only completion signal — the client builds its view from the
    // bus and never re-fetches the thread.
    if (
      req.method === "GET" &&
      tail === "event" &&
      ct.includes("text/event-stream") &&
      upstream.body
    ) {
      const [clientStream, watchStream] = upstream.body.tee();
      void watchEventStreamAndSnapshot(watchStream, {
        session_id,
        sandbox_url: cached.sandbox_url,
        harness_session_id: cached.harness_session_id,
      });
      return new Response(clientStream, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error("opencode proxy error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
