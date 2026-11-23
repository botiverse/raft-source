import { useCallback, useMemo, useState } from "react";
import type { ArtifactComment, ArtifactCommentId, ArtifactFile } from "@botiverse/raft-shared";

import type { ArtifactViewerActor } from "./artifactApi";
import type { ArtifactCommentThread } from "./artifactComments";
import {
  isSingleThread,
  isUnseenComment,
  layoutAtOpen,
  moveThread,
  readCommentSort,
  resorted,
  sortThreads,
  threadComments,
  withThreadsNow,
} from "./artifactCommentListOrder";
import type { ArtifactCommentLayout, ArtifactCommentReadMark, ArtifactCommentSort, ArtifactMarkPlaces } from "./artifactCommentListOrder";

/** The sort, kept on the device (local storage): anything unreadable is the default. */
const SORT_KEY = "raft:artifacts:comments:sort:v1";

function loadSort(): ArtifactCommentSort {
  try {
    return readCommentSort(window.localStorage.getItem(SORT_KEY));
  } catch {
    return readCommentSort(null);
  }
}

function saveSort(sort: ArtifactCommentSort) {
  try {
    window.localStorage.setItem(SORT_KEY, sort);
  } catch {
    // Storage full or off (private mode): the choice lasts while the page does.
  }
}

/** What the list holds while it is open; it starts over each time it opens (the panel mounts). */
interface Session {
  /** The read mark the list opened with: "new" is past it. */
  mark: ArtifactCommentReadMark;
  layout: ArtifactCommentLayout;
  /** Page order made with the frame's places (else it settles once, when they come). */
  withPlaces: boolean;
  /** Comments seen since the list opened: a thread expanded, a single comment shown. */
  seen: ReadonlySet<ArtifactCommentId>;
  /** While a thread is expanded: its comments that were new when it was, for its divider. */
  shownNew: ReadonlyMap<ArtifactCommentId, readonly ArtifactCommentId[]>;
  expanded: ReadonlySet<ArtifactCommentId>;
}

export interface ArtifactCommentList {
  sort: ArtifactCommentSort;
  pickSort: (sort: ArtifactCommentSort) => void;
  /** The open area's threads and the folded "Resolved (N)"'s, in order; empty until loaded. */
  open: ArtifactCommentThread[];
  rest: ArtifactCommentThread[];
  /** Ids of the open area, in order (where focus goes after a resolve). */
  layout: ArtifactCommentLayout | null;
  isExpanded: (thread: ArtifactCommentThread) => boolean;
  /** The comments after the thread's "New replies" divider: new ones, and while expanded those that were new when it opened. */
  newIn: (thread: ArtifactCommentThread) => ArtifactCommentId[];
  expand: (thread: ArtifactCommentThread) => void;
  /** Stays expanded as it grows (Reply opened in it: a thread of one comment gets a second, the reader's own). */
  keepExpanded: (thread: ArtifactCommentThread) => void;
  collapse: (thread: ArtifactCommentThread) => void;
  /** The reader resolved (`open` false) or reopened it: it moves at once; resolved, it collapses. */
  moved: (thread: ArtifactCommentThread, open: boolean) => void;
}

const isNewIn = (session: Pick<Session, "mark" | "seen">, viewer: ArtifactViewerActor | null) => (c: ArtifactComment) => isUnseenComment(c, session.mark, viewer, session.seen);

const withAdded = <T>(set: ReadonlySet<T>, items: readonly T[]): Set<T> => new Set([...set, ...items]);

/** The session after a thread collapsed: all it showed is seen, its divider goes. */
function collapsed(session: Session, thread: ArtifactCommentThread): Session {
  const expanded = new Set(session.expanded);
  expanded.delete(thread.id);
  const shownNew = new Map(session.shownNew);
  shownNew.delete(thread.id);
  return { ...session, expanded, shownNew, seen: withAdded(session.seen, threadComments(thread).map((c) => c.id)) };
}

/**
 * The comment list's state while it is open (approved prototype, RULES): its order and areas, made
 * as it opens (once the comments are loaded) and when the reader picks a sort, never moved by what
 * the list learns while open (seen, a new reply, another's resolve); the reader's own Resolve and
 * Reopen move a thread at once (`moved`). Threads it didn't have take their place by the sort
 * (withThreadsNow). Each collapsed thread shows its seen comments on one line and its new ones in
 * full after a divider; expanding it shows it whole and its new comments count as seen. A thread
 * of one comment is always shown whole, so it is seen as the list opens.
 */
