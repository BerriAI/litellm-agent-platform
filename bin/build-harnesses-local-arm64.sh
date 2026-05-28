#!/usr/bin/env bash
#
# Builds harness images for linux/arm64 (Apple Silicon dev). Wraps the
# `--provenance=false --sbom=false` quirk documented in AGENTS.md §1: with
# attestation enabled, buildx emits an OCI manifest list that `kind load
# docker-image` accepts but the CRI plugin never indexes, so pods fail with
# ErrImageNeverPull. The flat single-arch image is what containerd surfaces.
#
# Order matters: harnesses/base:dev must exist before claude-code / opencode /
# codex builds (they all `FROM harnesses/base:dev`).
#
# Pass harness names as arguments to build a subset:
#   bin/build-harnesses-local-arm64.sh                 # all four
#   bin/build-harnesses-local-arm64.sh claude-code     # base + claude-code only
#
# Loading into kind cluster + registry-mirror dance is a separate step — see
# bin/load-harnesses-to-kind.sh (Phase 5).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="linux/arm64"
BUILDX_FLAGS=(--platform "$PLATFORM" --provenance=false --sbom=false --load)

err() { printf "[build] error: %s\n" "$*" >&2; exit 1; }
info() { printf "[build] %s\n" "$*"; }

command -v docker >/dev/null || err "docker not installed"
docker buildx version >/dev/null 2>&1 || err "docker buildx not available (install Docker Desktop or the buildx plugin)"

cd "$REPO_ROOT"

# ---- base (required by all others) ---------------------------------------
build_base() {
  info "building harnesses/base:dev for $PLATFORM"
  docker buildx build "${BUILDX_FLAGS[@]}" \
    -f harnesses/base/Dockerfile -t harnesses/base:dev .
}

build_harness() {
  local name="$1"
  local tag="${name}-sandbox:dev"
  info "building $tag for $PLATFORM"
  docker buildx build "${BUILDX_FLAGS[@]}" \
    -f "harnesses/${name}/Dockerfile" -t "$tag" .
}

ALL_HARNESSES=(claude-code opencode codex)

if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${ALL_HARNESSES[@]}")
fi

# base always first
build_base

for h in "${TARGETS[@]}"; do
  case "$h" in
    base) ;;  # already built
    claude-code|opencode|codex) build_harness "$h" ;;
    *) err "unknown harness: $h (known: ${ALL_HARNESSES[*]})" ;;
  esac
done

info "✓ done"
info "built images:"
printf "%-45s %-15s %s\n" "REPOSITORY:TAG" "CREATED" "SIZE"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}' \
  | grep -E "harnesses/base|claude-code-sandbox|opencode-sandbox|codex-sandbox" || true
