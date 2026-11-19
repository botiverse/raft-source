import { useCallback, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useIntl } from "react-intl";
import { ArrowRightToLine, ArrowUpRight, ChevronDown, CopyPlus, CopyX, Globe, Laptop, Link, Pin, PinOff, Plus, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PanelAction,
  Spinner,
  Tabs,
  TabsLabel,
  TabsList,
  TabsTab,
} from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { MediaInUseIcon } from "./BrowserSiteSettings";
import { mediaMessageId, NO_MEDIA } from "./browserSitePermissions";
import { PINNED_TAB_WIDTH, splitBrowserTabs, TAB_MIN_WIDTH } from "./browserHeadFit";
import { BROWSER_MAX_TABS, browserTabLabel, canPinBrowserTab, isLocalAddress, useBrowserTabsStore } from "./browserTabsStore";
import type { BrowserTab } from "./browserTabsStore";
import { openWebPreviewInNewTab } from "./webPreviewStore";

/**
 * The built-in browser's tab strip (the side-window prototype's "Browser +
 * Artifact" row; the switch chip's mock is its picture): the tabs (raft-ui
 * Tabs, the one in front selected), More tabs where they don't all fit, then
 * New tab.
 *
 * - A tab shows a laptop for a page on this computer or the local network,
 *   else a globe (no favicon: the app does not load an image a page names),
 *   then the page's title, else its host. The tabs behind narrow down to
 *   TAB_MIN_WIDTH before any goes under More tabs; the one in front keeps its
 *   title (168px at most). While its page loads, the icon's place holds
 *   raft-ui's Spinner (the tab is `aria-busy`); the title and the × stay.
 * - Anatomy: every tab is [icon][title][close], the × at the trailing edge
 *   in every state (in front, behind, empty, loading); a tab behind shows it
 *   under the pointer, in that same place. Also Delete or Backspace on the
 *   focused tab, and a middle click. raft-ui's Tabs has no closable tab, so the ×
 *   is a small button laid over the tab (a sibling, not nested in it).
 * - Keys: the row is a tab list (Base UI): arrow keys, Home and End move the
 *   focus, Enter or Space brings the focused tab to the front.
 * - Order: drag a tab along the row to move it (dnd-kit's sortable, as the
 *   rail's tabs: a drag starts past 6px, so a click still selects); from the
 *   keyboard, Ctrl/Cmd+Shift+PageUp / PageDown (or ← / →) moves the focused
 *   tab one place, a browser's own keys. Space stays the tab's own key.
 * - Pinned tabs (#proj-workspace:#297) lead the row: the icon alone
 *   (PINNED_TAB_WIDTH; the title is the tooltip and the accessible name), no
 *   × (Close is in the menu and on Delete, as a browser's), and they move
 *   among themselves only, as the others do among theirs (two sortable
 *   groups in the one row).
 * - A tab's menu (right-click; the context-menu key or Shift+F10 on the
 *   focused tab, the browser's own `contextmenu`): raft-ui's ContextMenu,
 *   TabMenuItems. A tab under More tabs has none: brought to the row, it has.
 * - The speaker (#proj-workspace:#299, as Chrome's): a tab whose page plays
 *   sound, or that the person muted, shows a speaker before its ×; a click
 *   mutes or unmutes it (crossed out while muted). As the ×, it is a small
 *   button laid over the tab, the pointer's way; the menu's Mute tab /
 *   Unmute tab is the keyboard's, and a pinned tab's (its speaker takes the
 *   icon's place). Only on a shell that can mute a tab (`setMuted`).
 */
const DND_MODIFIERS = [restrictToHorizontalAxis, restrictToParentElement];
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
type DragId = { id: unknown };

