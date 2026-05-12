/**
 * Kubernetes sandbox lifecycle. Mirrors src/server/fargate.ts so the routing
 * layer doesn't care which backend is in use — see src/server/sandbox.ts for
 * the dispatcher.
 *
 * Backend model:
 *   - Each sandbox is an `agents.x-k8s.io/v1alpha1.Sandbox` CR plus a sibling
 *     NodePort `Service` that exposes the harness on a host-reachable port.
 *   - Names are deterministic from session_id / warm_task_id so reconcile can
 *     match a Sandbox back to a DB row even after a server restart. Long
 *     session_ids are truncated; the full id is preserved as a label so
 *     listTaggedTasks can recover it.
 *   - `task_arn` in the cross-backend contract maps to the Sandbox CR name.
 *     stopTask deletes the Sandbox (controller cleans up pods), and the
 *     sibling Service is deleted alongside.
 *
 * URL exposure:
 *   - kind clusters bind NodePorts on a host-side range when started with
 *     `extraPortMappings` (see bin/kind-up.sh). The web container reaches the
 *     pod via `http://${K8S_NODE_HOST}:${nodePort}` — host.docker.internal
 *     when running under docker-compose.
 */

import * as k8s from "@kubernetes/client-node";
import { fetch } from "undici";

import { env } from "@/server/env";
import { decrypt } from "@/server/integrations/core/crypto";
import { renderMemoryBlock, topMemoriesForAgent } from "@/server/memory";
import {
  TAG_AGENT_ID,
  TAG_SESSION_ID,
  TAG_WARM_TASK_ID,
  type AgentRow,
  type RunTaskOpts,
  type TaggedTask,
} from "@/server/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";
const CONTAINER_NAME = "harness";

// Labels mirror the ECS tags so listTaggedTasks can return a unified shape.
// Kubernetes label keys must be DNS-1123 subdomain compatible — replace the
// dotted ECS keys with `-` separators of the same prefix.
const LABEL_SESSION_ID = "litellm-session-id";
const LABEL_AGENT_ID = "litellm-agent-id";
const LABEL_WARM_TASK_ID = "litellm-warm-task-id";

// Stable selector label we stamp onto the pod template so the sibling Service
// can target the pod. The agent-sandbox controller adds its own
// `agents.x-k8s.io/sandbox-name-hash` label, but the value is a hash of the
// Sandbox name that we'd have to recompute to use as a selector — owning our
// own selector label avoids that coupling.
const LABEL_SANDBOX_NAME = "litellm-sandbox-name";

// Poll intervals tuned for local kind: pod IP and NodePort assignment
// usually settle in <500ms once the controller has scheduled the pod, so
// shorter ticks bound the tail without flooding the apiserver. Same for
// the HTTP probe — opencode boots in 5-10s and we don't want a fixed 2s
// window of dead air after it starts serving.
const POLL_RUNNING_INTERVAL_MS = 200;
const POLL_HTTP_INTERVAL_MS = 250;
const HTTP_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_RUNNING_TIMEOUT_MS = 600_000;
const DEFAULT_HTTP_READY_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Lazy clients — same pattern as fargate.ts. KubeConfig is parsed on first
// use so `next build` can evaluate route modules without a kubeconfig in
// scope. Loads from KUBECONFIG / ~/.kube/config / in-cluster service account
// in that order.
// ---------------------------------------------------------------------------

let _core: k8s.CoreV1Api | null = null;
let _custom: k8s.CustomObjectsApi | null = null;

