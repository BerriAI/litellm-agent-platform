/**
 * Shared API helpers for talking to the local Next.js backend's
 * managed_agents endpoints.
 *
 * Every request goes to /api/v1/... on the same Next.js origin that serves
 * this UI. The backend route handlers (src/app/api/v1/...) own all egress to
 * AWS / LiteLLM / harness containers; the browser never touches those
 * services directly.
 *
 * Endpoints used (all under /v1/managed_agents):
 *   GET    /dockerfiles                              — list configured harnesses
 *   GET    /agents                                   — list agents
 *   GET    /agents/{id}                              — one agent
 *   POST   /agents                                   — create agent
 *   POST   /agents/{id}/session                      — spawn session (slow ~50-90s)
 *   GET    /sessions                                 — list sessions, optional ?agent_id
 *   GET    /sessions/{id}                            — one session
 *   DELETE /sessions/{id}                            — terminate session
 *   POST   /sessions/{id}/message                    — passthrough chat message
 */

import type {
  VaultInterception,
  VaultInterceptionFingerprint,
} from "@/lib/vault-types";

export type { VaultInterception, VaultInterceptionFingerprint };

/**
 * The browser-side base URL — always relative, always points at the local
 * Next.js backend. Don't read NEXT_PUBLIC_LITELLM_* — those leaked the API
 * key into the bundle.
 */
const PROXY_PREFIX = "/api";

/**
 * Auth header value, or null if no key is stored yet.
 *
 * Login flow: user pastes `MASTER_KEY` (set in server .env) into /login.
 * It gets stashed in localStorage under MASTER_KEY_STORAGE; every API call
 * sends it as `Authorization: Bearer <key>`. Backend `assertAuth` does a
 * constant-time compare against `env.MASTER_KEY`. On 401 we wipe the stored
 * key and bounce the user back to /login.
 */
const MASTER_KEY_STORAGE = "ui_master_key";

export function getStoredMasterKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(MASTER_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setStoredMasterKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MASTER_KEY_STORAGE, key);
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearStoredMasterKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MASTER_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

function authHeader(): string | null {
  const key = getStoredMasterKey();
  return key && key.length > 0 ? `Bearer ${key}` : null;
}

/**
 * Returns the public-facing base URL exposed by /api/config — used by the
 * 'Call this agent' snippets to show users the URL they'd hit from outside
 * the app. Cached for the lifetime of the page.
 */
interface PublicConfig {
  base_url: string;
  preinstalled_github_repo: string;
}

let _publicConfigPromise: Promise<PublicConfig> | null = null;

function getPublicConfig(): Promise<PublicConfig> {
  if (_publicConfigPromise) return _publicConfigPromise;
  _publicConfigPromise = fetch("/api/config")
    .then((r) =>
      r.ok ? r.json() : { base_url: "", preinstalled_github_repo: "" },
    )
    .then((j) => ({
      base_url: typeof j?.base_url === "string" ? j.base_url : "",
      preinstalled_github_repo:
        typeof j?.preinstalled_github_repo === "string"
          ? j.preinstalled_github_repo
          : "",
    }))
    .catch(() => ({ base_url: "", preinstalled_github_repo: "" }));
  return _publicConfigPromise;
}

export function getPublicProxyBase(): Promise<string> {
  return getPublicConfig().then((c) => c.base_url);
}

export function getPreinstalledGithubRepo(): Promise<string> {
  return getPublicConfig().then((c) => c.preinstalled_github_repo);
}

// ---------- Types ----------

export type SessionStatus =
  | "creating"
  | "ready"
  | "failed"
  | "dead"
  | string;

export type TemplateBuildStatus =
  | "pending"
  | "ready"
  | "failed"
  | string;

export interface DockerfileRow {
  id: string;
  container_port: number;
}

/** @deprecated Use AgentTemplate instead. */
export interface TemplateRow {
  id: string;
  name?: string | null;
  dockerfile_id: string;
  container_port: number;
  repo_url: string;
  default_branch: string;
  visibility: string;
  image_uri?: string | null;
  task_def_arn?: string | null;
  build_status: TemplateBuildStatus;
  build_error?: string | null;
}

export interface SandboxFileSpec {
  name: string;
  sandbox_path: string;
  content: string;      // base64-encoded
  content_type: string;
  size: number;
}

