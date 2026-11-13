import FeedbackUnreadDot from "../../feedback/FeedbackUnreadDot";
import type { ReactNode } from "react";
import { SidebarGroupLabel, SidebarItem, SidebarItemContent, SidebarItemTitle } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";

export interface SettingsSidebarItem {
  id: string;
  label: string;
  /** The row's accessible name when the label alone repeats another row's
   *  (the server's Notifications next to the personal one). */
  ariaLabel?: string;
  icon: ReactNode;
  onClick?: () => void;
  /** A row with an href leaves Raft (Documentation): it opens in a new tab
   *  and ends in ↗ in the trailing slot. */
  href?: string;
  testId?: string;
  /** Trailing content before the row's end, e.g. an attention dot. */
  trailing?: ReactNode;
}

export interface SettingsSidebarGroup {
  /** The group's section title; a group without one (the phone's Members /
   *  Computers group at the top) shows its rows only and needs an `id`. */
  label?: string;
  id?: string;
  items: SettingsSidebarItem[];
}

/** The shared settings rows used inside the canonical AppShell sidebar:
 *  Personal / On {server} / Workspace / Resources groups, each under the DS section title
 *  (RUI SidebarGroupLabel). Rows are RUI SidebarItem, so the selected row is
 *  the yellow "you are here" sticker the sidebar recipe draws. External links
 *  keep anchor semantics via `render`, open in a new tab and end in ↗ in the
 *  row's trailing slot (raft-design navigation.md "Links that leave Raft"). */
export default function SettingsSidebarList({
  groups,
  activeId,
}: {
  groups: SettingsSidebarGroup[];
  activeId: string | null;
}) {
  const { formatMessage } = useIntl();
  return (
    <div data-testid="settings-sidebar-list">
      {groups.filter((group) => group.items.length > 0).map((group) => (
        <div key={group.id ?? group.label}>
          {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
          {/* A group's rows are a list of cells: 2px apart, 8px at its ends
              and under the group's label (raft-design patterns/lists.md). */}
          <div className="flex flex-col gap-0.5 py-2 md:pointer-fine:pt-1">
          {group.items.map((item) => {
            const selected = activeId === item.id;
            return (
              <SidebarItem
                key={item.id}
                active={selected}
                render={item.href ? (
                  // The render literal is empty by design: SidebarItem merges
                  // its children into this element. aria-label mirrors the
                  // visible label (and the ↗'s "opens in a new tab") for the
                  // anchor-has-content rule.
                  <a href={item.href} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, item.ariaLabel ?? item.label)} />
                ) : (
                  <button type="button" onClick={item.onClick} aria-label={item.ariaLabel ?? item.label} />
                )}
                data-testid={item.testId}
              >
                {/* The same parts as every sidebar row: the glyph in its 19px
                    icon box (the caller's SidebarItemIcon), the label on one
                    line with an ellipsis. */}
                {item.icon}
                <SidebarItemContent className="items-center">
                  <SidebarItemTitle>{item.label}</SidebarItemTitle>
                </SidebarItemContent>
                {item.trailing}
                {item.href && <LeavingRaftMark className="ml-auto size-3.5 text-foreground-hint" />}
                {item.id === "feedback" && <FeedbackUnreadDot className="ml-auto" />}
              </SidebarItem>
            );
          })}
          </div>
        </div>
      ))}
    </div>
  );
}
