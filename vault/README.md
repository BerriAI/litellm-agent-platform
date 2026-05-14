# vault

A ~200-line HTTPS forward proxy that swaps stub credentials for real values at egress, so the AI agent process can hold only stubs in its env.

## How it works

```
agent (env: GITHUB_TOKEN=stub_xxx)
  │  https://api.github.com/... with Bearer stub_xxx
  ▼
vault (127.0.0.1:14322, MITMs via per-pod CA)
  │  scan request → swap stub_xxx → ghp_real
  ▼
api.github.com
```

1. Reads `REAL_<KEY>` env vars at boot, mints a stub for each.
2. Writes `KEY=stub` to `/lap-shared/env`. The harness entrypoint sources this so the agent's env contains only stubs.
3. Loads the cluster CA from `/etc/vault-ca/` (a K8s TLS secret). The CA cert is also baked into the harness image's system trust store at build time, so every binary in the sandbox trusts vault's MITM out of the box.
4. Mints per-host TLS leaf certs on demand, signed by the CA.
5. On every CONNECT, terminates TLS, scans headers + text-y bodies for known stubs, swaps each for the real value, forwards to upstream.

## Deployment

- Generate a cluster CA once. Use `genpkey` for the private key — WebCrypto only imports PKCS#8, and OpenSSL 1.1.x's `req -newkey` emits PKCS#1 by default:
  ```
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out tls.key
  openssl req -new -x509 -key tls.key -out tls.crt -sha256 -days 3650 \
    -subj "/CN=vault/O=LiteLLM" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,digitalSignature"
  ```
- Store as K8s TLS secret named `vault-ca` (key + cert).
- Bake the cert into every harness image at build time: `COPY vault/ca.crt /usr/local/share/ca-certificates/vault.crt && update-ca-certificates`.
- Sidecar mounts the secret at `/etc/vault-ca` and reads it at boot. Private key never leaves the sidecar.

## Endpoints

- `GET /healthz` — returns `{status, stubs}`.
- `CONNECT host:port` — the load-bearing path.
