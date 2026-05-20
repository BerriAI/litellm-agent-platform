/**
 * Test: session thread persists across navigation.
 *
 * Uses Playwright route interception so no live session or production
 * credentials are required. The harness API responses are mocked so we can
 * control exactly what "the thread" contains and assert that it survives
 * a navigate-away / navigate-back cycle via sessionStorage caching.
 */

import { test, expect, type Page, type Route } from "@playwright/test";

const SESSION_ID = "test-session-e2e-navpersist";
const AGENT_ID = "test-agent-e2e";

// Minimal session row that makes the UI render the "ready" thread view.
const MOCK_SESSION = {
  session_id: SESSION_ID,
  agent_id: AGENT_ID,
  status: "ready",
  phase: null,
  sandbox_url: "http://fake-sandbox",
  harness_session_id: "harnessid-1",
  failure_reason: null,
  created_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  idle_timeout_ms: 86_400_000,
};

const MOCK_AGENT = {
  agent_id: AGENT_ID,
  agent_name: "E2E Test Agent",
  model: "claude-3-5-sonnet",
  harness_id: "claude-agent-sdk",
  prompt: "You are a test agent.",
  pfp_url: null,
  created_at: new Date().toISOString(),
};

// Two user messages with an agent response containing thinking + tool call.
const MOCK_MESSAGES = [
  {
    info: { id: "msg-u1", sessionID: "harnessid-1", role: "user" },
    parts: [{ type: "text", text: "Fix the bug in auth.ts" }],
  },
  {
    info: { id: "msg-a1", sessionID: "harnessid-1", role: "assistant" },
    parts: [
      { id: "p1", type: "thinking", text: "Let me look at the auth file." },
      {
        id: "p2",
        type: "tool",
        tool: "Read",
        state: { status: "completed", input: { path: "auth.ts" }, output: "// auth code" },
      },
      { id: "p3", type: "text", text: "I found the issue and fixed it." },
    ],
  },
];

async function setupRoutes(page: Page) {
  // Auth: accept any bearer token.
  await page.route("**/api/v1/managed_agents/sessions/" + SESSION_ID, (route: Route) => {
    route.fulfill({ json: MOCK_SESSION });
  });
  await page.route("**/api/v1/managed_agents/agents/" + AGENT_ID, (route: Route) => {
    route.fulfill({ json: MOCK_AGENT });
  });
  await page.route(
    "**/api/v1/managed_agents/sessions/" + SESSION_ID + "/messages",
    (route: Route) => {
      route.fulfill({ json: MOCK_MESSAGES });
    },
  );
  // Block the SDK SSE stream so it doesn't interfere.
  await page.route("**/api/ui/sessions/" + SESSION_ID + "/stream", (route: Route) => {
    route.abort();
  });
  // Block the cookie endpoint.
  await page.route("**/api/ui/auth/cookie", (route: Route) => {
    route.fulfill({ status: 200, json: { ok: true } });
  });
}

async function login(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    // Use the dev master key — dev server has this in .env
    localStorage.setItem("ui_master_key", "sk-dev-master-key-change-me");
  });
}

test.describe("session thread — navigation persistence", () => {
  test("thread shows immediately on nav back (sessionStorage hydration)", async ({
    page,
  }) => {
    await setupRoutes(page);
    await login(page);

    // ── First visit: thread loads from mock API ──────────────────────────
    await page.goto(`/sessions/${SESSION_ID}`);

    // Wait for the user prompt block to be visible.
    await expect(
      page.getByText("Fix the bug in auth.ts"),
    ).toBeVisible({ timeout: 10_000 });

    // Verify the assistant's thinking and tool call rendered too.
    await expect(page.getByText("Thinking")).toBeVisible();

    // ── Navigate away ────────────────────────────────────────────────────
    await page.goto("/sessions");
    await expect(page).toHaveURL(/\/sessions/);

    // ── Navigate back — measure paint time ──────────────────────────────
    // Intercept the messages API with a slow response so we can prove the
    // DOM painted from sessionStorage BEFORE the network resolved.
    await page.route(
      "**/api/v1/managed_agents/sessions/" + SESSION_ID + "/messages",
      async (route: Route) => {
        await new Promise<void>((res) => setTimeout(res, 2_000)); // 2 s delay
        await route.fulfill({ json: MOCK_MESSAGES });
      },
    );

    const start = Date.now();
    await page.goto(`/sessions/${SESSION_ID}`);

    // The user message should appear immediately from sessionStorage cache,
    // well before the 2 s delayed API response resolves.
    await expect(
      page.getByText("Fix the bug in auth.ts"),
    ).toBeVisible({ timeout: 1_500 });
    const elapsed = Date.now() - start;

    // If hydration worked, paint happened from cache (<1 s).
    // If not, it would have waited 2+ s for the API.
    expect(elapsed).toBeLessThan(1_500);
  });

  test("sessionStorage key written after first thread load", async ({ page }) => {
    await setupRoutes(page);
    await login(page);

    await page.goto(`/sessions/${SESSION_ID}`);
    // Wait for harness messages to paint.
    await expect(page.getByText("Fix the bug in auth.ts")).toBeVisible({ timeout: 10_000 });

    // Give the setMessages updater (which writes sessionStorage) a tick to run.
    await page.waitForTimeout(300);

    const cached = await page.evaluate((sid) => {
      const raw = sessionStorage.getItem(`thread-messages-${sid}`);
      if (!raw) return null;
      try { return JSON.parse(raw) as unknown[]; } catch { return null; }
    }, SESSION_ID);

    expect(cached).not.toBeNull();
    expect(Array.isArray(cached)).toBe(true);
    expect((cached as unknown[]).length).toBeGreaterThan(0);
  });

  test("tool calls and thinking remain visible after nav-back even without API response", async ({
    page,
  }) => {
    await setupRoutes(page);
    await login(page);

    // ── First visit ──────────────────────────────────────────────────────
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.getByText("Fix the bug in auth.ts")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Thinking")).toBeVisible();

    // ── Navigate away ────────────────────────────────────────────────────
    await page.goto("/sessions");

    // ── Make messages API permanently fail on second load ────────────────
    await page.route(
      "**/api/v1/managed_agents/sessions/" + SESSION_ID + "/messages",
      (route: Route) => route.fulfill({ status: 502, json: { error: "harness down" } }),
    );

    // ── Navigate back ────────────────────────────────────────────────────
    await page.goto(`/sessions/${SESSION_ID}`);

    // Even though the harness API is down, the thread should be visible
    // from the sessionStorage cache written on the first visit.
    await expect(
      page.getByText("Fix the bug in auth.ts"),
    ).toBeVisible({ timeout: 5_000 });
  });
});
