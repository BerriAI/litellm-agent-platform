"use client";

import { FormEvent, use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AgentFormFields, DEFAULT_HARNESS_ID } from "@/components/agent-form-fields";
import { EnabledTools, EnabledToolsUpdater } from "@/components/mcp-tools-picker";
import { AgentRow, ApiError, McpAllowedTools, ProjectConfig, createSkill, getAgent, updateAgent } from "@/lib/api";
import { BRAIN_INLINE_HARNESS_ID, PROJECTS_STORAGE_KEY } from "@/lib/constants";

interface LocalProject {
  id: string;
  name: string;
  repo_url?: string;
  description?: string;
  [key: string]: unknown;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

const SKILL_MARKER_RE = /\n<!-- skill(?::[^\s>]+)? -->\n/;

export default function EditAgentPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);
  const [harnessId, setHarnessId] = useState(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState("");
  const [branchOverride, setBranchOverride] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [envVars, setEnvVars] = useState<[string, string][]>([["", ""]]);

  // Skills
  const [pickedSkillIds, setPickedSkillIds] = useState<string[]>([]);
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillMode, setSkillMode] = useState<null | "write" | "pick">(null);
  const [skillSaveToLibrary, setSkillSaveToLibrary] = useState(true);

  // Projects — brain-inline harness only
  const [availableProjects, setAvailableProjects] = useState<LocalProject[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<LocalProject[]>([]);

  // MCP — not pre-populated (AgentRow lacks mcp_allowed_tools detail).
  // Only sent to PATCH if user touches the picker.
  const [enabledTools, setEnabledTools] = useState<EnabledTools>(new Map());
  const [mcpToolTotals, setMcpToolTotals] = useState<Map<string, number>>(new Map());
  const mcpTouched = useRef(false);

  // Ref to original agent prompt, used to preserve inline (no-ID) skill blocks on save.
  const originalPromptRef = useRef<string>("");

  useEffect(() => {
    getAgent(id)
      .then((a) => {
        setAgent(a);
        originalPromptRef.current = a.prompt ?? "";
        setName(a.name ?? "");
        setPfpUrl(a.pfp_url ?? null);
        setHarnessId(a.harness_id);
        setModel(a.model ?? "");
        setBranchOverride(a.branch === "main" ? "" : (a.branch ?? ""));
        // Strip all skill markers — show only the base prompt for editing.
        const base = (a.prompt ?? "").split(SKILL_MARKER_RE)[0]?.trim() ?? "";
        setSystemPrompt(base);
        // Env vars
        const pairs = Object.entries(a.env_vars ?? {});
        setEnvVars(pairs.length > 0 ? pairs : [["", ""]]);
        // Pre-populate existing library skill attachments so they're visible and detachable.
        setPickedSkillIds(a.attached_skill_ids ?? []);
        // Pre-populate projects from agent data so editing doesn't wipe them on save.
        if (Array.isArray(a.projects) && a.projects.length > 0) {
          setSelectedProjects(a.projects.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description ?? "",
            repo_url: p.repo_url,
          })));
        }
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : (e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  // Load projects from localStorage
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (raw) setAvailableProjects(JSON.parse(raw) as LocalProject[]);
    } catch { /* ignore */ }
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agent || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Save new inline skill to library if requested, surface failure as a warning.
      if (skillInstructions.trim() && skillSaveToLibrary && skillName.trim()) {
        try {
          await createSkill({
            name: skillName.trim(),
            description: skillDesc.trim() || undefined,
            content: skillInstructions.trim(),
          });
        } catch (skillErr) {
          // Skill library save failed — agent will still save, but warn the user.
          setSaveError(
            `Warning: agent saved but skill library save failed: ${skillErr instanceof ApiError ? skillErr.message : (skillErr as Error).message}`,
          );
        }
      }

      // Build final prompt:
      // 1. Base system prompt (user-edited)
      // 2. Currently-picked library skills (user can add/remove via UI)
      // 3. Existing inline (no-ID) skill blocks from the original prompt — preserved as-is
      // 4. Newly-written inline skill from this session (if any)
      const existingInlineMatch = originalPromptRef.current.match(/\n<!-- skill -->\n[\s\S]*/);
      const existingInlineBlock = existingInlineMatch ? existingInlineMatch[0] : "";

      let finalPrompt = systemPrompt.trim();

      for (const skillId of pickedSkillIds) {
        finalPrompt += `\n<!-- skill:${skillId} -->\n`;
      }

      if (existingInlineBlock) {
        finalPrompt += existingInlineBlock;
      }

      if (skillInstructions.trim()) {
        finalPrompt = finalPrompt
          ? `${finalPrompt}\n<!-- skill -->\n${skillInstructions.trim()}`
          : skillInstructions.trim();
      }

      // Env vars
      const envVarsRecord: Record<string, string> = {};
      for (const [k, v] of envVars) {
        const key = k.trim();
        if (key) envVarsRecord[key] = v;
      }

      // MCP — only update if user touched the picker
      let mcpServers: string[] | undefined;
      let mcpAllowedTools: McpAllowedTools[] | undefined;
      if (mcpTouched.current) {
        mcpServers = [];
        mcpAllowedTools = [];
        for (const [serverId, toolSet] of enabledTools.entries()) {
          if (toolSet.size === 0) continue;
          mcpServers.push(serverId);
          const total = mcpToolTotals.get(serverId);
          if (total === undefined || toolSet.size < total) {
            mcpAllowedTools.push({ server_id: serverId, tools: Array.from(toolSet).sort() });
          }
        }
        if (mcpAllowedTools.length === 0) mcpAllowedTools = undefined;
      }

      const updated = await updateAgent(id, {
        name: name.trim() || undefined,
        pfp_url: pfpUrl ?? "",
        model: model.trim() || undefined,
        // Send explicit value (empty string = reset to default "main") so clearing
        // the branch field actually removes any override rather than being a no-op.
        branch: branchOverride.trim() || "main",
        prompt: finalPrompt,
        env_vars: envVarsRecord,
        ...(mcpTouched.current && { mcp_servers: mcpServers, mcp_allowed_tools: mcpAllowedTools }),
        ...(harnessId === BRAIN_INLINE_HARNESS_ID && {
          projects: selectedProjects.map((p): ProjectConfig => ({
            id: p.id,
            name: p.name,
            description: p.description ?? "",
            repo_url: p.repo_url,
            branch: "main",
          })),
        }),
      });

      setAgent(updated);
      router.push(`/agents/${id}`);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : (e as Error).message);
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !agent) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <p className="font-mono text-xs text-destructive">{loadError ?? "Agent not found."}</p>
        <button
          type="button"
          onClick={() => router.push("/agents")}
          className="mt-2 text-[13px] underline underline-offset-2 hover:text-foreground"
        >
          Back to agents
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="mb-6 border-b pb-4">
        <h1 className="text-[22px] font-semibold tracking-tight">Edit Agent</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{agent.name ?? agent.id}</p>
      </div>

      {saveError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950">
          <p className="font-mono text-xs text-red-700 dark:text-red-400">{saveError}</p>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <AgentFormFields
          name={name} onNameChange={setName}
          pfpUrl={pfpUrl} onPfpUrlChange={setPfpUrl}
          harnessId={harnessId}
          /* no onHarnessIdChange — harness is read-only after creation */
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
          enabledTools={enabledTools}
          onEnabledToolsChange={(v) => {
            mcpTouched.current = true;
            setEnabledTools(v as Parameters<typeof setEnabledTools>[0]);
          }}
          onMcpToolTotals={setMcpToolTotals}
          disabled={saving}
        />

        {/* Sandbox projects — brain-inline only */}
        {harnessId === BRAIN_INLINE_HARNESS_ID && (
          <div className="space-y-2">
            <Label>Sandbox Projects</Label>
            <p className="text-[12px] text-muted-foreground">
              Claude will be able to provision sandboxes for these projects.
            </p>
            {availableProjects.length > 0 ? (
              <div className="rounded-lg border divide-y">
                {availableProjects.map((p) => (
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

        <div className="flex items-center gap-3 border-t pt-4">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <><Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden />Saving…</>
            ) : (
              "Save Changes"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => router.push(`/agents/${id}`)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
