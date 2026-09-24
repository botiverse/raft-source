import { join } from "node:path";
import {
  acceptMachineOperation,
  createMachineOperationRecord,
  reduceMachineConvergence,
  type MachineConvergenceEvent,
  type MachineReducerResult,
} from "./machineConvergenceReducer.js";
import {
  FileDurableTextCell,
  SerializedMachineOperationStore,
  type MachineAcceptanceSnapshot,
  type MachineDispatchIdentity,
  type MachineOperationRecord,
  type MachineProcessIdentity,
} from "./machineOperationStore.js";

function recordPath(slockHome: string, operationId: string): string {
  return join(slockHome, "machine-operations", `${operationId}.json`);
}

export function machineOperationStore(
  slockHome: string,
  operationId: string,
): SerializedMachineOperationStore {
  return new SerializedMachineOperationStore(
    new FileDurableTextCell(recordPath(slockHome, operationId)),
  );
}

export async function acceptDurableMachineOperation(input: {
  slockHome: string;
  identity: MachineDispatchIdentity;
  acceptance: MachineAcceptanceSnapshot;
  originRunner: MachineProcessIdentity;
}): Promise<MachineOperationRecord> {
  const store = machineOperationStore(input.slockHome, input.identity.dispatchOperationId);
  const incoming = createMachineOperationRecord(input);
  const created = await store.createIfAbsent(incoming);
  const accepted = acceptMachineOperation(
    created.kind === "exists" ? created.record : null,
    incoming,
  );
  if (accepted.kind === "conflict") throw new Error(accepted.code);
  if (accepted.kind === "rejected") throw new Error(accepted.code);
  return accepted.record;
}

export async function reduceDurableMachineOperation(
  slockHome: string,
  operationId: string,
  event: MachineConvergenceEvent extends infer Event
    ? Event extends MachineConvergenceEvent
      ? Omit<Event, "expectedPhaseVersion">
      : never
    : never,
): Promise<MachineReducerResult> {
  const store = machineOperationStore(slockHome, operationId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await store.load();
    if (!current) throw new Error("MACHINE_OPERATION_RECORD_MISSING");
    const result = reduceMachineConvergence(current, {
      ...event,
      expectedPhaseVersion: current.phaseVersion,
    } as MachineConvergenceEvent);
    if (result.kind !== "applied") return result;
    const swapped = await store.compareAndSwap(current.phaseVersion, result.record);
    if (swapped.kind === "applied") return { ...result, record: swapped.record };
    if (swapped.kind === "missing") throw new Error("MACHINE_OPERATION_RECORD_MISSING");
  }
  throw new Error("MACHINE_OPERATION_CAS_EXHAUSTED");
}
