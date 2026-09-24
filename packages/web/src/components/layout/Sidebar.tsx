import { createContext, useState, useEffect, useCallback, useContext, useLayoutEffect, useRef, useMemo, useSyncExternalStore, memo } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { Archive, Plus, Trash2, ChevronRight, ChevronDown, ChevronLeft, User, MessageSquare, MessageSquareCheck, MessageSquareDot, Monitor, Bot, X, Pencil, Bookmark, FileText, BookOpenText, Network, Search, Pin, PinOff, Square, RotateCcw, Play, Bell, BellOff, AtSign, Building2, Activity, ArrowUpDown, Languages, GitBranch, Type, CreditCard, Shield, Link2, BadgeInfo, Blocks, Check, FlaskConical, KeyRound, FolderInput, FolderPlus } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Transform } from "@dnd-kit/utilities";
import { toast } from "raft-ui";
import api from "../../api/client";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { canToggleActivityMute, matchesActivityMuteState, normalizeActivityMuteState } from "../../store/channelDomain";
import { selectAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useShallow } from "zustand/react/shallow";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useUIStore } from "../../store/uiStore";
import { useMessageStore } from "../../store/messageStore";
import { useThreadStore } from "../../store/threadStore";
import { useInboxStore } from "../../store/inboxStore";
import { SERVER_NOTIFICATION_PREFS_UPDATED_EVENT } from "../../store/events/notificationPrefsEvents";
import { trackActivityOpen } from "../../analytics/activity";
import { useSavedStore } from "../../store/savedStore";
import { useProfileStore } from "../../store/profileStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { SidebarConversationFinder } from "./SidebarConversationFinder";
import { useRailMode } from "../../hooks/useSidebarTab";
import AttentionDot from "../ui/AttentionDot";
import ContextMenuDivider from "../ui/ContextMenuDivider";
import MenuItem from "../ui/MenuItem";
import SelectionPopover from "../ui/SelectionPopover";
import StatusDot from "../ui/StatusDot";
import { SkeletonRow } from "../ui/Skeleton";
import AgentActivityDot from "../agent/AgentActivityDot";
import { useLongPress } from "../../hooks/useLongPress";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import CreateChannelDialog from "../channel/CreateChannelDialog";
import CreateJointChannelDialog from "../channel/CreateJointChannelDialog";
import ChannelPinMenuItem from "../channel/ChannelPinMenuItem";
import { ChannelKindIcon } from "../channel/channelKindIcon";
import InviteHumanDialog from "../member/InviteHumanDialog";
import CreateAgentDialog from "../agent/CreateAgentDialog";
import ResetAgentDialog from "../agent/ResetAgentDialog";
import ConfirmDialog from "../ConfirmDialog";
import AvatarSlot from "../ui/AvatarSlot";
import ServerSwitcherMenu from "../ui/ServerSwitcherMenu";
import DismissBackdrop from "../ui/DismissBackdrop";
import { getSidebarDmContextTarget } from "./sidebarDmContext";
import { buildAgentDmChannelByAgentId, resolveAgentDmProfileSource } from "./agentDmProfileSource";
import { placeSidebarContextMenu, placeSidebarContextSubmenu } from "./sidebarContextMenuPosition";
import { sortSidebarChannels, sortSidebarDms, sortSidebarPinnedItems, sidebarDmLabel } from "./sidebarSort";
import type { SidebarSortMode } from "./sidebarSort";
import {
  filterSidebarChannelsByMembership,
  readSidebarJoinedChannelsOnly,
  shouldShowSidebarChannelEmptyState,
  writeSidebarJoinedChannelsOnly,
} from "./sidebarChannelVisibility";
import NotificationTrigger from "./NotificationTrigger";
import { getChannelUnreadIndicatorState, hasUnmutedUnread, shouldShowActivityMutedIcon } from "../../utils/channelUnreadIndicator";
import {
  getComputerRowDotStatus,
  getComputerRowDotTitleDescriptor,
  getComputerRowDotTone,
  shouldShowComputerUpgradeIndicator,
} from "../../utils/computerUpgradeIndicator";
import { isElectronDesktopShell } from "../../utils/desktopShell";
import { getMachineRunLabelDescriptor } from "../../utils/machineRunLabel";
import { MachineRunLabel } from "../machine/MachineRunLabel";
import { hasOtherServerActivityUnread, parseServerUnreadSummaryRows, retainServerUnreadSummary } from "../../utils/serverUnreadSummary";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";
import { mobileServerSelectorPolygon } from "./mobileServerSelectorGeometry";
import {
  centeredSidebarScrollTop,
  isSidebarDisclosureRestoreState,
  readSidebarChannelFocusRequest,
} from "./sidebarChannelFocus";
import { emitWorkspaceGridDragPanel, emitWorkspaceGridOpenChannel, emitWorkspaceGridOpenDm, emitWorkspaceGridOpenPanel } from "../workspace/workspaceGridOpenEvents";
import { useWorkspaceGridNavigationStore } from "../workspace/workspaceGridNavigationStore";
import type { WorkspaceGridRailMode } from "../workspace/workspaceGridNavigationStore";
import type { WorkspacePanelRef } from "../workspace/workspaceGridDemoConfig";
import { canOpenSettingsTab, settingsTabIdForRouteSlug } from "../settings/settingsNavigation";
import SidebarSectionDialog from "./SidebarSectionDialog";
import {
  moveSidebarItemToCustomSection,
  moveSidebarItemToCustomSectionAtPosition,
  reorderSidebarSectionOrder,
  removeSidebarItemPlacement,
  sidebarSectionItemKey,
} from "../../store/sidebarSections";
import type { SidebarCustomSection, SidebarSectionItemKind, SidebarSectionPlacement } from "../../store/sidebarSections";
import {
  createWorkspaceGridSidebarSelection,
  selectWorkspaceGridActive,
  selectWorkspaceGridActiveAncestorRefKey,
  selectWorkspaceGridActiveRefKey,
} from "../workspace/workspaceGridSidebarSelection";
import {
  hasSidebarPinnedRef,
  removeSidebarPinnedRef,
  sidebarPinnedRefKey,
  upsertSidebarPinnedRef,
} from "../../utils/sidebarPinnedRefs";
import type {
  SidebarPinnedRef,
} from "../../utils/sidebarPinnedRefs";
import {
  readSidebarAgentMachineGroupCollapsed,
  readSidebarCollapsedSections,
  readSidebarCustomSectionCollapsed,
  writeSidebarAgentMachineGroupCollapsed,
  writeSidebarCollapsedSection,
  writeSidebarCustomSectionCollapsed,
} from "./sidebarCollapsedSections";
import type {
  SidebarCollapsedSection,
  SidebarCollapsedSections,
} from "./sidebarCollapsedSections";
import {
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  SERVER_LABS_UI_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  WIKI_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { isSlackBridgeSurfaceEnabled } from "../settings/slackBridgeVisibility";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import {
  findSidebarDndContainer,
  isSidebarDndData,
  moveSidebarDndItem,
  replaceSidebarSubsetOrder,
  sidebarCustomContainerId,
  sidebarCustomSectionId,
  SIDEBAR_CHANNELS_CONTAINER_ID,
  SIDEBAR_DMS_CONTAINER_ID,
  SIDEBAR_JOINT_CHANNELS_CONTAINER_ID,
  SIDEBAR_PINNED_CONTAINER_ID,
} from "./sidebarDnd";
import type { SidebarDndContainerData, SidebarDndData, SidebarDndItemData, SidebarDndProjection } from "./sidebarDnd";

interface CtxMenu {
  x: number;
  y: number;
  type: "channel" | "agent" | "human" | "dm" | "member-human" | "member-agent";
  id: string;
}

interface SectionCtxMenu {
  x: number;
  y: number;
  section: SidebarSortSection | `custom:${string}`;
}

interface SidebarSurfaceCtxMenu {
  x: number;
  y: number;
}

// Stryker disable all: shared context-menu geometry and propagation shielding predate the Activity mute action and have separate position/interaction coverage.
function getSidebarContextMenuStyle(ctxMenu: Pick<CtxMenu, "x" | "y">) {
  return { left: ctxMenu.x, top: ctxMenu.y };
}

function stopSidebarContextMenuPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
// Stryker restore all

type PinnedDisplayItem =
  | { id: string; ref: SidebarPinnedRef; type: "channel"; channel: Channel; createdAt: string; lastMessageAt?: string | null; label: string }
  | { id: string; ref: SidebarPinnedRef; type: "dm"; dm: Channel; createdAt: string; lastMessageAt?: string | null; label: string }
  | { id: string; ref: SidebarPinnedRef; type: "agent"; agent: Agent; createdAt: string; lastMessageAt?: string | null; label: string };

const EMPTY_PINNED_REFS: SidebarPinnedRef[] = [];

type CustomSectionDisplayItem =
  | { id: string; type: "channel"; channel: Channel; createdAt: string; lastMessageAt?: string | null; label: string; placementKind: "channel" }
  | { id: string; type: "dm"; dm: Channel; createdAt: string; lastMessageAt?: string | null; label: string; placementKind: "channel" }
  | { id: string; type: "agent"; agent: Agent; createdAt: string; lastMessageAt?: string | null; label: string; placementKind: "agent" };
type SidebarMovableItem = { kind: SidebarSectionItemKind; id: string };
type SidebarDndDisplayItem =
  | { type: "channel"; channel: Channel; label: string }
  | { type: "dm"; dm: Channel; label: string }
  | { type: "agent"; agent: Agent; label: string };
function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

function reconcileOrderIds<T extends { id: string }>(
  items: T[],
  storedIds: string[],
  pinnedId?: string | null,
): string[] {
  const itemIds = new Set(items.map((item) => item.id));
  const next: string[] = [];

  if (pinnedId && itemIds.has(pinnedId)) next.push(pinnedId);

  for (const id of storedIds) {
    if (id === pinnedId) continue;
    if (itemIds.has(id) && !next.includes(id)) next.push(id);
  }

  for (const item of items) {
    if (item.id === pinnedId) continue;
    if (!next.includes(item.id)) next.push(item.id);
  }

  return next;
}

function orderByIds<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  return orderedIds.map((id) => itemMap.get(id)).filter((item): item is T => !!item);
}

export function reorderSidebarSubset(
  orderedIds: string[],
  sortableIds: string[],
  activeId: string,
  overId: string,
): string[] | null {
  const oldIndex = sortableIds.indexOf(activeId);
  const newIndex = sortableIds.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return null;
  const reordered = arrayMove(sortableIds, oldIndex, newIndex);
  const remaining = [...reordered];
  const reorderedSet = new Set(reordered);
  return orderedIds.map((id) => reorderedSet.has(id) ? remaining.shift()! : id);
}

type WorkspaceSidebarReorderScope = "channels" | "jointChannels" | "dms";

export function getWorkspaceSidebarReorderScope(
  activeId: string,
  overId: string,
  options: {
    channelManualSort: boolean;
    jointChannelManualSort: boolean;
    dmManualSort: boolean;
    sortableChannelIds: string[];
    sortableJointChannelIds: string[];
    sortableDmIds: string[];
  },
): WorkspaceSidebarReorderScope | null {
  const activeParsed = parseDragId(activeId);
  const overParsed = parseDragId(overId);
  if (activeParsed?.kind === "channel" && overParsed?.kind === "channel") {
    if (
      options.channelManualSort
      && options.sortableChannelIds.includes(activeParsed.id)
      && options.sortableChannelIds.includes(overParsed.id)
    ) return "channels";
    if (
      options.jointChannelManualSort
      && options.sortableJointChannelIds.includes(activeParsed.id)
      && options.sortableJointChannelIds.includes(overParsed.id)
    ) return "jointChannels";
  }
  if (
    options.dmManualSort
    && activeParsed?.kind === "dm"
    && overParsed?.kind === "dm"
    && options.sortableDmIds.includes(activeParsed.id)
    && options.sortableDmIds.includes(overParsed.id)
  ) return "dms";
  return null;
}

const SIDEBAR_SORT_MODES: SidebarSortMode[] = ["manual", "recent", "az"];
// Sort-mode option labels are display copy — the map now holds the layout
// catalog id and the rendering call sites resolve it through formatMessage.
const SIDEBAR_SORT_LABEL_ID: Record<SidebarSortMode, MessageId> = {
  manual: "layout.sidebar.sortManual",
  recent: "layout.sidebar.sortRecent",
  az: "layout.sidebar.sortAz",
};

type SidebarSortSection = "pinned" | "jointChannels" | "channels" | "dms";
// Stryker disable all: accessible section labels are asserted by rendered DOM tests; mutating copy inside Sidebar does not exercise a separate domain seam.
const SIDEBAR_SORT_SECTION_LABEL_ID: Record<SidebarSortSection, MessageId> = {
  pinned: "layout.sidebar.pinned",
  jointChannels: "layout.sidebar.jointChannels",
  channels: "layout.sidebar.channels",
  dms: "layout.sidebar.directMessages",
};
const EMPTY_CUSTOM_SECTIONS: SidebarCustomSection[] = [];
const EMPTY_SECTION_PLACEMENTS: SidebarSectionPlacement[] = [];
const DEFAULT_SECTION_ORDER = ["system:pinned", "system:joint", "system:channels", "system:dms"];
// Stryker restore all
// Stryker disable next-line StringLiteral: section-row geometry is pinned by sidebarWidthContract; this task does not change section layout tokens.
const SIDEBAR_SECTION_ROW_CLASS = "mb-1 mt-3 flex h-6 items-center justify-between px-2";
// Pinned by sidebarWidthContract.test.ts as a sibling design-token to
// SIDEBAR_SECTION_ROW_CLASS — currently has no callsite after a layout
// refactor, but the contract test keeps the literal so future "first
// section" geometry stays explicit / reuse-ready. `void` keeps it lint-clean
// without removing the test pin.
const SIDEBAR_SECTION_ROW_FIRST_CLASS = "mb-1 flex h-6 items-center justify-between px-2";
void SIDEBAR_SECTION_ROW_FIRST_CLASS;
const SIDEBAR_SECTION_TOGGLE_CLASS = "flex h-6 min-w-0 flex-1 items-center gap-1 text-xs font-bold uppercase text-black tracking-widest hover:text-black/70 transition-colors";
const SIDEBAR_SECTION_ICON_BUTTON_CLASS = "btn-flat-sm flex size-6 items-center justify-center p-0";
type SidebarSectionDescriptionProps = HTMLAttributes<HTMLDivElement> & {
  tone?: "muted" | "subtle" | "strong";
};

/**
 * Compact help and empty-state copy that belongs to a Sidebar section.
 *
 * Keep this separate from entity metadata (for example an agent description)
 * and from the full-panel EmptyState primitive. Section descriptions share one
 * typography contract while their callsites retain context-specific spacing.
 */
function SidebarSectionDescription({
  children,
  className = "",
  tone = "muted",
  ...props
}: SidebarSectionDescriptionProps) {
  return (
    <div
      {...props}
      data-sidebar-section-description=""
      className={`px-2 text-xs font-mono leading-snug ${tone === "strong" ? "text-black" : tone === "subtle" ? "text-black/45" : "text-black/50"} ${className}`}
    >
      {children}
    </div>
  );
}
// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
function channelDragId(id: string): string {
  return `channel:${id}`;
}

function dmDragId(id: string): string {
  return `dm:${id}`;
}

function agentDragId(id: string): string {
  return `agent:${id}`;
}

function parseDragId(value: string): { kind: "channel" | "dm" | "agent"; id: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return kind === "channel" || kind === "dm" || kind === "agent" ? { kind, id } : null;
}

export function isSidebarCollisionCandidate(
  activeId: string,
  candidateId: string,
  sectionOrder: string[],
): boolean {
  const activeIsSection = sectionOrder.includes(activeId);
  return activeIsSection
    ? sectionOrder.includes(candidateId)
    : !sectionOrder.includes(candidateId);
}

function pinnedRefForDmChannel(dm: Channel): SidebarPinnedRef | null {
  if (dm.peerType === "agent" && dm.peerId) return { kind: "agent", id: dm.peerId };
  if (dm.peerType === "user" && dm.peerId) return { kind: "human", id: dm.peerId };
  return null;
}

type SidebarDropIndicatorEdge = "before" | "after";

export function getSidebarDropIndicatorEdge(
  activeCenterY: number,
  targetCenterY: number,
): SidebarDropIndicatorEdge {
  return activeCenterY < targetCenterY ? "before" : "after";
}

interface SidebarProps {
  mobileInline?: boolean;
  bottomSlot?: ReactNode;
  workspaceRailMode?: WorkspaceGridRailMode;
}

function SortableSidebarItem({
  id,
  containerId,
  children,
}: {
  id: string;
  containerId: string;
  children: ReactNode;
}) {
  const data = useMemo<SidebarDndItemData>(
    () => ({ type: "item", itemId: id, containerId }),
    [containerId, id],
  );
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data });
  const style = {
    transform: CSS.Transform.toString(getSidebarDragItemTransform(transform, true)),
    transition,
    opacity: isDragging ? 0.12 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-sidebar-drag-item={id}
      className="relative cursor-grab active:cursor-grabbing"
    >
      {children}
    </div>
  );
}

function SidebarDndContainer({
  id,
  kind,
  manual,
  itemIds,
  children,
  empty,
}: {
  id: string;
  kind: SidebarDndContainerData["kind"];
  manual: boolean;
  itemIds: string[];
  children: ReactNode;
  empty?: boolean;
}) {
  const data = useMemo<SidebarDndContainerData>(
    () => ({ type: "container", containerId: id, kind, manual }),
    [id, kind, manual],
  );
  const { setNodeRef, isOver } = useDroppable({ id, data });
  return (
    <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
      <div
        ref={setNodeRef}
        data-sidebar-dnd-container={id}
        className={`relative ${empty ? "min-h-7" : ""} ${isOver ? "bg-white/60" : ""}`}
      >
        {children}
      </div>
    </SortableContext>
  );
}

interface SidebarSectionDragHandleContextValue {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  setActivatorNodeRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
}

const SidebarSectionDragHandleContext = createContext<SidebarSectionDragHandleContextValue | null>(null);

function SortableSidebarSection({
  id,
  testId,
  order,
  children,
}: {
  id: string;
  testId: string;
  order: number;
  children: ReactNode;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(getSidebarSortableItemTransform(transform)),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
    order,
  };
  const dragHandle = useMemo(
    () => ({ attributes, listeners, setActivatorNodeRef }),
    [attributes, listeners, setActivatorNodeRef],
  );

  return (
    <SidebarSectionDragHandleContext.Provider value={dragHandle}>
      <div ref={setNodeRef} style={style} data-testid={testId}>
        {children}
      </div>
    </SidebarSectionDragHandleContext.Provider>
  );
}

function SidebarSectionHeader({ children, onContextMenu }: {
  children: ReactNode;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className={SIDEBAR_SECTION_ROW_CLASS} onContextMenu={onContextMenu}>
      {children}
    </div>
  );
}

function SidebarSectionToggle({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const sortable = useContext(SidebarSectionDragHandleContext);
  return (
    <button
      ref={sortable?.setActivatorNodeRef}
      type="button"
      className={`${className} cursor-default`}
      {...sortable?.attributes}
      {...sortable?.listeners}
      {...props}
    >
      {children}
    </button>
  );
}

export function getSidebarSortableItemTransform(
  transform: Transform | null,
  allowHorizontalDrag = false,
): Transform | null {
  return getSidebarDragItemTransform(transform, allowHorizontalDrag);
}

export function getSidebarDragItemTransform(
  transform: Transform | null,
  allowHorizontalDrag = false,
): Transform | null {
  if (!transform || allowHorizontalDrag) return transform;
  return { ...transform, x: 0 };
}

// Stryker disable all: the Workspace/native-drag vs classic/sortable branch is DOM + browser-drag verified; mutant DnD providers keep the command runner alive.
function SidebarSortOwnership({
  workspaceEnabled,
  sortable,
  staticContent,
}: {
  workspaceEnabled: boolean;
  sortable: ReactNode;
  staticContent: ReactNode;
}) {
  return workspaceEnabled ? staticContent : sortable;
}
// Stryker restore all

/**
 * Loading placeholder for a Sidebar list (channels / DMs / computers / agents).
 * Shown WHILE the store is loading so the section reads as "loading" rather than
 * flashing the "No X yet" empty state and then the real rows (闪回 fix, task
 * #32). Uses the shared `<SkeletonRow>` (#31, Joy) with the sidebar row's own
 * padding + avatar box so each placeholder row is the SAME height as the loaded
 * row — content swaps in without the list jumping.
 */
function SidebarRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow
          key={i}
          className="gap-1.5 px-2 py-2"
          avatar
          avatarClassName="size-[18px]"
          lineWidths={["w-3/5"]}
        />
      ))}
    </div>
  );
}

/**
 * Computers-section row. Subscribes to its OWN machine slice so a
 * `machine:status` event re-renders only the affected row, not the whole
 * Sidebar. The parent must NOT subscribe to status-bearing machine objects —
 * it only carries stable identity (id + name). Same per-row isolation doctrine
 * as `<AgentActivityDot>` (#2412): dynamic per-entity state subscribes itself.
 */
/**
 * The "Saved" nav row's count badge: shows the true saved total, hidden when 0.
 * Exported as its own unit so the visibility/value behavior is testable (the
 * inline-conditional form left the `total > 0` guard uncovered — see
 * tests/savedNavCount.behavior.test.tsx).
 */
export function SavedNavCount({ total }: { total: number }) {
  const { formatMessage } = useIntl();
  if (total <= 0) return null;
  return (
    <span className="ml-auto text-[10px] text-black/40 font-mono">
      {formatMessage({ id: "layout.sidebar.savedCount" }, { count: total })}
    </span>
  );
}

