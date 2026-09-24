import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { imageGalleryBackgroundClass, transparentImageBackgroundClass } from "../src/utils/imagePreviewStyles.js";

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

function strykerBackupSrc(): string | null {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
}

function readSource(path: string): string {
  const sourcePath = path.replace(/^src\//, "");
  const backupSrc = strykerBackupSrc();
  const backupPath = backupSrc ? resolve(backupSrc, sourcePath) : null;
  return readFileSync(backupPath && existsSync(backupPath) ? backupPath : resolve(srcRoot, sourcePath), "utf8");
}

test("transparent image previews use a shared checkerboard background class", () => {
  const css = readFileSync(resolve(repoRoot, "src/index.css"), "utf8");

  assert.equal(transparentImageBackgroundClass, "image-transparency-bg");
  assert.match(css, /\.image-transparency-bg\s*\{/);
  assert.match(css, /background-image:/);
});

test("image preview surfaces opt into the transparency background", () => {
  const previewSurfaces = [
    "src/components/message/MessageInput.tsx",
    "src/components/ImageLightbox.tsx",
    "src/components/agent/AgentWorkspace.tsx",
  ];

  for (const surface of previewSurfaces) {
    const source = readSource(surface);
    assert.match(source, /transparentImageBackgroundClass/, `${surface} should use the transparency preview class`);
  }
});

test("message gallery uses a quiet background instead of checkerboard", () => {
  const source = readSource("src/components/message/MessageItem.tsx");
  const css = readSource("src/index.css");

  assert.equal(imageGalleryBackgroundClass, "image-gallery-bg");
  assert.match(source, /imageGalleryBackgroundClass/);
  assert.doesNotMatch(source, /transparentImageBackgroundClass/);
  assert.match(source, /bg-brutal-cream\/60/);
  assert.doesNotMatch(source, /border-2 border-black bg-transparent/);
  assert.match(source, /const imageBackgroundClass = fitClass === "object-contain" \? imageGalleryBackgroundClass : "";/);
  assert.match(css, /\.image-gallery-bg\s*\{[\s\S]*?background:\s*#fff;/);
});

test("image lightbox backdrop and empty image stage close without making image clicks close", () => {
  const source = readSource("src/components/ImageLightbox.tsx");

  // Lightbox primitive owns the backdrop dismiss (dismissOnBackdrop=true by default).
  // ImageLightbox passes onClose={close} to Lightbox.
  assert.match(source, /data-testid="image-lightbox"/);
  assert.match(source, /<Lightbox[\s\S]{0,200}onClose=\{close\}/);
  // Image stage also closes on true visual click-outside. The bounds guard keeps
  // transformed image pixels non-dismissible after zoom/pan.
  assert.match(source, /data-testid="image-lightbox-stage"/);
  assert.match(source, /data-testid="image-lightbox-stage"[\s\S]*?e\.target === e\.currentTarget && !zoom\.containsImagePoint\(e\.clientX,\s*e\.clientY\)/);
  assert.match(source, /data-testid="image-lightbox-image"/);
});

test("SVG attachments use raster previews instead of inline SVG URLs", () => {
  const imageFallback = readSource("src/components/message/urlImageFallback.ts");
  const messageInput = readSource("src/components/message/MessageInput.tsx");
  const lightbox = readSource("src/components/ImageLightbox.tsx");

  assert.match(imageFallback, /mimeType === "image\/svg\+xml"[\s\S]*?thumbnailUrl \|\| att\.rasterPreviewUrl/);
  assert.match(messageInput, /mimeType !== "image\/svg\+xml"/);
  assert.match(lightbox, /const isRasterOnlyPreview = currentMimeType === "image\/svg\+xml"/);
  assert.match(lightbox, /if \(isRasterOnlyPreview\)[\s\S]*?current\.rasterPreviewUrl \|\| current\.thumbnailUrl \|\| current\.localPreviewUrl/);
  assert.match(lightbox, /setFullUrl\(safeRasterUrl \?\? null\)/);
});

test("image lightbox falls back to local draft previews when the signed URL image fails", () => {
  const lightbox = readSource("src/components/ImageLightbox.tsx");

  assert.match(lightbox, /const fallbackSrc = current\.thumbnailUrl \|\| current\.localPreviewUrl;/);
  assert.match(lightbox, /const displaySrc = fullUrl \|\| fallbackSrc;/);
  assert.match(lightbox, /if \(fullUrl && fallbackSrc\) \{[\s\S]*?setFullUrl\(null\);[\s\S]*?setError\(false\);[\s\S]*?return;/);
  assert.match(lightbox, /onError=\{handleImageError\}/);
});
