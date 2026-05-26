CREATE TABLE IF NOT EXISTS "managed_agent_session_assessment" (
    "assessment_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'on_track',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "blocker_type" TEXT,
    "diagnosis" TEXT NOT NULL,
    "recommended_action" TEXT,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "action_status" TEXT NOT NULL DEFAULT 'none',
    "action_ref" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_check_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_agent_session_assessment_pkey" PRIMARY KEY ("assessment_id")
);

CREATE INDEX IF NOT EXISTS "managed_agent_session_assessment_session_id_checked_at_idx"
    ON "managed_agent_session_assessment"("session_id", "checked_at");

CREATE INDEX IF NOT EXISTS "managed_agent_session_assessment_state_checked_at_idx"
    ON "managed_agent_session_assessment"("state", "checked_at");

ALTER TABLE "managed_agent_session_assessment"
    ADD CONSTRAINT "managed_agent_session_assessment_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "managed_agent_session"("session_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
