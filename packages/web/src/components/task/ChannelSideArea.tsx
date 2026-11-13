import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { ListTodo, Paperclip, ScanText, Settings, UserRound } from "lucide-react";
import { create } from "zustand";
import { Tabs, TabsLabel, TabsList, TabsTab } from "@botiverse/raft-ui";
import type { ChannelSideLayout, ChannelSideSection } from "@botiverse/raft-shared";
import { CHANNEL_SIDE_SECTION_MIN_WIDTH, channelSideColumnMinWidth, channelSideSectionWidth, visibleChannelSideColumns } from "@botiverse/raft-shared";

import ColumnResizeHandle from "../ui/ColumnResizeHandle";
import { useRowLayout, useRowPlan } from "../layout/rowLayout";
import { stackExpanded, useColumnAfter, useRowPlanStore } from "../layout/rowPlanStore";
import { RowRegionChrome } from "../layout/RowRegionChrome";
import { sideColumnKey, withShortcutHelpColumn, withTasksPageTaskColumn } from "../layout/rowPlan";
import type { PlanColumn } from "../layout/rowPlan";
import type { ColumnWidthSource, MainColumnLookup } from "../ui/ColumnResizeHandle";
import { useChannelSideLayoutStore } from "../../store/channelSideLayoutStore";
import { COLUMN_BOUNDS } from "../../lib/panelBounds";
import { useChannelSideCardStore } from "../../store/channelSideCardStore";
import { resetColumnWidth, useColumnWidth } from "../../store/columnWidthStore";
import { useThreadStore } from "../../store/threadStore";
import { useShortcutHelpStore } from "../../features/keyboard-shortcuts/shortcutHelpStore";
import type { ChannelSideCard } from "../../store/channelSideCardStore";
import { trackChannelTabSelected } from "../../analytics/entries";
import { activeSideCard, ROW_SELECTOR, rowRoom, SIDE_CARDS_FLOAT_COMPOSER_GAP, SIDE_CARDS_FLOAT_MESSAGES_MIN_WIDTH, SIDE_CARDS_MIN_WIDTH, SideCardContext, sideCardsColumnHeight, sideCardsOneAtATime } from "./sideCardsLayout";
import type { SideCardState, SideCardsMode } from "./sideCardsLayout";
import type { SideStackShares } from "./sideSectionDrag";
import { cancelSideDrag, headHeight, SideDragLayer, useSideDrag } from "./sideSectionDrag";
import { stackEndOf, useMarkStackEnd } from "./stackEnd";
import { useSideHighlight, useStackCorner } from "./stackCornerDrag";
import { StackCorners } from "./StackCorner";
import { moveNodeInto } from "../ui/moveNode";
import { focusLost } from "../../utils/focusGuard";

/**
 * The Thread, Tasks and Files sections right of a channel (task v2, task
 * #165), laid out by the person's section layout (`channelSideLayoutStore`):
 * columns of stacked sections, left to right after the channel.
 *
 * Tasks and Files are rendered by the channel panel (`SideSectionPortal`)
 * into elements this area moves into their place, so moving a section never
 * remounts it. The thread stays MainLayout's thread column; that column reads
 * the same placement (`useThreadColumnSide`) for its place among the others
 * and for the sections stacked with the thread in it.
 *
 * On a desktop every column stands in the row, and the row is planned by the
 * #189 rules (#proj-raft-ui:#189, the design lead's prototype; rowPlan,
 * rowLayout): the columns give way in proportion, then the thread folds into
 * the conversation's column, over the chat, with Back at its head's start
 * (rule 3: `covers`; it leaves its column, which stays for the sections
 * stacked with it), then everything clips down to 160, then the rightmost
 * columns become tabs. Nothing floats. On a phone (or a panel too narrow for
 * that) the sections cover the channel panel, one at a time under a switch,
 * with Back (`overlay`), or float over its messages (`float`).
 */

/**
 * A section of the area: the layout's, the Thread, Tasks, Files, the workspace
 * Artifact open in this channel (F41) and the profile (MainLayout's
 * ProfilePanel): every one of them moves among the columns (#189 rule 7).
 */
type AreaSection = ChannelSideSection;
type PortalSection = Exclude<AreaSection, "thread">;
/** Each section's content minimum (#189 rule 2): narrower, its column clips it. The Artifact's is its 480 (rule 4 counts it). */
const SECTION_CONTENT_MIN: Record<AreaSection, number> = {
  thread: COLUMN_BOUNDS.thread.contentMin,
  tasks: COLUMN_BOUNDS.sideCards.contentMin,
  files: COLUMN_BOUNDS.sideCards.contentMin,
  artifact: CHANNEL_SIDE_SECTION_MIN_WIDTH.artifact,
  profile: COLUMN_BOUNDS.detail.contentMin,
  context: CHANNEL_SIDE_SECTION_MIN_WIDTH.context,
  details: CHANNEL_SIDE_SECTION_MIN_WIDTH.details,
};

// ---------------------------------------------------------------- shared state

/** What the open Artifact tells the area about itself (its viewer is rendered by its own portal). */
export interface SideAreaArtifact {
  /** Its tab where only one section shows at a time. */
  icon: ReactNode;
  /** When it was opened: the section opened or picked last shows where only one fits. */
  openedAt: number;
  /** The width it wants beside the messages (480): given only where no other column gives way for it. */
  minWidth: number;
  /** Covers the whole channel panel under its header. */
  expanded: boolean;
}

interface SectionEntry {
  host: HTMLElement;
  title: string;
  /** The Artifact's own facts (only its entry has them). */
  artifact?: SideAreaArtifact;
}

/** The Artifact's place, for its viewer: as the other sections', or expanded over the panel. */
export interface SideArtifactPlace {
  mode: SideCardsMode | "expanded";
  /** Expanding means something only where it doesn't already cover the panel. */
  canExpand: boolean;
  /** On screen, not behind another section's tab. */
  shown: boolean;
}

export interface SideRoom {
  /** The row's width less its columns other than the channel and the sections (rowRoom); null outside a row. */
  room: number | null;
  viewportWidth: number;
  panelWidth: number;
  panelHeight: number;
  composerHeight: number;
  /** A thread column stands in the row beside the channel (not covering it). */
  threadInRow: boolean;
  /**
   * The thread's column's width on screen, unrounded as `room` is (0 out of the row, or where the
   * channel is hidden): it gives way to the other columns down to its minimum.
   */
  threadWidth: number;
  /** The thread is in Focus Mode, covering the row. */
  threadMaximized: boolean;
  /** The thread covers the row by the row's own width (index.css: a row under 720px, or a portrait window under 1280px). */
  threadCoversRow: boolean;
  /** The row's whole width: the room the plan shares out (#189). */
  rowWidth: number;
  /** A thread column is open in the row, standing in it or folded over the conversation. */
  threadOpen: boolean;
  /** A legacy task panel is in the row: the plan doesn't lay out a row it doesn't know. */
  legacyTask: boolean;
  /** A touch tablet in portrait under 1280px (responsive.md: the thread alone there, as on an iPad mini). */
  touchPortrait: boolean;
}

export interface PlacedColumn {
  /** The column's index in the layout. */
  column: number;
  sections: PortalSection[];
  width: number;
  minWidth: number;
}

/** A column's narrowest readable width: its widest section's content minimum (the Artifact's 480 counts, #189). */
const areaColumnMinWidth = (sections: readonly AreaSection[]) => channelSideColumnMinWidth(sections);

export interface SidePlacement {
  /** Columns standing in the row, left to right (the thread's is MainLayout's and not among them). */
  row: PlacedColumn[];
  /** Sections stacked with the thread in its column, above and below it. */
  companions: { before: PortalSection[]; after: PortalSection[] };
  /** The thread's column's layout index, or null when the thread isn't standing in the row. */
  threadColumn: number | null;
  /** Sections in the floating or covering surface, top to bottom, and which of the two it is. */
  floating: PortalSection[];
  floatMode: Exclude<SideCardsMode, "beside">;
  /**
   * The Artifact is expanded: it takes the whole row as the thread's Focus Mode does (the row's
   * `data-artifact-expanded`, index.css); the other columns keep their places and widths, hidden.
   */
  artifactExpanded: boolean;
  /**
   * The thread is folded into the conversation's column, over the chat (#189 rule 3; rowPlan): it leaves its
   * column (the sections stacked with it stand there without it) and has Back at its head's start.
   */
  covers: boolean;
}

