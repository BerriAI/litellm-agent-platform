/**
 * E2E: agent task checkpointing — behavioral tests.
 *
 * The agent should use save_task_progress, list_blocked_tasks, and
 * get_blocked_task when working on tasks. These tests verify the tools are
 * present, the routes work, and the checkpoint state persists correctly.
 *
 * Run locally:
 *   BASE_URL=http://localhost:3000 MASTER_KEY=sk-dev-master-key-change-me \
 *     npx playwright test tests/agent-task-checkpoint.spec.ts --headed
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const MASTER_KEY = process.env.MASTER_KEY ?? "sk-dev-master-key-change-me";
const AGENT_ID =
  process.env.CHECKPOINT_TEST_AGENT_ID ?? "9cbb91a6-e66d-43c5-92ed-68a570429527";

const TURN_TIMEOUT_MS = 90_000;
const LONG_TURN_TIMEOUT_MS = 600_000;

// Shared across tests — set in beforeAll, read by individual tests.
let sessionId: string;
// Set in test 5, read in the new-session assertion.
let secondSessionId: string;

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

async function sendMessage(sid: string, text: string): Promise<string> {
  const data = await apiPost(`sessions/${sid}/message`, { text });
  const parts = (data as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

async function waitForReady(sid: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await apiGet(`sessions/${sid}`);
    if (s.status === "ready") return;
    if (s.status === "failed") throw new Error(`session failed: ${s.failure_reason}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`session never became ready within ${timeoutMs}ms`);
}

async function spawnAndWait(title: string): Promise<string> {
  const session = await apiPost(`agents/${AGENT_ID}/session`, { title });
  const sid = session.id as string;
  if (!sid) throw new Error("session create returned no id");
  await waitForReady(sid);
  return sid;
}

/**
 * Extract tool call parts from the session's message thread for a given tool
 * name substring. Checks all messages' parts arrays for type=tool entries.
 */
async function getToolCalls(
  sid: string,
  toolName: string,
): Promise<Array<Record<string, unknown>>> {
  const msgs = await apiGet(`sessions/${sid}/messages`);
  const messages: unknown[] =
    (msgs as Record<string, unknown[]>).data ?? (Array.isArray(msgs) ? (msgs as unknown[]) : []);

  const results: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    const msg = m as Record<string, unknown>;
    const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
    for (const p of parts) {
      if (p.type === "tool" && String(p.tool ?? p.name ?? "").includes(toolName)) {
        results.push(p);
      }
    }
  }
  return results;
}

