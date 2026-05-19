/**
 * Claude-Agent-SDK adapter for the shared managed-tools/skills spec.
 *
 * Mirrors memory-tools.ts: all the real logic — schemas, descriptions,
 * HTTP client, local-disk write — lives in `@lap/managed-tools/skills`.
 * This file's only job is to bridge that spec to the Claude Agent SDK's
 * tool API (`tool()` + `createSdkMcpServer`).
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  callDeleteSkill,
  callListSkills,
  callSaveSkill,
  deleteSkillDescription,
  deleteSkillSchema,
  listSkillsDescription,
  listSkillsSchema,
  saveSkillDescription,
  saveSkillSchema,
  skillsEnv,
  type DeleteSkillInput,
  type ListSkillsInput,
  type SaveSkillInput,
} from "@lap/managed-tools/skills";

export function buildSkillMcpServer(): McpSdkServerConfigWithInstance | null {
  const env = skillsEnv();
  if (!env) return null;

  const saveSkill = tool(
    "save_skill",
    saveSkillDescription,
    saveSkillSchema,
    async (input: SaveSkillInput) => {
      const out = await callSaveSkill(env, input);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  const listSkills = tool(
    "list_skills",
    listSkillsDescription,
    listSkillsSchema,
    async (input: ListSkillsInput) => {
      const out = await callListSkills(env, input);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  const deleteSkill = tool(
    "delete_skill",
    deleteSkillDescription,
    deleteSkillSchema,
    async (input: DeleteSkillInput) => {
      const out = await callDeleteSkill(env, input);
      return {
        content: [{ type: "text" as const, text: out.text }],
        ...(out.isError && { isError: true }),
      };
    },
  );

  return createSdkMcpServer({
    name: "lap-skills",
    version: "0.1.0",
    tools: [saveSkill, listSkills, deleteSkill],
  });
}

export const SKILL_TOOL_NAMES = [
  "mcp__lap-skills__save_skill",
  "mcp__lap-skills__list_skills",
  "mcp__lap-skills__delete_skill",
] as const;
