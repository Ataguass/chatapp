FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN npm install --global pnpm@10.32.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared-types packages/shared-types
COPY server/package.json server/package.json
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=true pnpm install --frozen-lockfile
COPY server server
RUN DATABASE_URL=postgresql://build@localhost/build pnpm generate && pnpm build

FROM base
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared-types /app/packages/shared-types
COPY --from=build /app/server /app/server
WORKDIR /app/server
RUN mkdir -p /var/lib/messaging/media && chown node:node /var/lib/messaging/media
USER node
CMD ["node", "dist/index.js"]