export interface AgentRow {
  id: string;
  name?: string | null;
  model: string;
  prompt?: string | null;
  harness_id: string;
  /** Derived server-side; true for `claude-code` / `codex` (see TUI_HARNESSES). */
  supports_tui?: boolean;
  branch: string;
  pfp_url?: string | null;
  mcp_servers?: string[];
  env_vars?: Record<string, string>;
  allow_out?: string[];
  deny_out?: string[];
  sandbox_files?: SandboxFileSpec[];
  /**
   * Max non-pinned memories preloaded into AGENT_PROMPT for this agent.
   * Pinned memories are always-included on top of this, capped server-side.
   */
  preload_memory_limit?: number;
  /**
   * IDs of skills currently attached to this agent, in attach order.
   * Parsed server-side from `<!-- skill:<id> -->` markers in `prompt`.
   * Empty array when the agent has no skills.
   */
  attached_skill_ids?: string[];
  created_at?: string | null;
  session_count?: number;
  has_active_session?: boolean;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  sandbox_url?: string | null;
  // Browser-accessible WS base URL for TUI harnesses. Non-null when the
  // session is ready and the platform can supply a reachable endpoint:
  // - IN_CLUSTER: a relative path through the platform TCP proxy.
  // - Local dev: null (terminal-panel derives from sandbox_url directly).
  tty_url?: string | null;
  // Bearer token for the harness's `/tty` WebSocket on TUI harnesses.
  // Populated by the backend from process.env.HARNESS_AUTH_TOKEN.
  tty_token?: string | null;
  status: SessionStatus;
  task_arn?: string | null;
  response?: HarnessMessageResponse | null;
  created_at?: string | null;
  // Last user-message activity (ISO 8601). Null until the first message
  // bumps it; UI falls back to `created_at` for the idle countdown.
  last_seen_at?: string | null;
  // Idle window after which the reconciler reaps a `ready` sandbox. Sent
  // by the backend so the UI doesn't hardcode SESSION_IDLE_TIMEOUT_MS.
  idle_timeout_ms?: number;
  // Populated when bring-up dies and status flips to `failed`. The
  // creating-state UI surfaces this verbatim so the user knows why the
  // sandbox never came up.
  failure_reason?: string | null;
  // Fine-grained bring-up phase, written by the platform's bring-up
  // orchestrator and (for container-side steps) by the in-sandbox harness.
  // Null on legacy rows created before the column existed — SpawnProgress
  // falls back to a wall-clock approximation in that case. See the server
  // SessionPhase union for the closed set of values.
  phase?: string | null;
  // Optional human-readable detail for the current phase. Rendered as a
  // small subtitle under the active step.
  phase_detail?: string | null;
  // Set when the session was kicked off by an integration webhook
  // (Slack DM/@-mention, Linear assign, …) rather than the LAP UI. The
  // session view renders a small banner with a deep link back to the
  // originating thread. Null for sessions created from the UI.
  origin?: SessionOrigin | null;
}

/**
 * Wire-side description of which integration created this session and how
 * to link back. Mirrors `SessionOrigin` in
 * `src/server/integrations/core/origin.ts`. Today only Slack supplies a
 * `url`; other integrations may leave it null until their deep-link
 * helper is wired in.
 */
export interface SessionOrigin {
  integration_id: string;
  external_session_id: string;
  external_ref: string | null;
  workspace_name: string;
  url: string | null;
}

/**
 * Shape returned by the harness when we POST a message. Stored on
 * `SessionRow.response` after a `POST /agents/{id}/session` with an
 * `initial_prompt`, and returned directly from `POST /sessions/{id}/message`.
 *
 * Modeled loosely on opencode's response — the backend passes it through
 * verbatim, so we keep this permissive.
 */
export interface HarnessMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface HarnessMessageResponse {
  parts?: HarnessMessagePart[];
  [key: string]: unknown;
}

export interface HarnessMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | string;
  [key: string]: unknown;
}

/**
 * One entry from `GET /sessions/:id/messages` — the full opencode thread.
 * A single user prompt can spawn multiple assistant entries within the agent
 * loop (tool call, reasoning, final text); rendering all of them is what
 * surfaces "internal logic" in the UI.
 */
export interface HarnessMessage {
  info: HarnessMessageInfo;
  parts: HarnessMessagePart[];
}

// ---------- Models / MCP (other proxy endpoints, unchanged) ----------

