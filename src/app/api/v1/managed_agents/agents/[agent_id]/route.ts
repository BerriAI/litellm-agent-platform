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
import { hostAllowedByList } from "@/lib/egress-hosts";
import {
  encryptEnvVars,
  HARNESS_BRAIN_INLINE,
  httpError,
  parseEnvVarHosts,
  RESERVED_ENV_KEYS,
  toApiAgent,
  UpdateAgentBody,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";
import { deleteWorkspacePvc } from "@/server/k8s";

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
  if (body.projects !== undefined) data.projects = body.projects as Prisma.InputJsonValue;
  if (body.allow_out !== undefined) data.allow_out = body.allow_out as Prisma.InputJsonValue;
  if (body.deny_out !== undefined) data.deny_out = body.deny_out as Prisma.InputJsonValue;

  const existing = await prisma.agent.findUnique({ where: { agent_id } });
  if (existing === null) httpError(404, `agent '${agent_id}' not found`);

  if (
    existing!.harness_id === HARNESS_BRAIN_INLINE &&
    body.projects !== undefined &&
    body.projects.length === 0
  ) {
    httpError(400, {
      error: `harness_id "${HARNESS_BRAIN_INLINE}" requires at least one project entry in "projects"`,
    });
  }

  // Reconcile per-credential host bindings against the agent's *effective* state
  // (this PATCH merged onto the existing row). In this model env_var_hosts is the
  // source of truth and allow_out is derived from it, so a binding host is only
  // ever removed by an explicit env_var_hosts edit — never silently because the
  // env var was deleted (key pruned) or allow_out was narrowed. To keep the two
  // consistent we instead guarantee allow_out covers every bound host below.
  if (
    body.env_var_hosts !== undefined ||
    body.allow_out !== undefined ||
    body.env_vars !== undefined
  ) {
    const provided = body.env_var_hosts;
    const source = provided ?? parseEnvVarHosts((existing as Record<string, unknown>).env_var_hosts);
    const effectiveAllow =
      body.allow_out ??
      (Array.isArray(existing!.allow_out) ? (existing!.allow_out as string[]) : []);
    const effectiveKeys = new Set(
      body.env_vars
        ? Object.keys(body.env_vars)
        : Object.keys(
            existing!.env_vars && typeof existing!.env_vars === "object" && !Array.isArray(existing!.env_vars)
              ? (existing!.env_vars as Record<string, unknown>)
              : {},
          ).filter((k) => !RESERVED_ENV_KEYS.has(k)),
    );
    const reconciled: Record<string, string[]> = {};
    for (const [key, hosts] of Object.entries(source)) {
      // The only silent drop: the env var itself no longer exists (e.g. removed
      // via the inline editor). Removing a secret legitimately removes its scope.
      if (!effectiveKeys.has(key)) {
        if (provided) httpError(400, { error: `env_var_hosts: '${key}' is not a defined env var` });
        continue;
      }
      // When the caller sets bindings explicitly, every host must be allowed
      // (wildcard-aware, mirroring the vault) — a bad host is a 400, not a drop.
      if (provided && !hosts.every((h) => hostAllowedByList(h, effectiveAllow))) {
        httpError(400, {
          error: `env_var_hosts: a host for '${key}' is not in the agent's allowed hosts`,
        });
      }
      // Preserve all hosts. Crucially we do NOT filter by allow_out here: a
      // narrowed allow_out must never silently un-scope a credential.
      if (hosts.length > 0) reconciled[key] = hosts;
    }
    // Derive: allow_out must cover every bound host. If this PATCH narrows
    // allow_out below a binding, add the missing hosts back rather than leaving
    // the credential pointing outside the allowlist (which under
    // EGRESS_DEFAULT_DENY=false degrades to swap-anywhere).
    if (body.allow_out !== undefined) {
      const boundHosts = [...new Set(Object.values(reconciled).flat())];
      const missing = boundHosts.filter((h) => !hostAllowedByList(h, body.allow_out!));
      if (missing.length > 0) {
        data.allow_out = [...body.allow_out, ...missing] as Prisma.InputJsonValue;
      }
    }
    if (provided !== undefined || JSON.stringify(reconciled) !== JSON.stringify(source)) {
      // Cast through unknown — Prisma client not regenerated for the new column.
      (data as Record<string, unknown>).env_var_hosts =
        reconciled as unknown as Prisma.InputJsonValue;
    }
  }

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
  if (body.preload_memory_limit !== undefined || body.env_vars !== undefined) {
    await invalidateWarmTasks(agent_id);
  }
  return Response.json(toApiAgent(updated));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const row = await prisma.agent.findUnique({ where: { agent_id } });
  if (row === null) httpError(404, `agent '${agent_id}' not found`);
  await deleteWorkspacePvc(agent_id);
  await prisma.agent.delete({ where: { agent_id } });
  return new Response(null, { status: 204 });
});
