/**
 * Generic OAuth flow for the integrations subsystem.
 *
 * Per-agent model: every OAuth dance is scoped to a specific (agent_id,
 * integration_id). The agent's `AgentIntegrationConfig` holds the client_id
 * + client_secret the operator pasted in the UI; this file decrypts them on
 * the fly and threads them into the provider's adapter calls.
 *
 * The flow:
 *   1. UI hits `/api/integrations/oauth/{id}/{agent_id}/authorize` →
 *      `startOAuth(...)` → 302 to the provider's authorize URL with a CSRF
 *      `state` we minted that's bound to the (agent_id, integration_id).
 *   2. Provider redirects back to the matching `/callback` route →
 *      `completeOAuth(...)` validates state, exchanges the code, fetches
 *      install metadata, upserts an `IntegrationInstall` row with the tokens
 *      encrypted at rest.
 *
 * The state store is an in-process Map with a 10-minute TTL. Fine for a
 * single LAP instance; multi-instance needs a shared store.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db";
import { encryptToken, decryptToken } from "./crypto";
import type { Integration } from "./types";

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_BUFFER_MS = 5 * 60_000;

interface StateEntry {
  integrationId: string;
  agentId: string;
  redirectUri: string;
  expiresAt: number;
}

const stateStore = new Map<string, StateEntry>();

function sweepExpiredStates(now: number): void {
  for (const [k, v] of stateStore) {
    if (v.expiresAt < now) stateStore.delete(k);
  }
}

/**
 * Resolve the per-agent OAuth config and mint a CSRF state. Returns the
 * provider's authorize URL. Throws if no config row exists for the agent.
 */
export async function startOAuth(
  integration: Integration,
  agentId: string,
  redirectUri: string,
): Promise<string> {
  const config = await prisma.agentIntegrationConfig.findUnique({
    where: {
      agent_id_integration_id: {
        agent_id: agentId,
        integration_id: integration.id,
      },
    },
  });
  if (!config) {
    throw new Error(
      `Agent ${agentId} has no ${integration.id} integration configured. ` +
        "Save credentials before starting the OAuth flow.",
    );
  }
  if (!config.enabled) {
    throw new Error(
      `Agent ${agentId}'s ${integration.id} integration is disabled.`,
    );
  }

  const state = randomBytes(16).toString("hex");
  const now = Date.now();
  sweepExpiredStates(now);
  stateStore.set(state, {
    integrationId: integration.id,
    agentId,
    redirectUri,
    expiresAt: now + STATE_TTL_MS,
  });

  return integration.oauth.authorizeUrl({
    state,
    redirectUri,
    clientId: config.client_id,
  });
}

export interface CompleteOAuthInput {
  integration: Integration;
  code: string;
  state: string;
  createdBy?: string | null;
}

export interface CompleteOAuthResult {
  install_id: string;
  agent_id: string;
  workspace_name: string;
}

/**
 * Validate the OAuth callback: state must match a recent mint for this
 * (agent, integration), exchange the code, fetch metadata, upsert the install
 * row. Throws on state mismatch / expiry / config-missing.
 */
export async function completeOAuth(
  input: CompleteOAuthInput,
): Promise<CompleteOAuthResult> {
  const stored = stateStore.get(input.state);
  stateStore.delete(input.state);
  const now = Date.now();
  if (!stored) throw new Error("OAuth state not found");
  if (stored.expiresAt < now) throw new Error("OAuth state expired");
  if (stored.integrationId !== input.integration.id) {
    throw new Error("OAuth state belongs to a different integration");
  }

  const config = await prisma.agentIntegrationConfig.findUnique({
    where: {
      agent_id_integration_id: {
        agent_id: stored.agentId,
        integration_id: input.integration.id,
      },
    },
  });
  if (!config) throw new Error("Agent integration config disappeared mid-flow");

  const clientSecret = decryptToken(config.client_secret_enc);
  const token = await input.integration.oauth.exchange({
    code: input.code,
    redirectUri: stored.redirectUri,
    clientId: config.client_id,
    clientSecret,
  });
  const meta = await input.integration.oauth.fetchInstallMetadata(
    token.access_token,
  );

  const expiresAt =
    typeof token.expires_in === "number"
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;
  const encryptedAccess = encryptToken(token.access_token);
  const encryptedRefresh = token.refresh_token
    ? encryptToken(token.refresh_token)
    : null;

  const install = await prisma.integrationInstall.upsert({
    where: {
      agent_id_integration_id_workspace_id: {
        agent_id: stored.agentId,
        integration_id: input.integration.id,
        workspace_id: meta.workspace_id,
      },
    },
    update: {
      access_token: encryptedAccess,
      refresh_token: encryptedRefresh,
      expires_at: expiresAt,
      metadata: (meta.metadata ?? {}) as object,
      workspace_name: meta.workspace_name,
    },
    create: {
      agent_id: stored.agentId,
      integration_id: input.integration.id,
      workspace_id: meta.workspace_id,
      workspace_name: meta.workspace_name,
      access_token: encryptedAccess,
      refresh_token: encryptedRefresh,
      expires_at: expiresAt,
      metadata: (meta.metadata ?? {}) as object,
      created_by: input.createdBy ?? null,
    },
  });

  return {
    install_id: install.install_id,
    agent_id: install.agent_id,
    workspace_name: install.workspace_name,
  };
}

/**
 * Get a usable access token for an install. Transparently refreshes if the
 * stored token is within `REFRESH_BUFFER_MS` of expiry and the provider
 * supports refresh.
 */
export async function getAccessToken(
  install_id: string,
  integration: Integration,
): Promise<string> {
  const install = await prisma.integrationInstall.findUniqueOrThrow({
    where: { install_id },
    include: { config: true },
  });

  const expires = install.expires_at?.getTime();
  const needsRefresh =
    typeof expires === "number" && expires - Date.now() < REFRESH_BUFFER_MS;

  if (
    needsRefresh &&
    integration.oauth.refresh &&
    install.refresh_token !== null
  ) {
    const clientSecret = decryptToken(install.config.client_secret_enc);
    const refreshed = await integration.oauth.refresh({
      refreshToken: decryptToken(install.refresh_token),
      clientId: install.config.client_id,
      clientSecret,
    });
    const newExpires =
      typeof refreshed.expires_in === "number"
        ? new Date(Date.now() + refreshed.expires_in * 1000)
        : null;
    await prisma.integrationInstall.update({
      where: { install_id },
      data: {
        access_token: encryptToken(refreshed.access_token),
        refresh_token: refreshed.refresh_token
          ? encryptToken(refreshed.refresh_token)
          : install.refresh_token,
        expires_at: newExpires,
      },
    });
    return refreshed.access_token;
  }

  return decryptToken(install.access_token);
}
