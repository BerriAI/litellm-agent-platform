#!/usr/bin/env node
/**
 * sandbox-mcp — MCP server exposing sandbox tools to opencode.
 *
 * Two modes, decided by env:
 *   1. PLATFORM mode (LAP_BASE_URL + LAP_AUTH_TOKEN/MASTER_KEY set): every
 *      sandbox tool routes through the platform's
 *      /api/v1/managed_agents/sessions/<id>/sandbox/* endpoints. That path is
 *      what injects per-agent env-var stubs (GITHUB_TOKEN, etc.) into the e2b
 *      sandbox and wires HTTPS_PROXY at the vault — i.e. the only path that
 *      gives the agent a working `gh`/`git push`. Every tool REQUIRES
 *      `session_id` in this mode; there is no per-call session context in a
 *      shared inline-server harness, so the agent must pass the id explicitly
 *      (it lives in <lap_session_id> in its context).
 *   2. STANDALONE mode (no LAP_BASE_URL): direct E2B with only HTTPS_PROXY
 *      from VAULT_URL if set. Used for local dev / one-off harnesses with no
 *      platform behind them. No agent env stubs are available in this mode.
 *
 * Earlier versions silently fell back from PLATFORM to STANDALONE when the
 * agent omitted `session_id`. That's the bug behind LAP issue
 * 4ef96d1a — the shared inline harness has no per-session SESSION_ID env, so
 * every call hit the fallback and the sandbox got zero credential plumbing
 * (empty env, no /lap-shared, vault unreachable). We now refuse to fall back
 * when the platform is configured: pass session_id, or get a clear error.
 */

import { Sandbox } from "e2b";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.LAP_BASE_URL;
const ENV_SESSION_ID = process.env.SESSION_ID;
const TOKEN = process.env.LAP_AUTH_TOKEN ?? process.env.MASTER_KEY;
const E2B_API_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE || "base";
const VAULT_URL = process.env.VAULT_URL;
const VAULT_PROXY_TOKEN = process.env.VAULT_PROXY_TOKEN;
// E2B auto-shuts a sandbox this long after its shutdown timer was last set.
// In STANDALONE mode we reset it on every direct execute/read (keepalive); in
// PLATFORM mode the platform handles lifecycle. 30 min tolerates long thinking
// gaps between tool calls without leaving zombies.
const SANDBOX_TIMEOUT_MS = 1_800_000;
// Per-command cap. A single step like a UI screenshot (cold chromium launch +
// lazy-compiled route + login + render) can run past 2 min; 120s silently
// terminated those mid-flight. 3 min gives that flow margin without leaving a
// genuinely hung command running much longer.
const EXECUTE_TIMEOUT_MS = 180_000;

// PLATFORM is on whenever the harness has a platform URL + token to talk to;
// STANDALONE is only for harnesses with no platform behind them at all.
const PLATFORM = Boolean(BASE && TOKEN);
const sandboxes = new Map(); // STANDALONE-only: in-process Sandbox handles by name

console.error(`[sandbox-mcp] mode=${PLATFORM ? "platform" : "standalone"} template=${E2B_TEMPLATE} vault=${VAULT_URL ? "set" : "none"}`);

const server = new Server({ name: "opencode-sandbox", version: "1.0.0" }, { capabilities: { tools: {} } });

// `session_id` is required on EVERY tool call in PLATFORM mode (the only way
// a shared inline harness knows which session the call belongs to). The agent
// gets the value from <lap_session_id> injected into its context at bring-up.
// In STANDALONE mode session_id is ignored.
const SESSION_ID_PROP = {
  type: "string",
  description: "LAP session ID from <lap_session_id> in your context. REQUIRED in the inline/shared harness so the platform can inject your agent's env vars (GITHUB_TOKEN stub, vault proxy, etc.) into the sandbox.",
};

