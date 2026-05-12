"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronUp, ChevronDown, Plus, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/utils";
import {
  AgentRow,
  ApiError,
  SessionRow,
  listAgents,
  listSessions,
} from "@/lib/api";

function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

type HealthStatus = "ready" | "creating" | "failed" | "idle";
type SortCol = "name" | "harness" | "sessions" | "lastActive";
type SortDir = "asc" | "desc";

function agentHealth(sessions: SessionRow[]): HealthStatus {
  if (sessions.length === 0) return "idle";
  if (sessions.some((s) => s.status === "ready")) return "ready";
  if (sessions.some((s) => s.status === "creating")) return "creating";
  if (sessions.every((s) => s.status === "failed" || s.status === "dead"))
    return "failed";
  return "idle";
}

function agentLastActiveMs(sessions: SessionRow[], agent: AgentRow): number {
  const times = sessions
    .map((s) => s.created_at)
    .filter((t): t is string => !!t)
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t));
  if (times.length > 0) return Math.max(...times);
  const fallback = agent.created_at ? new Date(agent.created_at).getTime() : 0;
  return Number.isNaN(fallback) ? 0 : fallback;
}

function agentLastActive(sessions: SessionRow[], agent: AgentRow): string | null {
  const ms = agentLastActiveMs(sessions, agent);
  return ms ? new Date(ms).toISOString() : null;
}

function HealthDot({ status }: { status: HealthStatus }) {
  return (
    <span
      aria-label={status}
      title={status}
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
        status === "ready" && "bg-emerald-500",
        status === "creating" && "bg-amber-400",
        status === "failed" && "bg-red-500",
        status === "idle" && "bg-muted-foreground/30",
      )}
    />
  );
}

function SortIcon({ col, sortCol, sortDir }: { col: SortCol; sortCol: SortCol | null; sortDir: SortDir }) {
  if (sortCol !== col) return <ChevronUp className="ml-1 inline size-3 opacity-0 group-hover:opacity-30" />;
  return sortDir === "asc"
    ? <ChevronUp className="ml-1 inline size-3 opacity-70" />
    : <ChevronDown className="ml-1 inline size-3 opacity-70" />;
}

export default function AgentsListPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [harnessFilter, setHarnessFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol | null>("lastActive");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, s] = await Promise.all([listAgents(), listSessions()]);
      setAgents(a);
      setSessions(s);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sessionsByAgent = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const list = m.get(s.agent_id) ?? [];
      list.push(s);
      m.set(s.agent_id, list);
    }
    return m;
  }, [sessions]);

  const harnesses = useMemo(
    () => [...new Set(agents.map((a) => a.harness_id).filter(Boolean))].sort(),
    [agents],
  );

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = agents.filter((a) => {
      if (harnessFilter && a.harness_id !== harnessFilter) return false;
      if (!q) return true;
      return (
        a.id.toLowerCase().includes(q) ||
        (a.name ?? "").toLowerCase().includes(q) ||
        a.harness_id.toLowerCase().includes(q)
      );
    });

    if (!sortCol) return base;

    return [...base].sort((a, b) => {
      const aSessions = sessionsByAgent.get(a.id) ?? [];
      const bSessions = sessionsByAgent.get(b.id) ?? [];
      let cmp = 0;
      switch (sortCol) {
        case "name":
          cmp = (a.name ?? a.id).localeCompare(b.name ?? b.id);
          break;
        case "harness":
          cmp = a.harness_id.localeCompare(b.harness_id);
          break;
        case "sessions":
          cmp = aSessions.length - bSessions.length;
          break;
        case "lastActive":
          cmp = agentLastActiveMs(aSessions, a) - agentLastActiveMs(bSessions, b);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [agents, search, harnessFilter, sortCol, sortDir, sessionsByAgent]);

  const thClass = "px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer select-none group hover:text-foreground transition-colors";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[18px] font-semibold tracking-tight">Agents</h1>
          {!loading && (
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {agents.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => router.push("/agents/new")}>
            <Plus className="size-4" />
            New agent
          </Button>
        </div>
      </header>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b bg-muted/20 px-6 py-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search agents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
          />
        </div>
        {harnesses.length > 1 && (
          <select
            value={harnessFilter}
            onChange={(e) => setHarnessFilter(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All harnesses</option>
            {harnesses.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <p className="text-sm text-muted-foreground">
              {search || harnessFilter ? "No agents match your filters." : "No agents yet."}
            </p>
            {!search && !harnessFilter && (
              <Button size="sm" onClick={() => router.push("/agents/new")}>
                <Plus className="size-4" />
                Create your first agent
              </Button>
            )}
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b bg-muted/20">
                <th
                  className={thClass}
                  style={{ paddingLeft: "calc(1.5rem + 28px + 12px)" }}
                  onClick={() => handleSort("name")}
                >
                  Agent <SortIcon col="name" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className={thClass} onClick={() => handleSort("harness")}>
                  Harness <SortIcon col="harness" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className={thClass} onClick={() => handleSort("sessions")}>
                  Sessions <SortIcon col="sessions" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className={thClass} onClick={() => handleSort("lastActive")}>
                  Last active <SortIcon col="lastActive" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((agent) => {
                const agentSessions = sessionsByAgent.get(agent.id) ?? [];
                const health = agentHealth(agentSessions);
                const lastActive = agentLastActive(agentSessions, agent);
                return (
                  <tr
                    key={agent.id}
                    onClick={() => router.push(`/agents/${agent.id}`)}
                    className="cursor-pointer border-b transition-colors hover:bg-muted/40"
                  >
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <div className="relative shrink-0">
                          <AgentAvatar name={agent.name ?? agent.id} pfpUrl={agent.pfp_url} size={28} />
                          <HealthDot status={health} />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-foreground">
                            {agent.name?.trim() ? agent.name.trim() : (
                              <span className="italic text-muted-foreground">Untitled</span>
                            )}
                          </div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground/60">
                            {agent.id.slice(0, 8)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] text-muted-foreground">{agent.harness_id}</span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {agentSessions.length}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] tabular-nums text-muted-foreground">
                      {formatRelative(lastActive)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronRight className="size-4 text-muted-foreground/40" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
