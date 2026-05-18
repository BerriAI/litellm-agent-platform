/**
 * Slack OAuth v2 specifics.
 *
 * Build the authorize URL, exchange the code via `oauth.v2.access`, capture
 * the team id + name and the bot's own user id (used by the webhook to dedup
 * the bot's own messages echoing back as events).
 *
 * Docs: https://api.slack.com/authentication/oauth-v2
 *
 * Token model: Slack bot tokens (xoxb-) don't expire and don't refresh. No
 * `refresh` adapter — `core/oauth.getAccessToken` will just return the
 * stored token without ever rotating it.
 */

import { fetch } from "undici";
import type {
  InstallMetadata,
  OAuthAdapter,
  TokenResponse,
} from "../../core/types";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const TOKEN_URL = "https://slack.com/api/oauth.v2.access";

/**
 * Bot scopes for "DM the bot or @-mention it in a channel, get a reply".
 * Keep this list minimal — every scope is one more checkbox on the consent
 * screen. Add scopes only when the corresponding event/api call is wired.
 */
const SCOPES = [
  "app_mentions:read", // receive app_mention events
  "chat:write", // post replies via chat.postMessage
  "im:history", // read DM messages directed at the bot
  "im:read", // know which channels are DMs
  "im:write", // open DM conversations (not strictly required for v1, kept for parity)
];

interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  access_token?: string; // bot token, xoxb-...
  token_type?: string; // "bot"
  bot_user_id?: string; // the bot's user id in this workspace
  app_id?: string;
  team?: { id?: string; name?: string };
}

export function buildOAuthAdapter(): OAuthAdapter {
  return {
    scopes: SCOPES,

    authorizeUrl({ state, redirectUri }) {
      const clientId = process.env.SLACK_CLIENT_ID;
      if (!clientId) {
        // enabled() should have prevented this; throw loudly if not.
        throw new Error("SLACK_CLIENT_ID is not set");
      }
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", SCOPES.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchange({ code, redirectUri }): Promise<TokenResponse> {
      const clientId = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error("SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not set");
      }
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      if (!res.ok) {
        throw new Error(
          `Slack oauth.v2.access HTTP ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as SlackOAuthV2Response;
      if (!json.ok || !json.access_token) {
        throw new Error(
          `Slack oauth.v2.access not ok: ${json.error ?? JSON.stringify(json)}`,
        );
      }
      // Slack bot tokens don't expire. Stash bot_user_id + team in metadata
      // via fetchInstallMetadata below — but the exchange response already
      // carries everything we need, so we cache it on a module-local map
      // keyed by access_token. This avoids a second Slack API round trip.
      cachedExchangeMeta.set(json.access_token, {
        team_id: json.team?.id ?? "",
        team_name: json.team?.name ?? "",
        bot_user_id: json.bot_user_id ?? "",
        app_id: json.app_id ?? "",
      });
      return { access_token: json.access_token };
    },

    async fetchInstallMetadata(
      accessToken: string,
    ): Promise<InstallMetadata> {
      // Prefer the values stashed by `exchange` (same request, no second API
      // call). Fall back to auth.test for the rare case where this is called
      // independently (e.g. re-fetching metadata).
      const cached = cachedExchangeMeta.get(accessToken);
      cachedExchangeMeta.delete(accessToken);
      if (cached && cached.team_id && cached.bot_user_id) {
        return {
          workspace_id: cached.team_id,
          workspace_name: cached.team_name || cached.team_id,
          metadata: {
            bot_user_id: cached.bot_user_id,
            app_id: cached.app_id,
          },
        };
      }

      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        throw new Error(
          `Slack auth.test HTTP ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        team?: string;
        team_id?: string;
        user_id?: string; // for a bot token, this is the bot_user_id
      };
      if (!json.ok || !json.team_id || !json.user_id) {
        throw new Error(
          `Slack auth.test not ok: ${json.error ?? JSON.stringify(json)}`,
        );
      }
      return {
        workspace_id: json.team_id,
        workspace_name: json.team ?? json.team_id,
        metadata: { bot_user_id: json.user_id },
      };
    },
  };
}

/**
 * One-shot stash for the `oauth.v2.access` response so `fetchInstallMetadata`
 * doesn't have to re-fetch the same info via `auth.test`. The entry is
 * deleted on first read. Sized in practice by concurrent installs, which
 * is ~zero — but a sweep guards against leaks if `fetchInstallMetadata` is
 * ever skipped.
 */
const cachedExchangeMeta = new Map<
  string,
  {
    team_id: string;
    team_name: string;
    bot_user_id: string;
    app_id: string;
  }
>();
