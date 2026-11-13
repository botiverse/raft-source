import { SidebarItem, SidebarItemIcon } from "@botiverse/raft-ui";
import { Pencil, Bookmark } from "lucide-react";
import { OttieRailAvatar } from "../../../assistant/OttieRailAvatar";
import { sidebarItemClass } from "./sidebarRowClasses";
import { SidebarCellList } from "./SidebarCellList";
import { SavedNavCount } from "./SavedNavCount";
import { DraftsNavCount } from "./DraftsNavCount";
import type { SidebarData } from "../hooks/useSidebarData";
import type { SidebarHomeEntriesState } from "../hooks/useSidebarHomeEntries";

// Below md every row is a phone list of places: raft-ui SidebarItem itself
// grows it to ≥44px in the ListRow title type (16/24 600), also with `wrap`
// (raft-design sidebar.md: no phone sizes at the callsite).
// Phone Home's first entries (Saved, Assistant) are ListRow entries
// (`.rf-row--entry`): ≥44px, a 20px ink-3 icon, the name, a count on the right,
// no lines between them and never a yellow "you are here".
const SIDEBAR_ENTRY_ROW_CLASS = "h-auto min-h-11 gap-3 py-2.5 text-body font-semibold";
const SIDEBAR_ENTRY_ICON_CLASS = "shrink-0 text-foreground-hint";

/**
 * Saved, Drafts and (phone Home) Assistant, the entries above the Chat sections.
 */
export function SidebarHomeEntries({ mobileInline, data, home }: {
  mobileInline: boolean | undefined;
  data: SidebarData;
  home: SidebarHomeEntriesState;
}) {
  const { formatMessage, savedTotal, location } = data;
  const {
    draftsEnabled, showDraftsEntry, openDrafts, openSaved, showAssistantEntry, openAssistantEntry,
  } = home;
  return (
    <SidebarCellList>
    <SidebarItem
      active={!mobileInline && location.pathname.endsWith("/saved")}
      onClick={openSaved}
      className={mobileInline ? SIDEBAR_ENTRY_ROW_CLASS : sidebarItemClass(location.pathname.endsWith("/saved"))}
      data-testid="sidebar-saved-entry"
    >
      {mobileInline ? (
        <Bookmark size={20} className={SIDEBAR_ENTRY_ICON_CLASS} />
      ) : (
        <SidebarItemIcon><Bookmark /></SidebarItemIcon>
      )}
      {formatMessage({ id: "layout.sidebar.saved" })}
      <SavedNavCount total={savedTotal} />
    </SidebarItem>

    {/* Drafts — every message started and not sent, in any
        conversation (#triage:#127). Under Saved, the same kind of
        row: a place of your own, with its gray count. */}
    {showDraftsEntry ? (
    <SidebarItem
      active={!mobileInline && location.pathname.endsWith("/drafts")}
      onClick={openDrafts}
      className={mobileInline ? SIDEBAR_ENTRY_ROW_CLASS : sidebarItemClass(location.pathname.endsWith("/drafts"))}
      data-testid="sidebar-drafts-entry"
    >
      {mobileInline ? (
        <Pencil size={20} className={SIDEBAR_ENTRY_ICON_CLASS} />
      ) : (
        <SidebarItemIcon><Pencil /></SidebarItemIcon>
      )}
      {formatMessage({ id: "layout.sidebar.drafts" })}
      {draftsEnabled ? <DraftsNavCount /> : null}
    </SidebarItem>
    ) : null}

    {/* Assistant — the rail's Assistant entry, as the second Home
        entry on the phone (a desktop rail destination that is a Home
        row, not a tab). Only where the server's
        personal_assistant flag is on. Ottie's face, as on the rail
        (Artea, #triage:#350). */}
    {mobileInline && showAssistantEntry && (
      <SidebarItem
        data-testid="mobile-home-assistant-entry"
        onClick={openAssistantEntry}
        className={SIDEBAR_ENTRY_ROW_CLASS}
      >
        {/* 24px in the entries' 20px icon column (-2px each side), so the
            name lines up with Saved's and Drafts'. */}
        <span className="-mx-0.5 shrink-0"><OttieRailAvatar size={24} /></span>
        {formatMessage({ id: "layout.sidebar.assistant" })}
      </SidebarItem>
    )}
    </SidebarCellList>
  );
}
