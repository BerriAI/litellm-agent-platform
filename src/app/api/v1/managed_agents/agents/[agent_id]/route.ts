/**
 * /api/v1/managed_agents/agents/{agent_id}
 *
 * GET    — fetch one agent or 404.
 * PATCH  — partial update. We only touch the columns the user is actually
 *          changing (UpdateAgentBody fields are optional), so an empty
 *          PATCH is a no-op rather than a silent overwrite to defaults.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { invalidateWarmTasks } from "@/server/memory";
import {
  encryptEnvVars,
  httpError,
  RESERVED_ENV_KEYS,
  toApiAgent,
  UpdateAgentBody,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const row = await prisma.agent.findUnique({ where: { agent_id } });
  if (row === null) httpError(404, `agent '${agent_id}' not found`);
  return Response.json(toApiAgent(row));
});

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const body = UpdateAgentBody.parse(await req.json());

  const data: Prisma.AgentUpdateInput = {};
  if (body.name !== undefined) data.agent_name = body.name;
  if (body.pfp_url !== undefined) data.pfp_url = body.pfp_url;
  if (body.mcp_servers !== undefined) data.mcp_servers = body.mcp_servers;
  if (body.harness_image !== undefined) data.task_definition_arn = body.harness_image;
  if (body.prompt !== undefined) data.prompt = body.prompt;
  if (body.model !== undefined) data.model = body.model;
  if (body.branch !== undefined) data.branch = body.branch;
  if (body.preload_memory_limit !== undefined) {
    data.preload_memory_limit = body.preload_memory_limit;
  }
  if (body.agent_tools !== undefined) {
    data.agent_tools = body.agent_tools as unknown as Prisma.InputJsonValue;
  }

  const existing = await prisma.agent.findUnique({ where: { agent_id } });
  if (existing === null) httpError(404, `agent '${agent_id}' not found`);

  // env_vars replace flow: user supplies the new user-editable map; we
  // preserve any reserved-key entries already on the row (e.g.
  // AGENT_REQUIREMENTS, which is set at create time and not user-editable).
  if (body.env_vars !== undefined) {
    const existingRaw =
      existing &&
      existing.env_vars &&
      typeof existing.env_vars === "object" &&
      !Array.isArray(existing.env_vars)
        ? (existing.env_vars as Record<string, unknown>)
        : {};
    const preserved: Record<string, string> = {};
    for (const [k, v] of Object.entries(existingRaw)) {
      if (RESERVED_ENV_KEYS.has(k)) {
        // Reserved keys are stored encrypted — keep the ciphertext as-is.
        preserved[k] = String(v);
      }
    }
    const reencrypted = encryptEnvVars(body.env_vars);
    data.env_vars = {
      ...preserved,
      ...reencrypted,
    } as Prisma.InputJsonValue;
  }

  const updated = await prisma.agent.update({ where: { agent_id }, data });
  // The pre-loaded AGENT_PROMPT is baked at warm-task spawn, so a fresh
  // preload_memory_limit only takes effect on the next bring-up. Without
  // recycling warm tasks here, a user shrinking the limit from 10 → 0
  // would still see 10 ranked rows in the next session if a warm pod gets
  // claimed. Cheap: warm pool reconciler refills in <2s.
  if (body.preload_memory_limit !== undefined) {
    await invalidateWarmTasks(agent_id);
  }
  return Response.json(toApiAgent(updated));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const row = await prisma.agent.findUnique({ where: { agent_id } });
  if (row === null) httpError(404, `agent '${agent_id}' not found`);
  await prisma.agent.delete({ where: { agent_id } });
  return new Response(null, { status: 204 });
});
