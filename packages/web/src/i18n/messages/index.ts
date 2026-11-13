// Per-locale react-intl message maps + the MessageId union.
//
// Every catalog, `en` included, is fetched the first time its locale is shown:
// `loadLocaleMessages(locale)` loads what the locale's first screen needs,
// `mergedMessages(locale)` reads it once loaded. The boot script preloads the
// initial locale's from the page (boot/bootInlineScript.ts) and the app holds
// its first render until they are in (preloadLocaleMessages.ts), so nothing on
// screen is ever a raw id. English words code outside React needs
// synchronously are in enFallback.ts, not here.
//
// A web build ships each catalog in three parts (catalogParts.ts,
// scripts/catalogPartsPlugin.ts), named in the page's catalog map: the first
// part, every id the first download's code names, which is what the boot
// loads; the boot part, the ids of the pages main.tsx starts at boot from the
// address, which such a page waits for beside its chunk; and the rest, which
// `fetchDeferredUi` asks for after the first screen. Every later chunk waits
// for what it may show before it runs (withCatalogPart: the build wraps each
// such `import()` in it). A page without the map (the dev server, Raft
// Desktop's renderer, the tests, the boot shell's prerender) loads each
// catalog whole, as its first part, with empty boot and rest parts.
//
// en and zh-cn are complete (`Record<MessageId, string>`; zh-cn is its language
// owner's contract), so a reader of either loads that one catalog. The other
// catalogs are `Partial`: an id one lacks renders the English until it is
// backfilled, so those locales load en too. Adding English copy never requires
// six translations in the same PR. `scripts/i18n-missing.ts` lists what to
// backfill.

import { importHandledLocally } from "../../utils/dynamicImportRecovery";
import type { Locale } from "../locale";
import { CATALOG_GATE, CATALOG_PARTS, LOCALE_CATALOGS_ELEMENT_ID, partKey } from "./catalogParts";
import type { CatalogGate, CatalogPart } from "./catalogParts";
import type { MessageId } from "./en";

export type { MessageId };

type Catalog = Record<MessageId, string>;
type LocaleCatalog = Partial<Catalog>;

// Set by the web build (scripts/catalogPartsPlugin.ts), which loads the parts
// its page names: the whole catalogs are then not built at all.
declare const __RAFT_CATALOG_PARTS__: boolean | undefined;
const PARTS_BUILD = typeof __RAFT_CATALOG_PARTS__ !== "undefined" && __RAFT_CATALOG_PARTS__;

const noWholeCatalog = (): Promise<LocaleCatalog> => Promise.reject(new Error("Failed to fetch dynamically imported module: this build ships its catalogs in parts, and the page names none"));

const CATALOG_LOADERS: Record<Locale, () => Promise<LocaleCatalog>> = PARTS_BUILD
  ? { en: noWholeCatalog, es: noWholeCatalog, "pt-br": noWholeCatalog, ru: noWholeCatalog, ko: noWholeCatalog, ja: noWholeCatalog, "zh-cn": noWholeCatalog, "zh-tw": noWholeCatalog }
  : {
    en: () => import("./en").then((module) => module.en),
    es: () => import("./es").then((module) => module.es),
    "pt-br": () => import("./pt-br").then((module) => module.ptBr),
    ru: () => import("./ru").then((module) => module.ru),
    ko: () => import("./ko").then((module) => module.ko),
    ja: () => import("./ja").then((module) => module.ja),
    "zh-cn": () => import("./zh-cn").then((module) => module.zhCn),
    "zh-tw": () => import("./zh-tw").then((module) => module.zhTw),
  };

/**
 * Tests only: the loader for one locale's catalog (a request that never
 * answers, for the timeout). Through a module mock, a pending factory was not
 * always the import the loader awaited under a loaded CI runner.
 */
export function __setCatalogLoaderForTest(locale: Locale, loader: () => Promise<LocaleCatalog>): void {
  CATALOG_LOADERS[locale] = loader;
}

/** Locales whose own catalog has every id: nothing to fill in from en. */
const COMPLETE_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["en", "zh-cn"]);

