/**
 * Claude-Agent-SDK event translator.
 *
 * Concrete subclass of `SessionEventTranslator` (from @lap/harness-shared).
 * Converts raw SDK events into the platform-canonical `SessionEvent` union
 * — once, here, inside the harness. The /event SSE then emits SessionEvent
 * JSON directly; the platform persister never re-translates.
 *
 * To add another harness (e.g. an OpenAI Agents one), subclass
 * SessionEventTranslator in that harness's package with its own SDK event
 * type. The shape on the wire stays identical.
 */

import { randomUUID } from "node:crypto";

import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  SessionEventTranslator,
  type SessionEvent,
  type TranslationContext,
} from "@lap/harness-shared/session-event";

// Every SessionEvent we emit gets a stable UUID. The DB has UNIQUE
// (session_id, event_id) so re-delivery from a flapping subscriber, an
// SDK retry, or a worker scan-loop attaching a second subscriber all
// collapse to one row via ON CONFLICT DO NOTHING.
function newEventId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Per-turn context the harness threads through translate() calls.
// ---------------------------------------------------------------------------

/**
 * Stable id assigned by the harness to each user→assistant turn. Used to
 * key `message_id` / `part_id` so a refreshing UI client can correlate
 * coarse snapshots without back-tracking to the SDK's internal ids.
 */
export interface ClaudeTranslationContext extends TranslationContext {
  messageId: string;
  turn: TurnStreamState;
  /**
   * Out-channel for non-event metadata (SDK session id discovered on
   * `system init`, final cost/usage from the SDK `result` frame, terminal
   * errors). The harness server reads these after each translate() call
   * and threads them into Session state.
   */
  meta: TurnMetaSink;
}

export interface TurnStreamState {
  /** Next part-id to allocate this turn. Increments per content block. */
  nextGlobalIdx: number;
  /** Most recent SDK assistant message id seen on the stream. */
  currentSdkMsgId: string | null;
  /** For each SDK message id, the globalIdxs of its content blocks. */
  blockIdxsBySdkMsgId: Map<string, number[]>;
}

export interface TurnMetaSink {
  sdk_session_id?: string;
  cost_usd?: number;
  usage?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  error?: { name: string; message: string };
}

export function newTurnState(): TurnStreamState {
  return {
    nextGlobalIdx: 0,
    currentSdkMsgId: null,
    blockIdxsBySdkMsgId: new Map(),
  };
}

// ---------------------------------------------------------------------------
// The central translator class
// ---------------------------------------------------------------------------

export class ClaudeSdkTranslator extends SessionEventTranslator<
  SDKMessage,
  ClaudeTranslationContext
