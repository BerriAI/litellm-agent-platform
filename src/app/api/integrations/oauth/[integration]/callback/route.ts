/**
 * GET /api/integrations/oauth/{integration}/callback
 *
 * Receives the redirect from the provider after the user authorizes. Pulls
 * `code` + `state` off the query string, hands them to `completeOAuth(...)`,
 * which exchanges + persists the install row, then renders a tiny success
 * page so the operator knows it landed.
 *
 * This route is intentionally NOT behind `assertAuth` — the OAuth provider
 * is what's calling back, and it doesn't carry our master key. CSRF
 * protection comes from the `state` value `startOAuth` minted earlier.
 */

import { completeOAuth } from "@/server/integrations/core/oauth";
import { getProvider } from "@/server/integrations/core/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ integration: string }>;
}

function htmlResponse(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:14px/1.5 -apple-system,sans-serif;padding:32px;max-width:560px">` +
      `<h1 style="font-size:18px;margin:0 0 8px">${title}</h1>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { integration: integrationId } = await ctx.params;
  const integration = getProvider(integrationId);
  if (!integration) {
    return htmlResponse(
      404,
      "Unknown integration",
      `<p>No integration named <code>${integrationId}</code> is enabled.</p>`,
    );
  }

  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    return htmlResponse(
      400,
      "OAuth error",
      `<p>${integration.displayName} returned an error: <code>${error}</code>.</p>` +
        `<p>You can close this tab and retry from the settings page.</p>`,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlResponse(
      400,
      "Missing OAuth params",
      `<p>Both <code>code</code> and <code>state</code> are required.</p>`,
    );
  }

  try {
    const result = await completeOAuth({ integration, code, state });
    return htmlResponse(
      200,
      `${integration.displayName} connected`,
      `<p>Installed for workspace <strong>${result.workspace_name}</strong>.</p>` +
        `<p>You can close this tab. Enable specific agents on the agent settings page.</p>`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return htmlResponse(
      400,
      "OAuth callback failed",
      `<p>Could not complete the install: <code>${message}</code></p>`,
    );
  }
}
