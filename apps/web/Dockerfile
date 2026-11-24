FROM node:24.22.3-bookworm-slim AS build

WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile --filter @messaging/web...

COPY apps/web apps/web
COPY packages/shared-types packages/shared-types
RUN pnpm --filter @messaging/web build

FROM node:24.22.3-bookworm-slim AS runtime

WORKDIR /workspace
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=4300

COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static/ ./apps/web/.next/static/

USER node
EXPOSE 4300
CMD ["node", "apps/web/server.js"]
