import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { usePeopleSuggestionSearch } from "../src/hooks/usePeopleSuggestionSearch";
import type { PeopleSuggestionCandidate } from "../src/utils/peopleSuggestionSearch";

interface Person {
  id: string;
}

const candidates: PeopleSuggestionCandidate<Person>[] = [
  { kind: "human", id: "expert", value: { id: "expert" }, handle: "KMP-专家", displayName: "KMP 专家" },
  { kind: "agent", id: "android", value: { id: "android" }, handle: "android-developer", displayName: "Android Developer" },
  { kind: "human", id: "server", value: { id: "server" }, handle: "alice", displayName: "Alice", sourceServerLabel: "duihua server" },
];

function PeopleSearchHarness({ query }: { query: string }) {
  const { entries, ranked } = usePeopleSuggestionSearch(query, candidates);
  return (
    <output data-entry-count={entries.length}>
      {ranked.map((candidate) => candidate.id).join(",")}
    </output>
  );
}

afterEach(cleanup);

test("the shared people-picker hook ranks pinyin, fuzzy handles, and source-server labels", () => {
  const view = render(<PeopleSearchHarness query="zhuanjia" />);
  const output = view.getByRole("status");
  assert.equal(output.getAttribute("data-entry-count"), "3");
  assert.equal(output.textContent, "expert");

  view.rerender(<PeopleSearchHarness query="anddev" />);
  assert.equal(output.textContent, "android");

  view.rerender(<PeopleSearchHarness query="duihua" />);
  assert.equal(output.textContent, "server");
});
