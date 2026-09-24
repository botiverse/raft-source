// Task #480: thread reply ordering jump during optimistic→server merge.
//
// Root cause: ThreadPanel's `sortThreadMessages` used a DIFFERENT tiebreak than
// messageStore's `sortBySeq` — it sank EVERY not-yet-`seq` row below all persisted
// (has-`seq`) rows, regardless of `createdAt`. So an optimistic reply sat at the
// bottom, then jumped to its `seq` position the moment the server echo arrived.
//
// Fix: both surfaces now share `compareMessagesForDisplay` — a no-`seq` row is
// ordered by `createdAt` RELATIVE to persisted rows (where its future `seq` will
// land), so the thread sorts IDENTICALLY to the main list and can't diverge.
//
// The first block pins the discriminating property narratively (array order); the
// `compareMessagesForDisplay sign` block pins every tiebreak BRANCH by asserting
// the comparator's return SIGN directly — array-order assertions alone don't kill
// sign-breaking mutants (e.g. `a.seq - b.seq` → `a.seq + b.seq` stays positive and
// a 2-element `.sort()` can mask it), so the mutation-diff-gate needs the signs.
import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const { compareMessagesForDisplay, sortBySeq, useMessageStore } = await import("../src/store/messageStore.js");
// `sortThreadMessages` lives in ThreadPanel and must delegate to the shared
// comparator — importing it here pins ThreadPanel's own `[...msgs].sort(...)`.
const { sortThreadMessages } = await import("../src/components/message/ThreadPanel.js");
type Message = Parameters<ReturnType<typeof useMessageStore.getState>["addMessage"]>[0];

function msg(over: Partial<Message> & { id: string; createdAt: string }): Message {
  return {
    channelId: "c1",
    senderType: "user",
    senderId: "u1",
    content: "hi",
    ...over,
  } as Message;
}

function orderIds(msgs: Message[]): string[] {
  return [...msgs].sort(compareMessagesForDisplay).map((m) => m.id);
}

