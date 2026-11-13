# @botiverse/raft-web

React SPA frontend for Slock.

## Development

```bash
pnpm --filter @botiverse/raft-web dev        # Vite dev server on :5173 (proxies /api to :3001)
pnpm --filter @botiverse/raft-web build      # tsrs --noEmit && vite build → dist/
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

## Module shape

One component per file, named exports, and no file over 800 lines. Hooks,
helpers and constants live in their own modules, so React Fast Refresh can
update a component in place. `scripts/check-module-shape.ts` (part of `lint`)
holds today's exceptions in `scripts/module-shape-baseline/`, one small JSON
file per module (`src/x/Y.tsx` → `src/x/Y.tsx.json`), and only lets them
shrink: when you split a file, lower or remove its entry in the same PR.
`node --import @oxc-node/core/register scripts/check-module-shape.ts --write`
does that for you and follows files you moved (same file name, old path gone);
it refuses to write if anything grew. A large component moved into a file with
a new name (ThreadPanel.tsx → AuthenticatedThreadPanel.tsx) isn't recognised:
`git mv` its baseline file to the new path, with numbers no higher than
before, and say so in the PR. One file per module keeps parallel PRs from
conflicting in the baseline.

## Tests

`pnpm --filter @botiverse/raft-web test` runs the Node tests;
`pnpm --filter @botiverse/raft-web test:dom` runs isolated DOM workers.
DOM console output goes directly to worker stdout/stderr to avoid Vitest's
pending-console-RPC teardown race ([upstream #11153](https://github.com/vitest-dev/vitest/issues/11153)).
Logs remain visible but lose Vitest's per-test console labels. Assertions and
unhandled errors still fail the run; this does not excuse leaked async work.
`tests/webConsoleTransport.test.ts` exercises the shipped configuration with a
slow reporter and a late log, and separately proves a real unhandled rejection
still exits nonzero. Revisit this workaround when the upstream race is fixed.

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

## Mobile website association (Cloudflare Pages)

`public/_worker.js` serves Apple and Android association JSON directly under
`/.well-known/`; `_routes.json` sends these requests to the Worker rather than
SPA assets. The iOS association keeps app ID `XDAPXFY8FZ.build.raft.app` and
`/download`, and includes `/s/*/channel/*` and `/s/*/dm/*` for conversation and
message links. Query anchors (`thread=channelId:parentMessageId`, `msg=messageId`)
are delivered without imposing query requirements in AASA. `/join`, server
landing pages, settings and other unrelated routes are not added.

`*` also matches slashes or empty text, and Apple stops at the first matching
component, so `exclude` components listed first keep the two families to exactly
`/s/<slug>/(channel|dm)/<id>` (no empty id, no extra segment). This is still not
an identity validator: the mobile parser must reject malformed anchors and
enforce authentication and server access. Native entitlement scope
is coordinated separately; the current iOS proposal names only `app.raft.build`.

Run `pnpm --filter @botiverse/raft-web test tests/wellKnownAssociation.test.ts`
for exact response/App ID/path coverage, JSON-without-redirect routing, Android
certificate preservation and representative URL matching. The local matcher
models only the path patterns used here; it does not prove Apple CDN uptake,
signing entitlement validity or actual system delivery. After normal website
release, the mobile owners must verify the live/CDN AASA with the signed app,
including `/download` regression and cold/warm conversation entry. See
[Apple's component matching reference](https://developer.apple.com/documentation/bundleresources/applinks/details-swift.dictionary/components-swift.dictionary).
