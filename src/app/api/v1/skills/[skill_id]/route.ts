import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { UpdateSkillBody, toApiSkill, httpError } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ skill_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { skill_id } = await ctx.params;
  const row = await prisma.skill.findUnique({ where: { skill_id } });
  if (row === null) httpError(404, `skill '${skill_id}' not found`);
  return Response.json(toApiSkill(row));
});

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { skill_id } = await ctx.params;
  const body = UpdateSkillBody.parse(await req.json());

  const existing = await prisma.skill.findUnique({ where: { skill_id } });
  if (existing === null) httpError(404, `skill '${skill_id}' not found`);

  const updated = await prisma.skill.update({
    where: { skill_id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.content !== undefined && { content: body.content }),
    },
  });
  return Response.json(toApiSkill(updated));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { skill_id } = await ctx.params;
  const existing = await prisma.skill.findUnique({ where: { skill_id } });
  if (existing === null) httpError(404, `skill '${skill_id}' not found`);
  await prisma.skill.delete({ where: { skill_id } });
  return new Response(null, { status: 204 });
});