function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  // Hosted PaaS (Render, Fly, Railway, …) usually doesn't have a
  // kubeconfig on disk. Accept a base64-encoded blob in env so the
  // platform image stays generic and the deploy artifact carries the
  // cluster credentials. Falls back to KUBECONFIG file or the default
  // kubeconfig discovery chain when unset.
  if (process.env.KUBE_CONFIG_B64) {
    const yaml = Buffer.from(process.env.KUBE_CONFIG_B64, "base64").toString(
      "utf8",
    );
    kc.loadFromString(yaml);
  } else if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    kc.loadFromDefault();
  }
  // Optional server override — used when the active kubeconfig points at a
  // host this process can't reach (e.g. compose container needs to dial
  // host.docker.internal but kubeconfig has 127.0.0.1). Patch the cluster
  // entry in place.
  //
  // TLS verification is *not* implicitly disabled — that's an explicit
  // opt-in via K8S_SKIP_TLS_VERIFY=true. The kind/local-dev case sets both
  // K8S_API_SERVER and K8S_SKIP_TLS_VERIFY together (the apiserver cert SAN
  // won't cover the override hostname). A production deploy that overrides
  // the server URL but leaves the flag unset keeps full cert validation.
  const override = env.K8S_API_SERVER;
  if (override && override.length > 0) {
    const ctx = kc.getCurrentContext();
    const ctxObj = kc.getContextObject(ctx);
    if (ctxObj?.cluster) {
      const cluster = kc.getCluster(ctxObj.cluster);
      if (cluster) {
        // The Cluster type is declared readonly by client-node. We rebuild
        // the kubeconfig with a patched cluster entry rather than mutating
        // in place, which the public type forbids.
        const skipTLS = env.K8S_SKIP_TLS_VERIFY;
        const patched: k8s.Cluster = {
          ...cluster,
          server: override,
          // Only flip skipTLSVerify / drop CA data when the operator has
          // explicitly opted in. Otherwise preserve the kubeconfig's
          // existing cert trust for the new server URL.
          ...(skipTLS
            ? { skipTLSVerify: true, caData: undefined, caFile: undefined }
            : {}),
        };
        kc.loadFromOptions({
          clusters: [
            patched,
            ...kc
              .getClusters()
              .filter((c) => c.name !== cluster.name),
          ],
          users: kc.getUsers(),
          contexts: kc.getContexts(),
          currentContext: ctx,
        });
      }
    }
  }
  return kc;
}

function coreApi(): k8s.CoreV1Api {
  if (_core === null) _core = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
  return _core;
}

