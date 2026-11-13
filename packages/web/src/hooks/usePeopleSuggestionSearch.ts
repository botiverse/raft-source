import { useMemo } from "react";
import { useRankedComposerSuggestionsOrPending } from "./useRankedComposerSuggestions";
import {
  createPeopleSuggestionSearchEntries,
} from "../utils/peopleSuggestionSearch";
import type {
  PeopleSuggestionCandidate,
} from "../utils/peopleSuggestionSearch";

export function usePeopleSuggestionSearch<T>(
  query: string,
  candidates: PeopleSuggestionCandidate<T>[],
) {
  const entries = useMemo(
    () => createPeopleSuggestionSearchEntries(candidates),
    [candidates],
  );
  // `null` while a worker ranks the first query (useRankedComposerSuggestionsOrPending).
  const ranked = useRankedComposerSuggestionsOrPending(query, entries);
  return { entries, ranked };
}
