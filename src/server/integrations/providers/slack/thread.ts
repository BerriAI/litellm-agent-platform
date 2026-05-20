/**
 * Slack thread backfill.
 *
 * When the bot is @-mentioned inside an existing thread, Slack's event payload
 * carries only the mention message — never the conversation it lives in. To give
 * the agent the context a human reading the thread would have, we call
 * `conversations.replies` with the bot token (the same xoxb- token files.ts uses
 * for downloads) and render the earlier messages into a compact transcript.
 *
 * Bot scopes required: `channels:history` (public channels), `groups:history`
 * (private channels), `mpim:history` (group DMs), `im:history` (1:1 DMs).
 * Reflected in the manifest in `./index.ts` and the OAuth scope list in
 * `./oauth.ts`.
 *
 * Best-effort: any failure (missing scope, not_in_channel, rate limit, network)
 * is logged and returns null, so the caller falls back to just the mention text
 * — strictly no worse than before this existed.
 */
import { fetch } from "undici";
import type { IntegrationInstall } from "@prisma/client";
import { decrypt } from "../../core/crypto";

const REPLIES_URL = "https://slack.com/api/conversations.replies";

/** Slack's per-call page size for replies. One page is ample context. */
const MAX_REPLIES = 50;

/** Hard cap on the rendered transcript. Oldest lines are dropped first so the
 *  messages closest to the @mention survive the budget. */
const MAX_TRANSCRIPT_CHARS = 6000;

interface SlackReplyMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackRepliesResponse {
  ok: boolean;
  error?: string;
  messages?: SlackReplyMessage[];
}

/**
 * Render filtered messages (oldest→newest) into a `<@U…>: text` transcript.
 * Returns null when nothing renders. Trims oldest lines first when over budget,
 * prefixing a marker so the agent knows the thread was longer.
 */
function renderTranscript(messages: SlackReplyMessage[]): string | null {
  const lines = messages
    .map((m) => {
      const text = m.text?.trim();
      if (!text) return null;
      const who = m.user ? `<@${m.user}>` : "someone";
      return `${who}: ${text}`;
    })
    .filter((line): line is string => line !== null);

  if (lines.length === 0) return null;

  if (lines.join("\n").length <= MAX_TRANSCRIPT_CHARS) {
    return lines.join("\n");
  }
  // Over budget: drop oldest lines first, then hard-truncate in case a single
  // remaining message still exceeds the cap on its own.
  while (lines.length > 1 && lines.join("\n").length > MAX_TRANSCRIPT_CHARS) {
    lines.shift();
  }
  let body = lines.join("\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) {
    body = body.slice(0, MAX_TRANSCRIPT_CHARS) + "…";
  }
  return "… earlier messages omitted …\n" + body;
}

export async function fetchThreadHistory(
  channel: string,
  thread_ts: string,
  install: IntegrationInstall,
  excludeTs?: string,
): Promise<string | null> {
  const url = new URL(REPLIES_URL);
  url.searchParams.set("channel", channel);
  url.searchParams.set("ts", thread_ts);
  url.searchParams.set("limit", String(MAX_REPLIES));

  try {
    // decrypt can throw on a malformed/un-decryptable token — keep it inside
    // the try so the best-effort contract holds and parse() never 5xxes Slack.
    const token = decrypt(install.access_token);
    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[slack/thread] conversations.replies HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as SlackRepliesResponse;
    if (!json.ok || !Array.isArray(json.messages)) {
      console.warn(
        `[slack/thread] conversations.replies not ok: ${json.error ?? "no messages"}`,
      );
      return null;
    }
    // Drop the triggering message and any bot / system messages so the agent
    // reads the human conversation, not its own acks or channel-join notices.
    const prior = json.messages.filter(
      (m) =>
        m.ts !== excludeTs &&
        !m.bot_id &&
        !m.subtype &&
        typeof m.text === "string",
    );
    return renderTranscript(prior);
  } catch (err) {
    console.warn(
      `[slack/thread] fetch error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
