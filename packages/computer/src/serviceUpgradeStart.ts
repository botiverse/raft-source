import { type ChildProcess } from "node:child_process";

import { resolveUpgradeBaseUrl } from "./computerRelease.js";
import { resolveComputerUpgradeTargetVersion } from "./kReleaseSource.js";
import {
  inspectKUpgradeStart,
  spawnKUpgradeCoordinator,
  waitForKUpgradeStart,
} from "./kUpgradeProcess.js";
import { readChannel } from "./lib/channelState.js";
import {
  ServiceClientError,
  type UpgradeStartParams,
  type UpgradeStartResult,
} from "./lib/types.js";
import { COMPUTER_VERSION } from "./version.js";

type UpgradeTrigger = "cli" | "web" | "tray";

export interface ServiceUpgradeStartSeams {
  isSeaBinaryFn?: () => boolean;
  readChannelFn?: typeof readChannel;
  resolveUpgradeTargetVersionFn?: typeof resolveComputerUpgradeTargetVersion;
  spawnKUpgradeCoordinatorFn?: typeof spawnKUpgradeCoordinator;
  inspectKUpgradeStartFn?: typeof inspectKUpgradeStart;
  waitForKUpgradeStartFn?: typeof waitForKUpgradeStart;
}

interface InFlightUpgradeStart {
  scope: UpgradeStartParams["scope"];
  requestId: string;
  originServerId: string | undefined;
  targetVersion: string | undefined;
  trigger: UpgradeTrigger;
  result: Promise<UpgradeStartResult>;
}

export interface CreateServiceUpgradeStartOptions extends ServiceUpgradeStartSeams {
  slockHome: string;
  currentBinaryPath: string;
  servicePid: number;
  priorProcessIdentities: () => string[];
  checkControlAvailability: (requestId: string) => "available" | "replay";
  claimControl: (requestId: string) => symbol;
  releaseControl: (owner: symbol) => boolean;
}

/**
 * Keep K's acceptance handshake outside the resident supervisor's LOC budget.
 * The supervisor supplies only shared-control ownership and live runner PIDs;
 * this controller owns upgrade replay identity and the detached K receipt gate.
 */
export function createServiceUpgradeStart(
  options: CreateServiceUpgradeStartOptions,
): (params: UpgradeStartParams) => Promise<UpgradeStartResult> {
  let inFlightUpgrade: { upgradeId: string; targetVersion: string } | null = null;
  let inFlightStart: InFlightUpgradeStart | null = null;

  const release = (owner: symbol): void => {
    if (!options.releaseControl(owner)) return;
    inFlightUpgrade = null;
    inFlightStart = null;
  };

  return async (params): Promise<UpgradeStartResult> => {
    const { scope, targetVersion: explicit, requestId, trigger } = params;
    const originServerId = params.scope === "remote" ? params.originServerId : undefined;
    if (!options.isSeaBinaryFn?.()) {
      throw new ServiceClientError(
        "UPGRADE_START_REJECTED",
        describeUpgradeStartRejection("K_COORDINATOR_SEA_ONLY"),
      );
    }
    if (
      !requestId
      || (scope === "local" && (
        explicit === undefined
        || (trigger !== "cli" && trigger !== "tray")
        || "originServerId" in params
      ))
      || (scope === "remote" && (!originServerId || trigger !== "web"))
    ) {
      throw new ServiceClientError(
        "UPGRADE_START_REJECTED",
        describeUpgradeStartRejection("K_UPGRADE_REQUEST_IDENTITY_INVALID"),
      );
    }
    if (options.checkControlAvailability(requestId) === "replay") {
      if (
        inFlightStart?.scope === scope
        && inFlightStart.requestId === requestId
        && inFlightStart.originServerId === originServerId
        && inFlightStart.targetVersion === explicit
        && inFlightStart.trigger === trigger
      ) return inFlightStart.result;
      if (inFlightStart?.requestId === requestId) {
        throw new ServiceClientError(
          "CONTROL_BUSY",
          "CONTROL_BUSY: exact upgrade request identity does not match the in-flight operation",
        );
      }
      if (inFlightUpgrade) return { status: "already-running", ...inFlightUpgrade };
      throw new ServiceClientError("CONTROL_BUSY", "CONTROL_BUSY: upgrade state is unavailable");
    }

    const owner = options.claimControl(requestId);
    const result = startUpgrade(options, {
      scope,
      explicit,
      requestId,
      originServerId,
      trigger,
      owner,
      setInFlightUpgrade: (upgrade) => { inFlightUpgrade = upgrade; },
      release,
    });
    inFlightStart = { scope, requestId, originServerId, targetVersion: explicit, trigger, result };
    return result;
  };
}