> {
  translate(m: SDKMessage, ctx: ClaudeTranslationContext): SessionEvent[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = m as any;

    if (process.env.HARNESS_DEBUG) this.debugLog(ev);

    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      ctx.meta.sdk_session_id = ev.session_id;
      return [{ event_id: newEventId(), type: "status", status: "ready" }];
    }

    if (ev.type === "assistant" && ev.message) {
      return this.translateAssistant(ev, ctx);
    }

    if (ev.type === "user" && ev.message) {
      return this.translateToolResults(ev);
    }

    if (ev.type === "result") {
      return this.translateResult(ev, ctx);
    }

    if (ev.type === "stream_event") {
      // Maintains turn block-index state so later `assistant` events
      // resolve to stable part_ids — but emits nothing itself. Token-level
      // deltas are intentionally not part of the persisted SessionEvent
      // log; UIs that want token-stream animation can subscribe to a
      // future ephemeral channel.
      this.updateTurnState(ev, ctx.turn);
      return [];
    }

    return [];
  }

  // -------------------------------------------------------------------------

  private translateAssistant(
    ev: { message: { id?: string; content?: unknown[] } },
    ctx: ClaudeTranslationContext,
  ): SessionEvent[] {
    const content = ev.message.content ?? [];
    const sdkMsgId = ev.message.id;
    const idxs =
      (sdkMsgId ? ctx.turn.blockIdxsBySdkMsgId.get(sdkMsgId) : undefined) ?? [];
    const out: SessionEvent[] = [];

    content.forEach((rawBlock, idx) => {
      const block = rawBlock as {
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        id?: string;
        input?: unknown;
      };
      const globalIdx = idxs[idx] ?? ctx.turn.nextGlobalIdx++;
      const part_id = `${ctx.messageId}_b${globalIdx}`;

      if (block.type === "text") {
        out.push({
          event_id: newEventId(),
          type: "assistant_text",
          message_id: ctx.messageId,
          part_id,
          text: block.text ?? "",
        });
      } else if (block.type === "thinking") {
        out.push({
          event_id: newEventId(),
          type: "thinking",
          message_id: ctx.messageId,
          part_id,
          text: block.thinking ?? "",
        });
      } else if (block.type === "tool_use") {
        out.push({
          event_id: newEventId(),
          type: "tool_call",
          message_id: ctx.messageId,
          part_id,
          call_id: block.id ?? "",
          tool: block.name ?? "",
          input: block.input,
        });
      }
    });

    return out;
  }

  private translateToolResults(ev: {
    message: { content?: unknown[] };
  }): SessionEvent[] {
    const out: SessionEvent[] = [];
    const content = ev.message.content ?? [];
    for (const rawBlock of content) {
      const block = rawBlock as {
        type: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (block.type !== "tool_result") continue;
      const output = Array.isArray(block.content)
        ? block.content
            .map((c: unknown) => {
              const cc = c as { type?: string; text?: string };
              return cc.type === "text" ? (cc.text ?? "") : "";
            })
            .join("")
        : typeof block.content === "string"
          ? block.content
          : "";
      out.push({
        event_id: newEventId(),
        type: "tool_result",
        call_id: block.tool_use_id ?? "",
        output,
        is_error: !!block.is_error,
      });
    }
    return out;
  }

  private translateResult(
    ev: {
      total_cost_usd?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      is_error?: boolean;
      result?: unknown;
    },
    ctx: ClaudeTranslationContext,
  ): SessionEvent[] {
    ctx.meta.cost_usd = ev.total_cost_usd;
    ctx.meta.usage = {
      input: ev.usage?.input_tokens,
      output: ev.usage?.output_tokens,
      cache_read: ev.usage?.cache_read_input_tokens,
      cache_write: ev.usage?.cache_creation_input_tokens,
    };

    const out: SessionEvent[] = [
      {
        event_id: newEventId(),
        type: "turn_complete",
        cost_usd: ev.total_cost_usd ?? null,
        usage: ctx.meta.usage,
      },
    ];

    if (ev.is_error) {
      const message = String(ev.result ?? "agent reported error");
      ctx.meta.error = { name: "ResultError", message };
      out.push({ event_id: newEventId(), type: "error", message });
    }
    return out;
  }

  private updateTurnState(
    ev: {
      event?: {
        type?: string;
        message?: { id?: string };
        index?: number;
      };
    },
    turn: TurnStreamState,
  ): void {
    const inner = ev.event;
    if (!inner) return;

    if (inner.type === "message_start" && inner.message?.id) {
      turn.currentSdkMsgId = inner.message.id;
      turn.blockIdxsBySdkMsgId.set(inner.message.id, []);
      return;
    }

    if (
      inner.type === "content_block_start" &&
      typeof inner.index === "number" &&
      turn.currentSdkMsgId
    ) {
      const arr = turn.blockIdxsBySdkMsgId.get(turn.currentSdkMsgId) ?? [];
      arr[inner.index] = turn.nextGlobalIdx++;
      turn.blockIdxsBySdkMsgId.set(turn.currentSdkMsgId, arr);
    }
  }

  private debugLog(ev: {
    type?: string;
    subtype?: string;
    message?: { content?: Array<{ type: string }> };
    event?: {
      type?: string;
      delta?: { type?: string };
      content_block?: { type?: string };
    };
  }): void {
    if (ev.type === "assistant" && ev.message?.content) {
      const blocks = ev.message.content.map((b) => b.type);
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
}
