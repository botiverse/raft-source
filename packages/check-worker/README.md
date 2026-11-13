# Check Worker

The publish check's Worker for Raft's workspace Artifacts (task #proj-workspace:#130): every
minute it leases pending checks from Raft and, for each, in an invocation of its own and in
parallel (task #proj-workspace:#185), opens that version's content ticket **top-level** in
Cloudflare's headless browser (Browser Rendering, `@cloudflare/puppeteer`), takes a desktop and
a phone screenshot, records what went wrong on the page, and posts it all back. A check should
take about 4–6 s (not yet measured) where the page's Porthole shell says it has settled (Porthole P139) and a warm
browser is free, every content server serving a P139 shell; a page that takes the shell's word away adds at most
1 s, no longer the 10.5 s an older shell took (task #proj-workspace:#232). A Worker of its
own: it shares nothing with Raft but the two routes it calls with its own token, and it has no
public API (one health route, and the route its own checks are dispatched through).

| | staging | production |
| --- | --- | --- |
| Worker | `raft-artifact-check-staging` | `raft-artifact-check` |
| `RAFT_API_ORIGIN` | `https://api-aws-staging.botiverse.dev` | `https://api.raft.build` |

The contract is shared `artifactCheckContract.ts`; the server's side and its rules are
[workspace-artifacts.md, "The check Worker's API"](../../docs/development/workspace-artifacts.md#the-check-workers-api).

## A run

`scheduled` (cron `* * * * *`) runs the dispatcher, `src/runner.ts` `runChecks`. It opens no
browser itself:

1. `POST {RAFT_API_ORIGIN}/internal/artifacts-check/lease` with
   `Authorization: Bearer ${ARTIFACTS_CHECK_WORKER_TOKEN}`. 200: a lease (`src/raftClient.ts`
   checks it: ids, an https `url`, an ISO `lease`; the lease's `viewports`, else the
   contract's), handed at once to an invocation of its own (step 2), and the run asks again
   straight away. 204: nothing yet; the run asks again every `IDLE_POLL_MS` (3 s) while it is
   younger than `RUN_BUDGET_MS` (58 s), so a check pushed at any second of the minute starts
   within `IDLE_POLL_MS` or so (Raft has no way to wake the Worker: it has no host); one pushed
   after the run's last ask (~57 s) waits for the next cron, ~3 s. An idle minute costs 20
   lease calls and no browser.
2. **Each check in its own invocation**: the lease goes to the Worker itself through its loopback,
   `ctx.exports.default` (a service binding to its own default export, which the runtime provides
   from compatibility date 2025-11-17; no binding in `wrangler.jsonc`), as `POST /run` with the
   lease as JSON and the Worker's own token (`src/dispatch.ts`). Not one invocation for all: an
   invocation has room for six simultaneous connections, and each browser session holds one.
   The run doesn't wait for a check before it leases the next, within two bounds:
   - `MAX_IN_FLIGHT` (40) checks in flight a run: the steady-state ceiling Browser Rendering's
     launch rate sets (at most 3 new browsers a second, a check ~13–15 s, so ~40 at once; more in
     flight adds no throughput), far below its 200 concurrent browsers an account (Workers Paid;
     billed on the month's average); at the cap the run asks for no lease (one would sit leased,
     unchecked) until a check ends;
   - `LAUNCH_SPACING_MS` (350 ms) between dispatches, each of which takes a free browser or
     launches one at once (never more than one): Browser Rendering launches at most 3 new
     browsers a second, so the pool grows no faster than that either.

   Raft keeps the servers fair with no per-server cap: its lease takes the server with the fewest
   checks running first, so servers take turns, and it is work-conserving, so one server alone
   may have all of `MAX_IN_FLIGHT` (40), the cap per run
   ([the API](../../docs/development/workspace-artifacts.md#the-check-workers-api)).
   Two runs overlap only in the last checks of the earlier one (a run leases in its first 58 s).
3. The dispatched invocation (`fetch`, `POST /run`, `src/handler.ts`; `runLeasedCheck`): the
   token checked (constant time; else 401), the body checked as a lease (else 400), a **browser
   session for this check alone while it runs** ([warm browsers](#warm-browsers): one another
   check left running, else one launched), and in it a **fresh incognito context**
   (`src/check.ts`, `src/browser.ts`), closed after the check. Then the session is released
   (left running for the next check, or closed) before the result is posted. Its answer to the
   run is `{ outcome }` only (`recorded`, `conflict`, `refused`, `unavailable`, `rejected`,
   `browser_unavailable`, `not_started`, `failed`).
4. The check: the ticket opened once, at the first viewport (desktop 1280×800 @1x), settled,
   shot; then the phone (390×844 @2x, mobile, touch, a mobile user agent) emulated in place and
   shot. Viewport screenshots only (PNG), never the full page, at the viewport's device scale:
   desktop 1280×800, phone 780×1688.
5. `POST …/:checkId/result`, multipart: `report` (JSON) and a `desktop` / `phone` PNG part for a
   load that was `ok`. A 5xx, 429 or network error is tried again (2 s, 5 s) while the lease holds;
   409 (the lease is no longer current) is logged and the run goes on.
6. The run ends once every check it dispatched has answered (the dispatches are its
   subrequests).

What is not posted: a browser that can't be had (a Browser Rendering limit, an outage) or fails
before the ticket is opened, or a dispatch that fails, posts no result. The lease runs out
(2 minutes) and Raft leases the check again, at most five times within its run window, then its
`check_expiry` job fails it (`lease_expired`). A check answering `browser_unavailable` ends the
run's leasing (leasing more would only spend their attempts); so does a 401, on the lease or on a
check's result (see [Token rotation](#token-rotation)). The checks in flight still finish.

## Isolation conditions

**(2) A fresh context per check, no cookies; the ticket URL never logged; no navigation off the
content origin; only the entry page shot.**

- `CheckBrowser` (`src/checkPage.ts`) offers fresh contexts only: there is no way to open a page in
  the session's default context. `src/browser.ts` makes each with `browser.createBrowserContext()`
  (incognito: no cookies, storage or cache of any other context); `src/check.ts` closes it in
  `finally`, whatever happened. Service workers are bypassed, popups closed, dialogs dismissed.
- A browser session may serve many checks, one after another ([warm browsers](#warm-browsers)),
  never two of them sharing a context: a session goes back only once every context its check
  made is closed (one still open, or one whose making failed half-way, closes the session), and
  a check takes one only with no context open in it but the browser's default one, which no check
  uses. So pages of two Artifacts, of one server or of two, never share cookies, storage, cache or
  service workers; what a session keeps across checks is the browser process itself.
- The ticket URL goes to `page.goto` and nowhere else. Log lines (`src/log.ts`) are JSON with a
  fixed set of fields (ids, codes, counts, statuses) and no field for a URL, a message or an error;
  every string field still goes through `forLog`, which removes any URL. Errors become code-shaped
  classes from their kind alone (`errorClassOf`: `timeout`, `net.<code>`, a fixed fallback), never
  from their message, which for a browser names the URL. The report has the ticket taken out
  (`src/redact.ts`): reported addresses are origin and path only (no query or fragment), Porthole's
  sealed files segment is collapsed, and the ticket URL, its value and any `ticket=` value are
  replaced in console messages.
- The lease travels to its check's invocation in the body of the loopback's `POST /run`, and in
  nothing that is logged; the answer is the outcome's code only.
- Nothing escapes a handler (`src/handler.ts`): with Workers Logs on, an uncaught exception or a
  rejected `waitUntil` promise would be recorded with its message, stack and cause, and a
  browser's navigation errors name the URL. The outermost level of `scheduled` and `fetch` (and
  so of every dispatched check) catches everything and logs only the error's class; `goto` is turned into an outcome (`src/open.ts`);
  every puppeteer event callback is made unable to throw (a request whose decision threw is
  aborted); a browser step that loses its time limit has its later rejection caught.
- Every request of the tab is intercepted (`src/navigation.ts`): the first top-level navigation,
  to the ticket URL itself, and its same-origin redirects go; every other top-level navigation is
  aborted and reported as a blocked resource, off the content origin (`off_origin`) or on it
  (`after_entry`: a reload, a script's `location = …`, another page of the set). Subresources and
  subframes go (the content origin's CSP decides those). So only the entry page is ever shot.
- The ticket URL answers the version's page itself, with no hop for the guard to refuse (read in
  the code, 2026-11-04): the content Worker's open route answers Porthole's own ticket address
  in place (`packages/content-worker/src/services/raftContentService.ts` 984-988); Porthole
  0.14.4 serves a served version's entry at the ticket's address with a 200
  (`src/server/server.ts` 1058-1094, 1176-1193; `src/server/files.ts` 198-201, 291-293), and the
  shell moves the address to the sealed one with `history.replaceState`, no request
  (`src/shell/runtime.ts` 51-53). Porthole's one `location.replace` entry page is for url-mode
  apps (`kind: "external"`, `src/server/pages.ts` 58-80, `server.ts` 1579-1611), its
  `location.assign` follows a clicked link only (`runtime.ts` 1363), and the shell strips
  `meta http-equiv="refresh"` (`runtime.ts` 467). The parity script asserts it: one top-level
  request, the ticket's, and the fixture's own marker on the page.

**(3) The shell's top-level mode.** On a tab Porthole's shell finds no host and draws the page
itself. From Porthole P139 on it says so as it starts: it asks no host there, and the document's
root (`<html>`) carries `data-porthole-host="none"` before the page's own scripts run (on the root,
which stays when the page's document replaces the shell's body). The content Worker serves the
shell of the Porthole Raft pins, P139 or later everywhere now (production since v1.21.62, Porthole
0.14.18, on 2026-11-10; staging newer). A shell before P139 said nothing and asked `ui/initialize`
40 times, 250 ms apart, before it gave up, and the check waited that out (10.5 s from the
navigation's start); none is served any more, so that wait is gone (task #proj-workspace:#232). The
shots wait for the document's `load` (within 25 s, else the load is `timeout`), the network to go
idle (500 ms with no request, at most 5 s), then the shell's word (`untilShellSettled`, read every
`shellPollMs`, 250 ms), which a P139 shell has written before `load`, so it is there at the first
read; where it isn't (the page took it off the root, or the read failed), `SHELL_WORD_WAIT_MS`
(1 s: four more reads) from that first read, the most it waits; the network again unless the word
was there at the first read; and 500 ms more.
The phone shot waits 750 ms and the network after its emulation. Each check logs which it was
(`check.settled`: `said`, `said_late` or `unsaid`, with the time from the navigation). The word is
the page's own and decides only when the shots are taken: a page that writes it early is shot
after its `load` and an idle network, as a page that drew by then is; one that removes it waits
`SHELL_WORD_WAIT_MS` and the network once more. The [end-to-end check](#end-to-end-check) compares that render with the framed one.

One ticket opens once, so the page loads once: the phone is emulated on a CDP session of the
check's own (`Emulation.setDeviceMetricsOverride`, touch, the user agent), not with
`page.setViewport`, which reloads the page when the mobile flag changes. A page laid out by CSS
(media queries, its viewport meta) is shot as a phone shows it; one that reads the user agent only
while it loads keeps what it read at desktop width.

Each shot is taken on that same session (`Page.captureScreenshot`: PNG, from the surface, the
viewport only, no clip; `src/cdpPage.ts`). An emulation is its CDP session's: `page.screenshot`,
on puppeteer's own session, took the phone at its CSS size and 1x (390×844; the first staging
run, 2026-11-04). A phone PNG of 780×1688 stays far below the 5 MiB a shot may be.

## Warm browsers

`src/pool.ts` (task #proj-workspace:#232). Launching a browser per check spent a launch (1–3 s, and
one of Browser Rendering's 3 a second; the time is unmeasured) on each. Now a check takes a session another check left
running where one is free, and leaves its own running while checks are coming. The checks'
invocations share no memory, so the pool is Browser Rendering's own list of the account's sessions
(`puppeteer.sessions()`: each with a `connectionId` while a client is connected), and each check
decides alone:

- **Acquire.** The sessions with no connection, started less than `POOL_MAX_AGE_MS` (10 min) ago, in
  a random order (two checks starting together seldom try the same one), at most
  `POOL_CONNECT_TRIES` (3) of them, each connected to (`puppeteer.connect(binding, sessionId)`)
  within `POOL_CONNECT_TIMEOUT_MS` (5 s). One is taken only with no context open but the default:
  none left by a check that died, none of a check that connected a moment before (Browser
  Rendering lets clients share a session; a check that finds another's context disconnects and
  tries the next). None to be had (none free, every try failed, or the list failed): a launch, as
  before, with `keep_alive` `POOL_KEEP_ALIVE_MS` (60 s, the platform's default). A launch that fails
  is `browser_unavailable`, as before. Logged: `browser.acquired` with `reused` or `launched` and the
  time it took; `pool.connect_failed`, `pool.session_busy`, `pool.list_failed`.
- **Release**, once the check is done with the browser and before its result is posted. The
  session is kept (`browser.disconnect()`: left running for its `keep_alive`) only when the check
  ran (its page opened, or its opening failed: the browser answered throughout), no context of the
  check's is left open, the session is younger than `POOL_MAX_AGE_MS`, at least one other session
  is busy (checks are coming: a lone check keeps nothing warm), and fewer than `POOL_IDLE_MAX` (3)
  others wait. Otherwise `browser.close()`, unless another check uses it (below). Logged:
  `browser.released` with `kept`, `closed` or `left`.
- **Bounds.** At most one launch a dispatch, and dispatches `LAUNCH_SPACING_MS` apart, so the pool
  grows within the 3 launches a second. Sessions open at once: the checks in flight (at most
  `MAX_IN_FLIGHT` a run, whatever it is set to) and at most `POOL_IDLE_MAX` waiting, give or take
  the checks releasing in the same moment (each counts the others before it disconnects); a
  session that waits beyond that ends with its `keep_alive`.
- **Billing.** A waiting session bills browser time until a check takes it or its `keep_alive`
  ends: at most `POOL_IDLE_MAX` × 60 s after the last check of a burst (3 browser-minutes, about
  half a cent at $0.09 an hour beyond the included hours), and nothing after a lone check, which
  closes its own. A longer `keep_alive` (Browser Rendering allows up to 20 minutes) would keep
  browsers warm between bursts at that price per minute each, for a launch saved per burst: not
  worth it at today's volume. Concurrent browsers (10 included, then $2 each, on the month's
  average of daily peaks): the pool adds at most `POOL_IDLE_MAX` waiting sessions to a burst's
  checks in flight, and only while the burst lasts and a `keep_alive` after.
- **What a session keeps across checks** is the browser process (its memory, its GPU and font
  caches), never a context: each check's cookies, storage, cache, service workers and pages go
  with its context. A session is recycled after `POOL_MAX_AGE_MS`.
- **Release never closes a session under another check.** Two checks can connect to one free
  session at once (each sees no context open as it connects). So right before a close the
  session's contexts are read again (`Target.getBrowserContexts` on the browser's own target): with
  one open that this check didn't make, or with the read failing, the session is only
  disconnected (`browser.released` `left`: neither kept nor closed; its `keep_alive` ends it after
  the other check), never closed under that check's running page.
- **One pooling environment per Cloudflare account: `CHECK_BROWSER_POOL`** (a var,
  `src/config.ts`): `"on"` pools; `"off"`, absent or anything else launches a session per check
  and closes it after, never listing or connecting to another session. Browser Rendering's
  sessions are one list per account: any Worker of the account with a Browser Rendering binding
  can connect to a running session, and the pool takes any free session with no context open,
  whoever launched it. So use one Cloudflare account per environment, or accept that the
  environments of one account (and any other Browser Rendering Worker in it) share their warm
  browsers. Within one account at most one environment pools: `wrangler.jsonc` sets production
  `"on"`, staging and the top level `"off"`; `scripts/deploy-config.ts` refuses staging `"on"` and
  two environments on, and the deploy reads the deployed value back exactly.
- **What reuse shares:** a browser process is reused across servers' checks (fresh incognito
  context each; no shared cookies/storage/cache/service workers); only a full Chromium renderer
  compromise plus sandbox escape could persist in it and observe later checks within
  `POOL_MAX_AGE_MS`; Porthole's isolation in users' browsers rests on the same site isolation, so
  there are no per-server pools. `POOL_MAX_AGE_MS` stays ≤ 10 minutes (`test/pool.test.ts`
  asserts it).
- **Other settings on the account.** Should another Worker of the account ever use Browser
  Rendering with other settings (a session's `guardrails` are latched for its life and would
  refuse a page's CDN), the pool must tell its own sessions apart first; an account of its own
  makes that moot.

## What the report says

The findings are the agent's page's only. What is Raft's own on the tab is left out (`isRaftOwn`,
`src/report.ts`), so an agent reading the report never tries to fix it:

- console messages and exceptions from the content origin's `/_raft/` paths: Porthole's shell
  answers the ticket at `/_raft/open` and its own script runs there, and it moves the address to
  the version's files (`history.replaceState`) before any of the page's scripts run, so the page's
  own messages carry its files' address. A CSP refusal (`Refused to …`) is kept even from there:
  the shell inserts the page's scripts and elements, so Chromium can name the shell as the source
  of a refusal of the page's own resource;
- Chromium's `Unrecognized Content-Security-Policy directive 'webrtc'` from anywhere on the content
  origin: Raft sends every header policy there (Porthole's), `webrtc` closes WebRTC where an engine
  knows it, and Porthole's runtime guard closes it in Chromium (Porthole ADOPTING.md §8). A page may
  add a policy of its own (`<meta http-equiv="Content-Security-Policy">`); a mistyped directive
  there is left out too: only a warning, and it changes nothing the page does;
- blocked resources whose own address is on the content origin's `/_raft/` paths. A resource the
  page asked for is reported whoever started its request (the shell, inserting the page's
  `<script src>`, often does).

What the page did:

- `load`: `ok`; `timeout`; or `error` with a class: `http_<status>` for an error page (Porthole's
  denial page for a used or expired ticket, a check no longer running), `net.<code>` for a network
  failure, `navigation_failed`, `other`. Only an `ok` load has screenshots.
- `consoleErrors`: console messages of type error and uncaught exceptions (the first ten; each
  message and source cut to 300 characters, control characters as spaces; the source as origin and
  path, for an exception where it was thrown; the line 1-based, and only with a source: an inline
  script, which the shell inserts, counts its lines from its own start, not the file's). Chromium logs a CSP refusal as a
  console error too.
- `blockedResources`: the first twenty distinct addresses that didn't load: refused by the CSP
  (Chromium's CSP issues, read on the CDP session, out of the page's reach), aborted by the
  navigation guard, or failed on the network (`requestfailed`, but `net::ERR_ABORTED`: a request
  the page or a navigation cancelled). HTTP error statuses of subresources are not counted.
- `blank`: no text in the body and a desktop shot of one colour (at least 99% of sampled pixels:
  `src/png.ts` reads Chromium's 8-bit RGB/RGBA PNGs with `DecompressionStream`, only for a page
  with no text). Unknown is never blank.
- `phoneOverflow`: at the mobile viewport, `document.scrollingElement.scrollWidth` wider than
  `innerWidth` by more than a pixel: `{ contentWidth, viewportWidth }`, else null.

A screenshot that isn't a PNG or is over 5 MiB is left out (the contract allows a missing part),
and a report over 64 KiB loses blocked addresses, then console errors, from the end.

## Configuration

`wrangler.jsonc` names both environments; each repeats its bindings (wrangler inherits none). The
top level is no deployment: its `RAFT_API_ORIGIN` is empty, so it leases nothing.

- `BROWSER`: the Browser Rendering binding.
- `RAFT_API_ORIGIN` (var): Raft's API, an https origin.
- `CHECK_BROWSER_POOL` (var): `"on"` or `"off"`, warm browsers ([above](#warm-browsers));
  production `"on"`, staging and the top level `"off"`: at most one pooling environment per
  Cloudflare account.
- `ARTIFACTS_CHECK_WORKER_TOKEN` (secret, never committed): at least 32 random bytes, the
  server's `ARTIFACTS_CHECK_WORKER_TOKEN` (its own: never one of the content Worker's tokens).
  Kept in the deployment's secret store and set on the Worker from there by automation, not by
  hand.
- `compatibility_flags: ["nodejs_compat"]` (`@cloudflare/puppeteer` needs it), Workers Logs on
  (the lines carry ids and codes only), no traces.
- The loopback (`ctx.exports.default`) the run dispatches each check through: the runtime's, from
  the compatibility date (2026-07-24; it is on by default from 2025-11-17), so nothing in
  `wrangler.jsonc` and nothing for the deploy to read back. Only the Worker reaches it: deployed,
  the Worker has no host (`workers_dev: false`, no routes), and `POST /run` takes only the Worker's
  own token, should another Worker of the account ever bind this one.
- The run's bounds are constants in `src/runner.ts` (`MAX_IN_FLIGHT` 40, `LAUNCH_SPACING_MS` 350,
  `RUN_BUDGET_MS`, `IDLE_POLL_MS`), the pool's in `src/pool.ts` (`POOL_KEEP_ALIVE_MS` 60 s,
  `POOL_IDLE_MAX` 3, `POOL_MAX_AGE_MS` 10 min, `POOL_CONNECT_TRIES` 3, `POOL_CONNECT_TIMEOUT_MS`
  5 s) and the settle's in `src/check.ts` (`CHECK_TIMING`), changed by a commit and a deploy, as a
  var would be: the deploy's readback checks the vars exactly.

A setting missing or unusable: the run logs `raft-check.misconfigured` with what is wrong (never a
value) and leases nothing; so does a run with no loopback. `GET /health` answers
`{ ok: true, configured: false }` (the route stays for `wrangler dev`; deployed, the Worker has
no host: `workers_dev: false`); `POST /run` answers 503.

### Token rotation

There is one token, compared by the server against one setting. Rotating it (a new value on the
server and on the Worker) leaves a short window in which the two disagree: every lease and result
call is a 401, a check leased just before the switch can't post its result, its lease runs out,
and checks recorded in that window may expire and fail (`lease_expired`, `expired`). Accepted for
now. Seamless rotation would need the server to accept two tokens at
once (the current and the next, as the content Worker's `RAFT_TOKENS` does), then switch the
Worker, then drop the old one.

## Deploy

`.github/workflows/deploy-check-worker.yml`, off until it is set up: a staging push deploys only
once the repository variable `CHECK_WORKER_AUTO_DEPLOY_ENABLED` is `"true"`, and every run needs
the GitHub Environment `check-worker-<target>` (variable `CLOUDFLARE_ACCOUNT_ID`, secret
`CHECK_WORKER_CLOUDFLARE_API_TOKEN`). Production is a manual dispatch with a `source_sha` that
production's server already serves (the Worker calls its routes), as the content Worker's.

The token and the environments, as the content Worker's:
`CHECK_WORKER_CLOUDFLARE_API_TOKEN` is an account-owned API token with the Editor role on this one
Worker (Cloudflare's "Individual Worker" scope), one per environment, so it can change no other
Worker of the account. Creating a Worker that doesn't exist yet needs Admin on all Workers: a first
deploy uses a short-lived token for that (or the Worker is created in Cloudflare first), revoked
after the run. Each environment deploys only from the `staging` branch; staging needs no reviewer,
production a human one (as the content Worker's).

A run: typecheck and test, `scripts/deploy-config.ts describe` (the environment's name, origin and
cron, after checking the config's shape) and a dry-run build, the Worker's secret name checked,
deploy (a first deploy: `wrangler deploy`; after: `versions upload`, `versions deploy`,
`triggers deploy`, since an uploaded version carries no cron), the version's bindings and secret
name read back (`verify-version`), its cron read back. No HTTP smoke: the Worker has no host
(`workers_dev: false`), as `wrangler triggers deploy` with a workers.dev host reads the account's
subdomain, which a token scoped to this Worker can't; a misconfigured Worker shows in its logs
(`raft-check.misconfigured`) and in the server's checks, which stay unleased.

First deploy, per environment: create the GitHub Environment; set the server's
`ARTIFACTS_CHECK_WORKER_TOKEN` (with a usable one the server records a check for every pushed HTML version; there is no flag); dispatch with
`first_deploy=true`; run sync-worker-secrets for the Worker; dispatch again.

Build locally (bundles, deploys nothing): `pnpm run build`.

## Tests

`pnpm test` (node:test through tsx, no build, no browser): `test/raft-client.test.ts` (the lease
and result calls with fetch mocked: the bearer, 204, 401, 5xx, a bad lease, the form's parts, the
retry within the lease), `test/report.test.ts` (the caps, cutting, the ticket out of the report,
the 64 KiB fit, error classes), `test/navigation.test.ts` (the guard's decisions),
`test/page-checks.test.ts` (blank, overflow, the PNG reader over every row filter),
`test/cdp-page.test.ts` (each viewport emulated and shot with `Page.captureScreenshot` on the one
CDP session, after its emulation; where a `pageerror` was thrown),
`test/uncaught.test.ts` (`goto` throwing with the ticket URL in its message, stack and cause:
the handler resolves, no log line or report has it, nothing is left rejected; a timed-out step
rejecting later; throws at the handlers' outermost level logged as a class only),
`test/check.test.ts` (a check against a fake browser: a context per check, closed after; one
open, at desktop, then the phone in place; the shots once the shell said it settled, with no fixed
wait and no second idle when it said so at once, after polling when it said so late, and after
`SHELL_WORD_WAIT_MS` from the first read (not from the navigation: a slow load adds no fixed
time), never later, when it said nothing, something else, or its read failed or hung;
refused navigations
reported; failed loads without shots; Raft's own left out of the findings: no console errors for
a clean page whose shell logged the `webrtc` warning, the page's own error, exception and
refused resource kept), `test/pool.test.ts` (warm browsers: the candidates, free and young and at most three, shuffled;
when a session is kept, and every reason it is closed; acquire taking a free session, leaving one
with a context open, passing over a connect that fails or hangs, launching when none is free or
the list fails; release keeping or closing, never throwing, and only disconnecting where a
context it didn't make is open now or that can't be read; the pool off: a launch, closed, no
session listed or connected to; `POOL_MAX_AGE_MS` at most 10 minutes; the check's browser counting
its contexts, a half-made one included), `test/runner.test.ts` (the run: idle polling with no dispatch and no
browser, through the handler too; a check leased mid-run; several checks each handed to its own
invocation through the loopback's `POST /run`, each with a browser of its own; all in flight at
once; dispatches `LAUNCH_SPACING_MS` apart; the safety cap, `MAX_IN_FLIGHT` by default, with no
lease asked for at it; the time budget, the run waiting for its checks; 401 and 503 on the lease;
a check's `refused` or `browser_unavailable` ending the leasing, a conflict not; a failed dispatch
logged. One dispatched check: its own browser and context, closed after; released before its
result is posted, healthy, and kept where the pool keeps it; no browser; a browser failing before
the ticket, closed and never kept; 409 and 401 on the result. `POST /run`: only with the Worker's token
and a lease; no loopback, nothing leased. The settings), `test/log-redaction.test.ts` (a whole run
where the page, the browser and Raft all say the ticket URL: no log line has it, or any URL; no
report has the ticket), `test/deploy-config.test.ts` (among it `CHECK_BROWSER_POOL`: on or off,
staging and the top level off, the deployed value read back exactly).

What they don't reach: `src/browser.ts` against a real browser (among it, that Chromium answers the
phone shot at 780×1688 and names the sources `isRaftOwn` reads as described, that Browser
Rendering's `sessions()`, `connect` and `disconnect` behave as `src/pool.ts` reads them, and that a
P139 shell's `data-porthole-host` is read on the tab), and the runtime's loopback
(`ctx.exports.default`: a fake one calls the handler's `fetch` in the tests). Those are the
end-to-end check's.

## End-to-end check

1. **Top-level against framed, locally** (`packages/content-worker`, `pnpm test:check-parity`;
   Chromium through Playwright, the content Worker in Miniflare): a known Artifact (text, a grid,
   an SVG chart, a list drawn 1.5 s late) opened top-level with a check ticket in a fresh context
   and settled as this Worker settles it, against the same version framed by Raft's host page for
   a reader: the same top-left 1280×760 region, at most 0.5% of pixels differing; a negative
   control (another version, framed) must differ by more. It also asserts nothing frames the
   check, the ticket answers 200, and the late content is drawn before the shot.
2. **This Worker on staging**, after its first deploy: on a
   test server, push that same known Artifact; within seconds the check is `done` with
   both screenshots (the version's check row; the push and read output is a later PR). Read the
   desktop shot through core's object file route and compare it with step 1's framed shot by
   eye or with the same canvas comparison; see the phone shot is 780×1688 and a clean page's
   `consoleErrors` is empty (no `webrtc` warning); push a page that navigates away on load and one with a
   blocked CDN script, and see `blockedResources`; search Workers Logs for the ticket (`ticket=`,
   `_raft/open?`): no line. Push five versions within a few seconds: their checks run at once
   (Workers Logs: five `raft-check.check.leased` lines about 350 ms apart, then their
   `check.recorded` lines, each from its own invocation). Push ten more a few seconds apart: the
   later ones' `browser.acquired` is `reused`, a lone check's `browser.released` is `closed`, and
   Browser Rendering's dashboard shows no session open a minute after the last. With a content
   Worker serving a P139 shell, `check.settled` is `said` and the check takes a few seconds; a page
   that removes `data-porthole-host` from its root is `unsaid` 1 s after the first read.

## Launch follow-up

Before the flag is on for more than test servers: a usage metric (checks run, and Browser
Rendering sessions and browser time per day) in Raft's observability, with an alert as the daily
count nears the Browser Rendering cap and the platform's `ARTIFACTS_CHECK_DAILY_TOTAL`. No code
for it here yet.

## Open questions

- Browser Rendering limits and cost: a session per check while it runs (~4–6 s with a P139 shell,
  which every content server serves; ~13–15 s was an older shell's, mostly its 10.5 s wait, now
  gone; unmeasured until the staging run below), at
  most `MAX_IN_FLIGHT` (40) at once a run and at most ~3 launched a second, plus at most
  `POOL_IDLE_MAX` waiting ([warm browsers](#warm-browsers)); Workers Paid allows 200 concurrent
  browsers an account (10 included, then $2 each, on the month's average of daily peaks) and 3 new
  ones a second; with ~13–15 s checks ~40 is the steady-state ceiling the launch rate sets. Two runs
  overlap only in the earlier one's last checks, so up to twice the cap, 80, may be open for a
  moment, well under 200. A 429 at launch is that check's `browser_unavailable`: the run leases no
  more and the lease runs out (2 minutes). The daily caps (`ARTIFACTS_CHECK_DAILY_PER_SERVER`,
  `ARTIFACTS_CHECK_DAILY_TOTAL`) bound the day's sessions, not the Worker. Billing is per
  browser-hour beyond the included 10 a month ($0.09 an hour), idle `keep_alive` time included.
- Warm browsers, to measure on staging: how often `browser.acquired` is `reused`, what a launch
  and a connect take, and whether checks that share a session (one after another) ever differ from
  a fresh browser's (the parity script compares a fresh one). If reuse is rare at today's volume,
  `POOL_IDLE_MAX` can go to 0 (every session closed) with no other change. Two checks at once in
  one session (each its own context, as Browser Rendering's own example runs four) would cut
  concurrent browsers further; left out until a session's CPU under two pages is measured.
- The loopback's limits, as read in Cloudflare's docs, not measured: a request through a service
  binding is an invocation of its own (its own six connections and CPU time), and the run's
  pending dispatches are subrequests of its own, not among the connections the six count. If a
  deployed run were seen to hold at six checks at once, that would be why.
- Cron every minute with idle polling: a check waits up to `IDLE_POLL_MS` (3 s) to be leased,
  at any second of the minute (until 2026-11-11 a run leased for 45 s only, and a check pushed
  after it waited up to 18 s for the next cron). A Queue or a server push would start it at
  once; not needed now.
- Browser Rendering's session `guardrails` (allowed hosts) could add a second wall around the
  navigation guard, latched per session; they would also refuse a page's CDN subresources that
  its CSP allows, so they are left off.
