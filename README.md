# LiteLLM Agent Platform

[![Discord](https://img.shields.io/badge/Discord-Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/Nkxw3rm3EE)

LiteLLM Agent Platform is self-hosted infrastructure for running coding agents — Claude Code, Codex, anything — inside isolated sandboxes with a credential vault, so agents can run with bypass-permissions on without ever seeing your real keys. Use it from the `lap` CLI in your terminal, the web UI, or call the API directly.

**Learn more in the [docs](./docs)**.

<img width="1997" height="1219" alt="Xnapper-2026-05-08-19 10 50" src="https://github.com/user-attachments/assets/c0c2c2f8-d9e2-4821-b73a-e3971dac5169" />

## Get started

> [!NOTE]
> The `lap` CLI talks to a running instance of LiteLLM Agent Platform. To self-host the platform itself, jump to [Self-hosting](#self-hosting).

1. Install the `lap` CLI:

    ```bash
    git clone https://github.com/BerriAI/litellm-agent-platform.git
    cd litellm-agent-platform/cli && npm install
    ln -sf "$PWD/bin/lap.mjs" ~/.local/bin/lap
    ```

2. Point it at your platform:

    ```bash
    lap login
    ```

3. Open a sandbox:

    ```bash
    lap claude-code-cli1
    ```

That spins up a fresh Kubernetes pod running Claude Code, attaches your local terminal to its TTY over a WebSocket, and drops you straight into the agent. The pod's env contains only stub credentials (e.g. `GITHUB_TOKEN=stub_github_a8f1`); the vault swaps them for real keys on every outbound TLS connection. Press **Ctrl-D** to detach; the session stays alive for 24h. See [docs/lap-cli.md](docs/lap-cli.md) for the full CLI.

## Self-hosting

Sandboxes run on Kubernetes via the [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) CRD. Local dev uses [kind](https://kind.sigs.k8s.io/).

Prereqs: Docker Desktop, `kind`, `kubectl`, `helm`, a LiteLLM gateway URL.

```bash
bin/kind-up.sh
docker compose up
```

`bin/kind-up.sh` is idempotent — provisions a kind cluster `agent-sbx`, installs the agent-sandbox controller, and loads the harness image. `docker compose up` boots Postgres, runs the schema migration, and starts web (`:3000`) + worker.

Open [localhost:3000](http://localhost:3000) to create an agent. Then point `lap` at it and run through the steps above.

Architecture and tuning: [docs/k8s-backend.md](docs/k8s-backend.md).

### Deploying to production

Recommended path: AWS EKS for the sandbox cluster, Render for web + worker. See [`deploy/`](deploy/) — `bin/eks-up.sh` provisions the cluster, the Render Blueprint at the top of [`deploy/render/README.md`](deploy/render/README.md) is one click.

## Developer API

Create an agent, open a session, send a message, read the reply — directly with curl. See [`docs/spawn-task-agent.md`](docs/spawn-task-agent.md) and [`src/server/DEVELOPER.md`](src/server/DEVELOPER.md).

## License

MIT — see [LICENSE](LICENSE).
