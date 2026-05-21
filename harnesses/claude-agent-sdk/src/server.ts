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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  buildMemoryMcpServer,
  MEMORY_TOOL_NAMES,
} from "./memory-tools.js";
import {
  buildScreenshotMcpServer,
  SCREENSHOT_TOOL_NAMES,
} from "./screenshot-tool.js";
import {
  buildRecordingMcpServer,
  RECORDING_TOOL_NAMES,
} from "./recording-tool.js";
import {
  buildSandboxMcpServer,
  SANDBOX_TOOL_NAMES,
} from "./sandbox-mcp.js";

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

// In-process MCP server exposing save_memory + search_memory to the model.
// Returns null when LAP_BASE_URL/AGENT_ID/LAP_AUTH_TOKEN aren't all set, so
// local dev without the platform reachable still works (tools just absent).
const MEMORY_MCP = buildMemoryMcpServer();
const SCREENSHOT_MCP = buildScreenshotMcpServer();
const RECORDING_MCP = buildRecordingMcpServer();

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

interface SandboxProject {
  id: string;
  name: string;
  description: string;
  repo_url?: string;
}

interface Session {
  id: string;                          // our session id (returned to platform)
  system_prompt: string;               // per-session override from agent.prompt
  sdk_session_id: string | null;       // SDK's session id, set after first turn
  abortController: AbortController | null;
  history: PlatformMessage[];          // synthesized for GET /message
  busSubscribers: Set<(e: BusEvent) => void>;
  pending_prompt: string | null;       // for prompt_async → bus consumer pickup
  pending_kick: (() => void) | null;
  sandbox_tools: boolean;              // when true: restrict to sandbox MCP tools
  projects: SandboxProject[];          // available project templates (sandbox mode)
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
  for (const cb of s.busSubscribers) {
    try { cb(event); } catch (err) { console.error("[emit] session subscriber threw:", err); }
  }
  for (const cb of globalBusSubscribers) {
    try { cb(event); } catch (err) { console.error("[emit] global subscriber threw:", err); }
  }
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
/**
 * Anthropic-format image content block. Same shape the Claude API uses on
 * the wire; the Agent SDK forwards it verbatim when we pass an
 * AsyncIterable<SDKUserMessage> as `prompt`. `media_type` is the strict
 * union Anthropic's types require — validated at the wire boundary in
 * `extractTextAndImages`.
 */
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
interface ImageContentBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: ImageMediaType;
    data: string;
  };
}

// Extended-thinking config, model-aware (per Anthropic adaptive-thinking docs):
// opus-4-7 / opus-4-6 / sonnet-4-6 support adaptive; older Claude models use the
// legacy enabled+budget format; haiku / non-Claude get none. display:"summarized"
// so the thinking TEXT (not just the encrypted signature) comes back to render.
function thinkingOptionsFor(modelId: string): Partial<Options> {
  const m = modelId.toLowerCase();
  if (m.includes("haiku")) return {};
  if (/opus-4-7|opus-4-6|sonnet-4-6/.test(m))
    return { thinking: { type: "adaptive", display: "summarized" }, effort: "high" };
  if (/claude|sonnet|opus/.test(m))
    return { thinking: { type: "enabled", budgetTokens: 8000, display: "summarized" } };
  return {};
}

