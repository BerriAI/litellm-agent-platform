"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Plus } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AgentRow,
  SessionRow,
  listAgents,
  listSessions,
  ApiError,
} from "@/lib/api";

interface RowState {
  agent: AgentRow;
  active: boolean;
}

function formatCreated(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AgentsListPage() {
  const router = useRouter();
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentsRes, sessionsRes] = await Promise.all([
        listAgents(),
        listSessions(100),
      ]);
      const activeAgentIds = new Set<string>(
        sessionsRes.data
          .filter((s: SessionRow) => s.status === "ready")
          .map((s: SessionRow) => s.agent_id),
      );
      const next: RowState[] = agentsRes.data.map((a) => ({
        agent: a,
        active: activeAgentIds.has(a.id),
      }));
      setRows(next);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setError(msg);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">Agents</h1>
          <p className="text-sm tabular-nums text-muted-foreground">
            {rows.length}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => router.push("/agents/new")}
          >
            <Plus />
            New Agent
          </Button>
        </div>
      </div>

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
              <TableHead>Name</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={5}
                  className="h-32 text-center text-sm text-muted-foreground"
                >
                  No agents yet. Click + New Agent to create one.
                </TableCell>
              </TableRow>
            ) : (
              rows.map(({ agent, active }) => (
                <TableRow
                  key={agent.id}
                  onClick={() => router.push(`/agents/${agent.id}`)}
                  className="cursor-pointer hover:bg-muted/40"
                >
                  <TableCell>
                    <span
                      aria-label={active ? "active" : "inactive"}
                      title={active ? "active" : "inactive"}
                      className={
                        "inline-block size-2 rounded-full " +
                        (active ? "bg-emerald-500" : "bg-muted-foreground/40")
                      }
                    />
                  </TableCell>
                  <TableCell className="font-medium">{agent.name}</TableCell>
                  <TableCell>
                    {agent.config?.model ? (
                      <Badge variant="secondary" className="font-mono text-[11px]">
                        {agent.config.model}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {agent.id}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatCreated(agent.created_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
