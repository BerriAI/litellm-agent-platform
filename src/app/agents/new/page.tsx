"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronRight, FileText, Loader2, Plus, Search, Trash2, Upload, X } from "lucide-react";

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
import {
  AgentTemplate,
  ApiError,
  McpAllowedTools,
  McpRow,
  McpToolRow,
  ModelRow,
  SkillRow,
  createAgent,
  createSkill,
  getPreinstalledGithubRepo,
  listMcps,
  listMcpTools,
  listModels,
  listSkills,
  listTemplates,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface ServerToolsState {
  status: "idle" | "loading" | "ready" | "error";
  tools: McpToolRow[];
  error?: string;
}

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const NAME_MAX = 64;

// Each option below maps 1:1 to a registered ECS task-definition family.
// Adding a third harness = one extra row + matching env var on the server.
type HarnessOption = {
  id: string;
  label: string;
  description: string;
};
const HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "opencode",
    label: "opencode",
    description:
      "Multi-provider via LiteLLM. Default — used by every existing agent.",
  },
  {
    id: "claude-agent-sdk",
    label: "claude-agent-sdk",
    description:
      "Anthropic's first-party agent loop. Fewer harness bugs; SDK persists session state for free.",
  },
];
const DEFAULT_HARNESS_ID = HARNESS_OPTIONS[0].id;

