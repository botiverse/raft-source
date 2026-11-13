import type { Machine } from "../../store/machineStore";

// Order of the sidebar's Computers list (task #124 follow-up, WAWQAQ: "my
// computer is no longer at the top"). The server returns machines in an
// arbitrary order; what a user wants first is the computer they are sitting at,
// then the computers they attached themselves, then everyone else's.
//
//   1. this device: in Raft Desktop, the machine the app runs on
//      (localComputer/localComputerStore.ts); none in a browser,
//   2. the viewer's own computers (isMyComputer: attached or owned by them),
//   3. the rest,
// each group keeping the server's relative order (stable).
export type MyComputerFields = Pick<Machine, "computerAttachedByCurrentUser" | "ownerUserId">;
export type OrderedMachineFields = Pick<Machine, "id"> & MyComputerFields;

/**
 * The viewer's own computer (artin, #triage:#332): one they attached
 * (`computerAttachedByCurrentUser`, server-derived) or one Raft records them
 * as the owner of (`ownerUserId`; null is a Public Computer, nobody's). Every
 * "mine first" rule (this order, Members by computer, Create Agent's default
 * computer, the Computers page's groups) reads this one predicate.
 */
export function isMyComputer(machine: MyComputerFields, userId: string | null | undefined): boolean {
  if (machine.computerAttachedByCurrentUser === true) return true;
  return Boolean(userId) && machine.ownerUserId === userId;
}

/** Where a computer goes in the Computers list: 0 this device, 1 the viewer's own, 2 the rest. */
export function sidebarMachineTier(
  machine: OrderedMachineFields,
  pinnedMachineId: string | null | undefined,
  userId: string | null | undefined,
): 0 | 1 | 2 {
  if (pinnedMachineId && machine.id === pinnedMachineId) return 0;
  return isMyComputer(machine, userId) ? 1 : 2;
}

export function orderSidebarMachineIds(
  machines: readonly OrderedMachineFields[],
  pinnedMachineId: string | null | undefined,
  userId: string | null | undefined,
): string[] {
  const tiers: [string[], string[], string[]] = [[], [], []];
  for (const machine of machines) tiers[sidebarMachineTier(machine, pinnedMachineId, userId)].push(machine.id);
  return tiers.flat();
}

/**
 * This device and the rest of the Computers list on Raft Desktop (design
 * §4.1): `thisDevice` is the machine the app runs on, when it is one of the
 * server's computers (its row leads, marked This device); `others` the rest,
 * each in `orderedIds`' order. Without a device id (a browser, the phone)
 * everything is in `others`.
 */
export function groupSidebarMachineIds(
  orderedIds: readonly string[],
  thisDeviceId: string | null | undefined,
): { thisDevice: string | null; others: string[] } {
  const thisDevice = thisDeviceId && orderedIds.includes(thisDeviceId) ? thisDeviceId : null;
  return { thisDevice, others: thisDevice ? orderedIds.filter((id) => id !== thisDevice) : [...orderedIds] };
}

/**
 * `machines` in the Computers list's order. Every list or picker of computers
 * uses this so they all agree (artin: the migration dialog listed them in the
 * server's order).
 */
export function orderMachinesLikeSidebar<T extends OrderedMachineFields>(
  machines: readonly T[],
  pinnedMachineId: string | null | undefined,
  userId: string | null | undefined,
): T[] {
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  return orderSidebarMachineIds(machines, pinnedMachineId, userId).map((id) => byId.get(id)!);
}
