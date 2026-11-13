/**
 * The layout of the sections right of the conversation (task v2, task #165;
 * #proj-raft-ui:#189 rule 7): Thread, Tasks, Files, the Artifact, the
 * profile and the channel details, in one or more columns right of the conversation, each column a
 * vertical stack. One per person per server: the web reads and
 * writes it, the server stores it on the member (`channel_side_layout`,
 * through PATCH /servers/:id/sidebar-order) after checking its shape here.
 *
 * Only the shape is checked: a stored value that is not one (an unknown
 * section, too many columns, a width out of range) reads as "never saved",
 * and the default applies. Fitting the columns into a window (minimum widths,
 * floating a column that doesn't fit) is the web's, at render time; it never
 * rewrites what is saved.
 */

export const CHANNEL_SIDE_SECTIONS = ["thread", "tasks", "files", "artifact", "profile", "context", "details"] as const;
export type ChannelSideSection = typeof CHANNEL_SIDE_SECTIONS[number];

export interface ChannelSideLayoutColumn {
  /** Top to bottom; every section is in exactly one column. */
  sections: ChannelSideSection[];
  /** The column's width in px when there is room for it. */
  width: number;
}

export interface ChannelSideLayout {
  v: 1;
  /** Left to right, right of the conversation. */
  columns: ChannelSideLayoutColumn[];
}

/** At most four side columns (#189 rule 7), besides a column of the thread's own: the thread is a layer of the conversation. */
export const CHANNEL_SIDE_MAX_COLUMNS = 4;
/** A column may be dragged as narrow as 160 (#proj-raft-ui:#189, rule 2); its sections keep their own minimum, clipped. */
export const CHANNEL_SIDE_MIN_SAVED_WIDTH = 160;
export const CHANNEL_SIDE_MAX_SAVED_WIDTH = 4000;

/** A section's narrowest readable width; a column's is its widest section's (`columnMinWidth`). */
export const CHANNEL_SIDE_SECTION_MIN_WIDTH: Record<ChannelSideSection, number> = {
  thread: 360,
  tasks: 280,
  files: 280,
  artifact: 480,
  profile: 320,
  context: 320,
  details: 320,
};

/**
 * The sections that follow the profile (the context behind one of an agent's
 * messages, View Context; the channel details, which share the profile's
 * column and width, raft-design channel.md, stdrc 2026-11-10): placed under
 * it, carried with it, never left alone in a column (`foldFollowerOnlyColumns`),
 * so a closed one never takes one of the four side columns.
 */
const PROFILE_FOLLOWERS: readonly ChannelSideSection[] = ["context", "details"];
const followsProfile = (section: ChannelSideSection) => PROFILE_FOLLOWERS.includes(section);

/**
 * Before anyone drags: the thread in a column of its own, Tasks over Files right of it, then the Artifact, then the
 * profile with the context view and the channel details under it (one more column of its own would leave no room for
 * a drop to make one).
 */
export const DEFAULT_CHANNEL_SIDE_LAYOUT: ChannelSideLayout = {
  v: 1,
  columns: [
    { sections: ["thread"], width: 400 },
    { sections: ["tasks", "files"], width: 360 },
    { sections: ["artifact"], width: 480 },
    { sections: ["profile", "context", "details"], width: 400 },
  ],
};

/** A section's column of its own where it has none to keep (a new one, or out of a stack): the default layout's. */
export function channelSideSectionWidth(section: ChannelSideSection): number {
  return DEFAULT_CHANNEL_SIDE_LAYOUT.columns.find((column) => column.sections.includes(section))?.width ?? 360;
}

/** The thread's column of its own doesn't count among the side columns (CHANNEL_SIDE_MAX_COLUMNS). */
function sideColumnCount(columns: readonly ChannelSideLayoutColumn[]): number {
  return columns.filter((column) => !(column.sections.length === 1 && column.sections[0] === "thread")).length;
}

function isSection(value: unknown): value is ChannelSideSection {
  return typeof value === "string" && (CHANNEL_SIDE_SECTIONS as readonly string[]).includes(value);
}

/**
 * The layout `raw` is, or null when it is not one: `v` 1; 1 to 4 side columns
 * (and the thread's own); each with at least one section, no section twice in the whole layout; an
 * integer width from 160 to 4000. A section this build doesn't know (saved by
 * a newer client, or a retired one such as the execution record's "record") is
 * dropped, and a column left with none goes too, so an
 * older reader keeps the person's layout instead of falling back to the
 * default. Sections missing from it are allowed (a
 * layout saved before a section existed): `completeChannelSideLayout` places
 * them. Returns a fresh copy without any other keys.
 */
