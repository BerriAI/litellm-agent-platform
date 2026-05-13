"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, FileText, Loader2, Pencil, Play, Plus, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agent-avatar";
import { PfpUpload } from "@/components/pfp-upload";
import { CallAgentSnippets } from "@/components/call-agent-snippets";
import {
  AgentRow,
  ApiError,
  SessionRow,
  SkillRow,
  attachSkillToAgent,
  detachSkillFromAgent,
  getAgent,
  listSkills,
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
  const [showSkillModal, setShowSkillModal] = useState(false);
  const [skillTab, setSkillTab] = useState<"write" | "upload" | "existing">("write");
  const [skillDragOver, setSkillDragOver] = useState(false);
  const [skillUploading, setSkillUploading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillSaveToLibrary, setSkillSaveToLibrary] = useState(true);
  const [existingSkills, setExistingSkills] = useState<SkillRow[]>([]);
  // Write form
  const [skillWriteName, setSkillWriteName] = useState("");
  const [skillWriteDesc, setSkillWriteDesc] = useState("");
  const [skillWriteInstructions, setSkillWriteInstructions] = useState("");

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

  function parseSkillMd(text: string): { name: string; description: string; content: string } {
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!m) return { name: "Untitled skill", description: "", content: text };
    const fm = m[1];
    const body = m[2].trim();
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    return {
      name: nameMatch?.[1]?.trim() ?? "Untitled skill",
      description: descMatch?.[1]?.trim() ?? "",
      content: body,
    };
  }

  async function openSkillModal() {
    setSkillWriteName("");
    setSkillWriteDesc("");
    setSkillWriteInstructions("");
    setSkillTab("write");
    setShowSkillModal(true);
    try {
      setExistingSkills(await listSkills());
    } catch {
      // non-fatal
    }
  }

  async function handleSkillWrite() {
    if (!skillWriteInstructions.trim()) return;
    setSkillSaving(true);
    setError(null);
    try {
      await attachSkillInline(
        skillWriteInstructions.trim(),
        skillWriteName.trim(),
        skillWriteDesc.trim(),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSkillSaving(false);
    }
  }

  async function attachSkillById(skillId: string) {
    if (!agent) return;
    const result = await attachSkillToAgent(agent.id, { skill_id: skillId });
    setAgent(result.agent);
    setShowSkillModal(false);
  }

  async function attachSkillInline(content: string, name: string, description: string) {
    if (!agent) return;
    const result = await attachSkillToAgent(agent.id, {
      content,
      name: name || undefined,
      description: description || undefined,
      save_to_library: skillSaveToLibrary,
    });
    setAgent(result.agent);
    setShowSkillModal(false);
  }

  async function handleSkillFile(file: File) {
    if (!file.name.endsWith(".md")) {
      setError("Only .md files are supported");
      return;
    }
    setSkillUploading(true);
    setError(null);
    try {
      const text = await file.text();
      const { name, description, content } = parseSkillMd(text);
      await attachSkillInline(content, name, description);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSkillUploading(false);
    }
  }

  async function handleDetachSkill() {
    if (!agent) return;
    setError(null);
    try {
      const result = await detachSkillFromAgent(agent.id);
      setAgent(result.agent);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
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
                size="lg"
                variant="outline"
                onClick={() => router.push(`/agents/${id}/memory`)}
              >
                Memory
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => void openSkillModal()}
              >
                <FileText className="size-4" />
                {agent.prompt?.includes("<!-- skill -->") ? "Change skill" : "Add skill"}
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

              {/* System prompt + skill — split on the --- separator injected by selectTemplate */}
              {agent.prompt?.trim() ? (() => {
                const parts = agent.prompt.split(/\n<!-- skill -->\n/);
                const systemPrompt = parts[0]?.trim();
                const skill = parts[1]?.trim();
                return (
                  <>
                    <dt className="text-muted-foreground">System prompt</dt>
                    <dd>
                      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                        {systemPrompt}
                      </pre>
                    </dd>
                    {skill ? (
                      <>
                        <dt className="text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <span>Skill</span>
                            <button
                              type="button"
                              onClick={() => void handleDetachSkill()}
                              className="inline-flex items-center gap-0.5 rounded text-[10px] text-muted-foreground/60 hover:text-destructive focus-visible:outline-none"
                              title="Remove skill from agent"
                            >
                              <X className="size-2.5" />
                              detach
                            </button>
                          </div>
                        </dt>
                        <dd>
                          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                            {skill}
                          </pre>
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

          <div className="mt-8">
            <CallAgentSnippets agentId={agent.id} />
          </div>

          {/* Skill modal */}
          {showSkillModal ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <div className="w-full max-w-lg rounded-xl border bg-card shadow-xl">
                {/* Header */}
                <div className="flex items-center justify-between border-b px-6 py-4">
                  <h2 className="text-lg font-semibold">
                    {skillTab === "write" ? "Write skill instructions" : skillTab === "upload" ? "Upload skill" : "My skills"}
                  </h2>
                  <Button variant="ghost" size="sm" onClick={() => setShowSkillModal(false)} className="h-7 w-7 p-0">
                    <X className="size-4" />
                  </Button>
                </div>

                {/* Tabs */}
                <div className="flex border-b">
                  {(["write", "upload", "existing"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setSkillTab(t)}
                      className={`px-5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none ${
                        skillTab === t
                          ? "border-b-2 border-foreground text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t === "write" ? "Write" : t === "upload" ? "Upload .md" : "My skills"}
                    </button>
                  ))}
                </div>

                {/* Tab body */}
                <div className="px-6 py-5">
                  {skillTab === "write" ? (
                    <div className="space-y-4">
                      <div>
                        <label className="mb-1.5 block text-sm font-medium">Skill name</label>
                        <input
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          placeholder="e.g. code-reviewer"
                          value={skillWriteName}
                          onChange={(e) => setSkillWriteName(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-sm font-medium">Description</label>
                        <textarea
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          rows={2}
                          placeholder="What this skill does…"
                          value={skillWriteDesc}
                          onChange={(e) => setSkillWriteDesc(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-sm font-medium">Instructions</label>
                        <textarea
                          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          rows={8}
                          placeholder="Step-by-step instructions for the agent…"
                          value={skillWriteInstructions}
                          onChange={(e) => setSkillWriteInstructions(e.target.value)}
                        />
                      </div>
                    </div>
                  ) : skillTab === "upload" ? (
                    <>
                      <label
                        className={`flex h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors ${
                          skillDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-muted-foreground/60"
                        }`}
                        onDragOver={(e) => { e.preventDefault(); setSkillDragOver(true); }}
                        onDragLeave={() => setSkillDragOver(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setSkillDragOver(false);
                          const file = e.dataTransfer.files[0];
                          if (file) void handleSkillFile(file);
                        }}
                      >
                        <input
                          type="file"
                          accept=".md"
                          className="sr-only"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void handleSkillFile(file);
                          }}
                        />
                        <div className="flex size-9 items-center justify-center rounded-md border bg-muted">
                          <Plus className="size-4 text-muted-foreground" />
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {skillUploading ? "Uploading…" : "Drag and drop or click to upload"}
                        </span>
                      </label>
                      <div className="mt-4">
                        <p className="text-xs font-medium text-muted-foreground">File requirements</p>
                        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          <li>• <code className="font-mono">.md</code> file with optional YAML frontmatter</li>
                          <li>• Frontmatter <code className="font-mono">name:</code> / <code className="font-mono">description:</code> auto-extracted</li>
                        </ul>
                      </div>
                    </>
                  ) : (
                    <div>
                      {existingSkills.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">No saved skills yet.</p>
                      ) : (
                        <ul className="max-h-64 overflow-y-auto rounded-lg border divide-y">
                          {existingSkills.map((sk) => (
                            <li key={sk.id}>
                              <button
                                type="button"
                                onClick={() => void attachSkillById(sk.id)}
                                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted/50 transition-colors"
                              >
                                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-medium">{sk.name}</p>
                                  {sk.description ? (
                                    <p className="truncate text-xs text-muted-foreground">{sk.description}</p>
                                  ) : null}
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer — write tab only */}
                {skillTab === "write" ? (
                  <div className="flex items-center justify-between border-t px-6 py-4">
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <span
                        className={`grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors ${
                          skillSaveToLibrary ? "border-foreground bg-foreground text-background" : "border-border"
                        }`}
                        aria-hidden
                      >
                        {skillSaveToLibrary ? <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="2,6 5,9 10,3"/></svg> : null}
                      </span>
                      <input type="checkbox" className="sr-only" checked={skillSaveToLibrary}
                        onChange={(e) => setSkillSaveToLibrary(e.target.checked)} disabled={skillSaving} />
                      <span className="text-xs text-muted-foreground">Save to library</span>
                    </label>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setShowSkillModal(false)} disabled={skillSaving}>
                        Cancel
                      </Button>
                      <Button
                        onClick={() => void handleSkillWrite()}
                        disabled={skillSaving || !skillWriteInstructions.trim()}
                      >
                        {skillSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        Attach
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : !loading && !error ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Agent not found.
        </div>
      ) : null}
    </div>
  );
}
