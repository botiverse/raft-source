import type { ArtifactCard, ArtifactDashboardAllRow } from "@botiverse/raft-shared";

import { artifactNewsOf } from "./artifactNews";
import type { ArtifactNews } from "./artifactNews";

/**
 * One Artifact as the home page draws it: its card, what is new on it (the
 * sticker), and when the reader last opened it, which a tile shows instead of
 * the update time while the rows are in that order (design: the last line
 * follows the sort).
 */
export interface ArtifactDashboardItem {
  card: ArtifactCard;
  news: ArtifactNews;
  openedAt: string | null;
}

/** `byOpened`: the rows are in the order they were opened; in any other a time saying so would read as out of order. */
export function allItems(rows: readonly ArtifactDashboardAllRow[], byOpened: boolean): ArtifactDashboardItem[] {
  return rows.map((row) => ({ card: row.card, news: artifactNewsOf(row.news), openedAt: byOpened ? row.openedAt ?? null : null }));
}
