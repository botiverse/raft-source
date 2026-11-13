import type { SidebarCollapsedSection, SidebarCollapsedSections } from "../../components/layout/sidebarCollapsedSections";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
// Returns `prev` untouched when every section is already open, so a route
// reveal never re-renders the Sidebar for nothing.
export function expandSidebarSections(
  prev: SidebarCollapsedSections,
  sections: SidebarCollapsedSection[],
): SidebarCollapsedSections {
  if (!sections.some((section) => prev[section])) return prev;
  const next = { ...prev };
  for (const section of sections) next[section] = false;
  return next;
}
// Stryker restore all
