// Images a comment box takes (#proj-workspace:#146, phase 2: artifactCommentImageFiles):
// - only PNG, JPEG, WebP and GIF by their declared type (the Server sniffs the bytes and decides);
//   at most ARTIFACT_COMMENT_MAX_IMAGES, the rest refused as "count"; a type refused as "type";
// - the bytes uploaded: a JPEG always drawn again (EXIF and GPS gone, turned as its orientation
//   says), at most COMMENT_IMAGE_MAX_EDGE on its long edge; a WebP only when over that edge; PNG and
//   GIF byte for byte; anything the browser can't decode or encode goes as it is;
// - the size limit (ARTIFACT_COMMENT_IMAGE_MAX_BYTES) on the bytes to upload (a PNG or GIF at once);
//   empty is no image.
import assert from "node:assert/strict";
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, ARTIFACT_COMMENT_MAX_IMAGES } from "@botiverse/raft-shared";

import {
  COMMENT_IMAGE_ACCEPT,
  COMMENT_IMAGE_MAX_EDGE,
  commentImageFits,
  commentImageSize,
  commentImageTypeOf,
  pickCommentImages,
  prepareCommentImage,
} from "../src/apps/artifacts/artifactCommentImageFiles";
import type { DecodedImage, ImageDecoder } from "../src/apps/artifacts/artifactCommentImageFiles";

const file = (name: string, type: string, bytes = 8) => new File([new Uint8Array(bytes)], name, { type });

/** A decoder that says the image is `width` × `height` and encodes it as `encodedType` (what it was drawn at is recorded). */
function decoderOf(width: number, height: number, encodedType: string | null = null) {
  const drawn: Array<{ width: number; height: number; type: string; quality: number }> = [];
  let closed = 0;
  const decode: ImageDecoder = async () => {
    const image: DecodedImage = {
      width,
      height,
      encode: async (w, h, type, quality) => {
        drawn.push({ width: w, height: h, type, quality });
        return new Blob([new Uint8Array(4)], { type: encodedType ?? type });
      },
      close: () => { closed += 1; },
    };
    return image;
  };
  return { decode, drawn, closed: () => closed };
}

test("the picker accepts the four types a comment may carry, never SVG", () => {
  assert.equal(COMMENT_IMAGE_ACCEPT, "image/png,image/jpeg,image/webp,image/gif");
  assert.equal(commentImageTypeOf(file("a.png", "image/png")), "image/png");
  assert.equal(commentImageTypeOf(file("a.JPG", "IMAGE/JPEG")), "image/jpeg", "the declared type, in any case");
  assert.equal(commentImageTypeOf(file("a.svg", "image/svg+xml")), null);
  assert.equal(commentImageTypeOf(file("a.pdf", "application/pdf")), null);
  assert.equal(commentImageTypeOf(file("noname", "")), null);
});

test("taken in order up to the room left; the others say why (type, count)", () => {
  const five = Array.from({ length: 5 }, (_, i) => file(`${i}.png`, "image/png"));
  const all = pickCommentImages(five, ARTIFACT_COMMENT_MAX_IMAGES);
  assert.deepEqual(all.taken.map((f) => f.name), ["0.png", "1.png", "2.png", "3.png"]);
  assert.deepEqual([...all.refused], ["count"]);

  const mixed = pickCommentImages([file("doc.pdf", "application/pdf"), file("a.gif", "image/gif")], 1);
  assert.deepEqual(mixed.taken.map((f) => f.name), ["a.gif"]);
  assert.deepEqual([...mixed.refused], ["type"]);

  const full = pickCommentImages([file("a.webp", "image/webp")], 0);
  assert.equal(full.taken.length, 0);
  assert.deepEqual([...full.refused], ["count"], "no room: refused as count");
  assert.equal(pickCommentImages([file("a.png", "image/png")], 9).taken.length, 1, "room never past the contract's cap");
});

test("a PNG or GIF over the cap is refused at once (it goes byte for byte); a JPEG or WebP waits for its bytes", () => {
  const big = (name: string, type: string) => new File([new Uint8Array(ARTIFACT_COMMENT_IMAGE_MAX_BYTES + 1)], name, { type });
  const picked = pickCommentImages([big("a.png", "image/png"), big("b.gif", "image/gif"), big("c.jpg", "image/jpeg"), big("d.webp", "image/webp")], 4);
  assert.deepEqual(picked.taken.map((f) => f.name), ["c.jpg", "d.webp"]);
  assert.deepEqual([...picked.refused], ["size"]);
});

test("the size limit is on the bytes to upload; empty is no image", () => {
  assert.equal(commentImageFits(new Blob([new Uint8Array(ARTIFACT_COMMENT_IMAGE_MAX_BYTES)])), true);
  assert.equal(commentImageFits(new Blob([new Uint8Array(ARTIFACT_COMMENT_IMAGE_MAX_BYTES + 1)])), false);
  assert.equal(commentImageFits(new Blob([])), false);
});

test("the long edge is made COMMENT_IMAGE_MAX_EDGE at most, the proportions kept", () => {
  assert.deepEqual(commentImageSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(commentImageSize(5120, 2880), { width: COMMENT_IMAGE_MAX_EDGE, height: 1440 });
  assert.deepEqual(commentImageSize(3000, 6000), { width: 1280, height: COMMENT_IMAGE_MAX_EDGE });
});

test("a JPEG is always drawn again, as a JPEG; over the edge, made smaller", async () => {
  const small = decoderOf(1200, 900);
  const photo = file("photo.jpg", "image/jpeg", 64);
  const out = await prepareCommentImage(photo, small.decode);
  assert.notEqual(out, photo, "not the original bytes (their EXIF goes)");
  assert.equal(out.type, "image/jpeg");
  assert.deepEqual(small.drawn.map((d) => [d.width, d.height, d.type]), [[1200, 900, "image/jpeg"]]);
  assert.equal(small.closed(), 1, "the decoded image is let go");

  const large = decoderOf(4032, 3024);
  await prepareCommentImage(photo, large.decode);
  assert.deepEqual(large.drawn.map((d) => [d.width, d.height]), [[COMMENT_IMAGE_MAX_EDGE, 1920]]);
});

test("PNG and GIF go byte for byte, however large; a WebP is drawn again only over the edge", async () => {
  const huge = decoderOf(6000, 4000);
  const png = file("shot.png", "image/png");
  const gif = file("loop.gif", "image/gif");
  assert.equal(await prepareCommentImage(png, huge.decode), png);
  assert.equal(await prepareCommentImage(gif, huge.decode), gif);
  assert.equal(huge.drawn.length, 0, "never decoded or drawn");

  const webp = file("a.webp", "image/webp");
  assert.equal(await prepareCommentImage(webp, decoderOf(2000, 1000).decode), webp, "within the edge: as it is");
  const big = decoderOf(5000, 2500);
  const out = await prepareCommentImage(webp, big.decode);
  assert.equal(out.type, "image/webp");
  assert.deepEqual(big.drawn.map((d) => [d.width, d.height]), [[COMMENT_IMAGE_MAX_EDGE, 1280]]);
});

test("what the browser can't decode or encode goes as it is (the Server checks the bytes)", async () => {
  const photo = file("photo.jpg", "image/jpeg");
  assert.equal(await prepareCommentImage(photo, async () => null), photo, "no decoder");
  assert.equal(await prepareCommentImage(photo, async () => { throw new Error("bad image"); }), photo, "decoding failed");
  assert.equal(await prepareCommentImage(file("a.webp", "image/webp"), decoderOf(9000, 9000, "image/png").decode).then((b) => b.type), "image/webp", "an encoder that gives another type: the original");
});
