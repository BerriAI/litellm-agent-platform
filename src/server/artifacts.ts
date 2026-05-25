/**
 * S3 artifact upload + presigned URL generation.
 *
 * The route handler at /managed_agents/sessions/{id}/artifacts is the only
 * caller. It already returns 503 when S3 isn't configured, so the guard
 * here is defensive — if anyone wires this function into another code path
 * they get a clear runtime error instead of an `undefined` Bucket name.
 *
 * Why not validate config at module import? Because Node evaluates the
 * whole module on the first `import`, and `route.ts` is imported during
 * `next build`'s page-data collection phase. A top-level throw there
 * crashes the build (and every deployment that boots without S3
 * configured). Keep the work inside the function.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { env } from "@/server/env";

// Hard cap on artifact size. base64 expands ~33%, so the route schema's
// `content` field is bounded a bit higher; this cap is on the decoded
// bytes that actually land in S3.
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

// Tolerance between client-declared `size` and the actual decoded byte
// length. Base64 padding rounds make the two differ by a couple of bytes
// even when honest; anything beyond this window is a buggy or malicious
// caller and we reject the upload.
const SIZE_MISMATCH_TOLERANCE_BYTES = 16;

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
  // Guard inside the function (not at module top-level) so deployments
  // that haven't configured S3 still boot — the route returns 503 before
  // we reach this code in that case.
  if (!env.ARTIFACT_STORAGE || !env.AWS_S3_BUCKET) {
    throw new Error(
      "Artifact storage not configured: set ARTIFACT_STORAGE=s3 and AWS_S3_BUCKET",
    );
  }

  const buffer = Buffer.from(content, "base64");

  // Enforce the cap against the actual decoded bytes, not the
  // caller-supplied `size` — a caller could declare `size: 1` and ship a
  // 1 GB base64 string otherwise.
  if (buffer.length > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Artifact too large: ${buffer.length} bytes exceeds ${MAX_ARTIFACT_BYTES}`,
    );
  }

  // Reject mismatched declarations so the metadata we return (and any
  // accounting that trusts the `size` field) stays honest.
  if (Math.abs(buffer.length - size) > SIZE_MISMATCH_TOLERANCE_BYTES) {
    throw new Error(
      `Artifact size mismatch: declared ${size}, actual ${buffer.length}`,
    );
  }

  // Sanitize the filename before embedding it in the S3 key. S3 stores
  // keys literally, so `../` doesn't cause real traversal, but stripping
  // path/control characters keeps the artifacts/{session}/{id}/ layout
  // predictable and avoids producing keys with URL-special characters
  // that complicate later listing.
  const sanitizedName = name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/[^\x20-\x7E]/g, "");

  const id = randomUUID();
  const key = `artifacts/${session_id}/${id}/${sanitizedName}`;

  // Lazy-construct the S3 client so a deployment with S3 configured but
  // never actually invoking the route doesn't open a connection pool it
  // never uses. (Also keeps module import side-effect-free.)
  // endpoint set → S3-compatible provider (e.g. Cloudflare R2). forcePathStyle
  // keeps bucket addressing in the path so it works regardless of the provider's
  // virtual-host support. Unset → real AWS S3 with default addressing.
  const s3 = new S3Client({
    region: env.AWS_REGION,
    ...(env.AWS_S3_ENDPOINT && { endpoint: env.AWS_S3_ENDPOINT, forcePathStyle: true }),
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mime_type,
    }),
  );

  // Presigned URL TTL = 7 days. Long enough that a user can come back to
  // a chat the next week and still download an artifact; short enough
  // that a leaked URL has a bounded blast radius.
  //
  // ResponseContentDisposition forces browsers to download rather than
  // render — critical for MIME types like text/html that would otherwise
  // execute scripts in the S3 bucket origin.
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${sanitizedName}"`,
    }),
    { expiresIn: 7 * 24 * 60 * 60 },
  );

  return {
    id,
    name: sanitizedName,
    mime_type,
    // Return `buffer.length`, not the caller's `size`, so the response
    // metadata reflects what was actually written to S3.
    size: buffer.length,
    url,
    created_at: new Date().toISOString(),
  };
}
