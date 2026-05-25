#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing `save_memory` + `search_memory` for the
 * opencode harness — the same memory tools the claude-agent-sdk harness gets
 * via @lap/managed-tools/memory.
 *
 * PACKAGING NOTE — why this is self-contained instead of importing the shared
 * @lap/managed-tools/memory module:
 *
 *   The opencode harness runs .mjs files under plain `node` with NO TypeScript
 *   build step. Its deps are baked from harnesses/opencode/package.json via the
 *   Dockerfile `mcp-deps` stage (just @modelcontextprotocol/sdk + e2b). The
 *   shared package is a TS workspace pkg consumed as compiled `dist/` plus its
 *   own node_modules (undici/zod) at a fixed /opt/managed-tools path — none of
 *   which exists in the opencode runtime image. Wiring that up (a managed-tools
 *   build stage + ESM resolution for @lap/managed-tools from a bare .mjs) is a
 *   large, build-untested change. So, per the shared spec's own guidance
 *   (managed-tools/src/memory.ts header) that "opencode will wrap them with
 *   whatever its tool API is," and matching how sandbox-mcp.mjs self-contains
 *   its E2B client, this file re-implements the small HTTP client + schemas +
 *   the scrubSecrets() redaction inline.
 *
 *   The CANONICAL implementation lives in managed-tools/src/memory.ts. If you
 *   change the HTTP contract, the schemas, or the scrub patterns there, mirror
 *   the change here. The scrubSecrets() patterns below are a direct port.
 *
 * Env contract (read at boot, same as the shared spec):
 *   LAP_BASE_URL       base URL of the platform
 *   AGENT_ID           which agent's memory we operate on
 *   LAP_ACCESS_TOKEN   short-lived bearer (LAP_AUTH_TOKEN accepted for compat)
 *   LAP_REFRESH_TOKEN  optional long-lived bearer for /agent-auth/refresh
 *
 * If LAP_BASE_URL / AGENT_ID / an access token are missing, memory is not
 * configured: this server exposes NO tools and the harness boots cleanly
 * without memory (the LLM simply never sees save_memory/search_memory).
 *
 * Uses undici's ProxyAgent when HTTPS_PROXY is set so the vault sidecar can
 * swap stub credentials on the wire — same reason the shared spec does.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// ---------------------------------------------------------------------------
// Env wiring (mirrors memoryEnvStatus() in managed-tools/src/memory.ts)
// ---------------------------------------------------------------------------

function resolveMemoryEnv() {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  // Session-scoped mode is for the shared inline harness, which has no per-agent
  // AGENT_ID. The tools take a `session_id` arg instead and hit the
  // session-scoped route; MASTER_KEY is an accepted bearer there.
  const session_scoped = process.env.LAP_MEMORY_SESSION_SCOPED === "1";
  const access_token =
    process.env.LAP_ACCESS_TOKEN ??
    process.env.LAP_AUTH_TOKEN ??
    (session_scoped ? (process.env.MASTER_KEY ?? "") : "");
  const refresh_token = process.env.LAP_REFRESH_TOKEN ?? "";
  const missing = [];
  if (!base_url) missing.push("LAP_BASE_URL");
  if (!session_scoped && !agent_id) missing.push("AGENT_ID");
  if (!access_token) missing.push(session_scoped ? "MASTER_KEY/LAP_ACCESS_TOKEN" : "LAP_ACCESS_TOKEN");
  if (missing.length > 0) return { env: null, missing };
  return { env: { base_url, agent_id, access_token, refresh_token, session_scoped }, missing: [] };
}

