/**
 * POST /api/ui/auth/internal-user
 *
 * Exchanges username + password for a Bearer token. No auth header required.
 * Validates both credentials against INTERNAL_USER_USERNAME / INTERNAL_USER_PASSWORD.
 * Returns the token the client should use as `Authorization: Bearer <token>`.
 */

import { timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function POST(req: Request) {
  const username = env.INTERNAL_USER_USERNAME;
  const password = env.INTERNAL_USER_PASSWORD;

  if (!username || !password) {
    return Response.json({ error: "not configured" }, { status: 404 });
  }

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const gotUser = typeof body.username === "string" ? body.username : "";
  const gotPass = typeof body.password === "string" ? body.password : "";

  if (!safeEqual(gotUser, username) || !safeEqual(gotPass, password)) {
    return Response.json({ error: "invalid credentials" }, { status: 401 });
  }

  return Response.json({ token: password });
}
