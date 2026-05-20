# opencode harness
#
# Build from repo root (base must be built first):
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev . && \
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
# Note: the prior standalone opencode Dockerfile created `sandbox` at UID 1000;
# all other harnesses already used UID 1001 and `harnesses/base` consolidates
# on 1001. Sandbox volumes are ephemeral (fresh per session via
# data-plane/agent-sandbox), so no host-side data on disk carries the old UID.
FROM harnesses/base:dev

COPY --from=installer --chown=sandbox:sandbox /root/.opencode /home/sandbox/.opencode
ENV PATH="/home/sandbox/.opencode/bin:${PATH}"

WORKDIR /work

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY --chown=sandbox:sandbox harnesses/opencode/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER sandbox

EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
