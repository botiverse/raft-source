import { deferredModule } from "../../boot/deferredUi";

/**
 * The computer's detail (MachineDetailPanel), off the first download
 * (boot/deferredUi) and fetched in the background once the first screen is
 * done. One load for the side panel (ProfilePanel), the phone's page and the
 * search column (MainLayout), and the Computers page, which starts it when a
 * card is hovered or focused, so a click rarely waits on it.
 */
export const loadMachineDetailPanel = deferredModule(() => import("./MachineDetailPanel").then((module) => ({ default: module.MachineDetailPanel })));

/**
 * Starts the side panel's code and the detail's ahead of a click (a hover, a
 * focus), so the panel opens with the computer's head at once.
 */
export function preloadComputerPanel(): void {
  void import("../../components/profile/ProfilePanel").catch(() => {});
  void loadMachineDetailPanel().catch(() => {});
}
