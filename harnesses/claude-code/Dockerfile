# claude-tty harness
#
# Browser <--ws--> this container <--pty--> claude CLI
#
# Build from repo root (base must be built first):
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev . && \
#   docker buildx build -f harnesses/claude-code/Dockerfile -t claude-code-sandbox:dev .

FROM harnesses/base:dev

# Install claude CLI globally. node-pty's native binding build deps (make, g++)
# and tmux are already provided by harnesses/base.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app
COPY harnesses/claude-code/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/claude-code/server.js ./
COPY harnesses/claude-code/public ./public

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/claude-code/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN mkdir -p /work/repo \
    && chown -R sandbox:sandbox /work /app

ENV PORT=4096
ENV REPO_DIR=/work/repo
ENV POC_CMD=claude
ENV TERM=xterm-256color

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]
