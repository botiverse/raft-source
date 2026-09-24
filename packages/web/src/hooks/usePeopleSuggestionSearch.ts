import { useMemo } from "react";
import { useRankedComposerSuggestions } from "./useRankedComposerSuggestions";
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
  const ranked = useRankedComposerSuggestions(query, entries);
  return { entries, ranked };
}
