// The comment list's order and areas (#proj-workspace comment list v2, xxchan's approved prototype):
// the parts with no React in them. How the list sorts its threads (Last updated, Page order), which
// comments are new to the reader, and where each thread stands while the list is open.
import type { ArtifactCardUnseen, ArtifactComment, ArtifactCommentId, ArtifactFile } from "@botiverse/raft-shared";
import type { AnchorResult } from "@botiverse/porthole";

import type { ArtifactViewerActor } from "./artifactApi";
import { anchorOf, groupThreads, isOwnComment, isResolvedThread, mentionToken } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";

/** The list's sorts: by the thread's last comment, newest first (the default); by where it is in the page. */
export const ARTIFACT_COMMENT_SORTS = ["updated", "page"] as const;
export type ArtifactCommentSort = (typeof ARTIFACT_COMMENT_SORTS)[number];
export const ARTIFACT_COMMENT_DEFAULT_SORT: ArtifactCommentSort = "updated";

/** A stored sort, or the default for anything else (another build's value, nothing stored). */
export function readCommentSort(raw: string | null): ArtifactCommentSort {
  return (ARTIFACT_COMMENT_SORTS as readonly string[]).includes(raw ?? "") ? (raw as ArtifactCommentSort) : ARTIFACT_COMMENT_DEFAULT_SORT;
}

/** A thread's comments, oldest first: its root (when loaded), then its replies. */
export const threadComments = (thread: ArtifactCommentThread): ArtifactComment[] => (thread.root ? [thread.root, ...thread.replies] : [...thread.replies]);

/** One comment and nothing under it: always shown in full, never collapsed. */
export const isSingleThread = (thread: ArtifactCommentThread): boolean => thread.root !== null && thread.replies.length === 0;

/** When the thread last had a comment (deleted ones kept for their replies count too: their time is when they were written). */
export const lastCommentAt = (thread: ArtifactCommentThread): string =>
  threadComments(thread).reduce((last, c) => (c.createdAt > last ? c.createdAt : last), thread.first.createdAt);

// ---- What is new to the reader ----

/**
 * Where the reader had read the comments to (their read position on the Artifact), as the list
 * reads it: a comment by someone else written after `through`, or at or after `from`, is new.
 * The viewer's own route moves the read position as it opens (artifactSource readViewer), so it is
 * read from before: `from` is the oldest comment new to the reader when they opened it (the
 * viewer data's `unseenAtOpen`, which the route read before its move; else the opener's card's
 * `unseen`); `through` is the newest comment loaded when the list was
 * last looked at (the first load, then each time the list closes). Null `through`: not loaded yet.
 */
export interface ArtifactCommentReadMark {
  through: string | null;
  from: string | null;
}

export const NO_READ_MARK: ArtifactCommentReadMark = { through: null, from: null };

const newestAt = (comments: readonly ArtifactComment[]): string => comments.reduce((last, c) => (c.createdAt > last ? c.createdAt : last), "");

/**
 * The read mark once the comments first loaded: everything loaded then was read (the viewer's
 * route read it), but for what was new before the open (`opener`: the viewer data's
 * `unseenAtOpen`, or the opener's card's `unseen`): from its first new comment, found by its id,
 * else (on a page not loaded, or deleted since) from the newest `newComments` comments by others.
 * None (an outsider, an older Server opened without a card): nothing is new but what comes after.
 */
export function readMarkAtLoad(
  comments: readonly ArtifactComment[],
  viewer: ArtifactViewerActor | null,
  opener: Pick<ArtifactCardUnseen, "newComments" | "firstNewComment"> | null,
): ArtifactCommentReadMark {
  const through = newestAt(comments);
  if (!opener || opener.newComments <= 0) return { through, from: null };
  const first = opener.firstNewComment ? comments.find((c) => c.id === opener.firstNewComment) : undefined;
  if (first) return { through, from: first.createdAt };
  const others = comments.filter((c) => !c.deletedAt && !isOwnComment(c, viewer)).map((c) => c.createdAt).sort().reverse();
  const nth = others[Math.min(opener.newComments, others.length) - 1];
  return { through, from: nth ?? null };
}

/** The read mark once the list was looked at (it closed): everything loaded is read. */
export const readMarkAfterLook = (comments: readonly ArtifactComment[]): ArtifactCommentReadMark => ({ through: newestAt(comments), from: null });

