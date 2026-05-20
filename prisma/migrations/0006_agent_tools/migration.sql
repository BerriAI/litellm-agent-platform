-- AddColumn managed_agent.agent_tools
-- Sub-agents wired as callable tools. Stored as a JSON array of
-- { agent_id, name, description } objects. The harness entrypoint receives
-- AGENT_TOOLS_JSON and registers each entry as a first-class tool.

ALTER TABLE "managed_agent"
  ADD COLUMN IF NOT EXISTS "agent_tools" JSONB NOT NULL DEFAULT '[]';
