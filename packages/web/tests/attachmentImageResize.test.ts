import assert from "node:assert/strict";

import { vi } from "vitest";

import {
  IMAGE_RESIZE_MAX_INPUT_BYTES,
  IMAGE_RESIZE_MAX_LONG_EDGE,
  IMAGE_RESIZE_MIN_BYTES,
  IMAGE_RESIZE_QUALITY,
  browserImageResizeCodec,
  filenameForResizedType,
  prepareAttachmentFileForUpload,
  resizableImageType,
  resizedDimensions,
} from "../src/utils/attachmentImageResize";
import type { ImageResizeCodec, ResizableImageType } from "../src/utils/attachmentImageResize";

const MiB = 1024 * 1024;

function fileOf(size: number, type: string, name: string, lastModified = 1_700_000_000_000): File {
  return new File([new Uint8Array(size)], name, { type, lastModified });
}

type EncodeCall = Readonly<{ width: number; height: number; type: ResizableImageType; quality: number }>;

/** A fake codec: decodes to `width` x `height`, encodes to `outputBytes` (or what `encodeAs` says). */
function fakeCodec(options: {
  width?: number;
  height?: number;
  decodeError?: boolean;
  outputBytes?: number;
  /** The type the "browser" actually produces for a requested type; null = encode fails. */
  produces?: (requested: ResizableImageType) => string | null;
  encodeThrows?: boolean;
  hang?: boolean;
}) {
  const encodes: EncodeCall[] = [];
  let closed = 0;
  const hung: Array<() => void> = [];
  const codec: ImageResizeCodec = {
    async decode() {
      if (options.decodeError) throw new Error("undecodable");
      return { width: options.width ?? 4032, height: options.height ?? 3024, close: () => { closed += 1; } };
    },
    async encode(_image, width, height, type, quality) {
      encodes.push({ width, height, type, quality });
      // A hang holds the (one) resize slot until the test releases it.
      if (options.hang) return new Promise<Blob | null>((resolve) => { hung.push(() => resolve(null)); });
      if (options.encodeThrows) throw new Error("encoder crashed");
      const produced = options.produces ? options.produces(type) : type;
      if (produced === null) return null;
      return new Blob([new Uint8Array(options.outputBytes ?? MiB)], { type: produced });
    },
  };
  return { codec, encodes, closed: () => closed, release: () => { for (const done of hung.splice(0)) done(); } };
}

test("only JPEG and WebP are resizable, by MIME or (when the MIME is empty) by extension", () => {
  assert.equal(resizableImageType({ type: "image/jpeg", name: "a.bin" }), "image/jpeg");
  assert.equal(resizableImageType({ type: "IMAGE/WEBP", name: "a" }), "image/webp");
  assert.equal(resizableImageType({ type: "", name: "IMG_1.JPG" }), "image/jpeg");
  assert.equal(resizableImageType({ type: "", name: "x.jpeg" }), "image/jpeg");
  assert.equal(resizableImageType({ type: "", name: "x.webp" }), "image/webp");
  for (const [type, name] of [
    ["image/png", "a.png"],
    ["image/gif", "a.gif"],
    ["image/heic", "a.heic"],
    ["video/mp4", "a.mp4"],
    ["application/pdf", "a.pdf"],
    ["image/png", "misnamed.jpg"],
    ["", "a.png"],
    ["", "jpg"],
  ] as const) {
    assert.equal(resizableImageType({ type, name }), null, `${type} ${name}`);
  }
});

test("the long edge is capped at 2560 px with the aspect kept, and nothing is upscaled", () => {
  assert.equal(IMAGE_RESIZE_MAX_LONG_EDGE, 2560);
  assert.deepEqual(resizedDimensions(4032, 3024), { width: 2560, height: 1920 });
  assert.deepEqual(resizedDimensions(3024, 4032), { width: 1920, height: 2560 });
  assert.deepEqual(resizedDimensions(2560, 100), { width: 2560, height: 100 });
  assert.deepEqual(resizedDimensions(1200, 800), { width: 1200, height: 800 });
  assert.deepEqual(resizedDimensions(100_000, 10), { width: 2560, height: 1 });
});