function customApi(): k8s.CustomObjectsApi {
  if (_custom === null)
    _custom = loadKubeConfig().makeApiClient(k8s.CustomObjectsApi);
  return _custom;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compress a UUID-shaped id into the ≤63-char DNS-1123 label namespace
 * required by Sandbox / Service names. The full id is preserved as a label.
 */
function toName(prefix: "s" | "w", id: string): string {
  const compact = id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  // 2 + 1 (dash) + up to 50 = 53; keeps room for kubernetes-internal suffixes.
  return `${prefix}-${compact.slice(0, 50)}`;
}

/**
 * NodePort Service name. agent-sandbox controller auto-creates a headless
 * Service named after the Sandbox itself for stable DNS, so our NodePort
 * Service has to live at a different name. `-np` keeps it within the 63-
 * char DNS-1123 limit (53 + 3 = 56).
 */
function svcName(taskArn: string): string {
  return `${taskArn}-np`;
}

interface RunTaskMeta {
  name: string;
  labels: Record<string, string>;
}

function buildMeta(opts: RunTaskOpts): RunTaskMeta {
  const { agent, session_id, warm_task_id } = opts;
  if (!session_id && !warm_task_id) {
    throw new Error(
      "runTask: exactly one of session_id or warm_task_id must be set",
    );
  }
  if (session_id && warm_task_id) {
    throw new Error(
      "runTask: only one of session_id or warm_task_id may be set",
    );
  }
  const name = session_id
    ? toName("s", session_id)
    : toName("w", warm_task_id as string);
  const labels: Record<string, string> = {
    [LABEL_AGENT_ID]: agent.agent_id,
  };
  if (session_id) labels[LABEL_SESSION_ID] = session_id;
  if (warm_task_id) labels[LABEL_WARM_TASK_ID] = warm_task_id;
  return { name, labels };
}

async function buildContainerEnv(
  opts: RunTaskOpts,
): Promise<Array<{ name: string; value: string }>> {
  const { agent, env_vars, session_id } = opts;

  // Pre-load top-N memories into AGENT_PROMPT so the agent has instinctive
  // awareness from turn 1. The search_memory tool inside the harness reads
  // the live DB on demand, so any memory saved after launch is still
  // reachable mid-run — this is just the cheap "always-in-context" layer.
  const memories = await topMemoriesForAgent(agent.agent_id);
  const memoryBlock = renderMemoryBlock(memories);
  const fullPrompt = [memoryBlock, agent.prompt ?? ""].filter(Boolean).join("\n\n");

  // Phase-report wiring. The in-sandbox entrypoint POSTs to
  // {PLATFORM_URL}/api/v1/managed_agents/sessions/{SESSION_ID}/phase with
  // `Authorization: Bearer ${HARNESS_PROGRESS_TOKEN}`. Token == session_id
  // (per-session scope, no separate key management). Warm-pool tasks don't
  // yet have a session_id, so the harness falls back to a no-op if either
  // SESSION_ID or PLATFORM_URL is empty — phase reports only land once the
  // task has been claimed and reparented to a Session row, which is fine
  // because the warm path skips the pod-spawn phases anyway.
  const platformUrl = env.PLATFORM_INTERNAL_URL ?? "";
  const phaseToken = session_id ?? "";

  const base: Record<string, string> = {
    REPO_URL: agent.repo_url ?? env.PREINSTALLED_GITHUB_REPO,
    BRANCH: agent.branch,
    LITELLM_API_KEY: env.LITELLM_API_KEY,
    LITELLM_API_BASE: env.LITELLM_API_BASE,
    LITELLM_DEFAULT_MODEL: agent.model,
    AGENT_PROMPT: fullPrompt,
    PORT: String(agent.container_port),
    // For the harness's memory tools — empty LAP_BASE_URL makes the
    // tools no-op gracefully (the harness checks before registering them).
    AGENT_ID: agent.agent_id,
    LAP_BASE_URL: env.LAP_BASE_URL,
    LAP_AUTH_TOKEN: env.LAP_BASE_URL ? env.MASTER_KEY : "",
    // Harness phase-report channel (see entrypoint.sh `report_phase`).
    PLATFORM_URL: platformUrl,
    SESSION_ID: phaseToken,
    HARNESS_PROGRESS_TOKEN: phaseToken,
  };
  // Precedence (lowest → highest): passthrough → agent-level env_vars → per-session env_vars → required base.
  const rawAgentEnvVars =
    agent.env_vars &&
    typeof agent.env_vars === "object" &&
    !Array.isArray(agent.env_vars)
      ? (agent.env_vars as Record<string, string>)
      : {};
  const agentEnvVars = Object.fromEntries(
    Object.entries(rawAgentEnvVars).map(([k, v]) => [k, decrypt(v)]),
  );
  const merged: Record<string, string> = {
    ...env.containerEnvPassthrough,
    ...agentEnvVars,
    ...(env_vars ?? {}),
    ...base,
  };
  return Object.entries(merged).map(([name, value]) => ({ name, value }));
}

// ---------------------------------------------------------------------------
// runTask — create Sandbox CR + NodePort Service
// ---------------------------------------------------------------------------

interface SandboxSpec {
  podTemplate: {
    metadata?: {
      labels?: Record<string, string>;
    };
    spec: {
      restartPolicy: string;
      containers: Array<{
        name: string;
        image: string;
        imagePullPolicy: string;
        ports: Array<{ containerPort: number }>;
        env: Array<{ name: string; value: string }>;
        resources: {
          requests: { cpu: string; memory: string };
          limits: { cpu: string; memory: string };
        };
      }>;
    };
  };
}

interface SandboxResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: SandboxSpec;
}