const NO_PLAN_COLUMNS: PlanColumn[] = [];

const NO_PLACEMENT: SidePlacement = { row: [], companions: { before: [], after: [] }, threadColumn: null, floating: [], floatMode: "float", artifactExpanded: false, covers: false };

interface SideSectionsState {
  entries: Partial<Record<PortalSection, SectionEntry>>;
  /** Where each open section stands, as the area last placed it. */
  states: Partial<Record<PortalSection, Omit<SideCardState, "card">>>;
  placement: SidePlacement;
  /** The channel panel's slot for floating and covering sections (ChannelSideFloatSlot). */
  floatSlot: HTMLElement | null;
  /** The element each placed section's content goes into. */
  containers: Partial<Record<PortalSection, HTMLElement>>;
  /** Each section's host once the area has put it in the document: its content renders only then (a composite mounted detached keeps no Tab stop). */
  attached: Partial<Record<PortalSection, HTMLElement>>;
  register: (section: PortalSection, entry: SectionEntry) => void;
  unregister: (section: PortalSection, host: HTMLElement) => void;
}

export const useSideSections = create<SideSectionsState>((set, get) => ({
  entries: {},
  states: {},
  placement: NO_PLACEMENT,
  floatSlot: null,
  containers: {},
  attached: {},
  register: (section, entry) => {
    const current = get().entries[section];
    if (current?.host === entry.host && current.title === entry.title && current.artifact === entry.artifact) return;
    set({ entries: { ...get().entries, [section]: entry } });
  },
  unregister: (section, host) => {
    if (get().entries[section]?.host !== host) return;
    const entries = { ...get().entries };
    delete entries[section];
    set({ entries, attached: Object.fromEntries(Object.entries(get().attached).filter(([key]) => key !== section)) });
  },
}));

/** Stable ref callbacks: a section's container registers itself. */
const containerRef = Object.fromEntries((["tasks", "files", "artifact", "profile", "context", "details"] as const).map((section) => (
  [section, (element: HTMLElement | null) => setContainer(section, element)]
))) as Record<PortalSection, (element: HTMLElement | null) => void>;

function setContainer(section: PortalSection, element: HTMLElement | null) {
  const containers = useSideSections.getState().containers;
  if (element) {
    if (containers[section] === element) return;
    useSideSections.setState({ containers: { ...containers, [section]: element } });
  } else if (containers[section]) {
    const next = { ...containers };
    delete next[section];
    useSideSections.setState({ containers: next });
  }
}

const THREAD_COLLAPSED_KEY = "slock:channelSideThreadCollapsed";

/** Whether the thread is folded to its head, where it shares its column. */
export const useThreadSectionStore = create<{ collapsed: boolean; setCollapsed: (collapsed: boolean) => void }>((set) => ({
  collapsed: (() => {
    try { return typeof window !== "undefined" && window.localStorage.getItem(THREAD_COLLAPSED_KEY) === "true"; } catch { return false; }
  })(),
  setCollapsed: (collapsed) => {
    try { window.localStorage.setItem(THREAD_COLLAPSED_KEY, String(collapsed)); } catch { /* the session keeps it */ }
    set({ collapsed });
  },
}));

const STANDALONE: Omit<SideCardState, "card"> = { mode: "beside", collapsible: false, collapsed: false, onCollapsedChange: () => {} };

/**
 * A section's content (Tasks, Files), rendered by its owner wherever it is
 * mounted, into an element the side area places. Open while mounted.
 */
export function SideSectionPortal({ section, title, children }: { section: Exclude<PortalSection, "artifact">; title: string; children: ReactNode }) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    element.dataset.sideSection = section;
    return element;
  });
  const register = useSideSections((s) => s.register);
  const unregister = useSideSections((s) => s.unregister);
  useLayoutEffect(() => {
    register(section, { host, title });
  }, [host, register, section, title]);
  useLayoutEffect(() => () => {
    unregister(section, host);
    host.remove();
  }, [host, section, unregister]);
  const placed = useSideSections((s) => s.states[section]);
  const value = useMemo<SideCardState>(() => ({ card: section, ...(placed ?? STANDALONE) }), [placed, section]);
  // Its content renders once the area has put the host in the document, never into a detached node.
  const attached = useSideSections((s) => s.attached[section] === host);
  if (!attached) return null;
  return createPortal(<SideCardContext.Provider value={value}>{children}</SideCardContext.Provider>, host);
}

/**
 * The workspace Artifact open in this channel (F41), as a temporary section:
 * rendered by the channel panel into an element the area places, so moving
 * between the row, the floating surface and expanded never remounts it.
 */
export function SideArtifactPortal({ title, artifact, render }: { title: string; artifact: SideAreaArtifact; render: (place: SideArtifactPlace) => ReactNode }) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    element.dataset.sideSection = "artifact";
    return element;
  });
  const register = useSideSections((s) => s.register);
  const unregister = useSideSections((s) => s.unregister);
  useLayoutEffect(() => {
    register("artifact", { host, title, artifact });
  }, [artifact, host, register, title]);
  useLayoutEffect(() => () => {
    unregister("artifact", host);
    host.remove();
  }, [host, unregister]);
  const placed = useSideSections((s) => s.states.artifact);
  const expanded = useSideSections((s) => s.placement.artifactExpanded);
  const mode: SideArtifactPlace["mode"] = expanded ? "expanded" : placed?.mode ?? "beside";
  const place = useMemo<SideArtifactPlace>(() => ({ mode, canExpand: mode !== "overlay", shown: expanded || placed?.shown !== false }), [expanded, mode, placed?.shown]);
  // Its content renders once the area has put the host in the document, never into a detached node.
  const attached = useSideSections((s) => s.attached.artifact === host);
  if (!attached) return null;
  // A section of the planned row (#189): its head's grip and tabs (RowRegionChrome).
  return createPortal(<RowRegionChrome region="artifact">{render(place)}</RowRegionChrome>, host);
}

/** The section on top where only one shows at a time: the one opened or picked last (the Artifact counts from its opening). */
export function activeAreaSection<Section extends PortalSection>(open: readonly Section[], cardFocusAt: Readonly<Record<string, number>>, artifactOpenedAt = 0): Section | null {
  return activeSideCard(open, { ...cardFocusAt, artifact: Math.max(cardFocusAt.app ?? 0, artifactOpenedAt) });
}

/** The float slots mounted, the latest last: the one on screen is the latest (the app shell's over a hidden channel's). */
const floatSlots: HTMLElement[] = [];

function publishFloatSlot() {
  const top = floatSlots.at(-1) ?? null;
  if (useSideSections.getState().floatSlot !== top) useSideSections.setState({ floatSlot: top });
}

/**
 * Where a panel lets columns float or cover it: the channel panel's body,
 * under its header; the app shell's main area while it shows an Artifact
 * (ShellArtifactHost). Unmounting one gives the area back the one before it.
 */
export function ChannelSideFloatSlot() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    floatSlots.push(element);
    publishFloatSlot();
    return () => {
      floatSlots.splice(floatSlots.indexOf(element), 1);
      publishFloatSlot();
    };
  }, [element]);
  return <div ref={setElement} className="contents" data-testid="channel-side-float-slot" />;
}

// ---------------------------------------------------------------- placement

interface VisibleColumn {
  column: number;
  sections: AreaSection[];
  width: number;
  minWidth: number;
}

/**
 * The plan's columns (rowLayout, #189): each column's regions and their content minimums, and its saved width; the
 * thread's column is as wide as the thread's own saved width (`thread`), and its layout width once the thread has
 * folded out of it, for the sections stacked with it.
 */
