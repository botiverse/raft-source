# Stateful browser scenarios

For tests that change server/account state, import `test` from
`fixtures/scenario`, not directly from Playwright. The `scenario` fixture
provides `seed`, `login`, and a member `peer`; the browser's storage state is
bound to that same owner. Do not load the global owner's login or auth file in
these tests.

Each test invocation, repeat and retry allocates a new owner, peer and server in
the local disposable database. The fixture deletes that server and its two
accounts after dependent browser contexts close, including after assertion
failure. Cleanup errors fail the test. Abruptly killed workers may leave rows
until the standalone test process exits, but later attempts never reuse them.
The lifecycle attachment contains IDs, attempt indices and cleanup status only.

The provisioning router exists only in `startPlaywrightServer.ts`, before the
ordinary application via `createTestApp`'s test-only wrapper. It requires the
random process capability from the local seed file; deletion accepts only IDs
created by its registry. It is not registered by the production application.
Accounts use the same completed legacy onboarding state as the global fixture;
these scenarios are not evidence of signup/onboarding correctness. All tested
DM/menu mutations still go through the real application. Large search history
is seeded through real message/thread services in the harness, rather than
spending the search test's deadline on 128 HTTP sends. It retains search text,
sequence and parent linkage; the browser still exercises real history/context
requests, hydration, search highlighting and pagination constraints. This
recipe is not HTTP message-send coverage.

The removed-DM and lazy-thread-search specs are the first consumers. Other
specs still share the global fixture. Shard jobs have independent databases,
but workers within a shard share a process/database; unique tenants isolate
their domain state, not process crashes, global flags or resource exhaustion.

## Readiness and result assertions

`openSidebarRowMenu` establishes a row and an exact action label. Playwright's
locator click handles scrolling and remounts; the helper does not retry whole
menu openings. Failure records the menu phase and labels. Tests must still
assert the action's actual HTTP result and persisted state.

`expectThreadFocusedWindow` proves the intended focus row is visible before
sampling a partial timeline. A nonempty unrelated window is insufficient.
This extracts the focus-row precondition from PR #7479; it does not claim to
fix every original search timeout. Neither helper raises assertion deadlines.

## Verify a migration

Build the E2E-enabled web bundle, then use the package script with no retries:

```sh
VITE_E2E=true VITE_API_URL=http://127.0.0.1:4174 pnpm --filter @botiverse/raft-web build
pnpm --filter @botiverse/raft-web test:e2e removed-dm-menu-actions search-lazy-hydration --workers=2 --retries=0
```

For an isolated local port pair set `PLAYWRIGHT_WEB_PORT` and
`PLAYWRIGHT_API_PORT` on the test command, and build with `VITE_API_URL` pointing
at that API port. Inspect first-attempt results, not only the final summary.
The scenario contract test checks cross-tenant write denial, distinct owners,
cleanup survival of another tenant, and denial of global-seed deletion.

Judge checks by their protected property; see the
[Test judgment](../../../../docs/development/test-judgment.md).
The menu test clicks the exact actions and verifies their real effects. A
separate full-stack test of the readiness helper's custom rejection is not
required. When diagnosing a helper, a temporary wrong-state/valid-state control
can still distinguish a meaningful failure from a missing page or an
always-failing helper; that experiment need not become a permanent E2E case.
