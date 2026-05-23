/**
 * GET /api/v1/managed_agents/sessions/[session_id]/vault-keys
 *
 * Returns the list of credential names registered in the vault sidecar for
 * this session's sandbox pod (e.g. ["GITHUB_TOKEN", "LITELLM_API_KEY"]).
 * No stubs, no values — safe to surface in the UI.
 *
 * Returns [] when the pod isn't scheduled yet or on transient errors.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { fetchVaultKeys } from "@/server/k8s";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const row = await prisma.session.findUnique({
      where: { session_id },
      select: { task_arn: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);

    if (!row.task_arn) return json([]);

    try {
      const data = await fetchVaultKeys(row.task_arn);
      return json(data ?? []);
    } catch (err) {
      console.warn(
        `vault-keys: fetchVaultKeys(${row.task_arn}) failed for session ${session_id}:`,
        err,
      );
      return json([]);
    }
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
