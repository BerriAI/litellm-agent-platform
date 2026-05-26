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
import { AgentAvatar } from "@/components/agent-avatar";
import { AutomationsSection } from "@/components/automations-section";
import { AutomationRunsSection } from "@/components/automation-runs-section";
import { ChannelsSection } from "@/components/channels-section";
import { EnvVarsEditor } from "@/components/env-vars-editor";
import { PfpUpload } from "@/components/pfp-upload";
import { CallAgentSnippets } from "@/components/call-agent-snippets";
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
  syncAgentTemplate,
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

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  const [setupScriptEditing, setSetupScriptEditing] = useState(false);
  const [setupScript, setSetupScript] = useState("");
  const [setupScriptSaving, setSetupScriptSaving] = useState(false);

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

  function currentSetupScript(a: typeof agent): string {
    const entry = (a?.sandbox_files ?? []).find((f) => f.name === "setup.sh");
    if (!entry) return "";
    try {
      const bytes = Uint8Array.from(atob(entry.content), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch { return entry.content; }
  }

  function openSetupScriptEditor() {
    setSetupScript(currentSetupScript(agent));
    setSetupScriptEditing(true);
  }

  async function handleSetupScriptSave() {
    if (!agent || setupScriptSaving) return;
    setSetupScriptSaving(true);
    setError(null);
    try {
      const existing = (agent.sandbox_files ?? []).filter((f) => f.name !== "setup.sh");
      const encoded = btoa(unescape(encodeURIComponent(setupScript)));
      const files = setupScript.trim()
        ? [...existing, { name: "setup.sh", sandbox_path: "/lap/setup.sh", content: encoded, content_type: "application/x-sh", size: new TextEncoder().encode(setupScript).length }]
        : existing;
      const updated = await updateAgent(agent.id, { sandbox_files: files });
      setAgent(updated);
      setSetupScriptEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSetupScriptSaving(false);
    }
  }

  async function handleTemplateSync() {
    if (!agent || syncing) return;
    setSyncing(true);
    try {
      await syncAgentTemplate(id);
      const updated = await getAgent(id);
      setAgent(updated);
      setSyncOpen(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setSyncing(false);
    }
  }

  function computeLineDiff(
    oldText: string,
    newText: string,
  ): Array<{ type: "add" | "remove" | "same"; line: string }> {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    // Myers LCS — build dp table
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    const result: Array<{ type: "add" | "remove" | "same"; line: string }> = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && a[i] === b[j]) {
        result.push({ type: "same", line: a[i++] }); j++;
      } else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) {
        result.push({ type: "add", line: b[j++] });
      } else {
        result.push({ type: "remove", line: a[i++] });
      }
    }
    return result;
  }

  // Collapse unchanged runs to 3 context lines around each hunk
  function collapseContext(
    diff: Array<{ type: "add" | "remove" | "same"; line: string }>,
    ctx = 3,
  ): Array<{ type: "add" | "remove" | "same" | "ellipsis"; line: string }> {
    const result: Array<{ type: "add" | "remove" | "same" | "ellipsis"; line: string }> = [];
    let i = 0;
    while (i < diff.length) {
      if (diff[i].type !== "same") { result.push(diff[i++]); continue; }
      const start = i;
      while (i < diff.length && diff[i].type === "same") i++;
      const end = i;
      const len = end - start;
      if (len <= ctx * 2) { for (let k = start; k < end; k++) result.push(diff[k]); continue; }
      for (let k = start; k < start + ctx; k++) result.push(diff[k]);
      result.push({ type: "ellipsis", line: `… ${len - ctx * 2} unchanged lines` });
      for (let k = end - ctx; k < end; k++) result.push(diff[k]);
    }
    return result;
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
          <span className="truncate text-[13px] text-foreground">
            {agent?.name?.trim() || (agent?.id ?? id).slice(0, 8)}
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
          {/* Template update banner — shown below breadcrumb when out of sync */}
          {agent.template_id && !agent.template_in_sync && (
            <div className="mt-4 flex items-center gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <RefreshCw className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <p className="flex-1 text-[13px] text-amber-800 dark:text-amber-300">
                A new version of <span className="font-medium">{agent.template_id}</span> is available (v{agent.template_version} → v{agent.template_latest_version}). Review changes before updating.
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSyncOpen(true)}
                  className="border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                >
                  View changes
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleTemplateSync()}
                  disabled={syncing}
                  className="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
                >
                  {syncing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Update now
                </Button>
              </div>
            </div>
          )}

          {/* Hero */}
          <header className="mt-6 flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
            {/* Left — avatar + identity */}
            <div className="flex min-w-0 flex-1 items-start gap-4">
              <button
                type="button"
                onClick={() => setEditingPfp(true)}
                aria-label="Edit profile picture"
                className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <AgentAvatar
                  name={agent.name ?? agent.id}
                  pfpUrl={agent.pfp_url}
                  size={48}
                />
              </button>
              <div className="min-w-0 flex-1">
                <h1
                  className={
                    "truncate text-[22px] font-semibold tracking-tight leading-tight " +
                    (agent.name?.trim() ? "" : "text-muted-foreground")
                  }
                >
                  {displayName}
                </h1>
                {agent.prompt?.trim() ? (
                  <p className="mt-1 line-clamp-1 text-[13px] text-muted-foreground">
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
                  {agent.template_id && (
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {agent.template_id} v{agent.template_version ?? "?"}
                    </Badge>
                  )}
                  <span className="whitespace-nowrap text-[12px] text-muted-foreground">
                    · Created {formatTime(agent.created_at)}
                  </span>
                </div>
              </div>
            </div>

            {/* Right — actions */}
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
              <Button size="sm" variant="outline" onClick={() => router.push(`/agents/${id}/edit`)}>
                <Pencil className="size-4" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push(`/agents/${id}/memory`)}
              >
                Memory
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push(`/agents/${id}/skills`)}
              >
                <FileText className="size-4" />
                Skills
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push(`/agents/${id}/issues`)}
              >
                Issues
              </Button>
              <Button
                size="sm"
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

              {agent.repo_url && /^https?:\/\//i.test(agent.repo_url) ? (
                <>
                  <dt className="text-muted-foreground">Repo</dt>
                  <dd className="min-w-0 font-mono text-[13px] break-all">
                    <a
                      href={agent.repo_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {agent.repo_url}
                    </a>
                  </dd>
                </>
              ) : null}

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

              <dt className="pt-1 text-muted-foreground">Env vars</dt>
              <dd className="min-w-0">
                <EnvVarsEditor
                  value={agent.env_vars}
                  onSave={handleEnvVarsSave}
                  onError={(msg) => setError(msg)}
                />
              </dd>

              <dt className="pt-1 text-muted-foreground">Setup script</dt>
              <dd className="min-w-0">
                {setupScriptEditing ? (
                  <div className="space-y-2">
                    <textarea
                      value={setupScript}
                      onChange={(e) => setSetupScript(e.target.value)}
                      rows={8}
                      disabled={setupScriptSaving}
                      className="w-full rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                      placeholder={"#!/usr/bin/env bash\n# Runs in the E2B sandbox at provision time.\n# Write env vars to /tmp/lap_env:\n# echo \"DATABASE_URL=...\" >> /tmp/lap_env"}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void handleSetupScriptSave()} disabled={setupScriptSaving}>
                        {setupScriptSaving ? "Saving…" : "Save"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setSetupScriptEditing(false)} disabled={setupScriptSaving}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  (() => {
                    const script = currentSetupScript(agent);
                    return (
                      <div className="flex items-start gap-2">
                        {script ? (
                          <pre className="max-h-32 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                            {script}
                          </pre>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">None</span>
                        )}
                        <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={openSetupScriptEditor}>
                          <Pencil className="size-3.5" />
                        </Button>
                      </div>
                    );
                  })()
                )}
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

          <AutomationsSection agentId={agent.id} />

          <AutomationRunsSection agentId={agent.id} />

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

      {/* Template sync — overlay diff panel */}
      {syncOpen && agent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setSyncOpen(false); }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

          {/* Panel */}
          <div className="relative flex h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-[15px] font-semibold tracking-tight">Template update</h2>
                <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                  {agent.template_id} &nbsp;v{agent.template_version ?? "?"} → v{agent.template_latest_version}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setSyncOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void handleTemplateSync()} disabled={syncing}>
                  {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  Update to v{agent.template_latest_version}
                </Button>
              </div>
            </div>

            {/* Legend */}
            <div className="flex shrink-0 items-center gap-4 border-b bg-muted/20 px-6 py-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500/30" />
                Added
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-500/30" />
                Removed
              </span>
            </div>

            {/* Diff body */}
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const raw = computeLineDiff(agent.template_prompt ?? "", agent.template_latest_prompt ?? "");
                const hasChanges = raw.some((c) => c.type !== "same");
                const chunks = collapseContext(raw);
                return hasChanges ? (
                  <div className="font-mono text-[13px] leading-[1.7]">
                    {chunks.map((chunk, i) => (
                      <div
                        key={i}
                        className={
                          chunk.type === "add"
                            ? "flex gap-3 bg-emerald-500/10 px-6 py-px text-emerald-700 dark:text-emerald-400"
                            : chunk.type === "remove"
                            ? "flex gap-3 bg-red-500/10 px-6 py-px text-red-700 dark:text-red-400"
                            : chunk.type === "ellipsis"
                            ? "border-y bg-muted/40 px-6 py-2 text-[11px] text-muted-foreground/50 select-none"
                            : "flex gap-3 px-6 py-px text-muted-foreground/70"
                        }
                      >
                        {chunk.type !== "ellipsis" && (
                          <span className="w-4 shrink-0 select-none opacity-40">
                            {chunk.type === "add" ? "+" : chunk.type === "remove" ? "-" : " "}
                          </span>
                        )}
                        {chunk.type !== "ellipsis" && (
                          <span className="min-w-0 whitespace-pre-wrap break-words">{chunk.line || " "}</span>
                        )}
                        {chunk.type === "ellipsis" && chunk.line}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-[14px] text-muted-foreground">
                    No prompt changes detected.
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
