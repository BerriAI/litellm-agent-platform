"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Pencil, RefreshCw, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError, SkillRow, deleteSkill, getSkill, updateSkill } from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function SkillDetailPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [skill, setSkill] = useState<SkillRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editContent, setEditContent] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getSkill(id);
      setSkill(s);
      setEditName(s.name);
      setEditDescription(s.description ?? "");
      setEditContent(s.content);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  function startEdit() {
    if (!skill) return;
    setEditName(skill.name);
    setEditDescription(skill.description ?? "");
    setEditContent(skill.content);
    setEditing(true);
  }

  async function handleSave() {
    if (!skill) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSkill(skill.id, {
        name: editName,
        description: editDescription.trim() || null,
        content: editContent,
      });
      setSkill(updated);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!skill || !confirm(`Delete skill "${skill.name}"?`)) return;
    try {
      await deleteSkill(skill.id);
      router.push("/skills");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => router.push("/skills")}
            className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Skills
          </button>
          <ChevronRight className="size-3" aria-hidden />
          <span className="truncate font-mono text-[11px] text-foreground">{skill?.name ?? id}</span>
        </nav>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
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

      {skill ? (
        <>
          {/* Header */}
          <header className="mt-6 flex items-start justify-between gap-4 border-b pb-6">
            <div className="min-w-0 flex-1">
              {editing ? (
                <input
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-2xl font-semibold tracking-tight focus:outline-none focus:ring-2 focus:ring-ring"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Skill name"
                />
              ) : (
                <h1 className="text-2xl font-semibold tracking-tight">{skill.name}</h1>
              )}
              {editing ? (
                <input
                  className="mt-2 w-full rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Short description (optional)"
                />
              ) : skill.description ? (
                <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                Created {new Date(skill.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {editing ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                  >
                    <X className="size-3.5" />
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    Save
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDelete()}
                    className="text-destructive hover:text-destructive"
                  >
                    Delete
                  </Button>
                  <Button size="sm" onClick={startEdit}>
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                </>
              )}
            </div>
          </header>

          {/* Content */}
          <section className="mt-8">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Content
            </h2>
            {editing ? (
              <textarea
                className="min-h-[480px] w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-[13px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="Skill content (markdown)"
                spellCheck={false}
              />
            ) : (
              <pre className="min-h-[200px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground">
                {skill.content}
              </pre>
            )}
          </section>

          {/* Skill ID */}
          <section className="mt-6">
            <p className="text-xs text-muted-foreground">
              Skill ID: <span className="font-mono">{skill.id}</span>
            </p>
          </section>
        </>
      ) : !loading && !error ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Skill not found.</div>
      ) : null}
    </div>
  );
}
