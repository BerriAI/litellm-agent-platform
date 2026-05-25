/**
 * Parses process.env into the locked ServerEnv contract from types.ts.
 *
 * Validation is lazy — triggered on first property access, not on import.
 * `next build` evaluates route modules to collect page data without the
 * runtime .env in scope, so eager parsing made the build fail with
 * "Invalid server environment configuration". Lazy parsing keeps the same
 * fail-fast guarantee at runtime (first request) while letting builds
 * succeed in CI / Docker without secrets baked in.
 */

import { z } from "zod";
import type { ServerEnv } from "@/server/types";

const CONTAINER_ENV_PREFIX = "CONTAINER_ENV_";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  UI_USERNAME: z.string().min(1).default("admin"),
  MASTER_KEY: z.string().min(8),
  // HMAC-SHA256 signing key for per-pod agent tokens (see
  // src/server/auth/agent-token.ts). Tokens issued at pod-spawn time are
  // verified on every memory route call. Falls back to MASTER_KEY so
  // existing deployments keep working without a new env var; production
  // deployments should set this to its own random 32+ byte value.
  HARNESS_TOKEN_SIGNING_KEY: z.string().min(16).optional(),
  K8S_NAMESPACE: z.string().min(1).default("default"),
  K8S_NODE_HOST: z.string().optional().default("host.docker.internal"),
  K8S_IMAGE_PULL_POLICY: z.enum(["Never", "IfNotPresent", "Always"]).default("Never"),
  K8S_HARNESS_IMAGE: z.string().min(1).default("opencode-sandbox:dev"),
  // Per-harness overrides. `.min(1)` (combined with `.optional()`) means
  // "unset is fine, but if you set it, it must be non-empty" — protects
  // against the failure mode where an empty Secret value silently produces
  // image="" in the Sandbox CR. resolveHarnessImage() also uses `||` so an
  // empty string would fall back to K8S_HARNESS_IMAGE even if it got past
  // this gate, but failing fast at boot is clearer than that fallback.
  K8S_HARNESS_IMAGE_OPENCODE: z.string().min(1).optional(),
  K8S_HARNESS_IMAGE_CLAUDE_SDK: z.string().min(1).optional(),
  // TUI harnesses — see harnesses/claude-code/ and harnesses/codex/. The
  // session view attaches xterm.js to /tty on the pod instead of using the
  // JSON message API. Falls back to K8S_HARNESS_IMAGE if unset, like the
  // other harness vars.
  K8S_HARNESS_IMAGE_CLAUDE_CODE: z.string().min(1).optional(),
  K8S_HARNESS_IMAGE_CODEX: z.string().min(1).optional(),
  K8S_HARNESS_IMAGE_HERMES: z.string().min(1).optional(),
  K8S_HARNESS_IMAGE_GEMINI: z.string().min(1).optional(),
  K8S_HARNESS_IMAGE_EXECUTOR: z.string().min(1).optional(),
  K8S_VAULT_IMAGE: z.string().min(1).default("vault:dev"),
  K8S_API_SERVER: z.string().optional().default(""),
  // Explicit opt-in to skip TLS verification when K8S_API_SERVER is
  // overridden. Required for kind/local-dev because the kind apiserver
  // cert SAN won't cover host.docker.internal. Must remain false for any
  // production cluster — see src/server/k8s.ts loadKubeConfig().
  K8S_SKIP_TLS_VERIFY: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  // true when web/worker run inside EKS — enables pod-DNS routing, disables NodePort creation
  IN_CLUSTER: z.enum(["true", "false"]).optional().default("false"),
  PREINSTALLED_GITHUB_REPO: z.string().default(""),
  LITELLM_API_BASE: z.string().default(""),
  LITELLM_API_KEY: z.string().default(""),
  // The harness inside the sandbox uses this to POST/GET memory endpoints
  // on this platform. Empty string disables the memory tools gracefully.
  LAP_BASE_URL: z.string().default(""),
  // Where the harness POSTs phase-progress events back to. Distinct from
  // LAP_BASE_URL so a cluster-internal address (e.g. a kube Service DNS)
  // can be used here while LAP_BASE_URL stays the external https URL the
  // memory tools were already configured against. Empty disables harness
  // phase reports — the in-sandbox curl just no-ops.
  PLATFORM_INTERNAL_URL: z.string().default(""),
  // Local dev: skip K8s and route all sessions to this harness URL.
  LOCAL_SANDBOX_URL: z.string().optional(),
  // Local dev: skip K8s executor pod; route all provision calls to this Docker container.
  LOCAL_EXECUTOR_URL: z.string().optional(),
  // Shared secret used to authenticate calls to the executor pod's /execute
  // endpoint. Optional — if unset both sides skip the check so local dev
  // without K8s works out of the box. Production Sandbox CRs should always
  // set this to a randomly-generated value via the litellm-env k8s secret.
  EXECUTOR_SECRET: z.string().min(16).optional(),
  E2B_API_KEY: z.string().min(1).optional(),
  E2B_TEMPLATE: z.string().min(1).default("krrishdholakia/litellm-4gb"),
  SANDBOX_CHOICE: z.enum(["e2b"]).optional(),
  VAULT_URL: z.string().url().optional(),
  VAULT_PROXY_TOKEN: z.string().min(1).optional(),
  VAULT_CA_CRT: z.string().min(1).optional(),
  CONTAINER_PORT: z.coerce.number().int().positive().default(4096),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  // Warm pool — pre-provisioned sandbox pods waiting to be claimed by a
  // session create. Default of 2 keeps two pods ready for the most
  // recently active agent so users get sub-2s session creates out of the
  // box. Set WARM_POOL_SIZE=0 to disable.
  WARM_POOL_SIZE: z.coerce.number().int().nonnegative().default(2),
  WARM_POOL_MAX_PROVISIONING: z.coerce.number().int().positive().default(2),
  WARM_POOL_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  // Ignore agents whose last session is older than this — don't keep
  // warm pods around for an agent that hasn't been used in a long time.
  WARM_POOL_RECENT_AGENT_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24),
  // Priority agent: one agent that gets a dedicated warm-pool budget
  // independent of the shared WARM_POOL_SIZE pool. Useful for a "default
  // coding agent" that sees high traffic and needs more than 1 warm pod.
  // Set both vars to enable; omit either to disable.
  WARM_POOL_PRIORITY_AGENT_ID: z.string().optional(),
  WARM_POOL_PRIORITY_SIZE: z.coerce.number().int().positive().default(1),

  // S3 artifact storage — optional. When ARTIFACT_STORAGE="s3" and
  // AWS_S3_BUCKET is set, harness pods can POST file uploads to
  // /api/v1/managed_agents/sessions/{id}/artifacts and receive a 7-day
  // presigned URL back. Unset on existing deployments → the artifact
  // route returns 503 and the rest of the platform boots unchanged.
  ARTIFACT_STORAGE: z.enum(["s3"]).optional(),
  AWS_S3_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default("us-east-1"),
});

