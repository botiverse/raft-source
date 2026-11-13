import { useCallback } from "react";
import type { ExternalInviteEntry } from "../../../analytics/externalInvites";
import { useOpenAddComputer } from "../../../components/machine/localComputer/useOpenAddComputer";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";

/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * Openers of the create-channel and add-computer dialogs, from section
 * buttons and menus.
 */
export function useSidebarCreateActions(data: SidebarData, view: SidebarViewState) {
  const { setShowCreateChannel, setShowCreateJointChannel } = data;
  const { setSectionCtxMenu, canCreateJointChannel, gateExternalCreate, setOpenSortMenu } = view;

  const openCreateChannelDialog = useCallback(() => {
    setSectionCtxMenu(null);
    setShowCreateChannel(true);
  }, []);

  // The External section's "+" and both menus' Create External Channel open
  // it with their entry (Nova's external_invite_opened); the Free plan's one
  // external channel taken: the upgrade dialog instead (gateExternalCreate).
  const openCreateJointChannel = useCallback((entry: ExternalInviteEntry) => {
    if (!canCreateJointChannel) return;
    setSectionCtxMenu(null);
    gateExternalCreate(() => setShowCreateJointChannel(entry));
  }, [canCreateJointChannel, gateExternalCreate]);
  // The External section's menu.
  const openCreateJointChannelDialog = useCallback(() => openCreateJointChannel("sidebar_section_menu"), [openCreateJointChannel]);

  // Section-header action handlers. Stable references: raft-ui's
  // SidebarSectionControl is a component, not a DOM button.
  const openCreateChannelFromSectionButton = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setOpenSortMenu(null);
    openCreateChannelDialog();
  }, [openCreateChannelDialog]);
  const openCreateJointChannelFromSectionButton = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setOpenSortMenu(null);
    openCreateJointChannel("sidebar_section_button");
  }, [openCreateJointChannel]);
  // Add Computer asks where the computer is first (useOpenAddComputer).
  const openAddMachineDialog = useOpenAddComputer();
  return {
    openCreateChannelDialog, openCreateJointChannelDialog, openCreateChannelFromSectionButton,
    openCreateJointChannelFromSectionButton, openAddMachineDialog,
  };
}

export type SidebarCreateActions = ReturnType<typeof useSidebarCreateActions>;