function planColumns(columns: readonly VisibleColumn[], thread: number): PlanColumn[] {
  return columns.map((column) => ({
    key: sideColumnKey(column.column),
    regions: column.sections,
    mins: column.sections.map((section) => SECTION_CONTENT_MIN[section]),
    saved: column.sections.includes("thread") ? thread : column.width,
    savedWithoutThread: column.width,
  }));
}

/**
 * Where the open sections stand. On a desktop every column stands in the
 * row (the plan gives each its width, #189: nothing floats); the thread's own
 * column is MainLayout's and keeps its place, with the sections stacked in it,
 * unless the plan folds the thread into the conversation's column (`fold`,
 * rule 3): the thread then takes no place among the columns, and the sections
 * stacked with it stand in its column without it. On a phone (no row, or a
 * viewport under 768px) everything covers the panel (`overlay`), or floats
 * over its messages where the panel is wide enough (`float`); there the open
 * Artifact may take the whole panel instead (`expandArtifact`; a desktop's
 * Expand is the row's, rule 5).
 */
export function placeSections(
  layout: ChannelSideLayout,
  open: ReadonlySet<ChannelSideSection>,
  room: Pick<SideRoom, "room" | "viewportWidth" | "panelWidth" | "threadInRow"> & Partial<Pick<SideRoom, "threadOpen">>,
  expandArtifact = false,
  fold = false,
): SidePlacement {
  const desktop = room.viewportWidth >= 768 && room.room !== null;
  const openHere = new Set(open);
  // Folded over the conversation (rule 3), or not open, the thread takes no place among the columns; on a phone it is a page of its own.
  if (!desktop ? !room.threadInRow : fold || !(room.threadOpen ?? room.threadInRow)) openHere.delete("thread");
  const floatPanel = SIDE_CARDS_MIN_WIDTH + SIDE_CARDS_FLOAT_MESSAGES_MIN_WIDTH;
  const phoneMode: SidePlacement["floatMode"] = room.viewportWidth >= 768 && room.panelWidth >= floatPanel ? "float" : "overlay";
  // Expanded over the panel on a phone only where it floats (a desktop's Expand is the row's, rule 5).
  const artifactExpanded = !desktop && expandArtifact && open.has("artifact") && phoneMode !== "overlay";
  if (artifactExpanded) openHere.delete("artifact");
  const visible: VisibleColumn[] = visibleChannelSideColumns(layout, openHere);
  const thread = visible.find((column) => column.sections.includes("thread"));
  const at = thread ? thread.sections.indexOf("thread") : -1;
  const companions = {
    before: (thread?.sections.slice(0, at) ?? []) as PortalSection[],
    after: (thread?.sections.slice(at + 1) ?? []) as PortalSection[],
  };
  const columns: PlacedColumn[] = visible.flatMap((column) => {
    if (column === thread) return [];
    const sections = column.sections.filter((s): s is PortalSection => s !== "thread");
    return sections.length > 0 ? [{ column: column.column, sections, width: column.width, minWidth: areaColumnMinWidth(sections) }] : [];
  });
  const common = { companions, threadColumn: thread?.column ?? null, artifactExpanded };
  if (!desktop) return { row: [], floating: columns.flatMap((c) => c.sections), floatMode: phoneMode, covers: false, ...common };
  return { row: columns, floating: [], floatMode: "float", covers: fold && open.has("thread"), ...common };
}

const MESSAGES_SELECTOR = '[data-testid="message-content-surface"]';

const TOUCH_PORTRAIT = "(pointer: coarse) and (orientation: portrait) and (max-width: 1279.98px)";

/** What the plan reads of the row (#189): its width, the thread and the profile open in it, a legacy panel, a portrait tablet. */
function measurePlan(row: HTMLElement | null) {
  const thread = row?.querySelector<HTMLElement>(":scope > .thread-side-column") ?? null;
  return {
    rowWidth: row ? row.getBoundingClientRect().width : 0,
    threadOpen: !!thread && getComputedStyle(thread).display !== "none",
    legacyTask: !!row?.querySelector(':scope > :is([data-testid="legacy-task-panel"], [data-legacy-task-panel-fallback])'),
    touchPortrait: typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(TOUCH_PORTRAIT).matches,
  };
}

function measureRoom(row: HTMLElement | null, panel: HTMLElement | null): SideRoom {
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const threadMaximized = row?.dataset.threadMaximized === "true";
  const plan = measurePlan(row);
  if (!panel) return { room: row ? rowRoom(row) : null, viewportWidth, panelWidth: 0, panelHeight: 0, composerHeight: 0, threadInRow: false, threadWidth: 0, threadMaximized, threadCoversRow: false, ...plan };
  const box = panel.getBoundingClientRect();
  const messages = panel.querySelector(MESSAGES_SELECTOR);
  const composerHeight = messages ? Math.max(0, Math.round(box.bottom - messages.getBoundingClientRect().bottom)) : 0;
  const thread = row?.querySelector<HTMLElement>(":scope > .thread-side-column") ?? null;
  const style = thread ? getComputedStyle(thread) : null;
  const threadShown = !!style && style.display !== "none";
  const threadInRow = threadShown && style.position !== "absolute";
  const room = row ? rowRoom(row) : box.width;
  // Where the channel is folded away (a profile beside the thread: rowRoom's 0) the thread fills the row: it gives
  // nothing. Covering it (index.css), the channel keeps its box, hidden under the thread, and the thread gives its width.
  const channel = row?.querySelector<HTMLElement>(":scope > .thread-main-column") ?? null;
  const channelFolded = !!channel && getComputedStyle(channel).display === "none";
  const threadWidth = threadInRow && thread && !channelFolded ? thread.getBoundingClientRect().width : 0;
  return { room, viewportWidth, panelWidth: box.width, panelHeight: box.height, composerHeight, threadInRow, threadWidth, threadMaximized, threadCoversRow: threadShown && !threadInRow, ...plan };
}

function sameRoom(a: SideRoom, b: SideRoom): boolean {
  return a.room === b.room && a.viewportWidth === b.viewportWidth && a.panelWidth === b.panelWidth && a.panelHeight === b.panelHeight
    && a.composerHeight === b.composerHeight && a.threadInRow === b.threadInRow && a.threadMaximized === b.threadMaximized
    && a.threadWidth === b.threadWidth && a.threadCoversRow === b.threadCoversRow && a.rowWidth === b.rowWidth && a.threadOpen === b.threadOpen
    && a.legacyTask === b.legacyTask && a.touchPortrait === b.touchPortrait;
}

/**
 * Watches the layout row (its own children coming and going, Focus Mode) and
 * the channel panel holding the float slot (its size, the composer growing).
 */
