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
    # Also drop the CA-bundle overrides. With vault down, egress goes direct to
    # public hosts (github.com, pypi.org, …) which present real certs signed by
    # Mozilla roots. Leaving SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE /
    # GIT_SSL_CAINFO pointing at /etc/vault-ca/tls.crt would make every direct
    # HTTPS call fail SSL verification (git clone, uv pip install, the phase
    # report curl). NODE_EXTRA_CA_CERTS supplements (doesn't replace) Node's
    # built-in bundle, so it's safe to leave set.
    unset SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO
  else
    set -a
    . /lap-shared/env
    set +a
    # Build a combined CA bundle (vault CA + system CAs) so every TLS client
    # can verify BOTH the vault MITM cert (presented for proxied egress) AND
    # public certs (presented for direct egress to NO_PROXY hosts like
    # cluster-internal services). The platform also points the replacement-
    # bundle env vars (SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE,
    # GIT_SSL_CAINFO) at /etc/vault-ca/tls.crt for older harness images that
    # don't run this code path; override them here to the combined bundle so
    # both verification paths work. NODE_EXTRA_CA_CERTS is supplemental
    # (appends to Node's built-in Mozilla bundle) and is left at the vault
    # CA path the platform already set.
    if [ -r /etc/vault-ca/tls.crt ]; then
      # Build combined bundle: vault CA is always needed (all egress is MITM'd
      # by vault, which presents vault-CA-signed certs). Append system CAs if
      # present for any non-proxied hosts. Don't require system CAs to exist —
      # vault CA alone is sufficient when everything routes through the proxy.
      BUNDLE=/tmp/lap-ca-bundle.crt
      # Always emit a trailing newline between certs. The vault-issued
      # tls.crt has no terminating LF, so plain `cat A B >> bundle` glues
      # `-----END CERTIFICATE----------BEGIN CERTIFICATE-----` together
      # on one line. OpenSSL's PEM parser then rejects the whole file
      # with `[X509] PEM lib (_ssl.c:4123)`. Python's `ssl` and the
      # `openai` SDK both blow up here, breaking hermes (and any python
      # client) on its first model call. printf '\n' separates the
      # blocks correctly even when the input has no trailing newline.
      { cat /etc/vault-ca/tls.crt; printf '\n'; } > "$BUNDLE"
      if [ -r /etc/ssl/certs/ca-certificates.crt ]; then
        cat /etc/ssl/certs/ca-certificates.crt >> "$BUNDLE"
      fi
      export SSL_CERT_FILE="$BUNDLE"
      export REQUESTS_CA_BUNDLE="$BUNDLE"
      export CURL_CA_BUNDLE="$BUNDLE"
      export GIT_SSL_CAINFO="$BUNDLE"
    else
      echo "[entrypoint] WARNING: /etc/vault-ca/tls.crt not readable — TLS verification may fail" >&2
    fi
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
  # Persistent token: global credential store so gh + git push work from any
  # directory inside the container, not just $REPO_DIR.
  if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ] && [ -z "${GIT_TOKEN:-}" ]; then
    PERSIST_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN}}"
    printf 'https://x-access-token:%s@github.com\n' "$PERSIST_TOKEN" > /tmp/.git-credentials
    chmod 600 /tmp/.git-credentials
    git config --global credential.helper "store --file=/tmp/.git-credentials"
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
