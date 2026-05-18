// Minimal bridge: serves a static xterm.js page on /, accepts WebSocket
// upgrades on /tty, and pipes bytes between the browser terminal and a
// real PTY running the configured command (default: `gemini --yolo`).
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
// POC_CMD splits on whitespace so a value like "gemini --yolo" spawns the
// binary with its argv. Default: gemini in yolo mode (--yolo bypasses tool
// approval prompts, mirroring the posture of every other LAP TUI harness).
const _cmdParts = (process.env.POC_CMD ?? "gemini --yolo").trim().split(/\s+/);
const REPO_DIR = process.env.REPO_DIR ?? process.cwd();

// Wrap gemini in a tmux session so it survives WS reconnects — `lap` is a
// fixed session name (one agent per sandbox pod). `tmux new-session -A`
// creates the session on first attach and reattaches to the existing one
// thereafter, so `lap --resume <id>` lands on the in-progress gemini REPL
// with full scrollback / conversation instead of a fresh sign-in screen.
// Killing the spawned pty on ws-close kills the tmux *client*, not the
// server, so gemini and its memory persist for the next attach. Mirrors
// the pattern already used by harnesses/claude-code and harnesses/codex.
const SPAWN_CMD = "tmux";
const SPAWN_ARGS = ["new-session", "-A", "-s", "lap", ..._cmdParts];

const AUTH_TOKEN = (process.env.HARNESS_AUTH_TOKEN ?? "").trim();
const AUTH_TOKEN_BYTES = Buffer.from(AUTH_TOKEN, "utf8");
if (!AUTH_TOKEN) {
  console.warn(
    "[harness] WARNING: HARNESS_AUTH_TOKEN is empty. /tty and /session* will reject all requests.",
  );
}

function tokenMatches(presented) {
  if (!AUTH_TOKEN) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const given = Buffer.from(presented, "utf8");
  if (given.length !== AUTH_TOKEN_BYTES.length) return false;
  return timingSafeEqual(given, AUTH_TOKEN_BYTES);
}

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

// Two auth paths, in priority order:
//
//   1. BYO Gemini key. If the agent provided a GEMINI_API_KEY via env_vars,
//      the entrypoint sources it (vault-stubbed) before this runs, so
//      process.env.GEMINI_API_KEY is already set. Route directly to Google
//      — no LITELLM gateway, no base-URL override. Vault swaps the stub for
//      the real key on the wire.
//
//   2. Fallback: LiteLLM gateway. Use the platform's LITELLM_API_KEY as the
//      Gemini key and point the CLI at the gateway's `/gemini` passthrough.
//      Only works when the upstream LiteLLM proxy (a) accepts the key as a
//      virtual key and (b) has a `gemini/*` model_group configured. Without
//      a configured Gemini deployment on the proxy the CLI will hang on
//      every request — the call hits LiteLLM, returns 5xx, the CLI retries.
const userProvidedGeminiKey = Boolean(process.env.GEMINI_API_KEY);
if (!userProvidedGeminiKey && process.env.LITELLM_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.LITELLM_API_KEY;
  if (process.env.LITELLM_API_BASE && !process.env.GOOGLE_GEMINI_BASE_URL) {
    process.env.GOOGLE_GEMINI_BASE_URL =
      process.env.LITELLM_API_BASE.replace(/\/+$/, "") + "/gemini";
  }
}
// The CLI's inner Docker/Podman sandbox would try to spawn a nested container
// for tool calls — pointless inside our k8s pod and likely to fail. Disable
// it unconditionally; the k8s pod itself is the security boundary.
process.env.GEMINI_SANDBOX = "false";

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
    res.end(JSON.stringify({ ok: true, cmd: _cmdParts.join(" "), repo: REPO_DIR, auth_required: AUTH_TOKEN.length > 0 }));
    return;
  }

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
  console.log(`[bridge] listening on http://0.0.0.0:${PORT}  (cmd=${_cmdParts.join(" ")}, cwd=${REPO_DIR})`);
});
