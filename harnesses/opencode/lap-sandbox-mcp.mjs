#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing `lap_update_sandbox_setup` and
 * `lap_get_sandbox_setup` for the opencode harness.
 *
 * When the agent wants its next sandbox to run a custom setup script, it calls
 * `lap_update_sandbox_setup(script)`. The platform stores the script in
 * `sandbox_files` as a `setup.sh` entry, and every future sandbox provisioned
 * for that agent executes it automatically before the agent's first turn.
 *
 * Env contract:
 *   LAP_BASE_URL       platform base URL
 *   LAP_ACCESS_TOKEN   short-lived bearer (LAP_AUTH_TOKEN accepted for compat)
 *   LAP_REFRESH_TOKEN  optional long-lived bearer for /agent-auth/refresh
 *   AGENT_ID           agent UUID — optional at boot; used if agent_id not in args
 *   HTTPS_PROXY        optional — vault sidecar proxy for credential swapping
 *
 * If LAP_BASE_URL / an access token are missing this server exposes NO tools
 * and the harness boots cleanly without sandbox setup support.
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
// Tool implementations
// ---------------------------------------------------------------------------

async function callUpdateSandboxSetup(env, input) {
  const agent_id = process.env.AGENT_ID || input.agent_id;
  if (!agent_id) return { isError: true, text: "lap_update_sandbox_setup: agent_id required" };
  if (typeof input.script !== "string" || input.script.trim() === "") {
    return { isError: true, text: "lap_update_sandbox_setup: script must be a non-empty string" };
  }

  // GET current sandbox_files, replace/upsert the setup.sh entry
  const getRes = await callApi(env, "GET", `${env.base_url}/api/v1/managed_agents/agents/${agent_id}`, undefined);
  if (!getRes.ok || getRes.data == null) {
    return { isError: true, text: `lap_update_sandbox_setup: failed to fetch agent (HTTP ${getRes.status})` };
  }

  const existing = (getRes.data.sandbox_files ?? []).filter((f) => f.name !== "setup.sh");
  const scriptBuf = Buffer.from(input.script);
  const updated = [
    ...existing,
    {
      name: "setup.sh",
      sandbox_path: "/lap/setup.sh",
      content: scriptBuf.toString("base64"),
      content_type: "application/x-sh",
      size: scriptBuf.length,
    },
  ];

  const patchRes = await callApi(env, "PATCH", `${env.base_url}/api/v1/managed_agents/agents/${agent_id}`, { sandbox_files: updated });
  if (!patchRes.ok) {
    return {
      isError: true,
      text: `lap_update_sandbox_setup failed (HTTP ${patchRes.status}): ${patchRes.error ?? JSON.stringify(patchRes.data)}`,
    };
  }

  return {
    isError: false,
    text: "setup.sh saved. New sandboxes for this agent will run it automatically.",
  };
}

async function callGetSandboxSetup(env, input) {
  const agent_id = process.env.AGENT_ID || input.agent_id;
  if (!agent_id) return { isError: true, text: "lap_get_sandbox_setup: agent_id required" };

  const res = await callApi(env, "GET", `${env.base_url}/api/v1/managed_agents/agents/${agent_id}`, undefined);
  if (!res.ok || res.data == null) {
    return { isError: true, text: `lap_get_sandbox_setup failed (HTTP ${res.status})` };
  }

  const entry = (res.data.sandbox_files ?? []).find((f) => f.name === "setup.sh");
  if (!entry) return { isError: false, text: "No setup.sh in sandbox_files." };

  try {
    return { isError: false, text: Buffer.from(entry.content, "base64").toString("utf-8") };
  } catch {
    return { isError: false, text: entry.content };
  }
}

// ---------------------------------------------------------------------------
// Tool spec
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "lap_update_sandbox_setup",
    description:
      "Save a bash script that runs automatically every time a new sandbox is provisioned for this agent. Use this to install dependencies, start services (postgres, redis, litellm proxy), or export environment variables to /tmp/lap_env. The script runs before the agent gets its first message.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "Bash script content. Will run as setup.sh in each new sandbox.",
        },
        agent_id: {
          type: "string",
          description: "Your agent_id — visible in your system prompt. Required on inline harness.",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "lap_get_sandbox_setup",
    description: "Retrieve the current setup.sh script configured for this agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Your agent_id — visible in your system prompt.",
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
  { name: "lap-sandbox-setup", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: env ? TOOLS : [],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!env) {
    return {
      content: [{ type: "text", text: "sandbox setup MCP not configured" }],
      isError: true,
    };
  }
  if (name === "lap_update_sandbox_setup") {
    const out = await callUpdateSandboxSetup(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  if (name === "lap_get_sandbox_setup") {
    const out = await callGetSandboxSetup(env, args ?? {});
    return { content: [{ type: "text", text: out.text }], isError: out.isError };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  env
    ? `[lap-sandbox-mcp] ready (base=${env.base_url})`
    : `[lap-sandbox-mcp] disabled — missing env: ${missing.join(", ")}`,
);
