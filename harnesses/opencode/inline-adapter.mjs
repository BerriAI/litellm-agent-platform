#!/usr/bin/env node
/*
 * opencode inline adapter — makes attached skills LOADABLE on the single shared
 * `opencode serve` (the opencode-brain-inline harness).
 *
 * Why an adapter at all: opencode discovers skills from disk at session-create
 * time, and the platform delivers an agent's skills as SandboxFileSpec entries
 * in the POST /session `files` array. opencode *does* write that array, but only
 * after the session is created — too late for the new session to discover them.
 * So this adapter writes the skill files to the shared global skills dir
 * (~/.claude/skills) BEFORE forwarding session-create, so opencode picks them up
 * for that turn.
 *
 * Skills are written to the shared dir (not a per-agent directory): on this
 * shared server every agent sees every attached skill. We deliberately do NOT
 * pin sessions to a per-agent `?directory` — opencode's `/event` bus is
 * directory-scoped, and the UI's `/event` subscription has no directory, so a
 * per-session directory would hide the live transcript (the chat would hang on
 * "thinking…" even though the turn completed).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 4096);
const CHILD_PORT = Number(process.env.OPENCODE_CHILD_PORT || PORT + 1);
const UP = `http://127.0.0.1:${CHILD_PORT}`;
const SKILLS_ROOT = path.join(process.env.HOME || "/home/sandbox", ".claude", "skills");
<<<<<<< Updated upstream

const log = (...a) => console.log("[inline-adapter]", ...a);

=======
const DRAIN_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;
const HEALTH_INTERVAL_MS = 30_000;
const MSG_TAIL_CHARS = 200; // how many chars of message content to log

const log = (...a) => console.log("[inline-adapter]", ...a);

// Lifecycle state
let draining = false;       // true once SIGTERM received
let inFlight = 0;           // count of requests currently being handled
let restartCount = 0;       // how many times we've restarted the child
let currentChild = null;    // reference to the active child process

function checkDrainComplete() {
  if (draining && inFlight === 0) {
    log("drain complete — exiting");
    process.exit(0);
  }
}

// Probe the child and return true if it responds to any HTTP request.
function probeChild() {
  return new Promise((resolve) => {
    const req = http.get(UP + "/", { timeout: 2000 }, (res) => {
      res.resume();
      resolve({ ok: (res.statusCode ?? 0) > 0, status: res.statusCode });
    });
    req.on("error", (e) => resolve({ ok: false, err: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, err: "timeout" }); });
  });
}

>>>>>>> Stashed changes
// A SandboxFileSpec is a skill file when its sandbox_path lands in a skills dir
// and is a SKILL.md. Returns the slug (the directory under skills/), else null.
// Leading-alnum anchor rejects "." / ".." so a crafted name can't escape the dir.
function skillSlug(sandboxPath) {
  if (!sandboxPath) return null;
  const m = sandboxPath.replace(/\\/g, "/").match(/\/skills\/([^/]+)\/SKILL\.md$/);
  return m && /^[a-z0-9][a-z0-9._-]*$/i.test(m[1]) ? m[1] : null;
}

// Write a session's skill files to the shared global skills dir so opencode
// discovers them when it creates the session. Returns how many were written.
function materializeSkills(files) {
  let written = 0;
  for (const f of files || []) {
    const slug = skillSlug(f.sandbox_path);
    if (!slug) continue;
    const dir = path.join(SKILLS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), Buffer.from(f.content || "", "base64"));
    written++;
  }
  return written;
}

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

// Extract the tail of the last text part from a message body for logging.
function extractMsgTail(rawBody) {
  try {
    const body = JSON.parse(rawBody || "{}");
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const textParts = parts.filter((p) => p && p.type === "text" && typeof p.text === "string");
    if (textParts.length === 0) return null;
    const last = textParts[textParts.length - 1].text;
    return last.length > MSG_TAIL_CHARS ? "…" + last.slice(-MSG_TAIL_CHARS) : last;
  } catch {
    return null;
  }
}

function forward(method, urlPath, search, bodyBuf, clientRes, label) {
  const t0 = Date.now();
  const dest = UP + urlPath + (search || "");
  const upReq = http.request(dest, { method, headers: { "content-type": "application/json" } }, (upRes) => {
    const elapsed = Date.now() - t0;
    log(`← ${upRes.statusCode} ${method} ${urlPath} (${elapsed}ms)`);
    if (upRes.statusCode >= 400) {
      // Collect and log error body so we can see what opencode said
      let errBody = "";
      upRes.on("data", (c) => { errBody += c; });
      upRes.on("end", () => {
        log(`child error body for ${label || urlPath}: ${errBody.slice(0, 300)}`);
      });
    }
    clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(clientRes);
  });
  upReq.on("error", (e) => {
    const elapsed = Date.now() - t0;
    log(`forward error ${e.code || e.message} on ${method} ${urlPath} (${elapsed}ms)`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: String(e) }));
    }
  });
  if (bodyBuf) upReq.write(bodyBuf);
  upReq.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/" || p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
<<<<<<< Updated upstream
    res.end(JSON.stringify({ harness: "opencode-brain-inline", ok: true }));
    return;
  }

=======
    res.end(JSON.stringify({ harness: "opencode-brain-inline", ok: true, draining, inFlight, restartCount }));
    return;
  }

  // Reject NEW session creates while draining; all other in-flight paths continue.
  if (draining && p === "/session" && req.method === "POST") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server is draining — no new sessions accepted" }));
    return;
  }

  // Log every incoming request with path + Content-Length
  const contentLength = req.headers["content-length"] || "?";
  log(`→ ${req.method} ${p} (${contentLength} bytes)`);

  inFlight++;
  let decremented = false;
  const decrement = () => { if (!decremented) { decremented = true; inFlight--; checkDrainComplete(); } };
  res.on("finish", decrement);
  res.on("close", decrement);

>>>>>>> Stashed changes
  // POST /session: materialize this agent's skills before opencode creates the
  // session, then forward unchanged (no ?directory — keep the /event bus global).
  if (p === "/session" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const n = materializeSkills(body.files);
    // Drop skill files from the forwarded body — opencode would otherwise
    // re-write them (to the same path) after create, which is just wasted work.
    if (Array.isArray(body.files)) body.files = body.files.filter((f) => !skillSlug(f.sandbox_path));
    log(`session create: materialized ${n} skill(s) title=${JSON.stringify(body.title || "")}`);
    forward("POST", "/session", "", Buffer.from(JSON.stringify(body)), res, "session-create");
    return;
  }

  // For message/prompt_async paths: log content tail + probe child before forwarding.
  const isMessagePath = req.method === "POST" &&
    /\/session\/[^/]+\/(message|prompt_async)$/.test(p);

  if (isMessagePath) {
    const raw = await readBody(req);

    // Log message content tail
    const tail = extractMsgTail(raw);
    if (tail !== null) {
      log(`message tail for ${p}: ${JSON.stringify(tail)}`);
    }

    // Probe child before forwarding — surfaces ECONNREFUSED immediately
    // instead of letting the request hang until the upstream times out.
    const probe = await probeChild();
    if (!probe.ok) {
      log(`child unreachable BEFORE forward on ${p}: ${probe.err || "no response"}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `adapter: child unreachable — ${probe.err || "no response"}` }));
      return;
    }

    forward(req.method, p, url.search, Buffer.from(raw), res, p);
    return;
  }

  // Everything else (/event, /session/:id/*, ...) — transparent passthrough.
  const raw = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
  forward(req.method, p, url.search, raw ? Buffer.from(raw) : null, res, p);
});

// Boot the shared opencode serve as a child, then start accepting traffic.
function startChild() {
  log(`spawning: opencode serve on :${CHILD_PORT}`);
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(CHILD_PORT)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => { log(`opencode serve exited (${code}) — shutting down`); process.exit(code ?? 1); });
}

async function waitChild() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => {
      // Ready = the child answers HTTP at all. opencode is installed unpinned, and
      // its `/` route's status code has drifted across versions (200 -> 404/redirect);
      // requiring exactly 200 here silently wedged the deploy ("No open ports on
      // 0.0.0.0") because the adapter never reached server.listen(). Any HTTP
      // response means opencode is up and serving, which is all we need.
      const rq = http.get(UP + "/", (res) => { res.resume(); r((res.statusCode ?? 0) > 0); });
      rq.on("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

fs.mkdirSync(SKILLS_ROOT, { recursive: true });
startChild();
waitChild().then((ok) => {
  if (!ok) { log("opencode serve never became ready"); process.exit(1); }
  log(`listening :${PORT} -> ${UP} | skills=${SKILLS_ROOT}`);
  server.listen(PORT, "0.0.0.0");

  // Periodic child health heartbeat
  const healthTimer = setInterval(async () => {
    const probe = await probeChild();
    if (probe.ok) {
      log(`child health OK (${UP}) | inFlight=${inFlight} restarts=${restartCount} draining=${draining}`);
    } else {
      log(`child health FAIL (${UP}): ${probe.err || "no response"} | restarts=${restartCount}`);
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
});
