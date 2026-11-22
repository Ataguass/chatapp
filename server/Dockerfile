FROM node:22.18.0-bookworm-slim

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

RUN pnpm install --frozen-lockfile

COPY server server
COPY packages/shared-types packages/shared-types

# Prisma generation needs a syntactically valid URL, but it does not connect to it.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm generate \
    && pnpm build

WORKDIR /workspace/server

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4080

EXPOSE 4080

CMD ["pnpm", "start"]
