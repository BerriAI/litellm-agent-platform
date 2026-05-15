#!/usr/bin/env node
// lap — LiteLLM Agent Platform CLI
//
// Usage:
//   lap <agent-name>                open the agent's TUI in a sandbox
//   lap --agent <name>              same as above (flag form)
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

async function login() {
  process.stdout.write("\n  \x1b[1mSet up the agent platform\x1b[0m\n");
  process.stdout.write("  \x1b[2mSaved to ~/.lap/config.json (chmod 0600)\x1b[0m\n\n");
  const base = (await ask("  Agent platform URL: ")).trim().replace(/\/+$/, "");
  const key  = (await ask("  Master key:         ", { hidden: true })).trim();
  if (!base || !key) { console.error("  \x1b[31maborted\x1b[0m"); process.exit(1); }
  saveConfig({ base, key });
  console.log(`  \x1b[32m✓ saved to ${CONFIG}\x1b[0m\n`);
  return { base, key };
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

  process.stdout.write("  \x1b[2mwaiting for sandbox\x1b[0m");
  let session = null;
  // Network blips shouldn't abort the poll, but server-side errors (401,
  // 4xx auth, 5xx outage) should surface fast. We tolerate up to two
  // consecutive failures and then bail with the upstream status so the
  // user isn't waiting out the full 60-iteration timeout to see a 401.
  let consecutiveFailures = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1500));
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
    process.stdout.write(".");
    if (session?.status === "ready") break;
    if (session?.status === "failed" || session?.status === "dead") {
      console.error(`\n  \x1b[31m✗ ${session.status}: ${session.failure_reason ?? ""}\x1b[0m`);
      process.exit(1);
    }
  }
  if (session?.status !== "ready") {
    console.error("\n  \x1b[31m✗ timed out waiting for ready\x1b[0m");
    process.exit(1);
  }
  process.stdout.write(" \x1b[32mready\x1b[0m\n");

  // Prefer session.tty_url when the platform provides it — that's a
  // platform-served route (e.g. /api/v1/managed_agents/sessions/<id>/tty
  // proxied by server-proxy.mjs) that's reachable over the same public
  // ingress as the rest of the API. Fall back to sandbox_url + /tty for
  // older platforms / local dev where the sandbox is directly reachable.
  let wsUrl;
  if (session.tty_url) {
    if (/^wss?:\/\//.test(session.tty_url)) {
      wsUrl = session.tty_url;
    } else if (/^https?:\/\//.test(session.tty_url)) {
      wsUrl = session.tty_url.replace(/^http/, "ws");
    } else {
      // Relative path — prepend the platform base URL, swap to ws/wss.
      const baseWs = cfg.base.replace(/^http/, "ws").replace(/\/+$/, "");
      const suffix = session.tty_url.startsWith("/") ? session.tty_url : `/${session.tty_url}`;
      wsUrl = baseWs + suffix;
    }
  } else if (session.sandbox_url && !session.sandbox_url.includes(".svc.cluster.local")) {
    wsUrl = session.sandbox_url.replace(/^http/, "ws").replace(/\/+$/, "") + "/tty";
  } else if (TTY_FALLBACK) {
    wsUrl = TTY_FALLBACK;
    console.log(`  \x1b[2m(sandbox_url is in-cluster — using LAP_TTY_FALLBACK)\x1b[0m`);
  } else {
    console.error(`  \x1b[31m✗ session.sandbox_url is in-cluster (${session.sandbox_url}) and the platform did not return a tty_url.\x1b[0m`);
    console.error(`  \x1b[2m  upgrade the platform, or set LAP_TTY_FALLBACK=ws://host:port/tty in your env\x1b[0m`);
    process.exit(1);
  }
  // The harness's verifyClient requires the bearer token; the platform
  // returns it via session.tty_token (preferred) or via LAP_TTY_TOKEN env.
  // We send it as a request header (not a query param) so the token doesn't
  // end up in ingress / proxy / load-balancer access logs that record the
  // request line. The harness accepts both forms; we use the header form
  // from Node where it's available.
  const ttyToken = session.tty_token || process.env.LAP_TTY_TOKEN || "";
  console.log(`  \x1b[2m→ attaching local TTY to ${wsUrl}\x1b[0m`);
  console.log("  \x1b[2m(press Ctrl-D to detach)\x1b[0m\n");

  await attachPty(wsUrl, ttyToken);
}

function attachPty(wsUrl, ttyToken) {
  return new Promise((resolve, reject) => {
    // Pass the bearer token via the Authorization header — keeps it out of
    // access logs that record the request line. Node's `ws` package
    // supports header injection on the upgrade handshake; the browser
    // WebSocket API does not, which is why the harness accepts ?token= too
    // for browser callers.
    const headers = ttyToken ? { authorization: `Bearer ${ttyToken}` } : undefined;
    const ws = new WebSocket(wsUrl, { headers });
    // Default binaryType ("nodebuffer") yields Buffer in the message event,
    // which process.stdout.write accepts directly. Setting "arraybuffer"
    // would crash on every binary PTY frame because stdout.write rejects
    // ArrayBuffer.

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

    ws.on("close", () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      console.log("\n  \x1b[2m[connection closed]\x1b[0m");
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
    lap <agent-name>                open the agent's TUI in a sandbox
    lap --agent <name>              same as above (flag form)
    lap agents                      list agents on the platform
    lap login                       set base URL + master key (one-time)
    lap config                      show current config
    lap logout                      delete config

  \x1b[2mEXAMPLE\x1b[0m
    lap login
    lap refactor-bot

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
    console.log(`  ${name} \x1b[2m${harness} ${a.id.slice(0,8)}\x1b[0m`);
  }
}

async function main() {
  const [, , ...args] = process.argv;
  const cmd = args[0];
  // Subcommands are reserved keywords. Anything else is treated as an agent
  // name shorthand for `lap --agent <name>`.
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
    case "help":   help(); break;
    case "login":  await login(); break;
    case "agents": await agentsCmd(); break;
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