export interface ModelRow {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

export interface McpRow {
  server_id: string;
  server_name?: string;
  alias?: string;
  description?: string;
  url?: string;
  transport?: string;
  status?: string;
}

/**
 * One tool exposed by an MCP server, as returned by `/mcp-rest/tools/list`.
 * The proxy enriches each tool with `mcp_info` so we can group tools by
 * server in the UI without a second round-trip.
 */
export interface McpToolRow {
  name: string;
  description?: string;
  mcp_info?: {
    server_id?: string;
    server_name?: string;
    logo_url?: string;
  };
}

// ---------- Errors ----------

interface FastApiValidationItem {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function extractErrorMessage(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const items = detail as FastApiValidationItem[];
    return items
      .map((it) =>
        it && typeof it === "object" && "msg" in it
          ? String(it.msg)
          : JSON.stringify(it),
      )
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    const obj = detail as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
  }
  return `Request failed with status ${status}`;
}

// ---------- Core fetch ----------

export interface ApiInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: ApiInit,
): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const auth = authHeader();
  if (auth && !headers["Authorization"]) {
    headers["Authorization"] = auth;
  }

  // Caller passes paths like "/v1/managed_agents/agents" — these hit the
  // local Next.js backend on the same origin (no separate proxy hop).
  const res = await fetch(`${PROXY_PREFIX}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: init?.signal,
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      // Stored key is wrong / unset — wipe it and bounce to /login. Skip the
      // redirect for the /login page itself so the form can show the error.
      clearStoredMasterKey();
      if (
        typeof window !== "undefined" &&
        !window.location.pathname.startsWith("/login")
      ) {
        const next = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.href = `/login?next=${next}`;
      }
    }
    const detail =
      parsed && typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? (parsed as { detail: unknown }).detail
        : parsed;
    throw new ApiError(
      res.status,
      detail,
      extractErrorMessage(detail, res.status),
    );
  }

  return parsed as T;
}

// ---------- Templates / dockerfiles ----------

export function listDockerfiles(): Promise<DockerfileRow[]> {
  return api<DockerfileRow[]>("GET", "/v1/managed_agents/dockerfiles");
}

export function listTemplates(): Promise<AgentTemplate[]> {
  return api<AgentTemplate[]>("GET", "/v1/templates");
}

// ---------- Agents ----------

/**
 * Per-server tool whitelist. When a server appears in `mcp_servers` but NOT
 * in `mcp_allowed_tools`, the agent inherits all of that server's tools
 * (back-compat). When it appears here, the agent is restricted to the
 * listed tool names only.
 */
export interface McpAllowedTools {
  server_id: string;
  tools: string[];
}

export interface CreateAgentRequest {
  name?: string;
  model: string;
  prompt?: string;
  tools?: unknown[];
  // Picks which harness the Fargate container runs.
  // "opencode" (default) or "claude-agent-sdk".
  harness_id?: string;
  requirements?: string;
  repo_url?: string;
  branch?: string;
  pfp_url?: string;
  mcp_servers?: string[];
  mcp_allowed_tools?: McpAllowedTools[];
  env_vars?: Record<string, string>;
  allow_out?: string[];
  deny_out?: string[];
  sandbox_files?: SandboxFileSpec[];
  /** Library skill IDs to attach at create time (in order). Each is materialized inside the sandbox as ~/.claude/skills/<slug>/SKILL.md on session boot. */
  skill_ids?: string[];
}

export interface UpdateAgentRequest {
  name?: string;
  pfp_url?: string;
  mcp_servers?: string[];
  mcp_allowed_tools?: McpAllowedTools[];
  prompt?: string;
  /**
   * Replaces the agent's user-editable env_vars map. The PATCH route
   * preserves any internal reserved-key entries (e.g. AGENT_REQUIREMENTS)
   * that the user can't see. Re-encrypted at rest.
   */
  env_vars?: Record<string, string>;
  model?: string;
  branch?: string;
  preload_memory_limit?: number;
}

export function listAgents(): Promise<AgentRow[]> {
  return api<AgentListResponse>("GET", "/v1/managed_agents/agents").then((r) => r.data);
}

export interface ListAgentsParams {
  limit?: number;
  offset?: number;
  sort?: "created_at" | "name" | "harness_id" | "sessions";
  order?: "asc" | "desc";
  search?: string;
  signal?: AbortSignal;
}

export interface AgentListResponse {
  data: AgentRow[];
  total: number;
  limit: number;
  offset: number;
}

export function listAgentsPaginated(
  params: ListAgentsParams = {},
): Promise<AgentListResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.sort) qs.set("sort", params.sort);
  if (params.order) qs.set("order", params.order);
  if (params.search) qs.set("search", params.search);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return api<AgentListResponse>("GET", `/v1/managed_agents/agents${suffix}`, undefined, { signal: params.signal });
}

export function getAgent(id: string): Promise<AgentRow> {
  return api<AgentRow>(
    "GET",
    `/v1/managed_agents/agents/${encodeURIComponent(id)}`,
  );
}

export function createAgent(req: CreateAgentRequest): Promise<AgentRow> {
  return api<AgentRow>("POST", "/v1/managed_agents/agents", req);
}

export function updateAgent(
  id: string,
  req: UpdateAgentRequest,
): Promise<AgentRow> {
  return api<AgentRow>(
    "PATCH",
    `/v1/managed_agents/agents/${encodeURIComponent(id)}`,
    req,
  );
}

export function deleteAgent(id: string): Promise<void> {
  return api<void>("DELETE", `/v1/managed_agents/agents/${encodeURIComponent(id)}`);
}

// ---------- Memory ----------

export interface MemoryRow {
  id: string;
  agent_id: string;
  text: string;
  tags: string[];
  type: string;
  priority: number;
  /**
   * Always-on flag. When true, this memory is unconditionally included in
   * the AGENT_PROMPT pre-load regardless of the priority/usage ranking. See
   * server-side MAX_PINNED_PRELOAD for the safety cap.
   */
  pinned: boolean;
  disabled: boolean;
  times_applied: number;
  last_applied_at: string | null;
  source: string;
  source_user_id: string | null;
  source_session_id: string | null;
  source_thread_ts: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMemoryRequest {
  text: string;
  tags?: string[];
  type?: string;
  priority?: number;
  pinned?: boolean;
}

export interface UpdateMemoryRequest {
  text?: string;
  tags?: string[];
  type?: string;
  priority?: number;
  pinned?: boolean;
  disabled?: boolean;
}

export function listMemory(
  agentId: string,
  opts: { q?: string; tag?: string } = {},
): Promise<MemoryRow[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.tag) qs.set("tag", opts.tag);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return api<MemoryRow[]>(
    "GET",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/memory${suffix}`,
  );
}