test("the name keeps its base and only changes extension when the type changes", () => {
  assert.equal(filenameForResizedType("IMG_0001.JPG", "image/jpeg", "image/jpeg"), "IMG_0001.JPG");
  assert.equal(filenameForResizedType("shot.webp", "image/webp", "image/webp"), "shot.webp");
  assert.equal(filenameForResizedType("shot.webp", "image/webp", "image/jpeg"), "shot.jpg");
  assert.equal(filenameForResizedType("my.photo.WEBP", "image/webp", "image/jpeg"), "my.photo.jpg");
  assert.equal(filenameForResizedType("noext", "image/webp", "image/jpeg"), "noext.jpg");
  assert.equal(filenameForResizedType(".webp", "image/webp", "image/jpeg"), ".webp.jpg");
});

test("a large JPEG is resized to the same type at 0.85, keeping its name and lastModified", async () => {
  const original = fileOf(4 * MiB, "image/jpeg", "IMG_0001.jpg", 1_650_000_000_000);
  const fake = fakeCodec({ outputBytes: MiB });
  const prepared = await prepareAttachmentFileForUpload(original, { codec: fake.codec });

  assert.equal(prepared.outcome, "resized");
  assert.equal(prepared.originalBytes, 4 * MiB);
  assert.equal(prepared.file.size, MiB);
  assert.equal(prepared.file.type, "image/jpeg");
  assert.equal(prepared.file.name, "IMG_0001.jpg");
  assert.equal(prepared.file.lastModified, 1_650_000_000_000);
  assert.equal(prepared.width, 2560);
  assert.equal(prepared.height, 1920);
  assert.deepEqual(fake.encodes, [{ width: 2560, height: 1920, type: "image/jpeg", quality: IMAGE_RESIZE_QUALITY }]);
  assert.equal(IMAGE_RESIZE_QUALITY, 0.85);
  assert.equal(fake.closed(), 1);

  // A retry of the same upload does not re-encode its own output.
  const again = await prepareAttachmentFileForUpload(prepared.file, { codec: fake.codec });
  assert.equal(again.outcome, "already_prepared");
  assert.equal(again.file, prepared.file);
  assert.equal(fake.encodes.length, 1);
});

test("an extension-only JPEG gets a real type once resized", async () => {
  const prepared = await prepareAttachmentFileForUpload(fileOf(5 * MiB, "", "scan.jpeg"), { codec: fakeCodec({}).codec });
  assert.equal(prepared.outcome, "resized");
  assert.equal(prepared.file.type, "image/jpeg");
  assert.equal(prepared.file.name, "scan.jpeg");
});

test("WebP stays WebP, or becomes JPEG with a .jpg name when the browser cannot encode WebP", async () => {
  const webp = fileOf(4 * MiB, "image/webp", "shot.webp");
  const kept = await prepareAttachmentFileForUpload(webp, { codec: fakeCodec({}).codec });
  assert.equal(kept.outcome, "resized");
  assert.equal(kept.file.type, "image/webp");
  assert.equal(kept.file.name, "shot.webp");

  // Browsers silently hand back PNG for a type they cannot encode.
  const fallback = fakeCodec({ produces: (requested) => (requested === "image/webp" ? "image/png" : requested) });
  const converted = await prepareAttachmentFileForUpload(webp, { codec: fallback.codec });
  assert.equal(converted.outcome, "resized");
  assert.equal(converted.file.type, "image/jpeg");
  assert.equal(converted.file.name, "shot.jpg");
  assert.deepEqual(fallback.encodes.map((call) => call.type), ["image/webp", "image/jpeg"]);
});