function collectContainerEnvPassthrough(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(CONTAINER_ENV_PREFIX)) continue;
    if (typeof value !== "string") continue;
    const stripped = key.slice(CONTAINER_ENV_PREFIX.length);
    if (stripped.length === 0) continue;
    out[stripped] = value;
  }
  return out;
}

function parseEnv(): ServerEnv {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return {} as ServerEnv;
  }
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid server environment configuration:\n${issues}\n` +
        `See .env.example for the required keys.`,
    );
  }
  const data = parsed.data;
  // Render auto-injects RENDER_EXTERNAL_URL on every web service with the
  // public https URL. Fall back to it when LAP_BASE_URL is unset so the
  // memory tools (and any future cross-service caller) auto-resolve on
  // Render without a manual dashboard env-var. Explicit LAP_BASE_URL still
  // wins for non-Render deploys or split internal/external addressing.
  if (!data.LAP_BASE_URL && process.env.RENDER_EXTERNAL_URL) {
    data.LAP_BASE_URL = process.env.RENDER_EXTERNAL_URL;
  }
  // Default the HMAC signing key for per-pod agent tokens to MASTER_KEY when
  // an operator hasn't set a dedicated value. Backward compatible: existing
  // deployments don't have to touch their env to pick up the new auth path.
  // Production deployments are still encouraged to set a separate value so
  // that rotating the master key (which the UI uses) doesn't invalidate
  // every live pod's tokens.
  // After this fallback the field is guaranteed non-empty; assert it so the
  // ServerEnv consumer doesn't carry the `string | undefined` from zod.
  const signingKey = data.HARNESS_TOKEN_SIGNING_KEY || data.MASTER_KEY;
  return {
    ...data,
    HARNESS_TOKEN_SIGNING_KEY: signingKey,
    LOCAL_SANDBOX_URL: data.LOCAL_SANDBOX_URL,
    LOCAL_EXECUTOR_URL: data.LOCAL_EXECUTOR_URL,
    containerEnvPassthrough: collectContainerEnvPassthrough(process.env),
  };
}

let _env: ServerEnv | null = null;

function getEnv(): ServerEnv {
  if (_env === null) _env = parseEnv();
  return _env;
}

export const env: ServerEnv = new Proxy({} as ServerEnv, {
  get(_target, prop) {
    return getEnv()[prop as keyof ServerEnv];
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getEnv(), prop);
  },
});