test("[#480] a no-seq optimistic message sorts by createdAt relative to persisted rows, not sunk below them", () => {
  const persisted = msg({ id: "p1", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  // Optimistic with an EARLIER createdAt (composed before / clock ordering): it
  // must sort BEFORE the persisted row by time — the old ThreadPanel comparator
  // sank it to the bottom regardless.
  const optimisticEarlier = msg({ id: "optimistic-a", createdAt: "2026-07-03T09:59:00Z" });
  assert.deepEqual(
    orderIds([persisted, optimisticEarlier]),
    ["optimistic-a", "p1"],
    "no-seq optimistic with earlier createdAt must sort BEFORE the persisted row (by time), not sink below it",
  );
});

test("[#480] a no-seq optimistic sorts BETWEEN persisted rows by createdAt (thread == main-list ordering)", () => {
  const p1 = msg({ id: "p1", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  const p2 = msg({ id: "p2", seq: 6, createdAt: "2026-07-03T10:02:00Z" });
  const optimisticMid = msg({ id: "optimistic-b", createdAt: "2026-07-03T10:01:00Z" });
  // Placed by createdAt between p1 and p2 — NOT dumped after both (old behavior).
  assert.deepEqual(orderIds([p2, optimisticMid, p1]), ["p1", "optimistic-b", "p2"]);
});

test("[#480] newest optimistic stays at the tail across the seq merge (no jump for the common case)", () => {
  const p1 = msg({ id: "p1", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  const optimistic = msg({ id: "optimistic-c", createdAt: "2026-07-03T10:03:00Z" });
  assert.deepEqual(orderIds([p1, optimistic]), ["p1", "optimistic-c"]);
  // Server echo: same row now carries the next seq — position unchanged (tail).
  const merged = msg({ id: "server-c", seq: 6, createdAt: "2026-07-03T10:03:00Z" });
  assert.deepEqual(orderIds([p1, merged]), ["p1", "server-c"]);
});

// Direct SIGN assertions — one per comparator branch. `< 0` = a before b, `> 0` =
// a after b. These pin the sign that array-order tests can't (they kill the
// arithmetic/equality/conditional mutants on each tiebreak line).
test("[#480] compareMessagesForDisplay: both-seq rows order by seq ascending", () => {
  const lo = msg({ id: "x", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  const hi = msg({ id: "y", seq: 6, createdAt: "2026-07-03T10:00:00Z" });
  assert.ok(compareMessagesForDisplay(lo, hi) < 0, "lower seq sorts first");
  assert.ok(compareMessagesForDisplay(hi, lo) > 0, "higher seq sorts last");
});

test("[#480] compareMessagesForDisplay: seq wins even when createdAt DISAGREES with seq", () => {
  // seq says A after B (6 > 5), but A's createdAt is EARLIER. `seq` must win — this
  // kills the `a.seq !== b.seq` equality mutant and the L287 conditional (a `===`
  // or force-false mutant would fall through to createdAt and flip the sign).
  const a = msg({ id: "a", seq: 6, createdAt: "2026-07-03T09:00:00Z" });
  const b = msg({ id: "b", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  assert.ok(compareMessagesForDisplay(a, b) > 0, "higher seq sorts after even with earlier createdAt");
  assert.ok(compareMessagesForDisplay(b, a) < 0);
});

test("[#480] compareMessagesForDisplay: no-seq rows order by createdAt", () => {
  const earlier = msg({ id: "e", createdAt: "2026-07-03T10:00:00Z" });
  const later = msg({ id: "l", createdAt: "2026-07-03T10:03:00Z" });
  assert.ok(compareMessagesForDisplay(earlier, later) < 0, "earlier createdAt first");
  assert.ok(compareMessagesForDisplay(later, earlier) > 0);
});

test("[#480] compareMessagesForDisplay: no-seq vs has-seq at EQUAL createdAt — no-seq sorts after", () => {
  // Equal createdAt forces past the createdAt branch to the seq/no-seq fallbacks
  // (L298/L299). A no-seq row (future seq lands at the tail) sorts AFTER a has-seq
  // row when their time is identical — REGARDLESS of id.
  //
  // Ids are chosen to DISAGREE with the has-seq/no-seq direction (has-seq id "a"
  // < no-seq id "z"): if a mutant collapses L298/L299 into the L300 id tiebreak,
  // the sign flips and the assertion fails. (Equal ids would let the id fallback
  // mask those mutants.)
  const hasSeq = msg({ id: "a", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  const noSeq = msg({ id: "z", createdAt: "2026-07-03T10:00:00Z" });
  assert.ok(compareMessagesForDisplay(hasSeq, noSeq) > 0, "has-seq after no-seq (L298 returns 1, not id which says <0)");
  assert.ok(compareMessagesForDisplay(noSeq, hasSeq) < 0, "no-seq before has-seq (L299 returns -1, not id which says >0)");
});

test("[#480] compareMessagesForDisplay: id breaks ties for equal-seq and for equal-time no-seq rows", () => {
  // Both seq equal → id (L297).
  const s1 = msg({ id: "aaa", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  const s2 = msg({ id: "bbb", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  assert.ok(compareMessagesForDisplay(s1, s2) < 0, "equal seq → id ascending");
  assert.ok(compareMessagesForDisplay(s2, s1) > 0);
  // Both no-seq, equal createdAt → id (L300).
  const n1 = msg({ id: "aaa", createdAt: "2026-07-03T10:00:00Z" });
  const n2 = msg({ id: "bbb", createdAt: "2026-07-03T10:00:00Z" });
  assert.ok(compareMessagesForDisplay(n1, n2) < 0, "equal-time no-seq → id ascending");
  assert.ok(compareMessagesForDisplay(n2, n1) > 0);
});

test("[#480] compareMessagesForDisplay: unparseable createdAt falls through to the id tiebreak (Number.isFinite guard)", () => {
  // Invalid dates → Date.parse NaN → the L293 finite-guard must SKIP the time
  // branch (a force-true Number.isFinite mutant would return NaN and break the
  // sign). id decides instead.
  const bad1 = msg({ id: "aaa", createdAt: "not-a-date" });
  const bad2 = msg({ id: "bbb", createdAt: "also-not-a-date" });
  assert.ok(compareMessagesForDisplay(bad1, bad2) < 0, "unparseable dates fall to id ascending");
  assert.ok(compareMessagesForDisplay(bad2, bad1) > 0);
});

test("[#480] compareMessagesForDisplay: one valid + one unparseable createdAt still uses the finite-AND guard (not OR)", () => {
  // Only the VALID row has a finite time; the L293 guard is `isFinite(a) &&
  // isFinite(b) && a!==b`. If a `&&`→`||` mutant relaxes it, the branch fires with
  // one NaN operand and returns NaN (finite - NaN), breaking the sign. Both rows
  // are no-seq so the correct path is the L300 id tiebreak; ids disagree with the
  // NaN a mutant would produce.
  const valid = msg({ id: "a", createdAt: "2026-07-03T10:00:00Z" });
  const invalid = msg({ id: "z", createdAt: "not-a-date" });
  assert.ok(compareMessagesForDisplay(valid, invalid) < 0, "mixed validity falls to id ascending, not NaN");
  assert.ok(compareMessagesForDisplay(invalid, valid) > 0);
});

test("[#480] sortBySeq (main channel list) actually sorts by the shared comparator", () => {
  // Sibling of the ThreadPanel test — pins messageStore's own `msgs.sort(...)`.
  // Reversed input so sorted order differs from input order.
  const p1 = msg({ id: "p1", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  const optimistic = msg({ id: "optimistic-c", createdAt: "2026-07-03T10:03:00Z" });
  const sorted = sortBySeq([optimistic, p1]);
  assert.equal(sorted.length, 2, "all rows preserved (not emptied)");
  assert.deepEqual(sorted.map((m) => m.id), ["p1", "optimistic-c"], "returns sorted, not input order");
});

test("[#480] sortThreadMessages delegates to the shared comparator (returns all rows, sorted)", () => {
  // Kills ThreadPanel L73 mutants: dropping `.sort` (returns input order) or
  // emptying `[...msgs]` (returns []). Input is deliberately reversed so sorted
  // order differs from input order.
  const p1 = msg({ id: "p1", seq: 5, createdAt: "2026-07-03T10:00:00Z" });
  const optimistic = msg({ id: "optimistic-c", createdAt: "2026-07-03T10:03:00Z" });
  const sorted = sortThreadMessages([optimistic, p1]);
  assert.equal(sorted.length, 2, "all rows preserved (not emptied)");
  assert.deepEqual(sorted.map((m) => m.id), ["p1", "optimistic-c"], "returns sorted, not input order");
});
