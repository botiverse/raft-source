/**
 * One row for the three compact lists of task v2: the tasks under a message,
 * the Tasks card and the Files card (raft-design patterns/tasks.md, "Rows in a
 * compact list"). Like a DS ListRow list it is content: hairlines between the
 * rows, the whole row the target, no card per row.
 *
 * - Row: one line, at least 36px with a mouse and 44px on a phone or a touch
 *   screen, 6px above and below. Its inline padding is the margin of the
 *   column it sits in (`--compact-row-inset`): 20px in a side section (16px on
 *   a phone), so a row starts on the section head's line; 12px inside the
 *   box under a message.
 * - Leading (optional), the title on one line with its inline meta right
 *   after it, then a trailing group at the right that wraps, whole, to a
 *   second line (still at the right) when the row has no room for both.
 * - Hairlines between rows, as far as the list's container visibly goes
 *   (raft-design foundations/comfort.md, Separators): in the box under a
 *   message and in the Tasks page's box they meet its border; in a side
 *   card or a phone page, where the list has no edge of its own, they are
 *   inset like the content.
 * - Hover lays the row-hover overlay over the whole row, press the pressed
 *   overlay, keyboard focus an inset ring.
 */

/** The list in a side section or on a phone page: the rows run edge to edge;
 *  the list is one part of the section (header, filter, group headings) or
 *  of a page with no edge, so its lines are inset like the content: on the
 *  panel head's margin, 20px on a desktop and 16px on a phone. */
export const COMPACT_LIST_BLEED = "flex w-full min-w-0 flex-col [--compact-row-inset:1rem] md:[--compact-row-inset:1.25rem]";

/** The list under a message: a box sized by its content (320px to the
 *  message column), like an attachment. The box holds only the rows, so its
 *  lines meet its border (`--compact-row-divider-inset: 0`). */
export const COMPACT_LIST_BOXED = "flex w-fit min-w-[min(320px,100%)] max-w-full flex-col overflow-hidden rounded-control border border-line-hairline bg-layer-card [--compact-row-inset:0.75rem] [--compact-row-divider-inset:0px]";

/** Layout, size and dividers of one row (no states: see the two below).
 *  A hairline above every row but the first, `--compact-row-divider-inset`
 *  in from both edges: 0 in the box under a message or on the Tasks page,
 *  so it meets the box's border; otherwise the row's inline padding, so it starts and ends where
 *  the row's content does (raft-design patterns/tasks.md, "Dividers"). It is
 *  drawn on `before:`, so the row's hover still fills the whole row. */
export const COMPACT_ROW_DIVIDER = "before:pointer-events-none before:absolute before:top-0 before:inset-x-[var(--compact-row-divider-inset,var(--compact-row-inset,0.75rem))] before:border-t before:border-line-hairline before:content-[''] first:before:hidden";
/** The row's layout and size, without its divider or padding at the start
 *  (COMPACT_ROW adds both; a selectable row's wrapper draws the divider and
 *  holds its check box where the start padding would be). */
export const COMPACT_ROW_BODY = "relative flex w-full min-w-0 min-h-11 flex-wrap content-center items-baseline gap-x-2 gap-y-1 leading-(--text-callout--line-height) pr-[var(--compact-row-inset,0.75rem)] [&>svg]:self-center [&>[data-avatar-context]]:self-center [&>[data-row-mark]]:self-center py-1.5 text-left md:pointer-fine:min-h-(--row-height) md:pointer-fine:py-[5.5px]";
export const COMPACT_ROW = `${COMPACT_ROW_BODY} pl-[var(--compact-row-inset,0.75rem)] ${COMPACT_ROW_DIVIDER}`;

/** A row that is itself the button (a task). */
export const COMPACT_ROW_BUTTON = `group ${COMPACT_ROW} outline-none hover:overlay-subtle active:overlay-medium focus-visible:inset-ring-2 focus-visible:inset-ring-ink`;

/**
 * A row that can be selected (the Tasks page, raft-design patterns/tasks.md
 * with DS States › List cells): the row is a list cell holding the check box
 * and the row button. Hover and press fill the whole cell, the box's gutter
 * included; the divider sits on the cell, at the list's divider inset (the
 * page's box: full bleed). Selected, or open beside the list, it takes the
 * cell's selected fill.
 */
export const COMPACT_ROW_SELECTABLE = "group/select relative isolate flex w-full min-w-0 items-stretch [-webkit-touch-callout:none] hover:overlay-subtle active:overlay-medium before:pointer-events-none before:absolute before:top-0 before:inset-x-[var(--compact-row-divider-inset,var(--compact-row-inset,0.75rem))] before:z-raised before:border-t before:border-line-hairline before:content-[''] first:before:hidden data-[selected]:bg-fill-cell-selected data-[current]:bg-fill-cell-selected";