// ---------------------------------------------------------------------------
// Secret scrubbing — port of scrubSecrets() in managed-tools/src/memory.ts.
// Keep these patterns in sync with the canonical TS implementation.
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bxapp-[A-Za-z0-9-]{8,}\b/g,
  /\bgh[poseur]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\brnd_[A-Za-z0-9]{20,}\b/g,
  /\be2b_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b([A-Za-z0-9_.-]*(?:secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
];

const HIGH_ENTROPY = /\b[A-Za-z0-9+/=_]{32,}\b/g;

function looksHighEntropy(s) {
  if (/[+/=]/.test(s)) return true;
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  return hasLower && hasUpper && hasDigit;
}

function scrubSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, key) =>
      typeof key === "string" ? `${key}=${REDACTED}` : REDACTED,
    );
  }
  out = out.replace(HIGH_ENTROPY, (m) => (looksHighEntropy(m) ? REDACTED : m));
  return out;
}

// ---------------------------------------------------------------------------
// Proxy-aware fetch (mirrors managed-tools/src/memory.ts).
// ---------------------------------------------------------------------------

let _proxyAgent; // undefined = not resolved yet
function proxyDispatcher() {
  if (_proxyAgent !== undefined) return _proxyAgent ?? undefined;
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
  _proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  return _proxyAgent ?? undefined;
}

// ---------------------------------------------------------------------------
// HTTP client with refresh-on-401 (mirrors the shared spec).
// ---------------------------------------------------------------------------

let cachedAccessToken = null;