export function createMemory(
  agentId: string,
  req: CreateMemoryRequest,
): Promise<MemoryRow> {
  return api<MemoryRow>(
    "POST",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/memory`,
    req,
  );
}

export function updateMemory(
  agentId: string,
  memoryId: string,
  req: UpdateMemoryRequest,
): Promise<MemoryRow> {
  return api<MemoryRow>(
    "PATCH",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`,
    req,
  );
}

export function deleteMemory(agentId: string, memoryId: string): Promise<void> {
  return api<void>(
    "DELETE",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`,
  );
}

// ---------- Sessions ----------

export interface CreateSessionRequest {
  initial_prompt?: string;
  title?: string;
}

export function listSessions(agentId?: string): Promise<SessionRow[]> {
  const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
  return api<SessionRow[]>("GET", `/v1/managed_agents/sessions${qs}`);
}

export function getSession(id: string): Promise<SessionRow> {
  return api<SessionRow>(
    "GET",
    `/v1/managed_agents/sessions/${encodeURIComponent(id)}`,
  );
}

/**
 * Spawn a session for an agent. This is the slowest call in the system —
 * 50–90s typical. Pass an AbortSignal to cancel in-flight requests on
 * navigation. The backend provisions a Fargate task, waits for the harness
 * to come up, and (optionally) seeds the conversation with `initial_prompt`.
 */
export function spawnSession(
  agentId: string,
  req: CreateSessionRequest,
  init?: ApiInit,
): Promise<SessionRow> {
  return api<SessionRow>(
    "POST",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/session`,
    req,
    init,
  );
}

export function deleteSession(id: string): Promise<{ id: string; status: string }> {
  return api<{ id: string; status: string }>(
    "DELETE",
    `/v1/managed_agents/sessions/${encodeURIComponent(id)}`,
  );
}

/**
 * Respawn a Fargate task for a `failed` / `dead` session and replay the
 * persisted opencode history as the new harness session's first user
 * message. As slow as `spawnSession` (50–90s typical) since it goes through
 * the same RunTask → wait-for-IP → wait-for-harness path. Returns the
 * updated session row in the same shape as `getSession`.
 */
export function restartSession(
  id: string,
  init?: ApiInit,
): Promise<SessionRow> {
  return api<SessionRow>(
    "POST",
    `/v1/managed_agents/sessions/${encodeURIComponent(id)}/restart`,
    undefined,
    init,
  );
}

