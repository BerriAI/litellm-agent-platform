#!/usr/bin/env bash
#
# Provision a sandbox-ready EKS cluster from scratch.
#
# What it does:
#   1. Verifies AWS credentials and required CLIs.
#   2. Creates an EKS cluster (eksctl) with a small managed node group
#      and the NodePort range 30000-30099 exposed via a security-group
#      ingress rule.
#   3. Installs the kubernetes-sigs/agent-sandbox controller.
#   4. Writes a static service-account kubeconfig (long-lived token) to
#      stdout as base64 — paste into KUBE_CONFIG_B64 on Render / Railway.
#   5. Prints the K8S_NODE_HOST value (a public node IP).
#
# Usage:
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
#     bin/eks-up.sh > kube-config.b64
#
# Optional env:
#   CLUSTER_NAME    default: litellm-agents
#   NODE_TYPE       default: t3.medium  (4 GiB / 2 vCPU)
#   NODE_COUNT      default: 1
#   K8S_VERSION     default: 1.30
#   AGENT_SANDBOX_VERSION  default: v0.4.5
#
# Tear down:
#   eksctl delete cluster --name <CLUSTER_NAME> --region <AWS_REGION>

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-litellm-agents}"
# t3.large: 2 vCPU / 8 GiB. t3.medium (4 GiB) was insufficient — kubelet
# OOMd under modest concurrent sandbox load (~5-8 opencode pods doing
# git clone + sqlite migrate at once). Bump default and let operators
# downsize if their workload is lighter.
NODE_TYPE="${NODE_TYPE:-t3.large}"
# Two nodes by default so a single node failure doesn't take the cluster
# down. Cluster autoscaler can grow up to NODE_MAX (4) if warm pool
# capacity demands it.
NODE_COUNT="${NODE_COUNT:-2}"
NODE_MAX="${NODE_MAX:-4}"
K8S_VERSION="${K8S_VERSION:-1.30}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.4.5}"
NODEPORT_MIN="${K8S_NODEPORT_MIN:-30000}"
NODEPORT_MAX="${K8S_NODEPORT_MAX:-30099}"

err()  { printf "[eks-up] error: %s\n" "$*" >&2; exit 1; }
info() { printf "[eks-up] %s\n" "$*" >&2; }   # logs go to stderr; only the
                                              # base64 kubeconfig hits stdout

# Run any AWS CLI / eksctl / kubectl invocation with stdout redirected to
# stderr — these tools occasionally leak their own progress output to
# stdout, which would corrupt the base64 kubeconfig the caller captures
# at the end. Wrap external commands that aren't producing the final
# stdout payload.
silent() { "$@" >&2; }

# ---- 1. Prereqs ----------------------------------------------------------
command -v aws     >/dev/null || err "aws cli not installed"
command -v eksctl  >/dev/null || err "eksctl not installed (brew install eksctl)"
command -v kubectl >/dev/null || err "kubectl not installed"
command -v jq      >/dev/null || err "jq not installed"

: "${AWS_REGION:?AWS_REGION required}"
aws sts get-caller-identity >/dev/null \
  || err "AWS credentials missing or invalid"

# ---- 2. Cluster ----------------------------------------------------------
if eksctl get cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
     >/dev/null 2>&1; then
  info "cluster '$CLUSTER_NAME' already exists; reusing"
else
  info "creating EKS cluster '$CLUSTER_NAME' in $AWS_REGION (~15 min)"
  silent eksctl create cluster \
    --name "$CLUSTER_NAME" \
    --region "$AWS_REGION" \
    --version "$K8S_VERSION" \
    --nodegroup-name default \
    --node-type "$NODE_TYPE" \
    --nodes "$NODE_COUNT" \
    --nodes-min 1 --nodes-max "$NODE_MAX" \
    --managed
fi

# Open the full EKS default NodePort range (30000-32767) on the node
# security group. EKS's apiserver uses its default Service node-port range
# and we don't override it from outside, so allocations land anywhere in
# 30000-32767. Restricting the SG to a subset means most Sandbox spawns
# would assign a port the platform can't reach.
NG_SG=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
          --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' \
          --output text)
info "opening NodePort 30000-32767 on $NG_SG"
aws ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$NG_SG" \
  --ip-permissions \
    "IpProtocol=tcp,FromPort=30000,ToPort=32767,IpRanges=[{CidrIp=0.0.0.0/0}]" \
  >/dev/null 2>&1 || true   # idempotent — duplicate rule is fine

# ---- 3. agent-sandbox controller ----------------------------------------
info "installing agent-sandbox $AGENT_SANDBOX_VERSION"
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml" \
  >&2
kubectl -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=300s >&2

# ---- 4. Service-account kubeconfig --------------------------------------
# eksctl's default kubeconfig uses `aws eks get-token` (short-lived). For
# Render / Railway we need a static long-lived token.
SA_NS="default"
SA_NAME="litellm-agents-deployer"
info "creating service account $SA_NS/$SA_NAME with cluster-admin"
kubectl -n "$SA_NS" create serviceaccount "$SA_NAME" \
  --dry-run=client -o yaml | kubectl apply -f - >&2
kubectl create clusterrolebinding "${SA_NAME}-binding" \
  --clusterrole=cluster-admin \
  --serviceaccount="${SA_NS}:${SA_NAME}" \
  --dry-run=client -o yaml | kubectl apply -f - >&2

# Mint a service-account token. EKS caps duration at 24h regardless of
# what we request — projected service-account tokens don't honor longer
# expirations. Operators should re-run this script (it's idempotent on
# the SA + binding) on a schedule, or move to IRSA for in-cluster
# workloads.
TOKEN=$(kubectl create token "$SA_NAME" -n "$SA_NS" --duration=24h)

# Extract the cluster's server + CA from the AWS API directly. We cannot
# rely on `kubectl config view --raw -o jsonpath='{.clusters[0]...}'` —
# the host's kubeconfig may have multiple clusters from prior eksctl /
# `aws eks update-kubeconfig` runs, and `[0]` is whichever happens to be
# first. Pulling from EKS guarantees the right cluster.
APISERVER=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
              --query 'cluster.endpoint' --output text)
CA_DATA=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
              --query 'cluster.certificateAuthority.data' --output text)

KUBECONFIG_BODY=$(cat <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${APISERVER}
    certificate-authority-data: ${CA_DATA}
  name: ${CLUSTER_NAME}
contexts:
- context:
    cluster: ${CLUSTER_NAME}
    user: ${SA_NAME}
    namespace: ${SA_NS}
  name: ${CLUSTER_NAME}
current-context: ${CLUSTER_NAME}
users:
- name: ${SA_NAME}
  user:
    token: ${TOKEN}
EOF
)

# ---- 5. Output -----------------------------------------------------------
NODE_HOST=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}')
if [ -z "$NODE_HOST" ]; then
  NODE_HOST=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalDNS")].address}')
fi

info ""
info "=== READY ==="
info "K8S_NODE_HOST=$NODE_HOST"
info "Paste the base64 string below into KUBE_CONFIG_B64 on Render / Railway:"
info ""

# Only base64 hits stdout — easy to capture with `bin/eks-up.sh > kube.b64`.
printf '%s' "$KUBECONFIG_BODY" | base64 | tr -d '\n'
echo
