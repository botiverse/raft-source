# E2E login transport evidence

`packages/web/scripts/runE2eShard.ts` enables this collector for one invocation.
It reuses the existing `playwright-report/` artifact path and the existing
terminal-failure/recovered-flake retention decision. Plain Playwright runs and
application servers do not enable it. No retry, timeout, browser trace policy,
HTTP result, or signal handler is changed.

The API launcher records its process instance, listener and connection events,
and POST `/api/auth/login` arrival/finish/close. The login fixture adds a random
`x-e2e-login-request-id` and records attempt, worker, parallel slot and timestamps.
Only that validated random ID is projected from the request headers. No raw
headers, URLs, credentials, bodies, exception messages or tokens are saved.
Error codes use a fixed allowlist; unavailable codes remain `unknown`.

Read records by runId + instanceId + sequence, and correlate client/server by
requestId (with connectionId local to the server instance). A failed request
without a matching arrival does not prove that the server never received it.
Node's normal exit and uncaught-exception monitor are observed; default signal
termination, SIGKILL, power loss and logger failure can leave no terminal event.
No signal handlers or ordinary error listeners are installed to fill that gap.
The collector is evidence for an investigation, not a cause classifier or fix.

## Bounds and preservation

- One server stream, one global-setup client stream, and 16 parallel client
  slots. A slot is reused only after its previous Playwright worker is stopped.
  Higher parallel indices run normally without collection.
- Each stream has two segments of at most 256 KiB (a record is at most 2 KiB).
  The combined rolling streams are at most 9 MiB. Writes are synchronous and
  best-effort; write errors disable that writer and print one generic warning
  per process. There are no diagnostic timers, retry loops or retained sockets.
- On the first failed login in each client slot, pin the currently available
  two server segments and a small metadata record with the client correlation
  and attempt fields. Later errors do not replace that pin. Snapshots add at
  most 8.5 MiB plus 17 small metadata files. Total is under 18 MiB per shard.
- Snapshots are partial: copying can race with rotation or fail, and server
  terminal events can occur after the snapshot. Inspect the later rolling
  stream too. Missing/incomplete records leave the cause undetermined.
- The runner clears this dedicated directory before the next invocation.
  Existing GitHub uploads retain artifacts for seven days. Clean jobs do not
  upload; terminal failures and recovered test retries do. The existing
  cancellation condition remains unchanged, so cancelled jobs are not promised
  an upload. No separate long-term store is introduced.

## Verification

Run from the repository root with the repository's Node version and installed
frozen dependencies:

```
node --import tsx --test scripts/e2e/transportEvidence.test.ts
node scripts/ci/playwright-artifact-decision.test.mjs
```

The suite uses isolated ephemeral-port HTTP servers, never a shared service.
It exercises normal login, active server close and socket reset, compares
native fatal-error/SIGTERM exits with/without the collector, checks bounded
rotation and pinned evidence, and runs real failing/recovering Playwright
workers through the existing artifact classifier. A final probe launches the
real PGlite API harness and calls the real login fixture to verify both entry
points are wired. It does not run the full browser E2E suite.
