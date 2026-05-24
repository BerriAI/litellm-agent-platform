# E2B sandbox template for LiteLLM dev work.
# Mirrors the litellm-4gb spec (4 GB RAM / 8 vCPU set at build time) and
# pre-clones the two repos so sandboxes start with them already present
# (no per-session clone). Both repos are public — no token baked in.
FROM e2bdev/code-interpreter:latest

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Trust cloud-vault CA so HTTPS_PROXY TLS MITM succeeds in sandboxes.
# E2B may reset /etc/ssl/certs at container startup, so we create a
# combined bundle and point all tools at it via ENV — those vars survive.
COPY cloud-vault-ca.crt /etc/cloud-vault-ca.crt
RUN cat /etc/ssl/certs/ca-certificates.crt /etc/cloud-vault-ca.crt > /etc/ssl/certs/combined-ca.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/combined-ca.crt
ENV CURL_CA_BUNDLE=/etc/ssl/certs/combined-ca.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/combined-ca.crt
ENV NODE_EXTRA_CA_CERTS=/etc/cloud-vault-ca.crt
# Python / pip / uv / requests
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/combined-ca.crt
ENV PIP_CERT=/etc/ssl/certs/combined-ca.crt
# uv respects REQUESTS_CA_BUNDLE; also enable system certs as fallback
ENV UV_NATIVE_TLS=true

RUN git clone --depth 1 https://github.com/BerriAI/litellm.git /home/user/litellm \
 && git clone --depth 1 https://github.com/BerriAI/litellm-docs.git /home/user/litellm-docs \
 && chown -R user:user /home/user/litellm /home/user/litellm-docs
