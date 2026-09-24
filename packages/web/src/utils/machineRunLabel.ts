// Run-kind label for the Computer/daemon list rows. Online/offline is driven by
// `status` — NOT by the presence of a version string. `computerVersion` /
// `daemonVersion` only flow from the owning replica's in-memory connection map,
// so a non-owner REST read can return `status="online"` with `version=null`;
// rendering that as "computer offline" used to lie about a live Computer
// (#wg-raft-computer:de94165c — Maria showed a green status dot but the row
// said "computer offline" because the read landed on a non-owner replica).

export interface MachineRunLabelInput {
  isComputer?: boolean;
  status: string;
  computerVersion?: string | null;
  daemonVersion?: string | null;
}

export interface MachineRunLabel {
  text: string;
  isOffline: boolean;
}

export type MachineRunLabelDescriptor =
  | { id: "machine.runLabel.computerOffline"; values?: undefined; isOffline: true }
  | { id: "machine.runLabel.daemonOffline"; values?: undefined; isOffline: true }
  | { id: "machine.runLabel.computerVersion"; values: { version: string }; isOffline: false }
  | { id: "machine.runLabel.daemonVersion"; values: { version: string }; isOffline: false }
  | { id: "machine.runLabel.computerOnline"; values?: undefined; isOffline: false }
  | { id: "machine.runLabel.daemonOnline"; values?: undefined; isOffline: false };

export function machineRunLabel(m: MachineRunLabelInput): MachineRunLabel {
  const kind = m.isComputer ? "computer" : "daemon";
  if (m.status !== "online") return { text: `${kind} offline`, isOffline: true };
  const version = m.isComputer ? m.computerVersion : m.daemonVersion;
  if (version) return { text: `${kind} v${version}`, isOffline: false };
  return { text: `${kind} online`, isOffline: false };
}

export function getMachineRunLabelDescriptor(m: MachineRunLabelInput): MachineRunLabelDescriptor {
  if (m.status !== "online") {
    return m.isComputer
      ? { id: "machine.runLabel.computerOffline", isOffline: true }
      : { id: "machine.runLabel.daemonOffline", isOffline: true };
  }

  const version = m.isComputer ? m.computerVersion : m.daemonVersion;
  if (version) {
    return m.isComputer
      ? { id: "machine.runLabel.computerVersion", values: { version }, isOffline: false }
      : { id: "machine.runLabel.daemonVersion", values: { version }, isOffline: false };
  }

  return m.isComputer
    ? { id: "machine.runLabel.computerOnline", isOffline: false }
    : { id: "machine.runLabel.daemonOnline", isOffline: false };
}
