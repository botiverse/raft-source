ARG NODE_VERSION=24.15.0
FROM node:${NODE_VERSION}-bookworm-slim AS builder

RUN corepack enable

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches/ patches/

# Copy package manifests
COPY packages/desktop-contract/package.json packages/desktop-contract/
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/

# Install dependencies (skip Electron binary download — not needed for web)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/desktop-contract/ packages/desktop-contract/
COPY packages/sync-core/ packages/sync-core/
COPY packages/shared/ packages/shared/
COPY packages/visual-testing/shared/ packages/visual-testing/shared/
COPY packages/web/ packages/web/

# Build web app — VITE_* values are baked in at build time
ARG VITE_API_URL
ARG VITE_COMMIT_SHA=""
ARG VITE_BUILD_AT=""
ARG VITE_RELEASE_BRANCH=""
ARG VITE_FRONTEND_RELEASE_ID=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_COMMIT_SHA=$VITE_COMMIT_SHA
ENV VITE_BUILD_AT=$VITE_BUILD_AT
ENV VITE_RELEASE_BRANCH=$VITE_RELEASE_BRANCH
ENV VITE_FRONTEND_RELEASE_ID=$VITE_FRONTEND_RELEASE_ID
RUN pnpm --filter @botiverse/raft-web run build

# --- Production stage: nginx ---
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

# Pin nginx to the same content-derived strong ETag contract as Pages.
RUN test -f /usr/share/nginx/html/desktop-manifest.json \
    && manifest_sha="$(sha256sum /usr/share/nginx/html/desktop-manifest.json | cut -d' ' -f1)" \
    && printf 'add_header ETag "\\"sha256-%s\\"" always;\n' "$manifest_sha" \
      > /etc/nginx/desktop-manifest-etag.conf

# Copy nginx config
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
