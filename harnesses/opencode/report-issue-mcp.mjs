#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing `report_issue` for the opencode harness.
 *
 * When the agent encounters a problem it wants to surface to operators
 * (a broken dependency, a flaky test, a recurring error pattern, etc.), it
 * calls this tool. Reports are stored per-agent in the platform DB and shown
 * on the agent detail page so operators see all issues across sessions in one
 * place.
 *
 * Env contract:
 *   LAP_BASE_URL       platform base URL
 *   SESSION_ID         current session UUID — optional at boot; used at call time
 *                      if session_id is not passed as a tool argument
 *   LAP_ACCESS_TOKEN   short-lived bearer (LAP_AUTH_TOKEN accepted for compat)
 *   LAP_REFRESH_TOKEN  optional long-lived bearer for /agent-auth/refresh
 *   HTTPS_PROXY        optional — vault sidecar proxy for credential swapping
 *
 * If LAP_BASE_URL / an access token are missing this server exposes NO tools
 * and the harness boots cleanly without issue reporting.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// ---------------------------------------------------------------------------
// Top-level env constants (mirrors sandbox-mcp.mjs pattern)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

function resolveEnv() {
  const base_url = (process.env.LAP_BASE_URL ?? "").replace(/\/+$/, "");
  const agent_id = process.env.AGENT_ID ?? "";
  const access_token =
    process.env.LAP_ACCESS_TOKEN ?? process.env.LAP_AUTH_TOKEN ?? "";
  const refresh_token = process.env.LAP_REFRESH_TOKEN ?? "";
  const missing = [];
  if (!base_url) missing.push("LAP_BASE_URL");
  if (!agent_id) missing.push("AGENT_ID");
  if (!access_token) missing.push("LAP_ACCESS_TOKEN");
  if (missing.length > 0) return { env: null, missing };
  return { env: { base_url, agent_id, access_token, refresh_token }, missing: [] };
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
// HTTP client with refresh-on-401
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

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

async function callReportIssue(env, input) {
  const url = `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/issues`;
  const res = await callApi(env, "POST", url, {
    title: input.title,
    body: input.body,
    severity: input.severity,
    session_id: input.session_id,
  });
  if (!res.ok) {
    return {
      isError: true,
      text: `report_issue failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}`,
    };
  }
  return {
    isError: false,
    text: `Issue reported (id=${res.data?.id ?? "?"}): ${input.title}`,
  };
}

async function callListIssues(env, input) {
  const qs = new URLSearchParams({ status: input.status ?? "open" });
  if (input.severity) qs.set("severity", input.severity);
  const url = `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/issues?${qs}`;
  const res = await callApi(env, "GET", url, undefined);
  if (!res.ok) {
    return { isError: true, text: `list_issues failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}` };
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) return { isError: false, text: "No issues found." };
  const summary = rows.map((i) =>
    `- [${i.id}] (${i.severity}, ×${i.times_seen}) ${i.title}`
  ).join("\n");
  return { isError: false, text: summary };
}

async function callUpdateIssue(env, input) {
  if (!input.issue_id) return { isError: true, text: "update_issue: issue_id is required" };
  const url = `${env.base_url}/api/v1/managed_agents/agents/${env.agent_id}/issues/${input.issue_id}`;
  const body = {};
  if (input.status) body.status = input.status;
  if (input.severity) body.severity = input.severity;
  const res = await callApi(env, "PATCH", url, body);
  if (!res.ok) {
    return { isError: true, text: `update_issue failed (HTTP ${res.status}): ${res.error ?? JSON.stringify(res.data)}` };
  }
  return { isError: false, text: `Issue ${input.issue_id} updated.` };
}

// ---------------------------------------------------------------------------
// Tool spec
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "report_issue",
    description: "Report anything that blocked or degraded your ability to complete the task — missing tools, broken APIs, missing permissions, unclear instructions, or any other blocker. File it whenever you stop, get stuck, or have to work around something. If the same title is filed again, it increments an occurrence counter instead of creating a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short one-line summary of the issue (max 500 chars).",
        },
        body: {
          type: "string",
          description:
            "Optional detailed description: what failed, reproduction steps, context. Markdown OK.",
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error", "critical"],
          description:
            "info=FYI; warning=degraded but workable; error=task blocked; critical=data/security risk.",
        },
        session_id: {
          type: "string",
          description: "Session where this issue was observed — lets operators click through to the session for context.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "list_issues",
    description: "List open issues for this agent. Call this at the start of a session to check for known problems before filing a new one — if a matching issue exists, use update_issue instead.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "resolved", "dismissed"],
          description: "Filter by status. Defaults to 'open'.",
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error", "critical"],
          description: "Optional severity filter.",
        },
      },
    },
  },
  {
    name: "update_issue",
    description: "Update the status or severity of an existing issue. Use this when you see a known issue recurring (escalate severity) or confirm it is fixed (status=resolved).",
    inputSchema: {
      type: "object",
      properties: {
        issue_id: {
          type: "string",
          description: "The issue ID from list_issues.",
        },
        status: {
          type: "string",
          enum: ["open", "resolved", "dismissed"],
          description: "New status.",
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error", "critical"],
          description: "New severity.",
        },
      },
      required: ["issue_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const { env, missing } = resolveEnv();

const server = new Server(
  { name: "lap-issue-reporter", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: env ? TOOLS : [],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!env) {
    return {
      content: [{ type: "text", text: "issue reporter not configured" }],
      isError: true,
    };
  }
  if (name === "report_issue") {
    const out = await callReportIssue(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  if (name === "list_issues") {
    const out = await callListIssues(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  if (name === "update_issue") {
    const out = await callUpdateIssue(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  env
    ? `[report-issue-mcp] ready (base=${env.base_url})`
    : `[report-issue-mcp] disabled — missing env: ${missing.join(", ")}. report_issue will NOT be exposed.`,
);
