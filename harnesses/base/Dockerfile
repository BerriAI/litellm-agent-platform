# syntax=docker/dockerfile:1.7
#
# Base harness image — shared foundation for all LAP sandbox harnesses.
# Every harness extends this with FROM harnesses/base:dev (or the registry tag).
#
# Build from repo root:
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev .
#
# Includes:
#   - Debian bookworm-slim + Node 20
#   - Common apt deps (git, curl, python3, jq, make, g++, tmux, ripgrep,
#     python3-venv, python3-dev, ca-certificates, fonts-liberation,
#     Playwright chromium system deps)
#   - gh CLI pinned at 2.92.0 (arch-aware: amd64 + arm64)
#   - uv pinned at 0.5.13 (arch-aware: x86_64 / aarch64)
#   - Jaeger all-in-one v1.62.0 (arch-aware: amd64 + arm64)
#   - Vault CA baked into all trust paths
#   - sandbox user (uid 1001) + /work dir
#
# Each harness is responsible for:
#   - Installing its own agent binary / SDK
#   - Setting WORKDIR, EXPOSE, USER, ENTRYPOINT

FROM node:20-bookworm-slim

# ------------------------------------------------------------------ apt deps
# Core tools + build deps for node-pty native binding + Python venv support
# + Playwright chromium system libraries (system deps only; no npm package).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash curl jq \
      python3 python3-venv python3-dev \
      make g++ \
      tmux ripgrep \
      # Playwright chromium system deps — allows harnesses to run chromium
      # without installing the npm package here (harness installs playwright).
      libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 \
      libatk-bridge2.0-0 libcups2 libdrm2 libxcb1 libxkbcommon0 \
      libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------ gh CLI
# Pinned release + per-arch SHA-256. Checksums from the official
# gh_<version>_checksums.txt file alongside the release assets.
# TARGETARCH is set automatically by `docker buildx build --platform`.
ARG GH_VERSION=2.92.0
ARG GH_SHA256_AMD64=8f8212b1a9cec261a8839e0893168f50d3fc70f095da257feef4229234cefdf8
ARG GH_SHA256_ARM64=34d620b7c884774ed86236541535170889fda0b99aafbdab8b69c7d458b5ca6b
ARG TARGETARCH

RUN case "${TARGETARCH}" in \
      amd64) GH_ARCH=amd64; GH_SHA256="${GH_SHA256_AMD64}" ;; \
      arm64) GH_ARCH=arm64; GH_SHA256="${GH_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/gh.deb \
         "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb \
    && rm /tmp/gh.deb

# ------------------------------------------------------------------ uv
# Static binary release pinned by version. SHA-256 verified against astral's
# per-asset .sha256 sidecar file (same pattern as the hermes harness).
# No `curl | sh` — binary is downloaded, checksummed, then extracted.
ARG UV_VERSION=0.5.13

RUN case "${TARGETARCH}" in \
      amd64) UV_TARGET="x86_64-unknown-linux-gnu" ;; \
      arm64) UV_TARGET="aarch64-unknown-linux-gnu" ;; \
      *) \
        # Fallback: derive target from uname in case TARGETARCH is unset
        # (single-platform build without --platform flag).
        UNAME_M=$(uname -m); \
        case "$UNAME_M" in \
          x86_64)  UV_TARGET="x86_64-unknown-linux-gnu" ;; \
          aarch64) UV_TARGET="aarch64-unknown-linux-gnu" ;; \
          *) echo "Unsupported arch: $UNAME_M" >&2; exit 1 ;; \
        esac \
      ;; \
    esac \
    && cd /tmp \
    && curl -fsSL -o uv.tar.gz \
         "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz" \
    && curl -fsSL -o uv.tar.gz.sha256 \
         "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz.sha256" \
    && EXPECTED=$(awk '{print $1}' uv.tar.gz.sha256) \
    && ACTUAL=$(sha256sum uv.tar.gz | awk '{print $1}') \
    && if [ "$EXPECTED" != "$ACTUAL" ]; then \
         echo "uv checksum mismatch: expected $EXPECTED got $ACTUAL" >&2; exit 1; \
       fi \
    && tar -xzf uv.tar.gz \
    && install -m 0755 "uv-${UV_TARGET}/uv"  /usr/local/bin/uv \
    && install -m 0755 "uv-${UV_TARGET}/uvx" /usr/local/bin/uvx \
    && rm -rf uv.tar.gz uv.tar.gz.sha256 "uv-${UV_TARGET}" \
    && uv --version

# ------------------------------------------------------------------ Jaeger
# All-in-one binary for distributed tracing. Pinned version; arch-aware.
# Release ships `jaeger-<version>-linux-<arch>.tar.gz` with a sibling
# `jaeger-<version>-linux-<arch>.sha256sum.txt` containing per-binary
# checksums (BSD-style: `<hash> *<dir>/<name>`). We verify the
# jaeger-all-in-one entry before installing — same checksum-sidecar
# pattern as the `uv` block above.
ARG JAEGER_VERSION=1.62.0

RUN case "${TARGETARCH}" in \
      amd64) ARCH=amd64 ;; \
      arm64) ARCH=arm64 ;; \
      *) \
        UNAME_M=$(uname -m); \
        case "$UNAME_M" in \
          x86_64)  ARCH=amd64 ;; \
          aarch64) ARCH=arm64 ;; \
          *) echo "Unsupported arch: $UNAME_M" >&2; exit 1 ;; \
        esac \
      ;; \
    esac \
    && cd /tmp \
    && JAEGER_DIR="jaeger-${JAEGER_VERSION}-linux-${ARCH}" \
    && TARBALL="${JAEGER_DIR}.tar.gz" \
    && SIDECAR="${JAEGER_DIR}.sha256sum.txt" \
    && curl -fsSL -o "${TARBALL}" \
         "https://github.com/jaegertracing/jaeger/releases/download/v${JAEGER_VERSION}/${TARBALL}" \
    && curl -fsSL -o "${SIDECAR}" \
         "https://github.com/jaegertracing/jaeger/releases/download/v${JAEGER_VERSION}/${SIDECAR}" \
    && tar -xzf "${TARBALL}" \
    && grep " \*${JAEGER_DIR}/jaeger-all-in-one$" "${SIDECAR}" | sha256sum -c - \
    && install -m 0755 "${JAEGER_DIR}/jaeger-all-in-one" /usr/local/bin/jaeger-all-in-one \
    && rm -rf "${TARBALL}" "${SIDECAR}" "${JAEGER_DIR}"

# ------------------------------------------------------------------ vault CA
# The vault sidecar MITM-proxies all egress HTTPS to swap credential stubs
# for real values. Bake the CA into every trust path the sandbox uses —
# git, curl, Node, Python, OpenSSL — so no per-process env-var configuration
# is needed. `update-ca-certificates` handles hash symlinks; the explicit
# append covers the concatenated bundle file (where Debian's
# update-ca-certificates is unreliable for locally-added CAs);
# `openssl rehash` ensures the symlink dir is consistent.
COPY vault/ca.crt /etc/ssl/certs/vault.crt
RUN ln -sf /etc/ssl/certs/vault.crt /usr/local/share/ca-certificates/vault.crt \
    && update-ca-certificates \
    && cat /etc/ssl/certs/vault.crt >> /etc/ssl/certs/ca-certificates.crt \
    && openssl rehash /etc/ssl/certs/

# ------------------------------------------------------------------ sandbox user + /work
RUN useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /work \
    && chown sandbox:sandbox /work

# Each harness sets its own WORKDIR, EXPOSE, USER sandbox, and ENTRYPOINT.
