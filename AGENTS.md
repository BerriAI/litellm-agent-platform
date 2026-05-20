<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Session UI

- **Do NOT render the raw SDK message stream in the session thread.** There must be no "Agent stream (SDK) … live" panel (`SdkStreamPanel`) in `src/app/sessions/[sid]/view.tsx`. It is visual spam — a duplicate live dump of frames the normal thread already renders. `useSdkMessageStream` stays, but only as a signal: its message count drives `refreshThread()` so external/webhook turns (Slack, etc.) paint without waiting for the poll. Never re-add the panel render.

# Vault sidecar — key exposure rules

Every sandbox pod runs a vault sidecar that MITMs all HTTPS egress via `HTTPS_PROXY`/`HTTP_PROXY=http://127.0.0.1:14322`. Understand the two paths before touching `buildContainerEnv` or `buildVaultEnv` in `src/server/k8s.ts`:

| Path | How | Harness sees | Wire carries |
|---|---|---|---|
| `buildContainerEnv` | direct string in env | **real value** | real value |
| `buildVaultEnv` as `REAL_<KEY>` | vault stubs at startup | `stub_xxx` | real value (swapped by vault) |

**Rules:**
- Platform secrets (`LITELLM_API_KEY`, any API key the harness must not display) → `buildVaultEnv` as `REAL_<KEY>`. Never put them in `buildContainerEnv`.
- After merging `containerEnvPassthrough` into the harness env, **explicitly `delete merged["KEY"]`** for any key that must be vault-stubbed. `CONTAINER_ENV_<KEY>` server vars flow through passthrough and will silently reintroduce the real value if you only omit the key from `base`.
- Setting `HTTP_PROXY` or `HTTPS_PROXY` to point at vault requires the corresponding handler in `vault/src/server.ts`. Adding a proxy env var without a server handler returns 404 to the client — not a block, not a swap, just a broken proxy.

# Harness images

Each harness type has its own container image configured via env vars. Set these in the `litellm-env` k8s secret (or `.env` for local dev):

| Env var | Harness | Default (fallback) |
|---|---|---|
| `K8S_HARNESS_IMAGE_OPENCODE` | `opencode` | value of `K8S_HARNESS_IMAGE` |
| `K8S_HARNESS_IMAGE_CLAUDE_SDK` | `claude-agent-sdk` | value of `K8S_HARNESS_IMAGE` |
| `K8S_HARNESS_IMAGE` | both (fallback) | `opencode-sandbox:dev` |

The image is **snapshotted at agent-creation time** into `task_definition_arn`. Existing agents keep their image even after the env var changes — delete and recreate the agent to pick up a new image.

To update on EKS:
```bash
kubectl patch secret litellm-env -p "{\"data\":{
  \"K8S_HARNESS_IMAGE_OPENCODE\":\"$(echo -n <image> | base64 | tr -d '\n')\",
  \"K8S_HARNESS_IMAGE_CLAUDE_SDK\":\"$(echo -n <image> | base64 | tr -d '\n')\"
}}"
# Then restart web+worker to reload env
kubectl rollout restart deployment/litellm-web deployment/litellm-worker
```

# Schema migrations (Prisma + Neon)

`DATABASE_URL` must be the **direct (non-pooled)** Neon connection string — Neon's pgbouncer pooler blocks Postgres advisory locks that `prisma migrate deploy` requires. The direct URL also works fine for app queries; pooler is purely an optimization.

On Neon: Project → Connection Details → switch the dropdown from "Pooler" to "Direct".

## Adding a new migration

```bash
# 1. Edit prisma/schema.prisma locally
# 2. Generate a named migration file (does NOT run against DB)
npx prisma migrate dev --name <migration_name> --create-only
# 3. Commit prisma/migrations/XXXX_<migration_name>/migration.sql
# 4. On next deploy, web pod startup runs: npx prisma migrate deploy
```

## Emergency: fix missing table without a deploy

