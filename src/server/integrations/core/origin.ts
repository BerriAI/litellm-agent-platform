/**
 * Builds the `origin` payload exposed on `GET /sessions/{id}` when a session
 * was created by an integration webhook (Slack DM/@-mention, Linear assign,
 * etc.) rather than typed into the LAP UI.
 *
 * The UI uses this to render a small banner at the top of the thread linking
 * back to the original conversation. Provider-agnostic at the API layer:
 * each integration owns its own deep-link format here, keyed off
 * `IntegrationInstall.integration_id`.
 */
import type { IntegrationInstall } from "@prisma/client";

export interface SessionOrigin {
  /** "slack" | "linear" | ... — same id that lives on IntegrationInstall. */
  integration_id: string;
  /**
   * Medium-specific id this session is tied to. Opaque to the UI;
   * shown verbatim only as a fallback label when nothing prettier exists.
   */
  external_session_id: string;
  /**
   * Medium-friendly reference (e.g. "LIT-1234", "#test-shin", PR URL). Slack
   * webhooks today don't fill this in — left null and the UI falls back to
   * a generic "View thread" label.
   */
  external_ref: string | null;
  /** Workspace this install belongs to, as the user knows it. */
  workspace_name: string;
  /**
   * Best-effort deep link back to the originating thread. Null when we can't
   * confidently build one (unknown integration shape, malformed external id).
   */
  url: string | null;
}

interface BuildArgs {
  integration_id: string;
  external_session_id: string;
  external_ref: string | null;
  install: Pick<IntegrationInstall, "workspace_id" | "workspace_name">;
}

export function buildSessionOrigin(args: BuildArgs): SessionOrigin {
  return {
    integration_id: args.integration_id,
    external_session_id: args.external_session_id,
    external_ref: args.external_ref,
    workspace_name: args.install.workspace_name,
    url: buildOriginUrl(args),
  };
}

function buildOriginUrl(args: BuildArgs): string | null {
  switch (args.integration_id) {
    case "slack":
      return buildSlackUrl(args.external_session_id);
    case "linear":
      // Linear's webhook payload doesn't give us the agent-session URL up
      // front; external_ref already carries the issue identifier ("LIT-1234")
      // that the UI can link via the workspace URL pattern when we wire one
      // in. Leaving null for now.
      return null;
    default:
      return null;
  }
}

/**
 * `external_session_id` formats emitted by the Slack webhook (see
 * `providers/slack/webhook.ts`):
 *   - DM:           "slack:{team_id}:{channel_id}"
 *   - Channel msg:  "slack:{team_id}:{channel_id}:{thread_ts}"
 *
 * The Slack web client lives at app.slack.com/client and accepts a team_id
 * (not a workspace domain), which means we can deep-link to any workspace
 * without having stored its custom subdomain at install time. The desktop
 * Slack app intercepts these URLs and opens the thread directly.
 */
function buildSlackUrl(externalSessionId: string): string | null {
  if (!externalSessionId.startsWith("slack:")) return null;
  const parts = externalSessionId.split(":");
  // ["slack", team_id, channel_id] or ["slack", team_id, channel_id, thread_ts]
  if (parts.length < 3) return null;
  const [, teamId, channelId, threadTs] = parts;
  if (!teamId || !channelId) return null;
  const base = `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}`;
  if (threadTs) {
    return `${base}/thread/${encodeURIComponent(channelId)}-${encodeURIComponent(threadTs)}`;
  }
  return base;
}
