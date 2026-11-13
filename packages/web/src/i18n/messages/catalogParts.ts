// Each display locale's catalog ships in three parts in a web build
// (scripts/catalogPartsPlugin.ts), docs/frontend/i18n/README.md "First-screen part":
// - first: every id the first download's code names; the first render waits for it;
// - boot: the ids of the pages main.tsx starts at boot from the address (a
//   landing page, a thread or Artifact link, the server setup steps...: the
//   chunks BOOT_CHUNK_LOADERS and BOOT_CHUNK_PAGES name), which such a page
//   waits for beside its chunk;
// - rest: everything else, asked for once the first screen is done; every
//   other later chunk waits for it (and the boot part) before it runs
//   (messages/index.ts, withCatalogPart).
//
// Pure, no imports: the Vite config, the build check and the app read it.

export const CATALOG_PARTS = ["first", "boot", "rest"] as const;
export type CatalogPart = (typeof CATALOG_PARTS)[number];
/** What a later chunk waits for: "boot" (the first and boot parts) or "rest" (all three). */
export type CatalogGate = Exclude<CatalogPart, "first">;

/**
 * `<script type="application/json">` in index.html, by this id: each locale's
 * first part under its code (`en`, read by the boot script, which
 * modulepreloads the boot locale's), the others under `<code>:boot` and
 * `<code>:rest` (scripts/bootShellPlugin.ts writes it, public/sw.js keeps the files).
 */
export const LOCALE_CATALOGS_ELEMENT_ID = "raft-locale-catalogs";

/** The page map's key for a locale's part. */
export function partKey(locale: string, part: CatalogPart): string {
  return part === "first" ? locale : `${locale}:${part}`;
}

/**
 * The global a web build's later chunk loads go through: the plugin wraps
 * each `import()` of a chunk with app code in `globalThis[...](import(...))`
 * (`, "boot"` for a chunk main.tsx starts at boot), set by messages/index.ts:
 * the chunk resolves only once the parts it may show are in, so nothing it
 * renders is ever a raw id.
 */
export const CATALOG_GATE = "__raftCatalogGate";

/**
 * Modules whose `import()`s main.tsx starts at boot for the address (web root
 * relative): the chunks they load wait for the boot part only, and their ids
 * are in it. The build fails when one of these is gone or loads nothing.
 */
export const BOOT_CHUNK_LOADERS = [
  "src/pages/landingPages.ts",
  "src/components/onboarding/serverSetupStepChunks.ts",
  "src/features/thread/threadPanelChunk.ts",
  "src/features/computer/computersRackChunk.ts",
  "src/apps/artifacts/artifactOpenEarly.ts",
] as const;

/** Pages the address names that App.tsx loads lazily on its own (not through a loader above). */
export const BOOT_CHUNK_PAGES = ["src/components/window/ThreadWindowRoute.tsx"] as const;

// A string literal in built code that is an id ("common.confirm.cancel"),
// or the head of one built from it ("push." + x, `agent.status.${s}`).
const ID_LITERAL = /["'`]([A-Za-z][\w-]*(?:\.[\w-]+)*\.?)(?=["'`]|\$\{)/g;

/**
 * The ids `codes` (built chunks) name: every id named as a string, and every
 * id under a prefix one is built from (a literal ending in "." or a
 * template's head before `${`). The first part is what the first download's
 * chunks name; the boot part what the boot-started pages' chunks name. Ids
 * are typed `MessageId`, so they are written out (docs/frontend/i18n/README.md).
 */
export function idsNamedBy(codes: Iterable<string>, ids: readonly string[]): Set<string> {
  const all = new Set(ids);
  const named = new Set<string>();
  const prefixes = new Set<string>();
  for (const code of codes) {
    for (const match of code.matchAll(ID_LITERAL)) {
      const literal = match[1];
      if (all.has(literal)) named.add(literal);
      // A literal an id is built from ("push." + key) or a template's head
      // (`agent.status.${s}`, `task.status${s}`); dotted, as every id is (`h${level}` is a tag).
      else if (literal.includes(".") && (literal.endsWith(".") || code[match.index + match[0].length] === "$")) prefixes.add(literal);
    }
  }
  const heads = [...prefixes];
  for (const id of ids) {
    if (!named.has(id) && heads.some((head) => id.startsWith(head))) named.add(id);
  }
  return named;
}

/** A catalog split into its three parts by the first and boot parts' ids (an id in neither is in the rest). */
export function splitCatalog(
  catalog: Readonly<Record<string, string>>,
  first: ReadonlySet<string>,
  boot: ReadonlySet<string> = new Set(),
): Record<CatalogPart, Record<string, string>> {
  const parts: Record<CatalogPart, Record<string, string>> = { first: {}, boot: {}, rest: {} };
  for (const [id, text] of Object.entries(catalog)) parts[first.has(id) ? "first" : boot.has(id) ? "boot" : "rest"][id] = text;
  return parts;
}
