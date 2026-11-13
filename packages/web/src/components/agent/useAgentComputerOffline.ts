import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";

/** The member an offline Computer belongs to: "Turn on <owner>'s computer". */
export interface ComputerOwner {
  id: string;
  name: string;
}

export interface AgentComputerOffline {
  machine: Machine;
  /** Null when unknown (a departed member, an older server): the steps then name no one. */
  owner: ComputerOwner | null;
}

/**
 * Who a Computer belongs to: the machine row's owner (`machines.userId`), else
 * the person who attached it (`creator`, when a person). This is not the
 * server's Owner role (raft-design agent-profile, Its computer is offline).
 */
export function computerOwnerId(machine: Machine): string | null {
  return machine.userId ?? (machine.creator?.type === "human" ? machine.creator.id : null);
}

/**
 * The agent's Computer while it is offline (#triage:#206) and whose it is;
 * null while it is online, unknown or unassigned.
 */
export function useAgentComputerOffline(machineId: string | null | undefined): AgentComputerOffline | null {
  const machine = useMachineStore((s) => (machineId ? s.machines.find((m) => m.id === machineId) : undefined));
  const ownerId = machine ? computerOwnerId(machine) : null;
  const ownerMember = useServerStore((s) => (ownerId ? s.members.find((m) => m.userId === ownerId) : undefined));
  if (!machine || machine.status !== "offline") return null;
  // The name follows the same id: the member's, else the creator's when the creator is that person.
  const creator = machine.creator?.id === ownerId ? machine.creator : null;
  const ownerName = ownerMember ? ownerMember.displayName || ownerMember.name : creator ? creator.displayName || creator.name : null;
  return { machine, owner: ownerId && ownerName ? { id: ownerId, name: ownerName } : null };
}
