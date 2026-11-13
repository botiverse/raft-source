import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const repoRoot = resolve(import.meta.dirname, "..");

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(resolve(repoRoot, path))).digest("hex");
}

describe("favicon assets", () => {
  it("keeps app icons aligned with the canonical large favicon export", () => {
    assert.deepEqual(
      {
        "favicon.ico": sha256("public/favicon.ico"),
        "favicon-16x16.png": sha256("public/favicon-16x16.png"),
        "favicon-32x32.png": sha256("public/favicon-32x32.png"),
        "apple-touch-icon.png": sha256("public/apple-touch-icon.png"),
        "android-chrome-192x192.png": sha256("public/android-chrome-192x192.png"),
        "android-chrome-512x512.png": sha256("public/android-chrome-512x512.png"),
      },
      {
        "favicon.ico": "244a0abdf715418d393dcc3f099cf4e8d9a16f13f841113b4cd9fa8f7d57735a",
        "favicon-16x16.png": "a863b097b01daaf26352541b0fe85d870b67e92fd71c5e71ee5994fd8dfa4f5b",
        "favicon-32x32.png": "076a7b46f6c8032a6f493317b31ba7bb7dfaaabdb134c4bd5dff34f7b5e555de",
        "apple-touch-icon.png": "7b645494cb372c3e67a823136d9a4eb907d9b6f9c47130ff9d0561796ec26a69",
        "android-chrome-192x192.png": "55cc7324aa82b8734184d0dac58bbf56e866a91139a611bf33fadd430c53fae5",
        "android-chrome-512x512.png": "f8bb250ab317c77b2df6159ed115c8f5213cbc60528526e625854592de8a2730",
      },
    );
  });
});

describe("dotted favicon variants (notifications/badge.ts)", () => {
  it("exist as PNGs at their stated sizes", () => {
    for (const [file, size] of [["favicon-dot-16x16.png", 16], ["favicon-dot-32x32.png", 32], ["favicon-dot-192x192.png", 192]] as const) {
      const data = readFileSync(resolve(repoRoot, "public", file));
      assert.equal(data.subarray(1, 4).toString("latin1"), "PNG", file);
      assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [size, size], file);
    }
  });
});
