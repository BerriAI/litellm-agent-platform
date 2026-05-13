# SessionEvent flow — harness → DB → consumers

> **Audience: future agents working in this repo.** Read this before touching
> anything in `harnesses/`, `src/worker/`, the `/sessions/[sid]/events`
> route, or the `managed_agent_session_event` table.

## TL;DR

```
┌────────────┐      ┌──────────────┐      ┌────────────────┐      ┌──────────┐
│  Harness   │─SSE─▶│  Worker      │─SQL─▶│  Postgres      │◀─SQL─│  LAP API │
│  /event    │      │  subscriber  │ON    │  managed_agent │      │  GET     │
│            │      │              │CONF. │  _session_     │      │  /events │
│  emits     │      │  reconnects  │DO    │  event         │      │  long-   │
│  SessionEv │      │  on RST      │NOTH. │  (append-only) │      │  poll    │
└────────────┘      └──────────────┘      └────────────────┘      └────┬─────┘
                                                                       │ JSON
                                                       ┌───────────────┼───────────────┐
                                                       ▼               ▼               ▼
                                                 ┌──────────┐   ┌──────────┐   ┌────────────┐
                                                 │  UI page │   │  Slack   │   │  External  │
                                                 │  /events │   │  bot     │   │  consumer  │
                                                 │ (polls)  │   │ (polls)  │   │ (shin etc.)│
                                                 └──────────┘   └──────────┘   └────────────┘
```

One typed union (`SessionEvent`) flows from the harness pod to every
consumer. The harness owns translation; the platform persists what comes
off the wire; consumers read JSON via long-poll. **No second translator
exists outside the harness.**

## The contract

[`harnesses/_shared/src/session-event.ts`](../harnesses/_shared/src/session-event.ts)
exports two things every consumer can rely on:

- `SessionEvent` — the typed discriminated union. Every variant carries
  `event_id: string` (a UUID minted at emit time).
- `SessionEventTranslator<SDKEvent>` — abstract base class. One concrete
  subclass per harness. The Claude SDK harness ships
  [`ClaudeSdkTranslator`](../harnesses/claude-agent-sdk/src/sdk-translator.ts);
  a future OpenAI Agents harness would subclass the same base.

A new harness only has to:

1. Subscribe to its SDK's event stream
2. Run each event through a `translate()` that returns `SessionEvent[]`
3. JSON-serialise each one onto a `GET /event` SSE response

The platform is identical regardless of which harness produced the events.

## Per-step detail

### 1 · Harness emits

[`harnesses/claude-agent-sdk/src/runner.ts`](../harnesses/claude-agent-sdk/src/runner.ts)
runs the SDK and hands each frame to the translator. The translator
returns `SessionEvent[]`; the runner stamps each with `event_id =
randomUUID()` and broadcasts to in-process SSE subscribers.

Wire shape (`GET /event` SSE):

```
data: {"event_id":"...","type":"user_message","text":"hi"}

data: {"event_id":"...","type":"status","status":"ready"}

data: {"event_id":"...","type":"assistant_text","message_id":"msg_X","part_id":"msg_X_b0","text":"..."}

data: {"event_id":"...","type":"turn_complete","cost_usd":0.003,"usage":{...}}
```

Token-level deltas are intentionally NOT persisted. The harness keeps
them on the live SSE channel for live-streaming UIs but the
translator's `stream_event` branch returns `[]` — the persisted log
carries snapshot events only.

### 2 · Worker subscribes

[`src/worker/index.ts`](../src/worker/index.ts) scans Postgres every 10s
for `status='ready'` sessions and attaches one SSE subscriber per pod.
For each frame:

1. `JSON.parse` (no translation — the harness already emitted the
   canonical shape)
2. `appendSessionEvent(session_id, event)` (see below)

Two resilience features matter:

- **Reconnect loop** — undici stream errors (`TypeError: terminated`
  from a TCP RST when the harness restarts) trigger a 250 ms → 5 s
  backoff loop. Without it, one harness blip silently kills the writer.
- **Local-mode gate** — when `LAP_LOCAL_SANDBOX_URL` is set the worker
  scopes its scan to `task_arn='local'` only and disables reconcile/
  warm-pool ticks. Lets you run the worker on your laptop without
  fighting a production reconciler.

### 3 · DB writes (idempotent)

[`src/server/sessionEvents.ts`](../src/server/sessionEvents.ts)
`appendSessionEvent` uses raw `INSERT … ON CONFLICT (session_id,
event_id) DO NOTHING`. Two writers delivering the same SSE frame
collapse to one row. **You can run as many subscribers as you want;
duplicates can't happen.**

Schema:

```prisma
model SessionEvent {
  session_id String
  seq        Int       // monotonic per session
  event_type String
  payload    Json      // the full SessionEvent JSON
  event_id   String    // UUID minted at harness emit
  ts         DateTime  @default(now())

  @@id([session_id, seq])
  @@unique([session_id, event_id])
  @@index([session_id, seq])
}
```

