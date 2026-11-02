# infra/docker/node.Dockerfile — builds api | worker | mcp
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=11.7.0
ENV PNPM_HOME=/pnpm PATH=/pnpm/bin:/pnpm:$PATH
# Husky hooks and corepack download prompts must never run inside an image build.
ENV HUSKY=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Container networks often have broken IPv6/NAT64 routes; force IPv4 and skip
# Node's Happy Eyeballs, which otherwise waits on a blackholed AAAA address.
ENV NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"
# Pin the pnpm the repo's packageManager field expects so no build step ever
# resolves "pnpm latest" over the network; then keep the store where the
# builder's buildkit cache mount expects it.
RUN corepack enable \
    && for attempt in 1 2 3; do \
         corepack install --global pnpm@${PNPM_VERSION} && exit 0; \
         echo "corepack install failed (attempt ${attempt}/3); retrying in $((attempt * 5))s" >&2; \
         sleep $((attempt * 5)); \
       done; \
       exit 1
ENV npm_config_store_dir=/pnpm/store
WORKDIR /repo

FROM base AS pruner
ARG APP
RUN pnpm add -g turbo@^2
COPY . .
RUN turbo prune @trendr/${APP} --docker

FROM base AS builder
ARG APP
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prefer-offline --network-concurrency 6 --fetch-retries 5
COPY --from=pruner /repo/out/full/ .
# turbo prune omits root config files the packages extend, so copy them explicitly.
COPY --from=pruner /repo/tsconfig.base.json .
RUN pnpm turbo run build --filter=@trendr/${APP}...
RUN pnpm --filter=@trendr/${APP} deploy --prod --legacy /out   # pnpm deploy: self-contained node_modules
# The compose 'migrate' service runs `node packages/db/dist/migrate.js` (spec §17.1).
# Point that path at the deployed @trendr/db package: its realpath under .pnpm/
# carries the package's own node_modules (pg, drizzle-orm, ...), which loose
# copies of dist/ + migrations/ could not resolve.
RUN mkdir -p /out/packages && ln -sfn ../node_modules/@trendr/db /out/packages/db

FROM ${NODE_IMAGE} AS runner
ARG APP
# ENV from `base` does not carry across `FROM`; repeat the IPv4-first resolver
# here so the runtime (not just the builder) avoids blackholed IPv6 egress.
ENV NODE_ENV=production APP=${APP} NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=builder --chown=node:node /out/ ./
USER node
EXPOSE 4000 4100 9464
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
