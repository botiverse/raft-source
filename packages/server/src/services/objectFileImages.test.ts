// What core does to an image before keeping it (objectFileImages.ts): the
// pixel size from the header alone (every type; nothing decoded), the pixel
// cap applied before any decoding, and metadata removed whoever uploads it:
// a JPEG and a WebP encoded again without EXIF (a JPEG's orientation applied
// first; a lossless WebP stays lossless), a PNG without its text, EXIF and
// time chunks and with its pixel data byte for byte, a GIF as it is.
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  jpegHeaderOnly,
  pngChunk,
  pngChunksOf,
  testGif,
  testJpeg,
  testPng,
  testWebp,
} from "../test/objectFileTestImages";
import { imageHeaderSize, ImageRefusedError, keptImage, OBJECT_FILE_MAX_PIXELS, pngWithoutMetadata } from "./objectFileImages";

const refusedWith = (reason: ImageRefusedError["reason"]) => (error: unknown) => error instanceof ImageRefusedError && error.reason === reason;
const typesOf = (png: Buffer) => pngChunksOf(png).map((chunk) => chunk.type);

test("the header's pixel size, for every type, without decoding", async () => {
  assert.deepEqual(imageHeaderSize(testPng("a", { width: 7, height: 3 }), "image/png"), { width: 7, height: 3 });
  assert.deepEqual(imageHeaderSize(await testJpeg("a", { width: 9, height: 5 }), "image/jpeg"), { width: 9, height: 5 });
  assert.deepEqual(imageHeaderSize(await testWebp("a", { width: 6, height: 4 }), "image/webp"), { width: 6, height: 4 });
  assert.deepEqual(imageHeaderSize(await testWebp("a", { width: 6, height: 4, lossless: true }), "image/webp"), { width: 6, height: 4 });
  assert.deepEqual(imageHeaderSize(await testWebp("a", { width: 6, height: 4, exif: { ImageDescription: "x" } }), "image/webp"), { width: 6, height: 4 }, "VP8X's canvas");
  assert.deepEqual(imageHeaderSize(await testGif("a", { width: 5, height: 8 }), "image/gif"), { width: 5, height: 8 });
  // A header alone is enough: no pixel data needed.
  assert.deepEqual(imageHeaderSize(jpegHeaderOnly(8000, 6000), "image/jpeg"), { width: 8000, height: 6000 });
  assert.deepEqual(imageHeaderSize(testPng("", { width: 10_000, height: 5000, header: true }), "image/png"), { width: 10_000, height: 5000 });

  // A header that doesn't parse is no size.
  assert.equal(imageHeaderSize(testPng("a").subarray(0, 20), "image/png"), null, "IHDR cut short");
  assert.equal(imageHeaderSize(Buffer.concat([testPng("a").subarray(0, 8), pngChunk("tEXt", Buffer.from("k\0v"))]), "image/png"), null, "IHDR not first");
  assert.equal(imageHeaderSize(testPng("a", { width: 0 }), "image/png"), null, "a width of 0");
  assert.equal(imageHeaderSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"), null, "a JPEG with no frame header");
  assert.equal(imageHeaderSize(Buffer.from("GIF89a\x00\x00\x01\x00", "latin1"), "image/gif"), null);
  assert.equal(imageHeaderSize(Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBP")]), "image/webp"), null);
});

test("over the pixel cap by its header: refused before anything is decoded", async () => {
  assert.equal(OBJECT_FILE_MAX_PIXELS, 40_000_000);
  // 48 megapixels in a JPEG that has no data to decode: refused for its pixels, so the header was read
  // first (decoding it would have failed as unsupported_type, as the small one below does).
  await assert.rejects(keptImage(jpegHeaderOnly(8000, 6000), "image/jpeg"), refusedWith("too_many_pixels"));
  await assert.rejects(keptImage(jpegHeaderOnly(100, 100), "image/jpeg"), refusedWith("unsupported_type"));
  // A small PNG declaring 50 megapixels (a decode bomb for whoever draws it), and one just under the cap.
  await assert.rejects(keptImage(testPng("bomb", { width: 10_000, height: 5000, header: true }), "image/png"), refusedWith("too_many_pixels"));
  await assert.rejects(keptImage(testPng("big", { width: 8000, height: 5001, header: true }), "image/png"), refusedWith("too_many_pixels"));
  // A header that doesn't parse is refused as no image.
  await assert.rejects(keptImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"), refusedWith("unsupported_type"));
});

test("a PNG keeps only the chunks drawing it needs, its pixel data byte for byte", () => {
  const text = pngChunk("tEXt", Buffer.from("Comment\0taken at 51.5N 0.1W"));
  const itxt = pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"));
  const ztxt = pngChunk("zTXt", Buffer.from("Author\0\0x"));
  const exif = pngChunk("eXIf", Buffer.from("MM\0*\0\0\0\x08", "latin1"));
  const time = pngChunk("tIME", Buffer.from([0x07, 0xea, 1, 2, 3, 4, 5]));
  const phys = pngChunk("pHYs", Buffer.alloc(9));
  const gama = pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
  const srgb = pngChunk("sRGB", Buffer.from([0]));
  const original = testPng("shot", { before: [gama, srgb, text, itxt, exif, phys], after: [ztxt, time] });
  const kept = pngWithoutMetadata(Buffer.concat([original, Buffer.from("trailing bytes after IEND")]))!;

  assert.deepEqual(typesOf(original), ["IHDR", "gAMA", "sRGB", "tEXt", "iTXt", "eXIf", "pHYs", "IDAT", "zTXt", "tIME", "IEND"]);
  assert.deepEqual(typesOf(kept), ["IHDR", "gAMA", "sRGB", "IDAT", "IEND"]);
  const idat = (png: Buffer) => pngChunksOf(png).filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.bytes);
  assert.deepEqual(idat(kept), idat(original), "the pixel data as it was: never encoded again");
  assert.equal(kept.includes(Buffer.from("51.5N")), false);
  assert.equal(kept.includes(Buffer.from("trailing bytes")), false, "nothing after IEND");
  // A PNG with nothing to drop is kept as it is.
  assert.deepEqual(pngWithoutMetadata(testPng("plain")), testPng("plain"));
  // Chunks that don't parse, no IDAT, or IHDR not first: not a PNG core keeps.
  assert.equal(pngWithoutMetadata(original.subarray(0, original.length - 6)), null);
  assert.equal(pngWithoutMetadata(testPng("", { header: true })), null);
});

test("a JPEG is encoded again without its EXIF, its orientation applied first", async () => {
  const photo = await testJpeg("photo", { width: 4, height: 2, orientation: 6, exif: { ImageDescription: "taken at home", Make: "PhoneCo" } });
  const before = await sharp(photo).metadata();
  assert.equal(before.orientation, 6);
  assert.ok(before.exif && before.exif.includes(Buffer.from("taken at home")), "the fixture carries EXIF");

  const kept = await keptImage(photo, "image/jpeg");
  const after = await sharp(kept.bytes).metadata();
  assert.equal(after.format, "jpeg");
  assert.equal(after.exif, undefined, "no EXIF kept");
  assert.equal(after.xmp, undefined);
  assert.equal(after.orientation, undefined);
  assert.equal(kept.bytes.includes(Buffer.from("taken at home")), false);
  // Upright: a 4 × 2 photo turned by its orientation is kept 2 × 4, and that is the size answered.
  assert.deepEqual([kept.width, kept.height], [2, 4]);
  assert.deepEqual([after.width, after.height], [2, 4]);
});

test("a WebP is encoded again without its EXIF; a lossless one stays lossless", async () => {
  for (const lossless of [false, true]) {
    const webp = await testWebp("pic", { width: 6, height: 4, lossless, exif: { ImageDescription: "secret place" } });
    assert.ok((await sharp(webp).metadata()).exif, "the fixture carries EXIF");
    const kept = await keptImage(webp, "image/webp");
    const after = await sharp(kept.bytes).metadata();
    assert.equal(after.format, "webp");
    assert.equal(after.exif, undefined, `no EXIF kept (lossless ${lossless})`);
    assert.equal(kept.bytes.includes(Buffer.from("secret place")), false);
    assert.deepEqual([kept.width, kept.height], [6, 4]);
    assert.equal(kept.bytes.includes(Buffer.from("VP8L")), lossless, lossless ? "still lossless" : "lossy as it was");
  }
});

test("a GIF is kept as it is", async () => {
  const gif = await testGif("anim", { width: 5, height: 3 });
  const kept = await keptImage(gif, "image/gif");
  assert.deepEqual(kept.bytes, gif);
  assert.deepEqual([kept.width, kept.height], [5, 3]);
});
