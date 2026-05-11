/**
 * Shared contract for the integrations subsystem.
 *
 * Every provider under `../providers/` implements `Integration`. The dispatcher
 * (`./dispatcher.ts`) and the dynamic Next.js routes
 * (`src/app/api/integrations/...`) only ever see this interface — they never
 * know about Linear, Slack, GitHub, or any specific medium.
 *
 * Adding a new medium: create a directory under `../providers/<name>/`,
 * export a default `Integration`, and register it in `./registry.ts`.
 * No changes here unless the contract itself needs to grow.
 */

import type { IntegrationInstall, Agent } from "@prisma/client";

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
  /** Docs link surfaced on the settings page. */
  docsUrl: string;

  /**
   * Returns true if the integration has the env vars / config it needs.
   * Disabled integrations are skipped at startup; their routes return 404.
   * Lets a deployment ship the code for all providers but only activate
   * the ones the operator has actually configured.
   */
  enabled(): boolean;

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
  scopes: string[];
  authorizeUrl(params: { state: string; redirectUri: string }): string;
  exchange(params: { code: string; redirectUri: string }): Promise<TokenResponse>;
  refresh?(refreshToken: string): Promise<TokenResponse>;
  /**
   * Called right after `exchange` to populate workspace_id / workspace_name
   * and any medium-specific metadata that lives in IntegrationInstall.metadata
   * (e.g. the app_user_id Linear uses to dedup self-emitted webhooks).
   */
  fetchInstallMetadata(accessToken: string): Promise<InstallMetadata>;
}

export interface WebhookAdapter {
  /**
   * HMAC / signature check. The dispatcher resolves which `install` this
   * webhook belongs to first (so the install's signing secret is available
   * via `install.metadata`), then calls verify.
   */
  verify(rawBody: Buffer, headers: Headers, install: IntegrationInstall): Promise<boolean> | boolean;

  /**
   * Translate the medium's wire format into a canonical `IntegrationEvent`.
   * Returns `{ kind: "ignore" }` for events we don't care about (e.g. the
   * agent's own activity echoing back).
   */
  parse(payload: unknown, install: IntegrationInstall): IntegrationEvent;

  /**
   * Extract the medium's workspace id from the payload so the dispatcher can
   * find the matching IntegrationInstall before calling verify(). Returns
   * null if the payload doesn't carry a workspace id (in which case the
   * dispatcher rejects the webhook with 400).
   */
  workspaceIdFromPayload(payload: unknown): string | null;
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

/**
 * Inbound event — what an integration translates a raw webhook payload into.
 * The dispatcher acts on the kind tag.
 */
export type IntegrationEvent =
  | {
      kind: "new_task";
      external_session_id: string;
      prompt: string;
      /** Optional human label (e.g. "LIT-1234") used in logs and the first thought ack. */
      external_ref?: string;
    }
  | { kind: "followup"; external_session_id: string; body: string }
  | { kind: "cancel"; external_session_id: string }
  | { kind: "ignore" };

/**
 * Outbound event — what the harness emits and what the provider's
 * `onSessionEvent` translates into a medium-specific API call (e.g. Linear's
 * agentActivityCreate, Slack's chat.postMessage).
 */
export type SessionEvent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string; externalUrls?: { url: string; label: string }[] }
  | { type: "error"; body: string }
  | { type: "elicit"; body: string };