const EMPTY_CATALOG = {} as Catalog;

const loadedParts: Partial<Record<Locale, Partial<Record<CatalogPart, LocaleCatalog>>>> = {};
const mergedCatalogs = new Map<Locale, Catalog>();
const pendingLoads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** The catalogs `locale` is shown from: its own, and en under a partial locale. */
export function catalogsFor(locale: Locale): Locale[] {
  return COMPLETE_LOCALES.has(locale) ? [locale] : [locale, "en"];
}

function hasPart(locale: Locale, part: CatalogPart): boolean {
  return loadedParts[locale]?.[part] !== undefined;
}

/** Whether what `locale`'s first screen needs is in memory: the first part of every catalog it is shown from. */
export function isLocaleMessagesLoaded(locale: Locale): boolean {
  return catalogsFor(locale).every((catalog) => hasPart(catalog, "first"));
}

/** The parts a gate waits for: the first and boot parts, or all three. */
function partsUpTo(gate: CatalogPart): readonly CatalogPart[] {
  return CATALOG_PARTS.slice(0, CATALOG_PARTS.indexOf(gate) + 1);
}

function hasPartsUpTo(locale: Locale, gate: CatalogPart): boolean {
  return catalogsFor(locale).every((catalog) => partsUpTo(gate).every((part) => hasPart(catalog, part)));
}

