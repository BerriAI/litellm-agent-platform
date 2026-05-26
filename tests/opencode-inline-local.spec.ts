/**
 * E2E test: opencode-inline-harness local session smoke test.
 *
 * Runs against the local Next.js server (localhost:3003) with the opencode
 * inline harness running at localhost:4100. Spawns a session for agent
 * 9cbb91a6-e66d-43c5-92ed-68a570429527 (opencode-inline-final PROD) and
 * confirms the agent produces a non-empty text response.
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3003";
const MASTER_KEY = process.env.MASTER_KEY ?? "sk-dev-master-key-change-me";
const AGENT_ID = "9cbb91a6-e66d-43c5-92ed-68a570429527";

// Inline harness can take 30-60s per turn.
const TURN_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MASTER_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function apiGet(path: string) {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function waitForReady(sessionId: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await apiGet(`sessions/${sessionId}`);
    if (session.status === "ready") return;
    if (session.status === "failed") {
      throw new Error(`session failed: ${JSON.stringify(session.failure_reason)}`);
    }
    console.log(`  session ${sessionId} status=${session.status}, waiting...`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`session ${sessionId} never became ready within ${timeoutMs}ms`);
}

async function sendMessage(sessionId: string, text: string): Promise<string> {
  const data = await apiPost(`sessions/${sessionId}/message`, { text });
  const parts = (data as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

test.describe("opencode-inline harness — local smoke test", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    console.log(`Creating session for agent ${AGENT_ID} via ${BASE_URL}`);
    const session = await apiPost(`agents/${AGENT_ID}/session`, {
      title: "local-smoke-test",
    });
    sessionId = session.id as string;
    if (!sessionId) throw new Error("session create returned no id");
    console.log(`Session created: ${sessionId}`);
    await waitForReady(sessionId);
    console.log(`Session ready: ${sessionId}`);
  }, READY_TIMEOUT_MS + 10_000);

  test("1. session creates and reaches ready status", async () => {
    const session = await apiGet(`sessions/${sessionId}`);
    expect(session.status).toBe("ready");
    expect(session.harness_session_id).toBeDefined();
    console.log(`harness_session_id=${session.harness_session_id}`);
  });

  test("2. agent returns a non-empty text response", async () => {
    const reply = await sendMessage(
      sessionId,
      "Reply with exactly: hello from the opencode inline harness",
    );
    console.log(`Agent reply: ${reply.slice(0, 200)}`);
    expect(reply.trim().length).toBeGreaterThan(0);
    expect(reply.toLowerCase()).toMatch(/hello|opencode|harness/i);
  }, TURN_TIMEOUT_MS);
});