export async function runTask(
  opts: RunTaskOpts,
): Promise<{ task_arn: string }> {
  const { agent } = opts;
  const { name, labels } = buildMeta(opts);
  const ns = env.K8S_NAMESPACE;

  const sandbox: SandboxResource = {
    apiVersion: `${SANDBOX_GROUP}/${SANDBOX_VERSION}`,
    kind: "Sandbox",
    metadata: { name, namespace: ns, labels },
    spec: {
      podTemplate: {
        metadata: {
          labels: { ...labels, [LABEL_SANDBOX_NAME]: name },
        },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: CONTAINER_NAME,
              // `task_definition_arn` is a legacy ECS column that the agent
              // creation route (POST /api/v1/managed_agents/agents) stores
              // `env.K8S_HARNESS_IMAGE` into for every new agent, making it
              // effectively a per-agent image override.  Guard against any
              // migrated row that still holds a real ECS ARN so we never
              // attempt to pull an ARN as a container image.  The column is
              // slated for removal on the next schema bump; when it is dropped,
              // replace this line with just `env.K8S_HARNESS_IMAGE`.
              image:
                agent.task_definition_arn &&
                !agent.task_definition_arn.startsWith("arn:")
                  ? agent.task_definition_arn
                  : env.K8S_HARNESS_IMAGE,
              imagePullPolicy: env.K8S_IMAGE_PULL_POLICY,
              ports: [{ containerPort: agent.container_port }],
              env: await buildContainerEnv(opts),
              resources: {
                // Opencode is mostly idle between LLM round-trips — it's a
                // thin HTTP server forwarding to the model. Right-size the
                // request so a single-node kind cluster can fit a useful
                // number of warm + active sandboxes (4 vCPU / ~6GiB usable
                // typically). Limits stay generous so a chatty session
                // burst isn't artificially throttled.
                requests: { cpu: "100m", memory: "256Mi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
            },
          ],
        },
      },
    },
  };

  // Create Sandbox first; if Service create fails we delete the Sandbox so
  // we don't leak a runtime pod with no host-side route. AlreadyExists is
  // treated as a soft success — it usually means a prior request crashed
  // mid-flight, leaving the CR behind but no DB row pointing at it. The
  // ghost reaper will eventually clean up; in the meantime we adopt the
  // existing CR rather than 409 the user.
  try {
    await customApi().createNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: ns,
      plural: SANDBOX_PLURAL,
      body: sandbox,
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }

  try {
    // Sandbox controller stamps the pod with the Sandbox name; we mirror that
    // into the Service selector via a label the agent-sandbox controller adds
    // automatically (`agents.x-k8s.io/sandbox: <name>`). Fall back to
    // matching the pod name 1:1 since the pod is named after the Sandbox.
    const service: k8s.V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: svcName(name), namespace: ns, labels },
      spec: {
        type: "NodePort",
        selector: { [LABEL_SANDBOX_NAME]: name },
        ports: [
          {
            port: agent.container_port,
            targetPort: agent.container_port,
            protocol: "TCP",
          },
        ],
      },
    };
    try {
      await coreApi().createNamespacedService({ namespace: ns, body: service });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // Same idempotency story as the Sandbox: adopt the existing
      // Service rather than fail the spawn. The selector is deterministic
      // from the Sandbox name so a pre-existing Service points at our pod.
    }
  } catch (err) {
    // Roll back the Sandbox to avoid orphans.
    await deleteSandbox(name).catch(() => {
      /* best-effort */
    });
    throw err;
  }

  return { task_arn: name };
}

// ---------------------------------------------------------------------------
// stopTask — idempotent delete of Sandbox + Service
// ---------------------------------------------------------------------------

