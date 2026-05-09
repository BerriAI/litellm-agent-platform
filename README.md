# LiteLLM Agent Platform

A simple, self-hosted infrastructure platform for running multiple agents in production.

The main benefit of using this is that it will manage:
- Different sandboxes for different teams/contexts
- Session management across pod restarts/upgrades

We built this because we wanted a managed agent solution, but fully self-hosted. We are excited to have it open sourced and available for everyone to use.

<img width="1997" height="1219" alt="Xnapper-2026-05-08-19 10 50" src="https://github.com/user-attachments/assets/c0c2c2f8-d9e2-4821-b73a-e3971dac5169" />

---

## Quickstart

```bash
./setup.sh
docker compose up
```

Needs Docker Desktop, working AWS credentials (env vars, `AWS_PROFILE` + `~/.aws/credentials`, SSO, instance role — anything the AWS SDK's default chain finds), and a LiteLLM gateway. `./setup.sh` prompts for any missing config, validates `aws sts get-caller-identity` works, then provisions AWS infra (ECR, IAM, SG, cluster, task def) and writes the outputs into `.env`. `docker compose up` boots Postgres, runs the schema migration as an init container, and starts web (`:3000`) + worker.

### Container env passthrough

Anything in `.env` prefixed `CONTAINER_ENV_` is injected into every Fargate container with the prefix stripped:

```bash
CONTAINER_ENV_GITHUB_TOKEN=ghp_...   # container sees GITHUB_TOKEN=ghp_...
```

## Architecture

<img width="1997" height="1219" alt="Xnapper-2026-05-08-19 10 50" src="https://raw.githubusercontent.com/BerriAI/litellm-docs/main/static/img/litellm_agent_platform_alpha.png" />
## Developer Usage

Hitting the API directly with curl — create an agent, open a session, send a message, read the reply. See [`src/server/DEVELOPER.md`](src/server/DEVELOPER.md) for the full walkthrough.
