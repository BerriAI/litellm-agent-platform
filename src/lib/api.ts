/**
 * Shared API helpers for talking to a LiteLLM proxy.
 *
 * Resolution order:
 *   - Base URL: localStorage("LITELLM_PROXY_URL") || NEXT_PUBLIC_LITELLM_BASE_URL || "http://localhost:4000"
 *   - API key:  localStorage("LITELLM_API_KEY")   || NEXT_PUBLIC_LITELLM_API_KEY    || "sk-1234"
 *
 * localStorage takes precedence so a dev can override per-browser without rebuilding.
 */

const FALLBACK_PROXY = "http://localhost:4000";
const FALLBACK_KEY = "sk-1234";

export function getProxyBase(): string {
  if (typeof window !== "undefined") {
    const ls = window.localStorage.getItem("LITELLM_PROXY_URL");
    if (ls) return ls;
  }
  return process.env.NEXT_PUBLIC_LITELLM_BASE_URL || FALLBACK_PROXY;
}

export function getApiKey(): string {
  if (typeof window !== "undefined") {
    const ls = window.localStorage.getItem("LITELLM_API_KEY");
    if (ls) return ls;
  }
  return process.env.NEXT_PUBLIC_LITELLM_API_KEY || FALLBACK_KEY;
}

export function buildHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey()}`,
  };
}

export interface ListResponse<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export type MessageStatus = "in_progress" | "completed" | "failed";
export type MessageRole = "user" | "assistant";

export interface ToolCall {
  name: string;
  input?: unknown;
  output?: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  created_at: string;
  completed_at?: string;
  tools?: ToolCall[];
  model?: string;
  error_reason?: string;
}

export interface SandboxSpec {
  type: string;
  size: string;
  timeout_minutes?: number;
  idle_timeout_minutes?: number;
}

export interface RepoSpec {
  url: string;
  starting_ref: string;
  checked_out_sha?: string;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  agent_name?: string;
  sandbox: SandboxSpec;
  status: string;
  repos: RepoSpec[];
  created_by: string;
  created_at: string;
  terminated_at: string | null;
  default_model?: string;
}

export interface AgentConfig {
  model: string;
  system_prompt: string;
  tools: string[];
  litellm_api_key: string;
  litellm_base_url: string;
}

export interface AgentRow {
  id: string;
  name: string;
  config?: AgentConfig;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
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

/**
 * Static base URL resolved at module load (env var only). For runtime
 * resolution that respects localStorage overrides, call `getProxyBase()`.
 */
export const PROXY_BASE: string =
  process.env.NEXT_PUBLIC_LITELLM_BASE_URL || FALLBACK_PROXY;

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: { headers?: Record<string, string> },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    ...(init?.headers ?? {}),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${getProxyBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

// ---------- Endpoints ----------

export interface CreateAgentRequest {
  name: string;
  config: AgentConfig;
}

export function listAgents(): Promise<ListResponse<AgentRow>> {
  return api<ListResponse<AgentRow>>("GET", "/v2/agents");
}

export function getAgent(id: string): Promise<AgentRow> {
  return api<AgentRow>("GET", `/v2/agents/${encodeURIComponent(id)}`);
}

export function createAgent(req: CreateAgentRequest): Promise<AgentRow> {
  return api<AgentRow>("POST", "/v2/agents", req);
}

export function listSessions(
  limit = 100,
): Promise<ListResponse<SessionRow>> {
  return api<ListResponse<SessionRow>>("GET", `/v2/sessions?limit=${limit}`);
}

export interface CreateSessionRequest {
  agent_id: string;
  sandbox: SandboxSpec;
  repos: RepoSpec[];
  env_vars?: Record<string, string>;
}

export function createSession(req: CreateSessionRequest): Promise<SessionRow> {
  return api<SessionRow>("POST", "/v2/sessions", req);
}

export function listSessionsForAgent(
  agentId: string,
): Promise<ListResponse<SessionRow>> {
  return api<ListResponse<SessionRow>>(
    "GET",
    `/v2/agents/${encodeURIComponent(agentId)}/sessions`,
  );
}