const TOOLS = [
  {
    name: "provision",
    description: "Provision a sandbox for THIS session. Routes through the platform so your agent's env-var stubs and vault proxy land in the sandbox — pass `session_id` from <lap_session_id> in your context.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Sandbox label used in subsequent calls (e.g. 'main')." },
        session_id: SESSION_ID_PROP,
      },
      required: ["name", "session_id"],
    },
  },
  {
    name: "execute",
    description: "Execute a shell command inside this session's sandbox. Returns the command output.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Sandbox label from provision (e.g. 'main')." },
        cmd: { type: "string", description: "Shell command to execute" },
        session_id: SESSION_ID_PROP,
      },
      required: ["sandbox_name", "cmd", "session_id"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from this session's sandbox and return its text content. For large files, read a slice instead.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Sandbox label from provision." },
        path: { type: "string", description: "Absolute path of the file inside the sandbox" },
        session_id: SESSION_ID_PROP,
      },
      required: ["sandbox_name", "path", "session_id"],
    },
  },
  {
    name: "upload_artifact",
    description:
      "Upload a file from this session's sandbox to durable storage and get back a presigned download URL (valid 7 days). Use this to host a screenshot/PDF/CSV for embedding in a PR body — do NOT use external file hosts (imgur, 0x0.st, transfer.sh, catbox).",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Sandbox label from provision." },
        path: { type: "string", description: "Absolute path of the file inside the sandbox, e.g. /home/user/keys.png" },
        name: { type: "string", description: "Optional artifact filename (defaults to the basename of path)" },
        session_id: SESSION_ID_PROP,
      },
      required: ["sandbox_name", "path", "session_id"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function buildProxyUrl() {
  if (!VAULT_URL) return null;
  if (!VAULT_PROXY_TOKEN) return VAULT_URL;
  try {
    const u = new URL(VAULT_URL);
    u.username = "x";
    u.password = VAULT_PROXY_TOKEN;
    return u.toString();
  } catch { return VAULT_URL; }
}

function resolveSid(args) {
  return ENV_SESSION_ID || (args && args.session_id) || null;
}

function missingSidError(tool) {
  return textResult(
    `${tool} failed: session_id is required in PLATFORM mode — pass the value from <lap_session_id> in your context. ` +
    `Without it the sandbox cannot be associated with your session, and the platform cannot inject your agent's env-var stubs ` +
    `(GITHUB_TOKEN, etc.) or wire HTTPS_PROXY through the vault. There is no STANDALONE fallback when the platform is configured.`,
    true,
  );
}

async function platformPOST(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = {}; }
  return { ok: res.ok, status: res.status, json };
}

// ── Tool implementations ───────────────────────────────────────────────────

