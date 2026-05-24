/**
 * GET /api/v1/managed_agents/sessions
 *
 * Lists managed-agent sessions. With `?agent_id=<id>` the result is filtered
 * to that agent; otherwise every session is returned, newest first. Each row
 * is mapped through `toApiSession` so the response uses the wire shape the
 * frontend expects (and the stored `response` blob is surfaced verbatim — no
 * inline harness call).
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { HttpError, toApiSession } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    assertAuth(req);
    const url = new URL(req.url);
    const agent_id = url.searchParams.get("agent_id") ?? undefined;
    const rows = await prisma.session.findMany({
      where: agent_id ? { agent_id } : {},
      orderBy: { created_at: "desc" },
      include: { agent: { select: { harness_id: true } } },
    });
    return Response.json(rows.map((row) => toApiSession(row, null, null, row.agent?.harness_id ?? undefined)));
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