function memoryUrl(env, suffix = "", qs = null, session_id = "") {
  const base = env.session_scoped
    ? `${env.base_url}/api/v1/managed_agents/sessions/${encodeURIComponent(session_id)}/memory${suffix}`
    : `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/memory${suffix}`;
  return qs && qs.toString() ? `${base}?${qs.toString()}` : base;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function rawCall(method, url, body, bearer) {
  try {
    const dispatcher = proxyDispatcher();
    const res = await undiciFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(dispatcher !== undefined && { dispatcher }),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function refreshAccessToken(env) {
  try {
    const dispatcher = proxyDispatcher();
    const res = await undiciFetch(`${env.base_url}/api/v1/agent-auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: env.refresh_token }),
      ...(dispatcher !== undefined && { dispatcher }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json.access_token === "string" && json.access_token.length > 0
      ? json.access_token
      : null;
  } catch {
    return null;
  }
}

async function callApi(env, method, url, body) {
  const bearer = cachedAccessToken ?? env.access_token;
  const first = await rawCall(method, url, body, bearer);
  if (first.status !== 401 || !env.refresh_token) return first;
  const refreshed = await refreshAccessToken(env);
  if (!refreshed) return first;
  cachedAccessToken = refreshed;
  return rawCall(method, url, body, refreshed);
}

async function callSaveMemory(env, input, extra = {}) {
  if (env.session_scoped && !input.session_id) {
    return { isError: true, text: "save_memory failed: session_id is required — copy it verbatim from <lap_session_id> in your context." };
  }
  const res = await callApi(env, "POST", memoryUrl(env, "", null, input.session_id), {
    text: scrubSecrets(input.text),
    tags: input.tags ?? [],
    type: input.type,
    priority: input.priority,
    pinned: input.pinned,
    source: "agent",
    source_session_id: input.session_id ?? extra.source_session_id,
  });
  if (!res.ok) {
    return {
      isError: true,
      text: `save_memory failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}`,
    };
  }
  return { isError: false, text: `Saved memory:\n${JSON.stringify(res.data, null, 2)}` };
}

async function callSearchMemory(env, input) {
  if (env.session_scoped && !input.session_id) {
    return { isError: true, text: "search_memory failed: session_id is required — copy it verbatim from <lap_session_id> in your context." };
  }
  const qs = new URLSearchParams();
  if (input.query) qs.set("q", input.query);
  if (input.tag) qs.set("tag", input.tag);
  const res = await callApi(env, "GET", memoryUrl(env, "", qs, input.session_id));
  if (!res.ok) {
    return {
      isError: true,
      text: `search_memory failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}`,
    };
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) return { isError: false, text: "No matching memories." };
  return { isError: false, text: JSON.stringify(rows, null, 2) };
}

// ---------------------------------------------------------------------------
// Tool specs — JSON Schema (mirrors the zod schemas + descriptions in the
// shared spec). opencode/MCP wants JSON Schema, not zod.
// ---------------------------------------------------------------------------

const SAVE_MEMORY_DESCRIPTION = [
  "Save a durable lesson the user has just taught you, so it applies to",
  "every future run of this agent. Use when the user gives generalizable",
  "feedback ('next time', 'always', 'never', 'going forward', or",
  "explicitly types 'remember:'). Phrase the lesson generically — for",
  "future tasks, not for this PR specifically.",
].join(" ");

const SEARCH_MEMORY_DESCRIPTION = [
  "Search this agent's active memory for relevant lessons. MANDATORY",
  "checkpoint before you finalize and file a PR — build a query from what",
  "you actually changed (files, features, components) and read each",
  "returned memory. If your work violates one, fix the violation before",
  "filing. Optional mid-task when making a stylistic decision.",
].join(" ");

const TOOLS = [
  {
    name: "save_memory",
    description: SAVE_MEMORY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description:
            "The lesson, phrased generically. One rule per call. Markdown OK.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          maxItems: 4,
          description:
            "1-4 short kebab-case labels for grouping/filtering (e.g. ui, antd, pr, security).",
        },
        type: {
          type: "string",
          enum: ["convention", "constraint", "reference", "preference"],
          description:
            "convention=how things are done; constraint=hard rule; reference=pointer to docs; preference=soft style.",
        },
        priority: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description: "Higher = surfaces first in pre-load and search. Default 0.",
        },
        pinned: {
          type: "boolean",
          description:
            "Always-on: when true, this memory is unconditionally included in the AGENT_PROMPT pre-load on every future session, independent of the priority/usage ranking. Use sparingly — reserve for rules the agent absolutely cannot afford to miss (security constraints, hard requirements the user emphasized with 'always' / 'never'). Defaults to false.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "search_memory",
    description: SEARCH_MEMORY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Substring filter (case-insensitive) on memory text. Omit to list all.",
        },
        tag: {
          type: "string",
          description:
            "Restrict to memories that include this tag (e.g. 'ui', 'security').",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const { env, missing } = resolveMemoryEnv();

const server = new Server(
  { name: "lap-memory", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// In session-scoped mode (shared inline harness) the tools need a `session_id`
// arg so the platform can resolve which agent's memory to use.
function withSessionArg(tools) {
  return tools.map((t) => ({
    ...t,
    inputSchema: {
      ...t.inputSchema,
      properties: {
        ...t.inputSchema.properties,
        session_id: {
          type: "string",
          description:
            "The current LAP session id — copy it verbatim from <lap_session_id> in your context. Required.",
        },
      },
      required: [...(t.inputSchema.required ?? []), "session_id"],
    },
  }));
}

const EXPOSED_TOOLS = env ? (env.session_scoped ? withSessionArg(TOOLS) : TOOLS) : [];

// When memory isn't configured, expose NO tools — the harness still boots and
// the LLM simply never sees save_memory/search_memory.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: EXPOSED_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!env) {
    return { content: [{ type: "text", text: "memory not configured" }], isError: true };
  }
  let out;
  if (name === "save_memory") {
    out = await callSaveMemory(env, args ?? {}, {
      source_session_id: process.env.SESSION_ID || undefined,
    });
  } else if (name === "search_memory") {
    out = await callSearchMemory(env, args ?? {});
  } else {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  return { content: [{ type: "text", text: out.text }], isError: out.isError };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  env
    ? env.session_scoped
      ? `[memory-mcp] ready (session-scoped, base=${env.base_url})`
      : `[memory-mcp] ready (agent=${env.agent_id}, base=${env.base_url})`
    : `[memory-mcp] disabled — missing env: ${missing.join(", ")}. ` +
        `save_memory/search_memory will NOT be exposed.`,
);
