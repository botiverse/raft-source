import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "node:http";
import type {
  ProcessEvidence,
  ReleaseSource,
  Upgrader,
} from "@botiverse/k-carrier";
import { bootstrapStable, type QuarantineResult } from "@botiverse/k-carrier";

import { createKHostAdapter, type KHostAdapter } from "./kHostAdapter.js";
import { createComputerUpgrader } from "./kUpgrader.js";
import { findLiveServicePidReadOnly } from "./internal/service-pid-fallback.js";
import { RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR } from "./macosLoginCarrier.js";
import { kSlotBinaryPath } from "./kPaths.js";
import { compareComputerVersions } from "./kReleaseSource.js";
import { COMPUTER_VERSION } from "./version.js";
import { isProcessAlive } from "./internal/process-primitives.js";

export type KInstallerConvergenceResult = "not-initialized" | "converged";

/**
 * What the installer did about the resident service while converging K.
 * Surfaced to the user by the hidden CLI mode; never used as K evidence.
 */
export type KInstallerServiceState =
  | { kind: "live"; version: string; pid: number }
  | { kind: "restarted"; version: string; pid: number }
  | { kind: "not-running" };

/** The host-adapter duties the installer drives for a service handoff. */
export type KInstallerHostAdapter = Pick<
  KHostAdapter,
  "quiesce" | "stop" | "start" | "resume" | "healthProbe"
>;

type LiveServiceObservation =
  | { kind: "attested"; evidence: ProcessEvidence }
  | { kind: "alive-unattested"; pid: number }
  | { kind: "none" };

interface VerifiedArtifactServer {
  source: ReleaseSource;
  close(): Promise<void>;
}

export interface KInstallerConvergenceDeps {
  currentBinaryPath?: string;
  computerVersion?: string;
  createUpgraderFn?: (slockHome: string, source: ReleaseSource) => Upgrader;
  startArtifactServerFn?: (
    artifactPath: string,
    version: string,
    sha256: string,
    size: number,
  ) => Promise<VerifiedArtifactServer>;
  accessFn?: typeof access;
  statFn?: typeof stat;
  sha256FileFn?: (path: string) => Promise<string>;
  healthProbeFn?: (slockHome: string) => Promise<ProcessEvidence>;
  hostAdapterFn?: (slockHome: string) => KInstallerHostAdapter;
  findLiveServicePidFn?: (slockHome: string) => Promise<{ pid: number | null }>;
  onServiceState?: (state: KInstallerServiceState) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  randomIdFn?: () => string;
  nowMs?: () => number;
  isProcessAliveFn?: (pid: number) => boolean;
  bootstrapStableFn?: typeof bootstrapStable;
  onQuarantine?: (result: QuarantineResult) => void;
}

export interface KInstallerConvergenceOptions {
  forceDowngrade?: boolean;
}

function installerError(code: string, detail: string): Error {
  return new Error(`${code}: ${detail}`);
}