async function deleteSandbox(name: string): Promise<void> {
  try {
    await customApi().deleteNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: env.K8S_NAMESPACE,
      plural: SANDBOX_PLURAL,
      name,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function deleteService(name: string): Promise<void> {
  // We only delete our own NodePort Service. The headless Service the
  // agent-sandbox controller stamps alongside the Sandbox is owned by
  // the CR and gets garbage-collected when the Sandbox is deleted.
  try {
    await coreApi().deleteNamespacedService({
      name: svcName(name),
      namespace: env.K8S_NAMESPACE,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: number; statusCode?: number }).code
    ?? (err as { code?: number; statusCode?: number }).statusCode;
  return code === 404;
}

function isAlreadyExists(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: number; statusCode?: number }).code
    ?? (err as { code?: number; statusCode?: number }).statusCode;
  if (code === 409) return true;
  // Some client-node versions surface the API error reason on the body
  // instead of the HTTP code (e.g. 409 wrapped in a generic Error). Cheap
  // string match keeps the fallback compatible.
  const msg = (err as { message?: string }).message ?? "";
  return msg.includes("AlreadyExists") || msg.includes("already exists");
}

export async function stopTask(
  task_arn: string,
  _reason: string = "session-ended",
): Promise<void> {
  // Reason isn't surfaced anywhere on the k8s side; the controller doesn't
  // accept a kill reason. Kept in the signature for parity with fargate.ts.
  void _reason;
  await Promise.all([deleteSandbox(task_arn), deleteService(task_arn)]);
}

// ---------------------------------------------------------------------------
// waitRunningGetUrl — wait for pod Running + read assigned NodePort
// ---------------------------------------------------------------------------

export async function readNodePort(name: string): Promise<number | null> {
  try {
    const svc = await coreApi().readNamespacedService({
      name: svcName(name),
      namespace: env.K8S_NAMESPACE,
    });
    // Newer client returns the V1Service directly; older versions wrapped in
    // `{ body }`. Handle both shapes.
    const service = (svc as unknown as { body?: k8s.V1Service }).body
      ?? (svc as k8s.V1Service);
    const port = service.spec?.ports?.[0]?.nodePort;
    return typeof port === "number" ? port : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Read the phase of the pod owned by the Sandbox CR `name`.
 *
 * Pod naming contract (kubernetes-sigs/agent-sandbox v0.4.x):
 *   Pod.Name == Sandbox.Name unless the Sandbox carries the
 *   `agents.x-k8s.io/pod-name` annotation. We don't set that annotation
 *   anywhere in this codebase (search `agents.x-k8s.io/pod-name`), so the
 *   Sandbox CR name is the pod name.
 *
 * Source:
 *   https://github.com/kubernetes-sigs/agent-sandbox/blob/main/controllers/sandbox_controller.go
 *   - resolvePodName(sandbox): returns sandbox.Name when the annotation is unset
 *   - createPodForSandbox: pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: sandbox.Name, ...}}
 *
 * If a future controller version breaks this contract, every spawn would
 * spin until DEFAULT_RUNNING_TIMEOUT_MS. The contract is verified by the
 * spawn smoke test ("First spawn lands a Sandbox + Service, reaches ready").
 */
export async function readPodPhase(
  name: string,
): Promise<{ phase: string | undefined; reason: string | undefined }> {
  try {
    const res = await coreApi().readNamespacedPod({
      name,
      namespace: env.K8S_NAMESPACE,
    });
    const pod = (res as unknown as { body?: k8s.V1Pod }).body
      ?? (res as k8s.V1Pod);
    return {
      phase: pod.status?.phase,
      reason: pod.status?.reason ?? pod.status?.message,
    };
  } catch (err) {
    if (isNotFound(err)) return { phase: undefined, reason: undefined };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Node-host discovery
//
// The sandbox URL has the shape `http://<host>:<nodePort>`. We can't pin
// `<host>` to a single node IP forever — when the EKS / GKE nodegroup
// scales or replaces a node, that IP disappears and every spawn from
// that point starts dialing a dead address.
//
// `K8S_NODE_HOST=auto` (or unset on a hosted cluster) tells us to query
// the apiserver for any Ready node's external IP at request time. The
// result is cached for NODE_HOST_TTL_MS so we don't hammer the apiserver
// — the live set rotates on the order of minutes, not seconds.
//
// On kind / docker-compose dev, `K8S_NODE_HOST=host.docker.internal` or
// `127.0.0.1` keeps the simple path: env-driven, no apiserver hop.
// ---------------------------------------------------------------------------

const NODE_HOST_TTL_MS = 30_000;
let _nodeHostCache: { host: string; expiresAt: number } | null = null;

async function discoverNodeHost(): Promise<string> {
  const now = Date.now();
  if (_nodeHostCache && _nodeHostCache.expiresAt > now) {
    return _nodeHostCache.host;
  }
  const res = await coreApi().listNode();
  const list =
    (res as unknown as { body?: k8s.V1NodeList }).body
    ?? (res as unknown as k8s.V1NodeList);
  for (const node of list.items ?? []) {
    const ready = (node.status?.conditions ?? []).find(
      (c) => c.type === "Ready",
    );
    if (ready?.status !== "True") continue;
    const addrs = node.status?.addresses ?? [];
    const ext = addrs.find((a) => a.type === "ExternalIP")?.address
      ?? addrs.find((a) => a.type === "ExternalDNS")?.address;
    if (ext) {
      _nodeHostCache = { host: ext, expiresAt: now + NODE_HOST_TTL_MS };
      return ext;
    }
  }
  throw new Error("no Ready node with ExternalIP found in cluster");
}

export async function resolveNodeHost(): Promise<string> {
  const cfg = env.K8S_NODE_HOST;
  if (!cfg || cfg === "auto") return discoverNodeHost();
  return cfg;
}

/**
 * Wait until the Sandbox's pod is Running and resolve to the host-side URL
 * the web container should hit. Mirrors fargate.ts waitRunningGetIp + URL
 * construction so callers don't need backend-specific code.
 */
export async function waitRunningGetUrl(
  task_arn: string,
  agent: AgentRow,
  timeout_ms: number = DEFAULT_RUNNING_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeout_ms;
  let nodePort: number | null = null;
  let lastReason = "";

  while (Date.now() < deadline) {
    if (nodePort === null) nodePort = await readNodePort(task_arn);

    const { phase, reason } = await readPodPhase(task_arn);
    if (phase === "Failed") {
      throw new Error(
        `pod ${task_arn} entered Failed phase: ${reason ?? "?"}`,
      );
    }
    if (phase === "Running" && nodePort !== null) {
      const host = await resolveNodeHost();
      return `http://${host}:${nodePort}`;
    }
    lastReason = `phase=${phase ?? "?"} nodePort=${nodePort ?? "?"}`;
    await sleep(POLL_RUNNING_INTERVAL_MS);
  }

  throw new Error(
    `sandbox ${task_arn} never reached Running with NodePort within ${timeout_ms}ms (last: ${lastReason})`,
  );
}

// ---------------------------------------------------------------------------
// waitHttpReady — same probe semantics as fargate.ts
// ---------------------------------------------------------------------------

export async function waitHttpReady(
  sandbox_url: string,
  timeout_ms: number = DEFAULT_HTTP_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  const probeUrl = `${sandbox_url.replace(/\/+$/, "")}/session`;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(probeUrl, {
        method: "GET",
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
      });
      if (res.status < 500) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(POLL_HTTP_INTERVAL_MS);
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `sandbox never ready at ${probeUrl} within ${timeout_ms}ms: ${detail}`,
  );
}

// ---------------------------------------------------------------------------
// listTaggedTasks — list Sandbox CRs and project to TaggedTask shape
// ---------------------------------------------------------------------------

interface SandboxListItem {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
  };
  status?: { phase?: string };
}

interface SandboxListResponse {
  items: SandboxListItem[];
}

export async function listTaggedTasks(): Promise<TaggedTask[]> {
  const res = await customApi().listNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace: env.K8S_NAMESPACE,
    plural: SANDBOX_PLURAL,
  });
  // Same body-vs-direct compatibility shim.
  const list = (res as unknown as { body?: SandboxListResponse }).body
    ?? (res as unknown as SandboxListResponse);
  const items = list.items ?? [];

  const out: TaggedTask[] = [];
  for (const item of items) {
    const name = item.metadata?.name;
    if (!name) continue;
    const labels = item.metadata?.labels ?? {};
    const created = item.metadata?.creationTimestamp
      ? new Date(item.metadata.creationTimestamp)
      : null;
    out.push({
      task_arn: name,
      session_id: labels[LABEL_SESSION_ID] ?? null,
      agent_id: labels[LABEL_AGENT_ID] ?? null,
      warm_task_id: labels[LABEL_WARM_TASK_ID] ?? null,
      // Project Sandbox phase onto the ECS-flavored status strings the
      // reconciler matches against. The reconciler treats anything not in
      // {STOPPED} as live, so coarse mapping is enough.
      last_status: phaseToStatus(item.status?.phase),
      created_at: created,
      // Sandbox CRs don't track a separate "started" timestamp; fall back to
      // creationTimestamp so reconcile's age math stays single-sourced.
      started_at: created,
    });
  }

  // ECS bookkeeping uses TAG_* prefixes via setters on TaggedTask; expose
  // the raw label constants too so callers can reuse them.
  return out;
}

