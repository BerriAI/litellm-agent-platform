# Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BerriAI/litellm-agent-platform)

One click. Render reads [`render.yaml`](../../render.yaml) and creates:

| Resource         | Type                        |
|------------------|-----------------------------|
| Postgres         | Render managed Postgres     |
| `litellm-agents-web`    | Render Web Service   |
| `litellm-agents-worker` | Render Background Worker |

`MASTER_KEY` is auto-generated. `DATABASE_URL` is wired automatically.

## You provide

After Render finishes provisioning, fill these on the dashboard
(`Environment` tab, both web + worker — or use Render env groups):

| Var                  | Source                                                      |
|----------------------|-------------------------------------------------------------|
| `LITELLM_API_BASE`   | OpenAI-compatible `/chat/completions` endpoint (LiteLLM Cloud, your own LiteLLM proxy — anything that speaks OpenAI's wire format) |
| `LITELLM_API_KEY`    | API key for the above                                       |
| `KUBE_CONFIG_B64`    | base64-encoded kubeconfig from `bin/eks-up.sh` (exec-plugin — never expires) |
| `AWS_ACCESS_KEY_ID`  | the same IAM principal that ran `bin/eks-up.sh` — `aws-iam-authenticator` re-reads these on every k8s API call |
| `AWS_SECRET_ACCESS_KEY` |                                                          |
| `AWS_REGION`         | EKS cluster region, e.g. `us-east-1`                        |
| `K8S_NODE_HOST`      | `auto` (recommended — discover at request time) or stable LB hostname |
| `K8S_HARNESS_IMAGE`  | registry path of `opencode-sandbox:<tag>` your cluster pulls |

The platform never proxies the model itself — it just forwards
`/chat/completions` calls through `LITELLM_API_BASE`. Use `litellm.ai`
hosted, or run `ghcr.io/berriai/litellm:main-stable` anywhere.

## Sandbox cluster

Render does not host Kubernetes. Provision one elsewhere and bring the
kubeconfig:

| Cloud | Script                                              |
|-------|-----------------------------------------------------|
| AWS   | [`bin/eks-up.sh`](../../bin/eks-up.sh) — see [`../aws/`](../aws/) |
| GCP   | (similar GKE script — see [`../gcp/`](../gcp/))     |
| Other | install [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) on any cluster, then `kubectl config view --minify --flatten | base64` |

## Automation

[`AGENTS.md`](AGENTS.md) is an agent-friendly handover for scripted
deploys (LLM agents, CI). It enumerates inputs, the exact Render API
shapes, env contract, verification steps, and the failure modes worth
knowing about before you start.

## Gotchas

- **Egress is unpinned.** If your cluster apiserver / NodePort range is
  IP-allowlisted, buy Render's static-egress add-on or front the cluster
  with a public LB.
- **Auth runs via `aws-iam-authenticator` at every k8s API call.** The
  kubeconfig is an exec-plugin block — the binary mints a fresh token
  from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` on each request.
  The binary itself is installed by
  [`bin/install-aws-iam-authenticator.sh`](../../bin/install-aws-iam-authenticator.sh),
  invoked from both the Dockerfile (web) and `render.yaml`'s
  `buildCommand` (worker). If you fork either, keep that step.
- **First deploy will fail until you fill the `sync: false` vars.** That's
  expected — Render kicks off a build immediately, redeploy after pasting.
- **`npm ci` under `NODE_ENV=production` skips devDependencies.** The
  build commands in [`render.yaml`](../../render.yaml) pass
  `--include=dev` to keep Tailwind / Turbopack / tsx available. Don't
  drop the flag.
- **Stale `ready` rows poison the first request after re-pointing the
  cluster.** If the database previously served a different sandbox
  runtime (local kind, prior cluster), `Session` rows will have
  unreachable `sandbox_url` fields. The reconciler ghost-reaps them
  within 60s.