/** The check box's gutter at the cell's inner start: 12px by touch, 8px with a mouse, a 20px slot. */
export const COMPACT_ROW_SELECT_GUTTER = "flex shrink-0 items-center pl-3 md:pointer-fine:pl-2";

/** The row button inside a selectable cell: the row's body, 8px after the box, no hover of its own. */
export const COMPACT_ROW_SELECTABLE_BUTTON = `${COMPACT_ROW_BODY} min-w-0 flex-1 pl-2 outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ink`;

/** The list of selectable rows on the Tasks page: a box with the rows edge to edge (raft-design patterns/tasks.md).
 *  The box holds only the rows, so its lines run full bleed to its border (foundations/comfort.md, Separators: a line
 *  runs as far as its container visibly goes), as the box under a message. */
export const COMPACT_LIST_PAGE = "flex w-full min-w-0 flex-col overflow-hidden rounded-container border border-line-hairline bg-layer-card [--compact-row-inset:0.75rem] [--compact-row-divider-inset:0px]";

/** A row whose main button sits beside its own action buttons (a file): the
 *  row takes the hover; the main button stretches over it (see
 *  COMPACT_ROW_STRETCHED, which also lays the press) and the actions sit on
 *  top. */
export const COMPACT_ROW_WITH_ACTIONS = `group ${COMPACT_ROW} hover:overlay-subtle`;

/** The main button of a row with actions: its hit area covers the row, its
 *  focus ring draws around the row. It holds the 20px leading block too, so
 *  its basis is the title's 160px plus that block and its 8px gap, capped at
 *  its content as the title group's is. */
export const COMPACT_ROW_STRETCHED = "flex min-w-0 max-w-max flex-[1_1_calc(10rem+28px)] items-baseline gap-2 [&>svg]:self-center [&>[data-avatar-context]]:self-center [&>[data-row-mark]]:self-center text-left outline-none after:absolute after:inset-0 after:content-[''] active:after:overlay-medium focus-visible:after:inset-ring-2 focus-visible:after:inset-ring-ink";

/** The title and its inline meta: the title gives up only the room the row
 *  lacks, so the meta follows its last word or its ellipsis. Its basis keeps
 *  160px for a readable title before the trailing group wraps; capped at its
 *  own content (`max-w-max`), so a title shorter than that doesn't claim the
 *  160px and wrap a trailing group that fits beside it. */
export const COMPACT_ROW_TITLE_GROUP = "flex min-w-0 max-w-max flex-[1_1_10rem] items-baseline gap-1.5 [&>svg]:self-center [&>[data-avatar-context]]:self-center [&>[data-row-mark]]:self-center";
/** Texts of different sizes on a row share its first baseline; marks without
 *  text (icons, avatars, a file's visual, action buttons: `data-row-mark`) are
 *  centred (raft-design foundations/alignment.md). The row and each group in
 *  it align on the baseline and centre their marks.
 *
 *  Every text on the row takes the title's line height: COMPACT_ROW's
 *  `leading-*` for theme sizes (they read `--tw-leading`), and an explicit
 *  one on the sizes that set their own (Space Mono meta, the assignee's
 *  caption).
 *  A group is placed by the baseline of its own first text, so with a
 *  smaller text's shorter line (Space Mono meta, a name) the group's box sat
 *  lower than the title's line, a mark centred in it sat lower than the row's
 *  centre, and a mark taller than that line made the row taller with the
 *  text above the hover fill's centre. One line box for the whole row keeps
 *  every group's box on the title's line. */
export const COMPACT_ROW_TITLE = "min-w-0 truncate text-callout text-foreground";
/** The Tasks page's title group: all the room the row has left (not just its
 *  own content), so the title wraps instead of pushing the row wider. */
export const COMPACT_ROW_TITLE_GROUP_WRAP = "flex min-w-0 flex-[1_1_10rem] items-baseline gap-1.5 [&>svg]:self-center [&>[data-avatar-context]]:self-center [&>[data-row-mark]]:self-center";
/** The Tasks page's title: wraps, breaking anywhere a long word would overflow (Raft DS › Table). */
export const COMPACT_ROW_TITLE_WRAP = "min-w-0 text-callout text-foreground [overflow-wrap:anywhere]";

/** The trailing group: at the right, wrapping as a whole. */
export const COMPACT_ROW_TRAILING = "ml-auto flex min-w-0 shrink-0 items-baseline gap-2 [&>svg]:self-center [&>[data-avatar-context]]:self-center [&>[data-row-mark]]:self-center";

/** Leading and meta text in Space Mono. */
export const COMPACT_ROW_MONO = "shrink-0 font-mono text-mono-meta leading-(--text-callout--line-height) text-foreground-hint";
