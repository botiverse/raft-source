import { useMemo } from "react";
import { SidebarSection, SidebarSectionDisclosure, SidebarSectionHeader, SidebarSectionTitle } from "@botiverse/raft-ui";
import { SkeletonTextBar } from "../../../components/ui/Skeleton";
import { readSidebarEntryShown, readSidebarSectionRowCounts } from "../../../components/layout/sidebarSectionRowCounts";
import { readSidebarCollapsedSections } from "../../../components/layout/sidebarCollapsedSections";
import { useAppearanceStore } from "../../../store/appearanceStore";
import { SidebarCellList } from "../rows/SidebarCellList";
import { SIDEBAR_SECTION_EMPTY_ROWS_CLASS, SIDEBAR_SECTION_ROWS_CLASS } from "../rows/sidebarRowClasses";
import { SidebarRowsSkeleton } from "../rows/SidebarRowsSkeleton";
import { SidebarPinnedEmptyHint } from "./SidebarPinnedEmptyHint";
import { SidebarJointEmptyLine } from "./SidebarJointEmptyLine";
import { SidebarSectionChevronIcon } from "./SidebarSectionChevronIcon";

/**
 * One Chat section while the server loads: raft-ui's section head (the
 * loaded head's SidebarSection, SidebarSectionHeader with its chevron at the
 * end, the disclosure's line with a bar in the title) over the column the
 * loaded section's rows are in (SIDEBAR_SECTION_ROWS_CLASS, SidebarDndContainer's),
 * with skeleton rows or Pinned's empty hint's box in it. A section the
 * person folded is its head alone, folded, as the loaded one is.
 */
function SectionSkeleton({ testId, children, empty, collapsed }: { testId: string; children: React.ReactNode; empty: boolean; collapsed: boolean }) {
  return (
    <div data-testid={testId} data-collapsed={collapsed ? "" : undefined}>
      <SidebarSection open={!collapsed} render={<div />}>
        <SidebarSectionHeader chevronAtEnd>
          <SidebarSectionDisclosure render={<div />} type={undefined}>
            <SidebarSectionChevronIcon open={!collapsed} />
            <SidebarSectionTitle><SkeletonTextBar className="w-20" /></SidebarSectionTitle>
          </SidebarSectionDisclosure>
        </SidebarSectionHeader>
      </SidebarSection>
      {collapsed ? null : (
        <div data-section-rows="" className={empty ? `${SIDEBAR_SECTION_ROWS_CLASS} ${SIDEBAR_SECTION_EMPTY_ROWS_CLASS}` : SIDEBAR_SECTION_ROWS_CLASS}>{children}</div>
      )}
    </div>
  );
}

/**
 * The Chat sidebar while its server is still on its way (PendingServerLayout
 * and the boot shell prerendered from it): the loaded sidebar's shape, so its
 * rows replace these without moving (skeleton-vs-layout audit,
 * #proj-raft-ui:#231). Saved (and Drafts, and on a phone Assistant, when they
 * showed last time here) in the entries' list of cells, then the system
 * sections in their default order, each with as many rows as it had the last
 * time it loaded on this server (sidebarSectionRowCounts) or the loaded
 * Sidebar's own defaults; Pinned with none keeps its empty hint's box, as the
 * loaded Sidebar does while its pins are read, and Joint Channels with none
 * keeps its empty line's box (the loaded Sidebar draws that section, empty or
 * not, unless empty sections are hidden; with external channels on, or with
 * empty sections hidden for someone who may create one, the server's answer
 * decides, not known yet: the default case is drawn). Custom sections and a
 * custom order are the server's, not known yet either. Without a person or a server (the prerendered shell) every section
 * takes its default. A section the person folded stays folded: the loaded
 * Sidebar reads the same per-person setting (sidebarCollapsedSections) on
 * every server, so this one does too.
 */
export function PendingSidebarSkeleton({ userId, serverId, phone }: {
  userId: string | null | undefined;
  serverId: string | null | undefined;
  /** Phone Home: Assistant is one of its entries. */
  phone: boolean;
}) {
  const remembered = useMemo(() => readSidebarSectionRowCounts(userId, serverId), [userId, serverId]);
  const entries = useMemo(() => 1
    + (readSidebarEntryShown(userId, serverId, "drafts") === true ? 1 : 0)
    + (phone && readSidebarEntryShown(userId, serverId, "assistant") === true ? 1 : 0), [userId, serverId, phone]);
  const collapsed = useMemo(() => readSidebarCollapsedSections(userId ?? undefined), [userId]);
  const hideEmpty = useAppearanceStore((s) => s.hideEmptySidebarSections);
  const pinned = remembered.pinned ?? 0;
  const joint = remembered.jointChannels ?? 2;
  const channels = remembered.channels ?? 4;
  const dms = remembered.dms ?? 3;
  return (
    <div aria-busy="true" data-testid="pending-sidebar-skeleton">
      <SidebarCellList>
        <SidebarRowsSkeleton lead="icon" rows={entries} />
      </SidebarCellList>
      <div className="flex flex-col">
        {hideEmpty && pinned === 0 ? null : (
          <SectionSkeleton testId="pending-sidebar-section-pinned" empty={pinned === 0} collapsed={collapsed.pinned}>
            {pinned > 0 ? <SidebarRowsSkeleton rows={pinned} /> : <SidebarPinnedEmptyHint reserved />}
          </SectionSkeleton>
        )}
        {hideEmpty && joint === 0 ? null : (
          <SectionSkeleton testId="pending-sidebar-section-joint" empty={joint === 0} collapsed={collapsed.jointChannels}>
            {joint > 0 ? <SidebarRowsSkeleton lead="icon" rows={joint} /> : <SidebarJointEmptyLine external={false} reserved />}
          </SectionSkeleton>
        )}
        <SectionSkeleton testId="pending-sidebar-section-channels" empty={channels === 0} collapsed={collapsed.channels}>
          <SidebarRowsSkeleton lead="icon" rows={channels} />
        </SectionSkeleton>
        {hideEmpty && dms === 0 ? null : (
          <SectionSkeleton testId="pending-sidebar-section-dms" empty={dms === 0} collapsed={collapsed.agents}>
            <SidebarRowsSkeleton rows={dms} />
          </SectionSkeleton>
        )}
      </div>
    </div>
  );
}
