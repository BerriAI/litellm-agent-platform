/**
 * GET / PUT / DELETE /api/v1/managed_agents/sessions/[session_id]/sandbox-id
 *
 * Per-session persistence of the e2b sandbox ID for the inline-direct harness
 * mode. The legacy in-memory `sandboxes` Map in sandbox-mcp.mjs was global
 * across the (single-process) inline-shared harness and keyed only by `name`
 * ("main"), so two concurrent sessions collided — one's sandbox silently
 * replaced the other's. The harness now treats the session row as the source
 * of truth: on every provision/execute/read_file/upload_artifact it reads its
 * session's `sandbox_id` here, reconnects via the e2b SDK, and only creates a
 * fresh sandbox when this column is null. That also survives a harness
 * restart, because the e2b sandbox itself outlives the harness process.
 *
 * Auth: `assertAuth` — master key only (UI/CLI callers). If agent-token
 * support is needed here later, switch to `assertAgentScopeOrMaster` with
 * a "sandbox" scope. The harness today uses `LAP_AUTH_TOKEN ?? MASTER_KEY`
 * for this endpoint, so it must be configured with the master key.
 *
 * Body for PUT: { sandbox_id: string }
 */
import { z } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { wrap } from "@/server/route-helpers";
import { httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

const PutBody = z.object({
  // e2b sandbox IDs are short opaque tokens; keep the cap generous but bounded.
  sandbox_id: z.string().min(1).max(128),
});

async function loadSession(session_id: string) {
  const session = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true, sandbox_id: true },
  });
  if (!session) httpError(404, `session '${session_id}' not found`);
  return session!;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { session_id } = await ctx.params;
  const s = await loadSession(session_id);
  return Response.json({ session_id, sandbox_id: s.sandbox_id });
});

export const PUT = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { session_id } = await ctx.params;
  await loadSession(session_id);
  const { sandbox_id } = PutBody.parse(await req.json());
  await prisma.session.update({
    where: { session_id },
    data: { sandbox_id },
  });
  return Response.json({ session_id, sandbox_id });
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { session_id } = await ctx.params;
  await loadSession(session_id);
  await prisma.session.update({
    where: { session_id },
    data: { sandbox_id: null },
  });
  return Response.json({ session_id, sandbox_id: null });
});