// ---------- Session diagnose (one-shot debug bundle) ----------

/**
 * Shape returned by `GET /sessions/{id}/diagnose`. The endpoint is
 * intentionally permissive — every sub-section can be `{ exists: false }`,
 * `{ error: string }`, or partial. We keep everything `unknown` and narrow
 * inside the UI so a schema change on the backend doesn't break the build.
 */
export interface DiagnoseDetectedIssue {
  code: string;
  severity: "high" | "med" | "info";
  message: string;
  recommended_action?: string;
}

export interface DiagnoseResponse {
  session?: unknown;
  agent?: unknown;
  pod?: unknown;
  sandbox_cr?: unknown;
  service?: unknown;
  pod_logs_tail?: unknown;
  node?: unknown;
  image_cache?: unknown;
  warm_pool?: unknown;
  harness_probe?: unknown;
  detected_issues?: DiagnoseDetectedIssue[];
  notes?: unknown;
  [key: string]: unknown;
}

/**
 * Fetch the one-shot debug bundle for a session. The backend gathers pod,
 * service, node, warm-pool, image-cache, and harness-probe state in parallel
 * and runs a deterministic ruleset to surface known failure patterns. See
 * the route handler at /api/v1/managed_agents/sessions/[session_id]/diagnose
 * for the full response shape.
 */
export function getDiagnose(
  sessionId: string,
  init?: ApiInit,
): Promise<DiagnoseResponse> {
  return api<DiagnoseResponse>(
    "GET",
    `/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/diagnose`,
    undefined,
    init,
  );
}

// ---------- Sandbox pod logs (creating-state debugging) ----------

export interface SandboxLogsOpts {
  /** Only return lines from the last N seconds. Backend caps at 3600. */
  sinceSeconds?: number;
  /** Tail no more than N lines. Backend caps at 5000. */
  tailLines?: number;
  signal?: AbortSignal;
}

/**
 * Fetch the raw stdout+stderr of the harness pod backing `sessionId`. The
 * backend returns `text/plain` and is intentionally lenient — missing pods,
 * transient k8s errors, and sessions without a `task_arn` yet all surface as
 * 200 with empty (or a tiny marker line) text so the UI can poll without
 * branching on error states. A 404 still means "session row doesn't exist".
 */
export async function getSandboxLogs(
  sessionId: string,
  opts: SandboxLogsOpts = {},
): Promise<string> {
  const params = new URLSearchParams();
  if (typeof opts.sinceSeconds === "number") {
    params.set("sinceSeconds", String(opts.sinceSeconds));
  }
  if (typeof opts.tailLines === "number") {
    params.set("tailLines", String(opts.tailLines));
  }
  const qs = params.toString();
  const path = `/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/sandbox_logs${qs ? `?${qs}` : ""}`;
  const auth = authHeader();
  const headers: Record<string, string> = {};
  if (auth) headers["Authorization"] = auth;
  const res = await fetch(`${PROXY_PREFIX}${path}`, {
    method: "GET",
    headers,
    signal: opts.signal,
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearStoredMasterKey();
      if (
        typeof window !== "undefined" &&
        !window.location.pathname.startsWith("/login")
      ) {
        const next = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.href = `/login?next=${next}`;
      }
    }
    // Read the body as text so non-JSON error pages (e.g. proxy 502) don't
    // throw inside JSON.parse — the route itself returns JSON on error but
    // upstream infra might not.
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text, text || `sandbox_logs ${res.status}`);
  }
  return res.text();
}

// ---------- Vault interceptions (credential swap debugger) ----------
//
// Type definitions are in `src/lib/vault-types.ts` so the server-side k8s
// helper imports the same shapes. The import + re-export at the top of this
// file keeps callers using `import { VaultInterception } from "@/lib/api"`.

/**
 * Fetch the vault sidecar's recent credential swaps for the sandbox pod
 * backing `sessionId`. Backend is lenient — returns `[]` for sessions
 * without a pod yet, transient k8s blips, and missing IPs. A 404 still
 * means "session row doesn't exist".
 */
