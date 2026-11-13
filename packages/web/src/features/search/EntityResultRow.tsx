import { useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useIntl } from "react-intl";
import { Monitor } from "lucide-react";
import {
  Badge,
  Kbd,
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
  SearchEntityResultTitle,
} from "@botiverse/raft-ui";
import AgentActivityDot from "../../components/agent/AgentActivityDot";
import AppBadge from "../../components/agent/AppBadge";
import { useAppBotAgent } from "../../store/agentStore";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { ARCHIVED_CHANNEL_ICON_CLASS } from "../../components/channel/channelArchiveVisual";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { appBotEntitySubtitle, searchEntitySubtitleForQuery } from "./searchEntities";
import { formatEntitySubtitle } from "./searchLabels";
import { RETURN_KEY_GLYPH } from "./searchConstants";
import { SearchHighlight } from "./SearchHighlight";
import type { SearchSenderMember } from "./searchResultTypes";

/**
 * Destination (entity) row — shared by the overlay's exact-match head row and
 * the destinations section (task #102), so both render identically.
 */
export function EntityResultRow({
  result,
  query = "",
  returnHint,
  selected,
  returnedFrom = false,
  agentAvatarUrl,
  humanMember,
  onResultContextMenu,
  onResultClick,
}: {
  result: SearchEntityRecord;
  /** The search query: its hits are marked in the title and subtitle. */
  query?: string;
  returnHint: boolean;
  selected: boolean;
  /** The row a phone user just came back from: located (states.md#located). */
  returnedFrom?: boolean;
  agentAvatarUrl: string | null;
  humanMember: SearchSenderMember | undefined;
  onResultContextMenu: (event: ReactMouseEvent, result: SearchEntityRecord) => void;
  onResultClick: (event: ReactMouseEvent<HTMLButtonElement>, result: SearchEntityRecord) => void;
}) {
  const { formatMessage } = useIntl();
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => onResultContextMenu(event, result),
    [onResultContextMenu, result],
  );
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => onResultClick(event, result),
    [onResultClick, result],
  );
  const channelPinnedRef = result.type === "channel" && result.channelId
    ? { kind: "channel", id: result.channelId } as const
    : null;
  const isArchivedChannelResult = result.type === "channel" && !!result.archivedAt;
  // An App bot has no presence, and it is a Bot rather than an Agent: its row
  // shows the App badge in place of both, as its profile does, and its handle
  // rather than "Agent DM".
  const appBot = useAppBotAgent(result.type === "agentDm" ? result.agentId : null);
  const subtitle = appBotEntitySubtitle(searchEntitySubtitleForQuery(result, query), appBot);

  // The row frame, hover and selected states belong to rui's
  // SearchEntityResult, a list cell: no line between rows (raft-design
  // patterns/lists.md). The wrapper carries the row's test id,
  // keyboard-active marker and context menu.
  return (
    <div
      data-testid={channelPinnedRef ? `search-channel-result-${channelPinnedRef.id}` : undefined}
      data-active={selected ? "true" : undefined}
      onContextMenu={channelPinnedRef && !result.archivedAt ? handleContextMenu : undefined}
      className="relative flex w-full"
    >
      <SearchEntityResult
        type="button"
        onClick={handleClick}
        selected={selected}
        data-returned-from={returnedFrom ? "" : undefined}
        data-located={returnedFrom ? "" : undefined}
      >
        <SearchEntityResultLeading>
          {result.type === "channel" ? (
            <SearchEntityResultIcon
              className={isArchivedChannelResult ? ARCHIVED_CHANNEL_ICON_CLASS : undefined}
            >
              <ChannelIcon channelId={result.channelId} type={result.channelType ?? "channel"} />
            </SearchEntityResultIcon>
          ) : result.type === "computer" ? (
            <SearchEntityResultIcon>
              <Monitor size={14} aria-hidden="true" />
            </SearchEntityResultIcon>
          ) : result.type === "agentDm" ? (
            result.agentId ? (
              <AvatarSlot
                context="compact-row"
                type="agent"
                agentAvatarUrl={agentAvatarUrl}
                badge={appBot ? undefined : <AgentActivityDot agentId={result.agentId} />}
              />
            ) : (
              <AvatarSlot context="compact-row" type="agent" agentAvatarUrl={null} />
            )
          ) : result.userId ? (
            <AvatarSlot
              context="compact-row"
              type="human"
              humanAvatarUrl={humanMember?.avatarUrl}
            />
          ) : (
            <AvatarSlot context="compact-row" type="human" humanPlaceholder />
          )}
        </SearchEntityResultLeading>
        <SearchEntityResultContent>
          <SearchEntityResultHeader>
            <SearchEntityResultTitle className="truncate" muted={isArchivedChannelResult}>
              <SearchHighlight text={result.title} query={query} />
            </SearchEntityResultTitle>
            {/* The kind is a machine label after the name (DS `rf-tag`), not a
                coloured chip: identity comes from the tile/avatar. An App
                bot's kind is the App badge, in the same outline look. */}
            {appBot ? (
              <AppBadge appearance="outline" className="shrink-0" appName={appBot.managedByApp?.name} botName={result.title} />
            ) : (
              <Badge appearance="outline">
                {result.type === "channel" ? formatMessage({ id: "search.channel" }) : result.type === "computer" ? formatMessage({ id: "search.badgeComputer" }) : result.type === "agentDm" ? formatMessage({ id: "search.badgeAgent" }) : formatMessage({ id: "search.badgeHuman" })}
              </Badge>
            )}
            {result.archivedAt && (
              <Badge
                appearance={isArchivedChannelResult ? "outline" : "soft"}
                variant={isArchivedChannelResult ? undefined : "warning"}
              >
                {formatMessage({ id: "search.archived" })}
              </Badge>
            )}
          </SearchEntityResultHeader>
          <SearchEntityResultDescription muted={isArchivedChannelResult}>
            {/* Only real data (handles, descriptions) is marked, never a localized fallback label. */}
            {subtitle.kind === "text"
              ? <SearchHighlight text={subtitle.text} query={query} />
              : formatEntitySubtitle(subtitle, formatMessage)}
          </SearchEntityResultDescription>
        </SearchEntityResultContent>
        {returnHint && selected ? <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd> : null}
      </SearchEntityResult>
    </div>
  );
}
