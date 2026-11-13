import { HOST_PROVIDER_LABELS, isHostProvider } from "@botiverse/raft-shared";
import { computerOsName } from "./computerDevice";

export interface MachinePlatformInput {
  os?: string | null;
  osRelease?: string | null;
  hostProvider?: string | null;
}

/**
 * The one-line platform fact for a Computer: "Ubuntu 26.04 · Hetzner Cloud".
 * The OS is computerOsName's, as in the rack ("macOS" / "Windows" where
 * there is no release).
 * Shows whichever part exists, never a dangling separator, and null when
 * neither does (render nothing, not an empty line). The provider name comes
 * only from HOST_PROVIDER_LABELS: an id this bundle does not know (a newer
 * Server's list) shows no provider rather than the raw id.
 */
export function formatMachinePlatformLine(machine: MachinePlatformInput): string | null {
  const osRelease = computerOsName(machine);
  const provider = isHostProvider(machine.hostProvider) ? HOST_PROVIDER_LABELS[machine.hostProvider] : null;
  const parts = [osRelease, provider].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The other Computers in the list on the same physical machine as `machine`
 * (same `sameMachineGroup` label), in list order. Empty when the label is
 * null / absent (alone, or computer_host_identity_v0 off).
 */
export function sameMachinePeers<T extends { id: string; sameMachineGroup?: string | null }>(
  machine: T,
  machines: readonly T[],
): T[] {
  const group = machine.sameMachineGroup;
  if (!group) return [];
  return machines.filter((other) => other.id !== machine.id && other.sameMachineGroup === group);
}
