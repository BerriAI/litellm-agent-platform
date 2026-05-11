/**
 * Per-agent durable memory.
 *
 * One row = one lesson the agent should apply on future runs ("for UI
 * changes use shadcn Tag", "PR titles start with fix:"). See the Memory
 * model in prisma/schema.prisma for the full shape.
 *
 * Two read paths:
 *   1. Top-N pre-loaded into AGENT_PROMPT at warm-task launch — handled by
 *      buildContainerEnv() calling renderMemoryBlock(topMemoriesForAgent()).
 *      Cheap "instinctive awareness" with no tool call.
 *   2. search_memory tool inside the harness — grep-style ILIKE on the text
 *      column + tag intersect. Mandatory checkpoint before the agent
 *      finalizes a PR (see system-prompt rules added in renderMemoryBlock).
 *
 * Three write paths, distinguishable by `source`:
 *   - "agent": the harness called save_memory during a run.
 *   - "slack": shin matched a `remember:` prefix and POSTed here.
 *   - "ui":    a human clicked Add on /agents/:id/memory.
 *
 * Any write/update/disable invalidates warm tasks for that agent — the
 * top-N pre-load is baked into AGENT_PROMPT at launch, so warm rows must
 * be recycled to pick up the new prompt. The end-of-run search_memory call
 * always hits live data, so the worst stale-warm case is "pre-load is one
 * memory behind for ~60s" — search still catches violations.
 */

import { prisma } from "@/server/db";
import type { Memory } from "@prisma/client";

/** Max memories pre-loaded into AGENT_PROMPT. Tune if prompts get too long. */
export const PROMPT_PRELOAD_LIMIT = 10;

/** Max rows returned from search_memory. Defensive cap. */
export const SEARCH_LIMIT = 50;

export interface SaveMemoryInput {
  agent_id: string;
  text: string;
  tags?: string[];
  type?: string;
  priority?: number;
  source?: "agent" | "slack" | "ui";
  source_user_id?: string | null;
  source_session_id?: string | null;
  source_thread_ts?: string | null;
}

export interface UpdateMemoryInput {
  text?: string;
  tags?: string[];
  type?: string;
  priority?: number;
  disabled?: boolean;
}

export interface SearchMemoryOptions {
  q?: string;
  tag?: string;
  includeDisabled?: boolean;
  limit?: number;
}

/**
 * The grep query. `q` does case-insensitive substring match on text; `tag`
 * filters to memories that include that tag. Both optional. Bumps
 * times_applied + last_applied_at on returned rows so usage-based ordering
 * stays accurate.
 */
export async function searchMemory(
  agent_id: string,
  opts: SearchMemoryOptions = {},
): Promise<Memory[]> {
  const where = buildWhere(agent_id, opts);
  const rows = await prisma.memory.findMany({
    where,
    orderBy: [
      { priority: "desc" },
      { times_applied: "desc" },
      { created_at: "desc" },
    ],
    take: opts.limit ?? SEARCH_LIMIT,
  });
  if (rows.length > 0) {
    await bumpUsage(rows.map(r => r.memory_id));
  }
  return rows;
}

/**
 * The pre-load query. Same ordering as search but no filtering — top N
 * by priority+usage. Called once at warm-task / cold-task launch and
 * stuffed into AGENT_PROMPT.
 */
export async function topMemoriesForAgent(
  agent_id: string,
  limit: number = PROMPT_PRELOAD_LIMIT,
): Promise<Memory[]> {
  return prisma.memory.findMany({
    where: { agent_id, disabled: false },
    orderBy: [
      { priority: "desc" },
      { times_applied: "desc" },
      { created_at: "desc" },
    ],
    take: limit,
  });
}

export async function saveMemory(input: SaveMemoryInput): Promise<Memory> {
  const row = await prisma.memory.create({
    data: {
      agent_id: input.agent_id,
      text: input.text,
      tags: input.tags ?? [],
      type: input.type ?? "convention",
      priority: input.priority ?? 0,
      source: input.source ?? "agent",
      source_user_id: input.source_user_id ?? null,
      source_session_id: input.source_session_id ?? null,
      source_thread_ts: input.source_thread_ts ?? null,
    },
  });
  await invalidateWarmTasks(input.agent_id);
  return row;
}

export async function updateMemory(
  memory_id: string,
  input: UpdateMemoryInput,
): Promise<Memory | null> {
  const row = await prisma.memory.update({
    where: { memory_id },
    data: {
      ...(input.text !== undefined && { text: input.text }),
      ...(input.tags !== undefined && { tags: input.tags }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.disabled !== undefined && { disabled: input.disabled }),
    },
  });
  await invalidateWarmTasks(row.agent_id);
  return row;
}

