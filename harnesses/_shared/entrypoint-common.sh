# Common harness setup — sourced by every harness entrypoint.
# Do NOT add a shebang; this file is sourced, not executed.
# After this file returns, run any harness-specific setup, then exec the server.

# --- Vault sidecar handoff ---
# When enabled, vault writes stub env vars to /lap-shared/env once it is
# listening. Wait up to 15 s, source the stubs, then proceed. If vault
# never comes up, unset the proxy vars so direct HTTPS still works (degraded
# mode) rather than every outbound request hanging on the dead proxy.
if [ "${VAULT_ENABLED:-}" = "true" ]; then
  for _ in $(seq 1 30); do
    if [ -s /lap-shared/env ]; then break; fi
    sleep 0.5
  done
  if [ ! -s /lap-shared/env ]; then
    echo "[entrypoint] vault not ready after 15s — unsetting proxy, proceeding without stubs" >&2
    unset HTTPS_PROXY HTTP_PROXY NO_PROXY
  else
    set -a
    . /lap-shared/env
    set +a
    # CA-bundle env vars (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE,
    # CURL_CA_BUNDLE, GIT_SSL_CAINFO) are set by the platform (k8s.ts:buildContainerEnv)
    # to /etc/vault-ca/tls.crt so every TLS client trusts the MITM proxy. Don't
    # override them here — the previous "bake into system store at build time"
    # design was never wired up (no harness Dockerfile actually COPYs the CA
    # in), so pointing tools at /etc/ssl/certs/ca-certificates.crt masked the
    # real fix and silently broke proxied egress for git/curl/python.
    echo "[entrypoint] vault stubs sourced ($(wc -l </lap-shared/env) keys)"
  fi
fi

# --- Required env ---
: "${LITELLM_API_KEY:?LITELLM_API_KEY required}"
: "${LITELLM_API_BASE:?LITELLM_API_BASE required}"

: "${BRANCH:=main}"
: "${PORT:=4096}"
: "${REPO_DIR:=/work/repo}"

# --- Phase progress reporter ---
# POSTs the named phase to the platform so the UI can show real container-side
# progress. The platform injects PLATFORM_URL, SESSION_ID, and
# HARNESS_PROGRESS_TOKEN at runTask time. If any is empty (warm-pool pre-claim
# or unconfigured deploy) the call short-circuits. The || true is critical —
# a failed phase report must never abort the boot.
report_phase() {
  if [ -z "${PLATFORM_URL:-}" ] || [ -z "${SESSION_ID:-}" ] || [ -z "${HARNESS_PROGRESS_TOKEN:-}" ]; then
    return 0
  fi
  curl -fsS --max-time 5 \
    -X POST \
    -H "Authorization: Bearer ${HARNESS_PROGRESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"phase\":\"$1\"}" \
    "${PLATFORM_URL}/api/v1/managed_agents/sessions/${SESSION_ID}/phase" \
    >/dev/null 2>&1 || true
}

# --- Git clone ---
# Always ensure REPO_DIR exists — some harnesses spawn binaries with cwd set
# to REPO_DIR; if the dir is missing the spawn fails with a misleading error.
mkdir -p "$REPO_DIR"

# Two token paths:
#   GIT_TOKEN    — clone-only. Wiped from env after clone so the agent can't
#                  printenv it back. Use for read-only PR review.
#   GITHUB_TOKEN / GH_TOKEN — persistent. Left in env so gh + git push work.
CLONE_TOKEN="${GIT_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"

if [ -n "${REPO_URL:-}" ]; then
  if [ ! -d "$REPO_DIR/.git" ]; then
    report_phase cloning_repo
    if [ -n "$CLONE_TOKEN" ]; then
      git -c credential.helper= \
          -c "credential.helper=!f() { echo username=x-access-token; echo password=$CLONE_TOKEN; }; f" \
          clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    else
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    fi
  fi
  # Persistent token: store credentials so gh pr create / git push work without
  # the token landing in argv or .git/config.
  if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ] && [ -z "${GIT_TOKEN:-}" ]; then
    git -C "$REPO_DIR" config credential.helper "store --file=/tmp/.git-credentials"
    PERSIST_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN}}"
    printf 'https://x-access-token:%s@github.com\n' "$PERSIST_TOKEN" > /tmp/.git-credentials
    chmod 600 /tmp/.git-credentials
  fi
fi

# --- Python deps ---
report_phase installing_deps
if [ -n "${AGENT_REQUIREMENTS:-}" ]; then
  if command -v uv >/dev/null 2>&1; then
    printf '%s\n' "$AGENT_REQUIREMENTS" \
      | uv pip install --target /home/sandbox/.local/lib/python-agent -q -r /dev/stdin
    export PYTHONPATH="/home/sandbox/.local/lib/python-agent${PYTHONPATH:+:$PYTHONPATH}"
  else
    echo "[entrypoint] AGENT_REQUIREMENTS set but uv not found — skipping" >&2
  fi
fi

# --- Wipe clone-only token ---
unset GIT_TOKEN

# --- File injection ---
# Platform encodes agent-template files as LAP_FILE_N_DEST / LAP_FILE_N_CONTENT
# (base64) env vars. Decode and write them before the server starts so tools
# like settings.json are in place when the harness binary launches.
_lap_i=0
while true; do
  _lap_dest_var="LAP_FILE_${_lap_i}_DEST"
  _lap_content_var="LAP_FILE_${_lap_i}_CONTENT"
  _lap_dest="${!_lap_dest_var:-}"
  _lap_content="${!_lap_content_var:-}"
  [ -z "$_lap_dest" ] && break
  _lap_dest="${_lap_dest/#\~/$HOME}"
  mkdir -p "$(dirname "$_lap_dest")"
  printf '%s' "$_lap_content" | base64 -d > "$_lap_dest"
  _lap_i=$((_lap_i + 1))
done
unset _lap_i _lap_dest_var _lap_content_var _lap_dest _lap_content

report_phase harness_listening
