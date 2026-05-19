/**
 * GET /api/v1/managed_agents/sessions/[session_id]
 * DELETE /api/v1/managed_agents/sessions/[session_id]
 *
 * GET returns the wire-shape session row (or 404). DELETE is idempotent:
 * already-stopped/dead sessions short-circuit. Otherwise we ask Fargate to
 * stop the underlying task (skipping if no `task_arn` was ever recorded),
 * mark the row dead with a `stopped_at` timestamp, and respond with the
 * deletion ack.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { buildSessionOrigin } from "@/server/integrations/core/origin";
import { stopTask } from "@/server/k8s";
import { invalidateSession } from "@/server/sessionCache";
import { HttpError, httpError, toApiSession } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    // Pull integration_session + the binding's install in the same round-trip
    // so the UI can render an "originated from Slack/Linear" banner without a
    // follow-up request. The relation is optional — UI-originated sessions
    // have integration_session=null and the API returns origin=null.
    const row = await prisma.session.findUnique({
      where: { session_id },
      include: {
        integration_session: {
          include: { binding: { include: { install: true } } },
        },
      },
    });
    if (!row) httpError(404, `session ${session_id} not found`);
    const ext = row.integration_session;
    const origin = ext
      ? buildSessionOrigin({
          integration_id: ext.binding.install.integration_id,
          external_session_id: ext.external_session_id,
          external_ref: ext.external_ref ?? null,
          install: ext.binding.install,
        })
      : null;
    return Response.json(toApiSession(row, null, origin));
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

export async function DELETE(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const row = await prisma.session.findUnique({ where: { session_id } });
    if (!row) httpError(404, `session ${session_id} not found`);

    // Idempotent: if already terminal, ack without touching ECS again.
    if (row.status === "dead" || row.status === "stopped") {
      return Response.json({ id: row.session_id, status: row.status });
    }

    if (row.task_arn) {
      await stopTask(row.task_arn, "session deleted");
    }

    await prisma.session.update({
      where: { session_id },
      data: { status: "dead", stopped_at: new Date() },
    });

    // Drop the hot-path cache entry so the next message attempt observes the
    // dead state instead of forwarding to a torn-down sandbox.
    invalidateSession(session_id);

    return Response.json({ id: session_id, status: "deleted" });
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
