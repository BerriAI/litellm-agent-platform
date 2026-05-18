/**
 * POST /api/integrations/webhooks/slack
 *
 * Slack-specific intercept that handles the Events API `url_verification`
 * handshake before delegating real events to the generic
 * `handleInbound("slack", req)` dispatcher.
 *
 * The handshake: when you paste a Request URL into the Slack app's Event
 * Subscriptions page, Slack POSTs
 *
 *   { "type": "url_verification", "challenge": "<random>", "token": "..." }
 *
 * and expects a 200 with the `challenge` echoed back as plain text within
 * 3 seconds. There is no `team_id` on this payload, so it would otherwise
 * fall through to `workspaceIdFromPayload` → null → 400.
 *
 * Specific routes win over dynamic ones in Next.js App Router, so this
 * file takes precedence over `../[integration]/route.ts` for the
 * `slack` segment.
 */

import { handleInbound } from "@/server/integrations/core/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Read the body via a clone so the dispatcher gets a fresh, unread Request
  // (it does its own raw-body read for HMAC verification).
  const cloned = req.clone();
  let bodyText: string;
  try {
    bodyText = await cloned.text();
  } catch {
    return new Response(JSON.stringify({ error: "invalid body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { type?: unknown }).type === "url_verification"
  ) {
    const challenge = (parsed as { challenge?: unknown }).challenge;
    if (typeof challenge !== "string" || challenge.length === 0) {
      return new Response(
        JSON.stringify({ error: "missing challenge" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  return handleInbound("slack", req);
}
