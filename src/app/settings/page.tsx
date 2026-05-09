"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AdminStats, ApiError, getAdminStats } from "@/lib/api";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 5000;

type Health = "healthy" | "warming" | "drained" | "idle";

interface HealthSpec {
  label: string;
  dotClass: string;
  textClass: string;
}

const HEALTH: Record<Health, HealthSpec> = {
  healthy: {
    label: "Healthy",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-400",
  },
  warming: {
    label: "Warming up",
    dotClass: "bg-amber-500",
    textClass: "text-amber-700 dark:text-amber-400",
  },
  drained: {
    label: "Drained",
    dotClass: "bg-red-500",
    textClass: "text-red-700 dark:text-red-400",
  },
  idle: {
    label: "Idle",
    dotClass: "bg-muted-foreground",
    textClass: "text-muted-foreground",
  },
};

function poolHealth(stats: AdminStats): { health: Health; subtitle: string } {
  const wp = stats.warm_pool;
  if (wp.configured_size === 0) {
    return { health: "idle", subtitle: "Warm pool disabled" };
  }
  if (wp.counts.warm >= wp.configured_size) {
    return {
      health: "healthy",
      subtitle: `Next session create: <5s`,
    };
  }
  if (wp.counts.warm + wp.counts.provisioning >= wp.configured_size) {
    return {
      health: "warming",
      subtitle: `${wp.counts.provisioning} provisioning · ~40s to ready`,
    };
  }
  if (wp.counts.warm === 0) {
    return {
      health: "drained",
      subtitle: "Next session create: ~40s cold start",
    };
  }
  return {
    health: "warming",
    subtitle: `Below target — backfilling`,
  };
}

function sandboxHealth(stats: AdminStats): {
  health: Health;
  subtitle: string;
} {
  const sx = stats.sessions;
  const live = sx.counts.creating + sx.counts.ready;
  if (live === 0) {
    return { health: "idle", subtitle: "No live sandboxes" };
  }
  if (sx.counts.creating > 0) {
    return {
      health: "warming",
      subtitle: `${sx.counts.creating} still booting`,
    };
  }
  return {
    health: "healthy",
    subtitle: `Serving requests`,
  };
}

interface HealthTileProps {
  question: string;
  health: Health;
  metric: string;
  metricSub?: string;
  subtitle: string;
}

function HealthTile({
  question,
  health,
  metric,
  metricSub,
  subtitle,
}: HealthTileProps) {
  const spec = HEALTH[health];
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {question}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span
          aria-hidden
          className={cn("size-2 rounded-full", spec.dotClass)}
        />
        <span className={cn("text-sm font-medium", spec.textClass)}>
          {spec.label}
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-4xl font-semibold tabular-nums tracking-tight">
          {metric}
        </span>
        {metricSub ? (
          <span className="text-sm text-muted-foreground">{metricSub}</span>
        ) : null}
      </div>
      <div className="mt-2 text-sm text-muted-foreground">{subtitle}</div>
    </div>
  );
}

interface PoolBarProps {
  warm: number;
  provisioning: number;
  target: number;
}

/**
 * Single horizontal bar visualization. Solid green = ready, hatched amber =
 * provisioning, neutral fill = empty slots up to target. One glance answers
 * "do I have enough warm containers and what's coming next?".
 */
