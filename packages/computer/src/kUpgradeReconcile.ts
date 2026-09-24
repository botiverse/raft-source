import type { Upgrader } from "@botiverse/k-carrier";
import { createComputerUpgrader } from "./kUpgrader.js";

export interface KUpgradeDone {
  requestId: string;
  ok: boolean;
  newVersion?: string;
  rolledBack?: boolean;
  error?: string;
}

/** Project one exact terminal K receipt to its origin server until the Server receipts it. */
export async function reconcileKUpgradeOnConnect(input: {
  slockHome: string;
  serverId: string;
  runnerVersion: string;
  emitDone: (done: KUpgradeDone) => void;
}, deps: {
  createUpgrader?: (slockHome: string) => Pick<Upgrader, "operation" | "acknowledgeOperation">;
} = {}): Promise<boolean> {
  const upgrader = deps.createUpgrader?.(input.slockHome) ?? createComputerUpgrader(
    input.slockHome,
    {
      onProgress: () => {},
      notificationSink: async () => {},
    },
  );
  const observed = await upgrader.operation();
  if (
    observed.kind !== "observed"
    || observed.operation.outcome === null
    || observed.operation.acknowledgedAtMs !== null
    || observed.operation.metadata.originServerId !== input.serverId
  ) return false;

  const operation = observed.operation;
  const ok = (operation.outcome === "promoted" && input.runnerVersion === operation.targetVersion)
    || (operation.outcome === "up-to-date" && input.runnerVersion === operation.fromVersion);
  input.emitDone({
    requestId: operation.id,
    ok,
    newVersion: input.runnerVersion,
    ...(operation.outcome === "rolled-back" ? { rolledBack: true } : {}),
    ...(!ok && operation.reason ? { error: operation.reason } : {}),
  });
  return true;
}
