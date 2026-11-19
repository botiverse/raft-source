/** An http(s) address as a URL, else null: never javascript:, data:, blob:, file: or a custom protocol. */
export function webPreviewUrl(href: string | undefined | null): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The address typed into the built-in browser's address bar, as an http(s)
 * URL, or null where it isn't one: with a scheme it is taken as written (and
 * must be http or https); without, `https://` is assumed, `http://` for this
 * computer's own names (localhost, 127.0.0.1, [::1]), which seldom serve
 * https. There is no search: words that aren't an address go nowhere.
 */
export function typedWebAddress(text: string): URL | null {
  const typed = text.trim();
  if (!typed || /\s/.test(typed)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) return webPreviewUrl(typed);
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(typed);
  const url = webPreviewUrl(`${local ? "http" : "https"}://${typed}`);
  // A bare word is not a host: a name needs a dot unless it is this computer's.
  return url && (local || url.hostname.includes(".") || url.hostname.startsWith("[")) ? url : null;
}

/** The most characters of a refused address shown after its host (or its scheme); the rest is cut with "…". */
export const BLOCKED_ADDRESS_REST_MAX = 48;
/** The most characters of a refused address in the hover text. */
const BLOCKED_ADDRESS_FULL_MAX = 2048;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The address a page chose and the built-in browser refused, as the notice
 * shows it before its button opens it: `lead` is what says where it goes and
 * is never cut (a web address's host, without any user:password@; another
 * application's scheme), `rest` is what follows (path, query and fragment; the
 * scheme's target), cut to BLOCKED_ADDRESS_REST_MAX; `full` is the whole
 * address for the hover text. Every part is the address as WHATWG serializes
 * it (ASCII: a host in punycode, anything else percent-encoded), so no
 * character of the page's choosing (a right-to-left override, a look-alike
 * letter) reaches Raft's own words. Null where it doesn't parse.
 */
export function blockedAddressParts(address: string): { lead: string; rest: string; full: string } | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const full = cut(url.href, BLOCKED_ADDRESS_FULL_MAX);
  if (url.protocol === "http:" || url.protocol === "https:") {
    const rest = `${url.pathname}${url.search}${url.hash}`;
    return { lead: url.host, rest: rest === "/" ? "" : cut(rest, BLOCKED_ADDRESS_REST_MAX), full };
  }
  return { lead: url.protocol, rest: cut(url.href.slice(url.protocol.length), BLOCKED_ADDRESS_REST_MAX), full };
}
