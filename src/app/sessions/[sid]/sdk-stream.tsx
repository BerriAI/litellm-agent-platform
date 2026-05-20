"use client";

/**
 * SDKMessage stream wiring for the session detail page.
 *
 * The harness now publishes one `claude_sdk_message` envelope per
 * Anthropic `SDKMessage` on its event bus, alongside the existing
 * `message.part.*` legacy envelopes. The browser opens
 * `/api/ui/sessions/:id/stream` via `EventSource`, parses each frame, and
 * routes to:
 *
 *   - `claude_sdk_message` => push `properties.message` into a local
 *     `SDKMessage[]` array. `foldSdkMessages` collapses the partial
 *     `stream_event` frames into rolling assistant messages.
 *   - `session.idle | .error | .aborted` => set the status state so the
 *     header can drop its "live" indicator.
 *   - `stream.opened` => ignored (we have our own status).
 *   - `message.part.*` (legacy) => ignored. The historical `/messages`
 *     replay is still wired and remains the source of truth for the older
 *     wire format.
 *
 * Renders a `SdkStreamPanel` that walks the folded list and shows:
 *   - assistant text blocks as paragraphs
 *   - thinking blocks as collapsible <details>
 *   - tool_use blocks with their input JSON, paired with their matching
 *     tool_result from the next user turn (resolved by `tool_use_id`)
 *   - result messages as a terminal usage/cost line
 *   - system + plain user messages are skipped (prompt is shown elsewhere)
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { foldSdkMessages, type FoldedMessage } from "@/lib/fold-sdk-messages";

export type SdkStreamStatus =
  | "idle" // not connected (e.g. session not ready yet)
  | "streaming" // EventSource open, frames flowing
  | "completed" // saw session.idle
  | "error"
  | "aborted";

/**
 * Run-status frames the harness emits on the SSE bus. The platform's
 * /event passthrough forwards these verbatim under their top-level
 * `type`. We only react to the ones that signal the agent loop has
 * settled — everything else is ignored on this code path.
 */
const TERMINAL_TYPES = new Set([
  "session.idle",
  "session.error",
  "session.aborted",
]);

interface ClaudeSdkMessageFrame {
  type: "claude_sdk_message";
  properties: { message: SDKMessage };
}

interface SessionStatusFrame {
  type: string;
  properties?: Record<string, unknown>;
}

type AnyFrame = ClaudeSdkMessageFrame | SessionStatusFrame;

/**
 * Opens `/api/ui/sessions/:id/stream` and returns the rolling list of raw
 * `SDKMessage`s plus a status. The cookie that gates the route is
 * installed via `ensureUiCookie()` before connecting — without it the
 * EventSource would 401 immediately on every browser tab.
 *
 * `enabled` is false until the session row reaches `ready`; the harness
 * doesn't have an event bus to subscribe to before then.
 */
export function useSdkMessageStream(
  sessionId: string,
  enabled: boolean,
): { messages: SDKMessage[]; status: SdkStreamStatus } {
  const [messages, setMessages] = useState<SDKMessage[]>([]);
  const [status, setStatus] = useState<SdkStreamStatus>("idle");
  // Hold the EventSource in a ref so the cleanup closes the exact instance
  // the effect opened, even if React re-runs the effect during dev's
  // strict-mode double-invoke.
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("idle");

    (async () => {
      // Plant the HttpOnly cookie before opening the stream; this is a
      // no-op after the first call per page because the cookie is shared.
      const cookieOk = await ensureUiCookie();
      if (cancelled) return;
      if (!cookieOk) {
        setStatus("error");
        return;
      }

      const es = new EventSource(
        `/api/ui/sessions/${encodeURIComponent(sessionId)}/stream`,
      );
      esRef.current = es;
      setStatus("streaming");

      es.onmessage = (ev: MessageEvent) => {
        if (cancelled) return;
        let parsed: AnyFrame;
        try {
          parsed = JSON.parse(ev.data) as AnyFrame;
        } catch {
          // Malformed frame — server should never emit these. Skip rather
          // than break the stream.
          return;
        }
        if (parsed.type === "claude_sdk_message") {
          const sdk = (parsed as ClaudeSdkMessageFrame).properties?.message;
          if (!sdk) return;
          setMessages((prev) => [...prev, sdk]);
          return;
        }
        if (TERMINAL_TYPES.has(parsed.type)) {
          if (parsed.type === "session.idle") setStatus("completed");
          else if (parsed.type === "session.error") setStatus("error");
          else if (parsed.type === "session.aborted") setStatus("aborted");
          return;
        }
        // Everything else (stream.opened, message.part.*, server.connected,
        // etc.) is ignored on this code path. The historical /messages
        // replay covers the legacy envelopes.
      };

      es.onerror = () => {
        if (cancelled) return;
        // EventSource auto-reconnects on transient drops; only flip to
        // `error` when the browser has given up (readyState=CLOSED).
        if (es.readyState === EventSource.CLOSED) {
          setStatus((prev) =>
            prev === "completed" || prev === "aborted" ? prev : "error",
          );
        }
      };
    })();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [sessionId, enabled]);

  return { messages, status };
}

