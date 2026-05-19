# opencode harness
#
# Supports two modes via OPENCODE_MODE env var (default: tui):
#   tui   — WebSocket PTY bridge (Node server.js + tmux) for interactive use
#   serve — opencode's built-in HTTP server for programmatic sessions
#
# Build from repo root:
#   docker buildx build -f harnesses/opencode/Dockerfile -t opencode-sandbox:dev .

# ------------------------------------------------------------------ installer
FROM debian:bookworm-slim AS installer

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://opencode.ai/install | bash

# Drop install bundles / caches if any
RUN find /root/.opencode -maxdepth 2 -type d -name 'cache' -exec rm -rf {} + 2>/dev/null || true \
 && find /root/.opencode -maxdepth 2 -name '*.zip' -delete 2>/dev/null || true \
 && find /root/.opencode -maxdepth 2 -name '*.tar*' -delete 2>/dev/null || true

# ------------------------------------------------------------------ runtime
FROM debian:bookworm-slim

# gh CLI: pinned release + SHA-256 (no `curl | bash`, no unversioned URLs).
# To bump: update both ARGs together. SHA-256 is from the official
# gh_<version>_checksums.txt file alongside the release.
ARG GH_VERSION=2.92.0
ARG GH_SHA256_AMD64=8f8212b1a9cec261a8839e0893168f50d3fc70f095da257feef4229234cefdf8
ARG GH_SHA256_ARM64=34d620b7c884774ed86236541535170889fda0b99aafbdab8b69c7d458b5ca6b
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash python3 curl tmux make g++ python3-dev \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in \
         amd64) GH_ARCH=amd64; GH_SHA256="${GH_SHA256_AMD64}" ;; \
         arm64) GH_ARCH=arm64; GH_SHA256="${GH_SHA256_ARM64}" ;; \
         *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/gh.deb \
         "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb \
    && rm /tmp/gh.deb \
    && useradd -m -u 1000 -s /bin/bash sandbox \
    && mkdir -p /work \
    && chown sandbox:sandbox /work

ENV PORT=4096
ENV REPO_DIR=/work/repo
ENV OPENCODE_MODE=tui
ENV TERM=xterm-256color

COPY --from=installer --chown=sandbox:sandbox /root/.opencode /home/sandbox/.opencode
ENV PATH="/home/sandbox/.opencode/bin:${PATH}"

# Install Node.js for the WebSocket PTY bridge (TUI mode).
# node:20 ships with npm; we install it from the NodeSource deb for a lean
# single-layer install that shares the base debian-slim image.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY harnesses/opencode/package.json ./
RUN npm install --no-audit --no-fund
COPY harnesses/opencode/server.js ./

WORKDIR /work

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY --chown=sandbox:sandbox harnesses/opencode/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER sandbox

EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
