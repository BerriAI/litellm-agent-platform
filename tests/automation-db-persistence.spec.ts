/**
 * E2E regression test: automation run DB persistence for inline harness sessions.
 *
 * Regression: inline harness initial_prompt path called harnessSendMessage directly
 * without going through runInitialPrompt, so no messages, no response, and no history
 * were ever written to the DB. Automation runs stayed "running" forever and timed out.
 *
 * Fix: inline harness initial_prompt now calls runInitialPrompt, same as the K8s path.
 *
 * This test creates a session with initial_prompt on an opencode-brain-inline agent,
 * then asserts that after the agent replies:
 *   1. session.response is set (non-null) — triggers automation reconciler to mark succeeded
 *   2. session.history has entries — full thread is snapshotted for replay after sandbox reap
 *   3. managed_agent_session_message has at least one user row and one assistant row
 *
 * Run against the Render deployment:
 *   BASE_URL=https://litellm-agent-platform.onrender.com \
 *   MASTER_KEY=<key> \
 *   AUTOMATION_TEST_AGENT_ID=9cbb91a6-e66d-43c5-92ed-68a570429527 \
 *   npx playwright test tests/automation-db-persistence.spec.ts
 */

import { test, expect } from "@playwright/test";

const BASE_URL =
  process.env.BASE_URL ?? "https://litellm-agent-platform.onrender.com";
const MASTER_KEY =
  process.env.MASTER_KEY ??
  "5d6d52af44d3f3db3a87d66bc9fbf3ae9562b5b459cb65aea8bb973fdae72722";

// opencode-brain-inline agent: "opencode-inline-final (PROD)"
// This is exactly the agent used by the Shin automation.
const AGENT_ID =
  process.env.AUTOMATION_TEST_AGENT_ID ??
  "9cbb91a6-e66d-43c5-92ed-68a570429527";

// Generous — inline harness can take 2-5 min for a real turn.
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

async function apiPost(path: string, body: unknown): Promise<Record<string, unknown>> {
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

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function waitForReady(sessionId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await apiGet(`sessions/${sessionId}`);
    if (session.status === "ready") return;
    if (session.status === "failed") {
      throw new Error(`session failed: ${session.failure_reason}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`session ${sessionId} never became ready within ${timeoutMs}ms`);
}

/**
 * Poll until session.response is non-null, meaning runInitialPrompt completed
 * and wrote the response to the DB.
 */
async function waitForResponse(
  sessionId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await apiGet(`sessions/${sessionId}`);
    if (session.response !== null && session.response !== undefined) return session;
    if (session.failure_reason) {
      throw new Error(`initial_prompt failed: ${session.failure_reason}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `session ${sessionId} response never set within ${timeoutMs / 1000}s — ` +
      "DB persistence likely still broken",
  );
}

test.describe("automation run DB persistence — inline harness initial_prompt", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await apiPost(`agents/${AGENT_ID}/session`, {
      title: "[e2e] automation-db-persistence",
      initial_prompt:
        'Reply with exactly this text and nothing else: "AUTOMATION_DB_TEST_OK". Do not add any explanation.',
    });
    sessionId = session.id as string;
    if (!sessionId) throw new Error("session create returned no id");
    await waitForReady(sessionId, 30_000);
  }, 60_000);

  test("1. session.response is set after initial_prompt completes", async () => {
    // This is the field the automation reconciler checks to mark a run succeeded.
    // Before the fix it was always null — runs timed out after 1 hour.
    const session = await waitForResponse(sessionId, RESPONSE_TIMEOUT_MS);
    expect(
      session.response,
      "session.response must be non-null — runInitialPrompt must have completed and written to DB",
    ).not.toBeNull();
  }, RESPONSE_TIMEOUT_MS + 10_000);

  test("2. session.history has entries (thread snapshot persisted)", async () => {
    // runInitialPrompt calls snapshotThreadToHistory on completion.
    // Before the fix, history was never written — chat was empty after sandbox reap.
    const session = await apiGet(`sessions/${sessionId}`);
    const history = session.history as unknown[] | null;
    expect(Array.isArray(history) && history.length > 0, "session.history must be non-empty").toBe(
      true,
    );
  }, 30_000);

  test("3. messages table has user and assistant rows", async () => {
    // runInitialPrompt calls appendUserMessage and completeAssistantMessage.
    // Before the fix, managed_agent_session_message had 0 rows for inline sessions.
    const res = await fetch(
      `${BASE_URL}/api/v1/managed_agents/sessions/${sessionId}/messages`,
      { headers: { Authorization: `Bearer ${MASTER_KEY}` } },
    );
    expect(res.ok, `messages endpoint returned ${res.status}`).toBe(true);
    const messages = (await res.json()) as Array<{ role?: string }>;
    expect(Array.isArray(messages) && messages.length > 0, "messages array must be non-empty").toBe(
      true,
    );

    // Verify both sides of the conversation are stored.
    const roles = new Set(messages.map((m) => m.role).filter(Boolean));
    expect(roles.has("user"), "must have a stored user message").toBe(true);
    expect(roles.has("assistant"), "must have a stored assistant message").toBe(true);
  }, 30_000);

  test("4. assistant reply contains expected text", async () => {
    // Sanity-check the agent actually replied correctly and the content is readable.
    const session = await apiGet(`sessions/${sessionId}`);
    const response = session.response as Record<string, unknown> | null;
    expect(response, "response must be set").not.toBeNull();

    // response blob contains the assistant parts array
    const parts = (response?.parts ?? []) as Array<{ type?: string; text?: string }>;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join(" ");
    expect(text).toMatch(/AUTOMATION_DB_TEST_OK/i);
  }, 30_000);
});
