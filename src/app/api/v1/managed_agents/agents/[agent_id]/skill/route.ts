/**
 * POST /api/v1/managed_agents/agents/{agent_id}/skill
 *
 * Attach a skill to an agent by either referencing an existing skill or
 * providing inline content. Updates agent.prompt to embed the skill after
 * the <!-- skill --> separator.
 *
 * Body (one of):
 *   { skill_id: string }
 *     — attach an existing skill from the library by ID
 *
 *   { content: string, name?: string, description?: string, save_to_library?: boolean }
 *     — inline content; optionally saves a new Skill row first
 *
 * DELETE removes the skill block from agent.prompt (keeps base system prompt).
 */

import { z } from "zod";
import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { httpError, toApiAgent, toApiSkill } from "@/server/types";
import { wrap } from "@/server/route-helpers";

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

function embedSkill(basePrompt: string | null | undefined, skillContent: string): string {
  const base = (basePrompt ?? "").split(/\n<!-- skill -->\n/)[0].trimEnd();
  return base ? `${base}\n<!-- skill -->\n${skillContent.trim()}` : skillContent.trim();
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { user_id } = assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null || agent.created_by !== user_id) httpError(404, `agent '${agent_id}' not found`);

  const body = AttachSkillBody.parse(await req.json());

  let skillContent: string;
  let savedSkill = null;

  if ("skill_id" in body) {
    const skill = await prisma.skill.findUnique({ where: { skill_id: body.skill_id } });
    if (skill === null || skill.created_by !== user_id) httpError(404, `skill '${body.skill_id}' not found`);
    skillContent = skill.content;
    savedSkill = toApiSkill(skill);
  } else {
    skillContent = body.content;
    if (body.save_to_library && body.name?.trim()) {
      const row = await prisma.skill.create({
        data: {
          name: body.name.trim(),
          description: body.description?.trim() ?? null,
          content: body.content,
          created_by: user_id,
        },
      });
      savedSkill = toApiSkill(row);
    }
  }

  const updated = await prisma.agent.update({
    where: { agent_id },
    data: { prompt: embedSkill(agent.prompt, skillContent) },
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

  const basePrompt = (agent.prompt ?? "").split(/\n<!-- skill -->\n/)[0].trimEnd();
  const updated = await prisma.agent.update({
    where: { agent_id },
    data: { prompt: basePrompt || null },
  });

  return Response.json({ agent: toApiAgent(updated) });
});
