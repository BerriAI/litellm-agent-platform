# SessionEvents from this harness

`src/sdk-translator.ts` is the only translator. It subclasses
`SessionEventTranslator` (from `@lap/harness-shared`) and converts
Claude-Agent-SDK frames into the platform-canonical
[`SessionEvent`](../_shared/src/session-event.ts) union.

Before touching anything that emits events (`runner.ts`, `server.ts`,
`sdk-translator.ts`), read the architecture doc — it explains why every
event carries a UUID `event_id`, what gets persisted vs dropped, and
the resilience contract the platform-side worker depends on:

→ **[/ARCHITECTURE.md](../../ARCHITECTURE.md)**
