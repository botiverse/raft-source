ARG NODE_VERSION=24.15.0
FROM node:${NODE_VERSION}-bookworm-slim

RUN corepack enable

ARG SLOCK_RELEASE_SHA=""
ENV SLOCK_RELEASE_SHA=$SLOCK_RELEASE_SHA

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY patches/ patches/
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/shared/package.json packages/shared/
COPY packages/trace-upload-worker/package.json packages/trace-upload-worker/

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

COPY packages/sync-core/ packages/sync-core/
COPY packages/shared/ packages/shared/
COPY packages/trace-upload-worker/ packages/trace-upload-worker/

EXPOSE 3000

CMD ["pnpm", "--filter", "@botiverse/raft-trace-upload-worker", "start"]
