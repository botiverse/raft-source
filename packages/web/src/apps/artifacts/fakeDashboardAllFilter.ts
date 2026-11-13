// The fake data source's list filter (fakeArtifactSource.ts `dashboardAll`), as the server answers `q` and `relevant`:
// every word of `q` in the title (lower case; the server's tokenizer stands in), and `relevant` keeping what the reader
// is involved with (published, follows, mentioned on by someone else; read or not). Beside it, how many of the matching
// rows have news (`counts.relevant`, the toggle's badge). The order and the page are fakeDashboardAllOrder.ts's.
import type { ArtifactCard, ArtifactDashboardAllNews, ArtifactDashboardAllRow } from "@botiverse/raft-shared";

type NewsRow = ArtifactDashboardAllRow & { news: ArtifactDashboardAllNews };

/**
 * The rows of `entries` the options keep (`rowOf` makes each one's row, `involved` says whether the reader is involved
 * with it), and how many rows matching `q` have news, whether `relevant` is on or not.
 */
export function fakeDashboardAllListed<E extends { card: ArtifactCard }>(
  entries: readonly E[],
  options: { q?: string; relevant?: boolean },
  rowOf: (entry: E) => NewsRow,
  involved: (entry: E) => boolean,
): { listed: NewsRow[]; withNews: number } {
  const words = (options.q ?? "").trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  const rows = entries
    .filter(({ card }) => words.every((word) => card.title.toLowerCase().includes(word)))
    .map((entry) => ({ entry, row: rowOf(entry) }));
  const withNews = rows.filter(({ row: { news } }) => news.mentions > 0 || news.versions > 0 || news.comments > 0).length;
  const listed = (options.relevant ? rows.filter(({ entry }) => involved(entry)) : rows).map(({ row }) => row);
  return { listed, withNews };
}
