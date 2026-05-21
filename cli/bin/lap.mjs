#!/usr/bin/env node
// lap — LiteLLM Agent Platform CLI
//
// Usage:
//   lap <agent-name>                open the agent's TUI in a sandbox
//   lap --agent <name>              same as above (flag form)
//   lap --resume <id-or-url>        reattach to an existing session by ID
//                                    or by full <base>/sessions/<id> URL
//   lap agents                      list agents on the platform
//   lap login                       set base URL + master key (one-time)
//   lap config                      show current config
//   lap logout                      delete config
//
// Install:
//   npm install -g @berriai/lap-cli
//
// First run: prompts for the agent platform URL + master key. Saved to
// ~/.lap/config.json (chmod 0600).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { WebSocket } from "ws";

const CONFIG = path.join(os.homedir(), ".lap", "config.json");

// Optional fallback when the platform returns an in-cluster sandbox_url
// the local laptop can't reach AND doesn't provide session.tty_url
// (older platforms before the WS proxy landed). New platforms expose
// session.tty_url and the CLI prefers it automatically.
const TTY_FALLBACK = process.env.LAP_TTY_FALLBACK ?? "";

const PKG_VERSION = (() => {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version ?? "?";
  } catch { return "?"; }
})();

// ANSI helpers used by the banner, picker, and command output.
const ansi = {
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  blueBold: s => `\x1b[1;94m${s}\x1b[0m`,
};

