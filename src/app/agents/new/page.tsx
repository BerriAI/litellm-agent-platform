"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AgentFormFields, DEFAULT_HARNESS_ID } from "@/components/agent-form-fields";
import { EnabledTools, EnabledToolsUpdater } from "@/components/mcp-tools-picker";
import { BRAIN_INLINE_HARNESS_ID } from "@/lib/constants";
import {
  AgentTemplate,
  ApiError,
  McpAllowedTools,
  ProjectConfig,
  SandboxFileSpec,
  createAgent,
  createSkill,
  getPreinstalledGithubRepo,
  listProjects,
  listTemplates,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const NAME_MAX = 64;

interface LocalProject {
  id: string;
  name: string;
  description?: string;
  repo_url?: string;
  env_vars?: Record<string, string>;
  allow_out?: string[];
  deny_out?: string[];
  files?: SandboxFileSpec[];
}

export default function NewAgentPage() {
  const router = useRouter();

  // "blank" = no template; any other string = template id
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("blank");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [activeTemplateTab, setActiveTemplateTab] = useState<"overview" | "files" | "skill" | "prompt">("overview");
  // Per-template skill edits — keyed by template id
  const [skillEdits, setSkillEdits] = useState<Record<string, string>>({});
  // Per-template skill edit mode — false = rendered preview, true = raw textarea
  const [skillEditMode, setSkillEditMode] = useState<Record<string, boolean>>({});

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const currentSkill = selectedTemplate
    ? (skillEdits[selectedTemplate.id] ?? selectedTemplate.skill)
    : "";

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Projects (repo + env var keys) from localStorage
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // Multi-select for brain-inline harness
  const [selectedProjects, setSelectedProjects] = useState<LocalProject[]>([]);

  useEffect(() => {
    listProjects()
      .then((res) => setProjects(res.data.map((p) => ({
        id: p.project_id,
        name: p.name,
        description: p.description ?? undefined,
        repo_url: p.repo_url ?? undefined,
        env_vars: p.env_vars,
        allow_out: p.allow_out,
        deny_out: p.deny_out,
        files: p.files,
      })))
      )
      .catch(() => { /* ignore */ });
  }, []);

  function applyProject(id: string | null) {
    const nextId = id === selectedProjectId ? null : id;
    setSelectedProjectId(nextId);
    // Seed the agent's allowed hosts from the project default (editable after).
    const proj = nextId ? projects.find((p) => p.id === nextId) : null;
    if (proj?.allow_out && proj.allow_out.length > 0) setAllowOut(proj.allow_out);
  }

  function selectTemplate(id: string) {
    setSelectedTemplateId(id);
    setActiveTemplateTab("overview");
    const t = templates.find((t) => t.id === id);
    if (t) {
      setName(t.name);
      setHarnessId(t.harness_id);
      setModel(t.model);
      const parts = [t.prompt, t.skill ? `<!-- skill -->\n\n${skillEdits[t.id] ?? t.skill}` : ""].filter(Boolean);
      setSystemPrompt(parts.join("\n\n"));
      const templateVars = Object.entries(t.env_vars).filter(([k]) => !k.startsWith("LAP_FILE_"));
      setEnvVars(templateVars.length > 0 ? templateVars : [["", ""]]);
    } else {
      // blank
      setName("");
      setHarnessId(DEFAULT_HARNESS_ID);
      setModel(DEFAULT_MODEL);
      setSystemPrompt("");
      setEnvVars([["", ""]]);
    }
  }

  // Form state — controlled props for AgentFormFields
  const [name, setName] = useState("");
  const [harnessId, setHarnessId] = useState<string>(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [branchOverride, setBranchOverride] = useState("");
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);
  const [envVars, setEnvVars] = useState<[string, string][]>([["", ""]]);
  const [allowOut, setAllowOut] = useState<string[]>([]);
  const [envVarHosts, setEnvVarHosts] = useState<Record<string, string[]>>({});
  const [enabledTools, setEnabledTools] = useState<EnabledTools>(new Map());
  const [mcpToolTotals, setMcpToolTotals] = useState<Map<string, number>>(new Map());

  // Skill state
  const [pickedSkillIds, setPickedSkillIds] = useState<string[]>([]);
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillMode, setSkillMode] = useState<null | "write" | "pick">(null);
  const [skillSaveToLibrary, setSkillSaveToLibrary] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preinstalledRepo, setPreinstalledRepo] = useState<string>("");
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPreinstalledGithubRepo()
      .catch(() => "")
      .then((repo) => { if (!cancelled) setPreinstalledRepo(repo); })
      .catch((e) => { if (!cancelled) setMetaError(e instanceof ApiError ? e.message : (e as Error).message); })
      .finally(() => { if (!cancelled) setLoadingMeta(false); });
    return () => { cancelled = true; };
  }, []);

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

    if (allowOut.length === 0) {
      setError("Add at least one allowed host so the agent can reach the services it needs.");
      return;
    }

    setSubmitting(true);
    try {
      const mcpServers: string[] = [];
      const mcpAllowedTools: McpAllowedTools[] = [];
      for (const [serverId, toolSet] of enabledTools.entries()) {
        if (toolSet.size === 0) continue;
        mcpServers.push(serverId);
        const total = mcpToolTotals.get(serverId);
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
      // Keep only bindings for credentials that still exist on submit.
      const finalEnvVarHosts: Record<string, string[]> = {};
      for (const key of Object.keys(envVarsRecord)) {
        if (envVarHosts[key]?.length) finalEnvVarHosts[key] = envVarHosts[key];
      }

      // If a template is selected and the user edited the skill panel, merge back.
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

      // Append newly-picked library skills
      for (const skillId of pickedSkillIds) {
        finalPrompt = (finalPrompt ?? "") + `\n<!-- skill:${skillId} -->\n`;
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

      const selectedProject = projects.find((s) => s.id === selectedProjectId);
      const created = await createAgent({
        name: name.trim() || undefined,
        model: model.trim(),
        prompt: finalPrompt,
        harness_id: harnessId,
        requirements: selectedTemplate?.requirements ?? undefined,
        repo_url: selectedProject?.repo_url || preinstalledRepo || undefined,
        branch: branchOverride.trim() || undefined,
        pfp_url: pfpUrl ?? undefined,
        mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
        mcp_allowed_tools: mcpAllowedTools.length > 0 ? mcpAllowedTools : undefined,
        env_vars: Object.keys(envVarsRecord).length > 0 ? envVarsRecord : undefined,
        env_var_hosts: Object.keys(finalEnvVarHosts).length > 0 ? finalEnvVarHosts : undefined,
        allow_out: allowOut,
        deny_out: selectedProject?.deny_out,
        sandbox_files: selectedProject?.files,
        skill_ids: pickedSkillIds.length > 0 ? pickedSkillIds : undefined,
        // Preserve template provenance so the platform can detect version drift
        // and surface "sync available" when the template is later updated.
        template_id: selectedTemplate?.id ?? undefined,
        projects: harnessId === BRAIN_INLINE_HARNESS_ID && selectedProjects.length > 0
          ? selectedProjects.map((p): ProjectConfig => ({
              id: p.id,
              name: p.name,
              description: p.description ?? "",
              repo_url: p.repo_url,
              branch: "main",
            }))
          : undefined,
      });
      router.push(`/agents/${created.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
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
        </div>
      )}

      <div className="mt-5 flex flex-col gap-4">
        <Card className="order-2">
          <CardHeader className="sr-only">
            <CardTitle>New Agent</CardTitle>
            <CardDescription>Pick a model and system prompt.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={onSubmit} noValidate>

              {/* Project picker — new-only */}
              {projects.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Project (optional)</p>
                  <p className="text-[11px] text-muted-foreground">
                    Pre-fills repo URL and env var keys. Values stay empty — fill in your own.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {projects.map((t) => {
                      const active = selectedProjectId === t.id;
                      const keys = Object.keys(t.env_vars ?? {});
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => applyProject(active ? null : t.id)}
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
                    const sel = projects.find((s) => s.id === selectedProjectId);
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

              <AgentFormFields
                name={name} onNameChange={setName}
                pfpUrl={pfpUrl} onPfpUrlChange={setPfpUrl}
                harnessId={harnessId} onHarnessIdChange={setHarnessId}
                model={model} onModelChange={setModel}
                branchOverride={branchOverride} onBranchOverrideChange={setBranchOverride}
                systemPrompt={systemPrompt} onSystemPromptChange={setSystemPrompt}
                pickedSkillIds={pickedSkillIds} onPickedSkillIdsChange={setPickedSkillIds}
                skillName={skillName} onSkillNameChange={setSkillName}
                skillDesc={skillDesc} onSkillDescChange={setSkillDesc}
                skillInstructions={skillInstructions} onSkillInstructionsChange={setSkillInstructions}
                skillMode={skillMode} onSkillModeChange={setSkillMode}
                skillSaveToLibrary={skillSaveToLibrary} onSkillSaveToLibraryChange={setSkillSaveToLibrary}
                envVars={envVars} onEnvVarsChange={setEnvVars}
                allowOut={allowOut} onAllowOutChange={setAllowOut}
                envVarHosts={envVarHosts} onEnvVarHostsChange={setEnvVarHosts}
                enabledTools={enabledTools}
                onEnabledToolsChange={(v) => setEnabledTools(v as Parameters<typeof setEnabledTools>[0])}
                onMcpToolTotals={setMcpToolTotals}
                disabled={submitting}
              />

              {/* Sandbox projects — brain-inline only */}
              {harnessId === BRAIN_INLINE_HARNESS_ID && (
                <div className="space-y-2">
                  <Label>Sandbox Projects</Label>
                  <p className="text-[12px] text-muted-foreground">
                    Claude will be able to provision sandboxes for these projects.
                  </p>
                  {projects.length > 0 ? (
                    <div className="rounded-lg border divide-y">
                      {projects.map((p) => (
                        <label key={p.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-accent/50">
                          <input
                            type="checkbox"
                            checked={selectedProjects.some((sp) => sp.id === p.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedProjects([...selectedProjects, p]);
                              } else {
                                setSelectedProjects(selectedProjects.filter((sp) => sp.id !== p.id));
                              }
                            }}
                            className="rounded"
                          />
                          <span className="flex flex-col">
                            <span className="text-[13px] font-medium">{p.name}</span>
                            {p.repo_url && (
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {p.repo_url.replace("https://github.com/", "")}
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12px] text-muted-foreground">
                      No projects found.{" "}
                      <Link href="/projects/new" className="underline underline-offset-2 hover:text-foreground">
                        Create a project
                      </Link>{" "}
                      to add sandbox templates.
                    </p>
                  )}
                </div>
              )}

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
                  <p className="mt-3 font-mono text-xs text-destructive">{error}</p>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>

        {selectedTemplate && (
          <div>
            <Card className="overflow-hidden">
              <div className="flex border-b text-[13px]">
                {(["overview", "files", "skill", "prompt"] as const)
                  .filter((tab) => {
                    if (tab === "files") return selectedTemplate.files.length > 0;
                    if (tab === "skill") return !!selectedTemplate.skill;
                    if (tab === "prompt") return !!selectedTemplate.prompt;
                    return true;
                  })
                  .map((tab) => (
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
                    {selectedTemplate.files.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Files</p>
                        <div className="space-y-1">
                          {selectedTemplate.files.map((f) => (
                            <div key={f.template_path} className="flex items-center gap-2 font-mono text-[12px]">
                              <span className="rounded border border-border bg-muted px-2 py-0.5">{f.template_path}</span>
                              <span className="text-muted-foreground">→</span>
                              <span className="text-muted-foreground">{f.sandbox_path}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedTemplate.tools.length > 0 && (
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
                    )}
                    {selectedTemplate.skill_name && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Skill</p>
                        <div className="flex items-center gap-2">
                          <span className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[12px]">
                            {selectedTemplate.skill_name}
                          </span>
                          <button
                            type="button"
                            aria-label="View skill details"
                            onClick={() => setActiveTemplateTab("skill")}
                            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            View →
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {activeTemplateTab === "files" && (
                  <div className="space-y-4">
                    {selectedTemplate.files.map((f) => (
                      <div key={f.template_path}>
                        <div className="mb-1.5 flex items-center gap-2 font-mono text-[12px]">
                          <span className="rounded border border-border bg-muted px-2 py-0.5">{f.template_path}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground">{f.sandbox_path}</span>
                        </div>
                        <pre className="overflow-x-auto rounded-md border bg-muted/30 px-4 py-3 font-mono text-[12px] text-foreground">{f.content}</pre>
                      </div>
                    ))}
                  </div>
                )}
                {activeTemplateTab === "skill" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[13px] font-semibold">{selectedTemplate.skill_name}</p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setSkillEditMode((prev) => ({
                              ...prev,
                              [selectedTemplate.id]: !prev[selectedTemplate.id],
                            }))
                          }
                          className="flex items-center gap-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                          {skillEditMode[selectedTemplate.id] ? "Preview" : "Edit"}
                        </button>
                        {skillEdits[selectedTemplate.id] !== undefined && (
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
                        )}
                      </div>
                    </div>
                    {skillEditMode[selectedTemplate.id] ? (
                      <Textarea
                        value={currentSkill}
                        onChange={(e) =>
                          setSkillEdits((prev) => ({
                            ...prev,
                            [selectedTemplate.id]: e.target.value,
                          }))
                        }
                        className="min-h-[400px] font-mono text-[12px]"
                        spellCheck={false}
                      />
                    ) : (
                      <div className="prose prose-sm dark:prose-invert max-w-none overflow-y-auto rounded-md border bg-muted/30 px-4 py-3 text-[13px] [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {currentSkill}
                        </ReactMarkdown>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Edits are local to this agent — template is unchanged.
                    </p>
                  </div>
                )}
                {activeTemplateTab === "prompt" && (
                  <Textarea
                    aria-label="System prompt preview"
                    value={selectedTemplate.prompt}
                    readOnly
                    className="min-h-[400px] text-[13px] opacity-70"
                  />
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
