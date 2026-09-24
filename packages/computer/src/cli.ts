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
 *   login                              shared device-code user identity
 *   logout                             clear the saved user session
 *   attach <serverSlug>                add-not-replace per-server attach
 *   start [serverSlug]                 ensure service + per-server daemons
 *   stop                               stop the service + managed daemons
 *   status                             aggregate Computer view
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
 *
 * Verb-to-axis table:
 *   start/stop [serverSlug]            axis 1 only
 *   setup/attach <serverSlug>          axis 3 create/proof-resume only
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

import { runLogin, runLogout } from "./login.js";
import { runAttach } from "./attach.js";
import { runSetup } from "./setup.js";
import { formatStatusReport } from "./status.js";
import { runRunnersList, runRunnersStop } from "./runners.js";
import { runStart, runStop } from "./startStop.js";
import { runResident, runService, isSeaBinary, OS_SUPERVISOR_KIND_ENV_VAR, RESIDENT_CLI_PATH_ENV_VAR } from "./service.js";
import type { OsSupervisorKind } from "./osSupervisor.js";
import { runDoctor, runDoctorMigrationDetails } from "./doctorCli.js";
import { runLogs } from "./logs.js";
import { CliExit, info, fail, present } from "./output.js";
import { createComputerApi } from "./lib/api.js";
import { ComputerError } from "./lib/errors.js";
import { createComputerTracer } from "./lib/computerTracer.js";
import { currentDate, currentTimeMs, type Tracer } from "@botiverse/raft-shared";
import { withMutationLock } from "./concurrency.js";
import { runChannelShow, runChannelSet, runChannelVersions } from "./channel.js";
import { parseChannel, readChannel, SEMVER_RE } from "./lib/channelState.js";
import {
  resolveUpgradeBaseUrl,
} from "./computerRelease.js";
import { resolveComputerUpgradeTargetVersion } from "./kReleaseSource.js";
import { ComputerServiceError } from "./services/errors.js";
import { resolveRaftHome } from "./paths.js";
import { resolveTargetServerId } from "./targetServer.js";
import { DEFAULT_SLOCK_SERVER_URL } from "./serverUrl.js";
import { BUNDLED_CLI_VERSION, BUNDLED_DAEMON_VERSION, COMPUTER_VERSION } from "./version.js";
import { listAttachedServerIds, setServerManaged } from "./serverState.js";
import { prepareLocalLifecycleOperations } from "./localLifecycleIntents.js";
import { runLegacySupervisorTakeover } from "./legacySupervisorTakeover.js";
import { migrateLegacyOsSupervisorInstall } from "./legacyOsSupervisorMigration.js";
import { findLiveServicePidReadOnly } from "./internal/service-pid-fallback.js";
import { isDegraded } from "./health.js";
import { resetRunner } from "./reset.js";
import { requestServiceRestartViaIpc } from "./serviceControl.js";
import { readKUpgradeCoordinatorRequest } from "./kUpgradeProcess.js";
import { runKUpgradeCoordinator } from "./kUpgradeCoordinator.js";
import { requestKTargetConsent } from "./kConsent.js";
import { createComputerUpgrader } from "./kUpgrader.js";
import { convergeKInitializedInstaller } from "./kInstallerConvergence.js";
import { acknowledgeTerminalUpgradeReceipt } from "./kOperationAcknowledgement.js";

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
  "`latest` installs production releases; `alpha` follows staging builds; `pinned:<semver>` stays on one version";
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
  prepareTargetsForServiceHandoff?: typeof prepareRestartTargetsForServiceHandoff;
  requestServiceRestartViaIpc?: typeof requestServiceRestartViaIpc;
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
  prepareTargets: typeof prepareRestartTargetsForServiceHandoff;
  requestRestart: typeof requestServiceRestartViaIpc;
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
    prepareTargets: deps.prepareTargetsForServiceHandoff ?? prepareRestartTargetsForServiceHandoff,
    requestRestart: deps.requestServiceRestartViaIpc ?? requestServiceRestartViaIpc,
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
): Promise<void> {
  await runtime.prepareLifecycle(plan.slockHome, "restart", plan.targets).catch(() => []);
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
  runtime: Pick<RestartCommandRuntime, "prepareTargets" | "requestRestart" | "emitFail" | "emitInfo">,
): Promise<void> {
  await runtime.prepareTargets(plan.slockHome, plan.targets, signal);
  signal.throwIfAborted();

  try {
    await runtime.requestRestart(plan.slockHome);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.emitFail(
      "RESTART_SERVICE_UNREACHABLE",
      `Cannot restart the live Computer service via IPC (${detail}). This command will not send SIGTERM from the caller because the caller may be running under the service being restarted. Run \`raft-computer status\` and inspect \`raft-computer logs --service\`.`,
    );
  }

  runtime.emitInfo(
    `Service restart requested (pid ${liveServicePid}); replacement service will take over without relying on this shell.`,
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
  await recordRestartIntent(plan, runtime);

  const { pid } = await runtime.findLiveService(plan.slockHome);
  signal.throwIfAborted();

  if (pid === null) {
    await runColdBootRestart(plan, opts, signal, runtime);
    return;
  }

  await requestLiveServiceRestart(plan, pid, signal, runtime);
}

export const program = new Command();
program
  .name("raft-computer")
  .description("Raft Computer — connect this machine to Raft so agents can run here.")
  .version(COMPUTER_VERSION);

// --- login (shared device-code) ---
program
  .command("login")
  .description("Log in to Raft on this machine.")
  .option("--server-url <url>", `Raft API base URL; defaults to ${SERVER_URL_ENV_DESC}`)
  .action(withCliExit(async (opts: { serverUrl?: string }) => {
    await runLogin({ serverUrl: opts.serverUrl });
  }));

// --- logout (clear the saved user session) ---
program
  .command("logout")
  .description("Log out of Raft on this machine. Connected servers are kept.")
  .action(withCliExit(async () => {
    await runLogout();
  }));

// --- attach <serverSlug> (add-not-replace) ---
program
  .command("attach")
  .argument("<serverSlug>", SERVER_SLUG_TARGET_DESC)
  .description("Connect this machine to one Raft server.")
  .option("--server-url <url>", `Raft API base URL; defaults to the saved user session, ${SERVER_URL_ENV_DESC}`)
  .option("--name <name>", "Computer display name; defaults to a sanitized hostname")
  .option("--no-start", "connect without starting Raft Computer")
  .option("--foreground", FOREGROUND_DESC)
  .action(withCliExit(async (serverSlug: string, opts: { serverUrl?: string; name?: string; start?: boolean; foreground?: boolean }) => {
    await withMutationLock(() =>
      runAttach({ serverSlug, serverUrl: opts.serverUrl, name: opts.name, start: opts.start, foreground: opts.foreground }),
    );
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
  .description("Set up Raft Computer for one server: log in if needed, connect this machine, then start.")
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
    await withMutationLock(async (signal) =>
      runStart(
        {
          foreground: opts.foreground,
          serverId: serverSlug ? await resolveTargetServerId({ server: serverSlug }) : null,
          serverLabel: serverSlug ?? null,
          hostLifecycleOwner: "cli",
        },
        { signal },
      ),
    );
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
  .action(withCliExit(async () => {
    await withMutationLock((signal) => runStop({ signal, hostLifecycleOwner: "cli" }));
  }));

// --- restart [serverSlug] ---
// A clean full restart of the persistent service + all managed per-server
// server-runners. When a service is live, route through its IPC self-restart
// seam so a command launched by a managed daemon is not the process responsible
// for killing that same daemon before the replacement is running. Cold-boot
// restart stays equivalent to start.
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
  .action(withCliExit(async () => {
    const slockHome = resolveRaftHome();
    const api = createComputerApi(slockHome);
    await present(async () => {
      formatStatusReport(await api.getStatus());
    });
  }));

// --- doctor (aggregate per-server health) ---
program
  .command("doctor")
  .argument("[serverSlug]", `${SERVER_SLUG_OPTIONAL_DESC} (scopes recent-crash detail to that server)`)
  .description("Check Raft Computer setup and connection health. Secrets are never printed.")
  .option("--fix", "after diagnosis, clean up stale local state when it is safe")
  .option("--migration-details", "show local legacy migration evidence and server-relative exclusion reasons")
  .action(
    withCliExit(
      async (
        serverSlug: string | undefined,
        opts: { fix?: boolean; migrationDetails?: boolean },
      ) => {
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

const operation = program
  .command("operation")
  .description("Inspect or acknowledge durable Computer upgrade receipts.");
operation
  .command("acknowledge")
  .argument("<operationId>", "exact K operation id shown by `raft-computer status`")
  .description("Acknowledge one exact terminal K receipt without deleting its audit record.")
  .action(
    withCliExit(async (operationId: string) => {
      try {
        const result = await withMutationLock(() =>
          acknowledgeTerminalUpgradeReceipt(resolveRaftHome(), operationId));
        info(
          result.status === "already-acknowledged"
            ? `Terminal K operation ${result.operationId} was already acknowledged at ${result.acknowledgedAt}.`
            : `Acknowledged terminal K operation ${result.operationId} (${result.outcome}) at ${result.acknowledgedAt}.`,
        );
      } catch (error) {
        if (error instanceof ComputerError) fail(error.code, error.message, error.exitCode);
        throw error;
      }
    }),
  );

// --- upgrade (PR-E §2.5) ---
program
  .command("upgrade")
  .description(UPGRADE_DESC)
  .option("--dry-run", "resolve the update package only; server authorization is not checked and no changes are made")
  .option("--channel <name>", `use a release channel for this invocation only. ${RELEASE_CHANNEL_DESC}.`)
  // PR-E §2.5: use `--target-version`, not `--version`. Commander treats
  // `--version` as the root program version flag (prints "0.0.1" and
  // exits 0), so a subcommand `--version` is unreachable.
  .option("--target-version <semver>", "install a specific version")
  .option(
    "--rollback",
    "restore the previous version from the last successful upgrade; mutually exclusive with --target-version/--channel/--dry-run",
  )
  .action(
    withCliExit(
      async (opts: {
        dryRun?: boolean;
        channel?: string;
        targetVersion?: string;
        rollback?: boolean;
      }) => {
        const slockHome = resolveRaftHome();
        // Trigger-source attribution: the Computer service sets
        // SLOCK_UPGRADE_TRIGGER=web when it spawns this command on behalf of a
        // web button; a direct CLI invocation leaves it unset → "cli".
        const trigger = resolveUpgradeTrigger(process.env.SLOCK_UPGRADE_TRIGGER);
        const seaBinary = isSeaBinary();
        if (!seaBinary) {
          fail("UPGRADE_SEA_ONLY", "Computer self-upgrade requires the installed single-executable binary.");
        }
        if (opts.rollback && (opts.dryRun || opts.channel || opts.targetVersion)) {
          fail("UPGRADE_FLAGS_CONFLICT", "--rollback cannot be combined with --dry-run, --channel, or --target-version.");
        }
        if (!opts.rollback && opts.targetVersion !== undefined && !SEMVER_RE.test(opts.targetVersion)) {
          fail(
            "UPGRADE_VERSION_INVALID",
            `Invalid --target-version "${opts.targetVersion}". Expected semver like 0.53.0 or 1.0.0-alpha.`,
          );
        }
        let kTargetVersion = opts.targetVersion;
        if (opts.rollback) {
          const operation = await createComputerUpgrader(slockHome, {
            onProgress: () => {},
            notificationSink: async () => {},
          }).operation();
          if (operation.kind !== "observed" || operation.operation.outcome === null) {
            fail("UPGRADE_NO_ROLLBACK", "Nothing to roll back: K has no terminal operation with a previous stable version.");
          }
          kTargetVersion = operation.operation.previousStableVersion;
        }
        if (!kTargetVersion) {
          const channel = opts.channel
            ? parseChannel(opts.channel)
            : await readChannel(slockHome);
          if (channel === null) {
            fail(
              "CHANNEL_INVALID",
              `Invalid --channel "${opts.channel}". Accepted: latest | alpha | pinned:<semver>.`,
            );
          }
          const baseUrl = resolveUpgradeBaseUrl();
          try {
            kTargetVersion = await resolveComputerUpgradeTargetVersion(channel!, {
              currentVersion: COMPUTER_VERSION,
              platformKey: `${process.platform}-${process.arch}`,
            }, baseUrl);
          } catch (error) {
            if (error instanceof ComputerServiceError) presentUpgradeTargetResolutionFailure(error);
            throw error;
          }
        }
        // Hands reports `up_to_date` through the shared resolver as the
        // current version. Short-circuit before consent or any K/Computer
        // lifecycle surface so a no-op creates no prompt, intent, or receipt.
        if (kTargetVersion === COMPUTER_VERSION) {
          info(`Already at ${COMPUTER_VERSION}.`);
          return;
        }
        if (opts.dryRun) {
          info(
            `Package check resolved Computer ${kTargetVersion}. `
            + "Server authorization was not checked; no changes were made.",
          );
          return;
        }
        // An explicit target and the durable rollback marker already bind the
        // operator's action to one version. A moving channel does not: resolve
        // it first, then ask for this exact version. Non-interactive callers
        // must pass --target-version instead of silently approving the channel.
        if (!opts.targetVersion && !opts.rollback) {
          const consent = await requestKTargetConsent(kTargetVersion!);
          if (consent === "non-interactive") {
            fail(
              "UPGRADE_CONFIRMATION_REQUIRED",
              `Resolved Computer ${kTargetVersion}. Re-run with --target-version ${kTargetVersion} to approve that exact version in a non-interactive session.`,
            );
          }
          if (consent === "declined") {
            fail("UPGRADE_CANCELLED", `Upgrade to Computer ${kTargetVersion} was not confirmed.`);
          }
        }
        // ①b single-writer: when a service is running, route the upgrade
        // through it via IPC (`upgrade-start`) so the supervisor drives the
        // swap AND re-execs the resident process onto the new binary. Routing
        // is the ONLY path that makes the version actually take effect — a
        // standalone swap under a still-running service leaves the old process
        // reporting the old version (the silent-strand bug, #wg-raft-computer
        // task #100). The connect→upgrade-start→emit routing lives in
        // `api.tryUpgradeViaService` so the CLI + menu-bar share one path.
        //
        // dry-run stays standalone. Rollback is derived from K's terminal
        // operation receipt; Computer has no parallel `.prev` or target file.
        // A plain `--channel`
        // override DOES route now: `upgrade-start` carries only an explicit
        // targetVersion, so we resolve the override to a version here first
        // (the service would otherwise resolve the PERSISTED channel, which
        // could differ from the one-shot override — e.g. persisted
        // `pinned:0.0.63` while the user runs `upgrade --channel latest`).
        const api = createComputerApi(slockHome, { tracer: resolveCliTracer(slockHome) });
        let routed: Awaited<ReturnType<typeof api.tryUpgradeViaService>>;
        try {
          routed = await api.tryUpgradeViaService(kTargetVersion, (event) => {
            if (event.kind === "log.line") info(event.line);
          }, { trigger });
        } catch (error) {
          if (error instanceof ComputerError) fail(error.code, error.message);
          throw error;
        }
        if (routed.routed) return;
        if (routed.reason === "unreachable") {
          fail(
            "UPGRADE_SERVICE_UNREACHABLE",
            "A Computer service is running but its control socket could not be reached, " +
              "so the upgrade could not be applied to the live process. Run " +
              "`raft-computer restart` (or stop + start) and retry `upgrade`.",
          );
        }

        const operationId = randomUUID();
        try {
          const result = await runKUpgradeCoordinator(slockHome, {
            carrier: "k",
            mode: "upgrade",
            scope: "local",
            requestId: operationId,
            fromVersion: COMPUTER_VERSION,
            targetVersion: kTargetVersion,
            startedAt: currentDate().toISOString(),
            currentBinaryPath: process.execPath,
            trigger,
          });
          const localUpgrader = createComputerUpgrader(slockHome, {
            onProgress: () => {},
            notificationSink: async () => {},
          });
          if (result === "promoted") {
            info(`Upgrade promoted to ${kTargetVersion}; waiting for managed runner readback.`);
            await localUpgrader.acknowledgeOperation(operationId);
            return;
          }
          if (result === "up-to-date") {
            info(`Already at ${kTargetVersion}.`);
            await localUpgrader.acknowledgeOperation(operationId);
            return;
          }
          await localUpgrader.acknowledgeOperation(operationId);
          fail(
            "UPGRADE_SWAP_FAILED",
            result === "rolled-back"
              ? "The new version did not converge, so K restored the previous stable version."
              : "K held or failed the requested upgrade. Read the K operation receipt and retry after resolving it.",
          );
        } catch (error) {
          if (error instanceof Error && /UPGRADE_IN_PROGRESS|OPERATION_(IN_PROGRESS|RECEIPT_PENDING)/u.test(error.message)) {
            fail("UPGRADE_ALREADY_RUNNING", "Another K operation or undelivered terminal receipt already owns this Computer.");
          }
          // A local cold upgrade has no server runner to deliver K's terminal
          // receipt. Once this exact command is about to surface the failure,
          // acknowledge only its own terminal record so the next operation is
          // not permanently blocked behind an already-delivered CLI error.
          const localUpgrader = createComputerUpgrader(slockHome, {
            onProgress: () => {},
            notificationSink: async () => {},
          });
          const observed = await localUpgrader.operation();
          if (
            observed.kind === "observed"
            && observed.operation.id === operationId
            && observed.operation.outcome !== null
            && observed.operation.acknowledgedAtMs === null
          ) {
            await localUpgrader.acknowledgeOperation(operationId);
          }
          throw error;
        }
      },
    ),
  );

// --- hidden internal modes (re-execed by `start`) ---
program
  .command("__service", { hidden: true })
  .option("--slock-home <path>")
  .option("--raft-home <path>", "alias for --slock-home; --slock-home wins when both are given")
  .option("--os-supervised <kind>")
  .action(withCliExit(async (opts: { slockHome?: string; raftHome?: string; osSupervised?: string }) => {
    const home = opts.slockHome ?? opts.raftHome;
    if (home) process.env.SLOCK_HOME = home;
    if (opts.osSupervised) {
      const kinds: OsSupervisorKind[] = ["launchd-user", "systemd-user", "windows-task"];
      if (!kinds.includes(opts.osSupervised as OsSupervisorKind)) {
        throw new Error(`invalid OS supervisor kind: ${opts.osSupervised}`);
      }
      process.env[OS_SUPERVISOR_KIND_ENV_VAR] = opts.osSupervised;
    }
    await runService();
  }));
program
  .command("__run", { hidden: true })
  .argument("<serverId>", "server id this daemon child is bound to")
  .action(withCliExit(async (serverId: string) => {
    await runResident(serverId);
  }));
program
  .command("__k-upgrade", { hidden: true })
  .argument("<request>", "encoded non-secret K coordinator request")
  .action(withCliExit(async (encoded: string) => {
    const slockHome = resolveRaftHome();
    const request = readKUpgradeCoordinatorRequest(encoded);
    await runKUpgradeCoordinator(slockHome, request);
  }));
program
  .command("__installer-converge", { hidden: true })
  .argument("<targetVersion>", "manifest-bound installer target")
  .argument("<sha256>", "manifest-bound candidate digest")
  .option("--force-downgrade", "allow an explicitly requested verified downgrade")
  .action(withCliExit(async (
    targetVersion: string,
    sha256: string,
    opts: { forceDowngrade?: boolean },
  ) => {
    if (!SEMVER_RE.test(targetVersion)) throw new Error("invalid installer target version");
    const result = await convergeKInitializedInstaller(
      resolveRaftHome(),
      targetVersion,
      sha256.toLowerCase(),
      {
        forceDowngrade: opts.forceDowngrade === true,
      },
      {
        onQuarantine: (quarantine) => {
          process.stdout.write(
            `quarantined ${quarantine.quarantinePath} operation=${quarantine.operationId} timestamp=${quarantine.timestampMs} result=${quarantine.status}\n`,
          );
        },
        onServiceState: (state) => {
          process.stdout.write(
            state.kind === "not-running"
              ? "service not-running; run `raft-computer start` to launch the installed version\n"
              : `service ${state.kind} pid=${state.pid} version=${state.version}\n`,
          );
        },
      },
    );
    process.stdout.write(`${result}\n`);
  }));
program
  .command("__legacy-supervisor-takeover", { hidden: true })
  .argument("<role>", "coordinator or standby")
  .argument("<oldServicePid>", "attested legacy supervisor pid")
  .argument("<targetVersion>", "required replacement supervisor version")
  .argument("[operationId]", "durable machine dispatch id")
  .action(withCliExit(async (role: string, oldServicePid: string, targetVersion: string, operationId?: string) => {
    if (role !== "coordinator" && role !== "standby") throw new Error("invalid takeover role");
    if (!/^\d+$/.test(oldServicePid)) throw new Error("invalid legacy supervisor pid");
    if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) throw new Error("invalid target version");
    await runLegacySupervisorTakeover(role, Number(oldServicePid), targetVersion, operationId);
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
  // Hidden `__cli` mode (busybox/self-re-exec): run the bundled `slock` CLI
  // in-process. The cliTransport agent wrapper on a SEA Computer execs
  // `<exe> __cli <args>` because a single-binary has no node + sidecar CLI
  // script to spawn. Intercept BEFORE commander so the CLI's own arg parser
  // (not raft-computer's) handles the args. No-op for normal `raft-computer`
  // commands.
  if (process.argv[2] === "__cli") {
    const { runBundledRaftCli } = await import("@botiverse/raft-daemon/core");
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
    process.stderr.write(`raft-computer: ${err instanceof Error ? err.message : String(err)}\n`);
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
