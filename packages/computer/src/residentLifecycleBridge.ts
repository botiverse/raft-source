import { currentTimeMs, type ComputerLifecycleExecutionAck } from "@botiverse/raft-shared";
import { COMPUTER_VERSION } from "./version.js";
import {
  acknowledgeLifecycleReceipt,
  readPendingLifecycleAcknowledgements,
  retireCompletedUpgradeShutdownsFromLog,
} from "./lifecycleOperations.js";
import { readPendingRestartMarker } from "./restartMarker.js";
import { isProcessAlive } from "./internal/process-primitives.js";
import {
  readMachineServiceAttestation,
  waitForRestartConvergence,
} from "./machineServiceAttestation.js";
import {
  acknowledgeOperation,
  loadOperation,
  type OperationRead,
} from "@botiverse/k-carrier";
import { kStateDir } from "./kPaths.js";
import type { MachineServiceAttestation } from "./lib/types.js";

export interface ResidentLifecycleBridge {
  supervisorMutationsAttested: boolean;
  getAcknowledgements(): ComputerLifecycleExecutionAck[];
  getReadyAcknowledgements(): Promise<ComputerLifecycleExecutionAck[]>;
  acknowledgeReceipt(operationId: string, phase: "shutdown" | "ready"): Promise<void>;
}

/** Consume K's terminal receipt only after the Server receipts its exact ready ack. */
export async function acknowledgeKReadyReceipt(input: {
  slockHome: string;
  operationId: string;
  phase: "shutdown" | "ready";
}, deps: {
  acknowledge?: typeof acknowledgeOperation;
  nowMs?: () => number;
} = {}): Promise<void> {
  if (input.phase !== "ready") return;
  const result = await (deps.acknowledge ?? acknowledgeOperation)(
    kStateDir(input.slockHome),
    input.operationId,
    (deps.nowMs ?? currentTimeMs)(),
  );
  if (result === "not-terminal") {
    throw new Error(`K_OPERATION_RECEIPT_PREMATURE: ${input.operationId}`);
  }
}

/** Bind one ready ack to K's exact terminal receipt and a live successor. */
export function bindKUpgradeReadyAcknowledgement(input: {
  acknowledgement: ComputerLifecycleExecutionAck;
  serverId: string;
  operation: OperationRead;
  service: MachineServiceAttestation | null;
  isAlive?: (pid: number) => boolean;
}): ComputerLifecycleExecutionAck | null {
  const { acknowledgement: ack, operation, service } = input;
  if (
    ack.action !== "upgrade"
    || operation.kind !== "observed"
    || operation.operation.id !== ack.operationId
    || operation.operation.outcome !== "promoted"
    || operation.operation.targetVersion !== COMPUTER_VERSION
    || operation.operation.metadata.originServerId !== input.serverId
    || !service
    || service.computerVersion !== COMPUTER_VERSION
  ) return null;
  let deadProcessIdentities: string[];
  try {
    const parsed = JSON.parse(
      operation.operation.metadata.priorProcessIdentities ?? "null",
    ) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length === 0
      || parsed.some((identity) =>
        typeof identity !== "string"
        || !/^(?:service:\d+|runner:[^\s:]{1,240}:\d+)$/u.test(identity)
      )
    ) return null;
    deadProcessIdentities = parsed;
  } catch {
    return null;
  }
  const alive = input.isAlive ?? isProcessAlive;
  const oldProcessesDead = deadProcessIdentities.every((identity) => {
    const pid = Number.parseInt(identity.slice(identity.lastIndexOf(":") + 1), 10);
    return Number.isSafeInteger(pid) && pid > 0 && !alive(pid);
  });
  if (!oldProcessesDead) return null;
  return {
    ...ack,
    serviceGeneration: service.serviceGeneration,
    managedSetRevision: service.managedSetRevision,
    oldProcessIdentitiesDead: true,
    deadProcessIdentities,
  };
}

async function getReadyAcknowledgements(
  slockHome: string,
  serverId: string,
): Promise<ComputerLifecycleExecutionAck[]> {
  const pending = readPendingLifecycleAcknowledgements(
    slockHome,
    serverId,
    undefined,
    COMPUTER_VERSION,
  );
  const shutdown = pending.filter((ack) => ack.phase === "shutdown");
  const ready = pending.filter((ack) => ack.phase === "ready");
  if (ready.length === 0) return [];
  const pendingRestart = await readPendingRestartMarker(slockHome);
  const restart = await waitForRestartConvergence(slockHome, pendingRestart);
  const kOperation = await loadOperation(kStateDir(slockHome));
  const finalService = await readMachineServiceAttestation(slockHome);

  return [...shutdown, ...ready.flatMap((ack) => {
    if (pendingRestart?.requestId === ack.operationId) {
      if (!restart || !finalService || finalService.serviceGeneration !== restart.serviceGeneration) return [];
      return [{
        ...ack,
        serviceGeneration: restart.serviceGeneration,
        managedSetRevision: restart.managedSetRevision,
        oldProcessIdentitiesDead: true,
        deadProcessIdentities: restart.deadProcessIdentities,
      }];
    }
    const bound = bindKUpgradeReadyAcknowledgement({
      acknowledgement: ack,
      serverId,
      operation: kOperation,
      service: finalService,
    });
    return bound ? [bound] : [];
  })];
}

export async function prepareResidentLifecycleBridge(
  slockHome: string,
  serverId: string,
): Promise<ResidentLifecycleBridge> {
  await retireCompletedUpgradeShutdownsFromLog(slockHome, serverId);
  const initialService = await readMachineServiceAttestation(slockHome);
  const supervisorMutationsAttested = Boolean(
    initialService
    && initialService.computerVersion === COMPUTER_VERSION
    && isProcessAlive(initialService.servicePid),
  );
  return {
    supervisorMutationsAttested,
    getAcknowledgements: () => readPendingLifecycleAcknowledgements(
      slockHome,
      serverId,
      undefined,
      COMPUTER_VERSION,
    ),
    getReadyAcknowledgements: () => getReadyAcknowledgements(slockHome, serverId),
    acknowledgeReceipt: async (operationId, phase) => {
      await acknowledgeLifecycleReceipt(slockHome, serverId, operationId, phase);
      await acknowledgeKReadyReceipt({ slockHome, operationId, phase });
    },
  };
}
