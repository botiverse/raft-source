/**
 * A line of the toolbar over a list (Raft DS › Spacing › Heights, Patterns ›
 * Responsive › The toolbar over a list): on a desktop the header height, 44px
 * with its seam (the header air, the 34px controls, the air less the seam);
 * on a phone and a touch screen 49px (8px air, the 32px controls, 8px air,
 * the seam). The page's padding around its FitToolbar, which sets only the
 * 8px between its two lines. The sides are the page's own.
 */
export const LIST_TOOLBAR_AIR_CLASS =
  "border-b border-line-seam bg-layer-canvas py-2 md:pointer-fine:pt-(--header-air) md:pointer-fine:pb-[calc(var(--header-air)-1px)]";

/**
 * The give-way steps of a list's toolbar, in the order of Raft DS › The
 * toolbar over a list, for FitToolbar's `labelOrder`, `wrapOrder`,
 * `plusOrder`, `collapseOrder` and `moreOrder`.
 */
export const LIST_TOOLBAR_STEP = {
  /** 1. The sort, the grouping and the view switch show only their icons. */
  displayLabels: 10,
  /** 2. The filters show only their icons, all at once (Clear all with them). */
  filterLabels: 20,
  /** 3. The filters move to a scrolling second line, their labels back. */
  filtersWrap: 30,
  /**
   * A secondary add action (Invite human beside Create agent) shows only its
   * icon, its words kept as its name and tooltip: just before the primary
   * becomes +, which keeps its words the longest (Raft DS › FitToolbar).
   */
  secondaryLabels: 35,
  /** 4. The primary action becomes +. */
  primaryPlus: 40,
  /** 5. The scope's segmented control becomes a Select. */
  scopeSelect: 50,
  /**
   * 6. The sort, the grouping and the view switch fold into More together,
   * and a secondary add action with them (Invite human, a More item then).
   */
  displayMore: 60,
  /** 7. An empty search becomes its icon button. */
  searchButton: 70,
} as const;

/**
 * A toolbar group holding only More (⋯): while More is hidden it takes no
 * room, and the toolbar's 8px gap before it is taken back, so the search
 * reaches the line's end (Members at 420 stopped 8px short).
 */
export const LIST_TOOLBAR_MORE_GROUP_CLASS = "gap-2 not-has-[[data-fit-shown]]:-ml-2";
