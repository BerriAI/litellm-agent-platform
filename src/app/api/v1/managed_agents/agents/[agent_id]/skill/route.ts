/**
 * POST /api/v1/managed_agents/agents/{agent_id}/skill
 *
 * Attach a skill to an agent by either referencing an existing skill or
 * providing inline content. Updates agent.prompt by appending a per-skill
 * block delimited by `<!-- skill:<skill_id> -->`. Multiple skills can be
 * stacked on one agent — each gets its own block, ordered by attach time.
 *
 * Body (one of):
 *   { skill_id: string }
 *     — attach an existing skill from the library by ID
 *
 *   { content: string, name?: string, description?: string, save_to_library?: boolean }
 *     — inline content. By default (save_to_library !== false) the content
 *       is also saved to the Skill library so it can be reattached to
 *       other agents. Pass `save_to_library: false` for an ephemeral
 *       attachment — no Skill row is written and the marker uses a fresh
 *       random UUID; the response will not include a `skill` field.
 *
 * DELETE removes a skill block from agent.prompt.
 *   - With `?skill_id=<id>`: strip only that block.
 *   - Without param: strip all skill blocks (legacy "detach all").
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  appendSkillBlock,
  stripAllSkillBlocks,
  stripSkillBlock,
} from "@/server/skill-prompt";
import { httpError, toApiAgent, toApiSkill, type ApiSkill } from "@/server/types";
import { wrap } from "@/server/route-helpers";

// Re-export the prompt helpers from their canonical home for any
// callers that imported them from this route file historically.
export {
  appendSkillBlock,
  parseAttachedSkillIds,
  stripAllSkillBlocks,
  stripSkillBlock,
} from "@/server/skill-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

const AttachSkillBody = z.union([
  z.object({
    skill_id: z.string().min(1),
  }),
  z.object({
    content: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    save_to_library: z.boolean().optional(),
  }),
]);

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { user_id } = assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null || agent.created_by !== user_id) httpError(404, `agent '${agent_id}' not found`);

  const body = AttachSkillBody.parse(await req.json());

  let skillId: string;
  let skillContent: string;
  let savedSkill: ApiSkill | undefined;

  if ("skill_id" in body) {
    const skill = await prisma.skill.findUnique({ where: { skill_id: body.skill_id } });
    if (skill === null || skill.created_by !== user_id) httpError(404, `skill '${body.skill_id}' not found`);
    skillId = skill.skill_id;
    skillContent = skill.content;
    savedSkill = toApiSkill(skill);
  } else {
    // Inline content. Default behavior: persist the skill to the library
    // so it can be reattached to other agents. Callers can opt out with
    // `save_to_library: false` for an ephemeral marker — the id only
    // exists on this agent's prompt and can't be looked up later.
    const saveToLibrary = body.save_to_library !== false;
    if (saveToLibrary) {
      const name = body.name?.trim() || `Skill ${new Date().toISOString().slice(0, 19)}`;
      const row = await prisma.skill.create({
        data: {
          name,
          description: body.description?.trim() ?? null,
          content: body.content,
          created_by: user_id,
        },
      });
      skillId = row.skill_id;
      skillContent = row.content;
      savedSkill = toApiSkill(row);
    } else {
      // Ephemeral: no Skill row written. The id only exists in the
      // prompt marker; the skill can't be reattached to other agents
      // from the library.
      skillId = randomUUID();
      skillContent = body.content;
    }
  }

  const updated = await prisma.agent.update({
    where: { agent_id },
    data: { prompt: appendSkillBlock(agent.prompt, skillId, skillContent) },
  });

  return Response.json({
    agent: toApiAgent(updated),
    ...(savedSkill ? { skill: savedSkill } : {}),
  }, { status: 200 });
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  const { user_id } = assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null || agent.created_by !== user_id) httpError(404, `agent '${agent_id}' not found`);

  const url = new URL(req.url);
  const skillId = url.searchParams.get("skill_id");

  const nextPrompt = skillId
    ? stripSkillBlock(agent.prompt, skillId)
    : stripAllSkillBlocks(agent.prompt);

  const updated = await prisma.agent.update({
    where: { agent_id },
    data: { prompt: nextPrompt || null },
  });

  return Response.json({ agent: toApiAgent(updated) });
});
