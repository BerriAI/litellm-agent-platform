import { createArtifact } from "@/server/artifacts";
import { prisma } from "@/server/db";
import { z } from "zod";
import { HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateArtifactSchema = z.object({
  name: z.string().min(1).max(255),
  mime_type: z.string().min(1),
  content: z.string().min(1).max(100 * 1024 * 1024),  // base64, max 100MB
  size: z.number().int().min(1).max(100 * 1024 * 1024),
});

export async function POST(
  req: Request,
  { params }: { params: { session_id: string } },
) {
  try {
    // Verify session exists and is valid
    const session = await prisma.session.findUnique({
      where: { session_id: params.session_id },
      select: { session_id: true, status: true },
    });

    if (!session) {
      throw new HttpError(404, "session not found");
    }

    if (session.status !== "ready") {
      throw new HttpError(400, "session not in ready state");
    }

    const body = await req.json();
    const { name, mime_type, content, size } = CreateArtifactSchema.parse(body);

    // Additional validation: verify actual content size matches declared size
    const actualSize = Math.ceil((content.length * 3) / 4);  // base64 decode estimate
    if (Math.abs(actualSize - size) > 100) {
      // Allow 100 byte tolerance for rounding
      throw new HttpError(400, "content size does not match declared size");
    }

    const artifact = await createArtifact({
      session_id: params.session_id,
      name,
      mime_type,
      content,
      size,
    });

    return Response.json(artifact);
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.detail }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "invalid request", details: error.issues },
        { status: 400 },
      );
    }

    console.error("Failed to create artifact:", error);
    return Response.json({ error: "internal server error" }, { status: 500 });
  }
}
