FROM node:20-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --omit=optional --no-audit --no-fund && npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 14322
CMD ["node", "dist/server.js"]
