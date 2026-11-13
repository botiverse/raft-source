import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { transformWithOxc } from "vite";
import type { Plugin } from "vite";
import {
  BOOT_CHUNK_LOADERS,
  BOOT_CHUNK_PAGES,
  CATALOG_GATE,
  CATALOG_PARTS,
  idsNamedBy,
  partKey,
  splitCatalog,
} from "../src/i18n/messages/catalogParts";
import type { CatalogGate } from "../src/i18n/messages/catalogParts";

/**
 * The web build's catalog parts (src/i18n/messages/catalogParts.ts,
 * docs/frontend/i18n/README.md "First-screen part"). Each locale's catalog
 * (i18n/messages/<code>.ts) is split in three files named by their content's
 * hash: the ids the first download's code names (the entry and the chunks it
 * imports statically: what `check-entry-chunk-structure.ts` calls the initial
 * load), the ids the pages main.tsx starts at boot name (BOOT_CHUNK_LOADERS,
 * BOOT_CHUNK_PAGES, and the chunks they import statically), and the rest. The
 * app finds them through the page's catalog map (`.vite/catalog-parts.json`,
 * written into index.html by bootShellPlugin), never through an import the
 * bundler resolves, so a new split changes no chunk's code. The whole
 * catalogs are not built at all (`__RAFT_CATALOG_PARTS__`, messages/index.ts).
 *
 * Every `import()` of a chunk outside the first download that has app code
 * (not only packages from node_modules) is wrapped in
 * `globalThis.__raftCatalogGate(...)` (messages/index.ts, withCatalogPart):
 * it resolves once the shown locale's boot part (a boot-started page) or every
 * part (anything else) is in. Done in renderChunk, so the file hashes cover
 * it, and only for real chunk loads: an `import()` of a module already in its
 * importer's chunk is no request and no wait.
 */

const CATALOG_FILE = /^([a-z]{2}(?:-[a-z]{2})?)\.ts$/;
const CATALOG_PARTS_FILE = ".vite/catalog-parts.json";
// A chunk's name in renderChunk is a hash placeholder (`./x-!~{04$}~.js`): a `$` but not a template's `${`.
const RELATIVE_IMPORT = /\bimport\((["'`])(\.\.?\/(?:[^"'`$]|\$(?!\{))+?\.js)\1\)/g;

type ChunkLike = { fileName: string; isEntry: boolean; imports: readonly string[]; facadeModuleId: string | null; moduleIds: readonly string[] };

/** The static import closure of `roots` (file names). */
function staticClosure(roots: Iterable<string>, byName: ReadonlyMap<string, ChunkLike>): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    pending.push(...(byName.get(name)?.imports ?? []));
  }
  return seen;
}

/** The entry's static import closure: the chunks the first screen downloads. */
export function firstDownload(chunks: Iterable<ChunkLike>): Set<string> {
  const byName = new Map<string, ChunkLike>();
  for (const chunk of chunks) byName.set(chunk.fileName, chunk);
  return staticClosure([...byName.values()].filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName), byName);
}

/** The chunks a boot-started page downloads beside the first download: its own and those it imports statically. */
export function bootDownload(chunks: Iterable<ChunkLike>, bootFacades: ReadonlySet<string>, first: ReadonlySet<string>): Set<string> {
  const byName = new Map<string, ChunkLike>();
  for (const chunk of chunks) byName.set(chunk.fileName, chunk);
  const roots = [...byName.values()].filter((chunk) => chunk.facadeModuleId !== null && bootFacades.has(chunk.facadeModuleId)).map((chunk) => chunk.fileName);
  return new Set([...staticClosure(roots, byName)].filter((name) => !first.has(name)));
}

function hasAppCode(chunk: ChunkLike): boolean {
  return chunk.moduleIds.some((id) => !id.includes("/node_modules/") && !id.startsWith("\0"));
}

/** What loading `target` waits for: nothing (the first download, a package), the boot part, or every part. */
export function gateFor(target: ChunkLike, first: ReadonlySet<string>, bootFacades: ReadonlySet<string>): CatalogGate | null {
  if (first.has(target.fileName) || !hasAppCode(target)) return null;
  return target.facadeModuleId !== null && bootFacades.has(target.facadeModuleId) ? "boot" : "rest";
}

/** `code` (the chunk `fileName`) with each such `import()` wrapped; the targets it could not resolve. */
export function wrapLazyImports(
  code: string,
  fileName: string,
  chunks: Record<string, ChunkLike>,
  first: ReadonlySet<string>,
  bootFacades: ReadonlySet<string> = new Set(),
): { code: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const next = code.replace(RELATIVE_IMPORT, (call: string, _quote: string, specifier: string) => {
    const target = chunks[posix.join(posix.dirname(fileName), specifier)];
    if (!target) {
      unresolved.push(specifier);
      return call;
    }
    const gate = gateFor(target, first, bootFacades);
    if (!gate) return call;
    return `(globalThis.${CATALOG_GATE}||(m=>m))(${call}${gate === "boot" ? `,"boot"` : ""})`;
  });
  return { code: next, unresolved };
}

