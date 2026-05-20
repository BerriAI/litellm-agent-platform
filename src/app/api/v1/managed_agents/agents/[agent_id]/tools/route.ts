/**
 * /api/v1/managed_agents/agents/{agent_id}/tools
 *
 * GET  — list sub-agent tools configured on this agent.
 * POST — replace the agent's sub-agent tools list (idempotent upsert).
 *
 * POST /api/v1/managed_agents/agents/{agent_id}/tools/invoke
 * (handled in ./invoke/route.ts)
 *
 * Auth: master key (same as agent PATCH).
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  AgentToolSpec,
  httpError,
  toApiAgent,
} from "@/server/types";
import { z } from "zod";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

const AgentToolSpecSchema = z.object({
  agent_id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "name must be alphanumeric + underscores/hyphens"),
  description: z.string().min(1).max(256),
});

const PutToolsBody = z.object({
  agent_tools: z
    .array(AgentToolSpecSchema)
    .max(10, "agent_tools: max 10 sub-agent tools"),
});

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({
    where: { agent_id },
    select: { agent_id: true, agent_tools: true },
  });
  if (!agent) httpError(404, `agent '${agent_id}' not found`);

  const tools: AgentToolSpec[] = Array.isArray(agent!.agent_tools)
    ? (agent!.agent_tools as unknown as AgentToolSpec[])
    : [];

  return Response.json({ agent_tools: tools });
});

export const PUT = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;

  const exists = await prisma.agent.findUnique({
    where: { agent_id },
    select: { agent_id: true },
  });
  if (!exists) httpError(404, `agent '${agent_id}' not found`);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    httpError(400, "invalid JSON body");
  }

  const parsed = PutToolsBody.safeParse(body);
  if (!parsed.success) httpError(400, parsed.error.issues[0]?.message ?? "invalid body");

  const { agent_tools } = parsed.data!;

  // Validate that each referenced agent_id actually exists.
  const referencedIds = [...new Set(agent_tools.map((t) => t.agent_id))];
  if (referencedIds.length > 0) {
    const found = await prisma.agent.findMany({
      where: { agent_id: { in: referencedIds } },
      select: { agent_id: true },
    });
    const foundSet = new Set(found.map((a) => a.agent_id));
    const missing = referencedIds.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      httpError(404, `referenced agent_id(s) not found: ${missing.join(", ")}`);
    }
  }

  // Prevent self-referential tool (agent calling itself → infinite loop risk).
  if (agent_tools.some((t) => t.agent_id === agent_id)) {
    httpError(400, "agent cannot reference itself as a tool");
  }

  const updated = await prisma.agent.update({
    where: { agent_id },
    data: { agent_tools: agent_tools as unknown as Parameters<typeof prisma.agent.update>[0]["data"]["agent_tools"] },
  });

  return Response.json(toApiAgent(updated));
});
