import crypto from "node:crypto";
import { SERVER_CAPABILITY_START_SPAWN_ERROR_V1, type ServerToMachineMessage } from "@botiverse/raft-shared";
import { serverMachineContextCapabilities } from "../runtimeOutcomeOutboxIngest";
import { isPrivacyModeOn } from "../config/privacyMode";

type MachineContextSocket = {
  send(data: string): void;
};

/** One machine connection's epoch; minted by the route so `machine:context` can carry it. */
export function newMachineConnectionEpochId(machineId: string): string {
  return `machine:${machineId}:connection:${crypto.randomUUID()}`;
}

/**
 * `SLOCK_MACHINE_TRACE_UPLOAD_URL`: the trace-upload receiver this server's
 * machines should send their trace bundles to. Unset or blank → omitted, and
 * the daemon keeps its default. The daemon accepts the value only from its own
 * allowlist (packages/daemon/src/traceUploadUrl.ts) and its owner's
 * `SLOCK_DAEMON_TRACE_UPLOAD_URL` still wins. Never named under RAFT_PRIVACY_MODE.
 */
export function machineTraceUploadUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isPrivacyModeOn()) return undefined;
  const value = env.SLOCK_MACHINE_TRACE_UPLOAD_URL?.trim();
  return value ? value : undefined;
}

/**
 * The connection route has already authenticated both identities. Send this
 * before registration can replay any queued Agent/App work to the machine.
 * `capabilities` is omitted when the server advertises none, so the frame is
 * unchanged for every daemon until a capability is switched on.
 * `connectionEpochId` goes out only with `agent:start-spawn-error-v1` (task
 * #365): the daemon refuses an automatic `agent:start` stamped with another
 * epoch. `traceUploadUrl` goes out only when configured (machineTraceUploadUrl).
 * `privacyMode: true` goes out only under RAFT_PRIVACY_MODE, so with it off the
 * frame is unchanged.
 */
export function sendAuthenticatedMachineContext(
  ws: MachineContextSocket,
  context: { machineId: string; serverId: string; connectionEpochId?: string },
  capabilities: readonly string[] = serverMachineContextCapabilities(),
  traceUploadUrl: string | undefined = machineTraceUploadUrl(),
  privacyMode: boolean = isPrivacyModeOn(),
): void {
  const sendsEpoch = context.connectionEpochId !== undefined && capabilities.includes(SERVER_CAPABILITY_START_SPAWN_ERROR_V1);
  const message = {
    type: "machine:context",
    machineId: context.machineId,
    serverId: context.serverId,
    ...(capabilities.length > 0 ? { capabilities: [...capabilities] } : {}),
    ...(sendsEpoch ? { connectionEpochId: context.connectionEpochId } : {}),
    ...(traceUploadUrl && !privacyMode ? { traceUploadUrl } : {}),
    ...(privacyMode ? { privacyMode: true } : {}),
  } satisfies ServerToMachineMessage;
  ws.send(JSON.stringify(message));
}
