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
