/**
 * GET /api/v1/managed_agents/sessions/[session_id]/messages
 *
 * Proxies opencode's `GET /session/:harness_session_id/message`. Returns the
 * full thread including the agent-loop intermediates (tool calls, reasoning
 * parts) that POST /message hides — the UI uses this as the source of truth
 * for rendering reasoning + tool blocks.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { harnessListMessages } from "@/server/harness";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const row = await prisma.session.findUnique({ where: { session_id } });
    if (!row) httpError(404, `session ${session_id} not found`);
    if (!row.sandbox_url || !row.harness_session_id) {
      // Sessions still spinning up (creating, no harness session yet) and
      // dead/failed rows have nothing to fetch. Return [] so the UI can
      // show an empty thread without special-casing each status.
      return Response.json([]);
    }

    try {
      const msgs = await harnessListMessages({
        sandbox_url: row.sandbox_url,
        harness_session_id: row.harness_session_id,
      });
      return Response.json(msgs);
    } catch (err) {
      console.error("harness list_messages failed, falling back to history", err);
      // Harness unreachable (pod recycled, dead session, local dev without
      // a live sandbox). Return the last-known history snapshot so dead /
      // expired sessions can still display their full thread in the UI.
      if (Array.isArray(row.history) && row.history.length > 0) {
        return Response.json(row.history);
      }
      throw new HttpError(502, "harness request failed");
    }
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
