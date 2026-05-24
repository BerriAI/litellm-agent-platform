# E2B sandbox template for LiteLLM dev work.
# Mirrors the litellm-4gb spec (4 GB RAM / 8 vCPU set at build time) and
# pre-clones the two repos so sandboxes start with them already present
# (no per-session clone). Both repos are public — no token baked in.
FROM e2bdev/code-interpreter:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/BerriAI/litellm.git /home/user/litellm \
 && git clone --depth 1 https://github.com/BerriAI/litellm-docs.git /home/user/litellm-docs \
 && chown -R user:user /home/user/litellm /home/user/litellm-docs
