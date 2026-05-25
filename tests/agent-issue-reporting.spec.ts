/**
 * E2E: agent issue reporting — behavioral tests.
 *
 * The agent is NOT told to call report_issue. It should do so implicitly when
 * it can't complete a task. If it doesn't, we need to fix the system prompt.
 *
 * Run locally:
 *   BASE_URL=http://localhost:3000 MASTER_KEY=sk-dev-master-key-change-me \
 *     npx playwright test tests/agent-issue-reporting.spec.ts --headed
 */

import { test, expect, chromium } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const MASTER_KEY = process.env.MASTER_KEY ?? "sk-dev-master-key-change-me";
const AGENT_ID = process.env.ISSUE_TEST_AGENT_ID ?? "9cbb91a6-e66d-43c5-92ed-68a570429527";

const TURN_TIMEOUT_MS = 90_000;
const JIRA_PROMPT = "List my open Jira tickets.";

// Shared across tests — set by test 2, read by tests 3-6.
let jiraIssueTitle: string;
let firstSessionId: string;

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
  throw new Error(`session never became ready within ${timeoutMs}ms`);
}

async function spawnAndWait(title: string): Promise<string> {
  const session = await apiPost(`agents/${AGENT_ID}/session`, { title });
  const sid = session.id as string;
  if (!sid) throw new Error("session create returned no id");
  await waitForReady(sid);
  return sid;
}

async function openSessionInBrowser(sessionId: string) {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("input", MASTER_KEY);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  await page.goto(`${BASE_URL}/sessions/${sessionId}`, { waitUntil: "domcontentloaded", timeout: 15000 });
  return { browser, page };
}

function getOpenIssues(): Promise<Array<Record<string, unknown>>> {
  return fetch(`${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues?status=open`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  }).then((r) => r.json()) as Promise<Array<Record<string, unknown>>>;
}

test.describe.serial("agent issue reporting — implicit behavior", () => {
  test("1. report_issue tool is present in agent toolset", async () => {
    const sid = await spawnAndWait("e2e-tool-check");
    firstSessionId = sid;
    const reply = await sendMessage(sid, 'Reply ONLY with JSON: {"has_report_issue": true/false}. Check if any tool containing "report_issue" or "issue" is in your actual available tools. Include lap-issue-reporter_report_issue if present.');
    const match = reply.match(/\{[^}]+\}/s);
    expect(match, "agent should return JSON").not.toBeNull();
    const flags = JSON.parse(match![0]) as Record<string, boolean>;
    expect(flags.has_report_issue, "report_issue should be in toolset (as lap-issue-reporter_report_issue)").toBe(true);
  }, TURN_TIMEOUT_MS);

  test("2. agent implicitly files issue when Jira MCP unavailable", async () => {
    // Fresh session — don't reuse the tool-check session (JSON mode bleeds over).
    firstSessionId = await spawnAndWait("e2e-jira-implicit");
    const { browser, page } = await openSessionInBrowser(firstSessionId);
    console.log(`\nObserve session: ${BASE_URL}/sessions/${firstSessionId}\n`);

    await sendMessage(firstSessionId, JIRA_PROMPT);

    // Watch in browser for 30s
    await page.waitForTimeout(30_000);
    await browser.close();

    // Verify the agent called report_issue via session messages (tool call proof).
    // Don't rely on a new DB row — dedup may have incremented an existing issue.
    const msgs = await apiGet(`sessions/${firstSessionId}/messages`);
    const parts = (msgs as Record<string, unknown[]>).data ?? (Array.isArray(msgs) ? msgs : []);
    const toolCalled = parts.some((m: unknown) => {
      const msg = m as Record<string, unknown>;
      const ps = (msg.parts as Array<Record<string, unknown>>) ?? [];
      return ps.some((p) => p.type === "tool" && String(p.tool ?? "").includes("report_issue"));
    });
    expect(toolCalled, "agent should have called report_issue when Jira MCP unavailable").toBe(true);

    // Find the Jira issue (may be a deduped existing row — no recency filter needed)
    const issues = await getOpenIssues();
    const filed = issues.find((i) => String(i.title).toLowerCase().includes("jira"));
    expect(filed, "a Jira-related issue should exist").toBeDefined();
    jiraIssueTitle = filed!.title as string;
    console.log(`Agent filed issue: "${jiraIssueTitle}"`);
  }, TURN_TIMEOUT_MS + 30_000);

  let baseTimesSeen = 0;

  test("3. same title via API increments times_seen by 1", async () => {
    // Record current count before posting — prior test runs may have accumulated occurrences.
    const before = await getOpenIssues();
    const beforeRow = before.find((i) => i.title === jiraIssueTitle);
    baseTimesSeen = (beforeRow?.times_seen as number) ?? 1;

    await fetch(`${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ title: jiraIssueTitle, body: "second occurrence via API", severity: "info", session_id: firstSessionId }),
    });

    const issues = await getOpenIssues();
    const deduped = issues.find((i) => i.title === jiraIssueTitle);
    expect(deduped, "should still be one row").toBeDefined();
    expect(deduped!.times_seen).toBe(baseTimesSeen + 1);
    const comments = (deduped!.comments as unknown[]) ?? [];
    expect(comments.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test("4. same title again → times_seen increments again", async () => {
    await fetch(`${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ title: jiraIssueTitle, body: "third occurrence via API", severity: "info", session_id: firstSessionId }),
    });

    const issues = await getOpenIssues();
    const deduped = issues.find((i) => i.title === jiraIssueTitle);
    expect(deduped!.times_seen).toBe(baseTimesSeen + 2);
    const comments = (deduped!.comments as unknown[]) ?? [];
    expect(comments.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  test("5. UI shows ×3 badge and detail page", async () => {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    // Set localStorage auth directly — more reliable than form submit across environments
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.evaluate((key) => localStorage.setItem("ui_master_key", key), MASTER_KEY);

    // Issues list — networkidle ensures the API fetch completes before asserting
    await page.goto(`${BASE_URL}/agents/${AGENT_ID}/issues`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1000);
    // Find the row for this specific issue and check it has an occurrence badge (×N, N ≥ 2)
    const issueRow = page.locator(`tr:has-text("${jiraIssueTitle}")`).first();
    const expectedBadge = `×${baseTimesSeen + 2}`;
    await expect(issueRow.locator(`text=${expectedBadge}`)).toBeVisible();

    // Click into detail
    await issueRow.click();
    await page.waitForTimeout(1500);
    await expect(page.locator("p:has-text('Occurrences')").first()).toBeVisible();

    await page.waitForTimeout(5000); // leave open for observation
    await browser.close();
  }, 60_000);

  test("6. resolve removes from open list", async () => {
    const issues = await getOpenIssues();
    const issue = issues.find((i) => i.title === jiraIssueTitle);
    expect(issue).toBeDefined();

    await fetch(`${BASE_URL}/api/v1/managed_agents/agents/${AGENT_ID}/issues/${issue!.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ status: "resolved" }),
    });

    const openAfter = await getOpenIssues();
    expect(openAfter.find((i) => i.title === jiraIssueTitle)).toBeUndefined();
  }, 30_000);
});