> **Warning:** `db push` will DROP columns/tables removed from `schema.prisma` without a confirmation prompt. Only run against a DB you can restore, or when you are certain no columns were removed since the last deploy.

```bash
npx prisma db push --skip-generate
```

## How the web pod runs migrations

Startup command: `npx prisma migrate deploy && node server.js`

# Debugging a stuck or slow session

When investigating a session that's stuck in `creating` or that took unexpectedly long, **start with the diagnose endpoint** instead of running a dozen kubectl / curl / log queries by hand:

```
GET /api/v1/managed_agents/sessions/{session_id}/diagnose
Authorization: Bearer $MASTER_KEY
```

It returns one JSON with: the session row, agent row, pod state, Sandbox CR, NodePort Service, last 200 lines of pod logs, the node's Ready/capacity/oversubscription status, the `harness-image-prepull` DaemonSet status on that node, the warm-pool counts for the agent, and a direct harness HTTP probe via the node's ExternalIP (which bypasses the platform's `_nodeHostCache`).

Read the `detected_issues` array first. Possible codes:
- `dead_node_assigned` — pod is scheduled on a node whose Ready condition is not "True"
- `stale_node_host_cache_suspect` — pod + service + harness are all fine, but the session has been `creating` for >120s. The platform's in-process `_nodeHostCache` is almost certainly stuck on a terminated node's IP. Restart the platform service to flush.
- `pod_image_pull_backoff` — `ImagePullBackOff` / `ErrImagePull` / `ErrImageNeverPull`
- `pod_not_ready_old` — pod has been not-Ready for >180s
- `harness_unreachable` — pod Running but harness HTTP probe fails
- `node_oversubscribed` — node's allocated CPU or memory requests >150% of capacity
- `service_missing` — pod exists, no `-np` Service
- `warm_pool_empty_for_agent` — this agent has 0 warm rows and `WARM_POOL_SIZE > 0`

If `detected_issues` is empty and the session is still stuck, the bring-up is mid-flight; check Render platform logs for the session_id.

The endpoint is implemented at `src/app/api/v1/managed_agents/sessions/[session_id]/diagnose/route.ts`. Add new detection codes there as new failure patterns surface.

# Local dev on Apple Silicon

The `docker compose up` / `bin/kind-up.sh` path in the README assumes a Linux/amd64 workstation. On an arm64 Mac (M1/M2/M3) the bring-up looks like it works but the very first session create fails. The order below is what actually lands a Claude Agent SDK pod and round-trips a message against a LiteLLM gateway.

## 1. Build the harness image for arm64

The upstream `harnesses/claude-agent-sdk/Dockerfile` pins `linux_amd64` deb / `x86_64-unknown-linux-gnu` uv binaries. On Apple Silicon, build using the local arm64 variant:

```bash
docker buildx build --platform linux/arm64 \
  --provenance=false --sbom=false \
  -f harnesses/claude-agent-sdk/Dockerfile.local-arm64 \
  -t claude-agent-sdk-sandbox:dev --load .
```

`--provenance=false --sbom=false` is required: with attestation enabled, buildx emits an OCI manifest list that `kind load docker-image` accepts but the CRI plugin never indexes, so pods fail with `ErrImageNeverPull`. The flat single-arch image is the one CRI will surface.

Then set `K8S_HARNESS_IMAGE=claude-agent-sdk-sandbox:dev` in `.env` (the default is `opencode-sandbox:dev`).

## 2. Get the image visible to the CRI plugin

Even with a flat arm64 image, `kind load docker-image …` silently lands the image in containerd's content store without the `io.cri-containerd.image=managed` label that the CRI plugin requires. Symptom: `ctr -n k8s.io images ls` shows the image, `crictl images` does not, pods stay in `ErrImageNeverPull`.

The reliable workaround is a local Docker registry on the `kind` Docker network plus a containerd mirror entry:

```bash
docker run -d --restart=always --name kind-registry \
  -p 127.0.0.1:5001:5000 registry:2
docker network connect kind kind-registry

docker tag  claude-agent-sdk-sandbox:dev localhost:5001/claude-agent-sdk-sandbox:dev
docker push localhost:5001/claude-agent-sdk-sandbox:dev

REG_IP=$(docker inspect kind-registry --format \
  '{{(index .NetworkSettings.Networks "kind").IPAddress}}')

docker exec agent-sbx-control-plane bash -c "
  mkdir -p /etc/containerd/certs.d/localhost:5001 &&
  cat > /etc/containerd/certs.d/localhost:5001/hosts.toml <<EOF
[host.\"http://kind-registry:5000\"]
  capabilities = [\"pull\", \"resolve\"]
EOF
  grep -v kind-registry /etc/hosts > /h && echo '$REG_IP kind-registry' >> /h && cat /h > /etc/hosts
  systemctl restart containerd
"

docker exec agent-sbx-control-plane crictl pull localhost:5001/claude-agent-sdk-sandbox:dev
```

After this, both `localhost:5001/claude-agent-sdk-sandbox:dev` and `docker.io/library/claude-agent-sdk-sandbox:dev` show up in `crictl images` and `K8S_IMAGE_PULL_POLICY=Never` finds the image. The containerd restart is what flips the previously-invisible tag into the CRI index — don't skip it.

These edits live inside the `agent-sbx-control-plane` container's filesystem, so `kind delete cluster --name agent-sbx` wipes them and they must be redone on the next `bin/kind-up.sh`.

## 3. Kubeconfig: container user + current-context

Two issues, both surface as `session create failed` during `creating_sandbox`.

**a) Mount target unreachable by the container user.** The web/worker containers run as `nextjs` (uid 1001), but the compose volume mounts the host kubeconfig at `/root/.kube/config`. Failure: `EACCES: permission denied, open '/root/.kube/config'`. Fix by mounting to a path readable by uid 1001 and overriding `KUBECONFIG` accordingly, e.g.:

