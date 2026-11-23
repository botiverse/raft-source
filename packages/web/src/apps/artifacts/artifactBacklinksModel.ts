import type { ArtifactBacklinkMessage, ArtifactKind, ArtifactWebBacklinks } from "@botiverse/raft-shared";

import { isArtifactDrawnKind } from "./artifactDrawnKind";
import type { ArtifactHostConversation } from "./artifactShareHost";

/**
 * "Linked from" (#proj-workspace:#336 step 2, Kirby's design): what links to the Artifact shown, from
 * the backlinks route (useArtifactBacklinks), as the viewer says it. Pure: the parts a test can pin.
 */

/** How many rows a group lists before its "Show all N" (which shows the page, at most ARTIFACT_BACKLINKS_PAGE_LIMIT). */
export const BACKLINKS_FIRST_ROWS = 5;

/** The largest count said as a number; past it (or past the server's count) it is "999+". */
const BACKLINKS_COUNT_SHOWN_MAX = 999;

/** A count as "Linked from N" says it: the number, or "999+" past 999 or where the server stopped counting (`capped`). */
export function backlinksCountText(count: number, capped: boolean): string {
  return capped || count > BACKLINKS_COUNT_SHOWN_MAX ? `${BACKLINKS_COUNT_SHOWN_MAX}+` : String(count);
}

/**
 * How many link the Artifact as this reader is shown it, both groups together: the documents' count,
 * and the discussions' less those on the page the reader's own channel list can't name (`named`: how
 * many of `discussions.items` it names, namedBacklinkMessages), so the count says what the list lists
 * and never how many references the reader can't see (Kirby). When the page has discussions and the
 * reader can name none of them, those past the page are not counted either: they are most likely
 * unnamed too, and counting them would say the list holds more than it shows (Kirby). `capped` when
 * either group's count stopped at the server's cap (the discussions' only while they are counted): the
 * count then says "999+" (backlinksCountText).
 */
export function backlinksTotal(backlinks: ArtifactWebBacklinks, named: number): { count: number; capped: boolean } {
  const { documents, discussions } = backlinks;
  const unnamed = Math.max(0, discussions.items.length - named);
  const discussionCount = discussions.items.length > 0 && named === 0 ? 0 : Math.max(named, discussions.total - unnamed);
  return { count: documents.total + discussionCount, capped: documents.capped || (discussionCount > 0 && discussions.capped) };
}

/**
 * Whether the viewer says anything: there are rows to list, the documents and the discussions the
 * reader's own channel list names (`named`), so the strip and the title's chip never open onto
 * nothing (a group's `items` can be fewer than its count: an item that stopped linking it since it
 * was counted is left out; a discussion in a conversation the reader's list can't name, too).
 * Loading, a failure and an empty answer (null or none) say nothing.
 */
export function backlinksShown(backlinks: ArtifactWebBacklinks | null, named: number): backlinks is ArtifactWebBacklinks {
  if (!backlinks) return false;
  return backlinks.documents.items.length + named > 0 && backlinksTotal(backlinks, named).count > 0;
}

/**
 * Where "Linked from" goes for the file shown: `below`, directly under the content, where Raft draws
 * it itself (a csv, text, an image: the content scrolls in Raft); else `strip`, a strip at the
 * content's foot outside the frame (an HTML page, Markdown or a PDF scrolls inside its frame, which
 * must never hold it: the page's scripts would read it), as for No preview. `fileKind` null: no file.
 * As ArtifactContent decides how the file shown is drawn (`entry`: the version's entry, drawn by
 * `entryKind`; else by its own kind).
 */
export type ArtifactBacklinksPlace = "below" | "strip";

export function backlinksPlace(entryKind: ArtifactKind, fileKind: ArtifactKind | null, entry: boolean): ArtifactBacklinksPlace {
  if (fileKind === null) return "strip";
  return isArtifactDrawnKind(entry ? entryKind : fileKind) ? "below" : "strip";
}

/**
 * A group's rows as listed: the first BACKLINKS_FIRST_ROWS, or all the page's once "Show all" was
 * pressed (`all`); `more`: how many "Show all N" says (the rows it shows), 0 when there is no more.
 */
export function backlinksRows<T>(items: readonly T[], all: boolean): { rows: readonly T[]; more: number } {
  if (all || items.length <= BACKLINKS_FIRST_ROWS) return { rows: items, more: 0 };
  return { rows: items.slice(0, BACKLINKS_FIRST_ROWS), more: items.length };
}

/** A discussion with the conversation it is in, as the reader's own list names it. */
export interface NamedBacklinkMessage {
  message: ArtifactBacklinkMessage;
  conversation: ArtifactHostConversation;
}

/**
 * The discussions the reader's own channel list can name (`nameOf`: the share host's), in order; a
 * message in a conversation it can't name is left out, as the original message's line is
 * (ArtifactOriginLink: never an id, never a name from anywhere else).
 */
export function namedBacklinkMessages(
  items: readonly ArtifactBacklinkMessage[],
  nameOf: (conversationId: ArtifactBacklinkMessage["conversationId"]) => ArtifactHostConversation | null,
): NamedBacklinkMessage[] {
  const named: NamedBacklinkMessage[] = [];
  for (const message of items) {
    const conversation = nameOf(message.conversationId);
    if (conversation) named.push({ message, conversation });
  }
  return named;
}