async function provision({ name, project_id, session_id }) {
  if (PLATFORM) {
    const sid = resolveSid({ session_id });
    if (!sid) return missingSidError("provision");
    try {
      const { ok, status, json } = await platformPOST(
        `/api/v1/managed_agents/sessions/${sid}/sandbox/provision`, { name, project_id });
      if (!ok) return textResult(`provision failed: ${json.error ?? `HTTP ${status}`}`, true);
      return textResult(json.message ?? "sandbox provisioned");
    } catch (e) {
      return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  // STANDALONE — no platform; direct E2B with only HTTPS_PROXY from VAULT_URL.
  if (!E2B_API_KEY) return textResult("provision failed: E2B_API_KEY not set", true);
  const existing = sandboxes.get(name);
  if (existing) { try { await existing.kill(); } catch {} }
  try {
    const proxyUrl = buildProxyUrl();
    const sandbox = await Sandbox.create(E2B_TEMPLATE, {
      apiKey: E2B_API_KEY,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      envs: proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } : {},
    });
    sandboxes.set(name, sandbox);
    console.error(`[sandbox-mcp] provisioned standalone: ${sandbox.sandboxId} template=${E2B_TEMPLATE}`);
    return textResult(`sandbox "${name}" ready (${sandbox.sandboxId}, template ${E2B_TEMPLATE})`);
  } catch (e) {
    return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function execute({ sandbox_name, cmd, session_id }) {
  if (PLATFORM) {
    const sid = resolveSid({ session_id });
    if (!sid) return missingSidError("execute");
    try {
      const { ok, status, json } = await platformPOST(
        `/api/v1/managed_agents/sessions/${sid}/sandbox/execute`, { sandbox_name, cmd });
      if (!ok) return textResult(`execute failed: ${json.error ?? `HTTP ${status}`}`, true);
      return textResult(json.output ?? "");
    } catch (e) {
      return textResult(`execute error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  const sandbox = sandboxes.get(sandbox_name);
  if (!sandbox) return textResult(`execute failed: no sandbox "${sandbox_name}" — call provision first`, true);
  try {
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS); // keepalive
    const result = await sandbox.commands.run(cmd, { timeoutMs: EXECUTE_TIMEOUT_MS });
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    const code = result.exitCode ?? 0;
    return code === 0 ? textResult(out) : textResult(`${out}\n[exit ${code}]`, true);
  } catch (e) {
    const err = e && typeof e === "object" ? e : {};
    const out = (err.stdout ?? "") + (err.stderr ?? "");
    const msg = e instanceof Error ? e.message : String(e);
    return textResult(out ? `${out}\n[failed: ${msg}]` : `execute error: ${msg}`, true);
  }
}

const READ_FILE_MAX_BYTES = 256 * 1024;

async function readFile({ sandbox_name, path, session_id }) {
  if (PLATFORM) {
    const sid = resolveSid({ session_id });
    if (!sid) return missingSidError("read_file");
    try {
      const { ok, status, json } = await platformPOST(
        `/api/v1/managed_agents/sessions/${sid}/sandbox/read-file`, { sandbox_name, path });
      if (!ok) return textResult(`read_file failed: ${json.error ?? `HTTP ${status}`}`, true);
      return textResult(json.content ?? "");
    } catch (e) {
      return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  const sandbox = sandboxes.get(sandbox_name);
  if (!sandbox) return textResult(`read_file failed: no sandbox "${sandbox_name}" — call provision first`, true);
  try {
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS); // keepalive
    const content = await sandbox.files.read(path);
    if (content.length > READ_FILE_MAX_BYTES)
      return textResult(`error: file too large to return inline (${content.length} bytes > ${READ_FILE_MAX_BYTES}). Read a smaller slice or split it.`, true);
    return textResult(content);
  } catch (e) {
    return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// MIME inferred from the file extension; falls back to octet-stream. Mirrors the
// allowlist the /artifacts endpoint enforces server-side.
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", json: "application/json", csv: "text/csv",
  md: "text/markdown", txt: "text/plain", py: "text/x-python",
  ts: "text/x-typescript", js: "text/x-javascript", zip: "application/zip",
  tar: "application/x-tar", gz: "application/gzip",
};
function mimeForPath(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// Read a sandbox file's bytes as base64. STANDALONE: read locally via the
// held handle. PLATFORM: base64 inside the sandbox (binary-safe text transport).
async function readBase64({ sandbox_name, path, sid }) {
  if (!PLATFORM) {
    const sandbox = sandboxes.get(sandbox_name);
    if (!sandbox) throw new Error(`no sandbox "${sandbox_name}" — call provision first`);
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    const bytes = await sandbox.files.read(path, { format: "bytes" });
    return Buffer.from(bytes).toString("base64");
  }
  const { ok, status, json } = await platformPOST(
    `/api/v1/managed_agents/sessions/${sid}/sandbox/execute`,
    { sandbox_name, cmd: `base64 -w0 ${JSON.stringify(path)}` });
  if (!ok) throw new Error(json.error ?? `HTTP ${status}`);
  return (json.output ?? "").trim();
}

async function uploadArtifact({ sandbox_name, path, name, session_id }) {
  if (!PLATFORM) return textResult("upload_artifact failed: LAP_BASE_URL not set (artifacts endpoint lives on the platform)", true);
  const sid = resolveSid({ session_id });
  if (!sid) return missingSidError("upload_artifact");
  const fname = name || path.split("/").pop() || "artifact";
  let content;
  try {
    content = await readBase64({ sandbox_name, path, sid });
  } catch (e) {
    return textResult(`upload_artifact error reading ${path}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (!content) return textResult(`upload_artifact failed: ${path} is empty or unreadable`, true);
  const size = Buffer.from(content, "base64").length;
  try {
    const { ok, status, json } = await platformPOST(
      `/api/v1/managed_agents/sessions/${sid}/artifacts`,
      { name: fname, mime_type: mimeForPath(fname), content, size });
    if (!ok) return textResult(`upload_artifact failed: ${json.error ?? `HTTP ${status}`}`, true);
    return textResult(json.url ?? JSON.stringify(json));
  } catch (e) {
    return textResult(`upload_artifact error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

let cleaningUp = false;
async function cleanupAll() {
  if (cleaningUp) return; cleaningUp = true;
  // STANDALONE only — release the in-process handles. In PLATFORM mode the
  // platform owns sandbox lifecycle; we never held local kill rights.
  await Promise.all([...sandboxes.values()].map(s => s.kill().catch(() => {})));
  sandboxes.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => cleanupAll().finally(() => process.exit(0)));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "provision") return provision(args ?? {});
  if (name === "execute") return execute(args ?? {});
  if (name === "read_file") return readFile(args ?? {});
  if (name === "upload_artifact") return uploadArtifact(args ?? {});
  return textResult(`unknown tool: ${name}`, true);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sandbox-mcp] ready`);
