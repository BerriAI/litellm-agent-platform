# Docs

Setup, operation, and integration guides for the LiteLLM Agent Platform.

## Watch first

**▶ [Demo: setting up codex and claude-code sandboxes](https://www.loom.com/share/a88d525111b1445cb90db342ade09ebc)** &nbsp;·&nbsp; ~5 min

End-to-end walkthrough: create an agent, open a sandbox from the `lap` CLI, attach a local terminal, run codex / claude-code inside.

> _Video URL is a placeholder — please replace with the actual link._

## Guides

| Doc | What it covers |
|---|---|
| [**lap-cli.md**](lap-cli.md) | Open a sandbox in your terminal. `npm install` → `lap login` → `lap <agent>` → real Claude Code over WebSocket PTY. The primary developer surface. |
| [**deploy-aws.md**](deploy-aws.md) | Production deploy on AWS EKS. Web + worker as Deployments in the same cluster as sandboxes. OIDC for kubectl, no static AWS creds in env. |
| [**k8s-backend.md**](k8s-backend.md) | How the sandbox backend works. `Sandbox` CRs from `kubernetes-sigs/agent-sandbox`, vault sidecar, warm pool, NodePort routing. |
| [**spawn-task-agent.md**](spawn-task-agent.md) | When to spawn a dedicated agent vs. handle a task inline. Patterns for PR-review, security-scan, refactor agents. |

## Also useful

- [`../README.md`](../README.md) — project overview, screenshots, quickstart
- [`../src/server/DEVELOPER.md`](../src/server/DEVELOPER.md) — internals for contributors (API shape, harness contract, env vars)
- [`../harnesses/`](../harnesses/) — Dockerfiles + entrypoints for each harness (`claude-code`, `claude-agent-sdk`, `opencode`)
