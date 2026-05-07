"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  AgentRow,
  ApiError,
  SessionRow,
  listAgents,
  listSessions,
} from "@/lib/api";

const POLL_INTERVAL_MS = 5000;
const ID_TRUNCATE_LIMIT = 22;
const ALL_FILTER = "__all__";

function statusDotClass(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "provisioning":
    case "pending":
      return "bg-amber-500";
    case "error":
    case "failed":
      return "bg-red-500";
    case "terminated":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground";
  }
}

function truncateId(id: string): string {
  if (id.length <= ID_TRUNCATE_LIMIT) return id;
  return `${id.slice(0, ID_TRUNCATE_LIMIT)}…`;
}

function formatRelative(iso: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

export default function SessionsListPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>(ALL_FILTER);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sessionsRes, agentsRes] = await Promise.all([
        listSessions(100),
        listAgents(),
      ]);
      setSessions(sessionsRes.data);
      setAgents(agentsRes.data);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [load]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) {
      map.set(a.id, a.name);
    }
    return map;
  }, [agents]);

  const agentChips = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of sessions) {
      if (seen.has(s.agent_id)) continue;
      const name =
        agentNameById.get(s.agent_id) ?? s.agent_name ?? s.agent_id;
      seen.set(s.agent_id, name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [sessions, agentNameById]);

  const filteredSessions = useMemo(() => {
    if (activeFilter === ALL_FILTER) return sessions;
    return sessions.filter((s) => s.agent_id === activeFilter);
  }, [sessions, activeFilter]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">Sessions</h1>
          <p className="text-sm tabular-nums text-muted-foreground">
            {sessions.length}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh sessions"
        >
          <RefreshCw className={loading ? "animate-spin" : ""} aria-hidden />
          Refresh
        </Button>
      </header>

      {agentChips.length > 0 ? (
        <div className="mt-6 flex flex-wrap items-center gap-1.5">
          <FilterChip
            label="All"
            count={sessions.length}
            active={activeFilter === ALL_FILTER}
            onClick={() => setActiveFilter(ALL_FILTER)}
          />
          {agentChips.map((chip) => (
            <FilterChip
              key={chip.id}
              label={chip.name}
              count={sessions.filter((s) => s.agent_id === chip.id).length}
              active={activeFilter === chip.id}
              onClick={() => setActiveFilter(chip.id)}
            />
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Status</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Sandbox</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredSessions.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  {sessions.length === 0
                    ? "No sessions yet. Create an agent and start a session to see it here."
                    : "No sessions match this filter."}
                </TableCell>
              </TableRow>
            ) : (
              filteredSessions.map((s) => {
                const agentName =
                  agentNameById.get(s.agent_id) ?? s.agent_name ?? s.agent_id;
                return (
                  <TableRow
                    key={s.id}
                    onClick={() => router.push(`/sessions/${s.id}`)}
                    className="cursor-pointer hover:bg-muted/40"
                  >
                    <TableCell>
                      <span
                        aria-label={`status ${s.status}`}
                        title={s.status}
                        className={`inline-block size-1.5 rounded-full ${statusDotClass(s.status)}`}
                      />
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs text-foreground"
                      title={s.id}
                    >
                      {truncateId(s.id)}
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/agents/${s.agent_id}`);
                        }}
                        className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                      >
                        {agentName}
                      </button>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {s.sandbox?.type ?? "—"}
                      {s.sandbox?.size ? ` · ${s.sandbox.size}` : ""}
                    </TableCell>
                    <TableCell className="tabular-nums text-sm text-muted-foreground">
                      {formatRelative(s.created_at)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface FilterChipProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function FilterChip({ label, count, active, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none " +
        (active
          ? "border-border bg-accent text-foreground"
          : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground")
      }
    >
      <span className="font-medium">{label}</span>
      <span
        className={
          "tabular-nums text-[11px] " +
          (active ? "text-muted-foreground" : "text-muted-foreground/70")
        }
      >
        {count}
      </span>
    </button>
  );
}
