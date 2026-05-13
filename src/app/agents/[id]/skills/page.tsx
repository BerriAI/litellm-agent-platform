"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileText, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AgentRow,
  ApiError,
  SkillRow,
  attachSkillToAgent,
  detachSkillById,
  getAgent,
  getSkill,
  listSkills,
} from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
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

export default function AgentSkillsPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [attachedSkills, setAttachedSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-skill form
  const [addTab, setAddTab] = useState<"write" | "upload" | "library">("write");
  const [writeName, setWriteName] = useState("");
  const [writeDesc, setWriteDesc] = useState("");
  const [writeContent, setWriteContent] = useState("");
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [librarySkills, setLibrarySkills] = useState<SkillRow[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const a = await getAgent(id);
      setAgent(a);
      const ids = a.attached_skill_ids ?? [];
      const skills = await Promise.all(
        ids.map((sid) => getSkill(sid).catch(() => null)),
      );
      setAttachedSkills(skills.filter(Boolean) as SkillRow[]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function loadLibrary() {
    if (libraryLoaded) return;
    try {
      setLibrarySkills(await listSkills());
      setLibraryLoaded(true);
    } catch {
      // non-fatal
    }
  }

  async function handleWrite() {
    if (!writeContent.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await attachSkillToAgent(id, {
        content: writeContent.trim(),
        name: writeName.trim() || undefined,
        description: writeDesc.trim() || undefined,
        save_to_library: saveToLibrary,
      });
      setAgent(result.agent);
      const newId = result.agent.attached_skill_ids?.at(-1);
      if (newId) {
        const sk = await getSkill(newId).catch(() => null);
        if (sk) setAttachedSkills((prev) => [...prev, sk]);
      }
      setWriteName("");
      setWriteDesc("");
      setWriteContent("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleFile(file: File) {
    if (!file.name.endsWith(".md")) {
      setError("Only .md files are supported");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const text = await file.text();
      const { name, description, content } = parseSkillMd(text);
      const result = await attachSkillToAgent(id, {
        content: content.trim(),
        name,
        description: description || undefined,
        save_to_library: saveToLibrary,
      });
      setAgent(result.agent);
      const newId = result.agent.attached_skill_ids?.at(-1);
      if (newId) {
        const sk = await getSkill(newId).catch(() => null);
        if (sk) setAttachedSkills((prev) => [...prev, sk]);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleAttachFromLibrary(skillId: string) {
    setError(null);
    try {
      const result = await attachSkillToAgent(id, { skill_id: skillId });
      setAgent(result.agent);
      const sk = await getSkill(skillId).catch(() => null);
      if (sk) setAttachedSkills((prev) => [...prev, sk]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function handleDetach(skillId: string) {
    setError(null);
    try {
      const result = await detachSkillById(id, skillId);
      setAgent(result.agent);
      setAttachedSkills((prev) => prev.filter((sk) => sk.id !== skillId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  const attachedIds = new Set(agent?.attached_skill_ids ?? []);
  const agentLabel = agent?.name?.trim() || id;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <button
        onClick={() => router.push(`/agents/${id}`)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to agent
      </button>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Skills{agent?.name ? ` · ${agent.name}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {attachedSkills.length === 0
            ? "No skills attached. Add one below."
            : `${attachedSkills.length} skill${attachedSkills.length === 1 ? "" : "s"} attached.`}
        </p>
      </header>

      {error ? (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {/* Attached skills list */}
      {loading ? (
        <div className="py-12 text-center">
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        </div>
      ) : attachedSkills.length > 0 ? (
        <ul className="mb-8 space-y-2">
          {attachedSkills.map((sk) => (
            <li key={sk.id} className="rounded-lg border bg-card/40 p-4">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-none">{sk.name}</p>
                  {sk.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{sk.description}</p>
                  ) : null}
                  <pre className="mt-2 max-h-24 overflow-hidden text-ellipsis whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {sk.content.slice(0, 300)}{sk.content.length > 300 ? "…" : ""}
                  </pre>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => router.push(`/agents/${id}/skills/${sk.id}`)}
                    title="Edit skill"
                  >
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleDetach(sk.id)}
                    title="Detach skill"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mb-8 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          No skills attached yet.
        </div>
      )}

      {/* Add skill */}
      <section className="rounded-lg border bg-card/40 p-4">
        <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
          Add skill
        </h2>

        {/* Tabs */}
        <div className="mb-4 flex border-b">
          {(["write", "upload", "library"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setAddTab(t);
                if (t === "library") void loadLibrary();
              }}
              className={`px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none ${
                addTab === t
                  ? "border-b-2 border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "write" ? "Write" : t === "upload" ? "Upload .md" : "My skills"}
            </button>
          ))}
        </div>

        {addTab === "write" ? (
          <div className="space-y-3">
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Skill name"
              value={writeName}
              onChange={(e) => setWriteName(e.target.value)}
            />
            <textarea
              className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              rows={2}
              placeholder="Description (optional)"
              value={writeDesc}
              onChange={(e) => setWriteDesc(e.target.value)}
            />
            <textarea
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              rows={8}
              placeholder="Step-by-step instructions for the agent…"
              value={writeContent}
              onChange={(e) => setWriteContent(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <span
                  className={`grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors ${
                    saveToLibrary ? "border-foreground bg-foreground text-background" : "border-border"
                  }`}
                  aria-hidden
                >
                  {saveToLibrary ? (
                    <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="2,6 5,9 10,3" />
                    </svg>
                  ) : null}
                </span>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={saveToLibrary}
                  onChange={(e) => setSaveToLibrary(e.target.checked)}
                  disabled={saving}
                />
                <span className="text-xs text-muted-foreground">Save to library</span>
              </label>
              <Button
                onClick={() => void handleWrite()}
                disabled={saving || !writeContent.trim()}
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                Add skill
              </Button>
            </div>
          </div>
        ) : addTab === "upload" ? (
          <label
            className={`flex h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-muted-foreground/60"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
          >
            <input
              type="file"
              accept=".md"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <div className="flex size-9 items-center justify-center rounded-md border bg-muted">
              <Plus className="size-4 text-muted-foreground" />
            </div>
            <span className="text-sm text-muted-foreground">
              {uploading ? "Uploading…" : "Drag and drop or click to upload"}
            </span>
          </label>
        ) : (
          <div>
            {librarySkills.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No saved skills yet.
              </p>
            ) : (
              <ul className="max-h-64 overflow-y-auto rounded-lg border divide-y">
                {librarySkills.map((sk) => {
                  const already = attachedIds.has(sk.id);
                  return (
                    <li key={sk.id} className="flex items-center gap-2 px-3 py-2.5">
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{sk.name}</p>
                        {sk.description ? (
                          <p className="truncate text-xs text-muted-foreground">{sk.description}</p>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={already}
                        onClick={() => void handleAttachFromLibrary(sk.id)}
                      >
                        {already ? "Attached" : "Attach"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
