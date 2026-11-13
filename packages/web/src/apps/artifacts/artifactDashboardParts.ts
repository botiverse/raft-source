import type { ArtifactCard, ArtifactDashboardAllCounts, ArtifactDashboardConversation, ArtifactDashboardHome, ArtifactWebDashboardAll } from "@botiverse/raft-shared";

import type { ArtifactDashboardPrefs, ArtifactTableSizedColumn } from "./artifactDashboardPrefs";

/** What the Artifacts home page's parts share (ArtifactsDashboard and the modules it is split into). */

/** The homes the Conversation filter offers above the conversations (#proj-workspace:#221), in its order. */
export const ARTIFACT_PLACE_HOMES = ["public", "server"] as const satisfies readonly ArtifactDashboardHome[];
export type ArtifactPlaceHome = (typeof ARTIFACT_PLACE_HOMES)[number];

/** The Conversation filter's one value: a home that is no conversation (`home`), or a conversation (`conversation`). */
export type ArtifactPlace = { kind: "home"; home: ArtifactPlaceHome } | { kind: "conversation"; conversation: ArtifactDashboardConversation };

export const SKELETON_ROWS = 3;
/** The table's placeholder rows while its first page loads: about a screenful under its header. */
export const SKELETON_TABLE_ROWS = 8;

/** The tile grid's box: the loaded grid's and its skeleton's, so the placeholders sit where the tiles will. */
export const TILE_GRID_CLASS = "grid grid-cols-2 gap-2 px-(--column-margin) py-2 md:grid-cols-[repeat(auto-fill,minmax(248px,1fr))] md:gap-3";

/** A filter list's chosen row reads bold, beside its check (Kirby's draft, #proj-workspace:#221). */
export const CHOSEN_BOLD = "data-selected:font-bold";

/** The numbers of the header's count line and the toggle, and whether they were read with any filter on. */
export interface ShownCounts extends ArtifactDashboardAllCounts {
  narrowed: boolean;
}

export interface AllState {
  /** The latest read; an answer of an older one is dropped. */
  generation: number;
  /** `idle`: nothing asked yet; `off` when the server says Artifacts aren't on. */
  status: "idle" | "loading" | "ok" | "failed" | "off";
  /** The rows on screen (kept while the list reads itself again, and when that fails). */
  page: ArtifactWebDashboardAll | null;
  /** The read the rows on screen came from. */
  pageGeneration: number;
  /**
   * Whether the rows on screen were read in the order they were opened: what their time says follows them, not the
   * sort last asked for (a re-sort that fails leaves the rows in theirs, and goes back to it). Never under 和我有关, whose order is by update.
   */
  pageByOpened: boolean;
  /**
   * The latest first page's numbers. A state of their own, not the page's: later pages say null, and the header and
   * the toggle keep them through a read that replaces the rows, until that server's next first page answers.
   */
  counts: ShownCounts | null;
  paging: boolean;
  /** "Load More" added to the rows on screen: a read of the first page would drop those. */
  extended: boolean;
}

export type DashboardLayout = "grid" | "table" | "rows";

/** `index`: the row's place in the list, where focus goes back to when the viewer closes. */
export type OpenRow = (card: ArtifactCard, from: HTMLElement, index: number) => void;

export interface TableProps {
  widths: ArtifactDashboardPrefs["widths"];
  onWidthChange: (column: ArtifactTableSizedColumn, width: number | null) => void;
}

/** The list's reads (ArtifactsDashboard's useAllArtifacts). */
export interface AllArtifacts {
  state: AllState;
  read: (keepRows: boolean) => Promise<void>;
  loadMore: (cursor: string) => void;
}
