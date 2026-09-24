import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acknowledgeOperation,
  loadOperation,
  type OperationOutcome,
  type OperationRecord,
} from "@botiverse/k-carrier";
import { currentTimeMs } from "@botiverse/raft-shared";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isProcessAlive } from "./internal/process-primitives.js";
import { createComputerUpgrader } from "./kUpgrader.js";
import { kSlotBinaryPath } from "./kPaths.js";
import { ComputerError } from "./lib/errors.js";
import type { MachineServiceAttestation } from "./lib/types.js";
import { kStateDir } from "./kPaths.js";
import { readMachineServiceAttestation } from "./machineServiceAttestation.js";

export type TerminalUpgradeReceiptAcknowledgement = {
  status: "acknowledged" | "already-acknowledged";
  operationId: string;
  outcome: OperationOutcome;
  acknowledgedAt: string;
};

export interface TerminalUpgradeReceiptAcknowledgementDeps {
  load?: typeof loadOperation;
  acknowledge?: typeof acknowledgeOperation;
  nowMs?: () => number;
  readServiceAttestationFn?: (slockHome: string) => Promise<MachineServiceAttestation | null>;
  isProcessAliveFn?: (pid: number) => boolean;
  isKQuiescentFn?: (slockHome: string, operation: OperationRecord) => Promise<boolean>;
  /** Installer receipts: exact bytes/version currently in K's stable slot. */
  readStableSlotFn?: (slockHome: string) => Promise<{ version: string; sha256: string } | null>;
  /** Installer receipts: whether K's upgrade lock is held by a live process. */
  isKLockLiveFn?: (slockHome: string) => Promise<boolean>;
}

const SHA256_RE = /^[a-f0-9]{64}$/u;

/**
 * The official installer's own terminal receipt (`kInstallerConvergence`).
 * It carries no upgrade-scope marker and no predecessor identities: the
 * installer proved exact candidate bytes and (when a service was live) the
 * successor before it wrote this record, so its acknowledgement proof is the
 * stable slot itself, not a process handoff.
 */
function installerReceipt(operation: OperationRecord): boolean {
  const { metadata } = operation;
  return operation.provenance?.who === "local"
    && operation.provenance.carrier === "installer"
    && metadata.trigger === "cli"
    && metadata.installer === "official"
    && metadata.originServerId === undefined
    && metadata.upgradeScope === undefined
    && metadata.targetVersion === operation.targetVersion
    && typeof metadata.artifactSha256 === "string"
    && SHA256_RE.test(metadata.artifactSha256);
}

type AcknowledgeableReceipt = "local" | "installer";

function classifyReceipt(operation: OperationRecord): AcknowledgeableReceipt | null {
  if (localReceipt(operation)) return "local";
  if (installerReceipt(operation)) return "installer";
  return null;
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

async function defaultReadStableSlot(slockHome: string): Promise<{ version: string; sha256: string } | null> {
  try {
    const state = await createComputerUpgrader(slockHome, {
      onProgress: () => {},
      notificationSink: async () => {},
    }).state();
    if (state.stableVersion === "0.0.0") return null;
    return { version: state.stableVersion, sha256: await sha256File(kSlotBinaryPath(slockHome, "stable")) };
  } catch {
    return null;
  }
}

async function defaultKLockLive(slockHome: string, alive: (pid: number) => boolean): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(join(kStateDir(slockHome), "upgrade.lock"), "utf8")) as { pid?: unknown };
    return typeof lock.pid === "number" && lock.pid > 0 && alive(lock.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true; // unreadable lock: treat as live (fail closed)
  }
}

/**
 * Proof for an official installer receipt. Success outcomes (`up-to-date`,
 * `promoted`) require K's stable slot to hold the exact receipted bytes at the
 * target version; `failed` requires stable restored to the pre-install version.
 * A live service, if any answers, must attest that same version; a stopped
 * service does not block — the installer's success path performed no process
 * transition of its own, and a stopped machine is a legitimate state for a
 * fresh install.
 */
