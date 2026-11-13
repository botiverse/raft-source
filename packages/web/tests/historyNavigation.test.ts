import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  getHistoryPosition,
  historyEntryFor,
  isHistoryNavigationSupported,
  positionOf,
  readHistorySnapshot,
  recordCurrentHistoryEntry,
  resetHistoryTracking,
  resolveHistoryStep,
} from "../src/components/topbar/historyNavigation";
import type { HistoryEntry, HistorySnapshot } from "../src/components/topbar/historyNavigation";
import { createFakeNavigation } from "./helpers/fakeNavigation";

// Task #127: Back/Forward move between PLACES. The Navigation API says where
// the document sits; the records say what each observed entry showed. A step
// goes to the nearest different place, skipping transient layers (the search
// overlay) and same-place duplicates.

const place = (key: string): HistoryEntry => ({ kind: "place", key });
const overlay = (key: string): HistoryEntry => ({ kind: "overlay", key });

/** A snapshot of entries e0…eN with the current one at `index`; `shown` maps entry index → record (absent = unobserved). */
function snapshot(count: number, index: number, shown: Record<number, HistoryEntry>): HistorySnapshot {
  const keys = Array.from({ length: count }, (_, i) => `e${i}`);
  const records = new Map(Object.entries(shown).map(([i, entry]) => [`e${i}`, entry]));
  return { keys, index, records };
}

type MutableGlobal = typeof globalThis & { window?: unknown };
afterEach(() => {
  resetHistoryTracking();
  delete (globalThis as MutableGlobal).window;
});

test("a fresh document at the first entry can go neither way", () => {
  assert.deepEqual(positionOf(snapshot(1, 0, { 0: place("/s/x/channel/a") })), { canGoBack: false, canGoForward: false });
  assert.deepEqual(positionOf(null), { canGoBack: false, canGoForward: false });
});

test("entries behind enable back; entries ahead enable forward", () => {
  const records = { 0: place("a"), 1: place("b"), 2: place("c") };
  assert.deepEqual(positionOf(snapshot(3, 2, records)), { canGoBack: true, canGoForward: false });
  assert.deepEqual(positionOf(snapshot(3, 1, records)), { canGoBack: true, canGoForward: true });
  assert.deepEqual(positionOf(snapshot(3, 0, records)), { canGoBack: false, canGoForward: true });
});

test("the search overlay is not a place: channel → search → channel (Escape pushes) — Back goes to the previous channel in one hop, Forward never re-opens the palette", () => {
  // a(0) → b(1) → open ⌘K over b (2, overlay) → Escape pushes b again (3)
  const records = { 0: place("a"), 1: place("b"), 2: overlay("b"), 3: place("b") };
  const atEnd = snapshot(4, 3, records);
  assert.equal(resolveHistoryStep("back", atEnd), -3, "skip the overlay (2) and the duplicate b (1), land on a (0)");
  assert.equal(resolveHistoryStep("forward", atEnd), null);
  assert.deepEqual(positionOf(atEnd), { canGoBack: true, canGoForward: false });
  const atA = snapshot(4, 0, records);
  assert.equal(resolveHistoryStep("forward", atA), 1, "Forward goes to b (1) — the first different place, not the palette");
  const atB = snapshot(4, 1, records);
  assert.equal(resolveHistoryStep("forward", atB), null, "ahead of b(1) there is only the overlay and another b");
  assert.deepEqual(positionOf(atB), { canGoBack: true, canGoForward: false });
});

test("from inside an open overlay, Back goes to the place before the one underneath", () => {
  assert.equal(resolveHistoryStep("back", snapshot(3, 2, { 0: place("a"), 1: place("b"), 2: overlay("b") })), -2);
  assert.deepEqual(positionOf(snapshot(2, 1, { 0: place("a"), 1: overlay("a") })), { canGoBack: false, canGoForward: false }, "an overlay over the first place: nothing behind it");
});

test("entries another document left (before a full reload) are out of bounds both ways", () => {
  const reloaded = snapshot(4, 2, { 2: place("c") });
  assert.equal(resolveHistoryStep("back", reloaded), null);
  assert.equal(resolveHistoryStep("forward", reloaded), null);
  assert.deepEqual(positionOf(reloaded), { canGoBack: false, canGoForward: false });
  // This document went c(2) → d(3) → e(4); e0, e1 and e5 are the old document's.
  const later = snapshot(6, 3, { 2: place("c"), 3: place("d"), 4: place("e") });
  assert.equal(resolveHistoryStep("back", later), -1, "back to this document's first entry");
  assert.equal(resolveHistoryStep("back", snapshot(6, 2, { 2: place("c"), 3: place("d") })), null, "and no further");
  assert.equal(resolveHistoryStep("forward", snapshot(6, 4, { 2: place("c"), 3: place("d"), 4: place("e") })), null, "forward stops before the old document's entry");
  assert.equal(resolveHistoryStep("back", snapshot(4, 3, { 2: overlay("c"), 3: place("c") })), null, "skipping an overlay never runs into another document");
});

