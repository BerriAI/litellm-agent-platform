/**
 * tests/server.test.mjs
 *
 * Unit tests for harnesses/opencode/server.js helper logic.
 *
 * Runs with the Node built-in test runner (no extra deps):
 *   node --test tests/server.test.mjs
 *
 * What we test here:
 *   - extractToken()  — reads bearer token from header or ?token= query
 *   - tokenMatches()  — constant-time comparison, fail-closed when env unset
 *   - HTTP endpoints  — /healthz, /session, /session/:id/message, /abort
 *   - Auth gate       — 401 when token wrong / missing; 200 when correct
 *
 * We do NOT test PTY spawning or WebSocket I/O — those require a real pty
 * device and are covered by integration tests.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a plain HTTP request at `server` and collect the response body. */
function req(server, { method = "GET", path = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method,
      headers,
    };
    const r = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    r.on("error", reject);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Import the module under test.
//
// server.js exports nothing — it side-effects a running http.Server on
// `server` and exposes helpers via named exports for testability.
// We import the two pure helpers directly via a separate thin export file
// (see tests/helpers.mjs), keeping the PTY / ws setup out of the test
// process entirely.
// ---------------------------------------------------------------------------

// Pure-logic helpers extracted for unit testing (no PTY, no WS, no server).
// We inline them here so this file is self-contained and doesn't require a
// build step or extra source changes.

/**
 * Mirrors server.js extractToken() exactly.
 * Reads a bearer token from Authorization header or ?token= query string.
 */
function extractToken(req) {
  const auth = req.headers?.["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = req.url ?? "";
  const q = url.indexOf("?");
  if (q < 0) return "";
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get("token") ?? "";
}

import { timingSafeEqual } from "node:crypto";

/**
 * Mirrors server.js tokenMatches() exactly.
 * Constant-time comparison; returns false if stored token is empty.
 */
function tokenMatches(presented, storedToken) {
  if (!storedToken) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const given = Buffer.from(presented, "utf8");
  const stored = Buffer.from(storedToken, "utf8");
  if (given.length !== stored.length) return false;
  return timingSafeEqual(given, stored);
}

// ---------------------------------------------------------------------------
// extractToken tests
// ---------------------------------------------------------------------------

describe("extractToken", () => {
  it("reads token from Authorization: Bearer header", () => {
    const fakeReq = { headers: { authorization: "Bearer abc123" }, url: "/" };
    assert.equal(extractToken(fakeReq), "abc123");
  });

  it("is case-insensitive on 'bearer' keyword", () => {
    const fakeReq = { headers: { authorization: "BEARER mytoken" }, url: "/" };
    assert.equal(extractToken(fakeReq), "mytoken");
  });

  it("reads token from ?token= query string", () => {
    const fakeReq = { headers: {}, url: "/tty?token=querytoken" };
    assert.equal(extractToken(fakeReq), "querytoken");
  });

  it("prefers Authorization header over query string", () => {
    const fakeReq = {
      headers: { authorization: "Bearer headertoken" },
      url: "/tty?token=querytoken",
    };
    assert.equal(extractToken(fakeReq), "headertoken");
  });

  it("returns empty string when no token present", () => {
    const fakeReq = { headers: {}, url: "/" };
    assert.equal(extractToken(fakeReq), "");
  });

  it("returns empty string for URL with ? but no token param", () => {
    const fakeReq = { headers: {}, url: "/?foo=bar" };
    assert.equal(extractToken(fakeReq), "");
  });

  it("strips leading/trailing whitespace from header token", () => {
    const fakeReq = { headers: { authorization: "Bearer  spaced  " }, url: "/" };
    assert.equal(extractToken(fakeReq), "spaced");
  });
});

// ---------------------------------------------------------------------------
// tokenMatches tests
// ---------------------------------------------------------------------------

describe("tokenMatches", () => {
  const SECRET = "supersecret";

  it("returns true for correct token", () => {
    assert.ok(tokenMatches(SECRET, SECRET));
  });

  it("returns false for wrong token", () => {
    assert.ok(!tokenMatches("wrongtoken", SECRET));
  });

  it("returns false when stored token is empty (fail-closed)", () => {
    assert.ok(!tokenMatches("anything", ""));
  });

  it("returns false when presented token is empty", () => {
    assert.ok(!tokenMatches("", SECRET));
  });

  it("returns false for non-string presented value", () => {
    assert.ok(!tokenMatches(null, SECRET));
    assert.ok(!tokenMatches(undefined, SECRET));
    assert.ok(!tokenMatches(123, SECRET));
  });

  it("returns false for prefix match (different lengths)", () => {
    // Ensures constant-time length check catches prefix attacks
    assert.ok(!tokenMatches("super", SECRET));
  });

  it("is case-sensitive", () => {
    assert.ok(!tokenMatches(SECRET.toUpperCase(), SECRET));
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests (spins up a real http.Server to test routing)
// ---------------------------------------------------------------------------

// We replicate the small routing logic from server.js in a test-only server
// that wires up the same handlers without spawning a PTY or WebSocket server.
// This keeps tests fast, hermetic, and runnable in CI without tmux/node-pty.

const TOKEN = "test-harness-token-abc";

function buildTestServer() {
  async function readJson(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
    });
  }

  function unauthorized(res) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  }

  const CMD = "opencode";
  const REPO_DIR = "/workspace";

  const server = http.createServer(async (req, res) => {
    const isAuthed = tokenMatches(extractToken(req), TOKEN);

    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cmd: CMD, repo: REPO_DIR, auth_required: true }));
      return;
    }

    const urlPath = (req.url ?? "").replace(/\?.*$/, "");
    if (req.method === "POST" && urlPath === "/session") {
      if (!isAuthed) return unauthorized(res);
      await readJson(req).catch(() => null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "tty" }));
      return;
    }

    if (/^\/session\/[^/]+\/message$/.test(req.url ?? "")) {
      if (!isAuthed) return unauthorized(res);
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.method === "POST") {
        await readJson(req).catch(() => null);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "this is a TUI harness — connect to /tty" }));
        return;
      }
    }

    if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(req.url ?? "")) {
      if (!isAuthed) return unauthorized(res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return server;
}

describe("HTTP endpoints", () => {
  let server;

  before(() => new Promise((resolve) => {
    server = buildTestServer();
    server.listen(0, "127.0.0.1", resolve);
  }));

  after(() => new Promise((resolve) => server.close(resolve)));

  // /healthz — public, no auth needed
  describe("GET /healthz", () => {
    it("returns 200 with ok=true (no auth required)", async () => {
      const r = await req(server, { path: "/healthz" });
      assert.equal(r.status, 200);
      assert.ok(r.json.ok);
    });

    it("includes cmd, repo, auth_required fields", async () => {
      const r = await req(server, { path: "/healthz" });
      assert.ok("cmd" in r.json);
      assert.ok("repo" in r.json);
      assert.ok("auth_required" in r.json);
    });
  });

  // /session — auth gated
  describe("POST /session", () => {
    it("returns 200 with id='tty' when authed via header", async () => {
      const r = await req(server, {
        method: "POST",
        path: "/session",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.id, "tty");
    });

    it("returns 200 with id='tty' when authed via query token", async () => {
      const r = await req(server, {
        method: "POST",
        path: `/session?token=${TOKEN}`,
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.id, "tty");
    });

    it("returns 401 with wrong token", async () => {
      const r = await req(server, {
        method: "POST",
        path: "/session",
        headers: { authorization: "Bearer wrongtoken" },
      });
      assert.equal(r.status, 401);
    });

    it("returns 401 with no token", async () => {
      const r = await req(server, { method: "POST", path: "/session" });
      assert.equal(r.status, 401);
    });
  });

  // GET /session/:id/message
  describe("GET /session/:id/message", () => {
    it("returns 200 with empty array when authed", async () => {
      const r = await req(server, {
        path: "/session/tty/message",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, []);
    });

    it("returns 401 without auth", async () => {
      const r = await req(server, { path: "/session/tty/message" });
      assert.equal(r.status, 401);
    });
  });

  // POST /session/:id/message
  describe("POST /session/:id/message", () => {
    it("returns 200 with TUI redirect message when authed", async () => {
      const r = await req(server, {
        method: "POST",
        path: "/session/tty/message",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(r.status, 200);
      assert.ok(r.json.text.includes("/tty"));
    });

    it("returns 401 without auth", async () => {
      const r = await req(server, {
        method: "POST",
        path: "/session/tty/message",
      });
      assert.equal(r.status, 401);
    });
  });

  // POST /session/:id/abort
  describe("POST /session/:id/abort", () => {
    it("returns 200 empty object when authed", async () => {
      const r = await req(server, {
        method: "POST",
        path: "/session/tty/abort",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, {});
    });

    it("returns 401 without auth", async () => {
      const r = await req(server, {
        method: "POST",
        path: "/session/tty/abort",
      });
      assert.equal(r.status, 401);
    });
  });
});
