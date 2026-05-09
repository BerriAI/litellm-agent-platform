/**
 * Claude Agent SDK harness — peer of opencode.
 *
 * Drop-in HTTP surface that the agent platform's `src/server/harness.ts`
 * already calls. Same endpoints, same wire shapes — the platform doesn't
 * need to know which harness it's talking to. Pick at session-create time
 * via `Agent.harness_id`, route to the matching ECS task definition.
 *
 *   POST /session                          create session, returns {id}
 *   POST /session/:id/message              run an agent turn (blocking)
 *   POST /session/:id/prompt_async         queue a turn for streaming
 *   GET  /session/:id/message              list session history
 *   POST /session/:id/abort                cancel in-flight run
 *   GET  /event                            SSE bus of session events
 *
 * Why this is shorter than opencode's harness: the SDK owns the agent loop,
 * tool execution, conversation persistence, and stream parsing. We're a
 * thin bridge between the platform's wire format and `query()`.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

// SDK's auto-resolution of the Claude Code native binary fails when
// `process.cwd()` differs from the SDK's install location (we run with
// cwd=/work/repo). Resolve the sibling platform package's `claude` binary
// off the SDK's own module path and pin it via options.pathToClaudeCodeExecutable.
function resolveClaudeBinary(): string | undefined {
  const req = createRequire(import.meta.url);
  let sdkPath: string;
  try {
    sdkPath = req.resolve("@anthropic-ai/claude-agent-sdk");
  } catch {
    return undefined;
  }
  const platformDir = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidate = join(
    dirname(sdkPath),
    "..",
    platformDir,
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  return existsSync(candidate) ? candidate : undefined;
}
const CLAUDE_BIN = resolveClaudeBinary();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "4096", 10);
const REPO_DIR = process.env.REPO_DIR ?? "/work/repo";
const DEFAULT_MODEL =
  process.env.LITELLM_DEFAULT_MODEL ?? "claude-haiku-4-5";
const SYSTEM_PROMPT = process.env.AGENT_PROMPT ?? "";

// Route the SDK through the LiteLLM gateway. The SDK reads ANTHROPIC_BASE_URL
// and ANTHROPIC_AUTH_TOKEN, so set those from the LITELLM_* container env that
// the platform already passes in.
if (process.env.LITELLM_API_BASE) {
  process.env.ANTHROPIC_BASE_URL = process.env.LITELLM_API_BASE.replace(
    /\/+$/,
    "",
  );
}
if (process.env.LITELLM_API_KEY) {
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.LITELLM_API_KEY;
  process.env.ANTHROPIC_API_KEY = process.env.LITELLM_API_KEY;
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface BusEvent {
  type: string;
  properties: Record<string, unknown> & { sessionID: string };
}

interface Session {
  id: string;                          // our session id (returned to platform)
  sdk_session_id: string | null;       // SDK's session id, set after first turn
  abortController: AbortController | null;
  history: PlatformMessage[];          // synthesized for GET /message
  busSubscribers: Set<(e: BusEvent) => void>;
  pending_prompt: string | null;       // for prompt_async → bus consumer pickup
  pending_kick: (() => void) | null;
}

const sessions = new Map<string, Session>();
const globalBusSubscribers = new Set<(e: BusEvent) => void>();

function getSession(id: string): Session | null {
  return sessions.get(id) ?? null;
}

function emit(s: Session, type: string, props: Record<string, unknown>): void {
  const event: BusEvent = {
    type,
    properties: { ...props, sessionID: s.id },
  };
  for (const cb of s.busSubscribers) cb(event);
  for (const cb of globalBusSubscribers) cb(event);
}

// ---------------------------------------------------------------------------
// Wire-shape adapters — platform's HarnessMessageResponse <-> SDK events
// ---------------------------------------------------------------------------

interface PlatformPart {
  // Stable per-part id. The platform UI keys deltas off this — without it,
  // a `message.part.delta` arriving from us has no way to splice into the
  // right bubble. Format: `${assistantMsgId}_b${blockIndex}`.
  id?: string;
  type: string;
  [k: string]: unknown;
}
interface PlatformMessage {
  info: {
    id: string;
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    tokens?: {
      input?: number;
      output?: number;
      cache?: { read?: number; write?: number };
    };
    cost?: number;
    error?: { name: string; data: { message: string } };
  };
  parts: PlatformPart[];
}

function emptyParts(): PlatformPart[] {
  return [];
}

/**
 * Run the SDK and aggregate streaming events into the platform's blocking
 * response shape. The bus subscribers also see the same events live, which
 * is what powers `/event` SSE for the streaming UI route.
 */
