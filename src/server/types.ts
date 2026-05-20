/**
 * Shared backend contract.
 *
 * Every src/server/*.ts module and every route handler imports from this
 * file. The fan-out implementation rule: don't change a function name,
 * argument name, or return type defined here. If you need to, stop and
 * amend types.ts first, then re-fan-out.
 *
 * The Prisma row types (Agent, Session) are re-exported from @prisma/client
 * — that's the canonical shape. API request/response shapes are the wire
 * contract with src/lib/api.ts (frontend) and must stay drop-in compatible
 * with what the existing UI sends.
 */

import type { Agent, Memory, Session, WarmTask } from "@prisma/client";
import { z } from "zod";
import { decrypt, encrypt } from "@/server/integrations/core/crypto";
import type { SessionOrigin } from "@/server/integrations/core/origin";
import { SenderBody } from "@/server/integrations/core/sender";
import { parseAttachedSkillIds } from "@/server/skill-prompt";

// ============================================================================
// DB row types (re-export from Prisma, do not redefine)
// ============================================================================

export type AgentRow = Agent;
export type SessionRow = Session;
export type WarmTaskRow = WarmTask;
export type MemoryRow = Memory;

export type SessionStatus = "creating" | "ready" | "failed" | "dead";
export type WarmTaskStatus = "provisioning" | "warm" | "claimed" | "dead";

/**
 * Closed set of bring-up phase values written to `Session.phase`. The
 * platform owns the pod-spawn phases (everything up to and including
 * `harness_ready`); the in-sandbox harness owns the container-side phases
 * (`cloning_repo`, `installing_deps`, `harness_listening`). The
 * /sessions/{id}/phase endpoint whitelists the harness-side subset so the
 * sandbox can't write arbitrary states.
 *
 * Kept as a string union (not a TS enum) so it serialises cleanly to JSON
 * and survives Prisma's `String?` column without an additional mapping
 * layer.
 */
export type SessionPhase =
  | "creating_sandbox"
  | "pod_pending"
  | "pod_running"
  | "injecting_files"
  | "waiting_harness"
  | "harness_ready"
  | "cloning_repo"
  | "installing_deps"
  | "harness_listening"
  | "ready";

// ============================================================================
// Env var validation constants — shared by CreateAgentBody + CreateSessionBody
// ============================================================================
/**
 * Keys reserved by the harness runtime. Agent-level and per-session `env_vars`
 * cannot override any of these — the route returns 400 if a caller tries.
 *
 * `GIT_TOKEN` is reserved because the entrypoint uses it for clone-and-wipe
 * semantics: the token is erased from the env after `git clone` so the LLM
 * can't exfiltrate it. Callers that need a token persistent at runtime
 * (e.g. for `gh pr create` or `git push`) must use `GITHUB_TOKEN` /
 * `GH_TOKEN` instead — those flow through to the agent shell.
 */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "REPO_URL",
  "BRANCH",
  "LITELLM_API_KEY",
  "LITELLM_API_BASE",
  "LITELLM_DEFAULT_MODEL",
  "AGENT_PROMPT",
  "PORT",
  "GIT_TOKEN",
  "AGENT_REQUIREMENTS",
]);

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_VARS_MAX_KEYS = 50;
export const ENV_VARS_MAX_BYTES = 16_384;

// ============================================================================
// ============================================================================
// Sandbox file injection
// ============================================================================

/** One file to be written into the sandbox container at session start. */
export interface SandboxFileSpec {
  name: string;
  sandbox_path: string;
  content: string;      // base64-encoded
  content_type: string;
  size: number;
}

const SandboxFileSpecSchema = z.object({
  name: z.string().min(1),
  sandbox_path: z.string().min(1).regex(/^[~/]/, "sandbox_path must start with / or ~"),
  content: z.string().min(1),
  content_type: z.string().default("application/octet-stream"),
  size: z.number().int().min(0),
});

const SANDBOX_FILES_MAX_COUNT = 20;
const SANDBOX_FILES_MAX_TOTAL_B64 = 10 * 1024 * 1024; // 10 MB of base64

// ============================================================================
// API request schemas (zod) — handlers parse with these
// ============================================================================

