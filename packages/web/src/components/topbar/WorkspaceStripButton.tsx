import { memo, useCallback } from "react";
import { useIntl } from "react-intl";
import type { HTMLAttributes, MouseEvent } from "react";
import { Button, buttonVariants } from "@botiverse/raft-ui";
import type { AvatarBadgeOffset } from "@botiverse/raft-ui";
import AttentionDot from "../ui/AttentionDot";
import AvatarSlot from "../ui/AvatarSlot";
import AppTooltip from "../ui/Tooltip";
import { labelWithShortcut } from "../ui/LabelWithShortcut";
import { ON_FRAME_GHOST_BUTTON } from "./topBarClasses";
import type { Server } from "../../store/serverStore";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { getServerSwitcherTarget, openServerSwitcherAuxClickTarget } from "../../utils/serverSwitcherNavigation";
import { hostCanOpenNewWindow } from "../../utils/desktopBridge";

/** Unread dots on workspace avatars sit at the top-right corner (artin). */
export const WORKSPACE_UNREAD_BADGE_OFFSET: AvatarBadgeOffset = ["100%", 0];

/**
 * The avatar button's box with nothing in it, never shown: raft-ui sizes
 * Button `icon-md` by density (32px by touch, the 34px control height with a
 * mouse on a desktop), so the bar measures this to know a strip slot's width
 * whether the strip shows or not (useStripLayout). Not a <button>: it is no
 * control and must not count as one.
 */
const SLOT_PROBE_CLASS = buttonVariants({ variant: "ghost", size: "icon-md" }).root({ className: "pointer-events-none invisible absolute" });
export function WorkspaceStripSlotProbe() {
  return <span aria-hidden data-strip-slot-probe="" className={SLOT_PROBE_CLASS} />;
}

export const workspaceInitial = (server: Server) => (server.name || "S").trim().charAt(0).toUpperCase() || "S";

/**
 * One workspace avatar in the strip: the button, and its tooltip unless a drag is live. Memoized: the sortable avatar
 * around it renders on every pointer move while it is dragged.
 */
export const WorkspaceStripButton = memo(function WorkspaceStripButton({ server, isCurrent, hasUnread = false, otherUnread = false, shortcut, hideTooltip, onPick, dragProps }: {
  server: Server;
  isCurrent: boolean;
  /** Unread activity there: the dot is decorative, so the label says it. */
  hasUnread?: boolean;
  /** On the current workspace only: another workspace with nowhere in the
   *  strip to show its own dot has unread (the rail's server cell used to
   *  carry this one). */
  otherUnread?: boolean;
  /** Shown in the tooltip, a cap per key, where the host has such a shortcut (the desktop app's ⌘1…⌘9). */
  shortcut: ShortcutCombo | null;
  hideTooltip: boolean;
  onPick: (server: Server) => void;
  /** dnd-kit's attributes and listeners when the avatar is sortable. */
  dragProps?: HTMLAttributes<HTMLButtonElement>;
}) {
  const { formatMessage } = useIntl();
  // Middle-click and ⌘/Ctrl-click open the workspace in a new tab, as they do
  // on the switcher menu's rows (artin). A host without tabs (the desktop app
  // declares canOpenNewWindow: false) gets a plain switch for a modified click.
  const handleClick = useCallback((event: MouseEvent) => {
    if ((event.metaKey || event.ctrlKey) && hostCanOpenNewWindow()) {
      window.open(getServerSwitcherTarget(server.slug), "_blank", "noopener,noreferrer");
      return;
    }
    onPick(server);
  }, [onPick, server]);
  const handleAuxClick = useCallback((event: MouseEvent) => {
    openServerSwitcherAuxClickTarget(event, server.slug);
  }, [server]);
  const ownDot = hasUnread && !isCurrent;
  const currentDot = isCurrent && otherUnread;
  const label = ownDot
    ? formatMessage({ id: "ui.workspaceStrip.serverWithUnread" }, { name: server.name })
    : currentDot
      ? formatMessage({ id: "ui.workspaceStrip.currentWithOtherUnread" }, { name: server.name })
      : server.name;
  // The dot rides raft-ui's AvatarBadge (through AvatarSlot's badge slot): it
  // owns the corner, the size for the avatar's size and the stacking, so a
  // neighbouring avatar can no longer paint over it.
  const badge = ownDot || currentDot
    ? <AttentionDot aria-hidden data-testid={ownDot ? "workspace-strip-unread" : "app-top-bar-workspace-unread"} />
    : undefined;
  const button = (
    <Button
      variant="ghost"
      size="icon-md"
      className={ON_FRAME_GHOST_BUTTON}
      aria-label={label}
      aria-current={isCurrent ? "true" : undefined}
      data-current={isCurrent ? "true" : undefined}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      {...dragProps}
    >
      <AvatarSlot context="creator-link" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={workspaceInitial(server)} badge={badge} badgeOffset={WORKSPACE_UNREAD_BADGE_OFFSET} />
    </Button>
  );
  if (hideTooltip) return button;
  return <AppTooltip content={shortcut ? labelWithShortcut(server.name, shortcut, formatMessage) : server.name}>{button}</AppTooltip>;
});
