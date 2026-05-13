# Worker · SessionEvent subscriber

`index.ts` subscribes to each harness's `/event` SSE, JSON-parses each
frame as a `SessionEvent`, and persists via `appendSessionEvent`.
Idempotent (UNIQUE on `(session_id, event_id)`), with an undici
reconnect loop so a harness restart doesn't silently kill writes.

Before changing the subscriber, the reconnect/backoff, or
`appendSessionEvent`, read the architecture doc — the contract is
load-bearing across the UI, Slack bot, and external consumers:

→ **[/ARCHITECTURE.md](../../ARCHITECTURE.md)**
