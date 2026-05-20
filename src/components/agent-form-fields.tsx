"use client";

import { useEffect, useState } from "react";
import { Check, FileText, Loader2, Plus, Trash2, Upload, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PfpUpload } from "@/components/pfp-upload";
import { HarnessPicker, HARNESS_OPTIONS, DEFAULT_HARNESS_ID } from "@/components/harness-picker";
import { ModelPicker } from "@/components/model-picker";
import { McpToolsPicker, EnabledTools, EnabledToolsUpdater } from "@/components/mcp-tools-picker";
import { SkillRow, listSkills } from "@/lib/api";
import { cn } from "@/lib/utils";

export { DEFAULT_HARNESS_ID };

export interface AgentFormFieldsProps {
  name: string;
  onNameChange: (v: string) => void;
  pfpUrl: string | null;
  onPfpUrlChange: (v: string | null) => void;
  harnessId: string;
  /** Omit to render harness as read-only (edit mode — harness can't change post-creation). */
  onHarnessIdChange?: (v: string) => void;
  model: string;
  onModelChange: (v: string) => void;
  branchOverride: string;
  onBranchOverrideChange: (v: string) => void;
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  pickedSkillIds: string[];
  onPickedSkillIdsChange: (v: string[]) => void;
  skillName: string;
  onSkillNameChange: (v: string) => void;
  skillDesc: string;
  onSkillDescChange: (v: string) => void;
  skillInstructions: string;
  onSkillInstructionsChange: (v: string) => void;
  skillMode: null | "write" | "pick";
  onSkillModeChange: (v: null | "write" | "pick") => void;
  skillSaveToLibrary: boolean;
  onSkillSaveToLibraryChange: (v: boolean) => void;
  envVars: [string, string][];
  onEnvVarsChange: (v: [string, string][]) => void;
  enabledTools: EnabledTools;
  onEnabledToolsChange: (v: EnabledTools | EnabledToolsUpdater) => void;
  onMcpToolTotals?: (totals: Map<string, number>) => void;
  disabled?: boolean;
}

const NAME_MAX = 64;

