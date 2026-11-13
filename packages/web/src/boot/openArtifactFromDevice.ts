/**
 * A canonical Artifact link (`/artifacts/<id>`, `/v/<n>`) starts its page at
 * boot instead of after `/auth/me` and `/servers`: the page's chunk and the
 * content connection at once (prepareArtifactPermalink), and, with a stored
 * token that hasn't expired, its one call, `open` (where it opens and its
 * viewer data), in the same round trip as `/auth/me` (docs/development/
 * workspace-artifacts.md, "Opening an Artifact quickly"). It needs nothing
 * the device keeps but the token: no server list, so a cold profile sends it
 * too. The page takes that answer once (apps/artifacts artifactOpenEarly).
 *
 * `openArtifactFromDevice` may be called again once an expired token has
 * been refreshed at boot: it only sends `open` (for a token now good), and
 * never twice for the same person and address.
 */
import { artifactPermalinkTargetOf, artifactShortAddressOf, openArtifactEarly, prepareArtifactPermalink } from "../apps/artifacts";
import { isAccessTokenExpired } from "../utils/hostAccessTokenSync";

/**
 * Boot, before anything reads the address: an older canonical link
 * (`/artifacts/pt_<uuid>`) shows as links are written now, the short id
 * (artifactShortAddressOf), in place: no new history entry, the query and
 * hash kept. Whether it was rewritten.
 */
export function shortenArtifactAddress(location: Pick<Location, "pathname" | "search" | "hash">, history: Pick<History, "replaceState" | "state">): boolean {
  const short = artifactShortAddressOf(location.pathname);
  if (!short) return false;
  history.replaceState(history.state, "", `${short}${location.search}${location.hash}`);
  return true;
}

/** Boot, once: the link's page's chunk and content connection, then `open` when the stored token allows. Whether `open` went out. */
export function startArtifactPermalink(location: Pick<Location, "pathname">): boolean {
  const target = artifactPermalinkTargetOf(location.pathname);
  if (!target) return false;
  prepareArtifactPermalink(target.id);
  return openArtifactFromDevice(location);
}

/** `open` for the link's Artifact with the stored token, when there is one that hasn't expired. Whether it went out. */
export function openArtifactFromDevice(location: Pick<Location, "pathname">): boolean {
  const target = artifactPermalinkTargetOf(location.pathname);
  if (!target) return false;
  let token: string | null = null;
  try {
    token = localStorage.getItem("slock_access_token");
  } catch {
    return false;
  }
  // An expired token would send the request into the refresh first; asked again once it is refreshed, or by the page.
  if (!token || isAccessTokenExpired(token, Date.now())) return false;
  openArtifactEarly(target);
  return true;
}
