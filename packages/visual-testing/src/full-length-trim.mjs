#!/usr/bin/env node
// Full-length captures (sharedCases.json capture.fullLength): normalise the
// blank tail below the last content row to the same margin on every provider.
//
// The expansion itself is exact (it grows by the scroller's real scroll
// range), but that range includes each platform's own trailing padding: the
// Android member pages end with a 180dp spacer item, Settings with a larger
// bottom content padding than web. Those tails are uniform background and say
// nothing about parity, yet as long screenshots they would dominate the height
// difference. Rows at the bottom that are a single uniform colour (the page
// background) are cut down to MARGIN_DP; content, fixed bottom chrome and any
// tail shorter than the margin are left untouched. Idempotent.
//
// Usage: full-length-trim.mjs <image.png> [<viewport-width-dp>]
// Prints a JSON line: { height, trimmedPx, tailPx }.
import fs from "node:fs";
import sharp from "sharp";

const MARGIN_DP = 16;
const CHANNEL_TOLERANCE = 3;

const [, , file, viewportWidthArg = "390"] = process.argv;
if (!file) {
  console.error("Usage: full-length-trim.mjs <image.png> [<viewport-width-dp>]");
  process.exit(1);
}

const image = sharp(file, { limitInputPixels: false }).flatten({ background: "#ffffff" }).removeAlpha();
const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
const scale = width / Number(viewportWidthArg || 390);
const marginPx = Math.round(MARGIN_DP * scale);

const lastRow = (height - 1) * width * channels;
const ref = [data[lastRow], data[lastRow + 1], data[lastRow + 2]];
function rowIsBlank(y) {
  const start = y * width * channels;
  for (let x = 0; x < width; x += 1) {
    const i = start + x * channels;
    if (
      Math.abs(data[i] - ref[0]) > CHANNEL_TOLERANCE ||
      Math.abs(data[i + 1] - ref[1]) > CHANNEL_TOLERANCE ||
      Math.abs(data[i + 2] - ref[2]) > CHANNEL_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

let tail = 0;
while (tail < height && rowIsBlank(height - 1 - tail)) tail += 1;

let trimmed = 0;
if (tail > marginPx && tail < height) {
  const keep = height - tail + marginPx;
  trimmed = height - keep;
  const out = await sharp(file, { limitInputPixels: false })
    .extract({ left: 0, top: 0, width, height: keep })
    .png()
    .toBuffer();
  const tmp = `${file}.trim-tmp`;
  await fs.promises.writeFile(tmp, out);
  await fs.promises.rename(tmp, file);
}

console.log(JSON.stringify({ height: height - trimmed, trimmedPx: trimmed, tailPx: tail }));
