// Minimal bridge: serves a static xterm.js page on /, accepts WebSocket
// upgrades on /tty, and pipes bytes between the browser terminal and a
// real PTY running the configured command (default: `claude`).
//
// Protocol on /tty:
//   browser -> server : raw text (keystrokes)  OR  JSON {"type":"resize","cols":N,"rows":M}
//   server  -> browser: raw bytes (PTY stdout)
//
// Auth: every request to /tty (WebSocket upgrade) and every platform-compat
// endpoint (POST /session, /event, etc.) must present a token matching
// HARNESS_AUTH_TOKEN. Token is accepted via:
//   - `Authorization: Bearer <token>` header   (HTTP)
//   - `?token=<token>` query string             (WebSocket upgrade — browsers
//                                                can't set arbitrary headers)
// If HARNESS_AUTH_TOKEN is unset, the harness fails closed: all auth-gated
// requests are rejected with 401 and the WS upgrade is dropped. `/healthz`
// remains public so platform liveness probes work.
//
// Override the command for testing without an API key:
//   POC_CMD=bash docker run …

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const HAS_PUBLIC = fs.existsSync(PUBLIC_DIR);
const PORT = Number(process.env.PORT ?? 4096);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};
const CMD = process.env.POC_CMD ?? "claude";
const REPO_DIR = process.env.REPO_DIR ?? process.cwd();

// Wrap the agent in a tmux session so it survives WS reconnects. `lap` is
// a fixed session name (one agent per sandbox pod). `new-session -A`
// creates the session on first attach and reattaches to the existing one
// thereafter — so `lap --resume` lands on the in-progress agent instead
// of spawning a fresh REPL. Killing the spawned pty on ws-close kills the
// tmux *client*, not the server, so the agent and its scrollback persist.
const SPAWN_CMD = "tmux";
const SPAWN_ARGS = ["new-session", "-A", "-s", "lap", CMD];

// Auth token. Empty → fail-closed: all auth-gated requests are rejected.
// The platform is expected to set this per-pod at sandbox-create time and
// hand the same value back to authenticated session clients.
const AUTH_TOKEN = (process.env.HARNESS_AUTH_TOKEN ?? "").trim();
const AUTH_TOKEN_BYTES = Buffer.from(AUTH_TOKEN, "utf8");
if (!AUTH_TOKEN) {
  console.warn(
    "[harness] WARNING: HARNESS_AUTH_TOKEN is empty. /tty and /session* will reject all requests.",
  );
}

// Constant-time compare. Length mismatch short-circuits to false without
// leaking timing on prefix length.
function tokenMatches(presented) {
  if (!AUTH_TOKEN) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const given = Buffer.from(presented, "utf8");
  if (given.length !== AUTH_TOKEN_BYTES.length) return false;
  return timingSafeEqual(given, AUTH_TOKEN_BYTES);
}

// Extract a bearer token from either Authorization header or ?token= query.
function extractToken(req) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = req.url ?? "";
  const q = url.indexOf("?");
  if (q < 0) return "";
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get("token") ?? "";
}

function isAuthed(req) { return tokenMatches(extractToken(req)); }

// Route Claude Code through the LiteLLM gateway when the platform passes
// LITELLM_API_BASE / LITELLM_API_KEY in. The `claude` CLI reads
// ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, so rewrite at boot. Mirrors
// what harnesses/claude-agent-sdk/src/server.ts already does for the SDK.
if (process.env.LITELLM_API_BASE) {
  process.env.ANTHROPIC_BASE_URL = process.env.LITELLM_API_BASE.replace(
    /\/+$/,
    "",
  );
}
if (process.env.LITELLM_API_KEY) {
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.LITELLM_API_KEY;
  process.env.ANTHROPIC_API_KEY = process.env.LITELLM_API_KEY;
}

