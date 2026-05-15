# syntax=docker/dockerfile:1.7

# ---------- 0. aws-iam-authenticator ----------
# Standalone download + checksum-verify stage so the binary layer is cached
# independent of node_modules. The runner + worker stages both COPY from
# this stage. Sandboxes auth to EKS via an exec-plugin kubeconfig that
# spawns this binary on every request, so it has to be on PATH at runtime.
FROM alpine:3.20 AS aws-iam-authenticator
RUN apk add --no-cache bash curl ca-certificates coreutils
COPY bin/install-aws-iam-authenticator.sh /tmp/install-aws-iam-authenticator.sh
RUN bash /tmp/install-aws-iam-authenticator.sh /usr/local/bin

# ---------- 1. install ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Only copy lockfiles first so `npm ci` is cached unless deps change.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

# ---------- 2. build ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma needs openssl at codegen time on alpine.
RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `COPY . .` overwrites harnesses/_shared/ with the source tree (no dist/).
# node_modules/@lap/harness-shared is a symlink to that directory, so
# TypeScript can't resolve the package exports until we rebuild dist here.
RUN cd harnesses/_shared && npx tsc

# `npm ci` ran in the `deps` stage without prisma/schema.prisma in scope, so
# the Prisma client wasn't generated. Generate it here once the schema is
# present, before `next build` typechecks against `Prisma.*` types.
RUN --mount=type=cache,target=/root/.npm \
    npx prisma generate

# `output: "standalone"` in next.config.ts emits .next/standalone with a
# minimal node_modules — that's what the runtime stage runs.
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/app/.next/cache \
    npm run build

# ---------- 3. prisma migrate (compose init container) ----------
# `docker-compose.yml`'s db-migrate service builds this stage and runs it once
# at startup against the postgres service before web + worker come up.
FROM node:20-alpine AS prisma
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
CMD ["npx", "prisma", "db", "push", "--accept-data-loss", "--skip-generate"]

# ---------- 4. worker (reconciler) ----------
# Reuses `builder` (full node_modules, full source) so `tsx` and the
# generated Prisma client are available at runtime.
FROM node:20-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=aws-iam-authenticator /usr/local/bin/aws-iam-authenticator /usr/local/bin/aws-iam-authenticator
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/server ./src/server
COPY --from=builder /app/src/worker ./src/worker
CMD ["npx", "tsx", "src/worker/index.ts"]

# ---------- 5. run (web — default target) ----------
# Last stage = default `docker build` target = web service.
FROM node:20-alpine AS runner
WORKDIR /app

# Prisma needs openssl at runtime for `prisma db push`.
RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Sandboxes auth to EKS via an exec-plugin kubeconfig — `aws-iam-authenticator
# token` is invoked on every k8s API call. Installed into /usr/local/bin so
# it's on PATH for the non-root nextjs user. World-readable + executable
# (chmod 0755 by the install script).
COPY --from=aws-iam-authenticator /usr/local/bin/aws-iam-authenticator /usr/local/bin/aws-iam-authenticator

# Run as non-root.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The Next.js standalone bundle ships only the runtime node_modules its
# tracer found — that misses the prisma CLI and its transitive deps (e.g.
# `effect`), so `prisma db push` at startup would crash with MODULE_NOT_FOUND.
# Overlay the full builder node_modules so the migration CLI works.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/package-lock.json /app/tsconfig.json ./

# Worker source — needed when this image runs as the reconciler worker
# (k8s/worker.yaml runs `npm run worker` = tsx src/worker/index.ts)
COPY --from=builder --chown=nextjs:nodejs /app/src/server ./src/server
COPY --from=builder --chown=nextjs:nodejs /app/src/worker ./src/worker

# Agent templates — loaded at runtime by src/server/templates.ts via
# readFileSync(process.cwd() + "/agent-templates"). Not picked up by
# Next.js file tracing (dynamic path), so must be copied explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/agent_templates.json ./agent_templates.json
COPY --from=builder --chown=nextjs:nodejs /app/agent-templates ./agent-templates

# TCP proxy that fronts the Next.js standalone server and pipes /tty WS
# upgrades directly to cluster-internal sandbox pods (IN_CLUSTER mode).
COPY --chown=nextjs:nodejs server-proxy.mjs ./server-proxy.mjs

USER nextjs
EXPOSE 3000

# Push schema, then start the server.
# IN_CLUSTER=true: server-proxy.mjs listens on PORT (3000) and spawns
#   Next.js on NEXT_PORT (3001 by default). The proxy intercepts WebSocket
#   upgrades for /api/v1/managed_agents/sessions/*/tty and pipes them to
#   the sandbox pod; all other traffic is forwarded to Next.js.
# Not IN_CLUSTER: run Next.js standalone directly (local dev / no proxy needed).
CMD ["sh", "-c", "DATABASE_URL=\"${DATABASE_URL}&connection_limit=1&connect_timeout=30\" node node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate && if [ \"${IN_CLUSTER}\" = \"true\" ]; then node server-proxy.mjs; else node server.js; fi"]
