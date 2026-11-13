import { SidebarSectionCount } from "@botiverse/raft-ui";
import { useThisDeviceListEntry } from "../../../components/machine/localComputer/useThisDeviceListEntry";

/** The Computers heading's count: the rows below it, This Mac's included. */
export function ComputersSectionCount({ count }: { count: number }) {
  const entry = useThisDeviceListEntry();
  return <SidebarSectionCount>{count + (entry?.kind === "unattached" ? 1 : 0)}</SidebarSectionCount>;
}
