import type { CSSProperties } from "react";

/**
 * Single source of truth for every resizable column's width rules (task #139).
 *
 * One row per kind of column, not per page: the left sidebar is the same column on Chat, Members, Computers,
 * Settings and the public server page, so it has one width; a profile and a legacy task share the right-hand
 * detail column. The numbers were agreed with the design lead (2026-10-21); the widths are remembered per browser
 * profile under `storageKey` (see store/columnWidthStore.ts). `legacyStorageKeys` are the keys earlier builds wrote
 * for the same column: the first one present is adopted when `storageKey` has no value yet, then all are removed.
 *
 * The maximum of a column right of the conversation (thread, detail, sideCards; `growsToMainMin`) is not a number
 * in this table: it is as wide as the column can get while the conversation beside it keeps `MAIN_COLUMN_MIN_WIDTH`
 * (task #74, Tenny and Jasper, 2026-10-23; it was 720 / 640 / 652, about half of a 1280-1440 window). The handle
 * works it out from the layout when a drag or a key starts (`growToMainMinMax`); `max` there is only the safety
 * bound stored widths are clamped to.
 */
export interface ColumnBounds {
  readonly defaultWidth: number;
  /** The narrowest the column may be dragged. A column in the layout row goes to 160 (#189, rule 2): below `contentMin` its content keeps that width and is clipped. */
  readonly min: number;
  /** A column in the layout row: its content's minimum width, kept (and clipped) when the column is narrower. */
  readonly contentMin?: number;
  /** The widest the column may be dragged; for a `growsToMainMin` column only a safety bound for stored widths. */
  readonly max: number;
  /** The column's real maximum is what the conversation beside it can give up down to MAIN_COLUMN_MIN_WIDTH. */
  readonly growsToMainMin?: boolean;
  readonly storageKey: string;
  readonly legacyStorageKeys: readonly string[];
}

/** Safety bound for the remembered width of a `growsToMainMin` column: wider than any window it is shown in. */
export const GROWS_TO_MAIN_MIN_SAFETY_MAX = 8192;

export const COLUMN_BOUNDS = {
  /** Left sidebar: channels, Members, Computers, Settings, and the public server page's sidebars. */
  sidebar: {
    defaultWidth: 240,
    min: 200,
    max: 400,
    storageKey: "slock:sidebarWidth",
    legacyStorageKeys: ["slock:publicServer:channelSidebarWidth", "slock:publicServer:settingsSidebarWidth"],
  },
  /** Activity / Search list once it moves into the sidebar slot beside a picked item. Its 240 minimum lets the
   *  rail, the list and the conversation's 360 share a 768px window (stdrc: Activity is two columns on desktop). */
  list: {
    defaultWidth: 380,
    min: 240,
    max: 640,
    storageKey: "slock:searchPanelWidth",
    legacyStorageKeys: ["slock:searchPanelCompactWidth"],
  },
  /** Thread panel, signed in and on the public server page. */
  thread: {
    defaultWidth: 400,
    min: 160,
    contentMin: 360,
    max: GROWS_TO_MAIN_MIN_SAFETY_MAX,
    growsToMainMin: true,
    storageKey: "slock:threadPanelWidth",
    legacyStorageKeys: ["slock:publicServer:threadPanelWidth"],
  },
  /** Right-hand detail column: the profile panel and the legacy task side panel. */
  detail: {
    defaultWidth: 400,
    min: 160,
    contentMin: 320,
    max: GROWS_TO_MAIN_MIN_SAFETY_MAX,
    growsToMainMin: true,
    storageKey: "slock:profilePanelWidth",
    legacyStorageKeys: ["slock:legacyTaskPanelWidth"],
  },
  /**
   * Task v2: the Tasks / Files sections docked in a channel panel, flat against its edge: 360 by default; their
   * content at least 280, its left seam included.
   */
  sideCards: {
    defaultWidth: 360,
    min: 160,
    contentMin: 280,
    max: GROWS_TO_MAIN_MIN_SAFETY_MAX,
    growsToMainMin: true,
    storageKey: "slock:channelSideCardsWidth",
    legacyStorageKeys: [],
  },
  /** File tree in an agent's Workspace tab. */
  workspaceTree: {
    defaultWidth: 256,
    min: 180,
    max: 480,
    storageKey: "slock:workspaceTreeWidth",
    legacyStorageKeys: [],
  },
} as const satisfies Record<string, ColumnBounds>;

export type ColumnId = keyof typeof COLUMN_BOUNDS;

