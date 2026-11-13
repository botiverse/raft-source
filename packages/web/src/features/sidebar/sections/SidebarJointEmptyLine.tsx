import { useIntl } from "react-intl";
import { SidebarSectionDescription } from "./SidebarSectionDescription";

/**
 * The Joint Channels (External) section's empty line ("No joint channels
 * yet"): the rows' 8px above and below, in the hint color, as Pinned's and
 * raft-ui's SidebarSectionEmpty (cindyz, #wg-rbac:db936076: the two lines sat
 * differently). `reserved`: its box only, invisible and hidden from assistive
 * technology, for a section that is still loading with no rows to draw (none
 * last time here): the line is what most likely lands there, so the sections
 * below keep their place instead of moving down by its height once the
 * channels are read (skeleton-vs-layout audit round 2, as SidebarPinnedEmptyHint).
 */
export function SidebarJointEmptyLine({ external, reserved = false }: { external: boolean; reserved?: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <SidebarSectionDescription
      data-testid={reserved ? "sidebar-joint-empty-line-reserved" : "sidebar-joint-empty-line"}
      aria-hidden={reserved || undefined}
      tone="subtle"
      className={reserved ? "py-2 invisible" : "py-2"}
    >
      {formatMessage({ id: external ? "layout.sidebar.externalEmpty" : "layout.sidebar.jointChannelsEmpty" })}
    </SidebarSectionDescription>
  );
}
