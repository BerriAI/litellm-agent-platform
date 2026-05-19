/**
 * Skill tool spec — used by every harness adapter.
 *
 * Exposes the agent-facing `save_skill`, `list_skills`, and `delete_skill`
 * tools so an agent can author and refine its own SKILL.md files based on
 * recurring user feedback. Mirrors the memory spec's split:
 *
 *   1. Input schemas (zod) + natural-language descriptions for the LLM.
 *   2. Handler functions that call back into the LAP HTTP API.
 *
 * What a `save_skill` call does:
 *
 *   1. List the user's existing skills.
 *   2. If one matches by exact name → PATCH it (update content/description).
 *      Otherwise → POST a new Skill row.
 *   3. Detach-then-attach the skill to the current agent so its `<!-- skill:id -->`
 *      marker lives in agent.prompt — next session will hydrate it on boot.
 *   4. Write `~/.claude/skills/<slug>/SKILL.md` with synthesized YAML
 *      frontmatter so the running session sees the skill on its next scan
 *      of the skills directory (mid-session hydration).
 *
 * The slugify + frontmatter logic mirrors src/server/k8s.ts so a skill
 * written mid-session lands at the same path that the platform would use
 * when hydrating on next boot — meaning we don't end up with two copies of
 * the same skill at slightly different slugs.
 *
 * Env contract (read at tool-call time, not at module load):
 *
 *   LAP_BASE_URL     base URL of the platform (e.g. https://lap.example.com)
 *   AGENT_ID         which agent owns the skill and gets it attached
 *   LAP_AUTH_TOKEN   bearer token for /api/v1/managed_agents/*
 *
 * If any are missing, `skillsEnv()` returns null and the adapter is
 * expected to skip registering the tools — harness boots cleanly without
 * the skill tools, the LLM simply doesn't see those tool names.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

export interface SkillsEnv {
  base_url: string;
  agent_id: string;
  auth_token: string;
}

export function skillsEnv(): SkillsEnv | null {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  const auth_token = process.env.LAP_AUTH_TOKEN ?? "";
  if (!base_url || !agent_id || !auth_token) return null;
  return { base_url, agent_id, auth_token };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const saveSkillSchema = {
  name: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Short skill title (1-5 words). Re-use an EXISTING skill name to UPDATE that skill instead of creating a duplicate — name match is the dedup key.",
    ),
  description: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "One-line description of when this skill should trigger. The harness uses this in the LLM's available-skills list, so it must be specific enough to drive routing.",
    ),
  content: z
    .string()
    .min(1)
    .describe(
      "Skill body in markdown. May include a YAML frontmatter block (`---` fenced) — if omitted, the platform synthesizes one from name+description at hydration time. Should describe the workflow, triggers, and any helper instructions in the same shape as a Claude Code SKILL.md.",
    ),
} as const;

export const listSkillsSchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Substring filter (case-insensitive) applied to skill name or description. Omit to list all skills.",
    ),
} as const;

export const deleteSkillSchema = {
  skill_id: z
    .string()
    .min(1)
    .describe("UUID of the skill to delete. Get it from `list_skills`."),
} as const;

export type SaveSkillInput = {
  name: string;
  description: string;
  content: string;
};

export type ListSkillsInput = {
  query?: string;
};

export type DeleteSkillInput = {
  skill_id: string;
};

// ---------------------------------------------------------------------------
// Natural-language descriptions (read by the LLM)
// ---------------------------------------------------------------------------

export const saveSkillDescription = [
  "Save a reusable workflow as a Claude Code skill. Use when the user has",
  "asked you to handle a recurring multi-step task the same way every time",
  "('whenever someone asks me to X, do Y, Z'), or when a pattern has",
  "recurred enough that codifying it will save future re-derivation.",
  "Prefer save_memory for single-rule conventions; use save_skill when",
  "the lesson is multi-step or needs a body of instructions. Re-use an",
  "existing skill name to UPDATE — do not create duplicates.",
].join(" ");

export const listSkillsDescription = [
  "List skills currently saved in the user's library. Use to discover an",
  "existing skill you can update (re-pass its name to save_skill) or to",
  "find a skill_id for delete_skill.",
].join(" ");

export const deleteSkillDescription = [
  "Delete a skill from the user's library by skill_id. Also detaches it",
  "from the current agent and removes the local SKILL.md file so it stops",
  "loading on the next turn. Use when the user explicitly asks to remove",
  "a skill — not for retiring stale patterns silently.",
].join(" ");

// ---------------------------------------------------------------------------
// Tool result shape
// ---------------------------------------------------------------------------

export interface SkillsToolResult {
  isError: boolean;
  text: string;
}

// ---------------------------------------------------------------------------
// Handlers — pure async functions, harness-agnostic
// ---------------------------------------------------------------------------

interface SkillRow {
  skill_id: string;
  name: string;
  description: string | null;
  content: string;
}

export async function callSaveSkill(
  env: SkillsEnv,
  input: SaveSkillInput,
): Promise<SkillsToolResult> {
  // 1) Find an existing skill by exact name match (case-sensitive). This is
  // the deterministic dedup signal Shin recommended over fuzzy matching: the
  // LLM controls the name and can deliberately re-use it to trigger an
  // update.
  const listed = await callApi<SkillRow[]>(
    env,
    "GET",
    `${env.base_url}/api/v1/skills`,
  );
  if (!listed.ok) {
    return errorResult("list (dedup precheck)", listed);
  }
  const rows = unwrapList(listed.data);
  const existing = rows.find((r) => r.name === input.name);

  let savedSkill: SkillRow;
  let action: "created" | "updated";

  if (existing) {
    const patched = await callApi<SkillRow>(
      env,
      "PATCH",
      `${env.base_url}/api/v1/skills/${encodeURIComponent(existing.skill_id)}`,
      {
        description: input.description,
        content: input.content,
      },
    );
    if (!patched.ok) return errorResult("update", patched);
    savedSkill = patched.data as SkillRow;
    action = "updated";
  } else {
    const created = await callApi<SkillRow>(
      env,
      "POST",
      `${env.base_url}/api/v1/skills`,
      {
        name: input.name,
        description: input.description,
        content: input.content,
      },
    );
    if (!created.ok) return errorResult("create", created);
    savedSkill = created.data as SkillRow;
    action = "created";
  }

  // 2) Attach to the current agent so the skill survives across sessions.
  // Detach-then-attach is idempotent: detach is a no-op when not attached,
  // and attach appends a fresh `<!-- skill:id -->` block. This avoids the
  // duplicate-block trap that would occur if the agent already had the
  // skill attached and we attached again.
  const attachUrl = `${env.base_url}/api/v1/managed_agents/agents/${encodeURIComponent(env.agent_id)}/skill`;
  const detached = await callApi(
    env,
    "DELETE",
    `${attachUrl}?skill_id=${encodeURIComponent(savedSkill.skill_id)}`,
  );
  // 404 from detach is fine (skill wasn't attached); anything else is a
  // real failure that should surface to the LLM so it can retry or report.
  if (!detached.ok && detached.status !== 404) {
    return errorResult("detach-before-attach", detached);
  }
  const attached = await callApi(env, "POST", attachUrl, {
    skill_id: savedSkill.skill_id,
  });
  if (!attached.ok) return errorResult("attach", attached);

  // 3) Write the skill to the running container's skills directory so the
  // current session sees it without restart. Claude Code rescans this
  // directory between turns (no SDK restart needed) — but if the active
  // harness happens to cache its skill list at boot, the file is still
  // written and will pick up on the next session anyway.
  const slug = slugifySkillName(savedSkill.name, savedSkill.skill_id);
  const localPath = writeLocalSkill(slug, savedSkill, input);

  const lines = [
    `Skill ${action}: "${savedSkill.name}" (${savedSkill.skill_id})`,
    `Attached to agent ${env.agent_id} — will hydrate on every future session.`,
  ];
  if (localPath) {
    lines.push(
      `Wrote ${localPath} for this session. It should appear in your available-skills list on the next turn.`,
    );
  } else {
    lines.push(
      "Local SKILL.md write skipped (HOME unavailable). The skill will be active on next session.",
    );
  }
  return { isError: false, text: lines.join("\n") };
}

export async function callListSkills(
  env: SkillsEnv,
  input: ListSkillsInput,
): Promise<SkillsToolResult> {
  const res = await callApi<SkillRow[]>(
    env,
    "GET",
    `${env.base_url}/api/v1/skills`,
  );
  if (!res.ok) return errorResult("list", res);
  let rows = unwrapList(res.data);
  if (input.query) {
    const q = input.query.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    );
  }
  if (rows.length === 0) {
    return { isError: false, text: "No matching skills." };
  }
  const summary = rows.map((r) => ({
    skill_id: r.skill_id,
    name: r.name,
    description: r.description,
  }));
  return { isError: false, text: JSON.stringify(summary, null, 2) };
}

export async function callDeleteSkill(
  env: SkillsEnv,
  input: DeleteSkillInput,
): Promise<SkillsToolResult> {
  // Look up the row first so we know the slug to remove from local disk.
  // If lookup fails we still attempt the delete — the server is the source
  // of truth — but local-disk cleanup is best-effort.
  const lookup = await callApi<SkillRow>(
    env,
    "GET",
    `${env.base_url}/api/v1/skills/${encodeURIComponent(input.skill_id)}`,
  );
  const row =
    lookup.ok && lookup.data && typeof lookup.data === "object"
      ? (lookup.data as SkillRow)
      : null;

  // Detach from current agent first so the marker doesn't dangle pointing
  // at a deleted skill_id. 404 is fine — wasn't attached.
  const detachUrl = `${env.base_url}/api/v1/managed_agents/agents/${encodeURIComponent(env.agent_id)}/skill?skill_id=${encodeURIComponent(input.skill_id)}`;
  const detached = await callApi(env, "DELETE", detachUrl);
  if (!detached.ok && detached.status !== 404) {
    return errorResult("detach", detached);
  }

  const deleted = await callApi(
    env,
    "DELETE",
    `${env.base_url}/api/v1/skills/${encodeURIComponent(input.skill_id)}`,
  );
  if (!deleted.ok) return errorResult("delete", deleted);

  if (row) {
    const slug = slugifySkillName(row.name, row.skill_id);
    removeLocalSkill(slug);
  }

  return {
    isError: false,
    text: `Deleted skill ${input.skill_id}${row ? ` ("${row.name}")` : ""}. Detached from agent ${env.agent_id} and removed from local disk.`,
  };
}

// ---------------------------------------------------------------------------
// Slug + frontmatter — must stay in sync with src/server/k8s.ts so the
// mid-session write lands at the same path as the next-session hydration.
// ---------------------------------------------------------------------------

export function slugifySkillName(name: string, fallback: string): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback;
  return base;
}

export function ensureSkillFrontmatter(
  content: string,
  meta: { slug: string; name: string; description: string | null },
): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("---\n") || trimmed.startsWith("---\r\n")) {
    return content;
  }
  const description =
    (meta.description ?? "").trim() || `${meta.name} skill`;
  return [
    "---",
    `name: ${meta.slug}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    trimmed,
  ].join("\n");
}

function writeLocalSkill(
  slug: string,
  saved: SkillRow,
  input: SaveSkillInput,
): string | null {
  const home = homedir();
  if (!home) return null;
  const dir = join(home, ".claude", "skills", slug);
  const body = ensureSkillFrontmatter(input.content, {
    slug,
    name: saved.name,
    description: saved.description ?? input.description,
  });
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, body);
    return file;
  } catch {
    return null;
  }
}

function removeLocalSkill(slug: string): void {
  const home = homedir();
  if (!home) return;
  const dir = join(home, ".claude", "skills", slug);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort; the next session's hydration won't see a marker for
    // this skill, so the stale dir would be harmless anyway.
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

async function callApi<T = unknown>(
  env: SkillsEnv,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.auth_token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const data = text ? (safeJson(text) as T) : null;
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorResult(
  op: string,
  res: ApiResponse<unknown>,
): SkillsToolResult {
  return {
    isError: true,
    text: `${op} failed (HTTP ${res.status}): ${
      res.error ?? JSON.stringify(res.data)
    }`,
  };
}

// GET /api/v1/skills currently returns `{ data: [...] }`. Older revisions
// returned the bare array; accept both so the tool is forward/backward
// compatible without coupling tightly to the route's response shape.
function unwrapList(data: unknown): SkillRow[] {
  if (Array.isArray(data)) return data as SkillRow[];
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { data?: unknown[] }).data)
  ) {
    return (data as { data: SkillRow[] }).data;
  }
  return [];
}
