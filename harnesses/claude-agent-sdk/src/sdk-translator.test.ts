/**
 * Unit tests for ClaudeSdkTranslator. Feeds synthetic SDK frames and
 * asserts the returned SessionEvents. No real SDK, no network.
 */

import { describe, expect, it } from "vitest";
import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  ClaudeSdkTranslator,
  newTurnState,
  type ClaudeTranslationContext,
  type TurnMetaSink,
} from "./sdk-translator.js";

function setup(): { tx: ClaudeSdkTranslator; ctx: ClaudeTranslationContext } {
  return {
    tx: new ClaudeSdkTranslator(),
    ctx: {
      messageId: "msg_X",
      turn: newTurnState(),
      meta: {} as TurnMetaSink,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = (raw: any): SDKMessage => raw as SDKMessage;

describe("ClaudeSdkTranslator", () => {
  it("assistant text block -> assistant_text SessionEvent", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({
        type: "assistant",
        message: {
          id: "sdk_msg_1",
          content: [{ type: "text", text: "hello world" }],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "assistant_text",
      message_id: "msg_X",
      part_id: "msg_X_b0",
      text: "hello world",
    });
    expect((events[0] as { event_id: string }).event_id).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
  });

  it("thinking block -> thinking SessionEvent", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({
        type: "assistant",
        message: {
          id: "sdk_msg_t",
          content: [{ type: "thinking", thinking: "let me think..." }],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thinking",
      text: "let me think...",
    });
  });

  it("tool_use block -> tool_call SessionEvent", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({
        type: "assistant",
        message: {
          id: "sdk_msg_u",
          content: [
            {
              type: "tool_use",
              id: "toolu_abc",
              name: "Read",
              input: { file: "x.txt" },
            },
          ],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_call",
      message_id: "msg_X",
      part_id: "msg_X_b0",
      call_id: "toolu_abc",
      tool: "Read",
      input: { file: "x.txt" },
    });
  });

  it("tool_result user message -> tool_result SessionEvent", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_xyz",
              content: [{ type: "text", text: "file contents" }],
              is_error: false,
            },
          ],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_result",
      call_id: "toolu_xyz",
      output: "file contents",
      is_error: false,
    });
  });

  it("tool_result with is_error: true sets is_error flag", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_err",
              content: "boom",
              is_error: true,
            },
          ],
        },
      }),
      ctx,
    );
    expect(events[0]).toMatchObject({
      type: "tool_result",
      is_error: true,
      output: "boom",
    });
  });

  it("stream_event delta is dropped (deltas not persisted)", () => {
    const { tx, ctx } = setup();
    // Bootstrap turn state.
    tx.translate(
      m({
        type: "stream_event",
        event: { type: "message_start", message: { id: "sdk_msg_s" } },
      }),
      ctx,
    );
    tx.translate(
      m({
        type: "stream_event",
        event: { type: "content_block_start", index: 0 },
      }),
      ctx,
    );
    // The actual delta.
    const events = tx.translate(
      m({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        },
      }),
      ctx,
    );
    expect(events).toEqual([]);
    // But the turn state still advanced so later assistant events resolve.
    expect(ctx.turn.currentSdkMsgId).toBe("sdk_msg_s");
    expect(ctx.turn.nextGlobalIdx).toBe(1);
  });

  it("system init -> status:ready + records sdk_session_id in meta", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({ type: "system", subtype: "init", session_id: "sdk-sess-42" }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "status", status: "ready" });
    expect(ctx.meta.sdk_session_id).toBe("sdk-sess-42");
  });

  it("result frame -> turn_complete (+ error if is_error)", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({
        type: "result",
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        is_error: false,
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn_complete",
      cost_usd: 0.0123,
      usage: { input: 100, output: 50, cache_read: 10, cache_write: 5 },
    });
    expect(ctx.meta.cost_usd).toBe(0.0123);
  });

  it("result frame with is_error: true also emits error event", () => {
    const { tx, ctx } = setup();
    const events = tx.translate(
      m({
        type: "result",
        is_error: true,
        result: "model exploded",
      }),
      ctx,
    );
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("turn_complete");
    expect(events[1]).toMatchObject({ type: "error", message: "model exploded" });
    expect(ctx.meta.error?.message).toBe("model exploded");
  });
});
