import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = resolve(webRoot, "dist/assets");
const viteHashSuffix = /-[A-Za-z0-9_-]{8}\.[^/]+$/;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

const files = await listFiles(assetsRoot);
assert.ok(files.length > 0, "production build emitted no /assets files");

const stableNames = files
  .map((path) => relative(assetsRoot, path))
  .filter((path) => !viteHashSuffix.test(path));
assert.deepEqual(
  stableNames,
  [],
  `immutable /assets must remain content-addressed; stable filenames: ${stableNames.join(", ")}`,
);

const [sourceHeaders, builtHeaders] = await Promise.all([
  readFile(resolve(webRoot, "public/_headers"), "utf8"),
  readFile(resolve(webRoot, "dist/_headers"), "utf8"),
]);
let expectedHeaders = sourceHeaders;
try {
  const manifest = await readFile(resolve(webRoot, "dist/desktop-manifest.json"));
  const etag = `"sha256-${createHash("sha256").update(manifest).digest("hex")}"`;
  expectedHeaders = sourceHeaders.replaceAll(
    "__RAFT_DESKTOP_MANIFEST_ETAG__",
    etag,
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
assert.equal(
  builtHeaders,
  expectedHeaders,
  "production build must preserve cache headers with the exact manifest ETag",
);

console.log(`[immutable-assets] ${files.length} content-addressed files and dist/_headers verified`);
