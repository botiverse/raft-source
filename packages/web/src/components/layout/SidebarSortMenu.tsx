import { useCallback, useMemo } from "react";
import type { Dispatch, MouseEvent, SetStateAction } from "react";
import { useIntl } from "react-intl";
import { ArrowDownUp } from "lucide-react";
import { Popover, PopoverTrigger, SidebarSectionControl } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import SelectionPopover from "../ui/SelectionPopover";
import type { SidebarSortMode } from "./sidebarSort";
import {
  SIDEBAR_SORT_LABEL_ID,
  SIDEBAR_SORT_MODES,
} from "../../features/sidebar/sections/sidebarSortSections";
import type { SidebarSortSection } from "../../features/sidebar/sections/sidebarSortSections";

export function SidebarSortMenu({
  section,
  value,
  onChange,
  open,
  setOpenSortMenu,
}: {
  section: SidebarSortSection;
  value: SidebarSortMode;
  onChange: (value: SidebarSortMode) => void;
  open: boolean;
  setOpenSortMenu: Dispatch<SetStateAction<SidebarSortSection | null>>;
}) {
  const { formatMessage } = useIntl();
  const options = useMemo(() => SIDEBAR_SORT_MODES.map((mode) => ({
    key: mode,
    checked: mode === value,
    label: formatMessage({ id: SIDEBAR_SORT_LABEL_ID[mode] }),
    onClick: () => {
      onChange(mode);
      setOpenSortMenu(null);
    },
  })), [formatMessage, onChange, setOpenSortMenu, value]);
  // One sort menu at a time: opening one replaces the other; a close only
  // clears the one that closed.
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpenSortMenu((current) => (nextOpen ? section : current === section ? null : current));
  }, [section, setOpenSortMenu]);
  // The button sits in the section header: its press must not also fold the
  // section.
  const stopHeaderToggle = useCallback((event: MouseEvent) => {
    event.stopPropagation();
  }, []);
  // Sidebar sort = single-select dropdown — delegated to SelectionPopover
  // so the ✓ position (right) and hover token (the DS menu's yellow-soft)
  // match the rest of the Selection family. stdrc 2026-05-25
  // #proj-theme:ac79cf20 msg=8fdf9cba + msg=b0b92c1c. Removes the older
  // hand-rolled `<button role="menuitemradio">` rows that put ✓ on the
  // left and used full-saturation `bg-palette-yellow` for both hover and
  // selected fill (Linear/Notion/GitHub/Figma all put ✓ on the right
  // for single-select dropdowns).
  // raft-ui Popover: the menu is placed in a portal against the button and
  // kept on screen; the popover owns the toggle, outside presses and Escape.
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip content={formatMessage(
          { id: "layout.sidebar.sortTitle" },
          { currentLabel: formatMessage({ id: SIDEBAR_SORT_LABEL_ID[value] }) },
        )}>
        <PopoverTrigger
          render={(
            <SidebarSectionControl
              type="button"
              aria-label={formatMessage({ id: "layout.sidebar.sortAria" })}
              data-testid="sidebar-sort-menu-button"
              data-sort-section={section}
              onClick={stopHeaderToggle}
            />
          )}
        >
          <ArrowDownUp />
        </PopoverTrigger>
      </Tooltip>
      <SelectionPopover
        title={formatMessage({ id: "layout.sidebar.sortMenuTitle" })}
        showHeader={false}
        align="end"
        className="min-w-[160px] py-1.5"
        options={options}
      />
    </Popover>
  );
}
