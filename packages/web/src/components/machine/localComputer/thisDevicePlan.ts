// This device's actions (thisDeviceLogic.ts › thisDeviceActions) for the host
// as useLocalComputerHost reports it: the page (ThisDeviceSections) and the
// Computers row (ThisDeviceRackAction) ask the same table.
import type { LocalComputerHost } from "./useLocalComputerHost";
import { CHECKING_STALL_MS, thisDeviceActions } from "./thisDeviceLogic";
import type { ThisDeviceActionPlan } from "./thisDeviceLogic";

export function thisDevicePlanFor(host: LocalComputerHost, variant: "embedded" | "standalone", options: {
  /** Add to this server can run from here (a current server, the state calls for it). */
  canAdd: boolean;
  checkingStalled?: boolean;
}): ThisDeviceActionPlan {
  const { self } = host;
  return thisDeviceActions(self.state, {
    hostState: self.host,
    management: self.management,
    running: self.running,
    canAdd: options.canAdd,
    can: {
      updateComputer: host.updateComputer !== null,
      retryMigration: host.retryMigration !== null,
      runDiagnostics: host.runDiagnostics !== null,
      openLogs: (host.openComputerLogs ?? host.openDesktopLogs) !== null,
      retryRead: host.retryRead !== null,
    },
    checkingStalled: options.checkingStalled === true && self.state.kind === "checking",
  }, variant, self.host?.installSupported ?? true, self.host?.capabilities ?? null);
}

/** Add to this server applies: a current server, it can install or is installed, and it is not added here yet. */
export function thisDeviceCanAdd(host: LocalComputerHost, currentServer: { slug: string } | null): boolean {
  const { state } = host.self;
  return currentServer !== null && host.canAttach && (state.kind === "not-installed" || state.flags.notAttachedHere);
}

/** How long "Checking…" lasts before the page says the status is unknown. */
export function checkingStallMs(): number {
  return CHECKING_STALL_MS;
}