export async function getSessionInterceptions(
  sessionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<VaultInterception[]> {
  const path = `/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/interceptions`;
  const auth = authHeader();
  const headers: Record<string, string> = {};
  if (auth) headers["Authorization"] = auth;
  const res = await fetch(`${PROXY_PREFIX}${path}`, {
    method: "GET",
    headers,
    signal: opts.signal,
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearStoredMasterKey();
      if (
        typeof window !== "undefined" &&
        !window.location.pathname.startsWith("/login")
      ) {
        const next = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.href = `/login?next=${next}`;
      }
    }
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text, text || `interceptions ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new ApiError(500, "", "interceptions: expected JSON array");
  }
  return body as VaultInterception[];
}

// ---------- Session messages (passthrough to harness) ----------

/**
 * Inline binary content attached to a follow-up message. Matches the server's
 * `MessageAttachment` shape — see `src/server/types.ts`. Images today; the
 * route lifts each entry into a Claude-format multimodal `image` part.
 */
export interface SendMessageAttachment {
  name?: string;
  /** MIME type, e.g. "image/png". Required so the harness can route to vision. */
  mime_type: string;
  /** Raw file bytes, base64-encoded (no `data:` prefix). */
  base64: string;
}

export interface SendMessageRequest {
  text?: string;
  parts?: HarnessMessagePart[];
  attachments?: SendMessageAttachment[];
}

export function sendMessage(
  sessionId: string,
  req: SendMessageRequest,
  init?: ApiInit,
): Promise<HarnessMessageResponse> {
  return api<HarnessMessageResponse>(
    "POST",
    `/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/message`,
    req,
    init,
  );
}

/**
 * Streaming variant — opens an SSE connection to /message_stream and yields
 * harness bus events as they arrive. The promise resolves on the `done`
 * frame (server saw `session.idle`). On `error` it rejects.
 *
 * Each `harness_event` payload is an opencode bus event of shape
 * `{ id, type, properties }`; relevant types for token streaming:
 *   - "message.part.delta"   — token-level delta on `properties.delta`
 *   - "message.part.updated" — full part replacement (use as authoritative
 *     state if you missed deltas)
 *   - "message.updated"      — message-level metadata refresh
 *   - "session.idle"         — agent loop returned (server closes after this)
 */
export interface MessageStreamFrame {
  type: "ready" | "harness_event" | "done" | "error";
  event?: { id?: string; type: string; properties?: Record<string, unknown> };
  message?: string;
}

export async function sendMessageStream(
  sessionId: string,
  req: SendMessageRequest,
  onFrame: (frame: MessageStreamFrame) => void,
  init?: ApiInit,
): Promise<void> {
  const auth = authHeader();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (auth) headers.authorization = auth;
  const res = await fetch(
    `${PROXY_PREFIX}/v1/managed_agents/sessions/${encodeURIComponent(
      sessionId,
    )}/message_stream`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal: init?.signal,
    },
  );
  if (!res.ok) {
    if (res.status === 401) clearStoredMasterKey();
    const text = await res.text().catch(() => "");
    const msg = text || res.statusText;
    throw new ApiError(res.status, msg, msg);
  }
  if (!res.body) {
    throw new ApiError(0, "stream body missing", "stream body missing");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = pending.indexOf("\n\n");
        if (idx < 0) break;
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trimStart();
          if (!raw) continue;
          let parsed: MessageStreamFrame;
          try {
            parsed = JSON.parse(raw) as MessageStreamFrame;
          } catch {
            continue;
          }
          onFrame(parsed);
          if (parsed.type === "done") return;
          if (parsed.type === "error") {
            const msg = parsed.message ?? "stream error";
            throw new ApiError(502, msg, msg);
          }
        }
      }
    }
  } finally {
    // Always release the network reader — without this an early `done` /
    // `error` exit (or a thrown ApiError) would leak the underlying stream
    // until GC. cancel() also aborts the in-flight body fetch.
    try {
      await reader.cancel();
    } catch {
      /* already cancelled or stream errored */
    }
  }
}

/**
 * Full thread for a session — proxies opencode's `GET /session/:id/message`.
 * Use this instead of relying on `sendMessage`'s return value when the UI
 * needs to render tool calls and reasoning parts: those live in earlier
 * sibling assistant messages that POST does not return.
 */
export function listSessionMessages(
  sessionId: string,
  init?: ApiInit,
): Promise<HarnessMessage[]> {
  return api<HarnessMessage[]>(
    "GET",
    `/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/messages`,
    undefined,
    init,
  );
}

// ---------- Models ----------

interface OpenAIModelListResponse {
  data: ModelRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelRow(value: unknown): ModelRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  const row: ModelRow = { id: value.id };
  if (typeof value.object === "string") row.object = value.object;
  if (typeof value.owned_by === "string") row.owned_by = value.owned_by;
  if (typeof value.created === "number") row.created = value.created;
  return row;
}

// ---------- MCP servers ----------

function parseMcpRow(value: unknown): McpRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.server_id !== "string") return null;
  const row: McpRow = { server_id: value.server_id };
  if (typeof value.server_name === "string") row.server_name = value.server_name;
  if (typeof value.alias === "string") row.alias = value.alias;
  if (typeof value.description === "string") row.description = value.description;
  if (typeof value.url === "string") row.url = value.url;
  if (typeof value.transport === "string") row.transport = value.transport;
  if (typeof value.status === "string") row.status = value.status;
  return row;
}

export async function listMcps(): Promise<McpRow[]> {
  const raw = await api<unknown>("GET", "/v1/mcp/server");
  if (!Array.isArray(raw)) return [];
  const rows: McpRow[] = [];
  for (const item of raw) {
    const parsed = parseMcpRow(item);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function parseMcpToolRow(value: unknown): McpToolRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string") return null;
  const row: McpToolRow = { name: value.name };
  if (typeof value.description === "string") row.description = value.description;
  if (isRecord(value.mcp_info)) {
    const info = value.mcp_info;
    const out: McpToolRow["mcp_info"] = {};
    if (typeof info.server_id === "string") out.server_id = info.server_id;
    if (typeof info.server_name === "string") out.server_name = info.server_name;
    if (typeof info.logo_url === "string") out.logo_url = info.logo_url;
    row.mcp_info = out;
  }
  return row;
}

/**
 * Fetch the tools exposed by a single MCP server. The proxy endpoint also
 * supports a global "everything I'm allowed to see" mode (no server_id), but
 * we always scope to one server so a slow/broken server can't block the rest
 * of the picker.
 */
export async function listMcpTools(serverId: string): Promise<McpToolRow[]> {
  const qs = `?server_id=${encodeURIComponent(serverId)}`;
  const raw = await api<unknown>("GET", `/mcp-rest/tools/list${qs}`);
  if (!isRecord(raw)) return [];
  const tools = raw.tools;
  if (!Array.isArray(tools)) return [];
  const rows: McpToolRow[] = [];
  for (const item of tools) {
    const parsed = parseMcpToolRow(item);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

// ---------- Models ----------

export async function listModels(): Promise<ModelRow[]> {
  const raw = await api<OpenAIModelListResponse | unknown>("GET", "/v1/models");
  if (!isRecord(raw)) return [];
  const data = raw.data;
  if (!Array.isArray(data)) return [];
  const rows: ModelRow[] = [];
  for (const item of data) {
    const parsed = parseModelRow(item);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

// ---------- Admin / observability ----------

export interface AdminStats {
  warm_pool: {
    configured_size: number;
    max_provisioning: number;
    ttl_minutes: number;
    recent_agent_hours: number;
    counts: {
      provisioning: number;
      warm: number;
      claimed: number;
      dead: number;
    };
    by_agent: Array<{
      agent_id: string;
      agent_name: string | null;
      provisioning: number;
      warm: number;
      claimed: number;
      dead: number;
      oldest_warm_at: string | null;
    }>;
  };
  sessions: {
    counts: {
      creating: number;
      ready: number;
      failed: number;
      dead: number;
    };
    by_agent: Array<{
      agent_id: string;
      agent_name: string | null;
      creating: number;
      ready: number;
    }>;
  };
  agents: { total: number };
  runtime: {
    namespace: string;
    harness_image: string;
    nodeport_range: string;
    container_port: number;
    reconcile_interval_seconds: number;
  };
}

export function getAdminStats(): Promise<AdminStats> {
  return api<AdminStats>("GET", "/v1/admin/stats");
}

// ---------- Templates ----------

export interface TemplateFile {
  template_path: string;
  sandbox_path: string;
  content: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  prompt: string;
  skill_name: string;
  skill: string;
  tools: string[];
  requirements: string | null;
  env_vars: Record<string, string>;
  files: TemplateFile[];
}

// ---------- Agent skill attachment ----------

export interface AttachSkillByIdRequest {
  skill_id: string;
}

export interface AttachSkillInlineRequest {
  content: string;
  name?: string;
  description?: string;
  save_to_library?: boolean;
}

export interface AttachSkillResponse {
  agent: AgentRow;
  skill?: SkillRow;
}

export function attachSkillToAgent(
  agentId: string,
  req: AttachSkillByIdRequest | AttachSkillInlineRequest,
): Promise<AttachSkillResponse> {
  return api<AttachSkillResponse>(
    "POST",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/skill`,
    req,
  );
}

/**
 * Detach ALL skills from the agent (legacy behavior). Strips every
 * `<!-- skill:<id> -->` block plus the legacy anonymous `<!-- skill -->`
 * block from the prompt.
 */
export function detachSkillFromAgent(agentId: string): Promise<{ agent: AgentRow }> {
  return api<{ agent: AgentRow }>(
    "DELETE",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/skill`,
  );
}

/** Detach a single skill by id from the agent. */
export function detachSkillById(
  agentId: string,
  skillId: string,
): Promise<{ agent: AgentRow }> {
  return api<{ agent: AgentRow }>(
    "DELETE",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/skill?skill_id=${encodeURIComponent(skillId)}`,
  );
}

// ---------- Skills ----------

export interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  content: string;
  created_at: string;
}

