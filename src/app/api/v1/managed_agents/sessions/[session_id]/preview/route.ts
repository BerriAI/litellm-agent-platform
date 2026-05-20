/**
 * POST /api/v1/managed_agents/sessions/[session_id]/preview
 *
 * Called by the in-sandbox harness after the agent starts a service and
 * registers its port via the `report_preview_url` MCP tool. Constructs
 * the browser-accessible preview URL as `sandbox_url/proxy/{port}` and
 * writes it to `Session.preview_url` so the session view can show a
 * "View Preview" link in the header.
 *
 * Auth: accepts either the master key (UI/CLI) or a scoped agent access
 * token with `scope: "preview"` (harness inside sandbox). Because the URL
 * carries `session_id` rather than `agent_id`, we look up the session first
 * to get its `agent_id`, then validate the token against that agent.
 */

import { assertAgentTokenOrMaster, assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    const { session_id } = await ctx.params;

    const body = (await req.json()) as { port?: unknown };
    const port = body?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      httpError(400, "port must be an integer between 1 and 65535");
    }

    // Fetch the session early so we can extract agent_id for token validation.
    const row = await prisma.session.findUnique({ where: { session_id } });
    if (!row) httpError(404, `session ${session_id} not found`);

    // Accept either a scoped agent token (harness path) or the master key
    // (UI / CLI path). The agent token must be scoped to the session's agent.
    if (row.agent_id) {
      assertAgentTokenOrMaster(req, { scope: "preview", agent_id: row.agent_id });
    } else {
      // Sessions without an agent_id are not sandbox-backed; only master key applies.
      assertAuth(req);
    }

    if (!row.sandbox_url) {
      httpError(400, "session has no sandbox_url yet — sandbox may still be starting");
    }

    const preview_url = `${row.sandbox_url!.replace(/\/+$/, "")}/proxy/${port}`;

    await prisma.session.update({
      where: { session_id },
      data: { preview_url },
    });

    return Response.json({ ok: true, preview_url });
  } catch (e) {
    if (e instanceof HttpError) {
      return Response.json({ error: e.detail }, { status: e.status });
    }
    console.error("[preview] unexpected error:", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
