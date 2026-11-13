/**
 * The Raft Design System's themes (raft-design `packages/ui/src/themes.json`,
 * design/foundations/themes.md). A person picks one per server; it is stored
 * on their membership. `raft` is the foundation itself, the default.
 */
export const RAFT_THEME_IDS = [
  "raft",
  "boring",
  "bots",
  "critters",
  "space",
  "desk",
  "food",
  "quest",
  "weather",
  "plants",
  "spooky",
] as const;

export type RaftThemeId = (typeof RAFT_THEME_IDS)[number];

/** Only on a server whose plan is not Free; elsewhere it is kept but shown as `raft`. */
export const PRO_RAFT_THEME_IDS: readonly RaftThemeId[] = ["boring"];

export function isRaftThemeId(value: unknown): value is RaftThemeId {
  return typeof value === "string" && (RAFT_THEME_IDS as readonly string[]).includes(value);
}

/**
 * The theme a member sees: their choice, except a Pro theme on a Free server,
 * which shows as `raft` and comes back when the server is on a paid plan again.
 */
export function effectiveRaftTheme(choice: RaftThemeId | null | undefined, serverPlanIsFree: boolean): RaftThemeId {
  if (!choice) return "raft";
  if (serverPlanIsFree && PRO_RAFT_THEME_IDS.includes(choice)) return "raft";
  return choice;
}

/** The themes whose series draws pixel art on the frame (the decor a member can turn off). */
export function raftThemeHasDecor(theme: RaftThemeId): boolean {
  return theme !== "raft" && theme !== "boring";
}

/** Whether the frame's pixel art shows: the theme has some and the member has not turned it off. */
export function raftThemeDecorShown(theme: RaftThemeId, themeDecor: boolean | null | undefined): boolean {
  return themeDecor !== false && raftThemeHasDecor(theme);
}
