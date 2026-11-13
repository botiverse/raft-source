/** The server slug a URL opens (`/s/<slug>/…`, decoded), or null off a server page or when it does not decode. */
export function serverSlugOfPath(pathname: string): string | null {
  const slug = /^\/s\/([^/?#]+)/.exec(pathname)?.[1];
  if (!slug) return null;
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
}
