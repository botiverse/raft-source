import { useCallback, useState } from "react";
import type { ArtifactDashboardAllSort } from "@botiverse/raft-shared";

/**
 * What the Artifacts home page keeps on the device (#proj-workspace:#133): the
 * view (grid or list), the table's column widths (design D21) and the list's
 * sort (the server sorts it: `dashboardAll`'s `sort`, each in its default
 * direction). Local storage, one key; anything unreadable is the default, so a newer or older
 * build never breaks on another's value.
 */

export const ARTIFACT_DASHBOARD_VIEWS = ["grid", "list"] as const;
export type ArtifactDashboardView = (typeof ARTIFACT_DASHBOARD_VIEWS)[number];

/**
 * The table's columns, in their order; `title` takes the room the others leave.
 * No column for where it lives (#proj-workspace:#187, xxchan): it said what
 * "Who can see it" says. A width stored for it by an older build is dropped.
 */
export const ARTIFACT_TABLE_COLUMNS = ["title", "author", "updated", "comments", "visibility"] as const;
export type ArtifactTableColumn = (typeof ARTIFACT_TABLE_COLUMNS)[number];
/** The columns with a width of their own (all but the title), and their defaults in px (design D21). */
export type ArtifactTableSizedColumn = Exclude<ArtifactTableColumn, "title">;
export const ARTIFACT_TABLE_DEFAULT_WIDTHS: Record<ArtifactTableSizedColumn, number> = {
  author: 200,
  updated: 124,
  comments: 84,
  visibility: 196,
};
export const ARTIFACT_TABLE_MIN_WIDTH = 64;
export const ARTIFACT_TABLE_MAX_WIDTH = 480;

/**
 * The sorts the page offers (#proj-workspace:#210): recently opened, the default, and recently updated. The server
 * also sorts by title and by comments; the design keeps neither, so the page no longer asks for them.
 */
export const ARTIFACT_HOME_SORTS = ["opened", "updated"] as const satisfies readonly ArtifactDashboardAllSort[];
export type ArtifactHomeSort = (typeof ARTIFACT_HOME_SORTS)[number];

/** The page's first sort: what the reader opened last, first. */
export const ARTIFACT_HOME_DEFAULT_SORT: ArtifactHomeSort = "opened";

export interface ArtifactDashboardPrefs {
  view: ArtifactDashboardView;
  widths: Record<ArtifactTableSizedColumn, number>;
  /**
   * Not `order`, the field older builds keep: they wrote it on every change of view or width, so its newest update
   * first says nothing about a choice, and read as one it would keep those readers off the new default.
   */
  listSort: ArtifactHomeSort;
}

export const ARTIFACT_DASHBOARD_PREFS_KEY = "raft:artifacts:dashboard:v1";

const DEFAULT_PREFS: ArtifactDashboardPrefs = { view: "grid", widths: ARTIFACT_TABLE_DEFAULT_WIDTHS, listSort: ARTIFACT_HOME_DEFAULT_SORT };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

export const clampWidth = (width: number) => Math.round(Math.min(ARTIFACT_TABLE_MAX_WIDTH, Math.max(ARTIFACT_TABLE_MIN_WIDTH, width)));

/** A stored value as prefs: each part that doesn't read is its default, a column no longer there is dropped. */
export function readArtifactDashboardPrefs(raw: string | null): ArtifactDashboardPrefs {
  let parsed: unknown = null;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) return DEFAULT_PREFS;
  const view = oneOf(ARTIFACT_DASHBOARD_VIEWS, parsed.view) ? parsed.view : DEFAULT_PREFS.view;
  const storedWidths = isRecord(parsed.widths) ? parsed.widths : {};
  const widths = { ...ARTIFACT_TABLE_DEFAULT_WIDTHS };
  for (const column of Object.keys(widths) as ArtifactTableSizedColumn[]) {
    const width = storedWidths[column];
    if (typeof width === "number" && Number.isFinite(width)) widths[column] = clampWidth(width);
  }
  const listSort = oneOf(ARTIFACT_HOME_SORTS, parsed.listSort) ? parsed.listSort : DEFAULT_PREFS.listSort;
  return { view, widths, listSort };
}

function load(): ArtifactDashboardPrefs {
  try {
    return readArtifactDashboardPrefs(window.localStorage.getItem(ARTIFACT_DASHBOARD_PREFS_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

function save(prefs: ArtifactDashboardPrefs) {
  try {
    window.localStorage.setItem(ARTIFACT_DASHBOARD_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or off (private mode): the choice lasts this page only.
  }
}

/** The page's prefs, read once on mount, each change written back. */
export function useArtifactDashboardPrefs() {
  const [prefs, setPrefs] = useState(load);
  const update = useCallback((change: (prefs: ArtifactDashboardPrefs) => ArtifactDashboardPrefs) => {
    setPrefs((current) => {
      const next = change(current);
      save(next);
      return next;
    });
  }, []);
  const setView = useCallback((view: ArtifactDashboardView) => update((p) => ({ ...p, view })), [update]);
  const setWidth = useCallback((column: ArtifactTableSizedColumn, width: number | null) => update((p) => ({
    ...p,
    widths: { ...p.widths, [column]: width === null ? ARTIFACT_TABLE_DEFAULT_WIDTHS[column] : clampWidth(width) },
  })), [update]);
  const setSort = useCallback((listSort: ArtifactHomeSort) => update((p) => ({ ...p, listSort })), [update]);
  return { prefs, setView, setWidth, setSort };
}