test.describe.serial("agent task checkpointing — implicit behavior", () => {
  test.beforeAll(async () => {
    sessionId = await spawnAndWait("e2e-checkpoint-main");
    console.log(`\nMain session: ${BASE_URL}/sessions/${sessionId}\n`);
  });

  test("1. task checkpoint tools are present", async () => {
    const reply = await sendMessage(
      sessionId,
      'Reply ONLY with JSON (no markdown): {"has_save_task_progress": true/false, "has_list_blocked_tasks": true/false, "has_get_blocked_task": true/false}. Check your actual available tools and set each flag to true if ANY tool whose name contains that string is present.',
    );

    const match = reply.match(/\{[^}]+\}/s);
    expect(match, "agent should return JSON").not.toBeNull();
    const flags = JSON.parse(match![0]) as Record<string, boolean>;
    expect(
      flags.has_save_task_progress,
      "save_task_progress should be in toolset",
    ).toBe(true);
    expect(
      flags.has_list_blocked_tasks,
      "list_blocked_tasks should be in toolset",
    ).toBe(true);
    expect(
      flags.has_get_blocked_task,
      "get_blocked_task should be in toolset",
    ).toBe(true);
  }, TURN_TIMEOUT_MS);

  test("2. list_blocked_tasks returns empty or list at session start", async () => {
    const reply = await sendMessage(
      sessionId,
      "Call list_blocked_tasks and reply with the raw result. Do not summarize — include the exact JSON or message returned by the tool.",
    );

    // The tool should return either an empty array or a JSON array of blocked tasks.
    // "No blocked tasks" is an acceptable human-readable form the agent may emit.
    const looksLikeEmptyArray = /\[\s*\]/.test(reply);
    const looksLikeArray = /\[.*\]/s.test(reply);
    const looksLikeNoneMessage =
      /no blocked tasks/i.test(reply) || /empty/i.test(reply) || /none/i.test(reply);

    expect(
      looksLikeEmptyArray || looksLikeArray || looksLikeNoneMessage,
      `list_blocked_tasks should return an array or empty message; got: ${reply.slice(0, 200)}`,
    ).toBe(true);
  }, TURN_TIMEOUT_MS);

  test("3. agent checkpoints when picking a GitHub issue", async () => {
    // Ask the agent to pick a real litellm bug, analyze it, then stop before editing.
    // After the turn we verify a save_task_progress tool call was made.
    const reply = await sendMessage(
      sessionId,
      'Go to https://github.com/BerriAI/litellm/issues and pick one open bug issue. Read its body, analyze the root cause, then STOP before making any code edits. Call save_task_progress with status="in_progress" and a summary of what you found. Finally reply with exactly: ANALYZED: <issue title> — <root cause in one sentence>',
    );

    expect(
      reply.toLowerCase().includes("analyzed:"),
      `agent should reply with ANALYZED: prefix; got: ${reply.slice(0, 300)}`,
    ).toBe(true);

    // Check that save_task_progress was called at least once.
    const calls = await getToolCalls(sessionId, "save_task_progress");
    expect(
      calls.length,
      "agent should have called save_task_progress at least once",
    ).toBeGreaterThanOrEqual(1);
  }, LONG_TURN_TIMEOUT_MS);

  test("4. session row has task_checkpoint populated", async () => {
    // Fetch task_checkpoint directly from the dedicated endpoint.
    const checkpoint = await apiGet(`sessions/${sessionId}/task_checkpoint`);

    expect(checkpoint, "task_checkpoint should not be null").not.toBeNull();

    const status = checkpoint?.status as string | undefined;
    expect(
      status === "in_progress" || status === "blocked" || status === "complete",
      `task_checkpoint.status should be a valid status; got: ${status}`,
    ).toBe(true);

    const summary = checkpoint?.summary as string | undefined;
    expect(summary, "task_checkpoint.summary should be present").toBeTruthy();
    expect(
      (summary ?? "").length,
      "task_checkpoint.summary should be non-trivial (>20 chars)",
    ).toBeGreaterThan(20);
  }, 15_000);

  test("5. new session sees prior blocked task via list_blocked_tasks", async () => {
    // First: in the current session, explicitly save a blocked checkpoint so we
    // have a known row for the second session to discover.
    const blockedSummary = `e2e-test blocked task from session ${sessionId} at ${Date.now()}`;
    await sendMessage(
      sessionId,
      `Call save_task_progress with status="blocked", summary="${blockedSummary}", and blocked_reason="e2e test". Reply with OK when done.`,
    );

    // Verify the checkpoint is now blocked on the current session.
    const checkpoint = await apiGet(`sessions/${sessionId}/task_checkpoint`);
    expect(
      (checkpoint?.status as string | undefined) === "blocked",
      "first session task_checkpoint should be blocked",
    ).toBe(true);

    // Spawn a second session for the same agent.
    secondSessionId = await spawnAndWait("e2e-checkpoint-second");
    console.log(`\nSecond session: ${BASE_URL}/sessions/${secondSessionId}\n`);

    // Ask the second session to list blocked tasks and return the raw result.
    const reply = await sendMessage(
      secondSessionId,
      "Call list_blocked_tasks and reply with the raw result. Do not summarize — include the exact JSON or message returned by the tool.",
    );

    // The reply should contain either the blocked task summary or the session_id
    // of the first session, confirming the route is wired and the DB row is visible.
    const containsSummaryFragment = reply.includes(sessionId) || reply.includes("e2e-test blocked");
    const containsValidArray = /\[.*session_id/s.test(reply);
    expect(
      containsSummaryFragment || containsValidArray,
      `second session should see the blocked task from the first session; reply: ${reply.slice(0, 400)}`,
    ).toBe(true);
  }, TURN_TIMEOUT_MS * 3);
});