export function ComputerRow({
  machineId,
  selected,
  onSelect,
  onDragStart,
}: {
  machineId: string;
  selected: boolean;
  onSelect: (machineId: string, clickCount: number) => void;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>, machineId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const machine = useMachineStore((s) => s.machines.find((m) => m.id === machineId));
  if (!machine) return null;
  const upgradeAvailable = shouldShowComputerUpgradeIndicator(machine);
  const rowDotStatus = getComputerRowDotStatus(machine);
  const rowDotTitle = getComputerRowDotTitleDescriptor(
    rowDotStatus,
    machine.status,
    machine.computerBroadcastPolicy?.targetVersion,
  );
  return (
    <button
      onClick={(event) => onSelect(machine.id, event.detail)}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      draggable={!!onDragStart}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      onDragStart={(event) => onDragStart?.(event, machine.id)}
      data-testid={`computer-list-item-${machine.id}`}
      className={`mb-1.5 flex w-full items-center gap-2.5 px-2.5 py-2 [@media(max-height:600px)]:py-1 text-left border-2 transition-colors ${
        selected
          ? "border-black bg-brutal-pink shadow-brutal-sm"
          : "border-transparent hover:border-black hover:bg-white hover:shadow-brutal-sm"
      }`}
    >
      <div className="relative flex size-9 shrink-0 items-center justify-center border-2 border-black bg-soft-signal">
        <Monitor size={18} />
        <StatusDot
          className="absolute -right-1 -top-1"
          title={formatMessage({ id: rowDotTitle.id }, rowDotTitle.values)}
          tone={getComputerRowDotTone(rowDotStatus)}
          data-testid={`computer-status-dot-${machine.id}`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center">
          <span className="min-w-0 truncate text-sm font-bold text-black">{machine.name}</span>
        </div>
        {machine.description && (
          <div className="mt-0.5 truncate text-[11px] leading-tight text-black/60">
            {machine.description}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-black/50 font-mono">
          {(() => {
            const label = getMachineRunLabelDescriptor(machine);
            return (
              <span className={`truncate${label.isOffline ? " text-black/30 italic" : ""}`}>
                <MachineRunLabel machine={machine} />
              </span>
            );
          })()}
          {upgradeAvailable && machine.computerBroadcastPolicy?.targetVersion && (
            <span className="shrink-0 text-brutal-orange font-bold">
              → v{machine.computerBroadcastPolicy.targetVersion}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

type SidebarCtxKind = CtxMenu["type"];

// Touch long-press handlers spread onto a sidebar row button.
type SidebarLongPress = {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
};

// Pure — at module scope so the memoized row leaves below can compute their own
// className from primitive `selected`/`menuOpen` props (no className prop, which
// would change identity every parent render and defeat memoization).
// Stryker disable all: row class-token variants are visual-equivalent under the DOM oracle; wrap/unread behavior is pinned by focused Sidebar DOM tests.
function sidebarItemClass(selected: boolean, menuOpen = false, allowWrap = false) {
  return `mb-1  flex w-full ${allowWrap ? "items-start" : "items-center"} gap-1.5 px-2 py-2 [@media(max-height:600px)]:py-1 md:py-1 text-sm font-medium border-2 ${
    selected
      ? "border-black bg-brutal-pink text-black shadow-brutal-sm font-bold"
      : menuOpen
      ? "border-black bg-white shadow-brutal-sm"
      : "border-transparent hover:border-black hover:bg-white hover:shadow-brutal-sm active:border-black active:bg-white active:shadow-brutal-sm transition-colors"
  }`;
}
// Stryker restore all

function SidebarAgentActivityBadge({ agentId }: { agentId: string }) {
  return (
    <span data-sidebar-avatar-badge-shell="true" className="absolute bottom-0 right-0 block size-0">
      <AgentActivityDot
        agentId={agentId}
        size="sm"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      />
    </span>
  );
}

// Per-row leaf components. Two properties make them the fix for the
// channel-switch freeze:
//
//  1. They subscribe to ONLY their own unread/draft slice, so an incoming
//     `message:new` (which rebuilds the whole `unreadCounts` Record with a new
//     reference) re-renders just the one affected row, not the whole Sidebar.
//
//  2. They are `memo`'d with STABLE props — `channel`/`dm`/`agent` (structurally
//     shared by the stores), primitive `selected`/`menuOpen`, and parent
//     callbacks that are `useCallback`-stable. So when the parent DOES re-render
//     (every `message:new` rebuilds `channels`/`dmChannels` via
//     `touchChannelActivity`, bumping `lastMessageAt`), the 100s of unaffected
//     rows skip reconciliation instead of all re-rendering. Without stable props
//     memo is a no-op and the parent's re-render still walks every row — which is
//     exactly the ~80ms-of-children cost the profiler caught.
//
// The row builds its own event-handler closures from the stable callbacks; those
// inner closures are irrelevant to memo (memo compares the incoming props).
// Mirrors the <ComputerRow> machine-status isolation above. (broad-subscription sweep P0-B)
// Stryker disable all: ChannelRow changed lines here are visual class-token/default-prop variants; pinned/channel row identity, wrapping, dim/mute/unread behavior are covered by behavior tests.
const ChannelRow = memo(function ChannelRow({
  channel,
  selected,
  menuOpen,
  onSelect,
  onContextMenu,
  makeLongPress,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  // Stryker disable next-line BooleanLiteral: default row wrapping is a visual fallback; pinned wrapping is covered by explicit DOM tests.
  allowWrap = false,
}: {
  channel: Channel;
  selected: boolean;
  menuOpen: boolean;
  onSelect: (channel: Channel, clickCount: number) => void;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>, channel: Channel) => void;
  onDragEnd?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLButtonElement>, channel: Channel) => void;
  onDrop?: (event: React.DragEvent<HTMLButtonElement>, channel: Channel) => void;
  allowWrap?: boolean;
}) {
  const unread = useMessageStore((s) => s.unreadCounts[channel.id] || 0);
  const mentionMarked = useMessageStore((s) => s.mentionFlags[channel.id] === true);
  const hasDraft = useMessageStore((s) => !!s.drafts[channel.id]);
  // Display-language (react-intl) — the row owns its own marker copy so the
  // memoized leaf does not need a new prop from the parent.
  const { formatMessage } = useIntl();
  const dimmed = !selected && !channel.joined;
  const activityMuted = channel.activityMuted === true;
  const showMutedIcon = shouldShowActivityMutedIcon({ activityMuted, joined: channel.joined });
  const { showLoudUnreadBadge, showQuietUnreadCount } = getChannelUnreadIndicatorState({
    unread,
    joined: channel.joined === true,
    showMutedIcon,
  });
  const showMentionMarker = mentionMarked && channel.joined;
  return (
    <button
      data-sidebar-channel-id={channel.id}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      draggable={!!onDragStart}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      onDragStart={(event) => onDragStart?.(event, channel)}
      onDragEnd={onDragEnd}
      onDragOver={(event) => onDragOver?.(event, channel)}
      onDrop={(event) => onDrop?.(event, channel)}
      onClick={(event) => onSelect(channel, event.detail)}
      onContextMenu={(e) => onContextMenu(e, "channel", channel.id)}
      {...makeLongPress("channel", channel.id)}
      className={sidebarItemClass(selected, menuOpen, allowWrap)}
    >
      <div className="flex size-[18px] shrink-0 items-center justify-center">
        <ChannelKindIcon type={channel.type} className={dimmed ? "text-black/40" : ""} />
      </div>
      <span className={`min-w-0 flex flex-1 ${allowWrap ? "items-start" : "items-center"} text-left`}>
        <span className={`min-w-0 ${allowWrap ? "whitespace-normal break-words leading-tight" : "truncate"} ${dimmed ? "text-black/40" : activityMuted ? "text-black/70" : ""} ${showLoudUnreadBadge ? "font-bold" : ""}`}>{channel.name}</span>
        {channel.bridge?.provider === "slack" && (
          <span
            className="ml-1 shrink-0 border border-black bg-brutal-lavender px-1 font-mono text-[9px] font-bold uppercase leading-4 text-black"
            title={formatMessage({ id: "settings.slackBridge.providerBadge" })}
          >
            {formatMessage({ id: "settings.slackBridge.providerBadge" })}
          </span>
        )}
        {showMutedIcon && (
          <span
            className="ml-1 inline-flex size-4 shrink-0 items-center justify-center text-black/40"
            title={formatMessage({ id: "layout.sidebar.activityMutedTitle" })}
            data-testid="sidebar-activity-muted"
            aria-label={formatMessage({ id: "layout.sidebar.activityMutedAria" })}
          >
            <BellOff size={12} />
          </span>
        )}
      </span>
      {showMentionMarker && (
        <span
          className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded border border-black bg-soft-signal text-black"
          title={formatMessage({ id: "layout.sidebar.mentionedYouTitle" })}
          data-testid="sidebar-mention-marker"
          aria-label={formatMessage({ id: "layout.sidebar.mentionedYouAria" })}
        >
          <AtSign size={10} />
        </span>
      )}
      {showLoudUnreadBadge ? (
        <span className="ml-auto shrink-0 rounded bg-brutal-pink px-1.5 py-0.5 text-[10px] font-bold leading-none text-white border border-black">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : showQuietUnreadCount ? (
        <span className={`${showMutedIcon || showMentionMarker ? "ml-1" : "ml-auto"} shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-black/50 font-mono`}>
          {unread > 99 ? "99+" : unread}
        </span>
      ) : hasDraft && (
        <Pencil size={12} className={`${showMutedIcon ? "ml-1" : "ml-auto"} shrink-0 text-black/40`} />
      )}
    </button>
  );
});
// Stryker restore all

// DM row (handles both human and agent peers). Used by the DM list and pinned
// human DMs. The context-menu target (`ctxType`/`ctxId`) can differ from the DM
// channel id (e.g. agent DMs target the agent), so it is passed explicitly.
const DmRow = memo(function DmRow({
  dm,
  isAgent,
  peerId,
  displayName,
  description,
  avatarUrl,
  selected,
  menuOpen,
  ctxType,
  ctxId,
  onSelect,
  onContextMenu,
  makeLongPress,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  // Stryker disable next-line BooleanLiteral: default DM wrapping is a visual fallback; pinned wrapping is covered by explicit DOM tests.
  allowWrap = false,
}: {
  dm: Channel;
  isAgent: boolean;
  peerId: string | null;
  displayName: string;
  description: string | null;
  avatarUrl: string | null;
  selected: boolean;
  menuOpen: boolean;
  ctxType: SidebarCtxKind;
  ctxId: string;
  onSelect: (dmId: string, clickCount: number) => void;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>, dm: Channel) => void;
  onDragEnd?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLButtonElement>, dm: Channel) => void;
  onDrop?: (event: React.DragEvent<HTMLButtonElement>, dm: Channel) => void;
  allowWrap?: boolean;
}) {
  // Stryker disable all: visual class-token mutations are equivalent in the DOM oracle; pinned DM profile/source, wrapping, unread and pin-menu behavior are covered by behavior tests.
  const unread = useMessageStore((s) => s.unreadCounts[dm.id] || 0);
  // Stryker disable next-line all: pre-existing draft badge logic is outside the workspace mutation corpus.
  const hasDraft = useMessageStore((s) => !!s.drafts[dm.id]);
  return (
    <button
      data-sidebar-channel-id={dm.id}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      draggable={!!onDragStart}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      onDragStart={(event) => onDragStart?.(event, dm)}
      onDragEnd={onDragEnd}
      onDragOver={(event) => onDragOver?.(event, dm)}
      onDrop={(event) => onDrop?.(event, dm)}
      onClick={(event) => onSelect(dm.id, event.detail)}
      onContextMenu={(e) => onContextMenu(e, ctxType, ctxId)}
      {...makeLongPress(ctxType, ctxId)}
      className={sidebarItemClass(selected, menuOpen, allowWrap)}
    >
      {isAgent ? (
        <AvatarSlot
          context="sidebar-list"
          type="agent"
          agentAvatarUrl={avatarUrl}
          badge={peerId ? <SidebarAgentActivityBadge agentId={peerId} /> : undefined}
        />
      ) : (
        <AvatarSlot
          context="sidebar-list"
          type="human"
          humanAvatarUrl={dm.peerAvatarUrl ?? null}
          gravatarHash={dm.peerGravatarHash ?? null}
          humanPlaceholder={!dm.peerAvatarUrl && !dm.peerGravatarHash}
        />
      )}
      <div className={`flex min-w-0 flex-1 ${allowWrap ? "flex-col items-start gap-0.5" : "items-baseline gap-1"} text-left`}>
        <span className={`${allowWrap ? "min-w-0 max-w-full whitespace-normal break-words leading-tight" : "shrink-0 max-w-[70%] truncate"} text-sm ${unread > 0 ? "font-bold" : ""}`}>
          {displayName}
        </span>
        {description && (
          <span className={`min-w-0 ${allowWrap ? "max-w-full whitespace-normal break-words leading-tight" : "flex-1 truncate"} text-xs text-black/40`}>{description}</span>
        )}
      </div>
      <span className="flex shrink-0 self-center items-center gap-1.5">
        {unread > 0 ? (
          <span className="rounded bg-brutal-pink px-1.5 py-0.5 text-[10px] font-bold leading-none text-white border border-black">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : hasDraft && (
          <Pencil size={12} className="text-black/40" />
        )}
      </span>
    </button>
  );
  // Stryker restore all
});

// Pinned agent DM row — keyed off the agent entity; subscribes to the agent's
// DM channel unread (if a DM channel exists yet).
export const AgentDmRow = memo(function AgentDmRow({
  agent,
  dmId,
  dm,
  selected,
  menuOpen,
  onSelect,
  onContextMenu,
  makeLongPress,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  allowWrap = false,
  hideDescription = false,
}: {
  agent: Agent;
  dmId: string | undefined;
  dm: Channel | undefined;
  selected: boolean;
  menuOpen: boolean;
  onSelect: (agent: Agent, dmId: string | undefined, clickCount: number) => void;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>, agent: Agent, dmId: string | undefined) => void;
  onDragEnd?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLButtonElement>, dmId: string | undefined) => void;
  onDrop?: (event: React.DragEvent<HTMLButtonElement>, dmId: string | undefined) => void;
  allowWrap?: boolean;
  hideDescription?: boolean;
}) {
  // Stryker disable all: visual class-token mutations are equivalent in the DOM oracle; agent DM profile/source, wrapping, unread and pin-menu behavior are covered by behavior tests.
  const unread = useMessageStore((s) => (dmId ? s.unreadCounts[dmId] || 0 : 0));
  const hasDraft = useMessageStore((s) => (dmId ? !!s.drafts[dmId] : false));
  const { displayName, description, avatarUrl } = resolveAgentDmProfileSource(agent, dm);
  return (
    <button
      // The ordinary DM row publishes this too. Without it, the same pinned
      // conversation would gain or lose its channel identity purely from whether
      // the agent is still in the client's agent list — `pinnedItems` picks this
      // renderer on a cache hit and the DM renderer on a miss. Omitted when the
      // agent has no DM channel yet, since there is no channel to name.
      data-sidebar-channel-id={dmId}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      draggable={!!onDragStart}
      // Stryker disable next-line all: optional workspace drag glue is browser-smoke verified.
      onDragStart={(event) => onDragStart?.(event, agent, dmId)}
      onDragEnd={onDragEnd}
      onDragOver={(event) => onDragOver?.(event, dmId)}
      onDrop={(event) => onDrop?.(event, dmId)}
      onClick={(event) => onSelect(agent, dmId, event.detail)}
      onContextMenu={(e) => onContextMenu(e, "agent", agent.id)}
      {...makeLongPress("agent", agent.id)}
      className={sidebarItemClass(selected, menuOpen, allowWrap)}
    >
      <AvatarSlot
        context="sidebar-list"
        type="agent"
        agentAvatarUrl={avatarUrl}
        badge={<SidebarAgentActivityBadge agentId={agent.id} />}
      />
      <div className={`flex min-w-0 flex-1 ${allowWrap ? "flex-col items-start gap-0.5" : "items-baseline gap-1"} text-left`}>
        <span className={`${allowWrap ? "min-w-0 max-w-full whitespace-normal break-words leading-tight" : "shrink-0 max-w-[70%] truncate"} text-sm ${unread > 0 ? "font-bold" : ""}`}>{displayName}</span>
        {!hideDescription && description && (
          <span className={`min-w-0 ${allowWrap ? "max-w-full whitespace-normal break-words leading-tight" : "flex-1 truncate"} text-xs text-black/40`}>{description}</span>
        )}
      </div>
      <span className="flex shrink-0 self-center items-center gap-1.5">
        {unread > 0 ? (
          <span className="rounded bg-brutal-pink px-1.5 py-0.5 text-[10px] font-bold leading-none text-white border border-black">
            {/* Stryker disable all: pre-existing unread cap is outside the workspace mutation corpus. */}
            {unread > 99 ? "99+" : unread}
            {/* Stryker restore all */}
          </span>
        ) : hasDraft && (
          <Pencil size={12} className="text-black/40" />
        )}
      </span>
    </button>
  );
  // Stryker restore all
});

function MobileServerSelectorVectorSurface() {
  const surfaceRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ width: 168, height: 36 });

  useLayoutEffect(() => {
    const button = surfaceRef.current?.parentElement;
    if (!button) return;
    const measure = () => {
      const rect = button.getBoundingClientRect();
      setSize((current) => (
        Math.abs(current.width - rect.width) < 0.01 && Math.abs(current.height - rect.height) < 0.01
          ? current
          : { width: rect.width, height: rect.height }
      ));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  const viewBox = `0 0 ${size.width} ${size.height}`;
  return (
    <svg
      ref={surfaceRef}
      aria-hidden="true"
      focusable="false"
      className="mobile-server-selector-vector-surface"
      viewBox={viewBox}
      preserveAspectRatio="none"
    >
      <polygon className="mobile-server-selector-vector-shadow" points={mobileServerSelectorPolygon(size.width, size.height, 2)} />
      <polygon className="mobile-server-selector-vector-face" points={mobileServerSelectorPolygon(size.width, size.height, 0)} />
    </svg>
  );
}

export default function Sidebar({ mobileInline, bottomSlot, workspaceRailMode }: SidebarProps) {
  // Display-language (react-intl) — layout namespace. The 8 settings sub-nav
  // destinations below reuse the already-merged, AngLee-final `settings.tabs.*`
  // ids (identical English source + same destination) rather than forking the
  // copy under `layout.*`; everything else here resolves `layout.sidebar.*`
  // (zh finalized by @AngLee 2026-07-22).
  const { formatMessage } = useIntl();
  // `lastMessageAt` lives in the `channelActivity` slice (not the channel
  // objects), so `channels`/`dmChannels` are stable across inbound-message
  // activity bumps — plain subscriptions no longer re-render the whole Sidebar
  // per message (the channel-switch freeze / hover jank root).
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  // Loading flag so the channels/DMs lists show a skeleton WHILE loading
  // instead of the "No X yet" empty state, which otherwise renders first and
  // then flashes to the real list once data arrives (闪回 fix, task #32).
  const channelsLoading = useChannelStore((s) => s.loading);
  // `channelActivity` drives recency sorting. Subscribe it LIVE only when a
  // recency sort is active; otherwise freeze the snapshot so an inbound-message
  // bump doesn't re-render the Sidebar. `recencyActiveRef` is set below once the
  // sort modes are known; the (stable) snapshot reads it at compare time (between
  // renders), so a one-render lag on a sort-mode toggle is harmless.
  const recencyActiveRef = useRef(false);
  const activitySnapRef = useRef<Record<string, string | null>>({});
  const getActivitySnap = useCallback(() => {
    if (recencyActiveRef.current) {
      activitySnapRef.current = useChannelStore.getState().channelActivity;
    }
    return activitySnapRef.current;
  }, []);
  const channelActivity = useSyncExternalStore(useChannelStore.subscribe, getActivitySnap);
  const deleteChannel = useChannelStore((s) => s.deleteChannel);
  const archiveChannel = useChannelStore((s) => s.archiveChannel);
  const openUserDM = useChannelStore((s) => s.openUserDM);
  const openDM = useChannelStore((s) => s.openDM);
  const allAgents = useAgentStore((s) => s.agents);
  const agents = useMemo(() => allAgents.filter((a) => !a.deletedAt), [allAgents]);
  // Loading flags so the agents / computers lists show a skeleton WHILE loading
  // instead of flashing "No agents/computers yet" then the real rows (闪回 fix).
  const agentsLoading = useAgentStore((s) => s.loading);
  const machinesLoading = useMachineStore((s) => s.loading);
  const deleteAgent = useAgentStore((s) => s.deleteAgent);
  const startAgent = useAgentStore((s) => s.startAgent);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const setShowCreateAgent = useAgentStore((s) => s.setShowCreateAgent);
  // Parent subscribes ONLY stable machine identity (id → name), never the
  // status-bearing machine objects. `useShallow` short-circuits when the
  // id/name set is unchanged, so the high-frequency `machine:status` event
  // stream (cross-replica mirror / presence flaps) no longer re-renders the
  // whole Sidebar (× its ~140 rows). Per-machine status lives in <ComputerRow>.
  const machineNames = useMachineStore(
    useShallow((s) => Object.fromEntries(s.machines.map((m) => [m.id, m.name] as const))),
  );
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  const user = useAuthStore((s) => s.user);
  const server = useServerStore((s) => s.current);
  const servers = useServerStore((s) => s.servers);
  const sidebarOrder = useServerStore((s) => s.sidebarOrder);
  const customSections = sidebarOrder.customSections ?? EMPTY_CUSTOM_SECTIONS;
  const sectionOrder = sidebarOrder.sectionOrder ?? DEFAULT_SECTION_ORDER;
  const sectionPlacements = sidebarOrder.sectionPlacements ?? EMPTY_SECTION_PLACEMENTS;
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  // NOTE: the parent intentionally does NOT subscribe to the whole
  // `unreadCounts` / `drafts` Records — those churn a new reference on every
  // inbound `message:new`, which previously re-rendered this entire (~2300-line,
  // hundreds-of-rows) component on every message and froze channel-switching in
  // large servers. Per-row unread/draft now lives in the <ChannelRow>/<DmRow>/
  // <AgentDmRow> leaves; the parent derives only narrowed aggregates below
  // (`unreadFlags` for collapsed-section dots, `closedDmUnreadIds` for the
  // closed-DM auto-reopen). Non-reactive one-off reads use getState().
  // Narrowed trigger for the eager cross-server unread-summary refetch below.
  // Subscribing the effect to the whole `unreadCounts` Record made it re-run
  // (and fire GET /servers/unread-summary) on EVERY inbound message, because
  // messageStore rebuilds the Record with a new reference per `message:new`.
  // The cross-server badge only cares whether *any* local unread exists, so we
  // collapse to a boolean — it flips on 0↔nonzero transitions, not per message.
  // (Mirrors the LeftRail/ChatPanel narrowing in PR #2590.)
  const hasLocalUnread = useMessageStore((s) =>
    Object.values(s.unreadCounts).some((count) => count > 0),
  );
  const markRead = useMessageStore((s) => s.markRead);
  // Stryker disable next-line ArrowFunction: adjacent pre-existing selector is outside the Activity mute behavior slice.
  const markUnread = useMessageStore((s) => s.markUnread);
  // Stryker disable next-line all: pre-existing inbox loading is outside the workspace mutation corpus.
  const loadInbox = useInboxStore((s) => s.loadInbox);
  // Subscribe to the server-provided total (not the loaded `saved` page) so the
  // badge reflects the true count, and so this always-mounted row doesn't
  // re-render on every saved-list page mutation — just on count change.
  const savedTotal = useSavedStore((s) => s.total);
  const navigate = useNavigate();
  const nav = useAppNavigate();
  const location = useLocation();
  // React Router returns a new `navigate` function when location changes. Keep
  // both route values behind refs so the memoized sidebar-row handlers do not
  // change identity after a click and force every sibling row to reconcile.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const serverSlugRef = useRef(server?.slug);
  serverSlugRef.current = server?.slug;
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const handledSidebarFocusLocationKeyRef = useRef<string | null>(null);
  const workspaceEnabled = useWorkspaceGridNavigationStore(selectWorkspaceGridActive);
  const workspaceActiveRefKey = useWorkspaceGridNavigationStore(selectWorkspaceGridActiveRefKey);
  const workspaceActiveAncestorRefKey = useWorkspaceGridNavigationStore(selectWorkspaceGridActiveAncestorRefKey);
  // Mobile-only Wiki entry: desktop reaches Wiki through the LeftRail, which
  // is hidden on mobile, so the sidebar Home group is Wiki's mobile entry.
  const wikiEnabled = useServerFeatureFlag(WIKI_FEATURE_FLAG_KEY).enabled;
  const labsUiEnabled = useServerFeatureFlag(SERVER_LABS_UI_FEATURE_FLAG_KEY).enabled;
  const providerConnectionsEnabled = useServerFeatureFlag(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY).enabled;
  const slackBridgeGate = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  const slackBridgeEnabled = isSlackBridgeSurfaceEnabled(slackBridgeGate);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showCreateJointChannel, setShowCreateJointChannel] = useState(false);
  const [showCreateAgentMenu, setShowCreateAgentMenu] = useState(false);
  const createAgentMenuRef = useRef<HTMLDivElement | null>(null);
  const [showCreateExternalAgent, setShowCreateExternalAgent] = useState(false);
  const [showInviteHuman, setShowInviteHuman] = useState(false);
  const [serverUnreadCounts, setServerUnreadCounts] = useState<Record<string, ServerUnreadSummary>>({});
  const currentServerActivityCount = server?.id
    ? serverUnreadCounts[server.id]?.activityUnreadCount
    : undefined;
  // Activity is rendered only from the server's known authority. An absent
  // field is unknown and must not be replaced with the broader legacy count.
  const activityUnreadCount = currentServerActivityCount;
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const moveToSectionTriggerRef = useRef<HTMLDivElement | null>(null);
  const [moveToSectionMenuOpen, setMoveToSectionMenuOpen] = useState(false);
  const [moveToSectionMenuPosition, setMoveToSectionMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [sidebarDndProjection, setSidebarDndProjection] = useState<SidebarDndProjection | null>(null);
  const [sidebarDndActiveId, setSidebarDndActiveId] = useState<string | null>(null);
  const sidebarDndSnapshotRef = useRef<SidebarDndProjection | null>(null);
  const sidebarDndProjectionRef = useRef<SidebarDndProjection | null>(null);
  const workspaceSidebarNativeDragIdRef = useRef<string | null>(null);
  const setMoveToSectionMenuNode = useCallback((menu: HTMLDivElement | null) => {
    const trigger = moveToSectionTriggerRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    setMoveToSectionMenuPosition(placeSidebarContextSubmenu({
      anchor: {
        left: triggerRect.left,
        right: triggerRect.right,
        top: triggerRect.top,
      },
      menuWidth: menuRect.width,
      menuHeight: menuRect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }, []);
  const [sectionCtxMenu, setSectionCtxMenu] = useState<SectionCtxMenu | null>(null);
  const sectionCtxMenuRef = useRef<HTMLDivElement | null>(null);
  const [sidebarSurfaceCtxMenu, setSidebarSurfaceCtxMenu] = useState<SidebarSurfaceCtxMenu | null>(null);
  const sidebarSurfaceCtxMenuRef = useRef<HTMLDivElement | null>(null);
  const [sectionDialog, setSectionDialog] = useState<
    | { mode: "create"; moveItem?: SidebarMovableItem }
    | { mode: "edit"; section: SidebarCustomSection }
    | null
  >(null);
  const [collapsedCustomSections, setCollapsedCustomSections] = useState<Record<string, boolean>>(() => (
    Object.fromEntries(customSections.map((section) => [
      section.id,
      readSidebarCustomSectionCollapsed(user?.id, section.id),
    ]))
  ));
  const collapsedCustomSectionUserIdRef = useRef(user?.id);
  const customSectionIdsKey = customSections.map((section) => section.id).join("\u0000");
  const collapsedCustomSectionIdsKeyRef = useRef(customSectionIdsKey);
  useEffect(() => {
    if (
      collapsedCustomSectionUserIdRef.current === user?.id
      && collapsedCustomSectionIdsKeyRef.current === customSectionIdsKey
    ) return;
    collapsedCustomSectionUserIdRef.current = user?.id;
    collapsedCustomSectionIdsKeyRef.current = customSectionIdsKey;
    // oxlint-disable-next-line react-doctor/no-chain-state-updates -- disclosure state must reset when the authenticated user or server sections change.
    setCollapsedCustomSections(Object.fromEntries(customSections.map((section) => [
      section.id,
      readSidebarCustomSectionCollapsed(user?.id, section.id),
    ])));
  }, [customSectionIdsKey, customSections, user?.id]);
  // Members rail: per-machine disclosure for the AGENTS list groups, persisted
  // per user and stable machine id (mirrors the custom-section pattern above).
  const agentMachineGroupKeys = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const agent of agents) {
      const key = agent.machineId ?? "__no_machine__";
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    return keys;
  }, [agents]);
  const agentMachineGroupIdsKey = agentMachineGroupKeys.join("\u0000");
  const [collapsedAgentMachineGroups, setCollapsedAgentMachineGroups] = useState<Record<string, boolean>>(() => (
    Object.fromEntries(agentMachineGroupKeys.map((key) => [
      key,
      readSidebarAgentMachineGroupCollapsed(user?.id, key),
    ]))
  ));
  const collapsedAgentMachineGroupUserIdRef = useRef(user?.id);
  const collapsedAgentMachineGroupIdsKeyRef = useRef(agentMachineGroupIdsKey);
  useEffect(() => {
    if (
      collapsedAgentMachineGroupUserIdRef.current === user?.id
      && collapsedAgentMachineGroupIdsKeyRef.current === agentMachineGroupIdsKey
    ) return;
    collapsedAgentMachineGroupUserIdRef.current = user?.id;
    collapsedAgentMachineGroupIdsKeyRef.current = agentMachineGroupIdsKey;
    // oxlint-disable-next-line react-doctor/no-chain-state-updates -- disclosure state must reset when the authenticated user or machine grouping changes.
    setCollapsedAgentMachineGroups(Object.fromEntries(agentMachineGroupKeys.map((key) => [
      key,
      readSidebarAgentMachineGroupCollapsed(user?.id, key),
    ])));
  }, [agentMachineGroupIdsKey, agentMachineGroupKeys, user?.id]);
  const toggleAgentMachineGroup = (key: string) => {
    setCollapsedAgentMachineGroups((prev) => {
      const nextCollapsed = !(prev[key] === true);
      writeSidebarAgentMachineGroupCollapsed(user?.id, key, nextCollapsed);
      return { ...prev, [key]: nextCollapsed };
    });
  };
  const [deleteSectionConfirm, setDeleteSectionConfirm] = useState<SidebarCustomSection | null>(null);
  // iOS PWA (display:standalone) does not reliably suppress the synthetic
  // click after a long-press touchend, even with e.preventDefault(). That
  // phantom click would land on the context menu overlay or a menu button
  // and close the menu the instant the finger lifted. We absorb clicks with
  // an invisible full-screen shield for ~500ms after a long-press opens the
  // menu, then remove it so the user can interact normally.
  const [ctxMenuClickShielded, setCtxMenuClickShielded] = useState(false);
  const ctxMenuShieldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: "channel" | "agent";
    id: string;
    name: string;
  } | null>(null);
  const [stopAgentConfirm, setStopAgentConfirm] = useState<{ id: string; name: string } | null>(null);
  const [resetAgentTarget, setResetAgentTarget] = useState<{ id: string; name: string } | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Stryker disable all: pre-existing deleted-agent confirmation cleanup is outside the workspace mutation corpus.
  useEffect(() => {
    if (deleteConfirm?.type !== "agent") return;
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (allAgents.some((agent) => agent.id === deleteConfirm.id && agent.deletedAt)) {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setDeleteConfirm(null);
    }
  }, [allAgents, deleteConfirm]);
  // Stryker restore all

  // Stryker disable next-line all: pre-existing account menu state is outside the workspace mutation corpus.
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showServerMenu, setShowServerMenu] = useState(false);
  // Stryker disable next-line all: pre-existing member subscription is covered by sidebar behavior tests.
  const members = useServerStore((s) => s.members);
  const membersLoadError = useServerStore((s) => s.membersLoadError);
  const { role: currentRole, capabilities } = useServerPermissions();
  const canManageServer = capabilities.editServerSettings;
  const canCreateChannel = capabilities.createChannels;
  const canCreateJointChannel = capabilities.federateChannels;
  const canCreateAgent = capabilities.createAgents;
  const canRegisterMachines = capabilities.registerMachines;
  const canInviteMembers = capabilities.inviteMembers;
  const canManageExternalAuth = capabilities.manageExternalAuth;
  const canViewBillingSettings = canOpenSettingsTab("billing", capabilities);
  const canViewAdministrationSettings = canOpenSettingsTab("administration", capabilities);
  const canViewApplicationsSettings = canOpenSettingsTab("integrations", capabilities, currentRole);
  const canViewMcpSettings = canOpenSettingsTab("mcp", capabilities, currentRole);
  // Stryker disable next-line all: pre-existing membership privacy is covered by server/sidebar tests.
  const hideHumansFromMembers = server?.role === "member" && server.hideHumansFromMembers;
  // The single source of truth for which left-column surface is active.
  // Both Sidebar and LeftRail derive from useRailMode(), which reads the
  // URL — so the rail's highlighted button and the sidebar's content stay
  // strictly in sync. On mobile the LeftRail is hidden; the 4-tab mobile
  // bar maps /computers back to the Settings tab (Computers is reachable
  // from the Settings sub-nav, not Members).
  const { railMode: routeRailMode, selectRailMode } = useRailMode();
  // Stryker disable all: host-mode projection is source-contract and browser-smoke verified.
  const railMode = workspaceEnabled && workspaceRailMode ? workspaceRailMode : routeRailMode;
  const activeTab: "chat" | "members" = railMode === "members" || railMode === "humans" ? "members" : "chat";
  const showSettingsRail = railMode === "settings";
  const showComputersRail = railMode === "computers";
  const showChatRail = activeTab === "chat";
  const railLabel = railMode === "settings" ? formatMessage({ id: "layout.sidebar.headerSettings" })
    : railMode === "tasks" ? formatMessage({ id: "layout.sidebar.headerTasks" })
    : railMode === "computers" ? formatMessage({ id: "layout.sidebar.headerComputers" })
    : railMode === "humans" ? formatMessage({ id: "layout.sidebar.humans" })
    : railMode === "members" ? formatMessage({ id: "layout.sidebar.headerMembers" })
    : formatMessage({ id: "layout.sidebar.headerChat" });
  // Stryker restore all
  const selectSidebarTab = useCallback(
    (tab: "chat" | "members") => selectRailMode(tab),
    [selectRailMode],
  );

  const [collapsed, setCollapsed] = useState<SidebarCollapsedSections>(() => (
    readSidebarCollapsedSections(user?.id)
  ));
  const collapsedPreferenceUserIdRef = useRef(user?.id);
  useEffect(() => {
    if (collapsedPreferenceUserIdRef.current === user?.id) return;
    collapsedPreferenceUserIdRef.current = user?.id;
    setCollapsed(readSidebarCollapsedSections(user?.id));
  }, [user?.id]);
  const channelSortMode = sidebarOrder.channelSortMode;
  const jointChannelSortMode = sidebarOrder.jointChannelSortMode;
  const dmSortMode = sidebarOrder.dmSortMode;
  const pinnedSortMode = sidebarOrder.pinnedSortMode;
  // When any list sorts by recency, `lastMessageAt` order matters → the
  // channels/dmChannels subscriptions (above) must react to every bump. In the
  // default manual/az modes it does not, so those bumps are ignored.
  recencyActiveRef.current =
    channelSortMode === "recent" ||
    jointChannelSortMode === "recent" ||
    dmSortMode === "recent" ||
    pinnedSortMode === "recent";
  const [openSortMenu, setOpenSortMenu] = useState<SidebarSortSection | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  // Stryker disable all: React persistence wiring is browser/DOM verified; storage and membership semantics are mutation-tested in sidebarChannelVisibility.
  const [joinedChannelsOnly, setJoinedChannelsOnly] = useState(() =>
    readSidebarJoinedChannelsOnly(server?.id),
  );

  const updatePinnedSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ pinnedSortMode: mode });
  }, [updateSidebarOrder]);

  const updateChannelSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ channelSortMode: mode });
  }, [updateSidebarOrder]);

  const updateJointChannelSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ jointChannelSortMode: mode });
  }, [updateSidebarOrder]);

  const updateDmSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ dmSortMode: mode });
  }, [updateSidebarOrder]);

  const updateJoinedChannelsOnly = useCallback((joinedOnly: boolean) => {
    setJoinedChannelsOnly(joinedOnly);
    writeSidebarJoinedChannelsOnly(server?.id, joinedOnly);
  }, [server?.id]);

  useEffect(() => {
    if (!openSortMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && sortMenuRef.current?.contains(target)) return;
      setOpenSortMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSortMenu(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    // keydown-global-exempt: sort dropdown menu escape-close, focus stays on trigger
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openSortMenu]);

  useEffect(() => {
    setJoinedChannelsOnly(readSidebarJoinedChannelsOnly(server?.id));
  }, [server?.id]);
  // Stryker restore all

  useEffect(() => {
    if (!showCreateAgentMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && createAgentMenuRef.current?.contains(target)) return;
      setShowCreateAgentMenu(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowCreateAgentMenu(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    // keydown-global-exempt: create-agent dropdown menu escape-close, focus stays on trigger
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showCreateAgentMenu]);

  useEffect(() => {
    void loadInbox({ reset: true });
  }, [loadInbox, server?.id]);

  const focusFirstUnreadInboxItem = useCallback(() => {
    // Express the intent rather than computing the key synchronously here: at
    // dbl-click time `items` may not be loaded yet (fast mount, or a prod build
    // where this races ThreadsInbox's own load), and the old sync `find()` then
    // returned undefined → focus cleared → no highlight (preview-mode e2e flake
    // thread/sidebar-dblclick.spec.ts:25). ThreadsInbox resolves this to a
    // concrete focusedItemKey once items arrive, regardless of which load wins.
    useInboxStore.getState().setPendingFocusKind("first-unread");
    void useInboxStore.getState().loadInbox({ reset: true });
  }, []);

  // Closed DMs — server-synced via sidebarOrder for cross-device consistency
  const closedDmIds = useMemo(() => new Set(sidebarOrder.hiddenDmIds), [sidebarOrder.hiddenDmIds]);
  const closeDm = useCallback((dmId: string) => {
    const current = sidebarOrder.hiddenDmIds;
    if (current.includes(dmId)) return;
    void updateSidebarOrder({ hiddenDmIds: [...current, dmId] });
    // Navigate away if the closed DM is currently active
    const slug = useServerStore.getState().current?.slug;
    if (slug && location.pathname === `/s/${slug}/dm/${dmId}`) {
      navigate(`/s/${slug}`);
    }
  }, [sidebarOrder.hiddenDmIds, updateSidebarOrder, location.pathname, navigate]);
  const reopenDm = useCallback((dmId: string) => {
    const current = sidebarOrder.hiddenDmIds;
    if (!current.includes(dmId)) return;
    void updateSidebarOrder({ hiddenDmIds: current.filter((id) => id !== dmId) });
  }, [sidebarOrder.hiddenDmIds, updateSidebarOrder]);

  const [channelOrderIds, setChannelOrderIds] = useState<string[]>([]);
  const [dmOrderIds, setDmOrderIds] = useState<string[]>([]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 500, tolerance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const allChannelId = useMemo(() => channels.find((channel) => channel.name === "all")?.id ?? null, [channels]);

  useEffect(() => {
    const next = reconcileOrderIds(channels, sidebarOrder.channelOrder, allChannelId);
    setChannelOrderIds((prev) => arraysEqual(prev, next) ? prev : next);
  }, [sidebarOrder.channelOrder, channels, allChannelId]);

  useEffect(() => {
    const next = reconcileOrderIds(dmChannels, sidebarOrder.dmOrder);
    setDmOrderIds((prev) => arraysEqual(prev, next) ? prev : next);
  }, [sidebarOrder.dmOrder, dmChannels]);


  const toggleSection = (section: SidebarCollapsedSection) => {
    setCollapsed((prev) => {
      const nextValue = !prev[section];
      const next = { ...prev, [section]: nextValue };
      writeSidebarCollapsedSection(user?.id, section, nextValue);
      return next;
    });
  };

  const loadServerUnreadSummary = useCallback(async () => {
    try {
      const { data } = await api.get("/servers/unread-summary");
      const next = parseServerUnreadSummaryRows(data);
      setServerUnreadCounts((previous) => retainServerUnreadSummary(previous, next));
    } catch {
      // Ignore fetch failures to avoid sidebar noise.
    }
  }, []);

  useEffect(() => {
    if (!user || servers.length === 0) {
      setServerUnreadCounts({});
      return;
    }

    loadServerUnreadSummary();

    const intervalId = window.setInterval(() => {
      loadServerUnreadSummary();
    }, 30_000);
    const handleFocus = () => {
      loadServerUnreadSummary();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        loadServerUnreadSummary();
      }
    };
    const handleNotificationPrefsUpdated = () => {
      loadServerUnreadSummary();
    };

    window.addEventListener("focus", handleFocus);
    // Stryker disable next-line StringLiteral: pre-existing browser visibility wiring is outside the notification-prefs behavior slice.
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      // Stryker disable next-line StringLiteral: cleanup mirrors the pre-existing browser visibility listener above.
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    };
  }, [user, servers, loadServerUnreadSummary]);

  // Refresh server unread summary eagerly when unread counters change
  // (e.g. incoming message or mark-read), instead of waiting for polling.
  useEffect(() => {
    if (!user || servers.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      loadServerUnreadSummary();
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [hasLocalUnread, user, servers.length, loadServerUnreadSummary]);

  const hasOtherServerUnread = hasOtherServerActivityUnread(servers, server, serverUnreadCounts);

  const previousSidebarRouteRef = useRef({
    pathname: location.pathname,
    userId: user?.id,
  });

  // Auto-expand collapsed sections only for a navigation that happens while
  // the Sidebar is already mounted. On the first render, the route merely
  // describes the page being restored and must not override the user's saved
  // disclosure choices. Programmatic reveals stay transient: only an explicit
  // section-header click writes the preference.
  useEffect(() => {
    const path = location.pathname;
    const previousRoute = previousSidebarRouteRef.current;
    previousSidebarRouteRef.current = { pathname: path, userId: user?.id };
    if (
      path === previousRoute.pathname
      || user?.id !== previousRoute.userId
      || isSidebarDisclosureRestoreState(location.state)
    ) {
      return;
    }

    const channelMatch = path.match(/\/channel\/(.+)/);
    const dmMatch = path.match(/\/dm\/(.+)/);
    const agentMatch = path.match(/\/agent\/(.+)/);
    const machineMatch = path.match(/\/machine\/(.+)/);
    const humanMatch = path.match(/\/human\/(.+)/);

    if (channelMatch) {
      // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      if (collapsed.channels) setCollapsed((prev) => ({ ...prev, channels: false }));
    } else if (dmMatch) {
      // Expand DMs section (reuses agents collapsed state)
      if (collapsed.agents) setCollapsed((prev) => ({ ...prev, agents: false }));
      // Reopen DM if it was closed (e.g. navigated via Message button)
      reopenDm(dmMatch[1]);
    } else if (agentMatch) {
      // Expand agents in Tab 1
      if (collapsed.agents) setCollapsed((prev) => ({ ...prev, agents: false }));
      // Also expand in Tab 2
      if (collapsed.machinesAgents) setCollapsed((prev) => ({ ...prev, machinesAgents: false }));
    } else if (machineMatch) {
      if (collapsed.machinesAgents) setCollapsed((prev) => ({ ...prev, machinesAgents: false }));
    } else if (humanMatch) {
      if (collapsed.humans) setCollapsed((prev) => ({ ...prev, humans: false }));
    }
  }, [location.pathname, location.state, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close context menu on Escape. Outside-click is handled by the overlay
  // div in the portal (below) — using a document mousedown listener here
  // would race with iOS's synthetic mousedown after a long-press touchend,
  // closing the menu the instant it opens. The overlay pattern is the same
  // one MessageItem uses for its context menu.
  const closeCtx = useCallback(() => {
    setCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
  }, []);
  useEffect(() => {
    if (!ctxMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCtx();
    };
    // keydown-global-exempt: channel context-menu escape-close, anchored popover, focus stays on trigger
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ctxMenu, closeCtx]);

  // Stryker disable all: global Escape lifecycle is exercised by the Playwright proof; event-listener mutation is not stable in the focused DOM runner.
  const closeSectionCtx = useCallback(() => setSectionCtxMenu(null), []);
  useEffect(() => {
    if (!sectionCtxMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSectionCtx();
    };
    // keydown-global-exempt: section context-menu escape-close, anchored popover, focus stays on trigger
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sectionCtxMenu, closeSectionCtx]);

  const closeSidebarSurfaceCtx = useCallback(() => setSidebarSurfaceCtxMenu(null), []);
  useEffect(() => {
    if (!sidebarSurfaceCtxMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebarSurfaceCtx();
    };
    // keydown-global-exempt: the open sidebar surface menu closes globally on Escape.
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sidebarSurfaceCtxMenu, closeSidebarSurfaceCtx]);

  // Stryker restore all

  // Close user menu on outside click or Escape
  useEffect(() => {
    if (!showUserMenu) return;
    const onMouseDown = () => setShowUserMenu(false);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowUserMenu(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    // keydown-global-exempt: user dropdown menu escape-close, focus stays on trigger
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showUserMenu]);

  // Server-menu outside-click + ESC dismissal lives inside
  // <ServerSwitcherMenu>. The mobile pill trigger below uses
  // `onMouseDown={(e) => e.stopPropagation()}` to keep toggling from racing
  // the primitive's document mousedown listener.

  const markUnreadSidebarItemRead = useCallback((channelId: string) => {
    const messageStore = useMessageStore.getState();
    if (!messageStore.unreadCounts[channelId]) return;

    messageStore.clearUnread(channelId);
    void messageStore.markRead(channelId).catch(() => {
      void messageStore.loadUnreadCounts();
    });
  }, []);

  // Ref tracking which item is being long-pressed (set on touchstart).
  const longPressTargetRef = useRef<{ type: CtxMenu["type"]; id: string } | null>(null);

  const openCtxMenuAt = useCallback((x: number, y: number, type: CtxMenu["type"], id: string) => {
    setCtxMenu({ x, y, type, id });
    // Shield against the phantom click that fires after the long-press
    // touchend on iOS PWA standalone mode. Without this, the synthetic
    // click lands on the overlay (or the first menu button, if the finger
    // happens to be over it) and closes the menu immediately.
    setCtxMenuClickShielded(true);
    if (ctxMenuShieldTimerRef.current) clearTimeout(ctxMenuShieldTimerRef.current);
    ctxMenuShieldTimerRef.current = setTimeout(() => {
      setCtxMenuClickShielded(false);
      ctxMenuShieldTimerRef.current = null;
    }, 500);
  }, []);

  // Long-press handler for touch devices. Memoized so useLongPress returns stable
  // method identities — which keeps `makeLongPressHandlers` and the `handleSelect*`
  // callbacks stable, which is what lets the memo'd row leaves skip re-render when
  // the parent re-renders (every message:new churns channels/dmChannels).
  // Stryker disable all: pre-existing long-press dispatch is outside the workspace mutation corpus.
  const onLongPress = useCallback((coords: { x: number; y: number }) => {
    if (longPressTargetRef.current) {
      openCtxMenuAt(coords.x, coords.y, longPressTargetRef.current.type, longPressTargetRef.current.id);
    }
  }, [openCtxMenuAt]);
  // Stryker restore all
  const channelLongPress = useLongPress(onLongPress);
  // useLongPress returns a NEW object literal each render but stable method refs;
  // destructure the stable members so downstream useCallbacks don't depend on the
  // unstable object identity.
  const longPressSuppressRef = channelLongPress.suppressClickRef;
  const { onTouchStart: lpTouchStart, onTouchEnd: lpTouchEnd, onTouchMove: lpTouchMove, onTouchCancel: lpTouchCancel } = channelLongPress;

  // Stryker disable all: pre-existing touch forwarding is outside the workspace mutation corpus.
  const makeLongPressHandlers = useCallback((type: CtxMenu["type"], id: string) => ({
    onTouchStart: (e: React.TouchEvent) => {
      longPressTargetRef.current = { type, id };
      lpTouchStart(e);
    },
    onTouchEnd: (e: React.TouchEvent) => lpTouchEnd(e),
    onTouchMove: (e: React.TouchEvent) => lpTouchMove(e),
    onTouchCancel: () => lpTouchCancel(),
  }), [lpTouchStart, lpTouchEnd, lpTouchMove, lpTouchCancel]);
  // Stryker restore all

  // Stryker disable all: route-specific host wiring is contract-pinned and browser-smoke verified.
  const handleSelectChannel = useCallback((channel: Channel, _clickCount = 1) => {
    if (longPressSuppressRef.current) return;
    markUnreadSidebarItemRead(channel.id);
    if (workspaceEnabled) {
      emitWorkspaceGridOpenChannel(channel.id, { toggle: true });
    } else if (serverSlugRef.current && pathnameRef.current === `/s/${serverSlugRef.current}/channel/${channel.id}`) {
      // Classic chat has no tab model to close. Return to the server root with
      // an explicit empty-chat navigation state; DefaultRoute honors this
      // state instead of redirecting straight back to the first channel.
      navigateRef.current(`/s/${serverSlugRef.current}`, { state: { suppressDefaultRouteRedirect: true } });
    } else {
      nav.toChannel(channel.id);
    }
    setSidebarOpen(false);
  }, [longPressSuppressRef, markUnreadSidebarItemRead, nav, setSidebarOpen, workspaceEnabled]);
  // Stryker restore all

  const openDmSurface = useCallback(
    (dmChannelId: string) => {
      markUnreadSidebarItemRead(dmChannelId);
      if (workspaceEnabled) {
        emitWorkspaceGridOpenDm(dmChannelId, { toggle: true });
      } else if (serverSlugRef.current && pathnameRef.current === `/s/${serverSlugRef.current}/dm/${dmChannelId}`) {
        navigateRef.current(`/s/${serverSlugRef.current}`, { state: { suppressDefaultRouteRedirect: true } });
      } else {
        nav.toDm(dmChannelId);
      }
      setSidebarOpen(false);
    },
    // Stryker disable next-line ArrayDeclaration: callback freshness is exercised by sidebar navigation DOM tests; replacing the dependency list is not observable in the focused mutation lifecycle.
    [markUnreadSidebarItemRead, nav, setSidebarOpen, workspaceEnabled],
  );

  // Stryker disable all: route-specific host wiring is contract-pinned and browser-smoke verified.
  const handleSelectDm = useCallback((dmChannelId: string, _clickCount = 1) => {
    if (longPressSuppressRef.current) return;
    openDmSurface(dmChannelId);
  }, [longPressSuppressRef, openDmSurface]);
  // Stryker restore all

  // Stryker disable all: pre-existing singleton-panel cleanup is outside the workspace mutation corpus.
  const closeRightPanel = useCallback(() => {
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
  }, []);
  // Stryker restore all

  const handleSelectAgent = useCallback((agentId: string, _clickCount = 1) => {
    // Stryker disable all: workspace host dispatch is contract-pinned and browser-smoke verified.
    if (longPressSuppressRef.current) return;
    if (workspaceEnabled) {
      const agent = allAgents.find((candidate) => candidate.id === agentId);
      emitWorkspaceGridOpenPanel(
        { kind: "agent", id: agentId },
        { title: `@${agent?.displayName || agent?.name || agentId}`, subtitle: formatMessage({ id: "workspace.panel.agent" }), toggle: true },
      );
    } else {
      nav.toAgent(agentId);
    }
    closeRightPanel();
    setSidebarOpen(false);
  }, [allAgents, closeRightPanel, longPressSuppressRef, nav, setSidebarOpen, workspaceEnabled, formatMessage]);
  // Stryker restore all

  // Combined select for agent DM rows: open the existing DM if there is one,
  // otherwise navigate to the agent profile. Stable so <AgentDmRow> stays memo'd.
  // Stryker disable all: typed workspace routing is covered by channel/agent browser smoke.
  const handleSelectAgentDm = useCallback((agent: Agent, dmId: string | undefined, clickCount = 1) => {
    if (dmId) handleSelectDm(dmId, clickCount);
    else handleSelectAgent(agent.id, clickCount);
  }, [handleSelectDm, handleSelectAgent]);
  // Stryker restore all

  const handleSelectMachine = useCallback((machineId: string, _clickCount = 1) => {
    // Stryker disable all: workspace host dispatch is contract-pinned and browser-smoke verified.
    if (longPressSuppressRef.current) return;
    if (workspaceEnabled) {
      emitWorkspaceGridOpenPanel(
        { kind: "machine", id: machineId },
        { title: machineNames[machineId] || formatMessage({ id: "machine.detail.computer" }), subtitle: formatMessage({ id: "workspace.panel.computer" }), toggle: true },
      );
    } else {
      nav.toComputer(machineId);
    }
    closeRightPanel();
    setSidebarOpen(false);
  }, [closeRightPanel, formatMessage, longPressSuppressRef, machineNames, nav, setSidebarOpen, workspaceEnabled]);
  // Stryker restore all

  const handleSelectHuman = useCallback((userId: string, _clickCount = 1) => {
    // Stryker disable all: workspace host dispatch is contract-pinned and browser-smoke verified.
    if (longPressSuppressRef.current) return;
    if (workspaceEnabled) {
      const human = members.find((candidate) => candidate.userId === userId);
      emitWorkspaceGridOpenPanel(
        { kind: "human", id: userId },
        { title: `@${human?.displayName || human?.name || userId}`, subtitle: formatMessage({ id: "workspace.panel.human" }), toggle: true },
      );
    } else {
      nav.toHuman(userId);
    }
    closeRightPanel();
    setSidebarOpen(false);
  }, [closeRightPanel, longPressSuppressRef, members, nav, setSidebarOpen, workspaceEnabled, formatMessage]);
  // Stryker restore all

  const handleOpenHumanDm = useCallback(
    async (userId: string) => {
      closeRightPanel();
      selectSidebarTab("chat");
      const existingDm = dmChannels.find((dm) => dm.peerType === "user" && dm.peerId === userId);
      const dm = existingDm ?? await openUserDM(userId);
      openDmSurface(dm.id);
    },
    // Stryker disable next-line ArrayDeclaration: the DOM corpus remounts per intent; stale-closure behavior is covered by the broader sidebar navigation suite.
    [closeRightPanel, dmChannels, openDmSurface, openUserDM, selectSidebarTab],
  );

  const handleOpenAgentDm = useCallback(
    async (agentId: string) => {
      closeRightPanel();
      selectSidebarTab("chat");
      const existingDm = dmChannels.find((dm) => dm.peerType === "agent" && dm.peerId === agentId);
      const dm = existingDm ?? await openDM(agentId);
      openDmSurface(dm.id);
    },
    // Stryker disable next-line ArrayDeclaration: the DOM corpus remounts per intent; stale-closure behavior is covered by the broader sidebar navigation suite.
    [closeRightPanel, dmChannels, openDM, openDmSurface, selectSidebarTab],
  );

  // Stryker disable all: native drag-event forwarding is browser-smoke verified.
  const dragWorkspacePanel = useCallback((
    event: React.DragEvent<HTMLElement>,
    ref: WorkspacePanelRef,
    source: { title?: string; subtitle?: string },
    sidebarDragId?: string,
  ) => {
    if (!workspaceEnabled) return;
    workspaceSidebarNativeDragIdRef.current = sidebarDragId ?? null;
    emitWorkspaceGridDragPanel(event.nativeEvent, ref, source);
  }, [workspaceEnabled]);
  // Stryker restore all

  // Stryker disable all: pre-existing context-menu dispatch is outside the workspace mutation corpus.
  const openCtxMenu = useCallback((e: React.MouseEvent, type: CtxMenu["type"], id: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Skip if useLongPress already opened the menu (prevents double-open on mobile)
    if (longPressSuppressRef.current) return;
    setSectionCtxMenu(null);
    setSidebarSurfaceCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
    setCtxMenu({ x: e.clientX, y: e.clientY, type, id });
  }, [longPressSuppressRef]);
  // Stryker restore all

  // Stryker disable all: pointer coordinates and portal placement are browser-smoke verified; clamping semantics live in placeSidebarContextMenu.
  const openSectionCtxMenu = useCallback((event: React.MouseEvent, section: SidebarSortSection | `custom:${string}`) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxMenu(null);
    setSidebarSurfaceCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
    setOpenSortMenu(null);
    setSectionCtxMenu({ x: event.clientX, y: event.clientY, section });
  }, []);
  // Stryker restore all

  const openSidebarSurfaceCtxMenu = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [role='menuitem']")) return;
    event.preventDefault();
    setCtxMenu(null);
    setSectionCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
    setOpenSortMenu(null);
    setSidebarSurfaceCtxMenu({ x: event.clientX, y: event.clientY });
  }, []);

  // Stryker disable all: pre-existing context-menu placement is outside the workspace mutation corpus.
  useLayoutEffect(() => {
    if (!ctxMenu) return;
    const menuEl = ctxMenuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const next = placeSidebarContextMenu({
      x: ctxMenu.x,
      y: ctxMenu.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (next.x === ctxMenu.x && next.y === ctxMenu.y) return;
    setCtxMenu((current) => {
      if (!current || current.type !== ctxMenu.type || current.id !== ctxMenu.id) return current;
      if (current.x !== ctxMenu.x || current.y !== ctxMenu.y) return current;
      return { ...current, ...next };
    });
  }, [ctxMenu]);
  // Stryker restore all

  // Stryker disable all: section-menu placement reuses the pure, separately tested context-menu geometry and is verified in the browser proof.
  useLayoutEffect(() => {
    if (!sectionCtxMenu) return;
    const menuEl = sectionCtxMenuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const next = placeSidebarContextMenu({
      x: sectionCtxMenu.x,
      y: sectionCtxMenu.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (next.x === sectionCtxMenu.x && next.y === sectionCtxMenu.y) return;
    setSectionCtxMenu((current) => {
      if (!current || current.section !== sectionCtxMenu.section) return current;
      if (current.x !== sectionCtxMenu.x || current.y !== sectionCtxMenu.y) return current;
      return { ...current, ...next };
    });
  }, [sectionCtxMenu]);
  // Stryker restore all

  useLayoutEffect(() => {
    if (!sidebarSurfaceCtxMenu) return;
    const menuEl = sidebarSurfaceCtxMenuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const next = placeSidebarContextMenu({
      x: sidebarSurfaceCtxMenu.x,
      y: sidebarSurfaceCtxMenu.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (next.x === sidebarSurfaceCtxMenu.x && next.y === sidebarSurfaceCtxMenu.y) return;
    setSidebarSurfaceCtxMenu((current) => {
      if (!current) return current;
      if (current.x !== sidebarSurfaceCtxMenu.x || current.y !== sidebarSurfaceCtxMenu.y) return current;
      return { ...current, ...next };
    });
  }, [sidebarSurfaceCtxMenu]);

  // Stryker disable all: route identity glue is browser-smoke verified; selection semantics live in the pure helper.
  const serverSlug = useServerStore((s) => s.current?.slug);
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";
  // Stryker restore all

  // Stryker disable all: React wiring is browser-smoke verified; selection behavior is mutation-tested in the helper.
  const isChannelSelected = createWorkspaceGridSidebarSelection({
    kind: "channel",
    workspaceActive: workspaceEnabled,
    activeRefKey: workspaceActiveAncestorRefKey ?? workspaceActiveRefKey,
    pathname: location.pathname,
    pathBase,
  });
  const isDmSelected = createWorkspaceGridSidebarSelection({
    kind: "dm",
    workspaceActive: workspaceEnabled,
    activeRefKey: workspaceActiveAncestorRefKey ?? workspaceActiveRefKey,
    pathname: location.pathname,
    pathBase,
  });
  const isAgentSelected = createWorkspaceGridSidebarSelection({
    kind: "agent",
    workspaceActive: workspaceEnabled,
    activeRefKey: workspaceActiveRefKey,
    pathname: location.pathname,
    pathBase,
  });
  const isMachineSelected = (machineId: string) => workspaceEnabled
    ? workspaceActiveRefKey === `machine:${machineId}`
    : location.pathname === `${pathBase}/computer/${machineId}`
      || location.pathname === `${pathBase}/machine/${machineId}`;
  const isHumanSelected = createWorkspaceGridSidebarSelection({
    kind: "human",
    workspaceActive: workspaceEnabled,
    activeRefKey: workspaceActiveRefKey,
    pathname: location.pathname,
    pathBase,
  });
  // Stryker restore all
  const isReleaseNotesRoute = location.pathname.startsWith(`${pathBase}/release-notes`);

  // Settings-mode sidebar contents — when the user is in the Settings rail
  // mode, the sidebar shows a sub-nav of settings sections (Account /
  // Browser / Server / Release Notes, plus Computers on mobile) with their
  // canonical icons. The main panel renders the active sub-page; Logout
  // lives at the bottom of the Account page itself, not as a sidebar item.
  //
  // Computers is part of this sub-nav ONLY on mobile. Desktop has a
  // dedicated Computers rail mode in the LeftRail — adding Computers to
  // the Settings sub-nav there would be a duplicate entry point. Mobile's
  // 4-tab bar (Chat/Tasks/Members/Settings) folds Computers into Settings
  // instead of giving it its own tab (per @stdrc 2026-04-30 #proj-uiux:c8711d2a).
  const isComputersRoute =
    pathBase &&
    (location.pathname === `${pathBase}/computers`
      || location.pathname.startsWith(`${pathBase}/computers/`)
      || location.pathname.startsWith(`${pathBase}/computer/`)
      || location.pathname.startsWith(`${pathBase}/machine/`)); // legacy
  // On mobile, `/settings` is the Settings tab ROOT — a list of sub-items
  // with no sub-page rendered yet. Nothing should be highlighted until the
  // user actually picks a sub-tab. On desktop, `/settings` still defaults
  // to Account (SettingsRoute renders Account content there) so keep the
  // existing highlight behavior. Fix reported by @stdrc 2026-05-01
  // `#proj-uiux:c8711d2a` msg 83123f2b.
  const settingsTabFromPath: string | null = (() => {
    if (isComputersRoute) return "computers";
    if (isReleaseNotesRoute) return "release-notes";
    const m = location.pathname.match(new RegExp(`^${pathBase.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}/settings(?:/([^/?#]+))?`));
    if (!m) return null;
    const t = m[1];
    if (!t) return mobileInline ? null : "account";
    return settingsTabIdForRouteSlug(t);
  })();
  type SettingsItem = {
    id: string;
    label: string;
    icon: React.ReactNode;
    onClick?: () => void;
    href?: string;
  };
  type SettingsGroup = { label: string; items: SettingsItem[] };
  const settingsSidebarGroups: SettingsGroup[] = pathBase
    ? [
        {
          label: formatMessage({ id: "layout.sidebar.settingsGroupPersonal" }),
          items: [
            { id: "account", label: formatMessage({ id: "settings.tabs.account" }), icon: <User size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/account`) },
            { id: "language-region", label: formatMessage({ id: "settings.tabs.languageRegion" }), icon: <Languages size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/language-region`) },
            { id: "appearance", label: formatMessage({ id: "settings.tabs.appearance" }), icon: <Type size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/appearance`) },
            { id: "notifications", label: formatMessage({ id: "settings.tabs.notifications" }), icon: <Bell size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/notifications`) },
          ],
        },
        {
          label: formatMessage({ id: "layout.sidebar.settingsGroupServer" }),
          items: [
            { id: "server", label: formatMessage({ id: "settings.tabs.server" }), icon: <Building2 size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/server`) },
            ...(wikiEnabled && canManageServer
              ? [{ id: "wiki", label: formatMessage({ id: "wiki.settings" }), icon: <Network size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/wiki`) }]
              : []),
            ...(canViewBillingSettings
              ? [{ id: "billing", label: formatMessage({ id: "settings.tabs.billingHeader" }), icon: <CreditCard size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/billing`) }]
              : []),
            ...(canViewAdministrationSettings
              ? [{ id: "administration", label: formatMessage({ id: "settings.tabs.administration" }), icon: <Shield size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/administration`) }]
              : []),
            ...(slackBridgeEnabled
              ? [{ id: "im-bridges", label: formatMessage({ id: "settings.tabs.imBridges" }), icon: <Network size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/im-bridges`) }]
              : []),
            ...(canViewApplicationsSettings
              ? [{ id: "integrations", label: formatMessage({ id: "settings.tabs.integrations" }), icon: <Link2 size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/applications`) }]
              : []),
            ...(labsUiEnabled
              ? [{ id: "labs", label: formatMessage({ id: "settings.tabs.labs" }), icon: <FlaskConical size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/labs`) }]
              : []),
            ...(canViewMcpSettings
              ? [{ id: "mcp", label: formatMessage({ id: "settings.tabs.mcp" }), icon: <Blocks size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/mcp-servers`) }]
              : []),
            ...(providerConnectionsEnabled && canManageExternalAuth
              ? [{ id: "providers", label: formatMessage({ id: "settings.tabs.providers" }), icon: <KeyRound size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/providers`) }]
              : []),
            ...(mobileInline && currentRole !== "guest"
              ? [{ id: "computers", label: formatMessage({ id: "layout.sidebar.settingsComputers" }), icon: <Monitor size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/computers`) }]
              : []),
          ],
        },
        {
          label: formatMessage({ id: "layout.sidebar.settingsGroupAbout" }),
          items: [
            // @AngLee 2026-08-04: About→关于, Documentation→文档 (DOM-sweep residue).
            { id: "about", label: formatMessage({ id: "layout.sidebar.settingsAbout" }), icon: <BadgeInfo size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/about`) },
            { id: "documentation", label: formatMessage({ id: "layout.sidebar.settingsDocumentation" }), icon: <BookOpenText size={14} className="shrink-0" />, href: "https://docs.raft.build" },
            { id: "feedback", label: formatMessage({ id: "settings.about.feedbackTitle" }), icon: <MessageSquare size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/settings/feedback`) },
            { id: "release-notes", label: formatMessage({ id: "layout.sidebar.settingsReleaseNotes" }), icon: <FileText size={14} className="shrink-0" />, onClick: () => navigate(`${pathBase}/release-notes`) },
          ],
        },
      ]
    : [];

  // `sidebarItemClass` is now defined at module scope (pure) so the memoized row
  // leaves can use it too.

  // Stryker disable next-line StringLiteral: class composition is pinned by source-contract and real-browser scrollbar QA.
  const sidebarScrollClassName = "scrollbar-quiet flex-1 overflow-x-hidden overflow-y-auto px-2 py-3";

  const renderSortMenu = (
    section: SidebarSortSection,
    value: SidebarSortMode,
    onChange: (value: SidebarSortMode) => void,
  ) => {
    const isOpen = openSortMenu === section;
    // Sidebar sort = single-select dropdown — delegated to SelectionPopover
    // so the ✓ position (right) and hover token (`bg-soft-signal/30`)
    // match the rest of the Selection family. stdrc 2026-05-25
    // #proj-theme:ac79cf20 msg=8fdf9cba + msg=b0b92c1c. Removes the older
    // hand-rolled `<button role="menuitemradio">` rows that put ✓ on the
    // left and used full-saturation `bg-soft-signal` for both hover and
    // selected fill (Linear/Notion/GitHub/Figma all put ✓ on the right
    // for single-select dropdowns).
    return (
      <div ref={isOpen ? sortMenuRef : undefined} className="relative shrink-0">
        <button
          type="button"
          aria-label={formatMessage({ id: "layout.sidebar.sortAria" })}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          data-testid="sidebar-sort-menu-button"
          data-sort-section={section}
          title={formatMessage(
            { id: "layout.sidebar.sortTitle" },
            { currentLabel: formatMessage({ id: SIDEBAR_SORT_LABEL_ID[value] }) },
          )}
          onClick={(event) => {
            event.stopPropagation();
            setOpenSortMenu((current) => (current === section ? null : section));
          }}
          className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
        >
          <ArrowUpDown size={14} />
        </button>
        {isOpen && (
          <SelectionPopover
            title={formatMessage({ id: "layout.sidebar.sortMenuTitle" })}
            showHeader={false}
            className="absolute right-0 top-8 z-50 min-w-[136px] overflow-hidden border-2 border-black bg-white shadow-brutal"
            options={SIDEBAR_SORT_MODES.map((mode) => ({
              key: mode,
              checked: mode === value,
              label: formatMessage({ id: SIDEBAR_SORT_LABEL_ID[mode] }),
              onClick: () => {
                onChange(mode);
                setOpenSortMenu(null);
              },
            }))}
          />
        )}
      </div>
    );
  };

  const openCreateChannelDialog = () => {
    setSectionCtxMenu(null);
    setShowCreateChannel(true);
  };

  const openCreateJointChannelDialog = () => {
    if (!canCreateJointChannel) return;
    setSectionCtxMenu(null);
    setShowCreateJointChannel(true);
  };

  const openCreateAgentDialog = () => {
    setShowCreateAgentMenu(false);
    setShowCreateAgent(true);
  };

  const openCreateExternalAgentDialog = () => {
    setShowCreateAgentMenu(false);
    setShowCreateExternalAgent(true);
  };

  // Stryker disable all: rendered DOM and Playwright tests exercise both dedicated add buttons and their dialogs; this block is React event wiring.
  const renderSectionAddButton = (section: "channels" | "jointChannels") => {
    const isJoint = section === "jointChannels";
    if (isJoint ? !canCreateJointChannel : !canCreateChannel) return null;
    const label = isJoint
      ? formatMessage({ id: "layout.sidebar.createJointChannel" })
      : formatMessage({ id: "layout.sidebar.createChannel" });

    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpenSortMenu(null);
          setShowCreateAgentMenu(false);
          if (isJoint) openCreateJointChannelDialog();
          else openCreateChannelDialog();
        }}
        className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
      >
        <Plus size={14} />
      </button>
    );
  };
  // Stryker restore all

  const renderAgentActionMenu = () => {
    if (!canCreateAgent) return null;

    return (
      <div ref={showCreateAgentMenu ? createAgentMenuRef : undefined} className="relative shrink-0">
        <button
          type="button"
          aria-label={formatMessage({ id: "layout.sidebar.addAgent" })}
          aria-haspopup="menu"
          aria-expanded={showCreateAgentMenu}
          title={formatMessage({ id: "layout.sidebar.addAgent" })}
          onClick={(event) => {
            event.stopPropagation();
            setOpenSortMenu(null);
            setSectionCtxMenu(null);
            setShowCreateAgentMenu((current) => !current);
          }}
          className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
        >
          <Plus size={14} />
        </button>
        {showCreateAgentMenu && (
          <div
            role="menu"
            className="absolute right-0 top-8 z-50 min-w-[190px] overflow-hidden border-2 border-black bg-white shadow-brutal"
          >
            <MenuItem
              icon={<Bot size={14} className="shrink-0" />}
              onClick={(event) => {
                event.stopPropagation();
                openCreateAgentDialog();
              }}
            >
              {formatMessage({ id: "layout.sidebar.createAgent" })}
            </MenuItem>
            <MenuItem
              icon={<Link2 size={14} className="shrink-0" />}
              onClick={(event) => {
                event.stopPropagation();
                openCreateExternalAgentDialog();
              }}
            >
              {formatMessage({ id: "layout.sidebar.createExternalAgent" })}
            </MenuItem>
          </div>
        )}
      </div>
    );
  };

  // Stryker disable all: typed-pinned projection is covered by dedicated DOM/source contracts and browser preview.
  const pinnedRefs = Array.isArray(sidebarOrder.pinned) ? sidebarOrder.pinned : EMPTY_PINNED_REFS;
  const pinnedChannelIdSet = useMemo(
    () => new Set(pinnedRefs.filter((ref) => ref.kind === "channel").map((ref) => ref.id)),
    [pinnedRefs],
  );
  const pinnedAgentIdSet = useMemo(
    () => new Set(pinnedRefs.filter((ref) => ref.kind === "agent").map((ref) => ref.id)),
    [pinnedRefs],
  );
  const pinnedHumanIdSet = useMemo(
    () => new Set(pinnedRefs.filter((ref) => ref.kind === "human").map((ref) => ref.id)),
    [pinnedRefs],
  );
  const pinnedChannelIds = useMemo(() => {
    const ids = pinnedRefs.filter((ref) => ref.kind === "channel").map((ref) => ref.id);
    for (const dm of dmChannels) {
      if (dm.peerType === "user" && dm.peerId && pinnedHumanIdSet.has(dm.peerId)) ids.push(dm.id);
      if (dm.peerType === "agent" && dm.peerId && pinnedAgentIdSet.has(dm.peerId)) ids.push(dm.id);
    }
    return ids;
  }, [dmChannels, pinnedAgentIdSet, pinnedHumanIdSet, pinnedRefs]);
  const pinnedAgentIds = useMemo(
    () => pinnedRefs.filter((ref) => ref.kind === "agent").map((ref) => ref.id),
    [pinnedRefs],
  );
  const customPlacedChannelIds = useMemo(
    () => new Set(sectionPlacements.filter((placement) => placement.kind === "channel").map((placement) => placement.id)),
    [sectionPlacements],
  );
  const customPlacedAgentIds = useMemo(
    () => new Set(sectionPlacements.filter((placement) => placement.kind === "agent").map((placement) => placement.id)),
    [sectionPlacements],
  );

  const activeChannels = useMemo(
    () => channels.filter((channel) => !channel.archivedAt),
    [channels],
  );
  const orderedRegularChannels = useMemo(
    () => sortSidebarChannels(
      orderByIds(activeChannels.filter((channel) => channel.type !== "joint"), channelOrderIds),
      channelSortMode,
      channelActivity,
      allChannelId,
    ),
    [activeChannels, channelOrderIds, channelSortMode, channelActivity, allChannelId],
  );
  // Stryker disable all: memo/dependency wiring is rendered-DOM verified; membership behavior is mutation-tested in sidebarChannelVisibility.
  const visibleRegularChannels = useMemo(
    () => filterSidebarChannelsByMembership(orderedRegularChannels, joinedChannelsOnly),
    [orderedRegularChannels, joinedChannelsOnly],
  );
  const orderedJointChannels = useMemo(
    () => sortSidebarChannels(
      orderByIds(activeChannels.filter((channel) => channel.type === "joint"), channelOrderIds),
      jointChannelSortMode,
      channelActivity,
    ),
    [activeChannels, channelOrderIds, jointChannelSortMode, channelActivity],
  );
  const pinnedChannel = useMemo(
    () => visibleRegularChannels.find((channel) => channel.id === allChannelId && !pinnedChannelIdSet.has(channel.id) && !customPlacedChannelIds.has(channel.id)) ?? null,
    [visibleRegularChannels, allChannelId, pinnedChannelIdSet, customPlacedChannelIds],
  );
  const sortableChannels = useMemo(
    () => visibleRegularChannels.filter((channel) => channel.id !== allChannelId && !pinnedChannelIdSet.has(channel.id) && !customPlacedChannelIds.has(channel.id)),
    [visibleRegularChannels, allChannelId, pinnedChannelIdSet, customPlacedChannelIds],
  );
  const fallbackRegularChannels = useMemo(
    () => pinnedChannel ? [pinnedChannel, ...sortableChannels] : sortableChannels,
    [pinnedChannel, sortableChannels],
  );
  // Stryker restore all
  const sortableJointChannels = useMemo(
    () => orderedJointChannels.filter((channel) => !pinnedChannelIdSet.has(channel.id) && !customPlacedChannelIds.has(channel.id)),
    [orderedJointChannels, pinnedChannelIdSet, customPlacedChannelIds],
  );
  const sidebarChannelFocusRequest = readSidebarChannelFocusRequest(location.state);
  useLayoutEffect(() => {
    if (
      !showChatRail
      || !sidebarChannelFocusRequest
      || handledSidebarFocusLocationKeyRef.current === location.key
    ) {
      return;
    }

    const channelMatch = location.pathname.match(/\/channel\/([^/?]+)/);
    if (channelMatch?.[1] !== sidebarChannelFocusRequest.id) return;

    const targetChannel = activeChannels.find(
      (channel) => channel.id === sidebarChannelFocusRequest.id,
    );
    if (!targetChannel) return;

    const section = pinnedChannelIdSet.has(targetChannel.id)
      ? "pinned"
      : targetChannel.type === "joint"
        ? "jointChannels"
        : visibleRegularChannels.some((channel) => channel.id === targetChannel.id)
          ? "channels"
          : null;

    if (!section) {
      handledSidebarFocusLocationKeyRef.current = location.key;
      return;
    }

    if (collapsed[section]) {
      // Route-owned focus is allowed to reveal the destination row, matching
      // the existing channel-route auto-expand behavior above.
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- the follow-up render is required before the row exists to measure.
      setCollapsed((previous) => ({ ...previous, [section]: false }));
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const scroller = sidebarScrollRef.current;
      if (!scroller) return;
      const row = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-sidebar-channel-id]"),
      ).find((candidate) => (
        candidate.dataset.sidebarChannelId === sidebarChannelFocusRequest.id
      ));
      if (!row) {
        handledSidebarFocusLocationKeyRef.current = location.key;
        return;
      }

      const viewportRect = scroller.getBoundingClientRect();
      const itemRect = row.getBoundingClientRect();
      scroller.scrollTo({
        top: centeredSidebarScrollTop({
          currentScrollTop: scroller.scrollTop,
          itemHeight: itemRect.height,
          itemTop: itemRect.top,
          viewportHeight: scroller.clientHeight,
          viewportTop: viewportRect.top,
        }),
        behavior: "auto",
      });
      handledSidebarFocusLocationKeyRef.current = location.key;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    activeChannels,
    collapsed,
    location.key,
    location.pathname,
    pinnedChannelIdSet,
    showChatRail,
    sidebarChannelFocusRequest,
    visibleRegularChannels,
  ]);
  const sortableChannelIds = useMemo(() => sortableChannels.map((channel) => channel.id), [sortableChannels]);
  const sortableJointChannelIds = useMemo(() => sortableJointChannels.map((channel) => channel.id), [sortableJointChannels]);
  const channelManualSort = channelSortMode === "manual";
  const jointChannelManualSort = jointChannelSortMode === "manual";
  const dmManualSort = dmSortMode === "manual";
  const pinnedManualSort = pinnedSortMode === "manual";

  // Map agent ID → DM channel ID (for navigation + per-row unread subscription).
  // Unread itself is NOT computed here anymore — it lives in the <AgentDmRow>
  // leaf so this map stays stable across `message:new` churn.
  const agentDmChannelId = useMemo(() => {
    const channelId: Record<string, string> = {};
    for (const dm of dmChannels) {
      if (dm.peerType === "agent" && dm.peerId) {
        channelId[dm.peerId] = dm.id;
      }
    }
    return channelId;
  }, [dmChannels]);
  const agentDmChannelByAgentId = useMemo(() => {
    return buildAgentDmChannelByAgentId(dmChannels);
  }, [dmChannels]);
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const dmContextPeerIds = useMemo(() => ({
    agentIds: new Set(agents.map((agent) => agent.id)),
    humanIds: new Set(members.map((member) => member.userId)),
  }), [agents, members]);

  const pinnedItems = useMemo(() => {
    const channelById = new Map(channels.filter((channel) => !channel.archivedAt).map((channel) => [channel.id, channel]));
    const humanDmByPeerId = new Map(dmChannels.filter((dm) => dm.peerType === "user" && dm.peerId).map((dm) => [dm.peerId!, dm]));
    const agentDmById = new Map(dmChannels.filter((dm) => dm.peerType === "agent" && dm.peerId).map((dm) => [dm.peerId!, dm]));
    const manualItems: PinnedDisplayItem[] = [];
    for (const ref of pinnedRefs) {
      const id = sidebarPinnedRefKey(ref);
      if (ref.kind === "channel") {
        const channel = channelById.get(ref.id);
        if (channel) manualItems.push({ id, ref, type: "channel", channel, createdAt: channel.createdAt, lastMessageAt: channelActivity[channel.id], label: channel.name });
        continue;
      }
      if (ref.kind === "human") {
        const dm = humanDmByPeerId.get(ref.id);
        if (dm) manualItems.push({ id, ref, type: "dm", dm, createdAt: dm.createdAt, lastMessageAt: channelActivity[dm.id], label: sidebarDmLabel(dm) });
        continue;
      }
      const agent = agentById.get(ref.id);
      if (agent) {
        const dmChannel = agentDmById.get(agent.id);
        manualItems.push({
          id,
          ref,
          type: "agent",
          agent,
          createdAt: dmChannel?.createdAt ?? agent.createdAt,
          lastMessageAt: dmChannel ? channelActivity[dmChannel.id] : undefined,
          label: agent.displayName || agent.name,
        });
        continue;
      }
      const dm = agentDmById.get(ref.id);
      if (dm) manualItems.push({ id, ref, type: "dm", dm, createdAt: dm.createdAt, lastMessageAt: channelActivity[dm.id], label: sidebarDmLabel(dm) });
    }

    return sortSidebarPinnedItems(manualItems, pinnedSortMode);
  }, [pinnedRefs, channels, dmChannels, agentById, pinnedSortMode, channelActivity]);
  const pinnedDmIdSet = useMemo(
    () => new Set(pinnedItems.filter((item) => item.type === "dm").map((item) => item.dm.id)),
    [pinnedItems],
  );

  const customSectionItems = useMemo(() => {
    const channelById = new Map(channels.filter((channel) => !channel.archivedAt).map((channel) => [channel.id, channel]));
    const dmById = new Map(dmChannels.map((dm) => [dm.id, dm]));
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const result = new Map<string, CustomSectionDisplayItem[]>();
    for (const placement of [...sectionPlacements].sort((a, b) => a.position - b.position)) {
      const channel = channelById.get(placement.id);
      const dm = dmById.get(placement.id);
      const agent = agentById.get(placement.id);
      if (placement.kind === "channel" && (
        pinnedChannelIdSet.has(placement.id)
        || (dm?.peerType === "user" && !!dm.peerId && pinnedHumanIdSet.has(dm.peerId))
        || (dm?.peerType === "agent" && !!dm.peerId && pinnedAgentIdSet.has(dm.peerId))
      )) continue;
      if (placement.kind === "agent" && pinnedAgentIdSet.has(placement.id)) continue;
      let item: CustomSectionDisplayItem | null = null;
      if (dm) {
        item = { id: dm.id, type: "dm", dm, createdAt: dm.createdAt, lastMessageAt: channelActivity[dm.id], label: sidebarDmLabel(dm), placementKind: "channel" };
      } else if (channel) {
        item = { id: channel.id, type: "channel", channel, createdAt: channel.createdAt, lastMessageAt: channelActivity[channel.id], label: channel.name, placementKind: "channel" };
      } else if (agent) {
        const dmChannel = agentDmChannelByAgentId[agent.id];
        item = {
          id: agent.id,
          type: "agent",
          agent,
          createdAt: dmChannel?.createdAt ?? agent.createdAt,
          lastMessageAt: dmChannel ? channelActivity[dmChannel.id] : undefined,
          label: agent.displayName || agent.name,
          placementKind: "agent",
        };
      }
      if (!item) continue;
      const items = result.get(placement.sectionId) ?? [];
      items.push(item);
      result.set(placement.sectionId, items);
    }
    for (const section of customSections) {
      const items = result.get(section.id) ?? [];
      if (section.sortMode === "az") items.sort((a, b) => a.label.localeCompare(b.label));
      if (section.sortMode === "recent") items.sort((a, b) => String(b.lastMessageAt ?? b.createdAt).localeCompare(String(a.lastMessageAt ?? a.createdAt)));
      result.set(section.id, items);
    }
    return result;
  }, [agents, agentDmChannelByAgentId, channelActivity, channels, customSections, dmChannels, pinnedAgentIdSet, pinnedChannelIdSet, pinnedHumanIdSet, sectionPlacements]);

  // Narrowed unread aggregates. These subscribe to `unreadCounts` but collapse
  // it to 4 booleans (one per collapsible section) so the parent re-renders ONLY
  // when a section's "has unread" state flips — not on every inbound message.
  const unreadFlags = useMessageStore(
    useShallow((s) => {
      const has = (...unreadChannels: Array<Channel | undefined>) => (
        hasUnmutedUnread(s.unreadCounts, unreadChannels)
      );
      return {
        pinned: pinnedItems.some((item) => {
          if (item.type === "channel") return has(item.channel);
          if (item.type === "dm") return has(item.dm);
          return has(agentDmChannelByAgentId[item.agent.id]);
        }),
        joint: has(...sortableJointChannels),
        // Stryker disable next-line MethodExpression,ArrowFunction: collapsed unread chrome follows the browser-visible filtered list; store selector mutation is outside this task's domain seam.
        channels: has(...fallbackRegularChannels),
        dms: has(...dmChannels.filter(
          (dm) =>
            !pinnedDmIdSet.has(dm.id) &&
            !(dm.peerType === "agent" && dm.peerId && pinnedAgentIdSet.has(dm.peerId)) &&
            !(dm.peerType === "user" && dm.peerId && pinnedHumanIdSet.has(dm.peerId)) &&
            !customPlacedChannelIds.has(dm.id) &&
            !(dm.peerType === "agent" && dm.peerId && customPlacedAgentIds.has(dm.peerId)),
        )),
      };
    }),
  );
  const customUnreadSectionIds = useMessageStore(
    useShallow((state) => [...customSectionItems.entries()]
      .filter(([, items]) => items.some((item) => {
        const unreadChannel = item.type === "channel" ? item.channel
          : item.type === "dm" ? item.dm
            : agentDmChannelByAgentId[item.agent.id];
        return hasUnmutedUnread(state.unreadCounts, [unreadChannel]);
      }))
      .map(([sectionId]) => sectionId)),
  );
  const customUnreadSectionIdSet = useMemo(() => new Set(customUnreadSectionIds), [customUnreadSectionIds]);
  // Closed DMs that currently have unread must stay visible (auto-reopen on a
  // new message). Narrowed to the id list so a message to an already-visible DM
  // does not re-render the parent — only a closed→unread transition does.
  const closedDmUnreadIds = useMessageStore(
    useShallow((s) =>
      dmChannels
        .filter((dm) => closedDmIds.has(dm.id) && (s.unreadCounts[dm.id] || 0) > 0)
        .map((dm) => dm.id),
    ),
  );
  const closedDmUnreadSet = useMemo(() => new Set(closedDmUnreadIds), [closedDmUnreadIds]);

  const orderedDms = useMemo(() => {
    const visibleDmSet = new Set(
      dmChannels
        .filter((dm) =>
          (!closedDmIds.has(dm.id) || closedDmUnreadSet.has(dm.id)) &&
          !(dm.peerType === "agent" && dm.peerId && pinnedAgentIdSet.has(dm.peerId)) &&
          !(dm.peerType === "user" && dm.peerId && pinnedHumanIdSet.has(dm.peerId)) &&
          !pinnedDmIdSet.has(dm.id) &&
          !customPlacedChannelIds.has(dm.id) &&
          !(dm.peerType === "agent" && dm.peerId && customPlacedAgentIds.has(dm.peerId))
        )
        .map((dm) => dm.id),
    );
    return sortSidebarDms(
      orderByIds(dmChannels, dmOrderIds),
      dmSortMode,
      channelActivity,
    ).filter((dm) => visibleDmSet.has(dm.id));
  }, [
    channelActivity,
    closedDmIds,
    closedDmUnreadSet,
    customPlacedAgentIds,
    customPlacedChannelIds,
    dmChannels,
    dmOrderIds,
    dmSortMode,
    pinnedAgentIdSet,
    pinnedDmIdSet,
    pinnedHumanIdSet,
  ]);
  const sortableDmIds = useMemo(() => orderedDms.map((dm) => dm.id), [orderedDms]);

  const sidebarDndDisplayItems = useMemo(() => {
    const items = new Map<string, SidebarDndDisplayItem>();
    const addChannel = (channel: Channel) => {
      items.set(channelDragId(channel.id), { type: "channel", channel, label: channel.name });
    };
    const addDm = (dm: Channel) => {
      items.set(channelDragId(dm.id), { type: "dm", dm, label: sidebarDmLabel(dm) });
    };
    const addAgent = (agent: Agent) => {
      items.set(agentDragId(agent.id), { type: "agent", agent, label: agent.displayName || agent.name });
    };

    for (const item of pinnedItems) {
      if (item.type === "channel") addChannel(item.channel);
      else if (item.type === "dm") addDm(item.dm);
      else addAgent(item.agent);
    }
    for (const sectionItems of customSectionItems.values()) {
      for (const item of sectionItems) {
        if (item.type === "channel") addChannel(item.channel);
        else if (item.type === "dm") addDm(item.dm);
        else addAgent(item.agent);
      }
    }
    for (const channel of fallbackRegularChannels) addChannel(channel);
    for (const channel of sortableJointChannels) addChannel(channel);
    for (const dm of orderedDms) addDm(dm);
    return items;
  }, [
    customSectionItems,
    fallbackRegularChannels,
    orderedDms,
    pinnedItems,
    sortableJointChannels,
  ]);

  const sidebarDndBaseProjection = useMemo<SidebarDndProjection>(() => {
    const projection: SidebarDndProjection = {
      [SIDEBAR_PINNED_CONTAINER_ID]: pinnedItems.map((item) => (
        item.type === "agent" ? agentDragId(item.agent.id)
          : item.type === "dm" ? channelDragId(item.dm.id)
            : channelDragId(item.channel.id)
      )),
      [SIDEBAR_JOINT_CHANNELS_CONTAINER_ID]: sortableJointChannels.map((channel) => channelDragId(channel.id)),
      [SIDEBAR_CHANNELS_CONTAINER_ID]: fallbackRegularChannels.map((channel) => channelDragId(channel.id)),
      [SIDEBAR_DMS_CONTAINER_ID]: orderedDms.map((dm) => channelDragId(dm.id)),
    };
    for (const section of customSections) {
      projection[sidebarCustomContainerId(section.id)] = (customSectionItems.get(section.id) ?? []).map((item) => (
        item.type === "agent" ? agentDragId(item.agent.id)
          : item.type === "dm" ? channelDragId(item.dm.id)
            : channelDragId(item.channel.id)
      ));
    }
    return projection;
  }, [
    customSectionItems,
    customSections,
    fallbackRegularChannels,
    orderedDms,
    pinnedItems,
    sortableJointChannels,
  ]);
  const sidebarDndCurrentProjection = sidebarDndProjection ?? sidebarDndBaseProjection;

  const resolvePinnedRefFromDragId = useCallback((id: string): SidebarPinnedRef | null => {
    const parsed = parseDragId(id);
    if (!parsed) return null;
    if (parsed.kind === "agent") return { kind: "agent", id: parsed.id };
    const dm = dmChannels.find((channel) => channel.id === parsed.id);
    return dm ? pinnedRefForDmChannel(dm) : { kind: "channel", id: parsed.id };
  }, [dmChannels]);

  const resolveMovableItemFromDragId = useCallback((id: string): SidebarMovableItem | null => {
    const parsed = parseDragId(id);
    if (!parsed) return null;
    if (parsed.kind === "channel" || parsed.kind === "dm") {
      return { kind: "channel", id: parsed.id };
    }
    if (parsed.kind === "agent") return { kind: "agent", id: parsed.id };
    return null;
  }, []);

  const getSidebarDndHomeContainer = useCallback((itemId: string): string | null => {
    const parsed = parseDragId(itemId);
    if (!parsed) return null;
    if (parsed.kind === "agent") {
      return dmChannels.some((dm) => dm.peerType === "agent" && dm.peerId === parsed.id)
        ? SIDEBAR_DMS_CONTAINER_ID
        : null;
    }
    if (parsed.kind === "dm" || dmChannels.some((dm) => dm.id === parsed.id)) {
      return SIDEBAR_DMS_CONTAINER_ID;
    }
    const channel = channels.find((candidate) => candidate.id === parsed.id);
    if (!channel) return null;
    return channel.type === "joint"
      ? SIDEBAR_JOINT_CHANNELS_CONTAINER_ID
      : SIDEBAR_CHANNELS_CONTAINER_ID;
  }, [channels, dmChannels]);

  const getSidebarDndDefaultOrderId = useCallback((itemId: string): string | null => {
    const parsed = parseDragId(itemId);
    if (!parsed) return null;
    if (parsed.kind === "agent") {
      return dmChannels.find((dm) => dm.peerType === "agent" && dm.peerId === parsed.id)?.id ?? null;
    }
    return parsed.id;
  }, [dmChannels]);

  const isSidebarDndContainerManual = useCallback((containerId: string): boolean => {
    if (containerId === SIDEBAR_PINNED_CONTAINER_ID) return pinnedManualSort;
    if (containerId === SIDEBAR_CHANNELS_CONTAINER_ID) return channelManualSort;
    if (containerId === SIDEBAR_JOINT_CHANNELS_CONTAINER_ID) return jointChannelManualSort;
    if (containerId === SIDEBAR_DMS_CONTAINER_ID) return dmManualSort;
    const customSectionId = sidebarCustomSectionId(containerId);
    return !!customSectionId
      && customSections.some((section) => section.id === customSectionId && section.sortMode === "manual");
  }, [
    channelManualSort,
    customSections,
    dmManualSort,
    jointChannelManualSort,
    pinnedManualSort,
  ]);

  const isValidSidebarDndDestination = useCallback((itemId: string, containerId: string): boolean => {
    if (!isSidebarDndContainerManual(containerId)) return false;
    if (
      containerId === SIDEBAR_PINNED_CONTAINER_ID
      || sidebarCustomSectionId(containerId)
    ) return true;
    return getSidebarDndHomeContainer(itemId) === containerId;
  }, [getSidebarDndHomeContainer, isSidebarDndContainerManual]);

  const togglePinnedRef = useCallback((ref: SidebarPinnedRef, placementsToRemove: SidebarMovableItem[] = []) => {
    const isPinned = hasSidebarPinnedRef(pinnedRefs, ref);
    const next = isPinned ? removeSidebarPinnedRef(pinnedRefs, ref) : upsertSidebarPinnedRef(pinnedRefs, ref);
    const nextPlacements = isPinned
      ? sectionPlacements
      : placementsToRemove.reduce(
          (placements, item) => removeSidebarItemPlacement(placements, item),
          sectionPlacements,
        );
    void updateSidebarOrder({
      pinned: next,
      ...(nextPlacements === sectionPlacements ? {} : { sectionPlacements: nextPlacements }),
    });
  }, [pinnedRefs, sectionPlacements, updateSidebarOrder]);

  const pinnedRefForMovableItem = useCallback((item: SidebarMovableItem): SidebarPinnedRef | null => {
    if (item.kind === "agent") return { kind: "agent", id: item.id };
    const dm = dmChannels.find((channel) => channel.id === item.id);
    return dm ? pinnedRefForDmChannel(dm) : { kind: "channel", id: item.id };
  }, [dmChannels]);

  const moveItemToPinned = useCallback((item: SidebarMovableItem) => {
    const ref = pinnedRefForMovableItem(item);
    if (!ref) return;
    const nextSectionPlacements = removeSidebarItemPlacement(sectionPlacements, item);
    void updateSidebarOrder({
      sectionPlacements: nextSectionPlacements,
      pinned: hasSidebarPinnedRef(pinnedRefs, ref) ? pinnedRefs : upsertSidebarPinnedRef(pinnedRefs, ref),
    });
  }, [pinnedRefForMovableItem, pinnedRefs, sectionPlacements, updateSidebarOrder]);

  const moveItemToCustomSection = useCallback((item: SidebarMovableItem, sectionId: string) => {
    const ref = pinnedRefForMovableItem(item);
    void updateSidebarOrder({
      sectionPlacements: moveSidebarItemToCustomSection(sectionPlacements, item, sectionId),
      pinned: ref ? removeSidebarPinnedRef(pinnedRefs, ref) : pinnedRefs,
    });
  }, [pinnedRefForMovableItem, pinnedRefs, sectionPlacements, updateSidebarOrder]);

  const removeItemFromCustomSection = useCallback((item: SidebarMovableItem) => {
    void updateSidebarOrder({ sectionPlacements: removeSidebarItemPlacement(sectionPlacements, item) });
  }, [sectionPlacements, updateSidebarOrder]);

  const createCustomSection = useCallback((value: { name: string; emoji: string | null }, moveItem?: SidebarMovableItem) => {
    const id = crypto.randomUUID();
    const section: SidebarCustomSection = { id, name: value.name, emoji: value.emoji, sortMode: "manual" };
    const nextSectionPlacements = moveItem
      ? moveSidebarItemToCustomSection(sectionPlacements, moveItem, id)
      : sectionPlacements;
    const moveItemRef = moveItem ? pinnedRefForMovableItem(moveItem) : null;
    void updateSidebarOrder({
      customSections: [...customSections, section],
      sectionOrder: [...sectionOrder, id],
      sectionPlacements: nextSectionPlacements,
      pinned: moveItemRef ? removeSidebarPinnedRef(pinnedRefs, moveItemRef) : pinnedRefs,
    });
    setSectionDialog(null);
  }, [customSections, pinnedRefForMovableItem, pinnedRefs, sectionOrder, sectionPlacements, updateSidebarOrder]);

  const updateCustomSection = useCallback((sectionId: string, value: { name: string; emoji: string | null }) => {
    void updateSidebarOrder({
      customSections: customSections.map((section) => section.id === sectionId ? { ...section, ...value } : section),
    });
    setSectionDialog(null);
  }, [customSections, updateSidebarOrder]);

  const deleteCustomSection = useCallback((sectionId: string) => {
    void updateSidebarOrder({
      customSections: customSections.filter((section) => section.id !== sectionId),
      sectionOrder: sectionOrder.filter((id) => id !== sectionId),
      sectionPlacements: sectionPlacements.filter((placement) => placement.sectionId !== sectionId),
    });
    setSectionCtxMenu(null);
  }, [customSections, sectionOrder, sectionPlacements, updateSidebarOrder]);

  const togglePinChannel = useCallback((channelId: string) => {
    togglePinnedRef({ kind: "channel", id: channelId }, [{ kind: "channel", id: channelId }]);
  }, [togglePinnedRef]);

  const toggleChannelActivityMute = async (channel: Channel) => {
    // Stryker disable next-line all: the context-menu visibility gate enforces the same supported/joined/non-thread predicate; this is defense-in-depth for non-UI callers.
    if (!canToggleActivityMute(channel)) return;
    const previous = {
      activityMuted: channel.activityMuted === true,
      muteFromSeq: channel.muteFromSeq ?? null,
      prefsVersion: channel.prefsVersion,
    };
    const nextActivityMuted = !previous.activityMuted;
    const optimistic = {
      activityMuted: nextActivityMuted,
      muteFromSeq: previous.muteFromSeq,
      prefsVersion: previous.prefsVersion,
    };
    useChannelStore.getState().setActivityMuteState(channel.id, optimistic);

    try {
      const { data } = await api.patch(`/channels/${channel.id}/notification-settings`, {
        activityMuted: nextActivityMuted,
      });
      useChannelStore.getState().setActivityMuteState(channel.id, normalizeActivityMuteState(data));
    } catch {
      const current = useChannelStore.getState().channels.find((candidate) => candidate.id === channel.id);
      if (matchesActivityMuteState(current, optimistic)) {
        useChannelStore.getState().setActivityMuteState(channel.id, previous);
        toast.error(nextActivityMuted
          ? formatMessage({ id: "layout.sidebar.failedMuteActivity" })
          : formatMessage({ id: "layout.sidebar.failedUnmuteActivity" }));
      }
    }
  };

  const togglePinAgent = useCallback((agentId: string) => {
    const agentDm = dmChannels.find((dm) => dm.peerType === "agent" && dm.peerId === agentId);
    togglePinnedRef(
      { kind: "agent", id: agentId },
      [
        { kind: "agent", id: agentId },
        ...(agentDm ? [{ kind: "channel", id: agentDm.id } satisfies SidebarMovableItem] : []),
      ],
    );
  }, [dmChannels, togglePinnedRef]);

  const togglePinDm = useCallback((dm: Channel) => {
    const ref = pinnedRefForDmChannel(dm);
    if (!ref) return;
    togglePinnedRef(ref, [{ kind: "channel", id: dm.id }]);
  }, [togglePinnedRef]);

  const resolveWorkspaceSidebarReorderScope = useCallback((activeId: string, overId: string) => (
    getWorkspaceSidebarReorderScope(activeId, overId, {
      channelManualSort,
      jointChannelManualSort,
      dmManualSort,
      sortableChannelIds,
      sortableJointChannelIds,
      sortableDmIds,
    })
  ), [channelManualSort, dmManualSort, jointChannelManualSort, sortableChannelIds, sortableDmIds, sortableJointChannelIds]);

  const handleWorkspaceSidebarDragOver = useCallback((event: React.DragEvent<HTMLElement>, overId: string) => {
    const activeId = workspaceSidebarNativeDragIdRef.current;
    if (!activeId || !resolveWorkspaceSidebarReorderScope(activeId, overId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, [resolveWorkspaceSidebarReorderScope]);

  const handleWorkspaceSidebarDrop = useCallback((event: React.DragEvent<HTMLElement>, overId: string) => {
    const activeId = workspaceSidebarNativeDragIdRef.current;
    if (!activeId) return;
    const scope = resolveWorkspaceSidebarReorderScope(activeId, overId);
    if (!scope) return;
    event.preventDefault();
    event.stopPropagation();

    const activeParsed = parseDragId(activeId);
    const overParsed = parseDragId(overId);
    if (!activeParsed || !overParsed) return;

    if (scope === "dms") {
      const nextOrder = reorderSidebarSubset(dmOrderIds, sortableDmIds, activeParsed.id, overParsed.id);
      if (!nextOrder) return;
      setDmOrderIds(nextOrder);
      void updateSidebarOrder({ dmOrder: nextOrder });
      workspaceSidebarNativeDragIdRef.current = null;
      return;
    }

    const sortableIds = scope === "channels" ? sortableChannelIds : sortableJointChannelIds;
    const nextOrder = reorderSidebarSubset(channelOrderIds, sortableIds, activeParsed.id, overParsed.id);
    if (!nextOrder) return;
    setChannelOrderIds(nextOrder);
    void updateSidebarOrder({ channelOrder: nextOrder.filter((id) => id !== allChannelId) });
    workspaceSidebarNativeDragIdRef.current = null;
  }, [
    allChannelId,
    channelOrderIds,
    dmOrderIds,
    resolveWorkspaceSidebarReorderScope,
    sortableChannelIds,
    sortableDmIds,
    sortableJointChannelIds,
    updateSidebarOrder,
  ]);

  const handleWorkspaceSidebarDragEnd = useCallback(() => {
    workspaceSidebarNativeDragIdRef.current = null;
  }, []);

  const sidebarCollisionDetection = useCallback<CollisionDetection>((args) => {
    const activeId = String(args.active.id);
    if (sectionOrder.includes(activeId)) {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => (
          sectionOrder.includes(String(container.id))
        )),
      });
    }

    const validContainers = args.droppableContainers.filter((container) => {
      const data = container.data.current;
      if (!isSidebarDndData(data)) return false;
      return isValidSidebarDndDestination(activeId, data.containerId);
    });
    const collisionArgs = { ...args, droppableContainers: validContainers };
    const pointerCollisions = pointerWithin(collisionArgs);
    const itemCollision = pointerCollisions.find((collision) => {
      const container = validContainers.find((candidate) => candidate.id === collision.id);
      return (container?.data.current as SidebarDndData | undefined)?.type === "item";
    });
    if (itemCollision) return [itemCollision];
    if (pointerCollisions.length > 0) return pointerCollisions;

    // A pointer can be directly over a droppable that is not a valid
    // destination for the active item (for example, a regular channel passing
    // through Joint Channels). Falling back to the nearest valid container in
    // that case makes live projection alternate between the containers above
    // and below the invalid section as their geometry changes. That feedback
    // loop keeps dnd-kit remeasuring until React hits its update-depth guard.
    // Restore the drag-start container while any invalid droppable is directly
    // under the pointer. Returning no collision would preserve a transient
    // projection picked while crossing the gap before the invalid section.
    // Resolving the original container makes the projection deterministic and
    // keeps closest-center as the keyboard/gap fallback.
    if (pointerWithin(args).length > 0) {
      const sourceContainerId = sidebarDndSnapshotRef.current
        ? findSidebarDndContainer(sidebarDndSnapshotRef.current, activeId)
        : null;
      if (sourceContainerId) return [{ id: sourceContainerId }];
      return [];
    }
    return closestCenter(collisionArgs);
  }, [isValidSidebarDndDestination, sectionOrder]);

  const resetSidebarDnd = useCallback(() => {
    sidebarDndSnapshotRef.current = null;
    sidebarDndProjectionRef.current = null;
    setSidebarDndProjection(null);
    setSidebarDndActiveId(null);
  }, []);

  const handleSidebarDragStart = useCallback(({ active }: DragStartEvent) => {
    const data = active.data.current as SidebarDndData | undefined;
    if (data?.type !== "item") {
      resetSidebarDnd();
      return;
    }
    sidebarDndSnapshotRef.current = sidebarDndBaseProjection;
    sidebarDndProjectionRef.current = sidebarDndBaseProjection;
    setSidebarDndProjection(sidebarDndBaseProjection);
    setSidebarDndActiveId(data.itemId);
  }, [resetSidebarDnd, sidebarDndBaseProjection]);

  const projectSidebarDndOver = useCallback((
    active: DragOverEvent["active"],
    over: NonNullable<DragOverEvent["over"]>,
    current: SidebarDndProjection,
  ): SidebarDndProjection => {
    const activeData = active.data.current;
    const overData = over.data.current;
    if (
      !isSidebarDndData(activeData)
      || activeData.type !== "item"
      || !isSidebarDndData(overData)
    ) return current;
    if (!isValidSidebarDndDestination(activeData.itemId, overData.containerId)) return current;
    const destinationItems = current[overData.containerId];
    if (!destinationItems) return current;

    let destinationIndex = destinationItems.length;
    if (overData.type === "item" && overData.itemId !== activeData.itemId) {
      const itemsWithoutActive = destinationItems.filter((itemId) => itemId !== activeData.itemId);
      const overIndex = itemsWithoutActive.indexOf(overData.itemId);
      if (overIndex === -1) return current;
      const activeRect = active.rect.current.translated ?? active.rect.current.initial;
      const edge = getSidebarDropIndicatorEdge(
        activeRect ? activeRect.top + activeRect.height / 2 : over.rect.top,
        over.rect.top + over.rect.height / 2,
      );
      destinationIndex = overIndex + (edge === "after" ? 1 : 0);
    } else if (overData.type === "item") {
      return current;
    }

    return moveSidebarDndItem(
      current,
      activeData.itemId,
      overData.containerId,
      destinationIndex,
    );
  }, [isValidSidebarDndDestination]);

  const handleSidebarDragOver = useCallback(({ active, over }: DragOverEvent) => {
    if (!over) return;
    const current = sidebarDndProjectionRef.current ?? sidebarDndBaseProjection;
    const next = projectSidebarDndOver(active, over, current);
    if (next === current) return;
    sidebarDndProjectionRef.current = next;
    setSidebarDndProjection(next);
  }, [projectSidebarDndOver, sidebarDndBaseProjection]);

  const handleSidebarDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    const activeId = String(active.id);
    if (over && sectionOrder.includes(activeId) && sectionOrder.includes(String(over.id))) {
      const overId = String(over.id);
      const nextOrder = reorderSidebarSectionOrder(sectionOrder, activeId, overId);
      if (nextOrder !== sectionOrder) void updateSidebarOrder({ sectionOrder: nextOrder });
      resetSidebarDnd();
      return;
    }

    const snapshot = sidebarDndSnapshotRef.current;
    const currentProjection = sidebarDndProjectionRef.current;
    const projection = over && currentProjection
      ? projectSidebarDndOver(active, over, currentProjection)
      : currentProjection;
    const sourceContainerId = snapshot ? findSidebarDndContainer(snapshot, activeId) : null;
    const destinationContainerId = projection ? findSidebarDndContainer(projection, activeId) : null;
    resetSidebarDnd();
    if (
      !over
      || !snapshot
      || !projection
      || !sourceContainerId
      || !destinationContainerId
      || !isValidSidebarDndDestination(activeId, destinationContainerId)
    ) {
      return;
    }

    const movableItem = resolveMovableItemFromDragId(activeId);
    if (!movableItem) return;

    if (destinationContainerId === SIDEBAR_PINNED_CONTAINER_ID) {
      const seen = new Set<string>();
      const nextPinned = projection[SIDEBAR_PINNED_CONTAINER_ID]
        .map(resolvePinnedRefFromDragId)
        .filter((ref): ref is SidebarPinnedRef => {
          if (!ref) return false;
          const key = sidebarPinnedRefKey(ref);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      void updateSidebarOrder({
        pinned: nextPinned,
        sectionPlacements: removeSidebarItemPlacement(sectionPlacements, movableItem),
      });
      return;
    }

    const customSectionId = sidebarCustomSectionId(destinationContainerId);
    if (customSectionId) {
      const destinationIndex = projection[destinationContainerId].indexOf(activeId);
      const ref = resolvePinnedRefFromDragId(activeId);
      void updateSidebarOrder({
        sectionPlacements: moveSidebarItemToCustomSectionAtPosition(
          sectionPlacements,
          movableItem,
          customSectionId,
          destinationIndex,
        ),
        pinned: ref ? removeSidebarPinnedRef(pinnedRefs, ref) : pinnedRefs,
      });
      return;
    }

    const activeDefaultOrderId = getSidebarDndDefaultOrderId(activeId);
    if (!activeDefaultOrderId) return;
    const nextSubset = projection[destinationContainerId]
      .map(getSidebarDndDefaultOrderId)
      .filter((id): id is string => !!id);
    const previousSubset = [
      ...new Set([
        ...snapshot[destinationContainerId]
          .map(getSidebarDndDefaultOrderId)
          .filter((id): id is string => !!id),
        activeDefaultOrderId,
      ]),
    ];
    const ref = resolvePinnedRefFromDragId(activeId);
    const nextPlacements = removeSidebarItemPlacement(sectionPlacements, movableItem);
    const nextPinned = ref ? removeSidebarPinnedRef(pinnedRefs, ref) : pinnedRefs;

    if (destinationContainerId === SIDEBAR_DMS_CONTAINER_ID) {
      const nextOrder = replaceSidebarSubsetOrder(dmOrderIds, previousSubset, nextSubset);
      setDmOrderIds(nextOrder);
      void updateSidebarOrder({
        dmOrder: nextOrder,
        pinned: nextPinned,
        sectionPlacements: nextPlacements,
      });
      return;
    }
    const nextOrder = replaceSidebarSubsetOrder(channelOrderIds, previousSubset, nextSubset);
    setChannelOrderIds(nextOrder);
    void updateSidebarOrder({
      channelOrder: nextOrder.filter((id) => id !== allChannelId),
      pinned: nextPinned,
      sectionPlacements: nextPlacements,
    });
  }, [
    allChannelId,
    channelOrderIds,
    dmOrderIds,
    getSidebarDndDefaultOrderId,
    isValidSidebarDndDestination,
    pinnedRefs,
    resetSidebarDnd,
    resolveMovableItemFromDragId,
    resolvePinnedRefFromDragId,
    projectSidebarDndOver,
    sectionOrder,
    sectionPlacements,
    updateSidebarOrder,
  ]);
  // Stryker restore all

  const renderChannelItem = (channel: Channel, options: { allowWrap?: boolean } = {}) => (
    <ChannelRow
      key={channel.id}
      channel={channel}
      selected={isChannelSelected(channel.id)}
      menuOpen={ctxMenu?.type === "channel" && ctxMenu.id === channel.id}
      onSelect={handleSelectChannel}
      onContextMenu={openCtxMenu}
      makeLongPress={makeLongPressHandlers}
      // Stryker disable all: typed drag payload forwarding is contract-pinned and browser-smoke verified.
      onDragStart={workspaceEnabled ? (event, draggedChannel) => dragWorkspacePanel(
        event,
        { kind: "channel", id: draggedChannel.id },
        { title: `#${draggedChannel.name}`, subtitle: formatMessage({ id: "workspace.panel.channel" }) },
        channelDragId(draggedChannel.id),
      ) : undefined}
      onDragEnd={workspaceEnabled ? handleWorkspaceSidebarDragEnd : undefined}
      onDragOver={workspaceEnabled ? (event, draggedChannel) => handleWorkspaceSidebarDragOver(event, channelDragId(draggedChannel.id)) : undefined}
      onDrop={workspaceEnabled ? (event, draggedChannel) => handleWorkspaceSidebarDrop(event, channelDragId(draggedChannel.id)) : undefined}
      // Stryker restore all
      allowWrap={options.allowWrap}
    />
  );

  /** Render agent as a DM conversation item (Chat tab) — navigates to /dm/:dmId */
  const renderAgentDmItem = (agent: typeof agents[0], options: { allowWrap?: boolean; hideDescription?: boolean } = {}) => {
    const dmId = agentDmChannelId[agent.id];
    const dm = agentDmChannelByAgentId[agent.id];
    return (
      <AgentDmRow
        key={agent.id}
        agent={agent}
        dmId={dmId}
        dm={dm}
        selected={dmId ? isDmSelected(dmId) : false}
        menuOpen={ctxMenu?.type === "agent" && ctxMenu.id === agent.id}
        onSelect={handleSelectAgentDm}
        onContextMenu={openCtxMenu}
        makeLongPress={makeLongPressHandlers}
        // Stryker disable all: typed drag payload forwarding is contract-pinned and browser-smoke verified.
        onDragStart={workspaceEnabled ? (event, draggedAgent, draggedDmId) => dragWorkspacePanel(
          event,
          draggedDmId ? { kind: "dm", id: draggedDmId } : { kind: "agent", id: draggedAgent.id },
          {
            title: `@${draggedAgent.displayName || draggedAgent.name}`,
            subtitle: draggedDmId
              ? formatMessage({ id: "workspace.panel.directMessage" })
              : formatMessage({ id: "workspace.panel.agent" }),
          },
          draggedDmId ? dmDragId(draggedDmId) : undefined,
        ) : undefined}
        onDragEnd={workspaceEnabled ? handleWorkspaceSidebarDragEnd : undefined}
        onDragOver={workspaceEnabled ? (event, draggedDmId) => {
          if (draggedDmId) handleWorkspaceSidebarDragOver(event, dmDragId(draggedDmId));
        } : undefined}
        onDrop={workspaceEnabled ? (event, draggedDmId) => {
          if (draggedDmId) handleWorkspaceSidebarDrop(event, dmDragId(draggedDmId));
        } : undefined}
        // Stryker restore all
        allowWrap={options.allowWrap}
        hideDescription={options.hideDescription}
      />
    );
  };

  const renderDmItem = (dm: Channel, options: { allowWrap?: boolean; hideDescription?: boolean } = {}) => {
    const isAgent = dm.peerType === "agent";
    const dmCtxTarget = getSidebarDmContextTarget(dm, dmContextPeerIds);
    const matchingAgent = isAgent && dm.peerId ? agentById.get(dm.peerId) : undefined;
    const agentProfile = matchingAgent ? resolveAgentDmProfileSource(matchingAgent, dm) : null;
    const displayName = agentProfile
      ? agentProfile.displayName
      : dm.peerDisplayName || dm.peerName || dm.name;
    const description = options.hideDescription
      ? null
      : isAgent
        ? agentProfile?.description ?? null
        : dm.peerDescription ?? null;
    const avatarUrl = agentProfile ? agentProfile.avatarUrl : dm.peerAvatarUrl ?? null;
    return (
      <DmRow
        key={dm.id}
        dm={dm}
        isAgent={isAgent}
        peerId={dm.peerId ?? null}
        displayName={displayName}
        description={description}
        avatarUrl={avatarUrl}
        selected={isDmSelected(dm.id)}
        menuOpen={ctxMenu?.type === dmCtxTarget.type && ctxMenu.id === dmCtxTarget.id}
        ctxType={dmCtxTarget.type}
        ctxId={dmCtxTarget.id}
        onSelect={handleSelectDm}
        onContextMenu={openCtxMenu}
        makeLongPress={makeLongPressHandlers}
        // Stryker disable all: typed drag payload forwarding is contract-pinned and browser-smoke verified.
        onDragStart={workspaceEnabled ? (event, draggedDm) => dragWorkspacePanel(
          event,
          { kind: "dm", id: draggedDm.id },
          { title: `@${displayName}`, subtitle: formatMessage({ id: "workspace.panel.directMessage" }) },
          dmDragId(draggedDm.id),
        ) : undefined}
        onDragEnd={workspaceEnabled ? handleWorkspaceSidebarDragEnd : undefined}
        onDragOver={workspaceEnabled ? (event, draggedDm) => handleWorkspaceSidebarDragOver(event, dmDragId(draggedDm.id)) : undefined}
        onDrop={workspaceEnabled ? (event, draggedDm) => handleWorkspaceSidebarDrop(event, dmDragId(draggedDm.id)) : undefined}
        // Stryker restore all
        allowWrap={options.allowWrap}
      />
    );
  };

  /** Render agent as an entity item (Members tab) — navigates to /agent/:agentId */
  // Stryker disable all: member-row interaction glue is contract-pinned and browser-smoke verified.
  const renderAgentItem = (agent: typeof agents[0]) => {
    return (
      <button
        key={agent.id}
        draggable={workspaceEnabled}
        onDragStart={(event) => dragWorkspacePanel(
          event,
          { kind: "agent", id: agent.id },
          { title: `@${agent.displayName || agent.name}`, subtitle: formatMessage({ id: "workspace.panel.agent" }) },
        )}
        onClick={(event) => handleSelectAgent(agent.id, event.detail)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void handleOpenAgentDm(agent.id);
        }}
        onContextMenu={(e) => openCtxMenu(e, "member-agent", agent.id)}
        {...makeLongPressHandlers("member-agent", agent.id)}
        className={sidebarItemClass(isAgentSelected(agent.id), ctxMenu?.type === "member-agent" && ctxMenu.id === agent.id)}
      >
        <AvatarSlot
          context="sidebar-list"
          type="agent"
          agentAvatarUrl={agent.avatarUrl}
          badge={<SidebarAgentActivityBadge agentId={agent.id} />}
        />
        <div className="flex min-w-0 flex-1 items-baseline gap-1 text-left">
          <span className="shrink-0 max-w-[70%] truncate text-sm">{agent.displayName || agent.name}</span>
          {agent.description && (
            <span className="min-w-0 flex-1 truncate text-xs text-black/40">{agent.description}</span>
          )}
        </div>
      </button>
    );
  };
  // Stryker restore all

  // Stryker disable all: pre-existing shared section-toggle glue is outside the workspace mutation corpus.
  const toggleAgentsSection = () => toggleSection("agents");
  const agentsExpanded = !collapsed.agents;
  // Stryker restore all

  const renderPinnedItem = (item: PinnedDisplayItem) => {
    switch (item.type) {
      case "channel":
        return renderChannelItem(item.channel, { allowWrap: true });
      case "dm":
        // Stryker disable next-line all: allowWrap only changes pinned-row visual wrapping; DOM tests cover long-label wrapping for the pinned surface.
        return renderDmItem(item.dm, { allowWrap: true, hideDescription: item.dm.peerType === "agent" });
      case "agent":
        // Stryker disable next-line all: allowWrap only changes pinned-row visual wrapping; DOM tests cover long-label wrapping for the pinned surface.
        return renderAgentDmItem(item.agent, { allowWrap: true, hideDescription: true });
    }
  };

  const renderCustomSectionItem = (item: CustomSectionDisplayItem) => {
    switch (item.type) {
      case "channel":
        return renderChannelItem(item.channel);
      case "dm":
        return renderDmItem(item.dm, { hideDescription: true });
      case "agent":
        return renderAgentDmItem(item.agent, { hideDescription: true });
    }
  };

  const renderSidebarDndDisplayItem = (
    item: SidebarDndDisplayItem,
    containerId: string,
  ) => {
    const pinned = containerId === SIDEBAR_PINNED_CONTAINER_ID;
    const custom = sidebarCustomSectionId(containerId) !== null;
    switch (item.type) {
      case "channel":
        return renderChannelItem(item.channel, { allowWrap: pinned });
      case "dm":
        return renderDmItem(item.dm, {
          allowWrap: pinned,
          hideDescription: custom || (pinned && item.dm.peerType === "agent"),
        });
      case "agent":
        return renderAgentDmItem(item.agent, {
          allowWrap: pinned,
          hideDescription: pinned || custom,
        });
    }
  };

  const renderSidebarDndItem = (itemId: string, containerId: string) => {
    const item = sidebarDndDisplayItems.get(itemId);
    if (!item) return null;
    return (
      <SortableSidebarItem key={itemId} id={itemId} containerId={containerId}>
        {renderSidebarDndDisplayItem(item, containerId)}
      </SortableSidebarItem>
    );
  };

  const contextCustomSection = sectionCtxMenu?.section.startsWith("custom:")
    ? customSections.find((section) => section.id === sectionCtxMenu.section.slice("custom:".length)) ?? null
    : null;
  const sectionContextLabel = contextCustomSection?.name
    ?? (
      sectionCtxMenu && !sectionCtxMenu.section.startsWith("custom:")
        ? formatMessage({ id: SIDEBAR_SORT_SECTION_LABEL_ID[sectionCtxMenu.section as SidebarSortSection] })
        : "Section"
    );
  const contextMovableItem: SidebarMovableItem | null = (() => {
    if (!ctxMenu) return null;
    if (ctxMenu.type === "channel" || ctxMenu.type === "dm") return { kind: "channel", id: ctxMenu.id };
    if (ctxMenu.type === "human") {
      const dm = dmChannels.find((candidate) => candidate.peerType === "user" && candidate.peerId === ctxMenu.id);
      return dm ? { kind: "channel", id: dm.id } : null;
    }
    if (ctxMenu.type === "agent") {
      if (pinnedAgentIds.includes(ctxMenu.id) || customPlacedAgentIds.has(ctxMenu.id)) return { kind: "agent", id: ctxMenu.id };
      const dm = dmChannels.find((candidate) => candidate.peerType === "agent" && candidate.peerId === ctxMenu.id);
      return dm ? { kind: "channel", id: dm.id } : { kind: "agent", id: ctxMenu.id };
    }
    return null;
  })();
  const contextPlacement = contextMovableItem
    ? sectionPlacements.find((placement) => sidebarSectionItemKey(placement.kind, placement.id) === sidebarSectionItemKey(contextMovableItem.kind, contextMovableItem.id)) ?? null
    : null;
  const contextItemPinned = contextMovableItem?.kind === "channel"
    ? pinnedChannelIds.includes(contextMovableItem.id)
    : contextMovableItem?.kind === "agent" && pinnedAgentIds.includes(contextMovableItem.id);

  const renderReadToggleAction = (channelId: string, hasUnread: boolean) => (
    <MenuItem
      icon={hasUnread ? <MessageSquareCheck size={14} /> : <MessageSquareDot size={14} />}
      onClick={() => {
        setCtxMenu(null);
        const action = hasUnread ? markRead(channelId) : markUnread(channelId);
        void action.catch(() => {
          void useMessageStore.getState().loadUnreadCounts();
        });
      }}
    >
      {hasUnread
        ? formatMessage({ id: "layout.sidebar.markAsRead" })
        : formatMessage({ id: "layout.sidebar.markAsUnread" })}
    </MenuItem>
  );

  // Stryker disable all: pre-existing empty-computer state is outside the workspace mutation corpus.
  const emptyComputersContent = Object.keys(machineNames).length === 0
    ? machinesLoading ? (
      <SidebarRowsSkeleton rows={2} />
    ) : (
      <SidebarSectionDescription>{formatMessage({ id: "layout.sidebar.noComputersYet" })}</SidebarSectionDescription>
    )
    : null;
  // Stryker restore all

  return (
    <>
      {/* stdrc 2026-05-02 #proj-uiux:95e25b5b 6e039b98:
          - Desktop side-by-side: Sidebar `bg-brutal-cream`, Main `bg-white`
          - Mobile (mobileInline): no side-by-side; every tab interior
            is white per "移动端的每一个界面背景色都应该相应地变成白色".
            Sidebar full-screens as one tab → `bg-white`. */}
      <div
        // Stryker disable next-line StringLiteral: Tailwind composition is presentation-only and browser-smoke verified.
        className={`relative flex h-full w-full flex-col ${mobileInline ? "" : workspaceEnabled && workspaceRailMode ? "border-r border-black/25" : "border-r-2 border-black"} ${mobileInline ? "bg-white" : "bg-brutal-cream"} ${workspaceEnabled ? "workspace-scrollbar-subtle" : ""} text-black font-display select-none`}
        data-testid="sidebar-root"
      >
        {/* Mobile tab-root NavBar — yellow h-panel-header matching the level-2+
            panel headers so the brand yellow shows on every screen
            (@stdrc #proj-uiux:c8711d2a msgs 50ed96a6 + 83123f2b
            + 5013f840 2026-05-01).
            No tab icon — stdrc rejected the redundant Settings/Members/Hash
            glyph on the NavBar ("都不应该有那个 icon"). For the Chat tab
            the title text is also dropped: the ServerName pill is the
            only label, per "只显示一个 Server Name". For other tab roots
            (Settings / Members / Computers) the tab label sits on the
            left and the switcher pill stays on the right for server
            access. On desktop the switcher lives in the LeftRail, so we
            only need this header on mobile. */}
        {mobileInline && (
          <div className="relative flex h-panel-header shrink-0 items-center gap-3 border-b-2 border-black bg-soft-signal px-4">
            {railMode === "chat" ? (
              /* Home tab: ServerName pill on the LEFT — it IS the header.
                 No other tab renders the pill: stdrc msg 7b1cf65a
                 2026-05-01 `#proj-uiux:c8711d2a` "除了 Chat 之外的所有
                 其他区域，全都不要有 Server Name 那个选项". */
              <>
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setShowServerMenu(!showServerMenu)}
                  /* stdrc 2026-05-02 #proj-uiux:648f8735 5db88a17:
                     在窄+矮屏（移动 + max-h:600）顶部 server-name 不要卡片，
                     直接文字 + chevron，UI 跟 Members / Settings 一致。
                     Tailwind 修饰符链 strip 掉 tilt / border / bg / shadow / pad。 */
                  className="mobile-server-selector-vector relative inline-flex shrink-0 items-center border-2 [@media(max-height:600px)]:border-0 border-transparent bg-transparent px-3 [@media(max-height:600px)]:px-0 py-1 [@media(max-height:600px)]:py-0 font-display font-bold text-base text-soft-signal [@media(max-height:600px)]:text-black"
                >
                  <MobileServerSelectorVectorSurface />
                  {hasOtherServerUnread && (
                    <span className="mobile-server-selector-corner-anchor pointer-events-none absolute inset-0">
                      <AttentionDot
                        aria-label={formatMessage({ id: "layout.sidebar.otherServersUnread" })}
                        size="lg"
                        className="absolute -right-1 -top-1"
                        title={formatMessage({ id: "layout.sidebar.otherServersUnread" })}
                      />
                    </span>
                  )}
                  <span className="mobile-server-selector-content">
                    <span className="truncate max-w-[200px]">{server?.name || formatMessage({ id: "layout.sidebar.serverFallbackName" })}</span>
                    <ChevronDown size={16} className="rotate-2 shrink-0 [@media(max-height:600px)]:rotate-0" />
                  </span>
                </button>
                <div className="min-w-0 flex-1" />
                {/* Notification Center entry — permanent Bell on the Chat tab
                    navbar right side. Only its pink attention dot depends on
                    whether notifications exist. Originating direction:
                    stdrc 2026-05-02 #proj-uiux:f87f6eb9 (task #94 mobile case
                    "顶栏的右侧或右上角显示一个 Warning 按钮，只在首页显示"). */}
                <NotificationTrigger flavor="mobile-navbar" />
              </>
            ) : (
              <div className="min-w-0 flex-1">
                <div className="text-base font-bold text-black truncate">
                  {railLabel}
                </div>
              </div>
            )}

            {/* Server switcher menu — only renders on the Chat tab; other
                tabs don't host the pill trigger. */}
            {railMode === "chat" && (
              <ServerSwitcherMenu
                open={showServerMenu}
                onClose={() => setShowServerMenu(false)}
                serverUnreadCounts={serverUnreadCounts}
                testId="mobile-server-switcher-menu"
                navigationMode="replace-with-home"
                className="absolute top-full left-2 right-2 mt-1 max-h-[calc(100dvh-160px)]"
              />
            )}
          </div>
        )}

        {/* Desktop sidebar header — slimmer than the panel headers and
            without the yellow icon container; the LeftRail's selected tab
            already carries the icon, and reusing the panel-header pattern
            here visually competed with the channel/agent header to its
            right. Just a tall bold label gives the sidebar an anchored
            top edge while staying h-panel-header aligned. */}
        {!mobileInline && (
          // stdrc 2026-05-02 #proj-uiux:95e25b5b: sidebar header matches
          // sidebar body at `bg-brutal-cream`. Whole sidebar column
          // reads as one cream surface; main panel is white.
          <div className={`flex shrink-0 items-center bg-brutal-cream ${workspaceEnabled ? "h-12 border-b border-black/25 px-4" : "h-panel-header border-b-2 border-black px-5"}`}>
            <div className={workspaceEnabled ? "text-base font-semibold text-black" : "text-lg font-bold text-black"}>
              {railLabel}
            </div>
          </div>
        )}

        {/* "Find a conversation…" jump box, pinned above the scroll surface
            (Slack parity, #kabi-desktop). Chat rail only; name-based fuzzy jump
            over channels/DMs/agents/people — no message-content search, no
            keyboard shortcut. Electron desktop shell only: web withdraws it
            (@artin 2026-09-11), so `isElectronDesktopShell()` gates the block. */}
        {railMode === "chat" && isElectronDesktopShell() && (
          <SidebarConversationFinder
            channels={channels}
            dmChannels={dmChannels}
            agents={agents}
            members={members}
            currentUserId={user?.id}
            onOpenChannel={(channelId: string) => nav.toChannel(channelId)}
            onOpenDm={(dmChannelId: string) => nav.toDm(dmChannelId)}
            onOpenAgentDm={(agentId: string) => {
              void openDM(agentId).then((opened) => nav.toDm(opened.id));
            }}
            onOpenHumanDm={(userId: string) => {
              void openUserDM(userId).then((opened) => nav.toDm(opened.id));
            }}
          />
        )}

        {/* Scrollable content. Native browser scrollbars are used (task #282 /
            stdrc 2026-05-20 #proj-uiux:d7e5c75b restored desktop scrollbar
            visibility). */}
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={sidebarScrollRef}
            className={sidebarScrollClassName}
            data-testid="sidebar-scroll-surface"
            onContextMenu={railMode === "chat" ? openSidebarSurfaceCtxMenu : undefined}
          >
            {/* Keep a full-height inner surface without manufacturing phantom
                overflow; scrollbars should appear only for real overflow. */}
            <div className="min-h-full">
          {showSettingsRail ? (
            <div className="space-y-3">
              {settingsSidebarGroups.map((group) => (
                <div key={group.label}>
                  <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-widest text-black/40">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    // Stryker disable next-line all: pre-existing settings-row selection is outside the workspace mutation corpus.
                    const active = settingsTabFromPath === item.id;
                    const className = `${sidebarItemClass(active)} text-left`;
                    return item.href ? (
                      <a
                        key={item.id}
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={className}
                      >
                        {item.icon}
                        {item.label}
                      </a>
                    ) : (
                      <button
                        key={item.id}
                        onClick={item.onClick}
                        // Stryker disable next-line all: pre-existing settings-row presentation is outside the workspace mutation corpus.
                        className={className}
                      >
                        {item.icon}
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : showComputersRail ? (
            <>
              {/* Computers surface — larger card-style items showing the
                  computer name, daemon version, and status. Renders on both
                  desktop (dedicated Computers rail) and mobile (reached via
                  the Settings sub-nav → /computers). */}
              {/* Mobile-only back row — on mobile Computers is not a top-level
                  tab, it's a level-2 push under the Settings tab. iOS
                  NavigationView expects a back affordance at the top of every
                  pushed view, so render a "← Settings" row that pops back to
                  /settings (the Settings tab home). Desktop has its own
                  dedicated Computers rail so the back row would be wrong there. */}
              {mobileInline && (
                <button
                  type="button"
                  onClick={() => navigate(`${pathBase}/settings`)}
                  data-testid="computers-mobile-back"
                  className="mb-2 flex w-full items-center gap-1 px-2 py-1.5 text-left text-sm font-medium text-black/60 hover:text-black transition-colors"
                  aria-label={formatMessage({ id: "layout.sidebar.backToSettings" })}
                >
                  <ChevronLeft size={16} className="shrink-0" />
                  {formatMessage({ id: "layout.sidebar.headerSettings" })}
                </button>
              )}
              {/* Header→first-item gap matches the 1.5rem inter-item rhythm
                  (items below use mb-1.5), not the 1-unit rhythm used in
                  Chat/Members sections where items sit closer together. */}
              <div className="mb-1.5 flex items-center justify-between px-2">
                <div className="text-xs font-bold uppercase text-black tracking-widest">
                  {formatMessage({ id: "layout.sidebar.computersSectionLabel" })} <span className="text-black/40 font-mono normal-case tracking-normal">{Object.keys(machineNames).length}</span>
                </div>
                {canRegisterMachines && (
                  <button
                    onClick={() => setShowAddMachine(true)}
                    className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
                    title={formatMessage({ id: "layout.sidebar.addComputer" })}
                  >
                    <Plus size={14} />
                  </button>
                )}
              </div>

              {Object.keys(machineNames).map((machineId) => (
                <ComputerRow
                  key={machineId}
                  machineId={machineId}
                  selected={isMachineSelected(machineId)}
                  onSelect={handleSelectMachine}
                  // Stryker disable all: typed drag payload forwarding is contract-pinned and browser-smoke verified.
                  onDragStart={workspaceEnabled ? (event, machineId) => dragWorkspacePanel(
                    event,
                    { kind: "machine", id: machineId },
                    { title: machineNames[machineId] || formatMessage({ id: "machine.detail.computer" }), subtitle: formatMessage({ id: "workspace.panel.computer" }) },
                  ) : undefined}
                  // Stryker restore all
                />
              ))}

              {emptyComputersContent}
            </>
          ) : showChatRail ? (
            <>
              {/* Desktop Search lives in the LeftRail. Mobile keeps Search under
                  Home so it does not become a separate bottom-tab destination. */}
              {mobileInline && (
                <button
                  type="button"
                  data-testid="mobile-home-search-entry"
                  // Stryker disable next-line all: pre-existing mobile Search routing is outside the workspace mutation corpus.
                  onClick={() => nav.toSearch(undefined, { flushSync: true })}
                  className="mb-1 flex w-full items-center gap-1.5 px-2 py-2 [@media(max-height:600px)]:py-1 md:py-1 text-left text-sm font-medium border-2 border-transparent transition-colors hover:border-black hover:bg-white hover:shadow-brutal-sm active:border-black active:bg-white active:shadow-brutal-sm"
                >
                  <Search size={14} className="shrink-0" />
                  {formatMessage({ id: "layout.sidebar.search" })}
                </button>
              )}

              {/* Activity entry. On mobile (no rail) it always lives here. On
                  desktop Activity lives on the LeftRail (LeftRail.tsx), so this
                  sidebar entry is mobile-only — the rail-vs-sidebar placement
                  A/B was dropped 2026-06-30 (stdrc): rail is the default. */}
              {mobileInline && (
                <button
                  onClick={(e) => {
                    if (e.detail >= 2) return;
                    trackActivityOpen("sidebar");
                    nav.toThreadsInbox();
                  }}
                  onDoubleClick={() => {
                    // Land in the Activity surface and signal which row
                    // to scroll-to-top and highlight. We deliberately do
                    // NOT open the right thread panel — keeping the user in
                    // the inbox layer lets them scan other unread threads
                    // instead of jumping straight into one.
                    nav.toThreadsInbox();
                    focusFirstUnreadInboxItem();
                  }}
                  className={`mb-1  flex w-full items-center gap-1.5 px-2 py-2 [@media(max-height:600px)]:py-1 md:py-1 text-left text-sm font-medium border-2 transition-colors ${
                    location.pathname.endsWith("/activity") || location.pathname.endsWith("/inbox") || location.pathname.endsWith("/threads")
                      ? "border-black bg-brutal-pink shadow-brutal-sm font-bold"
                      : "border-transparent hover:border-black hover:bg-white hover:shadow-brutal-sm active:border-black active:bg-white active:shadow-brutal-sm"
                  }`}
                >
                  <Activity size={14} className="shrink-0" />
                  {formatMessage({ id: "layout.sidebar.activity" })}
                  {(() => {
                    return activityUnreadCount !== undefined && activityUnreadCount > 0 ? (
                      <span className="ml-auto shrink-0 rounded bg-brutal-pink px-1.5 py-0.5 text-[10px] font-bold leading-none text-white border border-black">
                        {activityUnreadCount > 99 ? "99+" : activityUnreadCount}
                      </span>
                    ) : null;
                  })()}
                </button>
              )}

              {/* Tasks moved to its own LeftRail mode, removed from Chat sidebar. */}

              {/* Saved */}
              {(() => {
                // Stryker disable all: workspace-only Saved visibility and selected chrome are browser-smoke verified, outside this pinned-sidebar mutation corpus.
                const savedEntry = !workspaceEnabled ? (
                  <button
                    onClick={() => nav.toSaved()}
                    className={`mb-1  flex w-full items-center gap-1.5 px-2 py-2 [@media(max-height:600px)]:py-1 md:py-1 text-left text-sm font-medium border-2 transition-colors ${
                      location.pathname.endsWith("/saved")
                        ? "border-black bg-brutal-pink shadow-brutal-sm font-bold"
                        : "border-transparent hover:border-black hover:bg-white hover:shadow-brutal-sm active:border-black active:bg-white active:shadow-brutal-sm"
                    }`}
                  >
                    <Bookmark size={14} className="shrink-0" />
                    {formatMessage({ id: "layout.sidebar.saved" })}
                    <SavedNavCount total={savedTotal} />
                  </button>
                ) : null;
                // Stryker restore all
                return savedEntry;
              })()}

              {/* Wiki - mobile-only entry (desktop uses the LeftRail tab).
                  Sits with Search/Activity/Saved per the mobile Home model. */}
              {mobileInline && wikiEnabled && (
                <button
                  type="button"
                  data-testid="mobile-home-wiki-entry"
                  onClick={() => nav.toWiki()}
                  className={`mb-1 flex w-full items-center gap-1.5 px-2 py-2 [@media(max-height:600px)]:py-1 md:py-1 text-left text-sm font-medium border-2 transition-colors ${
                    location.pathname.endsWith("/wiki")
                      ? "border-black bg-brutal-pink shadow-brutal-sm font-bold"
                      : "border-transparent hover:border-black hover:bg-white hover:shadow-brutal-sm active:border-black active:bg-white active:shadow-brutal-sm"
                  }`}
                >
                  <Network size={14} className="shrink-0" />
                  {formatMessage({ id: "layout.sidebar.wiki" })}
                </button>
              )}

              {(() => {
                // Stryker disable all: sidebar drag/drop render composition is covered by source contracts and browser/manual preview; command-runner DOM mutation tests cannot perform dnd-kit drags.
                const sidebarDragSections = (
              /* Stryker disable all: section-row event wiring and empty-state chrome are covered by rendered DOM plus the real-browser recording. */
              <DndContext
                sensors={dndSensors}
                collisionDetection={sidebarCollisionDetection}
                onDragStart={handleSidebarDragStart}
                onDragOver={handleSidebarDragOver}
                onDragCancel={resetSidebarDnd}
                onDragEnd={handleSidebarDragEnd}
              >
              <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col" data-testid="sidebar-section-list">
              {/* Pinned */}
              <SortableSidebarSection id="system:pinned" testId="sidebar-section-block-pinned" order={sectionOrder.indexOf("system:pinned")}>
                  <SidebarSectionHeader onContextMenu={(event) => openSectionCtxMenu(event, "pinned")}>
                    <SidebarSectionToggle
                      onClick={() => toggleSection("pinned")}
                      aria-expanded={!collapsed.pinned}
                      aria-controls="sidebar-section-pinned"
                      data-testid="sidebar-section-toggle-pinned"
                      className={SIDEBAR_SECTION_TOGGLE_CLASS}
                    >
                      <ChevronRight
                        size={12}
                        className={`transition-transform ${collapsed.pinned ? "" : "rotate-90"}`}
                      />
                      {formatMessage({ id: "layout.sidebar.pinned" })}
                      <span className="text-black/40 font-mono normal-case tracking-normal">
                        {sidebarDndCurrentProjection[SIDEBAR_PINNED_CONTAINER_ID].length}
                      </span>
                      {collapsed.pinned && unreadFlags.pinned && (
                        <AttentionDot size="lg" className="ml-1" />
                      )}
                    </SidebarSectionToggle>
                    <div className="flex shrink-0 items-center gap-1">
                      {renderSortMenu("pinned", pinnedSortMode, updatePinnedSortMode)}
                    </div>
                  </SidebarSectionHeader>

                  <div id="sidebar-section-pinned" hidden={collapsed.pinned}>
                    {!collapsed.pinned && (
                      <SidebarDndContainer
                        id={SIDEBAR_PINNED_CONTAINER_ID}
                        kind="pinned"
                        manual={pinnedManualSort}
                        itemIds={sidebarDndCurrentProjection[SIDEBAR_PINNED_CONTAINER_ID]}
                        empty={sidebarDndCurrentProjection[SIDEBAR_PINNED_CONTAINER_ID].length === 0}
                      >
                        {sidebarDndCurrentProjection[SIDEBAR_PINNED_CONTAINER_ID].length > 0 ? (
                            <SidebarSortOwnership
                              workspaceEnabled={workspaceEnabled}
                              sortable={sidebarDndCurrentProjection[SIDEBAR_PINNED_CONTAINER_ID]
                                .map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_PINNED_CONTAINER_ID))}
                              staticContent={pinnedItems.map((item) => (
                                <div key={item.id}>{renderPinnedItem(item)}</div>
                              ))}
                            />
                          ) : (
                            <SidebarSectionDescription
                              data-testid="sidebar-pinned-empty-hint"
                              tone="subtle"
                              className="mb-1 min-h-9 py-1.5 transition-colors"
                            >
                              <span className="block whitespace-normal break-words">
                                {formatMessage({ id: "layout.sidebar.pinnedEmptyHint" })}
                              </span>
                            </SidebarSectionDescription>
                          )
                        }
                      </SidebarDndContainer>
                    )}
                  </div>
                </SortableSidebarSection>

              {customSections
                .slice()
                .sort((a, b) => sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id))
                .map((section) => {
                  const containerId = sidebarCustomContainerId(section.id);
                  const projectedItemIds = sidebarDndCurrentProjection[containerId] ?? [];
                  const items = customSectionItems.get(section.id) ?? [];
                  const collapsedCustom = collapsedCustomSections[section.id] === true;
                  return (
                    <SortableSidebarSection key={section.id} id={section.id} testId={`sidebar-custom-section-${section.id}`} order={sectionOrder.indexOf(section.id)}>
                      <SidebarSectionHeader onContextMenu={(event) => openSectionCtxMenu(event, `custom:${section.id}`)}>
                        <SidebarSectionToggle
                          onClick={() => setCollapsedCustomSections((current) => {
                            const nextValue = !current[section.id];
                            writeSidebarCustomSectionCollapsed(user?.id, section.id, nextValue);
                            return { ...current, [section.id]: nextValue };
                          })}
                          aria-expanded={!collapsedCustom}
                          className={SIDEBAR_SECTION_TOGGLE_CLASS}
                        >
                          <ChevronRight size={12} className={`transition-transform ${collapsedCustom ? "" : "rotate-90"}`} />
                          {section.emoji && <span aria-hidden>{section.emoji}</span>}
                          <span className="truncate">{section.name}</span>
                          <span className="font-mono text-black/40 normal-case tracking-normal">{projectedItemIds.length}</span>
                          {collapsedCustom && customUnreadSectionIdSet.has(section.id) && <AttentionDot size="lg" className="ml-1" />}
                        </SidebarSectionToggle>
                      </SidebarSectionHeader>
                      <div hidden={collapsedCustom}>
                        <SidebarDndContainer
                          id={containerId}
                          kind="custom"
                          manual={section.sortMode === "manual"}
                          itemIds={projectedItemIds}
                          empty={projectedItemIds.length === 0}
                        >
                          {projectedItemIds.length === 0 ? (
                            <SidebarSectionDescription tone="subtle" className="py-1">
                              {formatMessage({ id: "layout.sidebar.noConversations" })}
                            </SidebarSectionDescription>
                          ) : (
                            <SidebarSortOwnership
                              workspaceEnabled={workspaceEnabled}
                              sortable={projectedItemIds.map((itemId) => renderSidebarDndItem(itemId, containerId))}
                              staticContent={items.map((item) => renderCustomSectionItem(item))}
                            />
                          )}
                        </SidebarDndContainer>
                      </div>
                    </SortableSidebarSection>
                  );
                })}

              {/* Joint Channels */}
              <SortableSidebarSection id="system:joint" testId="sidebar-section-block-joint" order={sectionOrder.indexOf("system:joint")}>
                  <SidebarSectionHeader onContextMenu={(event) => openSectionCtxMenu(event, "jointChannels")}>
                    <SidebarSectionToggle
                      onClick={() => toggleSection("jointChannels")}
                      aria-expanded={!collapsed.jointChannels}
                      aria-controls="sidebar-section-joint-channels"
                      data-testid="sidebar-section-toggle-joint-channels"
                      className={SIDEBAR_SECTION_TOGGLE_CLASS}
                    >
                      <ChevronRight
                        size={12}
                        className={`transition-transform ${collapsed.jointChannels ? "" : "rotate-90"}`}
                      />
                      <span className="truncate">{formatMessage({ id: "layout.sidebar.jointChannels" })}</span>
                      <span className="text-black/40 font-mono normal-case tracking-normal">
                        {sidebarDndCurrentProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID].length}
                      </span>
                      {collapsed.jointChannels && unreadFlags.joint && (
                        <AttentionDot size="lg" className="ml-1" />
                      )}
                    </SidebarSectionToggle>
                    <div className="flex shrink-0 items-center gap-1">
                      {renderSortMenu("jointChannels", jointChannelSortMode, updateJointChannelSortMode)}
                      {renderSectionAddButton("jointChannels")}
                    </div>
                  </SidebarSectionHeader>

                  <div id="sidebar-section-joint-channels" hidden={collapsed.jointChannels}>
                    {!collapsed.jointChannels && (
                      <SidebarDndContainer
                        id={SIDEBAR_JOINT_CHANNELS_CONTAINER_ID}
                        kind="jointChannels"
                        manual={jointChannelManualSort}
                        itemIds={sidebarDndCurrentProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID]}
                        empty={sidebarDndCurrentProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID].length === 0}
                      >
                        {sidebarDndCurrentProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID].length === 0 ? (
                          channelsLoading ? (
                            <SidebarRowsSkeleton rows={2} />
                          ) : (
                            <SidebarSectionDescription>{formatMessage({ id: "layout.sidebar.jointChannelsEmpty" })}</SidebarSectionDescription>
                          )
                        ) : (
                          <SidebarSortOwnership
                            workspaceEnabled={workspaceEnabled}
                            sortable={sidebarDndCurrentProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID]
                              .map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_JOINT_CHANNELS_CONTAINER_ID))}
                            staticContent={sortableJointChannels.map((channel) => renderChannelItem(channel))}
                          />
                        )}
                      </SidebarDndContainer>
                    )}
                  </div>
              </SortableSidebarSection>

              {/* Channels */}
              <SortableSidebarSection id="system:channels" testId="sidebar-section-block-channels" order={sectionOrder.indexOf("system:channels")}>
              <SidebarSectionHeader onContextMenu={(event) => openSectionCtxMenu(event, "channels")}>
                <SidebarSectionToggle
                  onClick={() => toggleSection("channels")}
                  aria-expanded={!collapsed.channels}
                  aria-controls="sidebar-section-channels"
                  data-testid="sidebar-section-toggle-channels"
                  className={SIDEBAR_SECTION_TOGGLE_CLASS}
                >
                  <ChevronRight
                    size={12}
                    className={`transition-transform ${collapsed.channels ? "" : "rotate-90"}`}
                  />
                  <span className="truncate">{formatMessage({ id: "layout.sidebar.channels" })}</span>
                  <span className="text-black/40 font-mono normal-case tracking-normal">
                    {sidebarDndCurrentProjection[SIDEBAR_CHANNELS_CONTAINER_ID].length}
                  </span>
                  {collapsed.channels && unreadFlags.channels && (
                    <AttentionDot size="lg" className="ml-1" data-testid="sidebar-section-unread-dot-channels" />
                  )}
                </SidebarSectionToggle>
                <div className="flex shrink-0 items-center gap-1">
                  {renderSortMenu("channels", channelSortMode, updateChannelSortMode)}
                  {renderSectionAddButton(
                    // Stryker disable next-line StringLiteral: the helper's non-joint branch intentionally treats every value other than jointChannels as a regular channel.
                    "channels",
                  )}
                </div>
              </SidebarSectionHeader>

              <div id="sidebar-section-channels" hidden={collapsed.channels}>
                {!collapsed.channels && (
                  <SidebarDndContainer
                    id={SIDEBAR_CHANNELS_CONTAINER_ID}
                    kind="channels"
                    manual={channelManualSort}
                    itemIds={sidebarDndCurrentProjection[SIDEBAR_CHANNELS_CONTAINER_ID]}
                    empty={sidebarDndCurrentProjection[SIDEBAR_CHANNELS_CONTAINER_ID].length === 0}
                  >
                    <SidebarSortOwnership
                      workspaceEnabled={workspaceEnabled}
                      sortable={sidebarDndCurrentProjection[SIDEBAR_CHANNELS_CONTAINER_ID]
                        .map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_CHANNELS_CONTAINER_ID))}
                      staticContent={fallbackRegularChannels.map((channel) => renderChannelItem(channel))}
                    />
                    {shouldShowSidebarChannelEmptyState(fallbackRegularChannels) && (
                      channelsLoading ? (
                        <SidebarRowsSkeleton />
                      ) : (
                        <SidebarSectionDescription>
                          {joinedChannelsOnly ? formatMessage({ id: "layout.sidebar.noJoinedChannels" }) : formatMessage({ id: "layout.sidebar.noChannelsYet" })}
                        </SidebarSectionDescription>
                      )
                    )}
                  </SidebarDndContainer>
                )}
              </div>
              {/* Stryker restore all */}
              </SortableSidebarSection>

              {/* Direct Messages — show open DMs, auto-reopen on unread */}
              {/* Stryker disable all: pre-existing DM ordering and section chrome are outside the workspace mutation corpus. */}
                <SortableSidebarSection id="system:dms" testId="sidebar-section-block-dms" order={sectionOrder.indexOf("system:dms")}>
                  <SidebarSectionHeader onContextMenu={(event) => openSectionCtxMenu(event, "dms")}>
                    <SidebarSectionToggle
                      onClick={toggleAgentsSection}
                      aria-expanded={agentsExpanded}
                      aria-controls="sidebar-section-direct-messages"
                      data-testid="sidebar-section-toggle-dms"
                      className={SIDEBAR_SECTION_TOGGLE_CLASS}
                    >
                      <ChevronRight
                        size={12}
                        className={`transition-transform ${collapsed.agents ? "" : "rotate-90"}`}
                      />
                      <span className="truncate">{formatMessage({ id: "layout.sidebar.directMessages" })}</span>
                      <span className="text-black/40 font-mono normal-case tracking-normal">
                        {sidebarDndCurrentProjection[SIDEBAR_DMS_CONTAINER_ID].length}
                      </span>
                      {collapsed.agents && unreadFlags.dms && (
                        <AttentionDot size="lg" className="ml-1" />
                      )}
                    </SidebarSectionToggle>
                    <div className="flex shrink-0 items-center gap-1">
                      {renderSortMenu("dms", dmSortMode, updateDmSortMode)}
                    </div>
                  </SidebarSectionHeader>

                  <div id="sidebar-section-direct-messages" hidden={collapsed.agents}>
                    {!collapsed.agents && (
                      <SidebarDndContainer
                        id={SIDEBAR_DMS_CONTAINER_ID}
                        kind="dms"
                        manual={dmManualSort}
                        itemIds={sidebarDndCurrentProjection[SIDEBAR_DMS_CONTAINER_ID]}
                        empty={sidebarDndCurrentProjection[SIDEBAR_DMS_CONTAINER_ID].length === 0}
                      >
                        {sidebarDndCurrentProjection[SIDEBAR_DMS_CONTAINER_ID].length > 0 ? (
                          <SidebarSortOwnership
                            workspaceEnabled={workspaceEnabled}
                            sortable={sidebarDndCurrentProjection[SIDEBAR_DMS_CONTAINER_ID]
                              .map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_DMS_CONTAINER_ID))}
                            staticContent={orderedDms.map((dm) => renderDmItem(dm))}
                          />
                        ) : channelsLoading ? (
                          <SidebarRowsSkeleton rows={3} />
                        ) : null}
                      </SidebarDndContainer>
                    )}
                  </div>
                </SortableSidebarSection>
                {/* Stryker restore all */}
              </div>
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {sidebarDndActiveId && sidebarDndDisplayItems.get(sidebarDndActiveId) ? (
                  <div
                    data-testid="sidebar-drag-overlay"
                    className="max-w-72 border-2 border-black bg-white px-2 py-1.5 text-sm font-medium shadow-brutal-sm"
                  >
                    {sidebarDndDisplayItems.get(sidebarDndActiveId)!.label}
                  </div>
                ) : null}
              </DragOverlay>
              </DndContext>
                );
                // Stryker restore all
                return sidebarDragSections;
              })()}
            </>
          ) : (
            <>
              {/* People tab: Agents, Humans, Computers */}
              {/* Stryker disable all: classic-only graph visibility is browser-smoke verified. */}
              {!workspaceEnabled ? (
                <button
                  type="button"
                  onClick={() => navigate(`${pathBase}/members/graph`)}
                  className={`${sidebarItemClass(location.pathname === `${pathBase}/members/graph`)} text-left`}
                >
                  <GitBranch size={14} className="shrink-0" />
                  {formatMessage({ id: "layout.sidebar.graph" })}
                </button>
              ) : null}
              {/* Stryker restore all */}

              {/* Agents */}
              {/* Stryker disable all: workspace rail composition is browser-smoke verified. */}
              {workspaceEnabled || railMode !== "humans" ? (
                <>
              <div className={SIDEBAR_SECTION_ROW_CLASS}>
                <button
                  type="button"
                  onClick={toggleAgentsSection}
                  className={SIDEBAR_SECTION_TOGGLE_CLASS}
                >
                  <ChevronRight
                    size={12}
                    className={`transition-transform ${collapsed.agents ? "" : "rotate-90"}`}
                  />
                  {formatMessage({ id: "layout.sidebar.agents" })}
                  <span className="text-black/40 font-mono normal-case tracking-normal">{agents.length}</span>
                </button>
                {renderAgentActionMenu()}
              </div>

              {!collapsed.agents && (
                <>
                  {agents.length === 0 ? (
                    agentsLoading ? (
                      <SidebarRowsSkeleton rows={3} />
                    ) : (
                      <SidebarSectionDescription>{formatMessage({ id: "layout.sidebar.noAgentsYet" })}</SidebarSectionDescription>
                    )
                  ) : (
                    (() => {
                      // Group agents by computer, preserving the order in which
                      // each computer first appears in the agents list.
                      const groups: { key: string; machineName: string; agents: typeof agents }[] = [];
                      const indexByKey = new Map<string, number>();
                      for (const agent of agents) {
                        const key = agent.machineId ?? "__no_machine__";
                        let idx = indexByKey.get(key);
                        if (idx === undefined) {
                          idx = groups.length;
                          indexByKey.set(key, idx);
                          const machineName = agent.machineId ? machineNames[agent.machineId] : null;
                          groups.push({
                            key,
                            machineName: machineName ?? formatMessage({ id: "layout.sidebar.noMachineGroupLabel" }),
                            agents: [],
                          });
                        }
                        groups[idx].agents.push(agent);
                      }
                      // Stryker disable all: grouped member-row projection is browser-smoke verified.
                      return groups.map((group) => {
                        const groupCollapsed = collapsedAgentMachineGroups[group.key] === true;
                        return (
                          <div key={group.key}>
                            <button
                              type="button"
                              onClick={() => toggleAgentMachineGroup(group.key)}
                              aria-expanded={!groupCollapsed}
                              data-testid={`sidebar-agent-machine-group-toggle-${group.key}`}
                              className="flex w-full items-center gap-1 px-2 mt-1.5 mb-0.5 text-[10px] font-mono lowercase text-black/40 select-none text-left hover:text-black/60"
                            >
                              <ChevronRight
                                size={9}
                                className={`shrink-0 transition-transform ${groupCollapsed ? "" : "rotate-90"}`}
                              />
                              <Monitor size={9} className="shrink-0" />
                              <span className="truncate">{group.machineName}</span>
                              <span>{group.agents.length}</span>
                            </button>
                            {!groupCollapsed && group.agents.map((agent) => renderAgentItem(agent))}
                          </div>
                        );
                      });
                      // Stryker restore all
                    })()
                  )}
                </>
              )}
                </>
              ) : null}
              {/* Stryker restore all */}

              {/* Humans */}
              {/* Stryker disable all: workspace rail composition is browser-smoke verified. */}
              {!hideHumansFromMembers && (
                <>
                  <div className={SIDEBAR_SECTION_ROW_CLASS}>
                    <button
                      type="button"
                      onClick={() => toggleSection("humans")}
                      data-testid="sidebar-section-toggle-humans"
                      className={SIDEBAR_SECTION_TOGGLE_CLASS}
                    >
                      <ChevronRight
                        size={12}
                        className={`transition-transform ${collapsed.humans ? "" : "rotate-90"}`}
                      />
                      {formatMessage({ id: "layout.sidebar.humans" })}
                      <span className="text-black/40 font-mono normal-case tracking-normal">{members.length}</span>
                    </button>
                    {canInviteMembers && (
                      <div className="relative">
                        <button
                          onClick={() => setShowInviteHuman(true)}
                          className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
                          title={formatMessage({ id: "layout.sidebar.inviteHuman" })}
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {!collapsed.humans && (
                    <>
                      {membersLoadError ? (
                        <div className="px-2 text-xs text-red-700 font-mono">{formatMessage({ id: "layout.sidebar.humansFailedToLoad" })}</div>
                      ) : members.length === 0 ? (
                        <SidebarSectionDescription>{formatMessage({ id: "layout.sidebar.noHumans" })}</SidebarSectionDescription>
                      ) : (
                        <>
                          {members.map((human) => {
                            const isSelf = human.userId === user?.id;
                            return (
                              <button
                                key={human.userId}
                                type="button"
                                draggable={workspaceEnabled}
                                onDragStart={(event) => dragWorkspacePanel(
                                  event,
                                  { kind: "human", id: human.userId },
                                  { title: `@${human.displayName || human.name}`, subtitle: formatMessage({ id: "workspace.panel.human" }) },
                                )}
                                onClick={(event) => handleSelectHuman(human.userId, event.detail)}
                                onDoubleClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void handleOpenHumanDm(human.userId);
                                }}
                                onContextMenu={(e) => openCtxMenu(e, "member-human", human.userId)}
                                {...makeLongPressHandlers("member-human", human.userId)}
                                className={sidebarItemClass(isHumanSelected(human.userId), ctxMenu?.type === "member-human" && ctxMenu.id === human.userId)}
                                title={isSelf ? formatMessage({ id: "layout.sidebar.youTitle" }) : `${human.displayName || human.name}`}
                              >
                                <AvatarSlot context="sidebar-list" type="human" humanAvatarUrl={human.avatarUrl} gravatarHash={human.gravatarHash} />
                                <div className="flex min-w-0 flex-1 items-baseline gap-1 text-left">
                                  <span className="shrink-0 max-w-[70%] truncate text-sm">
                                    {human.displayName || human.name}
                                    {isSelf && <span className="text-black/40 ml-1">{formatMessage({ id: "layout.sidebar.youSuffix" })}</span>}
                                  </span>
                                  {human.description && (
                                    <span className="min-w-0 flex-1 truncate text-xs text-black/40">{human.description}</span>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </>
                      )}
                    </>
                  )}
                </>
              )}
              {/* Stryker restore all */}

              {/* Computers list used to be inlined here on mobile (Members
                  tab covered the union). Per @stdrc 2026-04-30 #proj-uiux:c8711d2a
                  the mobile tab bar now has 4 tabs and Computers is reachable
                  via the Settings sub-nav (→ /computers). The desktop rail
                  still owns the dedicated Computers surface. */}
            </>
          )}
            </div>
          </div>
        </div>

        {bottomSlot ? (
          <div className="pointer-events-none shrink-0">
            {bottomSlot}
          </div>
        ) : null}

        {/* Bottom user bar removed — account info, Settings, Release Notes,
            and Logout all live in the LeftRail's account-menu flyout (desktop)
            and the MobileTabBar's Settings tab (mobile). */}
      </div>

      {showCreateChannel && (
        <CreateChannelDialog
          onClose={() => setShowCreateChannel(false)}
        />
      )}

      {showCreateJointChannel && canCreateJointChannel && (
        <CreateJointChannelDialog onClose={() => setShowCreateJointChannel(false)} />
      )}

      {showInviteHuman && (
        <InviteHumanDialog onClose={() => setShowInviteHuman(false)} />
      )}

      {showCreateExternalAgent && (
        <CreateAgentDialog
          external
          onClose={() => setShowCreateExternalAgent(false)}
        />
      )}

      {deleteConfirm && (() => {
        const target = deleteConfirm;
        const labels = {
          channel: {
            title: formatMessage({ id: "layout.sidebar.deleteChannelTitle" }),
            confirmLabel: formatMessage({ id: "layout.sidebar.deleteChannelTitle" }),
            message: formatMessage({ id: "layout.sidebar.deleteChannelMessage" }, { name: deleteConfirm.name }),
          },
          agent: {
            title: formatMessage({ id: "layout.sidebar.deleteAgentTitle" }),
            confirmLabel: formatMessage({ id: "layout.sidebar.deleteAgentTitle" }),
            message: formatMessage({ id: "layout.sidebar.deleteAgentMessage" }, { name: deleteConfirm.name }),
          },
        };
        const label = labels[target.type];
        return (
          <ConfirmDialog
            chromeLocale="active"
            title={label.title}
            message={label.message}
            confirmLabel={label.confirmLabel}
            loadingLabel={formatMessage({ id: "layout.sidebar.deletingLabel" })}
            onConfirm={async () => {
              if (target.type === "agent") {
                await deleteAgent(target.id);
              } else {
                await deleteChannel(target.id);
              }
              setDeleteConfirm(null);
            }}
            onClose={() => setDeleteConfirm(null)}
          />
        );
      })()}

      {stopAgentConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "layout.sidebar.stopAgentTitle" })}
          message={formatMessage({ id: "layout.sidebar.stopAgentMessage" }, { name: stopAgentConfirm.name })}
          confirmLabel={formatMessage({ id: "layout.sidebar.stopAgentTitle" })}
          loadingLabel={formatMessage({ id: "layout.sidebar.stoppingLabel" })}
          confirmColor="bg-brutal-orange"
          onConfirm={() => stopAgent(stopAgentConfirm.id)}
          onClose={() => setStopAgentConfirm(null)}
        />
      )}

      {resetAgentTarget && (
        <ResetAgentDialog
          agentId={resetAgentTarget.id}
          agentName={resetAgentTarget.name}
          canFullReset={capabilities.resetAgentWorkspace}
          memberRuntimeOnly={currentRole === "member"}
          onClose={() => setResetAgentTarget(null)}
        />
      )}

      {archiveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "layout.sidebar.archiveChannelTitle" })}
          message={formatMessage({ id: "layout.sidebar.archiveChannelMessage" }, { name: archiveConfirm.name })}
          confirmLabel={formatMessage({ id: "layout.sidebar.archiveChannelTitle" })}
          loadingLabel={formatMessage({ id: "layout.sidebar.archivingLabel" })}
          confirmColor="bg-brutal-orange"
          onConfirm={async () => {
            await archiveChannel(archiveConfirm.id);
          }}
          onClose={() => setArchiveConfirm(null)}
        />
      )}

      {sectionDialog?.mode === "create" && (
        <SidebarSectionDialog
          title={formatMessage({ id: "layout.sidebar.newSectionTitle" })}
          submitLabel={formatMessage({ id: "layout.sidebar.createSection" })}
          onSubmit={(value) => createCustomSection(value, sectionDialog.moveItem)}
          onClose={() => setSectionDialog(null)}
        />
      )}

      {sectionDialog?.mode === "edit" && (
        <SidebarSectionDialog
          title={formatMessage({ id: "layout.sidebar.editSectionTitle" })}
          initialName={sectionDialog.section.name}
          initialEmoji={sectionDialog.section.emoji ?? ""}
          submitLabel={formatMessage({ id: "layout.sidebar.saveSection" })}
          onSubmit={(value) => updateCustomSection(sectionDialog.section.id, value)}
          onClose={() => setSectionDialog(null)}
        />
      )}

      {deleteSectionConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "layout.sidebar.deleteSection" })}
          message={formatMessage(
            { id: "layout.sidebar.deleteSectionMessage" },
            { name: deleteSectionConfirm.name },
          )}
          confirmLabel={formatMessage({ id: "layout.sidebar.deleteSection" })}
          loadingLabel={formatMessage({ id: "layout.sidebar.deletingLabel" })}
          onConfirm={() => {
            deleteCustomSection(deleteSectionConfirm.id);
            setDeleteSectionConfirm(null);
          }}
          onClose={() => setDeleteSectionConfirm(null)}
        />
      )}

      {sectionCtxMenu && createPortal(
        <>
          <DismissBackdrop onDismiss={closeSectionCtx} trapContextMenu />
          <div
            ref={sectionCtxMenuRef}
            role="menu"
            aria-label={formatMessage(
              { id: "layout.sidebar.sectionOptionsAria" },
              { section: sectionContextLabel },
            )}
            data-testid={`sidebar-section-context-menu-${sectionCtxMenu.section}`}
            className="fixed z-50 card-brutal w-64 overflow-hidden select-none"
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
                  icon={<GitBranch size={14} />}
                  onClick={openCreateJointChannelDialog}
                >
                  {formatMessage({ id: "layout.sidebar.createJointChannel" })}
                </MenuItem>
                <ContextMenuDivider />
              </>
            )}
            <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-black/50">
              {formatMessage({ id: "layout.sidebar.sortMenuTitle" })}
            </div>
            {SIDEBAR_SORT_MODES.map((mode) => {
              const currentMode = contextCustomSection?.sortMode ?? (sectionCtxMenu.section === "pinned" ? pinnedSortMode
                : sectionCtxMenu.section === "jointChannels" ? jointChannelSortMode
                  : sectionCtxMenu.section === "channels" ? channelSortMode
                    : dmSortMode);
              return (
                <MenuItem
                  key={mode}
                  role="menuitemradio"
                  aria-checked={mode === currentMode}
                  trailing={mode === currentMode ? <Check size={14} /> : null}
                  onClick={() => {
                    if (contextCustomSection) {
                      void updateSidebarOrder({
                        customSections: customSections.map((section) => section.id === contextCustomSection.id ? { ...section, sortMode: mode } : section),
                      });
                    } else if (sectionCtxMenu.section === "pinned") updatePinnedSortMode(mode);
                    else if (sectionCtxMenu.section === "jointChannels") updateJointChannelSortMode(mode);
                    else if (sectionCtxMenu.section === "channels") updateChannelSortMode(mode);
                    else updateDmSortMode(mode);
                    closeSectionCtx();
                  }}
                >
                  {formatMessage({ id: SIDEBAR_SORT_LABEL_ID[mode] })}
                </MenuItem>
              );
            })}
            {sectionCtxMenu.section === "channels" && (
              <>
                <ContextMenuDivider />
                <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-black/50">
                  {formatMessage({ id: "layout.sidebar.displaySection" })}
                </div>
                <MenuItem
                  role="menuitemcheckbox"
                  aria-checked={joinedChannelsOnly}
                  trailing={joinedChannelsOnly ? <Check size={14} /> : null}
                  onClick={() => {
                    updateJoinedChannelsOnly(!joinedChannelsOnly);
                    closeSectionCtx();
                  }}
                >
                  {formatMessage({ id: "layout.sidebar.showJoinedChannelsOnly" })}
                </MenuItem>
              </>
            )}
            <ContextMenuDivider />
            {contextCustomSection && (
              <>
                <MenuItem
                  icon={<Pencil size={14} />}
                  onClick={() => {
                    setSectionDialog({ mode: "edit", section: contextCustomSection });
                    closeSectionCtx();
                  }}
                >
                  {formatMessage({ id: "layout.sidebar.renameSection" })}
                </MenuItem>
              </>
            )}
            <MenuItem
              icon={<FolderPlus size={14} />}
              onClick={() => {
                setSectionDialog({ mode: "create" });
                closeSectionCtx();
              }}
            >
              {formatMessage({ id: "layout.sidebar.newSectionMenu" })}
            </MenuItem>
            {contextCustomSection && (
              <>
                <ContextMenuDivider />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  onClick={() => {
                    setDeleteSectionConfirm(contextCustomSection);
                    closeSectionCtx();
                  }}
                >
                  {formatMessage({ id: "layout.sidebar.deleteSection" })}
                </MenuItem>
              </>
            )}
          </div>
        </>,
        document.body,
      )}

      {sidebarSurfaceCtxMenu && createPortal(
        <>
          <DismissBackdrop onDismiss={closeSidebarSurfaceCtx} trapContextMenu />
          <div
            ref={sidebarSurfaceCtxMenuRef}
            role="menu"
            aria-label={formatMessage({ id: "layout.sidebar.sidebarOptionsAria" })}
            data-testid="sidebar-surface-context-menu"
            className="fixed z-50 card-brutal w-64 overflow-hidden select-none"
            style={getSidebarContextMenuStyle(sidebarSurfaceCtxMenu)}
            onMouseDown={stopSidebarContextMenuPropagation}
          >
            {canManageServer && (
              <MenuItem
                icon={<Plus size={14} />}
                onClick={() => {
                  setShowCreateChannel(true);
                  closeSidebarSurfaceCtx();
                }}
              >
                {formatMessage({ id: "layout.sidebar.createChannel" })}
              </MenuItem>
            )}
            {canCreateJointChannel && (
              <MenuItem
                icon={<GitBranch size={14} />}
                onClick={() => {
                  setShowCreateJointChannel(true);
                  closeSidebarSurfaceCtx();
                }}
              >
                {formatMessage({ id: "layout.sidebar.createJointChannel" })}
              </MenuItem>
            )}
            {(canManageServer || canCreateJointChannel) && <ContextMenuDivider />}
            <MenuItem
              icon={<FolderPlus size={14} />}
              onClick={() => {
                setSectionDialog({ mode: "create" });
                closeSidebarSurfaceCtx();
              }}
            >
              {formatMessage({ id: "layout.sidebar.newSectionMenu" })}
            </MenuItem>
          </div>
        </>,
        document.body,
      )}

      {/* Context menu — portal to body to escape sidebar transform containment */}
      {ctxMenu && createPortal(
        <>
          {/* Outside-click overlay. onClick (not onMouseDown) so the synthetic
              mousedown after a long-press touchend doesn't close it instantly.
              Same pattern as MessageItem context menu. */}
          <DismissBackdrop onDismiss={closeCtx} trapContextMenu />
          {/* Phantom-click shield for iOS PWA. See ctxMenuClickShielded. */}
          {ctxMenuClickShielded && (
            <DismissBackdrop onDismiss={closeCtx} zIndex={60} stopPropagation />
          )}
          <div
            ref={ctxMenuRef}
            className="fixed z-50 card-brutal max-h-[calc(100vh-16px)] w-48 overflow-y-auto select-none"
            style={getSidebarContextMenuStyle(ctxMenu)}
            onMouseDown={stopSidebarContextMenuPropagation}
            onTouchStart={stopSidebarContextMenuPropagation}
            onMouseOver={(event) => {
              const menuItem = (event.target as Element).closest('[role="menuitem"]');
              if (menuItem && !moveToSectionTriggerRef.current?.contains(menuItem)) {
                setMoveToSectionMenuOpen(false);
              }
            }}
            onFocus={(event) => {
              if (!moveToSectionTriggerRef.current?.contains(event.target)) {
                setMoveToSectionMenuOpen(false);
              }
            }}
          >
          {contextMovableItem && (
            <>
              <div ref={moveToSectionTriggerRef}>
                <MenuItem
                  icon={<FolderInput size={14} />}
                  aria-haspopup="menu"
                  aria-expanded={moveToSectionMenuOpen}
                  trailing={<ChevronRight size={14} />}
                  onMouseEnter={() => setMoveToSectionMenuOpen(true)}
                  onClick={() => setMoveToSectionMenuOpen(true)}
                >
                  {formatMessage({ id: "layout.sidebar.moveToSection" })}
                </MenuItem>
              </div>
              <ContextMenuDivider />
            </>
          )}
          {ctxMenu.type === "channel" && (() => {
            const channel = channels.find((c) => c.id === ctxMenu.id);
            const canToggleChannelMute = canToggleActivityMute(channel);
            // Stryker disable all: unsupported and stale rows are covered by DOM tests; mutating this narrowing enters an invalid undefined-channel click path that the React oracle cannot terminate.
            const activityMuteAction = canToggleChannelMute && channel ? (
              <MenuItem
                icon={channel.activityMuted === true ? <Bell size={14} /> : <BellOff size={14} />}
                onClick={() => {
                  void toggleChannelActivityMute(channel);
                  setCtxMenu(null);
                }}
              >
                {channel.activityMuted === true
                  ? formatMessage({ id: "layout.sidebar.unmute" })
                  : formatMessage({ id: "layout.sidebar.mute" })}
              </MenuItem>
            ) : null;
            // Stryker restore all
            const isProtected = channel?.name === "all";
            const hasUnread = (useMessageStore.getState().unreadCounts[ctxMenu.id] || 0) > 0;
            const isPinned = hasSidebarPinnedRef(pinnedRefs, { kind: "channel", id: ctxMenu.id });
            const archiveChannelName = channel?.name ?? "";
            // Stryker disable all: joint-channel archive suppression is pinned by a DOM context-menu test; generated JSX branch mutants time out under the command runner.
            const canArchiveChannel = !!channel
              && (channel.channelCapabilities?.archiveChannels ?? capabilities.archiveChannels)
              && !isProtected
              && channel.type !== "joint"
              && !channel.archivedAt;
            // Stryker restore all
            // Stryker disable all: pin behavior predates the Activity mute action and has separate coverage.
            const handleToggleContextPin = () => {
              togglePinChannel(ctxMenu.id);
              setCtxMenu(null);
            };
            // Stryker restore all
            return (
              <>
                {renderReadToggleAction(ctxMenu.id, hasUnread)}
                <ChannelPinMenuItem
                  isPinned={isPinned}
                  onToggle={handleToggleContextPin}
                  pinLabel={formatMessage({ id: "layout.sidebar.pin" })}
                  unpinLabel={formatMessage({ id: "layout.sidebar.unpin" })}
                />
                {activityMuteAction}
                {canArchiveChannel && (
                  // Stryker disable all: archive action is pre-existing context-menu behavior; this slice only changes pinned row wrapping and drag transform.
                  <>
                    <ContextMenuDivider />
                    <MenuItem
                      icon={<Archive size={14} />}
                      onClick={() => {
                        setArchiveConfirm({ id: ctxMenu.id, name: archiveChannelName });
                        setCtxMenu(null);
                      }}
                    >
                      {formatMessage({ id: "layout.sidebar.archive" })}
                    </MenuItem>
                  </>
                  // Stryker restore all
                )}
              </>
            );
          })()}

          {(() => {
            // Stryker disable all: human pin menu portal branch is covered by focused DOM/manual preview; generated portal mutants are equivalent to inaccessible menu states in this corpus.
            const humanMenu = ctxMenu.type === "human" ? (() => {
            // Resolve this menu's identity from the id it was opened with, not
            // from the member row. Every action below needs the DM entity and
            // that id; the member row is only where the id used to come from.
            // Keying on `members` meant a background refresh that evicts the
            // peer unmounted the whole open menu, detaching the item the user
            // was mid-click on — measured as the cause of the
            // removed-dm-menu-actions flake. A remaining DM may outlive the
            // membership row, so only its absence should close the menu.
            const humanDmChannel = dmChannels.find((dm) => dm.peerType === "user" && dm.peerId === ctxMenu.id);
            if (!humanDmChannel) return null;
            const hasUnread = (useMessageStore.getState().unreadCounts[humanDmChannel.id] || 0) > 0;
            const humanPinnedRef: SidebarPinnedRef = { kind: "human", id: ctxMenu.id };
            const isPinned = hasSidebarPinnedRef(pinnedRefs, humanPinnedRef);
            return (
              <>
                {renderReadToggleAction(humanDmChannel.id, hasUnread)}
                <MenuItem
                  icon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                  onClick={() => {
                    togglePinnedRef(humanPinnedRef);
                    setCtxMenu(null);
                  }}
                >
                  {isPinned ? formatMessage({ id: "layout.sidebar.unpin" }) : formatMessage({ id: "layout.sidebar.pin" })}
                </MenuItem>
                <ContextMenuDivider />
                <MenuItem
                  icon={<X size={14} />}
                  onClick={() => {
                    closeDm(humanDmChannel.id);
                    setCtxMenu(null);
                  }}
                >
                  {formatMessage({ id: "layout.sidebar.closeChat" })}
                </MenuItem>
              </>
            );
            })() : null;
            // Stryker restore all
            return humanMenu;
          })()}

          {(() => {
            // Stryker disable all: DM pin menu portal branch is covered by focused DOM/manual preview; generated portal mutants are equivalent to inaccessible menu states in this corpus.
            const directMessageMenu = ctxMenu.type === "dm" ? (() => {
            const dmChannel = dmChannels.find((dm) => dm.id === ctxMenu.id);
            if (!dmChannel) return null;
            const hasUnread = (useMessageStore.getState().unreadCounts[dmChannel.id] || 0) > 0;
            const dmPinnedRef = pinnedRefForDmChannel(dmChannel);
            const isPinned = dmPinnedRef ? hasSidebarPinnedRef(pinnedRefs, dmPinnedRef) : false;
            const dmMenu = (
              <>
                {renderReadToggleAction(dmChannel.id, hasUnread)}
                {dmPinnedRef && (
                  <MenuItem
                    icon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                    onClick={() => {
                      togglePinDm(dmChannel);
                      setCtxMenu(null);
                    }}
                  >
                    {isPinned ? formatMessage({ id: "layout.sidebar.unpin" }) : formatMessage({ id: "layout.sidebar.pin" })}
                  </MenuItem>
                )}
                <ContextMenuDivider />
                <MenuItem
                  icon={<X size={14} />}
                  onClick={() => {
                    closeDm(dmChannel.id);
                    setCtxMenu(null);
                  }}
                >
                  {formatMessage({ id: "layout.sidebar.closeChat" })}
                </MenuItem>
              </>
            );
            return dmMenu;
            })() : null;
            // Stryker restore all
            return directMessageMenu;
          })()}
          {/* Stryker restore all */}

          {ctxMenu.type === "member-human" && (() => {
            const human = members.find((m) => m.userId === ctxMenu.id);
            if (!human) return null;
            return (
              <MenuItem
                icon={<MessageSquare size={14} />}
                onClick={() => {
                  setCtxMenu(null);
                  void handleOpenHumanDm(human.userId);
                }}
              >
                {formatMessage({ id: "layout.sidebar.message" })}
              </MenuItem>
            );
          })()}

          {ctxMenu.type === "member-agent" && (() => {
            const agent = agents.find((a) => a.id === ctxMenu.id);
            if (!agent) return null;
            const isOnline = selectAgentDisplayState(useAgentStore.getState(), agent.id, agent).isOnline;
            const agentName = agent.displayName || agent.name;
            return (
              <>
                <MenuItem
                  icon={<MessageSquare size={14} />}
                  onClick={() => {
                    setCtxMenu(null);
                    void handleOpenAgentDm(agent.id);
                  }}
                >
                  {formatMessage({ id: "layout.sidebar.message" })}
                </MenuItem>
                {capabilities.controlAgentRuntime && (
                  <>
                    <ContextMenuDivider />
                    <MenuItem
                      icon={isOnline ? <Square size={14} /> : <Play size={14} />}
                      onClick={() => {
                        if (isOnline) {
                          setStopAgentConfirm({ id: agent.id, name: agentName });
                        } else {
                          void startAgent(agent.id);
                        }
                        setCtxMenu(null);
                      }}
                    >
                      {isOnline ? formatMessage({ id: "layout.sidebar.stop" }) : formatMessage({ id: "layout.sidebar.start" })}
                    </MenuItem>
                    <MenuItem
                      icon={<RotateCcw size={14} />}
                      onClick={() => {
                        setResetAgentTarget({ id: agent.id, name: agentName });
                        setCtxMenu(null);
                      }}
                    >
                      {formatMessage({ id: "layout.sidebar.restartReset" })}
                    </MenuItem>
                  </>
                )}
              </>
            );
          })()}

          {ctxMenu.type === "agent" && (() => {
            const agent = agents.find((a) => a.id === ctxMenu.id);
            if (!agent) return null;
            const dmChannelId = agentDmChannelId[agent.id];
            const hasUnread = dmChannelId ? (useMessageStore.getState().unreadCounts[dmChannelId] || 0) > 0 : false;
            const isPinned = pinnedAgentIds.includes(ctxMenu.id);
            return (
              <>
                {dmChannelId && renderReadToggleAction(dmChannelId, hasUnread)}
                <MenuItem
                  icon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                  onClick={() => {
                    togglePinAgent(ctxMenu.id);
                    setCtxMenu(null);
                  }}
                >
                  {isPinned ? formatMessage({ id: "layout.sidebar.unpin" }) : formatMessage({ id: "layout.sidebar.pin" })}
                </MenuItem>
                {dmChannelId && (
                  <>
                    <ContextMenuDivider />
                    <MenuItem
                      icon={<X size={14} />}
                      onClick={() => {
                        closeDm(dmChannelId);
                        setCtxMenu(null);
                      }}
                    >
                      {formatMessage({ id: "layout.sidebar.closeChat" })}
                    </MenuItem>
                  </>
                )}
              </>
            );
          })()}
          </div>
          {contextMovableItem && moveToSectionMenuOpen && (
            <div
              ref={setMoveToSectionMenuNode}
              role="menu"
              aria-label={formatMessage({ id: "layout.sidebar.moveToSection" })}
              className="fixed z-[51] card-brutal max-h-[calc(100vh-16px)] w-56 overflow-y-auto select-none"
              style={{
                left: moveToSectionMenuPosition?.x ?? 0,
                top: moveToSectionMenuPosition?.y ?? 0,
                visibility: moveToSectionMenuPosition ? "visible" : "hidden",
              }}
              onMouseDown={stopSidebarContextMenuPropagation}
              onTouchStart={stopSidebarContextMenuPropagation}
            >
              <MenuItem
                icon={<Pin size={14} />}
                disabled={contextItemPinned}
                trailing={contextItemPinned ? <Check size={14} /> : null}
                onClick={() => {
                  moveItemToPinned(contextMovableItem);
                  closeCtx();
                }}
              >
                {formatMessage({ id: "layout.sidebar.pinned" })}
              </MenuItem>
              {customSections.map((section) => (
                <MenuItem
                  key={section.id}
                  icon={<FolderInput size={14} />}
                  trailing={contextPlacement?.sectionId === section.id ? <Check size={14} /> : null}
                  onClick={() => {
                    moveItemToCustomSection(contextMovableItem, section.id);
                    closeCtx();
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1">
                    {section.emoji && <span aria-hidden>{section.emoji}</span>}
                    <span className="truncate">{section.name}</span>
                  </span>
                </MenuItem>
              ))}
              <ContextMenuDivider />
              <MenuItem
                icon={<FolderPlus size={14} />}
                onClick={() => {
                  setSectionDialog({ mode: "create", moveItem: contextMovableItem });
                  closeCtx();
                }}
              >
                {formatMessage({ id: "layout.sidebar.newSectionMenu" })}
              </MenuItem>
              {contextPlacement && (
                <MenuItem
                  icon={<X size={14} />}
                  onClick={() => {
                    removeItemFromCustomSection(contextMovableItem);
                    closeCtx();
                  }}
                >
                  {formatMessage({ id: "layout.sidebar.removeFromSection" })}
                </MenuItem>
              )}
            </div>
          )}
        </>,
        document.body
      )}
    </>
  );
}