function TabClose({ label, active, onClose }: { label: string; active: boolean; onClose: () => void }) {
  const close = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    onClose();
  }, [onClose]);
  return (
    <button
      type="button"
      // The tab's own key closes it (Delete); this is the pointer's way.
      tabIndex={-1}
      aria-label={label}
      onClick={close}
      // One place in every state (#proj-workspace:#296): the trailing edge. A tab behind shows it under the pointer.
      className={`z-raised mr-1.5 flex size-5 cursor-pointer items-center justify-center justify-self-end rounded-sticker border-0 bg-transparent p-0 hover:bg-fill-medium ${active ? "text-sticker-ink" : "invisible text-foreground-muted group-hover/tab:visible"}`}
      data-testid="web-preview-tab-close"
    >
      <X className="size-3.5" aria-hidden />
    </button>
  );
}

function TabMute({ label, muted, active, onToggle }: { label: string; muted: boolean; active: boolean; onToggle: () => void }) {
  const toggle = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    onToggle();
  }, [onToggle]);
  const Icon = muted ? VolumeX : Volume2;
  return (
    <button
      type="button"
      // The menu's Mute tab is the keyboard's way; this is the pointer's.
      tabIndex={-1}
      aria-label={label}
      onClick={toggle}
      // Just before the × (its 20px and 6px from the edge), in every state: the tab says it plays whether in front or not.
      className={`z-raised mr-7 flex size-5 cursor-pointer items-center justify-center justify-self-end rounded-sticker border-0 bg-transparent p-0 hover:bg-fill-medium ${active ? "text-sticker-ink" : "text-foreground-muted"}`}
      data-testid="web-preview-tab-mute"
      data-muted={muted ? "" : undefined}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}

/** What the tab's menu acts with: the strip's own actions, and what each item needs to know to be offered. */
interface TabMenu {
  /** The shell has pinned tabs and the menu's intents (`list.pins`): without it only what any shell can do shows. */
  pins: boolean;
  /** Another tab fits in the strip. */
  room: boolean;
  /** One more tab can be pinned (canPinBrowserTab). */
  canPin: boolean;
  /** The ids of the conversation's own tabs, in order: what Close others and Close tabs to the right act on. */
  own: readonly string[];
  onReload: (tabId: string) => void;
  onDuplicate: (tabId: string) => void;
  onPin: (tabId: string, pinned: boolean) => void;
  onClose: (tabId: string, byKey: boolean) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
  /** Mute or unmute the tab (the speaker on it); null: the shell cannot (no speaker, no menu item). */
  onMute: ((tabId: string, muted: boolean) => void) | null;
}

/**
 * The tab's menu: Reload, Duplicate, Pin tab / Unpin tab, Open in browser, Copy link address; then Close, Close
 * other tabs, Close tabs to the right. An item that would do nothing is disabled: the page actions on an empty tab,
 * Duplicate at the cap, Pin tab where the cap refuses it, Close other tabs with no other own tab, Close tabs to the
 * right with none after it. The last two never close a pinned tab.
 */
