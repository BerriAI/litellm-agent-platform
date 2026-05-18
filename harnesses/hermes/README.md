# hermes-tty — Nous Research Hermes Agent Harness

Smallest possible "Hermes in a sandbox" — a Docker container that runs
`hermes --tui` under a PTY and bridges it to a browser terminal over
WebSocket. Same bridge pattern as `claude-code` and `codex` harnesses.

```
Browser (xterm.js) ◀── ws ──▶ bridge (node, this image) ◀── pty ──▶ hermes
```

---

## Auth

The `/tty` WebSocket — the only endpoint that spawns a PTY and gives the
caller a shell — requires a bearer token matching `HARNESS_AUTH_TOKEN`.

**The harness fails closed if this env var is empty**: every WS upgrade is
rejected with `401` before any process is spawned.

The HTTP endpoints (`/healthz`, `POST /session`, `GET /session/:id/message`,
etc.) are LAP-platform-compat stubs that return constants — no credentials,
no shell access — and are intentionally anonymous so the platform's
bootstrap probe doesn't need to hold the harness's auth token.

Token is accepted via:
- `Authorization: Bearer <token>` (HTTP)
- `?token=<token>` query string (WebSocket upgrade, since browsers can't
  set arbitrary headers on `new WebSocket(...)`)

---

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `HARNESS_AUTH_TOKEN` | **Yes** | Bearer token for `/tty` WebSocket auth. Fails closed if unset. |
| `LITELLM_API_BASE` | Yes (for Hermes) | LiteLLM gateway URL → mapped to `OPENAI_BASE_URL` |
| `LITELLM_API_KEY` | Yes (for Hermes) | LiteLLM key → mapped to `OPENAI_API_KEY` |
| `PORT` | No | HTTP listen port (default: `4096`) |
| `POC_CMD` | No | Command to run in PTY (default: `hermes --tui`) |
| `REPO_DIR` | No | Working directory for PTY (default: `cwd`) |
| `SKILLS_JSON` | No | JSON array of `{slug, content}` skill files to hydrate into `~/.hermes/skills/` |

> **Note:** `LITELLM_API_KEY` is injected as a vault stub (`stub_xxx`) by the
> LAP credential vault at egress — the harness never sees the real key in transit.

---

## Run

```bash
docker build -t hermes-tty-poc .

# With your LiteLLM gateway (recommended):
docker run --rm -p 4096:4096 \
  -e HARNESS_AUTH_TOKEN=$(openssl rand -hex 16) \
  -e LITELLM_API_BASE=https://litellm.acme.dev \
  -e LITELLM_API_KEY=$LITELLM_API_KEY \
  hermes-tty-poc

# Open the terminal UI:
open "http://localhost:4096/?token=<your-HARNESS_AUTH_TOKEN>"
```

You should see the Hermes welcome banner. Type a prompt and watch it work.

---

## Testing the bridge without an API key

Override the command to `bash` — no LLM needed:

```bash
docker run --rm -p 4096:4096 \
  -e POC_CMD=bash \
  -e HARNESS_AUTH_TOKEN=test \
  hermes-tty-poc
```

Open `http://localhost:4096/?token=test`. Type `ls`, `top`, `vim foo.txt` —
anything that uses ANSI / cursor movement. If those render correctly, the PTY
bridge is sound and swapping back to `hermes --tui` is a one-env-var change.

---

## How it differs from `claude-code`

| | `claude-code` | `hermes` |
|---|---|---|
| **Agent binary** | `claude` (Anthropic CLI) | `hermes --tui` (Nous Research) |
| **API key env** | `ANTHROPIC_API_KEY` | `LITELLM_API_KEY` → `OPENAI_API_KEY` |
| **Config file** | `~/.claude/` | `~/.hermes/config.yaml` + `~/.hermes/.env` |
| **Skills dir** | `~/.claude/skills/` | `~/.hermes/skills/` |
| **TUI support** | ✅ (xterm.js bridge) | ✅ (xterm.js bridge) |
| **Session persist** | tmux `-A` reattach | tmux `-A` reattach |

Both harnesses share the same `server.js` bridge pattern and identical auth
model — the only differences are the agent binary and its config layout.

---

## Files

- `Dockerfile` — node:20-slim + hermes CLI install + node-pty build
- `server.js` — HTTP static + WebSocket on `/tty` + PTY spawn (tmux wrapper)
- `entrypoint.sh` — writes `~/.hermes/config.yaml` + `.env` from vault-injected env vars; hydrates `SKILLS_JSON` into `~/.hermes/skills/`
- `package.json` — `ws`, `node-pty` dependencies

---

## What this is and isn't

- **Is**: the terminal-streaming half of the LAP "TUI harness" for Hermes.
  Proves xterm.js + node-pty + ws is the right plumbing for Nous Research's
  Hermes agent.
- **Isn't**: vault, repo isolation policy, K8s NetworkPolicy, multi-session,
  or auth policy. Those layers live in LAP itself and wrap around this bridge.
