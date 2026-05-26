#!/usr/bin/env bash
# Start the local PostgreSQL dev cluster (idempotent).
#
# Used two ways:
#   1. As the E2B sandbox start command (e2b.toml `start_cmd`) so the DB is up
#      the moment a sandbox boots — no agent action required.
#   2. By dev-up.sh, for humans in an interactive shell.
#
# The cluster is owned by `user` and postgres refuses to run as root. E2B runs
# the start_cmd as root, so we drop to `user` when invoked as root; when a human
# runs it (already `user`), we run directly.
set -euo pipefail

PG_VERSION=$(ls /usr/lib/postgresql 2>/dev/null | sort -V | tail -1)
PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"
PG_DATA="/home/user/pgdata"

# Run a command as `user` (direct if we're already `user`, via su if root).
as_user() {
  if [ "$(id -u)" = "0" ]; then su user -c "$1"; else bash -c "$1"; fi
}

if as_user "'${PG_BIN}/pg_ctl' -D '${PG_DATA}' status" >/dev/null 2>&1; then
  echo "[start-db] PostgreSQL already running."
  exit 0
fi

echo "[start-db] Starting PostgreSQL ${PG_VERSION}..."
as_user "'${PG_BIN}/pg_ctl' -D '${PG_DATA}' start -w -t 30 -l /tmp/postgres.log" \
  || { echo "[start-db] ERROR: pg_ctl failed — postgres log:" >&2; cat /tmp/postgres.log >&2 2>/dev/null || true; exit 1; }
echo "[start-db] PostgreSQL started."