function useSideRoom(row: HTMLElement | null, floatSlot: HTMLElement | null): SideRoom {
  const [room, setRoom] = useState<SideRoom>(() => measureRoom(row, floatSlot?.parentElement ?? null));
  useLayoutEffect(() => {
    if (!row) return;
    const panel = floatSlot?.parentElement ?? null;
    const update = () => {
      const next = measureRoom(row, panel);
      setRoom((prev) => (sameRoom(prev, next) ? prev : next));
    };
    update();
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    const watchChildren = () => {
      for (const child of Array.from(row.children)) resize?.observe(child);
    };
    resize?.observe(row);
    watchChildren();
    if (panel) resize?.observe(panel);
    const messages = panel?.querySelector(MESSAGES_SELECTOR);
    if (messages) resize?.observe(messages);
    // Only the row's own children (a thread or profile opening) and its Focus Mode flag; never the message list.
    const mutations = typeof MutationObserver !== "undefined" ? new MutationObserver(() => { watchChildren(); update(); }) : null;
    // (A profile opening adds its wrapper to the row, its panel or fallback in it; a portrait tablet turning resizes the window.)
    mutations?.observe(row, { childList: true, attributes: true, attributeFilter: ["data-thread-maximized"] });
    window.addEventListener("resize", update);
    return () => {
      resize?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [floatSlot, row]);
  return room;
}

/**
 * In the row the columns' conversation is the channel column, not the nearest marked sibling (a wider thread), the
 * thread folded over it included (#189 rule 3: the two share its width).
 */
export const rowMainColumn: MainColumnLookup = (columnElement) => {
  const row = columnElement.closest<HTMLElement>(ROW_SELECTOR);
  return row?.querySelector<HTMLElement>(":scope > .thread-main-column") ?? null;
};

/** The thread's column's width back to its default (its resize handle's double click), with a corner's. */
const resetThreadWidth = () => resetColumnWidth("thread");

/** A column's flex order in the row: the channel is 0, a profile and the like 50 (index.css). */
export const columnOrder = (column: number) => 10 + column;

// ---------------------------------------------------------------- a stack's heights

const SPLITS_KEY = "slock:channelSideSplits";
const LEGACY_SPLIT_KEY = "slock:channelSideSplit";
const MIN_SECTION_HEIGHT = 160;
const SPLIT_KEYBOARD_STEP = 16;
const SPLIT_KEYBOARD_STEP_LARGE = 64;

function readSplits(): Record<string, number[]> {
  try {
    const raw = window.localStorage.getItem(SPLITS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const splits: Record<string, number[]> = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number[]>) : {};
    // The two cards' one split, from before columns: Tasks over Files.
    const legacy = Number(window.localStorage.getItem(LEGACY_SPLIT_KEY));
    if (!splits["tasks+files"] && legacy > 0.1 && legacy < 0.9) splits["tasks+files"] = [legacy, 1 - legacy];
    return splits;
  } catch {
    return {};
  }
}

/**
 * The heights of each set of stacked sections, as shares of its column; saved
 * when a drag or a key ends (a drag paints its shares on the boxes until then:
 * useStack).
 */
const useSideSplits = create<{ splits: Record<string, number[]>; save: (key: string, shares: number[]) => void }>((set, get) => ({
  splits: typeof window === "undefined" ? {} : readSplits(),
  save: (key, shares) => {
    const splits = { ...get().splits, [key]: shares };
    try { window.localStorage.setItem(SPLITS_KEY, JSON.stringify(splits)); } catch { /* the session keeps it */ }
    set({ splits });
  },
}));

/** Default heights: Tasks over Files 60/40; with the thread or the Artifact, 3 parts to it and 2 to each other section; else even. */
function defaultShares(sections: readonly AreaSection[]): number[] {
  if (sections.join("+") === "tasks+files") return [0.6, 0.4];
  const parts = sections.map((s) => (s === "thread" || s === "artifact" || s === "profile" || s === "context" || s === "details" ? 3 : 2));
  const total = parts.reduce((a, b) => a + b, 0);
  return parts.map((p) => p / total);
}

function sharesFor(sections: readonly AreaSection[], splits: Record<string, number[]>): number[] {
  return savedOr(sections, splits[sections.join("+")]);
}

function savedOr(sections: readonly AreaSection[], saved: number[] | undefined): number[] {
  if (saved && saved.length === sections.length && saved.every((n) => n > 0)) return saved;
  return defaultShares(sections);
}

/** A section's flex in a stack: its share of what the open sections split (they fill the column together), or its head alone. */
function flexIn(sections: readonly AreaSection[], shares: readonly number[], collapsed: (section: AreaSection) => boolean) {
  const openTotal = sections.reduce((sum, s, i) => (collapsed(s) ? sum : sum + shares[i]), 0);
  return (section: AreaSection) => (collapsed(section) ? "0 0 auto" : `${shares[sections.indexOf(section)] / (openTotal || 1)} 1 0px`);
}

/** The Artifact doesn't fold (F41). */
function isCollapsedSection(section: AreaSection, cards: Record<ChannelSideCard, boolean>, thread: boolean): boolean {
  return section === "thread" ? thread : section === "tasks" || section === "files" ? cards[section] : false;
}

/** How a column of `sections` would share its height, as useStack lays it out: each one's share, null for a folded head. */
const stackShares: SideStackShares = (sections) => {
  const shares = sharesFor(sections, useSideSplits.getState().splits);
  const cards = useChannelSideCardStore.getState().collapsed;
  const thread = useThreadSectionStore.getState().collapsed;
  return sections.map((section, i) => (sections.length > 1 && isCollapsedSection(section, cards, thread) ? null : shares[i]));
};

/**
 * The heights of a column's stacked sections: each one's share, a folded one
 * its head alone (only where more than one shares the column), the others
 * splitting the rest; and the drags and keys of the seams between them.
 *
 * A drag follows the pointer without rendering (stdrc: it lagged when every
 * move re-rendered the stacks and MainLayout): it paints the boxes' flex
 * once a frame, the sections' containers and, for the thread, `root`'s
 * `--side-thread-flex`, and saves the shares once, when it ends. Each stack
 * reads only its own saved shares. A region expanded in it fills it, the others folded (#189 rule 5, `stackExpanded`).
 */
export function useStack(sections: readonly AreaSection[], measure: () => number, root?: () => HTMLElement | null) {
  const cards = useChannelSideCardStore((s) => s.collapsed);
  const thread = useThreadSectionStore((s) => s.collapsed);
  const key = sections.join("+");
  const saved = useSideSplits((s) => s.splits[key]);
  const shares = useMemo(() => savedOr(sections, saved), [sections, saved]);
  const collapsible = sections.length > 1;
  const expanded = useRowPlanStore((s) => (collapsible ? stackExpanded(s.plan, sections[0]!) : null));
  const collapsed = useCallback((section: AreaSection) => (expanded ? section !== expanded : collapsible && isCollapsedSection(section, cards, thread)), [cards, collapsible, expanded, thread]);
  const flexOf = useMemo(() => flexIn(sections, shares, collapsed), [collapsed, sections, shares]);

  const dragRef = useRef<{ seam: number; y: number; height: number; shares: number[]; live: number[] | null; frame: number | null; painting: boolean } | null>(null);
  const paint = useCallback((live: readonly number[]) => {
    const flex = flexIn(sections, live, collapsed);
    const containers = useSideSections.getState().containers;
    for (const section of sections) {
      if (section === "thread") root?.()?.style.setProperty("--side-thread-flex", flex(section));
      else containers[section]?.style.setProperty("flex", flex(section));
    }
  }, [collapsed, root, sections]);
  const [dragging, setDragging] = useState<number | null>(null);
  /**
   * The share of a pixel: the open sections' shares split what the folded
   * heads and the 1px seams leave of the column (as sideSectionDrag's
   * stackBox lays a stack out).
   */
  const perPixel = useCallback((height: number) => {
    let fixed = 0;
    let openTotal = 0;
    sections.forEach((s, i) => {
      if (i > 0 && !collapsed(sections[i - 1])) fixed += 1;
      if (collapsed(s)) fixed += headHeight();
      else openTotal += shares[i];
    });
    return (openTotal || 1) / Math.max(1, height - fixed);
  }, [collapsed, sections, shares]);
  /**
   * The shares with the seam's upper section at `top`: what it takes the lower
   * one gives (the pair keeps its total, so the seam moves as far as asked),
   * each kept at least MIN_SECTION_HEIGHT.
   */
  const withTop = useCallback((base: readonly number[], seam: number, top: number, height: number) => {
    const pair = base[seam] + base[seam + 1];
    const min = Math.min(pair * 0.45, height > 0 ? MIN_SECTION_HEIGHT * perPixel(height) : 0.1);
    const out = [...base];
    out[seam] = Math.max(min, Math.min(pair - min, top));
    out[seam + 1] = pair - out[seam];
    return out;
  }, [perPixel]);
  const start = useCallback((seam: number, y: number) => {
    dragRef.current = { seam, y, height: measure(), shares, live: null, frame: null, painting: false };
    setDragging(seam);
  }, [measure, shares]);
  const move = useCallback((y: number) => {
    const drag = dragRef.current;
    if (!drag || drag.height <= 0) return;
    drag.live = withTop(drag.shares, drag.seam, drag.shares[drag.seam] + (y - drag.y) * perPixel(drag.height), drag.height);
    // One paint a frame, of the latest position (`painting`, not the frame id: a frame may run before its id is kept).
    if (drag.painting) return;
    drag.painting = true;
    drag.frame = requestAnimationFrame(() => {
      drag.painting = false;
      drag.frame = null;
      if (drag.live) paint(drag.live);
    });
  }, [paint, perPixel, withTop]);
  // A stack that changes (another section opens, the column remounts) ends a drag without saving: its shares were
  // another stack's, and a frame still to come would paint boxes that are no longer this stack's.
  useEffect(() => () => {
    const drag = dragRef.current;
    if (drag?.frame != null) cancelAnimationFrame(drag.frame);
    dragRef.current = null;
  }, [key]);
  const end = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    setDragging(null);
    if (drag.live) {
      paint(drag.live);
      useSideSplits.getState().save(key, drag.live);
    }
  }, [key, paint]);
  const key2 = useCallback((seam: number, e: ReactKeyboardEvent) => {
    const height = measure();
    if (height <= 0) return;
    const step = (e.shiftKey ? SPLIT_KEYBOARD_STEP_LARGE : SPLIT_KEYBOARD_STEP) * perPixel(height);
    let top: number;
    if (e.key === "ArrowDown") top = shares[seam] + step;
    else if (e.key === "ArrowUp") top = shares[seam] - step;
    else if (e.key === "Home") top = 0;
    else if (e.key === "End") top = shares[seam] + shares[seam + 1];
    else return;
    e.preventDefault();
    useSideSplits.getState().save(key, withTop(shares, seam, top, height));
  }, [key, measure, perPixel, shares, withTop]);
  const reset = useCallback(() => useSideSplits.getState().save(key, defaultShares(sections)), [key, sections]);
  return { shares, collapsible, collapsed, expanded, flexOf, dragging, start, move, end, onKey: key2, reset };
}

