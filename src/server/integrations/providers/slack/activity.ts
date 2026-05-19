/**
 * Slack outbound — SessionEvent → chat.postMessage / reactions.add.
 *
 * Mapped event types:
 *   thought  -> small italic "_picking up…_" footer in the same thread
 *   action   -> ignored in v1 (would be a lot of noise in Slack)
 *   elicit   -> posted as plain text (the agent is asking the user something)
 *   response -> the agent's final reply, posted as plain text in the thread
 *   error    -> posted as a ":warning: ..." line
 *   react    -> reactions.add against the inbound message (immediate ack)
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
import { mrkdwnFromMarkdown } from "./mrkdwn";
import type {
  Integration,
  SessionEvent,
  SessionEventContext,
} from "../../core/types";

const POST_URL = "https://slack.com/api/chat.postMessage";
const REACT_URL = "https://slack.com/api/reactions.add";

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

/**
 * Pull `externalUrls` off the SessionEvent variants that carry them
 * (`thought`, `response`). Returns undefined for variants without the
 * field so the caller can branch on truthiness.
 */
function externalUrlsFor(
  event: SessionEvent,
): { url: string; label: string }[] | undefined {
  if (event.type === "thought" || event.type === "response") {
    return event.externalUrls;
  }
  return undefined;
}

/**
 * Build a Block Kit `actions` block with a button per URL. We use buttons
 * instead of appending mrkdwn `<url|label>` suffixes so the link reads as a
 * tappable element in the Slack client (matches the UX of integrations
 * like Inspect / Linear's agent activity cards).
 */
function buttonBlock(urls: { url: string; label: string }[]): {
  type: "actions";
  elements: Array<{
    type: "button";
    text: { type: "plain_text"; text: string };
    url: string;
  }>;
} {
  return {
    type: "actions",
    elements: urls.map((u) => ({
      type: "button",
      text: { type: "plain_text", text: u.label },
      url: u.url,
    })),
  };
}

function bodyFor(event: SessionEvent): string | null {
  switch (event.type) {
    case "thought":
      // Render as italicized note so it visually separates from real replies.
      // The body itself is short / single-line in practice, so we skip the
      // markdown conversion — wrapping converted bold/italic inside another
      // `_..._` would produce confusing nested formatting.
      return `_${event.body}_`;
    case "response":
      return mrkdwnFromMarkdown(event.body);
    case "elicit":
      return mrkdwnFromMarkdown(event.body);
    case "error":
      return `:warning: ${mrkdwnFromMarkdown(event.body)}`;
    case "action":
      // Hide raw tool calls in v1 — they create huge walls of text in Slack.
      // Surface them later behind a "verbose" channel-level setting.
      return null;
    case "react":
      // Handled in postActivity via reactions.add, not chat.postMessage.
      return null;
  }
}

/**
 * Strip surrounding colons from emoji names — Slack's reactions.add API
 * expects the bare name (`eyes`), not the rendered form (`:eyes:`).
 */
function normalizeEmoji(emoji: string): string {
  return emoji.replace(/^:|:$/g, "");
}

/**
 * Post a `reactions.add` for "react" SessionEvents. Failures are logged but
 * never thrown — a reaction is a UX nicety, not a correctness signal, and
 * the only common failure (`already_reacted` on a retry) is harmless.
 */
async function postReaction(
  integration: Integration,
  ctx: SessionEventContext,
): Promise<void> {
  if (ctx.event.type !== "react") return;
  const decoded = decodeKey(ctx.externalSessionId);
  if (!decoded) return;

  // Anchor: use the event's explicit ts if provided (the inbound user
  // message), otherwise fall back to the thread root encoded in the
  // session key. The fallback gets close to the right behavior for the
  // first @mention in a thread but lands on the wrong message for
  // followups — providers should always set `event.anchor.ts` if they
  // can.
  const anchorTs = ctx.event.anchor?.ts ?? decoded.thread_ts;
  if (!anchorTs) return;

  const accessToken = await getAccessToken(ctx.install.install_id, integration);
  const res = await fetch(REACT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      channel: decoded.channel,
      timestamp: anchorTs,
      name: normalizeEmoji(ctx.event.emoji),
    }),
  });
  if (!res.ok) {
    console.warn(`[slack] reactions.add HTTP ${res.status}`);
    return;
  }
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok && json.error !== "already_reacted") {
    console.warn(`[slack] reactions.add not ok: ${json.error}`);
  }
}

export async function postActivity(
  integration: Integration,
  ctx: SessionEventContext,
): Promise<void> {
  if (ctx.event.type === "react") {
    await postReaction(integration, ctx);
    return;
  }

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
    // Keep `text` set even when we send `blocks` — Slack uses it for
    // notifications, accessibility, and the fallback rendering in clients
    // that don't support Block Kit.
    text: body,
  };
  const urls = externalUrlsFor(ctx.event);
  if (urls && urls.length > 0) {
    payload.blocks = [
      { type: "section", text: { type: "mrkdwn", text: body } },
      buttonBlock(urls),
    ];
  }
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
