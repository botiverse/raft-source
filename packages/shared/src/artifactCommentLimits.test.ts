// A comment image's type by its first bytes, as the Server's object files
// decide it (services/objectFiles.ts sniffObjectFileType): clients check
// files with it before sending them.
import assert from "node:assert/strict";

import { ARTIFACT_COMMENT_IMAGE_TYPE_BYTES, artifactCommentImageTypeOf } from "./artifactCommentLimits";

const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

test("PNG, JPEG, GIF and WebP by their first bytes; anything else (SVG, PDF, a cut header, nothing) is none", () => {
  assert.equal(artifactCommentImageTypeOf(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(artifactCommentImageTypeOf(bytes([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(artifactCommentImageTypeOf(bytes("GIF89a", [1])), "image/gif");
  assert.equal(artifactCommentImageTypeOf(bytes("GIF87a")), "image/gif");
  assert.equal(artifactCommentImageTypeOf(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")), "image/webp");
  for (const other of [bytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), bytes("%PDF-1.7"), bytes("RIFF", [0, 0, 0, 0], "WAVE"), bytes([0x89], "PN"), bytes([0xff, 0xd8]), new Uint8Array()]) {
    assert.equal(artifactCommentImageTypeOf(other), null);
  }
});

test("the first ARTIFACT_COMMENT_IMAGE_TYPE_BYTES bytes decide the type (a client reads only those to check a file)", () => {
  const samples = [bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR"), bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF", [0, 1, 1]), bytes("GIF89a", [1, 0, 1, 0, 0, 0, 0]), bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ", [0, 0]), bytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")];
  for (const sample of samples) {
    assert.equal(artifactCommentImageTypeOf(sample.subarray(0, ARTIFACT_COMMENT_IMAGE_TYPE_BYTES)), artifactCommentImageTypeOf(sample));
  }
});
