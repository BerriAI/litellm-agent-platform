"use client";

import React from "react";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { HarnessMessagePart } from "@/lib/api";

// A single task as surfaced by the agent's plan tool. Mirrors the shape both
// the claude-code (`TodoWrite` → `todos`) and codex (`update_plan` → `plan`)
// harnesses emit, normalized to one status vocabulary.
export interface SessionTask {
  content: string;
  status: "pending" | "in_progress" | "completed";
  // claude-code sends a present-tense label for the active item; shown in
  // place of `content` while the task is in progress.
  activeForm?: string;
}

function normalizeStatus(value: unknown): SessionTask["status"] {
  const v = typeof value === "string" ? value.toLowerCase() : "";
  if (v === "completed" || v === "complete" || v === "done") return "completed";
  if (v === "in_progress" || v === "in-progress" || v === "active" || v === "running")
    return "in_progress";
  return "pending";
}

// Read a single plan-tool part into a task list. The harness stores tool args
// under `state.input`, which may already be an object or a JSON string.
function parseTaskInput(part: HarnessMessagePart): SessionTask[] {
  const state = (part.state as Record<string, unknown> | undefined) ?? {};
  let input: unknown = state.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const items = Array.isArray(obj.todos)
    ? obj.todos
    : Array.isArray(obj.plan)
      ? obj.plan
      : [];

  const tasks: SessionTask[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const content =
      typeof it.content === "string"
        ? it.content
        : typeof it.step === "string"
          ? it.step
          : "";
    if (!content) continue;
    tasks.push({
      content,
      status: normalizeStatus(it.status),
      activeForm: typeof it.activeForm === "string" ? it.activeForm : undefined,
    });
  }
  return tasks;
}

function isPlanTool(part: HarnessMessagePart): boolean {
  if ((typeof part?.type === "string" ? part.type : "") !== "tool") return false;
  const tool = typeof part.tool === "string" ? part.tool.toLowerCase() : "";
  return tool === "todowrite" || tool === "update_plan";
}

// Walk messages newest-first and return the task list from the most recent
// plan-tool call. The agent updates the UI purely by emitting a new plan
// tool call — this is the read side of that loop, no extra wiring needed.
export function extractLatestTasks(
  messageParts: Array<HarnessMessagePart[] | undefined>,
): SessionTask[] {
  for (let i = messageParts.length - 1; i >= 0; i--) {
    const parts = messageParts[i];
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isPlanTool(part)) continue;
      const tasks = parseTaskInput(part);
      if (tasks.length) return tasks;
    }
  }
  return [];
}

function TaskStatusIcon({ status }: { status: SessionTask["status"] }) {
  if (status === "completed")
    return <CheckCircle2 className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-600" />;
  if (status === "in_progress")
    return (
      <Loader2 className="mt-0.5 w-3.5 h-3.5 shrink-0 animate-spin text-blue-600" />
    );
  return <Circle className="mt-0.5 w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />;
}

function TaskRow({ task }: { task: SessionTask }) {
  const label =
    task.status === "in_progress" && task.activeForm
      ? task.activeForm
      : task.content;
  return (
    <div className="flex items-start gap-2 py-1.5 text-[13px] leading-snug">
      <TaskStatusIcon status={task.status} />
      <span
        className={
          task.status === "completed"
            ? "text-muted-foreground line-through"
            : "text-foreground"
        }
      >
        {label}
      </span>
    </div>
  );
}

// Right-rail Tasks panel. Renders nothing when the agent hasn't emitted a
// plan, so it stays out of the way for simple sessions.
export function SessionSidebar({ tasks }: { tasks: SessionTask[] }) {
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-l border-border bg-background overflow-y-auto">
      <div className="h-12 flex items-center justify-between border-b border-border px-4 flex-shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Tasks
        </span>
        <span className="text-[11px] text-muted-foreground">
          {done} / {tasks.length}
        </span>
      </div>
      <div className="flex flex-col px-4 py-3">
        {tasks.map((task, i) => (
          <TaskRow key={i} task={task} />
        ))}
      </div>
    </aside>
  );
}
