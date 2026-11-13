// This device's place in a list of the server's computers (design §4.1): on
// Raft Desktop the machine the app runs on always leads the list, marked
// "This device", whether or not it is one of the server's computers.
// The sidebar's Computers rail and the Computers rack both read it, so they
// agree.
//
// "Not one of them" is known only once the bridge has answered (status, the
// host state, the local identity) and the server's machine list has
// loaded: before that an attached machine would flash an Add to This Server
// row. Null in a browser and on the phone (no host), and until then.
import { useServerStore } from "../../../store/serverStore";
import { useMachineStore } from "../../../store/machineStore";
import { useLocalComputerHost } from "./useLocalComputerHost";
import type { LocalComputerHost } from "./useLocalComputerHost";

export type ThisDeviceListEntry =
  /** One of the server's computers: its own machine row leads the list. */
  | { kind: "attached"; host: LocalComputerHost; machineId: string }
  /** Not one of them: the This Mac row (Add to This Server) leads the list. */
  | { kind: "unattached"; host: LocalComputerHost; server: { slug: string; name: string } };

export function useThisDeviceListEntry(): ThisDeviceListEntry | null {
  const host = useLocalComputerHost();
  const server = useServerStore((s) => s.current);
  const machinesLoaded = useMachineStore((s) => !s.loading && s.loadStatus === "loaded");
  if (!host || !host.ready) return null;
  if (host.self.machineId !== null) return { kind: "attached", host, machineId: host.self.machineId };
  if (!server || host.self.management === null || !machinesLoaded) return null;
  return { kind: "unattached", host, server: { slug: server.slug, name: server.name } };
}
