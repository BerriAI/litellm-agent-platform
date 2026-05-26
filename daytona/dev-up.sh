#!/usr/bin/env bash
# Usage:  source /usr/local/bin/dev-up
#         (source so exports land in the caller's shell)
#
# What it does:
#   1. Starts the local PostgreSQL cluster (no sudo needed — user owns pgdata)
#   2. Exports dev env vars for the LiteLLM proxy
#   3. Prints the one-liner to boot the proxy
#
# NOTE: set -e intentionally omitted — sourcing a script with set -e would
# exit the caller's shell on any failed command.
set -uo pipefail

# Start postgres (idempotent). Shared with the sandbox start_cmd so there's a
# single source of truth for the PG start logic.
/usr/local/bin/start-db

export DATABASE_URL="postgresql://litellm:litellm@localhost:5432/litellm"
export LITELLM_MASTER_KEY="sk-1234"
export LITELLM_SALT_KEY="sk-litellm-salt-dev-unsafe"
export STORE_MODEL_IN_DB="True"

echo ""
echo "[dev-up] Env exported:"
echo "  DATABASE_URL=${DATABASE_URL}"
echo "  LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}"
echo "  LITELLM_SALT_KEY=${LITELLM_SALT_KEY}"
echo "  STORE_MODEL_IN_DB=${STORE_MODEL_IN_DB}"
echo ""
echo "[dev-up] Boot proxy:"
echo "  cd ~/litellm && python -m litellm.proxy.proxy_cli --port 4000 --detailed_debug"
