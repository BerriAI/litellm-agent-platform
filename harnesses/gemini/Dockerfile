# gemini TUI harness
#
# Browser <--ws--> this container <--pty--> gemini CLI (Google)
#
# Build from repo root (base must be built first):
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev . && \
#   docker buildx build -f harnesses/gemini/Dockerfile -t gemini-sandbox:dev .

FROM harnesses/base:dev

# Install gemini CLI globally. node-pty's native binding build deps (make, g++)
# and tmux are already provided by harnesses/base.
RUN npm install -g @google/gemini-cli@latest

WORKDIR /app
COPY harnesses/gemini/package.json ./
RUN npm install --no-audit --no-fund

COPY harnesses/gemini/server.js ./

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY harnesses/gemini/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN mkdir -p /work/repo /home/sandbox/.gemini \
    && chown -R sandbox:sandbox /work /app /home/sandbox/.gemini

ENV PORT=4096
ENV REPO_DIR=/work/repo
# `--yolo` bypasses Gemini CLI's interactive approval prompt so tool calls
# execute inside the sandbox without a human in the loop — same posture as
# every other LAP TUI harness. The vault sidecar and sandbox pod are the
# security boundary; the in-CLI approval gate is redundant here.
# server.js splits POC_CMD on whitespace to support argv.
ENV POC_CMD="gemini --yolo"
ENV TERM=xterm-256color
# Disable Gemini CLI's inner Docker/Podman sandbox — pointless inside our
# k8s pod, and it would try to spawn a nested container (which won't have
# Docker available anyway). The platform pod IS the sandbox.
ENV GEMINI_SANDBOX=false

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]
