# Agent hosts (RFC 060)

The daemon core drives every agent lifecycle call (start, stop, deliver, probe,
interrupt, app-inbox notice, running/session/launch queries) through one
`AgentLifecycleHost`. With the OAR host on (the default) that is
`AgentHostRouter`, with two hosts behind it:

- **Legacy host:** `AgentProcessManager` plus `drivers/`. Unchanged.
- **OAR host:** `OarAgentHost`, which runs an agent on an OAR `Session`
  (`@botiverse/oar`). OAR owns the process, the record stream, turn
  boundaries and typed control results; this host owns Raft's part around
  them. It never sees a `ParsedEvent`.

Workspace, skills, diagnostics and runtime-profile calls still go to the
process manager. The process manager is still imported only by `core.ts`
(`scripts/ci/check-daemon-runtime-boundaries.ts`); the OAR host reaches what
it shares with it through narrow callbacks that `core.ts` wires
(`OarAgentHostDeps`), and the legacy driver's launch preparation through
`drivers/index` (`prepareGrokLaunch`, `prepareCodexLaunch`).

Runtimes on the OAR host: **grok**, and the OAR-only **qwen** (Qwen Code),
**qoder** (Qoder) and **codebuddy** (CodeBuddy Code). The OAR-only runtimes have no legacy driver: their driver
shell (`drivers/oarOnly.ts`, `oarOnly: true`) gives detection, OAR model
listing and the standing prompt, and never spawns. The router sends every
start of them to the OAR host whatever `runtimeHost` says, and a start the OAR
host cannot run (Windows, a missing CLI, an RFC 071 refusal, an unresumable
session) fails with `OarOnlyStartError` instead of reaching the legacy host.
They have no server flag: whether one can be used for a new agent or a switch
is what the Computer reports (server `runtimeAdmissionService.ts`).
**codebuddy** (CodeBuddy Code): OAR drives it through ACP (`codebuddy
--acp`): the standing prompt as `systemPrompt` (a private
`--system-prompt-file`, not re-applied on resume as far as Raft knows, so
`standingPromptRefreshesOnResume` is off), the model as an ACP config option,
the effort as its `thought_level` (listed for its current model only). No
steer (`after_turn`), no single-task stop, no managed MCP yet (whether it
takes an HTTP entry and what it stores of one are not verified). Not run with
a real CodeBuddy login in Raft yet: hence experimental.

