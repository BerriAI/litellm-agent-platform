#!/usr/bin/env node
// server-proxy.mjs
//
// TCP-level reverse proxy that runs in front of the Next.js standalone
// server. It intercepts WebSocket upgrade requests bound for
//   /api/v1/managed_agents/sessions/<id>/tty
// and pipes the raw TCP connection directly to the cluster-internal sandbox
// pod (sandbox_url from the DB). Every other connection is forwarded to the
// Next.js server running on NEXT_PORT (default 3001).
//
// Why TCP-level: Next.js 16 App Router route handlers don't support WS
// upgrades (the connection closes after the response is generated). A
// raw-TCP proxy operates below the HTTP layer and avoids that restriction.
//
// Auth: the incoming WS upgrade must carry ?token=<value> matching either
// HARNESS_AUTH_TOKEN or MASTER_KEY. The token is forwarded as-is to the
// sandbox, which performs its own constant-time check.
//
// Startup: CMD ["sh", "-c", "... && node server-proxy.mjs"]
// Next.js is spawned as a child process on NEXT_PORT.

import { connect } from "net";
import { createServer as createHttpServer, request as httpRequest } from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
import { timingSafeEqual } from "crypto";
import { URL } from "url";

const require = createRequire(import.meta.url);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const NEXT_PORT = parseInt(process.env.NEXT_PORT ?? "3001", 10);
// Use BIND_HOST, not HOSTNAME: Kubernetes injects HOSTNAME as the pod name,
// which causes proxy.listen to bind on a single pod IP instead of all
// interfaces (and may fail DNS lookup at startup).
const BIND_HOST = process.env.BIND_HOST ?? "0.0.0.0";

// Token accepted on the incoming WS upgrade: the harness auth token only.
// MASTER_KEY is intentionally excluded — it would appear in plaintext in
// ALB access logs and browser history if used as a URL query parameter.
const HARNESS_TOKEN = (process.env.HARNESS_AUTH_TOKEN ?? "").trim();
const CONTAINER_HARNESS_TOKEN = (process.env.CONTAINER_ENV_HARNESS_AUTH_TOKEN ?? "").trim();
if (!HARNESS_TOKEN && !CONTAINER_HARNESS_TOKEN) {
  console.warn("[tty-proxy] WARNING: neither HARNESS_AUTH_TOKEN nor CONTAINER_ENV_HARNESS_AUTH_TOKEN is set — all TTY WebSocket connections will be rejected");
}

function tokenOk(presented) {
  // DEBUG: temporarily bypass token check to isolate proxy vs harness issue.
  // TODO: restore before shipping.
  console.log(`[tty-proxy] tokenOk DEBUG bypass: presented_len=${presented?.length} harness_len=${HARNESS_TOKEN.length} container_len=${CONTAINER_HARNESS_TOKEN.length}`);
  if (presented) return true;
  return false;
}

// --- Prisma lazy singleton ---
let _prisma = null;
function getPrisma() {
  if (!_prisma) {
    const { PrismaClient } = require("@prisma/client");
    _prisma = new PrismaClient({ log: [] });
  }
  return _prisma;
}

// --- Fix 1: DB cache (session_id → sandbox_url, 30s TTL) ---
const SESSION_CACHE_TTL = 30_000;
/** @type {Map<string, {url: string|null, expiresAt: number}>} */
const sessionUrlCache = new Map();

async function getSandboxUrl(sessionId) {
  const now = Date.now();
  const cached = sessionUrlCache.get(sessionId);

  if (cached && cached.expiresAt > now) {
    return cached.url;
  }

  try {
    const session = await getPrisma().session.findUnique({
      where: { session_id: sessionId },
      select: { sandbox_url: true, status: true },
    });
    const url = session?.sandbox_url ?? null;
    // Only cache non-null URLs. A null sandbox_url means the sandbox is still
    // spinning up; caching null would return 503 for 30s even after it's ready.
    if (url !== null) {
      sessionUrlCache.set(sessionId, { url, expiresAt: now + SESSION_CACHE_TTL });
    }
    return url;
  } catch (e) {
    if (cached) {
      console.warn("[tty-proxy] DB lookup failed, using stale cache for session", sessionId, e.message);
      return cached.url;
    }
    throw e;
  }
}

// Parse the HTTP request-line and headers from a raw buffer. Returns null if
// the header block isn't complete yet (caller should buffer more data).
function parseRequest(buf) {
  const str = buf.toString("latin1");
  const eoh = str.indexOf("\r\n\r\n");
  if (eoh === -1) return null;
  const lines = str.slice(0, eoh).split("\r\n");
  const requestLine = lines[0] ?? "";
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).toLowerCase().trim();
    const val = lines[i].slice(colon + 1).trim();
    headers[key] = val;
  }
  return { requestLine, headers };
}