```yaml
environment:
  KUBECONFIG: /etc/kube/config
volumes:
  - ./.local/kube:/etc/kube:ro
```

with `./.local/kube/config` chmod 644.

**b) `current-context` points at a non-kind cluster.** Common laptop state: an EKS or GKE context is current. The platform reads `current-context` via `@kubernetes/client-node` and inherits its exec auth plugin (`aws eks get-token`, `gke-gcloud-auth-plugin`, etc.) which is not on `$PATH` inside the compose image. Failure: `spawn aws ENOENT`. Fix by emitting a minified, kind-only kubeconfig into the bind mount:

```bash
KUBECONFIG=~/.kube/config kubectl config view --raw --minify \
  --context=kind-agent-sbx > .local/kube/config
chmod 644 .local/kube/config
```

The k8s clients in `src/server/k8s.ts` are cached on first request — restart `web` and `worker` (`docker compose restart web worker`) after rewriting the kubeconfig file or the stale config keeps loading.

## 4. Postgres host-port collision

`postgres:5432` in `docker-compose.yml` collides with any host-side Postgres. Remap the host port (the compose internal network keeps `5432`):

```yaml
postgres:
  ports:
    - "5434:5432"
```

## 5. Smoke test the full path

A green local stack should pass the following end-to-end test against a LiteLLM gateway in `.env`:

```bash
export BASE=http://localhost:3002
export KEY="$MASTER_KEY"

AGENT_ID=$(curl -sS $BASE/api/v1/managed_agents/agents \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"name":"smoke","harness_id":"claude-agent-sdk",
       "model":"anthropic/claude-sonnet-4-5","prompt":"You are a coding agent.",
       "repo_url":"https://github.com/BerriAI/litellm","branch":"main"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

SID=$(curl -sS $BASE/api/v1/managed_agents/agents/$AGENT_ID/session \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"title":"smoke"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

# Wait until status=ready, then:
curl -sS $BASE/api/v1/managed_agents/sessions/$SID/message \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"text":"Reply with: hello from the sandbox."}'
```

Expected: pod ready in ~6s on a warm laptop, message round-trip ~5s.