/**
 * Whether a comment is new to the reader: by someone else, not deleted, past the read mark the
 * list opened with, and not seen since it opened (`seen`: a thread expanded, a single comment shown).
 */
export function isUnseenComment(comment: ArtifactComment, mark: ArtifactCommentReadMark, viewer: ArtifactViewerActor | null, seen: ReadonlySet<ArtifactCommentId>): boolean {
  if (comment.deletedAt || seen.has(comment.id) || isOwnComment(comment, viewer)) return false;
  return (mark.through !== null && comment.createdAt > mark.through) || (mark.from !== null && comment.createdAt >= mark.from);
}

// ---- Page order ----

/**
 * Where the frame last said a posted thread's mark is (Porthole `anchored`): its place in the
 * document among the found marks (P112 `order`), else its top in the document (P132) or in the
 * frame. The page's word: an order to sort by, nothing more.
 */
export interface ArtifactMarkPlace {
  attached: boolean;
  at: number | null;
}

export function markPlaceOf(result: AnchorResult): ArtifactMarkPlace {
  if (result.state !== "attached") return { attached: false, at: null };
  const at = result.order ?? result.documentRect?.y ?? result.rect?.y ?? null;
  return { attached: true, at: typeof at === "number" && Number.isFinite(at) ? at : null };
}

/** The frame's places for the file it shows (`path`); null before it said anything. */
export interface ArtifactMarkPlaces {
  path: string;
  places: ReadonlyMap<string, ArtifactMarkPlace>;
}

/** A thread's place in its file: on the whole file first (0), then found places in order (1), then the rest (2). */
function placeInFile(thread: ArtifactCommentThread, frame: ArtifactMarkPlaces | null): [tier: number, at: number] {
  const anchor = anchorOf(thread.first);
  if (!anchor) return [0, 0];
  if (anchor.type === "lines" || anchor.type === "csv-rows") return [1, anchor.data.start];
  const target = thread.first.target;
  const place = anchor.type === "annotation" && frame && target.scope === "file" && target.path === frame.path ? frame.places.get(thread.id) : undefined;
  if (place?.attached && place.at !== null) return [1, place.at];
  // Not found in the page shown (lost, resolved and so not marked, on another file, a page's own
  // place): after the found ones, by where the text was when it was written, if it says.
  const position = anchor.type === "annotation" ? anchor.data.selectors.find((s) => s.type === "TextPositionSelector") : undefined;
  return [2, position?.type === "TextPositionSelector" ? position.start : Number.POSITIVE_INFINITY];
}

/**
 * The threads in the list's order. Last updated: by the thread's last comment, newest first.
 * Page order: the whole Artifact first, then each file in the version's order (groupThreads), in a
 * file by where each is (placeInFile), anchors not found last; each tie oldest first.
 */
export function sortThreads(
  threads: readonly ArtifactCommentThread[],
  sort: ArtifactCommentSort,
  { files, frame }: { files: readonly ArtifactFile[]; frame: ArtifactMarkPlaces | null },
): ArtifactCommentThread[] {
  const byStart = (a: ArtifactCommentThread, b: ArtifactCommentThread) => a.first.createdAt.localeCompare(b.first.createdAt);
  if (sort === "updated") return [...threads].sort((a, b) => lastCommentAt(b).localeCompare(lastCommentAt(a)) || -byStart(a, b));
  const keys = new Map(threads.map((t) => [t.id, placeInFile(t, frame)]));
  const inFile = [...threads].sort((a, b) => {
    const [ta, pa] = keys.get(a.id)!;
    const [tb, pb] = keys.get(b.id)!;
    return ta - tb || (pa === pb ? 0 : pa < pb ? -1 : 1) || byStart(a, b);
  });
  // groupThreads keeps each group's threads in the order given; the whole Artifact's stay oldest first.
  return groupThreads(inFile, files).flatMap((group) => group.threads);
}

// ---- Where each thread stands while the list is open ----

/**
 * The list's two areas, each in order: open (unresolved threads, and resolved ones with comments
 * new to the reader) and the folded "Resolved (N)". Made when the list opens and when the reader
 * picks a sort; nothing the list learns by itself moves a thread while it is open (seen, a new
 * reply, another's resolve): only the reader's own Resolve and Reopen do.
 */
