/**
 * Opencode harness client.
 *
 * Mirrors litellm/proxy/managed_agents_endpoints/harness_client.py — same
 * endpoints, same body shape. Translates httpx.AsyncClient calls to
 * undici.fetch with AbortSignal-based timeouts.
 */

import { fetch } from "undici";

import { buildSessionUrl } from "./sessionUrl";

// Bearer token the inline harness (lite-harness) gates its API on. When the
// env var is unset, the harness runs open and we send no header. Single source
// of truth so every fetch in this module agrees.
function harnessAuthHeaders(): Record<string, string> {
  const token =
    process.env.HARNESS_AUTH_TOKEN?.trim() ||
    process.env.CONTAINER_ENV_HARNESS_AUTH_TOKEN?.trim() ||
    "";
  return token ? { authorization: `Bearer ${token}` } : {};
}
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
const DEFAULT_MESSAGE_TIMEOUT_MS = 1_800_000; // 30 min — opus-4-7 with thinking can run long

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
// Also treat 200 + empty body as dead: opencode returns HTTP 200 with no
// body when the session is not found (NotFoundError), which would otherwise
// surface as "Unexpected end of JSON input" and bypass recovery entirely.
export function isDeadSessionError(err: unknown): boolean {
  if (!(err instanceof HarnessHttpError)) return false;
  if (err.status === 200 && (err.statusText === "empty response body" || err.statusText === "invalid JSON response body")) return true;
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

/**
 * Prepend the agent's system prompt to the FIRST turn's parts.
 *
 * Why here and not in the harness: opencode has no per-session system-prompt
 * API (system instructions only come from AGENTS.md / opencode.json, which are
 * process-global), and the shared inline harness serves every agent from one
 * `opencode serve` process — so a per-agent prompt can't be delivered via
 * files. We instead lead the first message with the prompt; opencode carries
 * it in the session's context for every later turn. No-op when prompt is empty.
 */
export function prependAgentSystemPrompt(
  prompt: string | null | undefined,
  parts: HarnessMessagePart[],
  session_id?: string,
): HarnessMessagePart[] {
  const trimmed = prompt?.trim();
  // Inject BOTH the raw id and the full public URL so the agent never has to
  // construct a session link itself (it hallucinates the id). When it must
  // reference the session in text (e.g. a channel post), it copies
  // <lap_session_url> verbatim. buildSessionUrl returns null without a public
  // base URL, in which case we fall back to the id line only.
  const sessionUrl = session_id ? buildSessionUrl(session_id) : null;
  const sessionLine = session_id
    ? `[SYSTEM: Your LAP session_id is ${session_id} — pass this exact string when calling sandbox_provision]\n` +
      `<lap_session_id>${session_id}</lap_session_id>\n` +
      (sessionUrl ? `<lap_session_url>${sessionUrl}</lap_session_url>\n` : "")
    : "";
  if (!trimmed && !sessionLine) return parts;
  const body = trimmed
    ? `<system_instructions>\n${trimmed}\n</system_instructions>\n\n` +
      `Follow the system instructions above for the entire conversation. ` +
      `Now respond to the request below.\n`
    : `Now respond to the request below.\n`;
  const preamble: HarnessMessagePart = {
    type: "text",
    text: sessionLine + body,
  };
  return [preamble, ...parts];
}

/**
 * Retry wrapper for transient network failures (e.g. a brief gap during
 * rolling deploys of the inline harness). Only retries on `TypeError` with
 * "fetch failed" — real HTTP errors (4xx/5xx) are never retried.
 *
 * Backoff: baseDelayMs * attempt (2 s, 4 s by default).
 */
async function fetchWithRetry(
  url: string,
  opts: Parameters<typeof fetch>[1],
  maxRetries = 2,
  baseDelayMs = 2000,
): ReturnType<typeof fetch> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.warn(
        `[harness] fetch failed, retry attempt ${attempt}/${maxRetries}:`,
        url,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * attempt),
      );
    }
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (
        err instanceof TypeError &&
        typeof err.message === "string" &&
        err.message.includes("fetch failed")
      ) {
        lastErr = err;
        // continue to next attempt
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

async function postJson(
  url: string,
  body: unknown,
  timeout_ms: number,
): Promise<unknown> {
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...harnessAuthHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout_ms),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HarnessHttpError(res.status, res.statusText, text, url, "POST");
  }
  // opencode returns HTTP 200 with an empty body when the session is not found
  // (NotFoundError). Treat empty response as a dead-session signal so the
  // caller's recovery logic can create a fresh session and replay.
  const text = await res.text().catch(() => "");
  if (!text.trim()) {
    throw new HarnessHttpError(200, "empty response body", "", url, "POST");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HarnessHttpError(200, "invalid JSON response body", text.slice(0, 300), url, "POST");
  }
}

export async function harnessCreateSession(
  opts: HarnessCreateSessionOpts,
): Promise<string> {
  const { sandbox_url, title = "default", timeout_ms = DEFAULT_CREATE_TIMEOUT_MS } =
    opts;
  const body: Record<string, unknown> = {
    title,
    prompt: opts.prompt,
    files: opts.files ?? [],
  };
  if (opts.sandbox_tools !== undefined) body.sandbox_tools = opts.sandbox_tools;
  if (opts.projects !== undefined) body.projects = opts.projects;
  if (opts.agent_id !== undefined) body.agent_id = opts.agent_id;
  if (opts.mcp_servers !== undefined) body.mcp_servers = opts.mcp_servers;
  if (opts.platform_session_id !== undefined) body.platform_session_id = opts.platform_session_id;
  let data = await postJson(
    `${sandbox_url}/session`,
    body,
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
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: harnessAuthHeaders(),
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
  // Derive providerID from model prefix: "anthropic/claude-x" → {providerID:"anthropic", modelID:"claude-x"}
  // Falls back to "litellm" for bare names (LiteLLM gateway path).
  const slashIdx = model.indexOf("/");
  const providerID = slashIdx > 0 ? model.slice(0, slashIdx) : "litellm";
  const modelID = slashIdx > 0 ? model.slice(slashIdx + 1) : model;
  const body = {
    model: { providerID, modelID },
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
    headers: { "content-type": "application/json", ...harnessAuthHeaders() },
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
/**
 * DELETE /session/:id — remove the session from the harness's in-memory map.
 * Used by brain-inline restart to prevent orphaned session accumulation. Fire
 * and forget: if the harness is unreachable the old session will simply idle
 * until the harness process restarts, which is preferable to blocking the new
 * restart on cleanup.
 */
export async function harnessDeleteSession(opts: {
  sandbox_url: string;
  harness_session_id: string;
}): Promise<void> {
  const { sandbox_url, harness_session_id } = opts;
  const url = `${sandbox_url}/session/${harness_session_id}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: harnessAuthHeaders(),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new HarnessHttpError(res.status, res.statusText, text, url, "DELETE");
  }
}

export async function harnessAbort(opts: {
  sandbox_url: string;
  harness_session_id: string;
}): Promise<void> {
  const { sandbox_url, harness_session_id } = opts;
  const url = `${sandbox_url}/session/${harness_session_id}/abort`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...harnessAuthHeaders() },
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HarnessHttpError(res.status, res.statusText, text, url, "POST");
  }
}

export async function harnessOpenEventStream(opts: {
  sandbox_url: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { sandbox_url, signal } = opts;
  const url = `${sandbox_url}/event`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "text/event-stream", ...harnessAuthHeaders() },
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