function atRest(phase: string): boolean {
  return phase === "idle" || phase === "promoted" || phase === "rolled-back";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function startArtifactServer(
  artifactPath: string,
  version: string,
  sha256: string,
  size: number,
): Promise<VerifiedArtifactServer> {
  const token = randomUUID();
  const pathname = `/${token}/raft-computer`;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== pathname) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-length", String(size));
    response.setHeader("connection", "close");
    const stream = createReadStream(artifactPath);
    stream.once("error", () => response.destroy());
    stream.pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw installerError("K_INSTALLER_ARTIFACT_SERVER_FAILED", "loopback listener has no TCP address");
  }
  const release = {
    version,
    url: `http://127.0.0.1:${address.port}${pathname}`,
    sha256,
    size,
  };
  const source: ReleaseSource = {
    checkForUpdate: async () => release,
    fetchRelease: async (requested) => {
      if (requested !== version) {
        throw installerError(
          "K_INSTALLER_TARGET_MISMATCH",
          `requested ${requested}, verified candidate is ${version}`,
        );
      }
      return release;
    },
  };
  return {
    source,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

async function pathExists(path: string, accessFn: typeof access): Promise<boolean> {
  try {
    await accessFn(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Liveness is a process fact, not a protocol fact. A service that is alive but
 * predates the attestation IPC must still be handed over; only "no pid at all"
 * may be reported as not-running.
 */
async function observeLiveService(
  probe: () => Promise<ProcessEvidence>,
  findLivePid: () => Promise<{ pid: number | null }>,
): Promise<LiveServiceObservation> {
  try {
    return { kind: "attested", evidence: await probe() };
  } catch {
    // Not answering the attestation probe is not proof of absence.
  }
  const { pid } = await findLivePid();
  return pid === null ? { kind: "none" } : { kind: "alive-unattested", pid };
}

/**
 * Entry gate for any handoff: on macOS the resident's login carrier refuses to
 * persist a K slot path and requires the stable PATH dispatcher to be named
 * in the environment. The candidate running this mode is not that dispatcher,
 * so the installer must have handed the path in. Checked BEFORE the resident
 * is stopped: a missing precondition must never leave the machine without a
 * service.
 */
function assertHandoffDispatcherBound(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  if (platform !== "darwin") return;
  const explicit = env[RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR]?.trim();
  if (explicit && isAbsolute(explicit)) return;
  throw installerError(
    "K_INSTALLER_DISPATCHER_UNBOUND",
    `a macOS service handoff requires ${RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR} to name the absolute stable dispatcher; the resident was not stopped`,
  );
}

/**
 * First half of K's handoff duties: park the exact managed set, then stop the
 * resident service. On a fresh install this runs BEFORE the old K directory
 * is quarantined — the resident was started from the slot being renamed, and
 * Windows will not rename a directory whose executable is still running.
 */
async function parkAndStopResident(host: KInstallerHostAdapter): Promise<void> {
  await host.quiesce();
  await host.stop("stable");
}

/**
 * Second half: start the stable slot, wait for the successor to serve the
 * parked managed set, then require the live process to report the installer
 * target. Nothing short of that attestation counts as a handoff.
 */
async function startStableAndProve(
  host: KInstallerHostAdapter,
  probe: () => Promise<ProcessEvidence>,
  expectedVersion: string,
): Promise<ProcessEvidence> {
  await host.start("stable");
  await host.resume();
  let live: ProcessEvidence;
  try {
    live = await probe();
  } catch (error) {
    throw installerError(
      "K_INSTALLER_HANDOFF_FAILED",
      `no live service answered after restarting stable ${expectedVersion}: ${(error as Error).message}`,
    );
  }
  if (live.version !== expectedVersion) {
    throw installerError(
      "K_INSTALLER_LIVE_VERSION_MISMATCH",
      `live stable reports ${live.version}, expected ${expectedVersion}`,
    );
  }
  return live;
}

/**
 * Bring the resident service in line with an exact stable slot without
 * inventing evidence: a service already attesting the target stays; an
 * absent service is reported as not-running (never faked); anything else
 * alive is handed over to stable and must then attest the target.
 */
async function settleResidentService(
  host: KInstallerHostAdapter,
  probe: () => Promise<ProcessEvidence>,
  findLivePid: () => Promise<{ pid: number | null }>,
  expectedVersion: string,
  forceHandoff: boolean,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<KInstallerServiceState> {
  if (!forceHandoff) {
    const observed = await observeLiveService(probe, findLivePid);
    if (observed.kind === "none") return { kind: "not-running" };
    if (observed.kind === "attested" && observed.evidence.version === expectedVersion) {
      return { kind: "live", version: observed.evidence.version, pid: observed.evidence.pid };
    }
  }
  assertHandoffDispatcherBound(platform, env);
  await parkAndStopResident(host);
  const live = await startStableAndProve(host, probe, expectedVersion);
  return { kind: "restarted", version: live.version, pid: live.pid };
}

async function assertRecoveryQuiescent(
  slockHome: string,
  operation: { metadata: Record<string, string> },
  isAlive: (pid: number) => boolean,
): Promise<void> {
  const coordinatorPid = Number(operation.metadata.coordinatorPid);
  if (Number.isSafeInteger(coordinatorPid) && coordinatorPid > 0 && isAlive(coordinatorPid)) {
    throw installerError("K_INSTALLER_RECOVERY_ACTIVE", `K coordinator ${coordinatorPid} is still alive`);
  }
  try {
    const lock = JSON.parse(await readFile(join(slockHome, "computer", "k", "upgrade.lock"), "utf8")) as { pid?: unknown };
    if (typeof lock.pid === "number" && lock.pid > 0 && isAlive(lock.pid)) {
      throw installerError("K_INSTALLER_RECOVERY_ACTIVE", `K lock owner ${lock.pid} is still alive`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("K_INSTALLER_RECOVERY_ACTIVE:")) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

/**
 * Converge an official installer candidate through K before the installer
 * replaces its PATH dispatcher. The candidate is served only on loopback;
 * K re-verifies the manifest sha/size, owns the upgrade lock, stages the
 * experiment, proves the live successor, and promotes stable.
 */
export async function convergeKInitializedInstaller(
  slockHome: string,
  expectedVersion: string,
  expectedSha256: string,
  options: KInstallerConvergenceOptions = {},
  deps: KInstallerConvergenceDeps = {},
): Promise<KInstallerConvergenceResult> {
  const currentBinaryPath = deps.currentBinaryPath ?? process.execPath;
  const computerVersion = deps.computerVersion ?? COMPUTER_VERSION;
  if (expectedVersion !== computerVersion) {
    throw installerError(
      "K_INSTALLER_SELF_VERSION_MISMATCH",
      `candidate reports ${computerVersion}, expected ${expectedVersion}`,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw installerError("K_INSTALLER_SHA256_INVALID", "expected sha256 must be 64 lowercase hex characters");
  }
  const candidateStat = await (deps.statFn ?? stat)(currentBinaryPath);
  if (!candidateStat.isFile()) {
    throw installerError("K_INSTALLER_CANDIDATE_INVALID", "candidate is not a regular file");
  }
  const actualSha256 = await (deps.sha256FileFn ?? sha256File)(currentBinaryPath);
  if (actualSha256 !== expectedSha256) {
    throw installerError(
      "K_INSTALLER_SHA256_MISMATCH",
      `candidate sha256 ${actualSha256} does not match ${expectedSha256}`,
    );
  }

  const server = await (deps.startArtifactServerFn ?? startArtifactServer)(
    currentBinaryPath,
    expectedVersion,
    expectedSha256,
    candidateStat.size,
  );
  try {
    const upgrader = (deps.createUpgraderFn ?? ((home, source) =>
      createComputerUpgrader(home, {
        source,
        onProgress: () => {},
        notificationSink: async () => {},
      })))(slockHome, server.source);
    const host = deps.hostAdapterFn?.(slockHome) ?? createKHostAdapter(slockHome);
    const probe = deps.healthProbeFn
      ? () => deps.healthProbeFn!(slockHome)
      : () => host.healthProbe();
    const findLivePid = deps.findLiveServicePidFn
      ? () => deps.findLiveServicePidFn!(slockHome)
      : () => findLiveServicePidReadOnly(slockHome);
    const onServiceState = deps.onServiceState ?? (() => {});
    const platform = deps.platform ?? process.platform;
    const env = deps.env ?? process.env;
    const sha256 = deps.sha256FileFn ?? sha256File;
    let operation = await upgrader.operation();
    if (operation.kind === "unreadable") {
      throw installerError("K_INSTALLER_STATE_UNREADABLE", operation.reason);
    }
    if (operation.kind === "observed" && operation.operation.outcome === null) {
      throw installerError(
        "K_INSTALLER_OPERATION_ACTIVE",
        `operation ${operation.operation.id} still owns K state`,
      );
    }

    let state = await upgrader.state();
    const stableExists = await pathExists(
      kSlotBinaryPath(slockHome, "stable"),
      deps.accessFn ?? access,
    );
    if (!stableExists) {
      if (
        operation.kind === "genesis"
        && state.phase === "idle"
        && state.stableVersion === "0.0.0"
        && state.experimentVersion === null
      ) return "not-initialized";
      throw installerError(
        "K_INSTALLER_STATE_CONFLICT",
        "K state exists without a complete stable slot",
      );
    }
    if (!atRest(state.phase)) {
      throw installerError(
        "K_INSTALLER_OPERATION_ACTIVE",
        `transaction phase ${state.phase} still owns K state`,
      );
    }

    if (
      !options.forceDowngrade
      && compareComputerVersions(state.stableVersion, expectedVersion) > 0
    ) {
      throw installerError(
        "K_INSTALLER_DOWNGRADE_REFUSED",
        `stable ${state.stableVersion} is newer than installer target ${expectedVersion}`,
      );
    }

    // Idempotent reinstall: K is already at rest on the exact target bytes
    // with no unfinished receipt. Touching K state here (quarantine, bootstrap,
    // a new receipt) would only manufacture churn; settle the resident service
    // against the existing stable and stop.
    const settledReceipt = operation.kind === "genesis"
      || (operation.kind === "observed"
        && operation.operation.outcome !== null
        && operation.operation.acknowledgedAtMs !== null);
    if (
      settledReceipt
      && atRest(state.phase)
      && state.stableVersion === expectedVersion
      && state.experimentVersion === null
      && await sha256(kSlotBinaryPath(slockHome, "stable")) === expectedSha256
    ) {
      onServiceState(await settleResidentService(host, probe, findLivePid, expectedVersion, false, platform, env));
      return "converged";
    }

    // A normal install is a fresh install: safely quiesced K state is moved
    // out of the live state directory before a new stable is initialized.
    // The carrier performs the lock-held terminal check and complete-directory
    // atomic rename; no raw operation/receipt/lock files are deleted.
    //
    // Liveness is observed BEFORE the rename: the resident service (if any)
    // was started from the slot being quarantined, and bootstrapping a new
    // stable performs no process handoff on its own (K reports the fresh
    // stable as up-to-date). Whatever is alive is parked and stopped first,
    // restarted onto the new stable after bootstrap, and must then attest the
    // target; absence is reported, never papered over.
    let freshInstall: LiveServiceObservation | null = null;
    if (operation.kind === "observed" || operation.kind === "genesis") {
      if (operation.kind === "observed") {
        if (
          operation.operation.provenance?.who !== "local"
          || operation.operation.metadata.originServerId !== undefined
        ) {
          throw installerError(
            "K_INSTALLER_RECOVERY_SCOPE_MISMATCH",
            `operation ${operation.operation.id} is not a local receipt; fresh install will not quarantine remote state`,
          );
        }
        await assertRecoveryQuiescent(
          slockHome,
          operation.operation,
          deps.isProcessAliveFn ?? isProcessAlive,
        );
      }
      // Refuse out-of-scope or still-owned state before interrupting the resident.
      freshInstall = await observeLiveService(probe, findLivePid);
      if (freshInstall.kind !== "none") {
        assertHandoffDispatcherBound(platform, env);
        await parkAndStopResident(host);
      }
      const operationId = operation.kind === "observed" ? operation.operation.id : "genesis";
      const timestampMs = (deps.nowMs ?? Date.now)();
      const quarantinePath = join(
        slockHome,
        "computer",
        "k-quarantine",
        `${operationId}-${timestampMs}`,
      );
      let quarantine: QuarantineResult;
      try {
        quarantine = await upgrader.quarantineState({
          destination: quarantinePath,
          timestampMs,
        });
      } catch (error) {
        // The old stable slot is still in place: give the machine its
        // service back before reporting why the fresh install stopped.
        if (freshInstall.kind !== "none") {
          try {
            await host.start("stable");
          } catch {
            // The original failure is the one worth reporting.
          }
        }
        throw error;
      }
      deps.onQuarantine?.(quarantine);
      await (deps.bootstrapStableFn ?? bootstrapStable)({
        stateDir: join(slockHome, "computer", "k"),
        version: expectedVersion,
        artifactPath: currentBinaryPath,
        nowMs: () => timestampMs,
      });
      operation = await upgrader.operation();
      state = await upgrader.state();
    }

    if (operation.kind === "observed" && operation.operation.acknowledgedAtMs === null) {
      throw installerError(
        "K_INSTALLER_OPERATION_ACTIVE",
        `operation ${operation.operation.id} still owns K state`,
      );
    }

    const operationId = `installer-${(deps.randomIdFn ?? randomUUID)()}`;
    const artifactSize = String(candidateStat.size);
    const outcome = await upgrader.upgradeTo(expectedVersion, {
      consented: true,
      provenance: { who: "local", carrier: "installer" },
      operation: {
        id: operationId,
        startedAtMs: (deps.nowMs ?? Date.now)(),
        metadata: {
          trigger: "cli",
          installer: "official",
          targetVersion: expectedVersion,
          artifactSha256: expectedSha256,
          artifactSize,
        },
      },
    });
    const receipt = await upgrader.operation();
    if (
      receipt.kind !== "observed"
      || receipt.operation.id !== operationId
      || receipt.operation.targetVersion !== expectedVersion
      || receipt.operation.outcome === null
      || receipt.operation.outcome !== outcome.result
      || receipt.operation.provenance?.who !== "local"
      || receipt.operation.provenance.carrier !== "installer"
      || receipt.operation.metadata.trigger !== "cli"
      || receipt.operation.metadata.installer !== "official"
      || receipt.operation.metadata.targetVersion !== expectedVersion
      || receipt.operation.metadata.artifactSha256 !== expectedSha256
      || receipt.operation.metadata.artifactSize !== artifactSize
    ) {
      throw installerError(
        "K_INSTALLER_RECEIPT_MISMATCH",
        "K did not publish the exact terminal installer receipt",
      );
    }
    if (outcome.result !== "promoted" && outcome.result !== "up-to-date") {
      throw installerError(
        "K_INSTALLER_CONVERGENCE_FAILED",
        `K finished official reinstall as ${outcome.result}`,
      );
    }
    const converged = await upgrader.state();
    if (
      !atRest(converged.phase)
      || converged.stableVersion !== expectedVersion
      || converged.experimentVersion !== null
    ) {
      throw installerError(
        "K_INSTALLER_CONVERGENCE_FAILED",
        `stable readback is ${converged.stableVersion} at ${converged.phase} with experiment ${converged.experimentVersion ?? "none"}, expected ${expectedVersion}`,
      );
    }
    const stableSha256 = await sha256(kSlotBinaryPath(slockHome, "stable"));
    if (stableSha256 !== expectedSha256) {
      throw installerError(
        "K_INSTALLER_STABLE_BYTES_MISMATCH",
        `stable sha256 ${stableSha256} does not match verified candidate ${expectedSha256}`,
      );
    }
    if (freshInstall !== null) {
      // Fresh install: K performed no handoff. A service that was alive before
      // quarantine was stopped above and is now started onto the new stable,
      // where it must attest the target; a machine with no service reports
      // not-running honestly (re-observed, so a race cannot hide a resident).
      if (freshInstall.kind !== "none") {
        const live = await startStableAndProve(host, probe, expectedVersion);
        onServiceState({ kind: "restarted", version: live.version, pid: live.pid });
      } else {
        onServiceState(await settleResidentService(host, probe, findLivePid, expectedVersion, false, platform, env));
      }
    } else {
      // K drove a real transaction: its promoted successor must be live and
      // report the exact target, or nothing is acknowledged.
      const live = await probe();
      if (live.version !== expectedVersion) {
        throw installerError(
          "K_INSTALLER_LIVE_VERSION_MISMATCH",
          `live stable reports ${live.version}, expected ${expectedVersion}`,
        );
      }
    }
    // The install path acknowledges only the NEW receipt: coordinator
    // success, exact stable bytes, and the resident service settled against
    // the stable target (live at target, restarted onto it, or provably
    // absent) must all be proven first.
    const acknowledgement = await upgrader.acknowledgeOperation(operationId);
    if (acknowledgement !== "acknowledged") {
      throw installerError(
        "K_INSTALLER_RECEIPT_ACK_FAILED",
        `terminal installer receipt changed while acknowledging (${acknowledgement})`,
      );
    }
    return "converged";
  } finally {
    await server.close();
  }
}