function parseEnvFile(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
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

export function AgentFormFields({
  name, onNameChange,
  pfpUrl, onPfpUrlChange,
  harnessId, onHarnessIdChange,
  model, onModelChange,
  branchOverride, onBranchOverrideChange,
  systemPrompt, onSystemPromptChange,
  pickedSkillIds, onPickedSkillIdsChange,
  skillName, onSkillNameChange,
  skillDesc, onSkillDescChange,
  skillInstructions, onSkillInstructionsChange,
  skillMode, onSkillModeChange,
  skillSaveToLibrary, onSkillSaveToLibraryChange,
  envVars, onEnvVarsChange,
  enabledTools, onEnabledToolsChange,
  onMcpToolTotals,
  disabled = false,
}: AgentFormFieldsProps) {
  const [librarySkills, setLibrarySkills] = useState<SkillRow[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [skillDragOver, setSkillDragOver] = useState(false);

  // Pre-load skill names when existing attachments are passed in (edit mode) so
  // the chips render without requiring the user to open the picker first.
  useEffect(() => {
    if (pickedSkillIds.length > 0 && librarySkills.length === 0) {
      listSkills().then(setLibrarySkills).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedSkillIds.length]);

  function setEnvKey(idx: number, key: string) {
    onEnvVarsChange(envVars.map((p, i) => (i === idx ? [key, p[1]] : p)));
  }
  function setEnvVal(idx: number, val: string) {
    onEnvVarsChange(envVars.map((p, i) => (i === idx ? [p[0], val] : p)));
  }
  function addEnvRow() {
    onEnvVarsChange([...envVars, ["", ""]]);
  }
  function removeEnvRow(idx: number) {
    const next = envVars.filter((_, i) => i !== idx);
    onEnvVarsChange(next.length === 0 ? [["", ""]] : next);
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
      onEnvVarsChange([
        ...envVars.filter(([k]) => k.trim() !== ""),
        ...parsed,
        ["", ""],
      ]);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handleSkillMdFile(file: File) {
    if (!file.name.endsWith(".md")) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== "string") return;
      const { name: n, description, content } = parseSkillMd(text);
      onSkillNameChange(n);
      onSkillDescChange(description);
      onSkillInstructionsChange(content);
      onSkillModeChange("write");
    };
    reader.readAsText(file);
  }

  function clearSkill() {
    onSkillNameChange("");
    onSkillDescChange("");
    onSkillInstructionsChange("");
    onSkillModeChange(null);
  }

  function toggleSkillPick(id: string) {
    onPickedSkillIdsChange(
      pickedSkillIds.includes(id)
        ? pickedSkillIds.filter((x) => x !== id)
        : [...pickedSkillIds, id],
    );
  }

  async function openPickSkill() {
    onSkillModeChange("pick");
    setLoadingLibrary(true);
    try {
      setLibrarySkills(await listSkills());
    } catch {
      // non-fatal
    } finally {
      setLoadingLibrary(false);
    }
  }

  const harnessLabel = HARNESS_OPTIONS.find((o) => o.id === harnessId)?.label ?? harnessId;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Profile picture</Label>
        <PfpUpload name={name} value={pfpUrl} onChange={onPfpUrlChange} disabled={disabled} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-name">Name (optional)</Label>
        <Input
          id="agent-name"
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="code-reviewer"
          disabled={disabled}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Harness</Label>
        {onHarnessIdChange ? (
          <HarnessPicker value={harnessId} onChange={onHarnessIdChange} disabled={disabled} />
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <span className="font-mono">{harnessLabel}</span>
            <span className="text-[11px]">(cannot change after creation)</span>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-branch">Branch (optional)</Label>
        <Input
          id="agent-branch"
          value={branchOverride}
          onChange={(e) => onBranchOverrideChange(e.target.value)}
          placeholder="default: main"
          disabled={disabled}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Pin this agent to a specific branch. Leave blank to use the default.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Model</Label>
        <ModelPicker value={model} onChange={onModelChange} disabled={disabled} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-prompt">System prompt (optional)</Label>
        <Textarea
          id="agent-prompt"
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          placeholder="You are a senior engineer reviewing code for clarity, correctness, and security."
          rows={6}
          disabled={disabled}
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
                onClick={() => onSkillModeChange("write")}
                disabled={disabled}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <Plus className="size-3" />
                Write
              </button>
              <span className="text-[11px] text-muted-foreground/40">·</span>
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground",
                  disabled && "pointer-events-none opacity-40",
                )}
              >
                <Upload className="size-3" />
                Upload .md
                <input
                  type="file"
                  accept=".md"
                  className="sr-only"
                  disabled={disabled}
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
                disabled={disabled}
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
              disabled={disabled}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
            >
              <X className="size-3" />
              Remove
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          A skill is a reusable instruction block. Library skills also land in the sandbox as{" "}
          <code className="font-mono">~/.claude/skills/&lt;slug&gt;/SKILL.md</code> so the TUI discovers them natively.
        </p>

        {pickedSkillIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">
              {pickedSkillIds.length} library skill{pickedSkillIds.length === 1 ? "" : "s"} attached
            </span>
            {librarySkills
              .filter((s) => pickedSkillIds.includes(s.id))
              .map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5">
                  <FileText className="size-3 text-muted-foreground" />
                  {s.name}
                  <button
                    type="button"
                    onClick={() => toggleSkillPick(s.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Detach ${s.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
          </div>
        ) : null}

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
              <p className="text-[11px] text-muted-foreground">
                Drag a <code className="font-mono">.md</code> onto this card to replace, or{" "}
                <label className={cn("cursor-pointer underline underline-offset-2 hover:text-foreground", disabled && "pointer-events-none opacity-40")}>
                  browse
                  <input type="file" accept=".md" className="sr-only" disabled={disabled}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSkillMdFile(f); e.target.value = ""; }} />
                </label>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-name" className="text-xs">Skill name</Label>
              <Input
                id="skill-name"
                value={skillName}
                onChange={(e) => onSkillNameChange(e.target.value)}
                placeholder="e.g. code-reviewer"
                disabled={disabled}
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-desc" className="text-xs">Description</Label>
              <Textarea
                id="skill-desc"
                value={skillDesc}
                onChange={(e) => onSkillDescChange(e.target.value)}
                placeholder="What this skill does…"
                rows={2}
                disabled={disabled}
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-instructions" className="text-xs">Instructions</Label>
              <Textarea
                id="skill-instructions"
                value={skillInstructions}
                onChange={(e) => onSkillInstructionsChange(e.target.value)}
                placeholder="Step-by-step instructions for the agent…"
                rows={6}
                disabled={disabled}
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
                onChange={(e) => onSkillSaveToLibraryChange(e.target.checked)}
                disabled={disabled}
              />
              <span className="text-[13px] text-muted-foreground">Save to skills library for reuse</span>
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
                  onClick={() => onSkillModeChange("write")}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Write one instead
                </button>
              </div>
            ) : (
              <>
                <ul className="divide-y">
                  {librarySkills.map((sk) => {
                    const picked = pickedSkillIds.includes(sk.id);
                    return (
                      <li key={sk.id}>
                        <button
                          type="button"
                          onClick={() => toggleSkillPick(sk.id)}
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                        >
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
                              picked
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-transparent",
                            )}
                            aria-hidden
                          >
                            {picked ? <Check className="size-3" /> : null}
                          </span>
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{sk.name}</p>
                            {sk.description ? (
                              <p className="truncate text-xs text-muted-foreground">{sk.description}</p>
                            ) : null}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {pickedSkillIds.length === 0
                      ? "Select one or more skills to attach"
                      : `${pickedSkillIds.length} selected`}
                  </span>
                  <div className="flex items-center gap-2">
                    {pickedSkillIds.length > 0 ? (
                      <button type="button" onClick={() => onPickedSkillIdsChange([])} className="hover:text-foreground">
                        Clear
                      </button>
                    ) : null}
                    <button type="button" onClick={() => onSkillModeChange(null)} className="hover:text-foreground">
                      Done
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* Env vars */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Environment variables (optional)</Label>
          <label
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground",
              disabled && "pointer-events-none opacity-50",
            )}
          >
            <Upload className="size-3" aria-hidden />
            Upload .env
            <input
              type="file"
              accept=".env,text/plain"
              className="sr-only"
              disabled={disabled}
              onChange={handleEnvFileUpload}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Injected into every session container. Stored encrypted in DB. Per-session env vars take precedence.
        </p>
        <div className="rounded-lg border bg-card">
          <ul className="divide-y">
            {envVars.map(([k, v], idx) => (
              <li key={idx} className="flex items-center gap-2 px-2 py-1.5">
                <Input
                  value={k}
                  onChange={(e) => setEnvKey(idx, e.target.value)}
                  placeholder="KEY"
                  disabled={disabled}
                  className="h-7 flex-1 font-mono text-xs uppercase"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="shrink-0 text-[11px] text-muted-foreground">=</span>
                <Input
                  value={v}
                  onChange={(e) => setEnvVal(idx, e.target.value)}
                  placeholder="value"
                  disabled={disabled}
                  className="h-7 flex-[2] font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                  type="password"
                />
                <button
                  type="button"
                  disabled={disabled}
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
              disabled={disabled}
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
            <p className="text-xs text-muted-foreground">{count} variable{count === 1 ? "" : "s"} set.</p>
          ) : null;
        })()}
      </div>

      {/* MCP tools */}
      <div className="space-y-1.5">
        <Label>MCP tools (optional)</Label>
        <p className="text-xs text-muted-foreground">
          Pick which MCP tools this agent can call. Expand a server to see its tools.
        </p>
        <McpToolsPicker
          value={enabledTools}
          onChange={(v: EnabledTools | EnabledToolsUpdater) =>
            onEnabledToolsChange(v as Parameters<typeof onEnabledToolsChange>[0])
          }
          onToolTotals={onMcpToolTotals}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
