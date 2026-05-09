# Render

Web + worker on Render. Sandbox cluster is external (Render does not
host k8s) — point at EKS or GKE. Kubeconfig ships as a base64 env var,
written to disk on container start.

## One-click

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BerriAI/litellm-agent-platform)

Provisions Postgres + LiteLLM proxy + web + worker from
[`render.yaml`](../../render.yaml). After the blueprint applies, fill in
the `sync: false` env vars on the dashboard:

| Var                  | Value                                                  |
|----------------------|--------------------------------------------------------|
| `ANTHROPIC_API_KEY`  | (litellm-proxy service)                                |
| `OPENAI_API_KEY`     | (litellm-proxy service, optional)                      |
| `KUBE_CONFIG_B64`    | base64 of stripped kubeconfig (web + worker)           |
| `K8S_NODE_HOST`      | node IP / LB hostname reachable from Render egress     |
| `K8S_HARNESS_IMAGE`  | registry path of `opencode-sandbox:<tag>`              |

For manual setup or self-hosted Render, see [§Manual setup](#manual-setup).

## Manual setup

## Stack

| Component        | Service                                                  |
|------------------|----------------------------------------------------------|
| `web`            | Render Web Service, this repo                            |
| `worker`         | Render Background Worker, this repo                      |
| `postgres`       | Render Postgres (or external Neon / Supabase)            |
| `litellm-proxy`  | Render Web Service, `ghcr.io/berriai/litellm:main-stable` |
| `sandbox-runtime`| External EKS or GKE — see [`../aws/`](../aws/) or [`../gcp/`](../gcp/) |

Prereqs: Render account, a running EKS/GKE cluster with the
agent-sandbox controller (see [shared notes](../README.md#cluster-prerequisites-every-target)),
a kubeconfig that authenticates to it.

## Steps

1. **Provision Postgres.** Render dashboard → New → Postgres. Copy the
   *internal* connection string into `DATABASE_URL`.

2. **Provision LiteLLM proxy.** New Web Service from
   `ghcr.io/berriai/litellm:main-stable`. Starter plan or higher
   (free tier sleeps). Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
   Note the public URL → `LITELLM_API_BASE`.

3. **Encode kubeconfig.** Strip the kubeconfig down to the one cluster
   web/worker need, then base64 it:
   ```bash
   kubectl config view --minify --flatten --context <ctx> | base64 | tr -d '\n'
   ```
   Paste into `KUBE_CONFIG_B64` on both web and worker.

4. **Create web service.** New Web Service from this repo.
   ```
   Build:  npm ci && npx prisma generate && npm run build
   Pre-deploy: npx prisma migrate deploy
   Start:  echo "$KUBE_CONFIG_B64" | base64 -d > /tmp/kubeconfig && KUBECONFIG=/tmp/kubeconfig npm start
   Health: /api/health
   ```
   Env: see [§Env](#env). `PORT` is set by Render.

5. **Create worker.** New Background Worker, same repo.
   ```
   Build:  npm ci && npx prisma generate
   Start:  echo "$KUBE_CONFIG_B64" | base64 -d > /tmp/kubeconfig && KUBECONFIG=/tmp/kubeconfig npm run worker
   ```
   Same env as web.

6. **Verify.** Tail web logs after first deploy:
   ```bash
   render logs --service <web-service-id> --tail
   ```
   First sandbox spawn produces a `Sandbox` CR — confirm with
   `kubectl get sandbox -A`.

## Env

```ini
DATABASE_URL=
MASTER_KEY=
UI_USERNAME=admin
LITELLM_API_BASE=https://<your-litellm>.onrender.com
LITELLM_API_KEY=
LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6

KUBE_CONFIG_B64=                  # base64 of stripped kubeconfig
K8S_NAMESPACE=default
K8S_NODE_HOST=                    # public IP/host of a cluster node or LB
K8S_API_SERVER=                   # leave blank — kubeconfig has it
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=30099
K8S_IMAGE_PULL_POLICY=IfNotPresent
K8S_HARNESS_IMAGE=<registry>/opencode-sandbox:<tag>

PREINSTALLED_GITHUB_REPO=
WARM_POOL_SIZE=2
```

## Gotchas

- **Free tier kills the proxy.** Sleeping LiteLLM blows first-call
  latency. Use Starter or higher for the proxy service.
- **Render Background Workers can't accept HTTP.** Don't try to expose
  the worker — it's outbound-only.
- **Egress IP is unpinned.** If the cluster's apiserver / NodePort range
  is behind a strict allowlist, buy Render's static-egress add-on or
  front the cluster with a public LB.
- **Kubeconfig token rotation.** Short-lived tokens (e.g. `aws eks
  get-token`) won't work — bake a static service-account token into the
  kubeconfig, or use Render's secret rotation.
- **NodePort reachability.** Web/worker hit `K8S_NODE_HOST:<port>` for
  every sandbox URL. That host needs the NodePort range open from
  Render's egress. Use a public LB targeting node ports if nodes are
  private.
