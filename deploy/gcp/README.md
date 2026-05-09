# GCP

Web + worker on Cloud Run. Sandbox cluster is GKE Autopilot in the same
project. Workload Identity binds the Cloud Run service account to a
Kubernetes service account so the platform authenticates to the cluster
without a kubeconfig on disk.

## Stack

| Component        | Service                                                  |
|------------------|----------------------------------------------------------|
| `web`            | Cloud Run service (public)                               |
| `worker`         | Cloud Run service (no ingress, `min-instances=1`)        |
| `postgres`       | Cloud SQL Postgres                                       |
| `litellm-proxy`  | Cloud Run, `ghcr.io/berriai/litellm:main-stable`         |
| `sandbox-runtime`| GKE Autopilot                                            |

Prereqs: `gcloud`, `kubectl`, `gke-gcloud-auth-plugin`. `$PROJECT`,
`$REGION` set via `gcloud config set`.

## Steps

1. **Provision GKE Autopilot.**
   ```bash
   gcloud container clusters create-auto litellm-agents \
     --region "$REGION" --release-channel=regular
   gcloud container clusters get-credentials litellm-agents --region "$REGION"
   ```

2. **Install agent-sandbox controller.**
   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.5/manifest.yaml
   kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
   ```

3. **Push harness image to Artifact Registry.**
   ```bash
   AR=$REGION-docker.pkg.dev/$PROJECT/litellm
   gcloud artifacts repositories create litellm --location="$REGION" --repository-format=docker
   gcloud auth configure-docker "$REGION-docker.pkg.dev"
   docker tag opencode-sandbox:dev "$AR/opencode-sandbox:latest"
   docker push "$AR/opencode-sandbox:latest"
   ```

4. **Set up Workload Identity.** Cloud Run runs web/worker as a Google
   SA; bind cluster access to it:
   ```bash
   gcloud iam service-accounts create litellm-platform
   gcloud projects add-iam-policy-binding "$PROJECT" \
     --member="serviceAccount:litellm-platform@$PROJECT.iam.gserviceaccount.com" \
     --role="roles/container.developer"
   ```
   The GKE auth plugin in-container exchanges the metadata-server token
   for a cluster token automatically.

5. **Front NodePort range with internal LB.** Autopilot doesn't expose
   node IPs. Apply a `LoadBalancer` Service annotated
   `networking.gke.io/load-balancer-type: "Internal"` covering
   `K8S_NODEPORT_MIN..MAX`, or run an ingress controller (gce, contour)
   for hostname-based routing past the 100-port window. Point
   `K8S_NODE_HOST` at its IP.

6. **Provision Cloud SQL.**
   ```bash
   gcloud sql instances create litellm-agents --database-version=POSTGRES_16 --region="$REGION" --tier=db-custom-2-7680
   gcloud sql databases create litellm_agents --instance=litellm-agents
   ```

7. **Deploy web/worker.**
   ```bash
   SA=litellm-platform@$PROJECT.iam.gserviceaccount.com
   SQL=$PROJECT:$REGION:litellm-agents
   gcloud run deploy web --source . --service-account=$SA \
     --add-cloudsql-instances=$SQL --set-env-vars-from-file=.env.web --region="$REGION"
   gcloud run deploy worker --source . --service-account=$SA \
     --add-cloudsql-instances=$SQL --set-env-vars-from-file=.env.worker --region="$REGION" \
     --no-allow-unauthenticated --min-instances=1 --max-instances=1
   ```

8. **Verify.** `gcloud run services logs tail web`, `kubectl get sandbox -A`.

## Env

```ini
DATABASE_URL=postgres://litellm:...@/litellm_agents?host=/cloudsql/<conn>
MASTER_KEY=
UI_USERNAME=admin
LITELLM_API_BASE=https://litellm-proxy-<hash>.run.app
LITELLM_API_KEY=
LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6

K8S_NAMESPACE=default
K8S_NODE_HOST=<internal-lb-ip>
K8S_API_SERVER=                   # leave blank — gke-gcloud-auth-plugin handles it
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=30099
K8S_IMAGE_PULL_POLICY=IfNotPresent
K8S_HARNESS_IMAGE=<region>-docker.pkg.dev/<project>/litellm/opencode-sandbox:latest

PREINSTALLED_GITHUB_REPO=
WARM_POOL_SIZE=2
```

## Gotchas

- **No host port mapping on Autopilot.** You don't own the nodes; a
  kind-style `K8S_NODE_HOST=<node-ip>` won't work. Always front the
  NodePort range with an internal LB or ingress.
- **Worker `min-instances=1`.** Cloud Run scales to zero by default; a
  sleeping worker means no reconciler ticks.
- **Cloud SQL socket.** Cloud Run uses a Unix socket at `/cloudsql/<conn>`.
  Don't reach the public IP.
- **Workload Identity propagation.** New bindings take 1-2 min to land
  in cluster auth. First post-binding deploy may 401 — wait, redeploy.
- **Autopilot CPU floors.** Smallest pod is 250m / 512Mi; the harness's
  `100m` request is silently bumped. Plan capacity tighter than on
  self-managed.
