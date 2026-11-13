import { ContextMenuLabel, ContextMenuPopup } from "@botiverse/raft-ui";
import { createPortal } from "react-dom";
import { Plus, Trash2, Pencil, GitBranch, Check, FolderPlus } from "lucide-react";
import { ExternalChannelIcon } from "../../../components/channel/channelKindIcon";
import ContextMenuDivider from "../../../components/ui/ContextMenuDivider";
import MenuItem from "../../../components/ui/MenuItem";
import DismissBackdrop from "../../../components/ui/DismissBackdrop";
import { SectionSortModeMenuItem } from "../../../components/layout/SectionSortModeMenuItem";
import { getSidebarContextMenuStyle, stopSidebarContextMenuPropagation } from "../sidebarContextMenu";
import { SIDEBAR_SORT_MODES, SIDEBAR_SORT_SECTION_LABEL_ID } from "../sections/sidebarSortSections";
import type { SidebarSortSection } from "../sections/sidebarSortSections";
import type { SidebarData } from "../hooks/useSidebarData";
import type { SidebarViewState } from "../hooks/useSidebarViewState";
import type { SidebarSync } from "../hooks/useSidebarSync";
import type { SidebarCreateActions } from "../hooks/useSidebarCreateActions";
import type { SidebarItems } from "../hooks/useSidebarItems";
import type { SidebarMenuActions } from "../hooks/useSidebarMenuActions";

/**
 * A section header's context menu: create, sort, display choices and the
 * custom-section actions.
 */
export function SidebarSectionContextMenu({ data, view, sync, createActions, items, menuActions }: {
  data: SidebarData;
  view: SidebarViewState;
  sync: SidebarSync;
  createActions: SidebarCreateActions;
  items: SidebarItems;
  menuActions: SidebarMenuActions;
}) {
  const { formatMessage, externalChannelsEnabled } = data;
  const {
    sectionCtxMenu, sectionCtxMenuRef, canCreateChannel, canCreateJointChannel, channelSortMode,
    jointChannelSortMode, dmSortMode, pinnedSortMode, joinedChannelsOnly, hideEmptySections,
  } = view;
  const { closeSectionCtx } = sync;
  const { openCreateChannelDialog, openCreateJointChannelDialog } = createActions;
  const { jointSectionLabelId } = items;
  const {
    contextCustomSection, selectSectionSortMode, toggleJoinedChannelsOnlyFromMenu,
    toggleHideEmptySectionsFromMenu, renameContextSection, createSectionFromSectionMenu,
    deleteContextSection,
  } = menuActions;

  const sectionContextLabel = contextCustomSection?.name
    ?? (
      sectionCtxMenu && !sectionCtxMenu.section.startsWith("custom:")
        ? formatMessage({ id: sectionCtxMenu.section === "jointChannels" ? jointSectionLabelId : SIDEBAR_SORT_SECTION_LABEL_ID[sectionCtxMenu.section as SidebarSortSection] })
        : "Section"
    );
  return (
    <>
      {sectionCtxMenu && createPortal(
        <>
          <DismissBackdrop onDismiss={closeSectionCtx} trapContextMenu />
          <ContextMenuPopup
            ref={sectionCtxMenuRef}
            role="menu"
            aria-label={formatMessage(
              { id: "layout.sidebar.sectionOptionsAria" },
              { section: sectionContextLabel },
            )}
            data-testid={`sidebar-section-context-menu-${sectionCtxMenu.section}`}
            className="fixed z-popup w-60 select-none"
            style={getSidebarContextMenuStyle(sectionCtxMenu)}
            onMouseDown={stopSidebarContextMenuPropagation}
          >
            {sectionCtxMenu.section === "channels" && canCreateChannel && (
              <>
                <MenuItem
                  icon={<Plus size={14} />}
                  onClick={openCreateChannelDialog}
                >
                  {formatMessage({ id: "layout.sidebar.createChannel" })}
                </MenuItem>
                <ContextMenuDivider />
              </>
            )}
            {sectionCtxMenu.section === "jointChannels" && canCreateJointChannel && (
              <>
                <MenuItem
                  icon={externalChannelsEnabled ? <ExternalChannelIcon size={14} /> : <GitBranch size={14} />}
                  onClick={openCreateJointChannelDialog}
                >
                  {formatMessage({ id: externalChannelsEnabled ? "layout.sidebar.createExternalChannel" : "layout.sidebar.createJointChannel" })}
                </MenuItem>
                <ContextMenuDivider />
              </>
            )}
            <ContextMenuLabel>
              {formatMessage({ id: "layout.sidebar.sortMenuTitle" })}
            </ContextMenuLabel>
            {SIDEBAR_SORT_MODES.map((mode) => {
              const currentMode = contextCustomSection?.sortMode ?? (sectionCtxMenu.section === "pinned" ? pinnedSortMode
                : sectionCtxMenu.section === "jointChannels" ? jointChannelSortMode
                  : sectionCtxMenu.section === "channels" ? channelSortMode
                    : dmSortMode);
              return (
                <SectionSortModeMenuItem
                  key={mode}
                  mode={mode}
                  checked={mode === currentMode}
                  onSelect={selectSectionSortMode}
                />
              );
            })}
            <ContextMenuDivider />
            <ContextMenuLabel>
              {formatMessage({ id: "layout.sidebar.displaySection" })}
            </ContextMenuLabel>
            {sectionCtxMenu.section === "channels" && (
              <MenuItem
                role="menuitemcheckbox"
                aria-checked={joinedChannelsOnly}
                trailing={joinedChannelsOnly ? <Check size={16} /> : null}
                className={joinedChannelsOnly ? "font-bold" : ""}
                onClick={toggleJoinedChannelsOnlyFromMenu}
              >
                {formatMessage({ id: "layout.sidebar.showJoinedChannelsOnly" })}
              </MenuItem>
            )}
            <MenuItem
              role="menuitemcheckbox"
              aria-checked={hideEmptySections}
              trailing={hideEmptySections ? <Check size={16} /> : null}
              className={hideEmptySections ? "font-bold" : ""}
              onClick={toggleHideEmptySectionsFromMenu}
            >
              {formatMessage({ id: "layout.sidebar.hideEmptySections" })}
            </MenuItem>
            <ContextMenuDivider />
            {contextCustomSection && (
              <>
                <MenuItem
                  icon={<Pencil size={14} />}
                  onClick={renameContextSection}
                >
                  {formatMessage({ id: "layout.sidebar.renameSection" })}
                </MenuItem>
              </>
            )}
            <MenuItem
              icon={<FolderPlus size={14} />}
              onClick={createSectionFromSectionMenu}
            >
              {formatMessage({ id: "layout.sidebar.newSectionMenu" })}
            </MenuItem>
            {contextCustomSection && (
              <>
                <ContextMenuDivider />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  className="text-danger-strong"
                  onClick={deleteContextSection}
                >
                  {formatMessage({ id: "layout.sidebar.deleteSection" })}
                </MenuItem>
              </>
            )}
          </ContextMenuPopup>
        </>,
        document.body,
      )}
    </>
  );
}
