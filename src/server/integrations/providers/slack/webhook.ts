/**
 * Slack Events API webhook verification + parsing.
 *
 * Slack signs every event POST with HMAC-SHA256 over
 *   "v0:" + X-Slack-Request-Timestamp + ":" + rawBody
 * using the app's signing secret. The signature is sent as `v0={hex}` in the
 * `X-Slack-Signature` header. The timestamp is also checked to be within 5
 * minutes of now to defeat replay attacks.
 *
 * Events we care about:
 *   - `app_mention` — the bot was @-mentioned in a channel
 *   - `message`     — only when `channel_type === "im"` (a DM to the bot)
 *
 * Everything else is `{ kind: "ignore" }` so the dispatcher 204s out.
 *
 * Self-echo dedup: Slack also fires `message` for the bot's own
 * `chat.postMessage`. We ignore any event whose `bot_id` is set OR whose
 * `user` matches the stored `bot_user_id` in IntegrationInstall.metadata.
 *
 * Conversation key (used as `external_session_id`):
 *   - DMs:     "slack:{team_id}:{channel_id}"
 *              All DMs in the same DM channel belong to one LAP session.
 *   - Channel: "slack:{team_id}:{channel_id}:{thread_ts}"
 *              One LAP session per thread. A top-level @mention starts a
 *              fresh thread (Slack auto-assigns thread_ts = event_ts).
 *
 * The dispatcher's `message` kind handler resolves "first contact" vs
 * "follow-up" by looking up IntegrationSession existence — we don't have to
 * decide here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IntegrationInstall } from "@prisma/client";
import type {
  IntegrationEvent,
  WebhookAdapter,
} from "../../core/types";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";
const MAX_SKEW_SEC = 5 * 60;

interface SlackEventEnvelope {
  type?: string; // "event_callback" | "url_verification"
  team_id?: string;
  api_app_id?: string;
  event?: SlackEvent;
  authorizations?: Array<{ team_id?: string; user_id?: string }>;
}

interface SlackEvent {
  type?: string; // "app_mention" | "message"
  subtype?: string; // "bot_message" / "message_changed" / ...
  channel?: string;
  channel_type?: string; // "im" for DMs, "channel" for channels
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

function getSigningSecret(): string | null {
  return process.env.SLACK_SIGNING_SECRET ?? null;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}

function stripMentions(text: string | undefined): string {
  if (!text) return "";
  // Slack mentions look like <@U123ABC>; strip them so the prompt the harness
  // sees doesn't get distracted by the bot's own user id.
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function conversationKey(
  team_id: string,
  channel: string,
  channel_type: string | undefined,
  thread_ts: string | undefined,
  event_ts: string | undefined,
): string {
  // DMs collapse into one session per channel. Channel @mentions thread.
  if (channel_type === "im") {
    return `slack:${team_id}:${channel}`;
  }
  const ts = thread_ts ?? event_ts ?? "0";
  return `slack:${team_id}:${channel}:${ts}`;
}

export function buildWebhookAdapter(): WebhookAdapter {
  return {
    workspaceIdFromPayload(payload: unknown): string | null {
      const env = payload as SlackEventEnvelope;
      return typeof env?.team_id === "string" ? env.team_id : null;
    },

    verify(rawBody, headers, _install): boolean {
      const secret = getSigningSecret();
      if (!secret) return false;

      const sig = headers.get(SIG_HEADER);
      const ts = headers.get(TS_HEADER);
      if (!sig || !ts) return false;

      // Replay protection: reject anything older than 5 minutes.
      const tsNum = Number.parseInt(ts, 10);
      if (!Number.isFinite(tsNum)) return false;
      const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
      if (skew > MAX_SKEW_SEC) return false;

      const base = `v0:${ts}:${rawBody.toString("utf8")}`;
      const expected =
        "v0=" + createHmac("sha256", secret).update(base).digest("hex");
      return safeEqualHex(sig, expected);
    },

    parse(payload, install: IntegrationInstall): IntegrationEvent {
      const env = payload as SlackEventEnvelope;
      if (env?.type !== "event_callback") return { kind: "ignore" };

      const e = env.event;
      if (!e) return { kind: "ignore" };

      // Self-echo dedup: drop any message produced by a bot (any bot — Slack
      // sets `bot_id` for bot-produced messages) AND any message whose author
      // is *this* bot user.
      if (e.bot_id) return { kind: "ignore" };
      const botUserId = (install.metadata as Record<string, unknown> | null)
        ?.bot_user_id;
      if (
        typeof botUserId === "string" &&
        typeof e.user === "string" &&
        e.user === botUserId
      ) {
        return { kind: "ignore" };
      }

      // Skip edits / deletes / channel-join / bot_message / etc. We only act
      // on a fresh user message.
      if (e.subtype) return { kind: "ignore" };

      // We handle two event types.
      const isAppMention = e.type === "app_mention";
      const isDM = e.type === "message" && e.channel_type === "im";
      if (!isAppMention && !isDM) return { kind: "ignore" };

      const channel = e.channel;
      const teamId = env.team_id;
      if (!channel || !teamId) return { kind: "ignore" };

      const text = stripMentions(e.text);
      if (!text) return { kind: "ignore" };

      const externalSessionId = conversationKey(
        teamId,
        channel,
        e.channel_type,
        e.thread_ts,
        e.ts,
      );

      return {
        kind: "message",
        external_session_id: externalSessionId,
        prompt: text,
      };
    },
  };
}
