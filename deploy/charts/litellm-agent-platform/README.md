# Helm Chart for LiteLLM Agent Platform

Self-hosted platform for running coding agents (Claude Code, Codex, Hermes) in isolated Kubernetes sandboxes with vault proxy.

## Prerequisites

- Kubernetes 1.21+
- Helm 3.8.0+
- [agent-sandbox CRD](https://github.com/kubernetes-sigs/agent-sandbox) installed on the cluster
- A container image built from the [Dockerfile](../../Dockerfile) available in a registry

## Quick Start

### 1. Install the agent-sandbox CRD (once per cluster)

```bash
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.5/manifest.yaml
```

### 2. Build and push the platform image

```bash
docker build -t your-registry/litellm-agent-platform:latest .
docker push your-registry/litellm-agent-platform:latest
```

### 3. Install the chart

```bash
helm install litellm-agents ./deploy/charts/litellm-agent-platform \
  --set image.repository=your-registry/litellm-agent-platform \
  --set image.tag=latest \
  --set secrets.litellmApiKey=sk-your-key \
  --set secrets.litellmApiBase=https://your-litellm-proxy.example.com \
  --set k8s.harnessImage=your-registry/opencode-sandbox:latest
```

### 4. Open the UI

```bash
kubectl port-forward svc/litellm-agents-web 3000:80
```

Open http://localhost:3000 and log in with the auto-generated master key:

```bash
kubectl get secret litellm-agents-env -o jsonpath='{.data.MASTER_KEY}' | base64 -d
```

## Configuration

### Image

| Key | Description | Default |
|-----|-------------|---------|
| `image.repository` | Platform container image repository | `litellm-agent-platform` |
| `image.tag` | Image tag | Chart appVersion |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `imagePullSecrets` | Secrets for private registries | `[]` |

### Secrets

| Key | Description | Default |
|-----|-------------|---------|
| `secrets.masterKey` | Master API key (auto-generated if empty) | `""` |
| `secrets.litellmApiKey` | API key for your LiteLLM proxy | `""` |
| `secrets.litellmApiBase` | LiteLLM proxy URL (e.g. `http://litellm:4000`) | `""` |
| `secrets.harnessAuthToken` | WebSocket auth token (auto-generated if empty) | `""` |
| `secrets.existingSecret` | Use an existing Secret instead of creating one | `""` |

### Database

| Key | Description | Default |
|-----|-------------|---------|
| `postgresql.enabled` | Deploy PostgreSQL via Bitnami subchart | `true` |
| `postgresql.auth.username` | Postgres username | `litellm` |
| `postgresql.auth.password` | Postgres password | `litellm` |
| `postgresql.auth.database` | Database name | `litellm_agents` |
| `postgresql.primary.persistence.size` | PVC size | `8Gi` |
| `externalDatabase.url` | External DATABASE_URL (takes precedence) | `""` |
| `externalDatabase.existingSecret` | Existing Secret with `url` key | `""` |

### Kubernetes Sandbox Backend

| Key | Description | Default |
|-----|-------------|---------|
| `k8s.namespace` | Namespace for Sandbox CRs | `default` |
| `k8s.nodeHost` | How web reaches k8s node (`auto` = discover) | `auto` |
| `k8s.nodeportMin` | NodePort range start | `"30000"` |
| `k8s.nodeportMax` | NodePort range end | `"30099"` |
| `k8s.harnessImage` | Default sandbox pod image | `""` |
| `k8s.harnessImageClaudeSdk` | Claude SDK harness override | `""` |
| `k8s.harnessImageClaudeCode` | Claude Code harness override | `""` |
| `k8s.harnessImageCodex` | Codex harness override | `""` |
| `k8s.harnessImageHermes` | Hermes harness override | `""` |

### Platform Config

| Key | Description | Default |
|-----|-------------|---------|
| `config.defaultModel` | Default LLM model | `anthropic/claude-sonnet-4-6` |
| `config.warmPoolSize` | Pre-provisioned sandbox pods | `"2"` |
| `config.preinstalledRepo` | Repo cloned in sandbox | `https://github.com/BerriAI/litellm` |
| `config.baseUrl` | Public URL of this deployment (for OAuth) | `""` |

### Web Service

| Key | Description | Default |
|-----|-------------|---------|
| `web.replicas` | Web deployment replicas | `1` |
| `web.port` | Container port | `10000` |
| `web.resources` | CPU/memory requests and limits | see values.yaml |

### Worker

| Key | Description | Default |
|-----|-------------|---------|
| `worker.replicas` | Worker deployment replicas | `1` |
| `worker.resources` | CPU/memory requests and limits | see values.yaml |

### Service / Ingress

| Key | Description | Default |
|-----|-------------|---------|
| `service.type` | Kubernetes Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `service.annotations` | Service annotations (e.g. AWS LB idle timeout) | `{}` |
| `ingress.enabled` | Enable Ingress | `false` |

### RBAC / Priority

| Key | Description | Default |
|-----|-------------|---------|
| `rbac.create` | Create RBAC resources | `true` |
| `priorityClasses.enabled` | Create PriorityClasses for sandbox preemption | `true` |
| `priorityClassName` | Priority class for platform pods | `platform-critical` |

## Example: Custom values for production

```yaml
image:
  repository: ghcr.io/myorg/litellm-agent-platform
  tag: "v1.0.0"

secrets:
  litellmApiKey: sk-prod-key-here
  litellmApiBase: http://litellm-proxy.litellm:4000

k8s:
  harnessImage: ghcr.io/myorg/opencode-sandbox:v1.0.0
  harnessImageClaudeSdk: ghcr.io/myorg/claude-sdk-sandbox:v1.0.0

postgresql:
  enabled: false

externalDatabase:
  url: "postgresql://user:pass@rds.endpoint:5432/litellm_agents?sslmode=require"

web:
  replicas: 2
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: "2"
      memory: 2Gi

worker:
  replicas: 2

service:
  type: ClusterIP

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: agents.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: agents-tls
      hosts:
        - agents.example.com

config:
  warmPoolSize: "4"
  baseUrl: "https://agents.example.com"
```

## Architecture

```
                    ┌──────────────┐
                    │   Ingress    │
                    │   / LB       │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  web (port   │
                    │  10000)      │
                    │  server-proxy│─── WS /tty ──► sandbox pods
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──┐  ┌──────▼──┐  ┌──────▼──┐
       │ worker  │  │ worker  │  │ Postgres│
       └─────────┘  └─────────┘  └─────────┘
```

Platform pods use in-cluster auth (`IN_CLUSTER=true`) with a ServiceAccount that has RBAC permissions to manage `Sandbox` CRs, Services, and read Nodes/Pods in the sandbox namespace.

## Migration

The chart includes a Helm pre-install/pre-upgrade hook Job that runs `npx prisma db push` against the database. This ensures the schema is up-to-date before the web/worker pods start.

## Notes

- **agent-sandbox CRD** must be installed separately before deploying the chart
- **NodePort range** (30000-30099) must match `--service-node-port-range` on the kube-apiserver for >100 concurrent sandboxes, consider ClusterIP + Ingress topology
- **WebSocket idle timeout**: If using an AWS LB, set `service.annotations."service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout": "3600"` to prevent WS drops during long agent sessions
