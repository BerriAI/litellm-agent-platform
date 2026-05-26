#!/usr/bin/env node
/**
 * Sandbox MCP — provision/execute/read_file/upload_artifact tools.
 *
 * One mode: platform delegation. Every call routes through the LAP platform
 * endpoint (`/api/v1/managed_agents/sessions/<sid>/sandbox/...`), which picks a
 * provider from the SandboxProvider registry (Daytona, E2B, …) based on
 * SANDBOX_CHOICE on the platform. The agent supplies `session_id` from the
 * <lap_session_id> tag in its context, OR the harness env injects SESSION_ID.
 *
 * The previous direct-E2B fallback was removed when the platform-side Daytona
 * provider became authoritative — duplicating SDK calls inside the MCP added
 * drift risk and a second place to keep up with provider changes.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.LAP_BASE_URL;
const ENV_SESSION_ID = process.env.SESSION_ID;
const TOKEN = process.env.LAP_AUTH_TOKEN ?? process.env.MASTER_KEY;

// Sandboxes provisioned via the platform path (session_id passed at provision time).
// Keyed by sandbox name → platform session_id so execute/read_file can route correctly.
const sandboxSessionIds = new Map();

// Centralised "no session" error so all four tools give the agent the same hint.
function missingSessionError(tool) {
  return textResult(
    `${tool} failed: no session_id available. Pass session_id from the ` +
      `<lap_session_id> tag in your context (and ensure LAP_BASE_URL is set).`,
    true,
  );
}

console.error(`[sandbox-mcp] mode=platform base=${BASE || "<unset>"} session_env=${ENV_SESSION_ID ? "set" : "unset"}`);

const server = new Server({ name: "opencode-sandbox", version: "1.0.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: "provision",
    description: "Provision a new sandbox environment. Returns a confirmation message when the sandbox is ready. IMPORTANT: always pass session_id so the platform injects your agent's env vars (e.g. GITHUB_TOKEN) into the sandbox. Find the session_id as the UUID text content of the <lap_session_id> tag in your conversation context (e.g. if context contains '<lap_session_id>abc-123</lap_session_id>' then session_id is 'abc-123').",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label for the sandbox — used in subsequent execute() calls as sandbox_name. Use 'main' if unsure." },
        session_id: { type: "string", description: "The UUID from the <lap_session_id> tag in your context. Do NOT use a variable like ${LAP_SESSION_ID} — copy the actual UUID string value." },
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

async function provision({ name, project_id, session_id: callSessionId }) {
  const effectiveSid = ENV_SESSION_ID || callSessionId;
  if (!effectiveSid || !BASE) return missingSessionError("provision");
  // Platform-mode only: the platform's sandbox endpoint routes to the configured
  // provider (Daytona/E2B per SANDBOX_CHOICE) and injects agent env var stubs so
  // the vault proxy can swap them for real values on HTTPS egress.
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${effectiveSid}/sandbox/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, project_id }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`provision failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    if (callSessionId) sandboxSessionIds.set(name, callSessionId);
    return textResult(json.message ?? "sandbox provisioned");
  } catch (e) {
    return textResult(`provision error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function execute({ sandbox_name, cmd }) {
  const platformSid = ENV_SESSION_ID || sandboxSessionIds.get(sandbox_name);
  if (!platformSid || !BASE) return missingSessionError("execute");
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${platformSid}/sandbox/execute`, {
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

async function readFile({ sandbox_name, path }) {
  const platformSid = ENV_SESSION_ID || sandboxSessionIds.get(sandbox_name);
  if (!platformSid || !BASE) return missingSessionError("read_file");
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${platformSid}/sandbox/read-file`, {
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

// Read a sandbox file's bytes as base64 by shelling out to `base64` inside the
// sandbox (binary-safe — we only transport the text). Goes through the platform's
// /execute endpoint so the active provider (Daytona/E2B/…) handles it.
async function readBase64({ sandbox_name, path, session_id }) {
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

// No local sandbox handles to tear down anymore — the platform owns lifecycle.
// Graceful exit on signal so the MCP doesn't hold the harness up.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

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
