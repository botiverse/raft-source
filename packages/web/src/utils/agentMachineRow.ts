import type { MachineLoadStatus } from "../store/machineStore";

/**
 * Which state the agent-detail "Computer" row is in, resolved from the machine store.
 *
 * Product decision (artin, task #259, 2026-09-04, both web and mobile): while the store is
 * still loading its first snapshot, the row is not rendered at all — it must not flash
 * "No computer assigned" and then flip to a machine. "No computer assigned" is only a
 * conclusion once the store has actually loaded (or an agent has no machineId to begin with).
 *
 * `loadStatus` semantics come from machineStore: "loading" only while there are no usable
 * rows; a refresh with cached rows, or an error with cached rows, both report "loaded".
 */
export type AgentMachineRow<M> =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "machine"; machine: M };

export function resolveAgentMachineRow<M extends { id: string }>(
  machineId: string | null | undefined,
  machines: readonly M[],
  loadStatus: MachineLoadStatus,
): AgentMachineRow<M> {
  if (!machineId) return { kind: "none" };
  const machine = machines.find((m) => m.id === machineId);
  if (machine) return { kind: "machine", machine };
  if (loadStatus !== "loaded") return { kind: "pending" };
  return { kind: "none" };
}
