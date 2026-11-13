import type { ReactElement } from "react";
import { useId, useState, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { ChevronRight, UserPlus } from "lucide-react";
import {
  TooltipProvider,
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowGroup,
  ListRowTitle,
  ListRowValue,
  Skeleton,
} from "@botiverse/raft-ui";
import { agentStatusFallbackActivity } from "../agent/channelMemberParts";
import AgentActivityDot from "../agent/AgentActivityDot";
import type { ChannelAgent, ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import AvatarSlot from "../ui/AvatarSlot";
import Tooltip from "../ui/Tooltip";
import { MEMBERS_STRIP_TOOLTIP_DELAY_MS } from "./membersStripTooltipDelay";

/** v2 members strip (Artea 2026-08-06「重量随风险」): the channel IS its
 *  people, so members are a bare strip right under the identity header —
 *  no row chrome. Tiles are two-tone by member kind (lavender = human,
 *  cyan = agent — Raft is the only product with agents as first-class
 *  members, so the split is shown, not summed); the count row swaps the
 *  drawer into its members page, the dashed add tile jumps straight
 *  into the add flow (one hop fewer). Artea 2026-08-10: the preview may
 *  wrap to at most three rows; overflow and add always keep their slots. */
const STRIP_MAX_ROWS = 3;
// The avatars' size (AvatarSlot panel-header): md 35px, sm 27px with a mouse on a desktop.
const STRIP_TILE_SIZE_PX = 35;
const STRIP_TILE_GAP_PX = 8;
const STRIP_FALLBACK_COLUMNS = 7;
// The members card is one target, the way a card that opens something as a whole is (raft-design
// MessageEmbed, Lists): the heading row's button stretches an ::after over the whole card (the stretched
// link), so a click on the avatars or between them opens the member list too, and the card hovers and
// presses as one surface. The card paints the tiers itself, so the heading row lays none of its own and the
// header never reads darker than the avatars under it. It no longer clips, so the cover's focus ring is
// drawn around the whole card. Add sits above the cover (z-raised), a separate action with its own hover and
// focus, never nested in the button (stdrc, members card hover). The hover tier is only for a device that
// hovers: after a tap, a touch screen keeps :hover on what was tapped, and the card would stay tinted. The
// press tier is for every device.
const MEMBERS_CARD_CLASS = [
  "relative isolate overflow-visible",
  "[@media(hover:hover)]:has-[[data-members-open]:hover]:overlay-subtle",
  "[@media(hover:hover)]:has-[[data-members-tile]:hover]:overlay-subtle",
  "has-[[data-members-open]:active]:overlay-medium has-[[data-members-tile]:active]:overlay-medium",
].join(" ");
const MEMBERS_OPEN_CLASS = [
  "static outline-none focus-visible:keyboard:inset-ring-0",
  "after:absolute after:-inset-px after:z-base after:rounded-container focus-visible:after:shadow-focus",
].join(" ");
// A member's face: not a control of its own (the card is the one tab stop), but raised over the cover so its
// name still shows on hover; a click on it opens the list, as the cover under it would.
const STRIP_FACE_CLASS = "relative z-raised shrink-0 cursor-pointer rounded-sticker";
// The add tile is a square button: sticker radius and the shared keyboard focus ring, over the cover.
const STRIP_ADD_BUTTON_CLASS = "relative z-raised shrink-0 rounded-sticker outline-none focus-visible:shadow-focus";
const STRIP_PRELOAD_LIMIT = STRIP_MAX_ROWS * STRIP_FALLBACK_COLUMNS;
const NO_CHANNEL_EXTERNAL_MEMBERS: ChannelExternalMember[] = [];

function MemberStripTooltip({
  children,
  label,
}: {
  children: ReactElement;
  label: string;
}) {
  return (
    <Tooltip
      content={label}
    >
      {children}
    </Tooltip>
  );
}

function getStripColumnCount(width: number, tile = STRIP_TILE_SIZE_PX): number {
  if (width <= 0) return STRIP_FALLBACK_COLUMNS;
  return Math.max(1, Math.floor(
    (width + STRIP_TILE_GAP_PX) / ((tile || STRIP_TILE_SIZE_PX) + STRIP_TILE_GAP_PX),
  ));
}

function getVisibleMemberLimit(total: number, columnCount: number): number {
  const capacity = STRIP_MAX_ROWS * columnCount;
  // The add slot is always visible. Once members overflow, reserve one more
  // slot for +N so the strip never spills into a fourth row.
  return total + 1 <= capacity
    ? total
    : Math.max(0, capacity - 2);
}

function createStripColumnStore() {
  let columnCount = STRIP_FALLBACK_COLUMNS;
  let observer: ResizeObserver | null = null;
  const listeners = new Set<() => void>();

  const measure = (width: number, grid: HTMLDivElement) => {
    if (width <= 0) return;
    const nextColumnCount = getStripColumnCount(width, parseFloat(getComputedStyle(grid).getPropertyValue("--strip-tile")));
    if (nextColumnCount === columnCount) return;
    columnCount = nextColumnCount;
    for (const listener of listeners) listener();
  };

  return {
    attach(grid: HTMLDivElement | null) {
      observer?.disconnect();
      observer = null;
      if (!grid) return;
      measure(grid.getBoundingClientRect().width, grid);
      if (typeof ResizeObserver === "undefined") return;
      observer = new ResizeObserver((entries) => {
        measure(entries[0]?.contentRect.width ?? grid.getBoundingClientRect().width, grid);
      });
      observer.observe(grid);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => columnCount,
    getServerSnapshot: () => STRIP_FALLBACK_COLUMNS,
  };
}

export function MembersStrip({
  channelAgents,
  channelHumans,
  channelExternalMembers = NO_CHANNEL_EXTERNAL_MEMBERS,
  loading,
  onOpen,
  onAdd,
}: {
  channelAgents: ChannelAgent[];
  channelHumans: ChannelHuman[];
  /** Slack participants of a bridged channel (display-only, never Raft members). */
  channelExternalMembers?: ChannelExternalMember[];
  loading: boolean;
  onOpen: () => void;
  onAdd?: () => void;
}) {
  const { formatMessage } = useIntl();
  const headingId = useId();
  const summaryId = useId();
  const [columnStore] = useState(createStripColumnStore);
  const columnCount = useSyncExternalStore(
    columnStore.subscribe,
    columnStore.getSnapshot,
    columnStore.getServerSnapshot,
  );
  const totalMembers = channelHumans.length + channelAgents.length + channelExternalMembers.length;
  const visibleMemberLimit = getVisibleMemberLimit(totalMembers, columnCount);
  const humans = channelHumans.slice(0, visibleMemberLimit);
  const agents = channelAgents.slice(0, Math.max(0, visibleMemberLimit - humans.length));
  const externalMembers = channelExternalMembers.slice(
    0,
    Math.max(0, visibleMemberLimit - humans.length - agents.length),
  );
  const overflow = totalMembers - humans.length - agents.length - externalMembers.length;
  // Machine text (the remaining count), kept out of JSX as a protocol literal.
  const overflowLabel = `+${overflow}`;

  const summary = loading
    ? formatMessage({ id: "message.chatPanel.overflow.membersLoading" })
    : channelExternalMembers.length > 0
      ? formatMessage(
        { id: "message.chatPanel.overflow.membersSummaryWithSlack" },
        {
          humans: channelHumans.length,
          agents: channelAgents.length,
          slack: channelExternalMembers.length,
        },
      )
      : formatMessage(
        { id: "message.chatPanel.overflow.membersSummary" },
        { humans: channelHumans.length, agents: channelAgents.length },
      );

  // A card in the channel details (raft-design channel.md): the heading row, which opens the member list inside
  // the column, and up to three rows of avatars under it, a row that belongs to it (ListRow `attached`). The
  // whole card opens the list (MEMBERS_CARD_CLASS). The heading row is a button that lays no tier of its own
  // (`interactive={false}` rendered as a button); its name is Members and the count.
  return (
    <section aria-labelledby={headingId} data-testid="channel-overflow-members-strip">
    <ListRowGroup className={MEMBERS_CARD_CLASS} data-testid="channel-overflow-members-card">
      <ListRow
        variant="plain"
        interactive={false}
        render={<button type="button" />}
        onClick={onOpen}
        aria-labelledby={`${headingId} ${summaryId}`}
        className={MEMBERS_OPEN_CLASS}
        data-members-open=""
        data-testid="channel-overflow-members-entry"
      >
        <ListRowBody>
          <ListRowTitle id={headingId} data-testid="channel-overflow-members-heading">
            {formatMessage({ id: "message.chatPanel.overflow.members" })}
          </ListRowTitle>
        </ListRowBody>
        <ListRowValue id={summaryId}>{summary}</ListRowValue>
        <ListRowChevron><ChevronRight aria-hidden="true" /></ListRowChevron>
      </ListRow>
      {/* Static, so the cover is laid over it, not under it. */}
      <ListRow variant="plain" interactive={false} attached role="group" aria-labelledby={headingId} className="static">
      <TooltipProvider delay={MEMBERS_STRIP_TOOLTIP_DELAY_MS}>
        <div
          ref={columnStore.attach}
          className="flex w-full flex-wrap content-start items-center gap-2 [--strip-tile:35px] md:pointer-fine:[--strip-tile:27px]"
          aria-busy={loading}
          data-testid="channel-overflow-members-grid"
          data-max-rows={STRIP_MAX_ROWS}
          data-column-count={columnCount}
        >
          {loading && Array.from({ length: 3 }, (_, index) => (
            <Skeleton
              key={index}
              variant="block"
              className="size-(--strip-tile) shrink-0"
              data-testid="channel-overflow-member-skeleton"
            />
          ))}
          {!loading && humans.map((human) => {
            const label = human.displayName ?? human.name;
            return (
              <MemberStripTooltip key={human.id} label={label}>
                <span
                  role="img"
                  onClick={onOpen}
                  aria-label={label}
                  data-kind="human"
                  data-members-tile=""
                  className={STRIP_FACE_CLASS}
                >
                  <AvatarSlot
                    context="panel-header"
                    type="human"
                    humanAvatarUrl={human.avatarUrl}
                  />
                </span>
              </MemberStripTooltip>
            );
          })}
          {!loading && agents.map((agent) => {
            const label = agent.displayName ?? agent.name;
            return (
              <MemberStripTooltip key={agent.id} label={label}>
                <span
                  role="img"
                  onClick={onOpen}
                  aria-label={label}
                  data-kind="agent"
                  data-members-tile=""
                  className={STRIP_FACE_CLASS}
                >
                  <AvatarSlot
                    context="panel-header"
                    type="agent"
                    agentAvatarUrl={agent.avatarUrl}
                    badge={(
                      <AgentActivityDot
                        agentId={agent.id}
                        fallbackActivity={agentStatusFallbackActivity(agent.status)}
                      />
                    )}
                  />
                </span>
              </MemberStripTooltip>
            );
          })}
          {!loading && externalMembers.map((member) => {
            const label = formatMessage(
              { id: "message.chatPanel.overflow.slackMemberLabel" },
              { name: member.displayName },
            );
            return (
              <MemberStripTooltip key={member.id} label={label}>
                <span
                  role="img"
                  onClick={onOpen}
                  aria-label={label}
                  data-kind="external"
                  data-members-tile=""
                  className={STRIP_FACE_CLASS}
                >
                  <AvatarSlot context="panel-header" type="human" humanAvatarUrl={member.avatarUrl} />
                </span>
              </MemberStripTooltip>
            );
          })}
          {!loading && overflow > 0 && (
            /* DS avatar stack overflow (`rf-avatars__more`): a sunken tile
               with the remaining count in machine type. It has no tooltip, so
               it stays under the cover, which opens the list. */
            <span
              className="flex h-(--strip-tile) min-w-(--strip-tile) shrink-0 items-center justify-center rounded-sticker bg-fill-muted px-1 font-mono text-mono-meta font-bold text-foreground-muted"
              data-testid="channel-overflow-members-more"
            >
              {overflowLabel}
            </span>
          )}
          {onAdd && (
            <Tooltip content={formatMessage({ id: "agent.channelMembers.addMember" })}>
              {/* DS empty identity (`rf-avatar--empty`): a dashed ink-3 square
                  with a plus — the place a new member would take. */}
              <button
                type="button"
                onClick={onAdd}
                disabled={loading}
                aria-label={formatMessage({ id: "agent.channelMembers.addMember" })}
                className={`${STRIP_ADD_BUTTON_CLASS} flex size-(--strip-tile) items-center justify-center border-[1.5px] border-dashed border-foreground-hint text-foreground-hint hover:bg-fill-medium disabled:cursor-wait disabled:border-line-hairline disabled:text-foreground-disabled`}
                data-testid="channel-overflow-members-add-tile"
              >
                <UserPlus className="size-5 md:pointer-fine:size-4" aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
      </ListRow>
    </ListRowGroup>
    </section>
  );
}

/**
 * Warm the exact avatar renderers used by the strip while the drawer is still
 * closed. Member data is fetched by ChatPanel for mentions on page mount; this
 * tiny offscreen surface lets uploaded images settle in the browser cache
 * at the same time instead of making the first drawer open pay for it.
 * The limit matches the largest strip viewport, so a large channel does not
 * turn preloading into an unbounded background gallery.
 */
export function MemberAvatarPreloader({
  channelAgents,
  channelHumans,
  loading,
}: {
  channelAgents: ChannelAgent[];
  channelHumans: ChannelHuman[];
  loading: boolean;
}) {
  if (loading) return null;
  const humans = channelHumans.slice(0, STRIP_PRELOAD_LIMIT);
  const remaining = Math.max(0, STRIP_PRELOAD_LIMIT - humans.length);
  const agents = channelAgents
    .filter((agent) => agent.avatarUrl && !agent.avatarUrl.startsWith("pixel:"))
    .slice(0, remaining);

  return (
    <div
      className="pointer-events-none absolute size-px overflow-hidden opacity-0"
      aria-hidden="true"
      data-testid="channel-overflow-avatar-preloader"
    >
      {humans.map((human) => (
        <AvatarSlot
          key={human.id}
          context="panel-header"
          type="human"
          humanAvatarUrl={human.avatarUrl}
        />
      ))}
      {agents.map((agent) => (
        <img key={agent.id} src={agent.avatarUrl!} alt="" />
      ))}
    </div>
  );
}
