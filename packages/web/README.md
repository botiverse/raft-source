# @botiverse/raft-web

React SPA frontend for Slock.

## Development

```bash
pnpm --filter @botiverse/raft-web dev        # Vite dev server on :5173 (proxies /api to :3001)
pnpm --filter @botiverse/raft-web build      # tsc --noEmit && vite build → dist/
pnpm --filter @botiverse/raft-web typecheck
```

To run a branch Web against a deployed server without browser CORS, keep
`VITE_API_URL` unset and select the same-origin Vite proxy target:

```bash
SLOCK_WEB_PROXY_TARGET=staging pnpm --filter @botiverse/raft-web dev
SLOCK_WEB_PROXY_TARGET=prod pnpm --filter @botiverse/raft-web dev
```

Only the closed `staging | prod` target set is accepted. Operators may update
the corresponding canonical origin without admitting arbitrary proxy targets
by setting `SLOCK_WEB_PROXY_STAGING_ORIGIN` or
`SLOCK_WEB_PROXY_PROD_ORIGIN` to a pathless HTTPS origin.
Remote proxy mode automatically marks the UI as a Web Preview and shows the
selected data target.

## Deploy (Vercel)

1. Import the repo on Vercel
2. Settings:
   - **Framework Preset:** Vite
   - **Root Directory:** `packages/web`
   - **Build Command:** `cd ../.. && pnpm install && pnpm --filter @botiverse/raft-web build`
   - **Output Directory:** `dist`
3. Environment variables:
   - `VITE_API_URL` — Backend server URL (e.g. `https://api.slock.ai`)

API calls and Socket.io both connect directly to `VITE_API_URL` (set at build time). SPA fallback is handled by the existing `vercel.json`.
The user-facing app domain is the deployed web host plus server-side `APP_URL`; changing it does not require changing `VITE_API_URL`, CDN, or share artifact hosts.
