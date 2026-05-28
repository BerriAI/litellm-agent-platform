#!/usr/bin/env bash
#
# Generates a fresh vault CA into .local/vault/ and overwrites vault/ca.crt so
# the harness images bake the matching cert into their system trust store. The
# k8s secret `vault-ca` (TLS type) is created in the agent-sbx cluster so the
# vault sidecar can mint per-host leaf certs at runtime.
#
# Idempotent: re-running regenerates the CA only when --force is passed.
# Without --force, existing material is reused.
#
# Order matters:
#   1. Run this script BEFORE building harness images (harness Dockerfile
#      bakes vault/ca.crt into /usr/local/share/ca-certificates/).
#   2. Apply the k8s secret AFTER kind-up.sh has created the agent-sbx cluster.
#      If the cluster does not exist yet, the secret step is skipped and a
#      reminder is printed.

set -euo pipefail

CONTEXT="${KUBE_CONTEXT:-kind-agent-sbx}"
LOCAL_DIR=".local/vault"
KEY="$LOCAL_DIR/tls.key"
CRT="$LOCAL_DIR/tls.crt"
REPO_CA="vault/ca.crt"
FORCE=0

err() { printf "[vault-ca] error: %s\n" "$*" >&2; exit 1; }
info() { printf "[vault-ca] %s\n" "$*"; }

[ "${1:-}" = "--force" ] && FORCE=1

command -v openssl >/dev/null || err "openssl not installed"
command -v kubectl >/dev/null || err "kubectl not installed"

mkdir -p "$LOCAL_DIR"

# ---- 1. CA generation ----------------------------------------------------
if [ -f "$KEY" ] && [ -f "$CRT" ] && [ "$FORCE" -eq 0 ]; then
  info "CA already exists at $CRT (use --force to regenerate)"
else
  info "generating fresh CA → $CRT"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" 2>/dev/null
  openssl req -new -x509 -key "$KEY" -out "$CRT" -sha256 -days 3650 \
    -subj "/CN=vault/O=LiteLLM" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,digitalSignature" 2>/dev/null
  chmod 600 "$KEY"
fi

# ---- 2. Sync to vault/ca.crt (baked into harness images) -----------------
if ! cmp -s "$CRT" "$REPO_CA" 2>/dev/null; then
  info "syncing $CRT → $REPO_CA (will trigger harness rebuild)"
  cp "$CRT" "$REPO_CA"
else
  info "$REPO_CA already matches"
fi

# ---- 3. Deploy as TLS secret if cluster exists ---------------------------
if kubectl --context "$CONTEXT" cluster-info >/dev/null 2>&1; then
  if kubectl --context "$CONTEXT" get secret vault-ca >/dev/null 2>&1; then
    info "secret vault-ca exists — deleting + recreating to pick up current cert"
    kubectl --context "$CONTEXT" delete secret vault-ca
  fi
  kubectl --context "$CONTEXT" create secret tls vault-ca \
    --cert="$CRT" --key="$KEY"
  info "✓ secret/vault-ca deployed to $CONTEXT"
else
  info "cluster $CONTEXT not reachable — secret step skipped"
  info "  re-run this script after bin/kind-up.sh has created the cluster"
fi

cat <<EOF

[vault-ca] done.

Local material:  $KEY (600), $CRT (644)
Baked into:      $REPO_CA  (harnesses/base/Dockerfile copies this at build time)
Cluster secret:  vault-ca (TLS) in context $CONTEXT
EOF