**antigravity** has an OAR launch (`oarAntigravityLaunch.ts`) behind
`agent_runtime_oar_antigravity` (#oar-raft:#2; on a server where it is on, new
Antigravity agents can be created again, #oar-raft:#6): `agy acp` as one session across
turns, on the user's own `agy` login, which OAR neither signs in nor reports. It
reuses the driver's environment and its managed MCP file in the workspace
(`.agents/mcp_config.json`), never ACP, where `agy` would store the entry
(see [Managed MCP](#managed-mcp)). An
agent whose session id came from the driver falls back to the driver until the
session is reset. Run on a real `agy` 1.5.2 with a fake model (no account):
opens, standing prompt in the request, workspace MCP connects, steer, resume.
Not run with a real `agy` login yet.

**codex** has an OAR launch (`oarCodexLaunch.ts`), used wherever the Computer
advertises `runtime-host:oar:codex` (its flag `agent_runtime_oar_codex` is
retired, #raft-architecture:#32; #wg-ax:#3). It reuses the driver's preparation: the
resolved executable, the app-server environment (without the driver's managed
MCP token variable; Windows included: where the driver runs an npm install's
`codex.js` through a node host, OAR gets the `.cmd` shim it came from, only
when OAR runs that shim's script itself without cmd.exe (an npm or pnpm shim:
the shim's own `node.exe`, else `node` on PATH); otherwise the start falls back.
On Windows the environment overlay matches names in any case, so the daemon's
`Path` is not removed under the launch's `PATH`), the managed MCP server as `mcpServers`
([Managed MCP](#managed-mcp)), the standing prompt as
`appendSystemPrompt` on every open (never `systemPrompt`, which replaces
Codex's base prompt), and an explicit service tier (`priority` or `default`,
the ids Codex reports back, #11175). Which install it picked is traced as the
driver traces it: `daemon.runtime.node_host_launch` with `host = 'oar'`,
`candidate_source`, `rejected_candidate_count` and `rejection_kind` (no paths;
status `error` when OAR cannot run that install and the start falls back). With a managed MCP server attached, the
first input waits until Codex reports that server started or failed, as the
driver holds its first turn, for at most 30 s (`OarLaunch.firstInputReady`,
traced as `daemon.agent.oar.first_input_ready`; a stop or Codex exiting ends
the wait). The thread name is not passed yet; since OAR 0.87.2 an older
app-server without `thread/name/set` no longer fails the open (OAR records a
`thread/name/set/error` frame, as the driver ignores the failure). There is no
Codex version floor: a Codex with no `serviceTier` in the open reply, or no
`thread/settings/updated` on a resume that changes effort, fails the open and
the start falls back to the legacy host. Since OAR 0.87.2
the app-server starts in the session's `cwd`, the agent's workspace, as the
driver's does; OAR fails the open when that directory does not exist.

**cursor** has an OAR launch (`oarCursorLaunch.ts`, #oar-raft:#10) behind
`agent_runtime_oar_cursor` (server-scoped, default off), only from a Computer
that advertises `runtime-host:oar:cursor`
(`DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR`: Linux, not the single-file SEA
build, Node 22.13 or newer, and `@cursor/sdk` resolves beside the daemon;
`cursorSdkAvailable` in `oarLoader.ts`). `@cursor/sdk` (1.3.1, OAR's peer) is a
daemon dependency, so npm and Electron installs of the Computer ship it with
its native companion; the daemon never imports it. OAR 0.101 runs it **in a
Node child per session** (`execution: "subprocess"`, `envBase: "clean"`), and
in a one-shot child for each sign-in status read: the daemon's
`process.execPath` running OAR's script, which imports the SDK from the file
URL `cursorSdkModule()` resolves. A SEA cannot start that child and has no
node_modules, so it never advertises the capability; its bundle aliases
`@cursor/sdk` to an empty module, and `verifyBundledOarHost` does not check
Cursor. OAR refuses `systemPrompt`, `appendSystemPrompt` and `launchArgs`
for Cursor.

- Standing prompt: ahead of a fresh session's first input (the cursor driver
  has no native standing prompt), as on the legacy driver.
- Environment (`cursorChildEnv`): the child starts from nothing and gets only
  the session's `env`: HOME, PATH, TMPDIR, LANG, LC_ALL, USER, LOGNAME,
  proxies and `NODE_EXTRA_CA_CERTS` from the daemon, `SHELL=/bin/sh` (the SDK's
  shell tool runs `$SHELL -lc`), then the launch's own variables from Raft's
  CLI transport (`prepareCliTransport` `launchEnv`): the agent's env vars,
  its identity, and PATH with the `raft` wrapper dir in front, so `raft`
  works as on any runtime. Daemon-only variables never reach the agent's
  tools ("the agent's tool shell does not see daemon-only environment
  variables", `oarCursorLaunch.test.ts`). OAR adds its native-companion
  variables and a marker.
- Cursor API key: `CURSOR_API_KEY` (the agent's env vars, else the daemon's)
  goes in the session's `env`; OAR takes it out of the child's environment
  and gives it to the SDK as `apiKey` over IPC, so tool shells and the
  child's `/proc/<pid>/environ` never hold it.
- Managed MCP: `mcpServers` with a bearer header ([Managed MCP](#managed-mcp)).
- Model: the Cursor CLI's `default` / `auto` are the SDK's default (no model
  given); any other id passes as is, and one the SDK does not list fails the
  open (a hand-back). No effort is passed.
- Sign-in: the SDK's own (`~/.cursor/sdk/auth.json` under the child's HOME,
  or `CURSOR_API_KEY`), separate from the Cursor CLI's. Read at the launch in
  the environment the agent's session would get (`cursorAuthEnv`: its env
  vars over the daemon's): with neither, signed out without starting a
  child; otherwise OAR's `authStatus` (a one-shot child that loads the SDK,
  reads the stored login from disk, no network, 20 s bound). Signed out: the start goes back to the driver silently
  (`cursor_sdk_signed_out`). Unreadable (`cursor_sdk_status_unknown`): back
  to the driver only when the agent has no SDK session; with one, the start
  fails (`OarLaunch` hand-back `failHere`, router stage `oar_kept_failed`) and
  the session is kept for the next start.
- Sessions: the SDK resumes only its own agent ids (`agent-<uuid>`); the CLI
  cannot resume those, nor the SDK the CLI's bare uuids
  (`runtimeHostSessionDrop`, `runtimeSpec.ts`). A start on the OAR host with a
  Cursor CLI session drops it before the launch (`session_dropped_for_spec`
  `reason: "runtime_host_changed"`); once the new session is open, the
  server forgets the old one (`agent:session:invalidate`
  `reason: "runtime_host_migration"`) and the agent's Activity Log gets a
  `system` row saying a new Cursor session started because of the move (not an
  error; `daemon.agent.oar.cursor_session_migrated`, once per old session per
  daemon). The legacy host drops an SDK session the same way (trace and
  invalidate, and an Activity Log row with the likely reason: Cursor through
  the SDK off or not available), so turning the flag off never feeds an
  `agent-` id to `cursor-agent --resume`. An
  SDK session the SDK reports gone (`SessionNotFoundError`) is not handed back
  (the driver could not resume it either): a new SDK session starts on the
  OAR host with the same start (`daemon.agent.oar.resume_failed_new_session`,
  invalidate `missing`, an Activity Log row). Any other resume failure fails
  the start and keeps the session (no invalidate).
- Child process: a crash or an out-of-memory in the SDK ends that agent's
  child only (OAR records `exited`), not the daemon; OAR ends the child's
  tree on dispose and when the daemon dies. About 120 MB RSS per child (OAR's
  measurement, SDK 1.3.1, Linux arm64).

Not run against a real Cursor account (no run through the real SDK in
subprocess mode yet, here or in OAR).

## Managed MCP

The managed MCP apps an agent has (Notion, Linear, ...) reach a runtime as one
MCP server: the launch's loopback proxy (`managedMcpRuntimeProxy.ts`), behind a
token minted for the launch and revoked with it (`cleanupLaunchProxiesForLaunch`,
also when an open fails). On this host the launch passes it as OAR's
`SessionOptions.mcpServers` (`oarManagedMcp.ts`, #oar-raft:#8): an HTTP entry
to `<proxy>/mcp` with the token as `Authorization: Bearer`. The token is not in
the URL, argv, the system prompt or the runtime's environment. OAR's
`McpServer` has no env reference (codex's `bearer_token_env_var`), so the
token goes as a header. It goes again on every open, resume included.

| Runtime | Before | Now |
|---|---|---|
| codex | `-c mcp_servers.<name>.url` and `bearer_token_env_var` as `launchArgs`; the token in the app-server's env (`RAFT_MANAGED_MCP_TOKEN`) | `mcpServers`: OAR sends `config.mcp_servers.<name>.http_headers` on `thread/start` / `thread/resume` over stdin; neither the `-c` overrides nor the env token are passed. The first input still waits for `mcpServer/startupStatus/updated` for that server |
| grok | none (the driver sends ACP `mcpServers: []`) | `mcpServers` when the agent has managed MCP tools: ACP `mcpServers[].headers` on `session/new` / `session/resume` (grok declares `mcpCapabilities.http`) |
| qwen | none | `mcpServers` when the agent has managed MCP tools and `qwen --version` is at least `QWEN_MIN_HTTP_MCP_VERSION` (0.26.0, OAR's Qwen baseline): the stream-json `initialize` control request. Below it, or unreadable, nothing is attached and a warning is logged: Qwen has no legacy driver, so a refused entry would fail the start |
| qoder | none | none: OAR's channel is a 0600 `--mcp-config` file for the process's lifetime, which the agent (the same OS user) could read; a runtime that never had the token in a file doesn't start having it there (`OAR_ONLY_MANAGED_MCP`) |
| codebuddy | none | none yet (`OAR_ONLY_MANAGED_MCP`): OAR would send ACP `mcpServers` on `session/new` (stdin), but neither CodeBuddy's HTTP MCP support nor what it stores of an entry is verified |
| cursor | the workspace's `.cursor/mcp.json` with the token in the URL path, readable by the agent | `mcpServers`: the SDK's `mcpServers` record with `headers` on create and on resume (over IPC to the session's child, never its environment or argv). Whether the SDK keeps the entry on disk (its agent store, transcripts) is not audited yet |
| antigravity | the workspace's `.agents/mcp_config.json` (token in the URL path, a 0600 file removed with the launch) | unchanged: OAR refuses an entry with `headers` or `env` (`mcpServerCredentials`), because `agy` stores session entries in plain text in its conversation database. Raft's entry always carries a token. Putting it in the URL would get past the check, but the token would still be stored |

Grok and qwen attach the server only when the Server's snapshot lists a tool
and the runtime's own condition holds (`prepareManagedMcpRuntimeProxy`'s
`admit`). Otherwise nothing is registered and no token is minted, so an agent
without managed MCP launches exactly as before. Codex attaches it as the
driver does, also with an empty catalog.

The token's transport is verified: it travels over the runtime's stdin, never
in argv or the environment. For codex this is pinned against OAR's own
`codexThreadOpen` (`http_headers` on start and resume; its error redactor
strips the token). Whether a runtime then writes the entry to its own disk is
verified only for some. OAR found agy storing it (hence the refusal), and OAR's
post-exit scan of an isolated HOME after qwen 0.26.1 found no MCP credential.
Codex's and grok's stores have not been audited for it, and Raft has not
checked any runtime's disk itself. If one does keep it, the token is per
launch, accepted only on the loopback proxy, revoked at launch cleanup, and
reaches only the agent's own managed MCP tools. It never carries a
connector's credential. The legacy drivers are unchanged. No runtime on this host has a
turn-origin getter (`ctx.readTurnOrigin`) yet, so a refused call raises no
connection card here, the same as codex before.

## Selection

Per start, never per session:

1. The server sets `AgentConfig.runtimeHost = "oar"` only when the connected
   daemon advertised `runtime-host:oar` (`DAEMON_CAPABILITY_RUNTIME_HOST_OAR`)
   and the Server's flag for the agent's runtime is on
   (`agent_runtime_oar_grok`, `agent_runtime_oar_antigravity`,
   `agent_runtime_oar_cursor`, server-scoped, default off; no row = off).
   Cursor also needs `runtime-host:oar:cursor` (see **cursor** above). Codex has no flag and needs
   `runtime-host:oar:codex` instead
   (`DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX`): earlier Computers advertise
   `runtime-host:oar` with an unfinished Codex launch. Grok likewise needs
   `runtime-host:oar:grok` (`DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK`, Computers
   from 1.0.56 to 1.0.67 lack fixes its default needs), and the OAR host takes a
   Grok start only for Grok Build itself at 1.0.70 or later
   (`isVerifiedGrokCli`): other ACP programs in the Grok slot keep the driver,
   traced as `grok_cli_not_verified`. A Computer that never
   advertised the capability never gets the field. There is no version
   comparison. `RAFT_AGENT_RUNTIME_OAR_DISABLED=1` on the server turns every
   runtime off.

   In an incident, turn the Server's flag for that runtime off first: it applies at the next start, without a deploy.
   `RAFT_AGENT_RUNTIME_OAR_DISABLED` is an environment variable of the server
   process and needs a redeploy (as does the daemon-side switch below).
2. The router sends the start to the OAR host when it asked for OAR, the legacy
   host holds no process or start for the agent, and `supports()` says yes;
   otherwise to the legacy host. Every decision is traced as
   `daemon.agent.host.selected` (`requested`, `host`, `fallback_reason`,
   `stage`).
3. A start for an agent a host already runs or starts stays on that host (a
   rebind). A flag change therefore never touches a running session; the next
   start after the session ended follows the flag.
4. The OAR host can still hand a start back (`fallback`) before anything ran
   on OAR (see below); the legacy host then runs that same start
   (`stage: "oar_fallback"`).

`RAFT_DAEMON_OAR_HOST_DISABLED=1` turns the OAR host off on one daemon: no
router, no capability, every start on the drivers.

## Host switches keep the session

The OAR launch for grok resumes the native grok session id the legacy driver
stored (`config.sessionId`), in the same cwd (the agent workspace) and with the
same launch environment (the driver's own `prepareCliTransport`), so grok
finds it in the same store. OAR sends `session/resume` or `session/load` with
the same `sessionId` and `cwd` the driver's `session/load` sends
(`oarGrokResume.test.ts` runs both against one fake grok).

Model and effort differ on the wire, not in effect: the driver sends the effort
in `session/set_model` `_meta` (selecting Grok's default model when the agent
runs the default); OAR sends `session/set_config_option` on Grok's
`reasoning_effort` (`thought_level`) option after any `set_model`, with or
without a model, and a resume without an effort keeps the level Grok saved. An
effort the model does not offer is refused at open, so the start is handed
back (`open_failed:Error`, open failure class `settings_not_confirmed`)
before any prompt; a command in the grok slot without that option hands back
any start with an effort (`open_failed:UnsupportedOptionError`)
(`oarGrokEffort.test.ts`, against a fake with Grok's documented shapes).

If OAR cannot open the session (refused or missing resume, any open failure),
the OAR host **never opens a fresh session in its place**: it hands the start
back and the legacy host runs it on the same session id, with its own recovery
if grok really lost it. This applies to every refused resume on the OAR host,
not only to the first start after a switch (the host cannot tell the two
apart). Fallback reasons: `resume_failed:<error>`, `open_failed:<error>`,
`first_input_rejected:<code>`, `start_refused` (the RFC 071 gate would refuse;
the legacy host refuses it the same way and shows it), `outcome_storage_blocked`,
`stale_dispatch`, `error:<name>`.

## Start

Before the session opens, the OAR host runs the legacy host's own steps:
workspace initialisation (`agentLaunchWorkspace.ts`), the RFC 071 gate (wait
for the connection's capability, `startRefusal`, then `openProcess` before the
process exists), wake session recycling and its constructed briefing
(`wakeSessionRecycle.ts`), the standing prompt (the grok driver's
`buildSystemPrompt`, sent as `systemPrompt`, which OAR passes as grok's
`systemPromptOverride` like the driver), the standing-prompt refresh for a
resumed session (`standingPromptRefresh.ts`, same ledger file), the first input
from the same ladder (`startupInput.ts`, shared with the process manager), the
startup MEMORY.md block, the fresh-session standing prompt in the first input
(`applyFreshSessionStandingPrompt`; a no-op for grok, whose standing prompt is
native), held server context (task #26), and the launch's spawn config
(`buildSpawnConfig`: runner credential, server URL, provider, env defaults).

Whether the start resumes its session, starts a new one or is refused is one
pure rule on both hosts (`chooseSession.ts`, reconciler step 8a), fed facts the
host has read: first the runtime spec drop (step 7, below), then the stuck
session refusal (task #10, `session_needs_reset`; legacy host only, no runtime
the OAR host runs keeps compaction failures on its session), then the wake
session recycle. A dropped session is neither refused nor recycled. The
traces stay each rule's own (`session_dropped_for_spec`,
`start.session_needs_reset`, `wake_recycle` / `wake_recycle_skipped`).

A live process reaches that recycle only through a start, so the legacy host
stops a cold one (reconciler step 8b, RFC 070 cold idle; the OAR host has its
own, below). Cold is a session policy on top of idle, not an idle of its
own: the one reconcile entry (`reconcile`, after the spec drift) finds the
process idle (`agentNotIdleReason`: background tasks from the event stream,
input not yet read, untold messages, tracked mentions) with no event for over
an hour (`coldIdleGate`, memory only; a Claude Code older than 2.1.220, or of
unknown version, is never cold: before typed task envelopes it showed a
background shell only in its transcript), then reads its session's context from
the transcript (async, one read per agent) and, past 128k, stops it the way a
spec restart does (`cold_idle_recycle`, session kept;
`daemon.agent.cold_idle_stop` with the `trigger`). A context it cannot read is
not cold. When the read answers, everything is decided again (the process,
its session, idle, the time since its last event) before anything stops. A
read in flight is not a stop: it holds no pi rotation. Background work is read
only from the event stream: neither the transcript's background-task markers
nor the session's sidecar files count any more. Every fact that makes the
process idle calls the entry, and the 10-minute sweep calls it for all
(`daemon.agent.cold_idle_sweep`: views, stops and the gate that held each
other one, once the sweep's reads have answered). A spec stop past the cold gap
says so (`cold_gap`, or `cold` with the context when a cold read found the
drift).

Turn-end compaction (#proj-runtime:#54 phase 3, `turnEndCompaction.ts`) runs
only while the Server's `turn_end_compaction` is on for the agent
(`AgentConfig.turnEndCompaction`, also answered by `server:features`), for Codex
and Grok: at a turn end with nothing running, held or queued and no
compaction open, a session summary context past 250k on a window of at least
400k calls OAR's `Session.compact()` (`maybeCompactAtTurnEnd`). Deliveries that
arrive meanwhile are held in `handOff` and handed over when it settles (a
compaction is no turn, so no turn end would). A refusal keeps the arm for a
later turn end; a compaction disarms it until the context is back at the
threshold. Each decision is `daemon.agent.turn_end_compaction` (skips once per
session and reason).

The OAR host's cold-idle stop (#proj-runtime:#54) runs only while the Server's
`wake_recycle_oar` is on for the agent (`AgentConfig.wakeRecycleOar`, also
answered by `server:features`; a change restarts nothing), for the runtimes
whose session summary supplies the facts (`WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES`:
Codex, Grok), and never with the local `RAFT_WAKE_RECYCLE=0`. From the one
reconcile entry, after the spec drift (`reconcileColdIdle`): the session
summary's facts (`sessionSummaryResumeFacts`; unknown while a turn runs or no
context was reported, so not cold), the same gates and thresholds
(`coldIdleGate`, `decideColdIdle`: idle over the hour, context over 128k),
idle as this host reads it (`agentNotIdle`: a turn, a working sub-agent, a
delivery held or being written), and never while compacting. A cold session
is ended the way the spec stop ends one (`cold_idle_recycle`, the session
kept, no status or activity; `daemon.agent.cold_idle_stop` with
`host: "oar"`): the next delivery finds no process, the Server starts the
agent, and that start's recycle decision, from the same summary, starts it
fresh with the briefing (`daemon.agent.wake_recycle`, `host: "oar"`). The
reconcile sweep keeps running while a session may turn cold
(`coldIdleCandidate`), since a session turns cold with no event.

Warm recycle (#proj-runtime:#54, RFC 070 §6.5, `wakeRecycleWarm.ts`) runs only
while the Server's `wake_recycle_warm` is on for the agent
(`AgentConfig.wakeRecycleWarm`, also answered by `server:features`; a change
restarts nothing), for the same runtimes and under the same `wake_recycle_oar`
as the cold-idle stop (the next start needs the summary's facts). At a clean
turn end (completed, with output) with nothing running, held or queued, a
summary context past 250k on a window of at least 400k marks the session
(`maybeMarkWarmRecycle`; it goes before turn-end compaction, and only one of
the two acts on a turn end). Past 500k the session is ended at once; otherwise
after 2 minutes with no delivery (`stopForWarmRecycle`, ended exactly as the
cold-idle stop ends one). A delivery inside the window (`hold`, an app Inbox
notice, a host input) drops the stop, and that session's next turn end is
left to turn-end compaction (below the ceiling). A session a start resumed
although its stop was remembered is never marked again. An exit, a stop or a
spec restart ends a pending mark with no event (`release`, `stopAgent`). The
host remembers the stop
(`WarmRecycleMarks`, in memory) and hands it to the next start's recycle
decision, which starts fresh with the warm notice whatever the gap
(`daemon.agent.wake_recycle`, `recycle_kind: "warm"`). Events:
`daemon.agent.wake_recycle.warm_marked` / `warm_stopped` / `warm_cancelled`.
The warm panel (RFC 070 §6.5, `buildConstructedPanelFromSummary({ warm })`)
adds the summary's `notes` (the latest text of each of the last 2 turns, kept
past a tool call) and `todos` (Codex's `turn/plan/updated`, an ACP `plan`
update from Grok, a `TodoWrite` or `update_plan` call; open items only), both
of the retired session and in the files' in-play window, and shows 30 actions
instead of 12. Both hosts log one
`[WakeRecycle] recycled: …` line per start that recycles, warm or cold
(`describeRecycledWakeLogLine`).

Health comes first in that entry (reconciler step 9, rule 3 / E2; the OAR
host applies the same rule to its own facts, below): a process stalled with
work queued is broken. One pure rule decides (`stalledWithWork.ts`, no host
types): messages queued, a turn under way, no stop underway, no delivery held
on purpose (a provider limit, an invalid credential or a runtime error's
delivery backoff), and silent (no runtime event since the later of the last
one and the turn's start) for 15 minutes, or 60 for an alive non-stdin runtime
with no open tool; a direct-stdin runtime also needs a session and no open
tool, unless stdin is known broken or the tool's diagnostic snapshots (read by
the host only when the open tool is the remaining question) show no live work.
Broken is stopped at once, not at idle (`stalled_recovery`, its traces and
activity as before; `daemon.runtime.stall.recovery_action` with the `trigger`
and the streak), and the close path starts it again with the queued messages,
resuming the session (`restart_stall`). What reaches it: a delivery queued
behind a turn (`delivery_arrived`), the sweep, and one stall-deadline timer per
process (`stall_deadline`), armed for the moment its queued work would cross
the threshold and re-armed lazily (it decides nothing itself; progress or a
turn start with work queued arms it when none is). There is no fixed recheck
interval, and the activity heartbeat only reports the stall (stalled without
queued work stays that fact). After two replacements in a row with no model
output or turn end in between, a third stall is not replaced
(`daemon.agent.stalled_recovery.gave_up` with the streak; the agent shows
"<runtime> stalled repeatedly with queued messages; restart it to retry"),
until model output, a turn end or an explicit stop (the Retry) ends the streak
(memory only, per agent, kept across replacements; one store per daemon,
shared with the OAR host).

The OAR host has the same entry (`reconcile`: health, then the runtime spec)
and the same rule, fed OAR's facts (`stalledWithWorkFacts`); a fact OAR cannot
give counts as not stalled, so a session is held longer rather than a long tool
killed. Inbox: the deliveries the host holds for the session (`pending`). Turn:
OAR's status is `running`. Stop underway: the host is ending the session, or a
turn abort is in flight (`stop.pendingAbortIds`). Holds: the credential's
provider limit (or its wait) and an invalid credential (the OAR host has no
runtime-error delivery backoff). Delivery mode: a launch that steers
(`busyDelivery: "now"`: codex, qoder) is a direct-stdin runtime; `after_turn`
(grok, qwen, codebuddy) holds input for the next turn, so it is a non-stdin runtime,
alive (an exit would have released the agent): 60 minutes, and any open tool
holds it. Open tools: the root agent's `tool_call_started` with no
`tool_call_ended` in the running turn; OAR has no tool diagnostic snapshots or
stdin-broken evidence, so an open tool is never proven idle. Silence: since
the status's `lastEventAt` (the latest record of the session, child agents'
included; the clock of OAR's stall report), never before the turn's start.
Broken ends the session at once (the stop that keeps the session, as a spec
restart: no status, `held_dropped` never sees the deliveries; planned as
`stalled_recovery` since step 10b) and the host starts the agent again itself
on that session (`restartAfterEnd`), with the same launch
(`process_spawned` `respawn`, after the ended session's `process_exited`) and a
new runner credential; the held deliveries never leave the daemon and go in
its first input, once. They cannot go back to the server: a plain delivery was
acked on custody, so a rejection finds nothing pending, and the server starts
no agent on an exit. A restart OAR cannot run (`fallback`: a refused resume, the
gate) shows the agent stopped (`daemon.agent.oar.stall_restart_failed`, status
`inactive`, an error activity); a held tracked mention is handed back for the
server's wake and plain deliveries stay unread for its next start. The
triggers are the legacy host's: a delivery held for a committed session
(`delivery_arrived`), the sweep (it now also runs while any session has
deliveries waiting), and one stall-deadline timer per launch (`stall_deadline`;
any session event with deliveries waiting arms it when none is). The events and
the activity are the legacy host's, with `host: "oar"`
(`daemon.runtime.stall.recovery_action` with `trigger`, `streak` and
`queued_messages_count`; `daemon.agent.stalled_recovery.gave_up`); model
output (text, reasoning, a tool start), a turn end or a person's stop ends the
streak. OAR's "No runtime output for N min" report stays the fact (C15),
at the same threshold.

What follows a process's exit is decided by one pure rule, on both hosts
(reconciler step 10a, `planExit.ts`, no host types; the OAR host since step
10b, below; the table in `testing/planExitCases.ts`). The legacy close path gathers
the facts (exit code and signal, an OOM kill, the turn boundary, the daemon's
own `expectedTerminationReason`, the runtime error and its recoverable class,
whether queued work wakes the agent, the credential's provider limit and
invalid record, the session's known resume error and early-crash record,
model output, uptime, the crash streak and its cap streak), plans, and acts
(`daemon.agent.exit.planned`: kind, start, hold, session choice, streaks,
hand-off):

- D1 clean exit with work queued: start now (a provider limit holds it until
  the limit ends, an invalid credential until it changes); D2 nothing queued:
  the next wake, from the restart snapshot.
- D3 recoverable close (rate limit, provider server, connection, stream): with
  work queued, start again after the crash streak's backoff (10 s, 20 s, 40 s,
  ... up to 5 min); with nothing queued, the next wake (held for the backoff
  from the second close in a row). Never capped: through a provider outage the
  agent keeps retrying every 5 min at most, showing the provider error, and
  runs again once the provider answers (a provider limit is the credential's
  hold, D1, not this).
- D4 resume failure: the facts go to `chooseSession` (rule 1b: a known resume
  error, or `RESUME_FAILURE_THRESHOLD` = 2 early crashes in a row of launches
  that resumed the session: exit 1-127, within 15 s, no model output, no
  credential hold, not recoverable). A new session starts at once and the
  server is told (`agent:session:invalidate`).
- D5 any other crash (OOM and signals included): `inactive` with the exit, the
  next wake; the restart snapshot stays (it is the agent's state), so the next
  wake resumes the session from it.
- Every crash (D3, D5, a resume failure's crash) counts into the crash streak
  (the backoff's; kept in `ExitStreaks`, planExit.ts: one store per daemon,
  created in `core.ts` and shared by both hosts with the early-crash record,
  so an agent's exits on either host count into the same streaks and a
  person's stop on either ends them); every one but
  a D3 close also counts into the cap streak, which a D3 close neither adds to
  nor resets. Model output, a clean turn end or an explicit stop ends both, a
  startup request cleanup resets both. From `CRASH_STREAK_CAP` = 5 in the cap
  streak the daemon stops restarting the agent: the snapshot and buffered
  deliveries go (`daemon.agent.spawn.local_restart_stopped` `source:
  process_close`, with the last exit's kind, code, signal and runtime error
  class and fingerprint, never its text, so a provider error the classes
  missed is visible), the exit and a failed start are reported (the
  server's early-exit and start-failure breakers count them and own the next
  start), and an error with no required action shows ("crashed 5 times in a
  row ...; restart the agent to try again"); Restart (an explicit stop, then a
  start) ends the streak. A failed daemon-local spawn and a start timeout use
  the same cap and backoff function (D12).
- The daemon's own terminations keep their outcomes: a turn end, a stall
  replacement (`restart_stall`), a cold-idle or spec stop and a turn interrupt
  are clean unless a live error says otherwise (the last two ignore a stale
  one); a start timeout and a startup request error have their own cleanups.
  A stop releases the process before its close, so no plan runs (D13: a stop
  while starting ends the child with the one stop of step 5).

### Exit and restart on the OAR host (step 10b)

An OAR session's end goes through the same `planExit` (`onExited` for an exit
on its own; the daemon's own stops: `explicit_stop`, the spec stop as
`cold_idle_recycle`, the stall replacement as `stalled_recovery`), traced as
`daemon.agent.exit.planned` with `host: "oar"`. Before step 10b the OAR host
never restarted an agent on an exit (the design table's OAR exit row, not
#13333's D6): it relied on the server's next
start, which a held tracked mention's rejection triggers.

The facts, read from OAR (`exitFacts`); what OAR does not expose is read
conservatively:

| Fact | On OAR |
| --- | --- |
| exit code | the `exited` event's code; null when OAR has none, and for the daemon's own stops (planned before the dispose) |
| signal, OOM | never exposed (OAR keeps the pid): null, false. An exit with no code is a crash (D5), never clean, never an early crash |
| turn boundary | no turn runs, and the exit did not cut the last one short (failed `runtime_exited`, or aborted with no interrupt asked) |
| runtime error | the last turn failed and no turn started since (a turn start is the legacy host's delivery, which clears it) |
| recoverable class | OAR's failure class: `quota`, `rate_limited` → rate limit; `overloaded`, `provider` → provider server error; `unknown` by its text as the legacy host reads it (connection, stream, 429, 5xx); others none. `quota`, `rate_limited` and `overloaded` also record a provider limit (#46), which holds first (`held_provider_limit`) |
| provider stream failure | the failure's text (the same text is the stream class, so it is always D3 on OAR) |
| sticky failure | never: OAR's sticky failures end the session through E1 first (a new session or a hand-off, step 12; not planned) |
| inbox | every non-transient delivery held (OAR defers none; a first input held at the commit counts) |
| credential | the shared ledger's invalid record and provider limit |
| session | the session; the one the launch resumed (`options.resume`); no known resume error (a resume OAR refuses at open hands the start to the legacy host before the commit); the shared early-crash record |
| model output, uptime | text, reasoning or a tool start; since the session's open |
| a turn that did nothing (D6) | an exit on its own with work held and no model output from the session, whether or not a turn started (Tenny, review of #13336): counted, backed off and capped like a crash (the zero-evidence error at the cap), where a plain clean exit would start again at once, forever. A completed turn with no output does not end the streaks |
| streaks, backoff | the shared `ExitStreaks`; the legacy host's delivery backoff policy (10 s doubling to 5 min) |

Acting on the plan:

- Start now (D1 with deliveries held, D4 on a new session, a stall
  replacement), after the crash streak's backoff (D3, D6 with deliveries
  held), or after a provider limit's wait (a clean exit or a close inside the
  limit with work held):
  `restartAfterEnd`, the step 9 restart generalised. The deliveries the
  session held move into the new start's pending (its first input takes
  them, once; never handed back, so no rejection asks the server to start it);
  the same launch (`process_spawned` `respawn`), the session `chooseSession`
  chose, a new runner credential. The new start is registered at once, so a
  server `agent:start` meanwhile rebinds onto it (one process; its launch
  named by `process_spawned`), a delivery is held for it, and a stop cancels
  it; during a backoff the agent reads as starting and stays `active`
  (`Crashed (...); restarting in N s`). A provider limit's wait is the
  plan's (`afterMs`, the limit's remaining time), uncounted as on the legacy
  host; a release of the limit ends it early
  (`daemon.agent.oar.restart_wait_ended`), so a runtime that exits right
  after it opens inside the limit starts once, not once per exit. D4 tells the
  server to forget the session (`agent:session:invalidate`) and reuses the
  start's own inputs, as the legacy cold start does. A restart OAR cannot run
  (`fallback`) shows the agent stopped (`daemon.agent.oar.exit_restart_failed`).
- The next wake (D2, D5, D3 with nothing held, a credential hold): as before
  10b: `inactive` with the exit, `Crashed (...)`, held deliveries dropped, a
  held tracked mention handed back so the server wakes the agent. There is
  no host residency after the release, so `holdNextWakeMs` (D3's hold of the
  next wake) is not applied: the next wake is the server's start, and with
  nothing held there is nothing to loop on.
- The cap (`handToServer`): as the legacy host, `local_restart_stopped`
  (`source: process_close`, `host: oar`, the last exit's code, OAR failure
  class and runtime error class/fingerprint, no text), `inactive` with the
  exit, a failed start (`runtime_spawn_failed`, the same frames as the legacy
  `reportStartFailure`) and the error with no required action. Held deliveries
  are left to the server (a held mention is not handed back, as on the legacy
  host). The legacy host's memory of the failed start (shown again when a
  later delivery finds no process) is not shared: on OAR the error stays the
  agent's last activity until its next start.
- The cap's error by the plan's kind: D6's zero-evidence text
  (`formatZeroEvidenceStreakMessage`), else the crash text
  (`formatCrashStreakExhaustedMessage`); both in planExit.ts, for both hosts.
- Streak resets: model output (also ends the early-crash record), a completed
  turn that produced output, an explicit stop (planned, or with no session
  yet ended directly).

The server's re-wake stays the fallback (not removed): every next-wake exit
still hands a held mention back, and a daemon that crashed or restarted holds
nothing, so the server's re-send finds no process and wakes the agent. The
daemon only stopped relying on that rejection where it now restarts the
agent itself.

Parity (`oarAgentHost.exitPlan.test.ts`): every `PLAN_EXIT_CASES` row OAR can
express is driven through a real OAR exit and must plan what `planExit` plans
for the legacy row (kind, start, hold, session choice, streaks, hand-off).
Rows with a signal or an OOM kill run as an exit with no code (same plan); a
clean exit with work queued that is not D6 runs a session that said
something (on OAR that is the evidence). Of the 53 rows, 39 run on OAR (the
test pins the counts) and 14 are not expressible, with the reason in the
test: a deferred delivery (OAR defers none), an unclassified stream failure
(twice), a known resume error, a sticky failure, a turn end of a
process-per-turn runtime (twice), a cold-idle stop with work queued, a turn
interrupt, the start timeout (twice) and the startup request cleanup, a stop
before the commit (no session ends), and D6 with nothing queued (on OAR an
exit 0 with nothing held is an ordinary D2 and starts nothing).

Held deliveries and a daemon crash: a plain server delivery the OAR host holds
(for a running turn, a busy runtime, a credential hold, or a restart waiting
out its backoff) was acked to the server when the host took it (custody, as
the legacy host acks what it queues). If the daemon process dies, the held
copy is gone and the server does not send an acked delivery again; the
message is not lost from the conversation (an ack moves no read cursor, so it
stays unread and the agent's next start's unread summary and catch-up carry
it), but it has no wake of its own and waits for that next start. A held
tracked mention is not acked before the runtime takes it (`daemon_pending`):
the server's durable mention recovery sends it again at the machine's `ready`
(bounded by its recovery rounds), the new daemon owns no agent and rejects it
for no process, and the server wakes the agent. Acking a plain delivery only
once the runtime takes it would change the delivery-ack contract both hosts
share with the server's re-send cycle; it is out of step 10b's scope.

The start commits when the runtime takes the first input. Only then does the
host report the process (`agent:process_spawned`, naming every accepted launch
still waiting, as the legacy spawn does), `agent:status active`,
`agent:session`, the start's activity, and deliver what arrived meanwhile. A
start that ends before that reports nothing and closes its open record as
never started (`processNotStarted`).

## Delivery and exit semantics

- A server delivery is acked when the host takes custody of it, as the legacy
  host acks what it queues: the ack stops the server's re-sends and moves no
  read cursor. The host holds it while the launch is in progress, while a turn
  runs (`after_turn`, below) or when the runtime answers
  `busy`/`no_active_turn`. What a stop, exit or terminal failure drops before
  the runtime took it stays unread on the server, and the next start's unread
  summary and catch-up carry it (task #353; traced as
  `daemon.agent.oar.held_dropped`, a warning unless it was a stop).
- A server re-send of a held or taken delivery is the same delivery, matched by
  message id or, for one without (a transient notice), by delivery id: it is
  acked and never reaches the runtime twice. Taken ids are remembered per
  launch for an hour (past the server's longest re-send), at most 4096.
- A tracked mention follows the legacy host's transitions: `daemon_received`
  on arrival; `daemon_pending` when it is held (a re-send of a held one:
  `daemon_pending` `coalesced`), so the server stops re-sending it; at the
  hand-off `daemon_drained` and its ack, once; a re-send after that is acked
  again. Release notices are acked once the runtime takes them.
- A transient delivery that arrives while grok is busy or starting is held
  and handed over alone at the turn end (or the commit), where the legacy host
  drops it; on purpose, so a show-once notice is not lost to a running turn.
  It reaches the runtime at most once: never twice (dedup above), and a stop
  or exit drops it.
- The input is formatted as the legacy host formats it: a transient delivery
  as a system notice, ordinary ones as rendered thread context and/or the
  content-free inbox notice (`formatInboxUpdateRuntimeInput`), held server
  context ahead of it.
- Idle session: `prompt`, a new turn (`busy` if a turn started meanwhile: held
  as below, never steered into it). Busy session: the launch's
  `busyDelivery`. Grok steers since OAR 0.96 (`_x.ai/interject`, as the driver
  does: it joins the running turn and cancels nothing; `no_active_turn` is
  held for the turn end). `after_turn` deliveries stay in the host until the
  turn ends and then go in as a new turn; they never use OAR's queue, which
  for grok is held in the daemon process only (`queue.durable: false`), out
  of the host's sight.
- A launch that steers (`busyDelivery: "now"`: codex, qoder, grok,
  antigravity) does not steer
  into a turn that is compacting (`compaction_started` .. `compaction_ended`)
  or, for codex, in review mode (`CodexActivityReader.inReview`): the delivery
  is held (`held_while_compacting` / `held_while_reviewing`). A steer the
  runtime refuses (`runtime_refused`) is held too, never refused, and tried
  again at the next tool start, at most `STEER_REFUSALS_PER_TURN` times a turn
  (`held_after_steer_refusals`). A held delivery is tried at each tool start
  and compaction end, and at the latest at the turn end, as a new turn.
- A prompt an idle session refuses (`runtime_refused`; codex: `turn/start`
  failed) is not handed back either: refused back, it was offered and refused
  again every few seconds for as long as the session lived (one Mac, about
  840 an hour for 9 hours, 2026-11-10). The deliveries stay held, the session
  is ended and the agent started again on it with them, once
  (`daemon.agent.oar.prompt_refused_recovery` `action: reopen`, restart cause
  `prompt_refused`). A refusal again before the restarted session took a
  later idle prompt as a new turn (a steer into a running turn does not
  count, nor does the restarted session's first input) hands the agent to the
  server as a failed start (`runtime_repeated_failure`, `action:
  hand_to_server`), whose pause retries by itself; a person's stop resets it,
  so a Restart gets its one reopen again. A restart whose first input is
  refused shows the agent stopped (`daemon.agent.oar.exit_restart_failed`,
  `cause: prompt_refused`), and the server's next start picks the host (codex
  then falls back to the legacy host). The refusal is traced as its class and
  fingerprint (`refusal_class`, `refusal_fingerprint`, `refusal_http_status`,
  also on the turn span; none when the runtime gave no reason), never its
  text; the owner's message names the class only in plain words.
- An input over the runtime's bound (OAR 0.103: Antigravity's 185,000 bytes)
  is refused by OAR before it is sent: `rejected`, code `unsupported`,
  `failure: "input_too_large"` (decided by `failure`, traced as
  `oar_failure`). Several held messages too long together stay held and go
  one at a time (`deliverSingly`: as many as were refused together, then
  they batch again); a message too long on its own is refused (a mention
  answered as not delivered) and the agent shows Raft's own words, a
  `MessageTooLargeError` (code `message_too_large`: shorten it or split it),
  never OAR's reason; the session keeps running. A first input refused so is
  never handed to the legacy host (the deprecated Antigravity driver would cut
  it): the session starts on the first input without its messages (wake,
  catch-up, carried; `first_input` `without_messages`, no catch-up echo), and
  they follow as deliveries one at a time. Too long even without them (the
  standing prompt and MEMORY.md): the start fails here (`failHere`).
- Third-party event bodies a first input or delivery rendered are reported
  delivered (`reportThirdPartyEventsDelivered`); an inbox notice names them
  only, and the agent's `raft message check` reads them.
- Exit on its own: planned (step 10b, above). With deliveries held and a plan
  to start now or after the backoff, the host starts the agent again itself
  and the new start takes them. Otherwise (the next wake): `agent:status
  inactive` with the exit, `Crashed (...)` activity, `agent:process_exited`,
  held deliveries dropped (above); a held tracked mention is handed back
  (`agent:delivery:rejected`, once), so the server wakes the agent for it
  (its next start re-selects the host). After a stop, or a hand-off at the
  crash cap, it is not (the server's held cycle settles it, as on the legacy
  host). A delivery the runtime refuses `runtime_exited` / `disposed` stays
  held for the exit's plan. There is no wake request for plain ones:
  `agent:wake:request` carries app-inbox notices only.
- Stop: launch proxies and the runner credential released, the session
  disposed, `agent:process_exited` once; then, unless silent, the runtime
  profile report (`stop`), inactive and `Stopped`, as the legacy host orders
  them, and not at all when a later start of the agent is already under way.
  A stop with `wait` (a migration) and the daemon's `stopAll` resolve only
  once the agent's launch is undone (below), so a migration never uploads a
  workspace an OAR grok may still open, and every exit and never-started open
  record is stored before the outbox stops. `stopAll` publishes a held empty
  wake first (task #17), as the legacy host does.
- Runner credentials held (#wg-rbac:#27): `getHeldRunnerCredentialIds` gives
  every launch's, starting or committed (the one minted at spawn and its
  start's, when another), for the daemon's `ready`
  (`runner-credential-reconcile:v1`; the server revokes this machine's
  credentials the list leaves out). A stopping launch's are not listed: its
  release revokes them. The legacy host lists its processes', queued starts'
  and spawns in progress'; the router adds starts waiting for an OAR unwind.
- An ended session (stop, exit, terminal failure) is undone like a stopped
  start (below): the next start, on either host, begins once its dispose and
  `process_exited` are done, so the old grok has let go of the session.
- Rebind before the commit: a start for an agent whose start is in progress
  joins it (`process_spawned` names both launches). Its wake is a delivery
  (the start's own wake stays the wake; the same wake again is not counted
  twice). Its config, unread summary and resume
  input replace the start's until the first input is built (the launch reads
  the latest request again after its last wait before that); after that they
  do not change the launch, as on a legacy start that is already spawning.
- Stop before the commit: the OAR host gives the agent up at once, while the
  stopped start still undoes its launch (its grok may still be opening the
  agent's session). A start after the stop is a new start, never a rebind
  onto the stopped one: the router sends it to the host it asks for, and it
  starts only once the stopped launch is undone (`unwound`), so two grok
  processes never hold one session. Meanwhile it reads as `starting`; a
  legacy-bound start waiting there holds the agent on the legacy host. A stop
  of a start that waits cancels it at once (`cancelled`, nothing spawned).
  A waiting stop and `stopAll` wait for the unwind too (`openSession` takes
  no abort signal: the unwind waits for the open to return).
  The stopped start cancels only the launches it took on, and releases only
  its own launch proxies. A stop that lands while a fallback undoes its
  session wins too: the start is cancelled, never handed to the legacy host.

## RFC 071 runtime outcomes

The OAR host joins the same gate and outbox as the legacy host (the same
`RuntimeProcessGate`; frames go through `routeAgentManagerFrame`, so they are
persisted and acked like the driver's), on the shared per-agent client
sequence:

- start admission: capability wait, `startRefusal` (a refusal is handed to the
  legacy host to decide and show), `openProcess` before the process;
- `agent:process_spawned` at commit (own launch + `supersededLaunchIds`),
  `agent:start:outcome` `rebound` for a start carried by the running session
  (after its own `startRefusal`/`openProcess`), `not_spawned: cancelled` for a
  start stopped before it ran, `agent:process_exited` at every end;
- E2 `turn_completed` for a completed root turn with model output and no
  failure, with the catch-up batch echo on the batch's turn;
- E1 `terminal_failure` by OAR's typed failure class: `input_too_large` and
  `model_unavailable` as `sticky_runtime_error`; the session then ends.
  Reconciler step 12 (stickyFailureRecords.ts, both hosts): no terminal
  record. `input_too_large` starts the agent again here on a new session with
  the held deliveries (`agent:session:invalidate` reason `input_too_large`),
  once: the same failure before a turn of the new session completes is
  reported as the start failure `session_needs_reset`. `model_unavailable`
  is reported at once as `model_unsupported` (`runtime_spawn_failed` to a
  server without SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1), and the
  runtime and model are recorded until the model or the credentials change,
  model output, or a person's stop. The crash-streak cap reports
  `runtime_repeated_failure` the same way. Other failures show an error and
  the session stays wakeable.
- Invalid credentials (#proj-raft-computer:#46, reconciler step 4a): `auth`
  (`user_reauth`), `billing`, and an `unknown` failure whose text says the
  plan lacks the model (`user_model_access`, for that model only) make the
  agent's credential invalid, not the session broken. They are recorded on
  the credential in the same ledger as provider limits (`recordInvalid`); the
  session is kept, no E1, the error activity says what to do, and every agent
  the record applies to, on either host, holds its deliveries
  (`held_for_credential_invalid`) until it is released: a credentials change
  for the runtime (a web login: a shared sign-in only; or, reconciler step 15,
  its credential source changing on disk, `credentialDiskWatch.ts`, for shared
  and own credentials, in-memory fingerprints only; for a server pause no held
  record knows of, after a restart, the same watch over the shared homes sends
  `machine:runtime_credentials:changed` once a fresh status reads the runtime
  signed in, docs/contracts/runtime-auth.md §5), model output from a turn on it
  started after the record, an explicit stop of an agent on it (the Retry),
  or, for `user_model_access` on an agent's own credential, a start with
  another model. A credentials-change release that now signs in as another
  provider account (Codex `auth.json` `tokens.account_id`, Claude
  `.claude.json` `oauthAccount.accountUuid`, compared with the account at the
  session's start; or unreadable while it was known) does not hand the held
  deliveries to the session: it drifts (`credential_account`), ends once idle
  and starts again on the same session with them
  (`daemon.agent.credential_account.restart`). The legacy host does the same (no SIGTERM, restart snapshot
  kept). A legacy process that closes cleanly while the record holds waits in
  the credential cooldown, which tries the credential once from its held
  deliveries after an hour; when the daemon closed it itself (a runtime
  spec restart, a cold-idle stop: reconciler steps 6, 7 and 8b) that hour only
  renews the hold (`daemon.agent.credential_invalid.hold_renewed`), as the
  live process would have held. An agent held for a record it did not see itself (another agent on
  its shared sign-in, on either host, reported it; or it started while the
  record holds) shows why as its idle status: the reporting agent's copy plus
  "(Reported by another agent on the same sign-in.)", once per record, at
  once when idle, else with its next idle status
  (`daemon.agent.credential_invalid.notice`). It is an `idle` frame with no
  `runtimeError`: a `runtime_error` frame, even without the carrier, would be
  stored as the agent's runtime error on the server, which then drops the
  release's idle frame, and a `requiredAction` (or an `AuthError` class) would
  put a login-only wake block on the agent. On release an idle agent shows its
  usual idle status again ("Idle"; "Process idle" on the legacy host).
  Step 4b (#proj-raft-computer:#48): the held notice's frame also carries the
  reason typed, `credentialHold: { reason }` (`user_reauth`,
  `user_model_access`, `billing`), and so does every frame that re-states it
  (probe reply, heartbeat, diagnostic, released turn); any other frame omits
  it, so the latest frame is the state. The server passes it through to the
  web, which names the reason instead of Online and offers Retry (the manual
  restart). An older daemon sends none: the web shows Online, as before.
- Credential restored (#proj-raft-computer:#48, reconciler step 4b): the
  ledger keeps, with each invalid record, the agents that showed it (the
  reporting agent's own error, the held notice; moved to a record that
  supersedes it). On release each host sends `agent:credential:restored`
  (agentId, the `reason` the agent showed, `releaseCause`) for its own such
  agents, live or closed (`daemon.agent.credential_invalid.restored_reported`);
  agents that never showed it are not reported. The server lifts only an
  automatic-wake block that reason fixes (`user_reauth` also lifts a start's
  `runtime_login_required`). The connection holds it until `ready`
  and replays it in order with the agent's status and activity (one per agent
  and reason). A daemon restart loses the records: those blocks lift only on
  a login or a person's start, as with an older daemon.
- Provider limits (#proj-raft-computer:#46, design row C6): `quota`
  (`quota_exhausted`, until OAR's `resetsAt` when it reports a future one),
  `rate_limited` and `overloaded` (`transient_rate_limit`), and an `unknown`
  failure whose text says the usage limit is reached (`quota_exhausted`), are
  recorded on the agent's credential (`shared:<runtime>` or `agent:<id>`) in
  the `ProviderLimitLedger` the legacy host owns and lends to this host
  (`providerLimitLedger.ts`). The wait is the legacy host's: a reported reset,
  else its exponential delivery backoff, at most 1 h. While it runs, every
  agent on that credential, on either host, holds its deliveries (custody kept,
  `daemon.agent.oar.delivery` `held_for_provider_limit`); a start opens and
  reports its session as usual and holds its first input the same way. The
  session is not ended. A shorter limit never cuts a longer one still running
  on the same credential (the ledger keeps the later end). The wait's end, or a release on
  either host (credentials change for the runtime, real model output from a
  turn started after the limit was recorded, an explicit stop), hands the held
  deliveries over.
- A start carrying an RFC 071 recovery grant (an admitted human start) runs on
  the legacy host (`recovery_grant`): the grant is spent at its spawn gate. A
  rebind onto a running OAR session spends it at the OAR host's rebind gate.

Not replicated: the legacy runtime-error fingerprint fence (E1
`fingerprint_fence` after repeated identical errors) and the runtime-error
delivery backoff for errors that are not provider limits. An OAR-hosted agent
whose turns keep failing the same way (other than a provider limit) keeps
taking deliveries; crash loops are still seen through
`process_exited`/status exits.

## What falls back to the legacy host (`supports()`)

| Reason | Why |
| --- | --- |
| `runtime_not_hosted:<runtime>` | Of the runtimes with a legacy driver, only antigravity, codex, cursor and grok have an OAR launch. |
| `platform_unsupported` | Windows: every runtime but Codex (each needs its driver's Windows launch resolution checked). Cursor: any platform but Linux. |
| `grok_cli_not_verified` | Grok: the Grok slot runs something other than Grok Build 1.0.70 or later. |
| `cursor_sdk_unavailable` | Cursor: this daemon cannot run the Cursor SDK's child (SEA build, Node older than 22.13, or `@cursor/sdk` not installed). |
| `cursor_sdk_signed_out` | Cursor, at the launch (`fallback`, before anything opened): the SDK has no sign-in of its own. Silent to the user. |
| `cursor_sdk_status_unknown` | Cursor, at the launch: the SDK's sign-in could not be read. Handed back only when the agent has no SDK session; otherwise the start fails (`oar_kept_failed`). |
| `runtime_profile_control` / `runtime_profile_message` | Deprecated runtime-profile migrations are completed by the legacy host. |
| `recovery_grant` | See RFC 071 above. |
| `legacy_holds_agent` | The legacy host has a process or a start for the agent. |

## Legacy features on the OAR host

| Feature | OAR host |
| --- | --- |
| View Context | Same service, on the legacy host's manager: this host reports each session (`deps.contextView`), and the launch's proxy reports sends with no Local Inbox coordinator (`agentCredentialProxyMessageCommitted`). After a session ends the manager keeps its last config and session, so its messages can still be viewed; a daemon restart loses that until the next start. |
| Skills list | **Partly.** `listSkills` doesn't read a hosted session's config: an agent with its own `CODEX_HOME` lists the default home's global skills. |
| First input (start ladder) | Same code (`startupInput.ts`). |
| Wake session recycling and constructed briefing | Same code. |
| Startup MEMORY.md block | Same code. |
| Standing prompt and its refresh on resume (task #13) | Same builder, ledger hash and session binding (`standingPromptSessionBinding`). |
| Thread-join context in first inputs and deliveries | Rendered once per thread target per agent, tracked by the OAR host (the legacy host uses its visible-message boundary). |
| Held server context (task #26) | Written ahead of the next input of each session that has not had it. |
| Activity and turn summaries (task #17) | Same activity shapes and `TurnSummaryTracker`; heartbeat and probe replies. |
| Tool rows | OAR's `classifyTool` names a command, a file read or edit and a search the same way on every runtime (`oarActivity.ts`); anything else keeps the runtime's own name. Codex keeps its reader for one `file_change` row per file with its kind. |
| Stall report and recovery (row C15, reconciler step 9) | The report: OAR `observeStalls` at the stall threshold (15 min). Stalled with deliveries held: ended and started again on its session with them, the legacy rule on OAR's facts (above). |
| App-inbox notices | Same notice text, once per item, `requireIdle` honoured. |
| Working → Idle hook (built-in apps: MEMORY.md cleaner, idle task reminder) | Yes: after a completed or interrupted turn that ended with nothing held (a held delivery opens the next turn; its end is the edge). |
| Idle task reminder notice | Handed over as it is, only into an idle session with nothing held; never kept. Its running sub-agents count as background tasks, as they do for the OAR cold-idle stop. |
| Tooling and instruction shape (`oarCodexTraces.ts`) | Codex on OAR records `daemon.runtime.tooling.exposure` when the launch commits and when the managed MCP server settles, and `daemon.codex.request_instruction_shape` at that commit, around each compaction and at the next request, as the legacy driver does, from the launch's options: OAR doesn't show the request it sent. |
| Sub-agents (`oarTaskActivity.ts`) | An OAR task of type `agent` makes a Sub-agents `system` row, whichever session reports it, and the frame restates the agent's own status. Stop goes through `Session.stopTask` (Claude, Codex, Qoder; Grok and Qwen answer `unsupported`); accepted ends nothing, the row ends on `task_ended`, or on Codex on the child's aborted turn after a person asked. On a runtime that only queues sub-agent results for its next turn (`needsWakeAfterSubagents`: Codex), the last sub-agent's end while the main turn is over wakes the agent with the sub-agents-finished input as a host-written delivery, if any sub-agent ended on its own since the turn ended, as on the legacy host (`daemon.runtime.subagent.finished_wake`, `host: "oar"`: `written`, or skipped `stopped_by_user`, `stopping`, `not_deliverable`, `turn_stopped`, `messages_pending`, `blocked`; `write_failed`). Not done: the status line doesn't count running tasks, as on the legacy host. |
| Silent background tasks (`backgroundTaskHealth.ts`) and long idle holds (`agentIdleHold.ts`) | Legacy host only. Its 10-minute sweep presumes a background task ended after an hour with no event naming it (its lifecycle envelopes, or its sub-agent's own rows matched by task id or by the one task of their call), unless the runtime's process tree is unreadable or holds a process started since the task did (Linux /proc, elsewhere `ps lstart`; an unknown start counts as the task's) (`daemon.runtime.background_task.presumed_ended`, `removed` true or false); a runtime spec restart (gate `spec_restart`), a cold-idle stop of a process past the cold gap (gate `cold_idle`) or pi rotation held 30 minutes by the same reason is traced (`daemon.agent.idle_hold_long`). The OAR host counts no background tasks (0), so nothing is held by one; its spec restart held 30 minutes is traced the same way (`host: "oar"`). |
| Server features (`server:features`, reconciler step 6) | Yes: the router hands every answer to both hosts. A committed session that started on values its runtime renders differently (`serverFeaturesDrift`; `agentContextView` never counts) is ended once it is idle (`reconcileSpec`, `agentNotIdleReason` from OAR's facts: the session's status is `idle`, nothing held or being handed over, no background tasks; never `queuedInputPending`, since nothing is written into a running turn behind OAR's status), with no status or activity, the way a stop that keeps the session ends it; the next delivery finds no process and the Server's next start carries the new values. Decided again at its turn end, when held deliveries are gone, and by a sweep that runs only while a session is held (`daemon.agent.spec_restart_stop`, `drift: "features"`, names the `trigger`). No "what changed" notice at the next start (the legacy host's `formatServerFeaturesNotice`), and no config is rewritten here. |
| Runtime spec (reconciler step 7, `runtimeSpec.ts`) | Same rule as the legacy host, one entry (`reconcileSpec`, also the server features above). A rebind of a committed session replaces its request's config; a session whose launch's `runtimeConfig` differs from it on a whitelisted component (`runtime`, `model`, `runtime_config`: mode and reasoning effort, `env`, `provider`: provider and connection id and the Claude command, `execution_mode`; compared after `hydrateRuntimeConfig`, canonical JSON hashed, empty values and key order aside) is ended once idle, decided after the rebind's wake is held (so that wake's turn runs first). Anything else (prompt inputs, runtime context, credentials, a field added later) never ends a session. `daemon.agent.spec_restart_stop` carries `drift` (kinds only, never an env var's name or value), `trigger` and `host`. A session that started on another runtime, or a Codex session on another model, is not resumed by the next start on either host (`SessionSpecMemory`, shared, memory only; `daemon.agent.session_dropped_for_spec` with the `reason`). The runtime profile reports the launch's own config (`hostedSession`). |
| Config push (`agent:config`, reconciler step 11, `DAEMON_CAPABILITY_AGENT_CONFIG_PUSH`) | Yes: the router hands it to the host that owns the agent. The core orders pushes first (`agentConfigRevisions.ts`: a push at or below the last applied revision, an `agent:start` `configRevision` included, is dropped). One rule for every config: none replaces a newer one. A start whose `configRevision` is older than the applied one still rebinds its launch, session and wake on either host, but the running config stays (an equal revision, or a start with none from an older server, replaces it as before); the latest push is kept for the next registration, so a stale start that registers a new process gets it applied. The session's request takes the config, keeping its session and runner credential, and the step 7 entry decides it: drift ends it once idle; the optional components `managed_mcp` and `provider_connection` count only when both sides carry them. A push never wakes, rebinds a launch or reports a status; a rebind with a wake keeps the session busy until that wake's turn ends, a push only waits for the current turn and held deliveries. A push that arrives before a host registered the agent is held (shared with the legacy host) and applied at registration only if newer than that start (a start with no revision drops it); one naming another runtime before the launch is planned waits for the plan and is then drift. As every spec stop here, nothing starts the agent again on this host: the next delivery finds no agent and the server's start runs on the new config; the legacy host does the same for a spec stop whose config names another runtime or host (`specChangeNeedsServerStart`): it releases the process at once (a silent stop: no restart snapshot, the next start waits for its exit), so a delivery during the stop's grace is refused to the server (a tracked mention ends `IDENTITY_UNKNOWN` and the server redelivers it untracked) and never restarts it on the legacy host. On the legacy host a config naming another runtime than the process runs does not wait for idle: the runtime binding fence refuses that process's input and output from then on (`runtime_mismatch`, its turn end included), so it is stopped at once, busy or not (a per-turn process too). A start naming another runtime is never rebound onto the running process, whichever path takes it (a start while running, a queued or deferred one, one that arrives while the old process registers): it stops the process and starts its own runtime after that exit, with its wake (`daemon.agent.start.replaces_process`). A turn the stopped process was running is lost, as at a person's stop: messages it had not read stay unread on the server; ones it had already taken are not delivered again. Neither host reports a session its config drops (a Codex model or runtime change, `reportableSessionId`). |
| Third-party event delivered reports | Through the CLI transport proxy, as on the driver. |
| Session transcripts / runtime profile reports | Read by the process manager through `setHostedSessions` (grok's own session files). Reports are sent at the commit (`session_init`) and after an explicit stop (`stop`), built by the process manager; not at turn ends (the legacy host reports there only when the session id changed). Runtime artifacts: the grok driver writes none. |
| First-turn end report (`agent:turn:ended`) | Yes. |
| Session summary for a fresh session's briefing (#wg-ax task #3) | OAR host only: `<raft home>/agent-session-summaries/<agentId>.json` (daemon state, never the agent's workspace, where a planted symlink could redirect the write; not carried by migration, it is a cache), folded from the session's OAR records and rewritten when a prompt is accepted (turn start), at each root turn end and at release. Rolling windows across sessions (last 25 messages, 40 actions, 14 files, each tagged with its session); context size, turn and compaction counts and the wake input reset per session; plus the latest turn's final model text, the last 2 turns' latest text (`notes`, kept past a tool call) and the latest todo / plan list (`todos`: Codex `turn/plan/updated`, ACP `plan` updates, `TodoWrite` / `update_plan` calls), both optional fields an older file lacks. No file contents, no tool output except raft reader output. Read by the fresh-session decision (`planWakeSessionRecycle`, facts from `sessionSummaryResumeFacts`; unknown while the latest turn has not ended) and the briefing (`buildConstructedPanelFromSummary`: the transcript build's sections plus the dated last note), but only for runtimes in `WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES` (Codex, Grok) and only while the Server's `wake_recycle_oar` is on for the agent (`summaryFactsRuntimesFor`); off, the summary is never read for a decision. |
| Daemon Local Inbox / freshness hold | Not wired: `raft message check` and sends of an OAR-hosted agent go to the server (the proxy's server path). |
| In-daemon crash respawn, idle cold start, deferred spawn | No: the server's next start. The one restart of its own: a stall replacement (reconciler step 9). |
| Daemon start queue (concurrency / rate limit) | No: OAR starts are not queued. |
| Stop kills what the turn started (`turn_interrupt.tree_kill`) | Codex: OAR's `endTurnProcessesOnAbort` (OAR 0.88.0) ends the processes the aborted turn started, keeping ones that ran before the prompt; nothing on Windows: OAR interrupts the turn in place and the turn's commands keep running. The driver sends no `turn/interrupt` on Windows, so its Stop restarts the app-server instead, and its turn tree kill selects nothing there: on neither host does Raft end the turn's commands on Windows. Grok (OAR 0.99): the same option ends the ACP terminals the aborted turn created, keeping ones from before the prompt; from OAR 0.100 only once that turn has closed and grok accepted the abort, and a closed turn's terminal list is dropped, so a long session no longer accumulates them (no Raft change). The Stop is complete only at OAR's `cleanup` response on the abort request, traced as `daemon.agent.turn_interrupt.cleanup` (outcome, `signalled`). Other OAR runtimes: no. |
| Turn span (`daemon.runtime.turn`, `oarTurnTrace.ts`) | One per turn, `host: "oar"`: opened at a prompt's `turn_started` (or, with none open, at model work, as the legacy host does), ended once with the legacy outcome values and counters (`runtimeCommunicationTrace.ts`, the same event cap). Tool calls, text, thinking and compaction are counted from the activity facts; Raft sends from the proxy's send outcome; tokens from OAR's `usage` running totals (Codex: its token telemetry, as on the legacy driver). A completed turn is `turn-completed`, a failed one `runtime-error`, an interrupt `turn-interrupted` (the legacy host reports that as `turn-completed`), an exit that cut the turn `process-exit`/`process-crash` by the exit plan (a cut turn whose exit does not come within 5 s, or before the next turn's model work, is `turn-interrupted`), a stop `process-exit` (`cancelled`, `expectedTerminationReason`), a stall replacement `runtime-stalled`, a rejected prompt `runtime-start-failed`. Sub-agents' events are not counted. |
| Codex telemetry | The Codex reader maps native `thread/tokenUsage/updated` and `account/rateLimits/updated` frames through the legacy `parseCodexTelemetryEvent`, to the same `daemon.runtime.telemetry.*` events with `host: "oar"`. Token totals stay codex's session totals, not OAR's count net of the resume baseline. A completed turn that showed text with no tool call records `daemon.runtime.turn.communication_gap`, with the legacy identity attrs. Trace only. Rates aren't fully comparable across hosts: legacy also records interrupted and failed turns, OAR counts a `sleep` item as a tool call, and its text and thinking counts are coalesced chunks. The tooling and instruction-shape traces aren't ported yet. |
| OOM preference | On Linux the launch command becomes a script (`oarOomPreference.ts`, under `<raft home>/oar-launch`) that raises `oom_score_adj` to 500 and execs the runtime: same pid, set before the runtime starts, only ever raising. No OAR option: the host chooses the command. OAR gives the ACP terminal commands it starts for a runtime (e.g. Grok's) the same score, from 0.90. Through `/bin/sh`, inherited environment variables whose names aren't identifiers can be dropped (dash does; e.g. `BASH_FUNC_x%%`). |
| Provider reconnect | OAR 0.89 reports a Codex reconnect as `retry` from the native `error` notification with `willRetry`, so no stderr is needed. It shows the legacy "Codex reconnecting to provider…" activity and `daemon.agent.provider_reconnect`. |
| Bounded record memory | Every OAR launch is opened with `retainedBytes` (`OAR_RETAINED_BYTES`, 4 MiB per session): older frames keep kind, `seq`, usage and text and lose their payloads. Raft reads records live, and stored ones only for the exit code. |

## Known differences from the legacy grok driver

What the agent and the machine see differently on the OAR host, beyond the
fallbacks above:

- **Terminal commands.** OAR offers grok the ACP client terminal
  (`clientCapabilities.terminal: true`) and runs the commands grok asks for
  itself, as children of the daemon with the launch environment; the driver
  offers none and grok runs them in its own process. A stop must clean
  them up (OAR's terminal host).
- **Busy deliveries** wait for the turn end (above); the driver interjects.
- **Effort** goes through grok's `thought_level` config option, read back by
  OAR; the driver sends it with `session/set_model`. A grok without that
  option fails the open, and the start runs on the driver.
- **Standing prompt** rides grok's `initialize` `_meta.systemPromptOverride`
  (OAR); the driver puts it in `session/new` / `session/load` `_meta`.
- **Tool names** in activity are OAR's reading (the ACP `title`); the driver
  prefers grok's `_meta["x.ai/tool"].name`.
- Not on the OAR host: the startup watchdog, stuck-tool detection
  (task #25), provider-request status, tracked-mention "told at start"
  bookkeeping (task #9), passive-AX context generations across a recycle
  (glimpse G0), the runtime-error fingerprint fence and delivery backoff.

## Files

- `agentLifecycleHost.ts`: the lifecycle surface and the start request.
- `agentHostRouter.ts`: per-agent routing and the fallback hand-over.
- `oarAgentHost.ts`: start, commit, rebind, delivery, stop, exit, RFC 071
  frames, `supports()`, `OAR_LAUNCHES`.
- `oarLaunch.ts`: what one OAR launch is (`OarLaunch`, `PrepareOarLaunch`).
- `oarGrokLaunch.ts`: grok's launch from the driver's `prepareGrokLaunch`.
- `oarCursorLaunch.ts`: cursor's launch (the SDK in OAR's child per session, its clean environment; #oar-raft:#10).
- `oarActivity.ts`: OAR event to Raft activity fact (pure).
- `oarSessionSummary.ts`: OAR records to the agent's session summary on disk.

OAR is loaded lazily (`oarLoader.ts`: `@botiverse/oar/runtimes/grok` and
`@botiverse/oar/observe`, never the root entry); a daemon that runs no
OAR-hosted agent loads neither.

## Adding a runtime

1. An `OarLaunch` builder from the legacy driver's own launch preparation
   (export it through `drivers/index`, as `prepareGrokLaunch`), with the
   runtime's `busyDelivery`, and an entry in `OAR_LAUNCHES`.
2. Its loader in `oarLoader.ts` (`OarLaunch.runtimeId`).
3. For a runtime that also has a legacy driver, its flag in
   `AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS` (server) chooses the OAR host per
   server. An OAR-only runtime needs none.
4. Check what its OAR adapter refuses (`refusedSessionOptions`: e.g. kimi and
   opencode v2 refuse `systemPrompt`) and how its session ids resume across
   hosts; add `supports()` reasons for what it cannot run.

## Tests

- `oarAgentHost.exitPlan.test.ts`: step 10b, the `PLAN_EXIT_CASES` parity on
  real OAR exits, and the acts (restart now with the held work, after the
  backoff, a server start during it, a 30 min outage never handed off, the
  cap's hand-off, a resume failure's new session, stops, the server fallback).
- `oarAgentHost.stalledWithWork.test.ts`: step 9's stall replacement.
- `oarAgentHost.test.ts`: the host on OAR's `scriptedRuntime` (first input,
  frames and order, fallbacks, deliveries: custody acks, busy ones held to
  the turn end, re-sends of a transient and of a mention, rebind, exit, stop
  and its order, waiting stops and `stopAll` over an unwind, E1, server
  context, standing-prompt refresh).
- `oarGrokResume.test.ts`: the legacy grok driver and OAR's real grok runtime
  against one fake grok (session id compatibility; a refused resume never opens
  a fresh session).
- `oarCodexResume.test.ts`: the legacy codex driver and OAR's real codex
  runtime against one fake `codex app-server`: a thread either host started
  resumes on the other with the same thread facts (cwd, model, approvals, the
  standing prompt as developer instructions, never base instructions), fast
  mode opens with codex's own `priority`, and an unknown thread is handed back.
- `agentHostRouter.test.ts`, `oarActivity.test.ts`, `oarGrokLaunch.test.ts`, `oarCodexLaunch.test.ts`.
- `oarCursorLaunch.test.ts`, `oarAgentHost.cursor.test.ts`: Cursor's launch
  options, the child's environment (no daemon-only variables; the agent's env
  vars, identity and `raft` on PATH), the sign-in read's environment, the
  capability rule, session ownership by host, the CLI-session move, an SDK
  session that cannot be resumed, the `supports()` and sign-in hand-backs,
  steer.
- `core.test.ts` ("RFC 060"): the capability in `ready`, and an OAR-hosted
  grok start through the real core, process manager and outbox.
- Server: `agentOrchestrator.runtimeHost.test.ts` (flag and capability gate).
