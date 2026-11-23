import assert from "node:assert/strict";
import "./helpers/domSetup";
import { createIntl } from "react-intl";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactCard, ArtifactSettled } from "@botiverse/raft-shared";

import type { ArtifactDashboardItem } from "../src/apps/artifacts/artifactDashboardItems";
import { readArtifactDashboardPrefs } from "../src/apps/artifacts/artifactDashboardPrefs";
import type { ArtifactNews } from "../src/apps/artifacts/artifactNews";
import { onOwnSettle, reportOwnSettle } from "../src/apps/artifacts/artifactOwnSettles";
import {
  WORKING_RECENT_MS,
  artifactSettledLine,
  decideHomeGroups,
  foldNews,
  groupArtifactItems,
  isArtifactWorking,
  settleRefusal,
  settledShown,
  withOwnSettles,
  withSettled,
} from "../src/apps/artifacts/artifactSettled";
import type { ArtifactHomeDecision } from "../src/apps/artifacts/artifactSettled";
import { mergedMessages } from "../src/i18n/messages";

// Settled (#334), the web half: which group of the home page an Artifact is in (Working on top, Other folded), a
// title search's one run, the fold's sticker, the fold kept on the device, the tag's words. The flag off (no
// `settled` on the card) shows and offers nothing. The Activity row's lines are in
// artifactHomeGroups.behavior.test.tsx. A DOM test: the Settled line's author words read the signed-in
// person (artifactAuthorText), whose store reads localStorage.

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const RECENT = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
const IDLE = new Date(NOW - WORKING_RECENT_MS - 60_000).toISOString();
const NOTHING: ArtifactNews = { mentioned: false, newerVersion: false, newComments: 0 };
const REMY = { type: "agent" as const, id: "a1", name: "remy", displayName: "Remy", avatarUrl: null };
const SETTLED: ArtifactSettled = { by: REMY, at: "2026-11-18T09:30:00.000Z", version: 3 };

function card(id: string, { updatedAt = RECENT, settled }: { updatedAt?: string; settled?: ArtifactSettled | null } = {}): ArtifactCard {
  return {
    id: asArtifactId(id), url: `https://app.raft.build/artifacts/${id}`, title: id, description: null, kind: "markdown",
    facts: { sizeBytes: 100, fileCount: 1 }, preview: { kind: "none" }, version: 3, pinned: false, latestVersion: 3,
    author: REMY, createdAt: "2026-11-01T00:00:00.000Z", updatedAt, commentCount: 0, home: { kind: "server" },
    ...(settled === undefined ? {} : { settled, reopened: null }),
  };
}

const item = (c: ArtifactCard, news: Partial<ArtifactNews> = {}): ArtifactDashboardItem => ({ card: c, news: { ...NOTHING, ...news }, openedAt: null });

test("Working: not settled and new for the reader or updated in the last 7 days; a settled one only with unseen comments or a mention", () => {
  assert.equal(isArtifactWorking(item(card("recent", { settled: null })), NOW), true);
  assert.equal(isArtifactWorking(item(card("idle", { updatedAt: IDLE, settled: null })), NOW), false);
  assert.equal(isArtifactWorking(item(card("idle-mention", { updatedAt: IDLE, settled: null }), { mentioned: true }), NOW), true);
  assert.equal(isArtifactWorking(item(card("idle-version", { updatedAt: IDLE, settled: null }), { newerVersion: true }), NOW), true);
  assert.equal(isArtifactWorking(item(card("idle-comments", { updatedAt: IDLE, settled: null }), { newComments: 2 }), NOW), true);
  // Settled: updated lately or not, Other, until someone comments or mentions the reader.
  assert.equal(isArtifactWorking(item(card("settled", { settled: SETTLED })), NOW), false);
  assert.equal(isArtifactWorking(item(card("settled-version", { settled: SETTLED }), { newerVersion: true }), NOW), false);
  assert.equal(isArtifactWorking(item(card("settled-comments", { settled: SETTLED }), { newComments: 1 }), NOW), true);
  assert.equal(isArtifactWorking(item(card("settled-mention", { settled: SETTLED }), { mentioned: true }), NOW), true);
  // An unreadable time is not "lately".
  assert.equal(isArtifactWorking(item(card("no-time", { updatedAt: "", settled: null })), NOW), false);
});

