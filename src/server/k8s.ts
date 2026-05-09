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
  // entry in place. TLS verification is disabled because the kind apiserver
  // cert SAN won't cover the override hostname.
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
        const patched: k8s.Cluster = {
          ...cluster,
          server: override,
          skipTLSVerify: true,
          caData: undefined,
          caFile: undefined,
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

function buildContainerEnv(opts: RunTaskOpts): Array<{ name: string; value: string }> {
  const { agent, env_vars } = opts;
  const base: Record<string, string> = {
    REPO_URL: agent.repo_url ?? env.PREINSTALLED_GITHUB_REPO,
    BRANCH: agent.branch,
    LITELLM_API_KEY: env.LITELLM_API_KEY,
    LITELLM_API_BASE: env.LITELLM_API_BASE,
    LITELLM_DEFAULT_MODEL: agent.model,
    AGENT_PROMPT: agent.prompt ?? "",
    PORT: String(agent.container_port),
  };
  // Same precedence as fargate.ts buildContainerEnv: passthrough -> per-session
  // env_vars -> required base. Required keys always win.
  const merged: Record<string, string> = {
    ...env.containerEnvPassthrough,
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
              image: env.K8S_HARNESS_IMAGE,
              imagePullPolicy: env.K8S_IMAGE_PULL_POLICY,
              ports: [{ containerPort: agent.container_port }],
              env: buildContainerEnv(opts),
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
  // we don't leak a runtime pod with no host-side route.
  await customApi().createNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace: ns,
    plural: SANDBOX_PLURAL,
    body: sandbox,
  });

  try {
    // Sandbox controller stamps the pod with the Sandbox name; we mirror that
    // into the Service selector via a label the agent-sandbox controller adds
    // automatically (`agents.x-k8s.io/sandbox: <name>`). Fall back to
    // matching the pod name 1:1 since the pod is named after the Sandbox.
    const service: k8s.V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: ns, labels },
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
    await coreApi().createNamespacedService({ namespace: ns, body: service });
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
  try {
    await coreApi().deleteNamespacedService({
      name,
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

async function readNodePort(name: string): Promise<number | null> {
  try {
    const svc = await coreApi().readNamespacedService({
      name,
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

async function readPodPhase(
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
      return `http://${env.K8S_NODE_HOST}:${nodePort}`;
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

// Re-export ECS tag constants so callers that reference them (warm pool,
// reconcile) work uniformly across backends. These are unused at runtime on
// the k8s path — labels are namespaced separately above — but importing them
// from here keeps the module surface uniform with fargate.ts.
export { TAG_AGENT_ID, TAG_SESSION_ID, TAG_WARM_TASK_ID };
