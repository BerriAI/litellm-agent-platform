# Deploy

Sandbox runtime is Kubernetes-only via the [kubernetes-sigs/agent-sandbox]
CRD. Web/worker run on whatever PaaS you like; the cluster they talk to
is independent. See [k8s backend reference](../docs/k8s-backend.md) for
internals.

[kubernetes-sigs/agent-sandbox]: https://github.com/kubernetes-sigs/agent-sandbox

## Targets

| Target  | web/worker host        | Sandbox cluster                          | Guide |
|---------|------------------------|------------------------------------------|-------|
| Fly.io  | Fly Machines           | k3s on a Fly machine (~60s)              | [`fly/`](fly/) |
| Render  | Render Web + Worker    | external — k3s on Fly, EKS, or GKE       | [`render/`](render/) |
| Railway | Railway services       | external EKS or GKE                      | [`railway/`](railway/) |
| AWS     | ECS Fargate or App Runner | EKS Auto Mode (same account)          | [`aws/`](aws/) |
| GCP     | Cloud Run              | GKE Autopilot (same project)             | [`gcp/`](gcp/) |

Component matrix is identical on every target:

| Component        | Service type                                       |
|------------------|----------------------------------------------------|
| `web`            | long-running HTTP, Next.js standalone server       |
| `worker`         | long-running, no HTTP, runs reconciler + warm pool |
| `postgres`       | managed Postgres 14+                               |
| `litellm-proxy`  | long-running HTTP, `ghcr.io/berriai/litellm:main-stable` |
| `sandbox-runtime`| Kubernetes cluster with agent-sandbox controller   |

## Architecture

```
┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌──────────────┐
│   web    │──▶│ postgres │   │ litellm proxy│──▶│  model API   │
│ (Next.js)│   │          │   │   (gateway)  │   │              │
└────┬─────┘   └──────────┘   └──────▲───────┘   └──────────────┘
     │              ▲                │
     │              │                │
┌────▼─────┐        │         ┌──────┴───────┐
│  worker  │────────┘         │ k8s cluster  │
│ (recon.) │─── kube API ────▶│ + agent-     │
└──────────┘                  │   sandbox    │
                              │   CRD        │
                              └──────────────┘
```

Web and worker authenticate to the cluster via kubeconfig (Render,
Railway), IRSA (AWS), or Workload Identity (GCP). One Sandbox CR per
session. NodePort + `K8S_NODE_HOST` returns a host-reachable URL.

## Required env (every target)

```ini
DATABASE_URL=
MASTER_KEY=
UI_USERNAME=admin

LITELLM_API_BASE=
LITELLM_API_KEY=
LITELLM_DEFAULT_MODEL=

K8S_NAMESPACE=default
K8S_NODE_HOST=
K8S_API_SERVER=
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=30099
K8S_IMAGE_PULL_POLICY=IfNotPresent
K8S_HARNESS_IMAGE=

PREINSTALLED_GITHUB_REPO=
WARM_POOL_SIZE=2
```

`prisma migrate deploy` runs the schema. Bake into the deploy/release
step (build script, post-deploy hook, init container — provider-specific).

## Cluster prerequisites (every target)

Whatever cluster you point at must have:

1. agent-sandbox controller installed:
   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.5/manifest.yaml
   kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
   ```
2. Service NodePort range overlapping `K8S_NODEPORT_MIN..MAX`. EKS / GKE
   default 30000-32767 covers the default range out of the box.
3. Inbound TCP on the NodePort range from web/worker. `K8S_NODE_HOST`
   must resolve to a node IP / LB / ingress reachable from web.
4. Harness image (`opencode-sandbox`) pushed to a registry the cluster
   can pull from. `K8S_IMAGE_PULL_POLICY=IfNotPresent` for hosted
   clusters; `Never` only for kind with locally-loaded images.

## Notes

- **Co-locate the LiteLLM proxy.** A sleeping free-tier proxy adds
  15-30s cold-start per call. Same provider/region as web.
- **Worker must always be on.** It ticks the reconciler and the warm
  pool. Set `min_instances=1` on Cloud Run / Fly; use Background Worker
  on Render; `numReplicas: 1` on Railway.
- **Egress shape.** web/worker → kube apiserver + LiteLLM proxy.
  Sandbox pods → LiteLLM proxy + GitHub. Open both directions.
- **Prefer NodePort + ingress for hosted k8s.** Direct node IPs work
  on EKS standard; on GKE Autopilot you do not own the nodes, so a
  Service `LoadBalancer` or ingress fronting the NodePort range is
  the only stable option.
- **Never set `K8S_API_SERVER` against prod.** It overrides the
  kubeconfig server URL with `skipTLSVerify=true`. Local kind only.
