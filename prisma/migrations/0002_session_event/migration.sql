-- AlterTable: add last_event_seq counter to Session.
-- Default 0 covers existing rows; appendEvent() bumps + reads via UPDATE...RETURNING.
ALTER TABLE "managed_agent_session"
  ADD COLUMN "last_event_seq" BIGINT NOT NULL DEFAULT 0;

-- CreateTable: append-only message log per session.
-- payload stores HarnessMessage ({info, parts}) verbatim — no transformation.
CREATE TABLE "managed_agent_session_event" (
    "event_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "managed_agent_session_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex: ordering + cursor pagination (WHERE seq > $last ORDER BY seq).
CREATE UNIQUE INDEX "managed_agent_session_event_session_id_seq_key"
  ON "managed_agent_session_event"("session_id", "seq");

-- CreateIndex: time-range scans (audit, debug).
CREATE INDEX "managed_agent_session_event_session_id_ts_idx"
  ON "managed_agent_session_event"("session_id", "ts");

-- AddForeignKey: cascade delete when the session row is removed.
ALTER TABLE "managed_agent_session_event"
  ADD CONSTRAINT "managed_agent_session_event_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "managed_agent_session"("session_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
