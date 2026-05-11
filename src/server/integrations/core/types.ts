/**
 * Shared contract for the integrations subsystem.
 *
 * Every provider under `../providers/` implements `Integration`. The dispatcher
 * (`./dispatcher.ts`) and the dynamic Next.js routes
 * (`src/app/api/integrations/...`) only ever see this interface — they never
 * know about Linear, Slack, GitHub, or any specific medium.
 *
 * Per-agent model: OAuth app credentials live in `AgentIntegrationConfig`
 * (the operator pastes them in the agent's Integrations panel), so a single
 * LAP deployment can host N delegateable agents that each appear as a
 * distinct app-user in the medium. The provider receives the resolved
 * config via call context — it never reads `process.env` for credentials.
 */

import type { Agent, AgentIntegrationConfig, IntegrationInstall } from "@prisma/client";

// ============================================================================
// Provider contract
// ============================================================================

export interface Integration {
  /** Stable kebab id used in URLs and the DB. e.g. "linear", "slack", "github". */
  id: string;
  /** Human label for the settings UI. */
  displayName: string;
  /** Static asset path relative to /public, e.g. "/integrations/linear.svg". */
  icon: string;
  /** Docs link surfaced on the agent integration form. */
  docsUrl: string;
  /** Where the operator creates the OAuth app in the medium (deep link). */
  appCreateUrl: string;
  /** Scopes auto-requested at install time. Read-only metadata for the UI. */
  scopes: string[];

  oauth: OAuthAdapter;
  webhook: WebhookAdapter;

  /**
   * Outbound: called by the dispatcher when the harness emits an event for a
   * session that originated from this integration. The provider translates
   * the canonical `SessionEvent` into a medium-specific API call.
   */
  onSessionEvent(ctx: SessionEventContext): Promise<void>;
}

export interface OAuthAdapter {
  authorizeUrl(params: AuthorizeParams): string;
  exchange(params: ExchangeParams): Promise<TokenResponse>;
  refresh?(params: RefreshParams): Promise<TokenResponse>;
  /**
   * Called right after `exchange` to populate workspace_id / workspace_name
   * and any medium-specific metadata that lives in IntegrationInstall.metadata
   * (e.g. the app_user_id Linear uses to identify the agent in its UI).
   */
  fetchInstallMetadata(accessToken: string): Promise<InstallMetadata>;
}

export interface AuthorizeParams {
  state: string;
  redirectUri: string;
  /** Decrypted client_id from the agent's config. */
  clientId: string;
}

export interface ExchangeParams {
  code: string;
  redirectUri: string;
  /** Decrypted client_id + secret from the agent's config. */
  clientId: string;
  clientSecret: string;
}

export interface RefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

export interface WebhookAdapter {
  /**
   * HMAC / signature check. The dispatcher resolves which `install` this
   * webhook belongs to first (so the install's config + secret are available),
   * then calls verify.
   */
  verify(rawBody: Buffer, headers: Headers, ctx: WebhookVerifyContext): Promise<boolean> | boolean;

  /**
   * Translate the medium's wire format into a canonical `IntegrationEvent`.
   * Returns `{ kind: "ignore" }` for events we don't care about.
   */
  parse(payload: unknown, install: IntegrationInstall): IntegrationEvent;

  /**
   * Extract the medium's workspace id from the payload so the dispatcher can
   * find the matching IntegrationInstall before calling verify(). Returns
   * null if the payload doesn't carry a workspace id.
   */
  workspaceIdFromPayload(payload: unknown): string | null;
}

export interface WebhookVerifyContext {
  /** Decrypted webhook signing secret from the agent's config. */
  webhookSecret: string;
  install: IntegrationInstall;
}

export interface SessionEventContext {
  install: IntegrationInstall;
  /** The medium's session id — e.g. Linear's agentSession.id. */
  externalSessionId: string;
  event: SessionEvent;
  agent: Agent;
}

// ============================================================================
// Wire types
// ============================================================================

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Seconds from now until the access token expires. */
  expires_in?: number;
}

export interface InstallMetadata {
  workspace_id: string;
  workspace_name: string;
  metadata?: Record<string, unknown>;
}

/** Inbound event — what an integration translates a raw webhook payload into. */
export type IntegrationEvent =
  | {
      kind: "new_task";
      external_session_id: string;
      prompt: string;
      external_ref?: string;
    }
  | { kind: "followup"; external_session_id: string; body: string }
  | { kind: "cancel"; external_session_id: string }
  | { kind: "ignore" };

/** Outbound event — what the harness emits. */
export type SessionEvent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string; externalUrls?: { url: string; label: string }[] }
  | { type: "error"; body: string }
  | { type: "elicit"; body: string };

export type { AgentIntegrationConfig, IntegrationInstall };
