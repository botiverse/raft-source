/**
 * Where the canonical link's Go to Raft goes: the last server the reader was
 * in on this device, else their only one; null with neither (`/`, the
 * chooser, which is then a choice to make).
 */
export function artifactLinkLeaveServer(servers: readonly { slug: string }[], lastSlug: string | null): string | null {
  const last = lastSlug ? servers.find((server) => server.slug === lastSlug) : undefined;
  return last?.slug ?? (servers.length === 1 ? servers[0]!.slug : null);
}
