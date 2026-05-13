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

# Build the workspace `@lap/harness-shared` package first — the platform
# package.json has a `file:./harnesses/_shared` dep on it, so npm ci needs
# the compiled output to exist before resolving deps.
COPY harnesses/_shared ./harnesses/_shared
RUN cd harnesses/_shared \
    && npm install --no-audit --no-fund --legacy-peer-deps \
    && npx tsc

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

# `COPY . .` overwrites harnesses/_shared/ from the host, which has no dist/.
# The `file:` dep symlink at node_modules/@lap/harness-shared then points at
# a directory with no compiled output, so typecheck fails on imports like
# `@lap/harness-shared/session-event`. Rebuild dist/ here before next build.
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
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

USER nextjs
EXPOSE 3000

# Push schema, then start the standalone Next.js server (server.js is what
# `output: "standalone"` writes — equivalent to `next start` without the
# dev/test toolchain).
CMD ["sh", "-c", "node node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate && node server.js"]
