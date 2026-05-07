"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AgentRow,
  ApiError,
  SessionRow,
  getAgent,
  listSessionsForAgent,
} from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

function maskKey(raw?: string): string {
  if (!raw) return "—";
  if (raw.length <= 8) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ready") return "default";
  if (status === "provisioning") return "secondary";
  if (status === "error") return "destructive";
  return "outline";
}

export default function AgentDetailPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, s] = await Promise.all([
        getAgent(id),
        listSessionsForAgent(id),
      ]);
      setAgent(a);
      setSessions(s.data);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="flex items-center justify-between">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to agents
        </Link>
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
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {agent ? (
        <>
          <div className="mt-6">
            <h1 className="text-[22px] font-semibold tracking-tight">
              {agent.name}
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {agent.id}
            </p>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>
                  Model, prompt, tools, and credentials.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    Model
                  </div>
                  <div className="font-mono text-sm">
                    {agent.config?.model ?? "—"}
                  </div>
                </div>

                <Separator />

                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    LiteLLM API key
                  </div>
                  <div className="font-mono text-sm">
                    {maskKey(agent.config?.litellm_api_key)}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    LiteLLM base URL
                  </div>
                  <div className="font-mono text-xs break-all">
                    {agent.config?.litellm_base_url ?? "—"}
                  </div>
                </div>

                <Separator />

                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    Tools
                  </div>
                  {agent.config?.tools && agent.config.tools.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {agent.config.tools.map((tool) => (
                        <Badge
                          key={tool}
                          variant="secondary"
                          className="font-mono text-[11px]"
                        >
                          {tool}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">None</div>
                  )}
                </div>

                <Separator />

                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    System prompt
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words font-mono">
                    {agent.config?.system_prompt ?? ""}
                  </pre>
                </div>

                <Separator />

                <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                  <span>Created {formatTime(agent.created_at)}</span>
                  <span>Updated {formatTime(agent.updated_at)}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Sessions</CardTitle>
                <CardDescription>
                  Running and past sessions for this agent.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {sessions.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    No sessions yet for this agent.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>ID</TableHead>
                        <TableHead>Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessions.map((session) => (
                        <TableRow
                          key={session.id}
                          onClick={() => router.push(`/sessions/${session.id}`)}
                          className="cursor-pointer hover:bg-muted/40"
                        >
                          <TableCell>
                            <Badge variant={statusVariant(session.status)}>
                              {session.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {session.id}
                          </TableCell>
                          <TableCell className="text-xs tabular-nums text-muted-foreground">
                            {formatTime(session.created_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : !loading && !error ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Agent not found.
        </div>
      ) : null}
    </div>
  );
}