export interface ArtifactCommentLayout {
  open: ArtifactCommentId[];
  rest: ArtifactCommentId[];
}

/** The open area's rule, as the list opens (or first meets a thread). */
export const belongsOpen = (thread: ArtifactCommentThread, isNew: (c: ArtifactComment) => boolean): boolean =>
  !isResolvedThread(thread) || threadComments(thread).some(isNew);

export function layoutAtOpen(sorted: readonly ArtifactCommentThread[], isNew: (c: ArtifactComment) => boolean): ArtifactCommentLayout {
  const open: ArtifactCommentId[] = [];
  const rest: ArtifactCommentId[] = [];
  for (const thread of sorted) (belongsOpen(thread, isNew) ? open : rest).push(thread.id);
  return { open, rest };
}

/** The same areas in a new order (a sort picked). */
export function resorted(layout: ArtifactCommentLayout, order: readonly ArtifactCommentId[]): ArtifactCommentLayout {
  const open = new Set(layout.open);
  const rest = new Set(layout.rest);
  return { open: order.filter((id) => open.has(id)), rest: order.filter((id) => rest.has(id)) };
}

/** `id` put into `area` where `order` has it: after the nearest thread before it in `order` that is there (first if none). */
function insertAt(area: readonly ArtifactCommentId[], order: readonly ArtifactCommentId[], id: ArtifactCommentId): ArtifactCommentId[] {
  for (let i = order.indexOf(id) - 1; i >= 0; i -= 1) {
    const at = area.indexOf(order[i]!);
    if (at >= 0) return [...area.slice(0, at + 1), id, ...area.slice(at + 1)];
  }
  return [id, ...area];
}

/** The reader resolved (`toOpen` false) or reopened a thread: it moves to the other area, in sort order. */
export function moveThread(layout: ArtifactCommentLayout, order: readonly ArtifactCommentId[], id: ArtifactCommentId, toOpen: boolean): ArtifactCommentLayout {
  const open = layout.open.filter((t) => t !== id);
  const rest = layout.rest.filter((t) => t !== id);
  return toOpen ? { open: insertAt(open, order, id), rest } : { open, rest: insertAt(rest, order, id) };
}

/**
 * Threads the list didn't have when it opened (one just written, earlier ones loaded, a reply whose
 * thread was on a page not loaded) take their place among the others by the current sort, without
 * moving any; threads gone (deleted) leave. Unchanged (the same object) when nothing is new or gone.
 */
export function withThreadsNow(
  layout: ArtifactCommentLayout,
  sorted: readonly ArtifactCommentThread[],
  isNew: (c: ArtifactComment) => boolean,
): ArtifactCommentLayout {
  const present = new Set(sorted.map((t) => t.id));
  const known = new Set([...layout.open, ...layout.rest]);
  const added = sorted.filter((t) => !known.has(t.id));
  const gone = [...known].some((id) => !present.has(id));
  if (added.length === 0 && !gone) return layout;
  const order = sorted.map((t) => t.id);
  let next = { open: layout.open.filter((id) => present.has(id)), rest: layout.rest.filter((id) => present.has(id)) };
  for (const thread of added) {
    next = belongsOpen(thread, isNew) ? { ...next, open: insertAt(next.open, order, thread.id) } : { ...next, rest: insertAt(next.rest, order, thread.id) };
  }
  return next;
}

/** Where focus goes once the reader resolved `id` from the open area: the card after it there, else the one before; null: none left. */
export function neighbourAfterResolve(layout: ArtifactCommentLayout, id: ArtifactCommentId): ArtifactCommentId | null {
  const at = layout.open.indexOf(id);
  if (at < 0) return null;
  return layout.open[at + 1] ?? layout.open[at - 1] ?? null;
}

// ---- A seen comment on one line ----

/**
 * The first line of a comment's words, as a collapsed thread shows a seen comment: the text and
 * its mentions (`@Name`), the first line with words on it, without a list's marker or inline
 * marks. Empty when it has none (images alone).
 */
export function commentFirstLine(comment: Pick<ArtifactComment, "body">): string {
  const text = comment.body.map((part) => (part.type === "text" ? part.text : mentionToken(part.actor))).join("");
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, "").replace(/\*\*|__|`/g, "").trim();
}
