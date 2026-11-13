/**
 * `raft-computer` — standalone Computer control-plane CLI (RFC v0.8
 * contract v4 §1/§2/§6). DISTINCT entrypoint from the agent-facing
 * `slock` (@slock-ai/cli) — package boundary enforced by
 * scripts/check-boundaries.mjs (#1573 lesson).
 *
 * Contract v4 §1 identity: a Computer IS one real machine / one
 * effective SLOCK_HOME. It manages N independent per-server attachments
 * + per-server daemon children, all under one service.
 *
 * MVP control-plane surface (§6):
 *   login                              kept for old scripts: runs attach's approval
 *   logout                             kept for old scripts: changes nothing
 *   attach <serverSlug>                add-not-replace per-server attach (one-time approval)
 *   start [serverSlug]                 ensure service + per-server daemons
 *   stop                               stop the service + managed daemons
 *   status                             aggregate Computer view
 *   detach <serverSlug>                revoke this machine's key there, then forget it
 *   doctor                             per-server health + login + service
 *   logs   [serverSlug | --service]
 *   runners list   [serverSlug]
 *   runners stop <agentId> [serverSlug]
 *
 * Lifecycle contract (task #151 P0):
 *   Axis 1: process actual state       service + per-server runner pids
 *   Axis 2: local desired policy       managed.flag / future enable state
 *   Axis 3: local credential proof     runner.state.json + sk_computer_*
 *   Axis 4: server identity            computers row + linked machines.id
 *
 * V0 ordinary CLI verbs MUST NOT mutate axes 3/4 except attach/setup when
 * they are explicitly creating or proof-resuming an attachment. Names are
 * display labels only, never identity proof: an already-attached server is
 * idempotent from local state, and missing local state means fresh attach
 * unless an explicit proof flow (daemon migration, future recover/rebind,
 * admin-confirmed recovery) says otherwise. The old user-facing `detach`
 * command and implementation are intentionally absent; local disconnect and
 * destructive revoke/delete are not part of the ordinary V0 CLI surface.
 * `detach <serverSlug>` (device-auth design §3.2) is not that command back:
 * it is an explicit, confirmed revoke on the server first (axis 4), and only
 * after the server confirms does it delete the local credential (axis 3), so
 * a live server key is never left without its local holder (detach.ts).
 *
 * Verb-to-axis table:
 *   start/stop [serverSlug]            axis 1 only
 *   setup/attach <serverSlug>          axis 3 create/proof-resume only
 *   detach <serverSlug>                axis 4 revoke, then axis 3 delete (confirmed)
 *   future enable/disable <serverSlug> axis 2 only
 *   service start/stop                 machine-scope axis 1 only
 *
 * Hidden internal modes (re-execed by `start`, not user-facing):
 *   __service                        the long-running service process
 *   __run <serverId>                   one per-server daemon child
 */
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Command } from "commander";

import { runLogin, runLogout } from "./login";
import { runAttach, runAttachWithTokenFromStdin } from "./attach";
import { readMachineTurnActivity } from "./turnActivity";
import { parseForceUnbindIds, runDetach } from "./detach";
import { runSetup } from "./setup";
import { formatStatusReport, printProcJobsStatus } from "./status";
import { runRunnersList, runRunnersStop } from "./runners";
import { noteStartNeverRan, runStart, runStop, startAcceptsPartialReady, startNotesUpgradeStep, startWaitForCaller } from "./startStop";
import { runResident, runService, isSeaBinary, RESIDENT_CLI_PATH_ENV_VAR } from "./service";
import { runDoctor, runDoctorJson, runDoctorMigrationDetails } from "./doctorCli";
import { runLogs } from "./logs";
import { CliExit, info, fail, present } from "./output";
import { createComputerApi } from "./lib/api";
import { createComputerTracer } from "./lib/computerTracer";
import { COMPUTER_CLI_ATTACH_TOKEN_STDIN_FLAG, COMPUTER_CLI_CAPABILITIES, currentDate, currentTimeMs, type Tracer } from "@botiverse/raft-shared";
import { withMutationLock } from "./concurrency";
import { runChannelShow, runChannelSet, runChannelVersions } from "./channel";
import { installerArgs, runInstallerAttended, scrubInstallerOperationEnv } from "./externalInstaller";
import { parseChannel, readChannel, SEMVER_RE } from "./lib/channelState";
import {
  resolveUpgradeBaseUrl,
} from "./computerRelease";
import { ComputerServiceError } from "./services/errors";
import { formatCliFatalError } from "./networkError";
import { deriveDefaultComputerName, resolveRaftHome } from "./paths";
import { approvalOsLabel } from "./services/attachGrant";
import { hostname as osHostname } from "node:os";
import { resolveTargetServerId } from "./targetServer";
import { DEFAULT_SLOCK_SERVER_URL } from "./serverUrl";
import { BUNDLED_CLI_VERSION, BUNDLED_DAEMON_VERSION, COMPUTER_VERSION } from "./version";
import { listAttachedServerIds, setServerManaged } from "./serverState";
import { prepareLocalLifecycleOperations, type PreparedLocalLifecycleOperation } from "./localLifecycleIntents";
import type { RestartServiceParams } from "./lib/types";
import { migrateLegacyOsSupervisorInstall } from "./legacyOsSupervisorMigration";
import { findLiveServicePidReadOnly } from "./internal/service-pid-fallback";
import { isDegraded } from "./health";
import { resetRunner } from "./reset";
import { isServiceConnectionLoss, requestServiceRestartViaIpc } from "./serviceControl";
import { callerIsRunnerHosted } from "./restartReadiness";
import { connectService } from "./lib/ipc-client";
import { removeServiceAddedMallocEnv } from "./runnerChildEnv";

