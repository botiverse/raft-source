import { useCallback, useId, useMemo } from "react";
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
import { useStoredChannel } from "../../store/useStoredChannel";
import { ARCHIVED_CHANNEL_ICON_CLASS } from "../../components/channel/channelArchiveVisual";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import type { SearchEntityResult as SearchEntityRecord, SearchEntityStatus } from "./searchEntities";
import { appBotEntitySubtitle, isArchivedEntity, searchEntitySubtitleForQuery } from "./searchEntities";
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
  humanAvatarUrl,
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
  /** A person's avatar as core's search sent it; else the loaded member's. */
  humanAvatarUrl?: string | null;
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
  const archived = isArchivedEntity(result);
  const isArchivedChannelResult = result.type === "channel" && archived;
  // The server's status, drawn as it is (docs/contracts/web-search.md), as
  // one mark at most (raft-design badge.md): the group heading already says
  // the kind. A public channel the reader hasn't joined says so in its
  // description; opening it lands on its preview, whose footer has Join.
  const status = result.status;
  const notJoined = result.type === "channel" && status?.requiredAction === "join_channel";
  // Its name says "not joined" (aria-label); the description stays read, as the row's description.
  const descriptionId = useId();
  // An App bot has no presence, and it is a Bot rather than an Agent: its row
  // shows the App badge in place of both, as its profile does, and its handle
  // rather than "Agent DM".
  const appBot = useAppBotAgent(result.type === "agentDm" ? result.agentId : null);
  const subtitle = appBotEntitySubtitle(searchEntitySubtitleForQuery(result, query), appBot);
  // Not joined: the description tells what the channel is about before opening it, so show it even
  // when the query hit only the name (the query's snippet when it hit the description).
  const notJoinedDescription = !notJoined
    ? null
    : subtitle.kind === "text" && subtitle.text
      ? subtitle.text
      : result.type === "channel" && result.description ? result.description : null;

  // The row frame, hover and selected states belong to rui's
  // SearchEntityResult, a list cell: no line between rows (raft-design
  // patterns/lists.md). The wrapper carries the row's test id,
  // keyboard-active marker and context menu.
  return (
    <div
      data-testid={channelPinnedRef ? `search-channel-result-${channelPinnedRef.id}` : undefined}
      data-active={selected ? "true" : undefined}
      onContextMenu={channelPinnedRef && !archived ? handleContextMenu : undefined}
      className="relative flex w-full"
    >
      <SearchEntityResult
        type="button"
        onClick={handleClick}
        aria-label={notJoined ? formatMessage({ id: "search.notJoinedAria" }, { name: result.title }) : undefined}
        aria-describedby={notJoined ? descriptionId : undefined}
        selected={selected}
        data-returned-from={returnedFrom ? "" : undefined}
        data-located={returnedFrom ? "" : undefined}
      >
        <SearchEntityResultLeading>
          {result.type === "channel" ? (
            <SearchEntityResultIcon
              className={isArchivedChannelResult ? ARCHIVED_CHANNEL_ICON_CLASS : undefined}
            >
              <SearchChannelIcon channelId={result.channelId} type={result.channelType ?? "channel"} status={status} />
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
              humanAvatarUrl={humanAvatarUrl ?? humanMember?.avatarUrl}
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
            {/* One mark at most, in priority order. Channel: Archived, else
                External (a channel with Guests is External too: raft-design
                channel.md). Person: Agent, else Guest; an App bot's is the
                App badge. Computer: none. */}
            {appBot ? (
              <AppBadge appearance="outline" className="shrink-0" appName={appBot.managedByApp?.name} botName={result.title} />
            ) : isArchivedChannelResult ? (
              <Badge appearance="soft" variant="muted" data-testid="search-entity-archived">
                {formatMessage({ id: "search.archived" })}
              </Badge>
            ) : result.type === "channel" && (status?.external || status?.guest) ? (
              <Badge appearance="outline" data-testid="search-entity-external">{formatMessage({ id: "search.badgeExternal" })}</Badge>
            ) : result.type === "agentDm" ? (
              <Badge appearance="outline" data-testid="search-entity-agent">{formatMessage({ id: "search.badgeAgent" })}</Badge>
            ) : result.type === "humanDm" && status?.guest ? (
              <Badge appearance="outline" data-testid="search-entity-guest">{formatMessage({ id: "search.badgeGuest" })}</Badge>
            ) : null}
          </SearchEntityResultHeader>
          <SearchEntityResultDescription id={descriptionId} muted={isArchivedChannelResult}>
            {/* Only real data (handles, descriptions) is marked, never a localized fallback label.
                Not joined: the mark in ink, then the description if it has one (not the "Channel" fallback). */}
            {notJoined ? (
              <>
                <span className="text-foreground" data-testid="search-entity-not-joined">{formatMessage({ id: "search.notJoined" })}</span>
                {notJoinedDescription ? <>{" · "}<SearchHighlight text={notJoinedDescription} query={query} /></> : null}
              </>
            ) : subtitle.kind === "text"
              ? <SearchHighlight text={subtitle.text} query={query} />
              : formatEntitySubtitle(subtitle, formatMessage)}
          </SearchEntityResultDescription>
        </SearchEntityResultContent>
        {returnHint && selected ? <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd> : null}
      </SearchEntityResult>
    </div>
  );
}

/**
 * A channel row's kind icon, from the same chooser as every other surface
 * (channelKindIconProps). A row from core's search carries its status, so the
 * icon takes External from it (`external || guest`), not only from the store:
 * a channel known only from the server draws the external icon too.
 */
function SearchChannelIcon({ channelId, type, status }: {
  channelId: string | null;
  type: NonNullable<SearchEntityRecord["channelType"]>;
  status: SearchEntityStatus | undefined;
}) {
  const stored = useStoredChannel(status ? channelId : null);
  const external = status ? status.external || status.guest : false;
  const archived = status?.archived === true;
  const source = useMemo(() => ({
    type,
    hasExternalRelation: external,
    archivedAt: archived ? (stored?.archivedAt ?? "archived") : null,
    guestVisible: stored?.guestVisible,
    conversionJob: stored?.conversionJob ?? null,
  }), [archived, external, stored?.archivedAt, stored?.conversionJob, stored?.guestVisible, type]);
  if (!status) return <ChannelIcon channelId={channelId} type={type} />;
  return <ChannelIcon channel={source} />;
}
