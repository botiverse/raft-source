// Post-build (last step of `pnpm run build`, run with @oxc-node/core): a brotli-11 copy, `<file>.br`,
// beside every built JS and CSS file under dist/assets and dist/feedback/assets.
//
// Cloudflare compresses responses on the fly at a low brotli level: measured on
// production's app-shell chunk, 912 KB on the wire against 723 KB at level 11
// (-21%). public/_worker.js serves the `.br` copy, with Content-Encoding: br, to
// a browser that accepts br; anything else gets the file as before. The copies
// are not part of the H5 bundle (build-h5-bundle.ts leaves out `.br`).

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";

const compress = promisify(brotliCompress);

/** What the worker serves precompressed (public/_worker.js PRECOMPRESSED_ASSET). */
export const PRECOMPRESSED_ASSET = /\.(?:js|css)$/;

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Write `<file>.br` for each JS and CSS file under `root`; returns the original and compressed byte totals. */
export async function precompressDirectory(root: string): Promise<{ files: number; original: number; compressed: number }> {
  const files = (await listFiles(root)).filter((path) => PRECOMPRESSED_ASSET.test(path));
  let original = 0;
  let compressed = 0;
  // zlib runs these on libuv's thread pool, a few at a time.
  await Promise.all(files.map(async (path) => {
    const bytes = await readFile(path);
    const br = await compress(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      },
    });
    await writeFile(`${path}.br`, br);
    original += bytes.length;
    compressed += br.length;
  }));
  return { files: files.length, original, compressed };
}

async function main() {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const roots = ["dist/assets", "dist/feedback/assets"].map((path) => resolve(webRoot, path)).filter((path) => existsSync(path));
  if (roots.length === 0) throw new Error("precompress-assets: no dist/assets; run vite build first");
  for (const root of roots) {
    const { files, original, compressed } = await precompressDirectory(root);
    console.log(`[precompress-assets] ${root.slice(webRoot.length + 1)}: ${files} files, ${(original / 1e6).toFixed(1)} MB -> ${(compressed / 1e6).toFixed(1)} MB brotli-11`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
