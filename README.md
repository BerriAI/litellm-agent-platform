# LiteLLM Agent Platform 🤖

A web UI for managing **agents** and their **sandboxed coding sessions** on a [LiteLLM](https://github.com/BerriAI/litellm) proxy. Each agent is bound to a sandbox template (a harness — opencode, claude-code, etc. — paired with a repo). Spawning a session boots a fresh Fargate task running that harness against that repo, and the proxy handles the lifecycle.

This UI is the front-end half of [BerriAI/litellm#27427](https://github.com/BerriAI/litellm/pull/27427). Point it at a LiteLLM proxy with `general_settings.managed_agents.enabled: true`.

## Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2FBerriAI%2Flitellm-agent-platform)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BerriAI/litellm-agent-platform)

Both expect two env vars:

| Var | Example |
| --- | --- |
| `NEXT_PUBLIC_LITELLM_BASE_URL` | `https://your-proxy.example.com` |
| `NEXT_PUBLIC_LITELLM_API_KEY` | `sk-...` (master key or virtual key) |

The UI talks to `/v1/managed_agents/*` on that base URL.

## Run locally

```bash
npm install
echo 'NEXT_PUBLIC_LITELLM_BASE_URL=http://localhost:4000' > .env.local
echo 'NEXT_PUBLIC_LITELLM_API_KEY=sk-1234' >> .env.local
npm run dev
```

## Endpoints used

```
GET    /v1/managed_agents/dockerfiles
GET    /v1/managed_agents/sandbox-templates
POST   /v1/managed_agents/agents
GET    /v1/managed_agents/agents
GET    /v1/managed_agents/agents/{id}
PATCH  /v1/managed_agents/agents/{id}                # name + pfp_url
POST   /v1/managed_agents/agents/{id}/session        # ~50–90s spawn
GET    /v1/managed_agents/sessions
GET    /v1/managed_agents/sessions/{id}
POST   /v1/managed_agents/sessions/{id}/message
GET    /v1/managed_agents/sessions/{id}/events       # SSE
DELETE /v1/managed_agents/sessions/{id}
```

## Stack

- Next.js 16 App Router + React 19
- shadcn/ui + Tailwind v4
- Reads/writes via `fetch` — no SDK dependency