async function runTurn(
  s: Session,
  userText: string,
  modelId: string,
  images?: ImageContentBlock[],
): Promise<PlatformMessage> {
  const startedAt = Date.now();
  const ac = new AbortController();
  s.abortController = ac;

  // Emit a `user` message into the bus so the streaming UI can render the
  // prompt as soon as it lands, before the assistant turn starts. Images
  // are surfaced as a single `image_count` part — the UI doesn't render
  // inline image blocks yet (and the base64 payload would bloat the
  // history-backed message log), so we record the count for context.
  const userParts: PlatformPart[] =
    images && images.length > 0
      ? [
          ...(userText ? [{ type: "text", text: userText }] : []),
          { type: "image_count", count: images.length },
        ]
      : [{ type: "text", text: userText }];
  const userMessage: PlatformMessage = {
    info: {
      id: `user_${randomUUID()}`,
      role: "user",
      time: { created: startedAt, completed: startedAt },
    },
    parts: userParts,
  };
  s.history.push(userMessage);
  emit(s, "message.updated", { info: userMessage.info });
  // `message.updated` only carries `info` — emit each user part too so the
  // event-driven UI renders the prompt text live (opencode does the same).
  // Without this the live user bubble is empty until a history re-seed.
  for (let i = 0; i < userParts.length; i++) {
    const part = { ...userParts[i], id: `${userMessage.info.id}_p${i}`, messageID: userMessage.info.id };
    emit(s, "message.part.updated", { messageID: userMessage.info.id, part });
  }

  // Sandbox mode: a per-session MCP server exposing provision + execute,
  // built lazily on each turn (it's stateless — only needs session_id).
  // Returns null when LAP_BASE_URL/LAP_AUTH_TOKEN aren't set.
  const sandboxMcp = s.sandbox_tools ? buildSandboxMcpServer(s.id) : null;

  // Build the system prompt, appending available project templates when
  // running in sandbox mode so the model knows which IDs to pass to provision().
  let effectiveSystemPrompt = (s.system_prompt || SYSTEM_PROMPT) || undefined;
  if (s.sandbox_tools && s.projects.length > 0) {
    const projectList = s.projects
      .map(
        (p) =>
          `- ID: ${p.id} | ${p.name}${p.description ? " — " + p.description : ""}${p.repo_url ? " (" + p.repo_url + ")" : ""}`,
      )
      .join("\n");
    const sandboxHint =
      `\n\nAvailable sandbox templates:\n${projectList}\n\n` +
      `To use a sandbox: call provision({ name: "<label>", project_id: "<ID>" }), then execute({ sandbox_name: "<label>", cmd: "..." })`;
    effectiveSystemPrompt = (effectiveSystemPrompt ?? "") + sandboxHint;
  }

  const options: Options = {
    cwd: REPO_DIR,
    model: modelId,
    // Request extended thinking so the SDK emits thinking blocks (rendered as
    // ThinkingBlock in the UI). Without this the model never thinks.
    ...thinkingOptionsFor(modelId),
    systemPrompt: effectiveSystemPrompt,
    permissionMode: "bypassPermissions",
    abortController: ac,
    // Token-level streaming. Without this, the SDK only emits one `assistant`
    // event when the whole turn finishes — so the UI sees one big chunk
    // instead of progressive text. With it on, the SDK emits `stream_event`
    // frames carrying Anthropic-API content_block_delta deltas; we splice
    // those into a growing `message.part.updated` below.
    includePartialMessages: true,
    // AskUserQuestion stalls the agent loop until the user answers a structured
    // tool call — but neither the web UI nor Slack renders question.asked
    // events yet, so the loop just parks indefinitely. Disable the tool so the
    // model has to make its best judgment and proceed. Revisit when both
    // surfaces render answerable question cards.
    disallowedTools: ["AskUserQuestion"],
    ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
    ...(s.sandbox_tools
      ? {
          // Sandbox mode: restrict built-in tools to safe read-only web tools
          // and expose only the provision/execute MCP tools.
          allowedTools: [
            "WebFetch",
            "WebSearch",
            ...(sandboxMcp ? [...SANDBOX_TOOL_NAMES] : []),
          ],
          mcpServers: {
            ...(sandboxMcp ? { "lap-sandbox": sandboxMcp } : {}),
          },
        }
      : {
          // Normal mode: full memory + screenshot + recording tool set.
          mcpServers: {
            ...(MEMORY_MCP ? { "lap-memory": MEMORY_MCP } : {}),
            "lap-screenshot": SCREENSHOT_MCP,
            "lap-recording": RECORDING_MCP,
          },
          allowedTools: [
            ...(MEMORY_MCP ? [...MEMORY_TOOL_NAMES] : []),
            ...SCREENSHOT_TOOL_NAMES,
            ...RECORDING_TOOL_NAMES,
          ],
        }),
    // Resume the SDK's persisted session if we have one — that's how the
    // SDK stitches turn N+1 onto turn N's history without us tracking it.
    ...(s.sdk_session_id ? { resume: s.sdk_session_id } : {}),
  };

  const assistantMessageId = `msg_${randomUUID()}`;
  const parts: PlatformPart[] = emptyParts();
  let lastError: { name: string; data: { message: string } } | undefined;
  let totalCost: number | undefined;
  let usage: PlatformMessage["info"]["tokens"];

  // Block-id allocation across the whole turn. The Anthropic API resets
  // `content_block` indices to 0 for every assistant SDK message — a turn
  // with a thinking message + a text message would have two `index=0` blocks
  // that collide if we keyed parts off `index` alone. We map each
  // (sdkMsgId, content_block.index) pair to a turn-unique globalIdx.
  const turnState: TurnStreamState = {
    nextGlobalIdx: 0,
    currentSdkMsgId: null,
    blockIdxsBySdkMsgId: new Map(),
    thinkingAccum: new Map(),
    asstBlockCount: new Map(),
  };

  try {
    // Multimodal prompt: when images are attached we can't use the simple
    // `prompt: string` form, because string-prompts are wrapped by the SDK
    // as text-only user content. Switch to the AsyncIterable<SDKUserMessage>
    // path and build a content array with text + image blocks. Single-turn
    // generator — the SDK consumes one message then closes.
    const promptArg =
      images && images.length > 0
        ? (async function* () {
            const content: Array<
              { type: "text"; text: string } | ImageContentBlock
            > = [];
            if (userText) content.push({ type: "text", text: userText });
            for (const img of images) content.push(img);
            yield {
              type: "user" as const,
              message: { role: "user" as const, content },
              parent_tool_use_id: null,
            };
          })()
        : userText;
    const stream = query({ prompt: promptArg, options });

    for await (const m of stream as AsyncIterable<SDKMessage>) {
      // Native passthrough. The SDK message is the contract — anything
      // subscribed to `/sessions/:id/stream` reads
      // `@anthropic-ai/claude-agent-sdk` types directly and renders
      // without translation.
      emit(s, "claude_sdk_message", { message: m });
      // We still build the in-memory `parts` array for the DB-backed
      // `/messages` historical view. `handleSdkEvent` does that
      // translation; live consumers should ignore everything on the bus
      // except `claude_sdk_message` going forward — the legacy
      // `message.part.*` envelopes remain only for backcompat.
      handleSdkEvent(s, m, parts, assistantMessageId, turnState, (e) => {
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
      console.error(`[runTurn] SDK error session=${s.id}:`, err);
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

interface TurnStreamState {
  // Next part-id to allocate for this turn. Increments on every new content
  // block we see, regardless of which SDK message it came from.
  nextGlobalIdx: number;
  // Most recent SDK assistant message id seen on the bus. The
  // `stream_event content_block_start` events that follow `message_start`
  // belong to this id until the next message_start fires.
  currentSdkMsgId: string | null;
  // Per-SDK-message: the array of globalIdxs allocated for its blocks, in
  // content-index order. Lookups: `assistant` events arrive AFTER all the
  // blocks have been started, so we just read straight from this map by
  // ev.message.id.
  blockIdxsBySdkMsgId: Map<string, number[]>;
  // Accumulated thinking text keyed by "${sdkMsgId}:${blockIndex}". Keying
  // by (sdkMsgId, blockIndex) — not globalIdx — ensures the assistant event
  // lookup succeeds even when blockIdxsBySdkMsgId misses (e.g. message_start
  // arrived without an id) and we fall back to fresh globalIdxs. The final
  // `assistant` event delivers block.thinking="" when the SDK doesn't
  // re-aggregate streaming thinking_delta events; we fall back to this map.
  thinkingAccum: Map<string, string>;
  // Per-SDK-message running count of assistant-event blocks. The SDK emits
  // `assistant` events incrementally — one content block each, always at
  // content-index 0 — so we accumulate the real block index here to build a
  // stable, unique partID that matches the streamed deltas (b0, b1, b2, …).
  asstBlockCount: Map<string, number>;
}

function handleSdkEvent(
  s: Session,
  m: SDKMessage,
  parts: PlatformPart[],
  msgId: string,
  turn: TurnStreamState,
  sink: (e: SdkEventSink) => void,
): void {
  // The SDK's event shape is rich; we only translate the fields the platform
  // and its UI actually consume. Unknown event types pass through silently
  // so we don't break on a future SDK release.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = m as any;
  // Debug visibility: log every raw SDK event type and (for assistant turns)
  // each content block's type. Helps catch silently-dropped block types like
  // `thinking`. Set HARNESS_DEBUG=1 to enable.
  if (process.env.HARNESS_DEBUG) {
    if (ev.type === "assistant" && ev.message?.content) {
      const blocks = (ev.message.content as Array<{ type: string }>).map(
        (b) => b.type,
      );
      console.log(`[sdk] assistant blocks=[${blocks.join(",")}]`);
    } else if (ev.type === "stream_event") {
      const inner = ev.event;
      const innerType = inner?.type ?? "?";
      const deltaType = inner?.delta?.type;
      const blockType = inner?.content_block?.type;
      console.log(
        `[sdk] stream_event ${innerType}` +
          (deltaType ? ` delta=${deltaType}` : "") +
          (blockType ? ` block=${blockType}` : ""),
      );
    } else {
      console.log(`[sdk] ${ev.type}${ev.subtype ? "/" + ev.subtype : ""}`);
    }
  }
  if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
    sink({ sdk_session_id: ev.session_id });
    emit(s, "session.connected", {});
  } else if (ev.type === "assistant" && ev.message) {
    const content = ev.message.content ?? [];
    const sdkMsgId: string | undefined = ev.message.id;
    // The SDK delivers `assistant` events incrementally — one content block at
    // a time, always at content-index 0 — so the raw `idx` collides on b0 for
    // reasoning/text/tool. Accumulate a running block count per SDK message so
    // each part gets a unique, stream-aligned partID.
    const seenBlocks = turn.asstBlockCount.get(sdkMsgId ?? "") ?? 0;
    content.forEach((block: { type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }, idx: number) => {
      // Real block index = accumulated count + position in this event. Unique
      // per block and aligned with the streamed delta partIDs (b0, b1, b2…) so
      // reasoning/text/tool never collide and overwrite each other.
      const blockIdx = seenBlocks + idx;
      const partId = `${sdkMsgId ?? msgId}_b${blockIdx}`;
      if (block.type === "text") {
        const part: PlatformPart = {
          id: partId,
          type: "text",
          text: block.text ?? "",
        };
        parts.push(part);
        emit(s, "message.part.updated", { messageID: msgId, part });
      } else if (block.type === "thinking") {
        // Extended-thinking content block. The model's reasoning, surfaced
        // to the UI as a separate part so it can render distinctly (collapsed
        // gray box, etc) instead of mixing into the visible reply text.
        // The SDK doesn't always re-aggregate streaming thinking_delta events
        // into the final assistant message — fall back to what we accumulated
        // from the stream so the history entry has the full reasoning text.
        const thinkingKey = `${sdkMsgId}:${blockIdx}`;
        const streamAccum = turn.thinkingAccum.get(thinkingKey) ?? "";
        const part: PlatformPart = {
          id: partId,
          // Match the opencode schema: reasoning is a "reasoning" part so the
          // UI renders it identically across harnesses (ReasoningBlock).
          type: "reasoning",
          text: (block.thinking as string | undefined) || streamAccum,
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
    turn.asstBlockCount.set(sdkMsgId ?? "", seenBlocks + content.length);
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
    // raw Anthropic-API SSE frames. We track which SDK message + block each
    // delta belongs to so partIDs stay turn-unique even when the SDK emits
    // multiple assistant messages per turn (each restarting block-index at 0).
    const inner = ev.event;
    if (inner?.type === "message_start" && inner.message?.id) {
      turn.currentSdkMsgId = inner.message.id;
      turn.blockIdxsBySdkMsgId.set(inner.message.id, []);
      return;
    }
    if (
      inner?.type === "content_block_start" &&
      typeof inner.index === "number" &&
      turn.currentSdkMsgId
    ) {
      const arr = turn.blockIdxsBySdkMsgId.get(turn.currentSdkMsgId) ?? [];
      arr[inner.index] = turn.nextGlobalIdx++;
      turn.blockIdxsBySdkMsgId.set(turn.currentSdkMsgId, arr);
      return;
    }
    if (
      inner?.type === "content_block_delta" &&
      typeof inner.index === "number" &&
      turn.currentSdkMsgId
    ) {
      // Same (SDK message id, block index) key as the assistant-event update
      // above, so streamed deltas land on the same part and never collide.
      const partID = `${turn.currentSdkMsgId}_b${inner.index}`;
      if (
        inner.delta?.type === "text_delta" &&
        typeof inner.delta.text === "string"
      ) {
        emit(s, "message.part.delta", {
          messageID: msgId,
          partID,
          delta: inner.delta.text,
          field: "text",
        });
      } else if (
        inner.delta?.type === "thinking_delta" &&
        typeof inner.delta.thinking === "string"
      ) {
        // Token-level thinking stream. Accumulate into thinkingAccum so the
        // final assistant event can fall back to this text if block.thinking
        // arrives empty. Key by "${sdkMsgId}:${blockIndex}" so the lookup in
        // the assistant event handler matches the same slot.
        const thinkingKey = `${turn.currentSdkMsgId}:${inner.index}`;
        const prev = turn.thinkingAccum.get(thinkingKey) ?? "";
        turn.thinkingAccum.set(thinkingKey, prev + inner.delta.thinking);
        emit(s, "message.part.delta", {
          messageID: msgId,
          partID,
          delta: inner.delta.thinking,
          // "reasoning" to match the opencode schema (see the part type above).
          field: "reasoning",
        });
      }
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
  let prompt: string | undefined;
  let files: Array<{ sandbox_path: string; content: string }> = [];
  let sandbox_tools = false;
  let projects: SandboxProject[] = [];
  try {
    const body = (await c.req.json()) as {
      title?: string;
      prompt?: string;
      files?: Array<{ sandbox_path: string; content: string }>;
      sandbox_tools?: boolean;
      projects?: Array<{ id: string; name: string; description: string; repo_url?: string }>;
    };
    title = body?.title;
    prompt = body?.prompt;
    files = Array.isArray(body?.files) ? body.files : [];
    sandbox_tools = body?.sandbox_tools === true;
    projects = Array.isArray(body?.projects) ? body.projects : [];
  } catch {
    // empty body is fine — opencode accepts that too.
  }
  for (const f of files) {
    try {
      const dest = f.sandbox_path.replace(/^~(?=\/|$)/, process.env.HOME ?? "/root");
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(f.content, "base64"));
    } catch (err) {
      console.error(`sandbox file inject failed (${f.sandbox_path}): ${err}`);
    }
  }
  const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  sessions.set(id, {
    id,
    system_prompt: prompt ?? "",
    sdk_session_id: null,
    abortController: null,
    history: [],
    busSubscribers: new Set(),
    pending_prompt: null,
    pending_kick: null,
    sandbox_tools,
    projects,
  });
  return c.json({ id, title: title ?? null });
});

app.get("/session/:id/message", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json(s.history);
});

/**
 * Anthropic-format image source as it arrives on the wire. The platform
 * dispatcher constructs this shape from inbound integration attachments
 * (e.g. Slack file uploads) — we forward verbatim to the Claude SDK.
 */
interface InboundPart {
  type?: string;
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

function extractTextAndImages(parts: InboundPart[] | undefined): {
  text: string;
  images: ImageContentBlock[];
} {
  const text = (parts ?? [])
    .filter((p) => p?.type === "text")
    .map((p) => p?.text ?? "")
    .join("\n");
  const images: ImageContentBlock[] = [];
  for (const p of parts ?? []) {
    if (
      p?.type === "image" &&
      p.source?.type === "base64" &&
      typeof p.source.media_type === "string" &&
      typeof p.source.data === "string" &&
      SUPPORTED_IMAGE_MEDIA_TYPES.has(p.source.media_type)
    ) {
      images.push({
        type: "image",
        source: {
          type: "base64",
          media_type: p.source.media_type as ImageMediaType,
          data: p.source.data,
        },
      });
    }
  }
  return { text, images };
}

app.post("/session/:id/message", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json()) as {
    model?: { providerID: string; modelID: string };
    parts?: InboundPart[];
  };
  const { text, images } = extractTextAndImages(body.parts);
  const modelId = body.model?.modelID ?? DEFAULT_MODEL;
  const result = await runTurn(s, text, modelId, images.length > 0 ? images : undefined);
  return c.json(result);
});

app.post("/session/:id/prompt_async", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json()) as {
    model?: { providerID: string; modelID: string };
    parts?: InboundPart[];
  };
  const { text, images } = extractTextAndImages(body.parts);
  const modelId = body.model?.modelID ?? DEFAULT_MODEL;

  // Kick off in the background; the streaming /event consumer follows the bus.
  // Errors are emitted on the bus, not thrown to this caller — this endpoint's
  // contract is fire-and-forget per the platform's expectations.
  void runTurn(s, text, modelId, images.length > 0 ? images : undefined).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      emit(s, "session.error", { message: msg });
    },
  );
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

app.delete("/session/:id", async (c) => {
  const id = c.req.param("id");
  const s = getSession(id);
  if (!s) return c.json({ error: "not found" }, 404);
  // Abort any in-flight turn before dropping the session entry.
  if (s.abortController) {
    s.abortController.abort();
  }
  sessions.delete(id);
  return c.json({ ok: true });
});

/**
 * SSE bus. The platform's streaming route subscribes here, filters by
 * `properties.sessionID === harness_session_id`, and forwards each event
 * to the browser. Anything we `emit()` upstream lands here.
 */
app.get("/event", (c) =>
  streamSSE(c, async (stream) => {
    const subscriberId = Math.random().toString(36).slice(2, 8);
    console.log(`[event/sse] subscriber ${subscriberId} connected`);
    const cb = (e: BusEvent): void => {
      stream.writeSSE({ data: JSON.stringify(e) }).catch((err: unknown) => {
        // Swallow write errors — subscriber may have disconnected. The
        // heartbeat loop will detect stream.aborted and clean up.
        console.error(`[event/sse] subscriber ${subscriberId} writeSSE failed (type=${e.type}):`, err);
      });
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
        if (stream.aborted) break;
        try {
          await stream.writeSSE({ event: "ping", data: "" });
        } catch (err) {
          console.error(`[event/sse] subscriber ${subscriberId} heartbeat failed, closing:`, err);
          break;
        }
      }
    } finally {
      console.log(`[event/sse] subscriber ${subscriberId} disconnected`);
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