async function verifyInstallerReceipt(
  slockHome: string,
  operation: OperationRecord,
  deps: TerminalUpgradeReceiptAcknowledgementDeps,
): Promise<void> {
  if (
    operation.outcome !== "up-to-date"
    && operation.outcome !== "promoted"
    && operation.outcome !== "failed"
  ) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_OUTCOME_UNSUPPORTED",
      `Installer operation ${operation.id} has terminal outcome ${operation.outcome}; only up-to-date, promoted, or failed installer receipts are acknowledgeable here.`,
    );
  }
  const alive = deps.isProcessAliveFn ?? isProcessAlive;
  const lockLive = deps.isKLockLiveFn ?? ((home: string) => defaultKLockLive(home, alive));
  if (await lockLive(slockHome)) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_K_ACTIVE",
      `K's upgrade lock is still held while installer operation ${operation.id} awaits acknowledgement; no acknowledgement was consumed.`,
    );
  }
  const stable = await (deps.readStableSlotFn ?? defaultReadStableSlot)(slockHome);
  if (!stable) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_STABLE_UNREADABLE",
      `K's stable slot could not be read for installer operation ${operation.id}; no acknowledgement was consumed.`,
    );
  }
  const expectedVersion = operation.outcome === "failed" ? operation.fromVersion : operation.targetVersion;
  if (stable.version !== expectedVersion) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_VERSION_MISMATCH",
      `K stable is ${stable.version}, but installer operation ${operation.id} requires ${expectedVersion}; no acknowledgement was consumed.`,
    );
  }
  if (operation.outcome !== "failed" && stable.sha256 !== operation.metadata.artifactSha256) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_STABLE_MISMATCH",
      `K stable bytes do not match the candidate receipted by installer operation ${operation.id}; no acknowledgement was consumed.`,
    );
  }
  const readAttestation = deps.readServiceAttestationFn
    ?? ((home: string) => readMachineServiceAttestation(home));
  const first = await readAttestation(slockHome);
  if (first === null) return; // no live service: nothing further to prove for an installer receipt
  const second = await readAttestation(slockHome);
  if (!second || !sameStableService(first, second)) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_SERVICE_UNSTABLE",
      `Installer operation ${operation.id} has no stable live Computer service readback; no acknowledgement was consumed.`,
    );
  }
  if (first.computerVersion !== expectedVersion) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_VERSION_MISMATCH",
      `The live Computer reports ${first.computerVersion}, but installer operation ${operation.id} requires ${expectedVersion}; no acknowledgement was consumed.`,
    );
  }
}

const PROCESS_ID_RE = /^(?:service:(\d+)|runner:[^\s:]{1,240}:(\d+))$/u;

function localReceipt(operation: OperationRecord): boolean {
  const trigger = operation.metadata.trigger;
  return operation.metadata.upgradeScopeVersion === "1"
    && operation.metadata.upgradeScope === "local"
    && operation.metadata.originServerId === undefined
    && (trigger === "cli" || trigger === "tray")
    && operation.provenance?.who === "local"
    && operation.provenance.carrier === trigger;
}

function predecessorPids(operation: OperationRecord): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.metadata.priorProcessIdentities ?? "null");
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 512) return null;
  const pids: number[] = [];
  for (const identity of parsed) {
    if (typeof identity !== "string") return null;
    const match = PROCESS_ID_RE.exec(identity);
    const pid = Number(match?.[1] ?? match?.[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    pids.push(pid);
  }
  return pids;
}

async function defaultKQuiescent(
  slockHome: string,
  operation: OperationRecord,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  const coordinatorPid = Number(operation.metadata.coordinatorPid);
  if (!Number.isSafeInteger(coordinatorPid) || coordinatorPid <= 0 || alive(coordinatorPid)) {
    return false;
  }
  try {
    const lock = JSON.parse(await readFile(join(kStateDir(slockHome), "upgrade.lock"), "utf8")) as {
      pid?: unknown;
    };
    return typeof lock.pid === "number" && lock.pid > 0 && !alive(lock.pid);
  } catch (error) {
    return error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT";
  }
}

function sameStableService(
  first: MachineServiceAttestation,
  second: MachineServiceAttestation,
): boolean {
  return first.computerVersion === second.computerVersion
    && first.servicePid === second.servicePid
    && first.serviceGeneration === second.serviceGeneration;
}

async function verifyTerminalReceipt(
  slockHome: string,
  operation: OperationRecord,
  deps: TerminalUpgradeReceiptAcknowledgementDeps,
): Promise<void> {
  if (!localReceipt(operation)) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_SCOPE_MISMATCH",
      `K operation ${operation.id} is not an exact versioned local scope receipt; no acknowledgement was consumed.`,
    );
  }
  if (
    operation.outcome !== "promoted"
    && operation.outcome !== "rolled-back"
    && operation.outcome !== "failed"
  ) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_OUTCOME_UNSUPPORTED",
      `K operation ${operation.id} has terminal outcome ${operation.outcome}; this local acknowledgement path accepts only promoted, rolled-back, or failed receipts.`,
    );
  }

  const pids = predecessorPids(operation);
  if (!pids) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_IDENTITY_INVALID",
      `K operation ${operation.id} does not carry exact predecessor process identities; no acknowledgement was consumed.`,
    );
  }
  const alive = deps.isProcessAliveFn ?? isProcessAlive;
  const quiescent = deps.isKQuiescentFn
    ?? ((home: string, record: OperationRecord) => defaultKQuiescent(home, record, alive));
  if (operation.outcome === "failed" && !await quiescent(slockHome, operation)) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_K_ACTIVE",
      `K operation ${operation.id} still has an active K coordinator or lock; no acknowledgement was consumed.`,
    );
  }

  const readAttestation = deps.readServiceAttestationFn
    ?? ((home: string) => readMachineServiceAttestation(home));
  const first = await readAttestation(slockHome);
  const second = await readAttestation(slockHome);
  if (!first || !second || !sameStableService(first, second)) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_SERVICE_UNSTABLE",
      `K operation ${operation.id} has no stable live Computer service readback; no acknowledgement was consumed.`,
    );
  }

  const expectedVersion = operation.outcome === "promoted"
    ? operation.targetVersion
    : operation.fromVersion;
  if (first.computerVersion !== expectedVersion) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_VERSION_MISMATCH",
      operation.outcome === "promoted"
        ? `The live Computer is not the exact successor version ${operation.targetVersion}; no acknowledgement was consumed.`
        : `The live Computer is not the exact restored version ${operation.fromVersion}; no acknowledgement was consumed.`,
    );
  }

  const livePredecessor = pids.find((pid) => alive(pid));
  const allowedFailedOriginal = operation.outcome === "failed"
    && livePredecessor === first.servicePid
    && pids.filter((pid) => alive(pid)).every((pid) => pid === first.servicePid);
  if (livePredecessor !== undefined && !allowedFailedOriginal) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_PREDECESSOR_ALIVE",
      `K operation ${operation.id} still has predecessor process ${livePredecessor} alive; no acknowledgement was consumed.`,
    );
  }
}

