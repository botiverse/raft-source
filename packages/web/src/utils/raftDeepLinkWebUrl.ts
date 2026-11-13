import { desktopRouteFromDeepLink } from "@botiverse/raft-shared";
import { shareableWebOrigin } from "./desktopShell";

/**
 * The web address of a `raft://` link to a place on a server (`raft:///s/…`
 * or `raft://s/…`, as Raft Desktop copies them): the same route on
 * shareableWebOrigin(), the origin a copied message link uses. A message
 * shows it like that web link, so a message link becomes its reference chip
 * and opens in place. Any other `raft://` link (the app start, "/servers",
 * sign-in callbacks) is null and stays text. The mobile App does the same
 * (raftSchemeLinkToWebLink, mobile #4028).
 */
export function webUrlFromRaftDeepLink(uri: string, origin: string = shareableWebOrigin()): string | null {
  const route = desktopRouteFromDeepLink(uri);
  if (!route?.startsWith("/s/") || !origin) return null;
  return `${origin}${route}`;
}
