# Daytona sandbox template for LiteLLM dev work — port of e2b/e2b.Dockerfile.
# Same pre-bake (postgres + litellm[proxy] + uv) so the agent's first execute
# isn't a 15-min apt + pip yak shave.
#
# Differences vs the E2B version:
#   - FROM ubuntu:22.04 instead of e2bdev/code-interpreter (no Python preinstalled).
#   - Creates the `user` account explicitly (E2B's base provided it).
#   - No e2b.toml; resources (8 GB memory) are passed at snapshot/sandbox create.
#
# Build (creates a Daytona snapshot named litellm-base):
#   DAYTONA_API_KEY=<key> node daytona/build-snapshot.mjs

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── System packages ────────────────────────────────────────────────────────────
# python3 + pip (E2B base had it; ubuntu doesn't). postgresql: dev db.
# lib*-dev + build-essential: compiled proxy deps (PyNaCl→libsodium,
# psycopg2→libpq, cryptography→libssl/libffi).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl sudo locales \
      python3 python3-pip python3-venv python3-dev \
      postgresql postgresql-client \
      libpq-dev libsodium-dev libssl-dev libffi-dev \
      build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/* \
 && locale-gen en_US.UTF-8

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# ── User account ───────────────────────────────────────────────────────────────
# E2B's base image shipped a `user` account; create the equivalent here so the
# rest of the Dockerfile (and any callers that hardcode `user`) still works.
RUN useradd -m -s /bin/bash user \
 && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# ── CA bundle ──────────────────────────────────────────────────────────────────
# Trust cloud-vault CA so HTTPS_PROXY TLS MITM succeeds in sandboxes.
COPY cloud-vault-ca.crt /etc/cloud-vault-ca.crt
RUN cat /etc/ssl/certs/ca-certificates.crt /etc/cloud-vault-ca.crt \
      > /etc/ssl/certs/combined-ca.crt

ENV SSL_CERT_FILE=/etc/ssl/certs/combined-ca.crt
ENV CURL_CA_BUNDLE=/etc/ssl/certs/combined-ca.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/combined-ca.crt
ENV NODE_EXTRA_CA_CERTS=/etc/cloud-vault-ca.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/combined-ca.crt
ENV PIP_CERT=/etc/ssl/certs/combined-ca.crt
ENV UV_NATIVE_TLS=true

# ── pip config ─────────────────────────────────────────────────────────────────
# System-wide pip.conf: always use pypi.org, always trust it, always use combined cert.
RUN printf '[global]\nindex-url = https://pypi.org/simple\ntrusted-host = pypi.org\ncert = /etc/ssl/certs/combined-ca.crt\n' \
      > /etc/pip.conf \
 && mkdir -p /home/user/.pip \
 && cp /etc/pip.conf /home/user/.pip/pip.conf \
 && chown -R user:user /home/user/.pip

ENV PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_TRUSTED_HOST=pypi.org
ENV UV_DEFAULT_INDEX=https://pypi.org/simple
ENV UV_INDEX_URL=https://pypi.org/simple

# ── uv ────────────────────────────────────────────────────────────────────────
# Install via pip (not the curl/astral install script) so it inherits pip.conf
# and the uv_build wheel resolves without --trusted-host gymnastics.
RUN pip install --no-cache-dir uv

# ── Clone repos ───────────────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/BerriAI/litellm.git /home/user/litellm \
 && git clone --depth 1 https://github.com/BerriAI/litellm-docs.git /home/user/litellm-docs

# ── Pre-install proxy deps ─────────────────────────────────────────────────────
# Done at image-build time so agents never wait for a 200-package install.
# Editable install (-e) means git-pull/branch-switch reflects live without reinstall.
RUN cd /home/user/litellm \
 && pip install --no-cache-dir -e ".[proxy]"

# ── PostgreSQL dev cluster ────────────────────────────────────────────────────
# Cluster owned by `user` (not the postgres system account) so dev-up.sh can
# start/stop it without sudo inside the sandbox.
# unix_socket_directories=/tmp because the default /var/run/postgresql is
# root-owned (and a tmpfs that resets at sandbox runtime).
RUN set -e; \
    PG_VERSION=$(ls /usr/lib/postgresql | sort -V | tail -1); \
    PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"; \
    PG_DATA="/home/user/pgdata"; \
    su -c "${PG_BIN}/initdb -D ${PG_DATA}" user; \
    su -c "echo \"unix_socket_directories = '/tmp'\" >> ${PG_DATA}/postgresql.conf" user; \
    su -c "${PG_BIN}/pg_ctl -D ${PG_DATA} start -w -t 30" user; \
    su -c "psql -h /tmp -d postgres -c \"CREATE USER litellm WITH PASSWORD 'litellm';\"" user; \
    su -c "psql -h /tmp -d postgres -c \"CREATE DATABASE litellm OWNER litellm;\"" user; \
    su -c "${PG_BIN}/pg_ctl -D ${PG_DATA} stop -m fast" user

# ── Dev DB + proxy env (baked in) ──────────────────────────────────────────────
# Daytona's executeCommand runs each command in a fresh shell, so env from
# `source dev-up` never carries across commands. Baking these as image ENV makes
# DATABASE_URL (and the proxy creds) available to EVERY command automatically.
ENV DATABASE_URL=postgresql://litellm:litellm@localhost:5432/litellm
ENV LITELLM_MASTER_KEY=sk-1234
ENV LITELLM_SALT_KEY=sk-litellm-salt-dev-unsafe
ENV STORE_MODEL_IN_DB=True

# ── DB start + dev-up scripts ──────────────────────────────────────────────────
# start-db: starts postgres (run on demand inside the sandbox).
# dev-up:   source it for an interactive shell → starts postgres + exports env.
# Unlike E2B (which had a `start_cmd` in e2b.toml), Daytona doesn't auto-run a
# boot command; the agent is expected to run start-db on its first execute, or
# we wire it into a wrapper at sandbox create time.
COPY start-db.sh /usr/local/bin/start-db
COPY dev-up.sh /usr/local/bin/dev-up
RUN chmod +x /usr/local/bin/start-db /usr/local/bin/dev-up

RUN chown -R user:user /home/user/litellm /home/user/litellm-docs

USER user
WORKDIR /home/user