test("groups: Working then Other in the server's order; a title search is one run, Working first, no fold", () => {
  const rows = [item(card("a", { settled: SETTLED })), item(card("b", { settled: null })), item(card("c", { updatedAt: IDLE, settled: null })), item(card("d", { settled: null }))];
  const working = (row: ArtifactDashboardItem) => isArtifactWorking(row, NOW);
  const grouped = groupArtifactItems(rows, working, false);
  assert.deepEqual(grouped.working?.map((row) => row.card.id), ["b", "d"]);
  assert.deepEqual(grouped.other.map((row) => row.card.id), ["a", "c"]);
  assert.deepEqual(grouped.all.map((row) => row.card.id), ["b", "d", "a", "c"]);
  const searched = groupArtifactItems(rows, working, true);
  assert.equal(searched.working, null);
  assert.deepEqual(searched.other, []);
  assert.deepEqual(searched.all.map((row) => row.card.id), ["b", "d", "a", "c"]);
});

const decide = (decided: ReadonlyMap<string, ArtifactHomeDecision>, rows: ArtifactDashboardItem[], fresh: boolean, acts: ReadonlyMap<string, number> = new Map()) =>
  decideHomeGroups(decided, rows, { now: NOW, fresh, acts });
const workingIds = (decided: ReadonlyMap<string, ArtifactHomeDecision>) => [...decided].filter(([, d]) => d.working).map(([id]) => id).sort();

test("a row's group holds while the page is open: opening it (its news cleared) or others' changes move nothing", () => {
  const first = decide(new Map(), [item(card("m", { updatedAt: IDLE, settled: null }), { mentioned: true }), item(card("s", { settled: SETTLED }))], true);
  assert.deepEqual(workingIds(first), ["m"]);
  // Read again: its mention read, and someone else unsettled the other; nothing moves, and nothing was decided again.
  const again = decide(first, [item(card("m", { updatedAt: IDLE, settled: null })), item(card("s", { settled: null }), { newComments: 3 })], true);
  assert.equal(again, first);
  // A row first listed later is decided then.
  const later = decide(first, [item(card("n", { settled: null }))], true);
  assert.deepEqual(workingIds(later), ["m", "n"]);
});

test("the tab's cached page decides only until the page's first fresh read: a new mention isn't kept folded, an old row isn't kept on top", () => {
  // The cache (last visit): `a` idle with nothing new, `b` new for the reader then.
  const cached = decide(new Map(), [item(card("a", { updatedAt: IDLE, settled: null })), item(card("b", { updatedAt: IDLE, settled: null }), { newComments: 1 })], false);
  assert.deepEqual(workingIds(cached), ["b"]);
  assert.equal(cached.get("a")?.fromCache, true);
  // Still the cache (a read again of it): held.
  assert.equal(decide(cached, [item(card("a", { updatedAt: IDLE, settled: null }), { mentioned: true })], false), cached);
  // The first fresh page: `a` now mentions the reader, `b` was read since.
  const fresh = decide(cached, [item(card("a", { updatedAt: IDLE, settled: null }), { mentioned: true }), item(card("b", { updatedAt: IDLE, settled: null }))], true);
  assert.deepEqual(workingIds(fresh), ["a"]);
  assert.equal(fresh.get("a")?.fromCache, false);
  // From then on it holds, as any fresh decision.
  assert.equal(decide(fresh, [item(card("a", { updatedAt: IDLE, settled: null }))], true), fresh);
});

