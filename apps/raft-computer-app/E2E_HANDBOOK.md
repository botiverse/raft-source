# Raft Computer Menu-Bar — E2E Handbook

A corner-case checklist for the menu-bar app. Every entry has:

- **Auto** — `y` if a unit/integration test pins this path; `n` if visual or interactive paths require human eyes.
- **Owner** — `harness` (Yingjun's automated e2e harness, in flight) or `agent` (any agent on rotation, eyeballs the dialog/tray/menu in a real macOS session).
- **Repro** — exact steps, designed to use an isolated `SLOCK_HOME` so the agent never breaks its own live session ([[feedback_e2e_isolate_slock_home]]).
- **Expected** — what should happen, in observable terms.

Run an isolated session with:

```bash
TEST_HOME=$(mktemp -d -t menubar-test-XXXX)
SLOCK_HOME="$TEST_HOME" pnpm --filter @botiverse/raft-computer-app start
# clean up:
rm -rf "$TEST_HOME"
```

Where the menu-bar talks to a real raftdev (login flows, etc.):

```bash
./raftdev start handbook
SLOCK_HOME="$TEST_HOME" \
  SLOCK_SERVER_URL="$(jq -r .serverUrl < .dev-env-handbook.json)" \
  pnpm --filter @botiverse/raft-computer-app start
```

The intermediate DSL (`menuModel.ts` + `actionRunner.ts`) backs every "Auto: y" entry: pure-result tests in `src/menuModel.test.ts` and stub-API tests in `src/actionRunner.test.ts`. Adding a new corner case = either extend the unit tests (the DSL covers it) or add an entry here marked "Auto: n" with explicit observation steps.

---

## 1. Cold start (no service, no login)

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `menuModel.test.ts` "empty state → version row + checking… status…" |
| Owner | harness (electron-launch smoke) |
| Repro | `SLOCK_HOME=$(mktemp -d) pnpm --filter @botiverse/raft-computer-app start` |
| Expected | Tray icon resolves to `iconTemplate.png` (template, OS-tinted), menu shows: version row, `Service: Stopped`, `No servers attached`, `Sign in…`, `Start Service`, `Run Doctor`, `Quit`. No errors logged. |
| Visual eye-check | Tray icon present in menubar (not missing/red/broken). |

## 2. Login (device-code happy path)

| Field | Value |
| --- | --- |
| Auto | partial — actionRunner test pins event handling against a stub api |
| Auto pin | `actionRunner.test.ts` "login: drives api.login + opens device-code URL + …" |
| Owner | agent (real login round-trip with raftdev) |
| Repro | Cold start → click `Sign in…` |
| Expected | (a) Default browser opens to `<verifyUrl>?user_code=<code>`. (b) macOS dialog shows "Approve in your browser" with the user code. (c) After approval in browser, dialog closes, "Signed in" toast appears, menu shows `Signed in as <id>…` row and `Sign out` replaces `Sign in`. |
| Visual eye-check | Browser tab actually opens; user code in dialog matches the URL fragment. |
| Failure shape | Cancel in browser → poll times out, error notify "Action failed" with `LOGIN_*` code. |

## 3. Start Service

| Field | Value |
| --- | --- |
| Auto | y (unit, stub api) |
| Auto pin | `actionRunner.test.ts` "startService: drives api.start…" |
| Owner | harness |
| Repro | After login, click `Start Service` |
| Expected | inFlight banner "Starting service…" appears in service status row; on success, `Service: Running` + "Service started" toast with "Managing N of M attached server(s)" detail; tray icon may flip to ok template if there are no degraded runners. |
| Visual eye-check | Tray icon goes from dimmed-template to standard-template within ~5s of completion (next status poll). |

## 4. Restart Service (service running)

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "restartService: calls api.resetService…" |
| Owner | harness |
| Repro | While `Service: Running`, click `Restart Service` |
| Expected | inFlight "Restarting service…", on success `Service restarted` info toast with `Was <state>. Cleared N crash entries.` detail. |

## 5. Restart Runner (per-server)

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "restartRunner: calls api.resetRunner…" + "not-found result surfaces as ERROR notify…" |
| Owner | harness |
| Repro | Open per-server submenu → `Restart runner` |
| Expected | inFlight "Restarting runner…", success → `Runner restarted` toast. If the lib returns `not-found` (server detached underneath), error notify "Restart runner failed" with the truncated server id. |

## 6. View Logs

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "viewLog: forwards path as file:// URL; no in-flight banner" |
| Owner | agent (default-app association is per-machine) |
| Repro | (a) Top-level `View service log`. (b) Per-server submenu → `View runner log`. |
| Expected | Default text editor for `.log` files opens with the path's contents. The path itself comes from `status.service.logPath` / `server.serverRunnerLogPath` — no embedded log viewer. |
| Visual eye-check | The editor that opens is the agent's actual editor of choice (not a fallback browser preview). |

## 7. Run Doctor

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "runDoctor: success → 'all checks passed' info toast" + "failing check → error toast with check summary" |
| Owner | harness (allOk path) + agent (degraded triage rendering) |
| Repro | Click `Run Doctor` |
| Expected | inFlight "Running doctor…", success → info toast `Doctor: all checks passed` with ✓ list. Any failing check → error toast `Doctor: issues found` with `✗ <name>` lines plus details. |
| Visual eye-check | Long detail strings wrap reasonably in the dialog (no truncation). |

## 8. Detach (success)

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "detach: prompts confirm; on OK calls api.detach + reports success" + "confirm cancel → no api call" |
| Owner | harness + agent (verify the dashboard shows the computer revoked) |
| Repro | Per-server submenu → `Detach from this server…` |
| Expected | Confirm dialog "Detach `<slug>`?" with Cancel (default) + OK. Cancel → no-op. OK → inFlight "Detaching `<slug>`…", success → "Detached" toast, server vanishes from per-server list, menu rebuilds. |
| Visual eye-check | The destructive-warning dialog uses `type:"warning"` icon (yellow/orange triangle). |

## 9. Detach (server-side revoke fails)

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "detach: server-side revoke failure surfaces a non-fatal warning" |
| Owner | harness (mock the revoke to return 5xx) |
| Repro | Detach when the server is unreachable / returns 5xx on the revoke endpoint. |
| Expected | Local detach still succeeds. Toast: `Detached locally` with detail "server-side revoke failed (`<network_error|http_error>`). You may want to revoke this Computer from the server's dashboard." |

## 10. Upgrade (service running, routed via IPC)

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "upgrade: routes through service when running, surfaces log.line as toast" |
| Owner | agent (full self-swap requires a real CDN / different version) |
| Repro | When CDN reports a newer `latestVersion`, click `Update available · v<x>` |
| Expected | inFlight "Upgrading to v<x>…", `log.line` from the supervisor surfaces as info toast "Upgrade started; the supervisor will swap and restart shortly." Service self-restarts asynchronously; the menu picks up the new version on the next status poll. |
| Visual eye-check | After ~30 seconds, the version row updates to `Raft Computer v<new>`. |

## 11. Upgrade (service not running)

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "upgrade: when no service running (routed:false), surfaces 'Service not running' message — no api.upgrade fall-through from menu" |
| Owner | harness |
| Repro | Stop service → click `Update available · v<x>` |
| Expected | Info toast "Service not running" with "Start the service first; the upgrade runs through the supervisor." **No** standalone swap from the GUI process (would tear the user's session out from under them). |

## 12. Per-server crash reason (degraded server)

| Field | Value |
| --- | --- |
| Auto | y (structure) — formatter and rendering branches both pinned in unit tests; harness still owns "doctor poll actually populates serverCrashReasons within one tick" |
| Auto pin | `menuModel.test.ts` describe `"crashSummary (per-server 'Crash:' row formatter)"` (signal-priority / `exit <code>` / `exit ?` / "no recorded crash") + `"buildMenuModel"` "degraded server with a crash reason → submenu shows the 'Crash: …' info row" + "healthy server → NO crash row even if a stale crash reason lingers in state" + "degraded server but no crash reason yet (doctor poll not landed) → no Crash row". `formatTime` is injected so the test pins structure, not the time string (logRotation TZ lesson). |
| Owner | harness + agent |
| Repro | (1) Start service + attach a server. (2) Kill the runner pid (`kill <runner.pid>`) so it crashes. (3) Wait one 5s status poll → server flips to ◐ degraded. (4) Open per-server submenu. |
| Expected | Submenu shows `Status: Degraded`, **plus** a non-clickable `Crash: SIGTERM (timestamp)` or `Crash: exit 1 (timestamp)` row populated by `api.doctor({serverId}).crashes`. After `Restart runner` succeeds, the crash row disappears on the next poll. |
| Visual eye-check | Tray icon flipped to orange `iconAttention.png` while degraded. |

## 13. Tray-icon visual states

| Field | Value |
| --- | --- |
| Auto | y (structure) + n (real macOS render) — basename mapping pinned in unit tests; pixel-level asset semantics pinned by PR #3229; real-tray dark/light render still human-eye |
| Auto pin (code) | `menuModel.test.ts` describe `"trayIconBasename (keystone: RolledUpHealth → tray icon)"` (each health → distinct basename, exactly one non-template variant, no two states share an icon) + `"trayIconBasename ∘ aggregateHealth (end-to-end: status → icon)"` (null/checking → dimmed; healthy runners → template; degraded runner → orange non-template; stopped service → dimmed). |
| Auto pin (asset) | `apps/raft-computer-app/assets/iconAttention@2x.png` avg RGB=(249,115,22), `iconDimmedTemplate@2x.png` alpha=74 (≈ 185 × 0.4) — see PR #3229 description. |
| Owner | agent (rotation: each agent looks once on a real macOS session) |
| Repro | (a) Cold start → `iconDimmedTemplate.png` (stopped). (b) Sign in + Start Service + attach a healthy server → `iconTemplate.png` (ok, OS-tinted). (c) Kill a runner pid → `iconAttention.png` (degraded, orange). |
| Expected | (a) Glyph fades into the menubar (≈40% alpha). (b) Glyph adopts the system menubar color (black on light mode, white on dark mode). (c) Glyph is brutal-orange `#f97316`, **not** template-tinted (i.e. orange is preserved across dark/light menubar themes). |
| Notes | The orange variant is intentionally **not** a template image. Apple HIG: colored icons signal status differently than auto-tinted templates. |

## 14. Open in Browser (per-server)

| Field | Value |
| --- | --- |
| Auto | y (unit, action wiring) |
| Auto pin | `actionRunner.test.ts` "openUrl: forwards to deps.openUrl + refreshes; no in-flight banner" |
| Owner | agent (URL-launch is OS-level) |
| Repro | Per-server submenu → `Open in browser`; top-level `Open This Computer in Browser` |
| Expected | Default browser navigates to `<dashboardUrl>/s/<slug>` or `<dashboardUrl>/s/<slug>/computer/<machineId>`. |

## 15. Sign out

| Field | Value |
| --- | --- |
| Auto | y (unit) |
| Auto pin | `actionRunner.test.ts` "signOut: calls api.logout + posts info notify…" |
| Owner | harness |
| Repro | While signed in, click `Sign out` |
| Expected | inFlight "Signing out…", `Signed out` toast, menu reverts to `Sign in…`. Per-server attachments are untouched (they still appear; `Restart runner` still works). |

## 16. CDN poll failure (latest version unknown)

| Field | Value |
| --- | --- |
| Auto | n |
| Owner | agent |
| Repro | Run the app on a machine without CDN reachability (e.g. firewall-block `cdn.raft.build`). |
| Expected | No `Update available` row appears; no error toast (the CDN probe is best-effort). The menu still works in every other way. |

## 17. Error taxonomy (non-ComputerError surfaces clean)

| Field | Value |
| --- | --- |
| Auto | y |
| Auto pin | `actionRunner.test.ts` describe `"runAction — error taxonomy (non-ComputerError surfaces clean)"` (raw `ServiceClientError` + non-Error thrown values like a thrown string) collapse to `UNKNOWN` errorCode in the notify detail; the span-keystone describe additionally covers a generic `new Error()` ending the span with `errorCode=UNKNOWN`. |
| Owner | harness (any IPC failure path) |
| Repro | Force the underlying lib call to throw a non-`ComputerError` (e.g. simulate a service.sock connection refusal that hits `ServiceClientError` before lib's wrapping). |
| Expected | The user sees `Action failed` notify with `UNKNOWN: <message>` detail — never a raw stack or unwrapped error type. (Yingjun's defense-in-depth follow-up wraps `ServiceClientError → ComputerError` with an `IPC_*` code; until then `UNKNOWN` is the safe ceiling.) |

## 18. Action span tracing (every click leaves a span)

| Field | Value |
| --- | --- |
| Auto | y |
| Auto pin | `actionRunner.test.ts` describe `"runAction — action span (tracing keystone)"` — each click records exactly one span with `surface=computer`, `kind=internal`, `attrs.action=<kind>`. Success → status `ok` no errorCode; ComputerError → status `error` + `errorCode=<ComputerError.code>`; non-ComputerError → status `error` + `errorCode=UNKNOWN`; user-cancelled detach → status `ok` (cancel is not an error); refresh no-op → still records one span. |
| Owner | harness (replay against the on-disk `<computerDir>/traces/` sink) |
| Repro | Click any menu action; tail `<computerDir>/traces/daemon-trace-*.jsonl`. |
| Expected | Each click yields one JSONL line with the shape above. Trace stream shows the click → route-decision → service chain in order. |

---

## Adding a new corner case

1. Try to express it as a `menuModel` literal or a stub-`actionRunner` test first. If you can, mark this entry **Auto: y** and link the test name.
2. If the case is interactive or visual (real browser, real OS dialog, real tray render), mark **Auto: n** and write the repro precisely enough that another agent can reproduce it cold.
3. Update the matching `actionRunner.test.ts` / `menuModel.test.ts` fixture so the regression survives a refactor.
4. Reference the entry from the PR that introduces the case — the handbook is a living index, not a one-shot doc.

The automated e2e harness (Yingjun, post-#3229) plugs into the **Auto: y** rows by exercising the same paths against a real `service.sock` and `health.json` instead of the stub api. The handbook stays the source of truth for **what corner cases exist**; the harness is the source of truth for **which ones pass right now**.
