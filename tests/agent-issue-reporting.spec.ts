/**
 * E2E tests: agent issue reporting via report_issue MCP tool.
 *
 * Tests against the live deployment. Requires MASTER_KEY and BASE_URL env vars.
 *
 * Assertions:
 * 1. report_issue tool is present in agent's toolset (inline harness).
 * 2. Agent can call report_issue and the issue appears in the DB (GET /issues).
 * 3. Calling report_issue again with the same title increments times_seen (dedup).
 * 4. Issue detail includes session_id backlink.
 * 5. Issue can be resolved via PATCH.
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const MASTER_KEY = process.env.MASTER_KEY ?? "sk-dev-master-key-change-me";
// opencode-inline-final (PROD) — has report_issue wired in
const AGENT_ID = process.env.ISSUE_TEST_AGENT_ID ?? "9cbb91a6-e66d-43c5-92ed-68a570429527";

const TURN_TIMEOUT_MS = 90_000;

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_KEY}` },
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

async function apiPatch(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function sendMessage(sessionId: string, text: string): Promise<string> {
  const data = await apiPost(`sessions/${sessionId}/message`, { text });
  const parts = (data as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
  return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

async function waitForReady(sessionId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await apiGet(`sessions/${sessionId}`);
    if (s.status === "ready") return;
    if (s.status === "failed") throw new Error(`session failed: ${s.failure_reason}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`session ${sessionId} never became ready within ${timeoutMs}ms`);
}

const UNIQUE_TITLE = `e2e-issue-${Date.now()}`;

test.describe("agent issue reporting", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await apiPost(`agents/${AGENT_ID}/session`, { title: "e2e issue reporting" });
    sessionId = session.id as string;
    if (!sessionId) throw new Error("session create returned no id");
    await waitForReady(sessionId);
  });

  test("1. report_issue tool is available", async () => {
    const reply = await sendMessage(
      sessionId,
      'Reply ONLY with JSON: {"has_report_issue": true/false}. Check actual available tools.',
    );
    const match = reply.match(/\{[^}]+\}/s);
    expect(match, "agent should return JSON").not.toBeNull();
    const flags = JSON.parse(match![0]) as Record<string, boolean>;
    expect(flags.has_report_issue).toBe(true);
  }, TURN_TIMEOUT_MS);

  test("2. agent calls report_issue and issue appears in DB", async () => {
    const reply = await sendMessage(
      sessionId,
      `Call report_issue with title="${UNIQUE_TITLE}", body="e2e test issue", severity="info", session_id="${sessionId}". Report what happened.`,
    );
    expect(reply.toLowerCase()).toMatch(/reported|filed|created|issue/i);

    // Verify issue landed in DB
    const issues = await fetch(
      `${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues?status=open`,
      { headers: { Authorization: `Bearer ${MASTER_KEY}` } },
    ).then((r) => r.json()) as Array<Record<string, unknown>>;

    const created = issues.find((i) => i.title === UNIQUE_TITLE);
    expect(created, `issue "${UNIQUE_TITLE}" should exist`).toBeDefined();
    expect(created!.status).toBe("open");
    expect(created!.severity).toBe("info");
    expect(created!.times_seen).toBe(1);
    expect(created!.session_id).toBe(sessionId);
  }, TURN_TIMEOUT_MS);

  test("3. same title increments times_seen (dedup)", async () => {
    // File the same issue again directly via API (simulating a second session)
    await fetch(`${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ title: UNIQUE_TITLE, body: "second occurrence", severity: "info", session_id: sessionId }),
    });

    const issues = await fetch(
      `${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues?status=open`,
      { headers: { Authorization: `Bearer ${MASTER_KEY}` } },
    ).then((r) => r.json()) as Array<Record<string, unknown>>;

    const deduped = issues.find((i) => i.title === UNIQUE_TITLE);
    expect(deduped, "deduped issue should still exist as one row").toBeDefined();
    expect(deduped!.times_seen).toBe(2);

    // Comments should have one entry (the second occurrence)
    const comments = (deduped!.comments as unknown[]) ?? [];
    expect(comments.length).toBeGreaterThanOrEqual(1);
  }, TURN_TIMEOUT_MS);

  test("4. issue detail includes session_id backlink", async () => {
    const issues = await fetch(
      `${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues?status=open`,
      { headers: { Authorization: `Bearer ${MASTER_KEY}` } },
    ).then((r) => r.json()) as Array<Record<string, unknown>>;

    const issue = issues.find((i) => i.title === UNIQUE_TITLE);
    expect(issue).toBeDefined();

    const detail = await fetch(
      `${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues/${issue!.id}`,
      { headers: { Authorization: `Bearer ${MASTER_KEY}` } },
    ).then((r) => r.json()) as Record<string, unknown>;

    expect(detail.session_id).toBe(sessionId);
    expect(detail.title).toBe(UNIQUE_TITLE);
    expect(Array.isArray(detail.comments)).toBe(true);
  }, TURN_TIMEOUT_MS);

  test("5. issue can be resolved via PATCH", async () => {
    const issues = await fetch(
      `${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues?status=open`,
      { headers: { Authorization: `Bearer ${MASTER_KEY}` } },
    ).then((r) => r.json()) as Array<Record<string, unknown>>;

    const issue = issues.find((i) => i.title === UNIQUE_TITLE);
    expect(issue).toBeDefined();

    const updated = await apiPatch(
      `agents/${AGENT_ID}/issues/${issue!.id}`,
      { status: "resolved" },
    );
    expect(updated.status).toBe("resolved");

    // Should no longer appear in open filter
    const openIssues = await fetch(
      `${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues?status=open`,
      { headers: { Authorization: `Bearer ${MASTER_KEY}` } },
    ).then((r) => r.json()) as Array<Record<string, unknown>>;

    expect(openIssues.find((i) => i.title === UNIQUE_TITLE)).toBeUndefined();
  }, TURN_TIMEOUT_MS);
});
