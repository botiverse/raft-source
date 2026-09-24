/**
 * task #364 S2 — the window bundle is the ONLY source decision.
 *
 * @赵梓淇's constraint: rows and every count travel together; "core rows with
 * legacy totals" must be unrepresentable, not merely avoided. That shape is the
 * natural accident in `ThreadsInbox`, where items come from `v2SourceItems` and
 * counts from `activityGroups` — swap one and the panel renders core rows under
 * a legacy badge and looks entirely normal.
 *
 * REQUIRED REVERSE CUT (verified): change the core branch of
 * `buildActivityWindowBundle` to carry `...legacy` totals alongside the core
 * rows — i.e. the exact splice — and "core totals come from the core" goes RED
 * while nothing else moves.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActivityWindowBundle,
} from "../src/store/activityPanel/windowBundle";
import type {
  ActivityWindowInputs,
} from "../src/store/activityPanel/windowBundle";
import type { ActivityWindowAuthority } from "../src/store/activityPanel/windowAuthority";

type Item = { id: string };
type Group = { key: string; count: number };

/** Legacy and core are made VISIBLY different so a splice cannot look plausible. */
const LEGACY: ActivityWindowInputs<Item, Group> = {
  items: [{ id: "legacy-1" }, { id: "legacy-2" }],
  groups: [{ key: "legacy", count: 40 }],
  totalCount: 40,
  totalUnreadCount: 7,
  hasMore: true,
  nextCursor: "legacy-cursor",
  complete: false,
};

const CORE_ROWS = [
  { latestActivitySeq: "9007199254740993", rowId: "core-1" },
];

function coreVerdict(overrides: Partial<Extract<ActivityWindowAuthority, { authority: "core" }>> = {}) {
  return {
    authority: "core" as const,
    rows: CORE_ROWS,
    nextCursor: null,
    hasMore: false,
    complete: true,
    totalCount: 1,
    totalUnreadCount: 0,
    activityVersion: "7",
    ...overrides,
  };
}

const projectCoreRows = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  items: rows.map((r) => ({ id: String(r.rowId) })),
  groups: [{ key: "core", count: rows.length }],
});

test("a legacy verdict yields a wholly legacy bundle, carrying its denial reason", () => {
  const bundle = buildActivityWindowBundle<Item, Group>({
    verdict: { authority: "legacy", reason: "repair_pending" },
    legacy: LEGACY,
    projectCoreRows,
  });

  assert.equal(bundle.source, "legacy");
  assert.equal(bundle.source === "legacy" ? bundle.reason : null, "repair_pending");
  assert.deepEqual(bundle.items, LEGACY.items);
  assert.deepEqual(bundle.groups, LEGACY.groups);
  assert.equal(bundle.totalCount, 40);
});

test("a core verdict yields core rows AND core totals — never legacy counts", () => {
  const bundle = buildActivityWindowBundle<Item, Group>({
    verdict: coreVerdict(),
    legacy: LEGACY,
    projectCoreRows,
  });

  assert.equal(bundle.source, "core");
  assert.deepEqual(bundle.items, [{ id: "core-1" }]);
  // The load-bearing assertions: every count is the CORE's. If any of these
  // read 40 / 7 / true, the panel would show one core row under a legacy badge.
  assert.equal(bundle.totalCount, 1, "totalCount must come from the core window, not legacy");
  assert.equal(bundle.totalUnreadCount, 0, "unread total must come from the core window");
  assert.equal(bundle.hasMore, false, "hasMore must come from the core window");
  assert.deepEqual(bundle.groups, [{ key: "core", count: 1 }], "groups must describe the CORE row set");
  // Pagination belongs to the whole window: a load-more that kept the legacy
  // cursor would page into a list the core never had.
  assert.equal(bundle.nextCursor, null, "nextCursor must come from the core window, not legacy");
  assert.equal(bundle.complete, true, "complete must come from the core window, not legacy");
});

test("a core window that cannot be projected degrades WHOLLY to legacy", () => {
  const bundle = buildActivityWindowBundle<Item, Group>({
    verdict: coreVerdict(),
    legacy: LEGACY,
    projectCoreRows: () => null,
  });

  assert.equal(bundle.source, "legacy");
  assert.deepEqual(bundle.items, LEGACY.items, "a half-projected list is the splice this prevents");
  assert.equal(bundle.totalCount, 40, "and its counts must be legacy's too, not the core's");
  assert.equal(
    bundle.source === "legacy" ? bundle.reason : null,
    "core_projection_unavailable",
    "the reason must name what actually failed — reporting the frontier check here would be a lie, it already passed upstream",
  );
  assert.equal(bundle.nextCursor, "legacy-cursor", "a legacy fallback keeps legacy's cursor");
});

