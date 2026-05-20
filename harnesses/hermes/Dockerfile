# hermes TUI harness
#
# Browser <--ws--> this container <--pty--> hermes CLI (Nous Research)
#
# Hermes is a Python project; we install it from a pinned release tag using
# uv. The Node WS bridge is the same pattern as the claude-code and codex
# harnesses — it just spawns the configured POC_CMD (default `hermes --tui`)
# inside a PTY.
#
# Build from repo root (base must be built first):
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev . && \
#   docker buildx build -f harnesses/hermes/Dockerfile -t hermes-sandbox:dev .

FROM harnesses/base:dev

# Clone hermes-agent at a pinned release tag and install into a venv at
# /opt/hermes. Skip the `[all]` extra (it pulls Playwright/Chromium + voice
# deps we don't need for a coding TUI). uv is already provided by harnesses/base.
ARG HERMES_VERSION=v2026.5.16
RUN git clone --depth 1 --branch ${HERMES_VERSION} \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes \
    && cd /opt/hermes \
    && uv venv /opt/hermes/.venv --python 3.11 \
    && . /opt/hermes/.venv/bin/activate \
    && uv pip install -e . \
    && ln -sf /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes

WORKDIR /app
COPY harnesses/hermes/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/hermes/server.js ./

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/hermes/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN mkdir -p /work/repo /home/sandbox/.hermes \
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
