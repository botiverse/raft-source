import assert from "node:assert/strict";
import type { AttachmentPreviewResponse, XlsxAttachmentPreviewData } from "@botiverse/raft-shared";
import * as XLSX from "xlsx";
import type { ResolvedAttachment } from "../attachmentRecord";
import {
  ATTACHMENT_PREVIEW_CACHE_MIN_COMPUTE_MS,
  ATTACHMENT_PREVIEW_CACHE_VERSION,
  attachmentPreviewContentKey,
  getAttachmentPreviewWithCache,
  type AttachmentPreviewCacheRow,
  type AttachmentPreviewCacheStore,
} from "./previewCache";
import { buildXlsxPreview, fitXlsxPreviewToPayloadCap, XLSX_PREVIEW_MAX_SHEETS } from "./providers/xlsx";

type Attachment = ResolvedAttachment;

function workbook(sheets: number, rows: number, columns: number, cellLength: number): Buffer {
  const book = XLSX.utils.book_new();
  for (let sheet = 0; sheet < sheets; sheet += 1) {
    const aoa = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) => `${sheet}-${row}-${column}-${"x".repeat(cellLength)}`));
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), `S${sheet}`);
  }
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}

// The pre-#19 loop: re-serialize the whole preview after every dropped row.
function referenceFit(preview: XlsxAttachmentPreviewData, cap: number): XlsxAttachmentPreviewData | null {
  while (Buffer.byteLength(JSON.stringify(preview), "utf8") > cap) {
    const target = [...preview.sheets].reverse().find((sheet) => sheet.rows.length > 0);
    if (!target) return null;
    target.rows.pop();
    target.truncated = true;
    preview.truncated = true;
  }
  return preview;
}

function syntheticPreview(rowsPerSheet: number[], cellLength: number): XlsxAttachmentPreviewData {
  return {
    kind: "xlsx",
    sheetCount: rowsPerSheet.length,
    truncated: false,
    sheets: rowsPerSheet.map((rows, sheet) => ({
      name: `S${sheet}`,
      headers: ["a", "b", "c"],
      rows: Array.from({ length: rows }, (_, row) => [`${sheet}`, `${row}`, "é".repeat((row * 7 + sheet) % cellLength)]),
      rowCount: rows,
      columnCount: 3,
      truncated: false,
    })),
  };
}

test("linear payload fit drops the same rows as the old quadratic loop, or at most one more", () => {
  for (const [rows, cellLength, cap] of [
    [[40, 40, 40], 50, 4_000],
    [[5, 0, 120], 30, 2_500],
    [[200], 80, 64 * 1024],
    [[3, 3], 10, 40],
  ] as const) {
    const expected = referenceFit(syntheticPreview([...rows], cellLength), cap);
    const actual = fitXlsxPreviewToPayloadCap(syntheticPreview([...rows], cellLength), cap);
    if (expected === null) {
      assert.equal(actual, null);
      continue;
    }
    assert.ok(actual !== null);
    assert.ok(Buffer.byteLength(JSON.stringify(actual), "utf8") <= cap);
    const expectedRows = expected.sheets.map((sheet) => sheet.rows.length);
    const actualRows = actual.sheets.map((sheet) => sheet.rows.length);
    const dropped = expectedRows.reduce((sum, count, index) => sum + count - actualRows[index], 0);
    assert.ok(dropped === 0 || dropped === 1, `rows ${actualRows} vs ${expectedRows}`);
    assert.equal(actual.truncated, expected.truncated);
  }
});

test("a wide multi-sheet workbook is previewed without quadratic re-serialization", () => {
  // 20 sheets x 300 rows of long cells took ~56 s before task #19.
  const started = performance.now();
  const preview = buildXlsxPreview(workbook(20, 300, 20, 60));
  const elapsedMs = performance.now() - started;
  assert.ok(preview !== null);
  assert.equal(preview.sheetCount, 20);
  assert.equal(preview.sheets.length, XLSX_PREVIEW_MAX_SHEETS);
  assert.equal(preview.truncated, true);
  assert.ok(elapsedMs < 10_000, `took ${elapsedMs} ms`);
});