export async function deleteMemory(memory_id: string): Promise<void> {
  const row = await prisma.memory.delete({ where: { memory_id } });
  await invalidateWarmTasks(row.agent_id);
}

/**
 * Mark all warm tasks for this agent dead so the pool reconciler stops them
 * and provisions new ones with the refreshed AGENT_PROMPT. No-op if there
 * are no warm tasks. Worst case: the next session waits for a cold start
 * (~50-90s) instead of pulling a warm task. The end-of-run search_memory
 * call always reads live data, so the absolute worst case is bounded.
 */
export async function invalidateWarmTasks(agent_id: string): Promise<void> {
  await prisma.warmTask.updateMany({
    where: { agent_id, status: { in: ["provisioning", "warm"] } },
    data: { status: "dead", failure_reason: "memory_changed" },
  });
}

/**
 * Format memories as the === AGENT MEMORY === block prepended to
 * AGENT_PROMPT. Discipline lives here, not in tooling — the rules tell
 * the model when to save_memory, when to search_memory (mandatory before
 * PR finalize), and what NOT to save.
 *
 * Empty memory list still emits the block (with the tool docs + rules) so
 * the agent knows the tools exist. Cheap.
 */
export function renderMemoryBlock(memories: Memory[]): string {
  const pinned = memories.length
    ? memories.map(m => `- [${[m.type, ...m.tags].join(", ")}] ${m.text}`).join("\n")
    : "(no memories yet)";

  return [
    "=== AGENT MEMORY ===",
    "You have a persistent memory for this agent. Active entries are pinned",
    "below; you can also search the full memory before finalizing your work.",
    "",
    `PRE-LOADED (top ${memories.length} by priority + recent usage):`,
    pinned,
    "",
    "TOOLS:",
    "- save_memory(text, tags?, type?, priority?)",
    "- search_memory(query?, tags?)",
    "",
    "WHEN TO save_memory:",
    "- User gives durable feedback: \"next time\", \"always\", \"never\",",
    "  \"going forward\", \"from now on\".",
    "- User explicitly types \"remember:\" / \"teach:\" in chat.",
    "- A correction generalizes beyond this PR (style, convention, constraint).",
    "Phrase generically (\"For UI changes…\" not \"For this PR…\"), one rule per",
    "entry, 1-4 short tags, pick the right type.",
    "",
    "WHEN TO search_memory (MANDATORY checkpoint):",
    "- BEFORE you finalize and file the PR — always. No exceptions.",
    "- Build the query from what you actually changed: file paths, features,",
    "  components used. Include the relevant tags.",
    "- For each returned memory:",
    "    * complies → continue.",
    "    * violates → fix it before filing the PR. State the violation in chat",
    "      (\"Memory <id> says X; I did Y; fixing.\").",
    "    * doesn't apply → ignore.",
    "- Also call search_memory mid-task if you're about to make a stylistic",
    "  or structural decision and want to check past guidance.",
    "",
    "WHEN NOT TO save_memory:",
    "- Task-specific corrections (variable rename, copy fix).",
    "- Conversational filler.",
    "- Anything already in your skills or the codebase.",
    "- Restating an existing pinned memory.",
    "",
    "IF YOU THINK A MEMORY IS WRONG:",
    "- Don't disable or delete it. Flag it in chat: \"Memory <id> says X but",
    "  the current codebase does Y. Worth reviewing.\" A human will curate.",
    "=== END AGENT MEMORY ===",
  ].join("\n");
}

// ============================================================================
// internals
// ============================================================================

function buildWhere(agent_id: string, opts: SearchMemoryOptions) {
  const where: {
    agent_id: string;
    disabled?: boolean;
    text?: { contains: string; mode: "insensitive" };
    tags?: { has: string };
  } = { agent_id };
  if (!opts.includeDisabled) where.disabled = false;
  if (opts.q && opts.q.trim().length > 0) {
    where.text = { contains: opts.q, mode: "insensitive" };
  }
  if (opts.tag && opts.tag.trim().length > 0) {
    where.tags = { has: opts.tag };
  }
  return where;
}

async function bumpUsage(memory_ids: string[]): Promise<void> {
  await prisma.memory.updateMany({
    where: { memory_id: { in: memory_ids } },
    data: {
      times_applied: { increment: 1 },
      last_applied_at: new Date(),
    },
  });
}
