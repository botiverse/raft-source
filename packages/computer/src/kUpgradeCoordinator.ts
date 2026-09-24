import {
  bootstrapStable,
  type CreateUpgraderOptions,
  type NotificationEvent,
  type OperationRecord,
  type Upgrader,
} from "@botiverse/k-carrier";

import { createComputerUpgrader } from "./kUpgrader.js";
import { kStateDir } from "./kPaths.js";

export type KUpgradeTrigger = "cli" | "web" | "tray";

interface KUpgradeCoordinatorRequestCommon {
  carrier: "k";
  mode: "upgrade" | "recover";
  requestId: string;
  fromVersion: string;
  targetVersion: string;
  startedAt: string;
  currentBinaryPath: string;
  trigger: KUpgradeTrigger;
  /** Exact live processes K must have stopped before a ready receipt is valid. */
  priorProcessIdentities?: string[];
}

export type KUpgradeCoordinatorRequest =
  | (KUpgradeCoordinatorRequestCommon & {
      scope: "local";
      trigger: "cli" | "tray";
      originServerId?: never;
    })
  | (KUpgradeCoordinatorRequestCommon & {
      scope: "remote";
      trigger: "web";
      originServerId: string;
    });

export interface KUpgradeCoordinatorDeps {
  bootstrapStableFn?: typeof bootstrapStable;
  createUpgraderFn?: (
    slockHome: string,
    opts: {
      onProgress: NonNullable<CreateUpgraderOptions["onProgress"]>;
      notificationSink: (event: NotificationEvent) => Promise<void>;
    },
  ) => Upgrader;
}

export type KUpgradeCoordinatorResult =
  | "promoted"
  | "rolled-back"
  | "held"
  | "up-to-date"
  | "failed"
  | "recovered-terminal"
  | "recovery-not-needed";

function resultFromOperation(operation: OperationRecord): KUpgradeCoordinatorResult {
  switch (operation.outcome) {
    case "promoted": return "promoted";
    case "rolled-back": return "rolled-back";
    case "held": return "held";
    case "up-to-date": return "up-to-date";
    case "failed": return "failed";
    case null: return "recovery-not-needed";
  }
}

/**
 * Thin detached driver. K owns the lock, journal, rollback target and terminal
 * receipt; Computer supplies only the release/host adapters and spawn lifetime.
 */
export async function runKUpgradeCoordinator(
  slockHome: string,
  request: KUpgradeCoordinatorRequest,
  deps: KUpgradeCoordinatorDeps = {},
): Promise<KUpgradeCoordinatorResult> {
  await (deps.bootstrapStableFn ?? bootstrapStable)({
    stateDir: kStateDir(slockHome),
    version: request.fromVersion,
    artifactPath: request.currentBinaryPath,
  });

  const upgrader = (deps.createUpgraderFn ?? ((home, opts) => createComputerUpgrader(home, opts)))(
    slockHome,
    { onProgress: () => {}, notificationSink: async () => {} },
  );
  if (request.mode === "recover") {
    const before = await upgrader.operation();
    if (before.kind !== "observed" || before.operation.id !== request.requestId) {
      return "recovery-not-needed";
    }
    if (before.operation.outcome !== null) return resultFromOperation(before.operation);
    await upgrader.recover();
    const after = await upgrader.operation();
    if (after.kind !== "observed" || after.operation.id !== request.requestId) {
      return "recovery-not-needed";
    }
    return after.operation.outcome === null ? "recovery-not-needed" : "recovered-terminal";
  }

  const outcome = await upgrader.upgradeTo(request.targetVersion, {
    consented: true,
    provenance: {
      who: request.scope === "remote" ? request.originServerId : "local",
      carrier: request.trigger,
    },
    operation: {
      id: request.requestId,
      startedAtMs: Date.parse(request.startedAt),
      metadata: {
        trigger: request.trigger,
        upgradeScopeVersion: "1",
        upgradeScope: request.scope,
        coordinatorPid: String(process.pid),
        ...(request.scope === "remote" ? { originServerId: request.originServerId } : {}),
        ...(request.priorProcessIdentities?.length
          ? { priorProcessIdentities: JSON.stringify(request.priorProcessIdentities) }
          : {}),
      },
    },
  });
  // A local upgrade has no Server to deliver K's terminal receipt to, and the
  // CLI/tray that asked for it has long since returned "started". Success is
  // the one outcome nobody needs to be told about: K's own predicates already
  // proved the live successor before promoting, so the driver consumes its
  // exact receipt here. Anything else (rolled-back / held / failed) stays
  // unacknowledged so `status` keeps surfacing it until it is delivered.
  // Remote receipts are the Server's to deliver and are never touched here.
  if (
    request.scope === "local"
    && (outcome.result === "promoted" || outcome.result === "up-to-date")
  ) {
    await upgrader.acknowledgeOperation(request.requestId);
  }
  return outcome.result;
}