function PoolBar({ warm, provisioning, target }: PoolBarProps) {
  if (target === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        Warm pool disabled (WARM_POOL_SIZE=0).
      </div>
    );
  }
  const total = Math.max(target, warm + provisioning);
  const warmPct = (warm / total) * 100;
  const provPct = (provisioning / total) * 100;
  const targetPct = (target / total) * 100;
  return (
    <div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-muted">
        {warmPct > 0 ? (
          <div
            className="absolute inset-y-0 left-0 bg-emerald-500"
            style={{ width: `${warmPct}%` }}
            aria-hidden
          />
        ) : null}
        {provPct > 0 ? (
          <div
            className="absolute inset-y-0 bg-amber-400"
            style={{ left: `${warmPct}%`, width: `${provPct}%` }}
            aria-hidden
          />
        ) : null}
        {/* target marker — only render if we're over-provisioned */}
        {targetPct < 100 ? (
          <div
            className="absolute inset-y-0 w-px bg-foreground/40"
            style={{ left: `${targetPct}%` }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-emerald-500" /> Warm{" "}
          <span className="tabular-nums text-foreground">{warm}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-amber-400" /> Provisioning{" "}
          <span className="tabular-nums text-foreground">{provisioning}</span>
        </span>
        <span className="ml-auto">
          Target{" "}
          <span className="tabular-nums text-foreground">{target}</span>
        </span>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setRefreshing(true);
    setError(null);
    try {
      const next = await getAdminStats();
      setStats(next);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.status} ${e.message}`
          : e instanceof Error
            ? e.message
            : "failed to load stats";
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const pool = stats ? poolHealth(stats) : null;
  const sand = stats ? sandboxHealth(stats) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Capacity at a glance · polls every 5s
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load()}
          disabled={refreshing}
        >
          <RefreshCw
            className={cn(
              "mr-2 h-3.5 w-3.5",
              refreshing && "animate-spin",
            )}
          />
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading && !stats ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : null}

      {stats && pool && sand ? (
        <>
          {/* The two questions */}
          <div className="grid gap-3 sm:grid-cols-2">
            <HealthTile
              question="Enough warm containers?"
              health={pool.health}
              metric={`${stats.warm_pool.counts.warm}`}
              metricSub={`/ ${stats.warm_pool.configured_size} target`}
              subtitle={pool.subtitle}
            />
            <HealthTile
              question="Enough sandboxes?"
              health={sand.health}
              metric={`${stats.sessions.counts.ready + stats.sessions.counts.creating}`}
              metricSub="live"
              subtitle={sand.subtitle}
            />
          </div>

          {/* Single supporting visual */}
          <div className="mt-6 rounded-lg border border-border bg-card p-5">
            <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
              Warm pool capacity
            </div>
            <PoolBar
              warm={stats.warm_pool.counts.warm}
              provisioning={stats.warm_pool.counts.provisioning}
              target={stats.warm_pool.configured_size}
            />
          </div>

          {/* Everything else folded behind a disclosure. */}
          <details
            className="mt-6 rounded-lg border border-border bg-card"
            open={detailsOpen}
            onToggle={(e) =>
              setDetailsOpen((e.target as HTMLDetailsElement).open)
            }
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  !detailsOpen && "-rotate-90",
                )}
                aria-hidden
              />
              Details
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                per-agent · runtime · knobs
              </span>
            </summary>
            <div className="space-y-6 border-t border-border px-5 py-5 text-sm">
              {/* Per-agent warm pool */}
              {stats.warm_pool.by_agent.length > 0 ? (
                <section>
                  <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                    Warm pool by agent
                  </h3>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">
                            Agent
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            Warm
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            Provisioning
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.warm_pool.by_agent.map((row) => (
                          <tr
                            key={row.agent_id}
                            className="border-t border-border"
                          >
                            <td className="px-3 py-2">
                              <Link
                                href={`/agents/${row.agent_id}`}
                                className="hover:underline"
                              >
                                {row.agent_name ?? (
                                  <span className="font-mono text-xs text-muted-foreground">
                                    {row.agent_id.slice(0, 8)}
                                  </span>
                                )}
                              </Link>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {row.warm}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {row.provisioning}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              {/* Knobs */}
              <section>
                <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Knobs
                </h3>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <Knob
                    name="WARM_POOL_SIZE"
                    value={stats.warm_pool.configured_size}
                    hint="target warm tasks"
                  />
                  <Knob
                    name="WARM_POOL_MAX_PROVISIONING"
                    value={stats.warm_pool.max_provisioning}
                    hint="max concurrent fills"
                  />
                  <Knob
                    name="WARM_POOL_TTL_MINUTES"
                    value={stats.warm_pool.ttl_minutes}
                    hint="recycle older than"
                  />
                  <Knob
                    name="WARM_POOL_RECENT_AGENT_HOURS"
                    value={stats.warm_pool.recent_agent_hours}
                    hint="warm only for recent agents"
                  />
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  Read at process boot. Change in env, restart service. See{" "}
                  <code>src/server/warmPool/README.md</code>.
                </p>
              </section>

              {/* Runtime */}
              <section>
                <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Runtime
                </h3>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <KV label="Namespace" value={stats.runtime.namespace} />
                  <KV
                    label="Harness image"
                    value={stats.runtime.harness_image}
                    mono
                  />
                  <KV
                    label="NodePort range"
                    value={stats.runtime.nodeport_range}
                  />
                  <KV
                    label="Container port"
                    value={String(stats.runtime.container_port)}
                  />
                  <KV
                    label="Reconcile interval"
                    value={`${stats.runtime.reconcile_interval_seconds}s`}
                  />
                  <KV label="Total agents" value={String(stats.agents.total)} />
                </dl>
              </section>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

function Knob({
  name,
  value,
  hint,
}: {
  name: string;
  value: number;
  hint: string;
}) {
  return (
    <div>
      <div className="text-xs font-mono text-muted-foreground">{name}</div>
      <div className="flex items-baseline gap-2">
        <span className="tabular-nums text-foreground">{value}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
    </div>
  );
}

function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "break-all",
          mono ? "font-mono text-xs" : "text-sm",
        )}
      >
        {value}
      </div>
    </div>
  );
}