function mcpLabel(m: McpRow): string {
  return m.alias?.trim() || m.server_name?.trim() || m.server_id;
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
  const [modelQuery, setModelQuery] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [branchOverride, setBranchOverride] = useState("");
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);

  const [models, setModels] = useState<ModelRow[]>([]);
  const [mcps, setMcps] = useState<McpRow[]>([]);
  const [preinstalledRepo, setPreinstalledRepo] = useState<string>("");
  // Per-server: which tools are enabled. A missing entry = server not enabled.
  // An entry with an empty set = server enabled but every tool was unchecked
  // (treated as "not enabled" at submit time — submitting an empty whitelist
  // would be confusing).
  const [enabledTools, setEnabledTools] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  // Which server cards are expanded in the UI.
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  // Lazy-fetched tools per server, keyed by server_id.
  const [serverTools, setServerTools] = useState<Map<string, ServerToolsState>>(
    new Map(),
  );
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
    async function load() {
      setMetaError(null);
      try {
        const [modelsRes, mcpsRes, repoRes] = await Promise.all([
          listModels().catch(() => [] as ModelRow[]),
          listMcps().catch(() => [] as McpRow[]),
          getPreinstalledGithubRepo().catch(() => ""),
        ]);
        if (cancelled) return;
        setModels(modelsRes);
        setMcps(mcpsRes);
        setPreinstalledRepo(repoRes);
      } catch (e) {
        if (cancelled) return;
        setMetaError(
          e instanceof ApiError ? e.message : (e as Error).message,
        );
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedMcps = useMemo(() => {
    return [...mcps].sort((a, b) => mcpLabel(a).localeCompare(mcpLabel(b)));
  }, [mcps]);

  async function loadToolsForServer(serverId: string) {
    setServerTools((prev) => {
      const next = new Map(prev);
      next.set(serverId, { status: "loading", tools: [] });
      return next;
    });
    try {
      const tools = await listMcpTools(serverId);
      setServerTools((prev) => {
        const next = new Map(prev);
        next.set(serverId, { status: "ready", tools });
        return next;
      });
      // Default behavior: if the user has not yet picked any tools for this
      // server, enable all of them — matches the old "select server" UX.
      setEnabledTools((prev) => {
        if (prev.has(serverId)) return prev;
        const next = new Map(prev);
        next.set(serverId, new Set(tools.map((t) => t.name)));
        return next;
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setServerTools((prev) => {
        const next = new Map(prev);
        next.set(serverId, { status: "error", tools: [], error: msg });
        return next;
      });
    }
  }

  function toggleServerExpanded(serverId: string) {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
        const existing = serverTools.get(serverId);
        if (!existing || existing.status === "error") {
          void loadToolsForServer(serverId);
        }
      }
      return next;
    });
  }

  function toggleTool(serverId: string, toolName: string) {
    setEnabledTools((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(serverId) ?? []);
      if (current.has(toolName)) current.delete(toolName);
      else current.add(toolName);
      next.set(serverId, current);
      return next;
    });
  }

  function setAllToolsForServer(serverId: string, enabled: boolean) {
    const state = serverTools.get(serverId);
    if (!state || state.status !== "ready") return;
    setEnabledTools((prev) => {
      const next = new Map(prev);
      next.set(
        serverId,
        enabled ? new Set(state.tools.map((t) => t.name)) : new Set(),
      );
      return next;
    });
  }

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

  // Total count of (server, tool) pairs currently enabled — drives the
  // summary line under the picker.
  const totalEnabledTools = useMemo(() => {
    let n = 0;
    for (const set of enabledTools.values()) n += set.size;
    return n;
  }, [enabledTools]);

  const sortedModels = useMemo(
    () => [...models].sort((a, b) => a.id.localeCompare(b.id)),
    [models],
  );
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return sortedModels;
    return sortedModels.filter((m) => m.id.toLowerCase().includes(q));
  }, [sortedModels, modelQuery]);

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
      // checked, send no whitelist for it — that lets the agent see future
      // tools added on that server without re-saving. If only a subset is
      // checked, send `mcp_allowed_tools` so the proxy can filter.
      const mcpServers: string[] = [];
      const mcpAllowedTools: McpAllowedTools[] = [];
      for (const [serverId, toolSet] of enabledTools.entries()) {
        if (toolSet.size === 0) continue;
        mcpServers.push(serverId);
        const state = serverTools.get(serverId);
        const total = state?.status === "ready" ? state.tools.length : 0;
        if (state?.status === "ready" && toolSet.size < total) {
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

      const created = await createAgent({
        name: name.trim() || undefined,
        model: model.trim(),
        prompt: finalPrompt,
        harness_id: harnessId,
        requirements: selectedTemplate?.requirements ?? undefined,
        branch: branchOverride.trim() || undefined,
        pfp_url: pfpUrl ?? undefined,
        mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
        mcp_allowed_tools:
          mcpAllowedTools.length > 0 ? mcpAllowedTools : undefined,
        env_vars: Object.keys(envVarsRecord).length > 0 ? envVarsRecord : undefined,
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

            <div className="space-y-1.5">
              <Label>Harness</Label>
              <div className="rounded-lg border bg-card">
                <ul role="radiogroup" aria-label="Harness" className="divide-y">
                  {HARNESS_OPTIONS.map((opt) => {
                    const selected = opt.id === harnessId;
                    return (
                      <li key={opt.id}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setHarnessId(opt.id)}
                          disabled={submitting}
                          className={cn(
                            "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            selected && "bg-accent/30",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                              selected
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-transparent",
                            )}
                            aria-hidden
                          >
                            {selected ? <Check className="size-3" /> : null}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="font-mono text-[13px] text-foreground">
                              {opt.label}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {opt.description}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {preinstalledRepo ? (
                <p className="text-[11px] text-muted-foreground">
                  repo:{" "}
                  <a
                    href={preinstalledRepo}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-foreground underline-offset-2 hover:underline"
                  >
                    {preinstalledRepo}
                  </a>
                </p>
              ) : null}
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
              <Label htmlFor="model-search">Model</Label>
              {sortedModels.length > 0 ? (
                <>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      id="model-search"
                      type="search"
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                      placeholder={`Search ${sortedModels.length} models…`}
                      disabled={submitting}
                      className="pl-8 font-mono text-xs"
                      autoComplete="off"
                    />
                  </div>
                  <div className="rounded-lg border bg-card">
                    {filteredModels.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        No models match{" "}
                        <span className="font-mono">
                          &quot;{modelQuery.trim()}&quot;
                        </span>
                        .
                      </p>
                    ) : (
                      <ul
                        role="listbox"
                        aria-label="Models"
                        className="max-h-64 divide-y overflow-y-auto"
                      >
                        {filteredModels.map((m) => {
                          const selected = m.id === model;
                          return (
                            <li key={m.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                onClick={() => setModel(m.id)}
                                disabled={submitting}
                                className={cn(
                                  "flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                  selected && "bg-accent/30",
                                )}
                              >
                                <span
                                  className={cn(
                                    "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                                    selected
                                      ? "border-foreground bg-foreground text-background"
                                      : "border-border bg-transparent",
                                  )}
                                  aria-hidden
                                >
                                  {selected ? (
                                    <Check className="size-3" />
                                  ) : null}
                                </span>
                                <span className="truncate font-mono text-xs text-foreground">
                                  {m.id}
                                </span>
                                {m.owned_by ? (
                                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                                    {m.owned_by}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </>
              ) : (
                <Input
                  id="model-search"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={DEFAULT_MODEL}
                  disabled={submitting}
                  className="font-mono text-xs"
                />
              )}
              <p className="text-xs text-muted-foreground">
                {loadingMeta
                  ? "Loading models from backend…"
                  : sortedModels.length > 0
                    ? <>Selected: <span className="font-mono text-foreground">{model}</span></>
                    : "No models returned by backend. Type a model id manually."}
              </p>
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
                Pick which MCP tools this agent can call. Expand a server to
                see its tools.
              </p>
              {loadingMeta ? (
                <p className="text-xs text-muted-foreground">
                  Loading MCP servers from backend…
                </p>
              ) : sortedMcps.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No MCP servers configured. Configure them under{" "}
                  <span className="font-mono">/v1/mcp/server</span>.
                </p>
              ) : (
                <div className="rounded-lg border bg-card">
                  <ul
                    aria-label="MCP servers and tools"
                    className="divide-y"
                  >
                    {sortedMcps.map((m) => {
                      const expanded = expandedServers.has(m.server_id);
                      const enabledSet = enabledTools.get(m.server_id);
                      const enabledCount = enabledSet?.size ?? 0;
                      const toolsState = serverTools.get(m.server_id);
                      const totalCount =
                        toolsState?.status === "ready"
                          ? toolsState.tools.length
                          : null;
                      return (
                        <li key={m.server_id}>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => toggleServerExpanded(m.server_id)}
                            disabled={submitting}
                            className={cn(
                              "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                              enabledCount > 0 && "bg-accent/30",
                            )}
                          >
                            <span
                              className="grid size-4 shrink-0 place-items-center text-muted-foreground"
                              aria-hidden
                            >
                              {expanded ? (
                                <ChevronDown className="size-3.5" />
                              ) : (
                                <ChevronRight className="size-3.5" />
                              )}
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-[13px] text-foreground">
                                {mcpLabel(m)}
                              </span>
                              {m.url ? (
                                <span className="truncate font-mono text-[11px] text-muted-foreground">
                                  {m.url}
                                </span>
                              ) : null}
                            </span>
                            {enabledCount > 0 ? (
                              <span className="shrink-0 rounded-md bg-foreground/90 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-background">
                                {totalCount !== null
                                  ? `${enabledCount}/${totalCount}`
                                  : `${enabledCount} on`}
                              </span>
                            ) : null}
                            {m.transport ? (
                              <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                                {m.transport}
                              </span>
                            ) : null}
                          </button>
                          {expanded ? (
                            <div className="border-t bg-muted/20 px-3 py-2">
                              {!toolsState || toolsState.status === "loading" ? (
                                <p className="py-1 text-xs text-muted-foreground">
                                  Loading tools…
                                </p>
                              ) : toolsState.status === "error" ? (
                                <div className="space-y-2">
                                  <p className="font-mono text-xs text-destructive">
                                    {toolsState.error ?? "Failed to load tools."}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void loadToolsForServer(m.server_id)
                                    }
                                    className="text-xs text-foreground underline underline-offset-2 hover:no-underline"
                                  >
                                    Retry
                                  </button>
                                </div>
                              ) : toolsState.tools.length === 0 ? (
                                <p className="py-1 text-xs text-muted-foreground">
                                  This server exposes no tools.
                                </p>
                              ) : (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-3 text-[11px]">
                                    <button
                                      type="button"
                                      disabled={submitting}
                                      onClick={() =>
                                        setAllToolsForServer(m.server_id, true)
                                      }
                                      className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                                    >
                                      Select all
                                    </button>
                                    <span aria-hidden className="text-muted-foreground/60">
                                      ·
                                    </span>
                                    <button
                                      type="button"
                                      disabled={submitting}
                                      onClick={() =>
                                        setAllToolsForServer(m.server_id, false)
                                      }
                                      className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                                    >
                                      Clear
                                    </button>
                                  </div>
                                  <ul className="space-y-1">
                                    {toolsState.tools.map((t) => {
                                      const checked =
                                        enabledSet?.has(t.name) ?? false;
                                      return (
                                        <li key={t.name}>
                                          <label
                                            className={cn(
                                              "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40",
                                              submitting &&
                                                "cursor-not-allowed opacity-60",
                                            )}
                                          >
                                            <span
                                              className={cn(
                                                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
                                                checked
                                                  ? "border-foreground bg-foreground text-background"
                                                  : "border-border bg-transparent",
                                              )}
                                              aria-hidden
                                            >
                                              {checked ? (
                                                <Check className="size-3" />
                                              ) : null}
                                            </span>
                                            <input
                                              type="checkbox"
                                              className="sr-only"
                                              checked={checked}
                                              disabled={submitting}
                                              onChange={() =>
                                                toggleTool(m.server_id, t.name)
                                              }
                                            />
                                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                              <span className="truncate font-mono text-[12px] text-foreground">
                                                {t.name}
                                              </span>
                                              {t.description ? (
                                                <span className="line-clamp-2 text-[11px] text-muted-foreground">
                                                  {t.description}
                                                </span>
                                              ) : null}
                                            </span>
                                          </label>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {totalEnabledTools > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {totalEnabledTools} tool{totalEnabledTools === 1 ? "" : "s"}{" "}
                  enabled.
                </p>
              ) : null}
            </div>

            {metaError ? (
              <p className="font-mono text-xs text-muted-foreground">
                Could not load model / MCP lists: {metaError}
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
