ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-bookworm-slim AS base

# Retain the Debian security fixes that are newer than the node base tag.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG PNPM_VERSION=12.15.0
# 12.15 adds SOURCE_DATE_EPOCH support for generated pnpm install metadata.
# This pin is local to this image builder; the workspace package manager stays put.
ENV COREPACK_ENABLE_PROJECT_SPEC=0 \
    npm_config_manage_package_manager_versions=false \
    SOURCE_DATE_EPOCH=0 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/shared/package.json packages/shared/
COPY packages/trace-upload-worker/package.json packages/trace-upload-worker/
COPY patches/ patches/
RUN test "$(pnpm --version)" = "$PNPM_VERSION" \
  && pnpm --filter @botiverse/raft-trace-upload-worker... install --prod --frozen-lockfile

COPY packages/sync-core/ packages/sync-core/
COPY packages/shared/ packages/shared/
COPY packages/trace-upload-worker/ packages/trace-upload-worker/
# Keep workspace TypeScript outside node_modules: Node/Oxc deliberately does not
# transpile packages there. Preserve the normal workspace symlinks while copying
# only the three filtered projects and their production dependency graph.
RUN mkdir -p /out-app/packages /out-dependencies/packages \
  && mv node_modules /out-dependencies/node_modules \
  && cp package.json tsconfig.json /out-app/ \
  && for package in sync-core shared trace-upload-worker; do \
       mkdir -p "/out-dependencies/packages/$package"; \
       if [ -d "packages/$package/node_modules" ]; then \
         mv "packages/$package/node_modules" "/out-dependencies/packages/$package/node_modules"; \
       fi; \
       cp -a "packages/$package" "/out-app/packages/$package"; \
     done \
  && find /out-app /out-dependencies -exec touch --no-dereference --date=@0 {} +

FROM base AS runtime
# The worker starts with Node and does not need npm or its bundled libraries.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
WORKDIR /app/packages/trace-upload-worker
# A separate linked COPY keeps these bytes independent of base-layer rebuilds.
COPY --link --from=build /out-dependencies/ /app/
COPY --link --from=build /out-app/ /app/

# Release identity belongs after dependency installation and copying.
ARG SLOCK_RELEASE_SHA=""
ARG SLOCK_BUILD_AT=""
ARG SLOCK_RELEASE_BRANCH=""
ARG RAFT_IMAGE_SOURCE=""
ENV SLOCK_RELEASE_SHA=$SLOCK_RELEASE_SHA
LABEL org.opencontainers.image.title="raft-trace-upload" \
  org.opencontainers.image.source="${RAFT_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${SLOCK_RELEASE_SHA}" \
  org.opencontainers.image.created="${SLOCK_BUILD_AT}" \
  org.opencontainers.image.version="${SLOCK_RELEASE_BRANCH}"
EXPOSE 3000
CMD ["node", "--import", "@oxc-node/core/register", "src/node.ts"]
