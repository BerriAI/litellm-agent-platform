/**
 * GET /api/integrations/oauth/{integration}/authorize
 *
 * Kicks off the OAuth flow for a given integration. Mints a CSRF state,
 * stashes it server-side, and 302s to the provider's authorize URL.
 *
 * Auth: gated by the LAP master key. The UI is expected to set the
 * Authorization header before redirecting, or — more commonly — initiate
 * this from a same-origin link that flows through the assertAuth-checked
 * settings page. For now we accept either Authorization header OR a session
 * cookie if one exists; the bare minimum is that the request must come from
 * the same browser that already authed with the dashboard.
 */

import { assertAuth } from "@/server/auth";
import { getProvider } from "@/server/integrations/core/registry";
import { startOAuth } from "@/server/integrations/core/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ integration: string }>;
}

function redirectUriFor(req: Request, integrationId: string): string {
  const base = process.env.BASE_URL ?? new URL(req.url).origin;
  return `${base.replace(/\/$/, "")}/api/integrations/oauth/${encodeURIComponent(
    integrationId,
  )}/callback`;
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    assertAuth(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { integration: integrationId } = await ctx.params;
  const integration = getProvider(integrationId);
  if (!integration) {
    return new Response(
      JSON.stringify({ error: `unknown or disabled integration "${integrationId}"` }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  const url = startOAuth(integration, redirectUriFor(req, integrationId));
  return new Response(null, { status: 302, headers: { location: url } });
}
