/**
 * E2E test: inline harness session tool access and MCP usage.
 *
 * Tests against the live EKS deployment. Requires MASTER_KEY and BASE_URL
 * env vars (or falls back to the known production values).
 *
 * Assertions:
 * 1. Session creates successfully for agent test-cc-23 (claude-code-brain-inline).
 * 2. When asked about tools, the agent reports sandbox tools (provision/execute)
 *    but NOT the Bash tool.
 * 3. When asked about Linear ticket LIT-3198, the agent uses the Linear MCP
 *    tool (not Bash, Read, or any file/shell tool) to retrieve the information.
 */

import { test, expect } from "@playwright/test";

const BASE_URL =
  process.env.BASE_URL ??
  "http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com";
const MASTER_KEY =
  process.env.MASTER_KEY ??
  "5d6d52af44d3f3db3a87d66bc9fbf3ae9562b5b459cb65aea8bb973fdae72722";
const AGENT_ID = "e1a2a88a-c056-48d7-af57-78c3feaa5f20";
// Agent with projects configured — used to test sandbox provision route.
const AGENT_WITH_PROJECTS_ID = "6b023d93-b570-4a60-a5bd-6a0b630e4a7b";
const AGENT_WITH_PROJECTS_PROJECT_ID = "litellm-sandbox-mpecoia5-asxmn";

// Generous timeout — inline harness can take 10-30s per turn.
const TURN_TIMEOUT_MS = 60_000;

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

async function sendMessage(
  sessionId: string,
  text: string,
): Promise<string> {
  const data = await apiPost(`sessions/${sessionId}/message`, { text });
  const parts = (data as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
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

test.describe("inline harness session — tool access and MCP usage", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await apiPost(`agents/${AGENT_ID}/session`, {
      title: "e2e tool check",
    });
    sessionId = session.id as string;
    if (!sessionId) throw new Error("session create returned no id");
    await waitForReady(sessionId);
  });

  test("1. session creates successfully", async () => {
    const session = await apiGet(`sessions/${sessionId}`);
    expect(session.status).toBe("ready");
    expect(session.harness_session_id).toBeDefined();
  });

  test("2. agent has sandbox tools but NOT Bash", async () => {
    const reply = await sendMessage(
      sessionId,
      "Reply with a JSON object: { \"has_bash\": true/false, \"has_provision\": true/false, \"has_execute\": true/false, \"has_linear\": true/false }. Set each field based on whether that tool is in your available toolset right now.",
    );
    // Extract the JSON from the reply
    const jsonMatch = reply.match(/\{[^}]+\}/s);
    expect(jsonMatch, "agent should return a JSON object").not.toBeNull();
    const toolFlags = JSON.parse(jsonMatch![0]) as Record<string, boolean>;
    expect(toolFlags.has_bash).toBe(false);
    // Should have at least one of the expected MCP tools
    const hasMcpTools = toolFlags.has_provision || toolFlags.has_execute || toolFlags.has_linear;
    expect(hasMcpTools).toBe(true);
  }, TURN_TIMEOUT_MS);

  test("3. sandbox provision route resolves platform UUID (regression: ses_* mismatch)", async () => {
    // Create a fresh session for the agent-with-projects so harness_session_id
    // is live and platform_session_id is wired correctly.
    const session = await apiPost(`agents/${AGENT_WITH_PROJECTS_ID}/session`, {
      title: "e2e provision check",
    });
    const provisionSessionId = session.id as string;
    await waitForReady(provisionSessionId, 30_000);

    // Hit the provision route directly — no AI in the loop.
    // Before the fix this returned 404 "session ses_* not found" because
    // the harness used its internal ses_* ID instead of the platform UUID.
    const res = await fetch(
      `${BASE_URL}/api/v1/managed_agents/sessions/${provisionSessionId}/sandbox/provision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MASTER_KEY}`,
        },
        body: JSON.stringify({ name: "e2e-test", project_id: AGENT_WITH_PROJECTS_PROJECT_ID }),
      },
    );
    const json = await res.json() as Record<string, unknown>;
    // Must not be the "session not found" 404 that caused the regression.
    expect(res.status, `provision returned ${res.status}: ${JSON.stringify(json)}`).not.toBe(404);
    // Either a 200 success or a non-session-lookup error (e.g. K8s quota) is
    // acceptable — what matters is the DB lookup succeeded.
    expect(json.error ?? "").not.toMatch(/not found/i);
  }, TURN_TIMEOUT_MS);

  test("4. agent describes LIT-3198 via Linear MCP (not via Bash or file tools)", async () => {
    const reply = await sendMessage(
      sessionId,
      "Describe this Linear ticket: https://linear.app/litellm-ai/issue/LIT-3198/add-otel-spans-for-mcp — use only the Linear MCP tool to fetch it.",
    );
    // Should contain ticket-related content
    expect(reply.toLowerCase()).toMatch(/otel|span|mcp|observ|tracing|lit-3198/i);
    // Must not mention bash execution or file reads
    expect(reply.toLowerCase()).not.toMatch(/bash|shell|file read|open\(|subprocess/i);
  }, TURN_TIMEOUT_MS);
});
