# gemini TUI harness
#
# Browser <--ws--> this container <--pty--> gemini CLI (Google)
#
# Build from repo root:
#   docker buildx build -f harnesses/gemini/Dockerfile -t gemini-sandbox:dev .

FROM node:20-bookworm-slim

# Build deps for node-pty's native binding + runtime deps.
# curl is required by the phase reporter in entrypoint-common.sh.
# tmux holds the agent PTY across WS reconnects so `lap --resume` lands on
# the same in-progress gemini session instead of a fresh REPL.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash curl python3 make g++ tmux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @google/gemini-cli@latest

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
COPY harnesses/gemini/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/gemini/server.js ./

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/gemini/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /work/repo /home/sandbox/.gemini \
    && chown -R sandbox:sandbox /work /app /home/sandbox/.gemini

ENV PORT=4096
ENV REPO_DIR=/work/repo
# `--yolo` bypasses Gemini CLI's interactive approval prompt so tool calls
# execute inside the sandbox without a human in the loop — same posture as
# every other LAP TUI harness. The vault sidecar and sandbox pod are the
# security boundary; the in-CLI approval gate is redundant here.
# server.js splits POC_CMD on whitespace to support argv.
ENV POC_CMD="gemini --yolo"
ENV TERM=xterm-256color
# Disable Gemini CLI's inner Docker/Podman sandbox — pointless inside our
# k8s pod, and it would try to spawn a nested container (which won't have
# Docker available anyway). The platform pod IS the sandbox.
ENV GEMINI_SANDBOX=false

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]
