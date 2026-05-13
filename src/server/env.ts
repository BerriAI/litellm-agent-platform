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
  UI_USERNAME: z.string().min(1),
  MASTER_KEY: z.string().min(8),
  K8S_NAMESPACE: z.string().min(1).default("default"),
  K8S_NODE_HOST: z.string().optional().default("host.docker.internal"),
  K8S_IMAGE_PULL_POLICY: z.enum(["Never", "IfNotPresent", "Always"]).default("Never"),
  K8S_HARNESS_IMAGE: z.string().min(1).default("opencode-sandbox:dev"),
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
  PREINSTALLED_GITHUB_REPO: z.string().min(1),
  LITELLM_API_BASE: z.string().min(1),
  LITELLM_API_KEY: z.string().min(1),
  // The harness inside the sandbox uses this to POST/GET memory endpoints
  // on this platform. Empty string disables the memory tools gracefully.
  LAP_BASE_URL: z.string().default(""),
  // Where the harness POSTs phase-progress events back to. Distinct from
  // LAP_BASE_URL so a cluster-internal address (e.g. a kube Service DNS)
  // can be used here while LAP_BASE_URL stays the external https URL the
  // memory tools were already configured against. Empty disables harness
  // phase reports — the in-sandbox curl just no-ops.
  PLATFORM_INTERNAL_URL: z.string().default(""),
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
  return {
    ...data,
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
