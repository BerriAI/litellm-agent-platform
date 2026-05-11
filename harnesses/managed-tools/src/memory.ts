/**
 * Memory tool spec — used by every harness adapter.
 *
 * Exposes the agent-facing `save_memory` and `search_memory` tools as two
 * pieces:
 *
 *   1. Input schemas (zod) + natural-language descriptions for the LLM.
 *   2. Handler functions that call back into the LAP HTTP API.
 *
 * What's NOT here: the harness-specific tool-registration glue. The Claude
 * Agent SDK harness wraps these with `createSdkMcpServer({ tools: [...] })`;
 * opencode will wrap them with whatever its tool API is. Both adapters
 * stay short — see harnesses/claude-agent-sdk/src/memory-tools.ts.
 *
 * Env contract (read at tool-call time, not at module load):
 *
 *   LAP_BASE_URL     base URL of the platform (e.g. https://lap.example.com)
 *   AGENT_ID         which agent's memory we operate on
 *   LAP_AUTH_TOKEN   bearer token for /api/v1/managed_agents/*
 *
 * If any are missing, `memoryEnv()` returns null and the adapter is
 * expected to skip registering the tools — harness boots cleanly without
 * memory, the LLM simply doesn't see those tool names.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

export interface MemoryEnv {
  base_url: string;
  agent_id: string;
  auth_token: string;
}

export function memoryEnv(): MemoryEnv | null {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  const auth_token = process.env.LAP_AUTH_TOKEN ?? "";
  if (!base_url || !agent_id || !auth_token) return null;
  return { base_url, agent_id, auth_token };
}

// ---------------------------------------------------------------------------
// Input schemas (zod raw shapes — harness adapters convert as needed)
// ---------------------------------------------------------------------------

export const saveMemorySchema = {
  text: z
    .string()
    .min(1)
    .describe(
      "The lesson, phrased generically. One rule per call. Markdown OK.",
    ),
  tags: z
    .array(z.string())
    .max(4)
    .optional()
    .describe(
      "1-4 short kebab-case labels for grouping/filtering (e.g. ui, antd, pr, security).",
    ),
  type: z
    .enum(["convention", "constraint", "reference", "preference"])
    .optional()
    .describe(
      "convention=how things are done; constraint=hard rule; reference=pointer to docs; preference=soft style.",
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("Higher = surfaces first in pre-load and search. Default 0."),
} as const;

export const searchMemorySchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Substring filter (case-insensitive) on memory text. Omit to list all.",
    ),
  tag: z
    .string()
    .optional()
    .describe(
      "Restrict to memories that include this tag (e.g. 'ui', 'security').",
    ),
} as const;

export type SaveMemoryInput = {
  text: string;
  tags?: string[];
  type?: "convention" | "constraint" | "reference" | "preference";
  priority?: number;
};

export type SearchMemoryInput = {
  query?: string;
  tag?: string;
};

// ---------------------------------------------------------------------------
// Natural-language descriptions (read by the LLM)
// ---------------------------------------------------------------------------

export const saveMemoryDescription = [
  "Save a durable lesson the user has just taught you, so it applies to",
  "every future run of this agent. Use when the user gives generalizable",
  "feedback ('next time', 'always', 'never', 'going forward', or",
  "explicitly types 'remember:'). Phrase the lesson generically — for",
  "future tasks, not for this PR specifically.",
].join(" ");

export const searchMemoryDescription = [
  "Search this agent's active memory for relevant lessons. MANDATORY",
  "checkpoint before you finalize and file a PR — build a query from what",
  "you actually changed (files, features, components) and read each",
  "returned memory. If your work violates one, fix the violation before",
  "filing. Optional mid-task when making a stylistic decision.",
].join(" ");

// ---------------------------------------------------------------------------
// Tool result shape — adapters re-pack into their harness's expected format
// ---------------------------------------------------------------------------

export interface MemoryToolResult {
  isError: boolean;
  text: string; // human/LLM-readable result body
}

// ---------------------------------------------------------------------------
// Handlers — pure async functions, harness-agnostic
// ---------------------------------------------------------------------------

export async function callSaveMemory(
  env: MemoryEnv,
  input: SaveMemoryInput,
  extra: { source_session_id?: string } = {},
): Promise<MemoryToolResult> {
  const res = await callApi(env, "POST", memoryUrl(env), {
    text: input.text,
    tags: input.tags ?? [],
    type: input.type,
    priority: input.priority,
    source: "agent",
    source_session_id: extra.source_session_id,
  });
  if (!res.ok) {
    return {
      isError: true,
      text: `save_memory failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  return {
    isError: false,
    text: `Saved memory:\n${JSON.stringify(res.data, null, 2)}`,
  };
}

export async function callSearchMemory(
  env: MemoryEnv,
  input: SearchMemoryInput,
): Promise<MemoryToolResult> {
  const qs = new URLSearchParams();
  if (input.query) qs.set("q", input.query);
  if (input.tag) qs.set("tag", input.tag);
  const res = await callApi(env, "GET", memoryUrl(env, "", qs));
  if (!res.ok) {
    return {
      isError: true,
      text: `search_memory failed (HTTP ${res.status}): ${
        res.error ?? JSON.stringify(res.data)
      }`,
    };
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) {
    return { isError: false, text: "No matching memories." };
  }
  return { isError: false, text: JSON.stringify(rows, null, 2) };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function memoryUrl(
  env: MemoryEnv,
  suffix = "",
  qs: URLSearchParams | null = null,
): string {
  const base = `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/memory${suffix}`;
  return qs && qs.toString() ? `${base}?${qs.toString()}` : base;
}

async function callApi(
  env: MemoryEnv,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
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
    const data = text ? safeJson(text) : null;
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
