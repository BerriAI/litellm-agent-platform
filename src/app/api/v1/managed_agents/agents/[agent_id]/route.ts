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
import {
  httpError,
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

  const existing = await prisma.agent.findUnique({ where: { agent_id } });
  if (existing === null) httpError(404, `agent '${agent_id}' not found`);

  const updated = await prisma.agent.update({ where: { agent_id }, data });
  return Response.json(toApiAgent(updated));
});