export interface CreateSkillRequest {
  name: string;
  description?: string;
  content: string;
}

export interface UpdateSkillRequest {
  name?: string;
  description?: string | null;
  content?: string;
}

export function listSkills(): Promise<SkillRow[]> {
  return api<{ data: SkillRow[] }>("GET", "/v1/skills").then((r) => r.data);
}

export function getSkill(id: string): Promise<SkillRow> {
  return api<SkillRow>("GET", `/v1/skills/${encodeURIComponent(id)}`);
}

export function createSkill(req: CreateSkillRequest): Promise<SkillRow> {
  return api<SkillRow>("POST", "/v1/skills", req);
}

export function updateSkill(id: string, req: UpdateSkillRequest): Promise<SkillRow> {
  return api<SkillRow>("PATCH", `/v1/skills/${encodeURIComponent(id)}`, req);
}

export function deleteSkill(id: string): Promise<void> {
  return api<void>("DELETE", `/v1/skills/${encodeURIComponent(id)}`);
}

// ---------- Integrations / Channels ----------

export interface IntegrationInstallSummary {
  install_id: string;
  workspace_id: string;
  workspace_name: string;
}

export interface IntegrationBindingSummary {
  binding_id: string;
  install_id: string;
  workspace_name: string;
  enabled: boolean;
}

