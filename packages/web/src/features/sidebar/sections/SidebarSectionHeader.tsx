import { SidebarSection, SidebarSectionHeader as RaftSidebarSectionHeader } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { ReactNode } from "react";
import type { SectionCtxMenu } from "../sidebarContextMenu";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
// A section's header, its chevron at the end with a mouse (raft-ui
// `chevronAtEnd` and SidebarSectionEndChevron, stdrc option B). The section's
// open state is ours (persisted, and the rows are a dnd container, not a
// Collapsible panel), so the header alone sits in a controlled raft-ui
// SidebarSection: the end chevron is its trigger and turns with `open`. A
// plain block around the header, so neither its layout nor its controls'
// end alignment move.
export function SidebarSectionHeader<K extends string>({
  children,
  section,
  onOpenContextMenu,
  sectionKey,
  open,
  onToggleSection,
}: {
  children: ReactNode;
  section?: SectionCtxMenu["section"];
  onOpenContextMenu?: (event: React.MouseEvent<HTMLDivElement>, section: SectionCtxMenu["section"]) => void;
  sectionKey: K;
  open: boolean;
  onToggleSection: (sectionKey: K) => void;
}) {
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (section && onOpenContextMenu) onOpenContextMenu(event, section);
    },
    [onOpenContextMenu, section],
  );
  const handleOpenChange = useCallback(() => onToggleSection(sectionKey), [onToggleSection, sectionKey]);
  return (
    <SidebarSection open={open} onOpenChange={handleOpenChange} render={<div />}>
      <RaftSidebarSectionHeader chevronAtEnd onContextMenu={section ? handleContextMenu : undefined}>
        {children}
      </RaftSidebarSectionHeader>
    </SidebarSection>
  );
}
// Stryker restore all
