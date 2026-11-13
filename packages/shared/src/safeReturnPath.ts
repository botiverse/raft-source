const SAFE_RETURN_PATH_BASE = "https://return-path.invalid";
const ENCODED_BACKSLASH_RE = /%5c/i;
const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** Longer than any path the app routes to; a longer one is dropped, not cut (a cut path could name another page). */
export const MAX_APP_LOCAL_RETURN_PATH_LENGTH = 2048;

/**
 * Normalize an application-local redirect target without allowing URL parser
 * differences (notably backslash-as-slash handling) to turn it into an
 * external navigation. Anything else (not a string, not starting with one
 * `/`, `//` or `/\`, a scheme, control characters, longer than
 * MAX_APP_LOCAL_RETURN_PATH_LENGTH) becomes `/`.
 */
export function sanitizeAppLocalReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_APP_LOCAL_RETURN_PATH_LENGTH || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  if (value.includes("\\") || ENCODED_BACKSLASH_RE.test(value) || ASCII_CONTROL_RE.test(value)) {
    return "/";
  }

  try {
    const resolved = new URL(value, SAFE_RETURN_PATH_BASE);
    if (resolved.origin !== SAFE_RETURN_PATH_BASE) return "/";
    // URL parsing removes dot segments. Recheck the normalized path because a
    // local-looking input such as `/a/..//host` normalizes to a scheme-relative
    // navigation target (`//host`) when passed back to window.location.
    if (resolved.pathname.startsWith("//")) return "/";
    const normalized = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    // Percent-encoding can lengthen it past the cap.
    return normalized.length > MAX_APP_LOCAL_RETURN_PATH_LENGTH ? "/" : normalized;
  } catch {
    return "/";
  }
}