test("the reader's own settle or unsettle (from the menu or the viewer: an act) decides its row again, once", () => {
  const first = decide(new Map(), [item(card("w", { settled: null })), item(card("o", { updatedAt: IDLE, settled: SETTLED }))], true);
  assert.deepEqual(workingIds(first), ["w"]);
  // `w` settled by the reader (act 1): to Other. Its answer is on the row (withOwnSettles).
  const settledRows = withOwnSettles([item(card("w", { settled: null })), item(card("o", { updatedAt: IDLE, settled: SETTLED }))], new Map([["w", SETTLED]]));
  const afterSettle = decide(first, settledRows, true, new Map([["w", 1]]));
  assert.deepEqual(workingIds(afterSettle), []);
  assert.equal(afterSettle.get("w")?.act, 1);
  // The same act seen again (the list read again, the server's rows now say so): no new decision.
  assert.equal(decide(afterSettle, [item(card("w", { settled: SETTLED }), { newerVersion: true }), item(card("o", { updatedAt: IDLE, settled: SETTLED }))], true, new Map([["w", 1]])), afterSettle);
  // `o` unsettled in the viewer (act 2): it was updated over 7 days ago with nothing new, so it stays in Other; `w`
  // unsettled again (act 3) goes back to Working (updated lately).
  const rows = withOwnSettles([item(card("w", { settled: SETTLED })), item(card("o", { updatedAt: IDLE, settled: SETTLED }), { newComments: 0 })], new Map([["w", null], ["o", null]]));
  const afterUnsettle = decide(afterSettle, rows, true, new Map([["w", 3], ["o", 2]]));
  assert.deepEqual(workingIds(afterUnsettle), ["w"]);
  assert.equal(afterUnsettle.get("o")?.act, 2);
});

test("the reader's own answers go on the rows; rows without one are the same objects", () => {
  const rows = [item(card("x", { settled: null })), item(card("y", { settled: SETTLED }))];
  assert.equal(withOwnSettles(rows, new Map()), rows);
  const shown = withOwnSettles(rows, new Map([["x", SETTLED]]));
  assert.deepEqual(shown[0]?.card.settled, SETTLED);
  assert.equal(shown[1], rows[1]);
});

test("the reader's own acts reach every listener, in order, until it stops listening", () => {
  const heard: Array<[string, number, boolean]> = [];
  const stop = onOwnSettle(({ id, seq, settled }) => heard.push([id, seq, settled !== null]));
  reportOwnSettle(asArtifactId("pt_a"), SETTLED);
  reportOwnSettle(asArtifactId("pt_b"), null);
  stop();
  reportOwnSettle(asArtifactId("pt_c"), null);
  assert.deepEqual(heard.map(([id, , isSettled]) => [id, isSettled]), [["pt_a", true], ["pt_b", false]]);
  assert.ok((heard[1]?.[1] ?? 0) > (heard[0]?.[1] ?? 0));
});

test("the fold's sticker says everything new inside it", () => {
  assert.deepEqual(foldNews([item(card("x"), { newComments: 2 }), item(card("y"), { mentioned: true, newComments: 1 }), item(card("z"))]), { mentioned: true, newerVersion: false, newComments: 3 });
  assert.deepEqual(foldNews([]), NOTHING);
});

test("the flag off: no `settled` on the card, nothing of Settled shown", () => {
  assert.equal(settledShown(card("off")), false);
  assert.equal(settledShown(card("working", { settled: null })), true);
  assert.equal(settledShown(card("settled", { settled: SETTLED })), true);
});

test("the reader's own settle or unsettle goes on the card, and ends Working again", () => {
  const reopened = { ...card("r", { settled: null }), reopened: { version: 4, was: SETTLED } };
  const settled = withSettled(reopened, SETTLED);
  assert.deepEqual(settled.settled, SETTLED);
  assert.equal(settled.reopened, null);
  assert.equal(withSettled(settled, null).settled, null);
});

test("Other is folded by default and kept on the device", () => {
  assert.equal(readArtifactDashboardPrefs(null).otherOpen, false);
  assert.equal(readArtifactDashboardPrefs("{\"view\":\"list\"}").otherOpen, false);
  assert.equal(readArtifactDashboardPrefs("{\"otherOpen\":true}").otherOpen, true);
  assert.equal(readArtifactDashboardPrefs("{\"otherOpen\":\"yes\"}").otherOpen, false);
});

test("words: the tag's who, when and version; a refusal by its code", () => {
  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  const line = artifactSettledLine(SETTLED, null, intl);
  assert.match(line, /^Remy settled it on .+ \(v3\)$/);
  const you = artifactSettledLine({ ...SETTLED, by: { ...REMY, type: "user", id: "u1" } }, "u1", intl);
  assert.match(you, /^You settled it on /);
  assert.equal(settleRefusal("FORBIDDEN"), "artifacts.settled.forbidden");
  assert.equal(settleRefusal("SETTLED_NOT_AVAILABLE"), "artifacts.settled.failed");
  assert.equal(settleRefusal(null), "artifacts.settled.failed");
});