function withCliExit<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof CliExit) {
        process.exitCode = err.exitCode;
        return;
      }
      throw err;
    }
  };
}

function resolveUpgradeTrigger(raw: string | undefined): "cli" | "tray" {
  return raw === "tray" ? raw : "cli";
}

function presentUpgradeTargetResolutionFailure(error: ComputerServiceError): never {
  const messages: Record<string, string> = {
    K_SOURCE_DEVICE_ID_INVALID: "Could not resolve the stable release identity for this OS user.",
    K_SOURCE_TARGET_UNSUPPORTED: "Hands has no compatible Computer package for this platform and architecture.",
    K_SOURCE_VERSION_UNAVAILABLE: "Hands did not authorize the requested exact Computer version.",
    K_SOURCE_IDENTITY_DRIFT: "Hands returned an inconsistent Computer candidate; no upgrade was started.",
    K_SOURCE_BACKEND_INVALID: "The configured Computer release backend is invalid.",
  };
  fail(
    error.code,
    messages[error.code] ?? "Could not resolve a Computer release from the configured authority; no upgrade was started.",
  );
}

/**
 * Resolve the CLI-side tracer for single-writer upgrade routing.
 * `source: "computer.cli"` attributes every span to this process.
 * Env-gated to mirror the daemon: local tracing is ON by default; set
 * `RAFT_COMPUTER_LOCAL_TRACE=0` to disable.
 * Tracing setup is never allowed
 * to break a command — any failure falls back to `noopTracer`.
 */
function resolveCliTracer(slockHome: string): Tracer {
  return createComputerTracer(slockHome, "computer.cli");
}

// Shared CLI description constants (anti-drift). One canonical sentence
// per recurring concept so two subcommands can never word the same option
// differently. Command-specific behavior notes are appended at the
// callsite, but the boilerplate (slug format / foreground) comes from here.
const FOREGROUND_DESC = "run the service in this terminal instead of the background";
const SERVER_SLUG_TARGET_DESC =
  "target Raft server slug (canonical form `/myserver`; bare `myserver` accepted)";
const SERVER_SLUG_OPTIONAL_DESC =
  "optional: scope to one attached server (canonical `/myserver`; bare accepted; default: all attached)";
const SERVER_URL_ENV_DESC = `SLOCK_SERVER_URL/RAFT_SERVER_URL or ${DEFAULT_SLOCK_SERVER_URL}`;
const RELEASE_CHANNEL_DESC =
  "`latest` installs production releases; `alpha` follows staging builds; `pinned:<semver>` stays on one version; "
  + "a named channel (lowercase letters, digits, hyphens, e.g. `constructed-wake-context`) follows one feature branch's builds";
const UPGRADE_DESC =
  "Update Raft Computer to the latest version for this machine. " +
  "By default it follows the saved release channel; pass --target-version to install a specific version.";

async function prepareRestartTargetsForServiceHandoff(
  slockHome: string,
  serverIds: string[],
  signal: AbortSignal,
): Promise<void> {
  const nowMs = currentTimeMs();
  for (const serverId of serverIds) {
    signal.throwIfAborted();
    await setServerManaged(slockHome, serverId);
    signal.throwIfAborted();
    if (await isDegraded(slockHome, serverId, nowMs)) {
      await resetRunner(slockHome, serverId);
    }
  }
}

export interface RestartCommandDeps {
  resolveRaftHome?: typeof resolveRaftHome;
  resolveTargetServerId?: typeof resolveTargetServerId;
  listAttachedServerIds?: typeof listAttachedServerIds;
  prepareLocalLifecycleOperations?: typeof prepareLocalLifecycleOperations;
  findLiveServicePidReadOnly?: typeof findLiveServicePidReadOnly;
  runStart?: typeof runStart;
  runStop?: typeof runStop;
  prepareTargetsForServiceHandoff?: typeof prepareRestartTargetsForServiceHandoff;
  requestServiceRestartViaIpc?: typeof requestServiceRestartViaIpc;
  callerIsRunnerHosted?: typeof callerIsRunnerHosted;
  info?: typeof info;
  fail?: typeof fail;
}

