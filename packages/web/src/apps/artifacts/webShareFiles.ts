// Handing an Artifact's file (⋯'s Share) to the system share sheet with the
// standard Web Share API (`navigator.share({ files })`). One path for every
// browser and the mobile App's web view, which implements `share` and
// `canShare` itself; nothing here asks which one it is.

/** A navigator as file sharing reads it: either method may be missing. */
export interface FileShareNavigator {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
}

/**
 * Whether `files` can be shared here: `share` and `canShare` both exist and
 * `canShare` takes these files (a browser refuses some types, or files at
 * all). A `canShare` that throws is a no.
 */
export function canShareFiles(files: File[], nav: FileShareNavigator | undefined): boolean {
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files });
  } catch {
    return false;
  }
}

/** The person closed the share sheet without sharing: nothing went wrong, so nothing is said. */
export function isShareAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
