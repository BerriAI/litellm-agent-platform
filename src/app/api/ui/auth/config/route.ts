/**
 * GET /api/ui/auth/config
 *
 * Returns public auth configuration for the login page — specifically whether
 * an internal user is configured so the UI can show the "User" login tab.
 * No auth required; only boolean + username are exposed (no secrets).
 */

import { env } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const username = env.INTERNAL_USER_USERNAME;
  return Response.json({
    hasInternalUser: Boolean(username),
    internalUsername: username ?? null,
  });
}
