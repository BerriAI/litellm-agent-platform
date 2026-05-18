# hermes TUI harness
#
# Browser <--ws--> this container <--pty--> hermes CLI (Nous Research)
#
# Hermes is a Python project; we install it from a pinned release tag using
# uv. The Node WS bridge is the same pattern as the claude-code and codex
# harnesses — it just spawns the configured POC_CMD (default `hermes --tui`)
# inside a PTY.
#
# Build from repo root:
#   docker buildx build -f harnesses/hermes/Dockerfile -t hermes-sandbox:dev .

FROM node:20-bookworm-slim

# Build deps for node-pty's native binding + runtime deps for both the WS
# bridge and the Hermes Python install (python3, git for clone, ripgrep for
# hermes's code search, build tools for any pure-Python wheels that need
# compilation). tmux is the wrapper that survives WS reconnects — see
# server.js SPAWN_CMD / SPAWN_ARGS, same pattern as claude-code/codex.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash curl python3 python3-venv python3-dev \
      make g++ ripgrep tmux \
    && rm -rf /var/lib/apt/lists/*

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

# Install uv as a single static binary, pinned by version + SHA-256
# checksum from astral's per-asset `.sha256` sidecar. Following AGENTS.md
# CI Supply-Chain Safety: no `curl | sh` of an unpinned installer, and
# every downloaded binary has its digest verified before extraction.
ARG UV_VERSION=0.5.11
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64) UV_TARGET="x86_64-unknown-linux-gnu" ;; \
      aarch64) UV_TARGET="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac && \
    cd /tmp && \
    curl -fsSL -o uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz" && \
    curl -fsSL -o uv.tar.gz.sha256 "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz.sha256" && \
    EXPECTED=$(awk '{print $1}' uv.tar.gz.sha256) && \
    ACTUAL=$(sha256sum uv.tar.gz | awk '{print $1}') && \
    if [ "$EXPECTED" != "$ACTUAL" ]; then \
      echo "uv checksum mismatch: expected $EXPECTED got $ACTUAL" >&2; exit 1; \
    fi && \
    tar -xzf uv.tar.gz && \
    mv uv-${UV_TARGET}/uv /usr/local/bin/uv && \
    rm -rf uv.tar.gz uv.tar.gz.sha256 uv-${UV_TARGET} && \
    uv --version

# Clone hermes-agent at a pinned release tag and install into a venv at
# /opt/hermes. Skip the `[all]` extra (it pulls Playwright/Chromium + voice
# deps we don't need for a coding TUI).
ARG HERMES_VERSION=v2026.5.16
RUN git clone --depth 1 --branch ${HERMES_VERSION} \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes \
    && cd /opt/hermes \
    && uv venv /opt/hermes/.venv --python 3.11 \
    && . /opt/hermes/.venv/bin/activate \
    && uv pip install -e . \
    && ln -sf /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes

# Vault CA: the vault sidecar MITM-proxies all egress HTTPS to swap
# credential stubs for real values. Bake the CA into the OS trust store so
# git, curl, and Node trust the proxy TLS.
COPY vault/ca.crt /etc/ssl/certs/vault.crt
RUN ln -sf /etc/ssl/certs/vault.crt /usr/local/share/ca-certificates/vault.crt \
    && update-ca-certificates \
    && cat /etc/ssl/certs/vault.crt >> /etc/ssl/certs/ca-certificates.crt \
    && openssl rehash /etc/ssl/certs/

WORKDIR /app
COPY harnesses/hermes/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/hermes/server.js ./

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/hermes/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /work/repo /home/sandbox/.hermes \
    && chown -R sandbox:sandbox /work /app /home/sandbox/.hermes \
    && chown -R sandbox:sandbox /opt/hermes

ENV PORT=4096
ENV REPO_DIR=/work/repo
# `--tui` launches the modern Ink-based UI (plain `hermes` falls back to the
# legacy CLI which doesn't render over a bare PTY). `--yolo` bypasses the
# dangerous-command approval prompt so the agent can execute tool calls freely
# inside its sandbox — same posture as the other LAP harnesses, which all run
# inside vault-isolated containers where approval prompts add no real safety.
# server.js splits POC_CMD on whitespace to support argv.
ENV POC_CMD="hermes --tui --yolo"
ENV TERM=xterm-256color
ENV HERMES_HOME=/home/sandbox/.hermes

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]