Two unique constraints, two failure modes:

- `(session_id, seq)` PK collision → another writer grabbed our seq.
  We retry up to 8x with `MAX(seq)+1` recomputed.
- `(session_id, event_id)` collision → the event already landed. We
  return the existing seq and treat it as success.

### 4 · API serves the log

[`src/app/api/v1/managed_agents/sessions/[session_id]/events/route.ts`](../src/app/api/v1/managed_agents/sessions/%5Bsession_id%5D/events/route.ts)

```
GET /api/v1/managed_agents/sessions/{sid}/events?since=N&wait=30
Authorization: Bearer $MASTER_KEY
→ { events: ApiSessionEvent[], next_since: number }
```

Long-poll: returns immediately if there are rows with `seq > since`,
otherwise short-polls every 250ms up to `wait` seconds. Same endpoint
serves the UI, Slack, the upcoming `shin-litellm-platform` `/agents/{id}/events`
passthrough, and any future external consumer. **One read path, one
JSON shape.**

### 5 · Consumers replay

Each consumer keeps a cursor (the last `seq` it persisted), polls
`/events?since=cursor`, advances. State is fully recoverable from the
log — a refreshing client renders the same thread as a long-lived one.

- **UI** —
  [`src/app/sessions/[sid]/events/page.tsx`](../src/app/sessions/%5Bsid%5D/events/page.tsx)
  groups events into turns, renders UserPromptBlock / ToolBlock /
  ThinkingBlock / typewriter-animated assistant text. A
  `WorkerHealthChip` surfaces a red "worker stuck (Ns)" indicator when
  a `user_message` is the latest event and >15 s have passed.
- **Slack** — see `shin-litellm-platform/src/slack.ts`. The bot polls
  events and renders status/PR-url/critique updates as thread replies.
- **External (`shin`)** —
  [`shin-litellm-platform/src/server.ts`](https://github.com/BerriAI/shin-litellm-platform/blob/main/src/server.ts)
  exposes `GET /agents/:agentId/events` as a thin passthrough to the
  LAP endpoint above. `shin`'s `agentId` is LAP's `session_id`.

## What NOT to add

- **A second translator.** If you find yourself converting `BusEvent →
  SessionEvent` outside the harness, you're rebuilding what we just
  deleted. The harness is the only translator.
- **A separate write path for `user_message`.** Both the LAP `POST
  /message` route AND the harness's `runner.ts` used to write
  user_message → double rows. Today only the harness writes it; the
  LAP route returns `seq_started = MAX(seq)` and lets the long-poll
  pick it up.
- **A live + replay channel split.** It's one log. UIs that want
  token-level streaming can subscribe to the harness `/event` SSE
  directly, but they should NOT persist deltas — that's the difference
  between "snapshot events" (persisted) and "live deltas" (ephemeral).

## Failure modes you'll meet

| Symptom | Most likely cause | Fix |
|---|---|---|
| Empty `/events` after sending a message | Worker is dead (silent undici crash before the reconnect-loop patch) | Restart the worker; check `tail /tmp/local-worker.log` for `disconnected; reconnecting` lines |
| Duplicate events in DB | Multiple subscribers running (zombie tsx processes survived `pkill`) | `lsof -i:<harness port>` to count subscribers; `pkill -9 -f 'src/worker/index.ts'` (broader pattern); the `event_id` unique index now prevents this architecturally for new events |
| `cache_control` 400 from anthropic | SDK request shape quirk routed through a proxy that adds malformed cache blocks | Bypass the proxy (`unset ANTHROPIC_BASE_URL`) or switch to a model the proxy understands |
| Sessions stuck `creating` forever | Pod scheduled but image not in CRI index | `docker exec agent-sbx-control-plane crictl images` to verify; rebuild + push to local registry + retag inside containerd |
| Wrong model id reaches the LLM | LiteLLM-style `anthropic/<model>` prefix sent to api.anthropic.com directly | `normalizeModelId()` in `harnesses/claude-agent-sdk/src/server.ts` strips it when no proxy is configured |

## Where to read next

- `harnesses/_shared/src/session-event.ts` — the canonical types
- `harnesses/claude-agent-sdk/src/sdk-translator.ts` — the only translator
- `src/server/sessionEvents.ts` — append + long-poll helpers
- `src/worker/index.ts` — the SSE subscriber with reconnect
- `src/app/sessions/[sid]/events/page.tsx` — the UI that reads the log
- PRs: [#60](https://github.com/BerriAI/litellm-agent-platform/pull/60)
  (the refactor), [#61](https://github.com/BerriAI/litellm-agent-platform/pull/61)
  (UI), [#62](https://github.com/BerriAI/litellm-agent-platform/pull/62)
  (local-mode + idempotency + worker resilience).
