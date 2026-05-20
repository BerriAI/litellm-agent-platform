/**
 * Opencode harness client.
 *
 * Mirrors litellm/proxy/managed_agents_endpoints/harness_client.py — same
 * endpoints, same body shape. Translates httpx.AsyncClient calls to
 * undici.fetch with AbortSignal-based timeouts.
 */

import { fetch } from "undici";

import type {
  HarnessCreateSessionOpts,
  HarnessMessage,
  HarnessMessagePart,
  HarnessMessageResponse,
  HarnessSendMessageOpts,
  MessageAttachment,
} from "./types";

// 60s is plenty for /session create. Message responses can run minutes when
// the model invokes tools and reads files, so callers should bump this on
// the message path (or the harness will end up disconnected mid-stream).
const DEFAULT_CREATE_TIMEOUT_MS = 60_000;
const DEFAULT_MESSAGE_TIMEOUT_MS = 600_000;

export class HarnessHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    url: string,
    method: string,
  ) {
    super(
      `harness request failed: ${method} ${url} -> ${status} ${statusText}: ${body}`,
    );
  }
}

const HARD_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export function isHardConnectFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string" && HARD_CONNECT_CODES.has(e.code)) return true;
  const cause = e.cause;
  if (cause && typeof cause === "object") {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === "string" && HARD_CONNECT_CODES.has(c)) return true;
  }
  return false;
}

// 404 + {"error":"not found"} from the harness means the harness_session_id
// is unknown — happens when a NodePort is reused by a different pod after
// the original pod dies. Treat it as dead so the user can /restart.
export function isDeadSessionError(err: unknown): boolean {
  if (!(err instanceof HarnessHttpError)) return false;
  if (err.status !== 404) return false;
  try {
    return (JSON.parse(err.body) as { error?: string }).error === "not found";
  } catch {
    return false;
  }
}

export function expandMessage(
  text?: string,
  parts?: HarnessMessagePart[],
  attachments?: MessageAttachment[],
): HarnessMessagePart[] {
  // Build Claude-format multimodal parts when attachments are present. Text
  // part first, then each image as a base64 source — matches the Anthropic
  // API content-block shape, which the claude-agent-sdk harness forwards
  // verbatim. Mirrors `runInitialPrompt` so the wire shape stays identical
  // between session-create and follow-up sends.
  if (attachments && attachments.length > 0) {
    return [
      ...(text !== undefined && text !== "" ? [{ type: "text", text }] : []),
      ...attachments.map((a) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: a.mime_type,
          data: a.base64,
        },
      })),
    ];
  }
  if (parts !== undefined) return parts;
  if (text !== undefined) return [{ type: "text", text }];
  throw new Error("message body must include 'text', 'parts', or 'attachments'");
}

async function postJson(
  url: string,
  body: unknown,
  timeout_ms: number,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout_ms),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HarnessHttpError(res.status, res.statusText, text, url, "POST");
  }
  return res.json();
}

export async function harnessCreateSession(
  opts: HarnessCreateSessionOpts,
): Promise<string> {
  const { sandbox_url, title = "default", timeout_ms = DEFAULT_CREATE_TIMEOUT_MS } =
    opts;
  let data = await postJson(
    `${sandbox_url}/session`,
    { title, prompt: opts.prompt, files: opts.files ?? [] },
    timeout_ms,
  );
  // Harness may return a bare object OR a single-element array (proto quirk).
  if (Array.isArray(data)) {
    if (data.length === 0) {
      throw new Error(
        `unexpected harness session response: ${JSON.stringify(data)}`,
      );
    }
    data = data[0];
  }
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { id?: unknown }).id !== "string"
  ) {
    throw new Error(
      `unexpected harness session response: ${JSON.stringify(data)}`,
    );
  }
  return (data as { id: string }).id;
}