/**
 * The conversation's content minimum: the window gives way around it (fits, the thread split's container query in
 * index.css, 360 + the thread's 360 = 720; keep them in step). In MainLayout's row a seam drag takes the conversation
 * on to 160 like any column, its content clipped (#189, rowLayout); a column dragged alone elsewhere stops here.
 */
export const MAIN_COLUMN_MIN_WIDTH = 360;

/**
 * The widest a `growsToMainMin` column may be dragged right now: its rendered width plus whatever the conversation
 * beside it has above `mainMin`, within the column's bounds. When the conversation is already at (or below) its
 * minimum, the column cannot grow, but it never has to go under its own minimum either.
 */
export function growToMainMinMax(
  column: ColumnId,
  columnWidth: number,
  conversationWidth: number,
  mainMin = MAIN_COLUMN_MIN_WIDTH,
): number {
  const { min, max } = COLUMN_BOUNDS[column];
  const reachable = Math.floor(columnWidth + Math.max(0, conversationWidth - mainMin));
  return Math.max(min, Math.min(max, reachable));
}

export function clampColumnWidth(column: ColumnId, width: number): number {
  const { min, max } = COLUMN_BOUNDS[column];
  return Math.round(Math.max(min, Math.min(max, width)));
}

export interface FitColumn {
  /** Remembered width (already within the column's bounds). */
  readonly width: number;
  readonly min: number;
}

/** Room every other column and the main column keep before column `index` gives way (see fitColumnWidths). */
function shrinkAllowance(columns: readonly FitColumn[], index: number, mainMin: number): number {
  const leftWidths = columns.slice(0, index).reduce((sum, column) => sum + column.width, 0);
  const rightMins = columns.slice(index + 1).reduce((sum, column) => sum + column.min, 0);
  return mainMin + leftWidths + rightMins;
}

/**
 * Rendered widths for side columns, left to right, sharing `available` px with a main column of at least `mainMin`.
 *
 * When the window is too narrow for the remembered widths, the rightmost column gives way first, down to its
 * minimum, then the one before it, and so on. Remembered widths are never changed. A column never renders below its
 * minimum: when even the minimums do not fit, the overflow is left to the layout (the right panel then covers the
 * conversation through index.css's container queries).
 *
 * Closed form of that order: column k keeps its width unless the room left after the main column, the remembered
 * widths to its left and the minimums to its right is smaller. Each column's answer depends only on remembered
 * widths and minimums, so the same rule can be written in CSS (`fittedColumnStyles`).
 */
export function fitColumnWidths(available: number, columns: readonly FitColumn[], mainMin = MAIN_COLUMN_MIN_WIDTH): number[] {
  return columns.map((column, index) =>
    Math.max(column.min, Math.min(column.width, available - shrinkAllowance(columns, index, mainMin))));
}

/**
 * Rendered width of a column left of the conversation when a panel needing `rightColumnMin` px may open on the right
 * (0 when none). It gives way for that panel only while doing so can still put the panel beside the conversation;
 * when even its own minimum would leave too little room, the panel will cover the conversation anyway (index.css),
 * so the column keeps the width the conversation alone allows instead of snapping to its minimum for nothing.
 */
export function fitLeadingColumnWidth(
  available: number,
  column: FitColumn,
  rightColumnMin: number,
  mainMin = MAIN_COLUMN_MIN_WIDTH,
): number {
  const splitReachable = rightColumnMin > 0 && available - column.min >= mainMin + rightColumnMin;
  return fitColumnWidths(
    available,
    splitReachable ? [column, { width: rightColumnMin, min: rightColumnMin }] : [column],
    mainMin,
  )[0]!;
}

/**
 * The widest a leading column may render when it must not outgrow the column beside it: `share` of the room from
 * its left edge to the window's right edge (half: the conversation is at least as wide as the column), never below
 * the column's minimum. Activity's list with an item open (stdrc: "the channel narrower than the list is odd").
 */
export function shareCapWidth(room: number, share: number, min: number): number {
  return Math.max(min, Math.floor(room * share));
}

/**
 * `fitColumnWidths` as CSS custom properties, for a layout whose columns are children of a size container. Pair each
 * style with the width rule
 * `max(var(--column-min), min(var(--column-width), calc(100cqw - var(--column-allowance))))`,
 * which takes the container's width (`100cqw`) as the available room, so a window resize stays CSS-only.
 */
export function fittedColumnStyles(columns: readonly FitColumn[], mainMin = MAIN_COLUMN_MIN_WIDTH): CSSProperties[] {
  return columns.map((column, index) => ({
    "--column-width": `${column.width}px`,
    "--column-min": `${column.min}px`,
    "--column-allowance": `${shrinkAllowance(columns, index, mainMin)}px`,
  }) as CSSProperties);
}
