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
   * Optional: return the medium-specific app/install manifest with this
   * deployment's base URL substituted in. Surfaced by the UI on
   * /agents/[id] so an operator can copy-paste it into the provider's app
   * console (e.g. api.slack.com/apps "Create from manifest"). Providers
   * that don't have a manifest concept (anything that's installed by the
   * user clicking "Connect" in a marketplace, e.g. Linear) omit it; the
   * UI then skips the manifest step in their setup wizard.
   *
   * The returned value is serialized to JSON for the UI; objects render
   * pretty-printed, strings render verbatim (e.g. a YAML manifest).
   */
  manifest?(baseUrl: string): unknown;

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
   *
   * May return a Promise so providers can resolve auth-gated side-content
   * (e.g. Slack file URLs require the bot token to download) before handing
   * the dispatcher a fully self-contained event.
   */
  parse(
    payload: unknown,
    install: IntegrationInstall,
  ): IntegrationEvent | Promise<IntegrationEvent>;

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
  /**
   * Resolved agent bound to this install. Set whenever the dispatcher has
   * already done the `agentIntegrationBinding` lookup before emitting the
   * event — the common case for `thought`, `response`, `error`, etc.
   *
   * Undefined for events fired BEFORE the binding lookup, currently only
   * the immediate `react` ack on the Slack message path. Providers that
   * use `ctx.agent` must guard the field — typically by `event.type`-
   * switching on event types that aren't fired pre-binding.
   */
  agent?: Agent;
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
 * Binary content carried with an inbound message (Slack file uploads, etc.).
 *
 * The webhook adapter resolves the medium's private URL into bytes — Slack's
 * `url_private` needs an `Authorization: Bearer <bot_token>` header that only
 * the server holds — and hands the dispatcher a self-contained blob. The
 * dispatcher passes it through to the v1 session create API, which lifts
 * each attachment into a Claude-format multimodal message part for the
 * harness alongside the text prompt.
 *
 * Size cap: providers SHOULD reject files larger than ~5 MB before reaching
 * the dispatcher. Base64 inflates bytes by ~33%, and Claude's per-request
 * cap is 32 MB total across all content blocks.
 */
export interface IntegrationAttachment {
  /** Original filename (best-effort; some mediums don't expose one). */
  name: string;
  /** MIME type, e.g. "image/png". Required so the harness can route to vision. */
  mime_type: string;
  /** Raw bytes, base64-encoded. The agent's sandbox can't authenticate
   *  against the medium's private file URLs, so we inline the content. */
  base64: string;
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
      /** Image / file uploads attached to the inbound message. */
      attachments?: IntegrationAttachment[];
    }
  | {
      kind: "followup";
      external_session_id: string;
      body: string;
      attachments?: IntegrationAttachment[];
    }
  | { kind: "cancel"; external_session_id: string }
  /**
   * Messaging-style mediums (Slack, Discord, …) can't tell from the webhook
   * payload alone whether this is the first message in a conversation or a
   * follow-up — they need an IntegrationSession lookup to decide. The
   * dispatcher resolves that ambiguity: it treats `message` as a follow-up
   * when an IntegrationSession exists for `external_session_id` and the
   * underlying LAP session is still ready + within its idle window;
   * otherwise it treats it as a new_task.
   */
  | {
      kind: "message";
      external_session_id: string;
      prompt: string;
      external_ref?: string;
      /** Image / file uploads attached to the inbound message. */
      attachments?: IntegrationAttachment[];
      /** Original ts of the inbound message in the medium (e.g. Slack `event.ts`).
       *  Used by the dispatcher to anchor immediate-ack signals (reactions,
       *  first-thought reply) to the user's actual message rather than the
       *  thread root. Optional — providers that don't have a per-message id
       *  can leave it unset and the dispatcher falls back to `external_session_id`. */
      original_ts?: string;
    }
  | { kind: "ignore" };

/**
 * Optional pointer to the inbound message a SessionEvent should anchor to.
 * Used by `react` events so the provider knows which Slack message ts to
 * `reactions.add` against — without it we'd react to the thread root by
 * default, which is wrong for any followup message in a thread.
 */
export interface EventAnchor {
  ts: string;
}

/**
 * Outbound event — what the harness emits and what the provider's
 * `onSessionEvent` translates into a medium-specific API call (e.g. Linear's
 * agentActivityCreate, Slack's chat.postMessage).
 */
export type SessionEvent =
  | {
      type: "thought";
      body: string;
      /**
       * Optional links the provider should attach to the thought (e.g. a
       * pointer to the LAP agent / session page on the dispatch ack so the
       * user can jump from Slack to the live session view). Mirrors the
       * field already present on `response`.
       */
      externalUrls?: { url: string; label: string }[];
    }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string; externalUrls?: { url: string; label: string }[] }
  | { type: "error"; body: string }
  | { type: "elicit"; body: string }
  /**
   * Lightweight acknowledgement signal. The dispatcher fires this the moment
   * a message arrives, before any session bring-up, so the user gets fast
   * visual feedback (a Slack reaction, a typing indicator on other platforms).
   * `anchor` points at the user's inbound message; providers that can't
   * anchor reactions to a specific message should no-op.
   */
  | { type: "react"; emoji: string; anchor?: EventAnchor };
