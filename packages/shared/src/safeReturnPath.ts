const SAFE_RETURN_PATH_BASE = "https://return-path.invalid";
const ENCODED_BACKSLASH_RE = /%5c/i;
const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Normalize an application-local redirect target without allowing URL parser
 * differences (notably backslash-as-slash handling) to turn it into an
 * external navigation.
 */
export function sanitizeAppLocalReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
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
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}
