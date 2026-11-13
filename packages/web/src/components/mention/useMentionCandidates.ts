import { useEffect, useMemo, useRef, useState } from "react";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";

import { useRankedComposerSuggestions } from "../../hooks/useRankedComposerSuggestions";
import { createMentionCandidateSearchEntries } from "../message/mentionCandidates";
import type { MentionCandidate } from "../message/mentionCandidates";
import { fetchMentionAudienceCandidates, mentionAudienceKey } from "./mentionAudience";
import type { MentionAudience, MentionAudienceCandidates, MentionSource } from "./mentionAudience";

/** How long typing pauses before a capped audience is asked by `q`. */
export const MENTION_QUERY_DEBOUNCE_MS = 150;

const NONE: readonly MentionCandidate[] = [];

/**
 * The audience's candidates while the list is open: the `q`-empty answer,
 * asked once per open (dropped on close, so the next open asks again), and,
 * when it was capped, the server's answer for the latest `q` (debounced; an
 * answer to an earlier request never replaces a later one's).
 */
function useAudienceCandidates(audience: MentionAudience | null, open: boolean, query: string) {
  const key = audience ? mentionAudienceKey(audience) : null;
  const audienceRef = useRef(audience);
  audienceRef.current = audience;
  const [answers, setAnswers] = useState<{
    base: MentionAudienceCandidates;
    searched: { q: string; candidates: MentionCandidate[] } | null;
  } | null>(null);

  useEffect(() => {
    const current = audienceRef.current;
    if (!open || !current) return;
    let ignore = false;
    void fetchMentionAudienceCandidates(current, "").then(
      (answer) => { if (!ignore) setAnswers({ base: answer, searched: null }); },
      () => {},
    );
    return () => {
      ignore = true;
      setAnswers(null);
    };
  }, [open, key]);

  const capped = answers?.base.capped ?? null;
  const issued = useRef(0);
  useEffect(() => {
    const current = audienceRef.current;
    if (!open || !current || capped !== true || query === "") return;
    let ignore = false;
    // Debounced: a capped audience is asked once typing pauses, not per keystroke.
    const timer = setClockTimeout(() => {
      issued.current += 1;
      const request = issued.current;
      void fetchMentionAudienceCandidates(current, query).then(
        (answer) => {
          // Only the latest request's answer is shown.
          if (!ignore && request === issued.current) setAnswers((now) => (now ? { ...now, searched: { q: query, candidates: answer.candidates } } : now));
        },
        () => {},
      );
    }, MENTION_QUERY_DEBOUNCE_MS);
    return () => {
      ignore = true;
      clearClockTimeout(timer);
    };
  }, [open, key, capped, query]);

  if (!open || !audience || !answers) return { pool: NONE, exact: null };
  const { base, searched } = answers;
  if (!base.capped || query === "" || !searched) return { pool: base.candidates, exact: null };
  // While the search for this `q` is pending, the last answer is filtered here.
  return { pool: searched.candidates, exact: searched.q === query ? searched.candidates : null };
}

/**
 * The candidates an @ list offers for `query`, ranked as chat ranks them
 * (useRankedComposerSuggestions over the mention search entries). A `local`
 * source is ranked as is; an `audience` source is asked of the server
 * (see MentionSource) and its answer ranked the same way, except a capped
 * audience's answer for this exact `q`, which the server already searched.
 */
export function useMentionCandidates(source: MentionSource, { open, query }: { open: boolean; query: string }): MentionCandidate[] {
  const local = "local" in source ? source.local : null;
  const audience = "audience" in source ? source.audience : null;
  const remote = useAudienceCandidates(audience, open, query);
  const pool = local ?? remote.pool;
  const entries = useMemo(() => createMentionCandidateSearchEntries(pool), [pool]);
  const ranked = useRankedComposerSuggestions(query, entries);
  return remote.exact ?? ranked;
}
