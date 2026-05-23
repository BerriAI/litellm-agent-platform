#!/usr/bin/env node
/**
 * Emits the `mcp` object for opencode.json (stdout, JSON).
 *
 * opencode `serve` only reads MCP config from opencode.json at startup — it
 * ignores the per-session `mcp_servers` the platform sends. So this builds the
 * MCP config at boot from two sources:
 *
 *   1. The E2B sandbox MCP (local stdio) — when E2B_API_KEY is set.
 *   2. Every MCP server the harness's LiteLLM key can access — discovered via
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
