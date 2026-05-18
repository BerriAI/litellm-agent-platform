/**
 * Slack file download helper.
 *
 * When a user @-mentions the bot with an image attached, Slack's event
 * payload includes a `files: [...]` array. Each entry exposes
 * `url_private_download` (or `url_private`) which is NOT a public URL — the
 * GET must carry `Authorization: Bearer <bot_token>` or Slack returns 403.
 * That auth lives on `IntegrationInstall.access_token` (encrypted), so the
 * download has to happen in the LAP web pod, not inside the agent's sandbox.
 *
 * Bot scope required: `files:read`. Reflected in the manifest in `./index.ts`.
 */
import { fetch } from "undici";
import { decrypt } from "../../core/crypto";
import type { IntegrationAttachment } from "../../core/types";
import type { IntegrationInstall } from "@prisma/client";

/**
 * Subset of the Slack file object we care about. Slack returns ~40 fields per
 * file but only these are load-bearing for image piping.
 */
export interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

/**
 * Hard cap per file. Above this we drop the attachment with a warning rather
 * than try to base64 a giant blob through to Anthropic — Claude's per-request
 * total is 32 MB across all parts and base64 inflates by ~33%.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Only forward image types. Other MIME types are silently dropped today. */
function isSupportedImageMime(mime: string | undefined): mime is string {
  if (!mime) return false;
  return (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/gif" ||
    mime === "image/webp"
  );
}

/**
 * Pull the supported image files from a Slack event's `files` array into
 * self-contained {name, mime, base64} blobs. Non-image files, missing URLs,
 * over-size files, and download failures are silently skipped (the agent
 * gets the text prompt either way; we don't want a flaky CDN to drop the
 * whole message).
 *
 * Returns an empty array when there's nothing to forward — including when
 * `files` is undefined, which lets callers chain unconditionally.
 */
export async function fetchAttachments(
  files: SlackFile[] | undefined,
  install: IntegrationInstall,
): Promise<IntegrationAttachment[]> {
  if (!files || files.length === 0) return [];

  // Slack bot tokens (xoxb-...) don't expire, so we skip the OAuth refresh
  // flow and just decrypt the stored token directly. This also keeps
  // `parse()` synchronous from a control-flow standpoint — one fetch round
  // trip per file, nothing else.
  const token = decrypt(install.access_token);
  const out: IntegrationAttachment[] = [];

  for (const f of files) {
    if (!isSupportedImageMime(f.mimetype)) continue;

    const url = f.url_private_download ?? f.url_private;
    if (!url) continue;

    if (typeof f.size === "number" && f.size > MAX_FILE_BYTES) {
      console.warn(
        `[slack/files] dropping ${f.name ?? f.id}: size ${f.size} > cap ${MAX_FILE_BYTES}`,
      );
      continue;
    }

    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.warn(
          `[slack/files] download failed: ${res.status} for ${f.name ?? f.id}`,
        );
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_FILE_BYTES) {
        console.warn(
          `[slack/files] dropping ${f.name ?? f.id}: post-fetch size ${buf.byteLength} > cap`,
        );
        continue;
      }
      out.push({
        name: f.name ?? f.id ?? "image",
        mime_type: f.mimetype,
        base64: buf.toString("base64"),
      });
    } catch (err) {
      console.warn(
        `[slack/files] fetch error for ${f.name ?? f.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return out;
}
