/**
 * Stub harness — emits a scripted SessionEvent sequence on /event SSE,
 * identical wire shape to the real harness's post-translation output.
 * Used to validate the subscriber + persistence pipeline without
 * depending on the LLM.
 *
 * Usage:
 *   PORT=4100 npx tsx scripts/stub-harness.mts
 */
import { randomUUID } from "node:crypto";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { SessionEvent } from "@lap/harness-shared/session-event";

const PORT = parseInt(process.env.PORT ?? "4100", 10);

// Stamp every scripted event with a fresh UUID each turn so the
// platform's UNIQUE (session_id, event_id) index doesn't dedupe two
// "say hi" turns into one row.
const stamp = (e: Omit<SessionEvent, "event_id">): SessionEvent =>
  ({ ...e, event_id: randomUUID() } as SessionEvent);

// Template-only — event_id is added at emission time via stamp() so each
// "say hi" turn lands as a fresh row instead of being deduped by the
// (session_id, event_id) unique index. Distributive Omit so each
// variant of the SessionEvent union keeps its own discriminant.
type SessionEventTemplate = SessionEvent extends infer T
  ? T extends { event_id: string }
    ? Omit<T, "event_id">
    : never
  : never;
const SCRIPT: SessionEventTemplate[] = [
  { type: "status", status: "ready" },
  { type: "user_message", text: "hi" },
  {
    type: "assistant_text",
    message_id: "msg_demo_1",
    part_id: "msg_demo_1_b0",
    text: "Hi! Looking at the PR now.",
  },
  {
    type: "tool_call",
    message_id: "msg_demo_1",
    part_id: "msg_demo_1_b1",
    call_id: "call_abc123",
    tool: "Bash",
    input: { command: "git fetch origin pull/27344/head" },
  },
  {
    type: "tool_result",
    call_id: "call_abc123",
    output:
      "From github.com:BerriAI/litellm\n * branch refs/pull/27344/head -> FETCH_HEAD\n",
    is_error: false,
  },
  {
    type: "thinking",
    message_id: "msg_demo_1",
    part_id: "msg_demo_1_b2",
    text:
      "PR-27344 sets has_passthrough_route_constraints=True unconditionally when the AG has any allowed_routes config, even when those routes are model names rather than pass-through routes. The fix is to gate the flag on the presence of an actual PT route.",
  },
  {
    type: "assistant_text",
    message_id: "msg_demo_1",
    part_id: "msg_demo_1_b3",
    text:
      "Yes — PR-27344 is applicable. The regression is in `_filter_endpoints_by_team_allowed_routes`: when a team's access-group lists model names only (no pass-through routes), the function currently assumes constraints exist and filters all endpoints out. The fix is correct — only set `has_passthrough_route_constraints=True` when the AG has at least one PT-route entry. I'd suggest also adding a test for the model-only AG case in `tests/test_litellm/proxy/auth/test_passthrough_routes.py`.",
  },
  {
    type: "turn_complete",
    cost_usd: 0.0035,
    usage: { input: 1840, output: 280, cache_read: 0, cache_write: 0 },
  },
];

const subs = new Set<(e: SessionEvent) => void>();

const app = new Hono();

app.get("/", (c) =>
  c.json({ harness: "stub-harness", version: "0.0.2", port: PORT }),
);

app.get("/event", (c) =>
  streamSSE(c, async (stream) => {
    const cb = (e: SessionEvent): void => {
      void stream.writeSSE({ data: JSON.stringify(e) });
    };
    subs.add(cb);
    while (true) {
      await stream.sleep(60_000);
    }
  }),
);

app.post("/session/:id/message", async (c) => {
  const body = await c.req.json<{ text?: string }>();
  console.log(`[stub] received message: ${JSON.stringify(body).slice(0, 200)}`);
  setImmediate(async () => {
    for (const tpl of SCRIPT) {
      const e = stamp(tpl);
      for (const cb of subs) cb(e);
      await new Promise((r) => setTimeout(r, 80));
    }
    console.log(`[stub] script complete (${SCRIPT.length} events emitted)`);
  });
  return c.json({
    info: { id: "msg_demo_1", role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text: "ok (synthetic)" }],
  });
});

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`stub-harness listening on http://0.0.0.0:${port}`);
});