test("an entry this document was current in but never recorded (its route never committed) is a distinct place", () => {
  const own = new Set(["e2", "e3", "e4"]);
  const s = { ...snapshot(6, 3, { 2: place("c"), 3: place("d") }), own };
  assert.equal(resolveHistoryStep("forward", s), 1, "e4 is ours");
  assert.equal(resolveHistoryStep("forward", { ...s, index: 4 }), null, "e5 is not");
  assert.equal(resolveHistoryStep("back", { ...s, index: 2 }), null);
});

test("the store keeps Back and Forward inside this document (Navigation API with an earlier document's entries)", () => {
  const navigation = createFakeNavigation("/", { before: ["/s/old/channel/a", "/s/old/channel/b"], after: ["/s/old/channel/c"] });
  (globalThis as MutableGlobal).window = { navigation };
  recordCurrentHistoryEntry(place("/"));
  assert.deepEqual(getHistoryPosition(), { canGoBack: false, canGoForward: false }, "a 401 sent the app to / in a new document: nothing to go back to");
  navigation.push("/s/x/channel/a"); // prunes the old forward entry
  recordCurrentHistoryEntry(place("/s/x/channel/a"));
  assert.deepEqual(getHistoryPosition(), { canGoBack: true, canGoForward: false });
  assert.equal(resolveHistoryStep("back", readHistorySnapshot()), -1, "to this document's first entry");
  navigation.traverse(-1);
  recordCurrentHistoryEntry(place("/"));
  assert.deepEqual(getHistoryPosition(), { canGoBack: false, canGoForward: true }, "not into the old document");
});

test("resolveHistoryStep accepts only back / forward", () => {
  const s = snapshot(2, 0, { 0: place("a"), 1: place("b") });
  for (const junk of [2, -1, 1, "1", "up", undefined, null]) assert.equal(resolveHistoryStep(junk, s), null, String(junk));
  assert.equal(resolveHistoryStep("forward", null), null);
  assert.equal(resolveHistoryStep("back", { keys: [], index: -1, records: new Map() }), null);
});

test("historyEntryFor: an overlay location is keyed by the place underneath; a plain location by itself", () => {
  const resolve = (location: { pathname: string; state: unknown }) => (
    location.pathname.endsWith("/search")
      ? (location.state as { backgroundLocation: { pathname: string; search: string } }).backgroundLocation
      : null
  );
  assert.deepEqual(historyEntryFor({ pathname: "/s/x/channel/a", search: "?tab=chat", state: null }, resolve), { kind: "place", key: "/s/x/channel/a?tab=chat" });
  assert.deepEqual(historyEntryFor({
    pathname: "/s/x/search",
    search: "",
    state: { backgroundLocation: { pathname: "/s/x/channel/a", search: "" } },
  }, resolve), { kind: "overlay", key: "/s/x/channel/a" });
});

test("without the Navigation API there is no history position and nothing is recorded", () => {
  (globalThis as MutableGlobal).window = {};
  assert.equal(isHistoryNavigationSupported(), false);
  assert.equal(readHistorySnapshot(), null);
  recordCurrentHistoryEntry(place("a"));
  assert.deepEqual(getHistoryPosition(), { canGoBack: false, canGoForward: false });
});

test("the store follows the Navigation API's entries, forgets pruned entries, and keeps a stable snapshot while flags are unchanged", () => {
  const navigation = createFakeNavigation("/s/x/channel/a");
  (globalThis as MutableGlobal).window = { navigation };
  assert.equal(isHistoryNavigationSupported(), true);
  const initial = getHistoryPosition();
  recordCurrentHistoryEntry(place("a"));
  assert.equal(getHistoryPosition(), initial, "same flags → same snapshot object");
  navigation.push("/s/x/channel/b");
  recordCurrentHistoryEntry(place("b"));
  const afterPush = getHistoryPosition();
  assert.notEqual(afterPush, initial);
  assert.deepEqual(afterPush, { canGoBack: true, canGoForward: false });
  navigation.replace("/s/x/channel/b?tab=chat");
  recordCurrentHistoryEntry(place("b2"));
  assert.equal(getHistoryPosition(), afterPush, "a replace at the same entry changes no flag → same snapshot");
  navigation.traverse(-1);
  recordCurrentHistoryEntry(place("a"));
  assert.deepEqual(getHistoryPosition(), { canGoBack: false, canGoForward: true });
  navigation.push("/s/x/channel/c"); // prunes b
  recordCurrentHistoryEntry(place("c"));
  assert.deepEqual(getHistoryPosition(), { canGoBack: true, canGoForward: false });
  assert.equal(readHistorySnapshot()?.records.size, 2, "the pruned entry's record is gone");
});
