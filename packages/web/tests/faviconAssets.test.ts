import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
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

  it("keeps manifest and browser chrome colors on the current icon token", () => {
    const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "public/site.webmanifest"), "utf8"));

    assert.match(html, /<meta name="theme-color" content="#FFD440" \/>/);
    assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/);
    assert.equal(manifest.theme_color, "#FFD440");
    assert.equal(manifest.background_color, "#FFD440");
  });

  it("version-busts favicon links so browser favicon caches refresh", () => {
    const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");

    assert.match(html, /href="\/favicon\.ico\?v=20260511"/);
    assert.match(html, /href="\/android-chrome-512x512\.png\?v=20260511"/);
    assert.match(html, /href="\/android-chrome-192x192\.png\?v=20260511"/);
    assert.match(html, /href="\/favicon-32x32\.png\?v=20260511"/);
    assert.match(html, /href="\/favicon-16x16\.png\?v=20260511"/);
    assert.match(html, /href="\/apple-touch-icon\.png\?v=20260511"/);
    assert.match(html, /href="\/site\.webmanifest\?v=20260628"/);
  });

  it("advertises high-resolution browser icons for desktop taskbar pins", () => {
    const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");

    assert.match(html, /<link rel="icon" href="\/favicon\.ico\?v=20260511" sizes="any" \/>/);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="512x512" href="\/android-chrome-512x512\.png\?v=20260511" \/>/);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="\/android-chrome-192x192\.png\?v=20260511" \/>/);
  });
});
