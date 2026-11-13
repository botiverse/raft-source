import assert from "node:assert/strict";
import { buildSearchEntityResults, findExactDestination } from "../searchEntities";
import type { SearchEntityResult } from "../searchEntities";

// Task #102 (desktop ⌘K overlay, Slack model): Return enters a destination only
// when the query names it outright; otherwise Return opens the full results page.

function entity(overrides: Partial<SearchEntityResult> & Pick<SearchEntityResult, "key" | "type" | "title">): SearchEntityResult {
  return {
    subtitle: { kind: "channel" },
    channelId: null,
    channelType: null,
    machineId: null,
    agentId: null,
    userId: null,
    archivedAt: null,
    ...overrides,
  };
}

const design = entity({ key: "channel:1", type: "channel", title: "design", channelId: "1", channelType: "channel" });
const designSystem = entity({ key: "channel:2", type: "channel", title: "design-system", channelId: "2", channelType: "channel" });
const andrew = entity({ key: "human:u1", type: "humanDm", title: "Andrew Lamb", subtitle: { kind: "text", text: "@andrew" }, userId: "u1" });

test("exact title match on the top-ranked destination, ignoring a leading # / @, case and whitespace runs", () => {
  assert.equal(findExactDestination("design", [design, designSystem])?.key, "channel:1");
  assert.equal(findExactDestination("#Design ", [design, designSystem])?.key, "channel:1");
  assert.equal(findExactDestination("andrew   lamb", [andrew])?.key, "human:u1");
  assert.equal(findExactDestination("@andrew", [andrew])?.key, "human:u1", "handle counts for people/agents");
});

test("a prefix or partial match is NOT exact — Return must open the results page instead", () => {
  assert.equal(findExactDestination("desig", [design, designSystem]), null);
  assert.equal(findExactDestination("design-sys", [designSystem, design]), null);
  assert.equal(findExactDestination("lamb", [andrew]), null, "a bare surname is neither the full title nor the handle");
  assert.equal(findExactDestination("andrew la", [andrew]), null, "a truncated title is not exact");
});

test("the strict match is found anywhere in the ranked list and hoisted; empty inputs never match", () => {
  assert.equal(findExactDestination("design", [designSystem, design])?.key, "channel:1", "a strict hit ranked second is still the destination");
  assert.equal(findExactDestination("   ", [design]), null);
  assert.equal(findExactDestination("#", [design]), null);
  assert.equal(findExactDestination("design", []), null);
});

// PR #8012 review P2: the ranking's exact score drops punctuation (and matches
// pinyin), so with `design-system` and `designsystem` the query `designsystem`
// ranks `design-system` first. A head-only check would miss the real destination.
test("review counterexample: design-system vs designsystem — the real ranking order does not hide the strict destination", () => {
  const ranked = buildSearchEntityResults({
    query: "designsystem",
    channels: [
      { id: "c1", name: "design-system", description: null, type: "channel", createdAt: "" },
      { id: "c2", name: "designsystem", description: null, type: "channel", createdAt: "" },
    ],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  } as Parameters<typeof buildSearchEntityResults>[0]);
  assert.ok(ranked.length >= 2, "both channels rank");
  const exact = findExactDestination("designsystem", ranked);
  assert.equal(exact?.channelId, "c2", "the strict match is the destination regardless of its rank");
  assert.equal(findExactDestination("design-system", ranked)?.channelId, "c1");
  assert.equal(findExactDestination("design system", ranked), null, "punctuation-insensitive lookalikes are NOT exact for Return-enters purposes");
});