interface StartUpgradeContext {
  scope: UpgradeStartParams["scope"];
  explicit: string | undefined;
  requestId: string;
  originServerId: string | undefined;
  trigger: UpgradeTrigger;
  owner: symbol;
  setInFlightUpgrade: (upgrade: { upgradeId: string; targetVersion: string }) => void;
  release: (owner: symbol) => void;
}

async function startUpgrade(
  options: CreateServiceUpgradeStartOptions,
  context: StartUpgradeContext,
): Promise<UpgradeStartResult> {
  const { scope, requestId: upgradeId, originServerId, trigger, owner } = context;
  try {
    const channel = await (options.readChannelFn ?? readChannel)(options.slockHome);
    const baseUrl = resolveUpgradeBaseUrl();
    let resolved = context.explicit;
    if (!resolved) {
      const resolveTarget = options.resolveUpgradeTargetVersionFn
        ?? resolveComputerUpgradeTargetVersion;
      resolved = await resolveTarget(channel, {
        currentVersion: COMPUTER_VERSION,
        platformKey: `${process.platform}-${process.arch}`,
      }, baseUrl);
    }
    context.setInFlightUpgrade({ upgradeId, targetVersion: resolved });
    const commonRequest = {
      carrier: "k" as const,
      mode: "upgrade" as const,
      requestId: upgradeId,
      fromVersion: COMPUTER_VERSION,
      targetVersion: resolved,
      startedAt: new Date().toISOString(),
      currentBinaryPath: options.currentBinaryPath,
      priorProcessIdentities: [
        `service:${options.servicePid}`,
        ...options.priorProcessIdentities(),
      ],
    };
    const request = scope === "remote"
      ? {
          ...commonRequest,
          scope,
          trigger: "web" as const,
          originServerId: originServerId!,
        }
      : {
          ...commonRequest,
          scope,
          trigger: trigger as "cli" | "tray",
        };
    const existing = await (options.inspectKUpgradeStartFn ?? inspectKUpgradeStart)(
      options.slockHome,
      request,
    );
    if (existing === "exact") {
      context.release(owner);
      return { status: "already-running", upgradeId, targetVersion: resolved };
    }
    const coordinator = await (
      options.spawnKUpgradeCoordinatorFn ?? spawnKUpgradeCoordinator
    )(options.slockHome, request);
    await waitForCoordinatorReceipt(options, request, coordinator, () => context.release(owner));
    return { status: "started", upgradeId, targetVersion: resolved };
  } catch (error) {
    context.release(owner);
    if (error instanceof ServiceClientError) throw error;
    throw new ServiceClientError(
      "UPGRADE_START_REJECTED",
      describeUpgradeStartRejection(error instanceof Error ? error.message : "coordinator start failed"),
      error,
    );
  }
}

/**
 * Human-readable body for a typed `UPGRADE_START_REJECTED` (task #779).
 *
 * The K reason token stays first so logs and tests can grep it; the sentence
 * after it tells the operator what is true and what, if anything, to do. Only
 * genuinely useful commands are fenced in backticks, because the CLI presenter
 * lifts fenced `raft-computer …` commands into its `Next:` line — so a receipt
 * that the service settles by itself must NOT name a repair command, and must
 * never send anyone to `raft-computer doctor` for a condition doctor cannot fix.
 */
