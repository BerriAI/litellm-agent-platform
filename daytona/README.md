# Daytona sandbox template for LiteLLM

Port of `e2b/` to Daytona. Same pre-bake (postgres + `litellm[proxy]` + uv) so the agent's first `execute` isn't a 15-min apt+pip wait.

## Build the snapshot (once per Dockerfile change)

```bash
DAYTONA_API_KEY=<key> node daytona/build-snapshot.mjs
```

Streams build logs to stderr. On success, set on the LAP platform service:

```
SANDBOX_CHOICE=daytona
DAYTONA_API_KEY=<key>
DAYTONA_SNAPSHOT=litellm-8gb
```

(Or `DAYTONA_IMAGE=ubuntu:22.04` for a vanilla base with no pre-bake — first turn is slow but doesn't need a snapshot.)

## Resources

Baked at snapshot build time via `Resources` (cpu / memory GB / disk GB). Defaults: 2 vCPU, 8 GB memory, 10 GB disk (Daytona's default per-sandbox cap; ask support for more). Override with `DAYTONA_MEMORY_GB`, `DAYTONA_CPU`, `DAYTONA_DISK_GB`.

## Notes vs E2B

- No `e2b.toml` equivalent — resources go via the build script.
- No `start_cmd` — Daytona doesn't auto-run a boot command. Either source `dev-up` on first `execute`, or wrap commands at provision time. The existing `start-db` is in `/usr/local/bin/` for convenience.
- The base image is `ubuntu:22.04` (no Python preinstalled), so the Dockerfile installs `python3`/`python3-pip` explicitly. E2B's `code-interpreter` base had it.
- A `user` account is `useradd`'d explicitly (E2B's base provided it).
