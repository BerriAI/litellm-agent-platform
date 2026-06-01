/**
 * POST /api/v1/managed_agents/sessions/[session_id]/task_checkpoint
 *   Agent saves progress on the current session.
 *   Body: { summary: string, status: "in_progress" | "blocked" | "complete", blocked_reason?: string }
 *   Returns: { ok: true }
 *
 * GET  /api/v1/managed_agents/sessions/[session_id]/task_checkpoint
 *   Read the checkpoint for any session (e.g. for the get_blocked_task tool
 *   reading a prior session's state).
 *   Returns: the task_checkpoint JSON object, or null.
 *
 * Both routes resolve agent_id from the session row so callers only need session_id.
 */

import { z } from "zod";
import { assertAgentTokenOrMaster } from "@/server/auth";
import { prisma } from "@/server/db";
import { httpError } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

async function resolveSession(session_id: string) {
  const row = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true },
  });
  if (!row) httpError(404, `session '${session_id}' not found`);
  return row!;
}

const CheckpointBody = z.object({
  summary: z.string().min(1),
  status: z.enum(["in_progress", "blocked", "complete"]),
  blocked_reason: z.string().optional(),
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;
  const sessionRow = await resolveSession(session_id);
  assertAgentTokenOrMaster(req, { scope: "memory", agent_id: sessionRow.agent_id });

  const body = CheckpointBody.parse(await req.json());

  const checkpoint = {
    summary: body.summary,
    status: body.status,
    blocked_reason: body.blocked_reason ?? null,
    updated_at: new Date().toISOString(),
  };

  await prisma.session.update({
    where: { session_id },
    data: { task_checkpoint: checkpoint },
  });

  return Response.json({ ok: true });
});

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;
  const sessionRow = await resolveSession(session_id);
  assertAgentTokenOrMaster(req, { scope: "memory", agent_id: sessionRow.agent_id });

  const session = await prisma.session.findUnique({
    where: { session_id },
    select: { task_checkpoint: true },
  });

  if (!session) httpError(404, `session '${session_id}' not found`);

  return Response.json(session!.task_checkpoint ?? null);
});
