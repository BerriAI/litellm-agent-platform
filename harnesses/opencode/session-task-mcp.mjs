#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing task-checkpointing tools for the
 * opencode harness:
 *
 *   save_task_progress   — write current task state to the session row
 *   list_blocked_tasks   — list blocked tasks from prior sessions (same agent)
 *   get_blocked_task     — read full checkpoint for a specific prior session
 *
 * Env contract (same as report-issue-mcp.mjs):
 *   LAP_BASE_URL       platform base URL
 *   SESSION_ID         current session UUID — optional at boot; passed as tool arg on inline harness
 *   LAP_ACCESS_TOKEN   short-lived bearer (LAP_AUTH_TOKEN accepted for compat)
 *   LAP_REFRESH_TOKEN  optional long-lived bearer for /agent-auth/refresh
 *   HTTPS_PROXY        optional — vault sidecar proxy for credential swapping
 *
 * If LAP_BASE_URL / an access token are missing this server exposes NO tools
 * and the harness boots cleanly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

function resolveEnv() {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const access_token =
    process.env.LAP_ACCESS_TOKEN ?? process.env.LAP_AUTH_TOKEN ?? "";
  const refresh_token = process.env.LAP_REFRESH_TOKEN ?? "";
  const missing = [];
  if (!base_url) missing.push("LAP_BASE_URL");
  if (!access_token) missing.push("LAP_ACCESS_TOKEN");
  if (missing.length > 0) return { env: null, missing };
  return { env: { base_url, access_token, refresh_token }, missing: [] };
}

// ---------------------------------------------------------------------------
// Proxy-aware fetch
// ---------------------------------------------------------------------------

let _proxyAgent;
function proxyDispatcher() {
  if (_proxyAgent !== undefined) return _proxyAgent ?? undefined;
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
  _proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  return _proxyAgent ?? undefined;
}

// ---------------------------------------------------------------------------
// HTTP client with retry + refresh-on-401
// ---------------------------------------------------------------------------

let cachedAccessToken = null;

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
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const RETRY_DELAYS_MS = [200, 600, 1500];
function isTransient(res) {
  return res.status === 0 || (res.status >= 500 && res.status < 600);
}
async function retryCall(method, url, body, bearer) {
  let last = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    last = await rawCall(method, url, body, bearer);
    if (!isTransient(last)) return last;
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  return last;
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
  const first = await retryCall(method, url, body, bearer);
  if (first.status !== 401 || !env.refresh_token) return first;
  const refreshed = await refreshAccessToken(env);
  if (!refreshed) return first;
  cachedAccessToken = refreshed;
  return retryCall(method, url, body, refreshed);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function callSaveTaskProgress(env, input) {
  const session_id = process.env.SESSION_ID || input.session_id;
  if (!session_id) return { isError: true, text: "save_task_progress: session_id required" };
  const url = `${env.base_url}/api/v1/managed_agents/sessions/${encodeURIComponent(session_id)}/task_checkpoint`;
  const res = await callApi(env, "POST", url, {
    summary: input.summary,
    status: input.status,
    ...(input.blocked_reason && { blocked_reason: input.blocked_reason }),
  });
  if (!res.ok) return { isError: true, text: `save_task_progress failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}` };
  return { isError: false, text: "Task progress saved." };
}

async function callListBlockedTasks(env, input) {
  const session_id = process.env.SESSION_ID || input.session_id;
  if (!session_id) return { isError: true, text: "list_blocked_tasks: session_id required" };
  const url = `${env.base_url}/api/v1/managed_agents/sessions/${encodeURIComponent(session_id)}/blocked_tasks`;
  const res = await callApi(env, "GET", url, undefined);
  if (!res.ok) return { isError: true, text: `list_blocked_tasks failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}` };
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) return { isError: false, text: "No blocked tasks. Pick a new ticket." };
  return { isError: false, text: JSON.stringify(rows, null, 2) };
}

async function callGetBlockedTask(env, input) {
  if (!input.session_id) return { isError: true, text: "get_blocked_task: session_id (of the prior session) is required" };
  const url = `${env.base_url}/api/v1/managed_agents/sessions/${encodeURIComponent(input.session_id)}/task_checkpoint`;
  const res = await callApi(env, "GET", url, undefined);
  if (!res.ok) return { isError: true, text: `get_blocked_task failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}` };
  if (!res.data) return { isError: false, text: "No checkpoint found for that session." };
  return { isError: false, text: JSON.stringify(res.data, null, 2) };
}

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "save_task_progress",
    description: "Checkpoint your current task so another session can resume it if this one gets blocked or dies. Call after picking a task and completing analysis, after each significant step, and ALWAYS before standing down or giving up. status=in_progress: actively working. status=blocked: cannot continue, another session should pick this up. status=complete: task fully done.",
    inputSchema: {
      type: "object",
      required: ["summary", "status"],
      properties: {
        summary: {
          type: "string",
          description: "Everything a fresh agent needs to resume: what the task is, what you found, what's done, what's next. Free text, be thorough.",
        },
        status: {
          type: "string",
          enum: ["in_progress", "blocked", "complete"],
        },
        blocked_reason: {
          type: "string",
          description: "Why you are blocked. Required when status=blocked. Be specific — the next agent will use this to decide if the blocker is gone.",
        },
        session_id: {
          type: "string",
          description: "Your current session_id from <lap_session_id>. Required on the inline harness where SESSION_ID env var is not set.",
        },
      },
    },
  },
  {
    name: "list_blocked_tasks",
    description: "List tasks from prior sessions that got blocked and need to be picked up. Call this at the start of each session BEFORE picking a new Linear ticket. If any blocked tasks exist, attempt to continue them first.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Your current session_id from <lap_session_id>. Required on the inline harness.",
        },
      },
    },
  },
  {
    name: "get_blocked_task",
    description: "Get the full task checkpoint for a specific prior session. Use after list_blocked_tasks to read the full summary and context before deciding whether to pick it up.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: {
          type: "string",
          description: "The session_id of the prior blocked session (from list_blocked_tasks output).",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const { env, missing } = resolveEnv();

const server = new Server(
  { name: "lap-session-task", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: env ? TOOLS : [],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!env) {
    return { content: [{ type: "text", text: "session task not configured" }], isError: true };
  }
  if (name === "save_task_progress") {
    const out = await callSaveTaskProgress(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  if (name === "list_blocked_tasks") {
    const out = await callListBlockedTasks(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  if (name === "get_blocked_task") {
    const out = await callGetBlockedTask(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  env
    ? `[session-task-mcp] ready (base=${env.base_url})`
    : `[session-task-mcp] disabled — missing env: ${missing.join(", ")}. save_task_progress/list_blocked_tasks/get_blocked_task will NOT be exposed.`,
);