function renderBanner() {
  const cfg = loadConfig();
  const where = cfg?.base ?? "(not configured)";
  const { blueBold: b, bold, dim } = ansi;
  // Bright-white pixel-art-style face glyphs over a blue body.
  const w = s => `\x1b[1;97m${s}\x1b[0m`;
  // Side-profile chibi bullet-train sprite (4 lines) above the wordmarks.
  // Curved nose on the left (▄▀…), single white `•` "eye" on the front
  // where the driver's windscreen would be, dim `▭` windows along the
  // body, two pairs of `▀▀` wheels under the chassis. ~22 cols wide,
  // centered over the 56-col LITELLM band → 19 leading spaces. Below:
  // ANSI-shaded "LITELLM" block-letter wordmark + smaller 2-row
  // "AGENT PLATFORM" wordmark in the same bright blue. Full banner is
  // ~13 lines — only shown on `lap` (wizard) and `lap login`, not on
  // fast paths like `lap <name>`.
  const sp = " ".repeat(19);
  const lines = [
    "",
    `${sp}${b("     ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄")}`,
    `${sp}${b("   ▄▀")} ${w("•")} ${dim("▭ ▭ ▭ ▭ ▭")} ${b("█")}`,
    `${sp}${b("   █████████████████████")}`,
    `${sp}${b("     ▀▀          ▀▀")}`,
    "",
    `  ${b("██╗     ██╗████████╗███████╗██╗     ██╗     ███╗   ███╗")}`,
    `  ${b("██║     ██║╚══██╔══╝██╔════╝██║     ██║     ████╗ ████║")}`,
    `  ${b("██║     ██║   ██║   █████╗  ██║     ██║     ██╔████╔██║")}`,
    `  ${b("██║     ██║   ██║   ██╔══╝  ██║     ██║     ██║╚██╔╝██║")}`,
    `  ${b("███████╗██║   ██║   ███████╗███████╗███████╗██║ ╚═╝ ██║")}`,
    `  ${b("╚══════╝╚═╝   ╚═╝   ╚══════╝╚══════╝╚══════╝╚═╝     ╚═╝")}`,
    "",
    `  ${b("▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀   █▀█ █   ▄▀█ ▀█▀ █▀▀ █▀█ █▀█ █▄ ▄█")}`,
    `  ${b("█▀█ █▄█ █▄▄ █ ▀█  █    █▀▀ █▄▄ █▀█  █  █▀  █▄█ █▀▄ █ ▀ █")}`,
    "",
    `              ${dim(`lap-cli v${PKG_VERSION}  ${where}`)}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// Arrow-key picker over `items`. `render(item, isHighlighted)` returns the
// row body (no trailing newline). Returns the chosen item, or null on Esc /
// Ctrl-C / q. Single-item lists are returned without prompting.
function pickFromList(items, render) {
  if (items.length === 0) return Promise.resolve(null);
  if (items.length === 1) return Promise.resolve(items[0]);
  let cur = 0;
  const draw = () => {
    for (let i = 0; i < items.length; i++) {
      const marker = i === cur ? ansi.cyan("▶ ") : "  ";
      process.stdout.write(marker + render(items[i], i === cur) + "\n");
    }
  };
  const erase = () => {
    readline.moveCursor(process.stdout, 0, -items.length);
    for (let i = 0; i < items.length; i++) {
      readline.clearLine(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, 1);
    }
    readline.moveCursor(process.stdout, 0, -items.length);
  };
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.off("keypress", onKey);
      process.stdin.pause();
    };
    const onKey = (_, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        cur = (cur - 1 + items.length) % items.length; erase(); draw();
      } else if (key.name === "down" || key.name === "j") {
        cur = (cur + 1) % items.length; erase(); draw();
      } else if (key.name === "return") {
        cleanup(); resolve(items[cur]);
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup(); resolve(null);
      }
    };
    process.stdin.on("keypress", onKey);
    draw();
  });
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return null; }
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  try { fs.chmodSync(CONFIG, 0o600); } catch {}
}

function ask(prompt, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // mute keystroke echo while we read the line; restore after.
      const onKey = () => {
        readline.moveCursor(process.stdout, -rl.line.length - prompt.length, 0);
        readline.clearLine(process.stdout, 1);
        process.stdout.write(prompt + "•".repeat(rl.line.length));
      };
      process.stdin.on("keypress", onKey);
      rl.once("close", () => process.stdin.off("keypress", onKey));
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function login({ banner = true } = {}) {
  if (banner) renderBanner();
  process.stdout.write("  \x1b[1mSet up the agent platform\x1b[0m\n");
  process.stdout.write("  \x1b[2mSaved to ~/.lap/config.json (chmod 0600)\x1b[0m\n\n");
  const base = (await ask("  Agent platform URL: ")).trim().replace(/\/+$/, "");
  const key  = (await ask("  Master key:         ", { hidden: true })).trim();
  if (!base || !key) { console.error("  \x1b[31maborted\x1b[0m"); process.exit(1); }
  saveConfig({ base, key });
  console.log(`  \x1b[32m✓ saved to ${CONFIG}\x1b[0m\n`);
  return { base, key };
}

// Backend exposes `supports_tui` (derived from TUI_HARNESSES). Fall back to
// a client-side allowlist when the field is missing so a fresh CLI still
// works against a platform that hasn't shipped the field yet.
const CLIENT_TUI_HARNESSES = new Set(["claude-code", "codex"]);
function isTuiAgent(a) {
  if (typeof a.supports_tui === "boolean") return a.supports_tui;
  return CLIENT_TUI_HARNESSES.has(a.harness_id);
}

// Re-fetches the session row one more time (best-effort) and prints every
// field that's useful for debugging a stuck startup — session id, status,
// phase, phase_detail, failure_reason, sandbox_url, timestamps — so the
// user has something concrete to paste when reporting the issue. Called
// from the poll loop on timeout and on terminal `failed`/`dead` status.
async function printSessionDiagnostics(cfg, sid, lastSession, headline) {
  let s = lastSession;
  try {
    const r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sid}`, {
      headers: { "authorization": `Bearer ${cfg.key}` },
    });
    if (r.ok) s = (await r.json().catch(() => null)) ?? s;
  } catch { /* keep lastSession — diagnostics are best-effort */ }
  const fields = [
    ["session_id",     sid],
    ["status",         s?.status],
    ["phase",          s?.phase],
    ["phase_detail",   s?.phase_detail],
    ["failure_reason", s?.failure_reason],
    ["sandbox_url",    s?.sandbox_url],
    ["created_at",     s?.created_at],
    ["last_seen_at",   s?.last_seen_at ?? s?.updated_at],
  ];
  console.error(`\n  ${ansi.red(`✗ ${headline}`)}\n`);
  for (const [k, v] of fields) {
    if (v === undefined || v === null || v === "") continue;
    const label = (k + ":").padEnd(16);
    const display = typeof v === "string" ? v : JSON.stringify(v);
    console.error(`    ${ansi.dim(label)}${display}`);
  }
  console.error(`\n    ${ansi.dim("please share this block when reporting the issue.")}`);
}

// Derive the WS URL to attach to from a session row. Returns null + prints
// an error to stderr if neither a public tty_url nor a reachable sandbox_url
// is available (older platforms, in-cluster sandbox without LAP_TTY_FALLBACK).
function deriveTtyUrl(cfg, session) {
  if (session.tty_url) {
    if (/^wss?:\/\//.test(session.tty_url)) return session.tty_url;
    if (/^https?:\/\//.test(session.tty_url)) return session.tty_url.replace(/^http/, "ws");
    const baseWs = cfg.base.replace(/^http/, "ws").replace(/\/+$/, "");
    const suffix = session.tty_url.startsWith("/") ? session.tty_url : `/${session.tty_url}`;
    return baseWs + suffix;
  }
  if (session.sandbox_url && !session.sandbox_url.includes(".svc.cluster.local")) {
    return session.sandbox_url.replace(/^http/, "ws").replace(/\/+$/, "") + "/tty";
  }
  if (TTY_FALLBACK) {
    console.log(`  ${ansi.dim("(sandbox_url is in-cluster — using LAP_TTY_FALLBACK)")}`);
    return TTY_FALLBACK;
  }
  if (session.sandbox_url) {
    console.error(`  ${ansi.red(`✗ session.sandbox_url is in-cluster (${session.sandbox_url}) and the platform did not return a tty_url.`)}`);
  } else {
    console.error(`  ${ansi.red("✗ platform returned neither tty_url nor a reachable sandbox_url.")}`);
  }
  console.error(`  ${ansi.dim("  upgrade the platform, or set LAP_TTY_FALLBACK=ws://host:port/tty in your env")}`);
  return null;
}

// Called from the WS close handler. The connection is gone but the session
// row may still be ready on the server (ALB idle drop, transient network
// blip, harness still running). Best-effort GET — if the row is ready, tell
// the user how to reattach; if it's failed/dead, surface the reason instead
// so they don't paste the resume command into a black hole.
async function printResumeHint(cfg, sid) {
  let status = null;
  let failure = null;
  try {
    const r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sid}`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    });
    if (r.ok) {
      const s = await r.json().catch(() => null);
      status = s?.status ?? null;
      failure = s?.failure_reason ?? null;
    }
  } catch { /* best-effort */ }

  if (status === "ready") {
    console.log(`\n  ${ansi.bold("Session is still alive.")} Resume with:\n`);
    console.log(`    ${ansi.cyan(`lap --resume ${sid}`)}\n`);
    console.log(`  ${ansi.dim("or with the full URL:")}`);
    console.log(`    ${ansi.dim(`lap --resume ${cfg.base}/sessions/${sid}`)}\n`);
    return;
  }
  if (status === "failed" || status === "dead" || status === "stopped") {
    const reason = failure ? ` — ${failure}` : "";
    console.log(`\n  ${ansi.yellow(`Session is ${status}${reason}.`)}\n`);
    return;
  }
  // Couldn't fetch (auth, network, 5xx). Still surface the resume command so
  // the user has a chance — `lap --resume` will repeat the GET with the same
  // error path and produce a clearer message if it's still broken.
  console.log(`\n  ${ansi.dim("(could not verify session state — try anyway)")}\n`);
  console.log(`    ${ansi.cyan(`lap --resume ${sid}`)}\n`);
}

async function openAgent(args) {
  // Accept `lap <name>`, `lap --agent <name>`, or `lap` (prompts).
  // The agent's harness_id determines what CLI runs inside the sandbox
  // (claude-code, codex, …) — the user doesn't need to say.
  const flagIdx = args.indexOf("--agent");
  let wanted = "";
  if (flagIdx >= 0) {
    wanted = args[flagIdx + 1] ?? "";
  } else {
    const positional = args.find(a => !a.startsWith("-"));
    if (positional) wanted = positional;
  }
  if (!wanted) {
    console.error("  usage: lap <agent-name>  (or `lap --agent <name>`)");
    console.error("  list:  lap agents");
    process.exit(2);
  }

  let cfg = loadConfig();
  if (!cfg) {
    console.log("\n  \x1b[33mNo agent platform configured.\x1b[0m");
    cfg = await login();
  }

  // Resolve agent: accept either a UUID or a name.
  let agentId;
  // Null = unknown (UUID path, no agent object fetched); we'll fall back to
  // session.supports_tui after polling. True/false = known from the agent list.
  let agentSupportsTui = null;
  if (/^[0-9a-f-]{36}$/i.test(wanted)) {
    agentId = wanted;
  } else {
    process.stdout.write(`  \x1b[2m→ resolving agent '${wanted}'…\x1b[0m`);
    try {
      const r = await fetch(`${cfg.base}/api/v1/managed_agents/agents`, {
        headers: { "authorization": `Bearer ${cfg.key}` },
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const { data } = await r.json();
      const hit = data.find(a => a.name === wanted);
      if (!hit) {
        console.error(`\n  \x1b[31m✗ no agent named '${wanted}'.\x1b[0m`);
        console.error(`  \x1b[2mavailable: ${data.slice(0, 8).map(a => a.name).join(", ")}${data.length > 8 ? ` (+${data.length - 8} more)` : ""}\x1b[0m`);
        process.exit(1);
      }
      agentId = hit.id;
      agentSupportsTui = isTuiAgent(hit);
      console.log(`\r  \x1b[32m✓\x1b[0m agent \x1b[36m${hit.name}\x1b[0m \x1b[2m(${agentId.slice(0,8)}, harness=${hit.harness_id})\x1b[0m`);
    } catch (e) {
      console.error(`\n  \x1b[31m✗ agent lookup failed: ${e.message}\x1b[0m`);
      process.exit(1);
    }
  }

  process.stdout.write(`  \x1b[2m→ POST .../agents/${agentId.slice(0,8)}…/session\x1b[0m\n`);
  let sid;
  try {
    const res = await fetch(`${cfg.base}/api/v1/managed_agents/agents/${agentId}/session`, {
      method: "POST",
      headers: { "authorization": `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "lap-cli" }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    ({ id: sid } = await res.json());
  } catch (e) {
    console.error(`  \x1b[31m✗ session create failed: ${e.message}\x1b[0m`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✓\x1b[0m session \x1b[36m${sid.slice(0,8)}\x1b[0m`);

  process.stdout.write(`  ${ansi.dim("waiting for sandbox")} `);
  let session = null;
  // Network blips shouldn't abort the poll, but server-side errors (401,
  // 4xx auth, 5xx outage) should surface fast. We tolerate up to two
  // consecutive failures and then bail with the upstream status so the
  // user isn't waiting out the full 60-iteration timeout to see a 401.
  let consecutiveFailures = 0;
  // Track the most recent phase we printed so we can surface phase
  // transitions inline instead of just dots — gives the user real signal
  // about why a slow start is slow (cloning_repo vs installing_deps vs
  // waiting_harness, etc.) rather than an opaque row of `.`.
  let lastPhase = null;
  const POLL_LIMIT = 60;
  const POLL_INTERVAL_MS = 1500;
  for (let i = 0; i < POLL_LIMIT; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let r;
    try {
      r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sid}`, {
        headers: { "authorization": `Bearer ${cfg.key}` },
      });
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        console.error(`\n  \x1b[31m✗ session poll failed: ${e.message}\x1b[0m`);
        process.exit(1);
      }
      process.stdout.write("?");
      continue;
    }
    if (!r.ok) {
      // Auth errors are terminal — re-polling won't fix a wrong master key.
      if (r.status === 401 || r.status === 403) {
        console.error(`\n  \x1b[31m✗ session poll: ${r.status} ${r.statusText} (master key invalid?)\x1b[0m`);
        process.exit(1);
      }
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        const body = await r.text().catch(() => "");
        console.error(`\n  \x1b[31m✗ session poll: ${r.status} ${r.statusText} ${body.slice(0, 120)}\x1b[0m`);
        process.exit(1);
      }
      process.stdout.write("?");
      continue;
    }
    consecutiveFailures = 0;
    session = await r.json().catch(() => null);
    const phase = session?.phase ?? null;
    if (phase && phase !== lastPhase) {
      // First phase we see prints as `phase`; later transitions as `→ phase`
      // so the line reads like `creating → cloning_repo → installing_deps`.
      const arrow = lastPhase ? ` ${ansi.dim("→")} ` : "";
      process.stdout.write(`${arrow}${ansi.cyan(phase)} `);
      lastPhase = phase;
    } else {
      process.stdout.write(".");
    }
    if (session?.status === "ready") break;
    if (session?.status === "failed" || session?.status === "dead") {
      await printSessionDiagnostics(cfg, sid, session, `${session.status}`);
      process.exit(1);
    }
  }
  if (session?.status !== "ready") {
    const timeoutSecs = Math.round((POLL_LIMIT * POLL_INTERVAL_MS) / 1000);
    await printSessionDiagnostics(cfg, sid, session, `session did not reach ready in ${timeoutSecs}s`);
    process.exit(1);
  }
  process.stdout.write(` ${ansi.cyan("ready")}\n`);

  // Determine interaction mode. agentSupportsTui is known when we resolved by
  // name (agent list fetch). For UUID path it's null; fall back to the
  // session.supports_tui field the updated platform now returns.
  const tuiMode = agentSupportsTui ?? session.supports_tui ?? true;

  if (!tuiMode) {
    await attachRepl(cfg, sid);
    return;
  }

  // Prefer session.tty_url when the platform provides it — that's a
  // platform-served route (e.g. /api/v1/managed_agents/sessions/<id>/tty
  // proxied by server-proxy.mjs) that's reachable over the same public
  // ingress as the rest of the API. Fall back to sandbox_url + /tty for
  // older platforms / local dev where the sandbox is directly reachable.
  const wsUrl = deriveTtyUrl(cfg, session);
  if (!wsUrl) process.exit(1);
  // The harness's verifyClient requires the bearer token; the platform
  // returns it via session.tty_token (preferred) or via LAP_TTY_TOKEN env.
  const ttyToken = session.tty_token || process.env.LAP_TTY_TOKEN || "";
  console.log(`  \x1b[2m→ attaching local TTY to ${wsUrl}\x1b[0m`);
  console.log("  \x1b[2m(press Ctrl-D to detach)\x1b[0m\n");

  await attachPty(cfg, sid, wsUrl, ttyToken);
}

// Reattach to an existing session by ID or by a full <base>/sessions/<id>
// URL. Surfaced as the recovery path when the WS drops mid-session (which
// is what `[connection closed]` prints when the ALB/ELB times us out or the
// pod's egress hiccups). Refuses to attach when the session row is not
// `ready` so the user doesn't stare at a dead WebSocket; the failure_reason
// is printed instead.
async function resumeSession(arg) {
  if (!arg) {
    console.error("  usage: lap --resume <session_id>");
    console.error("         lap --resume <base>/sessions/<session_id>");
    process.exit(2);
  }

  let baseOverride = null;
  let sid;
  // Accept either a bare UUID or a full URL whose path ends in
  // `/sessions/<uuid>` (with optional query/fragment). The URL form lets a
  // user paste a UI link directly from the platform without first running
  // `lap login` against that base.
  const urlMatch = arg.match(/^(https?:\/\/[^/]+(?:\/[^/?#]+)*?)\/sessions\/([0-9a-f-]{36})(?:[/?#].*)?$/i);
  if (urlMatch) {
    baseOverride = urlMatch[1].replace(/\/+$/, "");
    sid = urlMatch[2];
  } else if (/^[0-9a-f-]{36}$/i.test(arg)) {
    sid = arg;
  } else {
    console.error(`  ${ansi.red(`✗ '${arg}' is not a session_id or sessions URL`)}`);
    process.exit(2);
  }

  let cfg = loadConfig();
  if (!cfg) {
    console.error(`  ${ansi.red("✗ no config — run `lap login` first.")}`);
    process.exit(1);
  }
  // URL-form base override applies for this one attach only — we don't
  // persist it. If the user wants the new base saved, they can `lap login`.
  if (baseOverride && baseOverride !== cfg.base) {
    console.log(`  ${ansi.dim(`→ using base from URL: ${baseOverride}`)}`);
    cfg = { ...cfg, base: baseOverride };
  }

  process.stdout.write(`  ${ansi.dim(`→ fetching session ${sid.slice(0, 8)}…`)} `);
  let session;
  try {
    const r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sid}`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    });
    if (!r.ok) {
      console.error(`\n  ${ansi.red(`✗ ${r.status} ${r.statusText}`)}`);
      process.exit(1);
    }
    session = await r.json();
  } catch (e) {
    console.error(`\n  ${ansi.red(`✗ session fetch failed: ${e.message}`)}`);
    process.exit(1);
  }
  if (session.status !== "ready") {
    const reason = session.failure_reason ? `: ${session.failure_reason}` : "";
    console.error(`\n  ${ansi.red(`✗ session is ${session.status}${reason}`)}`);
    process.exit(1);
  }
  console.log(ansi.cyan("ready"));

  // session.supports_tui is present on updated platforms; for older platforms
  // that don't return it, fall back to tty_url presence as a proxy.
  const tuiMode = typeof session.supports_tui === "boolean"
    ? session.supports_tui
    : !!session.tty_url;

  if (!tuiMode) {
    await attachRepl(cfg, sid);
    return;
  }

  const wsUrl = deriveTtyUrl(cfg, session);
  if (!wsUrl) process.exit(1);
  const ttyToken = session.tty_token || process.env.LAP_TTY_TOKEN || "";
  console.log(`  ${ansi.dim(`→ attaching local TTY to ${wsUrl}`)}`);
  console.log(`  ${ansi.dim("(press Ctrl-D to detach)")}\n`);
  await attachPty(cfg, sid, wsUrl, ttyToken);
}

// Render a markdown string with ANSI terminal formatting (no deps).
function renderMarkdown(text) {
  const lines = text.split("\n");
  const out = [];
  let inCode = false;
  const codeLines = [];

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(codeLines.map(l => `  \x1b[2m${l}\x1b[0m`).join("\n"));
        codeLines.length = 0;
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    const h1 = line.match(/^# (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    if (h1) { out.push(`\x1b[1;4m${h1[1]}\x1b[0m`); continue; }
    if (h2) { out.push(`\x1b[1m${h2[1]}\x1b[0m`); continue; }
    if (h3) { out.push(`\x1b[1m${h3[1]}\x1b[0m`); continue; }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      out.push(`\x1b[2m${"─".repeat(40)}\x1b[0m`);
      continue;
    }

    let l = line;
    l = l.replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[0m");
    l = l.replace(/__(.+?)__/g, "\x1b[1m$1\x1b[0m");
    l = l.replace(/`([^`]+)`/g, "\x1b[36m$1\x1b[0m");
    out.push(l);
  }

  if (inCode && codeLines.length > 0) {
    out.push(codeLines.map(l => `  \x1b[2m${l}\x1b[0m`).join("\n"));
  }

  return out.join("\n");
}

// Extract a plain-text string from a HarnessMessageResponse (parts array).
function extractReplText(data) {
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const texts = parts
    .filter(p => p?.type === "text" && typeof p.text === "string")
    .map(p => p.text);
  if (texts.length > 0) return texts.join("\n");
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.response === "string") return data.response;
  return JSON.stringify(data, null, 2);
}

// Animated spinner shown while the agent turn is in-flight.
// Returns a stop() function that clears the line and returns elapsed seconds.
function startSpinner() {
  const verbs = ["Thinking","Running","Churning","Working","Percolating"];
  const start = Date.now();
  let dots = 0;
  // Write a blank line that the spinner will own — readline already moved to a
  // new line after Enter, so we take the next line and hold it.
  process.stdout.write("\n");
  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const verb    = verbs[Math.floor(elapsed / 4) % verbs.length];
    const trail   = ".".repeat((dots % 3) + 1).padEnd(3, " ");
    // \x1b[1A = up 1 line  \x1b[2K = erase entire line  \r = col 0
    process.stdout.write(`\x1b[1A\x1b[2K\r  * ${verb}${trail}(${elapsed}s)\n`);
    dots++;
  }, 300);
  return {
    stop() {
      clearInterval(timer);
      // Erase the spinner line and leave cursor at col 0 on that line
      process.stdout.write(`\x1b[1A\x1b[2K\r`);
      return Math.round((Date.now() - start) / 1000);
    },
  };
}

// REPL mode for JSON-API harnesses (claude-agent-sdk, opencode).
// Sends each line through LAP's opencode proxy
// (POST /sessions/:id/opencode/session/:ocid/message) and prints the reply.
function attachRepl(cfg, sid) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: ansi.cyan("  > "),
    });

    console.log(`  ${ansi.dim("Chat mode — Ctrl-D to exit")}\n`);
    rl.prompt();

    let busy = false;
    // opencode session id, resolved once from the LAP session row. The CLI
    // talks to the harness through LAP's opencode proxy, same as the UI.
    let ocid = null;
    const resolveOcid = async () => {
      if (ocid) return ocid;
      const r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sid}`, {
        headers: { authorization: `Bearer ${cfg.key}` },
      });
      if (!r.ok) throw new Error(`session lookup failed: ${r.status}`);
      const s = await r.json();
      if (!s.harness_session_id) {
        throw new Error("session has no harness_session_id yet");
      }
      ocid = s.harness_session_id;
      return ocid;
    };
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) { rl.prompt(); return; }
      if (busy) return; // drop input while request is in-flight
      busy = true;
      (async () => {
        const spinner = startSpinner();
        try {
          const id = await resolveOcid();
          const r = await fetch(`${cfg.base}/api/v1/managed_agents/sessions/${sid}/opencode/session/${id}/message`, {
            method: "POST",
            headers: {
              "authorization": `Bearer ${cfg.key}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ parts: [{ type: "text", text }] }),
          });
          const elapsed = spinner.stop();
          if (!r.ok) {
            const body = await r.text().catch(() => "");
            console.error(`  ${ansi.red(`✗ ${r.status} ${r.statusText} ${body.slice(0, 120)}`)}`);
          } else {
            const data = await r.json().catch(() => null);
            const tokens = data?.info?.tokens;
            const cost   = data?.info?.cost;
            const meta   = [
              `${elapsed}s`,
              tokens?.output != null ? `↓ ${tokens.output} tokens` : null,
              cost != null ? `$${cost.toFixed(4)}` : null,
            ].filter(Boolean).join(" · ");
            console.log("\n" + renderMarkdown(extractReplText(data)) + "\n");
            process.stdout.write(`  ${ansi.dim(meta)}\n\n`);
          }
        } catch (e) {
          spinner.stop();
          console.error(`  ${ansi.red(`✗ ${e.message}`)}`);
        }
        busy = false;
        rl.prompt();
      })();
    });

    rl.on("close", async () => {
      // Wait for any in-flight request to finish so piped / scripted
      // usage sees the response before the process exits.
      while (busy) await new Promise(r => setTimeout(r, 50));
      console.log(`\n  ${ansi.dim("[chat ended]")}`);
      resolve();
      process.exit(0);
    });
  });
}

function attachPty(cfg, sid, wsUrl, ttyToken) {
  return new Promise((resolve, reject) => {
    // Send the token both as `?token=` and as an Authorization header. AWS
    // ALB / Classic ELB silently strip custom request headers (including
    // Authorization) on WebSocket upgrade requests, so a header-only auth
    // gets a 401 from behind those load balancers — verified against the
    // production EKS ELB ingress, where the header form was rejected but
    // `?token=` succeeded with HTTP 101. The harness and server-proxy.mjs
    // both already accept either form, so sending both is safe and works
    // whether the path goes through an ALB or not.
    const urlWithToken = ttyToken
      ? `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(ttyToken)}`
      : wsUrl;
    const headers = ttyToken ? { authorization: `Bearer ${ttyToken}` } : undefined;
    const ws = new WebSocket(urlWithToken, { headers });
    // Default binaryType ("nodebuffer") yields Buffer in the message event,
    // which process.stdout.write accepts directly. Setting "arraybuffer"
    // would crash on every binary PTY frame because stdout.write rejects
    // ArrayBuffer.

    // Keep-alive: AWS classic ELB defaults to 60s idle timeout, and many
    // corporate proxies / NLBs are similarly tight. The TTY can sit silent
    // for minutes (model thinking, user reading a permission prompt) and
    // the WS gets silently dropped — the next keystroke goes to a dead
    // socket and the user sees "[connection closed]" with no warning.
    // Send a protocol-level WS ping every 30s so there's always recent
    // traffic. The ws library handles pong correlation automatically.
    let pingTimer;

    ws.on("open", () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      ws.send(JSON.stringify({
        type: "resize",
        cols: process.stdout.columns || 100,
        rows: process.stdout.rows || 30,
      }));

      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.ping(); } catch { /* underlying socket already torn down */ }
      }, 30_000);

      process.stdin.on("data", (data) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Ctrl-D detaches the local CLI; the remote process stays alive.
        if (data.length === 1 && data[0] === 0x04) { ws.close(); return; }
        ws.send(data);
      });

      process.stdout.on("resize", () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: "resize",
          cols: process.stdout.columns,
          rows: process.stdout.rows,
        }));
      });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || data instanceof Buffer) process.stdout.write(data);
      else process.stdout.write(typeof data === "string" ? data : Buffer.from(data));
    });

    ws.on("close", async (code, reasonBuf) => {
      if (pingTimer) clearInterval(pingTimer);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      // Surface the close code/reason so a future drop is debuggable —
      // 1006 = abnormal closure (typical ALB idle drop), 1001 = going away
      // (pod restart / proxy shutdown), 1008 = policy violation (auth).
      const reason = reasonBuf?.length ? reasonBuf.toString("utf8") : "";
      const codeStr = code ? ` code=${code}` : "";
      const reasonStr = reason ? ` reason=${reason}` : "";
      console.log(`\n  ${ansi.dim(`[connection closed${codeStr}${reasonStr}]`)}`);
      // Best-effort: tell the user how to reattach if the session row is
      // still ready, or print the failure_reason if it died.
      await printResumeHint(cfg, sid);
      resolve();
      process.exit(0);
    });

    ws.on("error", (err) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      console.error(`\n  \x1b[31m✗ ws error: ${err.message}\x1b[0m`);
      reject(err);
      process.exit(1);
    });
  });
}

function help() {
  console.log(`
  \x1b[1mlap\x1b[0m — LiteLLM Agent Platform CLI

  \x1b[2mUSAGE\x1b[0m
    lap                             interactive wizard (login + agent picker)
    lap <agent-name>                open the agent's TUI in a sandbox
    lap --agent <name>              same as above (flag form)
    lap --resume <id-or-url>        reattach to an existing session
    lap agents                      list agents on the platform ([tui] = compatible)
    lap login                       set base URL + master key (one-time)
    lap config                      show current config
    lap logout                      delete config

  \x1b[2mEXAMPLE\x1b[0m
    lap                             # first run — banner, login, pick
    lap refactor-bot                # fast path once you know the name
    lap --resume 8114556d-eaa5-…    # reattach after a disconnect

  Config:  ${CONFIG}
`);
}

async function agentsCmd() {
  const cfg = loadConfig();
  if (!cfg) { console.error("  (no config — run `lap login`)"); process.exit(1); }
  const r = await fetch(`${cfg.base}/api/v1/managed_agents/agents`, {
    headers: { "authorization": `Bearer ${cfg.key}` },
  });
  if (!r.ok) { console.error(`  ✗ ${r.status} ${r.statusText}`); process.exit(1); }
  const { data } = await r.json();
  for (const a of data) {
    const name = (a.name ?? "<unnamed>").padEnd(28);
    const harness = (a.harness_id ?? "?").padEnd(20);
    const tag = isTuiAgent(a) ? ansi.cyan("[tui]") : ansi.dim("     ");
    console.log(`  ${name} \x1b[2m${harness}\x1b[0m ${tag} \x1b[2m${a.id.slice(0,8)}\x1b[0m`);
  }
}

// `lap` with no args: banner → ensure login → pick a TUI-compatible agent
// → hand off to openAgent. The picker filters to `supports_tui` because the
// CLI can only attach to PTY-exposing harnesses; non-TUI agents would just
// fail at WS-connect time with a confusing message.
async function wizard() {
  renderBanner();
  let cfg = loadConfig();
  if (!cfg) {
    process.stdout.write(`  ${ansi.yellow("No agent platform configured — let's set one up.")}\n\n`);
    cfg = await login({ banner: false });
  }
  process.stdout.write(`  ${ansi.dim("→ fetching agents…")}\n`);
  let agents;
  try {
    const r = await fetch(`${cfg.base}/api/v1/managed_agents/agents`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    ({ data: agents } = await r.json());
  } catch (e) {
    console.error(`  ${ansi.red(`✗ agent list failed: ${e.message}`)}`);
    process.exit(1);
  }
  const tui = agents.filter(isTuiAgent);
  if (tui.length === 0) {
    console.error(`  ${ansi.red("✗ no TUI-compatible agents on this platform.")}`);
    console.error(`  ${ansi.dim(`TUI requires harness ${[...CLIENT_TUI_HARNESSES].join(" or ")} — visit ${cfg.base}/agents to create one.`)}`);
    process.exit(1);
  }
  // Reposition above the "fetching agents…" line so the picker draws cleanly.
  readline.moveCursor(process.stdout, 0, -1);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(`  ${ansi.bold("Pick an agent")}  ${ansi.dim("↑/↓ to move, Enter to open, q to cancel")}\n\n`);
  const picked = await pickFromList(tui, (a) => {
    const name = (a.name ?? "<unnamed>").padEnd(28);
    return `${name} ${ansi.dim(`${a.harness_id ?? "?"}  ${a.id.slice(0, 8)}`)}`;
  });
  if (!picked) { console.log(`  ${ansi.dim("cancelled.")}`); process.exit(0); }
  process.stdout.write("\n");
  await openAgent([picked.name]);
}

async function main() {
  const [, , ...args] = process.argv;
  // `--resume` is checked before the subcommand switch so it works whether
  // the user writes `lap --resume <id>` or `lap resume <id>`.
  const resumeFlag = args.indexOf("--resume");
  if (resumeFlag >= 0) return resumeSession(args[resumeFlag + 1]);
  const cmd = args[0];
  // Subcommands are reserved keywords. Anything else is treated as an agent
  // name shorthand for `lap --agent <name>`.
  switch (cmd) {
    case undefined: await wizard(); break;
    case "-h":
    case "--help":
    case "help":   help(); break;
    case "login":  await login(); break;
    case "agents": await agentsCmd(); break;
    case "resume": await resumeSession(args[1]); break;
    case "config": {
      const c = loadConfig();
      if (!c) console.log("  (no config — run `lap login`)");
      else console.log(JSON.stringify({ ...c, key: c.key.slice(0,4) + "…" + c.key.slice(-4) }, null, 2));
      break;
    }
    case "logout": try { fs.rmSync(CONFIG, { force: true }); console.log("  logged out"); } catch {} break;
    default: await openAgent(args);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