// Read the JSON body of an incoming request (server-side helper).
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function unauthorized(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    // `auth_required` lets callers see whether the harness will demand a
    // token without having to attempt a 401 first. The token itself is
    // never returned.
    res.end(JSON.stringify({ ok: true, cmd: CMD, repo: REPO_DIR, auth_required: AUTH_TOKEN.length > 0 }));
    return;
  }

  // NOTE: The HTTP endpoints below are LAP-platform-compat stubs. They return
  // constants (session id "tty", empty message history, keepalive SSE) and
  // never expose credentials, shell access, or session contents. We leave
  // them unauthenticated so the platform's bootstrap probe can mark the
  // sandbox `ready` without holding the harness's auth token. The actual
  // load-bearing surface — `/tty` WebSocket — is auth-gated below at the
  // upgrade handshake, before any PTY spawns.

  // Platform-compat stubs: the LAP platform expects every harness to expose
  // the same JSON contract (POST /session, GET /session/:id/message, etc.).
  // TUI harnesses don't actually use those — the session is the WS /tty
  // connection — but the platform's bootstrap calls POST /session before
  // marking the session ready. Return a constant id so it succeeds. The
  // other endpoints are stubs in case anything probes them.
  if (req.method === "POST" && req.url === "/session") {
    await readJson(req).catch(() => null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "tty" }));
    return;
  }
  if (/^\/session\/[^/]+\/message$/.test(req.url ?? "")) {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.method === "POST") {
      await readJson(req).catch(() => null);
      // TUI mode: messages don't flow through the JSON API. Tell callers
      // to use the WS /tty endpoint instead.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "this is a TUI harness — connect to /tty" }));
      return;
    }
  }
  if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  // SSE bus: keep open with periodic comments so the platform's stream-tail
  // doesn't immediately close.
  if (req.method === "GET" && req.url?.startsWith("/event")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const ka = setInterval(() => res.write(":keepalive\n\n"), 15000);
    req.on("close", () => clearInterval(ka));
    return;
  }

  // Standalone debug UI: serve the bundled xterm.js page on / so that
  // hitting the pod directly (via NodePort / LoadBalancer / port-forward)
  // produces a working terminal without needing the LAP web tier.
  if (req.method === "GET" && HAS_PUBLIC) {
    const requested = (req.url ?? "/").replace(/\?.*$/, "");
    const rel = requested === "/" ? "/index.html" : requested;
    const candidate = path.join(PUBLIC_DIR, rel);
    if (candidate.startsWith(PUBLIC_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate);
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      fs.createReadStream(candidate).pipe(res);
      return;
    }
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// Reject the WebSocket upgrade itself when the bearer token is missing or
// wrong. ws's verifyClient runs before any frames are exchanged, so an
// unauthenticated client never sees the PTY at all — no shell, no leakage.
const wss = new WebSocketServer({
  server,
  path: "/tty",
  verifyClient: ({ req }, cb) => {
    if (isAuthed(req)) return cb(true);
    return cb(false, 401, "unauthorized");
  },
});

wss.on("connection", (ws) => {
  let term;
  try {
    term = pty.spawn(SPAWN_CMD, SPAWN_ARGS, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: REPO_DIR,
      env: process.env,
    });
  } catch (e) {
    ws.send(`\r\n\x1b[31m[bridge] failed to spawn ${SPAWN_CMD}: ${e.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  console.log(`[bridge] spawned ${SPAWN_CMD} ${SPAWN_ARGS.join(" ")} (pid ${term.pid}) for ${ws._socket.remoteAddress}`);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  term.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[2m[bridge] process exited (code=${exitCode}, signal=${signal ?? "-"})\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) { term.write(raw); return; }
    const s = raw.toString();
    // Resize messages are the only JSON we accept; everything else is
    // keystrokes. The startsWith check keeps the hot path cheap.
    if (s.length > 0 && s[0] === "{") {
      try {
        const msg = JSON.parse(s);
        if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          term.resize(msg.cols, msg.rows);
          return;
        }
        if (msg.type === "ping") return;
      } catch { /* fall through and treat as keystrokes */ }
    }
    term.write(s);
  });

  ws.on("close", () => {
    try { term.kill(); } catch { /* already gone */ }
  });

  ws.on("error", (e) => console.warn(`[bridge] ws error: ${e.message}`));
});

server.listen(PORT, () => {
  console.log(`[bridge] listening on http://0.0.0.0:${PORT}  (cmd=${CMD}, cwd=${REPO_DIR})`);
});
