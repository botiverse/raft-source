import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
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

// A hashed CSS filename does not prove its referenced fonts or images exist.
// Imported styles once retained unresolved relative font and Ottie image URLs,
// producing a successful Vite build whose published resources all returned 404.
for (const file of files.filter((path) => path.endsWith(".css"))) {
  const css = await readFile(file, "utf8");
  const assetBytes = new Map<string, Buffer>();
  for (const source of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
    const url = source[1];
    if (/^(?:https?:|data:|blob:|\/\/|#)/.test(url)) continue;
    const pathname = decodeURIComponent(url.split(/[?#]/)[0]);
    const target = pathname.startsWith("/")
      ? resolve(webRoot, "dist", `.${pathname}`)
      : resolve(dirname(file), pathname);
    assert.ok(target.startsWith(`${resolve(webRoot, "dist")}${sep}`), `CSS asset escapes dist: ${url}`);
    const bytes = await readFile(target).catch((error) => {
      throw new Error(`unresolved built CSS asset ${url} in ${relative(assetsRoot, file)}`, { cause: error });
    });
    assetBytes.set(url, bytes);
  }
  for (const face of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    for (const source of face[1].matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
      const url = source[1];
      const bytes = assetBytes.get(url);
      if (!bytes) continue;
      const signature = bytes.subarray(0, 4);
      assert.ok(
        signature.equals(Buffer.from([0, 1, 0, 0])) ||
          ["wOFF", "wOF2", "OTTO", "ttcf"].includes(signature.toString()),
        `built font is not a font file: ${url}`,
      );
    }
  }
}

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
