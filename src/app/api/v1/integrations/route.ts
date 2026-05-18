/**
 * GET /api/v1/integrations
 *
 * Lists every registered integration provider and — when `?agent_id` is
 * supplied — joins in this agent's current binding so the agent detail page
 * can render a per-channel status with one round trip.
 *
 * Response:
 *   {
 *     providers: [
 *       {
 *         id, display_name, icon, docs_url,
 *         enabled,        // server has the env vars to actually use it
 *         has_manifest,   // provider exposes a copy-paste app manifest
 *         installs: [{ install_id, workspace_id, workspace_name }, ...],
 *         binding: { binding_id, install_id, workspace_name, enabled } | null
 *       },
 *       ...
 *     ]
 *   }
 *
 * Disabled providers (env vars missing) are returned with `enabled: false`
 * and empty `installs` — the UI greys them out with a "Configure on server"
 * hint instead of pretending they aren't there.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { listProviders } from "@/server/integrations/core/registry";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(async (req) => {
  assertAuth(req);
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent_id");

  const providers = listProviders();

  // One query per provider for installs — provider count is tiny (3-5 at
  // most realistic horizons), so this is cheaper than a single join + Map
  // shuffle and keeps the response assembly readable.
  const installs = await prisma.integrationInstall.findMany({
    where: { integration_id: { in: providers.map((p) => p.id) } },
    select: {
      install_id: true,
      integration_id: true,
      workspace_id: true,
      workspace_name: true,
    },
  });

  const bindings = agentId
    ? await prisma.agentIntegrationBinding.findMany({
        where: { agent_id: agentId },
        include: {
          install: {
            select: {
              integration_id: true,
              workspace_name: true,
            },
          },
        },
      })
    : [];

  const response = {
    providers: providers.map((p) => {
      const enabled = p.enabled();
      const providerInstalls = enabled
        ? installs.filter((i) => i.integration_id === p.id)
        : [];
      const binding = bindings.find((b) => b.install.integration_id === p.id);
      return {
        id: p.id,
        display_name: p.displayName,
        icon: p.icon,
        docs_url: p.docsUrl,
        enabled,
        has_manifest: typeof p.manifest === "function",
        installs: providerInstalls.map((i) => ({
          install_id: i.install_id,
          workspace_id: i.workspace_id,
          workspace_name: i.workspace_name,
        })),
        binding: binding
          ? {
              binding_id: binding.binding_id,
              install_id: binding.install_id,
              workspace_name: binding.install.workspace_name,
              enabled: binding.enabled,
            }
          : null,
      };
    }),
  };

  return Response.json(response);
});
