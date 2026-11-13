import { SidebarSectionDisclosure } from "@botiverse/raft-ui";
import { useCallback, useContext } from "react";
import type { ButtonHTMLAttributes } from "react";
import { SidebarSectionDragHandleContext } from "./sidebarSectionDragHandleContext";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
// A collapsible section title (raft-ui SidebarSectionDisclosure) that is also
// the section's drag handle when the sections are sortable.
export function SidebarSectionToggle<K extends string>({
  children,
  sectionKey,
  onToggleSection,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className"> & {
  sectionKey: K;
  onToggleSection: (sectionKey: K) => void;
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
    </SidebarSectionDisclosure>
  );
}

// Stryker restore all
