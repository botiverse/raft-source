import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAst } from "vite";

// Post-build check on dist/ (runs from `pnpm run build`, after check-devtools-prod-bundle).
//
// 1. No emitted JS chunk contains a top-level await. A top-level await anywhere
//    in the module graph makes Rolldown turn off common-chunk merging for the
//    whole build. Measured on this app: one `await` at the top of main.tsx took
//    the build from 177 to 207 JS chunks, while the entry's static imports looked
//    unchanged. So the check looks for the cause in the output; it survives into
//    the chunk because ESM must keep it. An await behind `import.meta.env.DEV`
//    is removed from the production build and is fine.
// 2. The entry's static import closure (what the first paint loads) is the entry
//    plus the named groups from vite.config.ts and the Rolldown runtime, each at
//    most once. Any other chunk there means the entry was split again
//    (rolldown/rolldown#10731 turned first paint into ~100 requests).
// 3. Every module the app declares deferred (`lazyDeferred` / `deferredPanel` /
//    `deferredDialog` / `deferredModule` / `lazyPanel`, or a
//    named `const loadX = () => import(...)` loader,
//    src/boot/deferredUi.tsx) is outside that closure: one static import of it
//    anywhere on the startup path silently puts it back in the first download.
const INITIAL_CHUNK_NAMES = new Set([
  "rolldown-runtime",
  "vendor-react",
  "vendor-markdown",
  "vendor-socketio",
  "vendor-raft-ui",
  "vendor-icons-base-ui",
  "vendor-zod-axios",
  "vendor-startup",
  "app-stable",
  "app-shell",
]);
const HASH_SUFFIX = /-[A-Za-z0-9_-]{8}\.js$/;

function chunkName(file) {
  return file.split("/").pop().replace(HASH_SUFFIX, "");
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

export function hasTopLevelAwait(code, file = "chunk.js") {
  const visit = (node) => {
    if (Array.isArray(node)) return node.some(visit);
    if (!node || typeof node !== "object") return false;
    if (FUNCTION_TYPES.has(node.type)) return false;
    if (node.type === "AwaitExpression") return true;
    if (node.type === "ForOfStatement" && node.await) return true;
    for (const key in node) {
      if (key !== "type" && visit(node[key])) return true;
    }
    return false;
  };
  try {
    // Emitted chunks are ESM; without this a chunk with no import/export parses as a script.
    return visit(parseAst(code, { sourceType: "module" }, file));
  } catch (error) {
    throw new Error(`could not parse ${file}: ${error.message}`);
  }
}

/**
 * @param {{ manifest: Record<string, { file: string, isEntry?: boolean, imports?: string[] }>, chunks: Map<string, string>, deferred?: string[] }} input
 */
export function validateEntryChunkStructure({ manifest, chunks, deferred = [] }) {
  const errors = [];
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
  if (entries.length !== 1) {
    errors.push(`expected exactly one entry chunk, found ${entries.length}: ${entries.map(([key]) => key).join(", ")}`);
  }

  const initial = [];
  if (entries.length > 0) {
    const seen = new Set();
    const pending = [entries[0][0]];
    while (pending.length > 0) {
      const key = pending.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const chunk = manifest[key];
      if (!chunk) {
        errors.push(`manifest import ${key} has no manifest record`);
        continue;
      }
      initial.push(chunk.file);
      pending.push(...(chunk.imports ?? []));
    }
    const names = initial.slice(1).map(chunkName);
    for (const name of names) {
      if (!INITIAL_CHUNK_NAMES.has(name)) errors.push(`unexpected chunk ${name} in the entry's static import closure`);
    }
    for (const name of new Set(names)) {
      const count = names.filter((other) => other === name).length;
      if (count > 1) errors.push(`initial chunk ${name} is split into ${count} files`);
    }
  }

  const initialFiles = new Set(initial);
  for (const source of deferred) {
    const chunk = manifest[source];
    if (!chunk) errors.push(`deferred module ${source} has no chunk of its own`);
    else if (initialFiles.has(chunk.file)) errors.push(`deferred module ${source} is in the first download (${chunkName(chunk.file)}): a static import of it reaches the entry`);
  }

  const jsFiles = [...new Set(Object.values(manifest).map((chunk) => chunk.file))].filter((file) => file.endsWith(".js"));
  if (jsFiles.length === 0) errors.push("manifest lists no JS chunks");
  for (const file of jsFiles) {
    const code = chunks.get(file);
    if (code === undefined) {
      errors.push(`manifest chunk ${file} is missing from the output`);
      continue;
    }
    if (hasTopLevelAwait(code, file)) errors.push(`${file} contains a top-level await`);
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { initial, jsChunkCount: jsFiles.length };
}

// The factory is written inline as an arrow (boot-bundle.md); type arguments may nest once.
// The import may sit in one inline wrapper arrow, `importHandledLocally(() => import(...))`.
const DEFERRED_IMPORT = /\b(?:lazyDeferred|deferredPanel|deferredDialog|deferredModule|lazyPanel)(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*\(\)\s*=>\s*(?:\w+\(\s*\(\)\s*=>\s*)?import\(\s*["']([^"']+)["']\s*\)/g;

// A named loader a lazyPanel takes or a boot start shares (pages/landingPages.ts,
// onboarding/serverSetupStepChunks.ts): `const loadX = () => import("./X")`, or
// one shared load of it, `const loadX = sharedModule(() => import("./X"))`.
const LOADER_IMPORT = /\bconst\s+load[A-Z]\w*\s*=\s*(?:sharedModule\(\s*)?\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)/g;

/** The modules src/ declares deferred, as manifest keys (paths from the web root). */
export async function findDeferredModules(webRoot) {
  const found = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const code = await readFile(path, "utf8");
        for (const match of [...code.matchAll(DEFERRED_IMPORT), ...code.matchAll(LOADER_IMPORT)]) {
          const target = resolve(dirname(path), match[1]);
          const file = [".tsx", ".ts"].map((extension) => target + extension).find((candidate) => existsSync(candidate));
          if (!file) throw new Error(`${relative(webRoot, path)}: deferred import ${match[1]} not found`);
          found.add(relative(webRoot, file).split("\\").join("/"));
        }
      }
    }
  }
  await walk(join(webRoot, "src"));
  return [...found].sort();
}

async function main() {
  // Optional dist directory argument, for checking a build written elsewhere.
  const dist = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL("../dist/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL(".vite/manifest.json", dist), "utf8"));
  const chunks = new Map();
  for (const { file } of Object.values(manifest)) {
    if (file.endsWith(".js") && !chunks.has(file)) chunks.set(file, await readFile(new URL(file, dist), "utf8"));
  }
  try {
    const deferred = await findDeferredModules(fileURLToPath(new URL("..", import.meta.url)));
    const { initial, jsChunkCount } = validateEntryChunkStructure({ manifest, chunks, deferred });
    console.log(
      `[entry-chunk-structure] no top-level await in ${jsChunkCount} JS chunks; initial load: ${initial.map(chunkName).join(", ")}; ${deferred.length} deferred modules outside it`,
    );
  } catch (error) {
    console.error(`[entry-chunk-structure] production chunk structure broken:\n${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  await main();
}