function TabMenuItems({ tab, menu }: { tab: BrowserTab; menu: TabMenu }) {
  const { formatMessage } = useIntl();
  const { id, url } = tab;
  const pinned = tab.pinned === true;
  const empty = url === null;
  const others = menu.own.filter((each) => each !== id).length;
  const after = pinned ? menu.own.length : menu.own.length - 1 - menu.own.indexOf(id);
  const reload = useCallback(() => menu.onReload(id), [id, menu]);
  const duplicate = useCallback(() => menu.onDuplicate(id), [id, menu]);
  const pin = useCallback(() => menu.onPin(id, !pinned), [id, menu, pinned]);
  const openInBrowser = useCallback(() => {
    if (url) openWebPreviewInNewTab(url);
  }, [url]);
  const copyLink = useCallback(() => {
    if (url) void copyTextToClipboard(url).catch(() => {});
  }, [url]);
  const close = useCallback(() => menu.onClose(id, false), [id, menu]);
  const closeOthers = useCallback(() => menu.onCloseOthers(id), [id, menu]);
  const closeRight = useCallback(() => menu.onCloseRight(id), [id, menu]);
  const muted = tab.muted === true;
  const mute = useCallback(() => menu.onMute?.(id, !muted), [id, menu, muted]);
  return (
    <>
      <ContextMenuItem onClick={reload} disabled={empty} data-testid="web-preview-tab-menu-reload">
        <RefreshCw aria-hidden />
        <span>{formatMessage({ id: "webPreview.tabMenu.reload" })}</span>
      </ContextMenuItem>
      {menu.pins ? (
        <>
          <ContextMenuItem onClick={duplicate} disabled={empty || !menu.room} data-testid="web-preview-tab-menu-duplicate">
            <CopyPlus aria-hidden />
            <span>{formatMessage({ id: "webPreview.tabMenu.duplicate" })}</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={pin} disabled={!pinned && !menu.canPin} data-testid="web-preview-tab-menu-pin">
            {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            <span>{formatMessage({ id: pinned ? "webPreview.tabMenu.unpin" : "webPreview.tabMenu.pin" })}</span>
          </ContextMenuItem>
        </>
      ) : null}
      {menu.onMute && !empty ? (
        <ContextMenuItem onClick={mute} data-testid="web-preview-tab-menu-mute">
          {muted ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
          <span>{formatMessage({ id: muted ? "webPreview.tabMenu.unmute" : "webPreview.tabMenu.mute" })}</span>
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onClick={openInBrowser} disabled={empty} data-testid="web-preview-tab-menu-open">
        <ArrowUpRight aria-hidden />
        <span>{formatMessage({ id: "webPreview.openInBrowser" })}</span>
      </ContextMenuItem>
      <ContextMenuItem onClick={copyLink} disabled={empty} data-testid="web-preview-tab-menu-copy">
        <Link aria-hidden />
        <span>{formatMessage({ id: "webPreview.tabMenu.copyLink" })}</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={close} data-testid="web-preview-tab-menu-close">
        <X aria-hidden />
        <span>{formatMessage({ id: "webPreview.close" })}</span>
      </ContextMenuItem>
      {menu.pins ? (
        <>
          <ContextMenuItem onClick={closeOthers} disabled={others === 0} data-testid="web-preview-tab-menu-close-others">
            <CopyX aria-hidden />
            <span>{formatMessage({ id: "webPreview.tabMenu.closeOthers" })}</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={closeRight} disabled={after === 0} data-testid="web-preview-tab-menu-close-right">
            <ArrowRightToLine aria-hidden />
            <span>{formatMessage({ id: "webPreview.tabMenu.closeRight" })}</span>
          </ContextMenuItem>
        </>
      ) : null}
    </>
  );
}

function StripTab({ tab, active, menu, onMove, measure }: { tab: BrowserTab; active: boolean; menu: TabMenu; onMove: (tabId: string, to: "left" | "right") => void; measure?: (element: HTMLElement | null) => void }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: tab.id });
  const slotRef = useCallback((element: HTMLElement | null) => {
    setNodeRef(element);
    measure?.(element);
  }, [measure, setNodeRef]);
  const { formatMessage } = useIntl();
  const label = browserTabLabel(tab) ?? formatMessage({ id: "webPreview.newTab" });
  const pinned = tab.pinned === true;
  const Icon = isLocalAddress(tab.url) ? Laptop : Globe;
  const media = tab.media ?? NO_MEDIA;
  const inUse = media.length > 0;
  const muted = tab.muted === true;
  // The speaker: the page plays sound, or the person muted it (crossed out, as Chrome's, until unmuted).
  const speaker = menu.onMute !== null && tab.url !== null && (tab.audible === true || muted);
  const Speaker = muted ? VolumeX : Volume2;
  const onMute = menu.onMute;
  const toggleMute = useCallback(() => onMute?.(tab.id, !muted), [muted, onMute, tab.id]);
  const onClose = menu.onClose;
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const move = (event.ctrlKey || event.metaKey) && event.shiftKey
      ? (event.key === "PageUp" || event.key === "ArrowLeft" ? "left" : event.key === "PageDown" || event.key === "ArrowRight" ? "right" : null)
      : null;
    if (move) {
      event.preventDefault();
      event.stopPropagation();
      onMove(tab.id, move);
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    onClose(tab.id, true);
  }, [onClose, onMove, tab.id]);
  const handleAuxClick = useCallback((event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose(tab.id, false);
  }, [onClose, tab.id]);
  const close = useCallback(() => onClose(tab.id, false), [onClose, tab.id]);
  const slotStyle = pinned
    ? { width: PINNED_TAB_WIDTH, transform: CSS.Translate.toString(transform), transition }
    : { ...(active ? { flexShrink: 0 } : { minWidth: TAB_MIN_WIDTH }), transform: CSS.Translate.toString(transform), transition };
  const tabNode = (
    <TabsTab
      value={tab.id}
      // A pinned tab shows no title: its tooltip and its name say it. Any other keeps its address as the hint.
      title={pinned ? undefined : tab.url ?? undefined}
      aria-label={pinned ? formatMessage({ id: "webPreview.pinnedTab" }, { title: label }) : undefined}
      aria-keyshortcuts="Delete Control+Shift+PageUp Control+Shift+PageDown Shift+F10"
      aria-busy={tab.loading || undefined}
      onKeyDown={handleKeyDown}
      onAuxClick={handleAuxClick}
      className={pinned
        ? "w-full min-w-0 shrink justify-center px-0"
        : `w-full min-w-0 shrink justify-start px-2.5 ${speaker ? "pr-12" : "pr-7"} *:data-[slot=tabs-tab-content]:min-w-0 *:data-[slot=tabs-tab-content]:flex-1`}
      data-testid="web-preview-tab"
      data-pinned={pinned ? "" : undefined}
    >
      {tab.loading ? <Spinner size="xs" aria-hidden="true" data-testid="web-preview-tab-loading" /> : pinned && (inUse || speaker) ? null : <Icon aria-hidden />}
      {/* A pinned tab has room for one icon: its speaker takes the page's icon's place (its menu mutes it). */}
      {pinned && speaker && !inUse && !tab.loading ? (
        <span role="img" aria-label={formatMessage({ id: muted ? "webPreview.tabMuted" : "webPreview.tabAudible" })} className="flex shrink-0" data-testid="web-preview-tab-speaker">
          <Speaker aria-hidden />
        </span>
      ) : null}
      {pinned ? null : <TabsLabel className="block min-w-0 truncate" data-testid="web-preview-tab-label">{label}</TabsLabel>}
      {/* The page uses the microphone or the camera (the shell gave it one): said on its tab, as a recording light. */}
      {inUse ? (
        <span role="img" aria-label={formatMessage({ id: mediaMessageId("webPreview.siteSettings.inUse", media) })} className="flex shrink-0" data-testid="web-preview-tab-media">
          <MediaInUseIcon media={media} className="text-danger-strong" />
        </span>
      ) : null}
    </TabsTab>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={(
          <span
            ref={slotRef}
            className={`group/tab grid items-center *:col-start-1 *:row-start-1 ${pinned ? "flex-none" : "max-w-[168px] flex-[0_1_auto]"} ${isDragging ? "z-raised" : ""}`}
            style={slotStyle}
            {...listeners}
            data-testid="web-preview-tab-slot"
            data-tab-id={tab.id}
          />
        )}
      >
        {pinned ? <Tooltip content={label}>{tabNode}</Tooltip> : tabNode}
        {!pinned && speaker ? <TabMute label={formatMessage({ id: muted ? "webPreview.unmuteTab" : "webPreview.muteTab" }, { title: label })} muted={muted} active={active} onToggle={toggleMute} /> : null}
        {pinned ? null : <TabClose label={formatMessage({ id: "webPreview.closeTab" }, { title: label })} active={active} onClose={close} />}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={label} data-testid="web-preview-tab-menu">
        <TabMenuItems tab={tab} menu={menu} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A tab the row has no room for, in More tabs: picking it brings it to the front (and into the row). */
function MoreTab({ tab, onSelect }: { tab: BrowserTab; onSelect: (tabId: string) => void }) {
  const { formatMessage } = useIntl();
  const Icon = isLocalAddress(tab.url) ? Laptop : Globe;
  const pick = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
  return (
    <DropdownMenuItem onClick={pick} title={tab.url ?? undefined} data-testid="web-preview-more-tab">
      <Icon aria-hidden />
      <span className="max-w-[240px] min-w-0 truncate">{browserTabLabel(tab) ?? formatMessage({ id: "webPreview.newTab" })}</span>
    </DropdownMenuItem>
  );
}

export function BrowserTabStrip({ bridge, conversationId, tabs, activeId, tabsShown, measureFront }: {
  bridge: DesktopWebPreviewTabsBridge;
  conversationId: string;
  tabs: readonly BrowserTab[];
  activeId: string;
  /** How many tabs the row has room for (browserHeadFit); the rest go under More tabs. */
  tabsShown: number;
  /** Measures the tab in front, for the fit. */
  measureFront: (element: HTMLElement | null) => void;
}) {
  const { formatMessage } = useIntl();
  const activate = useBrowserTabsStore((s) => s.activate);
  const closeTab = useBrowserTabsStore((s) => s.closeTab);
  const newTab = useBrowserTabsStore((s) => s.newTab);
  const moveTab = useBrowserTabsStore((s) => s.moveTab);
  const pinTab = useBrowserTabsStore((s) => s.pinTab);
  const unpinTab = useBrowserTabsStore((s) => s.unpinTab);
  const duplicateTab = useBrowserTabsStore((s) => s.duplicateTab);
  const closeOtherTabs = useBrowserTabsStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useBrowserTabsStore((s) => s.closeTabsToRight);
  const canPin = useBrowserTabsStore((s) => canPinBrowserTab(s, conversationId));
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const move = useCallback((tabId: string, to: string) => moveTab(conversationId, tabId, to), [conversationId, moveTab]);
  // A drag is read out in the rail tabs' own words (the same gesture, already in every locale). The keyboard's
  // move has no announcement of its own: the focus stays on the tab it moved.
  const accessibility = useMemo(() => {
    const nameOf = (id: unknown) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      return (tab && browserTabLabel(tab)) ?? formatMessage({ id: "webPreview.newTab" });
    };
    return {
      screenReaderInstructions: { draggable: "" },
      announcements: {
        onDragStart: ({ active }: { active: DragId }) => formatMessage({ id: "layout.leftRail.dragPickedUp" }, { name: nameOf(active.id) }),
        onDragOver: ({ active, over }: { active: DragId; over: DragId | null }) => (over
          ? formatMessage({ id: "layout.leftRail.dragOver" }, { name: nameOf(active.id), target: nameOf(over.id) })
          : formatMessage({ id: "layout.leftRail.dragNotOver" }, { name: nameOf(active.id) })),
        onDragEnd: ({ active, over }: { active: DragId; over: DragId | null }) => (over
          ? formatMessage({ id: "layout.leftRail.dragDroppedAt" }, { name: nameOf(active.id), target: nameOf(over.id) })
          : formatMessage({ id: "layout.leftRail.dragDropped" }, { name: nameOf(active.id) })),
        onDragCancel: ({ active }: { active: DragId }) => formatMessage({ id: "layout.leftRail.dragCancelled" }, { name: nameOf(active.id) }),
      },
    };
  }, [formatMessage, tabs]);
  const onDragEnd = useCallback((event: DragEndEvent) => {
    if (event.over && event.active.id !== event.over.id) move(String(event.active.id), String(event.over.id));
  }, [move]);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // A tab closed by its key took the focus with it: the tab now in front takes it.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"] [role="tab"]`)?.focus();
  }, [activeId, tabs.length]);
  const close = useCallback((tabId: string, byKey: boolean) => {
    refocus.current = byKey;
    closeTab(conversationId, tabId);
  }, [closeTab, conversationId]);
  const select = useCallback((tabId: string) => activate(conversationId, tabId), [activate, conversationId]);
  const add = useCallback(() => newTab(conversationId), [conversationId, newTab]);
  const { row, more } = splitBrowserTabs(tabs, activeId, tabsShown);
  // Two groups in the one row: a tab is sorted among its own kind, so none crosses the line between them.
  const pinnedRow = useMemo(() => row.filter((tab) => tab.pinned), [row]);
  const ownRow = useMemo(() => row.filter((tab) => !tab.pinned), [row]);
  const pinnedIds = useMemo(() => pinnedRow.map((tab) => tab.id), [pinnedRow]);
  const ownIds = useMemo(() => ownRow.map((tab) => tab.id), [ownRow]);
  const full = tabs.length >= BROWSER_MAX_TABS;
  const pins = bridge.list?.pins === true;
  const menu = useMemo<TabMenu>(() => ({
    pins,
    room: !full,
    canPin,
    own: tabs.filter((tab) => !tab.pinned).map((tab) => tab.id),
    onReload: (tabId) => bridge.reload(tabId),
    onDuplicate: (tabId) => duplicateTab(conversationId, tabId),
    onPin: (tabId, pinned) => (pinned ? pinTab : unpinTab)(conversationId, tabId),
    onClose: close,
    onCloseOthers: (tabId) => closeOtherTabs(conversationId, tabId),
    onCloseRight: (tabId) => closeTabsToRight(conversationId, tabId),
    onMute: bridge.setMuted ? (tabId, muted) => bridge.setMuted?.(tabId, muted) : null,
  }), [bridge, canPin, close, closeOtherTabs, closeTabsToRight, conversationId, duplicateTab, full, pinTab, pins, tabs, unpinTab]);
  const stripTab = (tab: BrowserTab) => (
    <StripTab key={tab.id} tab={tab} active={tab.id === activeId} menu={menu} onMove={move} measure={tab.id === activeId ? measureFront : undefined} />
  );
  const moreLabel = formatMessage({ id: "webPreview.moreTabs" });
  const newLabel = formatMessage({ id: "webPreview.newTab" });
  return (
    <div ref={stripRef} className="flex min-w-0 flex-[0_1_auto] items-center gap-1" data-testid="web-preview-tab-strip">
      <Tabs<string> value={activeId} onValueChange={select} className="w-auto min-w-0 flex-[0_1_auto]" data-testid="web-preview-tabs">
        <TabsList aria-label={formatMessage({ id: "webPreview.tabs" })} className="w-full overflow-hidden">
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={DND_MODIFIERS} accessibility={accessibility} onDragEnd={onDragEnd}>
            <SortableContext items={pinnedIds} strategy={horizontalListSortingStrategy}>
              {pinnedRow.map(stripTab)}
            </SortableContext>
            <SortableContext items={ownIds} strategy={horizontalListSortingStrategy}>
              {ownRow.map(stripTab)}
            </SortableContext>
          </DndContext>
        </TabsList>
      </Tabs>
      {more.length > 0 ? (
        <DropdownMenu>
          <Tooltip content={moreLabel}>
            <DropdownMenuTrigger render={(
              <PanelAction aria-label={moreLabel} data-testid="web-preview-more-tabs">
                <ChevronDown />
              </PanelAction>
            )} />
          </Tooltip>
          <DropdownMenuContent side="bottom" align="start" data-testid="web-preview-more-tabs-list">
            {more.map((tab) => <MoreTab key={tab.id} tab={tab} onSelect={select} />)}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* At the cap it stays focusable, so its tooltip can say why it does nothing. */}
      <Tooltip content={full ? formatMessage({ id: "webPreview.tabLimit" }, { count: BROWSER_MAX_TABS }) : newLabel}>
        <PanelAction
          aria-label={newLabel}
          onClick={add}
          disabled={full}
          focusableWhenDisabled
          className="data-disabled:cursor-default data-disabled:text-foreground-disabled data-disabled:hover:bg-transparent data-disabled:active:bg-transparent"
          data-testid="web-preview-new-tab"
        >
          <Plus />
        </PanelAction>
      </Tooltip>
    </div>
  );
}
