# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 ships prebuilt binaries; the toolchain is only the fallback
# for a platform without one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN mkdir -p /data && chown node:node /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

ENV NODE_ENV=production \
  PROMPTD_HOME=/data \
  HOST=0.0.0.0 \
  PORT=4321 \
  PROMPTD_SELF_UPDATE=0 \
  PROMPTD_TRUST_PROXY=1

USER node
VOLUME ["/data"]
EXPOSE 4321

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4321/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# No init of its own: compose runs it with `init: true`, and `docker run --init` does the same.
CMD ["node", "dist/entry-hub.js"]