async function runTurn(
  s: Session,
  userText: string,
  modelId: string,
): Promise<PlatformMessage> {
  const startedAt = Date.now();
  const ac = new AbortController();
  s.abortController = ac;

  // Emit a `user` message into the bus so the streaming UI can render the
  // prompt as soon as it lands, before the assistant turn starts.
  const userMessage: PlatformMessage = {
    info: {
      id: `user_${randomUUID()}`,
      role: "user",
      time: { created: startedAt, completed: startedAt },
    },
    parts: [{ type: "text", text: userText }],
  };
  s.history.push(userMessage);
  emit(s, "message.updated", { info: userMessage.info });

  const options: Options = {
    cwd: REPO_DIR,
    model: modelId,
    systemPrompt: SYSTEM_PROMPT || undefined,
    permissionMode: "bypassPermissions",
    abortController: ac,
    // Token-level streaming. Without this, the SDK only emits one `assistant`
    // event when the whole turn finishes — so the UI sees one big chunk
    // instead of progressive text. With it on, the SDK emits `stream_event`
    // frames carrying Anthropic-API content_block_delta deltas; we splice
    // those into a growing `message.part.updated` below.
    includePartialMessages: true,
    ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
    // Resume the SDK's persisted session if we have one — that's how the
    // SDK stitches turn N+1 onto turn N's history without us tracking it.
    ...(s.sdk_session_id ? { resume: s.sdk_session_id } : {}),
  };

  const assistantMessageId = `msg_${randomUUID()}`;
  const parts: PlatformPart[] = emptyParts();
  let lastError: { name: string; data: { message: string } } | undefined;
  let totalCost: number | undefined;
  let usage: PlatformMessage["info"]["tokens"];

  try {
    const stream = query({ prompt: userText, options });

    for await (const m of stream as AsyncIterable<SDKMessage>) {
      handleSdkEvent(s, m, parts, assistantMessageId, (e) => {
        if (e.error) lastError = e.error;
        if (e.cost !== undefined) totalCost = e.cost;
        if (e.usage) usage = e.usage;
        if (e.sdk_session_id && !s.sdk_session_id)
          s.sdk_session_id = e.sdk_session_id;
      });
    }
  } catch (err) {
    if (ac.signal.aborted) {
      lastError = {
        name: "AbortError",
        data: { message: "run aborted by client" },
      };
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = { name: "SDKError", data: { message: msg.slice(0, 500) } };
    }
  } finally {
    s.abortController = null;
  }

  const completedAt = Date.now();
  const assistant: PlatformMessage = {
    info: {
      id: assistantMessageId,
      role: "assistant",
      time: { created: startedAt, completed: completedAt },
      tokens: usage,
      cost: totalCost,
      ...(lastError ? { error: lastError } : {}),
    },
    parts,
  };
  s.history.push(assistant);

  emit(s, "message.updated", { info: assistant.info });
  emit(s, "session.idle", { sessionID: s.id });

  return assistant;
}

interface SdkEventSink {
  error?: PlatformMessage["info"]["error"];
  cost?: number;
  usage?: PlatformMessage["info"]["tokens"];
  sdk_session_id?: string;
}

