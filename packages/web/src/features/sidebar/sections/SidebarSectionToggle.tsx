import { SidebarSectionDisclosure } from "@botiverse/raft-ui";
import { useCallback, useContext } from "react";
import type { ButtonHTMLAttributes } from "react";
import { SidebarSectionDragHandleContext } from "./sidebarSectionDragHandleContext";
import { SidebarBrowserInUseMark } from "../rows/SidebarBrowserInUseMark";
import type { SidebarBrowserInUse } from "../rows/SidebarBrowserInUseMark";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
// A collapsible section title (raft-ui SidebarSectionDisclosure) that is also
// the section's drag handle when the sections are sortable. Folded, it can carry
// its hidden rows' browser mark (`browserInUse`, SidebarBrowserInUseMark) after
// the title and count.
export function SidebarSectionToggle<K extends string>({
  children,
  sectionKey,
  onToggleSection,
  browserInUse = null,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className"> & {
  sectionKey: K;
  onToggleSection: (sectionKey: K) => void;
  /** Folded: a hidden row's browser pages use a device or play sound. */
  browserInUse?: SidebarBrowserInUse | null;
}) {
  const sortable = useContext(SidebarSectionDragHandleContext);
  const handleClick = useCallback(() => onToggleSection(sectionKey), [onToggleSection, sectionKey]);
  return (
    <SidebarSectionDisclosure
      ref={sortable?.setActivatorNodeRef}
      render={<button type="button" />}
      className="cursor-default"
      {...sortable?.attributes}
      {...sortable?.listeners}
      {...props}
      onClick={handleClick}
    >
      {children}
      <SidebarBrowserInUseMark inUse={browserInUse} className="ml-1" />
    </SidebarSectionDisclosure>
  );
}

// Stryker restore all
