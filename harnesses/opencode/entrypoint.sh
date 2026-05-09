#!/usr/bin/env bash
set -euo pipefail

: "${LITELLM_API_KEY:?LITELLM_API_KEY required}"
: "${LITELLM_API_BASE:?LITELLM_API_BASE required}"
: "${LITELLM_DEFAULT_MODEL:?LITELLM_DEFAULT_MODEL required}"

: "${BRANCH:=main}"
: "${PORT:=4096}"
: "${REPO_DIR:=/work/repo}"

# Normalize base URL: strip trailing slash, ensure /v1 suffix
BASE="${LITELLM_API_BASE%/}"
case "$BASE" in
  */v1) ;;
  *) BASE="${BASE}/v1" ;;
esac

# Two token paths, mutually compatible:
#   * GIT_TOKEN — clone-only. Wiped from env after cloning so the LLM can't
#     `printenv GIT_TOKEN` it back. Use when the agent must not push.
#   * GITHUB_TOKEN / GH_TOKEN — persistent. Left in env so `gh pr create` and
#     `git push` work from the agent shell. A global git credential helper is
#     configured below so the token never lands in argv or .git/config.
#
# CLONE_TOKEN is whichever is set, with GIT_TOKEN winning (more restrictive).
# When REPO_URL is unset, skip cloning and run the harness from an empty workdir.
CLONE_TOKEN="${GIT_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"

if [ -n "${REPO_URL:-}" ]; then
  if [ ! -d "$REPO_DIR/.git" ]; then
    if [ -n "$CLONE_TOKEN" ]; then
      git -c credential.helper= \
          -c "credential.helper=!f() { echo username=x-access-token; echo password=$CLONE_TOKEN; }; f" \
          clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    else
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    fi
  fi
else
  mkdir -p "$REPO_DIR"
fi

# Wipe GIT_TOKEN (clone-only by design). GITHUB_TOKEN / GH_TOKEN stay set —
# gh and git push need them at runtime.
unset GIT_TOKEN

cd "$REPO_DIR"

# Belt-and-suspenders: ensure .git/config has clean remote (no embedded creds).
if [ -n "${REPO_URL:-}" ]; then
  git remote set-url origin "$REPO_URL" 2>/dev/null || true
fi

# Persistent path: configure a global credential helper so subsequent
# `git push` from the agent shell authenticates without the token landing
# in argv or .git/config. gh auto-detects GITHUB_TOKEN / GH_TOKEN.
PERSIST_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -n "$PERSIST_TOKEN" ]; then
  git config --global credential.helper \
    "!f() { echo username=x-access-token; echo password=$PERSIST_TOKEN; }; f"
fi

# Wire LiteLLM as OpenAI-compatible provider
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
  cat > .opencode/agent/default.md <<EOF
---
description: sandbox agent
---
${AGENT_PROMPT}
EOF
fi

echo "[entrypoint] booting opencode serve on 0.0.0.0:${PORT}"
echo "[entrypoint] base=${BASE} model=${LITELLM_DEFAULT_MODEL} repo=${REPO_DIR}"

exec opencode serve --hostname 0.0.0.0 --port "$PORT"
