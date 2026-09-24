#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv.length !== 11) {
  fail("Usage: sharp-image-overlay.mjs <baseline.png> <current.png> <overlay.png> <region-overlay.png|none> <region-side-by-side.png|none> <metrics.json> <alpha> <region-name> <region-spec|none>");
}

const [, , baselinePath, currentPath, overlayPath, regionOverlayPath, regionSideBySidePath, metricsPath, alphaArg, regionName, regionSpec] = process.argv;
const alpha = Number(alphaArg);
if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) fail(`Invalid alpha: ${alphaArg}`);

function parseRegion(value) {
  if (!value || value === "none") return null;
  const parts = String(value).split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    fail(`Invalid region '${value}', expected x,y,width,height`);
  }
  const [left, top, width, height] = parts.map((part) => Math.round(part));
  if (left < 0 || top < 0 || width <= 0 || height <= 0) fail(`Invalid region bounds: ${value}`);
  return { left, top, width, height };
}

async function loadImage(file) {
  const image = sharp(file, { limitInputPixels: false }).flatten({ background: "#ffffff" }).ensureAlpha();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) fail(`Unable to read image size: ${file}`);
  return {
    width: metadata.width,
    height: metadata.height,
    png: await image.png().toBuffer(),
  };
}

async function halfAlphaPng(file, opacity) {
  const overlay = await sharp(file, { limitInputPixels: false }).flatten({ background: "#ffffff" }).ensureAlpha().png().toBuffer();
  return sharp(overlay)
    .composite([
      {
        input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
}

async function rgbaBuffer(file, width, height, mode) {
  let pipeline = sharp(file, { limitInputPixels: false }).flatten({ background: "#ffffff" }).ensureAlpha();
  if (mode === "resize") {
    pipeline = pipeline.resize(width, height, { fit: "fill" });
  } else {
    const metadata = await pipeline.metadata();
    pipeline = pipeline.extend({
      top: 0,
      left: 0,
      bottom: Math.max(0, height - Number(metadata.height || 0)),
      right: Math.max(0, width - Number(metadata.width || 0)),
      background: "#ffffff",
    });
  }
  return pipeline.raw().toBuffer();
}

async function imageMetrics(leftPath, rightPath, width, height) {
  const rgbLeft = await rgbaBuffer(leftPath, width, height, "resize");
  const rgbRight = await rgbaBuffer(rightPath, width, height, "resize");
  const pixelLeft = await rgbaBuffer(leftPath, width, height, "pad");
  const pixelRight = await rgbaBuffer(rightPath, width, height, "pad");
  let diff = 0;
  let matching = 0;
  for (let i = 0; i < rgbLeft.length; i += 4) {
    diff += (Math.abs(rgbLeft[i] - rgbRight[i]) + Math.abs(rgbLeft[i + 1] - rgbRight[i + 1]) + Math.abs(rgbLeft[i + 2] - rgbRight[i + 2])) / 3;
    if (pixelLeft[i] === pixelRight[i] && pixelLeft[i + 1] === pixelRight[i + 1] && pixelLeft[i + 2] === pixelRight[i + 2] && pixelLeft[i + 3] === pixelRight[i + 3]) {
      matching += 1;
    }
  }
  const pixelPerfectSimilarity = matching / (width * height);
  return {
    comparisonWidth: width,
    comparisonHeight: height,
    rgbSimilarity: Math.max(0, 1 - diff / (width * height * 255)),
    pixelPerfectSimilarity,
    pixelMismatchRatio: 1 - pixelPerfectSimilarity,
  };
}

async function writeOverlay(basePng, currentPath, outputPath, opacity) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const currentHalf = await halfAlphaPng(currentPath, opacity);
  await sharp(basePng).composite([{ input: currentHalf, blend: "over" }]).png().toFile(outputPath);
}

const region = parseRegion(regionSpec);
const baseline = await loadImage(baselinePath);
const current = await loadImage(currentPath);
if (baseline.width !== current.width || baseline.height !== current.height) {
  fail(`Overlay requires same raw size, got ${baseline.width}x${baseline.height} and ${current.width}x${current.height}`);
}

await writeOverlay(baseline.png, currentPath, overlayPath, alpha);
const metrics = {
  baselineWidth: baseline.width,
  baselineHeight: baseline.height,
  currentWidth: current.width,
  currentHeight: current.height,
  alpha,
  overlayImage: overlayPath,
};

if (region) {
  const baselineCrop = await sharp(baselinePath).extract(region).png().toBuffer();
  const currentCrop = await sharp(currentPath).extract(region).png().toBuffer();
  const tempDir = await fs.promises.mkdtemp(path.join(path.dirname(metricsPath), ".overlay-region-"));
  const baselineCropPath = path.join(tempDir, "baseline.png");
  const currentCropPath = path.join(tempDir, "current.png");
  await fs.promises.writeFile(baselineCropPath, baselineCrop);
  await fs.promises.writeFile(currentCropPath, currentCrop);
  if (regionOverlayPath !== "none") {
    await writeOverlay(baselineCrop, currentCropPath, regionOverlayPath, alpha);
  }
  if (regionSideBySidePath !== "none") {
    const spacer = await sharp({
      create: { width: 24, height: region.height, channels: 4, background: "#ffffff" },
    }).png().toBuffer();
    await sharp({
      create: { width: region.width * 2 + 24, height: region.height, channels: 4, background: "#ffffff" },
    })
      .composite([
        { input: baselineCrop, left: 0, top: 0 },
        { input: spacer, left: region.width, top: 0 },
        { input: currentCrop, left: region.width + 24, top: 0 },
      ])
      .png()
      .toFile(regionSideBySidePath);
  }
  metrics.region = {
    name: regionName || "region",
    ...region,
    overlayImage: regionOverlayPath === "none" ? null : regionOverlayPath,
    sideBySideImage: regionSideBySidePath === "none" ? null : regionSideBySidePath,
    ...(await imageMetrics(baselineCropPath, currentCropPath, region.width, region.height)),
  };
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}

await fs.promises.mkdir(path.dirname(metricsPath), { recursive: true });
await fs.promises.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