function phaseToStatus(phase: string | undefined): string {
  switch (phase) {
    case "Running":
      return "RUNNING";
    case "Pending":
      return "PENDING";
    case "Succeeded":
    case "Failed":
      return "STOPPED";
    default:
      return "UNKNOWN";
  }
}

// ---------------------------------------------------------------------------
// readPodLogs — fetch stdout+stderr of the harness container so the UI can
// show a live "sandbox terminal" panel during creating-state spawns.
//
// The k8s log endpoint already merges stdout+stderr at the kubelet, so a
// single call covers both streams. `sinceSeconds` / `tailLines` keep the
// payload bounded — the UI re-polls every ~1s, and a giant historical dump
// per tick would be wasteful. Returns "" when the pod hasn't been created
// yet (the Sandbox CR exists but the controller hasn't stamped the pod, or
// the pod was already torn down) so callers can render an empty terminal
// without special-casing NotFound.
// ---------------------------------------------------------------------------

export interface ReadPodLogsOpts {
  sinceSeconds?: number;
  tailLines?: number;
  /** Bounds the K8s API call so a stuck apiserver doesn't wedge the route. */
  timeoutMs?: number;
}

const DEFAULT_LOG_TIMEOUT_MS = 10_000;

export async function readPodLogs(
  task_arn: string,
  opts: ReadPodLogsOpts = {},
): Promise<string> {
  const { sinceSeconds, tailLines, timeoutMs = DEFAULT_LOG_TIMEOUT_MS } = opts;
  // AbortSignal.timeout doesn't propagate into the kubernetes client (it
  // builds its own request). Race the call against a timeout instead so we
  // never block the request thread for more than `timeoutMs`.
  const call = coreApi().readNamespacedPodLog({
    name: task_arn,
    namespace: env.K8S_NAMESPACE,
    container: CONTAINER_NAME,
    sinceSeconds,
    tailLines,
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`readPodLogs timeout after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );
  try {
    const res = (await Promise.race([call, timeout])) as unknown;
    // Newer client-node versions return the string directly; older versions
    // wrap it in `{ body }`. Cover both.
    if (typeof res === "string") return res;
    if (res && typeof res === "object" && "body" in res) {
      const body = (res as { body?: unknown }).body;
      return typeof body === "string" ? body : "";
    }
    return "";
  } catch (err) {
    // Pod not (yet) created or already gone: return empty so the UI keeps
    // polling without rendering an error. Anything else bubbles.
    if (isNotFound(err)) return "";
    throw err;
  }
}

// Re-export ECS tag constants so callers that reference them (warm pool,
// reconcile) work uniformly across backends. These are unused at runtime on
// the k8s path — labels are namespaced separately above — but importing them
// from here keeps the module surface uniform with fargate.ts.
export { TAG_AGENT_ID, TAG_SESSION_ID, TAG_WARM_TASK_ID };