export function parseChannelSideLayout(raw: unknown): ChannelSideLayout | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { v, columns } = raw as { v?: unknown; columns?: unknown };
  if (v !== 1 || !Array.isArray(columns) || columns.length === 0 || columns.length > CHANNEL_SIDE_MAX_COLUMNS + 1) return null;
  const seen = new Set<ChannelSideSection>();
  const parsed: ChannelSideLayoutColumn[] = [];
  for (const column of columns) {
    if (!column || typeof column !== "object" || Array.isArray(column)) return null;
    const { sections, width } = column as { sections?: unknown; width?: unknown };
    if (!Array.isArray(sections) || sections.length === 0) return null;
    if (typeof width !== "number" || !Number.isInteger(width) || width < CHANNEL_SIDE_MIN_SAVED_WIDTH || width > CHANNEL_SIDE_MAX_SAVED_WIDTH) return null;
    const own: ChannelSideSection[] = [];
    for (const section of sections) {
      // A section this build doesn't know (a newer client's): dropped, the rest of the layout kept.
      if (!isSection(section)) continue;
      if (seen.has(section)) return null;
      seen.add(section);
      own.push(section);
    }
    // A column of only unknown sections goes with them.
    if (own.length > 0) parsed.push({ sections: own, width });
  }
  if (parsed.length === 0 || sideColumnCount(parsed) > CHANNEL_SIDE_MAX_COLUMNS) return null;
  return { v: 1, columns: parsed };
}

/**
 * Every section placed exactly once: a section the layout lacks goes where the
 * default puts it, after the sections it follows there (the thread into a new
 * first column; Tasks or Files under the other one, or into a new last column;
 * the Artifact and the profile, saved before they were sections, into a new
 * last column, or at the bottom of the last one where there is none to make;
 * the context view and the channel details, added later, under the profile,
 * else the same way). A column holding only those is not kept: it goes under
 * the profile.
 */
export function completeChannelSideLayout(layout: ChannelSideLayout): ChannelSideLayout {
  const columns = layout.columns.map((column) => ({ sections: [...column.sections], width: column.width }));
  const placed = new Set(columns.flatMap((column) => column.sections));
  for (const section of CHANNEL_SIDE_SECTIONS) {
    if (placed.has(section)) continue;
    const profileColumn = followsProfile(section) ? columns.find((column) => column.sections.includes("profile")) : undefined;
    if (section === "thread") {
      columns.unshift({ sections: ["thread"], width: DEFAULT_CHANNEL_SIDE_LAYOUT.columns[0].width });
    } else if (profileColumn) {
      profileColumn.sections.push(section);
    } else if (section === "artifact" || section === "profile" || followsProfile(section)) {
      if (sideColumnCount(columns) < CHANNEL_SIDE_MAX_COLUMNS) columns.push({ sections: [section], width: channelSideSectionWidth(section) });
      else columns[columns.length - 1].sections.push(section);
    } else {
      let sibling: ChannelSideLayoutColumn | undefined;
      for (const column of columns) if (column.sections.some((s) => s === "tasks" || s === "files")) sibling = column;
      if (sibling) sibling.sections.push(section);
      else if (sideColumnCount(columns) < CHANNEL_SIDE_MAX_COLUMNS) columns.push({ sections: [section], width: DEFAULT_CHANNEL_SIDE_LAYOUT.columns[1].width });
      else columns[columns.length - 1].sections.push(section);
    }
    placed.add(section);
  }
  return foldFollowerOnlyColumns({ v: 1, columns });
}

/** A column's narrowest readable width: its widest section's minimum. */
export function channelSideColumnMinWidth(sections: readonly ChannelSideSection[]): number {
  return Math.max(0, ...sections.map((section) => CHANNEL_SIDE_SECTION_MIN_WIDTH[section]));
}

export interface VisibleChannelSideColumn {
  /** The column's index in the layout. */
  column: number;
  /** Its open sections, top to bottom. */
  sections: ChannelSideSection[];
  width: number;
  minWidth: number;
}

/** The columns with an open section, left to right; a column with none shows nothing. */
export function visibleChannelSideColumns(layout: ChannelSideLayout, open: ReadonlySet<ChannelSideSection>): VisibleChannelSideColumn[] {
  const visible: VisibleChannelSideColumn[] = [];
  layout.columns.forEach((column, index) => {
    const sections = column.sections.filter((section) => open.has(section));
    if (sections.length > 0) visible.push({ column: index, sections, width: column.width, minWidth: channelSideColumnMinWidth(sections) });
  });
  return visible;
}

/**
 * Where a dragged section lands: into a column before its visible section
 * `before` (null: at the bottom), or as a new column before the column `at`
 * (the layout's index; `columns.length` for a new last column). Indices are
 * the layout's; `before` names a section, so closed sections in between do
 * not shift it.
 */
export type ChannelSideDrop =
  | { kind: "into"; column: number; before: ChannelSideSection | null }
  | { kind: "newColumn"; at: number };

/**
 * The layout with `section` moved to `drop`. A column left with no section at
 * all disappears; one left with only closed sections stays (they show there
 * when opened). A section moved out alone keeps its column's width; out of a
 * stack it takes its own default width (the stack keeps its width). Returns
 * the layout unchanged when the drop is where the section already is, or would
 * make a fifth side column. The profile carries the context view sitting
 * right under it, and no column is left holding only that (it goes under the
 * profile).
 */