test("an INCOMPLETE core window falls back whole: page-derived groups cannot describe the full set", () => {
  // rows=1 but totalCount=40 with more to fetch. Any grouping derived from the
  // loaded page says 1 while the totals say 40 — internally inconsistent even
  // though every field came from the core.
  const bundle = buildActivityWindowBundle<Item, Group>({
    verdict: coreVerdict({ complete: false, hasMore: true, totalCount: 40, nextCursor: "core-cursor" }),
    legacy: LEGACY,
    projectCoreRows,
  });

  assert.equal(bundle.source, "legacy", "a paginated core window may not be served until the core carries authoritative groups");
  assert.equal(bundle.source === "legacy" ? bundle.reason : null, "core_window_incomplete");
  assert.deepEqual(bundle.items, LEGACY.items);
  assert.equal(bundle.totalCount, 40);
  assert.equal(bundle.nextCursor, "legacy-cursor");
});

test("a core window whose fields contradict each other falls back whole", () => {
  // @赵梓淇 found this: the fold accepts complete/hasMore/nextCursor/totalCount
  // field-by-field with NO cross-field invariant, so `complete: true` alone
  // does not mean the loaded rows are the whole result set. Each row below is a
  // window that passed the old `!complete` check and was served as core while
  // its groups described 1 row and its totals described 40.
  const cases = [
    {
      name: "complete but still advertising more pages",
      verdict: coreVerdict({ complete: true, hasMore: true, totalCount: 1 }),
      reason: "core_window_incoherent",
    },
    {
      name: "complete but still holding a cursor",
      verdict: coreVerdict({ complete: true, nextCursor: "core-cursor", totalCount: 1 }),
      reason: "core_window_incoherent",
    },
    {
      name: "complete but the total does not match the rows in hand",
      verdict: coreVerdict({ complete: true, hasMore: false, nextCursor: null, totalCount: 40 }),
      reason: "core_window_incoherent",
    },
    {
      name: "not complete at all",
      verdict: coreVerdict({ complete: false }),
      reason: "core_window_incomplete",
    },
  ] as const;

  for (const c of cases) {
    const bundle = buildActivityWindowBundle<Item, Group>({
      verdict: c.verdict,
      legacy: LEGACY,
      projectCoreRows,
    });
    assert.equal(bundle.source, "legacy", `${c.name}: must not be served from the core`);
    assert.equal(
      bundle.source === "legacy" ? bundle.reason : null,
      c.reason,
      `${c.name}: the reason must name what actually failed`,
    );
    assert.deepEqual(bundle.items, LEGACY.items, `${c.name}: items must be legacy's`);
    assert.equal(bundle.totalCount, 40, `${c.name}: counts must be legacy's`);
  }
});

test("a coherent core window — rows ARE the whole set — is still served from the core", () => {
  // The gate must not be so strict that nothing can ever be served; without
  // this, every case above would pass even if the core branch were unreachable.
  const bundle = buildActivityWindowBundle<Item, Group>({
    verdict: coreVerdict({ complete: true, hasMore: false, nextCursor: null, totalCount: 1 }),
    legacy: LEGACY,
    projectCoreRows,
  });

  assert.equal(bundle.source, "core");
  assert.deepEqual(bundle.items, [{ id: "core-1" }]);
  assert.equal(bundle.totalCount, 1);
});

test("every denial reason produces legacy, so a new reason cannot silently serve the core", () => {
  for (const reason of [
    "gate_closed",
    "scope_absent",
    "repair_pending",
    "no_baseline",
    "row_missing_latest_activity_seq",
  ] as const) {
    const bundle = buildActivityWindowBundle<Item, Group>({
      verdict: { authority: "legacy", reason },
      legacy: LEGACY,
      projectCoreRows,
    });
    assert.equal(bundle.source, "legacy", `${reason} must not serve the core`);
    assert.equal(bundle.totalCount, 40, `${reason}: counts must stay legacy's`);
  }
});
