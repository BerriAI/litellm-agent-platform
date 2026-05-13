/**
 * Per-turn runner. Drives the SDK `query()`, hands each raw SDK event to
 * the central `ClaudeSdkTranslator`, and re-emits the resulting
 * `SessionEvent`s on the harness bus. Aggregates a legacy `PlatformMessage`
 * for callers that still expect a blocking response shape.
 */

import { randomUUID } from "node:crypto";

const newEventId = (): string => randomUUID();

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent } from "@lap/harness-shared/session-event";

import { MEMORY_TOOL_NAMES } from "./memory-tools.js";
import {
  ClaudeSdkTranslator,
  newTurnState,
  type ClaudeTranslationContext,
  type TurnMetaSink,
} from "./sdk-translator.js";

// Legacy blocking-response shape. Built by re-folding the SessionEvent[]
// the translator produces — same source of truth, two views.
export interface PlatformPart {
  id?: string;
  type: string;
  [k: string]: unknown;
}
export interface PlatformMessage {
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

export interface RunTurnSession {
  id: string;
  system_prompt: string;
  sdk_session_id: string | null;
  abortController: AbortController | null;
  history: PlatformMessage[];
}

export interface RunTurnConfig {
  repoDir: string;
  systemPrompt: string;
  claudeBin: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  memoryMcp: any;
}

const TRANSLATOR = new ClaudeSdkTranslator();

/**
 * Append-or-update a PlatformPart slice from one SessionEvent. The runner
 * uses this to keep a legacy `parts[]` array in sync so callers that still
 * read the blocking response (initial_prompt during session create, the
 * restart-replay path) keep working. New consumers should read the
 * SessionEvent stream directly.
 */
function applyToParts(events: SessionEvent[], parts: PlatformPart[]): void {
  for (const e of events) {
    if (e.type === "assistant_text") {
      parts.push({ id: e.part_id, type: "text", text: e.text });
    } else if (e.type === "thinking") {
      parts.push({ id: e.part_id, type: "thinking", text: e.text });
    } else if (e.type === "tool_call") {
      parts.push({
        id: e.part_id,
        type: "tool",
        tool: e.tool,
        callID: e.call_id,
        state: { input: e.input, status: "running" },
      });
    } else if (e.type === "tool_result") {
      const match = parts.find(
        (p) => p.type === "tool" && (p as { callID?: string }).callID === e.call_id,
      );
      if (!match) continue;
      const state = (match as unknown as { state: Record<string, unknown> })
        .state;
      state.status = e.is_error ? "error" : "completed";
      state.output = e.output;
      if (e.is_error) state.error = e.output;
    }
  }
}

export async function runTurn(
  s: RunTurnSession,
  userText: string,
  modelId: string,
  cfg: RunTurnConfig,
  emit: (event: SessionEvent) => void,
): Promise<PlatformMessage> {
  const startedAt = Date.now();
  const ac = new AbortController();
  s.abortController = ac;

  // Record the user prompt as the first SessionEvent of the turn.
  emit({ event_id: newEventId(), type: "user_message", text: userText });
  const userMessage: PlatformMessage = {
    info: {
      id: `user_${randomUUID()}`,
      role: "user",
      time: { created: startedAt, completed: startedAt },
    },
    parts: [{ type: "text", text: userText }],
  };
  s.history.push(userMessage);

  const options: Options = {
    cwd: cfg.repoDir,
    model: modelId,
    systemPrompt: (s.system_prompt || cfg.systemPrompt) || undefined,
    permissionMode: "bypassPermissions",
    abortController: ac,
    includePartialMessages: true,
    ...(cfg.claudeBin ? { pathToClaudeCodeExecutable: cfg.claudeBin } : {}),
    ...(cfg.memoryMcp
      ? {
          mcpServers: { "lap-memory": cfg.memoryMcp },
          allowedTools: [...MEMORY_TOOL_NAMES],
        }
      : {}),
    ...(s.sdk_session_id ? { resume: s.sdk_session_id } : {}),
  };

  const assistantMessageId = `msg_${randomUUID()}`;
  const parts: PlatformPart[] = [];
  const ctx: ClaudeTranslationContext = {
    messageId: assistantMessageId,
    turn: newTurnState(),
    meta: {} as TurnMetaSink,
  };
  let lastError: { name: string; data: { message: string } } | undefined;

  try {
    const stream = query({ prompt: userText, options });

    for await (const m of stream as AsyncIterable<SDKMessage>) {
      const events = TRANSLATOR.translate(m, ctx);
      if (ctx.meta.sdk_session_id && !s.sdk_session_id) {
        s.sdk_session_id = ctx.meta.sdk_session_id;
      }
      if (ctx.meta.error) {
        lastError = {
          name: ctx.meta.error.name,
          data: { message: ctx.meta.error.message },
        };
      }
      applyToParts(events, parts);
      for (const ev of events) emit(ev);
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
    emit({ event_id: newEventId(), type: "error", message: lastError.data.message });
  } finally {
    s.abortController = null;
  }

  const completedAt = Date.now();
  const usage = ctx.meta.usage
    ? {
        input: ctx.meta.usage.input,
        output: ctx.meta.usage.output,
        cache: {
          read: ctx.meta.usage.cache_read,
          write: ctx.meta.usage.cache_write,
        },
      }
    : undefined;
  const assistant: PlatformMessage = {
    info: {
      id: assistantMessageId,
      role: "assistant",
      time: { created: startedAt, completed: completedAt },
      tokens: usage,
      cost: ctx.meta.cost_usd,
      ...(lastError ? { error: lastError } : {}),
    },
    parts,
  };
  s.history.push(assistant);

  emit({
    event_id: newEventId(),
    type: "status",
    status: "ready",
    detail: "idle",
  });

  return assistant;
}