interface RestartCommandRuntime {
  resolveHome: typeof resolveRaftHome;
  resolveServer: typeof resolveTargetServerId;
  listAttached: typeof listAttachedServerIds;
  prepareLifecycle: typeof prepareLocalLifecycleOperations;
  findLiveService: typeof findLiveServicePidReadOnly;
  start: typeof runStart;
  stop: typeof runStop;
  prepareTargets: typeof prepareRestartTargetsForServiceHandoff;
  requestRestart: typeof requestServiceRestartViaIpc;
  callerRunnerHosted: typeof callerIsRunnerHosted;
  emitInfo: typeof info;
  emitFail: typeof fail;
}

interface RestartTargetPlan {
  slockHome: string;
  serverId: string | null;
  serverLabel: string | null;
  targets: string[];
}

function resolveRestartRuntime(deps: RestartCommandDeps): RestartCommandRuntime {
  return {
    resolveHome: deps.resolveRaftHome ?? resolveRaftHome,
    resolveServer: deps.resolveTargetServerId ?? resolveTargetServerId,
    listAttached: deps.listAttachedServerIds ?? listAttachedServerIds,
    prepareLifecycle: deps.prepareLocalLifecycleOperations ?? prepareLocalLifecycleOperations,
    findLiveService: deps.findLiveServicePidReadOnly ?? findLiveServicePidReadOnly,
    start: deps.runStart ?? runStart,
    stop: deps.runStop ?? runStop,
    prepareTargets: deps.prepareTargetsForServiceHandoff ?? prepareRestartTargetsForServiceHandoff,
    requestRestart: deps.requestServiceRestartViaIpc ?? requestServiceRestartViaIpc,
    callerRunnerHosted: deps.callerIsRunnerHosted ?? callerIsRunnerHosted,
    emitInfo: deps.info ?? info,
    emitFail: deps.fail ?? fail,
  };
}

async function resolveRestartTargetPlan(
  serverSlug: string | undefined,
  runtime: Pick<RestartCommandRuntime, "resolveHome" | "resolveServer" | "listAttached">,
): Promise<RestartTargetPlan> {
  const slockHome = runtime.resolveHome();
  const serverId = serverSlug ? await runtime.resolveServer({ server: serverSlug }) : null;
  const targets = serverId ? [serverId] : await runtime.listAttached(slockHome);
  return {
    slockHome,
    serverId,
    serverLabel: serverSlug ?? null,
    targets,
  };
}

async function recordRestartIntent(
  plan: RestartTargetPlan,
  runtime: Pick<RestartCommandRuntime, "prepareLifecycle">,
): Promise<PreparedLocalLifecycleOperation[]> {
  return runtime.prepareLifecycle(plan.slockHome, "restart", plan.targets).catch(() => []);
}

/**
 * Bind the recorded lifecycle operations to the service restart so the
 * replacement service can acknowledge each server's `ready` phase. Without
 * this binding the service wrote no pending-restart marker and the operation
 * stayed pending forever while the Server reported ready_timeout (task #803).
 */
function restartServiceParamsFor(
  prepared: readonly PreparedLocalLifecycleOperation[],
): RestartServiceParams | undefined {
  const [first] = prepared;
  if (!first) return undefined;
  return {
    requestId: first.operationId,
    originServerId: first.serverId,
    requestIds: Object.fromEntries(prepared.map((operation) => [operation.serverId, operation.operationId])),
  };
}

async function runColdBootRestart(
  plan: RestartTargetPlan,
  opts: { foreground?: boolean },
  signal: AbortSignal,
  runtime: Pick<RestartCommandRuntime, "start">,
): Promise<void> {
  await runtime.start(
    {
      foreground: opts.foreground,
      serverId: plan.serverId,
      serverLabel: plan.serverLabel,
      recordLifecycleIntent: false,
      hostLifecycleOwner: "cli",
    },
    { signal },
  );
}

