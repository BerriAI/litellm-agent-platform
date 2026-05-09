# Railway

Web + worker on Railway. Sandbox cluster is external (Railway does not
host k8s) — point at EKS or GKE. Kubeconfig ships as a base64 env var,
written to disk on container start.

## Stack

| Component        | Service                                                  |
|------------------|----------------------------------------------------------|
| `web`            | Railway service, this repo                               |
| `worker`         | Railway service (no public domain), this repo            |
| `postgres`       | Railway Postgres plugin (or external)                    |
| `litellm-proxy`  | Railway service, `ghcr.io/berriai/litellm:main-stable`   |
| `sandbox-runtime`| External EKS or GKE — see [`../aws/`](../aws/) or [`../gcp/`](../gcp/) |

Prereqs: Railway account + CLI (`brew install railwayapp/railway/railway`),
a running EKS/GKE cluster with the agent-sandbox controller (see
[shared notes](../README.md#cluster-prerequisites-every-target)).

## Steps

1. **Provision project + Postgres.**
   ```bash
   railway login
   railway init
   railway add --plugin postgresql
   ```
   Reference Postgres via `${{Postgres.DATABASE_URL}}` in the consumers.

2. **Provision LiteLLM proxy.** New service from Docker image
   `ghcr.io/berriai/litellm:main-stable`. Set `ANTHROPIC_API_KEY` /
   `OPENAI_API_KEY`. Generate a public domain. URL → `LITELLM_API_BASE`.

3. **Encode kubeconfig.**
   ```bash
   kubectl config view --minify --flatten --context <ctx> | base64 | tr -d '\n'
   ```
   Paste into `KUBE_CONFIG_B64` on web and worker.

4. **Create web service.** Connect this repo. Set custom start command:
   ```bash
   sh -c 'echo "$KUBE_CONFIG_B64" | base64 -d > /tmp/kubeconfig && \
     KUBECONFIG=/tmp/kubeconfig npx prisma migrate deploy && \
     KUBECONFIG=/tmp/kubeconfig npm start'
   ```
   Health check: `/api/health`. Generate a public domain.

5. **Create worker service.** Same repo, no domain. Start command:
   ```bash
   sh -c 'echo "$KUBE_CONFIG_B64" | base64 -d > /tmp/kubeconfig && \
     KUBECONFIG=/tmp/kubeconfig npm run worker'
   ```
   Pin `numReplicas: 1` — the reconciler is a singleton.

6. **Set shared env.** Per [§Env](#env). Use Railway shared variables
   so web + worker stay aligned (`railway variables --set ...`).

7. **Verify.** `railway logs --service web` after first deploy. Confirm
   sandbox CRs land in the cluster: `kubectl get sandbox -A`.

## Env

```ini
DATABASE_URL=${{Postgres.DATABASE_URL}}
MASTER_KEY=
UI_USERNAME=admin
LITELLM_API_BASE=https://<your-litellm>.up.railway.app
LITELLM_API_KEY=
LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6

KUBE_CONFIG_B64=
K8S_NAMESPACE=default
K8S_NODE_HOST=                    # public IP/host of a cluster node or LB
K8S_API_SERVER=
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=30099
K8S_IMAGE_PULL_POLICY=IfNotPresent
K8S_HARNESS_IMAGE=<registry>/opencode-sandbox:<tag>

PREINSTALLED_GITHUB_REPO=
WARM_POOL_SIZE=2
```

## Gotchas

- **Replica count.** Railway autoscales by default. Worker must be
  `numReplicas: 1` — multiple reconcilers fight over the same warm
  pool. Web can scale freely.
- **Egress IP unpinned.** Same as Render. Cluster apiserver behind a
  strict allowlist needs a public LB or Railway's static-egress feature.
- **Build cache.** Railway caches Nixpacks builds aggressively. After
  bumping the harness image tag, redeploy with `--no-cache` or the
  worker will keep referencing the old digest baked into env.
- **Kubeconfig staleness.** Short-lived tokens (`aws eks get-token`)
  expire. Use a long-lived service-account token bound to a Role/
  RoleBinding scoped to `K8S_NAMESPACE`.
- **Sleep mode.** Hobby-tier services sleep on idle. Worker on Hobby
  means no reconciler ticks → orphaned sandboxes. Pro plan required.