/**
 * `GET /session/:id/message` — full thread including all intermediate
 * assistant messages (tool calls, reasoning) within each agent loop. POST
 * only returns the final assistant message, so the UI uses this list as
 * the source of truth for rendering tool/reasoning parts.
 */
export async function harnessListMessages(opts: {
  sandbox_url: string;
  harness_session_id: string;
  timeout_ms?: number;
}): Promise<HarnessMessage[]> {
  const {
    sandbox_url,
    harness_session_id,
    timeout_ms = DEFAULT_CREATE_TIMEOUT_MS,
  } = opts;
  const url = `${sandbox_url}/session/${harness_session_id}/message`;
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeout_ms),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HarnessHttpError(res.status, res.statusText, text, url, "GET");
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(
      `unexpected harness messages response (not array): ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return data as HarnessMessage[];
}

/**
 * Render a persisted opencode thread (the `[{info, parts}, ...]` shape from
 * `harnessListMessages`) into a single text blob suitable for replaying as
 * the first user message of a restarted session.
 *
 * The opencode harness has no import endpoint, so replay must go through
 * `POST /session/:id/message` as a text part. We dump the full message array
 * as pretty-printed JSON inside `<previous_session_history><msgs>...</msgs>`
 * tags so the model receives a lossless record of the prior session and can
 * interpret it as context rather than a fresh user request.
 */
export function formatHistoryAsText(msgs: HarnessMessage[]): string {
  return [
    "<previous_session_history>",
    "<msgs>",
    JSON.stringify(msgs, null, 2),
    "</msgs>",
    "</previous_session_history>",
  ].join("\n");
}

export async function harnessSendMessage(
  opts: HarnessSendMessageOpts,
): Promise<HarnessMessageResponse> {
  const {
    sandbox_url,
    harness_session_id,
    model,
    parts,
    timeout_ms = DEFAULT_MESSAGE_TIMEOUT_MS,
  } = opts;
  const body = {
    model: { providerID: "litellm", modelID: model },
    parts,
  };
  const data = await postJson(
    `${sandbox_url}/session/${harness_session_id}/message`,
    body,
    timeout_ms,
  );
  return data as HarnessMessageResponse;
}

/**
 * Fire the prompt asynchronously — the harness returns 204 immediately and
 * publishes progress on its event bus. Pair with `harnessOpenEventStream` to
 * stream tokens to the client without holding a request open for the entire
 * agent loop. See opencode `routes/instance/httpapi/groups/session.ts`.
 */
export async function harnessPromptAsync(
  opts: HarnessSendMessageOpts,
): Promise<void> {
  const {
    sandbox_url,
    harness_session_id,
    model,
    parts,
    timeout_ms = DEFAULT_CREATE_TIMEOUT_MS,
  } = opts;
  const url = `${sandbox_url}/session/${harness_session_id}/prompt_async`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "litellm", modelID: model },
      parts,
    }),
    signal: AbortSignal.timeout(timeout_ms),
  });
  // 204 No Content is the documented success path; res.ok already covers it
  // (200–299), so a single `!res.ok` guard handles the error case.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HarnessHttpError(res.status, res.statusText, text, url, "POST");
  }
}

/**
 * Subscribe to the harness's instance-wide bus stream. The stream is
 * `text/event-stream` with one JSON message per SSE event:
 *   `{ id, type, properties }`
 * The first event is `server.connected`. Heartbeats arrive every 10s as
 * `server.heartbeat`.
 *
 * The Response is returned without parsing so the caller can pipe the body
 * through their own filter+forward path. The caller is responsible for
 * canceling via the signal when done — without that, the stream stays open
 * (10s heartbeats keep undici from idling it shut).
 */
export async function harnessOpenEventStream(opts: {
  sandbox_url: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { sandbox_url, signal } = opts;
  const url = `${sandbox_url}/event`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HarnessHttpError(res.status, res.statusText, text, url, "GET");
  }
  if (!res.body) {
    throw new Error(`harness ${url} returned no body`);
  }
  return res as unknown as Response;
}
