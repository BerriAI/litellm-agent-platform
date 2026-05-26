#!/usr/bin/env node
/**
 * Two modes:
 * 1. Platform delegation: SESSION_ID + LAP_BASE_URL set → calls platform API
 * 2. Direct E2B fallback: SESSION_ID missing (inline) → E2B direct + vault proxy
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
const SANDBOX_CHOICE = process.env.SANDBOX_CHOICE;
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
const DAYTONA_API_URL = process.env.DAYTONA_API_URL;
const DAYTONA_SNAPSHOT = process.env.DAYTONA_SNAPSHOT;
const DAYTONA_IMAGE = process.env.DAYTONA_IMAGE;
const DAYTONA_MEMORY_GIB = process.env.DAYTONA_MEMORY_GIB ? Number(process.env.DAYTONA_MEMORY_GIB) : undefined;
const DAYTONA_CPU = process.env.DAYTONA_CPU ? Number(process.env.DAYTONA_CPU) : undefined;
const USE_DAYTONA = SANDBOX_CHOICE === "daytona" && !!DAYTONA_API_KEY;
// E2B auto-shuts a sandbox this long after its shutdown timer was last set. We
// reset that timer on every execute/read (keepalive, see below), so in practice
// this is "max idle before reaping", not a hard cap on total task time. 30 min
// tolerates long thinking gaps between tool calls without leaving zombies.
const SANDBOX_TIMEOUT_MS = 1_800_000;
// Per-command cap. A single step like a UI screenshot (cold chromium launch +
// lazy-compiled route + login + render) can run past 2 min; 120s silently
// terminated those mid-flight. 3 min gives that flow margin without leaving a
// genuinely hung command running much longer.
const EXECUTE_TIMEOUT_MS = 180_000;

const USE_DIRECT = !ENV_SESSION_ID;
const sandboxes = new Map();

const directMode = USE_DIRECT ? (USE_DAYTONA ? "direct-daytona" : "direct-e2b") : "platform";
console.error(`[sandbox-mcp] mode=${directMode} template=${E2B_TEMPLATE} vault=${VAULT_URL ? "set" : "none"}`);

const server = new Server({ name: "opencode-sandbox", version: "1.0.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: "provision",
    description: "Provision a new sandbox environment. Returns a confirmation message when the sandbox is ready.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label for the sandbox — used in subsequent execute() calls as sandbox_name. Use 'main' if unsure." },
      },
      required: ["name"],
    },
  },
  {
    name: "execute",
    description: "Execute a shell command inside a provisioned sandbox. Returns the command output.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Label of the provisioned sandbox" },
        cmd: { type: "string", description: "Shell command to execute" },
      },
      required: ["sandbox_name", "cmd"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file from a provisioned sandbox and return its text content, so you can pull files out of the sandbox into your own workspace (no cat/base64 needed). For large files, read a slice instead.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: {
          type: "string",
          description: "Label of the provisioned sandbox to read the file from",
        },
        path: { type: "string", description: "Absolute path of the file inside the sandbox" },
        session_id: {
          type: "string",
          description: "LAP session ID — required when SESSION_ID env var is not set",
        },
      },
      required: ["sandbox_name", "path"],
    },
  },
  {
    name: "upload_artifact",
    description:
      "Upload a file from a provisioned sandbox to durable storage and get back a presigned download URL (valid 7 days). Use this to host a screenshot/PDF/CSV for embedding in a PR body or sharing with a human — do NOT use external file hosts (imgur, 0x0.st, transfer.sh, catbox). Returns the URL as text.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string", description: "Label of the provisioned sandbox the file lives in" },
        path: { type: "string", description: "Absolute path of the file inside the sandbox, e.g. /home/user/keys.png" },
        name: { type: "string", description: "Optional artifact filename (defaults to the basename of path)" },
        session_id: { type: "string", description: "LAP session ID — required only when the SESSION_ID env var is not set" },
      },
      required: ["sandbox_name", "path"],
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

async function getDaytona() {
  const { Daytona } = await import("@daytona/sdk");
  return new Daytona({ apiKey: DAYTONA_API_KEY, ...(DAYTONA_API_URL ? { apiUrl: DAYTONA_API_URL } : {}) });
}

async function provision({ name, project_id }) {
  if (USE_DIRECT) {
    if (USE_DAYTONA) {
      const existing = sandboxes.get(name);
      if (existing) {
        try { const d = await getDaytona(); await d.delete(existing); } catch {}
        sandboxes.delete(name);
      }
      try {
        const proxyUrl = buildProxyUrl();
        const envVars = proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } : {};
        // Resources only supported on image-based sandboxes — Daytona rejects on snapshots.
        const resources = DAYTONA_IMAGE && (DAYTONA_MEMORY_GIB || DAYTONA_CPU)
          ? { ...(DAYTONA_MEMORY_GIB ? { memory: DAYTONA_MEMORY_GIB } : {}), ...(DAYTONA_CPU ? { cpu: DAYTONA_CPU } : {}) }
          : undefined;
        const daytona = await getDaytona();
        const sandbox = DAYTONA_IMAGE
          ? await daytona.create({ image: DAYTONA_IMAGE, envVars, autoStopInterval: 0, ...(resources ? { resources } : {}) }, { timeout: 120 })
          : await daytona.create({ snapshot: DAYTONA_SNAPSHOT, envVars, autoStopInterval: 0 }, { timeout: 120 });
        sandboxes.set(name, sandbox);
        console.error(`[sandbox-mcp] provisioned daytona: ${sandbox.id}`);
        return textResult(`sandbox "${name}" ready (id: \`${sandbox.id}\`, provider: daytona)`);
      } catch (e) {
        return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
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
      console.error(`[sandbox-mcp] provisioned direct: ${sandbox.sandboxId} template=${E2B_TEMPLATE}`);
      return textResult(`sandbox "${name}" ready (${sandbox.sandboxId}, template ${E2B_TEMPLATE})`);
    } catch (e) {
      return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, project_id }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`provision failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.message ?? "sandbox provisioned");
  } catch (e) {
    return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function execute({ sandbox_name, cmd }) {
  if (USE_DIRECT) {
    const sandbox = sandboxes.get(sandbox_name);
    if (!sandbox) return textResult(`execute failed: no sandbox "${sandbox_name}" — call provision first`, true);
    if (USE_DAYTONA) {
      try {
        const result = await sandbox.process.executeCommand(cmd, undefined, undefined, Math.ceil(EXECUTE_TIMEOUT_MS / 1000));
        const out = result.result ?? "";
        return result.exitCode !== 0 ? textResult(`${out}\n[exit code ${result.exitCode}]`, true) : textResult(out);
      } catch (e) {
        return textResult(`execute error: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
    try {
      await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
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
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sandbox_name, cmd }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`execute failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.output ?? "");
  } catch (e) {
    return textResult(`execute error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

const READ_FILE_MAX_BYTES = 256 * 1024;

async function readFile({ sandbox_name, path }) {
  if (USE_DIRECT) {
    const sandbox = sandboxes.get(sandbox_name);
    if (!sandbox) return textResult(`read_file failed: no sandbox "${sandbox_name}" — call provision first`, true);
    if (USE_DAYTONA) {
      try {
        const buf = await sandbox.fs.downloadFile(path);
        const content = buf.toString("utf-8");
        if (content.length > READ_FILE_MAX_BYTES)
          return textResult(`error: file too large to return inline (${content.length} bytes > ${READ_FILE_MAX_BYTES}). Read a smaller slice or split it.`, true);
        return textResult(content);
      } catch (e) {
        return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
    try {
      await sandbox.setTimeout(SANDBOX_TIMEOUT_MS); // keepalive (see execute)
      const content = await sandbox.files.read(path);
      if (content.length > READ_FILE_MAX_BYTES)
        return textResult(`error: file too large to return inline (${content.length} bytes > ${READ_FILE_MAX_BYTES}). Read a smaller slice or split it.`, true);
      return textResult(content);
    } catch (e) {
      return textResult(`read_file error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${ENV_SESSION_ID}/sandbox/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sandbox_name, path }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`read_file failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.content ?? "");
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

// Read a sandbox file's bytes as base64 — works in both modes: direct-e2b reads
// the bytes locally via the held sandbox handle; platform mode shells out to
// `base64` inside the sandbox (binary-safe, since we transport the text).
async function readBase64({ sandbox_name, path, session_id }) {
  const sandbox = sandboxes.get(sandbox_name);
  if (sandbox) {
    if (USE_DAYTONA) {
      const buf = await sandbox.fs.downloadFile(path);
      return buf.toString("base64");
    }
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS); // keepalive (see execute)
    const bytes = await sandbox.files.read(path, { format: "bytes" });
    return Buffer.from(bytes).toString("base64");
  }
  const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${session_id}/sandbox/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sandbox_name, cmd: `base64 -w0 ${JSON.stringify(path)}` }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return (json.output ?? "").trim();
}

async function uploadArtifact({ sandbox_name, path, name, session_id }) {
  const sid = ENV_SESSION_ID ?? session_id;
  if (!sid) return textResult("upload_artifact failed: no session_id (SESSION_ID env not set and none passed)", true);
  if (!BASE) return textResult("upload_artifact failed: LAP_BASE_URL not set", true);
  const fname = name || path.split("/").pop() || "artifact";
  let content;
  try {
    content = await readBase64({ sandbox_name, path, session_id: sid });
  } catch (e) {
    return textResult(`upload_artifact error reading ${path}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (!content) return textResult(`upload_artifact failed: ${path} is empty or unreadable`, true);
  const size = Buffer.from(content, "base64").length;
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: fname, mime_type: mimeForPath(fname), content, size }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`upload_artifact failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.url ?? JSON.stringify(json));
  } catch (e) {
    return textResult(`upload_artifact error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

let cleaningUp = false;
async function cleanupAll() {
  if (cleaningUp) return; cleaningUp = true;
  if (USE_DAYTONA) {
    try {
      const d = await getDaytona();
      await Promise.all([...sandboxes.values()].map(s => d.delete(s).catch(() => {})));
    } catch {}
  } else {
    await Promise.all([...sandboxes.values()].map(s => s.kill().catch(() => {})));
  }
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
