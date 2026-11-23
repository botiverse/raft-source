import { createContext } from "react";
import type { IntlShape } from "react-intl";
import type { ArtifactCard, ArtifactSettled } from "@botiverse/raft-shared";

import { artifactAuthorText } from "./artifactAuthorText";
import type { ArtifactDashboardItem } from "./artifactDashboardItems";
import type { ArtifactNews } from "./artifactNews";

/**
 * Settled (#334): someone who may comment on an Artifact marked it done, no longer a draft under discussion; Working
 * is everything else. The card says so (`settled`, `reopened`) only where the Artifact's server has
 * `artifact_settled_v0` on and the reader isn't an outsider to it; absent otherwise, and then nothing of it is shown
 * or offered anywhere (no tag, no Settle in a menu, no Working / Other on the home page).
 */
export const settledShown = (card: Pick<ArtifactCard, "settled">): boolean => card.settled !== undefined;

/** The card with its settled state as this reader's own settle or unsettle left it (its answer). */
export function withSettled<C extends Pick<ArtifactCard, "settled" | "reopened">>(card: C, settled: ArtifactSettled | null): C {
  // Settling again or unsettling ends "Working again since vN" (the server clears it on both).
  return { ...card, settled, reopened: null };
}

/** The rows with the reader's own answers on them (`settled` by Artifact id), until the list is read again. */
export function withOwnSettles(items: ArtifactDashboardItem[], settled: ReadonlyMap<string, ArtifactSettled | null>): ArtifactDashboardItem[] {
  if (settled.size === 0) return items;
  return items.map((item) => {
    const answer = settled.get(item.card.id);
    return answer === undefined ? item : { ...item, card: withSettled(item.card, answer) };
  });
}

