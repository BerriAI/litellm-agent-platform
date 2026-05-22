"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileCode, Globe, Pencil, Plus, Trash2 } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { type ProjectRow, deleteProject, listProjects } from "@/lib/api";

export interface SandboxFile {
  name: string;
  sandbox_path: string;
  content: string;
  content_type: string;
  size: number;
}

// Kept for backwards-compat with agents/new and agents/[id]/edit which pass
// LocalProject to the project selector. These fields are the agent-template
// fields that were folded into LocalProject historically; the DB Project only
// carries the sandbox-config subset.
export interface LocalProject {
  id: string;
  name: string;
  repo_url?: string;
  env_vars?: Record<string, string>;
  allow_out?: string[];
  deny_out?: string[];
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  prompt: string;
  skill_name: string;
  skill: string;
  tools: string[];
  requirements: string | null;
  files?: SandboxFile[];
  source: "local";
}

function ProjectCard({ project, onDelete }: { project: ProjectRow; onDelete?: () => void; }) {
  const envKeys = Object.keys(project.env_vars ?? {});
  const allowOut = project.allow_out ?? [];
  const denyOut = project.deny_out ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-foreground">{project.name}</p>
          {project.repo_url && (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {project.repo_url.replace("https://github.com/", "")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href={`/projects/${project.project_id}/edit`}
            aria-label={`Edit ${project.name}`}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Pencil className="size-3.5" aria-hidden />
          </Link>
          <Dialog>
            <DialogTrigger
              render={
                <button
                  type="button"
                  aria-label={`Delete ${project.name}`}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:hover:bg-red-950 dark:hover:text-red-400"
                />
              }
            >
              <Trash2 className="size-3.5" aria-hidden />
            </DialogTrigger>
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>Delete Project</DialogTitle>
                <DialogDescription>
                  Delete <strong className="text-foreground">{project.name}</strong>? This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="destructive" onClick={onDelete} />}>
                  Delete
                </DialogClose>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {envKeys.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {envKeys.map((k) => (
            <span key={k} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {k}
            </span>
          ))}
        </div>
      )}

      {(project.files ?? []).length > 0 && (
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-2">
          <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <FileCode className="size-2.5" aria-hidden />
            Sandbox Files
          </p>
          <div className="space-y-0.5">
            {project.files!.map((f, i) => (
              <p key={i} className="truncate font-mono text-[10px] text-muted-foreground">{f.sandbox_path}</p>
            ))}
          </div>
        </div>
      )}

      {(allowOut.length > 0 || denyOut.length > 0) && (
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-2">
          <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <Globe className="size-2.5" aria-hidden />
            Network Egress
          </p>
          {allowOut.length > 0 && (
            <div className="space-y-1">
              <p className="text-[9px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Allow</p>
              <div className="flex flex-wrap gap-1">
                {allowOut.map((r) => (
                  <span key={r} className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">{r}</span>
                ))}
              </div>
            </div>
          )}
          {denyOut.length > 0 && (
            <div className="space-y-1">
              <p className="text-[9px] font-medium uppercase tracking-wider text-red-600 dark:text-red-400">Deny</p>
              <div className="flex flex-wrap gap-1">
                {denyOut.map((r) => (
                  <span key={r} className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">{r}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listProjects()
      .then((res) => setProjects(res.data))
      .catch(() => {/* silently stay empty */})
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(id: string) {
    try {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.project_id !== id));
    } catch {
      // TODO: surface an error toast
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between border-b pb-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Projects</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Preconfigured sandbox environments for agent creation.
          </p>
        </div>
        <Link href="/projects/new" className={buttonVariants()}>
          <Plus className="size-4" aria-hidden />
          New Project
        </Link>
      </div>

      {loading && (
        <div className="rounded-lg border border-dashed bg-muted/30 px-6 py-12 text-center">
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        </div>
      )}

      {!loading && projects.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 px-6 py-12 text-center">
          <p className="text-[13px] text-muted-foreground">No projects yet.</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            <Link href="/projects/new" className="underline underline-offset-2 hover:text-foreground">
              Create your first project →
            </Link>
          </p>
        </div>
      )}

      {!loading && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.project_id}
              project={p}
              onDelete={() => handleDelete(p.project_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
