ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-bookworm-slim AS base

# ECS migration overrides invoke pnpm --filter ... db:migrate:deploy. Keep the
# repository's pinned CLI and its binary warm, without installing dev packages.
ARG RUNTIME_PNPM_VERSION=12.15.0
RUN corepack enable \
  && corepack prepare pnpm@${RUNTIME_PNPM_VERSION} --activate \
  && test "$(pnpm --version)" = "$RUNTIME_PNPM_VERSION"

# Sharp rasterizes download-only SVG attachments through libvips/librsvg.
# The slim Node image contains neither fontconfig nor fonts, so otherwise even
# ordinary Mermaid `font-family="sans-serif"` labels become tofu/blank pixels
# while shapes still render. Keep small Latin and CJK baseline fonts and fail
# the image build if the generic family cannot actually resolve them.
#
# `apt-get upgrade` pulls Debian security fixes that the node base tag has not
# been rebuilt with yet (2026-10-26: perl 5.36.0-7+deb12u3 -> deb12u4, which
# clears all 5 Critical ECR findings on the prod image).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    fonts-wqy-zenhei \
  && fc-match sans-serif | grep -q "DejaVu Sans" \
  && for language in zh-cn ja ko; do \
    fc-match -f '%{family}\n' "sans-serif:lang=${language}" | grep -q "WenQuanYi Zen Hei"; \
  done \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG PNPM_VERSION=12.15.0
# Use SOURCE_DATE_EPOCH for pnpm's generated metadata; do not change the
# repository's development package manager.
ENV COREPACK_ENABLE_PROJECT_SPEC=0 \
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false \
    SOURCE_DATE_EPOCH=0 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/runtime-form/package.json packages/runtime-form/
COPY packages/shared/package.json packages/shared/
COPY packages/trace-client/package.json packages/trace-client/
COPY packages/server/package.json packages/server/
COPY patches/ patches/
# sheetjs is not on npm; its tarball is vendored (vendor/README.md).
COPY vendor/ vendor/
RUN test "$(pnpm --version)" = "$PNPM_VERSION" \
  && pnpm --filter @botiverse/raft-server... install --prod --frozen-lockfile

COPY packages/sync-core/ packages/sync-core/
COPY packages/runtime-form/ packages/runtime-form/
COPY packages/shared/ packages/shared/
COPY packages/trace-client/ packages/trace-client/
COPY packages/server/ packages/server/
COPY manual/ manual/
# Node/Oxc cannot transpile TypeScript beneath node_modules. Keep workspace
# sources at their original paths, separate from the production dependency graph.
RUN mkdir -p /out-app/packages /out-dependencies/packages \
  && mv node_modules /out-dependencies/node_modules \
  && cp package.json pnpm-workspace.yaml pnpm-lock.yaml /out-app/ \
  && for package in sync-core runtime-form shared trace-client server; do \
       mkdir -p "/out-dependencies/packages/$package"; \
       if [ -d "packages/$package/node_modules" ]; then \
         mv "packages/$package/node_modules" "/out-dependencies/packages/$package/node_modules"; \
       fi; \
       cp -a "packages/$package" "/out-app/packages/$package"; \
     done \
  && cp -a manual /out-app/manual \
  && chmod +x /out-app/packages/server/entrypoint.sh \
  && mkdir -p /out-dependencies/node_modules/@oxc-node \
  && ln -s ../../packages/server/node_modules/@oxc-node/core /out-dependencies/node_modules/@oxc-node/core \
  && find /out-app /out-dependencies -exec touch --no-dereference --date=@0 {} +

FROM base AS runtime
# Corepack supplies the migration CLI independently of npm. Remove the unused
# npm/npx distribution (including its bundled undici) from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# This is an immutable production install. pnpm's default pre-script install
# would treat the intentionally omitted dev dependencies as missing.
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
WORKDIR /app
# The root loader alias preserves entrypoint.sh's /app working directory.
# Linked COPY layers stay reusable when base security packages are rebuilt.
COPY --link --from=build /out-dependencies/ /app/
COPY --link --from=build /out-app/ /app/

# Release identity belongs after every filesystem-producing step.
ARG RAFT_RELEASE_SHA=""
ARG RAFT_BUILD_AT=""
ARG RAFT_RELEASE_BRANCH=""
# Repository the image was built from; passed by the build scripts.
ARG RAFT_IMAGE_SOURCE=""
ARG SLOCK_RELEASE_SHA=""
ARG SLOCK_BUILD_AT=""
ARG SLOCK_RELEASE_BRANCH=""
# RAFT_* is the canonical release identity; SLOCK_* remains a compatibility alias.
ENV RAFT_RELEASE_SHA=$RAFT_RELEASE_SHA
ENV RAFT_BUILD_AT=$RAFT_BUILD_AT
ENV RAFT_RELEASE_BRANCH=$RAFT_RELEASE_BRANCH
ENV SLOCK_RELEASE_SHA=$SLOCK_RELEASE_SHA
ENV SLOCK_BUILD_AT=$SLOCK_BUILD_AT
ENV SLOCK_RELEASE_BRANCH=$SLOCK_RELEASE_BRANCH

LABEL org.opencontainers.image.title="slock-server" \
  org.opencontainers.image.source="${RAFT_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${RAFT_RELEASE_SHA}" \
  org.opencontainers.image.created="${RAFT_BUILD_AT}" \
  org.opencontainers.image.version="${RAFT_RELEASE_BRANCH}"

EXPOSE 3001
CMD ["packages/server/entrypoint.sh"]
