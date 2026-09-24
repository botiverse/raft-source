import assert from "node:assert/strict";
import test from "node:test";
import { rankComposerSuggestions } from "../src/utils/composerSuggestionSearch.js";
import {
  createPeopleSuggestionSearchEntries,
} from "../src/utils/peopleSuggestionSearch.js";
import type {
  PeopleSuggestionCandidate,
} from "../src/utils/peopleSuggestionSearch.js";

interface Person {
  id: string;
}

const candidates: PeopleSuggestionCandidate<Person>[] = [
  { kind: "human", id: "expert", value: { id: "expert" }, handle: "KMP-专家", displayName: "KMP 专家" },
  { kind: "agent", id: "android", value: { id: "android" }, handle: "android-developer", displayName: "Android Developer" },
  { kind: "human", id: "server", value: { id: "server" }, handle: "alice", displayName: "Alice", sourceServerLabel: "duihua server" },
];

test("people picker entries share composer pinyin and fuzzy ranking", () => {
  const entries = createPeopleSuggestionSearchEntries(candidates);

  assert.deepEqual(rankComposerSuggestions("zhuanjia", entries).map((candidate) => candidate.id), ["expert"]);
  assert.deepEqual(rankComposerSuggestions("anddev", entries).map((candidate) => candidate.id), ["android"]);
  assert.deepEqual(rankComposerSuggestions("duihua", entries).map((candidate) => candidate.id), ["server"]);
});
