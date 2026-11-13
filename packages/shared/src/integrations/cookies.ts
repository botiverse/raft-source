// The session cookies an app sets at the agent-login callback, kept and sent
// back the way the `raft` CLI does: host-only (a Domain attribute must equal
// the setting host), path-matched, Secure only over https, until they expire.
// These cookies are the agent's credential at that app.

export interface IntegrationSessionCookie {
  /** `name=value`, as set. */
  pair: string;
  host: string;
  path: string;
  secure: boolean;
  /** ISO time; absent for a cookie with no expiry. */
  expiresAt?: string;
}

/** Every `Set-Cookie` header of a response (one per cookie). */
export function setCookieHeaderValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getSetCookie === "function"
    ? getSetCookie.call(headers)
    : [headers.get("set-cookie")].filter((value): value is string => Boolean(value));
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return pathname.slice(0, lastSlash);
}

function parseCookieExpiry(parts: string[], now: number): string | undefined {
  const attributes = parts.map((part) => {
    const separator = part.indexOf("=");
    return {
      name: (separator >= 0 ? part.slice(0, separator) : part).trim().toLowerCase(),
      value: separator >= 0 ? part.slice(separator + 1).trim() : "",
    };
  });
  const maxAge = attributes.find((attribute) => attribute.name === "max-age");
  if (maxAge && /^-?\d+$/.test(maxAge.value)) {
    const seconds = Number(maxAge.value);
    if (Number.isSafeInteger(seconds)) {
      return seconds <= 0 ? new Date(0).toISOString() : new Date(now + seconds * 1000).toISOString();
    }
  }
  for (const attribute of attributes) {
    if (attribute.name === "expires") {
      const time = Date.parse(attribute.value);
      if (Number.isFinite(time)) return new Date(time).toISOString();
    }
  }
  return undefined;
}

/** One `Set-Cookie` value from `sourceUrl`; null when it is malformed or names another host. */
export function parseSetCookie(value: string, sourceUrl: URL, now = Date.now()): IntegrationSessionCookie | null {
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  const pair = parts.shift();
  if (!pair || !pair.includes("=") || pair.startsWith("=")) return null;

  const sourceHost = sourceUrl.hostname.toLowerCase();
  let host = sourceHost;
  let cookiePath = defaultCookiePath(sourceUrl.pathname);
  let secure = false;
  for (const part of parts) {
    const separator = part.indexOf("=");
    const name = (separator >= 0 ? part.slice(0, separator) : part).trim().toLowerCase();
    const rawValue = separator >= 0 ? part.slice(separator + 1) : "";
    if (name === "secure") {
      secure = true;
    } else if (name === "path" && rawValue.trim().startsWith("/")) {
      cookiePath = rawValue.trim();
    } else if (name === "domain") {
      const domain = rawValue.trim().replace(/^\./, "").toLowerCase();
      if (domain !== sourceHost) return null;
      host = domain;
    }
  }
  return { pair, host, path: cookiePath, secure, expiresAt: parseCookieExpiry(parts, now) };
}

/** The cookies a response set, parsed against the URL it came from. */
export function cookiesFromResponse(headers: Headers, sourceUrl: URL, now = Date.now()): IntegrationSessionCookie[] {
  return setCookieHeaderValues(headers)
    .map((value) => parseSetCookie(value, sourceUrl, now))
    .filter((cookie): cookie is IntegrationSessionCookie => cookie !== null);
}

export function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (cookiePath.endsWith("/")) return requestPath.startsWith(cookiePath);
  return requestPath.startsWith(`${cookiePath}/`);
}

export function isCookieUnexpired(cookie: IntegrationSessionCookie, now = Date.now(), skewMs = 0): boolean {
  if (!cookie.expiresAt) return true;
  return Date.parse(cookie.expiresAt) > now + skewMs;
}

/** The `cookie` header for a request to `url`, or null when no stored cookie applies. */
export function cookieHeaderForUrl(cookies: readonly IntegrationSessionCookie[], url: URL, now = Date.now()): string | null {
  const host = url.hostname.toLowerCase();
  const valid = cookies
    .filter((cookie) => isCookieUnexpired(cookie, now))
    .filter((cookie) => cookie.host === host)
    .filter((cookie) => !cookie.secure || url.protocol === "https:")
    .filter((cookie) => cookiePathMatches(url.pathname || "/", cookie.path))
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => cookie.pair);
  return valid.length > 0 ? valid.join("; ") : null;
}

/** Cookies that will still be valid in `skewMs` (default 30 s, as the CLI). */
export function freshCookies(cookies: readonly IntegrationSessionCookie[], now = Date.now(), skewMs = 30_000): IntegrationSessionCookie[] {
  return cookies.filter((cookie) => isCookieUnexpired(cookie, now, skewMs));
}