const attachment = {
  id: "11111111-1111-4111-8111-111111111111",
  objectId: "22222222-2222-4222-8222-222222222222",
  storageKey: "srv/att/obj.xlsx",
  sizeBytes: 1234,
  filename: "book.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as Attachment;
const textAttachment = { ...attachment, id: "33333333-3333-4333-8333-333333333333", filename: "notes.txt", mimeType: "text/plain" } as Attachment;
const okResponse: AttachmentPreviewResponse = { status: "ok", data: { kind: "text", text: "hi" } as never };

function memoryStore(initial: Record<string, AttachmentPreviewCacheRow> = {}) {
  const rows = new Map(Object.entries(initial));
  const calls = { reads: 0, writes: 0, touches: 0 };
  const store: AttachmentPreviewCacheStore = {
    async read(id) { calls.reads += 1; return rows.get(id) ?? null; },
    async write(id, row) { calls.writes += 1; rows.set(id, { ...row, lastHitAt: new Date() }); },
    async touch() { calls.touches += 1; },
  };
  return { store, rows, calls };
}

function clock(stepMs: number) {
  let now = 0;
  return () => { const value = now; now += stepMs; return value; };
}

test("xlsx previews are stored and then served from the cache without rebuilding", async () => {
  const { store, calls } = memoryStore();
  let builds = 0;
  const build = async () => { builds += 1; return okResponse; };
  const first = await getAttachmentPreviewWithCache(attachment, { store, build, now: clock(1) });
  assert.equal(first.cache, "miss_stored");
  const second = await getAttachmentPreviewWithCache(attachment, { store, build, now: clock(1) });
  assert.equal(second.cache, "hit");
  assert.deepEqual(second.response, okResponse);
  assert.equal(builds, 1);
  assert.equal(calls.writes, 1);
});

test("cheap previews of light kinds are recomputed, slow ones are stored", async () => {
  const fast = memoryStore();
  const cheap = await getAttachmentPreviewWithCache(textAttachment, { store: fast.store, build: async () => okResponse, now: clock(1) });
  assert.equal(cheap.cache, "miss_not_stored");
  assert.equal(fast.calls.writes, 0);

  const slow = memoryStore();
  const costly = await getAttachmentPreviewWithCache(textAttachment, {
    store: slow.store, build: async () => okResponse, now: clock(ATTACHMENT_PREVIEW_CACHE_MIN_COMPUTE_MS),
  });
  assert.equal(costly.cache, "miss_stored");
  assert.equal(slow.calls.writes, 1);
});

test("a cached row is ignored when the content key or provider version no longer matches", async () => {
  for (const stale of [
    { contentKey: "other-object:key:1", providerVersion: ATTACHMENT_PREVIEW_CACHE_VERSION },
    { contentKey: attachmentPreviewContentKey(attachment), providerVersion: ATTACHMENT_PREVIEW_CACHE_VERSION + 1 },
  ]) {
    const { store } = memoryStore({ [attachment.id]: { ...stale, preview: { status: "unsupported" }, lastHitAt: new Date() } });
    let builds = 0;
    const result = await getAttachmentPreviewWithCache(attachment, { store, build: async () => { builds += 1; return okResponse; }, now: clock(1) });
    assert.equal(builds, 1);
    assert.equal(result.cache, "miss_stored");
    assert.deepEqual(result.response, okResponse);
  }
});

test("simultaneous requests share one cache lookup and one build", async () => {
  // All three arrive before the first cache read resolves: none may slip past
  // the in-flight check and rebuild (Tenny's review on #9856).
  const { store, calls } = memoryStore();
  let builds = 0;
  const build = async () => { builds += 1; return okResponse; };
  const results = await Promise.all([1, 2, 3].map(() => getAttachmentPreviewWithCache(attachment, { store, build, now: clock(1) })));
  assert.equal(builds, 1);
  assert.equal(calls.reads, 1);
  assert.deepEqual(results.map((result) => result.cache).sort(), ["miss_stored", "shared", "shared"]);
  assert.ok(results.every((result) => result.response === okResponse));
  // Once settled, a later request goes back to the cache.
  assert.equal((await getAttachmentPreviewWithCache(attachment, { store, build, now: clock(1) })).cache, "hit");
});

test("a failed build is shared, then forgotten so the next request retries", async () => {
  const { store } = memoryStore();
  let builds = 0;
  const build = async () => { builds += 1; if (builds === 1) throw new Error("storage gone"); return okResponse; };
  const settled = await Promise.allSettled([1, 2].map(() => getAttachmentPreviewWithCache(attachment, { store, build, now: clock(1) })));
  assert.deepEqual(settled.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(builds, 1);
  assert.equal((await getAttachmentPreviewWithCache(attachment, { store, build, now: clock(1) })).cache, "miss_stored");
});

test("cache failures fall back to building the preview", async () => {
  const errors: unknown[] = [];
  const broken: AttachmentPreviewCacheStore = {
    async read() { throw new Error("db down"); },
    async write() { throw new Error("db down"); },
    async touch() { throw new Error("db down"); },
  };
  const result = await getAttachmentPreviewWithCache(attachment, {
    store: broken, build: async () => okResponse, now: clock(1), onCacheError: (err) => errors.push(err),
  });
  assert.deepEqual(result.response, okResponse);
  assert.equal(errors.length, 2);
});

test("a hit refreshes last_hit_at only when it is older than an hour", async () => {
  const fresh = memoryStore({ [attachment.id]: { contentKey: attachmentPreviewContentKey(attachment), providerVersion: ATTACHMENT_PREVIEW_CACHE_VERSION, preview: okResponse, lastHitAt: new Date() } });
  await getAttachmentPreviewWithCache(attachment, { store: fresh.store, build: async () => okResponse });
  assert.equal(fresh.calls.touches, 0);
  const old = memoryStore({ [attachment.id]: { contentKey: attachmentPreviewContentKey(attachment), providerVersion: ATTACHMENT_PREVIEW_CACHE_VERSION, preview: okResponse, lastHitAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
  await getAttachmentPreviewWithCache(attachment, { store: old.store, build: async () => okResponse });
  assert.equal(old.calls.touches, 1);
});

test("a transient unavailable response is never stored, so the next request rebuilds", async () => {
  // reason "unavailable" is pool degradation, not a property of the file;
  // xlsx is ALWAYS_CACHED_KINDS, so this pins the explicit exclusion.
  const unavailable: AttachmentPreviewResponse = { status: "unsupported", reason: "unavailable" };
  const { store, calls } = memoryStore();
  const first = await getAttachmentPreviewWithCache(attachment, { store, build: async () => unavailable, now: clock(1) });
  assert.equal(first.cache, "miss_not_stored");
  assert.equal(calls.writes, 0);
  const recovered = await getAttachmentPreviewWithCache(attachment, { store, build: async () => okResponse, now: clock(1) });
  assert.equal(recovered.cache, "miss_stored");
  assert.deepEqual(recovered.response, okResponse);
});

test("only parse time decides caching: a slow download with a fast parse is not stored", async () => {
  // The storage download is async I/O; counting it filled the table with
  // cheap text/markdown rows (task #17 follow-up: 59% of rows).
  const slowFetch = memoryStore();
  const fetchHeavy = await getAttachmentPreviewWithCache(textAttachment, {
    store: slowFetch.store,
    build: async (_attachment, timings) => { timings.fetchMs = 900; timings.parseMs = 5; return okResponse; },
    now: clock(1_000),
  });
  assert.equal(fetchHeavy.cache, "miss_not_stored");
  assert.equal(fetchHeavy.fetchMs, 900);
  assert.equal(fetchHeavy.parseMs, 5);
  assert.equal(slowFetch.calls.writes, 0);

  const slowParse = memoryStore();
  const parseHeavy = await getAttachmentPreviewWithCache(textAttachment, {
    store: slowParse.store,
    build: async (_attachment, timings) => { timings.fetchMs = 3; timings.parseMs = ATTACHMENT_PREVIEW_CACHE_MIN_COMPUTE_MS; return okResponse; },
    now: clock(1),
  });
  assert.equal(parseHeavy.cache, "miss_stored");
  assert.equal(slowParse.calls.writes, 1);
});
