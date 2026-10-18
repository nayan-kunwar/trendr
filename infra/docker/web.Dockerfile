# infra/docker/web.Dockerfile — Next.js standalone
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
ARG PNPM_VERSION=11.7.0
ENV PNPM_HOME=/pnpm PATH=/pnpm/bin:/pnpm:$PATH
# Husky hooks and corepack download prompts must never run inside an image build.
ENV HUSKY=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Container networks often have broken IPv6/NAT64 routes; resolve registry hosts to IPv4.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Pin the pnpm the repo's packageManager field expects so no build step ever
# resolves "pnpm latest" over the network; then keep the store where the
# builder's buildkit cache mount expects it.
RUN corepack enable && corepack install --global pnpm@${PNPM_VERSION}
ENV npm_config_store_dir=/pnpm/store
WORKDIR /repo

FROM base AS pruner
RUN pnpm add -g turbo@^2
COPY . .
RUN turbo prune @trendr/web --docker

FROM base AS builder
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prefer-offline --network-concurrency 6 --fetch-retries 5
COPY --from=pruner /repo/out/full/ .
# turbo prune omits root config files the packages extend, so copy them explicitly.
COPY --from=pruner /repo/tsconfig.base.json .
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
# NEXT_STANDALONE=true makes next.config.ts emit .next/standalone (spec §17.2).
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=true
RUN pnpm turbo run build --filter=@trendr/web...

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# apps/web/public/.gitkeep must be committed (spec §17.2); Dockerfile COPY takes no trailing comments.
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