export interface IntegrationSummary {
  id: string;
  display_name: string;
  icon: string;
  docs_url: string;
  /** Server has the env vars to actually use this integration. */
  enabled: boolean;
  /** Provider exposes a copy-paste app manifest (used by the wizard). */
  has_manifest: boolean;
  installs: IntegrationInstallSummary[];
  binding: IntegrationBindingSummary | null;
}

export interface ListIntegrationsResponse {
  providers: IntegrationSummary[];
}

export function listIntegrations(
  agentId?: string,
): Promise<ListIntegrationsResponse> {
  const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
  return api<ListIntegrationsResponse>("GET", `/v1/integrations${qs}`);
}

export interface IntegrationManifestResponse {
  base_url: string;
  manifest: unknown;
}

export function getIntegrationManifest(
  providerId: string,
): Promise<IntegrationManifestResponse> {
  return api<IntegrationManifestResponse>(
    "GET",
    `/v1/integrations/${encodeURIComponent(providerId)}/manifest`,
  );
}

export function bindIntegration(
  agentId: string,
  providerId: string,
  installId: string,
): Promise<IntegrationBindingSummary> {
  return api<IntegrationBindingSummary>(
    "POST",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/integrations/${encodeURIComponent(providerId)}/bind`,
    { install_id: installId },
  );
}

export function unbindIntegration(
  agentId: string,
  providerId: string,
): Promise<{ deleted: number }> {
  return api<{ deleted: number }>(
    "DELETE",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/integrations/${encodeURIComponent(providerId)}/bind`,
  );
}

// ---------- Harness response helpers ----------

/**
 * Best-effort flatten of the harness message response into a single string.
 * Used by the session thread view to display assistant turns without binding
 * to a specific harness's exact part shape.
 */
export function harnessResponseText(
  resp: HarnessMessageResponse | null | undefined,
): string {
  if (!resp) return "";
  const parts = Array.isArray(resp.parts) ? resp.parts : [];
  const out: string[] = [];
  for (const p of parts) {
    if (p && typeof p === "object" && typeof p.text === "string") {
      out.push(p.text);
    }
  }
  return out.join("");
}
