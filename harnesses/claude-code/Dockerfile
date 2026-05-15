# claude-tty harness
#
# Browser <--ws--> this container <--pty--> claude CLI
#
# Build from repo root:
#   docker buildx build -f harnesses/claude-code/Dockerfile -t claude-code-sandbox:dev .

FROM node:20-bookworm-slim

# Build deps for node-pty's native binding + runtime deps.
# curl is required by the phase reporter in entrypoint-common.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash curl python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@latest

# Vault CA: the vault sidecar MITM-proxies all egress HTTPS to swap
# credential stubs for real values. Bake the CA into the OS trust store so
# git, curl, and Node (via NODE_EXTRA_CA_CERTS) all trust the proxy TLS.
COPY vault/ca.crt /etc/ssl/certs/vault.crt
RUN ln -sf /etc/ssl/certs/vault.crt /usr/local/share/ca-certificates/vault.crt \
    && update-ca-certificates \
    && cat /etc/ssl/certs/vault.crt >> /etc/ssl/certs/ca-certificates.crt \
    && openssl rehash /etc/ssl/certs/

WORKDIR /app
COPY harnesses/claude-code/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/claude-code/server.js ./
COPY harnesses/claude-code/public ./public

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/claude-code/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /work/repo \
    && chown -R sandbox:sandbox /work /app

ENV PORT=4096
ENV REPO_DIR=/work/repo
ENV POC_CMD=claude
ENV TERM=xterm-256color

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]
