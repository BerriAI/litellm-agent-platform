/**
 * Slack integration.
 *
 * Wires the four sibling modules into one Integration:
 *   - oauth.ts    — Slack OAuth v2 (bot token install)
 *   - webhook.ts  — verify signing-secret + parse event_callback
 *   - activity.ts — chat.postMessage on outbound SessionEvent
 *
 * `enabled()` returns false until the operator sets SLACK_CLIENT_ID,
 * SLACK_CLIENT_SECRET, and SLACK_SIGNING_SECRET. The registry skips
 * disabled integrations; their routes return 404.
 */

import type { Integration } from "../../core/types";
import { buildOAuthAdapter } from "./oauth";
import { buildWebhookAdapter } from "./webhook";
import { postActivity } from "./activity";

const integration: Integration = {
  id: "slack",
  displayName: "Slack",
  icon: "/integrations/slack.svg",
  docsUrl: "https://api.slack.com/start",

  enabled() {
    return Boolean(
      process.env.SLACK_CLIENT_ID &&
        process.env.SLACK_CLIENT_SECRET &&
        process.env.SLACK_SIGNING_SECRET,
    );
  },

  oauth: buildOAuthAdapter(),
  webhook: buildWebhookAdapter(),

  manifest(baseUrl) {
    // Strip any trailing slash so the substituted URLs don't end up with
    // a double `//` between host and path.
    const host = baseUrl.replace(/\/+$/, "");
    return {
      display_information: {
        name: "OPENCLAW",
        description:
          "Ask a Claude Code agent running on LiteLLM Agent Platform — directly in Slack.",
        background_color: "#0e0f12",
      },
      features: {
        bot_user: {
          display_name: "OPENCLAW",
          always_online: true,
        },
      },
      oauth_config: {
        redirect_urls: [
          `${host}/api/integrations/oauth/slack/callback`,
        ],
        scopes: {
          bot: [
            "app_mentions:read",
            "chat:write",
            "im:history",
            "im:read",
            "im:write",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: `${host}/api/integrations/webhooks/slack`,
          bot_events: ["app_mention", "message.im"],
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    };
  },

  async onSessionEvent(ctx) {
    await postActivity(integration, ctx);
  },
};

export default integration;