export const CreateAgentBody = z.object({
  name: z.string().optional(),
  model: z.string().min(1),
  prompt: z.string().optional(),
  tools: z.array(z.unknown()).default([]),
  // Which harness binary the Fargate container runs. Picks the task
  // definition family — opencode (default) or claude-agent-sdk. Kept open
  // as `string` so adding a third harness is a one-line env change.
  harness_id: z.string().optional(),
  /** pip requirements.txt content — injected as AGENT_REQUIREMENTS and installed at harness boot. */
  requirements: z.string().optional(),
  repo_url: z.string().url().optional(),
  branch: z.string().optional(),
  pfp_url: z.string().optional(),
  mcp_servers: z.array(z.string()).default([]),
  allow_out: z.array(z.string()).default([]),
  deny_out: z.array(z.string()).default([]),
  sandbox_files: z
    .array(SandboxFileSpecSchema)
    .max(SANDBOX_FILES_MAX_COUNT, `sandbox_files: max ${SANDBOX_FILES_MAX_COUNT} files`)
    .default([])
    .refine(
      (files) => (files as SandboxFileSpec[]).reduce((sum, f) => sum + f.content.length, 0) <= SANDBOX_FILES_MAX_TOTAL_B64,
      { message: `sandbox_files: total base64 size must be ≤ 10 MB` },
    ),
  /**
   * Library skills to attach at create time. Each becomes a
   * `<!-- skill:<id> -->` block appended to `prompt` (via appendSkillBlock)
   * and is materialized inside the sandbox as `~/.claude/skills/<slug>/SKILL.md`
   * on session boot. Caller must own every skill_id — unknown or foreign
   * IDs cause a 404 (same pattern as the single-skill attach route).
   */
  skill_ids: z.array(z.string().min(1)).optional(),
  /**
   * Agent-level env vars persisted to the DB and injected into every
   * session container. Same constraints as CreateSessionBody.env_vars.
   * Use for long-lived secrets like GITHUB_TOKEN or API keys the agent
   * always needs. Per-session env_vars (from CreateSessionBody) take
   * precedence over these when both are present for the same key.
   */
  env_vars: z
    .record(z.string().regex(ENV_VAR_NAME_RE, "invalid env var name"), z.string())
    .optional()
    .refine((v) => !v || Object.keys(v).length <= ENV_VARS_MAX_KEYS, {
      message: `env_vars: max ${ENV_VARS_MAX_KEYS} keys`,
    })
    .refine((v) => !v || JSON.stringify(v).length <= ENV_VARS_MAX_BYTES, {
      message: `env_vars: total size must be ≤ ${ENV_VARS_MAX_BYTES} bytes`,
    })
    .refine(
      (v) => !v || !Object.keys(v).some((k) => RESERVED_ENV_KEYS.has(k)),
      {
        message: `env_vars cannot override reserved keys: ${[...RESERVED_ENV_KEYS].join(", ")}`,
      },
    ),
});
export type CreateAgentBody = z.infer<typeof CreateAgentBody>;

export const UpdateAgentBody = z.object({
  name: z.string().optional(),
  pfp_url: z.string().optional(),
  mcp_servers: z.array(z.string()).optional(),
  harness_image: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().min(1).optional(),
  branch: z.string().optional(),
  /**
   * How many memories get pre-loaded into AGENT_PROMPT (top-by-priority).
   * Pinned rows always-include on top of this, capped server-side. Bounded
   * here so a runaway value can't blow up the prompt.
   */
  preload_memory_limit: z.number().int().min(0).max(50).optional(),
  /**
   * Replace the agent's env_vars map. Same constraints as the CreateAgentBody
   * version: max keys, max byte size, reserved keys blocked. The PATCH route
   * encrypts each value before persisting (mirrors the create flow).
   */
  env_vars: z
    .record(z.string().regex(ENV_VAR_NAME_RE, "invalid env var name"), z.string())
    .optional()
    .refine((v) => !v || Object.keys(v).length <= ENV_VARS_MAX_KEYS, {
      message: `env_vars: max ${ENV_VARS_MAX_KEYS} keys`,
    })
    .refine((v) => !v || JSON.stringify(v).length <= ENV_VARS_MAX_BYTES, {
      message: `env_vars: total size must be ≤ ${ENV_VARS_MAX_BYTES} bytes`,
    })
    .refine(
      (v) => !v || !Object.keys(v).some((k) => RESERVED_ENV_KEYS.has(k)),
      {
        message: `env_vars cannot override reserved keys: ${[...RESERVED_ENV_KEYS].join(", ")}`,
      },
    ),
});
export type UpdateAgentBody = z.infer<typeof UpdateAgentBody>;

export const CreateSkillBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string().min(1),
});
export type CreateSkillBody = z.infer<typeof CreateSkillBody>;

export const UpdateSkillBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  content: z.string().min(1).optional(),
});
export type UpdateSkillBody = z.infer<typeof UpdateSkillBody>;

export interface ApiSkill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  created_at: string;
}

