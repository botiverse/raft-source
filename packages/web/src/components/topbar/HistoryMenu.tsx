// The top bar's History menu (task #127, Slack's 🕘): the conversations the
// user was in most recently, most recent first, as a raft-ui DropdownMenu.
//
// The list is the web's own recent-conversation resolution
// (useRecentConversationEntities — the same visit store and destination catalog
// the ⌘K overlay's empty state uses), restricted to places actually visited
// (no activity fill) and excluding the conversation on screen. Each row leads
// with the web's RecentConversationLeading: its identity primitives
// (ChannelKindIcon / AvatarSlot, so a channel, an agent DM and a human DM look
// exactly as they do everywhere else) inside one fixed leading slot, so icon
// rows and avatar rows share a glyph centre line and every title starts at the
// same x.
//
// The trigger is a raft-ui icon Button owned here (composition rule: the caller
// owns the trigger, the content is structural). While open, the raft-ui popup's
// `data-open` makes the layer guard flip the title bar to no-drag (task #121).

import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { History as HistoryIcon } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemLabel,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@botiverse/raft-ui";
import AppTooltip from "../ui/Tooltip";
import { RecentConversationLeading } from "../../features/search/RecentConversationLeading";
import { conversationChannelIdFromPath } from "../../features/search/recentConversations";
import { useRecentConversationEntities } from "../../features/search/useRecentConversationEntities";
import type { SearchEntityResult } from "../../features/search/searchEntities";
import { useAppNavigate } from "../../hooks/useAppNavigate";

export const HISTORY_MENU_TRIGGER_TESTID = "desktop-history-trigger";
export const HISTORY_MENU_TESTID = "desktop-history-menu";

function HistoryMenuRow({ entity, onOpen }: { entity: SearchEntityResult; onOpen: (entity: SearchEntityResult) => void }) {
  const handleClick = useCallback(() => onOpen(entity), [entity, onOpen]);
  return (
    <DropdownMenuItem onClick={handleClick} data-testid={`desktop-history-item-${entity.channelId}`}>
      <RecentConversationLeading entity={entity} />
      <DropdownMenuItemLabel className="truncate">{entity.title}</DropdownMenuItemLabel>
    </DropdownMenuItem>
  );
}

export function HistoryMenu() {
  const { formatMessage } = useIntl();
  const location = useLocation();
  const nav = useAppNavigate();
  const recent = useRecentConversationEntities({
    excludeChannelId: conversationChannelIdFromPath(location.pathname),
    fillFromActivity: false,
  });
  const label = formatMessage({ id: "desktop.history.menu", defaultMessage: "History" });

  const open = useCallback((entity: SearchEntityResult) => {
    if (!entity.channelId) return;
    if (entity.type === "channel") nav.toChannel(entity.channelId, { sidebarFocus: "center" });
    else nav.toDm(entity.channelId);
  }, [nav]);

  return (
    <DropdownMenu>
      <AppTooltip content={label}>
        <DropdownMenuTrigger
          render={(
            <Button variant="on-frame" size="icon-md" aria-label={label} data-testid={HISTORY_MENU_TRIGGER_TESTID}>
              <HistoryIcon aria-hidden />
            </Button>
          )}
        />
      </AppTooltip>
      {/* DS Menu: 240 wide (raft-ui's own width, fixed so a long title
          truncates instead of widening the menu). */}
      <DropdownMenuContent side="bottom" align="start" sideOffset={4} aria-label={label} data-testid={HISTORY_MENU_TESTID} className="w-60">
        <DropdownMenuLabel>{formatMessage({ id: "search.overlay.recentConversations", defaultMessage: "Recent conversations" })}</DropdownMenuLabel>
        {recent.length === 0 ? (
          <DropdownMenuItem disabled data-testid="desktop-history-empty">
            <DropdownMenuItemLabel>{formatMessage({ id: "desktop.history.empty", defaultMessage: "No recent conversations yet" })}</DropdownMenuItemLabel>
          </DropdownMenuItem>
        ) : (
          recent.map((entity) => <HistoryMenuRow key={entity.key} entity={entity} onOpen={open} />)
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
