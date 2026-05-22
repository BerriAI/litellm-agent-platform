import { z } from "zod";
import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { httpError } from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SandboxFileSchema = z.object({
  name: z.string(),
  sandbox_path: z.string(),
  content: z.string(),
  content_type: z.string(),
  size: z.number(),
});

const UpdateProjectBody = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().optional(),
  repo_url: z.string().url().optional().or(z.literal("")).optional(),
  env_vars: z.record(z.string()).optional(),
  allow_out: z.array(z.string()).optional(),
  deny_out: z.array(z.string()).optional(),
  files: z.array(SandboxFileSchema).optional(),
});

async function getOwnedProject(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { project_id: projectId },
  });
  if (!project) httpError(404, { error: "project not found" });
  if (project!.created_by !== userId) httpError(403, { error: "forbidden" });
  return project!;
}

export const GET = wrap(async (req: Request, ctx: { params: Promise<{ project_id: string }> }) => {
  const identity = assertAuth(req);
  const { project_id } = await ctx.params;
  const project = await getOwnedProject(project_id, identity.user_id);
  return Response.json(project);
});

export const PATCH = wrap(async (req: Request, ctx: { params: Promise<{ project_id: string }> }) => {
  const identity = assertAuth(req);
  const { project_id } = await ctx.params;
  await getOwnedProject(project_id, identity.user_id);

  const body = UpdateProjectBody.parse(await req.json());
  const data: Prisma.ProjectUpdateInput = {};

  if (body.name !== undefined) {
    const trimmed = body.name.trim();
    if (!trimmed) httpError(400, { error: "name is required" });
    data.name = trimmed;
  }
  if (body.description !== undefined) data.description = body.description;
  if (body.repo_url !== undefined) data.repo_url = body.repo_url?.trim() || null;
  if (body.env_vars !== undefined) data.env_vars = body.env_vars as Prisma.InputJsonValue;
  if (body.allow_out !== undefined) data.allow_out = body.allow_out as Prisma.InputJsonValue;
  if (body.deny_out !== undefined) data.deny_out = body.deny_out as Prisma.InputJsonValue;
  if (body.files !== undefined) data.files = body.files as Prisma.InputJsonValue;

  const updated = await prisma.project.update({
    where: { project_id },
    data,
  });

  return Response.json(updated);
});

export const DELETE = wrap(async (req: Request, ctx: { params: Promise<{ project_id: string }> }) => {
  const identity = assertAuth(req);
  const { project_id } = await ctx.params;
  await getOwnedProject(project_id, identity.user_id);

  await prisma.project.delete({ where: { project_id } });
  return new Response(null, { status: 204 });
});
