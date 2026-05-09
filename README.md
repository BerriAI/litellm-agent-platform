# LiteLLM Agent Platform

Self-hosted control plane for sandboxed agents on AWS Fargate. Each agent binds `(harness, repo, model, prompt)`. Spawning a session launches a Fargate task running the [opencode](https://opencode.ai) harness, cloned to the repo, talking to a [LiteLLM](https://github.com/BerriAI/litellm) gateway for model traffic.

## 1. Create an Agent 
<img width="1164" height="720" alt="split1" src="https://github.com/user-attachments/assets/2c4371a3-dc4b-4ca0-a1a8-a09006ac3314" />

## 2. Use your Agent on the UI 

<img width="1164" height="720" alt="d7" src="https://github.com/user-attachments/assets/a39e1d74-9fd1-4db9-b090-9bffc49b09d5" />



## Setup

Prereqs: Docker Desktop, AWS account with default VPC, Postgres, LiteLLM gateway, Node 20+.

```bash
git clone https://github.com/BerriAI/litellm-agent-platform
cd litellm-agent-platform
npm install
cp .env.example .env       # fill in (table below)
./setup.sh                 # builds + pushes harness image, provisions ECR/IAM/SG/cluster/task-def
                           #   paste the four printed values back into .env
npx prisma db push
npm run dev                # :3000
npm run worker             # reconciler, 60s tick
```

Open `http://localhost:3000` → sign in at `/login` with `MASTER_KEY`.

## .env

| Var | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres |
| `UI_USERNAME` | display only |
| `MASTER_KEY` | bearer the UI signs in with, min 8 chars |
| `AWS_REGION` `AWS_CLUSTER` | defaults `litellm-agents` |
| `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` | needs ECS/ECR/EC2/IAM/Logs/STS |
| `AWS_TASK_DEFINITION_ARN` `AWS_SUBNETS` `AWS_SECURITY_GROUP` | filled by `setup.sh` |
| `PREINSTALLED_GITHUB_REPO` | default repo when agent has no `repo_url` |
| `LITELLM_API_BASE` `LITELLM_API_KEY` | model gateway |
| `CONTAINER_PORT` | default 4096 |
| `RECONCILE_INTERVAL_SECONDS` | default 60 |
| `CONTAINER_ENV_*` | injected into every Fargate container, prefix stripped |

## Lifecycle

- Cold session boot: 50–120s.
- Ready Fargate task: ~$0.04/hr (0.5 vCPU + 1 GB).
- Reconciler sweeps every `RECONCILE_INTERVAL_SECONDS`:
  - orphan tasks (row missing or dead) → `StopTask`, 5min grace
  - stuck `creating` > 10min → mark failed
  - idle `ready` > 24h → kill
- Manual stop: `DELETE /api/v1/managed_agents/sessions/{id}`.

## Endpoints

| Method | Path |
| --- | --- |
| GET | `/api/v1/managed_agents/dockerfiles` |
| GET / POST | `/api/v1/managed_agents/agents` |
| GET / PATCH | `/api/v1/managed_agents/agents/{id}` |
| POST | `/api/v1/managed_agents/agents/{id}/session` |
| GET / DELETE | `/api/v1/managed_agents/sessions/{id}` |
| GET | `/api/v1/managed_agents/sessions` |
| POST | `/api/v1/managed_agents/sessions/{id}/message` |
| any | `/api/v1/[...path]` → `${LITELLM_API_BASE}/v1/...` |
| any | `/api/mcp-rest/[...path]` → `${LITELLM_API_BASE}/mcp-rest/...` |

All require `Authorization: Bearer <MASTER_KEY>`.

## Harness contract

`/sessions/{id}/message` is a thin passthrough — body and response shape match the [opencode HTTP API](https://github.com/sst/opencode) verbatim. Any container that exposes opencode-compatible `POST /session` and `POST /session/{id}/message` on `CONTAINER_PORT` works. Drop one in `harnesses/<id>/` and re-run `./setup.sh` to bake a new task definition.

The container is launched with these env vars injected (per session, via `RunTask` `containerOverrides.environment`):

| Env | Source |
| --- | --- |
| `REPO_URL` | agent `repo_url` (falls back to `PREINSTALLED_GITHUB_REPO`) |
| `BRANCH` | agent `branch` (default `main`) |
| `LITELLM_API_BASE` `LITELLM_API_KEY` | host env, passed to the harness for model calls |
| `LITELLM_DEFAULT_MODEL` | agent `model` |
| `AGENT_PROMPT` | agent `prompt` |
| `PORT` | `CONTAINER_PORT` |
| `<X>` | every host `CONTAINER_ENV_<X>` (prefix stripped) |

The harness only needs to read these at startup (e.g. in `entrypoint.sh`); the platform owns the rest of the lifecycle.
