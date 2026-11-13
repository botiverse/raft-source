import { getProductEventServerId } from "../../analytics/track";
import { accessTokenSubject } from "../../utils/hostAccessTokenSync";

/** No server's: a public Artifact read as an outsider (never a server's id, which is a uuid). */
const OUTSIDER = "outsider";

/**
 * Who is reading, where: the current server and the signed-in person (the
 * access token's subject). What the page keeps for a reader's next opening
 * (a frame ticket, a card's header, a read started on a press) is used only
 * by the same reader in the same server: a sign-out, another person signing
 * in on this page, or a server switch leaves it unused. Null with no server
 * (signed out): nothing kept is used.
 */
export function artifactReaderScope(): string | null {
  const server = getProductEventServerId();
  return server === undefined ? null : artifactReaderScopeIn(server);
}

/**
 * The same, for an answer that names its server itself instead of the
 * current one (the canonical link's `open`, asked with no server): `serverId`
 * the server it opens in, or null for a public Artifact read as an outsider
 * (no server of the reader's stands behind it). Null without a person.
 */
export function artifactReaderScopeIn(serverId: string | null): string | null {
  const person = accessTokenSubject(localStorage.getItem("slock_access_token"));
  // Not knowing who reads (no readable token here, e.g. a cookie session) is never one shared scope (Tenny).
  return person === null ? null : `${serverId ?? OUTSIDER}|${person}`;
}
