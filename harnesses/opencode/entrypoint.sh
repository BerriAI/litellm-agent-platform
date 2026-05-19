#!/usr/bin/env bash
# opencode harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
#
# Two modes, selected by OPENCODE_MODE (default: tui):
#
#   tui    — WebSocket PTY bridge (Node server.js) wraps opencode in a tmux
#            session so the TUI survives WS reconnects. The LAP platform UI
#            connects via /tty WebSocket. This is the primary interactive mode.
#
#   serve  — opencode's built-in HTTP server (`opencode serve`). Useful for
#            automated/scripted sessions that talk JSON over HTTP.
set -euo pipefail

. /opt/lap/common.sh

: "${LITELLM_DEFAULT_MODEL:?LITELLM_DEFAULT_MODEL required}"

# Normalize base URL: strip trailing slash, ensure /v1 suffix.
BASE="${LITELLM_API_BASE%/}"
case "$BASE" in
  */v1) ;;
  *) BASE="${BASE}/v1" ;;
esac

cd "$REPO_DIR"

# Belt-and-suspenders: ensure .git/config has clean remote (no embedded creds).
if [ -n "${REPO_URL:-}" ]; then
  git remote set-url origin "$REPO_URL" 2>/dev/null || true
fi

# Wire LiteLLM as the OpenAI-compatible provider for opencode.
cat > opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "${BASE}",
        "apiKey": "${LITELLM_API_KEY}"
      },
      "models": {
        "${LITELLM_DEFAULT_MODEL}": {}
      }
    }
  },
  "model": "litellm/${LITELLM_DEFAULT_MODEL}"
}
EOF

if [ -n "${AGENT_PROMPT:-}" ]; then
  mkdir -p .opencode/agent
  cat > .opencode/agent/default.md <<EOF2
---
description: sandbox agent
---
${AGENT_PROMPT}
EOF2
fi

OPENCODE_MODE="${OPENCODE_MODE:-tui}"

if [ "$OPENCODE_MODE" = "serve" ]; then
  echo "[entrypoint] booting opencode serve on 0.0.0.0:${PORT}"
  echo "[entrypoint] base=${BASE} model=${LITELLM_DEFAULT_MODEL} repo=${REPO_DIR}"
  exec opencode serve --hostname 0.0.0.0 --port "$PORT"
else
  echo "[entrypoint] booting opencode TUI harness (node bridge) on 0.0.0.0:${PORT}"
  echo "[entrypoint] base=${BASE} model=${LITELLM_DEFAULT_MODEL} repo=${REPO_DIR}"
  exec node /app/server.js
fi