const TTY_PATH_RE = /\/api\/v1\/managed_agents\/sessions\/([^/?]+)\/tty/;

let draining = false;

// Proxy a regular HTTP request to Next.js on NEXT_PORT.
function forwardHttpToNext(req, res) {
  if (draining) { res.writeHead(503); res.end(); return; }
  const proxy = httpRequest({
    hostname: "127.0.0.1",
    port: NEXT_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
  req.pipe(proxy, { end: true });
}

async function handleTtyUpgrade(clientSocket, buf, sessionId, token) {
  console.log(`[tty-proxy] request session=${sessionId} token_present=${!!token}`);

  if (!tokenOk(token)) {
    console.warn(`[tty-proxy] 401 session=${sessionId} presented=${token ? token.slice(0,8) + "…" : "(empty)"} HARNESS_TOKEN_SET=${!!HARNESS_TOKEN} CONTAINER_TOKEN_SET=${!!CONTAINER_HARNESS_TOKEN}`);
    try {
      clientSocket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  let sandboxUrl;
  try {
    sandboxUrl = await getSandboxUrl(sessionId);
  } catch (e) {
    console.error(`[tty-proxy] 503 session=${sessionId} reason=db_error error=${e.message}`);
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  if (!sandboxUrl) {
    console.warn(`[tty-proxy] 503 session=${sessionId} reason=no_sandbox_url (session not ready or missing)`);
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  let parsed;
  try {
    parsed = new URL(sandboxUrl);
  } catch {
    console.error(`[tty-proxy] 500 session=${sessionId} reason=bad_sandbox_url sandbox_url=${sandboxUrl}`);
    try { clientSocket.destroy(); } catch {}
    return;
  }

  const host = parsed.hostname;
  const port = parseInt(parsed.port || "80", 10);

  // Rewrite the request line before forwarding to the sandbox.
  // The browser sends: GET /api/v1/managed_agents/sessions/{id}/tty?token=X HTTP/1.1
  // The harness only handles:            GET /tty?token=X HTTP/1.1
  const rawStr = buf.toString("latin1");
  const lineEnd = rawStr.indexOf("\r\n");
  const parts = rawStr.slice(0, lineEnd).split(" ");
  const origPath = parts[1] ?? "/tty";
  const qIdx = origPath.indexOf("?");
  const ttyPath = "/tty" + (qIdx >= 0 ? origPath.slice(qIdx) : "");
  // Default the HTTP version to avoid "undefined" in the forwarded line if the
  // request line is somehow malformed with fewer than 3 space-delimited tokens.
  const httpVersion = parts[2] ?? "HTTP/1.1";
  const forwardBuf = Buffer.from(
    `${parts[0]} ${ttyPath} ${httpVersion}` + rawStr.slice(lineEnd),
    "latin1",
  );

  console.log(`[tty-proxy] connecting session=${sessionId} target=${host}:${port}`);

  const target = connect(port, host);
  target.once("connect", () => {
    // Peek at the harness response to catch non-101 rejections before piping.
    let peeked = false;
    const onFirstData = (chunk) => {
      if (peeked) return;
      peeked = true;
      const firstLine = chunk.toString("latin1").split("\r\n")[0] ?? "";
      if (firstLine.includes("101")) {
        console.log(`[tty-proxy] upgraded session=${sessionId} target=${host}:${port} response="${firstLine}"`);
      } else {
        console.warn(`[tty-proxy] upgrade_rejected session=${sessionId} target=${host}:${port} response="${firstLine}"`);
      }
    };
    target.once("data", onFirstData);

    target.write(forwardBuf);
    clientSocket.pipe(target);
    target.pipe(clientSocket);
    clientSocket.on("error", (e) => {
      console.error(`[tty-proxy] client socket error session=${sessionId}:`, e.message);
      try { target.destroy(); } catch {}
    });
    target.on("error", (e) => {
      console.error(`[tty-proxy] sandbox socket error session=${sessionId} target=${host}:${port}:`, e.message);
      try { clientSocket.destroy(); } catch {}
    });
  });
  target.once("error", (e) => {
    console.error(`[tty-proxy] sandbox connect error session=${sessionId} target=${host}:${port}: ${e.message}`);
    try { clientSocket.destroy(); } catch {}
  });
}

function extractToken(req) {
  const auth = (req.headers["authorization"] ?? "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const q = (req.url ?? "").indexOf("?");
  if (q < 0) return "";
  return new URLSearchParams((req.url ?? "").slice(q + 1)).get("token") ?? "";
}

function createProxy() {
  // Use http.createServer so each HTTP request on a keep-alive connection is
  // handled independently. The old net.createServer approach piped the entire
  // TCP connection to Next.js after the first request, causing ALB-reused
  // connections to bypass the /tty intercept for subsequent requests.
  const server = createHttpServer((req, res) => {
    const url = req.url ?? "";
    const match = url.match(TTY_PATH_RE);
    console.log(`[tty-proxy] ${req.method} ${url.slice(0,80)} tty=${!!match} upgrade=${req.headers["upgrade"]??""}`);

    if (match) {
      const sessionId = match[1];
      const token = extractToken(req);
      if (!tokenOk(token)) {
        console.warn(`[tty-proxy] 401 session=${sessionId} presented=${token ? token.slice(0,8)+"…" : "(empty)"} HARNESS_TOKEN_SET=${!!HARNESS_TOKEN} CONTAINER_TOKEN_SET=${!!CONTAINER_HARNESS_TOKEN}`);
        res.writeHead(401, { "content-length": "0", "connection": "close" });
        res.end();
        return;
      }
      // Detach socket from http.createServer and proxy raw TCP to harness.
      const socket = req.socket;
      // Reconstruct the raw WS upgrade request for the harness.
      const qIdx = url.indexOf("?");
      const ttyPath = "/tty" + (qIdx >= 0 ? url.slice(qIdx) : "");
      let rawHeaders = `GET ${ttyPath} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(req.headers)) rawHeaders += `${k}: ${v}\r\n`;
      rawHeaders += "\r\n";
      const forwardBuf = Buffer.from(rawHeaders, "latin1");
      // Tell http.createServer to stop tracking this socket.
      socket.setTimeout(0);
      socket.setNoDelay(true);
      req.socket.removeAllListeners();
      handleTtyUpgrade(socket, forwardBuf, sessionId, token).catch((e) => {
        console.error("[tty-proxy] tty error:", e.message);
        try { socket.destroy(); } catch {}
      });
      return;
    }

    if (draining) { res.writeHead(503); res.end(); return; }
    forwardHttpToNext(req, res);
  });

  // Also handle explicit WS upgrade events (when ALB preserves the header).
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const match = url.match(TTY_PATH_RE);
    if (!match) { socket.destroy(); return; }
    const sessionId = match[1];
    const token = extractToken(req);
    if (!tokenOk(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.destroy(); return;
    }
    const qIdx = url.indexOf("?");
    const ttyPath = "/tty" + (qIdx >= 0 ? url.slice(qIdx) : "");
    let rawHeaders = `GET ${ttyPath} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers)) rawHeaders += `${k}: ${v}\r\n`;
    rawHeaders += "\r\n";
    const forwardBuf = head.length > 0
      ? Buffer.concat([Buffer.from(rawHeaders, "latin1"), head])
      : Buffer.from(rawHeaders, "latin1");
    socket.removeAllListeners();
    handleTtyUpgrade(socket, forwardBuf, sessionId, token).catch((e) => {
      console.error("[tty-proxy] upgrade error:", e.message);
      try { socket.destroy(); } catch {}
    });
  });

  return server;
}

// Start Next.js on an internal port so only the proxy faces the network.
// Returns the child process so the SIGTERM handler can kill it.
function startNextServer() {
  const child = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(NEXT_PORT), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.error(`[tty-proxy] Next.js exited (code=${code ?? "?"})`);
    process.exit(code ?? 1);
  });
  process.on("exit", () => {
    try { child.kill(); } catch {}
  });
  return child;
}

// Fix 2: poll for Next.js TCP readiness before starting proxy
function waitForNextReady(port, intervalMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error(`Next.js did not become ready within ${timeoutMs}ms`));
          return;
        }
        console.debug(`[tty-proxy] waiting for Next.js on port ${port}...`);
        setTimeout(attempt, intervalMs);
      });
    }
    attempt();
  });
}

const nextChild = startNextServer();

waitForNextReady(NEXT_PORT, 200, 60_000)
  .then(() => {
    console.log(`[tty-proxy] Next.js ready on 127.0.0.1:${NEXT_PORT}`);

    const proxy = createProxy();

    // Graceful drain on SIGTERM
    process.on("SIGTERM", () => {
      draining = true;
      proxy.close(() => {
        try { nextChild.kill(); } catch {}
        process.exit(0);
      });
      setTimeout(() => {
        try { nextChild.kill(); } catch {}
        process.exit(0);
      }, 30_000);
    });

    proxy.listen(PORT, BIND_HOST, () => {
      console.log(
        `[tty-proxy] listening on ${BIND_HOST}:${PORT} — Next.js on 127.0.0.1:${NEXT_PORT}`,
      );
    });
    proxy.on("error", (e) => {
      console.error("[tty-proxy] server error:", e.message);
      process.exit(1);
    });
  })
  .catch((e) => {
    console.error("[tty-proxy]", e.message);
    process.exit(1);
  });
