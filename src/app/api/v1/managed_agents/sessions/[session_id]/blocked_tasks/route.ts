/**
 * GET /api/v1/managed_agents/sessions/[session_id]/blocked_tasks
 *   List all blocked tasks for the same agent from *other* sessions.
 *   Resolves agent_id from the URL's session_id so callers only need session_id.
 *
 *   Returns (up to 10): array of
 *     { session_id, summary, blocked_reason, updated_at }
 *   sourced from each session's task_checkpoint JSONB field.
 */

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

interface TaskCheckpoint {
  summary: string;
  status: string;
  blocked_reason: string | null;
  updated_at: string;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;
  const sessionRow = await resolveSession(session_id);
  assertAgentTokenOrMaster(req, { scope: "memory", agent_id: sessionRow.agent_id });

  // Find sessions for the same agent that have a task_checkpoint with status="blocked",
  // excluding the current session. Prisma's JSONB path filter maps to Postgres @> / ->> operators.
  const rows = await prisma.session.findMany({
    where: {
      agent_id: sessionRow.agent_id,
      session_id: { not: session_id },
      task_checkpoint: {
        path: ["status"],
        equals: "blocked",
      },
    },
    select: {
      session_id: true,
      task_checkpoint: true,
      // Fall back to session updated_at for ordering when checkpoint updated_at is unavailable.
      last_seen_at: true,
      created_at: true,
    },
    orderBy: { created_at: "desc" },
    take: 10,
  });

  const result = rows.map((row) => {
    const cp = row.task_checkpoint as TaskCheckpoint | null;
    return {
      session_id: row.session_id,
      summary: cp?.summary ?? null,
      blocked_reason: cp?.blocked_reason ?? null,
      updated_at: cp?.updated_at ?? (row.last_seen_at ?? row.created_at).toISOString(),
    };
  });

  return Response.json(result);
});
