import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DISPLAY_LOCALES } from "@botiverse/raft-shared";
import {
  BOOT_CHUNK_LOADERS,
  BOOT_CHUNK_PAGES,
  CATALOG_GATE,
  CATALOG_PARTS,
  LOCALE_CATALOGS_ELEMENT_ID,
  idsNamedBy,
  partKey,
} from "../src/i18n/messages/catalogParts";

// Post-build check on dist/ (runs from `pnpm run build`, after
// check-entry-chunk-structure): the catalog parts (scripts/catalogPartsPlugin.ts,
// docs/frontend/i18n/README.md "First-screen part"). Independent of the
// plugin where it can be: the boot-started pages come from the loaders'
// source, the gate from the built code.
//
// 1. index.html's catalog map names every part of every display locale, and no
//    whole catalog is built any more.
// 2. Every locale's first part has every id the first download's code names,
//    the first and boot parts every id a boot-started page's chunks name, and
//    no id is in two parts.
// 3. Every `import()` of a later chunk with app code goes through the gate: a
//    boot-started page's with "boot", any other's with every part. There are
//    such loads (a build where none matched would prove nothing).

type ManifestChunk = { file: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[] };

const CATALOG_SOURCE = /^src\/i18n\/messages\/[a-z]{2}(?:-[a-z]{2})?\.ts$/;
const LAZY_IMPORT = /import\((["'`])\.\/((?:[^"'`$\\]|\$(?!\{))+?\.js)\1\)/g;
const GATE_BEFORE = new RegExp(`\\(globalThis\\.${CATALOG_GATE}\\|\\|\\((\\w+)=>\\1\\)\\)\\($`);
const BOOT_ARGUMENT = /^,\s*["'`]boot["'`]\)/;

/** The manifest keys of the modules `source` (web root relative) loads with a literal `import()`. */
export function dynamicImportTargets(source: string, code: string, exists: (path: string) => boolean): string[] {
  return [...code.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((match) => {
    const base = posix.join(posix.dirname(source), match[1]!);
    const found = [base, `${base}.tsx`, `${base}.ts`].find(exists);
    if (!found) throw new Error(`${source}: import(${match[1]}) not found`);
    return found;
  });
}

export function validateCatalogParts(input: {
  manifest: Record<string, ManifestChunk>;
  files: Map<string, string>;
  html: string;
  parts: Map<string, Record<string, string>>;
  bootPages: readonly string[];
}): { firstIds: number; bootIds: number; restIds: number; gated: number; bootGated: number } {
  const { manifest, files, html, parts, bootPages } = input;
  const errors: string[] = [];
  const mapJson = new RegExp(`<script type="application/json" id="${LOCALE_CATALOGS_ELEMENT_ID}">([^<]*)</script>`).exec(html)?.[1];
  const map = mapJson ? JSON.parse(mapJson) as Record<string, string> : {};
  if (!mapJson) errors.push("index.html has no catalog map");
  for (const key of Object.keys(manifest)) if (CATALOG_SOURCE.test(key)) errors.push(`a whole catalog is still built: ${key}`);

  const closure = (keys: string[]) => {
    const seen = new Set<string>();
    const pending = [...keys];
    while (pending.length > 0) {
      const key = pending.pop()!;
      const chunk = manifest[key];
      if (!chunk || seen.has(chunk.file)) continue;
      seen.add(chunk.file);
      pending.push(...(chunk.imports ?? []));
    }
    return seen;
  };
  const initial = closure(Object.entries(manifest).filter(([, chunk]) => chunk.isEntry).map(([key]) => key));
  const appChunks = new Set<string>();
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.file.endsWith(".js") && !key.includes("node_modules/")) appChunks.add(chunk.file);
  const bootFiles = new Set<string>();
  for (const page of bootPages) {
    const chunk = manifest[page];
    if (!chunk?.isDynamicEntry) errors.push(`boot-started page ${page} has no chunk of its own`);
    else bootFiles.add(chunk.file);
  }

  const counts = { firstIds: 0, bootIds: 0, restIds: 0 };
  const enParts = CATALOG_PARTS.map((part) => parts.get(partKey("en", part)));
  if (enParts.some((part) => !part)) {
    errors.push("no en catalog parts");
  } else {
    const [first, boot, rest] = enParts as Record<string, string>[];
    const ids = [...Object.keys(first), ...Object.keys(boot), ...Object.keys(rest)];
    counts.firstIds = Object.keys(first).length;
    counts.bootIds = Object.keys(boot).length;
    counts.restIds = Object.keys(rest).length;
    const namedFirst = idsNamedBy([...initial].map((file) => files.get(file) ?? ""), ids);
    const bootClosure = closure(bootPages.filter((page) => manifest[page]));
    const namedBoot = idsNamedBy([...bootClosure].filter((file) => !initial.has(file)).map((file) => files.get(file) ?? ""), ids);
    for (const locale of DISPLAY_LOCALES) {
      const own = CATALOG_PARTS.map((part) => parts.get(partKey(locale, part)));
      for (const part of CATALOG_PARTS) if (!map[partKey(locale, part)]) errors.push(`the catalog map lacks ${locale}'s ${part} part`);
      if (own.some((part) => !part)) {
        errors.push(`${locale}: a catalog part is missing from the build`);
        continue;
      }
      const [ownFirst, ownBoot, ownRest] = own as Record<string, string>[];
      const inTwo = Object.keys(ownFirst).filter((id) => Object.hasOwn(ownBoot, id) || Object.hasOwn(ownRest, id))
        .concat(Object.keys(ownBoot).filter((id) => Object.hasOwn(ownRest, id)));
      if (inTwo.length > 0) errors.push(`${locale}: ${inTwo.length} ids in two parts (${inTwo.slice(0, 3).join(", ")})`);
      // en and zh-cn have every id; the others may lack one (it renders en's), but not have it in a later part.
      const complete = locale === "en" || locale === "zh-cn";
      const lacking = (named: Set<string>, has: (id: string) => boolean) => [...named].filter((id) => !has(id) && (complete || Object.hasOwn(ownRest, id) || Object.hasOwn(ownBoot, id)));
      const missingFirst = lacking(namedFirst, (id) => Object.hasOwn(ownFirst, id));
      if (missingFirst.length > 0) errors.push(`${locale}: the first download names ${missingFirst.length} ids its first part lacks (${missingFirst.slice(0, 3).join(", ")})`);
      const missingBoot = lacking(namedBoot, (id) => Object.hasOwn(ownFirst, id) || Object.hasOwn(ownBoot, id));
      if (missingBoot.length > 0) errors.push(`${locale}: the boot-started pages name ${missingBoot.length} ids its first and boot parts lack (${missingBoot.slice(0, 3).join(", ")})`);
    }
  }

  let gated = 0;
  let bootGated = 0;
  for (const [file, code] of files) {
    if (!file.endsWith(".js")) continue;
    for (const match of code.matchAll(LAZY_IMPORT)) {
      const target = posix.join(posix.dirname(file), match[2]!);
      if (initial.has(target) || !appChunks.has(target)) continue;
      const before = code.slice(Math.max(0, match.index - 60), match.index);
      const after = code.slice(match.index + match[0].length, match.index + match[0].length + 12);
      if (!GATE_BEFORE.test(before)) {
        errors.push(`${file} loads ${target} without the catalog gate`);
        continue;
      }
      gated++;
      const boot = BOOT_ARGUMENT.test(after);
      if (boot) bootGated++;
      if (boot !== bootFiles.has(target)) errors.push(`${file} loads ${target} with the ${boot ? "boot" : "rest"} gate; it is ${bootFiles.has(target) ? "" : "not "}a boot-started page`);
    }
  }
  if (gated === 0) errors.push("no later chunk load goes through the catalog gate: the check found nothing to check");
  if (bootGated === 0) errors.push("no boot-started page loads through the boot gate");

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { ...counts, gated, bootGated };
}

async function main() {
  const webRoot = fileURLToPath(new URL("..", import.meta.url));
  const dist = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL("../dist/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL(".vite/manifest.json", dist), "utf8")) as Record<string, ManifestChunk>;
  const html = await readFile(new URL("index.html", dist), "utf8");
  const files = new Map<string, string>();
  for (const { file } of Object.values(manifest)) {
    if (file.endsWith(".js") && !files.has(file)) files.set(file, await readFile(new URL(file, dist), "utf8"));
  }
  const map = JSON.parse(await readFile(new URL(".vite/catalog-parts.json", dist), "utf8")) as Record<string, string>;
  const parts = new Map<string, Record<string, string>>();
  for (const [key, href] of Object.entries(map)) {
    const module = await import(new URL(href.replace(/^\//, ""), dist).href) as { default: Record<string, string> };
    parts.set(key, module.default);
  }
  const bootPages: string[] = [...BOOT_CHUNK_PAGES];
  for (const loader of BOOT_CHUNK_LOADERS) {
    bootPages.push(...dynamicImportTargets(loader, await readFile(resolve(webRoot, loader), "utf8"), (path) => statSync(resolve(webRoot, path), { throwIfNoEntry: false })?.isFile() === true));
  }
  try {
    const result = validateCatalogParts({ manifest, files, html, parts, bootPages: [...new Set(bootPages)] });
    console.log(`[catalog-parts] ids: first ${result.firstIds}, boot ${result.bootIds}, rest ${result.restIds}; ${result.gated} later-chunk loads gated (${result.bootGated} boot-started pages)`);
  } catch (error) {
    console.error(`[catalog-parts] catalog parts broken:\n${(error as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

