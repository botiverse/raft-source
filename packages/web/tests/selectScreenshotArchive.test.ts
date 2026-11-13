import assert from "node:assert/strict";
import { createScreenshotZip, screenshotPageFilename } from "../src/utils/selectScreenshotArchive";

const image = (byte: number) => ({
  dataUrl: "data:image/png;base64,AA==",
  blob: new Blob([Uint8Array.of(byte)], { type: "image/png" }),
  width: 1,
  height: 1,
  pixelRatio: 1,
});

test("page filenames are stable and ordered", () => {
  assert.equal(screenshotPageFilename("raft-thread.png", 1, 1), "raft-thread.png");
  assert.equal(screenshotPageFilename("raft-thread.png", 2, 12), "raft-thread-02-of-12.png");
});

test("multi-page ZIP contains every ordered PNG name", async () => {
  const zip = await createScreenshotZip([image(1), image(2), image(3)], "raft-thread.png");
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.ok(text.indexOf("raft-thread-1-of-3.png") < text.indexOf("raft-thread-2-of-3.png"));
  assert.ok(text.indexOf("raft-thread-2-of-3.png") < text.indexOf("raft-thread-3-of-3.png"));
  assert.equal((text.match(/raft-thread-[123]-of-3\.png/g) ?? []).length, 6, "local + central entry for every page");
});