type Stack = ReturnType<typeof useStack>;

/**
 * The seam between stacked sections `seam` and `seam + 1`; where both are
 * open, it drags their split (DS Resizable, on a seam): nothing at rest but
 * the line, a 1px foreground-muted line on hover and drag, 2px foreground on
 * keyboard focus, a 12px hit area (24px by touch), the row-resize cursor.
 */
function StackSeam({ stack, seam, splittable, corner, column, label }: { stack: Stack; seam: number; splittable: boolean; corner?: ReactNode; column?: number; label?: string }) {
  const { formatMessage } = useIntl();
  const highlight = useSideHighlight((s) => (column !== undefined && s.column === column && s.seam === seam ? s.state : undefined));
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return;
    e.preventDefault();
    stack.start(seam, e.clientY);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  return (
    <div className="relative h-px shrink-0 bg-line-seam" data-testid="channel-side-seam" data-side-seam="">
      {splittable ? (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={label ?? formatMessage({ id: "task.sideColumn.resizeSplit" })}
            aria-valuenow={Math.round((stack.shares[seam] / (stack.shares[seam] + stack.shares[seam + 1])) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            data-testid="channel-side-split"
            data-dragging={stack.dragging === seam ? "true" : undefined}
            data-highlight={highlight}
            className="absolute inset-x-0 -top-1.5 z-control h-3 cursor-row-resize touch-none select-none outline-none pointer-coarse:-top-3 pointer-coarse:h-6 before:pointer-events-none before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-transparent before:transition-colors before:content-[''] hover:before:bg-foreground-muted data-[dragging=true]:before:bg-foreground-muted data-[highlight]:before:bg-foreground-muted focus-visible:keyboard:before:h-0.5 focus-visible:keyboard:before:bg-foreground"
            onPointerDown={onPointerDown}
            onPointerMove={(e) => stack.move(e.clientY)}
            onPointerUp={stack.end}
            onPointerCancel={stack.end}
            onLostPointerCapture={stack.end}
            onKeyDown={(e) => stack.onKey(seam, e)}
            onDoubleClick={stack.reset}
          />
          {corner}
        </>
      ) : null}
    </div>
  );
}

/**
 * Where a section's content goes (its head, the drag handle, is the section's
 * own: ChannelSideCard, the Artifact viewer's, the profile's): a place to drop
 * next to (`data-side-box`) where it stands in the row.
 */
function SectionBox({ section, flex, hidden, beside, end }: { section: PortalSection; flex?: string; hidden?: boolean; beside: boolean; /** Last in its column, its head alone under a section showing its body: no seam under its head along the column's bottom (stackEnd). */ end?: boolean }) {
  // Every section in the row is a place to drop next to (the Artifact and the profile too, #189 rule 7).
  const movable = beside;
  useMarkStackEnd(section, !!end && !hidden);
  return (
    <div
      ref={containerRef[section]}
      data-card={section === "artifact" ? "app" : section}
      data-side-box={movable && !hidden ? section : undefined}
      className={`relative min-h-0 min-w-0 flex-col ${hidden ? "hidden" : "flex"}`}
      style={{ flex: hidden ? undefined : flex }}
    />
  );
}

// ---------------------------------------------------------------- the thread's column

/**
 * What MainLayout's thread column needs from the placement: its place among
 * the columns, the sections stacked with the thread, and the thread's own
 * height and folding there.
 */
export function useThreadColumnSide(column: HTMLElement | null) {
  const placement = useSideSections((s) => s.placement);
  const stackSections = useMemo<AreaSection[]>(
    () => [...placement.companions.before, "thread", ...placement.companions.after],
    [placement.companions.after, placement.companions.before],
  );
  const measure = useCallback(() => column?.getBoundingClientRect().height ?? 0, [column]);
  const root = useCallback(() => column, [column]);
  const stack = useStack(stackSections, measure, root);
  const ownFold = useThreadSectionStore((s) => s.collapsed);
  const inRow = placement.threadColumn !== null;
  const stacked = inRow && stackSections.length > 1;
  const collapsed = stack.collapsed("thread");
  const threadFold = !stacked || !collapsed ? undefined : stack.expanded && !ownFold ? "expand" as const : "true" as const;
  // Last in its column, folded to its head under another section that shows its body: on the column's bottom edge,
  // no seam under its head there (stackEnd).
  useMarkStackEnd("thread", stacked && stackEndOf(stackSections, stack.collapsed) === "thread");
  // The thread's column's left seam lit from the crossing of a split with it (StackCorner), as a side column's.
  const seamHighlight = useSideHighlight((s) => (inRow && s.edge === placement.threadColumn ? s.state : undefined));
  return {
    inRow,
    /** The column (its corners drag its width) and its index in the side layout (useSideHighlight). */
    element: column,
    layoutColumn: placement.threadColumn ?? undefined,
    seamHighlight,
    /**
     * Folded into the conversation's column, over the chat (#189 rule 3; index.css `data-covers`): Back at its
     * head's start instead of × at its end, no seam of its own, the sections it was stacked with in a column of theirs.
     */
    covers: placement.covers ? "first" as const : undefined,
    order: inRow ? columnOrder(placement.threadColumn!) : undefined,
    sideCol: inRow ? String(placement.threadColumn) : undefined,
    stacked,
    threadFlex: stack.flexOf("thread"),
    threadCollapsed: collapsed,
    /**
     * MainLayout's `data-thread-collapsed` (index.css): "true" folded by its own chevron, its content hidden; "expand"
     * folded by a region expanded in its column (#189 rule 5), its content kept laid out at its height out of sight
     * (rowPlanStore `keepThreadContent`), so its replies keep their scroll and rows and restoring shows it as it was.
     */
    threadFold,
    stackSections,
    stack,
  };
}

export type ThreadColumnSide = ReturnType<typeof useThreadColumnSide>;

/** The sections stacked above (`before`) or below (`after`) the thread, with the seams between them and it. */
export function ThreadColumnSections({ side, part }: { side: ThreadColumnSide; part: "before" | "after" }) {
  const { stackSections, stack, element, layoutColumn } = side;
  // The crossing of a split with the column's left seam drags the thread's width and the split (StackCorner); with its
  // right seam, where a column stands right of it, that column's width and the split. Stacked, the column stands in
  // the row; while a region in it is expanded every seam has a folded neighbour: no split, no corner.
  const columnElement = useCallback(() => element, [element]);
  const after = useColumnAfter(layoutColumn);
  const corner = useStackCorner(layoutColumn, after, columnElement, rowMainColumn, stack, resetThreadWidth);
  if (!side.stacked) return null;
  const at = stackSections.indexOf("thread");
  const indices = part === "before" ? stackSections.slice(0, at).map((_, i) => i) : stackSections.slice(at + 1).map((_, i) => at + 1 + i);
  const seamAt = (i: number) => (
    // The seam above stacked section i + 1: none under a folded head, which draws its own.
    stack.collapsed(stackSections[i]) ? null : (
      <StackSeam key={`seam-${i}`} stack={stack} seam={i} column={layoutColumn} splittable={!stack.collapsed(stackSections[i + 1])} corner={<StackCorners corner={corner} seam={i} left right={after !== null} />} />
    )
  );
  const items: ReactNode[] = [];
  for (const i of indices) {
    if (part === "after" || i > 0) items.push(seamAt(i - 1));
    items.push(<SectionBox key={stackSections[i]} section={stackSections[i] as PortalSection} flex={stack.flexOf(stackSections[i])} beside end={stackEndOf(stackSections, stack.collapsed) === stackSections[i]} />);
  }
  if (part === "before" && indices.length > 0) items.push(seamAt(at - 1));
  return <>{items}</>;
}

// ---------------------------------------------------------------- the area

/**
 * MainLayout renders this inside the row's `channel-side-slot`. It places the
 * sections (publishing the placement the thread column reads), renders the
 * columns that stand in the row and the floating or covering surface (into
 * the channel panel's float slot), and moves each open section into its
 * place.
 */
export default function ChannelSideArea() {
  const [marker, setMarker] = useState<HTMLElement | null>(null);
  const row = marker?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
  // A drag shows nothing but where the section will land until it is dropped (sideSectionDrag): the saved layout.
  const layout = useChannelSideLayoutStore((s) => s.layout);
  const entries = useSideSections((s) => s.entries);
  const containers = useSideSections((s) => s.containers);
  const floatSlot = useSideSections((s) => s.floatSlot);
  const collapsedCards = useChannelSideCardStore((s) => s.collapsed);
  const setCardCollapsed = useChannelSideCardStore((s) => s.setCardCollapsed);
  const cardFocusAt = useChannelSideCardStore((s) => s.cardFocusAt);
  const room = useSideRoom(row, floatSlot);

  const open = useMemo(() => {
    const set = new Set<ChannelSideSection>(Object.keys(entries) as PortalSection[]);
    if (room.threadOpen || room.threadInRow || room.threadCoversRow) set.add("thread");
    return set;
  }, [entries, room.threadCoversRow, room.threadInRow, room.threadOpen]);
  // The open Artifact (F41): a section like the others, in the layout's place for it.
  const artifact = entries.artifact?.artifact ?? null;
  const expandArtifact = !!artifact?.expanded;
  // The row planned by the #189 rules on a desktop (rowLayout): every open column, the thread's included, each at
  // its saved width; the plan says whether the thread folds.
  const planned = room.room !== null && room.viewportWidth >= 768 && !room.legacyTask;
  const threadWidth = useColumnWidth("thread");
  // The keyboard shortcuts panel open beside the conversation: a column of the plan in the thread's place (rowPlan
  // `withShortcutHelpColumn`), so every column gives way for it as for any other. Over a folded thread it takes the
  // whole row instead, and the plan stays as it was (index.css).
  const helpBeside = useShortcutHelpStore((s) => s.open && !s.overCoveringThread);
  const helpWidth = useColumnWidth("detail");
  // The Tasks page's task beside its list (TasksRoute): a column of the row right of the list, the conversation, at
  // the detail column's width, as the thread beside its channel; its Focus Mode is its Expand (rule 5).
  const taskColumn = useRowPlanStore((s) => s.taskColumn !== null);
  const taskExpanded = useRowPlanStore((s) => s.taskColumn?.focused ?? false);
  const columnsForPlan = useMemo<PlanColumn[]>(() => {
    if (!planned) return NO_PLAN_COLUMNS;
    let columns = planColumns(visibleChannelSideColumns(layout, open), threadWidth);
    if (taskColumn) columns = withTasksPageTaskColumn(columns, { saved: helpWidth, contentMin: COLUMN_BOUNDS.detail.contentMin });
    return helpBeside ? withShortcutHelpColumn(columns, { saved: helpWidth, contentMin: COLUMN_BOUNDS.detail.contentMin }) : columns;
  }, [helpBeside, helpWidth, layout, open, planned, taskColumn, threadWidth]);
  const plan = useRowPlan({ active: planned, available: room.rowWidth, columns: columnsForPlan, thread: open.has("thread") && !helpBeside, forceFold: room.touchPortrait, threadExpanded: room.threadMaximized && !helpBeside, taskExpanded: taskColumn && taskExpanded });
  const fold = plan?.fold ?? false;
  const placement = useMemo(() => placeSections(layout, open, room, expandArtifact, fold), [expandArtifact, fold, layout, open, room]);
  useRowLayout(row, room, plan);
  // For the heads' Move Left / Move Right (rule 7): the layout as placed, and how a section moves.
  useLayoutEffect(() => {
    useRowPlanStore.setState({ layout, moveSection: useChannelSideLayoutStore.getState().moveSection });
  }, [layout]);
  useLayoutEffect(() => () => useRowPlanStore.setState({ layout: null, moveSection: null }), []);
  // For the drag: how a column would share its height, for the area a section will take. Every new column a drop
  // makes stands in the row (the plan clips or tabs it, #189 rules 4 and 7): none needs the sidebar collapsed.
  useLayoutEffect(() => {
    useSideDrag.setState({ fit: room.room === null ? null : () => "fits", shares: stackShares });
    return () => useSideDrag.setState({ fit: null, shares: null });
  }, [room.room]);

  const floatColumnHeight = sideCardsColumnHeight("float", room.panelHeight, room.composerHeight);
  const floatOneAtATime = placement.floating.length > 1 && (placement.floatMode === "overlay" || sideCardsOneAtATime(placement.floatMode, floatColumnHeight, placement.floating.length));
  const floatActive = floatOneAtATime ? activeAreaSection(placement.floating, cardFocusAt, artifact?.openedAt) : null;
  const collapseHandlers = useMemo<Record<PortalSection, (collapsed: boolean) => void>>(() => ({
    tasks: (collapsed: boolean) => setCardCollapsed("tasks", collapsed),
    files: (collapsed: boolean) => setCardCollapsed("files", collapsed),
    // The others don't fold.
    artifact: () => {}, profile: () => {}, context: () => {}, details: () => {},
  }), [setCardCollapsed]);
  useLayoutEffect(() => {
    // Every open section's place, for its head (mode, folding, on screen); and the placement for the thread column.
    const states: Partial<Record<PortalSection, Omit<SideCardState, "card">>> = {};
    const place = (sections: PortalSection[], mode: SideCardsMode, collapsible: boolean, active: PortalSection | null = null) => {
      for (const section of sections) {
        const folds = collapsible && (section === "tasks" || section === "files");
        states[section] = { mode, collapsible: folds, collapsed: folds && collapsedCards[section as ChannelSideCard], onCollapsedChange: collapseHandlers[section], shown: active === null || active === section };
      }
    };
    for (const column of placement.row) place(column.sections, "beside", column.sections.length > 1);
    const companions = [...placement.companions.before, ...placement.companions.after];
    place(companions, "beside", companions.length > 0);
    place(placement.floating, placement.floatMode, placement.floating.length > 1 && !floatOneAtATime, floatActive);
    useSideSections.setState({ states, placement });
  }, [collapseHandlers, collapsedCards, floatActive, floatOneAtATime, placement]);

  // Moving sections: where they stand in the row, more than one open there, nothing expanded (#189 rule 7).
  const setDragEnabled = useSideDrag((s) => s.setEnabled);
  const movable = placement.row.reduce((n, c) => n + c.sections.length, 0) + (placement.threadColumn !== null ? 1 + placement.companions.before.length + placement.companions.after.length : 0);
  const dragEnabled = movable > 1 && planned && !plan?.expandedUnit;
  useLayoutEffect(() => {
    setDragEnabled(dragEnabled);
    // A drag doesn't outlive the row's sections being movable, nor the area.
    if (!dragEnabled) cancelSideDrag();
  }, [dragEnabled, setDragEnabled]);
  useLayoutEffect(() => cancelSideDrag, []);

  // Folded over, the channel keeps its box (its scroll and drafts) under the thread but is out of reach: no focus,
  // no pointer, nothing read out, until the thread closes or the row widens (rule 3).
  useLayoutEffect(() => {
    const channel = placement.covers ? row?.querySelector<HTMLElement>(":scope > .thread-main-column") : null;
    if (!channel) return;
    channel.setAttribute("inert", "");
    return () => channel.removeAttribute("inert");
  }, [placement.covers, row]);
  const keepFocus = useCoverFocus(row, placement, open.has("thread"));

  // Each section's content into its place; a move the cover made keeps the focus that was in it (useCoverFocus).
  useLayoutEffect(() => {
    for (const [section, entry] of Object.entries(entries) as Array<[PortalSection, SectionEntry]>) {
      if (containers[section] && entry.host.parentElement !== containers[section]) moveNodeInto(containers[section], entry.host);
    }
    // The hosts now in the document let their content render (SideSectionPortal).
    const attached = useSideSections.getState().attached;
    const nowAttached = (Object.entries(entries) as Array<[PortalSection, SectionEntry]>).filter(([section, entry]) => attached[section] !== entry.host && entry.host.isConnected);
    if (nowAttached.length > 0) useSideSections.setState({ attached: { ...attached, ...Object.fromEntries(nowAttached.map(([section, entry]) => [section, entry.host])) } });
    keepFocus();
  }, [containers, entries, keepFocus]);

  const surface = placement.floating.length > 0 && floatSlot ? createPortal(
    <SideColumn
      kind={placement.floatMode}
      sections={placement.floating}
      titles={entries}
      oneAtATime={floatOneAtATime}
      composerHeight={room.composerHeight}
    />,
    floatSlot,
  ) : null;
  // The Artifact expanded (F41, #proj-workspace:#100) is the row's focus mode, as the thread's is: it covers the
  // whole row (this slot is `contents`, so the row is its box) and the row's `data-artifact-expanded` hides the
  // rest (index.css). The channel, the thread and the other columns keep their places and widths, so collapsing
  // brings them back as they were.
  const artifactExpanded = placement.artifactExpanded && !!artifact;
  useLayoutEffect(() => {
    if (!row || !artifactExpanded) return;
    row.dataset.artifactExpanded = "true";
    return () => { delete row.dataset.artifactExpanded; };
  }, [artifactExpanded, row]);
  const expandedSurface = artifactExpanded ? (
    <div data-testid="channel-side-column" data-mode="expanded" data-expanded="true" className="absolute inset-0 z-cover flex bg-layer-canvas">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SectionBox section="artifact" flex="1 1 0px" beside={false} />
      </div>
    </div>
  ) : null;

  return (
    <>
      <div ref={setMarker} hidden data-side-area="" data-testid="channel-side-area" />
      <SideDragLayer />
      {placement.row.map((column) => (
        <SideColumn
          key={column.sections.join("+")}
          kind="beside"
          column={column.column}
          widthColumn={column.column}
          sections={column.sections}
          titles={entries}
          width={column.width}
          minWidth={column.minWidth}
        />
      ))}
      {surface}
      {expandedSurface}
    </>
  );
}

/**
 * Where the focus goes as the thread folds over the conversation and back (#189 rule 3; Kirby's reviews of #11404 and
 * #11439); all of it only where the fold took the focus away, never over a place the person moved it to:
 *
 * - the fold begins with the focus in the channel (inert now): to the thread's title;
 * - it ends with the thread open (the row widened) and the focus still on that title or fallen to the page: back
 *   where it was;
 * - Back closes the thread: back where it was, else the thread's "N replies" in the channel, else its composer;
 * - a section's content moved to another column (the thread folding out of the column it shares) takes the focus
 *   out of it: it goes back to where it was in the section. A drop puts the focus back itself (sideSectionDrag).
 *
 * Returns what the area calls once it has moved the sections' content into place.
 */
function useCoverFocus(row: HTMLElement | null, placement: SidePlacement, threadOpen: boolean): () => void {
  const coverFocus = useRef<{ parent: string | null; returnTo: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    const channel = placement.covers ? row?.querySelector<HTMLElement>(":scope > .thread-main-column") : null;
    if (!channel || !row) return;
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && channel.contains(active);
    coverFocus.current = { parent: useThreadStore.getState().openParentMessageId, returnTo: hadFocus ? active : null };
    if (hadFocus) coverFocusTarget(row)?.focus();
  }, [placement.covers, row]);
  useLayoutEffect(() => {
    const was = coverFocus.current;
    const channel = row?.querySelector<HTMLElement>(":scope > .thread-main-column");
    if (threadOpen) {
      if (placement.covers) return;
      // Unfolded with the thread open (the row widened): where the fold took the focus from, if it is still where
      // the fold put it (the thread's title) or fell to the page.
      coverFocus.current = null;
      const active = document.activeElement;
      const left = focusLost() || (active instanceof HTMLElement && active.dataset.testid === "thread-scroll-to-top");
      if (was?.returnTo?.isConnected && channel?.contains(was.returnTo) && left) was.returnTo.focus();
      return;
    }
    // The thread closed while it was folded (its Back): the focus, which was on Back, goes back to the channel.
    coverFocus.current = null;
    if (!was || !channel || !focusLost()) return;
    const message = Array.from(channel.querySelectorAll<HTMLElement>("[data-message-id]")).find((element) => element.dataset.messageId === was.parent);
    const replies = message?.querySelector<HTMLElement>('[data-message-affordance="inline-thread-replies"], [data-testid="message-thread-replies-badge"]') ?? null;
    const composer = channel.querySelector<HTMLElement>('[data-testid="composer-textarea"]');
    [was.returnTo, replies, composer].find((element) => element?.isConnected && channel.contains(element))?.focus();
  }, [placement.covers, row, threadOpen]);

  // The section holding the focus.
  const focusedIn = useRef<{ section: PortalSection; element: HTMLElement } | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const entry = target ? (Object.entries(useSideSections.getState().entries) as Array<[PortalSection, SectionEntry]>).find(([, e]) => e.host.contains(target)) : undefined;
      focusedIn.current = entry && target ? { section: entry[0], element: target } : null;
    };
    // A press elsewhere that takes the focus to the page (no focusin) is the person leaving the section.
    const onPointerDown = (event: PointerEvent) => {
      const focused = focusedIn.current;
      if (focused && !(event.target instanceof Node && useSideSections.getState().entries[focused.section]?.host.contains(event.target))) focusedIn.current = null;
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  // The sections the fold moved, in or out of the thread's column, with the last placement: only their focus is kept
  // (a drop puts the focus back itself).
  const companions = [...placement.companions.before, ...placement.companions.after].join("+");
  const last = useRef({ covers: placement.covers, companions });
  const coverMoved = useRef<Set<PortalSection>>(new Set());
  useLayoutEffect(() => {
    if (last.current.covers !== placement.covers) {
      coverMoved.current = new Set([...last.current.companions.split("+"), ...companions.split("+")].filter(Boolean) as PortalSection[]);
    }
    last.current = { covers: placement.covers, companions };
  }, [companions, placement.covers]);
  return useCallback(() => {
    const focused = focusedIn.current;
    if (!focused || !coverMoved.current.has(focused.section) || !focused.element.isConnected || !focusLost()) return;
    coverMoved.current.delete(focused.section);
    if (useSideSections.getState().entries[focused.section]?.host.contains(focused.element)) focused.element.focus({ preventScroll: true });
  }, []);
}

/** Where focus goes when the fold takes it from the channel: the thread's title, else its Back. */
function coverFocusTarget(row: HTMLElement): HTMLElement | null {
  const column = row.querySelector<HTMLElement>(":scope > .thread-side-column");
  return column?.querySelector<HTMLElement>('[data-testid="thread-scroll-to-top"]')
    ?? column?.querySelector<HTMLElement>('[data-testid="thread-mobile-back"]')
    ?? null;
}

// ---------------------------------------------------------------- one column

interface SideColumnProps {
  kind: SideCardsMode;
  column?: number;
  /** The layout's column whose width it drags (its own); none: not resizable. */
  widthColumn?: number;
  sections: PortalSection[];
  titles: Partial<Record<PortalSection, SectionEntry>>;
  width?: number;
  minWidth?: number;
  oneAtATime?: boolean;
  composerHeight?: number;
}

/**
 * One column of stacked sections: in the row (a seam on its left that drags
 * its width), or the floating / covering surface. Between two sections, a
 * seam that drags their split; where it meets the column's left seam, a
 * crossing that drags both.
 */
function SideColumn({ kind, column, widthColumn, sections, titles, width, minWidth, oneAtATime = false, composerHeight = 0 }: SideColumnProps) {
  const { formatMessage, formatList } = useIntl();
  const cardFocusAt = useChannelSideCardStore((s) => s.cardFocusAt);
  const focusCard = useChannelSideCardStore((s) => s.focusCard);
  const stackRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const active = oneAtATime ? activeAreaSection(sections, cardFocusAt, titles.artifact?.artifact?.openedAt) : null;
  const shown = useMemo<PortalSection[]>(() => (active ? [active] : sections), [active, sections]);
  const measure = useCallback(() => stackRef.current?.getBoundingClientRect().height ?? 0, []);
  const stack = useStack(shown, measure);
  const beside = kind === "beside";
  const resizable = beside && widthColumn !== undefined;

  const source = useMemo<ColumnWidthSource | undefined>(() => (resizable ? {
    width: width ?? channelSideSectionWidth(sections[0] ?? "tasks"),
    min: COLUMN_BOUNDS.sideCards.min,
    // Its sections' content minimum (areaColumnMinWidth: the Artifact's 480 included): narrower, it clips (#189 rule 2).
    contentMin: minWidth,
    get: () => useChannelSideLayoutStore.getState().layout.columns[widthColumn!]?.width ?? width ?? 0,
    preview: (w) => useChannelSideLayoutStore.getState().resizeColumn(widthColumn!, w, false),
    commit: (w) => {
      const store = useChannelSideLayoutStore.getState();
      store.resizeColumn(widthColumn!, w ?? store.layout.columns[widthColumn!]?.width ?? 0, true);
    },
    // The width of the section on top's own column (channelSideSectionWidth).
    reset: () => useChannelSideLayoutStore.getState().resizeColumn(widthColumn!, channelSideSectionWidth(sections[0] ?? "tasks"), true),
  } : undefined), [widthColumn, minWidth, resizable, sections, width]);

  // The crossing of the column's left seam, or of its right one where a column stands right of it, with a seam
  // between sections: one drag moves both (StackCorner).
  const highlight = useSideHighlight((s) => (column !== undefined && s.edge === column ? s.state : undefined));
  const columnElement = useCallback(() => columnRef.current, []);
  const resetWidth = useCallback(() => source?.reset(), [source]);
  const after = useColumnAfter(beside ? column : undefined);
  const corner = useStackCorner(column, after, columnElement, rowMainColumn, stack, resetWidth);

  const label = formatMessage({ id: "layout.columnResize.sideCards" }, { sections: formatList(sections.map((s) => titles[s]?.title ?? s), { type: "conjunction" }) });
  // A click on the switch (channel_tab_selected); the Artifact's tab isn't one of the conversation's tabs.
  const switchCard = useCallback((card: PortalSection) => {
    if (card === "artifact") {
      focusCard("app");
      return;
    }
    // (The profile is a section of a desktop's row only, never under a phone's switch.)
    if (card === "profile") return;
    if (card !== "context" && card !== "details") trackChannelTabSelected(card, "side_column_tabs", false);
    focusCard(card);
  }, [focusCard]);

  return (
    <div
      ref={columnRef}
      data-testid="channel-side-column"
      data-mode={kind}
      data-column={column}
      data-side-col={beside ? column : undefined}
      data-in-row={beside ? "true" : undefined}
      className={columnClass(kind)}
      style={{
        ...(beside ? { order: columnOrder(column ?? 0), width: `${width}px`, minWidth: `${Math.min(width ?? 0, minWidth ?? 0)}px` } : null),
        ...(kind === "float" ? { bottom: `${composerHeight + SIDE_CARDS_FLOAT_COMPOSER_GAP}px` } : null),
      }}
    >
      {resizable ? (
        <ColumnResizeHandle
          column="sideCards"
          edge="left"
          label={label}
          source={source}
          mainColumn={rowMainColumn}
          highlight={highlight}
          // The column draws its left seam itself (columnClass "beside").
          ownBorder
          data-testid="channel-side-column-resize"
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active ? (
          <div data-testid="channel-side-switch" className="flex h-12 shrink-0 items-center border-b border-line-seam px-4 md:px-(--surface-inset) md:pointer-fine:h-panel-header">
            <Tabs<PortalSection> value={active} onValueChange={switchCard} className="w-auto min-w-0">
              <TabsList aria-label={formatMessage({ id: "task.sideColumn.paneSwitch" })}>
                {sections.map((section) => (
                  <TabsTab key={section} value={section} data-testid={`channel-side-switch-${section === "artifact" ? "app" : section}`}>
                    {section === "tasks" ? <ListTodo /> : section === "files" ? <Paperclip /> : section === "profile" ? <UserRound /> : section === "context" ? <ScanText /> : section === "details" ? <Settings /> : titles.artifact?.artifact?.icon}
                    <TabsLabel>{titles[section]?.title ?? section}</TabsLabel>
                  </TabsTab>
                ))}
              </TabsList>
            </Tabs>
          </div>
        ) : null}
        <div ref={stackRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {sections.map((section) => {
            const index = shown.indexOf(section);
            const visible = index >= 0;
            const seam = index - 1;
            const seamAbove = visible && index > 0 && !stack.collapsed(shown[seam]);
            return (
              <Fragment key={section}>
              {seamAbove ? (
                <StackSeam
                  column={column}
                  stack={stack}
                  seam={seam}
                  // Under the Artifact: its own name, not Tasks and Files' (F41).
                  label={shown[seam] === "artifact" ? formatMessage({ id: "artifacts.viewer.resizeSplit" }) : undefined}
                  splittable={!stack.collapsed(section)}
                  corner={<StackCorners corner={corner} seam={seam} left={resizable} right={after !== null} />}
                />
              ) : null}
              <SectionBox section={section} flex={visible ? stack.flexOf(section) : undefined} hidden={!visible} beside={beside} end={visible && stackEndOf(shown, stack.collapsed) === section} />
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The column's box: in the row, floating, or covering the panel. */
function columnClass(kind: SideCardsMode): string {
  switch (kind) {
    case "overlay":
      return "absolute inset-0 z-cover flex bg-layer-canvas";
    case "float":
      // Over the right of the messages, flat against the panel's top and
      // right edges and stopping above the composer (bottom set inline).
      // Flat like a column, raised by the shadow alone. At most 58% of the
      // panel and 360px, so part of the messages stays readable. The column
      // always draws its bottom edge; a folded head at the bottom draws no
      // line of its own (data-stack-end), so the two don't double.
      return "absolute top-0 right-0 z-float flex border-b border-l border-line-seam bg-layer-canvas shadow-float [width:min(360px,max(280px,58%),calc(100%-24px))]";
    case "beside":
      // Full height in the row, a seam on its left like the thread column's.
      // Its width is its basis; it gives way to its minimum before the
      // channel drops under 360px (index.css), and floats past that.
      return "relative flex shrink border-l border-line-seam bg-layer-canvas";
  }
}
