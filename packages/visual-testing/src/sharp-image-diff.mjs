#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv.length !== 10) {
  fail("Usage: sharp-image-diff.mjs <baseline.png> <current.png> <side-by-side.png> <metrics.json> <case-id> <case-title> <baseline-label> <current-label>");
}

const [, , baselinePath, currentPath, outputPath, metricsPath, caseId, caseTitle, baselineLabel, currentLabel] = process.argv;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadImage(file) {
  const image = sharp(file, { limitInputPixels: false }).flatten({ background: "#ffffff" }).ensureAlpha();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) fail(`Unable to read image size: ${file}`);
  const png = await image.png().toBuffer();
  return {
    file,
    width: metadata.width,
    height: metadata.height,
    png,
  };
}

async function rgbaBuffer(image, width, height, mode) {
  let pipeline = sharp(image.file, { limitInputPixels: false }).flatten({ background: "#ffffff" }).ensureAlpha();
  if (mode === "resize") {
    pipeline = pipeline.resize(width, height, { fit: "fill" });
  } else {
    pipeline = pipeline.extend({
      top: 0,
      left: 0,
      bottom: Math.max(0, height - image.height),
      right: Math.max(0, width - image.width),
      background: "#ffffff",
    });
  }
  return pipeline.raw().toBuffer();
}

async function rgbSimilarity(baseline, current, width, height) {
  const left = await rgbaBuffer(baseline, width, height, "resize");
  const right = await rgbaBuffer(current, width, height, "resize");
  let diff = 0;
  for (let i = 0; i < left.length; i += 4) {
    diff += (Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2])) / 3;
  }
  return Math.max(0, 1 - diff / (width * height * 255));
}

async function pixelPerfectSimilarity(baseline, current, width, height) {
  const left = await rgbaBuffer(baseline, width, height, "pad");
  const right = await rgbaBuffer(current, width, height, "pad");
  let matching = 0;
  for (let i = 0; i < left.length; i += 4) {
    if (left[i] === right[i] && left[i + 1] === right[i + 1] && left[i + 2] === right[i + 2] && left[i + 3] === right[i + 3]) {
      matching += 1;
    }
  }
  return matching / (width * height);
}

function panelSize(image, framePadding, headerHeight, shadow) {
  return {
    width: image.width + framePadding * 2 + shadow,
    height: image.height + framePadding * 2 + headerHeight + shadow,
  };
}

function panelSvg({ x, y, width, height, shadow, framePadding, provider, rawSize, title, id }) {
  const frameWidth = width - shadow;
  const frameHeight = height - shadow;
  const headerX = x + framePadding;
  const headerY = y + framePadding;
  const headerWidth = frameWidth - framePadding * 2;
  const badgeWidth = Math.max(58, provider.length * 8 + 16);
  const badgeX = headerX + headerWidth - badgeWidth;
  const badgeY = headerY + 2;
  return `
    <rect x="${x + shadow}" y="${y + shadow}" width="${frameWidth}" height="${frameHeight}" fill="#141111"/>
    <rect x="${x}" y="${y}" width="${frameWidth}" height="${frameHeight}" fill="#ffffff" stroke="#141111" stroke-width="2"/>
    <text x="${headerX}" y="${headerY + 12}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" font-weight="700" fill="#6b625f">${escapeXml(id.toUpperCase())}</text>
    <text x="${headerX}" y="${headerY + 34}" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="18" font-weight="700" fill="#141111">${escapeXml(title)}</text>
    <text x="${headerX}" y="${headerY + 48}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="500" fill="#514946">${escapeXml(rawSize)}</text>
    <rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="22" fill="#ffd440" stroke="#141111" stroke-width="2"/>
    <text x="${badgeX + badgeWidth / 2}" y="${badgeY + 15}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" font-weight="700" fill="#141111">${escapeXml(provider.toUpperCase())}</text>
  `;
}

async function renderSideBySide(baseline, current, metrics) {
  const gutter = 24;
  const padding = 18;
  const metricsHeight = 76;
  const framePadding = 16;
  const headerHeight = 58;
  const shadow = 4;
  const baselinePanel = panelSize(baseline, framePadding, headerHeight, shadow);
  const currentPanel = panelSize(current, framePadding, headerHeight, shadow);
  const width = padding * 2 + baselinePanel.width + gutter + currentPanel.width;
  const panelHeight = Math.max(baselinePanel.height, currentPanel.height);
  const height = padding * 2 + panelHeight + metricsHeight;
  const baselineX = padding;
  const currentX = padding + baselinePanel.width + gutter;
  const panelY = padding;
  const baselineImageX = baselineX + framePadding;
  const baselineImageY = panelY + headerHeight + framePadding;
  const currentImageX = currentX + framePadding;
  const currentImageY = panelY + headerHeight + framePadding;
  const rgb = (metrics.rgbSimilarity * 100).toFixed(1);
  const pixel = (metrics.pixelPerfectSimilarity * 100).toFixed(2);
  const mismatch = (metrics.pixelMismatchRatio * 100).toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${panelSvg({ x: baselineX, y: panelY, width: baselinePanel.width, height: baselinePanel.height, shadow, framePadding, provider: baselineLabel, rawSize: `${baseline.width}×${baseline.height}`, title: caseTitle, id: caseId })}
    ${panelSvg({ x: currentX, y: panelY, width: currentPanel.width, height: currentPanel.height, shadow, framePadding, provider: currentLabel, rawSize: `${current.width}×${current.height}`, title: caseTitle, id: caseId })}
    <text x="${width / 2}" y="${height - 40}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="700" fill="#141111">RGB similarity ${rgb}%   Pixel perfect ${pixel}%   Mismatch ${mismatch}%</text>
    <text x="${width / 2}" y="${height - 20}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="500" fill="#514946">Compare canvas ${metrics.comparisonWidth}×${metrics.comparisonHeight}</text>
  </svg>`;
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(Buffer.from(svg))
    .composite([
      { input: baseline.png, left: baselineImageX, top: baselineImageY },
      { input: current.png, left: currentImageX, top: currentImageY },
    ])
    .png()
    .toFile(outputPath);
}

const baseline = await loadImage(baselinePath);
const current = await loadImage(currentPath);
const comparisonWidth = Math.max(baseline.width, current.width);
const comparisonHeight = Math.max(baseline.height, current.height);
const rgb = await rgbSimilarity(baseline, current, comparisonWidth, comparisonHeight);
const pixel = await pixelPerfectSimilarity(baseline, current, comparisonWidth, comparisonHeight);
const metrics = {
  baselineWidth: baseline.width,
  baselineHeight: baseline.height,
  currentWidth: current.width,
  currentHeight: current.height,
  comparisonWidth,
  comparisonHeight,
  rgbSimilarity: rgb,
  pixelPerfectSimilarity: pixel,
  pixelMismatchRatio: 1 - pixel,
  compositor: "sharp",
  displayMode: "preserve-provider-raw-size",
  metricMode: "rgb-resize-pixel-pad-no-crop",
};
await renderSideBySide(baseline, current, metrics);
await fs.promises.mkdir(path.dirname(metricsPath), { recursive: true });
await fs.promises.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