test("files outside the rule are returned untouched without decoding", async () => {
  const fake = fakeCodec({});
  const cases = [
    fileOf(IMAGE_RESIZE_MIN_BYTES - 1, "image/jpeg", "small.jpg"),
    fileOf(8 * MiB, "image/png", "big.png"),
    fileOf(8 * MiB, "image/gif", "big.gif"),
    fileOf(8 * MiB, "image/heic", "big.heic"),
    fileOf(8 * MiB, "video/mp4", "big.mp4"),
    fileOf(8 * MiB, "application/zip", "big.zip"),
    // Above the decode-safety cap a JPEG goes up untouched.
    fileOf(IMAGE_RESIZE_MAX_INPUT_BYTES + 1, "image/jpeg", "huge.jpg"),
  ];
  for (const file of cases) {
    const prepared = await prepareAttachmentFileForUpload(file, { codec: fake.codec });
    assert.equal(prepared.outcome, "not_eligible", file.name);
    assert.equal(prepared.file, file, file.name);
  }
  assert.equal(fake.encodes.length, 0);

  // Exactly 3 MiB is in.
  const boundary = await prepareAttachmentFileForUpload(
    fileOf(IMAGE_RESIZE_MIN_BYTES, "image/jpeg", "edge.jpg"),
    { codec: fakeCodec({ outputBytes: 1_000 }).codec },
  );
  assert.equal(boundary.outcome, "resized");

  // Exactly 64 MiB is still in.
  const cap = await prepareAttachmentFileForUpload(
    fileOf(IMAGE_RESIZE_MAX_INPUT_BYTES, "image/jpeg", "cap.jpg"),
    { codec: fakeCodec({ outputBytes: 1_000 }).codec },
  );
  assert.equal(cap.outcome, "resized");
});

test("the original is kept unless the result is under 70% of it", async () => {
  const original = fileOf(4 * MiB, "image/jpeg", "a.jpg");
  const atLimit = await prepareAttachmentFileForUpload(original, { codec: fakeCodec({ outputBytes: Math.ceil(original.size * 0.7) }).codec });
  assert.equal(atLimit.outcome, "not_smaller");
  assert.equal(atLimit.file, original);

  const larger = await prepareAttachmentFileForUpload(original, { codec: fakeCodec({ outputBytes: 5 * MiB }).codec });
  assert.equal(larger.outcome, "not_smaller");
  assert.equal(larger.file, original);

  const under = await prepareAttachmentFileForUpload(original, { codec: fakeCodec({ outputBytes: Math.floor(original.size * 0.7) - 1 }).codec });
  assert.equal(under.outcome, "resized");
});

test("every failure falls back to the original file and never rejects", async () => {
  const original = fileOf(4 * MiB, "image/jpeg", "a.jpg");
  const outcomes: Array<[string, string]> = [];
  const run = async (label: string, codec: ImageResizeCodec | null, timeoutMs?: number) => {
    const prepared = await prepareAttachmentFileForUpload(original, { codec, timeoutMs });
    assert.equal(prepared.file, original, label);
    outcomes.push([label, prepared.outcome]);
  };
  await run("no api", null);
  await run("decode", fakeCodec({ decodeError: true }).codec);
  await run("encode null", fakeCodec({ produces: () => null }).codec);
  await run("encode throws", fakeCodec({ encodeThrows: true }).codec);
  await run("wrong type", fakeCodec({ produces: () => "image/png" }).codec);
  await run("zero size", fakeCodec({ width: 0, height: 0 }).codec);
  const hanging = fakeCodec({ hang: true });
  await run("hang", hanging.codec, 5);
  hanging.release();
  assert.deepEqual(outcomes, [
    ["no api", "unsupported"],
    ["decode", "decode_failed"],
    ["encode null", "encode_failed"],
    ["encode throws", "encode_failed"],
    ["wrong type", "encode_failed"],
    ["zero size", "decode_failed"],
    ["hang", "timeout"],
  ]);
});

test("without createImageBitmap the browser codec reports itself unavailable", async () => {
  const saved = globalThis.createImageBitmap;
  try {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
    assert.equal(browserImageResizeCodec(), null);
    const original = fileOf(4 * MiB, "image/jpeg", "a.jpg");
    const prepared = await prepareAttachmentFileForUpload(original);
    assert.equal(prepared.outcome, "unsupported");
    assert.equal(prepared.file, original);
  } finally {
    if (saved) globalThis.createImageBitmap = saved;
  }
});

/** A codec whose decodes wait for the test, and which records how many run at once. */
function gatedCodec() {
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const codec: ImageResizeCodec = {
    async decode(file) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push((file as File).name);
      await new Promise<void>((resolve) => { gates.push(resolve); });
      return { width: 4032, height: 3024, close: () => { active -= 1; } };
    },
    async encode(_image, _width, _height, type) {
      return new Blob([new Uint8Array(MiB)], { type });
    },
  };
  const openNext = async () => {
    await vi.waitFor(() => assert.ok(gates.length > 0, "a decode is waiting"));
    gates.shift()!();
  };
  return { codec, started, openNext, maxActive: () => maxActive, active: () => active };
}

