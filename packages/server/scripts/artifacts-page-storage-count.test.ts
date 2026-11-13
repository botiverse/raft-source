import assert from "node:assert/strict";
import { countStorageUses, isPageSource, storageUses } from "./artifacts-page-storage-count";

test("a page or a script of the set is read; an image, a stylesheet or data is not", () => {
  for (const path of ["index.html", "docs/Page.HTM", "app.js", "lib/mod.mjs"]) assert.equal(isPageSource(path), true, path);
  for (const path of ["logo.png", "style.css", "data.json", "notes.md", "js", "page.html.bak"]) assert.equal(isPageSource(path), false, path);
});

test("each API is matched as a word in the source, and nothing else is", () => {
  assert.deepEqual(storageUses("const db = indexedDB.open('x')"), ["indexedDB"]);
  assert.deepEqual(storageUses("caches.open('v1'); new CacheStorage()"), ["cacheApi"]);
  assert.deepEqual(storageUses("document . cookie = 'a=b'"), ["cookie"]);
  assert.deepEqual(storageUses("window.localStorage.setItem('k', 'v')"), ["localStorage"]);
  assert.deepEqual(storageUses("myindexedDBlike; cookies; sessionStorage; cachesX"), []);
  assert.deepEqual(storageUses("indexedDB; document.cookie; localStorage; caches.keys()").sort(), ["cacheApi", "cookie", "indexedDB", "localStorage"]);
});

test("counts are per Artifact, over every page and script of its current version; nothing but counts comes back", async () => {
  const rows = [
    { itemId: "a", path: "index.html", r2Key: "k1", sizeBytes: 10 },
    { itemId: "a", path: "app.js", r2Key: "k2", sizeBytes: 20 },
    { itemId: "b", path: "index.html", r2Key: "k3", sizeBytes: 30 },
    { itemId: "c", path: "index.html", r2Key: "k4", sizeBytes: 40 },
    { itemId: "d", path: "index.html", r2Key: "k5", sizeBytes: 9_000 },
    { itemId: "e", path: "index.html", r2Key: "gone", sizeBytes: 5 },
    { itemId: "f", path: "index.html", r2Key: "broken", sizeBytes: 6 },
  ];
  const sources: Record<string, string> = {
    k1: "<p>plain</p>",
    k2: "indexedDB.open('x'); localStorage.getItem('k')",
    k3: "localStorage.setItem('k', 'v')",
    k4: "document.cookie; caches.open('v')",
  };
  const read: string[] = [];
  const count = await countStorageUses(8, rows, async (row) => {
    read.push(row.r2Key);
    if (row.r2Key === "broken") throw new Error("NoSuchKey: servers/s/blobs/abc/broken");
    return sources[row.r2Key] ?? null;
  }, { maxBytes: 1_000, concurrency: 3 });
  assert.deepEqual(count, {
    artifacts: 8,
    artifactsWithPages: 6,
    uses: { indexedDB: 1, cacheApi: 1, cookie: 1, localStorage: 2 },
    // a (IndexedDB) and c (a cookie and the Cache API): b uses only what a nested page keeps.
    usesAnyMissing: 2,
    filesRead: 4,
    bytesRead: 100,
    filesSkippedLarge: 1,
    filesMissing: 1,
    // A read that threw is counted and nothing of its message kept.
    filesFailed: 1,
  });
  assert.ok(!read.includes("k5"), "a file past the cap is never read");
  assert.equal(/k1|index\.html|broken|NoSuchKey/.test(JSON.stringify(count)), false, "no key, no path, no error text");
});
