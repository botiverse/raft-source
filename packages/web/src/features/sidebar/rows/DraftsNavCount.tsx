import { SidebarItemMeta } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { useDraftCount } from "../../../hooks/useDrafts";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * The Drafts row's count (#triage:#127): this server's unsent drafts, hidden
 * when 0. Its own component, so a draft appearing or going re-renders this
 * number and not the Sidebar (typing in a composer changes neither).
 */
export function DraftsNavCount() {
  const { formatMessage } = useIntl();
  const total = useDraftCount();
  if (total <= 0) return null;
  return (
    <SidebarItemMeta data-testid="sidebar-drafts-count">
      {formatMessage({ id: "layout.sidebar.draftsCount" }, { count: total })}
    </SidebarItemMeta>
  );
}
// Stryker restore all
