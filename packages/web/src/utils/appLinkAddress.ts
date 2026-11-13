/**
 * Where an App link really goes, as Raft shows it next to the App's own words
 * (protocol v3.2.3 addendum 5 §2a): on the chip on devices that can't hover,
 * and in the hover card.
 *
 * The domain is the link's full hostname with only a leading `www.` removed.
 * It is never cut to the registrable domain: a subdomain may belong to someone
 * else. The WHATWG URL parser already gives a non-ASCII hostname in its
 * `xn--` (punycode) form, so a look-alike name can't pass for another.
 *
 * Only `http:` and `https:` links have a domain here; anything else (or a
 * string that is not a URL) is null, and Raft opens nothing for it.
 */
export function appLinkDomain(url: string): string | null {
  const parsed = openableUrl(url);
  if (!parsed?.hostname) return null;
  return parsed.hostname.replace(/^www\./, "");
}

/**
 * The address shortened to its domain and path, for a chip that has no title
 * (an App that isn't allowed yet, or one that asks the viewer to connect an
 * account): `stamp.build/botiverse/slock/pull/10449`. The query and fragment
 * are left out; the label truncates what is still too long.
 */
export function appLinkShortAddress(url: string): string | null {
  const parsed = openableUrl(url);
  const domain = appLinkDomain(url);
  if (!parsed || !domain) return null;
  return parsed.pathname === "/" ? domain : `${domain}${parsed.pathname}`;
}

/** The URL itself when Raft may open it (http or https), else null. */
export function appLinkOpenHref(url: string): string | null {
  return openableUrl(url)?.href ?? null;
}

function openableUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}
