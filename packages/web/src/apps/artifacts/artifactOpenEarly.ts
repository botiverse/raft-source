import type { ArtifactId, ArtifactViewerData, ArtifactWebOpen } from "@botiverse/raft-shared";

import { sharedModule } from "../../boot/appChunkLoading";
import { accessTokenSubject } from "../../utils/hostAccessTokenSync";
import { artifactPagePath, artifactPermalinkTarget } from "./artifactLinks";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { prefetchArtifactContentDns } from "./artifactOpenIntent";
import { artifactReaderScopeIn } from "./artifactReaderScope";
import { artifactSource, viewerKey } from "./artifactSource";
import { preloadArtifactFrameCode } from "./artifactViewerChunk";
import { withoutViewerFrame } from "./artifactViewerFrame";

/**
 * The canonical link's page (`/artifacts/<id>`, ArtifactPermalink) started
 * at boot, before `/auth/me` answers: the page's chunk, the content
 * connection, and its one call, `open` (where it opens and its viewer data),
 * sent with the stored token and no server (core's boot starts it:
 * boot/openArtifactFromDevice). Nothing of the device's server list is
 * needed, so a cold profile sends it too.
 *
 * The page takes that answer once: for the same Artifact and version, by the
 * person it was asked for (the token's subject), and once it has come it is
 * forgotten, so Retry, a remount or another visit asks again. An early 401
 * (the stored session wasn't good) is never taken: the page, which runs once
 * someone is signed in, asks again.
 */

/** The Artifact a canonical link's address names (`/artifacts/<id>`, `/v/<n>`), or null. */
export function artifactPermalinkTargetOf(pathname: string): ArtifactLinkTarget | null {
  const match = pathname.match(/^\/artifacts\/([^/]+)(?:\/v\/([^/]+))?\/?$/);
  if (!match) return null;
  try {
    return artifactPermalinkTarget(decodeURIComponent(match[1]!), match[2] === undefined ? undefined : decodeURIComponent(match[2]));
  } catch {
    return null;
  }
}

/**
 * An older canonical link's address (`/artifacts/pt_<uuid>`, `/v/<n>`) as
 * links are written now, `/artifacts/<short id>` (artifactPagePath), or null
 * when the address is already that or isn't an Artifact's. Boot (main.tsx)
 * and the signed-in route (ArtifactPermalinkRoute) put it in the address bar
 * in place (history.replaceState), the query and hash kept; the page opens
 * the same Artifact either way. The edge Worker answers such a request with
 * a 301 first (public/_worker.js), so this covers the hosts without it (the
 * desktop shell, self-hosted, a link followed inside the app).
 */
export function artifactShortAddressOf(pathname: string): string | null {
  const target = artifactPermalinkTargetOf(pathname);
  if (!target) return null;
  const short = artifactPagePath(target.id, target.version);
  return short === pathname.replace(/\/$/, "") ? null : short;
}

/** The canonical link's page, as the app shell's lazy route loads it (the same chunk). */
export const loadArtifactPermalink = sharedModule(() => import("./ArtifactPermalink"));

/** `open`'s answer as the page holds it: its viewer's frame ticket already taken out (artifactViewerFrame). */
export interface ArtifactOpened {
  opensIn: ArtifactWebOpen["opensIn"];
  viewer: ArtifactViewerData;
}

const personNow = () => accessTokenSubject(localStorage.getItem("slock_access_token"));

/**
 * One `open`. Its viewer's frame ticket is taken out as it arrives, as a
 * viewer read's is (withoutViewerFrame), held for the reader it was answered
 * for in the server it names (or none: an outsider's), never in the data the
 * page keeps.
 */
function readOpen(target: ArtifactLinkTarget): Promise<ArtifactOpened> {
  return artifactSource().open(target).then(({ opensIn, viewer }) => ({
    opensIn,
    viewer: withoutViewerFrame(viewer, artifactReaderScopeIn(opensIn?.serverId ?? null)),
  }));
}

let early: { key: string; person: string | null; answer: Promise<ArtifactOpened> } | null = null;

/** Boot, on a canonical link's address: its page's chunk and its content connection, before anything else is known. */
export function prepareArtifactPermalink(id: ArtifactId): void {
  void loadArtifactPermalink().catch(() => {});
  prefetchArtifactContentDns(id);
}

/** Boot: `open` for `target`, ahead of the page (with a stored, unexpired token; boot/openArtifactFromDevice). */
export function openArtifactEarly(target: ArtifactLinkTarget): void {
  const key = viewerKey(target);
  const person = personNow();
  // Already on its way for this person (started again after a refresh, say): one is enough.
  if (early && early.key === key && early.person === person) return;
  preloadArtifactFrameCode();
  const answer = readOpen(target);
  answer.catch(() => {});
  early = { key, person, answer };
}

const isUnauthorized = (error: unknown) => (error as { status?: unknown } | null)?.status === 401;

/** The page's `open`: the early one when it was asked for this Artifact and version by this same person, else a new one. */
export function openArtifact(target: ArtifactLinkTarget): Promise<ArtifactOpened> {
  const known = early;
  if (!known || known.key !== viewerKey(target) || known.person === null || known.person !== personNow()) return readOpen(target);
  const forget = () => {
    if (early === known) early = null;
  };
  known.answer.then(forget, forget);
  return known.answer.catch((error: unknown) => {
    if (isUnauthorized(error)) return readOpen(target);
    throw error;
  });
}

/** Tests only. */
export function resetArtifactOpenEarlyForTests(): void {
  early = null;
}
