#!/usr/bin/env node
/**
 * Emits the `mcp` object for opencode.json (stdout, JSON).
 *
 * opencode `serve` only reads MCP config from opencode.json at startup — it
 * ignores the per-session `mcp_servers` the platform sends. So this builds the
 * MCP config at boot from two sources:
 *
 *   1. The E2B sandbox MCP (local stdio) — when E2B_API_KEY is set.
 *   2. The LAP memory MCP (local stdio) — when memory env is configured
 *      (LAP_BASE_URL + AGENT_ID + an access token). Exposes save_memory /
 *      search_memory, same tools the claude-agent-sdk harness gets.
 *   3. Every MCP server the harness's LiteLLM key can access — discovered via
 *      `${base}/v1/mcp/server` and wired as `remote` entries pointing at
 *      `${base}/mcp/<name>` with `Authorization: Bearer <key>` (same gateway +
 *      key + URL convention the platform's resolveAgentMcpServers uses).
 *
 * Failure to reach LiteLLM is non-fatal: we emit whatever we have (possibly
 * just the sandbox MCP, or `{}`) so the harness still boots.
 */

const out = {};

// --- E2B sandbox MCP (local) ---
const e2bKey = process.env.E2B_API_KEY;
if (e2bKey) {
  out.sandbox = {
    type: "local",
    command: ["node", "/opt/lap/opencode-sandbox-mcp/sandbox-mcp.mjs"],
    enabled: true,
    environment: {
      E2B_API_KEY: e2bKey,
      E2B_TEMPLATE: process.env.E2B_TEMPLATE || "base",
      ...(process.env.LAP_BASE_URL && { LAP_BASE_URL: process.env.LAP_BASE_URL }),
      ...(process.env.LAP_AUTH_TOKEN && { LAP_AUTH_TOKEN: process.env.LAP_AUTH_TOKEN }),
      ...(process.env.MASTER_KEY && { MASTER_KEY: process.env.MASTER_KEY }),
      ...(process.env.SESSION_ID && { SESSION_ID: process.env.SESSION_ID }),
    },
  };
}

// --- LAP memory MCP (local) ---
// Gate on the same env contract the memory MCP itself reads. We only pass the
// memory env vars through here; the MCP re-reads and re-validates them at boot.
// LAP_AUTH_TOKEN is accepted as a fallback for the access token (backward-compat
// with older pods), matching the shared spec.
const memBase = (process.env.LAP_BASE_URL || "").replace(/\/+$/, "");
const memAgent = process.env.AGENT_ID || "";
const memAccess = process.env.LAP_ACCESS_TOKEN || process.env.LAP_AUTH_TOKEN || "";
if (memBase && memAgent && memAccess) {
  out["lap-memory"] = {
    type: "local",
    command: ["node", "/opt/lap/opencode-sandbox-mcp/memory-mcp.mjs"],
    enabled: true,
    environment: {
      LAP_BASE_URL: memBase,
      AGENT_ID: memAgent,
      LAP_ACCESS_TOKEN: memAccess,
      ...(process.env.LAP_REFRESH_TOKEN && { LAP_REFRESH_TOKEN: process.env.LAP_REFRESH_TOKEN }),
      ...(process.env.SESSION_ID && { SESSION_ID: process.env.SESSION_ID }),
      // Pass proxy + CA so the vault sidecar can swap stub creds on the wire,
      // exactly as the in-process shared client does.
      ...(process.env.HTTPS_PROXY && { HTTPS_PROXY: process.env.HTTPS_PROXY }),
      ...(process.env.NODE_EXTRA_CA_CERTS && { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
    },
  };
}

// --- LiteLLM gateway MCP servers (remote) ---
const rawBase = process.env.LITELLM_API_BASE || "";
const key = process.env.LITELLM_API_KEY || "";
// Strip trailing slash and a trailing /v1 so we can append both /v1/mcp/server
// and /mcp/<name> cleanly.
const base = rawBase.replace(/\/+$/, "").replace(/\/v1$/, "");

if (base && key) {
  try {
    const res = await fetch(`${base}/v1/mcp/server`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const servers = await res.json();
      const list = Array.isArray(servers) ? servers : servers.servers ?? [];
      for (const s of list) {
        const name = s.alias || s.server_name;
        if (!name) continue;
        out[name] = {
          type: "remote",
          url: `${base}/mcp/${encodeURIComponent(name)}`,
          enabled: true,
          headers: { Authorization: `Bearer ${key}` },
        };
      }
    } else {
      console.error(`[gen-mcp-config] LiteLLM /v1/mcp/server returned ${res.status}`);
    }
  } catch (err) {
    console.error(`[gen-mcp-config] could not list MCP servers: ${err instanceof Error ? err.message : String(err)}`);
  }
}

process.stdout.write(JSON.stringify(out));
