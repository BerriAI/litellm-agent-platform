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
import { harnessDeleteSession } from "@/server/harness";
import { buildSessionOrigin } from "@/server/integrations/core/origin";
import { stopTask } from "@/server/k8s";
import { invalidateSession } from "@/server/sessionCache";
import { clearSandboxes } from "@/server/tools/sandboxTools";
import { HARNESS_BRAIN_INLINE, HttpError, httpError, toApiSession } from "@/server/types";

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
        agent: { select: { harness_id: true } },
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
    return Response.json(toApiSession(row, null, origin, row.agent.harness_id));
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
    const row = await prisma.session.findUnique({
      where: { session_id },
      include: { agent: { select: { harness_id: true } } },
    });
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

    // Release any in-process sandboxMap entries for brain-inline sessions so
    // they don't accumulate as a memory leak across many session cycles.
    clearSandboxes(session_id);

    // For brain-inline sessions, also delete the harness session from the
    // shared harness server's in-memory map to prevent unbounded accumulation.
    // Fire-and-forget: failure here is non-fatal (harness restarts clear state).
    if (row.agent.harness_id === HARNESS_BRAIN_INLINE && row.harness_session_id && row.sandbox_url) {
      void harnessDeleteSession({ sandbox_url: row.sandbox_url, harness_session_id: row.harness_session_id })
        .catch((err: unknown) => {
          console.warn(`session DELETE: failed to delete harness session ${row.harness_session_id}:`, err);
        });
    }

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