/**
 * Mark one exact terminal K receipt as delivered without deleting its audit
 * record. Active, missing, corrupt, or different receipts fail closed.
 */
export async function acknowledgeTerminalUpgradeReceipt(
  slockHome: string,
  operationId: string,
  deps: TerminalUpgradeReceiptAcknowledgementDeps = {},
): Promise<TerminalUpgradeReceiptAcknowledgement> {
  const stateDir = kStateDir(slockHome);
  const load = deps.load ?? loadOperation;
  const acknowledge = deps.acknowledge ?? acknowledgeOperation;
  const before = await load(stateDir);
  if (before.kind === "genesis") {
    throw new ComputerError(
      "UPGRADE_RECEIPT_NOT_FOUND",
      `No K operation receipt exists. Re-run \`raft-computer status\` and acknowledge only the exact id it shows.`,
    );
  }
  if (before.kind === "unreadable") {
    throw new ComputerError(
      "UPGRADE_RECEIPT_UNREADABLE",
      `The K operation receipt is unreadable (${before.reason}). Run \`raft-computer doctor\` before changing it.`,
    );
  }
  if (before.operation.id !== operationId) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_ID_MISMATCH",
      `K currently holds operation ${before.operation.id}, not ${operationId}. Re-run \`raft-computer status\` and acknowledge only the exact id it shows.`,
    );
  }
  if (before.operation.outcome === null) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_ACTIVE",
      `K operation ${operationId} is still active in phase ${before.operation.phase}; it cannot be acknowledged as terminal.`,
    );
  }
  const receiptKind = classifyReceipt(before.operation);
  if (receiptKind === null) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_SCOPE_MISMATCH",
      `K operation ${operationId} is not an exact versioned local scope receipt; no acknowledgement was consumed.`,
    );
  }
  if (before.operation.acknowledgedAtMs !== null) {
    return {
      status: "already-acknowledged",
      operationId,
      outcome: before.operation.outcome,
      acknowledgedAt: new Date(before.operation.acknowledgedAtMs).toISOString(),
    };
  }

  if (receiptKind === "installer") {
    await verifyInstallerReceipt(slockHome, before.operation, deps);
  } else {
    await verifyTerminalReceipt(slockHome, before.operation, deps);
  }

  const result = await acknowledge(stateDir, operationId, (deps.nowMs ?? currentTimeMs)());
  if (result !== "acknowledged") {
    throw new ComputerError(
      result === "not-terminal"
        ? "UPGRADE_RECEIPT_ACTIVE"
        : result === "not-found"
          ? "UPGRADE_RECEIPT_NOT_FOUND"
          : "UPGRADE_RECEIPT_CHANGED",
      `K operation ${operationId} changed while it was being acknowledged (${result}); no delivery was confirmed. Re-run \`raft-computer status\`.`,
    );
  }
  const after = await load(stateDir);
  if (
    after.kind !== "observed"
    || after.operation.id !== operationId
    || after.operation.outcome === null
    || after.operation.acknowledgedAtMs === null
    || classifyReceipt(after.operation) !== receiptKind
  ) {
    throw new ComputerError(
      "UPGRADE_RECEIPT_READBACK_FAILED",
      `K did not durably confirm acknowledgement of operation ${operationId}. Re-run \`raft-computer status\`.`,
    );
  }
  return {
    status: "acknowledged",
    operationId,
    outcome: after.operation.outcome,
    acknowledgedAt: new Date(after.operation.acknowledgedAtMs).toISOString(),
  };
}
