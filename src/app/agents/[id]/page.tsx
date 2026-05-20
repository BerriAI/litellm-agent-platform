"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, FileText, Loader2, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AgentAvatar } from "@/components/agent-avatar";
import { ChannelsSection } from "@/components/channels-section";
import { ModelPicker } from "@/components/model-picker";
import { PfpUpload } from "@/components/pfp-upload";
import { CallAgentSnippets } from "@/components/call-agent-snippets";
import { EnvVarsEditor } from "@/components/env-vars-editor";
import { AgentAsToolPicker, type AgentToolSpec } from "@/components/agent-as-tool-picker";
import {
  AgentRow,
  ApiError,
  SessionRow,
  SkillRow,
  deleteAgent,
  getAgent,
  getSkill,
  listSessions,
  spawnSession,
  updateAgent,
} from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatRelative(iso?: string | null): string {
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
  return `${day}d ago`;
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ready") return "default";
  if (status === "creating") return "secondary";
  if (status === "failed") return "destructive";
  return "outline";
}

export default function AgentDetailPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);
  const [editingPfp, setEditingPfp] = useState(false);
  const [pfpSaving, setPfpSaving] = useState(false);
  // Cache of attached skill rows keyed by skill_id, for name display in chips.
  const [attachedSkills, setAttachedSkills] = useState<Record<string, SkillRow>>({});

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);

  const [agentToolsSaving, setAgentToolsSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, s] = await Promise.all([getAgent(id), listSessions(id)]);
      setAgent(a);
      setSessions(s);
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

  // Fetch SkillRow for each attached skill_id we haven't resolved yet.
  // Backend doesn't have a batch endpoint, so we fan out — fine for the
  // small N (a handful of skills per agent) this is realistically used for.
  useEffect(() => {
    const ids = agent?.attached_skill_ids ?? [];
    const missing = ids.filter((sid) => !attachedSkills[sid]);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const fetched = await Promise.all(
        missing.map((sid) =>
          getSkill(sid).then(
            (sk) => [sid, sk] as const,
            () => [sid, null] as const,
          ),
        ),
      );
      if (cancelled) return;
      setAttachedSkills((prev) => {
        const next = { ...prev };
        for (const [sid, sk] of fetched) {
          if (sk) next[sid] = sk;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [agent?.attached_skill_ids, attachedSkills]);

  async function handlePfpChange(next: string | null) {
    if (!agent) return;
    // Optimistic update — revert if PATCH fails.
    const prev = agent.pfp_url ?? null;
    setAgent({ ...agent, pfp_url: next });
    setPfpSaving(true);
    setError(null);
    try {
      const updated = await updateAgent(agent.id, {
        pfp_url: next ?? "",
      });
      setAgent(updated);
      setEditingPfp(false);
    } catch (e) {
      setAgent({ ...agent, pfp_url: prev });
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setPfpSaving(false);
    }
  }

  const handleEnvVarsSave = useCallback(
    async (next: Record<string, string>) => {
      if (!agent) return;
      setError(null);
      const updated = await updateAgent(agent.id, { env_vars: next });
      setAgent(updated);
    },
    [agent],
  );

  const handleAgentToolsSave = useCallback(
    async (tools: AgentToolSpec[]) => {
      if (!agent) return;
      setError(null);
      setAgentToolsSaving(true);
      try {
        const updated = await updateAgent(agent.id, { agent_tools: tools });
        setAgent(updated);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        setAgentToolsSaving(false);
      }
    },
    [agent],
  );

  function openEdit() {
    if (!agent) return;
    setEditName(agent.name ?? "");
    setEditModel(agent.model ?? "");
    // Show only the base system prompt — skill blocks stay in the full prompt
    // and are re-spliced on save so attachments are never lost.
    const SKILL_RE = /\n<!-- skill(?::[^\s>]+)? -->\n/;
    const systemPrompt = (agent.prompt ?? "").split(SKILL_RE)[0]?.trim() ?? "";
    setEditPrompt(systemPrompt);
    setEditOpen(true);
  }

  async function handleEditSave() {
    if (!agent || editSaving) return;
    setEditSaving(true);
    setError(null);
    try {
      // Re-splice skill blocks after the edited base prompt so attachments survive.
      const SKILL_RE = /(\n<!-- skill(?::[^\s>]+)? -->\n[\s\S]*)/;
      const skillSuffix = (agent.prompt ?? "").match(SKILL_RE)?.[1] ?? "";
      // When user clears the prompt, send "" explicitly so PATCH's
      // `if (body.prompt !== undefined)` guard actually fires and persists it.
      const mergedPrompt = editPrompt.trim()
        ? editPrompt.trim() + (skillSuffix || "")
        : skillSuffix || "";
      const updated = await updateAgent(agent.id, {
        name: editName.trim() || undefined,
        model: editModel.trim() || undefined,
        prompt: mergedPrompt,
      });
      setAgent(updated);
      setEditOpen(false);
    } catch (e) {
      setEditOpen(false);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDeleteAgent() {
    if (!agent || deleteInProgress) return;
    setDeleteInProgress(true);
    setError(null);
    try {
      await deleteAgent(agent.id);
      router.push("/agents");
    } catch (e) {
      setDeleteOpen(false);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setDeleteInProgress(false);
    }
  }

  async function handleSpawn() {
    if (!agent || spawning) return;
    setSpawning(true);
    setError(null);
    try {
      const session = await spawnSession(agent.id, {});
      router.push(`/sessions/${session.id}`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setError(msg);
      setSpawning(false);
    }
  }

  const displayName = agent?.name?.trim() || "Untitled agent";

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      {/* Breadcrumb + refresh */}
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => router.push("/agents")}
            className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Agents
          </button>
          <ChevronRight className="size-3" aria-hidden />
          <span className="truncate font-mono text-[11px] text-foreground">
            {agent?.id ?? id}
          </span>
        </nav>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading || spawning}
          aria-label="Refresh"
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {agent ? (
        <>
          {/* Hero */}
          <header className="mt-6 flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              <button
                type="button"
                onClick={() => setEditingPfp(true)}
                aria-label="Edit profile picture"
                className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <AgentAvatar
                  name={agent.name ?? agent.id}
                  pfpUrl={agent.pfp_url}
                  size={72}
                />
              </button>
              <div className="min-w-0">
                <h1
                  className={
                    "text-[26px] font-semibold tracking-tight leading-none " +
                    (agent.name?.trim() ? "" : "text-muted-foreground")
                  }
                >
                  {displayName}
                </h1>
                {agent.prompt?.trim() ? (
                  <p className="mt-2 line-clamp-2 max-w-[520px] text-[14px] text-muted-foreground">
                    {agent.prompt}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="font-mono text-[11px]">
                    {agent.model}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {agent.harness_id}
                  </Badge>
                  <span className="text-[12px] text-muted-foreground">
                    Created {formatTime(agent.created_at)}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDeleteOpen(true)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Delete agent"
              >
                <Trash2 className="size-4" />
              </Button>
              <Button size="lg" variant="outline" onClick={openEdit}>
                <Pencil className="size-4" />
                Edit
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => router.push(`/agents/${id}/memory`)}
              >
                Memory
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => router.push(`/agents/${id}/skills`)}
              >
                <FileText className="size-4" />
                Skills
              </Button>
              <Button
                size="lg"
                onClick={() => void handleSpawn()}
                disabled={spawning}
              >
                {spawning ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {spawning ? "Spawning…" : "Spawn session"}
              </Button>
            </div>
          </header>

          {editingPfp ? (
            <section className="mt-6 rounded-lg border bg-card/40 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                  Profile picture
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingPfp(false)}
                  disabled={pfpSaving}
                  className="h-7 px-2 text-muted-foreground hover:text-foreground"
                >
                  Done
                </Button>
              </div>
              <PfpUpload
                name={agent.name ?? agent.id}
                value={agent.pfp_url}
                onChange={(next) => void handlePfpChange(next)}
                disabled={pfpSaving}
              />
            </section>
          ) : null}

          {spawning ? (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Provisioning sandbox — typically a few seconds. Don&rsquo;t
              leave the page.
            </div>
          ) : null}

          {/* Configuration */}
          <section className="mt-8">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Configuration
            </h2>
            <dl className="grid gap-x-6 gap-y-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-[140px_1fr]">
              <dt className="text-muted-foreground">Harness</dt>
              <dd className="min-w-0">
                <span className="font-mono text-[13px]">
                  {agent.harness_id}
                </span>
              </dd>

              <dt className="text-muted-foreground">Branch</dt>
              <dd className="font-mono text-[13px]">{agent.branch}</dd>

              <dt className="text-muted-foreground">MCP servers</dt>
              <dd>
                {agent.mcp_servers && agent.mcp_servers.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {agent.mcp_servers.map((id) => (
                      <Badge
                        key={id}
                        variant="outline"
                        className="font-mono text-[11px]"
                      >
                        {id}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-[13px] text-muted-foreground">
                    None
                  </span>
                )}
              </dd>

              <dt className="text-muted-foreground">Env vars</dt>
              <dd className="min-w-0">
                <EnvVarsEditor
                  value={agent.env_vars}
                  onSave={handleEnvVarsSave}
                  onError={(msg) => setError(msg)}
                />
              </dd>

              <dt className="text-muted-foreground">Sub-agent tools</dt>
              <dd className="min-w-0">
                <AgentAsToolPicker
                  self_agent_id={agent.id}
                  value={agent.agent_tools ?? []}
                  disabled={agentToolsSaving}
                  onChange={(tools) => {
                    // Optimistic update
                    setAgent({ ...agent, agent_tools: tools });
                    void handleAgentToolsSave(tools);
                  }}
                />
              </dd>

              {agent.prompt?.trim() ? (() => {
                const systemPrompt = agent.prompt
                  .split(/\n<!-- skill(?::[^\s>]+)? -->\n/)[0]
                  ?.trim();
                const attachedIds = agent.attached_skill_ids ?? [];
                return (
                  <>
                    {systemPrompt ? (
                      <>
                        <dt className="text-muted-foreground">System prompt</dt>
                        <dd>
                          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                            {systemPrompt}
                          </pre>
                        </dd>
                      </>
                    ) : null}
                    {attachedIds.length > 0 ? (
                      <>
                        <dt className="text-muted-foreground">
                          {attachedIds.length === 1 ? "Skill" : "Skills"}
                        </dt>
                        <dd>
                          <div className="flex flex-wrap gap-1.5">
                            {attachedIds.map((sid) => {
                              const sk = attachedSkills[sid];
                              const label = sk?.name ?? `${sid.slice(0, 8)}…`;
                              return (
                                <button
                                  key={sid}
                                  type="button"
                                  onClick={() => router.push(`/agents/${id}/skills/${sid}`)}
                                  className="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-2.5 text-[12px] hover:bg-muted transition-colors"
                                >
                                  <FileText className="size-3 text-muted-foreground" />
                                  <span className="max-w-[200px] truncate">{label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </dd>
                      </>
                    ) : null}
                  </>
                );
              })() : null}

              <dt className="text-muted-foreground">Agent ID</dt>
              <dd className="font-mono text-[12px] text-muted-foreground break-all">
                {agent.id}
              </dd>
            </dl>
          </section>

          {/* Sessions */}
          <section className="mt-8">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Sessions
              </h2>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {sessions.length}
              </span>
            </div>
            {sessions.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-card/40 px-6 py-10 text-center text-sm text-muted-foreground">
                No sessions yet. Click <span className="font-medium text-foreground">Spawn session</span> above to start one.
              </div>
            ) : (
              <ul className="overflow-hidden rounded-lg border bg-card">
                {sessions.map((session, i) => (
                  <li
                    key={session.id}
                    onClick={() => router.push(`/sessions/${session.id}`)}
                    className={
                      "flex cursor-pointer items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50 " +
                      (i > 0 ? "border-t" : "")
                    }
                  >
                    <Badge variant={statusVariant(session.status)} className="shrink-0">
                      {session.status}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
                      {session.id}
                    </span>
                    <span className="shrink-0 tabular-nums text-[12px] text-muted-foreground">
                      {formatRelative(session.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <ChannelsSection agentId={agent.id} />

          <div className="mt-8">
            <CallAgentSnippets agentId={agent.id} />
          </div>

        </>
      ) : !loading && !error ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Agent not found.
        </div>
      ) : null}

      {/* Edit agent dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => { if (!open && !editSaving) setEditOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="code-reviewer"
                disabled={editSaving}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <ModelPicker value={editModel} onChange={setEditModel} disabled={editSaving} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-prompt">System prompt</Label>
              <Textarea
                id="edit-prompt"
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                rows={6}
                disabled={editSaving}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={() => void handleEditSave()} disabled={editSaving}>
              {editSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete agent confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!open && !deleteInProgress) setDeleteOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent</DialogTitle>
            <DialogDescription>
              Delete <span className="font-medium">{agent?.name?.trim() || "this agent"}</span>? All sessions will be permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteInProgress}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteAgent()} disabled={deleteInProgress}>
              {deleteInProgress ? "Deleting…" : "Delete agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
