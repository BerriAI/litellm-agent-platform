# AWS

Web + worker on ECS Fargate or App Runner. Sandbox cluster is EKS in
the same account. Use IAM Roles for Service Accounts (IRSA) so pods
authenticate to the cluster without a kubeconfig on disk.

## Stack

| Component        | Service                                                  |
|------------------|----------------------------------------------------------|
| `web`            | ECS Fargate service (ALB) or App Runner                  |
| `worker`         | ECS Fargate service, no LB                               |
| `postgres`       | RDS Postgres or Aurora Serverless v2                     |
| `litellm-proxy`  | ECS Fargate service, `ghcr.io/berriai/litellm:main-stable` |
| `sandbox-runtime`| EKS Auto Mode (recommended) or EKS standard              |

Prereqs: `awscli`, `eksctl`, `kubectl`, `helm`. Region pinned via
`AWS_REGION`.

## Steps

1. **Provision EKS Auto Mode.** Auto Mode manages nodes + add-ons:
   ```bash
   eksctl create cluster --name litellm-agents --region "$AWS_REGION" \
     --enable-auto-mode --version 1.31
   ```
   ~10 min. Kubeconfig context is written locally.

2. **Install agent-sandbox controller.**
   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.5/manifest.yaml
   kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
   ```

3. **Push harness image to ECR.**
   ```bash
   ECR=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
   aws ecr create-repository --repository-name opencode-sandbox
   aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR"
   docker tag opencode-sandbox:dev "$ECR/opencode-sandbox:latest"
   docker push "$ECR/opencode-sandbox:latest"
   ```

4. **Set up IRSA for web/worker.** Auto Mode enables OIDC by default.
   For ECS Fargate, create an EKS access entry mapping the ECS task
   role ARN to a `ClusterRole` scoped to `K8S_NAMESPACE`, then in the
   task entrypoint:
   ```bash
   aws eks update-kubeconfig --name litellm-agents --region "$AWS_REGION"
   ```
   The task role does the token exchange — no static kubeconfig needed.

5. **Provision RDS.**
   ```bash
   aws rds create-db-instance --db-instance-identifier litellm-agents \
     --engine postgres --engine-version 16 --master-username litellm \
     --master-user-password "$DB_PASS" --db-instance-class db.t4g.small \
     --allocated-storage 20 --vpc-security-group-ids "$SG_ID"
   ```

6. **Deploy web/worker.** Build/push the platform image, register web
   and worker ECS task definitions, env per [§Env](#env). Task entrypoint
   runs `npx prisma migrate deploy` before `npm start` / `npm run worker`.

7. **Verify.** `aws ecs describe-services` plus `kubectl get sandbox -A`.

## Env

```ini
DATABASE_URL=postgres://litellm:...@<rds-endpoint>:5432/litellm_agents
MASTER_KEY=
UI_USERNAME=admin
LITELLM_API_BASE=http://litellm-proxy.litellm-agents.local:4000
LITELLM_API_KEY=
LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6

K8S_NAMESPACE=default
K8S_NODE_HOST=<eks-nlb-dns>       # NLB targeting node-port range
K8S_API_SERVER=                   # leave blank, kubeconfig from aws eks update-kubeconfig
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=30099
K8S_IMAGE_PULL_POLICY=IfNotPresent
K8S_HARNESS_IMAGE=<acct>.dkr.ecr.<region>.amazonaws.com/opencode-sandbox:latest

PREINSTALLED_GITHUB_REPO=
WARM_POOL_SIZE=2
```

## Gotchas

- **EKS access entry, not aws-auth.** Auto Mode uses access entries;
  `kubectl edit cm aws-auth` is a no-op.
- **NodePort + NLB.** Auto Mode doesn't expose static node IPs. Front
  the NodePort range with an internal NLB (target type `instance`),
  point `K8S_NODE_HOST` at its DNS.
- **Cross-account ECR.** Same-account pulls work by default; cross-
  account needs an explicit repository policy.
- **RDS private subnet.** Web/worker tasks must be in the same VPC or
  peered. Don't expose RDS publicly.
- **Region drift.** Cluster, ECR, RDS, ECS in the same region — cross-
  region NodePort traffic is billed and slow.
