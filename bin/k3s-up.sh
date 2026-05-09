#!/usr/bin/env bash
#
# Provision a single-node k3s cluster on a Fly.io machine.
#
# Why: EKS/GKE control planes take 5-15 min. A Fly machine boots in ~10s
# and k3s self-installs in ~30s, so this script gets you a working
# Kubernetes cluster + the agent-sandbox controller in under ~60s.
#
# Trade-offs vs managed k8s:
#   - One node. Good for small/medium self-hosted deployments; bad for
#     anything that needs HA control plane.
#   - You own the host. No SOC2-blessed managed control plane.
#   - ~$5-10/mo for a `shared-cpu-2x` machine with 2 GiB RAM.
#
# Usage:
#   FLY_API_TOKEN=fo1_... \
#     bin/k3s-up.sh > kube-config.b64
#
# Optional env:
#   FLY_APP        default: litellm-agents-k3s
#   FLY_REGION     default: iad
#   MACHINE_SIZE   default: shared-cpu-2x  (2 vCPU / 2 GiB)
#   K3S_VERSION    default: v1.30.5+k3s1
#   AGENT_SANDBOX_VERSION  default: v0.4.5
#
# Tear down:
#   flyctl apps destroy <FLY_APP>

set -euo pipefail

FLY_APP="${FLY_APP:-litellm-agents-k3s}"
FLY_REGION="${FLY_REGION:-iad}"
MACHINE_SIZE="${MACHINE_SIZE:-shared-cpu-2x}"
MACHINE_MEMORY="${MACHINE_MEMORY:-2048}"
K3S_VERSION="${K3S_VERSION:-v1.30.5+k3s1}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.4.5}"
NODEPORT_MIN="${K8S_NODEPORT_MIN:-30000}"
NODEPORT_MAX="${K8S_NODEPORT_MAX:-30099}"

err()  { printf "[k3s-up] error: %s\n" "$*" >&2; exit 1; }
info() { printf "[k3s-up] %s\n" "$*" >&2; }

# ---- 1. Prereqs ----------------------------------------------------------
command -v flyctl  >/dev/null || err "flyctl not installed (curl -L https://fly.io/install.sh | sh)"
command -v kubectl >/dev/null || err "kubectl not installed"

: "${FLY_API_TOKEN:?FLY_API_TOKEN required}"
export FLY_API_TOKEN

flyctl auth whoami >/dev/null 2>&1 || err "flyctl token rejected"

# ---- 2. Fly app + IPv4 ---------------------------------------------------
if flyctl apps list --json | grep -q "\"$FLY_APP\""; then
  info "app '$FLY_APP' exists; reusing"
else
  info "creating Fly app '$FLY_APP'"
  flyctl apps create "$FLY_APP" --org personal >&2
fi

# Public IPv4 — k3s API server + NodePort range need to be reachable from
# external web/worker hosts. IPv6 is free; v4 costs $2/mo.
if ! flyctl ips list -a "$FLY_APP" 2>/dev/null | grep -q v4; then
  info "allocating shared IPv4"
  flyctl ips allocate-v4 --shared -a "$FLY_APP" >&2 || \
    flyctl ips allocate-v4 -a "$FLY_APP" >&2
fi

# ---- 3. Boot k3s machine -------------------------------------------------
# Build a port-spec list: 6443 (k8s API) + NodePort range.
PORT_FLAGS=("--port" "6443:6443/tcp")
for p in $(seq "$NODEPORT_MIN" "$NODEPORT_MAX"); do
  PORT_FLAGS+=("--port" "$p:$p/tcp")
done

if flyctl machine list -a "$FLY_APP" --json | grep -q '"state":"started"'; then
  info "machine already running on '$FLY_APP'; reusing"
  MACHINE_ID=$(flyctl machine list -a "$FLY_APP" --json \
    | python3 -c 'import sys, json; print(json.load(sys.stdin)[0]["id"])')
