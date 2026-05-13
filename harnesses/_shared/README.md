# @lap/harness-shared

The central `SessionEvent` type + `SessionEventTranslator` abstract base
class. **Every harness extends this; the platform never does.**

If you're adding a new harness or wondering why one event has an
`event_id` field, read the data-flow + design doc:

→ **[/ARCHITECTURE.md](../../ARCHITECTURE.md)**

That doc covers the full lifecycle: harness emit → worker subscriber →
Postgres idempotent insert → UI / Slack / external consumer.
