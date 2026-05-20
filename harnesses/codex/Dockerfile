# codex TUI harness
#
# Browser <--ws--> this container <--pty--> codex CLI (OpenAI)
#
# Build from repo root (base must be built first):
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev . && \
#   docker buildx build -f harnesses/codex/Dockerfile -t codex-sandbox:dev .

FROM harnesses/base:dev

# Install codex CLI globally. node-pty's native binding build deps (make, g++)
# and tmux are already provided by harnesses/base.
RUN npm install -g @openai/codex@latest

WORKDIR /app
COPY harnesses/codex/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/codex/server.js ./

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/codex/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN mkdir -p /work/repo \
    && chown -R sandbox:sandbox /work /app

ENV PORT=4096
ENV REPO_DIR=/work/repo
ENV POC_CMD=codex
ENV TERM=xterm-256color

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]