else
  info "booting k3s machine on $FLY_REGION ($MACHINE_SIZE)"
  # rancher/k3s image starts a single-node server when invoked with
  # `server`. --tls-san covers the Fly hostname for cert validation.
  MACHINE_OUT=$(flyctl machine run "rancher/k3s:${K3S_VERSION}" \
    --app "$FLY_APP" \
    --region "$FLY_REGION" \
    --size "$MACHINE_SIZE" \
    --memory "$MACHINE_MEMORY" \
    --entrypoint "" \
    --env "K3S_KUBECONFIG_OUTPUT=/var/lib/rancher/k3s/k3s.yaml" \
    --env "K3S_KUBECONFIG_MODE=644" \
    "${PORT_FLAGS[@]}" \
    -- server --tls-san "$FLY_APP.fly.dev" --disable=traefik 2>&1)
  MACHINE_ID=$(echo "$MACHINE_OUT" | grep -oE 'ID: [a-z0-9]+' | awk '{print $2}' | head -1)
  [ -n "$MACHINE_ID" ] || err "failed to capture machine id from flyctl output"
fi

# ---- 4. Wait for k3s API server -----------------------------------------
HOST="$FLY_APP.fly.dev"
info "waiting for k3s API at https://$HOST:6443"
for i in $(seq 1 60); do
  if curl -sk --max-time 3 "https://$HOST:6443/healthz" 2>/dev/null | grep -q ok; then
    break
  fi
  sleep 2
  if [ "$i" = 60 ]; then err "k3s API never came up at $HOST:6443"; fi
done

# ---- 5. Pull kubeconfig from machine ------------------------------------
info "pulling kubeconfig"
RAW=$(flyctl ssh console -a "$FLY_APP" -C "cat /var/lib/rancher/k3s/k3s.yaml" 2>/dev/null)
[ -n "$RAW" ] || err "failed to read /var/lib/rancher/k3s/k3s.yaml"

# k3s writes server: https://127.0.0.1:6443. Rewrite to the Fly hostname.
KUBECONFIG_BODY=$(echo "$RAW" | sed -E "s#https://127\\.0\\.0\\.1:6443#https://${HOST}:6443#g")

# Persist locally so subsequent kubectl calls in this script use it.
TMP_KCFG=$(mktemp)
trap 'rm -f "$TMP_KCFG"' EXIT
printf '%s' "$KUBECONFIG_BODY" > "$TMP_KCFG"

# ---- 6. agent-sandbox controller ----------------------------------------
info "installing agent-sandbox $AGENT_SANDBOX_VERSION"
KUBECONFIG="$TMP_KCFG" kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml" \
  --insecure-skip-tls-verify=true >&2
KUBECONFIG="$TMP_KCFG" kubectl --insecure-skip-tls-verify=true \
  -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=180s >&2

# ---- 7. Long-lived service account + scoped kubeconfig ------------------
SA_NS="default"
SA_NAME="litellm-agents-deployer"
KUBECONFIG="$TMP_KCFG" kubectl --insecure-skip-tls-verify=true \
  -n "$SA_NS" create serviceaccount "$SA_NAME" \
  --dry-run=client -o yaml | KUBECONFIG="$TMP_KCFG" \
  kubectl --insecure-skip-tls-verify=true apply -f - >&2
KUBECONFIG="$TMP_KCFG" kubectl --insecure-skip-tls-verify=true \
  create clusterrolebinding "${SA_NAME}-binding" \
  --clusterrole=cluster-admin \
  --serviceaccount="${SA_NS}:${SA_NAME}" \
  --dry-run=client -o yaml | KUBECONFIG="$TMP_KCFG" \
  kubectl --insecure-skip-tls-verify=true apply -f - >&2

TOKEN=$(KUBECONFIG="$TMP_KCFG" kubectl --insecure-skip-tls-verify=true \
  create token "$SA_NAME" -n "$SA_NS" --duration=87600h)

# Build the final kubeconfig: same server, SA token, skipTLSVerify since
# the k3s self-signed cert won't pass strict verification in clients that
# don't honor the bundled CA.
FINAL_KUBECONFIG=$(cat <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://${HOST}:6443
    insecure-skip-tls-verify: true
  name: ${FLY_APP}
contexts:
- context:
    cluster: ${FLY_APP}
    user: ${SA_NAME}
    namespace: ${SA_NS}
  name: ${FLY_APP}
current-context: ${FLY_APP}
users:
- name: ${SA_NAME}
  user:
    token: ${TOKEN}
EOF
)

# ---- 8. Output -----------------------------------------------------------
info ""
info "=== READY ==="
info "K8S_NODE_HOST=$HOST"
info "Paste the base64 string below into KUBE_CONFIG_B64:"
info ""

printf '%s' "$FINAL_KUBECONFIG" | base64 | tr -d '\n'
echo
