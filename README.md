# LiteLLM Agent Platform

[![Discord](https://img.shields.io/badge/Discord-Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/Nkxw3rm3EE)

**Self-hosted platform for running coding agents in isolated sandboxes.**

Run Claude Code, Codex, or any coding-agent harness in its own Kubernetes sandbox. A vault proxy sits in front of each sandbox and swaps stub credentials for real ones on outbound calls — the agent process never sees your raw credentials.

<img width="1997" height="1219" alt="Xnapper-2026-05-08-19 10 50" src="https://github.com/user-attachments/assets/c0c2c2f8-d9e2-4821-b73a-e3971dac5169" />

---

## Why this exists

In most enterprises you can't just run `claude --dangerously-skip-permissions` on a corporate laptop. IT won't approve it. So developers babysit a permission popup every two minutes instead of shipping.

Run the agent inside a sandbox where the env contains only stub credentials and the vault swaps them at egress, and bypass-permissions becomes safe to enable.

## How it works — developer flow

A developer never deals with Kubernetes or the vault. They install one CLI and run one command.

### 1. Install the `lap` CLI

```bash
git clone https://github.com/BerriAI/litellm-agent-platform.git
cd litellm-agent-platform/cli
npm install
chmod +x bin/lap.mjs
ln -sf "$PWD/bin/lap.mjs" ~/.local/bin/lap
```

### 2. Log in to your platform

```bash
lap login
#   Agent platform URL: https://lap.acme.dev
#   Master key:         ••••••••••••••••
#   ✓ saved to ~/.lap/config.json
```

### 3. List the agents your team has configured

```bash
lap agents
```

### 4. Open a sandbox

```bash
lap claude-code-cli1
```

That command spins up a fresh Kubernetes pod running Claude Code, attaches your local terminal to its TTY over a WebSocket, and drops you straight into the agent. Same feel as `ssh` — your iTerm / tmux / wezterm stays exactly where it is. Press **Ctrl-D** to detach; the session stays alive for 24h and you can reconnect by running `lap <agent>` again.

### What's running in the sandbox

- The actual `claude` CLI under `node-pty`
- Working tree at `/work/repo`, optionally cloned at boot
- Credentials in the pod's env are stub placeholders:
  ```
  GITHUB_TOKEN=stub_github_a8f1
  LITELLM_API_KEY=stub_litellm_bb20
  ```
  Vault swaps them for the real values inline on every outbound TLS connection. The agent can `echo $GITHUB_TOKEN` all it wants and only get the stub.

Full CLI docs: [docs/lap-cli.md](docs/lap-cli.md).

## Self-hosting the platform

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
