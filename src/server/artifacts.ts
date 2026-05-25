import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { env } from "@/server/env";

const s3 = new S3Client({ region: env.AWS_REGION });

export interface ArtifactResponse {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  url: string;
  created_at: string;
}

export async function createArtifact({
  session_id,
  name,
  mime_type,
  content,
  size,
}: {
  session_id: string;
  name: string;
  mime_type: string;
  content: string;
  size: number;
}): Promise<ArtifactResponse> {
  const id = randomUUID();
  const key = `artifacts/${session_id}/${id}/${name}`;

  const buffer = Buffer.from(content, "base64");

  await s3.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mime_type,
      Metadata: {
        sessionId: session_id,
        originalName: name,
      },
    }),
  );

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
    }),
    { expiresIn: 7 * 86400 },
  );

  return {
    id,
    name,
    mime_type,
    size,
    url,
    created_at: new Date().toISOString(),
  };
}
