# codex TUI harness
#
# Browser <--ws--> this container <--pty--> codex CLI (OpenAI)
#
# Build from repo root:
#   docker buildx build -f harnesses/codex/Dockerfile -t codex-sandbox:dev .

FROM node:20-bookworm-slim

# Build deps for node-pty's native binding + runtime deps.
# curl is required by the phase reporter in entrypoint-common.sh.
# tmux is the wrapper that survives WS reconnects — see server.js
# SPAWN_CMD / SPAWN_ARGS for the same pattern already used in claude-code.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash curl python3 make g++ tmux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@latest

# gh CLI: pinned release + checksum (matches the opencode / claude-agent-sdk
# harness posture). Required so agents can run `gh pr create`, `gh issue view`,
# etc. without bootstrapping the binary at runtime.
ARG GH_VERSION=2.92.0
ARG GH_SHA256=8f8212b1a9cec261a8839e0893168f50d3fc70f095da257feef4229234cefdf8
RUN curl -fsSL -o /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb \
    && rm /tmp/gh.deb

# Vault CA: the vault sidecar MITM-proxies all egress HTTPS to swap
# credential stubs for real values. Bake the CA into the OS trust store so
# git, curl, and Node (via NODE_EXTRA_CA_CERTS) all trust the proxy TLS.
COPY vault/ca.crt /etc/ssl/certs/vault.crt
RUN ln -sf /etc/ssl/certs/vault.crt /usr/local/share/ca-certificates/vault.crt \
    && update-ca-certificates \
    && cat /etc/ssl/certs/vault.crt >> /etc/ssl/certs/ca-certificates.crt \
    && openssl rehash /etc/ssl/certs/

WORKDIR /app
COPY harnesses/codex/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/codex/server.js ./

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/codex/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /work/repo \
    && chown -R sandbox:sandbox /work /app

ENV PORT=4096
ENV REPO_DIR=/work/repo
ENV POC_CMD=codex
ENV TERM=xterm-256color

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]
