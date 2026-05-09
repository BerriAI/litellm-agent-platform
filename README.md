# LiteLLM Agent Platform

Self-hosted infrastructure for running multiple agents in production. Manages:

- Per-team / per-context sandboxes
- Session continuity across pod restarts and upgrades

<img width="1997" height="1219" alt="Xnapper-2026-05-08-19 10 50" src="https://github.com/user-attachments/assets/c0c2c2f8-d9e2-4821-b73a-e3971dac5169" />

---

## Quickstart

Sandboxes run on Kubernetes via the [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) CRD. Local dev uses [kind](https://kind.sigs.k8s.io/).

Prereqs: Docker Desktop, `kind`, `kubectl`, `helm`, a LiteLLM gateway.

```bash
bin/kind-up.sh
docker compose up
```

`bin/kind-up.sh` is idempotent — provisions a kind cluster `agent-sbx`, installs the agent-sandbox controller, and loads the harness image. `docker compose up` boots Postgres, runs the schema migration, and starts web (`:3000`) + worker.

Architecture and tuning: [docs/k8s-backend.md](docs/k8s-backend.md).

### Container env passthrough

Anything in `.env` prefixed `CONTAINER_ENV_` is injected into every sandbox container with the prefix stripped:

```bash
CONTAINER_ENV_GITHUB_TOKEN=ghp_...   # container sees GITHUB_TOKEN=ghp_...
```

### Deploying

Per-platform guides in [`deploy/`](deploy/).

## Architecture

<img width="1997" height="1219" alt="Xnapper-2026-05-08-19 10 50" src="https://raw.githubusercontent.com/BerriAI/litellm-docs/main/static/img/litellm_agent_platform_alpha.png" />

## Developer Usage

Hitting the API directly with curl — create an agent, open a session, send a message, read the reply. See [`src/server/DEVELOPER.md`](src/server/DEVELOPER.md).

## License

MIT — see [LICENSE](LICENSE).
