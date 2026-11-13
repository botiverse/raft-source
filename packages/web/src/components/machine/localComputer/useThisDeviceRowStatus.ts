// This device's status where a list shows a computer (the sidebar row, the
// Computers rack) and on its page's chip: one derived answer from the local
// host, which knows before the server does. While Raft Computer is not
// running here (stopped, not set up, being moved, …) the row says so in the
// page's words ("Stopped", "Update required") with the matching
// dot, never the server's last snapshot (a version, a green dot); likewise
// while the server still sees it offline but it is not simply running.
// Null for any other computer, or when the server's view is the right one.
import { useIntl } from "react-intl";
import type { Machine } from "../../../store/machineStore";
import { useLocalComputerHost } from "./useLocalComputerHost";
import { useLocalComputerMachineId } from "./localComputerStore";
import { thisDevicePresence, thisDeviceStatePhrase } from "./thisDeviceCopy";

export interface ThisDeviceRowStatus {
  label: string;
  presence: "online" | "busy" | "error" | "offline";
  /** Raft Computer does not run here: the server's "online" is stale. */
  notRunning: boolean;
}

export function useThisDeviceRowStatus(machine: Pick<Machine, "id" | "status"> | null | undefined): ThisDeviceRowStatus | null {
  const intl = useIntl();
  const host = useLocalComputerHost();
  const thisId = useLocalComputerMachineId();
  if (!machine || !host || !host.ready || thisId !== machine.id) return null;
  const { state, running } = host.self;
  const notRunning = !running;
  if (!notRunning && (machine.status === "online" || state.kind === "running")) return null;
  return {
    label: thisDeviceStatePhrase(state.kind, intl, state.flags.serviceRunning),
    presence: thisDevicePresence(state.kind, state.problem, state.flags.awaitingListing),
    notRunning,
  };
}
