/**
 * GET /api/v1/integrations/[provider_id]/manifest
 *
 * Returns the medium-specific app manifest with the live deployment's base
 * URL substituted in. The UI shows the result inside a copy-to-clipboard
 * code block on the channel setup wizard (e.g. "paste this into the Slack
 * app's Create-from-manifest screen").
 *
 * Base URL resolution, in order:
 *   1. `LAP_BASE_URL` env var (canonical)
 *   2. `BASE_URL` env var (legacy, also read by the dispatcher's
 *      `spawnSessionForEvent`)
 *   3. Inferred from the request's forwarded host headers
 *   4. `req.url`'s origin
 *
 * 404 if the provider doesn't exist, isn't enabled (env vars missing), or
 * doesn't expose a `manifest()` adapter (e.g. Linear — installed by clicking
 * Connect in Linear's UI, not by pasting a manifest).
 */

import { assertAuth } from "@/server/auth";
import { getProvider } from "@/server/integrations/core/registry";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ provider_id: string }>;
}

function resolveBaseUrl(req: Request): string {
  const fromEnv = process.env.LAP_BASE_URL || process.env.BASE_URL;
  if (fromEnv) return fromEnv;

  const forwardedProto = req.headers.get("x-forwarded-proto");
  const forwardedHost =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (forwardedHost) {
    return `${forwardedProto ?? "https"}://${forwardedHost}`;
  }
  return new URL(req.url).origin;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { provider_id } = await ctx.params;

  const provider = getProvider(provider_id);
  if (!provider) {
    return Response.json(
      { error: `integration "${provider_id}" not found or not enabled` },
      { status: 404 },
    );
  }
  if (typeof provider.manifest !== "function") {
    return Response.json(
      { error: `integration "${provider_id}" has no manifest` },
      { status: 404 },
    );
  }

  const baseUrl = resolveBaseUrl(req);
  const manifest = provider.manifest(baseUrl);
  return Response.json({ base_url: baseUrl, manifest });
});
