/**
 * Bearer auth for v0 single-tenant UI.
 * See AuthIdentity / assertAuth / expectedBearer in src/server/types.ts.
 */

import { timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import type { AuthIdentity } from "@/server/types";

let cachedExpected: string | null = null;

/**
 * Name of the HttpOnly cookie that mirrors the bearer master key for SSE
 * routes the browser opens via `EventSource` (which can't attach an
 * Authorization header). Set by POST /api/ui/auth/cookie after a successful
 * /login submit; read by `assertCookieAuth` on the /api/ui SSE proxy.
 *
 * Single-tenant v0: same MASTER_KEY value as Bearer, just delivered via a
 * cookie envelope. HttpOnly + SameSite=Lax + Secure-in-prod keeps it out
 * of script reach (matches the security profile of the bearer-in-Authorization
 * header that other v1 routes use).
 */
export const UI_COOKIE_NAME = "__lap_master_key";

export function expectedBearer(): string {
  if (cachedExpected === null) {
    cachedExpected = `Bearer ${env.MASTER_KEY}`;
  }
  return cachedExpected;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Accepts `Authorization: Bearer <token>`.
 *   - token == MASTER_KEY               → admin role (full access)
 *   - token == INTERNAL_USER_PASSWORD   → internal_user role (agent CRUD only,
 *                                         no sandbox templates). Client obtains
 *                                         this token by POSTing username+password
 *                                         to /api/ui/auth/internal-user.
 *
 * Throws a 401 Response if no token matches.
 */
export function assertAuth(req: Request): AuthIdentity {
  const header = req.headers.get("authorization");
  if (header === null) throw unauthorized();
  if (!header.startsWith("Bearer ")) throw unauthorized();

  if (safeEqual(header, expectedBearer())) {
    return { user_id: "ui", role: "admin" };
  }

  const username = env.INTERNAL_USER_USERNAME;
  const password = env.INTERNAL_USER_PASSWORD;
  if (username && password && safeEqual(header, `Bearer ${password}`)) {
    return { user_id: username, role: "internal_user" };
  }

  throw unauthorized();
}

/**
 * Like assertAuth but only allows admin role (MASTER_KEY).
 * Internal users receive 403 Forbidden.
 */
export function assertAdminAuth(req: Request): AuthIdentity {
  const identity = assertAuth(req);
  if (identity.role !== "admin") throw forbidden();
  return identity;
}

/**
 * Cookie-auth variant for SSE routes the browser opens via `EventSource`.
 * Reads `UI_COOKIE_NAME` from the request `Cookie` header and timing-safe
 * compares it to `env.MASTER_KEY`. Throws a 401 Response on mismatch.
 *
 * Used by /api/ui/sessions/:id/stream — the browser can't attach an
 * Authorization header to an EventSource, so we accept the same secret
 * through an HttpOnly cookie installed at /login time.
 */
export function assertCookieAuth(req: Request): AuthIdentity {
  const cookieHeader = req.headers.get("cookie") || "";
  // Naive parse: cookies look like "k=v; k2=v2". HttpOnly cookies set by
  // our /auth/cookie endpoint don't contain `;` or `=` inside values, so
  // this is fine. We don't pull in a cookie-parser dep for one read.
  let got: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== UI_COOKIE_NAME) continue;
    got = part.slice(eq + 1).trim();
    break;
  }
  if (got === null) throw unauthorized();
  const a = Buffer.from(got);
  const b = Buffer.from(env.MASTER_KEY);
  if (a.length !== b.length) throw unauthorized();
  if (!timingSafeEqual(a, b)) throw unauthorized();
  return { user_id: "ui", role: "admin" };
}
