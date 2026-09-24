import type { DaemonCoreOptions } from "@botiverse/raft-daemon/core";
import { BUNDLED_DAEMON_VERSION, COMPUTER_VERSION } from "./version.js";

export interface ResidentCoreIdentityCredentials {
  serverId: string;
  serverMachineId: string;
  apiKey: string;
  serverUrl: string;
}

export function residentCoreIdentity(
  creds: ResidentCoreIdentityCredentials,
): Pick<
  DaemonCoreOptions,
  "serverUrl" | "apiKey" | "machineOwnerProvenance" | "daemonVersion" | "computerVersion"
> {
  return {
    serverUrl: creds.serverUrl,
    apiKey: creds.apiKey,
    machineOwnerProvenance: {
      kind: "managed_computer_runner",
      serverId: creds.serverId,
      serverMachineId: creds.serverMachineId,
    },
    daemonVersion: BUNDLED_DAEMON_VERSION,
    computerVersion: COMPUTER_VERSION,
  };
}
