# Kubernetes sandbox backend

The sandbox backend. Managed-agent sandboxes run as [kubernetes-sigs/agent-sandbox] `Sandbox` CRs; the controller owns the underlying pod.

[kubernetes-sigs/agent-sandbox]: https://github.com/kubernetes-sigs/agent-sandbox

## Why Kubernetes

- Portable across local kind, EKS, GKE, AKS, on-prem.
- Pod-level resource isolation, RBAC, network policies are off-the-shelf.
- gVisor / Kata isolation available via the CRD's `runtimeClass` field (not wired up today).
- No cloud-provider lock-in for the sandbox runtime path.

## Architecture

```
src/app/api/v1/managed_agents/.../route.ts
                │
                ▼
        src/server/k8s.ts
                │
        Sandbox CR + Service
        delete CR + Service
        NodePort + K8S_NODE_HOST
        listNamespacedCustomObject
```

Per-session resources:

- **`Sandbox`** custom resource (`agents.x-k8s.io/v1alpha1`). The agent-sandbox controller owns the underlying `Pod`, including stable identity and lifecycle. Naming: `s-<session-id-compact>` for sessions, `w-<warm-task-id-compact>` for warm-pool entries.
- **`Service`** of type `NodePort`. Selector is our own `litellm-sandbox-name` label (the controller's `agents.x-k8s.io/sandbox-name-hash` is opaque, so we set our own selector via `podTemplate.metadata.labels`).
- Labels on both: `litellm-session-id` / `litellm-warm-task-id` / `litellm-agent-id`. `listTaggedTasks` filters on these.

`task_arn` in the cross-cutting contract maps to the Sandbox CR name. `stopTask(name)` deletes the CR and its Service.

## URL exposure

Web/worker need a host-reachable URL per pod. Pod IPs (`10.244.x`) live inside the CNI overlay and aren't routable from the host or from the docker-compose network. We expose each sandbox via a NodePort Service:

- `bin/kind-up.sh` opens host port mappings for `K8S_NODEPORT_MIN .. MAX` on the kind node (default `30000-30099`).
- Same range is pinned in the kube-apiserver via `--service-node-port-range` so k8s only allocates inside the window.
- `waitRunningGetUrl` reads the assigned `nodePort` and returns `http://${K8S_NODE_HOST}:${nodePort}`. Default `K8S_NODE_HOST` is `host.docker.internal` (works inside compose), or `127.0.0.1` for `next dev` directly on the host.

The window caps concurrent live sandboxes at 100. For higher fan-out, swap to a ClusterIP + ingress topology — out of scope for this iteration.

## Local setup

Prereqs: `kind`, `kubectl`, `helm`, `docker`, the harness image `opencode-sandbox:dev` available locally.

```bash
bin/kind-up.sh
```

Idempotent. Creates a kind cluster `agent-sbx` with:

- API server pinned at `https://127.0.0.1:6444` (host) / `https://host.docker.internal:6444` (container side).
- NodePort range 30000-30099 enforced via kubeadm config + extraPortMappings.
- agent-sandbox `v0.4.5` controller installed.
- Local `opencode-sandbox:dev` loaded into the cluster.

`.env` variables:

| var | example | meaning |
|---|---|---|
| `K8S_HARNESS_IMAGE` | `opencode-sandbox:dev` | image used for sandbox pods |
| `K8S_IMAGE_PULL_POLICY` | `Never` | use `Never` for kind-loaded local images |
| `K8S_NAMESPACE` | `default` | namespace for Sandbox CRs |
| `K8S_NODEPORT_MIN` | `30000` | low end of NodePort window |
| `K8S_NODEPORT_MAX` | `30099` | high end of NodePort window |
| `K8S_NODE_HOST` | `host.docker.internal` | host the URL points at; use `127.0.0.1` for `next dev` |
| `K8S_API_SERVER` | `https://host.docker.internal:6444` | override apiserver URL in-process (compose only) |
| `K8S_SKIP_TLS_VERIFY` | `false` | explicit opt-in to skip cert validation when `K8S_API_SERVER` is set; required for kind, NEVER for prod |

Tear down:

```bash
kind delete cluster --name agent-sbx
```

## docker-compose integration

`docker-compose.yml` mounts `~/.kube` read-only into web/worker and adds `host.docker.internal` to `extra_hosts` (Docker Desktop adds this automatically; Linux compose needs the alias). `KUBECONFIG=/root/.kube/config` inside the container points at the mounted kubeconfig.

When the kubeconfig server URL is unreachable from the container (kind writes `127.0.0.1` which inside compose loops back to the container itself), `K8S_API_SERVER` overrides the cluster server URL in-process via `KubeConfig.loadFromOptions`. Cert validation against the override URL is **only** disabled when `K8S_SKIP_TLS_VERIFY=true` is also set — required for kind because the apiserver cert SAN won't cover an arbitrary override hostname. **Never set `K8S_SKIP_TLS_VERIFY=true` against a prod cluster.**

## Hot-path cache

`POST /sessions/:id/message` used to hit Postgres twice on every request: a `findUnique` (with `agent` JOIN) to resolve the sandbox URL and a `session.update` to bump `last_seen_at` for idle reaping. Against Neon this added ~350ms per message — measured, not assumed.

[`src/server/sessionCache.ts`](../src/server/sessionCache.ts) removes both:

- **Read-side**: process-local `Map<session_id, SessionCacheEntry>`. On miss the cache hydrates from the DB once and stores `sandbox_url`, `harness_session_id`, `agent_id`, `agent_model`. Routes that mutate session state (`agents/[id]/session`, `sessions/[id]/restart`, `sessions/[id]/route.ts` DELETE) call `putCachedSession` / `invalidateSession` so the cache stays consistent without polling.
- **Write-side**: `markSessionSeen` writes to a `Map<session_id, Date>` in memory. A 5s `setInterval` flushes the highest-watermark timestamp per session in a single `prisma.$transaction` of `update` calls. The reconciler reads `last_seen_at` from the DB, so worst-case staleness for the idle-sweep clock is `FLUSH_INTERVAL_MS` (5s) — three orders of magnitude under `SESSION_IDLE_TIMEOUT_MS` (24h).

Cache is process-local. Multiple web replicas each hold their own state; last_seen writes converge at flush time. The map has a soft cap of 10 000 entries with oldest-first eviction so a long-running web process doesn't grow unbounded.

Net result: hot path is `auth → cache hit → opencode HTTP → in-memory mark → return`. No DB calls. Web overhead falls from ~350ms to <1ms.

## Spawn-time perf

The spawn path (`POST /agents/:id/session`) goes through several phases. Real numbers from single-node kind on M-series with the harness image already loaded:

| Phase                  | Time      | Notes                                |
|------------------------|-----------|--------------------------------------|
| `runTask`              | ~115ms    | Sandbox CR + Service create          |
| `update task_arn`      | ~100ms    | Neon RTT                             |
| `waitRunningGetUrl`    | ~1-2s     | pod schedule + IP + NodePort assign  |
| `waitHttpReady`        | **~8-11s**| dominated by opencode boot           |
| `harnessCreateSession` | ~85ms     | POST opencode `/session`             |
| `update ready`         | ~200-700ms| Neon RTT                             |
| **Cold total**         | **10-12s**|                                      |

`waitHttpReady` is the bottleneck. Inside opencode boot:

- `git clone --depth 1` of the agent's repo (~5-7s for a 7k-file repo).
- `opencode serve` launch + sqlite migration (~3-4s).

Three knobs to bring this down:

1. **Tighter polls** (already applied). `k8s.ts` polls pod state every 200ms and HTTP every 250ms. Saves up to 2-3s of dead air after opencode binds.
2. **Pre-baked image**. Bake the agent's repo into the harness image so `git clone` is skipped at boot. ~5-7s saved.
3. **Warm pool** (`WARM_POOL_SIZE > 0`). Pre-spun pods sit `ready` in the cluster; `claimWarmTask` hands one to the request, so spawn becomes `Neon SELECT FOR UPDATE (~150ms) + harnessCreateSession (~85ms)` ≈ **~1.8s** end-to-end. Measured.

The warm path is the only way to hit sub-2s consistently. Cold spawn will always include opencode boot.

## Pod resource requests

[`src/server/k8s.ts`](../src/server/k8s.ts) requests `100m` CPU / `256Mi` memory per sandbox pod, with limits at `1` CPU / `1Gi`. Opencode is mostly idle between LLM round-trips; a single-node kind cluster (4 vCPU) fits ~30 idle sandboxes plus warm-pool capacity at this sizing. Bursts can grab the full CPU limit while a session is mid-LLM-call.

When the cluster is short on CPU, warm-pool pods stay `Pending` (`FailedScheduling: Insufficient cpu`). Reap stale session pods first:

```bash
kubectl get sandbox -L litellm-session-id
kubectl delete sandbox <name>          # CR delete cleans up the pod
```

## Reconciliation

`src/server/reconcile.ts` consumes the `TaggedTask` shape from `listTaggedTasks` and stops anything whose DB row is gone, dead, stuck creating, idle past the timeout, or ghost (DB says ready but no live task).

`last_status` is projected from Sandbox phase:

| Sandbox phase      | last_status |
|--------------------|-------------|
| `Running`          | `RUNNING`   |
| `Pending`          | `PENDING`   |
| `Succeeded` / `Failed` | `STOPPED` |
| anything else      | `UNKNOWN`   |

Sandbox CRs don't track a separate started-at timestamp, so `started_at = creationTimestamp` in the unified shape. The reconciler's grace-window math single-sources off this.

## Trade-offs and gaps

- **gVisor / Kata not wired up.** The agent-sandbox CRD supports a runtime class field; we don't set it today. Adding it is a small podSpec patch when needed.
- **NodePort range capped at 100** by `bin/kind-up.sh`. For higher fan-out, switch to ClusterIP + an ingress controller and use hostname-based routing. Code in `k8s.ts` would change `Service.spec.type` and the URL construction.
- **No persistent storage.** Sandbox CRD supports persistent volumes; we don't use them. opencode session state is ephemeral by design today.
- **`K8S_SKIP_TLS_VERIFY=true` skips TLS verify** on the patched cluster URL. Acceptable for local kind, never set against a real cluster. Defaults to `false` so an override-only `K8S_API_SERVER` keeps full cert validation.
- **Cache is process-local.** Multi-replica deployments converge at flush time, not instantly. Acceptable while idle-sweep granularity is hours; revisit if it ever becomes seconds.

## Files

- [`src/server/k8s.ts`](../src/server/k8s.ts) — Kubernetes implementation of the sandbox contract.
- [`src/server/sessionCache.ts`](../src/server/sessionCache.ts) — hot-path read cache + batched `last_seen_at` flusher.
- [`src/server/types.ts`](../src/server/types.ts) — `TaggedTask` and `K8S_*` env contract.
- [`src/server/env.ts`](../src/server/env.ts) — required-fields validation.
- [`bin/kind-up.sh`](../bin/kind-up.sh) — local kind cluster bootstrap.
- [`k8s/opencode-sandbox.yaml`](../k8s/opencode-sandbox.yaml) — manual smoke-test Sandbox CR.
- [`docker-compose.yml`](../docker-compose.yml) — kubeconfig mount + host.docker.internal alias.