/** Whether every id `locale` is shown with is in memory: every part of every catalog it is shown from. */
export function isLocaleMessagesComplete(locale: Locale): boolean {
  return hasPartsUpTo(locale, "rest");
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** One catalog's parts in memory, merged. */
function partsOf(locale: Locale): LocaleCatalog[] {
  const parts = loadedParts[locale];
  return parts?.first ? CATALOG_PARTS.map((part) => parts[part] ?? {}) : [];
}

/** What `shown` reads from the parts in memory (see mergedMessages). Null with nothing loaded. */
function compose(shown: Locale): Catalog | null {
  const pieces: LocaleCatalog[] = [];
  if (!loadedParts[shown]?.first) {
    // Not in yet: what is loaded of en.
    if (shown !== "en") pieces.push(...partsOf("en"));
  } else {
    if (!COMPLETE_LOCALES.has(shown)) pieces.push(...partsOf("en"));
    pieces.push(...partsOf(shown));
  }
  return pieces.length > 0 ? Object.assign({}, ...pieces) as Catalog : null;
}

// An id shown before the part that has it was in (IntlProviderWrapper's
// onError): the next part that arrives replaces the messages object, so what
// shows that id renders again, with its words.
let missingIdShown = false;

/** IntlProviderWrapper: an id the loaded parts lack was shown. */
export function noteMissingIdShown(): void {
  missingIdShown = true;
}

function registerPart(locale: Locale, part: CatalogPart, catalog: LocaleCatalog): void {
  (loadedParts[locale] ??= {})[part] = catalog;
  if (part === "first" || missingIdShown) {
    // Until every part is in: the id shown may be in a part still to come.
    if (missingIdShown && isLocaleMessagesComplete(shownLocale)) missingIdShown = false;
    mergedCatalogs.clear();
  } else {
    // A later part adds ids nothing on screen shows yet (a first-screen id is
    // in a first part): filled into the object IntlProvider already has, so
    // the app is not rendered again for words it does not show.
    for (const [shown, merged] of mergedCatalogs) {
      if (catalogsFor(shown).includes(locale)) Object.assign(merged, compose(shown));
    }
  }
  notify();
}

/** Install a whole catalog that is already in memory (tests): all its parts. */
export function registerLocaleMessages(locale: Locale, catalog: LocaleCatalog): void {
  loadedParts[locale] = { first: catalog, boot: {}, rest: {} };
  mergedCatalogs.clear();
  notify();
}

/** A catalog request that has not answered in this long counts as failed: on a weak network one can hang with no error. */
export const CATALOG_LOAD_TIMEOUT_MS = 12_000;

type CatalogPartMap = Partial<Record<string, string>>;
let pagePartMap: CatalogPartMap | null | undefined;

/** The page's catalog map (a web build's index.html), or null: then each catalog loads whole. */
function catalogPartMap(): CatalogPartMap | null {
  if (pagePartMap !== undefined) return pagePartMap;
  pagePartMap = null;
  try {
    const text = typeof document === "undefined" ? null : document.getElementById(LOCALE_CATALOGS_ELEMENT_ID)?.textContent;
    const map: unknown = text ? JSON.parse(text) : null;
    if (map && typeof map === "object" && CATALOG_PARTS.every((part) => typeof (map as CatalogPartMap)[partKey("en", part)] === "string")) pagePartMap = map as CatalogPartMap;
  } catch {
    // An unreadable map: whole catalogs, as on a page without one.
  }
  return pagePartMap;
}

let partLoaderForTest: ((locale: Locale, part: CatalogPart) => Promise<LocaleCatalog>) | null = null;

/** Tests only: load catalogs in parts, as a web build does, from this loader instead of the page's map. */
export function __setCatalogPartLoaderForTest(loader: ((locale: Locale, part: CatalogPart) => Promise<LocaleCatalog>) | null): void {
  partLoaderForTest = loader;
}

function fetchPart(locale: Locale, part: CatalogPart): Promise<LocaleCatalog> {
  if (partLoaderForTest) return partLoaderForTest(locale, part);
  const map = catalogPartMap();
  if (!map) return part === "first" ? CATALOG_LOADERS[locale]() : Promise.resolve({});
  const href = map[partKey(locale, part)];
  if (!href) return Promise.reject(new Error(`Failed to fetch dynamically imported module: no ${part} part of the ${locale} catalog in this page`));
  // The part's URL is the page's (its file is no chunk the bundler knows: catalogPartsPlugin.ts).
  // oxlint-disable-next-line react-doctor/no-dynamic-import-path
  return import(/* @vite-ignore */ href).then((module: { default: LocaleCatalog }) => module.default);
}

function loadPart(locale: Locale, part: CatalogPart): Promise<void> {
  if (hasPart(locale, part)) return Promise.resolve();
  const key = `${locale}:${part}`;
  const pending = pendingLoads.get(key);
  if (pending) return pending;
  // importHandledLocally: a failed chunk is this loader's to handle (a retry at
  // boot, the current language kept on a switch, a deferred panel's Try
  // again), so main.tsx's preload-error handler does not raise the app-wide
  // refresh prompt over it.
  const imported = importHandledLocally(() => fetchPart(locale, part)).then((catalog: unknown) => {
    // Not a catalog (a host's error page served as JS...): a failed load, so
    // nothing waiting on this part spins on it.
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      throw new Error(`Failed to fetch dynamically imported module: the ${part} part of the ${locale} catalog is not a catalog`);
    }
    // A late answer after the timeout still counts.
    if (!hasPart(locale, part)) registerPart(locale, part, catalog as LocaleCatalog);
  });
  // Its own failure is reported through `load` below; a failure after the timeout already settled it.
  imported.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Failed to fetch dynamically imported module: the ${locale} catalog did not load within ${CATALOG_LOAD_TIMEOUT_MS / 1000} s`,
    )), CATALOG_LOAD_TIMEOUT_MS);
  });
  const load = Promise.race([imported, timeout]).finally(() => {
    clearTimeout(timer);
    pendingLoads.delete(key);
  });
  pendingLoads.set(key, load);
  return load;
}

/**
 * Fetch what `locale`'s first screen needs (the first part of each catalog it
 * is shown from), once each. Resolves immediately when it is loaded;
 * concurrent callers share one request; a failed request can be retried.
 */
export function loadLocaleMessages(locale: Locale): Promise<void> {
  return Promise.all(catalogsFor(locale).map((catalog) => loadPart(catalog, "first"))).then(() => {});
}

/** Fetch the parts up to `gate` of every catalog `locale` is shown from. */
function loadLocaleParts(locale: Locale, gate: CatalogPart): Promise<void> {
  return Promise.all(catalogsFor(locale).flatMap((catalog) => partsUpTo(gate).map((part) => loadPart(catalog, part)))).then(() => {});
}

/** Fetch every part of every catalog `locale` is shown from. */
export function loadLocaleMessagesComplete(locale: Locale): Promise<void> {
  return loadLocaleParts(locale, "rest");
}

// The furthest part anything has asked for (a later chunk, the background
// fetch): a language switch then waits for the new locale's parts that far
// too, as what is open may show any of their ids.
let wantedPart: CatalogPart = "first";

function want(gate: CatalogGate): void {
  if (CATALOG_PARTS.indexOf(gate) > CATALOG_PARTS.indexOf(wantedPart)) wantedPart = gate;
}

/** Whether the app can switch to `locale` now (LocaleProvider): its parts as far as they are wanted. */
export function isLocaleReadyToShow(locale: Locale): boolean {
  return hasPartsUpTo(locale, wantedPart);
}

/** Load what `isLocaleReadyToShow` needs; checked again after each load, as more may be wanted meanwhile. */
export async function loadLocaleToShow(locale: Locale): Promise<void> {
  while (!isLocaleReadyToShow(locale)) await loadLocaleParts(locale, wantedPart);
}

/**
 * Resolves once the shown locale's parts up to `gate` are in (the first and
 * boot parts, or all three), again for the new one if the language changed
 * meanwhile. Read a microtask late: main.tsx starts a landing page's chunk
 * before it names the initial locale (preloadInitialLocaleMessages), in the
 * same task. Each round loads something or rejects (loadPart), so it ends.
 */
export function catalogPartsReady(gate: CatalogGate = "rest"): Promise<void> {
  want(gate);
  return Promise.resolve().then(async () => {
    while (!hasPartsUpTo(shownLocale, gate)) await loadLocaleParts(shownLocale, gate);
  });
}

/** Every part of the shown locale (the background fetch after the first screen, IntlProviderWrapper's missing id). */
export function restCatalogReady(): Promise<void> {
  return catalogPartsReady("rest");
}

/**
 * A chunk past the first download, resolved only once the words it may show
 * are in (catalogPartsReady): its first render never shows a raw id. A web
 * build sends every such `import()` through this (globalThis[CATALOG_GATE],
 * scripts/catalogPartsPlugin.ts): "boot" for a page main.tsx starts at boot,
 * every part for anything else. A part that fails rejects the load as a
 * failed download, so the caller's Try again asks for both again.
 */
export function withCatalogPart<T>(module: Promise<T>, gate: CatalogGate = "rest"): Promise<T> {
  return Promise.all([module, catalogPartsReady(gate)]).then(([loaded]) => loaded);
}

(globalThis as Record<string, unknown>)[CATALOG_GATE] = withCatalogPart;

/** Notifies when a catalog part finishes loading, for `useSyncExternalStore`. */
export function subscribeLocaleMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Messages for `locale`: a complete catalog as it is; a partial one overlaid on
 * en, so an id not yet translated reads as English rather than its raw id.
 * Before the catalogs are in, what is loaded (en for a locale still loading,
 * when it is there): the boot holds the first render until they are, and a
 * language switch commits only once they are (LocaleProvider). The result is
 * cached, so callers get a stable object to hand to IntlProvider; a rest part
 * that arrives later is filled into that same object.
 */
export function mergedMessages(locale: Locale): Catalog {
  let merged = mergedCatalogs.get(locale);
  if (!merged) {
    const composed = compose(locale);
    if (!composed) return EMPTY_CATALOG;
    merged = composed;
    mergedCatalogs.set(locale, merged);
  }
  return merged;
}

let shownLocale: Locale = "en";

/** The locale the app is showing (the boot's initial locale, then IntlProviderWrapper's). */
export function setShownLocale(locale: Locale): void {
  shownLocale = locale;
}

/**
 * The shown locale and its messages, for words formatted outside React
 * (background hints, store errors): the catalogs that are loaded, so a
 * Simplified Chinese reader, who never loads en, gets Chinese rather than ids.
 */
export function shownLocaleMessages(): { locale: Locale; messages: Catalog } {
  return { locale: shownLocale, messages: mergedMessages(shownLocale) };
}
