/**
 * POST   /api/v1/managed_agents/agents/[agent_id]/integrations/[provider_id]/bind
 * DELETE /api/v1/managed_agents/agents/[agent_id]/integrations/[provider_id]/bind
 *
 * Bind / unbind an integration install to an agent. v1 assumes one binding
 * per (agent, integration) pair — enforced by the `@@unique([agent_id,
 * install_id])` constraint on `agent_integration_binding`, so re-binding to
 * the same install is idempotent.
 *
 * POST body:
 *   { install_id: string }   — required. The UI gets valid IDs from
 *                              GET /api/v1/integrations.
 *
 * If a different binding already exists for this (agent, integration), the
 * server replaces it: each agent talks to one workspace per medium. Multi-
 * workspace is a follow-up.
 *
 * DELETE has no body — drops every binding this agent has under this
 * provider. Returns 200 even if nothing was bound (idempotent), so the UI
 * doesn't have to special-case the "already off" state.
 */

import { z, ZodError } from "zod";
import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { getProvider } from "@/server/integrations/core/registry";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string; provider_id: string }>;
}

const BindBody = z.object({
  install_id: z.string().min(1, "install_id required"),
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, provider_id } = await ctx.params;

  const provider = getProvider(provider_id);
  if (!provider) {
    return Response.json(
      { error: `integration "${provider_id}" not found or not enabled` },
      { status: 404 },
    );
  }

  let body: z.infer<typeof BindBody>;
  try {
    body = BindBody.parse(await req.json());
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }

  // Validate the agent exists. Surface a clear 404 instead of letting the
  // foreign-key violation bubble up as a 500 from prisma.
  const agent = await prisma.agent.findUnique({
    where: { agent_id },
    select: { agent_id: true },
  });
  if (!agent) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }

  // Validate the install belongs to this provider — otherwise a caller could
  // bind the wrong workspace by mixing IDs across mediums.
  const install = await prisma.integrationInstall.findUnique({
    where: { install_id: body.install_id },
    select: { install_id: true, integration_id: true, workspace_name: true },
  });
  if (!install || install.integration_id !== provider_id) {
    return Response.json(
      { error: "install not found for this integration" },
      { status: 404 },
    );
  }

  // Replace any existing binding under this (agent, provider). Linear users
  // might have one install; Slack users might have several over time
  // (different workspaces) — we keep the model at "one active binding per
  // medium per agent" and let the UI prompt before switching.
  const existing = await prisma.agentIntegrationBinding.findMany({
    where: {
      agent_id,
      install: { integration_id: provider_id },
    },
    select: { binding_id: true, install_id: true },
  });

  for (const row of existing) {
    if (row.install_id !== install.install_id) {
      await prisma.agentIntegrationBinding.delete({
        where: { binding_id: row.binding_id },
      });
    }
  }

  const binding = await prisma.agentIntegrationBinding.upsert({
    where: {
      agent_id_install_id: {
        agent_id,
        install_id: install.install_id,
      },
    },
    update: { enabled: true },
    create: {
      agent_id,
      install_id: install.install_id,
      enabled: true,
      config: {},
    },
  });

  return Response.json({
    binding_id: binding.binding_id,
    install_id: install.install_id,
    workspace_name: install.workspace_name,
    enabled: binding.enabled,
  });
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, provider_id } = await ctx.params;

  const provider = getProvider(provider_id);
  if (!provider) {
    return Response.json(
      { error: `integration "${provider_id}" not found or not enabled` },
      { status: 404 },
    );
  }

  // Idempotent: deleteMany returns a count, never errors when count is 0.
  const result = await prisma.agentIntegrationBinding.deleteMany({
    where: {
      agent_id,
      install: { integration_id: provider_id },
    },
  });

  return Response.json({ deleted: result.count });
});
