import { SidebarList, SidebarSection, SidebarSectionChevron, SidebarSectionCount, SidebarSectionDisclosure, SidebarSectionHeader, SidebarSectionTitle } from "@botiverse/raft-ui";
import type { ReactNode } from "react";

/** Raft UI disclosure for one member kind on the drawer-internal roster
 * page. Both categories start expanded; the primitive owns keyboard/ARIA
 * state and chevron rotation, while filtering continues to own the live
 * count and whether an empty category is rendered at all. */
export function MemberPageSection({
  kind,
  label,
  count,
  children,
}: {
  /** "viewer-server" / "other-servers": a computed joint roster's groups. */
  kind: "invited" | "humans" | "agents" | "external" | "viewer-server" | "other-servers";
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <SidebarSection
      defaultOpen
      data-testid={`member-page-section-${kind}-group`}
    >
      <SidebarSectionHeader className="w-full!">
        <SidebarSectionDisclosure
          data-testid={`member-page-section-${kind}-toggle`}
        >
          <SidebarSectionChevron className="md:pointer-fine:hidden" />
          <span
            className="flex min-w-0 items-center"
            data-testid={`member-page-section-${kind}`}
          >
            <SidebarSectionTitle>{label}</SidebarSectionTitle>
            <SidebarSectionCount>{" · "}{count}</SidebarSectionCount>
          </span>
        </SidebarSectionDisclosure>
        {/* With a mouse the chevron is the header's last control (stdrc, 2026-11-05, option B). */}
        <SidebarSectionDisclosure aria-hidden tabIndex={-1} className="hidden size-6 flex-none justify-center md:pointer-fine:flex">
          <SidebarSectionChevron />
        </SidebarSectionDisclosure>
      </SidebarSectionHeader>
      <SidebarList data-testid={`member-page-section-${kind}-panel`}>
        {children}
      </SidebarList>
    </SidebarSection>
  );
}