/** "Updated in the last 7 days" keeps an Artifact that isn't settled in Working with nothing new for the reader. */
export const WORKING_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which group of the home page an Artifact is in (#334, the prototype's rule 3 and 4): Working, on top, is what is
 * still moving for the reader: not settled, and either new for them (mentions them, a new version, new comments) or
 * updated in the last 7 days; and a settled one with comments they haven't seen or a mention of them (a comment
 * doesn't change its state, but while they have some to read it is here, its Settled tag on it). Everything else is
 * Other: settled ones with nothing to read, and Working ones idle for 7 days with nothing new.
 */
export function isArtifactWorking({ card, news }: Pick<ArtifactDashboardItem, "card" | "news">, now: number): boolean {
  if (card.settled) return news.mentioned || news.newComments > 0;
  if (news.mentioned || news.newerVersion || news.newComments > 0) return true;
  const updated = Date.parse(card.updatedAt);
  return Number.isFinite(updated) && now - updated < WORKING_RECENT_MS;
}

/** Which group the home page put an Artifact in, and on what (decideHomeGroups). */
export interface ArtifactHomeDecision {
  working: boolean;
  /** Decided on the tab's cached page, before the page's own first read answered: the first fresh page decides again. */
  fromCache: boolean;
  /** The reader's last own settle or unsettle it accounts for (ArtifactOwnSettles' sequence number; 0: none). */
  act: number;
}

/**
 * Each row's group on the home page (#334), from the decisions so far: nothing moves while the page is open, so a row
 * already decided keeps its group, through every read again, whatever its news says now. A row is decided (again)
 * only when:
 * - the page lists it for the first time;
 * - it was decided on the tab's cached page (`fromCache`) and this is the page's first fresh one (`fresh`): the cache
 *   is the previous visit's rows (a new mention since must not stay folded in Other, nor an old row in Working);
 * - the reader settled or unsettled it themselves since (`acts`, from the home page's menu or the viewer): their own
 *   act moves it at once, as resolving a comment does. Someone else's settle, or a new version, moves nothing.
 *
 * `items` are the rows as drawn (the reader's own answers on them). Returns `decided` itself when nothing changed.
 */
export function decideHomeGroups(
  decided: ReadonlyMap<string, ArtifactHomeDecision>,
  items: readonly ArtifactDashboardItem[],
  { now, fresh, acts }: { now: number; fresh: boolean; acts: ReadonlyMap<string, number> },
): ReadonlyMap<string, ArtifactHomeDecision> {
  let next: Map<string, ArtifactHomeDecision> | null = null;
  for (const item of items) {
    const id = item.card.id;
    const had = decided.get(id);
    const act = acts.get(id) ?? 0;
    if (had && !(had.fromCache && fresh) && act <= had.act) continue;
    next ??= new Map(decided);
    next.set(id, { working: isArtifactWorking(item, now), fromCache: !fresh, act: Math.max(act, had?.act ?? 0) });
  }
  return next ?? decided;
}

/**
 * The home page's rows in their groups. `working` says each one's group (as it was when the page first listed it:
 * useArtifactHomeGroups). With a title search there are no groups: everything in one run, Working first, each part in
 * the server's order (`working` null, `other` empty). Otherwise Working's rows under their heading, the rest folded
 * at the end.
 */
export interface ArtifactHomeGroups {
  /** Working's rows under their heading; null while a search lists everything in one run (`all`). */
  working: ArtifactDashboardItem[] | null;
  /** The fold's rows (none while searching). */
  other: ArtifactDashboardItem[];
  /** Every row in the order drawn: Working's, then Other's. */
  all: ArtifactDashboardItem[];
}

export function groupArtifactItems(items: readonly ArtifactDashboardItem[], working: (item: ArtifactDashboardItem) => boolean, searching: boolean): ArtifactHomeGroups {
  const top: ArtifactDashboardItem[] = [];
  const rest: ArtifactDashboardItem[] = [];
  for (const item of items) (working(item) ? top : rest).push(item);
  const all = [...top, ...rest];
  return searching ? { working: null, other: [], all } : { working: top, other: rest, all };
}

/** The groups as a view draws them (#334): their rows, and whether Other is unfolded (kept on the device). */
export interface ArtifactHomeSections {
  groups: ArtifactHomeGroups;
  otherOpen: boolean;
  onToggleOther: () => void;
}

/** What the folded Other's own sticker says: everything new inside it, so folding hides no mention. */
export function foldNews(items: readonly ArtifactDashboardItem[]): ArtifactNews {
  return {
    mentioned: items.some((item) => item.news.mentioned),
    newerVersion: items.some((item) => item.news.newerVersion),
    newComments: items.reduce((sum, item) => sum + item.news.newComments, 0),
  };
}

/** "Nov 19, 14:02" in the reader's locale (the app module keeps its own: core's time formatting is not among its imports). */
function shortDateTime(at: string, locale: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** What a refused settle or unsettle says, by the server's code. */
export function settleRefusal(code: string | null): "artifacts.settled.forbidden" | "artifacts.settled.failed" {
  return code === "FORBIDDEN" ? "artifacts.settled.forbidden" : "artifacts.settled.failed";
}

/**
 * Who settled it, when and at which version, in words: "Remy settled it on Nov 19, 14:02 (v3)", the reader's own as
 * "You". The Settled tag's tooltip and the details' Status section say it.
 */
export function artifactSettledLine(settled: ArtifactSettled, readerId: string | null, { formatMessage, locale }: Pick<IntlShape, "formatMessage" | "locale">): string {
  return formatMessage({ id: "artifacts.settled.line" }, {
    name: artifactAuthorText(settled.by, readerId, formatMessage).name,
    time: shortDateTime(settled.at, locale),
    version: settled.version,
  });
}

/** The home page's Settle / Unsettle (useArtifactHomeGroups), for its tiles' and rows' menu (ArtifactHomeMenu). */
export interface ArtifactHomeSettle {
  /** Settle or unsettle it; settles once answered (a refusal said why in a toast). */
  setSettled: (card: ArtifactCard, settled: boolean) => Promise<void>;
  /** Being asked: its menu item waits. */
  pending: ReadonlySet<string>;
}

/** The home page's Settle / Unsettle; none elsewhere, nor with the flag off. */
export const ArtifactHomeSettleContext = createContext<ArtifactHomeSettle | null>(null);