async function requestLiveServiceRestart(
  plan: RestartTargetPlan,
  liveServicePid: number,
  signal: AbortSignal,
  runtime: Pick<
    RestartCommandRuntime,
    "prepareTargets" | "requestRestart" | "emitFail" | "emitInfo"
  >,
  prepared: readonly PreparedLocalLifecycleOperation[] = [],
): Promise<void> {
  await runtime.prepareTargets(plan.slockHome, plan.targets, signal);
  signal.throwIfAborted();

  try {
    await runtime.requestRestart(plan.slockHome, restartServiceParamsFor(prepared));
  } catch (err) {
    // On Windows the service closes this connection to hand its named pipe to
    // the replacement (task #924); the restart is then in progress, not failed.
    if (isServiceConnectionLoss(err)) {
      runtime.emitInfo(
        `Service restart in progress (pid ${liveServicePid}); the service closed this connection to hand over to its replacement. Check with \`raft-computer status\`.`,
      );
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    runtime.emitFail(
      "RESTART_SERVICE_UNREACHABLE",
      `Cannot restart the live Computer service via IPC (${detail}). This command will not send SIGTERM from the caller because the caller may be running under the service being restarted. Run \`raft-computer status\` and inspect \`raft-computer logs --service\`.`,
    );
  }

  runtime.emitInfo(
    `Service restart requested (pid ${liveServicePid}); replacement service will take over without relying on this shell.`,
  );

  // Only an agent-hosted caller reaches this handoff (see runRestartCommand).
  // Restarting tears down the caller's own runner, so the shell may not
  // survive long enough to observe reconnects.
  runtime.emitInfo("Running inside an agent process: not waiting for runners to reconnect. Check with `raft-computer status`.");
}

/**
 * A restart asked for from a person's own terminal is a stop followed by a
 * start from that terminal, exactly what `raft-computer stop` then
 * `raft-computer start` would do. The live-service IPC handoff instead has the
 * old service launch its own replacement, so the replacement inherits whatever
 * launch context the old service had; a user report (task #1202) could only
 * recover with a stop and a start from the new login session. Each half
 * records its own lifecycle step, as the two commands do. A stop that cannot
 * finish (the old service does not exit) fails loudly before anything is
 * started, so the machine is never left with two services.
 */
async function runCallerStopThenStart(
  plan: RestartTargetPlan,
  liveServicePid: number,
  opts: { foreground?: boolean },
  signal: AbortSignal,
  runtime: Pick<RestartCommandRuntime, "stop" | "start" | "emitInfo">,
): Promise<void> {
  runtime.emitInfo(
    `Restarting from this terminal: stopping the service (pid ${liveServicePid}), then starting it again.`,
  );
  await runtime.stop({ signal, hostLifecycleOwner: "cli" });
  signal.throwIfAborted();
  await runtime.start(
    {
      foreground: opts.foreground,
      serverId: plan.serverId,
      serverLabel: plan.serverLabel,
      hostLifecycleOwner: "cli",
    },
    { signal },
  );
}

export async function runRestartCommand(
  serverSlug: string | undefined,
  opts: { foreground?: boolean },
  signal: AbortSignal,
  deps: RestartCommandDeps = {},
): Promise<void> {
  const runtime = resolveRestartRuntime(deps);
  const plan = await resolveRestartTargetPlan(serverSlug, runtime);

  const { pid } = await runtime.findLiveService(plan.slockHome);
  signal.throwIfAborted();

  if (pid !== null && !runtime.callerRunnerHosted()) {
    await runCallerStopThenStart(plan, pid, opts, signal, runtime);
    return;
  }

  // Inside an agent process the service must hand off to its own replacement:
  // stopping it from here would stop the caller's runner with it.
  const prepared = await recordRestartIntent(plan, runtime);
  if (pid === null) {
    await runColdBootRestart(plan, opts, signal, runtime);
    return;
  }

  await requestLiveServiceRestart(plan, pid, signal, runtime, prepared);
}

export const program = new Command();
program
  .name("raft-computer")
  .description("Raft Computer — connect this machine to Raft so agents can run here.")
  .version(COMPUTER_VERSION);

// --- login (kept for old docs/scripts: runs attach's one-time approval) ---
program
  .command("login")
  .description("No longer needed: use `raft-computer attach <server>`. Runs the same approval.")
  .option("--server-url <url>", `Raft API base URL; defaults to ${SERVER_URL_ENV_DESC}`)
  .action(withCliExit(async (opts: { serverUrl?: string }) => {
    await runLogin({ serverUrl: opts.serverUrl });
  }));

// --- logout (kept for old docs/scripts: there is no session to end) ---
program
  .command("logout")
  .description("No longer needed: this machine keeps no sign-in. Changes nothing.")
  .action(withCliExit(async () => {
    await runLogout();
  }));

// --- attach <serverSlug> (add-not-replace) ---
program
  .command("attach")
  .argument("<serverSlug>", SERVER_SLUG_TARGET_DESC)
  .description("Connect this machine to one Raft server.")
  .option("--server-url <url>", `Raft API base URL; defaults to the saved user session, ${SERVER_URL_ENV_DESC}`)
  .option("--name <name>", "Computer display name shown on the approval page; defaults to a sanitized hostname")
  .option("--no-start", "connect without starting Raft Computer")
  .option("--foreground", FOREGROUND_DESC)
  // Raft Desktop: it ran the approval itself (a one-time attach grant) and
  // hands over the single-use `dvat_*` token on stdin, never on argv.
  .option("--server-id <id>", "the server id the attach token was approved for (with --attach-token-stdin)")
  .option(COMPUTER_CLI_ATTACH_TOKEN_STDIN_FLAG, "read a one-time attach token from stdin instead of asking for approval")
  .option("--json", "print the result as one JSON line (with --attach-token-stdin)")
  .action(withCliExit(async (serverSlug: string, opts: { serverUrl?: string; name?: string; start?: boolean; foreground?: boolean; serverId?: string; attachTokenStdin?: boolean; json?: boolean }) => {
    if (opts.attachTokenStdin) {
      await withMutationLock(() =>
        runAttachWithTokenFromStdin({ serverSlug, serverId: opts.serverId, serverUrl: opts.serverUrl, name: opts.name, json: opts.json === true }),
      );
      return;
    }
    await withMutationLock(() =>
      runAttach({ serverSlug, serverUrl: opts.serverUrl, name: opts.name, start: opts.start, foreground: opts.foreground }),
    );
  }));

// --- detach <serverSlug> (device-auth design §3.2) ---
// Revoke this machine's key on one server (and the agent keys it issued),
// then delete its local copy and stop that server's runner. Server first:
// nothing local changes unless the server confirms (detach.ts).
program
  .command("detach")
  .argument("<serverSlug>", SERVER_SLUG_TARGET_DESC)
  .description("Disconnect this machine from one Raft server: revoke its key there, then remove it here.")
  .option("-y, --yes", "skip the confirmation prompt")
  .option(
    "--force-unbind <agentIds>",
    "other people's agents on this machine to unbind and stop with the detach: the ids a refused detach listed, comma-separated",
  )
  .action(withCliExit(async (serverSlug: string, opts: { yes?: boolean; forceUnbind?: string }) => {
    const forceUnbind = parseForceUnbindIds(opts.forceUnbind);
    await withMutationLock(() => runDetach({ serverSlug, yes: opts.yes, forceUnbind }));
  }));

// --- setup <serverSlug> (task #41 PR-J3 — login + attach + start wrapper) ---
//
// RFC v9.8 §X.1 one-prompt migration: when local state shows a legacy
// `@botiverse/raft-daemon` machine install on a TTY, setup prompts the
// operator to migrate before falling back to fresh attach. The
// non-interactive 4-channel CLI flag resolution (`--adopt-legacy` +
// `--legacy-api-key{,-file,-stdin}`) and the standalone `adopt-legacy`
// verb were removed in PR-impl-3 commit 3 per §X.6. The internal
// adoption service (`services/adoptLegacy.ts`) is preserved byte-
// identical and reachable only via the §X.1 one-prompt path.
program
  .command("setup")
  .argument("<serverSlug>", SERVER_SLUG_TARGET_DESC)
  .description("Set up Raft Computer for one server: approve this machine in the browser if needed, connect it, then start.")
  .option("--server-url <url>", `Raft API base URL; defaults to the saved user session, ${SERVER_URL_ENV_DESC}`)
  .option("--name <name>", "Computer display name for a new attachment; defaults to a sanitized hostname")
  .option("--machine <machineId>", "adopt the Computer/daemon row with this id (shown on the web Computers page) instead of matching local evidence")
  .option("--fresh", "create a new connection after unmatched local legacy evidence is printed")
  .option("--verbose", "show detailed migration evidence during setup")
  .option("--no-start", "finish setup without starting Raft Computer")
  .option("--foreground", FOREGROUND_DESC)
  .option("-y, --yes", "allow non-interactive setup after confirming the planned actions")
  .action(
    withCliExit(async (
      serverSlug: string,
      opts: {
        serverUrl?: string;
        name?: string;
        machine?: string;
        fresh?: boolean;
        verbose?: boolean;
        start?: boolean;
        foreground?: boolean;
        yes?: boolean;
      },
    ) => {
      await withMutationLock(() =>
        runSetup({
          serverSlug,
          serverUrl: opts.serverUrl,
          name: opts.name,
          machine: opts.machine,
          fresh: opts.fresh,
          verbose: opts.verbose,
          start: opts.start,
          foreground: opts.foreground,
          yes: opts.yes,
        }),
      );
    }),
  );

// --- start [serverSlug] (service + per-server daemons) ---
program
  .command("start")
  .argument("[serverSlug]", SERVER_SLUG_OPTIONAL_DESC)
  .description("Start Raft Computer in the background.")
  .option("--foreground", FOREGROUND_DESC)
  .action(withCliExit(async (serverSlug: string | undefined, opts: { foreground?: boolean }) => {
    const noteUpgradeStep = startNotesUpgradeStep();
    let ran = false;
    await withMutationLock(async (signal) => {
      ran = true;
      return runStart(
        {
          foreground: opts.foreground,
          serverId: serverSlug ? await resolveTargetServerId({ server: serverSlug }) : null,
          serverLabel: serverSlug ?? null,
          hostLifecycleOwner: "cli",
        },
        { signal, ensureTimeoutMs: startWaitForCaller(), acceptPartialReady: startAcceptsPartialReady(), noteUpgradeStep },
      );
    }).catch(async (err: unknown) => {
      // Refused before it ran (the mutation lock): runStart notes every other outcome itself.
      if (!ran && noteUpgradeStep && !opts.foreground) await noteStartNeverRan(err);
      throw err;
    });
  }));

// --- stop (graceful service shutdown) ---
// Root `stop` — gracefully stops the persistent service + all
// per-server daemon children (the service's SIGTERM handler kills
// children before clearing its own pidfile). Idempotent: missing /
// stale pidfile reports "Service not running" and exits 0.
//
// Before 0.0.8 the only `stop` command was `runners stop <agentId>`;
// the missing root `stop` was the blocker Hao caught in
// #wg-raft-computer:f83dbaed msg=fb9e5675. (The npm-era ephemeral-context
// upgrade remediation that pointed users here was removed with the SEA-only
// upgrade refactor — the upgrade command is now SEA-only and K-owned.)
program
  .command("stop")
  .description("Stop Raft Computer and any agents it is running.")
  .option("--jobs", "also stop the agents' background jobs (raft proc), which otherwise keep running")
  .action(withCliExit(async (opts: { jobs?: boolean }) => {
    await withMutationLock((signal) => runStop({ signal, hostLifecycleOwner: "cli", jobs: opts.jobs === true ? "stop" : "report" }));
  }));

// --- restart [serverSlug] ---
// A clean full restart of the persistent service + all managed per-server
// server-runners. From a person's terminal it is stop then start from that
// terminal (task #1202). From inside an agent process, route through the live
// service's IPC self-restart seam so a command launched by a managed daemon is
// not the process responsible for killing that same daemon before the
// replacement is running. Cold-boot restart stays equivalent to start.
program
  .command("restart")
  .argument("[serverSlug]", SERVER_SLUG_OPTIONAL_DESC)
  .description("Restart Raft Computer.")
  .option("--foreground", FOREGROUND_DESC)
  .action(withCliExit(async (serverSlug: string | undefined, opts: { foreground?: boolean }) => {
    await withMutationLock(async (signal) => {
      await runRestartCommand(serverSlug, opts, signal);
    });
  }));

// --- status (aggregate Computer view) ---
program
  .command("status")
  .description("Show whether Raft Computer is logged in, running, and connected to servers.")
  .option("--json", "print the live machine status as JSON")
  .action(withCliExit(async (opts: { json?: boolean }) => {
    const slockHome = resolveRaftHome();
    const api = createComputerApi(slockHome);
    if (opts.json) {
      const report = await api.getStatus();
      let attestation: unknown = null;
      if (report.service.running) {
        try {
          const client = await connectService(slockHome);
          try { attestation = await client.request("machine-attestation", undefined); } finally { await client.close(); }
        } catch { /* status remains useful when the service exits during readback */ }
      }
      // The installer repeats `nextStep` on its success line: what a person
      // should do before Computer can run. Nothing to say once a server is
      // attached (or, on an older server, once logged in).
      const nextStep = report.loggedIn || report.servers.length > 0 ? null : "run raft-computer setup /<server>";
      // Agents mid-turn now (Raft Desktop's quiet point); null when a runner
      // could not tell.
      const turns = await readMachineTurnActivity(slockHome).catch(() => null);
      const activeTurns = turns && turns.unknownServerIds.length === 0 ? turns.activeTurns : null;
      // What a one-time attach approval names this machine (Raft Desktop asks
      // the server for the grant before it hands the token to `attach`).
      const approvalRequest = { machineName: deriveDefaultComputerName(), hostname: osHostname(), os: approvalOsLabel() };
      // What this Computer's CLI can do for a caller (Raft Desktop enables a
      // feature only when it is listed; packages/shared computerCliContract.ts).
      const capabilities = [...COMPUTER_CLI_CAPABILITIES];
      process.stdout.write(`${JSON.stringify({ ...report, attestation, nextStep, activeTurns, approvalRequest, capabilities })}\n`);
      return;
    }
    await present(async () => {
      formatStatusReport(await api.getStatus());
      await printProcJobsStatus(slockHome);
    });
  }));

// --- doctor (aggregate per-server health) ---
program
  .command("doctor")
  .argument("[serverSlug]", `${SERVER_SLUG_OPTIONAL_DESC} (scopes recent-crash detail to that server)`)
  .description("Check Raft Computer setup and connection health. Secrets are never printed.")
  .option("--fix", "after diagnosis, clean up stale local state when it is safe")
  .option("--migration-details", "show local legacy migration evidence and server-relative exclusion reasons")
  .option("--json", "print the report as one JSON line (details redacted); exits 0 whenever it ran")
  .action(
    withCliExit(
      async (
        serverSlug: string | undefined,
        opts: { fix?: boolean; migrationDetails?: boolean; json?: boolean },
      ) => {
        if (opts.json) {
          const serverId = serverSlug ? await resolveTargetServerId({ server: serverSlug }) : undefined;
          await runDoctorJson({ cleanup: opts.fix, serverId, serverLabel: serverSlug });
          return;
        }
        if (opts.migrationDetails) {
          await runDoctorMigrationDetails({ serverLabel: serverSlug });
          return;
        }
        const serverId = serverSlug ? await resolveTargetServerId({ server: serverSlug }) : undefined;
        await runDoctor({
          cleanup: opts.fix,
          serverId: serverId,
          serverLabel: serverSlug,
        });
      },
    ),
  );

// --- logs [serverSlug] [--service] ---
program
  .command("logs")
  .argument("[serverSlug]", `${SERVER_SLUG_OPTIONAL_DESC} (required when ≥2 attached; ignored with --service)`)
  .description("Show recent Raft Computer logs. Secrets are redacted.")
  .option("--lines <n>", "trailing lines to show (default 200)", (v) => Number.parseInt(v, 10))
  .option("--service", "show machine-level logs instead of server-specific logs")
  .action(withCliExit(async (serverSlug: string | undefined, opts: { lines?: number; service?: boolean }) => {
    await runLogs({ lines: opts.lines, server: serverSlug ?? null, service: !!opts.service });
  }));

// --- runners list|stop ---
const runners = program
  .command("runners")
  .description("Advanced tools for agents running on this Computer.");
runners
  .command("list")
  .argument("[serverSlug]", `${SERVER_SLUG_OPTIONAL_DESC} (optional; default lists this Computer's runners across attached servers)`)
  .description("List agents running on this Computer.")
  .option("--all", "list all runners on the selected server (legacy server-wide view; serverSlug required when ≥2 attached)")
  .action(withCliExit(async (serverSlug: string | undefined, opts: { all?: boolean }) => {
    await runRunnersList({ server: serverSlug ?? null, all: opts.all === true });
  }));
runners
  .command("stop")
  .argument("<agentId>", "id of the agent to stop")
  .argument("[serverSlug]", `${SERVER_SLUG_OPTIONAL_DESC} (required when ≥2 attached)`)
  .description("Stop an agent running on this Computer.")
  .action(withCliExit(async (agentId: string, serverSlug: string | undefined) => {
    await withMutationLock(() => runRunnersStop(agentId, { server: serverSlug ?? null }));
  }));

// --- channel show|set (PR-E §2.1 release channel) ---
const channel = program
  .command("channel")
  .description(`Show or set the Computer release channel. ${RELEASE_CHANNEL_DESC}.`);
channel
  .command("show")
  .description("Show the saved Computer release channel. If none is set, this prints `latest`.")
  .action(
    withCliExit(async () => {
      await runChannelShow(resolveRaftHome());
    }),
  );
channel
  .command("set")
  .argument("<channel>", RELEASE_CHANNEL_DESC)
  .description("Set which release channel future `raft-computer upgrade` commands should use.")
  .action(
    withCliExit(async (value: string) => {
      await withMutationLock(() => runChannelSet(resolveRaftHome(), value));
    }),
  );
channel
  .command("versions")
  .argument("[channel]", "release channel to list; defaults to the saved channel")
  .description("List installable Computer versions published on a release channel.")
  .option("--json", "print the stable machine-readable response")
  .option("--limit <count>", "maximum versions to return (1-100)")
  .action(
    withCliExit(async (
      value: string | undefined,
      opts: { json?: boolean; limit?: string },
    ) => {
      await runChannelVersions(resolveRaftHome(), value, {
        json: opts.json === true,
        ...(opts.limit === undefined ? {} : { limit: Number(opts.limit) }),
      });
    }),
  );


// --- upgrade: run the external installer ---
program
  .command("upgrade")
  .description(UPGRADE_DESC)
  .option("--channel <name>", `use a release channel for this invocation only. ${RELEASE_CHANNEL_DESC}.`)
  // Commander treats `--version` as the root program version flag, so a
  // subcommand `--version` is unreachable; keep `--target-version`.
  .option("--target-version <semver>", "install a specific version")
  .option("--allow-downgrade", "intend an older --target-version; going back to a version that worked is this")
  .option("-y, --yes", "run unattended: no question, nothing read from stdin (Raft Desktop's Update Now)")
  .action(
    withCliExit(async (opts: { channel?: string; targetVersion?: string; allowDowngrade?: boolean; yes?: boolean }) => {
      if (opts.targetVersion !== undefined && !SEMVER_RE.test(opts.targetVersion)) {
        fail("UPGRADE_VERSION_INVALID", `Invalid --target-version "${opts.targetVersion}". Expected semver like 1.0.31.`);
      }
      let channel = opts.channel === undefined ? await readChannel(resolveRaftHome()) : parseChannel(opts.channel);
      if (channel === null) {
        fail("CHANNEL_INVALID", `Invalid channel "${opts.channel}". Accepted: \`latest\`, \`alpha\`, or \`pinned:<semver>\`.`);
      }
      // The installer decides everything from here: presence, the question,
      // settling unfinished work, the transaction, the one printed line.
      const code = await runInstallerAttended(installerArgs({ targetVersion: opts.targetVersion, channel, allowDowngrade: opts.allowDowngrade }), process.env, { unattended: opts.yes === true });
      if (code !== 0) throw new CliExit(code);
    }),
  );

program
  .command("__service", { hidden: true })
  .option("--slock-home <path>")
  .option("--raft-home <path>", "alias for --slock-home; --slock-home wins when both are given")
  .action(withCliExit(async (opts: { slockHome?: string; raftHome?: string }) => {
    const home = opts.slockHome ?? opts.raftHome;
    if (home) process.env.SLOCK_HOME = home;
    // The installer that started this service may have left its per-run
    // variables in our environment; runners and agents inherit process.env,
    // so drop them before anything is spawned (#proj-raft-computer:#32).
    scrubInstallerOperationEnv(process.env);
    await runService();
  }));
program
  .command("__run", { hidden: true })
  .argument("<serverId>", "server id this daemon child is bound to")
  .action(withCliExit(async (serverId: string) => {
    // Before anything is spawned: runtimes and agent commands must not inherit
    // the service's malloc settings (#wg-memory-usage:#36).
    removeServiceAddedMallocEnv(process.env);
    await runResident(serverId);
  }));

const supervisorCommand = program.command("__supervisor", { hidden: true });
supervisorCommand
  .command("retire-legacy", { hidden: true })
  .action(withCliExit(async () => {
    const slockHome = resolveRaftHome();
    const binaryPath = process.env[RESIDENT_CLI_PATH_ENV_VAR] || process.execPath;
    const result = await migrateLegacyOsSupervisorInstall(slockHome, binaryPath);
    if (result.retirement.status === "incomplete") {
      process.stderr.write(`[computer] note: ${result.retirement.message}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }));

async function runCli(): Promise<void> {
  // Native-build verification mode. Kept hidden from Commander and ordinary
  // help; the SEA builder executes the final injected carrier and compares all
  // three baked package identities before publishing bytes.
  if (process.argv[2] === "__build-versions") {
    process.stdout.write(`${JSON.stringify({
      computerVersion: COMPUTER_VERSION,
      daemonVersion: BUNDLED_DAEMON_VERSION ?? null,
      cliVersion: BUNDLED_CLI_VERSION ?? null,
    })}\n`);
    return;
  }
  // Execute on the injected release artifact, without reading account files or
  // contacting an OAuth service. A successful --version cannot detect missing
  // modules behind the SDK's lazy credential-derivation path.
  if (process.argv[2] === "__verify-bundled-oauth" || process.argv[2] === "__verify-bundled-kimi" || process.argv[2] === "__verify-bundled-oar") {
    const core = await import("@botiverse/raft-daemon/core");
    if (process.argv[2] === "__verify-bundled-oauth") {
      await core.verifyBundledPiOAuth();
      process.stdout.write("oauth-bundle-ok\n");
    } else if (process.argv[2] === "__verify-bundled-oar") {
      // RFC 060: the OAR host's runtimes (grok, qwen, qoder, codebuddy), their session paths and the observe entry, from the bundle.
      await core.verifyBundledOarHost();
      process.stdout.write("oar-bundle-ok\n");
    } else {
      // The SEA ships the kimi SDK as its own asset; load it like a launch would.
      await core.verifyBundledKimiSdk();
      process.stdout.write("kimi-bundle-ok\n");
    }
    return;
  }
  // Hidden `__cli` mode (busybox/self-re-exec): run the bundled `slock` CLI
  // in-process. The cliTransport agent wrapper on a SEA Computer execs
  // `<exe> __cli <args>` because a single-binary has no node + sidecar CLI
  // script to spawn. Intercept BEFORE commander so the CLI's own arg parser
  // (not raft-computer's) handles the args. No-op for normal `raft-computer`
  // commands.
  if (process.argv[2] === "__cli") {
    const { runBundledRaftCli } = await import("@botiverse/raft-daemon/bundled-cli");
    await runBundledRaftCli(process.argv.slice(3));
    return;
  }
  await program.parseAsync(process.argv);
}

// Import-safe entrypoint guard: only run the CLI when this module is the
// process entrypoint (CLI / SEA), NOT when it is imported (e.g. by the
// cliServerArgContract test, which inspects the configured `program`).
// In a SEA single-executable binary, `process.execPath` IS the bundled app and
// there is no script entry — `process.argv[1]` is the first USER arg (e.g.
// "--version"), so the import.meta.url === argv[1] check is always false and the
// CLI would never run (the binary exits silently). Treat a SEA binary as always
// invoked-as-main; the import-guard below still protects `node dist/index.js`
// imports (e.g. the cliServerArgContract test).
//
// Exported runner (rename block ④, #proj-aiax:c1b79aaa): the published
// `raft-computer` is a thin wrapper file that delegates to the import-safe
// entrypoint below.
// Under a wrapper, process.argv[1] is the WRAPPER path, so the argv guard
// below is false by design — wrappers must call this runner explicitly.
// A bare `import` (tests) still runs nothing.
export function runCliAsMain(): void {
  runCli().catch((err: unknown) => {
    process.stderr.write(formatCliFatalError(err));
    const debugStack = process.env.RAFT_COMPUTER_DEBUG_STACK;
    if (debugStack && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  });
}

// Main-guard moved to the thin entry (src/index.ts, task #326 bootstrap
// seam): this module must stay passive on import so the entry can capture
// the terminal-equivalent environment BEFORE the service graph evaluates.
