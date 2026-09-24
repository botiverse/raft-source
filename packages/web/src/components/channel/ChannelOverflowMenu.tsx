import type { ReactElement } from "react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { ChevronRight, CircleStop, Search, Settings } from "lucide-react";
import { TooltipProvider } from "raft-ui";
import EditChannelDialog from "./EditChannelDialog";
import Modal from "../Modal";
import ChannelMembers, { agentStatusFallbackActivity } from "../agent/ChannelMembers";
import AgentActivityDot from "../agent/AgentActivityDot";
import type { ChannelAgent, ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { canUseChannelMemberAction } from "../../utils/channelMemberPermissions";
import AvatarSlot from "../ui/AvatarSlot";
import Button from "../ui/Button";
import Skeleton from "../ui/Skeleton";
import {
  OverflowActionRow,
  OverflowMenuTrigger,
  OverflowSheet,
} from "../ui/OverflowSheet";
import Tooltip from "../ui/Tooltip";

/** v2 members strip (Artea 2026-08-06「重量随风险」): the channel IS its
 *  people, so members are a bare strip right under the identity header —
 *  no row chrome. Tiles are two-tone by member kind (lavender = human,
 *  cyan = agent — Raft is the only product with agents as first-class
 *  members, so the split is shown, not summed); the count row swaps the
 *  drawer into its members page, the dashed add tile jumps straight
 *  into the add flow (one hop fewer). Artea 2026-08-10: the preview may
 *  wrap to at most three rows; overflow and add always keep their slots. */
const STRIP_MAX_ROWS = 3;
const STRIP_TILE_SIZE_PX = 36;
const STRIP_TILE_GAP_PX = 8;
const STRIP_FALLBACK_COLUMNS = 7;
const STRIP_PRELOAD_LIMIT = STRIP_MAX_ROWS * STRIP_FALLBACK_COLUMNS;
export const MEMBERS_STRIP_TOOLTIP_DELAY_MS = 250;

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
      contentProps={{ className: "bg-white" }}
    >
      {children}
    </Tooltip>
  );
}

