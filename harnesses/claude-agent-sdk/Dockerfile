# syntax=docker/dockerfile:1.7
#
# Claude Agent SDK harness — peer of harnesses/opencode.
#
# Same shape as the opencode image (debian-slim runtime, sandbox user,
# /work workdir, port 4096, entrypoint clones $REPO_URL then starts the
# server). The differences:
#   - no opencode binary; we ship a Node server that drives @anthropic-ai/claude-agent-sdk
#   - pre-install gh + uv so agents don't have to bootstrap them at runtime
#     (the gap that bit session adc694c3 / 2f12d7b3 today).

# NOTE: build context is the repo root. This Dockerfile lives under
# harnesses/claude-agent-sdk/ but it COPYs the platform-level
# `managed-tools/` package too:
#   docker buildx build -f harnesses/claude-agent-sdk/Dockerfile .

FROM node:20-bookworm AS builder

# Shared tool-spec package — built first so the harness's `file:` dep
# resolves to compiled .js + .d.ts at install time. Path mirrors the
# source tree so the package.json's `file:../../managed-tools` resolves.
WORKDIR /build/managed-tools
COPY managed-tools/package.json managed-tools/tsconfig.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY managed-tools/src ./src
RUN npx tsc

# Harness server — depth-2 path mirrors the source layout
# (harnesses/claude-agent-sdk/) so file: resolves up two levels.
WORKDIR /build/harnesses/claude-agent-sdk
COPY harnesses/claude-agent-sdk/package.json harnesses/claude-agent-sdk/tsconfig.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY harnesses/claude-agent-sdk/src ./src
RUN npx tsc

# ------------------------------------------------------------------ runtime
FROM node:20-bookworm-slim

# gh CLI: pinned release + checksum (matches the opencode harness's posture).
ARG GH_VERSION=2.92.0
ARG GH_SHA256=8f8212b1a9cec261a8839e0893168f50d3fc70f095da257feef4229234cefdf8

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash python3 curl jq \
    && curl -fsSL -o /tmp/gh.deb \
         "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb \
    && rm /tmp/gh.deb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /work \
    && chown sandbox:sandbox /work

# gitleaks — secret scanner used by security agent templates.
# Uses Go-style arch names (x64/arm64), not dpkg names (amd64/arm64).
ARG GITLEAKS_VERSION=8.18.4
RUN case "$(uname -m)" in x86_64) GL_ARCH=x64 ;; aarch64) GL_ARCH=arm64 ;; *) GL_ARCH=$(uname -m) ;; esac \
    && TARBALL="gitleaks_${GITLEAKS_VERSION}_linux_${GL_ARCH}.tar.gz" \
    && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${TARBALL}" \
         -o /tmp/gitleaks.tar.gz \
    && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" \
         -o /tmp/gitleaks_checksums.txt \
    && EXPECTED=$(grep "${TARBALL}" /tmp/gitleaks_checksums.txt | awk '{print $1}') \
    && echo "${EXPECTED}  /tmp/gitleaks.tar.gz" | sha256sum -c - \
    && tar -xz -C /usr/local/bin -f /tmp/gitleaks.tar.gz gitleaks \
    && rm /tmp/gitleaks.tar.gz /tmp/gitleaks_checksums.txt

# uv — installed to a system path so $PATH already finds it for any user.
# Static binary release; no shell pipe.
ARG UV_VERSION=0.5.13
RUN curl -fsSL -o /tmp/uv.tar.gz \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
    && tar -xzf /tmp/uv.tar.gz -C /tmp \
    && install -m 0755 "/tmp/uv-x86_64-unknown-linux-gnu/uv" /usr/local/bin/uv \
    && install -m 0755 "/tmp/uv-x86_64-unknown-linux-gnu/uvx" /usr/local/bin/uvx \
    && rm -rf /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu

# Harness server — only the production node_modules + compiled JS. We do a
# fresh `npm install --omit=dev` here so the runtime image doesn't carry
# tsc / @types — keeps the layer small. The managed-tools package must be
# co-located at ../../managed-tools (same depth ratio as the source tree)
# so the `file:` dep resolves at install time.
COPY --from=builder /build/managed-tools/package.json /opt/managed-tools/package.json
COPY --from=builder /build/managed-tools/dist /opt/managed-tools/dist
# Install managed-tools' own runtime deps (e.g. zod) so that when npm
# symlinks this package via `file:` the dist files can resolve their imports.
WORKDIR /opt/managed-tools
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

WORKDIR /opt/harnesses/claude-agent-sdk
COPY --from=builder /build/harnesses/claude-agent-sdk/package.json ./
COPY --from=builder /build/harnesses/claude-agent-sdk/dist ./dist
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps \
    && chown -R sandbox:sandbox /opt/harnesses /opt/managed-tools \
    # Symlink the SDK's bundled `claude` binary into a stable PATH location
    # so the SDK's auto-resolver finds it regardless of cwd, AND so an agent
    # running inside the sandbox can invoke `claude` as a tool too.
    && ln -sf /opt/harnesses/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude \
         /usr/local/bin/claude

WORKDIR /work
COPY --chown=sandbox:sandbox harnesses/claude-agent-sdk/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

USER sandbox
EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