export function useArtifactCommentList({ threads, files, readMark, viewer, markPlaces, placesKnown }: {
  /** The list's threads; null while loading. */
  threads: readonly ArtifactCommentThread[] | null;
  files: readonly ArtifactFile[];
  readMark: ArtifactCommentReadMark;
  viewer: ArtifactViewerActor | null;
  markPlaces: () => ArtifactMarkPlaces | null;
  placesKnown: boolean;
}): ArtifactCommentList {
  const [sort, setSort] = useState(loadSort);
  const [session, setSession] = useState<Session | null>(null);
  const sortNow = useCallback(
    (by: ArtifactCommentSort) => (threads ? sortThreads(threads, by, { files, frame: by === "page" ? markPlaces() : null }) : []),
    [threads, files, markPlaces],
  );
  // The frame's places are read as the order is made (a getter, not each report): from when they first came.
  const sorted = useMemo(
    () => (threads ? sortThreads(threads, sort, { files, frame: sort === "page" && placesKnown ? markPlaces() : null }) : []),
    [threads, sort, files, markPlaces, placesKnown],
  );
  // React's "adjusting state": the list opens (once loaded), Page order settles once the frame said where, threads come and go.
  if (threads && session === null) {
    const fresh: Session = { mark: readMark, layout: { open: [], rest: [] }, withPlaces: placesKnown, seen: new Set(), shownNew: new Map(), expanded: new Set() };
    const isNew = isNewIn(fresh, viewer);
    const layout = layoutAtOpen(sorted, isNew);
    const open = new Set(layout.open);
    const shown = sorted.filter((t) => open.has(t.id) && isSingleThread(t) && isNew(t.root!));
    setSession({ ...fresh, layout, seen: new Set(shown.map((t) => t.root!.id)), shownNew: new Map(shown.map((t): [ArtifactCommentId, ArtifactCommentId[]] => [t.id, [t.root!.id]])) });
  } else if (session && sort === "page" && !session.withPlaces && placesKnown) {
    setSession({ ...session, withPlaces: true, layout: resorted(session.layout, sorted.map((t) => t.id)) });
  } else if (session && threads) {
    const layout = withThreadsNow(session.layout, sorted, isNewIn(session, viewer));
    if (layout !== session.layout) setSession({ ...session, layout });
  }

  const pickSort = useCallback((next: ArtifactCommentSort) => {
    setSort(next);
    saveSort(next);
    const order = sortNow(next).map((t) => t.id);
    setSession((current) => (current ? { ...current, withPlaces: placesKnown, layout: resorted(current.layout, order) } : current));
  }, [sortNow, placesKnown]);
  const expand = useCallback((thread: ArtifactCommentThread) => setSession((current) => {
    if (!current) return current;
    const fresh = threadComments(thread).filter(isNewIn(current, viewer)).map((c) => c.id);
    const shownNew = new Map(current.shownNew);
    shownNew.set(thread.id, fresh);
    return { ...current, seen: withAdded(current.seen, fresh), expanded: withAdded(current.expanded, [thread.id]), shownNew };
  }), [viewer]);
  const keepExpanded = useCallback((thread: ArtifactCommentThread) => setSession((current) => (
    current && !current.expanded.has(thread.id) ? { ...current, expanded: withAdded(current.expanded, [thread.id]) } : current
  )), []);
  const collapse = useCallback((thread: ArtifactCommentThread) => setSession((current) => (current ? collapsed(current, thread) : current)), []);
  const order = useMemo(() => sorted.map((t) => t.id), [sorted]);
  const moved = useCallback((thread: ArtifactCommentThread, open: boolean) => setSession((current) => {
    if (!current) return current;
    const next = { ...current, layout: moveThread(current.layout, order, thread.id, open) };
    return open ? next : collapsed(next, thread);
  }), [order]);

  const byId = useMemo(() => new Map((threads ?? []).map((t) => [t.id, t])), [threads]);
  const pick = (ids: readonly ArtifactCommentId[]) => ids.flatMap((id) => byId.get(id) ?? []);
  const isExpanded = useCallback((thread: ArtifactCommentThread) => isSingleThread(thread) || (session?.expanded.has(thread.id) ?? false), [session]);
  const newIn = useCallback((thread: ArtifactCommentThread) => {
    if (!session) return [];
    const isNew = isNewIn(session, viewer);
    const shown = new Set(isExpanded(thread) ? session.shownNew.get(thread.id) ?? [] : []);
    return threadComments(thread).filter((c) => shown.has(c.id) || isNew(c)).map((c) => c.id);
  }, [session, viewer, isExpanded]);
  return {
    sort,
    pickSort,
    open: session ? pick(session.layout.open) : [],
    rest: session ? pick(session.layout.rest) : [],
    layout: session?.layout ?? null,
    isExpanded,
    newIn,
    expand,
    keepExpanded,
    collapse,
    moved,
  };
}
