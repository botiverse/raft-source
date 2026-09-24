import type { ServerToMachineMessage } from "@botiverse/raft-shared";

type MachineContextSocket = {
  send(data: string): void;
};

/**
 * The connection route has already authenticated both identities. Send this
 * before registration can replay any queued Agent/App work to the machine.
 */
export function sendAuthenticatedMachineContext(
  ws: MachineContextSocket,
  context: { machineId: string; serverId: string },
): void {
  const message = {
    type: "machine:context",
    machineId: context.machineId,
    serverId: context.serverId,
  } satisfies ServerToMachineMessage;
  ws.send(JSON.stringify(message));
}
