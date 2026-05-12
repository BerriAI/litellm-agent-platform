"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronUp, ChevronDown, Plus, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/utils";
import { AgentRow, ApiError, listAgentsPaginated } from "@/lib/api";

const PAGE_SIZE = 50;

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
  return `${Math.floor(hr / 24)}d ago`;
}

type SortCol = "name" | "harness_id" | "sessions" | "created_at";
type SortDir = "asc" | "desc";

type HealthStatus = "ready" | "idle";

function HealthDot({ status }: { status: HealthStatus }) {
  return (
    <span
      aria-label={status}
      title={status}
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
        status === "ready" ? "bg-emerald-500" : "bg-muted-foreground/30",
      )}
    />
  );
}

function SortIcon({ col, sortCol, sortDir }: { col: SortCol; sortCol: SortCol; sortDir: SortDir }) {
  if (sortCol !== col) return <ChevronUp className="ml-1 inline size-3 opacity-0 group-hover:opacity-30" />;
  return sortDir === "asc"
    ? <ChevronUp className="ml-1 inline size-3 opacity-70" />
    : <ChevronDown className="ml-1 inline size-3 opacity-70" />;
}

export default function AgentsListPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("sessions");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (
    q: string, col: SortCol, dir: SortDir, pg: number,
  ) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const r = await listAgentsPaginated({
        search: q || undefined,
        sort: col,
        order: dir,
        limit: PAGE_SIZE,
        offset: pg * PAGE_SIZE,
        signal: abortRef.current?.signal,
      });
      setAgents(r.data);
      setTotal(r.total);
      setLoading(false);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(search, sortCol, sortDir, page);
  }, [load, search, sortCol, sortDir, page]);

  function handleSearchChange(q: string) {
    setInputValue(q);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      setSearch(q);
      setPage(0);
    }, 300);
  }

  function handleSort(col: SortCol) {
    const newDir = sortCol === col && sortDir === "desc" ? "asc" : "desc";
    setSortCol(col);
    setSortDir(newDir);
    setPage(0);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const thClass = "px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer select-none group hover:text-foreground transition-colors";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[18px] font-semibold tracking-tight">Agents</h1>
          {!loading && (
            <span className="text-[13px] text-muted-foreground tabular-nums">{total}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost" size="sm"
            onClick={() => void load(search, sortCol, sortDir, page)}
            disabled={loading}
            aria-label="Refresh"
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => router.push("/agents/new")}>
            <Plus className="size-4" /> New agent
          </Button>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b bg-muted/20 px-6 py-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search agents…"
            value={inputValue}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
          />
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {agents.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <p className="text-sm text-muted-foreground">
              {search ? "No agents match your search." : "No agents yet."}
            </p>
            {!search && (
              <Button size="sm" onClick={() => router.push("/agents/new")}>
                <Plus className="size-4" /> Create your first agent
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
                <th className={thClass} onClick={() => handleSort("harness_id")}>
                  Harness <SortIcon col="harness_id" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className={thClass} onClick={() => handleSort("sessions")}>
                  Sessions <SortIcon col="sessions" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className={thClass} onClick={() => handleSort("created_at")}>
                  Created <SortIcon col="created_at" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const sessionCount = agent.session_count ?? 0;
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
                          <HealthDot status={agent.has_active_session ? "ready" : "idle"} />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-foreground">
                            {agent.name?.trim() || <span className="italic text-muted-foreground">Untitled</span>}
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
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{sessionCount}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] tabular-nums text-muted-foreground">
                      {formatRelative(agent.created_at)}
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t px-6 py-3 text-[12px] text-muted-foreground">
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline" size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="h-7 px-3 text-[12px]"
            >
              ← Prev
            </Button>
            <Button
              variant="outline" size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1 || loading}
              className="h-7 px-3 text-[12px]"
            >
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