function getStripColumnCount(width: number): number {
  if (width <= 0) return STRIP_FALLBACK_COLUMNS;
  return Math.max(1, Math.floor(
    (width + STRIP_TILE_GAP_PX) / (STRIP_TILE_SIZE_PX + STRIP_TILE_GAP_PX),
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

  const measure = (width: number) => {
    if (width <= 0) return;
    const nextColumnCount = getStripColumnCount(width);
    if (nextColumnCount === columnCount) return;
    columnCount = nextColumnCount;
    for (const listener of listeners) listener();
  };

  return {
    attach(grid: HTMLDivElement | null) {
      observer?.disconnect();
      observer = null;
      if (!grid) return;
      measure(grid.getBoundingClientRect().width);
      if (typeof ResizeObserver === "undefined") return;
      observer = new ResizeObserver((entries) => {
        measure(entries[0]?.contentRect.width ?? grid.getBoundingClientRect().width);
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

function MembersStrip({
  channelAgents,
  channelHumans,
  loading,
  onOpen,
  onAdd,
}: {
  channelAgents: ChannelAgent[];
  channelHumans: ChannelHuman[];
  loading: boolean;
  onOpen: () => void;
  onAdd?: () => void;
}) {
  const { formatMessage } = useIntl();
  const [columnStore] = useState(createStripColumnStore);
  const columnCount = useSyncExternalStore(
    columnStore.subscribe,
    columnStore.getSnapshot,
    columnStore.getServerSnapshot,
  );
  const totalMembers = channelHumans.length + channelAgents.length;
  const visibleMemberLimit = getVisibleMemberLimit(totalMembers, columnCount);
  const humans = channelHumans.slice(0, visibleMemberLimit);
  const agents = channelAgents.slice(0, Math.max(0, visibleMemberLimit - humans.length));
  const overflow = channelHumans.length + channelAgents.length - humans.length - agents.length;

  return (
    <div className="px-4 pb-3 pt-3" data-testid="channel-overflow-members-strip">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center justify-between gap-2 text-left"
        data-testid="channel-overflow-members-entry"
      >
        <span
          role="heading"
          aria-level={3}
          className="text-base font-bold text-black"
          data-testid="channel-overflow-members-heading"
        >
          {formatMessage({ id: "message.chatPanel.overflow.members" })}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1 text-xs font-bold text-black">
          {loading
            ? formatMessage({ id: "message.chatPanel.overflow.membersLoading" })
            : formatMessage(
                { id: "message.chatPanel.overflow.membersSummary" },
                { humans: channelHumans.length, agents: channelAgents.length },
              )}
          <ChevronRight size={14} />
        </span>
      </button>
      <TooltipProvider delay={MEMBERS_STRIP_TOOLTIP_DELAY_MS}>
        <div
          ref={columnStore.attach}
          className="mt-2 flex flex-wrap content-start items-center gap-2"
          aria-busy={loading}
          data-testid="channel-overflow-members-grid"
          data-max-rows={STRIP_MAX_ROWS}
          data-column-count={columnCount}
        >
          {loading && Array.from({ length: 3 }, (_, index) => (
            <Skeleton
              key={index}
              variant="circle"
              className="size-9 shrink-0"
              data-testid="channel-overflow-member-skeleton"
            />
          ))}
          {!loading && humans.map((human) => {
            const label = human.displayName ?? human.name;
            return (
              <MemberStripTooltip key={human.id} label={label}>
                <button
                  type="button"
                  onClick={onOpen}
                  aria-label={label}
                  data-kind="human"
                  className="shrink-0 transition-colors hover:brightness-90"
                >
                  <AvatarSlot
                    context="panel-header"
                    type="human"
                    humanAvatarUrl={human.avatarUrl}
                    gravatarHash={human.gravatarHash}
                  />
                </button>
              </MemberStripTooltip>
            );
          })}
          {!loading && agents.map((agent) => {
            const label = agent.displayName ?? agent.name;
            return (
              <MemberStripTooltip key={agent.id} label={label}>
                <button
                  type="button"
                  onClick={onOpen}
                  aria-label={label}
                  data-kind="agent"
                  className="shrink-0 transition-colors hover:brightness-90"
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
                </button>
              </MemberStripTooltip>
            );
          })}
          {!loading && overflow > 0 && (
            <button
              type="button"
              onClick={onOpen}
              className="flex h-9 w-9 shrink-0 items-center justify-center border-2 border-black text-xs font-bold"
              data-testid="channel-overflow-members-more"
            >
              +{overflow}
            </button>
          )}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              disabled={loading}
              title={formatMessage({ id: "agent.channelMembers.addMember" })}
              aria-label={formatMessage({ id: "agent.channelMembers.addMember" })}
              className="flex h-9 w-9 shrink-0 items-center justify-center border-2 border-dashed border-black/40 text-lg font-bold text-black/45 transition-colors hover:border-black hover:text-black disabled:cursor-wait disabled:opacity-40"
              data-testid="channel-overflow-members-add-tile"
            >
              +
            </button>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}

/**
 * Warm the exact avatar renderers used by the strip while the drawer is still
 * closed. Member data is fetched by ChatPanel for mentions on page mount; this
 * tiny offscreen surface lets uploaded images and Gravatar's session cache
 * settle at the same time instead of making the first drawer open pay for it.
 * The limit matches the largest strip viewport, so a large channel does not
 * turn preloading into an unbounded background gallery.
 */
function MemberAvatarPreloader({
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
          gravatarHash={human.gravatarHash}
        />
      ))}
      {agents.map((agent) => (
        <img key={agent.id} src={agent.avatarUrl!} alt="" />
      ))}
    </div>
  );
}

/**
 * Channel topbar details and settings surface (task #187, gated by
 * `topbar_overflow_v0`).
 *
 * Collects the channel-header settings actions (members / channel settings
 * incl. activity mute / stop-all-agents) into a drawer. Search remains a
 * sibling topbar action, so it is available without opening Settings. Every control maps to an existing
 * API — this component introduces no new endpoints. Visibility is
 * trimmed by the caller with the same RBAC predicates the old header
 * buttons used: optional props left undefined simply omit the
 * row/section.
 *
 * Members is a two-tone avatar STRIP (v2「重量随风险」, Artea
 * 2026-08-06: lavender = human, cyan = agent, count row 「N humans · M
 * agents ›」 swaps the drawer into its second-level MEMBERS VIEW; the
 * dashed pink 「+」 tile lands directly in the add flow) — page
 * navigation inside the drawer, size unchanged, ‹ back returns, ✕
 * closes through the same unsaved-draft guard.
 * v2 visual thesis: weight follows risk. The yellow header is the
 * identity surface (name + visibility pill + description);
 * preferences stay bare on the paper; the channel
 * actions (visibility → Archive → Leave → Stop agents → Delete) form
 * the drawer's SINGLE bordered zone, and Delete is the only filled
 * row. Channel settings stays a FLAT section inside this drawer
 * (design master final11: 平铺, sections instead of stacked modal /
 * side sheet / second-level page).
 */
export interface ChannelOverflowMenuProps {
  channelId: string;
  channelName: string;
  /** Opens channel search. Rendered as the header icon (v2). */
  onSearch: () => void;
  /** Activity-mute switch, rendered in the settings panel's preferences
   *  group between Pin and collapse (final11: Mute is a per-user
   *  preference). Omit when the server does not support it. */
  activityMute?: {
    muted: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  /** Collapse-long-messages switch, rendered in the settings panel's
   *  preferences group next to Pin. Omit when the server does not
   *  support it. */
  collapseLongMessages?: {
    enabled: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  /** Show the members section (false e.g. for #all with
   *  hideHumansFromMembers). */
  showMembers?: boolean;
  /** Already-prefetched channel roster from ChatPanel. Passing it here keeps
   *  the settings drawer from issuing a second request only after opening. */
  members?: {
    agents: ChannelAgent[];
    humans: ChannelHuman[];
    externalMembers: ChannelExternalMember[];
    loading: boolean;
    addMembers: (input: { userIds: string[]; agentIds: string[] }) => Promise<unknown>;
    addAgent: (agentId: string) => Promise<void>;
    removeAgent: (agentId: string) => Promise<void>;
    addHuman: (userId: string) => Promise<void>;
    removeHuman: (userId: string) => Promise<void>;
    changeMemberRole: (targetType: "user" | "agent", memberId: string, role: "member" | "admin") => Promise<void>;
    roleChangeFailed: boolean;
  };
  /** Channel settings section. Omit when the user can neither manage
   *  channels nor leave (mirrors `showChannelOptionsButton`). */
  settings?: {
    initialName: string;
    initialDescription: string;
    onLeaveChannel?: () => Promise<void> | void;
  };
  /** Danger-zone row. Omit unless joined && canManageAgents. */
  onStopAllAgents?: () => void;
  /** Controlled open state — used when another surface (e.g. the archived
   *  channel banner's Unarchive link) must open this drawer directly.
   *  Omit for the self-triggered usage. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function ChannelOverflowMenu({
  channelId,
  channelName,
  onSearch,
  activityMute,
  collapseLongMessages,
  showMembers = false,
  members,
  settings,
  onStopAllAgents,
  open: controlledOpen,
  onOpenChange,
}: ChannelOverflowMenuProps) {
  const { formatMessage } = useIntl();
  const [internalOpen, setInternalOpen] = useState(false);
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);
  const [unsavedCanSave, setUnsavedCanSave] = useState(true);
  const [unsavedBusy, setUnsavedBusy] = useState(false);
  // Drawer-internal page navigation (task #187): "members" swaps the
  // sheet into the members page (bare mode — the sheet SIZE is fixed);
  // the root view stays mounted underneath so a dirty settings draft
  // survives root → members → back. membersInitialView lets the strip's
  // dashed 「+」 tile land DIRECTLY in the add flow (v2: one hop fewer).
  const [view, setView] = useState<"root" | "members">("root");
  const [membersInitialView, setMembersInitialView] = useState<"add" | undefined>(undefined);
  const open = controlledOpen ?? internalOpen;
  // v2 identity header: visibility badge reads the live channel.
  const channel = useChannelStore((s) => s.channels.find((c) => c.id === channelId));
  const currentUserId = useAuthStore((s) => s.user?.id);
  const currentServerId = useServerStore((s) => s.current?.id);
  const serverMembers = useServerStore((s) => s.members);
  const isAllChannel = channel?.name === "all" && channel?.type === "channel";
  const canAddMembers = canUseChannelMemberAction({
    currentUserId,
    currentServerId,
    channelServerId: channel?.serverId,
    channelHumans: members?.humans ?? [],
    serverMembers,
    hasChannelMemberCapability: channel?.channelCapabilities?.addChannelMembers === true,
    isAllChannel,
  }) && !channel?.archivedAt;
  // task #187: the flat settings panel carries no Drawer chrome, so the
  // host drawer owns the unsaved-draft guard — a close attempt while a
  // draft exists opens the save/discard prompt (final6) instead of
  // silently blocking or discarding. Refs keep dirtiness and the save
  // callback out of this component's render cycle.
  const settingsDirtyRef = useRef(false);
  const settingsSaveAndCloseAvailableRef = useRef(true);
  const settingsSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const postCloseActionRef = useRef<(() => void) | null>(null);
  const setOpen = (next: boolean) => {
    if (!next) {
      settingsDirtyRef.current = false;
      settingsSaveAndCloseAvailableRef.current = true;
      postCloseActionRef.current = null;
      setView("root");
      setMembersInitialView(undefined);
    }
    if (onOpenChange) onOpenChange(next);
    else setInternalOpen(next);
  };
  const close = () => setOpen(false);
  // The members page ✕ rides the same draft guard as every other close
  // affordance; row → profile keeps the historical unguarded close (the
  // old drawer panel behavior).
  const guardedClose = (postCloseAction?: () => void) => {
    if (settingsDirtyRef.current) {
      postCloseActionRef.current = postCloseAction ?? null;
      setUnsavedCanSave(settingsSaveAndCloseAvailableRef.current);
      setShowUnsavedPrompt(true);
      return;
    }
    close();
    postCloseAction?.();
  };
  const handleSaveAndClose = async () => {
    setUnsavedBusy(true);
    try {
      const saved = (await settingsSaveRef.current?.()) ?? true;
      if (saved) {
        const postCloseAction = postCloseActionRef.current;
        postCloseActionRef.current = null;
        setShowUnsavedPrompt(false);
        close();
        postCloseAction?.();
      }
    } finally {
      setUnsavedBusy(false);
    }
  };

  return (
    <>
      <OverflowMenuTrigger
        labelId="message.chatPanel.searchChannel"
        onClick={() => guardedClose(onSearch)}
        icon={<Search size={14} />}
        testId="channel-topbar-search"
      />
      <OverflowMenuTrigger
        labelId="message.chatPanel.overflow.open"
        onClick={() => setOpen(true)}
        icon={<Settings size={14} />}
        testId="channel-overflow-trigger"
      />
      {showMembers && members && (
        <MemberAvatarPreloader
          channelAgents={members.agents}
          channelHumans={members.humans}
          loading={members.loading}
        />
      )}
      <OverflowSheet
        open={open}
        onOpenChange={setOpen}
        title={(
          /* v2「重量随风险」 (Artea 2026-08-06): the yellow header is the
             identity surface — name + visibility pill live ON the title
             row, the description below it, search/mute-state ride the
             header instead of body rows. */
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate" data-testid="channel-overflow-title-text">
              {formatMessage({ id: "message.chatPanel.overflow.channelName" }, { name: channelName })}
            </span>
            {channel && (
              <span
                className="shrink-0 border-[1.5px] border-black bg-brutal-lime px-2 py-px text-[11px] font-bold"
                data-testid="channel-overflow-visibility-badge"
              >
                {channel.type === "private"
                  ? formatMessage({ id: "message.chatPanel.overflow.visibilityPrivate" })
                  : channel.type === "joint"
                    ? formatMessage({ id: "channel.edit.jointChannelBadge" })
                  : formatMessage({ id: "message.chatPanel.overflow.visibilityPublic" })}
              </span>
            )}
          </span>
        )}
        subtitle={settings?.initialDescription ? (
          <p className="truncate font-mono text-xs text-black/50" data-testid="channel-overflow-identity-desc">
            {settings.initialDescription}
          </p>
        ) : undefined}
        descriptionId="message.chatPanel.overflow.open"
        closeLabelId="message.chatPanel.overflow.close"
        hideDesktopClose
        closeGuardRef={settingsDirtyRef}
        onCloseGuarded={() => {
          postCloseActionRef.current = null;
          setUnsavedCanSave(settingsSaveAndCloseAvailableRef.current);
          setShowUnsavedPrompt(true);
        }}
        bare={view === "members"}
        testId="channel-overflow-sheet"
      >
        {/* Root view stays MOUNTED (hidden) while the members page shows,
            so an unsaved name/description draft survives the round trip. */}
        <div className={view === "members" ? "hidden" : undefined}>
          {showMembers && (
            <MembersStrip
              channelAgents={members?.agents ?? []}
              channelHumans={members?.humans ?? []}
              loading={members?.loading ?? true}
              onOpen={() => {
                setMembersInitialView(undefined);
                setView("members");
              }}
              onAdd={canAddMembers ? () => {
                if (!canAddMembers) return;
                setMembersInitialView("add");
                setView("members");
              } : undefined}
            />
          )}

          {settings && (
            <EditChannelDialog
              channelId={channelId}
              initialName={settings.initialName}
              initialDescription={settings.initialDescription}
              onLeaveChannel={settings.onLeaveChannel}
              onClose={close}
              presentation="panel"
              dirtyRef={settingsDirtyRef}
              saveAndCloseAvailableRef={settingsSaveAndCloseAvailableRef}
              saveRef={settingsSaveRef}
              activityMute={activityMute}
              collapseLongMessages={collapseLongMessages}
              stopAgentsRow={onStopAllAgents ? (
                /* v2: agent runtime joins the single action zone as a
                   plain row (reversible — agents can be restarted), NOT
                   a danger-red separate group. */
                <OverflowActionRow
                  icon={<CircleStop size={14} />}
                  label={formatMessage({ id: "message.chatPanel.overflow.stopAgents" })}
                  ariaLabel={formatMessage({ id: "message.chatPanel.stopAllAgents" })}
                  onClick={onStopAllAgents}
                  testId="channel-overflow-stop-agents"
                />
              ) : undefined}
            />
          )}
        </div>

        {view === "members" && (
          <ChannelMembers
            presentation="page"
            channelId={channelId}
            initialView={membersInitialView}
            prefetchedMembers={members ? {
              channelAgents: members.agents,
              channelHumans: members.humans,
              channelExternalMembers: members.externalMembers,
              loading: members.loading,
              addMembers: members.addMembers,
              addAgent: members.addAgent,
              removeAgent: members.removeAgent,
              addHuman: members.addHuman,
              removeHuman: members.removeHuman,
              changeMemberRole: members.changeMemberRole,
              roleChangeFailed: members.roleChangeFailed,
            } : undefined}
            onBack={() => setView("root")}
            onClose={guardedClose}
            onRequestClose={close}
          />
        )}
      </OverflowSheet>

      {showUnsavedPrompt && (
        /* Closing the drawer with unsaved settings asks first. Only
           name/description drafts can be saved here; an invitation draft
           must be sent from its own form or explicitly discarded. Three
           actions, so a plain Modal instead of the two-action ConfirmDialog. */
        <Modal
          onClose={() => {
            if (unsavedBusy) return;
            postCloseActionRef.current = null;
            setShowUnsavedPrompt(false);
          }}
          layer={1}
        >
          <div
            className="w-full max-w-sm card-brutal p-6"
            role="dialog"
            aria-modal="true"
            data-testid="channel-overflow-unsaved-prompt"
          >
            <h2 className="mb-4 text-lg font-bold">
              {formatMessage({ id: "message.chatPanel.overflow.unsavedTitle" })}
            </h2>
            <p className="mb-5 text-sm text-black/70">
              {formatMessage({
                id: unsavedCanSave
                  ? "message.chatPanel.overflow.unsavedMessage"
                  : "message.chatPanel.overflow.unsavedInvitationMessage",
              })}
            </p>
            <div className="flex justify-end gap-3">
              <Button
                onClick={() => {
                  postCloseActionRef.current = null;
                  setShowUnsavedPrompt(false);
                }}
                disabled={unsavedBusy}
                size="sm"
                tone="white"
                className="disabled:opacity-50"
              >
                {formatMessage({ id: "message.chatPanel.overflow.keepEditing" })}
              </Button>
              <Button
                onClick={() => {
                  const postCloseAction = postCloseActionRef.current;
                  postCloseActionRef.current = null;
                  setShowUnsavedPrompt(false);
                  close();
                  postCloseAction?.();
                }}
                disabled={unsavedBusy}
                size="sm"
                tone="orange"
                className="disabled:opacity-50"
                data-testid="channel-overflow-unsaved-discard"
              >
                {formatMessage({ id: "message.chatPanel.overflow.discardChanges" })}
              </Button>
              {unsavedCanSave && (
                <Button
                  onClick={() => void handleSaveAndClose()}
                  disabled={unsavedBusy}
                  size="sm"
                  tone="pink"
                  className="disabled:opacity-50"
                  data-testid="channel-overflow-unsaved-save"
                >
                  {unsavedBusy
                    ? formatMessage({ id: "channel.edit.saving" })
                    : formatMessage({ id: "message.chatPanel.overflow.saveAndClose" })}
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