test("concurrent resizes run one at a time", async () => {
  const gated = gatedCodec();
  const first = prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "one.jpg"), { codec: gated.codec });
  const second = prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "two.jpg"), { codec: gated.codec });
  const third = prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "three.jpg"), { codec: gated.codec });

  await gated.openNext();
  assert.equal((await first).outcome, "resized");
  assert.deepEqual(gated.started.slice(0, 1), ["one.jpg"]);
  await gated.openNext();
  assert.equal((await second).outcome, "resized");
  await gated.openNext();
  assert.equal((await third).outcome, "resized");

  assert.deepEqual(gated.started, ["one.jpg", "two.jpg", "three.jpg"]);
  assert.equal(gated.maxActive(), 1, "never two decodes in flight");
  assert.equal(gated.active(), 0, "every bitmap was closed");
});

test("a timed-out resize keeps the slot until its decode settles, then drops its encode", async () => {
  const gated = gatedCodec();
  const slow = await prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "slow.jpg"), { codec: gated.codec, timeoutMs: 5 });
  assert.equal(slow.outcome, "timeout");
  assert.equal(slow.file.name, "slow.jpg");

  // The next file waits: the timed-out decode still holds the slot.
  const next = prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "next.jpg"), { codec: gated.codec });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(gated.started, ["slow.jpg"]);

  await gated.openNext(); // the abandoned decode finishes: its bitmap is closed, no encode
  await gated.openNext();
  assert.equal((await next).outcome, "resized");
  assert.equal(gated.maxActive(), 1);
  assert.equal(gated.active(), 0);
});

test("a file stuck behind a decode that never settles goes as the original; a cancel leaves the queue", async () => {
  const gated = gatedCodec();
  const stuck = prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "stuck.jpg"), { codec: gated.codec, timeoutMs: 5 });
  const waiting = await prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "waiting.jpg"), { codec: gated.codec, queueTimeoutMs: 10 });
  assert.equal(waiting.outcome, "timeout");
  assert.equal(waiting.file.name, "waiting.jpg");

  const controller = new AbortController();
  const cancelled = prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "cancelled.jpg"), { codec: gated.codec, signal: controller.signal });
  controller.abort();
  assert.equal((await cancelled).file.name, "cancelled.jpg");

  await gated.openNext();
  assert.equal((await stuck).outcome, "timeout");
  // Neither the timed-out waiter nor the cancelled file ever decoded.
  const after = prepareAttachmentFileForUpload(fileOf(4 * MiB, "image/jpeg", "after.jpg"), { codec: gated.codec });
  await gated.openNext();
  assert.equal((await after).outcome, "resized");
  assert.deepEqual(gated.started, ["stuck.jpg", "after.jpg"]);
});

test("the browser codec decodes with EXIF orientation applied and paints JPEG on white", async () => {
  // Regression guard (#545 review S3): the re-encoded file carries no EXIF, so
  // a decode that ignores the orientation would upload a portrait photo sideways.
  const bitmapCalls: Array<[Blob, unknown]> = [];
  const painted: string[] = [];
  vi.stubGlobal("createImageBitmap", async (source: Blob, options?: unknown) => {
    bitmapCalls.push([source, options]);
    return { width: 3024, height: 4032, close: () => {} };
  });
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(public width: number, public height: number) {}
    getContext() {
      const context = {
        fillStyle: "" as unknown,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        fillRect: () => { painted.push(`fill ${String(context.fillStyle)}`); },
        drawImage: () => { painted.push("draw"); },
      };
      return context;
    }
    async convertToBlob(options: { type: string }) {
      return new Blob([new Uint8Array(MiB)], { type: options.type });
    }
  });
  try {
    const photo = fileOf(4 * MiB, "image/jpeg", "portrait.jpg");
    const prepared = await prepareAttachmentFileForUpload(photo);
    assert.equal(prepared.outcome, "resized");
    assert.deepEqual(bitmapCalls, [[photo, { imageOrientation: "from-image" }]]);
    assert.deepEqual([prepared.width, prepared.height], [1920, 2560]);
    assert.deepEqual(painted, ["fill #fff", "draw"]);
  } finally {
    vi.unstubAllGlobals();
  }
});
