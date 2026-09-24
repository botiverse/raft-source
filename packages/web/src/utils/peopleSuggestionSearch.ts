import type { ComposerSuggestionSearchEntry } from "./composerSuggestionSearch";

export interface PeopleSuggestionCandidate<T> {
  kind: "agent" | "human";
  id: string;
  value: T;
  handle: string;
  displayName?: string | null;
  description?: string | null;
  sourceServerLabel?: string | null;
}

export function createPeopleSuggestionSearchEntries<T>(
  candidates: PeopleSuggestionCandidate<T>[],
): ComposerSuggestionSearchEntry<PeopleSuggestionCandidate<T>>[] {
  return candidates.map((candidate, index) => ({
    index,
    suggestion: candidate,
    fields: [
      { raw: candidate.handle, priority: 0 },
      { raw: candidate.displayName ?? "", priority: 1 },
      { raw: candidate.description ?? "", priority: 3 },
      { raw: candidate.sourceServerLabel ?? "", priority: 4 },
    ],
  }));
}
