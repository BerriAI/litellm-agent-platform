/**
 * Linear integration.
 *
 * Wires together the four sibling modules:
 *   - oauth.ts    — install via Linear OAuth (`actor=app`)
 *   - webhook.ts  — verify + parse AgentSessionEvent
 *   - activity.ts — agentActivityCreate on outbound SessionEvent
 *   - prompt.ts   — issue → harness prompt
 *
 * No env vars. The operator creates a Linear OAuth app, pastes its
 * credentials into the agent's Integrations panel, and the platform stores
 * them encrypted at rest in `agent_integration_config`. Every per-agent
 * OAuth dance + webhook uses those credentials.
 */

import type { Integration } from "../../core/types";
import { buildOAuthAdapter, SCOPES } from "./oauth";
import { buildWebhookAdapter } from "./webhook";
import { postActivity } from "./activity";

const integration: Integration = {
  id: "linear",
  displayName: "Linear",
  icon: "/integrations/linear.svg",
  docsUrl: "https://linear.app/developers/agents",
  appCreateUrl: "https://linear.app/settings/api/applications/new",
  scopes: SCOPES,

  oauth: buildOAuthAdapter(),
  webhook: buildWebhookAdapter(),

  async onSessionEvent(ctx) {
    await postActivity(integration, ctx);
  },
};

export default integration;
