# LiteLLM Agent Platform

A self-hosted control plane for **managed agents** on AWS Fargate, talking to a [LiteLLM](https://github.com/BerriAI/litellm) gateway as their model provider. Create agents, spawn sandboxed sessions, chat with them.

Each agent binds `(harness, repo, model, prompt)`. Spawning a session launches a fresh Fargate task running the [opencode](https://opencode.ai) harness, cloned to the configured repo, with the agent's env injected. The TypeScript backend owns Fargate lifecycle (RunTask → wait ready → harness HTTP), Postgres state, and a 60-second reconciler that kills orphan tasks and reaps idle sessions. Frontend, backend, and worker live in one repo.

<img width="1056" height="720" alt="d3" src="https://github.com/user-attachments/assets/63fbeed7-b3be-4f9a-9e79-6b8170b74f90" />




## Architecture

```
   browser ──► Next.js (this app) ──► Fargate task (opencode harness)
                  │                       │
                  │                       └─► LiteLLM gateway ──► models
                  │
                  ├─► Postgres (Prisma: Agent, Session)
                  └─► AWS SDK (ECS RunTask / StopTask, EC2 ENI lookup)

   sidecar worker (npm run worker) ──► reconciler tick every 60s
```

`/api/v1/managed_agents/*` are the route handlers that own Fargate + DB. `/api/v1/[...path]` and `/api/mcp-rest/[...path]` are passthroughs to the LiteLLM gateway with the master key attached server-side. `MASTER_KEY` gates everything; the browser collects it at `/login` and stashes it in localStorage.

## Prereqs

- **Docker Desktop** running locally (only needed once, for `setup.sh` to build + push the harness image to ECR).
- **AWS account** with permission to create ECR repos, ECS clusters, IAM roles, security groups, log groups, and run Fargate tasks. The default boto3-compatible credential chain is used.
- **A default VPC** in your target region with at least one public subnet (`map-public-ip-on-launch=true`). `setup.sh` discovers it automatically.
- **Postgres** (any provider — Neon, RDS, local, etc.).
- **A running LiteLLM gateway** the harness can call for model traffic (`LITELLM_API_BASE` + `LITELLM_API_KEY`).
- **Node 20+**.

## Setup

### 1. Clone + install

```bash
git clone https://github.com/BerriAI/litellm-agent-platform
cd litellm-agent-platform
npm install
cp .env.example .env
```

### 2. Fill `.env`

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. |
| `UI_USERNAME` | Display name shown in the UI sign-in (any string). |
| `MASTER_KEY` | Server-side bearer the UI signs in with. Min 8 chars. |
| `AWS_REGION` | AWS region for ECR/ECS/EC2. |
| `AWS_CLUSTER` | ECS cluster name (default `litellm-agents`; created by `setup.sh` if missing). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | IAM creds with ECS/ECR/EC2/IAM/Logs/STS perms. |
| `AWS_TASK_DEFINITION_ARN` / `AWS_SUBNETS` / `AWS_SECURITY_GROUP` | Filled in by `setup.sh`. Leave blank for now. |
| `PREINSTALLED_GITHUB_REPO` | Default repo cloned into a sandbox when an agent has no `repo_url`. |
| `LITELLM_API_BASE` / `LITELLM_API_KEY` | LiteLLM gateway the harness uses for model calls. |
| `CONTAINER_PORT` | Harness HTTP port (default 4096). |
| `RECONCILE_INTERVAL_SECONDS` | Worker tick (default 60). |
| `CONTAINER_ENV_*` | Anything with this prefix is injected into every Fargate container with the prefix stripped (e.g. `CONTAINER_ENV_GITHUB_TOKEN=ghp_...` → container sees `GITHUB_TOKEN`). |

### 3. Provision AWS infra

`setup.sh` is bash + `aws` CLI + `docker`. Idempotent — re-run any time.

```bash
./setup.sh
```

It does, in order:

1. ECR repo `litellm-agents-opencode` (created if missing).
2. `docker build --platform linux/amd64 harnesses/opencode/` and pushes the image, tag = git short SHA. (Mac silicon builds amd64 via QEMU emulation.)
3. IAM role `litellm-agents-task-exec` with `AmazonECSTaskExecutionRolePolicy`.
4. CloudWatch log group `/ecs/litellm-agents`.
5. ECS cluster `$AWS_CLUSTER`.
6. Default-VPC public subnet + a security group (`litellm-agents-sg`) with `4096/tcp` ingress from `0.0.0.0/0`.
7. ECS task definition `litellm-agents-opencode` (FARGATE, 512 cpu / 1024 mem, X86_64).
8. Prints the four values you need to paste back into `.env`:

```
AWS_TASK_DEFINITION_ARN=arn:aws:ecs:...:task-definition/litellm-agents-opencode:N
AWS_SUBNETS=subnet-...
AWS_SECURITY_GROUP=sg-...
OPENCODE_IMAGE_URI=<account>.dkr.ecr.<region>.amazonaws.com/litellm-agents-opencode:<sha>
```

Re-run `setup.sh` whenever you change `harnesses/opencode/Dockerfile` or `entrypoint.sh` — it pushes a new image tag and registers a new task definition revision.

### 4. Migrate the database

```bash
npx prisma db push          # creates `managed_agent` + `managed_agent_session`
```

### 5. Run

Two processes; both read `.env`.

```bash
npm run dev                 # Next.js on :3000 — frontend + API
npm run worker              # reconciler loop (orphan + idle sweep, 60s)
```

Open `http://localhost:3000`. You'll be bounced to `/login` — paste the `MASTER_KEY` you set.

## Lifecycle, cost, and cleanup

- **Cold session boot** is ~50–120 s: ECS RunTask → ENI public-IP attach → opencode HTTP ready → first message. The route handler holds the request open for the full duration; expect long-running response times.
- A `ready` Fargate task burns ~$0.04/hr (0.5 vCPU + 1 GB).
- The worker reconciler does three sweeps every `RECONCILE_INTERVAL_SECONDS`:
  - **Orphan tasks** — running tasks tagged with `litellm_session_id` whose row is missing or in `dead/failed/stopped` get `StopTask`'d. 5 min grace for fresh tasks.
  - **Stuck `creating`** — sessions stuck creating > 10 min get failed.
  - **Idle `ready`** — sessions whose `last_seen_at` is older than 24 h get killed (`failure_reason: "idle timeout"`).
- Manual stop: `DELETE /api/v1/managed_agents/sessions/{id}`.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/managed_agents/dockerfiles` | Returns the single bundled harness (`opencode`). |
| GET / POST | `/api/v1/managed_agents/agents` | List + create. |
| GET / PATCH | `/api/v1/managed_agents/agents/{id}` | Fetch + update (name, pfp, mcp servers). |
| POST | `/api/v1/managed_agents/agents/{id}/session` | Spin Fargate. ~50–120 s. Optional `initial_prompt`. |
| GET / DELETE | `/api/v1/managed_agents/sessions/{id}` | Fetch + stop. |
| GET | `/api/v1/managed_agents/sessions` | Optional `?agent_id=`. |
| POST | `/api/v1/managed_agents/sessions/{id}/message` | Forwards to harness on the Fargate task. |
| any | `/api/v1/[...path]` | Passthrough to `${LITELLM_API_BASE}/v1/...` (e.g. `/v1/models`, `/v1/mcp/server`). |
| any | `/api/mcp-rest/[...path]` | Passthrough to `${LITELLM_API_BASE}/mcp-rest/...` (MCP tool listing). |

All endpoints require `Authorization: Bearer <MASTER_KEY>`.

## Stack

- Next.js 16 App Router · React 19 · Tailwind v4 · shadcn/ui
- Prisma 6 + Postgres
- AWS SDK v3 (`@aws-sdk/client-ecs`, `@aws-sdk/client-ec2`, `@aws-sdk/credential-providers`)
- undici for outbound harness + LiteLLM HTTP
- zod for env + request body validation
- Reconciler worker via `tsx --env-file=.env`

## Pairs with

[BerriAI/litellm#27427](https://github.com/BerriAI/litellm/pull/27427) — the upstream Python managed-agents endpoints this repo replaces. You only need a LiteLLM gateway that can serve `/v1/models`, `/v1/mcp/server`, `/mcp-rest/tools/list`, and the chat/completions traffic the harness sends; no `general_settings.managed_agents` block is required on the gateway anymore.
