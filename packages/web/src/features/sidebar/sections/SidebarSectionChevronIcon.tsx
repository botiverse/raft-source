import { ChevronRight } from "lucide-react";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
// The section's chevron: a bare 14px glyph (DS `.rf-section__title .rf-i`)
// that turns when the section is open.
// With a mouse on a desktop the chevron is the header's last control, at its
// end (raft-ui SidebarSectionEndChevron; stdrc, 2026-11-05, option B), so
// the one before the title shows on touch only.
export function SidebarSectionChevronIcon({ open }: { open: boolean }) {
  return <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""} md:pointer-fine:hidden`} />;
}
// Stryker restore all
