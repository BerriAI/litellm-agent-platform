/**
 * Slack outbound — SessionEvent → chat.postMessage / chat.update.
 *
 * Mapped event types:
 *   thought  -> small italic "_picking up…_" footer in the same thread
 *   action   -> ignored in v1 (would be a lot of noise in Slack)
 *   elicit   -> posted as plain text (the agent is asking the user something)
 *   response -> the agent's final reply, posted as plain text in the thread
 *   error    -> posted as a ":warning: ..." line
 *
 * Thread placement: `external_session_id` is shaped as
 *   slack:{team_id}:{channel_id}              (DMs)
 *   slack:{team_id}:{channel_id}:{thread_ts}  (channel @mentions)
 * The decoder pulls channel + thread_ts out so every reply lands in the
 * same Slack thread the user started.
 *
 * Token: the bot token (xoxb-...) lives encrypted in IntegrationInstall.
 * `core/oauth.getAccessToken` decrypts it on demand; Slack bot tokens don't
 * expire so the refresh branch is never exercised.
 */

import { fetch } from "undici";
import { getAccessToken } from "../../core/oauth";
import type {
  Integration,
  SessionEvent,
  SessionEventContext,
} from "../../core/types";

const POST_URL = "https://slack.com/api/chat.postMessage";

interface SlackPostResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

interface DecodedKey {
  team_id: string;
  channel: string;
  /** Undefined for DMs (no thread); set for channel @mentions. */
  thread_ts?: string;
}

/**
 * Parse `external_session_id` back into the Slack coordinates we need to
 * call chat.postMessage. Returns null for unparseable keys (shouldn't
 * happen unless someone hand-edits the DB row).
 */
function decodeKey(external_session_id: string): DecodedKey | null {
  if (!external_session_id.startsWith("slack:")) return null;
  const parts = external_session_id.slice("slack:".length).split(":");
  if (parts.length < 2) return null;
  const [team_id, channel, thread_ts] = parts;
  if (!team_id || !channel) return null;
  return { team_id, channel, thread_ts };
}

function bodyFor(event: SessionEvent): string | null {
  switch (event.type) {
    case "thought":
      // Render as italicized note so it visually separates from real replies.
      return `_${event.body}_`;
    case "response":
      return event.body;
    case "elicit":
      return event.body;
    case "error":
      return `:warning: ${event.body}`;
    case "action":
      // Hide raw tool calls in v1 — they create huge walls of text in Slack.
      // Surface them later behind a "verbose" channel-level setting.
      return null;
  }
}

export async function postActivity(
  integration: Integration,
  ctx: SessionEventContext,
): Promise<void> {
  const decoded = decodeKey(ctx.externalSessionId);
  if (!decoded) {
    console.warn(
      `[slack] cannot decode external_session_id="${ctx.externalSessionId}"`,
    );
    return;
  }

  const body = bodyFor(ctx.event);
  if (body === null) return;

  const accessToken = await getAccessToken(ctx.install.install_id, integration);

  const payload: Record<string, unknown> = {
    channel: decoded.channel,
    text: body,
  };
  if (decoded.thread_ts) {
    payload.thread_ts = decoded.thread_ts;
  }

  const res = await fetch(POST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      `Slack chat.postMessage HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as SlackPostResponse;
  if (!json.ok) {
    throw new Error(
      `Slack chat.postMessage not ok: ${json.error ?? JSON.stringify(json)}`,
    );
  }
}
