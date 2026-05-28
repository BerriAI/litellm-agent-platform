-- AlterTable
ALTER TABLE "managed_agent" ADD COLUMN     "workspace_pvc" TEXT;

-- AlterTable
ALTER TABLE "managed_agent_session_message" ALTER COLUMN "message_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "project" ALTER COLUMN "project_id" DROP DEFAULT;
