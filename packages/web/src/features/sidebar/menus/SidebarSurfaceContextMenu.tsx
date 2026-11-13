import { ContextMenuPopup } from "@botiverse/raft-ui";
import { createPortal } from "react-dom";
import { Plus, GitBranch, FolderPlus } from "lucide-react";
import { ExternalChannelIcon } from "../../../components/channel/channelKindIcon";
import ContextMenuDivider from "../../../components/ui/ContextMenuDivider";
import MenuItem from "../../../components/ui/MenuItem";
import DismissBackdrop from "../../../components/ui/DismissBackdrop";
import { getSidebarContextMenuStyle, stopSidebarContextMenuPropagation } from "../sidebarContextMenu";
import type { SidebarData } from "../hooks/useSidebarData";
import type { SidebarViewState } from "../hooks/useSidebarViewState";
import type { SidebarSync } from "../hooks/useSidebarSync";
import type { SidebarMenuActions } from "../hooks/useSidebarMenuActions";

/**
 * The context menu of the Chat list's empty surface: create a channel, a joint
 * channel or a section.
 */
export function SidebarSurfaceContextMenu({ data, view, sync, menuActions }: {
  data: SidebarData;
  view: SidebarViewState;
  sync: SidebarSync;
  menuActions: SidebarMenuActions;
}) {
  const { formatMessage, externalChannelsEnabled } = data;
  const { sidebarSurfaceCtxMenu, sidebarSurfaceCtxMenuRef, canManageServer, canCreateJointChannel } = view;
  const { closeSidebarSurfaceCtx } = sync;
  const {
    createChannelFromSurfaceMenu, createJointChannelFromSurfaceMenu, createSectionFromSurfaceMenu,
  } = menuActions;
  return (
    <>
      {sidebarSurfaceCtxMenu && createPortal(
        <>
          <DismissBackdrop onDismiss={closeSidebarSurfaceCtx} trapContextMenu />
          <ContextMenuPopup
            ref={sidebarSurfaceCtxMenuRef}
            role="menu"
            aria-label={formatMessage({ id: "layout.sidebar.sidebarOptionsAria" })}
            data-testid="sidebar-surface-context-menu"
            className="fixed z-popup w-60 select-none"
            style={getSidebarContextMenuStyle(sidebarSurfaceCtxMenu)}
            onMouseDown={stopSidebarContextMenuPropagation}
          >
            {canManageServer && (
              <MenuItem
                icon={<Plus size={14} />}
                onClick={createChannelFromSurfaceMenu}
              >
                {formatMessage({ id: "layout.sidebar.createChannel" })}
              </MenuItem>
            )}
            {canCreateJointChannel && (
              <MenuItem
                icon={externalChannelsEnabled ? <ExternalChannelIcon size={14} /> : <GitBranch size={14} />}
                onClick={createJointChannelFromSurfaceMenu}
              >
                {formatMessage({ id: externalChannelsEnabled ? "layout.sidebar.createExternalChannel" : "layout.sidebar.createJointChannel" })}
              </MenuItem>
            )}
            {(canManageServer || canCreateJointChannel) && <ContextMenuDivider />}
            <MenuItem
              icon={<FolderPlus size={14} />}
              onClick={createSectionFromSurfaceMenu}
            >
              {formatMessage({ id: "layout.sidebar.newSectionMenu" })}
            </MenuItem>
          </ContextMenuPopup>
        </>,
        document.body,
      )}
    </>
  );
}