/** The part file's source: the catalog as an object literal, the module's default export. */
export function catalogPartSource(part: Record<string, string>): string {
  return `export default ${JSON.stringify(part)};\n`;
}

/** Each display locale's catalog, from its source (i18n/messages/<code>.ts: one exported object, type imports only). */
async function readCatalogs(root: string): Promise<Map<string, Record<string, string>>> {
  const directory = resolve(root, "src/i18n/messages");
  const catalogs = new Map<string, Record<string, string>>();
  for (const name of (await readdir(directory)).sort()) {
    const locale = CATALOG_FILE.exec(name)?.[1];
    if (!locale) continue;
    const file = join(directory, name);
    const { code } = await transformWithOxc(await readFile(file, "utf8"), file, { lang: "ts" });
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Record<string, unknown>;
    const exported = Object.values(module).filter((value) => value && typeof value === "object");
    if (exported.length !== 1) throw new Error(`catalog parts: ${name} should export one catalog, found ${exported.length}`);
    catalogs.set(locale, exported[0] as Record<string, string>);
  }
  return catalogs;
}

export function catalogPartsPlugin(): Plugin {
  let base = "/";
  let root = process.cwd();
  let bootFacades = new Set<string>();
  let first: Set<string> | null = null;
  let firstOf: object | null = null;
  return {
    name: "raft-catalog-parts",
    apply: "build",
    // The whole catalogs' loaders are left out of this build (messages/index.ts).
    config: () => ({ define: { __RAFT_CATALOG_PARTS__: "true" } }),
    configResolved(config) {
      base = config.base;
      root = config.root;
    },
    buildEnd(error) {
      if (error) return;
      bootFacades = new Set();
      for (const loader of BOOT_CHUNK_LOADERS) {
        const info = this.getModuleInfo(resolve(root, loader));
        if (!info?.dynamicallyImportedIds.length) this.error(`catalog parts: ${loader} (BOOT_CHUNK_LOADERS) is not in the build or loads nothing`);
        for (const id of info!.dynamicallyImportedIds) bootFacades.add(id);
      }
      for (const page of BOOT_CHUNK_PAGES) {
        const id = resolve(root, page);
        if (!this.getModuleInfo(id)) this.error(`catalog parts: ${page} (BOOT_CHUNK_PAGES) is not in the build`);
        bootFacades.add(id);
      }
    },
    renderChunk(code, chunk, _options, meta) {
      const chunks = meta.chunks as Record<string, ChunkLike>;
      if (firstOf !== chunks) {
        first = firstDownload(Object.values(chunks));
        firstOf = chunks;
      }
      const wrapped = wrapLazyImports(code, chunk.fileName, chunks, first!, bootFacades);
      if (wrapped.unresolved.length > 0) {
        this.error(`catalog parts: ${chunk.fileName} imports ${wrapped.unresolved.join(", ")}, which is no chunk of this build`);
      }
      return wrapped.code === code ? null : { code: wrapped.code, map: null };
    },
    async generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) => (output.type === "chunk" ? [output] : []));
      const initial = firstDownload(chunks);
      const boot = bootDownload(chunks, bootFacades, initial);
      if (boot.size === 0) this.error("catalog parts: no boot-started page chunk in this build");
      const catalogs = await readCatalogs(root);
      const en = catalogs.get("en");
      if (!en) this.error("catalog parts: no en catalog");
      const ids = Object.keys(en!);
      const codeOf = (names: ReadonlySet<string>) => chunks.filter((chunk) => names.has(chunk.fileName)).map((chunk) => chunk.code);
      const firstIds = idsNamedBy(codeOf(initial), ids);
      const bootIds = new Set([...idsNamedBy(codeOf(boot), ids)].filter((id) => !firstIds.has(id)));
      const map: Record<string, string> = {};
      for (const [locale, catalog] of catalogs) {
        const parts = splitCatalog(catalog, firstIds, bootIds);
        for (const part of CATALOG_PARTS) {
          const source = catalogPartSource(parts[part]);
          const hash = createHash("sha256").update(source).digest("base64url").slice(0, 8);
          const fileName = `assets/${locale}-${part}-${hash}.js`;
          this.emitFile({ type: "asset", fileName, source });
          map[partKey(locale, part)] = `${base}${fileName}`;
        }
      }
      this.emitFile({ type: "asset", fileName: CATALOG_PARTS_FILE, source: `${JSON.stringify(map, null, 2)}\n` });
    },
  };
}

export { CATALOG_PARTS_FILE };
