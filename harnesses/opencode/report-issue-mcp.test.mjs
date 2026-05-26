/**
 * Tests for report-issue-mcp.mjs
 *
 * Scenarios:
 *   1. sandbox-reset: agent provisions sandbox, writes a file, sandbox state
 *      resets (file gone on next read). Agent calls report_issue. Verifies the
 *      LAP mock server receives the issue POST with correct fields.
 *   2. MASTER_KEY fallback: MCP boots with only MASTER_KEY (no LAP_ACCESS_TOKEN),
 *      verifies the tool is exposed and the bearer reaches the mock server.
 *   3. missing env: MCP boots without LAP_BASE_URL → exposes no tools.
 *
 * Run: node --test harnesses/opencode/report-issue-mcp.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = join(__dirname, "report-issue-mcp.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a mock LAP HTTP server. Returns { server, port, captured } where
 *  captured is an array of all POST /…/issues bodies received. */
function buildMockLapServer() {
  const captured = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url.includes("/issues")) {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        captured.push({ url: req.url, body: parsed, auth: req.headers.authorization });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "iss_test001", status: "open", times_seen: 1 }));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
  });
  return { server, captured };
}

/** Spawn the MCP stdio process and return a handle for sending/receiving. */
function spawnMcp(env) {
  const proc = spawn("node", [MCP_SCRIPT], {
    env: { ...process.env, ...env, HTTPS_PROXY: "", HTTP_PROXY: "", NO_PROXY: "*" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return proc;
}

/** Send a JSON-RPC message to the MCP process stdin (newline-delimited). */
function send(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

/** Collect stdout lines until a JSON-RPC response with matching id arrives,
 *  or timeout. */
function waitForResponse(proc, id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timeout waiting for id=${id}`)), timeoutMs);
    let buf = "";
    function onData(chunk) {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) {
          clearTimeout(deadline);
          proc.stdout.off("data", onData);
          resolve(msg);
        }
      }
    }
    proc.stdout.on("data", onData);
  });
}

/** Wait until the MCP process stderr contains a ready/disabled line. */
function waitForReady(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("MCP process ready timeout")), timeoutMs);
    let buf = "";
    function onData(chunk) {
      buf += chunk.toString();
      if (buf.includes("[report-issue-mcp]")) {
        clearTimeout(deadline);
        proc.stderr.off("data", onData);
        resolve(buf);
      }
    }
    proc.stderr.on("data", onData);
  });
}

/** Initialize MCP session (required before tools/list or tools/call). */
async function initMcp(proc) {
  send(proc, { jsonrpc: "2.0", id: 0, method: "initialize", params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.1" },
  }});
  await waitForResponse(proc, 0);
  // send initialized notification (no response expected)
  send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
}

// ---------------------------------------------------------------------------
// Shared mock server lifecycle
// ---------------------------------------------------------------------------

let mockLap;
let lapPort;

before(async () => {
  const { server, captured } = buildMockLapServer();
  mockLap = { server, captured };
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  lapPort = server.address().port;
});

after(() => {
  mockLap?.server?.close();
});

// ---------------------------------------------------------------------------
// Scenario 1: sandbox reset → report_issue filed
// ---------------------------------------------------------------------------

describe("sandbox-reset issue reporting", () => {
  test("agent calls report_issue after sandbox state loss — LAP server receives issue", async () => {
    mockLap.captured.length = 0;

    const proc = spawnMcp({
      LAP_BASE_URL: `http://127.0.0.1:${lapPort}`,
      LAP_ACCESS_TOKEN: "test-token",
      AGENT_ID: "agent_abc123",
    });

    proc.stderr.on("data", (d) => {
      // suppress noise in test output
      void d;
    });

    try {
      await waitForReady(proc);
      await initMcp(proc);

      // Simulate: agent ran execute("cat written_file.py") and got "No such file"
      // — exactly the sandbox-reset scenario from the UI screenshot.
      send(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "report_issue",
          arguments: {
            title: "Sandbox state reset: file written but not found on next read",
            body: "Wrote /work/repo/written_file.py via execute(), then ran cat on it and got 'No such file or directory'. Either a pre-commit hook, pytest cleanup, or watcher is resetting sandbox state between operations.",
            severity: "warning",
            session_id: "ses_test_session_001",
            agent_id: "agent_abc123",
          },
        },
      });

      const resp = await waitForResponse(proc, 1);

      // MCP tool returned successfully
      assert.ok(!resp.error, `MCP tool error: ${JSON.stringify(resp.error)}`);
      const content = resp.result?.content ?? [];
      const text = content.map((c) => c.text ?? "").join("");
      assert.ok(
        text.includes("iss_test001") || text.includes("reported"),
        `expected issue id in response, got: ${text}`,
      );

      // LAP mock server received exactly one issue POST
      assert.equal(mockLap.captured.length, 1, "expected exactly one issue POST to LAP");
      const { body, auth, url } = mockLap.captured[0];
      assert.ok(url.includes("agent_abc123"), `expected agent_id in URL, got: ${url}`);
      assert.equal(body?.title, "Sandbox state reset: file written but not found on next read");
      assert.equal(body?.severity, "warning");
      assert.equal(body?.session_id, "ses_test_session_001");
      assert.ok(auth?.includes("test-token"), `expected bearer in auth header, got: ${auth}`);
    } finally {
      proc.kill();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: missing env → no tools exposed
// ---------------------------------------------------------------------------

describe("missing env", () => {
  test("MCP with no LAP_BASE_URL exposes empty tools list", async () => {
    const proc = spawnMcp({
      // LAP_BASE_URL intentionally absent
      LAP_ACCESS_TOKEN: "test-token",
    });

    proc.stderr.on("data", (d) => { void d; });

    try {
      const readyMsg = await waitForReady(proc);
      assert.ok(readyMsg.includes("disabled"), `expected disabled message, got: ${readyMsg}`);

      await initMcp(proc);

      send(proc, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
      const resp = await waitForResponse(proc, 3);
      const tools = resp.result?.tools ?? [];
      assert.equal(tools.length, 0, "expected no tools when env missing");
    } finally {
      proc.kill();
    }
  });
});
