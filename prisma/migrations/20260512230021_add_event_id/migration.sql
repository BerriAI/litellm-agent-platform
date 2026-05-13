-- Idempotent SessionEvent inserts. Each event carries a UUID minted at the
-- harness emit site; the unique index makes second/third writes of the same
-- event a no-op via ON CONFLICT DO NOTHING (vs raising a constraint error).

-- Backfill existing rows with a placeholder so the NOT NULL add succeeds.
-- They won't be re-written; we just need *a* value.
ALTER TABLE "managed_agent_session_event" ADD COLUMN "event_id" TEXT;
UPDATE "managed_agent_session_event"
   SET "event_id" = 'legacy_' || "session_id" || '_' || "seq"
 WHERE "event_id" IS NULL;
ALTER TABLE "managed_agent_session_event" ALTER COLUMN "event_id" SET NOT NULL;

CREATE UNIQUE INDEX "managed_agent_session_event_session_id_event_id_key"
  ON "managed_agent_session_event"("session_id", "event_id");
