// Where This device opens (design §4.1): the machine's own computer page
// when it is one of the current server's computers, otherwise the
// standalone /computers/this-device page. `section` opens Troubleshoot (the tray, the Dock menu, Help, a Computer notification).
import type { DesktopThisDeviceSection } from "@botiverse/raft-shared";

export const THIS_DEVICE_SEGMENT = "this-device";

export function thisDevicePath(serverSlug: string, machineId: string | null, section?: DesktopThisDeviceSection | null): string {
  const query = section ? `?section=${section}` : "";
  return machineId
    ? `/s/${serverSlug}/computer/${machineId}${query}`
    : `/s/${serverSlug}/computers/${THIS_DEVICE_SEGMENT}${query}`;
}

/** The `section` query parameter, when it names one. */
export function thisDeviceSectionParam(search: string): DesktopThisDeviceSection | null {
  const value = new URLSearchParams(search).get("section");
  return value === "troubleshoot" ? value : null;
}