export function describeUpgradeStartRejection(reason: string): string {
  const token = /^K_[A-Z0-9_]+/u.exec(reason.trim())?.[0] ?? null;
  // Strip backtick fences from any pass-through detail: the CLI presenter lifts
  // fenced `raft-computer …` commands into its `Next:` line, so a raw error
  // message must never be able to steer the operator's next step.
  const detail = (token === null ? reason.trim() : reason.trim().slice(token.length).replace(/^[:\s-]+/u, ""))
    .replace(/`/gu, "");
  const key = token ?? "K_UPGRADE_START_FAILED";
  const sentence = UPGRADE_START_REJECTION_TEXT[key]
    ?? `The service refused to start this upgrade${detail ? ` (${detail})` : ""}; nothing was swapped. Retry \`raft-computer upgrade\`; if it repeats, read the service log.`;
  return `${key}: ${sentence}`;
}

const UPGRADE_START_REJECTION_TEXT: Record<string, string> = {
  K_UPGRADE_OPERATION_BLOCKED:
    "The service still holds the terminal receipt of a previous upgrade operation, so a new upgrade cannot start until that receipt is delivered. No action is required from you; `raft-computer status` shows the current version and whether an upgrade is in flight.",
  K_UPGRADE_RECEIPT_UNREADABLE:
    "The K operation receipt on disk could not be read, so the service refused to start an upgrade over it. Run `raft-computer doctor` before changing anything.",
  K_UPGRADE_RECEIPT_IDENTITY_MISMATCH:
    "Another upgrade operation with a different identity owns the receipt slot; this request was not started. `raft-computer status` shows the operation in flight.",
  K_UPGRADE_START_TIMEOUT:
    "The upgrade coordinator did not publish an accepted receipt in time; nothing was swapped. Retry `raft-computer upgrade`; if it repeats, read the service log.",
  K_UPGRADE_COORDINATOR_REJECTED:
    "The upgrade coordinator exited before accepting the request; nothing was swapped. Retry `raft-computer upgrade`; if it repeats, read the service log.",
  K_UPGRADE_COORDINATOR_MISSING:
    "The upgrade coordinator process could not be spawned; nothing was swapped. Retry `raft-computer upgrade`; if it repeats, read the service log.",
  K_COORDINATOR_SEA_ONLY:
    "This service is not a packaged (SEA) build, so it cannot run the upgrade coordinator; upgrade-start is unavailable in dev/npm runs.",
  K_UPGRADE_REQUEST_IDENTITY_INVALID:
    "The upgrade request carried an invalid local/remote identity and was not started.",
};

async function waitForCoordinatorReceipt(
  options: CreateServiceUpgradeStartOptions,
  request: Parameters<typeof waitForKUpgradeStart>[1],
  coordinator: ChildProcess,
  onAcceptedExit: () => void,
): Promise<void> {
  if (!coordinator.pid) throw new Error("K_UPGRADE_COORDINATOR_MISSING");
  let coordinatorExited = false;
  let startupAccepted = false;
  const hasExited = (): boolean => coordinatorExited
    || typeof coordinator.exitCode === "number"
    || (coordinator.signalCode !== null && coordinator.signalCode !== undefined);
  coordinator.once("exit", () => {
    coordinatorExited = true;
    if (startupAccepted) onAcceptedExit();
  });
  coordinator.once("error", () => { coordinatorExited = true; });
  await (options.waitForKUpgradeStartFn ?? waitForKUpgradeStart)(
    options.slockHome,
    request,
    hasExited,
  );
  if (hasExited()) throw new Error("K_UPGRADE_COORDINATOR_REJECTED");
  startupAccepted = true;
}
