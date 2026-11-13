import assert from "node:assert/strict";

import { dataUrlToBlob } from "../src/utils/dataUrlBlob";
import { dataUrlToPngFile } from "../src/utils/selectMarkdown";

// A 1x1 transparent PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("#triage:#352: a data URL's bytes and type, decoded in place", async () => {
  const blob = dataUrlToBlob(PNG);
  assert.equal(blob.type, "image/png");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "the PNG signature");
  assert.throws(() => dataUrlToBlob("https://example.com/a.png"), /not a base64 data URL/);
  assert.throws(() => dataUrlToBlob("data:image/png,raw"), /not a base64 data URL/);
});

test("#triage:#352: the generated image is read without fetch (Raft Desktop's page policy refuses fetch of a data URL)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("Refused to connect: connect-src"))) as typeof fetch;
  try {
    const file = await dataUrlToPngFile(PNG, "messages.png");
    assert.equal(file.name, "messages.png");
    assert.equal(file.type, "image/png");
    assert.ok(file.size > 0, "the image's bytes, not an empty file");
  } finally {
    globalThis.fetch = original;
  }
});
