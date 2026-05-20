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
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev . && \
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
FROM harnesses/base:dev

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

# Harness server — only the production node_modules + compiled JS. We do a
# fresh `npm install --omit=dev` here so the runtime image doesn't carry
# tsc / @types — keeps the layer small. The managed-tools package must be
# co-located at ../../managed-tools (same depth ratio as the source tree)
# so the `file:` dep resolves at install time.
COPY --from=builder /build/managed-tools/package.json /opt/managed-tools/package.json
COPY --from=builder /build/managed-tools/dist /opt/managed-tools/dist
# Install managed-tools runtime deps INTO its own directory. Node ESM
# resolves `import` from the FILE's real path, not the symlinked
# `node_modules/@lap/managed-tools` path the harness sees — so the
# harness's hoisted `zod` is invisible from `/opt/managed-tools/dist/*.js`.
# Install the deps where memory.js etc. will actually look for them.
WORKDIR /opt/managed-tools
COPY managed-tools/.npmrc ./.npmrc
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps
# Playwright browsers — `npm install playwright` does NOT download browser
# binaries since v1.38, so `screenshot_url` would fail at runtime without an
# explicit install step. Pin the cache to /opt/ms-playwright (set BEFORE the
# install) so the binary lands in a path the sandbox user can read at
# runtime — the default location is $HOME/.cache/ms-playwright, which would
# resolve to /root/.cache/ during build and be unreadable by `sandbox`.
# Chromium system libs (libnss3, libxkbcommon0, fonts-liberation, etc.) are
# already installed in harnesses/base, so `--with-deps` is not needed.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

WORKDIR /opt/harnesses/claude-agent-sdk
COPY --from=builder /build/harnesses/claude-agent-sdk/package.json ./
COPY --from=builder /build/harnesses/claude-agent-sdk/dist ./dist
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps \
    && npx --no-install playwright install chromium \
    && chown -R sandbox:sandbox /opt/harnesses /opt/managed-tools /opt/ms-playwright \
    # Symlink the SDK's bundled `claude` binary into a stable PATH location
    # so the SDK's auto-resolver finds it regardless of cwd, AND so an agent
    # running inside the sandbox can invoke `claude` as a tool too.
    && ln -sf /opt/harnesses/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude \
         /usr/local/bin/claude

WORKDIR /work

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY --chown=sandbox:sandbox harnesses/claude-agent-sdk/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

USER sandbox
EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
