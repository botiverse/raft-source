// The fake data source's list order (fakeArtifactSource.ts `dashboardAll`), as the server answers `sort`, `dir`,
// `relevant` and the cursor (server webDashboardAllOrder.ts): `updated` (the default, newest first), `title` (any case,
// from A), `comments` (the card's commentCount, the most first) or `opened` (the row's openedAt, latest first, then by
// update), each then by id in the same direction; `dir` flips it, and what was never opened stays last either way.
// `relevant` fixes the order, whatever `sort` says: what has news first, among it what mentions the reader first, then
// the rest; each by update, newest first.
// The cursor is an offset here: newest update first keeps the plain one (`"3"`), every other order names itself
// (`"title:asc:3"`, `"relevant:3"`), so a cursor pages only its own order; anything else is 400 INVALID_REQUEST, as the server's.
import { ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS, ARTIFACT_DASHBOARD_ALL_DIRS, ARTIFACT_DASHBOARD_ALL_SORTS } from "@botiverse/raft-shared";
import type { ArtifactCard, ArtifactDashboardAllDir, ArtifactDashboardAllRow, ArtifactDashboardAllSort } from "@botiverse/raft-shared";

import type { ArtifactApiError } from "./artifactApi";

const invalid = (): ArtifactApiError => ({ status: 400, code: "INVALID_REQUEST" });

const byId = (a: ArtifactCard, b: ArtifactCard) => a.id.localeCompare(b.id);
const byUpdate = (a: ArtifactCard, b: ArtifactCard) => a.updatedAt.localeCompare(b.updatedAt) || byId(a, b);

/** Ascending by each sort's key, then by id; `opened` only among what was opened. */
const ASCENDING: Record<ArtifactDashboardAllSort, (a: ArtifactDashboardAllRow, b: ArtifactDashboardAllRow) => number> = {
  updated: (a, b) => byUpdate(a.card, b.card),
  title: (a, b) => {
    const [x, y] = [a.card.title.toLowerCase(), b.card.title.toLowerCase()];
    return (x < y ? -1 : x > y ? 1 : 0) || byId(a.card, b.card);
  },
  comments: (a, b) => a.card.commentCount - b.card.commentCount || byId(a.card, b.card),
  opened: (a, b) => (a.openedAt ?? "").localeCompare(b.openedAt ?? "") || byUpdate(a.card, b.card),
};

const opened = (row: ArtifactDashboardAllRow) => (row.openedAt ?? null) !== null;
/** `relevant`'s tier, as the server's: 2 waiting on the reader, 1 other news, 0 none. */
const tier = ({ news }: ArtifactDashboardAllRow) => (!news ? 0 : news.mentions > 0 ? 2 : news.versions > 0 || news.comments > 0 ? 1 : 0);

function compare(sort: ArtifactDashboardAllSort, dir: ArtifactDashboardAllDir) {
  const directed = (a: ArtifactDashboardAllRow, b: ArtifactDashboardAllRow) => (dir === "asc" ? ASCENDING[sort](a, b) : ASCENDING[sort](b, a));
  return sort === "opened" ? (a: ArtifactDashboardAllRow, b: ArtifactDashboardAllRow) => Number(opened(b)) - Number(opened(a)) || directed(a, b) : directed;
}

const relevantFirst = (a: ArtifactDashboardAllRow, b: ArtifactDashboardAllRow) => tier(b) - tier(a) || byUpdate(b.card, a.card);

/**
 * One page of `rows` in the order the options ask, `pageSize` a page after `cursor` (a nextCursor of the same order);
 * throws 400 INVALID_REQUEST for a sort, dir or cursor the server would refuse.
 */
export function fakeDashboardAllPage(
  rows: readonly ArtifactDashboardAllRow[],
  options: { sort?: ArtifactDashboardAllSort; dir?: ArtifactDashboardAllDir; cursor?: string; relevant?: boolean },
  pageSize: number,
): { rows: ArtifactDashboardAllRow[]; nextCursor: string | null } {
  const sort = options.sort ?? "updated";
  if (!(ARTIFACT_DASHBOARD_ALL_SORTS as readonly string[]).includes(sort)) throw invalid();
  const dir = options.dir ?? ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS[sort];
  if (!(ARTIFACT_DASHBOARD_ALL_DIRS as readonly string[]).includes(dir)) throw invalid();
  const prefix = options.relevant ? "relevant:" : sort === "updated" && dir === "desc" ? "" : `${sort}:${dir}:`;
  let offset = 0;
  if (options.cursor !== undefined) {
    const rest = options.cursor.startsWith(prefix) ? options.cursor.slice(prefix.length) : "";
    offset = /^\d+$/.test(rest) ? Number(rest) : -1;
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid();
  }
  const ordered = [...rows].sort(options.relevant ? relevantFirst : compare(sort, dir));
  const end = offset + pageSize;
  return { rows: ordered.slice(offset, end), nextCursor: end < ordered.length ? `${prefix}${end}` : null };
}