export function toApiSkill(row: { skill_id: string; name: string; description: string | null; content: string; created_at: Date }): ApiSkill {
  return {
    id: row.skill_id,
    name: row.name,
    description: row.description,
    content: row.content,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Hard cap per attachment when starting a session. Anything bigger is a
 * 400 — Claude's per-request total is 32 MB across all content blocks and
 * base64 inflates payload size by ~33%.
 */
export const INITIAL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const INITIAL_ATTACHMENTS_MAX_COUNT = 10;
/** Supported MIME types for inline binary content on session create. Today
 *  just images — vision-only; not parsing PDFs or other formats yet. */
const INITIAL_ATTACHMENT_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const InitialAttachment = z.object({
  name: z.string().max(255).optional(),
  mime_type: z
    .string()
    .refine((m) => INITIAL_ATTACHMENT_ALLOWED_MIME.has(m), {
      message: `mime_type must be one of: ${[...INITIAL_ATTACHMENT_ALLOWED_MIME].join(", ")}`,
    }),
  base64: z
    .string()
    .min(1)
    .refine(
      (s) => {
        // Rough size check: 4 base64 chars ≈ 3 bytes, so length * 0.75 ≈ bytes.
        return s.length * 0.75 <= INITIAL_ATTACHMENT_MAX_BYTES;
      },
      { message: `attachment exceeds ${INITIAL_ATTACHMENT_MAX_BYTES} bytes` },
    ),
});

export const CreateSessionBody = z.object({
  initial_prompt: z.string().optional(),
  title: z.string().optional(),
  /**
   * Binary content (images today) attached to `initial_prompt`. Sent to the
   * harness as Claude-format multimodal parts alongside the text. Used by
   * integrations (e.g. Slack image uploads) so the agent can reason about
   * pictures the user pasted. Each entry's `base64` is the raw file bytes —
   * server-side only, never persisted, never logged by value.
   */
  initial_attachments: z
    .array(InitialAttachment)
    .max(INITIAL_ATTACHMENTS_MAX_COUNT)
    .optional(),
  /**
   * Identity of the human who sent the message in the originating medium.
   * Populated by the integrations dispatcher (Slack today) so the agent can
   * @-mention the user back. The route prepends a one-line `[from: …]`
   * header to `initial_prompt` before sending it to the harness; see
   * `src/server/integrations/core/sender.ts`.
   *
   * Optional — direct API / UI callers don't set this and the prompt
   * passes through unchanged.
   */
  sender: SenderBody.optional(),
  /**
   * Per-session env vars forwarded into the harness shell at Sandbox CR
   * create time. Use for short-lived secrets like `GITHUB_TOKEN` or
   * `CIRCLECI_TOKEN`. Never persisted to the database, never logged by value.
   *
   * Constraints (each is a 400 if violated):
   *   - max 50 keys
   *   - total JSON-encoded size ≤ 16 KB
   *   - key names match /^[A-Za-z_][A-Za-z0-9_]*$/
   *   - keys cannot intersect `RESERVED_ENV_KEYS`
   */
  env_vars: z
    .record(z.string().regex(ENV_VAR_NAME_RE, "invalid env var name"), z.string())
    .optional()
    .refine((v) => !v || Object.keys(v).length <= ENV_VARS_MAX_KEYS, {
      message: `env_vars: max ${ENV_VARS_MAX_KEYS} keys`,
    })
    .refine((v) => !v || JSON.stringify(v).length <= ENV_VARS_MAX_BYTES, {
      message: `env_vars: total size must be ≤ ${ENV_VARS_MAX_BYTES} bytes`,
    })
    .refine(
      (v) => !v || !Object.keys(v).some((k) => RESERVED_ENV_KEYS.has(k)),
      {
        message: `env_vars cannot override reserved keys: ${[...RESERVED_ENV_KEYS].join(", ")}`,
      },
    ),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const SendMessageBody = z.object({
  text: z.string().optional(),
  parts: z.array(z.record(z.string(), z.unknown())).optional(),
  /**
   * Inline binary content (images today) attached to `text`. Same shape and
   * caps as `CreateSessionBody.initial_attachments` — see that field for the
   * rationale. The route lifts each entry into a Claude-format multimodal
   * `image` part alongside the text, mirroring `runInitialPrompt`. Mutually
   * exclusive with `parts` (caller picks one path).
   */
  attachments: z
    .array(InitialAttachment)
    .max(INITIAL_ATTACHMENTS_MAX_COUNT)
    .optional(),
  /**
   * Same `IntegrationSender` shape forwarded by the dispatcher on follow-up
   * messages — see `CreateSessionBody.sender`. The route prepends a
   * `[from: …]` header to `text` so every turn carries the author identity
   * (Slack threads can have multiple participants, and the agent shouldn't
   * have to guess who's writing now).
   *
   * Ignored when only `parts` is set (UI callers explicitly building
   * harness parts opt out of header injection).
   */
  sender: SenderBody.optional(),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;
export type MessageAttachment = z.infer<typeof InitialAttachment>;

// Memory bodies — see src/server/memory.ts for the model.
// `source` is set by the handler (slack/ui/agent depending on the entry
// point), not the caller, so it's not in the body.
export const CreateMemoryBody = z.object({
  text: z.string().min(1, "text required"),
  tags: z.array(z.string()).max(8).optional(),
  type: z.string().optional(),
  priority: z.number().int().optional(),
  pinned: z.boolean().optional(),
  source: z.enum(["agent", "slack", "ui"]).optional(),
  source_user_id: z.string().optional(),
  source_session_id: z.string().optional(),
  source_thread_ts: z.string().optional(),
});
export type CreateMemoryBody = z.infer<typeof CreateMemoryBody>;

export const UpdateMemoryBody = z.object({
  text: z.string().min(1).optional(),
  tags: z.array(z.string()).max(8).optional(),
  type: z.string().optional(),
  priority: z.number().int().optional(),
  pinned: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
export type UpdateMemoryBody = z.infer<typeof UpdateMemoryBody>;

// ============================================================================
// API response shapes — keep field names identical to frontend src/lib/api.ts
// (drop-in compatibility). `id` aliases the Prisma PK; `created_at` is ISO.
// ============================================================================

export interface ApiAgent {
  id: string;
  name: string | null;
  model: string;
  prompt: string | null;
  harness_id: string;
  /**
   * Derived from `harness_id` via `TUI_HARNESSES`. True for harnesses
   * that expose a PTY over `/tty` (e.g. `claude-code`, `codex`), which
   * the `lap` CLI / browser terminal can attach to. False for HTTP-only
   * programmatic harnesses (`opencode`, `claude-agent-sdk`). The CLI
   * wizard reads this to filter the agent picker.
   */
  supports_tui: boolean;
  repo_url: string | null;
  branch: string;
  pfp_url: string | null;
  mcp_servers: string[];
  env_vars: Record<string, string>;
  /**
   * IDs of skills currently attached to this agent, in attach order.
   * Parsed from `<!-- skill:<id> -->` markers in `prompt`. Empty array
   * when the agent has no skills (or only the legacy anonymous marker).
   */
  attached_skill_ids: string[];
  allow_out: string[];
  deny_out: string[];
  sandbox_files: SandboxFileSpec[];
  /**
   * Max non-pinned memories preloaded into AGENT_PROMPT at session start.
   * Pinned memories are always-included on top of this, capped server-side
   * by MAX_PINNED_PRELOAD. Editable per-agent on /agents/:id/memory.
   */
  preload_memory_limit: number;
  created_at: string;
}

export interface ApiMemory {
  id: string;
  agent_id: string;
  text: string;
  tags: string[];
  type: string;
  priority: number;
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

export interface ApiSession {
  id: string;
  agent_id: string;
  sandbox_url: string | null;
  // Browser-accessible WebSocket base URL for TUI harnesses.
  // - IN_CLUSTER deployments: a relative path routed through the platform's
  //   TCP proxy (server-proxy.mjs) so the browser never dials the
  //   cluster-internal sandbox DNS directly.
  // - Local dev (not IN_CLUSTER): null — the session view derives the URL
  //   from sandbox_url (the NodePort address the browser can reach).
  // Null while the session is still creating (sandbox_url not yet set).
  tty_url: string | null;
  // Bearer token for the harness's `/tty` WebSocket. Populated only for TUI
  // harnesses (claude-code, codex) where the harness pod requires
  // authentication on the WS upgrade. The browser session view and the
  // `lap` CLI both append this as `?token=…` when connecting.
  tty_token: string | null;
  status: SessionStatus | string;
  task_arn: string | null;
  response: HarnessMessageResponse | null;
  created_at: string;
  // Last user message activity. Null until the first POST /message bumps it;
  // the UI falls back to `created_at` for the idle countdown when null.
  last_seen_at: string | null;
  // Idle window after which the reconciler reaps a `ready` sandbox. Sent
  // alongside last_seen_at so the UI shows an accurate countdown without
  // hardcoding the constant.
  idle_timeout_ms: number;
  // Populated when status flips to `failed`. The UI surfaces this verbatim
  // on the session page so the user can see why bring-up died instead of
  // staring at a stuck "creating" spinner.
  failure_reason: string | null;
  // Fine-grained bring-up phase. Null on legacy rows created before the
  // phase column existed; the UI falls back to wall-clock thresholds when
  // null. See `SessionPhase` for the closed set of values.
  phase: string | null;
  // Optional human-readable detail for the current phase. Rendered as a
  // small subtitle under the active step in the spawn-progress card.
  phase_detail: string | null;
  // Present when the session was created by an integration webhook
  // (Slack DM/@-mention, Linear assign, etc.) rather than the LAP UI.
  // The session view renders a banner at the top with a deep link back
  // to the originating thread. Null for UI-originated sessions.
  origin: SessionOrigin | null;
  // First user-message text from the session thread, truncated. The sidebar
  // uses this as a row label so users can recognise sessions by content
  // instead of opaque short-ids. Null on brand-new sessions where no user
  // turn has been recorded yet — the UI falls back to `Session {shortId}`.
  title_preview: string | null;
}

// Admin / observability — wire shape returned by GET /api/v1/admin/stats.
// The settings page renders this; keep field names stable so the UI doesn't
// drift on a backend rename.
export interface ApiAdminStats {
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
  agents: {
    total: number;
  };
  runtime: {
    namespace: string;
    harness_image: string;
    container_port: number;
    reconcile_interval_seconds: number;
  };
}

export interface ApiDockerfile {
  id: string;
  container_port: number;
}

export interface HarnessMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface HarnessMessageResponse {
  parts?: HarnessMessagePart[];
  [key: string]: unknown;
}

/**
 * One entry from opencode's `GET /session/:id/message`. Each user prompt may
 * spawn multiple assistant messages within the agent loop (tool call, then
 * text reply, etc.) — POST /session/:id/message returns only the final one,
 * so to render reasoning + tool parts the UI has to read the full list.
 */
export interface HarnessMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | string;
  [key: string]: unknown;
}

export interface HarnessMessage {
  info: HarnessMessageInfo;
  parts: HarnessMessagePart[];
}

// ============================================================================
// Module signatures — fan-out agents implement against these.
// ============================================================================

// ---- src/server/env.ts ----
export interface ServerEnv {
  DATABASE_URL: string;
  UI_USERNAME: string;
  MASTER_KEY: string;
  // HMAC signing key for per-pod agent tokens. Defaults to MASTER_KEY at
  // env-load time when unset; see src/server/auth/agent-token.ts.
  HARNESS_TOKEN_SIGNING_KEY: string;
  K8S_NAMESPACE: string; // default "default"
  // Hostname the web container reaches the kind/k8s node on. For local dev
  // with kind + docker-compose this is "host.docker.internal" (mapped via
  // extra_hosts). For in-cluster deployments leave blank to use Pod IP.
  K8S_NODE_HOST: string;
  // Image pull policy for Sandbox pods. "Never" for local kind-loaded images,
  // "IfNotPresent" or "Always" for registry-backed images.
  K8S_IMAGE_PULL_POLICY: "Never" | "IfNotPresent" | "Always";
  // Per-harness container images. K8S_HARNESS_IMAGE is the fallback default
  // (used when a harness-specific var is absent). Set K8S_HARNESS_IMAGE_OPENCODE
  // and K8S_HARNESS_IMAGE_CLAUDE_SDK to route each harness to its own ECR image.
  K8S_HARNESS_IMAGE: string;
  K8S_HARNESS_IMAGE_OPENCODE?: string;
  K8S_HARNESS_IMAGE_CLAUDE_SDK?: string;
  K8S_HARNESS_IMAGE_CLAUDE_CODE?: string;
  K8S_HARNESS_IMAGE_CODEX?: string;
  // Image for the vault sidecar that runs alongside the harness in each
  // Sandbox pod. Defaults to "vault:dev" (the kind-loaded local image);
  // production deploys point this at a registry-published image.
  K8S_VAULT_IMAGE: string;
  // Optional override for the kubeconfig cluster server URL. Use when the
  // active kubeconfig points at a host the running process can't reach
  // (e.g. kubeconfig has 127.0.0.1 but the web container needs to dial
  // host.docker.internal). Empty = use kubeconfig as-is.
  K8S_API_SERVER: string;
  // Explicit opt-in (truthy "true") to skip TLS verification on the
  // patched kubeconfig cluster entry. Only takes effect when K8S_API_SERVER
  // is non-empty. Required for kind/local-dev because the kind apiserver
  // cert SAN won't cover host.docker.internal. Defaults to false so a
  // production deploy that overrides the API server URL still validates
  // certs.
  K8S_SKIP_TLS_VERIFY: boolean;
  // true when web/worker run inside EKS — enables pod-DNS routing, disables NodePort creation
  IN_CLUSTER: string;
  PREINSTALLED_GITHUB_REPO: string;
  LITELLM_API_BASE: string;
  LITELLM_API_KEY: string;
  /**
   * Base URL the in-sandbox harness uses to call back into this platform —
   * specifically the agent memory endpoints. Empty string means the memory
   * tools are unavailable to the harness (graceful no-op), which is fine for
   * local dev without the kind cluster pointed at the host. In prod, set to
   * the Render external URL (e.g. https://litellm-agent-platform.onrender.com).
   * In docker-compose dev, "http://host.docker.internal:3000" reaches the host.
   */
  LAP_BASE_URL: string;
  /**
   * URL that an in-sandbox harness uses to POST progress events back to the
   * platform's /sessions/{id}/phase endpoint. Distinct from LAP_BASE_URL
   * because the harness-side reports may need to reach the platform on a
   * cluster-internal address (e.g. `http://litellm-agent-platform.default.svc:3000`)
   * while LAP_BASE_URL is the external https URL the memory tools rely on.
   * Empty string disables harness phase reports (the curl just no-ops).
   */
  PLATFORM_INTERNAL_URL: string;
  LOCAL_SANDBOX_URL: string | undefined;
  CONTAINER_PORT: number; // default 4096
  RECONCILE_INTERVAL_SECONDS: number; // default 60
  // Warm pool. WARM_POOL_SIZE = 0 disables the feature entirely; default of
  // 2 keeps two tasks ready for the most-recently-active agent so users
  // get sub-5s session creates out of the box.
  WARM_POOL_SIZE: number;
  WARM_POOL_MAX_PROVISIONING: number; // default 2
  WARM_POOL_TTL_MINUTES: number; // default 30
  WARM_POOL_RECENT_AGENT_HOURS: number; // default 24

  /**
   * All process.env entries whose key starts with `CONTAINER_ENV_`, with
   * the prefix stripped. Passed verbatim into every sandbox container's
   * `env[]` at Sandbox CR create time.
   */
  containerEnvPassthrough: Record<string, string>;
}
// must export: `export const env: ServerEnv`

// ---- src/server/db.ts ----
// must export: `export const prisma: PrismaClient` (HMR-safe singleton)

// ---- src/server/auth.ts ----
/**
 * Bearer auth: header is `Authorization: Bearer <MASTER_KEY>`. UI collects
 * the key at /login and stashes it in localStorage. Constant-time compare
 * against `env.MASTER_KEY`.
 *
 * On miss, throws a Response (401). On hit, returns a stable user_id used
 * for the `created_by` audit column — currently fixed to "ui" since v0 is
 * single-tenant.
 */
export type AuthIdentity = { user_id: string };

// must export:
//   export function assertAuth(req: Request): AuthIdentity
//   export function expectedBearer(): string  // for tests / debugging

// ---- src/server/harness.ts ----
export interface HarnessCreateSessionOpts {
  sandbox_url: string; // http://<task_ip>:<container_port>
  title?: string;
  prompt?: string;
  files?: SandboxFileSpec[];
  timeout_ms?: number;
}

export interface HarnessSendMessageOpts {
  sandbox_url: string;
  harness_session_id: string;
  model: string;
  parts: HarnessMessagePart[];
  timeout_ms?: number;
}

// must export:
//   export function expandMessage(text?: string, parts?: HarnessMessagePart[]): HarnessMessagePart[]
//   export async function harnessCreateSession(opts: HarnessCreateSessionOpts): Promise<string> // returns harness_session_id
//   export async function harnessSendMessage(opts: HarnessSendMessageOpts): Promise<HarnessMessageResponse>

// ---- src/server/k8s.ts ----
//
// Exactly one of `session_id` or `warm_task_id` must be set. Both end up as
// labels on the Sandbox CR so the reconciler can attribute it back to the
// right DB row when sweeping.
export interface RunTaskOpts {
  agent: AgentRow;
  session_id?: string;
  warm_task_id?: string;
  /**
   * Per-session env vars to forward into the harness container alongside the
   * required `base` keys and the global `containerEnvPassthrough`. Required
   * keys cannot be clobbered (see `buildContainerEnv` precedence). Values are
   * never logged or persisted.
   */
  env_vars?: Record<string, string>;
}

// `task_arn` here is the Sandbox CR name — kept as `task_arn` for symmetry
// with prior naming and the unified reconciler shape.
export interface TaggedTask {
  task_arn: string;
  session_id: string | null;
  agent_id: string | null;
  warm_task_id: string | null;
  last_status: string; // RUNNING | PENDING | STOPPED | UNKNOWN
  // Sandbox CRs only carry `creationTimestamp`; we project it onto both
  // fields so the reconciler's grace-window math is single-sourced.
  created_at: Date | null;
  started_at: Date | null;
}

// must export (every function async):
//   export async function runTask(opts: RunTaskOpts): Promise<{ task_arn: string }>
//   export async function stopTask(task_arn: string, reason?: string): Promise<void>
//   export async function waitRunningGetUrl(task_arn: string, agent: AgentRow, timeout_ms?: number): Promise<string>
//   export async function waitHttpReady(sandbox_url: string, timeout_ms?: number): Promise<void>
//   export async function listTaggedTasks(): Promise<TaggedTask[]>

// ---- src/server/reconcile.ts ----
export interface ReconcileResult {
  inspected: number;
  stopped: number;
  failed_creating: number;
  idle_killed: number;
  // Warm-pool sweeps. Counts warm-labelled Sandbox CRs whose DB row is gone
  // or terminal — non-zero usually means an operator or migration deleted
  // a warm row out from under the worker.
  warm_orphans_stopped: number;
  // Ready Sessions whose backing Sandbox CR vanished (deleted externally —
  // OOM, eviction, manual delete). Flipped to `dead` so send_message stops
  // hammering a dead URL.
  ghost_killed: number;
  // Warm task DB rows whose pod no longer exists — e.g. leftover from a
  // pre-fix deployment that created pods without HARNESS_AUTH_TOKEN, then had
  // their Sandboxes deleted. Marked dead so topUpWarmPool reprovisions them
  // with the correct env.
  warm_stale_killed: number;
}

// must export:
//   export async function reconcileOrphans(): Promise<ReconcileResult>
//   export async function stopSessionsForAgent(agent_id: string): Promise<number>

// ============================================================================
// HTTP error helper used by every route handler
// ============================================================================

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

export function httpError(status: number, detail: unknown): never {
  throw new HttpError(status, detail);
}

// ============================================================================
// Row → API mappers (one source of truth so all handlers agree)
// ============================================================================

/** Encrypt each value in an env vars map before persisting. */
export function encryptEnvVars(
  vars: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, encrypt(v)]),
  );
}

/** Decrypt each value in a stored env vars map. Skips entries that fail to decrypt. */
function decryptEnvVars(stored: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored)) {
    try {
      result[k] = decrypt(String(v));
    } catch {
      // Skip corrupted/wrong-key entries rather than dropping all vars.
    }
  }
  return result;
}

export function toApiAgent(row: AgentRow): ApiAgent {
  const rawEnvVars =
    row.env_vars &&
    typeof row.env_vars === "object" &&
    !Array.isArray(row.env_vars)
      ? (row.env_vars as Record<string, unknown>)
      : {};
  return {
    id: row.agent_id,
    name: row.agent_name ?? null,
    model: row.model,
    prompt: row.prompt ?? null,
    harness_id: row.harness_id,
    supports_tui: harnessSupportsTui(row.harness_id),
    repo_url: row.repo_url ?? null,
    branch: row.branch,
    pfp_url: row.pfp_url ?? null,
    mcp_servers: Array.isArray(row.mcp_servers)
      ? (row.mcp_servers as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [],
    env_vars: decryptEnvVars(rawEnvVars),
    attached_skill_ids: parseAttachedSkillIds(row.prompt),
    allow_out: Array.isArray(row.allow_out) ? (row.allow_out as string[]) : [],
    deny_out: Array.isArray(row.deny_out) ? (row.deny_out as string[]) : [],
    sandbox_files: Array.isArray((row as Record<string, unknown>).sandbox_files)
      ? ((row as Record<string, unknown>).sandbox_files as SandboxFileSpec[])
      : [],
    preload_memory_limit: row.preload_memory_limit,
    created_at: row.created_at.toISOString(),
  };
}

export function toApiMemory(row: MemoryRow): ApiMemory {
  return {
    id: row.memory_id,
    agent_id: row.agent_id,
    text: row.text,
    tags: row.tags,
    type: row.type,
    priority: row.priority,
    pinned: row.pinned,
    disabled: row.disabled,
    times_applied: row.times_applied,
    last_applied_at: row.last_applied_at ? row.last_applied_at.toISOString() : null,
    source: row.source,
    source_user_id: row.source_user_id ?? null,
    source_session_id: row.source_session_id ?? null,
    source_thread_ts: row.source_thread_ts ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// Hard cap on the sidebar title preview. Long enough to be recognisable
// across the agent's typical first prompts, short enough that the sidebar
// stays compact on a small viewport.
const TITLE_PREVIEW_MAX_LENGTH = 60;

/**
 * Pull the first user-message text from the cached harness thread snapshot
 * and trim it for the sidebar label. The `history` column on `Session` is
 * the canonical opencode thread shape: `[{info: {role, ...}, parts: [...]}, ...]`
 * — we walk user-role entries in order, concatenate their text-typed parts,
 * and return the first non-empty one truncated to TITLE_PREVIEW_MAX_LENGTH.
 *
 * Pure non-text user turns (e.g. an image upload with no caption, a
 * tool_result on the user side) are skipped — we keep scanning so a later
 * text turn still produces a useful label. Returns null only when no user
 * turn in the thread carries any text at all (brand-new session, or a
 * thread that is image-only end-to-end). Caller falls back to the short-id.
 */
function extractTitlePreview(history: unknown): string | null {
  if (!Array.isArray(history)) return null;
  for (const msg of history) {
    if (!msg || typeof msg !== "object") continue;
    const info = (msg as { info?: unknown }).info as
      | { role?: unknown }
      | undefined;
    if (!info || info.role !== "user") continue;
    const parts = (msg as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter(
        (p): p is { type: string; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("")
      .trim();
    // Skip image-only / tool-result-only user turns and keep scanning — the
    // next user turn's caption is a better label than the short-id fallback.
    if (!text) continue;
    // Collapse internal whitespace so multi-line prompts render on one line
    // without trailing "\n" artefacts.
    const oneLine = text.replace(/\s+/g, " ");
    return oneLine.length > TITLE_PREVIEW_MAX_LENGTH
      ? `${oneLine.slice(0, TITLE_PREVIEW_MAX_LENGTH - 1)}…`
      : oneLine;
  }
  return null;
}

export function toApiSession(
  row: SessionRow,
  response: HarnessMessageResponse | null = null,
  origin: SessionOrigin | null = null,
): ApiSession {
  // tty_token comes from the shared HARNESS_AUTH_TOKEN env var the platform
  // also propagates into sandbox pods (via CONTAINER_ENV_HARNESS_AUTH_TOKEN
  // passthrough). Clients connecting to the harness's /tty WS need to send
  // the same value as ?token=…. Returned unconditionally because the master
  // key required to read this response already grants admin access; per-
  // session token minting is a follow-up.
  const ttyToken =
    process.env.HARNESS_AUTH_TOKEN?.trim() ||
    process.env.CONTAINER_ENV_HARNESS_AUTH_TOKEN?.trim() ||
    null;

  // tty_url: browser-accessible WS base URL for TUI harnesses.
  // IN_CLUSTER: sandbox_url is cluster-internal (*.svc.cluster.local) and
  // unreachable from the browser. Return a relative path that the platform's
  // TCP proxy (server-proxy.mjs) handles by piping raw TCP to the sandbox.
  // Not IN_CLUSTER (local dev): sandbox_url is a NodePort address the browser
  // can reach directly; return null so the session view derives it client-side.
  const ttyUrl: string | null = (() => {
    if (!row.sandbox_url || row.status !== "ready") return null;
    if (process.env.IN_CLUSTER === "true") {
      return `/api/v1/managed_agents/sessions/${row.session_id}/tty`;
    }
    return null;
  })();

  return {
    id: row.session_id,
    agent_id: row.agent_id,
    sandbox_url: row.sandbox_url ?? null,
    tty_url: ttyUrl,
    tty_token: ttyToken,
    status: row.status,
    task_arn: row.task_arn ?? null,
    response:
      response ??
      (row.response && typeof row.response === "object"
        ? (row.response as HarnessMessageResponse)
        : null),
    created_at: row.created_at.toISOString(),
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    idle_timeout_ms: SESSION_IDLE_TIMEOUT_MS,
    failure_reason: row.failure_reason ?? null,
    phase: row.phase ?? null,
    phase_detail: row.phase_detail ?? null,
    origin,
    title_preview: extractTitlePreview(row.history),
  };
}

// ============================================================================
// Constants
// ============================================================================

export const TAG_SESSION_ID = "litellm_session_id";
export const TAG_AGENT_ID = "litellm_agent_id";
export const TAG_WARM_TASK_ID = "litellm_warm_task_id";
export const HARNESS_OPENCODE = "opencode";
export const HARNESS_CLAUDE_SDK = "claude-agent-sdk";
// TUI harnesses — pod exposes /tty (WebSocket) instead of the JSON message API.
// The session view attaches xterm.js directly.
export const HARNESS_CLAUDE_CODE = "claude-code";
export const HARNESS_CODEX = "codex";
export const HARNESS_HERMES = "hermes";
export const HARNESS_GEMINI = "gemini";
export const TUI_HARNESSES: ReadonlySet<string> = new Set([
  HARNESS_CLAUDE_CODE,
  HARNESS_CODEX,
  HARNESS_HERMES,
  HARNESS_GEMINI,
]);

/** True when the harness exposes a PTY over `/tty` (see `TUI_HARNESSES`). */
export function harnessSupportsTui(harness_id: string): boolean {
  return TUI_HARNESSES.has(harness_id);
}
export const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
  HARNESS_OPENCODE,
  HARNESS_CLAUDE_SDK,
  HARNESS_CLAUDE_CODE,
  HARNESS_CODEX,
  HARNESS_HERMES,
  HARNESS_GEMINI,
]);

// Resolves the container image for a harness at runtime from env vars.
// Called at session-creation time (not agent-creation time) so image updates
// take effect immediately without recreating agents.
// env is imported lazily to avoid circular deps — pass it in from the call site.
export function resolveHarnessImage(
  harness_id: string,
  harnessEnv: {
    K8S_HARNESS_IMAGE: string;
    K8S_HARNESS_IMAGE_OPENCODE?: string;
    K8S_HARNESS_IMAGE_CLAUDE_SDK?: string;
    K8S_HARNESS_IMAGE_CLAUDE_CODE?: string;
    K8S_HARNESS_IMAGE_CODEX?: string;
    K8S_HARNESS_IMAGE_HERMES?: string;
    K8S_HARNESS_IMAGE_GEMINI?: string;
  },
): string {
  const map: Record<string, string | undefined> = {
    [HARNESS_CLAUDE_SDK]: harnessEnv.K8S_HARNESS_IMAGE_CLAUDE_SDK,
    [HARNESS_OPENCODE]: harnessEnv.K8S_HARNESS_IMAGE_OPENCODE,
    [HARNESS_CLAUDE_CODE]: harnessEnv.K8S_HARNESS_IMAGE_CLAUDE_CODE,
    [HARNESS_CODEX]: harnessEnv.K8S_HARNESS_IMAGE_CODEX,
    [HARNESS_HERMES]: harnessEnv.K8S_HARNESS_IMAGE_HERMES,
    [HARNESS_GEMINI]: harnessEnv.K8S_HARNESS_IMAGE_GEMINI,
  };
  // `||` (not `??`): an empty string for a per-harness var must also fall
  // back to the global default. Otherwise an accidentally-blanked secret
  // entry (e.g. K8S_HARNESS_IMAGE_CLAUDE_CODE="") returns "" here and the
  // Sandbox CR is created with image="", which k8s rejects with
  // `spec.containers[0].image: Required value` on every session create.
  return map[harness_id] || harnessEnv.K8S_HARNESS_IMAGE;
}

export const SESSION_CREATING_TIMEOUT_MS = 600_000;
// Ready sessions with no message activity (last_seen_at) older than this are
// reaped by the reconciler — keeps cluster footprint bounded for forgotten tabs.
export const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_NEW_TASK_GRACE_MS = 300_000;
