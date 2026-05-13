"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ApiError,
  SkillRow,
  getAgent,
  getSkill,
  updateAgent,
  updateSkill,
} from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string; skill_id: string }>;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceSkillBlockContent(
  prompt: string | null | undefined,
  skillId: string,
  newContent: string,
): string {
  const current = prompt ?? "";
  const re = new RegExp(
    `(<!-- skill:${escapeRegex(skillId)} -->\\n)[\\s\\S]*?(?=\\n+<!-- skill:|$)`,
  );
  return current.replace(re, `$1${newContent.trim()}`);
}

export default function AgentSkillEditPage({ params }: PageProps) {
  const router = useRouter();
  const { id: agentId, skill_id: skillId } = use(params);

  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editContent, setEditContent] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agent, sk] = await Promise.all([getAgent(agentId), getSkill(skillId)]);
      setAgentName(agent.name ?? agent.id);
      setAgentPrompt(agent.prompt ?? null);
      setSkill(sk);
      setEditName(sk.name);
      setEditDescription(sk.description ?? "");
      setEditContent(sk.content);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId, skillId]);

  useEffect(() => { void load(); }, [load]);

  async function handleSave() {
    if (!skill) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSkill(skill.id, {
        name: editName.trim() || undefined,
        description: editDescription.trim() || null,
        content: editContent.trim(),
      });
      const newPrompt = replaceSkillBlockContent(agentPrompt, updated.id, updated.content);
      await updateAgent(agentId, { prompt: newPrompt });
      router.push(`/agents/${agentId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      {/* Breadcrumb */}
      <div className="flex items-center text-[12px] text-muted-foreground">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => router.push("/agents")}
            className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Agents
          </button>
          <ChevronRight className="size-3" aria-hidden />
          <button
            type="button"
            onClick={() => router.push(`/agents/${agentId}`)}
            className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {agentName ?? agentId}
          </button>
          <ChevronRight className="size-3" aria-hidden />
          <span className="truncate font-mono text-[11px] text-foreground">
            {skill?.name ?? skillId}
          </span>
        </nav>
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {skill ? (
        <>
          <header className="mt-6 flex items-start justify-between gap-4 border-b pb-6">
            <div className="min-w-0 flex-1">
              <input
                className="w-full rounded-md border bg-background px-3 py-1.5 text-2xl font-semibold tracking-tight focus:outline-none focus:ring-2 focus:ring-ring"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Skill name"
              />
              <input
                className="mt-2 w-full rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Short description (optional)"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Created {new Date(skill.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push(`/agents/${agentId}`)}
                disabled={saving}
              >
                <X className="size-3.5" />
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !editContent.trim()}
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                Save
              </Button>
            </div>
          </header>

          <section className="mt-8">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Content
            </h2>
            <textarea
              className="min-h-[480px] w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-[13px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="Skill instructions (markdown)"
              spellCheck={false}
            />
          </section>

          <section className="mt-6">
            <p className="text-xs text-muted-foreground">
              Skill ID: <span className="font-mono">{skill.id}</span>
            </p>
          </section>
        </>
      ) : loading ? (
        <div className="mt-16 flex justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}
