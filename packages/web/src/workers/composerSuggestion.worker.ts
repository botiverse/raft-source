import { rankComposerSuggestions } from "../utils/composerSuggestionSearch";
import type { ComposerSuggestionSearchEntry, ComposerSuggestionSearchField } from "../utils/composerSuggestionSearch";

interface ComposerSuggestionWorkerEntry {
  index: number;
  fields: ComposerSuggestionSearchField[];
}

interface ComposerSuggestionWorkerRequest {
  type: "rank";
  requestId: number;
  query: string;
  entries?: ComposerSuggestionWorkerEntry[];
}

interface ComposerSuggestionWorkerResponse {
  type: "ranked";
  requestId: number;
  indexes: number[];
}

let cachedEntries: ComposerSuggestionSearchEntry<number>[] = [];

self.onmessage = (event: MessageEvent<ComposerSuggestionWorkerRequest>) => {
  const message = event.data;
  if (message.type !== "rank") return;

  if (message.entries) {
    cachedEntries = message.entries.map((entry) => ({
      index: entry.index,
      suggestion: entry.index,
      fields: entry.fields,
    }));
  }
  const indexes = rankComposerSuggestions(message.query, cachedEntries);
  const response: ComposerSuggestionWorkerResponse = {
    type: "ranked",
    requestId: message.requestId,
    indexes,
  };
  self.postMessage(response);
};
