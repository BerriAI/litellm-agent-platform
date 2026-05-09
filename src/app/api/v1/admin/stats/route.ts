/**
 * GET /api/v1/admin/stats
 *
 * Aggregate snapshot of platform state for the settings dashboard:
 *   - Warm pool: configured limits + current depth, broken out per agent.
 *   - Sessions: live counts + per-agent breakdown of creating/ready.
 *   - Agents: total count.
 *   - Runtime: namespace, harness image, NodePort range, reconcile cadence.
 *
 * Read-only and aggressively batched — three groupBy queries plus an agent
 * lookup, then an O(rows) merge. Tested at small scale; if pool counts ever
 * exceed a few hundred rows we should switch the per-agent slice to a
 * materialized view.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import type { ApiAdminStats } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WarmStatusKey = "provisioning" | "warm" | "claimed" | "dead";
const WARM_STATUSES: WarmStatusKey[] = [
  "provisioning",
  "warm",
  "claimed",
  "dead",
];

type SessionStatusKey = "creating" | "ready" | "failed" | "dead";
const SESSION_STATUSES: SessionStatusKey[] = [
  "creating",
  "ready",
  "failed",
  "dead",
];

function emptyWarmCounts(): Record<WarmStatusKey, number> {
  return { provisioning: 0, warm: 0, claimed: 0, dead: 0 };
}

function emptySessionCounts(): Record<SessionStatusKey, number> {
  return { creating: 0, ready: 0, failed: 0, dead: 0 };
}

export const GET = wrap(async (req: Request) => {
  assertAuth(req);

  const [
    warmGroups,
    warmOldestPerAgent,
    sessionGroups,
    agentTotal,
    agents,
  ] = await Promise.all([
    // Warm pool counts grouped by (agent, status). Cheap — table is small.
    prisma.warmTask.groupBy({
      by: ["agent_id", "status"],
      _count: { _all: true },
    }),
    // Oldest warm row per agent — surfaces "this agent has had a stuck
    // warm task for an hour" without requiring a separate detail page.
    prisma.warmTask.groupBy({
      by: ["agent_id"],
      where: { status: "warm" },
      _min: { ready_at: true },
    }),
    // Live session counts. We bucket by status not by ARN so a single agent
    // with many ready sessions shows up as a single row.
    prisma.session.groupBy({
      by: ["agent_id", "status"],
      _count: { _all: true },
    }),
    prisma.agent.count(),
    prisma.agent.findMany({
      select: { agent_id: true, agent_name: true },
    }),
  ]);

  const agentName = new Map<string, string | null>(
    agents.map((a) => [a.agent_id, a.agent_name]),
  );

  // Reduce groupBy output into per-agent maps. Defensive against unknown
  // status strings (older rows from before the enum stabilized).
  const warmByAgent = new Map<string, Record<WarmStatusKey, number>>();
  const warmTotals = emptyWarmCounts();
  for (const g of warmGroups) {
    const status = g.status as WarmStatusKey;
    if (!WARM_STATUSES.includes(status)) continue;
    const cur = warmByAgent.get(g.agent_id) ?? emptyWarmCounts();
    cur[status] += g._count._all;
    warmTotals[status] += g._count._all;
    warmByAgent.set(g.agent_id, cur);
  }
  const oldestWarmByAgent = new Map<string, string | null>(
    warmOldestPerAgent.map((g) => [
      g.agent_id,
      g._min.ready_at ? g._min.ready_at.toISOString() : null,
    ]),
  );

  const sessionByAgent = new Map<string, Record<SessionStatusKey, number>>();
  const sessionTotals = emptySessionCounts();
  for (const g of sessionGroups) {
    const status = g.status as SessionStatusKey;
    if (!SESSION_STATUSES.includes(status)) continue;
    const cur = sessionByAgent.get(g.agent_id) ?? emptySessionCounts();
    cur[status] += g._count._all;
    sessionTotals[status] += g._count._all;
    sessionByAgent.set(g.agent_id, cur);
  }

  // Build per-agent rows from the union of agent_ids that show up in
  // either map. Skip rows with all zeros so a workspace with 100 agents
  // doesn't render 100 empty lines.
  const agentIds = new Set<string>([
    ...warmByAgent.keys(),
    ...sessionByAgent.keys(),
  ]);
  const warmRows: ApiAdminStats["warm_pool"]["by_agent"] = [];
  for (const agent_id of agentIds) {
    const c = warmByAgent.get(agent_id);
    if (!c) continue;
    if (c.provisioning + c.warm + c.claimed + c.dead === 0) continue;
    warmRows.push({
      agent_id,
      agent_name: agentName.get(agent_id) ?? null,
      ...c,
      oldest_warm_at: oldestWarmByAgent.get(agent_id) ?? null,
    });
  }
  warmRows.sort((a, b) => b.warm - a.warm || b.provisioning - a.provisioning);

  const sessionRows: ApiAdminStats["sessions"]["by_agent"] = [];
  for (const agent_id of agentIds) {
    const c = sessionByAgent.get(agent_id);
    if (!c) continue;
    if (c.creating + c.ready === 0) continue;
    sessionRows.push({
      agent_id,
      agent_name: agentName.get(agent_id) ?? null,
      creating: c.creating,
      ready: c.ready,
    });
  }
  sessionRows.sort((a, b) => b.ready - a.ready || b.creating - a.creating);

  const body: ApiAdminStats = {
    warm_pool: {
      configured_size: env.WARM_POOL_SIZE,
      max_provisioning: env.WARM_POOL_MAX_PROVISIONING,
      ttl_minutes: env.WARM_POOL_TTL_MINUTES,
      recent_agent_hours: env.WARM_POOL_RECENT_AGENT_HOURS,
      counts: warmTotals,
      by_agent: warmRows,
    },
    sessions: {
      counts: sessionTotals,
      by_agent: sessionRows,
    },
    agents: { total: agentTotal },
    runtime: {
      namespace: env.K8S_NAMESPACE,
      harness_image: env.K8S_HARNESS_IMAGE,
      nodeport_range: `${env.K8S_NODEPORT_MIN}-${env.K8S_NODEPORT_MAX}`,
      container_port: env.CONTAINER_PORT,
      reconcile_interval_seconds: env.RECONCILE_INTERVAL_SECONDS,
    },
  };
  return Response.json(body);
});
