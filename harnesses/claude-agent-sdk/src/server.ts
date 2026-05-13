/**
 * Claude Agent SDK harness — peer of opencode.
 *
 *   POST /session                          create session, returns {id}
 *   POST /session/:id/message              run an agent turn (blocking)
 *   POST /session/:id/prompt_async         queue a turn for streaming
 *   GET  /session/:id/message              list session history
 *   POST /session/:id/abort                cancel in-flight run
 *   GET  /event                            SSE stream of SessionEvents
 *
 * The /event SSE emits the platform's canonical `SessionEvent` JSON
 * directly — translation happens once, inside this harness, via
 * `ClaudeSdkTranslator`. The platform persister consumes these without
 * further translation.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionEvent } from "@lap/harness-shared/session-event";

import { buildMemoryMcpServer } from "./memory-tools.js";
import { runTurn, type PlatformMessage, type RunTurnSession } from "./runner.js";

// SDK's auto-resolution of the Claude Code native binary fails when
// `process.cwd()` differs from the SDK's install location (we run with
// cwd=/work/repo). Resolve the sibling platform package's `claude` binary
// off the SDK's own module path and pin it via options.pathToClaudeCodeExecutable.
function resolveClaudeBinary(): string | undefined {
  const req = createRequire(import.meta.url);
  let sdkPath: string;
  try {
    sdkPath = req.resolve("@anthropic-ai/claude-agent-sdk");
  } catch {
    return undefined;
  }
  const platformDir = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidate = join(
    dirname(sdkPath),
    "..",
    platformDir,
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  return existsSync(candidate) ? candidate : undefined;
}
const CLAUDE_BIN = resolveClaudeBinary();

const MEMORY_MCP = buildMemoryMcpServer();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "4096", 10);
const REPO_DIR = process.env.REPO_DIR ?? "/work/repo";
const DEFAULT_MODEL =
  process.env.LITELLM_DEFAULT_MODEL ?? "claude-haiku-4-5";
const SYSTEM_PROMPT = process.env.AGENT_PROMPT ?? "";

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

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface Session extends RunTurnSession {
  busSubscribers: Set<(e: SessionEvent) => void>;
  pending_prompt: string | null;
  pending_kick: (() => void) | null;
}

const sessions = new Map<string, Session>();
const globalBusSubscribers = new Set<(e: SessionEvent) => void>();

function getSession(id: string): Session | null {
  return sessions.get(id) ?? null;
}

function emitToSubscribers(s: Session, event: SessionEvent): void {
  for (const cb of s.busSubscribers) cb(event);
  for (const cb of globalBusSubscribers) cb(event);
}

const RUNNER_CFG = {
  repoDir: REPO_DIR,
  systemPrompt: SYSTEM_PROMPT,
  claudeBin: CLAUDE_BIN,
  memoryMcp: MEMORY_MCP,
};

function runTurnForSession(
  s: Session,
  userText: string,
  modelId: string,
): Promise<PlatformMessage> {
  return runTurn(s, userText, modelId, RUNNER_CFG, (event) =>
    emitToSubscribers(s, event),
  );
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const app = new Hono();

app.get("/", (c) =>
  c.json({ harness: "claude-agent-sdk", version: "0.2.0", port: PORT }),
);

app.post("/session", async (c) => {
  let title: string | undefined;
  let prompt: string | undefined;
  try {
    const body = (await c.req.json()) as { title?: string; prompt?: string };
    title = body?.title;
    prompt = body?.prompt;
  } catch {
    // empty body is fine — opencode accepts that too.
  }
  const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  sessions.set(id, {
    id,
    system_prompt: prompt ?? "",
    sdk_session_id: null,
    abortController: null,
    history: [],
    busSubscribers: new Set(),
    pending_prompt: null,
    pending_kick: null,
  });
  return c.json({ id, title: title ?? null });
});

app.get("/session/:id/message", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json(s.history);
});

interface MessageBody {
  model?: { providerID: string; modelID: string };
  parts?: Array<{ type?: string; text?: string }>;
}

function extractTurnInputs(body: MessageBody): { text: string; modelId: string } {
  const text = (body.parts ?? [])
    .filter((p) => p?.type === "text")
    .map((p) => p?.text ?? "")
    .join("\n");
  return { text, modelId: body.model?.modelID ?? DEFAULT_MODEL };
}

app.post("/session/:id/message", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const { text, modelId } = extractTurnInputs(await c.req.json());
  const result = await runTurnForSession(s, text, modelId);
  return c.json(result);
});

app.post("/session/:id/prompt_async", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const { text, modelId } = extractTurnInputs(await c.req.json());
  void runTurnForSession(s, text, modelId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emitToSubscribers(s, { type: "error", message: msg });
  });
  c.status(204);
  return c.body(null);
});

app.post("/session/:id/abort", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  if (s.abortController) {
    s.abortController.abort();
    emitToSubscribers(s, {
      type: "status",
      status: "ready",
      detail: "aborted",
    });
  }
  return c.json({ ok: true });
});

/**
 * SSE stream of `SessionEvent` JSON — one event per `data:` frame. No
 * envelope, no translation step downstream: this IS the canonical shape.
 */
app.get("/event", (c) =>
  streamSSE(c, async (stream) => {
    const cb = (event: SessionEvent): void => {
      void stream.writeSSE({ data: JSON.stringify(event) });
    };
    globalBusSubscribers.add(cb);
    try {
      while (!stream.aborted) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    } finally {
      globalBusSubscribers.delete(cb);
    }
  }),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(
    `claude-agent-sdk harness listening on http://0.0.0.0:${info.port}`,
  );
  console.log(`  cwd=${REPO_DIR} model=${DEFAULT_MODEL}`);
  console.log(
    `  base=${process.env.ANTHROPIC_BASE_URL ?? "<sdk default>"}`,
  );
});
