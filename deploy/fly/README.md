# Fly.io

Whole stack on Fly: Postgres + web + worker + k3s sandbox cluster.
Bring your own LiteLLM endpoint.

## One script

```bash
FLY_API_TOKEN=fo1_... \
LITELLM_API_BASE=https://your-litellm-host \
LITELLM_API_KEY=sk-... \
K8S_HARNESS_IMAGE=ghcr.io/you/opencode-sandbox:latest \
  bin/fly-deploy.sh
```

What it does (~3-4 min total, mostly Fly machine boot + k3s install):

1. Creates Fly Postgres (`litellm-agents-pg`).
2. Spins a k3s sandbox cluster on a Fly machine — see [`bin/k3s-up.sh`](../../bin/k3s-up.sh).
3. Creates `litellm-agents-web`, attaches Postgres, sets secrets, deploys.
4. Creates `litellm-agents-worker`, attaches Postgres, sets secrets, deploys.

Output ends with the web URL and the auto-generated `MASTER_KEY`.

## Stack

| Component        | Fly resource                                         |
|------------------|------------------------------------------------------|
| `postgres`       | Fly Postgres cluster                                 |
| `web`            | Fly app from `Dockerfile` target=`runner`            |
| `worker`         | Fly app from `Dockerfile` target=`worker`            |
| `sandbox cluster`| Fly machine running `rancher/k3s` + agent-sandbox CRD |

LiteLLM is **not** provisioned. Bring your own — anything that speaks
OpenAI's `/chat/completions` wire format works.

## Configs

- [`fly.toml`](../../fly.toml) — web app config (target `runner`).
- [`fly.worker.toml`](../../fly.worker.toml) — worker app config (target `worker`).
- [`bin/fly-deploy.sh`](../../bin/fly-deploy.sh) — orchestrator.
- [`bin/k3s-up.sh`](../../bin/k3s-up.sh) — sandbox cluster provisioner.

## Cluster credentials

`bin/k3s-up.sh` outputs a base64-encoded kubeconfig + the Fly hostname.
`src/server/k8s.ts` reads `KUBE_CONFIG_B64` directly — no kubeconfig
file is written to disk in the web/worker containers.

The minted service account holds `cluster-admin` and a 10-year token.
Re-run `bin/k3s-up.sh` to rotate it (idempotent on the SA + binding).

## Required env / secrets

Set as Fly app secrets — `bin/fly-deploy.sh` does this for you, but
documented here for manual operations:

```ini
DATABASE_URL=             # wired by `flyctl postgres attach`
MASTER_KEY=               # auto-gen
UI_USERNAME=admin
LITELLM_API_BASE=
LITELLM_API_KEY=
LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6
KUBE_CONFIG_B64=          # from bin/k3s-up.sh
K8S_NODE_HOST=            # from bin/k3s-up.sh (e.g. litellm-agents-k3s.fly.dev)
K8S_HARNESS_IMAGE=
K8S_NAMESPACE=default
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=30099
WARM_POOL_SIZE=2
PREINSTALLED_GITHUB_REPO=
```

## Gotchas

- **Public IPv4 on the k3s machine.** The script allocates a shared
  IPv4. The k3s API server (6443) and the NodePort range (30000-30099)
  must both be reachable from the web/worker. Fly's machine port
  mappings handle this.
- **`auto_stop_machines = "off"` on web.** Cold start wipes the
  in-memory session cache — the first message after the machine sleeps
  pays a Postgres round-trip. Off keeps the cache warm.
- **Worker must always be running.** `min_machines_running = 1` is
  implied by Fly's worker app shape — no public ports, no auto-stop.
- **Fly machine for k3s consumes RAM.** Default `shared-cpu-2x` /
  2 GiB fits ~10 idle sandboxes. Bump `MACHINE_SIZE` for warm-pool
  capacity past that.
- **Single-region cluster.** Sandbox NodePort calls cross the public
  internet from web/worker → k3s machine in the same region. For
  multi-region, run web/worker close to the cluster (or move the
  cluster nearer to the user).
- **No HA.** k3s here is single-node. Loses durability if the Fly
  machine reboots — sessions in flight die. Acceptable for self-hosted
  dev/SMB; not for prod-critical workloads.