let _uiCookiePromise: Promise<boolean> | null = null;

/**
 * POSTs the bearer master key (from localStorage) to /api/ui/auth/cookie so
 * the HttpOnly cookie that gates /api/ui/sessions/:id/stream is in place
 * before we open the EventSource. Resolves true on success, false on auth
 * failure or network error. Cached per-page so multiple subscribers share
 * one install.
 */
function ensureUiCookie(): Promise<boolean> {
  if (_uiCookiePromise) return _uiCookiePromise;
  _uiCookiePromise = (async () => {
    if (typeof window === "undefined") return false;
    let key: string | null = null;
    try {
      key = window.localStorage.getItem("ui_master_key");
    } catch {
      return false;
    }
    if (!key) return false;
    try {
      const res = await fetch("/api/ui/auth/cookie", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  })();
  return _uiCookiePromise;
}

// =====================================================================
// Rendering
// =====================================================================

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
  // Streamed partial input (mirrors what foldSdkMessages accumulates from
  // `input_json_delta` frames before `content_block_stop`).
  input_partial_json?: string;
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

type AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock;

/**
 * Build a map of `tool_use_id => tool_result content` by walking the user
 * messages in the folded list. The harness emits tool results as
 * `user` SDKMessages with a `content` array of `tool_result` blocks; we
 * pair them with their `tool_use` siblings on the previous assistant turn
 * so the UI can render the call and its result inline.
 */
function indexToolResults(
  folded: FoldedMessage[],
): Map<string, ToolResultBlock> {
  const out = new Map<string, ToolResultBlock>();
  for (const m of folded) {
    if (m.type !== "user") continue;
    const userMsg = m as unknown as { message?: { content?: unknown } };
    const content = userMsg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result" &&
        typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
      ) {
        const tr = block as ToolResultBlock;
        out.set(tr.tool_use_id, tr);
      }
    }
  }
  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (
          c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string"
        ) {
          return (c as { text: string }).text;
        }
        try {
          return JSON.stringify(c);
        } catch {
          return String(c);
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function stringifyToolInput(block: ToolUseBlock): string {
  // Streaming path: partial JSON is the most up-to-date view while the
  // model is still emitting `input_json_delta` frames.
  if (
    typeof block.input_partial_json === "string" &&
    block.input_partial_json.length > 0
  ) {
    return block.input_partial_json;
  }
  if (block.input == null) return "";
  try {
    return JSON.stringify(block.input, null, 2);
  } catch {
    return String(block.input);
  }
}

export function SdkStreamPanel({
  messages,
  status,
}: {
  messages: SDKMessage[];
  status: SdkStreamStatus;
}) {
  const folded = useMemo(() => foldSdkMessages(messages), [messages]);
  const toolResults = useMemo(() => indexToolResults(folded), [folded]);

  // Hide the panel entirely until there's something to show OR we're
  // actively streaming. Avoids a dead box on every session page load
  // before the first turn lands.
  if (status === "idle" && folded.length === 0) return null;

  // Filter out frames that contribute nothing visible: system boilerplate,
  // and user messages that are pure-text prompts (those are surfaced in
  // the legacy thread view). Tool_result content from user messages is
  // already merged into the matching tool_use, so we drop the user row.
  const rows = folded.filter((m) => {
    if (m.type === "system") return false;
    if (m.type === "user") return false;
    return true;
  });

  return (
    <div className="border border-gray-200 bg-gray-50/40 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-medium text-gray-600 uppercase tracking-wide">
          Agent stream (SDK)
        </div>
        <StreamStatusBadge status={status} />
      </div>
      {rows.length === 0 && (
        <div className="text-[13px] text-gray-400">
          Waiting for the first SDK message…
        </div>
      )}
      {rows.map((m, i) => (
        <FoldedMessageRow
          key={i}
          msg={m}
          toolResults={toolResults}
        />
      ))}
    </div>
  );
}

function StreamStatusBadge({ status }: { status: SdkStreamStatus }) {
  if (status === "streaming") {
    return (
      <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 inline-flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        live
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="text-[11px] text-gray-500 border border-gray-200 rounded-full px-2 py-0.5">
        idle
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
        error
      </span>
    );
  }
  if (status === "aborted") {
    return (
      <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
        aborted
      </span>
    );
  }
  return null;
}

function FoldedMessageRow({
  msg,
  toolResults,
}: {
  msg: FoldedMessage;
  toolResults: Map<string, ToolResultBlock>;
}) {
  if (msg.type === "result") {
    return <ResultRow msg={msg} />;
  }
  if (msg.type === "assistant") {
    // SDKAssistantMessage's payload is `.message.content` (Anthropic API
    // shape). foldSdkMessages preserves this — we read the same path.
    const am = msg as unknown as { message?: { content?: unknown } };
    const blocks = Array.isArray(am.message?.content)
      ? (am.message!.content as AssistantBlock[])
      : [];
    return (
      <div className="flex flex-col gap-2">
        {blocks.map((block, i) => (
          <AssistantContentBlock
            key={i}
            block={block}
            toolResults={toolResults}
          />
        ))}
      </div>
    );
  }
  return null;
}

function AssistantContentBlock({
  block,
  toolResults,
}: {
  block: AssistantBlock;
  toolResults: Map<string, ToolResultBlock>;
}) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") {
    return (
      <p className="text-[14px] text-gray-800 leading-relaxed whitespace-pre-wrap">
        {block.text}
      </p>
    );
  }
  if (block.type === "thinking") {
    return (
      <details className="text-[13px] text-gray-500">
        <summary className="cursor-pointer select-none">Thinking</summary>
        <div className="mt-1 italic whitespace-pre-wrap border-l-2 border-gray-200 pl-3">
          {block.thinking}
        </div>
      </details>
    );
  }
  if (block.type === "tool_use") {
    const inputStr = stringifyToolInput(block);
    const result = toolResults.get(block.id);
    return (
      <div className="rounded-md border border-gray-200 bg-white text-[13px] text-gray-700">
        <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-100">
          <span className="text-gray-400">▸</span>
          <span className="font-mono text-[12px]">{block.name}</span>
          {result && (
            <span
              className={
                result.is_error
                  ? "ml-auto text-red-600 text-[11px]"
                  : "ml-auto text-emerald-600 text-[11px]"
              }
            >
              {result.is_error ? "✗" : "✓"}
            </span>
          )}
        </div>
        {inputStr && (
          <pre className="px-3 py-2 mono text-[11px] text-gray-600 whitespace-pre-wrap break-words m-0">
            {inputStr}
          </pre>
        )}
        {result && (
          <pre
            className={
              "px-3 py-2 mono text-[11px] whitespace-pre-wrap break-words m-0 border-t border-gray-100 " +
              (result.is_error ? "text-red-700 bg-red-50" : "text-gray-600")
            }
          >
            {stringifyToolResult(result.content)}
          </pre>
        )}
      </div>
    );
  }
  return null;
}

function ResultRow({ msg }: { msg: FoldedMessage }) {
  // SDKResultMessage carries cost/usage on its top-level — pull the bits
  // we care about defensively (the contract evolves).
  const r = msg as unknown as {
    total_cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
    is_error?: boolean;
    subtype?: string;
  };
  const cost =
    typeof r.total_cost_usd === "number"
      ? `$${r.total_cost_usd.toFixed(4)}`
      : null;
  const dur =
    typeof r.duration_ms === "number"
      ? `${(r.duration_ms / 1000).toFixed(1)}s`
      : null;
  const turns =
    typeof r.num_turns === "number" ? `${r.num_turns} turn(s)` : null;
  const parts = [r.subtype, turns, dur, cost].filter(Boolean);
  return (
    <div
      className={
        "mono text-[11px] " +
        (r.is_error ? "text-red-600" : "text-gray-400")
      }
    >
      {parts.length > 0 ? parts.join(" · ") : "result"}
    </div>
  );
}
