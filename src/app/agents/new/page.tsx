"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, Loader2, Plus, Trash2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { PfpUpload } from "@/components/pfp-upload";
import { HarnessPicker, DEFAULT_HARNESS_ID } from "@/components/harness-picker";
import { ModelPicker } from "@/components/model-picker";
import { McpToolsPicker, EnabledTools, EnabledToolsUpdater } from "@/components/mcp-tools-picker";
import { SANDBOX_TEMPLATES_STORAGE_KEY } from "@/lib/constants";
import {
  AgentTemplate,
  ApiError,
  McpAllowedTools,
  SkillRow,
  createAgent,
  createSkill,
  getPreinstalledGithubRepo,
  listSkills,
  listTemplates,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const NAME_MAX = 64;

interface SandboxTemplate {
  id: string;
  name: string;
  repo_url?: string;
  env_vars?: Record<string, string>;
  allow_out?: string[];
  deny_out?: string[];
}

export default function NewAgentPage() {
  const router = useRouter();

  // "blank" = no template; any other string = template id
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("blank");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [activeTemplateTab, setActiveTemplateTab] = useState<"overview" | "skill" | "prompt">("overview");
  // Per-template skill edits — keyed by template id
  const [skillEdits, setSkillEdits] = useState<Record<string, string>>({});

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const currentSkill = selectedTemplate
    ? (skillEdits[selectedTemplate.id] ?? selectedTemplate.skill)
    : "";

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Sandbox templates (repo + env var keys) from localStorage
  const [sandboxTemplates, setSandboxTemplates] = useState<SandboxTemplate[]>([]);
  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SANDBOX_TEMPLATES_STORAGE_KEY);
      if (raw) setSandboxTemplates(JSON.parse(raw) as SandboxTemplate[]);
    } catch { /* ignore */ }
  }, []);

  function applySandboxTemplate(id: string | null) {
    setSelectedSandboxId(id === selectedSandboxId ? null : id);
  }

  // Selecting a template immediately pre-fills the form fields.
  function selectTemplate(id: string) {
    setSelectedTemplateId(id);
    setActiveTemplateTab("overview");
    const t = templates.find((t) => t.id === id);
    if (t) {
      setName(t.name);
      setHarnessId(t.harness_id);
      setModel(t.model);
      setSystemPrompt(
        skillEdits[t.id] !== undefined
          ? `${t.prompt}\n\n<!-- skill -->\n\n${skillEdits[t.id]}`
          : `${t.prompt}\n\n<!-- skill -->\n\n${t.skill}`,
      );
    } else {
      // blank
      setName("");
      setHarnessId(DEFAULT_HARNESS_ID);
      setModel(DEFAULT_MODEL);
      setSystemPrompt("");
    }
  }

  const [name, setName] = useState("");
  const [harnessId, setHarnessId] = useState<string>(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [branchOverride, setBranchOverride] = useState("");
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);

  const [preinstalledRepo, setPreinstalledRepo] = useState<string>("");
  const [enabledTools, setEnabledTools] = useState<EnabledTools>(new Map());
  const [mcpToolTotals, setMcpToolTotals] = useState<Map<string, number>>(new Map());
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Env vars: list of [key, value] pairs for the editor UI.
  const [envVars, setEnvVars] = useState<[string, string][]>([["", ""]]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline skill section
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillSaveToLibrary, setSkillSaveToLibrary] = useState(true);
  // null = hidden, "write" = inline form, "pick" = pick from library modal
  const [skillMode, setSkillMode] = useState<null | "write" | "pick">(null);
  const [skillDragOver, setSkillDragOver] = useState(false);
  const [librarySkills, setLibrarySkills] = useState<SkillRow[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);

  async function openPickSkill() {
    setSkillMode("pick");
    setLoadingLibrary(true);
    try {
      setLibrarySkills(await listSkills());
    } catch {
      // non-fatal
    } finally {
      setLoadingLibrary(false);
    }
  }

  function parseSkillMd(text: string): { name: string; description: string; content: string } {
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!m) return { name: "", description: "", content: text.trim() };
    const fm = m[1];
    const body = m[2].trim();
    return {
      name: fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "",
      description: fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "",
      content: body,
    };
  }

  function handleSkillMdFile(file: File) {
    if (!file.name.endsWith(".md")) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== "string") return;
      const { name, description, content } = parseSkillMd(text);
      setSkillName(name);
      setSkillDesc(description);
      setSkillInstructions(content);
      setSkillMode("write");
    };
    reader.readAsText(file);
  }

  function clearSkill() {
    setSkillName("");
    setSkillDesc("");
    setSkillInstructions("");
    setSkillMode(null);
  }

  useEffect(() => {
    let cancelled = false;
    getPreinstalledGithubRepo()
      .catch(() => "")
      .then((repo) => { if (!cancelled) setPreinstalledRepo(repo); })
      .catch((e) => { if (!cancelled) setMetaError(e instanceof ApiError ? e.message : (e as Error).message); })
      .finally(() => { if (!cancelled) setLoadingMeta(false); });
    return () => { cancelled = true; };
  }, []);

  function parseEnvFile(text: string): [string, string][] {
    const pairs: [string, string][] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip surrounding quotes (single or double)
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key) pairs.push([key, val]);
    }
    return pairs;
  }

  function handleEnvFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== "string") return;
      const parsed = parseEnvFile(text);
      if (parsed.length === 0) return;
      setEnvVars((prev) => {
        // Merge: keep existing non-empty rows, append parsed, then add blank row
        const existing = prev.filter(([k]) => k.trim() !== "");
        const merged = [...existing, ...parsed, ["", ""] as [string, string]];
        return merged;
      });
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function setEnvKey(idx: number, key: string) {
    setEnvVars((prev) => prev.map((p, i) => (i === idx ? [key, p[1]] : p)));
  }
  function setEnvVal(idx: number, val: string) {
    setEnvVars((prev) => prev.map((p, i) => (i === idx ? [p[0], val] : p)));
  }
  function addEnvRow() {
    setEnvVars((prev) => [...prev, ["", ""]]);
  }
  function removeEnvRow(idx: number) {
    setEnvVars((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length === 0 ? [["", ""]] : next;
    });
  }

  function validate(): string | null {
    const trimmedName = name.trim();
    if (trimmedName.length > NAME_MAX) {
      return `Name must be ${NAME_MAX} characters or fewer.`;
    }
    if (!model.trim()) return "Model is required.";
    return null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      // Walk per-server tool selections. A server is "enabled" iff it has at
      // least one tool checked. If every tool of a (fully-loaded) server is
      // checked, send no whitelist — that lets the agent see future tools
      // added on that server without re-saving. If only a subset is checked,
      // send `mcp_allowed_tools` so the proxy can filter.
      const mcpServers: string[] = [];
      const mcpAllowedTools: McpAllowedTools[] = [];
      for (const [serverId, toolSet] of enabledTools.entries()) {
        if (toolSet.size === 0) continue;
        mcpServers.push(serverId);
        const total = mcpToolTotals.get(serverId);
        // Only emit the whitelist when user selected a strict subset.
        if (total === undefined || toolSet.size < total) {
          mcpAllowedTools.push({
            server_id: serverId,
            tools: Array.from(toolSet).sort(),
          });
        }
      }

      const envVarsRecord: Record<string, string> = {};
      for (const [k, v] of envVars) {
        const key = k.trim();
        if (key) envVarsRecord[key] = v;
      }

      // If a template is selected and the user edited the skill panel, merge the
      // edited skill back into the current systemPrompt value. We split on the
      // <!-- skill --> separator so that any edits the user made to the base-prompt
      // portion of the textarea are preserved — never fall back to the original
      // template text.
      let finalPrompt = systemPrompt.trim() || undefined;
      if (selectedTemplate) {
        const editedSkill = skillEdits[selectedTemplate.id];
        if (editedSkill !== undefined) {
          const SEPARATOR = "<!-- skill -->";
          const separatorIdx = systemPrompt.indexOf(SEPARATOR);
          const basePrompt =
            separatorIdx >= 0
              ? systemPrompt.slice(0, separatorIdx).trimEnd()
              : systemPrompt.trimEnd();
          finalPrompt =
            `${basePrompt}\n\n${SEPARATOR}\n\n${editedSkill}`.trim() || undefined;
        }
      }

      // Merge inline skill into prompt
      if (skillInstructions.trim()) {
        const base = (finalPrompt ?? "").trimEnd();
        finalPrompt = base
          ? `${base}\n<!-- skill -->\n${skillInstructions.trim()}`
          : skillInstructions.trim();
        if (skillSaveToLibrary && skillName.trim()) {
          createSkill({
            name: skillName.trim(),
            description: skillDesc.trim() || undefined,
            content: skillInstructions.trim(),
          }).catch(() => {});
        }
      }

      const sandboxTpl = sandboxTemplates.find((s) => s.id === selectedSandboxId);
      const created = await createAgent({
        name: name.trim() || undefined,
        model: model.trim(),
        prompt: finalPrompt,
        harness_id: harnessId,
        requirements: selectedTemplate?.requirements ?? undefined,
        repo_url: sandboxTpl?.repo_url || undefined,
        branch: branchOverride.trim() || undefined,
        pfp_url: pfpUrl ?? undefined,
        mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
        mcp_allowed_tools:
          mcpAllowedTools.length > 0 ? mcpAllowedTools : undefined,
        env_vars: Object.keys(envVarsRecord).length > 0 ? envVarsRecord : undefined,
        allow_out: sandboxTpl?.allow_out,
        deny_out: sandboxTpl?.deny_out,
      });
      router.push(`/agents/${created.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-[22px] font-semibold tracking-tight">New Agent</h1>

      {/* Template strip — only shown when templates exist */}
      {templates.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Templates
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {/* Blank — pre-selected */}
            <button
              type="button"
              onClick={() => selectTemplate("blank")}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors hover:bg-accent/40",
                selectedTemplateId === "blank"
                  ? "border-foreground bg-accent/30"
                  : "border-dashed border-border",
              )}
            >
              <div className="text-lg">✦</div>
              <div className="mt-1.5 text-[13px] font-semibold">Blank</div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">Start from scratch.</div>
            </button>

            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTemplate(t.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors hover:bg-accent/40",
                  selectedTemplateId === t.id
                    ? "border-foreground bg-accent/30"
                    : "border-border bg-card",
                )}
              >
                <div className="text-lg">{t.icon}</div>
                <div className="mt-1.5 text-[13px] font-semibold">{t.name}</div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">{t.description}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.tags.map((tag) => (
                    <span key={tag} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>

          {/* Template detail — tools/skill/prompt tabs, only for non-blank */}
          {selectedTemplate && (
            <Card className="overflow-hidden">
              <div className="flex border-b text-[13px]">
                {(["overview", "skill", "prompt"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTemplateTab(tab)}
                    className={cn(
                      "px-4 py-2 font-medium capitalize transition-colors hover:text-foreground",
                      activeTemplateTab === tab
                        ? "border-b-2 border-foreground text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <CardContent className="pt-4">
                {activeTemplateTab === "overview" && (
                  <div className="space-y-3 text-[13px]">
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Tools</p>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedTemplate.tools.map((tool) => (
                          <span key={tool} className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[12px]">
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Skill</p>
                      <div className="flex items-center gap-2">
                        <span className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[12px]">
                          {selectedTemplate.skill_name}
                        </span>
                        <button
                          type="button"
                          onClick={() => setActiveTemplateTab("skill")}
                          className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          Edit →
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {activeTemplateTab === "skill" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[13px] font-semibold">{selectedTemplate.skill_name}</p>
                      <button
                        type="button"
                        onClick={() =>
                          setSkillEdits((prev) => {
                            const next = { ...prev };
                            delete next[selectedTemplate.id];
                            return next;
                          })
                        }
                        className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Reset
                      </button>
                    </div>
                    <Textarea
                      value={currentSkill}
                      onChange={(e) =>
                        setSkillEdits((prev) => ({
                          ...prev,
                          [selectedTemplate.id]: e.target.value,
                        }))
                      }
                      className="min-h-[240px] font-mono text-[12px]"
                      spellCheck={false}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Edits are local to this agent — template is unchanged.
                    </p>
                  </div>
                )}
                {activeTemplateTab === "prompt" && (
                  <Textarea
                    value={selectedTemplate.prompt}
                    readOnly
                    className="min-h-[120px] text-[13px] opacity-70"
                  />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card className="mt-5">
        <CardHeader className="sr-only">
          <CardTitle>New Agent</CardTitle>
          <CardDescription>
            Pick a model and system prompt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label>Profile picture</Label>
              <PfpUpload
                name={name}
                value={pfpUrl}
                onChange={setPfpUrl}
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="name">Name (optional)</Label>
              <Input
                id="name"
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                placeholder="code-reviewer"
                disabled={submitting}
              />
            </div>

            {sandboxTemplates.length > 0 && (
              <div className="space-y-2">
                <Label>Sandbox Template (optional)</Label>
                <p className="text-[11px] text-muted-foreground">
                  Pre-fills repo URL and env var keys. Values stay empty — fill in your own.
                </p>
                <div className="flex flex-wrap gap-2">
                  {sandboxTemplates.map((t) => {
                    const active = selectedSandboxId === t.id;
                    const keys = Object.keys(t.env_vars ?? {});
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => applySandboxTemplate(active ? null : t.id)}
                        disabled={submitting}
                        className={cn(
                          "flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                          active
                            ? "border-foreground bg-accent/40"
                            : "border-border bg-card hover:bg-accent/30",
                        )}
                      >
                        <span className="text-[13px] font-medium text-foreground">{t.name}</span>
                        {t.repo_url && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {t.repo_url.replace("https://github.com/", "")}
                          </span>
                        )}
                        {keys.length > 0 && (
                          <span className="font-mono text-[9px] text-muted-foreground">
                            {keys.length} env var{keys.length !== 1 ? "s" : ""}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {(() => {
                  const sel = sandboxTemplates.find((s) => s.id === selectedSandboxId);
                  const keys = Object.keys(sel?.env_vars ?? {});
                  if (!sel || keys.length === 0) return null;
                  return (
                    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                      <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Env vars in this template
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {keys.map((k) => (
                          <span key={k} className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                            {k}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Harness</Label>
              <HarnessPicker value={harnessId} onChange={setHarnessId} disabled={submitting} />
              {(() => {
                const sandboxRepo = sandboxTemplates.find((s) => s.id === selectedSandboxId)?.repo_url;
                const repo = sandboxRepo || preinstalledRepo;
                return repo ? (
                  <p className="text-[11px] text-muted-foreground">
                    repo:{" "}
                    <a href={repo} target="_blank" rel="noopener noreferrer" className="font-mono text-foreground underline-offset-2 hover:underline">
                      {repo}
                    </a>
                    {sandboxRepo && (
                      <span className="ml-1.5 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">from template</span>
                    )}
                  </p>
                ) : null;
              })()}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="branch">Branch (optional)</Label>
              <Input
                id="branch"
                value={branchOverride}
                onChange={(e) => setBranchOverride(e.target.value)}
                placeholder="default: main"
                disabled={submitting}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Pin this agent to a specific branch. Leave blank to use the
                default.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Model</Label>
              <ModelPicker value={model} onChange={setModel} disabled={submitting} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="system-prompt">System prompt (optional)</Label>
              <Textarea
                id="system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You are a senior engineer reviewing code for clarity, correctness, and security."
                rows={6}
                disabled={submitting}
              />
            </div>

            {/* Skill section */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Skill (optional)</Label>
                {skillMode === null ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSkillMode("write")}
                      disabled={submitting}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      <Plus className="size-3" />
                      Write
                    </button>
                    <span className="text-[11px] text-muted-foreground/40">·</span>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground",
                        submitting && "pointer-events-none opacity-40",
                      )}
                    >
                      <Upload className="size-3" />
                      Upload .md
                      <input
                        type="file"
                        accept=".md"
                        className="sr-only"
                        disabled={submitting}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleSkillMdFile(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <span className="text-[11px] text-muted-foreground/40">·</span>
                    <button
                      type="button"
                      onClick={() => void openPickSkill()}
                      disabled={submitting}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      <FileText className="size-3" />
                      Pick from library
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={clearSkill}
                    disabled={submitting}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
                  >
                    <X className="size-3" />
                    Remove
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                A skill is a reusable instruction block injected after the system prompt.
              </p>

              {skillMode === "write" ? (
                <div
                  className={cn(
                    "rounded-lg border bg-card p-4 space-y-3 transition-colors",
                    skillDragOver && "border-primary bg-primary/5",
                  )}
                  onDragOver={(e) => { e.preventDefault(); setSkillDragOver(true); }}
                  onDragLeave={() => setSkillDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setSkillDragOver(false);
                    const f = e.dataTransfer.files[0];
                    if (f) handleSkillMdFile(f);
                  }}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-muted-foreground">Drag a <code className="font-mono">.md</code> onto this card to replace, or{" "}
                      <label className={cn("cursor-pointer underline underline-offset-2 hover:text-foreground", submitting && "pointer-events-none opacity-40")}>
                        browse
                        <input type="file" accept=".md" className="sr-only" disabled={submitting}
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSkillMdFile(f); e.target.value = ""; }} />
                      </label>
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="skill-name" className="text-xs">Skill name</Label>
                    <Input
                      id="skill-name"
                      value={skillName}
                      onChange={(e) => setSkillName(e.target.value)}
                      placeholder="e.g. code-reviewer"
                      disabled={submitting}
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="skill-desc" className="text-xs">Description</Label>
                    <Textarea
                      id="skill-desc"
                      value={skillDesc}
                      onChange={(e) => setSkillDesc(e.target.value)}
                      placeholder="What this skill does…"
                      rows={2}
                      disabled={submitting}
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="skill-instructions" className="text-xs">Instructions</Label>
                    <Textarea
                      id="skill-instructions"
                      value={skillInstructions}
                      onChange={(e) => setSkillInstructions(e.target.value)}
                      placeholder={"Step-by-step instructions for the agent…"}
                      rows={6}
                      disabled={submitting}
                      className="font-mono text-xs"
                    />
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
                        skillSaveToLibrary
                          ? "border-foreground bg-foreground text-background"
                          : "border-border bg-transparent",
                      )}
                      aria-hidden
                    >
                      {skillSaveToLibrary ? <Check className="size-3" /> : null}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={skillSaveToLibrary}
                      onChange={(e) => setSkillSaveToLibrary(e.target.checked)}
                      disabled={submitting}
                    />
                    <span className="text-[13px] text-muted-foreground">
                      Save to skills library for reuse
                    </span>
                  </label>
                </div>
              ) : skillMode === "pick" ? (
                <div className="rounded-lg border bg-card">
                  {loadingLibrary ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      Loading…
                    </div>
                  ) : librarySkills.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      No skills in library yet.{" "}
                      <button
                        type="button"
                        onClick={() => setSkillMode("write")}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        Write one instead
                      </button>
                    </div>
                  ) : (
                    <ul className="divide-y">
                      {librarySkills.map((sk) => (
                        <li key={sk.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSkillName(sk.name);
                              setSkillDesc(sk.description ?? "");
                              setSkillInstructions(sk.content);
                              setSkillSaveToLibrary(false);
                              setSkillMode("write");
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                          >
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{sk.name}</p>
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
              ) : null}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Environment variables (optional)</Label>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground",
                    submitting && "pointer-events-none opacity-50",
                  )}
                >
                  <Upload className="size-3" aria-hidden />
                  Upload .env
                  <input
                    type="file"
                    accept=".env,text/plain"
                    className="sr-only"
                    disabled={submitting}
                    onChange={handleEnvFileUpload}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Injected into every session container. Stored encrypted in DB.
                Per-session env vars (set at session create) take precedence.
              </p>
              <div className="rounded-lg border bg-card">
                <ul className="divide-y">
                  {envVars.map(([k, v], idx) => (
                    <li key={idx} className="flex items-center gap-2 px-2 py-1.5">
                      <Input
                        value={k}
                        onChange={(e) => setEnvKey(idx, e.target.value)}
                        placeholder="KEY"
                        disabled={submitting}
                        className="h-7 flex-1 font-mono text-xs uppercase"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <span className="shrink-0 text-[11px] text-muted-foreground">=</span>
                      <Input
                        value={v}
                        onChange={(e) => setEnvVal(idx, e.target.value)}
                        placeholder="value"
                        disabled={submitting}
                        className="h-7 flex-[2] font-mono text-xs"
                        autoComplete="off"
                        spellCheck={false}
                        type="password"
                      />
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => removeEnvRow(idx)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                        aria-label="Remove row"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="border-t px-2 py-1.5">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={addEnvRow}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    <Plus className="size-3" aria-hidden />
                    Add variable
                  </button>
                </div>
              </div>
              {(() => {
                const count = envVars.filter(([k]) => k.trim()).length;
                return count > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {count} variable{count === 1 ? "" : "s"} set.
                  </p>
                ) : null;
              })()}
            </div>

            <div className="space-y-1.5">
              <Label>MCP tools (optional)</Label>
              <p className="text-xs text-muted-foreground">
                Pick which MCP tools this agent can call. Expand a server to see its tools.
              </p>
              <McpToolsPicker
                value={enabledTools}
                onChange={(v: EnabledTools | EnabledToolsUpdater) =>
                  setEnabledTools(v as Parameters<typeof setEnabledTools>[0])
                }
                onToolTotals={setMcpToolTotals}
                disabled={submitting}
              />
            </div>

            {metaError ? (
              <p className="font-mono text-xs text-muted-foreground">
                Could not load repo info: {metaError}
              </p>
            ) : null}

            <div className="pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create agent"}
              </Button>
              {error ? (
                <p className="mt-3 font-mono text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
