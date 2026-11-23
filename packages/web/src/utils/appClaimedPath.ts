import { isDesktopDeepLinkPathname } from "@botiverse/raft-shared";

/**
 * Deep links v1: which Raft addresses an installed app opens, per platform.
 * The one rule the open-in-app offers ask before they show: an address no app
 * takes would be handed to nothing and, on a phone, come back as "not
 * installed".
 *
 * - `desktop`: the routes Raft Desktop accepts behind raft:// (the shared
 *   DESKTOP_DEEP_LINK_ROUTE_PREFIXES: `/s/…`, `/servers`).
 * - `android`: every `/s/…` path; the Android app claims them all on
 *   app.raft.build and open.raft.build.
 * - `ios`: only what the served apple-app-site-association claims
 *   (public/_worker.js): a channel or DM permalink, `/s/<slug>/channel|dm/<id>`
 *   with nothing before or after; an open Artifact on the Artifacts page,
 *   `/s/<slug>/artifacts?artifact=<id>`; an Artifact's share link,
 *   `/artifacts/<id>` and `/artifacts/<id>/v/<n>`; an external invite,
 *   `/external-invite/…`; a server join link, `/join/<token>`. tests/wellKnownAssociation.test.ts holds this rule
 *   to the file the Worker serves, so the two cannot drift. (That file's other
 *   entries, `/download` and the sign-up verification link, are entry points
 *   of their own, not pages an offer appears on.)
 *
 * `search` matters only where a claim depends on the query (the open Artifact).
 * The offers themselves show in the workspace and on its sign-in page (`/s/…`);
 * an address claimed here that has no offer mounted on it simply shows none.
 */
export type AppPlatform = "desktop" | "android" | "ios";

const IOS_CONVERSATION = /^\/s\/[^/]+\/(?:channel|dm)\/[^/]+$/;
const IOS_ARTIFACTS_PAGE = /^\/s\/[^/]+\/artifacts$/;
const ARTIFACT_LINK = /^\/artifacts\/[^/]+(?:\/v\/[^/]+)?$/;
const EXTERNAL_INVITE = /^\/external-invite\/.+$/;
const SERVER_JOIN = /^\/join\/[^/]+$/;

function normalizePathname(pathname: string): string {
  // iOS matches the path with a trailing slash added, so `/x` and `/x/` are the same address to it.
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isIosClaimedPath(pathname: string, search: string): boolean {
  const normalized = normalizePathname(pathname);
  if (IOS_CONVERSATION.test(normalized) || ARTIFACT_LINK.test(normalized) || EXTERNAL_INVITE.test(normalized) || SERVER_JOIN.test(normalized)) return true;
  // The Artifacts page only with an Artifact open on it.
  return IOS_ARTIFACTS_PAGE.test(normalized) && (new URLSearchParams(search).get("artifact") ?? "") !== "";
}

function isAndroidClaimedPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  // Android's manifest claims every `/s/…` path plus Artifact share links, external invites and server join links.
  return normalized.startsWith("/s/") || ARTIFACT_LINK.test(normalized) || EXTERNAL_INVITE.test(normalized) || SERVER_JOIN.test(normalized);
}

export function isAppClaimedPath(pathname: string, platform: AppPlatform, search = ""): boolean {
  if (platform === "desktop") return isDesktopDeepLinkPathname(pathname);
  if (platform === "android") return isAndroidClaimedPath(pathname);
  return isIosClaimedPath(pathname, search);
}