export function moveChannelSideSection(layout: ChannelSideLayout, section: ChannelSideSection, drop: ChannelSideDrop): ChannelSideLayout {
  const from = layout.columns.findIndex((column) => column.sections.includes(section));
  if (from < 0) return layout;
  const moving = movingSections(layout.columns[from].sections, section);
  const without = (column: ChannelSideLayoutColumn) => ({ sections: column.sections.filter((s) => !moving.includes(s)), width: column.width });
  if (drop.kind === "into") {
    if (drop.column < 0 || drop.column >= layout.columns.length || (drop.before !== null && moving.includes(drop.before))) return layout;
    const target = layout.columns[drop.column];
    if (drop.before !== null && !target.sections.includes(drop.before)) return layout;
    const columns = layout.columns.map(without);
    const into = columns[drop.column];
    const at = drop.before === null ? into.sections.length : into.sections.indexOf(drop.before);
    into.sections.splice(at, 0, ...moving);
    const next = foldFollowerOnlyColumns({ v: 1 as const, columns: columns.filter((column) => column.sections.length > 0) });
    return sameLayout(next, layout) ? layout : next;
  }
  if (drop.at < 0 || drop.at > layout.columns.length) return layout;
  const alone = layout.columns[from].sections.every((s) => moving.includes(s));
  // Dropping a section that is alone in its column at either of its own edges changes nothing.
  if (alone && (drop.at === from || drop.at === from + 1)) return layout;
  // Its saved width goes with it (#189 rule 7): alone, its column's; out of a stack, its own default.
  const width = alone ? layout.columns[from].width : channelSideSectionWidth(section);
  const columns: ChannelSideLayoutColumn[] = layout.columns.map(without);
  columns.splice(drop.at, 0, { sections: [...moving], width });
  const next = foldFollowerOnlyColumns({ v: 1 as const, columns: columns.filter((column) => column.sections.length > 0) });
  if (sameLayout(next, layout)) return layout;
  return sideColumnCount(next.columns) > CHANNEL_SIDE_MAX_COLUMNS ? layout : next;
}

/**
 * What a move of `section` takes along: the profile carries the context view
 * sitting right under it (where it was placed, and stays until moved by
 * itself), so a closed one never stays behind alone.
 */
function movingSections(sections: readonly ChannelSideSection[], section: ChannelSideSection): ChannelSideSection[] {
  if (section !== "profile") return [section];
  const moving: ChannelSideSection[] = ["profile"];
  for (let at = sections.indexOf("profile") + 1; at < sections.length && followsProfile(sections[at]); at += 1) moving.push(sections[at]);
  return moving;
}

/**
 * A column holding only the context view is not kept: it goes under the
 * profile instead, among what already follows it.
 * Such a column, its sections closed, would show nothing and still count among
 * the four side columns (CHANNEL_SIDE_MAX_COLUMNS).
 */
function foldFollowerOnlyColumns(layout: ChannelSideLayout): ChannelSideLayout {
  const withProfile = layout.columns.findIndex((column) => column.sections.includes("profile"));
  const lone = layout.columns.filter((column) => column.sections.every(followsProfile));
  if (lone.length === 0 || withProfile < 0) return layout;
  const columns = layout.columns
    .filter((column) => !lone.includes(column))
    .map((column) => ({ sections: [...column.sections], width: column.width }));
  const profile = columns.find((column) => column.sections.includes("profile"))?.sections;
  if (!profile) return layout;
  const start = profile.indexOf("profile") + 1;
  let end = start;
  while (end < profile.length && followsProfile(profile[end])) end += 1;
  // The run under the profile, in the default's order.
  const run = [...profile.slice(start, end), ...lone.flatMap((column) => column.sections)]
    .sort((x, y) => PROFILE_FOLLOWERS.indexOf(x) - PROFILE_FOLLOWERS.indexOf(y));
  profile.splice(start, end - start, ...run);
  return { v: 1, columns };
}

/** The layout with column `column` `width` px wide (rounded, within the saved range). */
export function resizeChannelSideColumn(layout: ChannelSideLayout, column: number, width: number): ChannelSideLayout {
  if (column < 0 || column >= layout.columns.length) return layout;
  const clamped = Math.round(Math.min(CHANNEL_SIDE_MAX_SAVED_WIDTH, Math.max(CHANNEL_SIDE_MIN_SAVED_WIDTH, width)));
  if (layout.columns[column].width === clamped) return layout;
  return { v: 1, columns: layout.columns.map((c, i) => (i === column ? { sections: [...c.sections], width: clamped } : c)) };
}

export function sameLayout(a: ChannelSideLayout, b: ChannelSideLayout): boolean {
  return a.columns.length === b.columns.length && a.columns.every((column, i) => {
    const other = b.columns[i];
    return column.width === other.width && column.sections.length === other.sections.length && column.sections.every((s, j) => s === other.sections[j]);
  });
}