function handleSdkEvent(
  s: Session,
  m: SDKMessage,
  parts: PlatformPart[],
  msgId: string,
  sink: (e: SdkEventSink) => void,
): void {
  // The SDK's event shape is rich; we only translate the fields the platform
  // and its UI actually consume. Unknown event types pass through silently
  // so we don't break on a future SDK release.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = m as any;
  if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
    sink({ sdk_session_id: ev.session_id });
    emit(s, "session.connected", {});
  } else if (ev.type === "assistant" && ev.message) {
    const content = ev.message.content ?? [];
    content.forEach((block: { type: string; text?: string; name?: string; id?: string; input?: unknown }, idx: number) => {
      // Stable per-block id so the UI can pair this authoritative update with
      // any deltas it received earlier under the same partID. Format mirrors
      // the stream_event branch below.
      const partId = `${msgId}_b${idx}`;
      if (block.type === "text") {
        const part: PlatformPart = {
          id: partId,
          type: "text",
          text: block.text ?? "",
        };
        parts.push(part);
        emit(s, "message.part.updated", { messageID: msgId, part });
      } else if (block.type === "tool_use") {
        const part: PlatformPart = {
          id: partId,
          type: "tool",
          tool: block.name,
          callID: block.id,
          state: { input: block.input, status: "running" },
        };
        parts.push(part);
        emit(s, "message.part.updated", { messageID: msgId, part });
      }
    });
  } else if (ev.type === "user" && ev.message) {
    // Tool results come back as `user` messages with `tool_result` blocks;
    // attach the output to the matching tool part so the UI can show it.
    const content = ev.message.content ?? [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const matching = parts
        .filter((p) => p.type === "tool")
        .find((p) => (p as { callID?: string }).callID === block.tool_use_id);
      if (!matching) continue;
      const out = Array.isArray(block.content)
        ? block.content
            .map((c: { type?: string; text?: string }) =>
              c.type === "text" ? (c.text ?? "") : "",
            )
            .join("")
        : typeof block.content === "string"
          ? block.content
          : "";
      const state = (matching as unknown as { state: Record<string, unknown> })
        .state;
      state.status = block.is_error ? "error" : "completed";
      state.output = out;
      if (block.is_error) state.error = out;
      emit(s, "message.part.updated", { messageID: msgId, part: matching });
    }
  } else if (ev.type === "result") {
    sink({
      cost: ev.total_cost_usd,
      usage: {
        input: ev.usage?.input_tokens,
        output: ev.usage?.output_tokens,
        cache: {
          read: ev.usage?.cache_read_input_tokens,
          write: ev.usage?.cache_creation_input_tokens,
        },
      },
    });
    if (ev.is_error) {
      sink({
        error: {
          name: "ResultError",
          data: { message: String(ev.result ?? "agent reported error") },
        },
      });
    }
  } else if (ev.type === "stream_event") {
    // Token-level deltas. With includePartialMessages: true, the SDK forwards
    // raw Anthropic-API SSE frames; the only one the UI cares about is
    // content_block_delta / text_delta. Map block-index → stable partID so
    // the UI can splice each delta onto the right bubble. The renderer at
    // src/app/sessions/[sid]/view.tsx:396 expects { partID, delta, field }.
    const inner = ev.event;
    if (
      inner?.type === "content_block_delta" &&
      typeof inner.index === "number" &&
      inner.delta?.type === "text_delta" &&
      typeof inner.delta.text === "string"
    ) {
      emit(s, "message.part.delta", {
        messageID: msgId,
        partID: `${msgId}_b${inner.index}`,
        delta: inner.delta.text,
        field: "text",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const app = new Hono();

app.get("/", (c) =>
  c.json({ harness: "claude-agent-sdk", version: "0.1.0", port: PORT }),
);

app.post("/session", async (c) => {
  let title: string | undefined;
  try {
    const body = (await c.req.json()) as { title?: string };
    title = body?.title;
  } catch {
    // empty body is fine — opencode accepts that too.
  }
  const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  sessions.set(id, {
    id,
    sdk_session_id: null,
    abortController: null,
    history: [],
    busSubscribers: new Set(),
    pending_prompt: null,
    pending_kick: null,
  });
  return c.json({ id, title: title ?? null });
});

app.get("/session/:id/message", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json(s.history);
});

app.post("/session/:id/message", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json()) as {
    model?: { providerID: string; modelID: string };
    parts?: Array<{ type?: string; text?: string }>;
  };
  const text = (body.parts ?? [])
    .filter((p) => p?.type === "text")
    .map((p) => p?.text ?? "")
    .join("\n");
  const modelId = body.model?.modelID ?? DEFAULT_MODEL;
  const result = await runTurn(s, text, modelId);
  return c.json(result);
});

app.post("/session/:id/prompt_async", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json()) as {
    model?: { providerID: string; modelID: string };
    parts?: Array<{ type?: string; text?: string }>;
  };
  const text = (body.parts ?? [])
    .filter((p) => p?.type === "text")
    .map((p) => p?.text ?? "")
    .join("\n");
  const modelId = body.model?.modelID ?? DEFAULT_MODEL;

  // Kick off in the background; the streaming /event consumer follows the bus.
  // Errors are emitted on the bus, not thrown to this caller — this endpoint's
  // contract is fire-and-forget per the platform's expectations.
  void runTurn(s, text, modelId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emit(s, "session.error", { message: msg });
  });
  c.status(204);
  return c.body(null);
});

app.post("/session/:id/abort", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  if (s.abortController) {
    s.abortController.abort();
    emit(s, "session.aborted", {});
  }
  return c.json({ ok: true });
});

/**
 * SSE bus. The platform's streaming route subscribes here, filters by
 * `properties.sessionID === harness_session_id`, and forwards each event
 * to the browser. Anything we `emit()` upstream lands here.
 */
app.get("/event", (c) =>
  streamSSE(c, async (stream) => {
    const cb = (e: BusEvent): void => {
      void stream.writeSSE({ data: JSON.stringify(e) });
    };
    globalBusSubscribers.add(cb);
    // First event the platform's stream route waits for before posting the
    // prompt — same contract opencode has.
    await stream.writeSSE({
      data: JSON.stringify({ type: "server.connected", properties: {} }),
    });
    try {
      // Hold the stream open until the client disconnects. Heartbeats keep
      // intermediate proxies (Render, browsers) from killing idle SSE.
      while (!stream.aborted) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    } finally {
      globalBusSubscribers.delete(cb);
    }
  }),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(
    `claude-agent-sdk harness listening on http://0.0.0.0:${info.port}`,
  );
  console.log(`  cwd=${REPO_DIR} model=${DEFAULT_MODEL}`);
  console.log(
    `  base=${process.env.ANTHROPIC_BASE_URL ?? "<sdk default>"}`,
  );
});
