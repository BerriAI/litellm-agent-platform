/**
 * /api/v1/managed_agents/agents
 *
 * GET  — list every agent, newest first, mapped through `toApiAgent`.
 * POST — create an agent. The request body is the user-facing slice
 *        (`CreateAgentBody`); we fill in the server-owned columns
 *        (`harness_id`, `task_definition_arn`, `container_port`, `created_by`)
 *        from env + the auth identity so callers can't override them.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import {
  CreateAgentBody,
  HARNESS_OPENCODE,
  toApiAgent,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(async (req: Request) => {
  assertAuth(req);
  const rows = await prisma.agent.findMany({
    orderBy: { created_at: "desc" },
  });
  return Response.json(rows.map(toApiAgent));
});

export const POST = wrap(async (req: Request) => {
  const identity = assertAuth(req);
  const body = CreateAgentBody.parse(await req.json());
  const created = await prisma.agent.create({
    data: {
      agent_name: body.name ?? null,
      model: body.model,
      prompt: body.prompt ?? null,
      // zod gives us `unknown[]`; Prisma's Json column wants InputJsonValue.
      // We trust the body here — the agent owner is authenticated.
      tools: body.tools as Prisma.InputJsonValue,
      harness_id: HARNESS_OPENCODE,
      repo_url: body.repo_url ?? null,
      branch: body.branch ?? "main",
      pfp_url: body.pfp_url ?? null,
      mcp_servers: body.mcp_servers as Prisma.InputJsonValue,
      // Legacy column from the ECS era; on k8s we run the same harness
      // image for every Sandbox so we just stash that here. Plan is to
      // drop the column on the next schema bump.
      task_definition_arn: env.K8S_HARNESS_IMAGE,
      container_port: env.CONTAINER_PORT,
      created_by: identity.user_id,
    },
  });
  return Response.json(toApiAgent(created));
});
