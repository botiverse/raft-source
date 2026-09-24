# Slock UI Inventory

Standalone visual inventory for reusable Slock web UI components and product surfaces.

This package intentionally lives beside `packages/web` so it can be deployed as a separate internal UI reference site, for example:

```text
slock-internal-ui.botiverse.pages.dev
```

It still imports real components and design tokens from `@botiverse/raft-web/src/...`, so the examples stay close to the production app while the inventory has its own build and deploy lifecycle.

## Commands

```bash
pnpm --filter @botiverse/raft-ui-inventory dev
pnpm --filter @botiverse/raft-ui-inventory build
pnpm --filter @botiverse/raft-ui-inventory typecheck
```

## Cloudflare Pages

Suggested setup:

- Root directory: `/` (repo root, so pnpm workspace dependencies resolve)
- Build command: `pnpm install --frozen-lockfile && pnpm --filter @botiverse/raft-ui-inventory build`
- Build output directory: `packages/ui-inventory/dist`
