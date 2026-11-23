import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import type { ArtifactActor, ArtifactCommentId } from "@botiverse/raft-shared";

import type { ArtifactCommentThread } from "./artifactComments";
import { commentSearchTerms, hidesMatch, searchCommentThreads } from "./artifactCommentSearch";
import type { ArtifactCommentSearchResult } from "./artifactCommentSearch";
import { artifactActorName } from "./artifactFacts";

const NO_TERMS: readonly string[] = [];
const NONE_FOLDED: ReadonlySet<ArtifactCommentId> = new Set();

/** What the reader changed while searching for some words; it goes as soon as the words change, even back to these. */
interface OwnWhileSearching {
  /** The words (`terms` joined) it was changed for. */
  key: string;
  /** The Resolved section folded (false) or opened again (true); null: open, as a search shows it. */
  resolvedOpen: boolean | null;
  /** Threads the search opened that the reader folded back (Collapse, Esc). */
  folded: ReadonlySet<ArtifactCommentId>;
}

export interface ArtifactCommentSearch {
  query: string;
  /** Typed in the field. */
  type: (query: string) => void;
  /** The field's first Esc and its ×: the words go, and the list is as it was. */
  clear: () => void;
  /** The words searched for, folded (commentSearchTerms); empty: not searching. */
  terms: readonly string[];
  /** What it found; null: not searching. */
  found: ArtifactCommentSearchResult | null;
  /** The Resolved section while searching: open unless the reader folded it. */
  resolvedOpen: boolean;
  toggleResolved: () => void;
  /** A thread found there was picked (a card pressed or focused, a marker in the page): the section opens. */
  showResolved: () => void;
  /** A collapsed thread the search opens: one of its one-line comments matches, and the reader didn't fold it back. */
  opens: (thread: ArtifactCommentThread, newIds: readonly ArtifactCommentId[]) => boolean;
  /** The reader folded back a thread the search opened. */
  fold: (thread: ArtifactCommentThread) => void;
}

/**
 * The comment list's search (#proj-workspace:#341): the words in the panel's field, the threads they
 * find (artifactCommentSearch), and what the reader changed while searching for them (the Resolved
 * section folded, a thread the search opened folded back), which goes whenever the words change. It
 * changes nothing of the list's own state (useArtifactCommentList): its order and areas, what is
 * expanded, and what is seen stay as they were, so a thread shown or opened because it matched isn't
 * read, and clearing the words gives the list back as it was, scrolled where it was.
 */
export function useArtifactCommentSearch(threads: readonly ArtifactCommentThread[] | null, listRef: RefObject<HTMLElement | null>): ArtifactCommentSearch {
  const { formatMessage } = useIntl();
  const [query, setQuery] = useState("");
  // The words as one key (none has a space in it), so typing a space or a word's case again finds nothing new.
  const key = commentSearchTerms(query).join(" ");
  const terms = useMemo(() => (key === "" ? NO_TERMS : key.split(" ")), [key]);
  const nameOf = useCallback((actor: ArtifactActor) => artifactActorName(actor, formatMessage), [formatMessage]);
  const found = useMemo(() => (threads && terms.length > 0 ? searchCommentThreads(threads, terms, nameOf) : null), [threads, terms, nameOf]);
  // React's "adjusting state": new words start afresh, so words typed again ("logo", Esc, "logo") don't find an old fold.
  const [own, setOwn] = useState<OwnWhileSearching>({ key: "", resolvedOpen: null, folded: NONE_FOLDED });
  let mine = own;
  if (own.key !== key) {
    mine = { key, resolvedOpen: null, folded: NONE_FOLDED };
    setOwn(mine);
  }

  // Where the list was scrolled as the search began, given back when it ends; each new search shows its results from the top.
  const scrolledAt = useRef<number | null>(null);
  const type = useCallback((next: string) => {
    if (key === "" && scrolledAt.current === null && commentSearchTerms(next).length > 0) scrolledAt.current = listRef.current?.scrollTop ?? 0;
    setQuery(next);
  }, [key, listRef]);
  const clear = useCallback(() => setQuery(""), []);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (key !== "") {
      list.scrollTo?.({ top: 0 });
    } else if (scrolledAt.current !== null) {
      list.scrollTop = scrolledAt.current;
      scrolledAt.current = null;
    }
  }, [key, listRef]);

  const resolvedOpen = mine.resolvedOpen ?? true;
  const toggleResolved = useCallback(() => setOwn({ ...mine, resolvedOpen: !resolvedOpen }), [mine, resolvedOpen]);
  const showResolved = useCallback(() => {
    if (!resolvedOpen) setOwn({ ...mine, resolvedOpen: true });
  }, [mine, resolvedOpen]);
  const opens = useCallback(
    (thread: ArtifactCommentThread, newIds: readonly ArtifactCommentId[]) => found !== null && !mine.folded.has(thread.id) && hidesMatch(thread, found.comments, newIds),
    [found, mine.folded],
  );
  const fold = useCallback((thread: ArtifactCommentThread) => setOwn({ ...mine, folded: new Set([...mine.folded, thread.id]) }), [mine]);
  return { query, type, clear, terms, found, resolvedOpen, toggleResolved, showResolved, opens, fold };
}
