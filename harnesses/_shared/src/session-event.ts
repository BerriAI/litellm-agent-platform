/**
 * SessionEvent — the unified, persisted, shared log format for the LAP.
 *
 * Every harness emits this shape directly on its /event SSE. The platform
 * deserializes without further translation and writes rows to the
 * managed_agent_session_event table. UI, public API, and any third-party
 * consumer (Slack, Linear, ...) read the same union — there is no second
 * translator layer outside the harness.
 *
 * To add a new harness:
 *   1. Subclass `SessionEventTranslator<YourSdkEventType>`
 *   2. Implement `translate(sdkEvent, ctx) -> SessionEvent[]`
 *   3. Have your harness server pipe each SDK event through the translator
 *      and write the resulting SessionEvents to the /event SSE stream.
 */

export type SessionStatusLike =
  | "creating"
  | "ready"
  | "failed"
  | "dead"
  | string;

export type SessionPhaseLike =
  | "creating_sandbox"
  | "pod_pending"
  | "pod_running"
  | "waiting_harness"
  | "harness_ready"
  | "cloning_repo"
  | "installing_deps"
  | string;

/**
 * Every persisted event carries a stable `event_id` UUID minted at the
 * harness emit site. The DB has a UNIQUE INDEX on (session_id, event_id),
 * so the second/third/Nth subscriber writing the same event no-ops via
 * ON CONFLICT DO NOTHING. Makes the pipeline idempotent end-to-end and
 * means a flapping subscriber can't double-write.
 */
interface EventBase {
  event_id: string;
}

export type SessionEvent =
  | (EventBase & {
      type: "assistant_text";
      message_id: string;
      part_id: string;
      text: string;
    })
  | (EventBase & {
      type: "thinking";
      message_id: string;
      part_id: string;
      text: string;
    })
  | (EventBase & {
      type: "tool_call";
      message_id: string;
      part_id: string;
      call_id: string;
      tool: string;
      input: unknown;
    })
  | (EventBase & {
      type: "tool_result";
      call_id: string;
      output: string;
      is_error: boolean;
    })
  | (EventBase & {
      type: "status";
      status: SessionStatusLike;
      detail?: string;
    })
  | (EventBase & {
      type: "phase";
      phase: SessionPhaseLike;
      detail?: string | null;
    })
  | (EventBase & { type: "user_message"; text: string })
  | (EventBase & {
      type: "turn_complete";
      cost_usd: number | null;
      usage: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
      } | null;
    })
  | (EventBase & { type: "error"; message: string });

/**
 * Translation context. Concrete translators tighten this generic with
 * whatever per-turn state they need (e.g. SDK block-index lookups for
 * streaming deltas).
 */
export interface TranslationContext {
  [key: string]: unknown;
}

/**
 * Central translator base class. One concrete subclass per harness.
 *
 * The platform never subclasses this — translation happens INSIDE the
 * harness pod, exactly once, before events hit the /event SSE wire.
 */
export abstract class SessionEventTranslator<
  SDKEvent,
  Ctx extends TranslationContext = TranslationContext,
> {
  /**
   * Convert one SDK event into zero or more SessionEvents.
   * Return [] to drop the event (e.g. token-level deltas, heartbeats,
   * internal handshake frames).
   */
  abstract translate(sdkEvent: SDKEvent, ctx: Ctx): SessionEvent[];
}
