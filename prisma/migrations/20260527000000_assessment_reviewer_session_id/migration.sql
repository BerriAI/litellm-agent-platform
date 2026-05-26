-- Track the spawned reviewer agent session per target session. Lets the
-- worker spawn the critique once and reuse the same session across ticks
-- instead of firing a new agent every minute.
ALTER TABLE "managed_agent_session_assessment"
  ADD COLUMN IF NOT EXISTS "reviewer_session_id" TEXT;
