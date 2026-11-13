const DYNAMIC_IMPORT_FAILURE_PREFIX = "slock:dynamic-import-failure:";

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload (?:CSS )?for/i,
  /ChunkLoadError/i,
  /Loading chunk \S+ failed/i,
];

function textFromError(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, error.stack].filter(Boolean).join("\n");
  }
  return String(error);
}

function keySuffixForError(text: string): string {
  const url = text.match(/https?:\/\/[^\s"'<>)]*/)?.[0];
  if (url) return url;
  return text.replace(/\s+/g, " ").slice(0, 160);
}

export function dynamicImportFailureKey(error: unknown): string | null {
  const text = textFromError(error);
  if (!DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return `${DYNAMIC_IMPORT_FAILURE_PREFIX}${keySuffixForError(text)}`;
}

export function isDynamicImportFailure(error: unknown): boolean {
  return dynamicImportFailureKey(error) !== null;
}

let locallyHandledImports = 0;

/**
 * A dynamic import whose failure its caller shows in place (the Artifact
 * viewer's Try again, apps/artifacts/artifactLazyChunk.tsx). While one is in
 * flight, main.tsx's `vite:preloadError` handler does not raise the app-wide
 * refresh prompt: in a production build every import() goes through Vite's
 * preload helper, which dispatches that event before the import rejects.
 * Anything else that fails at the same time still reaches RootErrorBoundary,
 * which raises the prompt itself.
 */
export function importHandledLocally<T>(load: () => Promise<T>): Promise<T> {
  locallyHandledImports++;
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    locallyHandledImports--;
  };
  try {
    return load().finally(settle);
  } catch (error) {
    settle();
    return Promise.reject(error);
  }
}

/** Whether an importHandledLocally load is in flight (main.tsx's preload-error handler). */
export function isLocallyHandledImportPending(): boolean {
  return locallyHandledImports > 0;
}

let reloadOntoNewerRelease: () => boolean = () => false;

/** main.tsx: how a page whose release was replaced reloads onto the kept one (reloadOntoKeptRelease). */
export function registerStaleReleaseReload(reload: () => boolean): void {
  reloadOntoNewerRelease = reload;
}

/**
 * A chunk's own Try again, before asking for the same file again: a page
 * whose release the service worker has since replaced reloads onto it (its
 * old files may be gone from the server), as the app-wide prompt would.
 * True when it reloads.
 */
export function reloadIfReleaseSuperseded(): boolean {
  return reloadOntoNewerRelease();
}

let checkReleaseShownInPlace: (error: unknown) => void = () => {};

/** main.tsx (installAppUpdateGate): what a chunk failure shown in place also does. */
export function registerChunkFailureShownInPlace(check: (error: unknown) => void): void {
  checkReleaseShownInPlace = check;
}

/**
 * A chunk failure its surface shows in place (deferredPanel / lazyPanel /
 * deferredDialog / lazyDialog's Try again), whose import skipped the app-wide
 * check (importHandledLocally): the same release check the app-wide path runs
 * (appUpdateGate), so a release gone from the server still brings up the
 * update strip (or reloads onto the kept one) beside the local Try again; a
 * blip, nothing more.
 */
export function noteChunkFailureShownInPlace(error: unknown): void {
  checkReleaseShownInPlace(error);
}

/**
 * What a failed chunk says about this page's release (main.tsx's
 * `vite:preloadError`): "gone", the server no longer has this release's files
 * (a deploy replaced it: refreshing is the way out); "current", it still has
 * them (a network blip, a page the phone suspended mid-request: the import can
 * simply be tried again); "unknown", the server could not be asked.
 */
export type ReleaseCheck = "current" | "gone" | "unknown";

const CHUNK_URL = /(?:https?:\/\/[^\s"'<>)]+|\/assets\/[^\s"'<>)]+)/;

/** The failed file's own address when the error names one on this origin (Safari's "Importing a module script failed." does not). */
function failedChunkUrl(error: unknown): string | null {
  const match = textFromError(error).match(CHUNK_URL)?.[0];
  if (!match) return null;
  try {
    const url = new URL(match, window.location.href);
    return url.origin === window.location.origin ? url.href : null;
  } catch {
    return null;
  }
}

/** The page's entry script: a deploy removes it with every other file of the release. */
function entryScriptUrl(): string | null {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src || null;
}

// HEAD skips the service worker (sw.js answers GETs only), so this asks the
// server; the Pages Worker answers a missing built file with a real 404
// (_worker.js normalizeBuiltAssetResponse), never the SPA's HTML.
async function probe(url: string): Promise<ReleaseCheck> {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
    if (response.ok) return "current";
    return response.status === 404 || response.status === 410 ? "gone" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Resolves once the page is visible and online (a backgrounded phone, a dropped connection), then after `delayMs`. */
function untilReachable(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const ready = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
    const check = () => {
      if (!ready()) return;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      setTimeout(resolve, delayMs);
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    check();
  });
}

export const RELEASE_RECHECK_DELAY_MS = 2_000;

/**
 * Asks the server whether this page's release is still there after a chunk
 * failed: the failed file (when the error names it) and the page's entry
 * script. A request that fails is tried once more when the page is visible
 * and online again.
 */
export async function checkReleaseAfterChunkFailure(error: unknown): Promise<ReleaseCheck> {
  const urls = [...new Set([failedChunkUrl(error), entryScriptUrl()].filter((url): url is string => url !== null))];
  if (urls.length === 0) return "unknown";
  const once = async (): Promise<ReleaseCheck> => {
    const results = await Promise.all(urls.map(probe));
    if (results.includes("gone")) return "gone";
    return results.every((result) => result === "current") ? "current" : "unknown";
  };
  await untilReachable(0);
  const first = await once();
  if (first !== "unknown") return first;
  await untilReachable(RELEASE_RECHECK_DELAY_MS);
  return once();
}
