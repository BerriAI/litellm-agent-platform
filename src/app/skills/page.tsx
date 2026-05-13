"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError, SkillRow, createSkill, deleteSkill, listSkills } from "@/lib/api";
import { cn } from "@/lib/utils";

function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
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

type ModalTab = "write" | "upload";

export default function SkillsPage() {
  const router = useRouter();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [tab, setTab] = useState<ModalTab>("write");

  // Write form
  const [writeName, setWriteName] = useState("");
  const [writeDesc, setWriteDesc] = useState("");
  const [writeInstructions, setWriteInstructions] = useState("");
  const [saving, setSaving] = useState(false);

  // Upload
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSkills(await listSkills());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openModal(defaultTab: ModalTab = "write") {
    setWriteName("");
    setWriteDesc("");
    setWriteInstructions("");
    setTab(defaultTab);
    setError(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setError(null);
  }

  async function handleWrite() {
    if (!writeName.trim() || !writeInstructions.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const skill = await createSkill({
        name: writeName.trim(),
        description: writeDesc.trim() || undefined,
        content: writeInstructions.trim(),
      });
      closeModal();
      router.push(`/skills/${skill.id}`);
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
      const skill = await createSkill({ name, description, content });
      closeModal();
      router.push(`/skills/${skill.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this skill?")) return;
    try {
      await deleteSkill(id);
      setSkills((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reusable instruction sets attached to agents via{" "}
            <code className="font-mono text-xs">&lt;!-- skill --&gt;</code> in the system prompt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => openModal("write")}>
            <Plus className="size-3.5" />
            New skill
          </Button>
        </div>
      </div>

      {error && !showModal ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {/* Modal */}
      {showModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-xl border bg-card shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="text-lg font-semibold">
                {tab === "write" ? "Write skill instructions" : "Upload skill"}
              </h2>
              <Button variant="ghost" size="sm" onClick={closeModal} className="h-7 w-7 p-0">
                ✕
              </Button>
            </div>

            {/* Tabs */}
            <div className="flex border-b">
              {(["write", "upload"] as ModalTab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "px-5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none",
                    tab === t
                      ? "border-b-2 border-foreground text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "write" ? "Write" : "Upload .md"}
                </button>
              ))}
            </div>

            {/* Tab body */}
            <div className="px-6 py-5">
              {error ? (
                <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
                  {error}
                </div>
              ) : null}

              {tab === "write" ? (
                <div className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Skill name</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      placeholder="e.g. weekly-status-report"
                      value={writeName}
                      onChange={(e) => setWriteName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Description</label>
                    <textarea
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      rows={3}
                      placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries."
                      value={writeDesc}
                      onChange={(e) => setWriteDesc(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Instructions</label>
                    <textarea
                      className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      rows={8}
                      placeholder={"Summarize my recent work in three sections: wins, blockers, and next steps.\nKeep the tone professional but not stiff..."}
                      value={writeInstructions}
                      onChange={(e) => setWriteInstructions(e.target.value)}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <label
                    className={cn(
                      "flex h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors",
                      dragOver
                        ? "border-primary bg-primary/5"
                        : "border-muted-foreground/30 hover:border-muted-foreground/60",
                    )}
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
                      <Upload className="size-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {uploading ? "Uploading…" : "Drag and drop or click to upload"}
                    </span>
                  </label>
                  <div className="mt-4">
                    <p className="text-xs font-medium text-muted-foreground">File requirements</p>
                    <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                      <li>• <code className="font-mono">.md</code> file with optional YAML frontmatter</li>
                      <li>• Frontmatter <code className="font-mono">name:</code> and <code className="font-mono">description:</code> are auto-extracted</li>
                      <li>• Body becomes the skill content injected into agents</li>
                    </ul>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            {tab === "write" ? (
              <div className="flex justify-end gap-2 border-t px-6 py-4">
                <Button variant="outline" onClick={closeModal} disabled={saving}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleWrite()}
                  disabled={saving || !writeName.trim() || !writeInstructions.trim()}
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Create
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Skills list */}
      <div className="mt-8">
        {!loading && skills.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-card/40 px-6 py-16 text-center">
            <FileText className="mx-auto size-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">No skills yet.</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button size="sm" onClick={() => openModal("write")}>
                <Plus className="size-3.5" />
                Write skill
              </Button>
              <Button size="sm" variant="outline" onClick={() => openModal("upload")}>
                <Upload className="size-3.5" />
                Upload .md
              </Button>
            </div>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-lg border bg-card">
            {skills.map((skill, i) => (
              <li
                key={skill.id}
                onClick={() => router.push(`/skills/${skill.id}`)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50",
                  i > 0 && "border-t",
                )}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <FileText className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{skill.name}</p>
                  {skill.description ? (
                    <p className="truncate text-xs text-muted-foreground">{skill.description}</p>
                  ) : null}
                </div>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatRelative(skill.created_at)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => void handleDelete(skill.id, e)}
                  className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
