import { useMemo } from "react";
import { artifactLinkId, artifactPagePath as sharedArtifactPagePath, parseArtifactId, parseArtifactRef } from "@botiverse/raft-shared";
import type { ArtifactId } from "@botiverse/raft-shared";

import { readRaftAppHosts, useRaftAppHosts } from "../../store/raftAppHosts";
import { shareableWebOrigin } from "../../utils/desktopShell";
import type { ArtifactOpenSource } from "./artifactAnalytics";

/** An Artifact by id, at a pinned version (F10) or following the latest (null). */
export interface ArtifactLinkTarget {
  id: ArtifactId;
  version: number | null;
}

/**
 * The Artifact one link in a message names, or null. The links are the
 * message's visible bare links (shared `messageBareLinks`, read once per
 * message by core's useMessageLinkCards). Recognition is the shared
 * `parseArtifactRef` (every Artifact address, G2/G3); only links that name an
 * id count here. A legacy `raft-artifacts.com/p/<server>/<name>` link names
 * an Artifact by name, which only the server can resolve, and a legacy
 * per-version `/a/<token>` link names no Artifact at all.
 *
 * A card says what a link is, so `/artifacts/<id>` counts only on Raft's
 * own app hosts: `appHosts` (artifactAppHosts: the hosts the server knows
 * from its config, Tenny), each compared whole. `evil.com/artifacts/pt_x`
 * and `app.raft.build.evil.com/artifacts/pt_x` stay plain links. The fixed
 * hosts (ARTIFACT_LINK_FIXED_HOSTS and the content domain) are the shared
 * parser's.
 */
export function artifactLinkTarget(link: string, appHosts: readonly string[]): ArtifactLinkTarget | null {
  const parsed = parseArtifactRef(link, { appHosts });
  return parsed.kind === "id" ? { id: parsed.id, version: parsed.version ?? null } : null;
}

/** The host of the one outward Artifact address (G2). */
export const CANONICAL_APP_HOST = "app.raft.build";

/**
 * The app hosts an Artifact link may be on to get a card: Raft's app hosts
 * as this deployment's server knows them (`configured`: its appHosts(), the
 * canonical one (G2), APP_URL's, Raft's earlier hosts and
 * APP_PERMALINK_HOSTS, store/raftAppHosts.ts), and the page's own hostname
 * (a preview, self-hosted; the desktop shell's compiled frontend origin),
 * deduped. Until the server's list arrives: the canonical host and the
 * page's own. The server leaves the Artifact links on its list out of the
 * App link read (shared appLinkReadUrls), so once it is here both sides
 * count a message's links alike. Hostnames, no port: the shared parser
 * compares `URL.hostname`.
 */
export function artifactAppHosts(origin: string = shareableWebOrigin(), configured: readonly string[] | null = readRaftAppHosts()): string[] {
  const hosts = configured?.length ? [...configured] : [CANONICAL_APP_HOST];
  try {
    const own = new URL(origin).hostname;
    if (own && !hosts.includes(own)) hosts.push(own);
  } catch {
    // No usable origin (tests, odd embeds): the hosts above only.
  }
  return hosts;
}

/**
 * artifactAppHosts() for a component, the one list every split of a
 * message's links uses (the Artifacts it names, useArtifactLinkTargets; the
 * App link read, core's useAppLinkPreviews): the same array until the
 * server's list arrives, then a new one, so what was split on the fallback
 * is split again.
 */
export function useArtifactAppHosts(): readonly string[] {
  const configured = useRaftAppHosts();
  return useMemo(() => artifactAppHosts(shareableWebOrigin(), configured), [configured]);
}

/**
 * The outward address (G2) on this deployment's own origin, `/v/<n>` when
 * pinned: `https://app.raft.build/artifacts/<short id>` (shared
 * artifactLinkId: the uuid in 22 characters of Base58, never `pt_…`) on production, staging's or
 * a self-hosted origin elsewhere (the server's appUrl() and the agent API say
 * the same). The origin is shareableWebOrigin(), as artifactAppHosts uses, so
 * the desktop shell gives its compiled frontend origin; with no usable origin,
 * the canonical host.
 */
export function artifactUrl(id: ArtifactId, version: number | null = null, origin: string = shareableWebOrigin()): string {
  return `${artifactOrigin(origin)}${artifactPagePath(id, version)}`;
}

/** The Artifact's own page in this app: `/artifacts/<short id>`, `/v/<n>` for a pinned version (shared artifactPagePath). */
export function artifactPagePath(id: ArtifactId, version: number | null = null): string {
  return sharedArtifactPagePath(id, version);
}

function artifactOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // No usable origin (tests, odd embeds): the canonical host.
  }
  return `https://${CANONICAL_APP_HOST}`;
}


/**
 * The params that open one Artifact over a page: the Artifacts home's
 * (`/s/<slug>/artifacts?artifact=<id>`, `&version=<n>` pinned), and the same
 * on a channel's page (its side card) and in Activity's and Search's detail
 * slot (#proj-workspace:#240; core's components/layout/artifactOpenAddress.ts
 * reads and writes them for every surface): the address the viewer is
 * (#proj-workspace:#237). A row of the page pushes it, Back and
 * the viewer's close take it away, a version picked in the viewer replaces
 * `version`, and a reload, a copied address or a new tab opens the same
 * Artifact. The canonical link of a server not in the reader's list yet goes
 * here too, adding `&from=link` (ARTIFACT_OPEN_FROM_PARAM), so the opening
 * records `artifact_opened` source `link` rather than `search`; `from` is the
 * only one the page drops once it is read (ArtifactOpenAddress).
 */
export const ARTIFACT_OPEN_PARAM = "artifact";
export const ARTIFACT_OPEN_VERSION_PARAM = "version";
export const ARTIFACT_OPEN_FROM_PARAM = "from";

/** Where an address that opens an Artifact came from: the canonical link, a conversation's Files tab (`other`), or (no `from`) a search hit. */
export type ArtifactOpenFrom = "link" | "search" | "other";

/** The `from` values an address carries; a search hit carries none. */
const ARTIFACT_OPEN_FROM_VALUES: readonly Exclude<ArtifactOpenFrom, "search">[] = ["link", "other"];

/** An Artifact the Artifacts page opens by address, and where that address came from. */
export interface ArtifactOpenTarget extends ArtifactLinkTarget {
  from: ArtifactOpenFrom;
}

/**
 * The in-app address that opens an Artifact (at a pinned version, or the
 * latest) over the Artifacts home page, under the server's base
 * (`/s/<slug>`); `from`: `link` for the canonical link (a search hit says
 * nothing).
 */
export function artifactOpenPath(id: ArtifactId, version: number | null = null, from: ArtifactOpenFrom = "search"): `/artifacts?${string}` {
  const params = new URLSearchParams({ [ARTIFACT_OPEN_PARAM]: artifactLinkId(id) });
  if (version !== null) params.set(ARTIFACT_OPEN_VERSION_PARAM, String(version));
  if (from !== "search") params.set(ARTIFACT_OPEN_FROM_PARAM, from);
  return `/artifacts?${params.toString()}`;
}

/** The page's params without the open params (`artifact`, `version`, `from`), the others kept: the list's address, once the viewer closes. */
export function withoutArtifactOpenParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of [ARTIFACT_OPEN_PARAM, ARTIFACT_OPEN_VERSION_PARAM, ARTIFACT_OPEN_FROM_PARAM]) next.delete(name);
  return next;
}

/** The page's params opening `target` over its list (the short id, artifactLinkId; `version` when pinned), the others kept and any earlier opening's dropped. */
export function withArtifactOpenParams(params: URLSearchParams, target: ArtifactLinkTarget): URLSearchParams {
  const next = withoutArtifactOpenParams(params);
  next.set(ARTIFACT_OPEN_PARAM, artifactLinkId(target.id));
  if (target.version !== null) next.set(ARTIFACT_OPEN_VERSION_PARAM, String(target.version));
  return next;
}

/** The page's params with the open Artifact at `version` (null: the latest, no `version`), the others kept. */
export function withArtifactOpenVersion(params: URLSearchParams, version: number | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (version === null) next.delete(ARTIFACT_OPEN_VERSION_PARAM);
  else next.set(ARTIFACT_OPEN_VERSION_PARAM, String(version));
  return next;
}

/** The page's params without `from`, the others kept: the address once the opening has read where it came from. */
export function withoutArtifactOpenFrom(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(ARTIFACT_OPEN_FROM_PARAM);
  return next;
}

/** A version as an address writes it: a positive integer in decimal, else null. */
function versionOf(value: string | null | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

/**
 * The Artifact a page's `?artifact=` names, with `?version=` when it pins a
 * well-formed one (else the latest), or null (absent, or not a bare Artifact
 * id: `pt_…` or the short id artifactOpenPath writes, both read as `pt_…`). `from` is `link` for `&from=link` (the canonical link), `other` for
 * `&from=other` (a conversation's Files tab), else `search`.
 */
export function artifactOpenTarget(params: URLSearchParams): ArtifactOpenTarget | null {
  const value = params.get(ARTIFACT_OPEN_PARAM);
  if (!value) return null;
  const id = parseArtifactId(value);
  if (id === null) return null;
  const from = ARTIFACT_OPEN_FROM_VALUES.find((value) => value === params.get(ARTIFACT_OPEN_FROM_PARAM)) ?? "search";
  return { id, version: versionOf(params.get(ARTIFACT_OPEN_VERSION_PARAM)), from };
}

/** What the Artifacts home page shows over its list: an Artifact, and what opened it (`artifact_opened`'s source). */
export type ArtifactOpenShown = ArtifactLinkTarget & { source: ArtifactOpenSource };

/**
 * The Artifact open over the Artifacts home page, as its host keeps it: the
 * route keeps it in the address (MainLayout's useArtifactOpenAddress:
 * `?artifact=`, ARTIFACT_OPEN_PARAM), so the viewer is a history entry of
 * its own; a host with none (a test) in the page's own state.
 */
export interface ArtifactOpenAddress {
  /** What is open over the list, or null. Read from the address: Back and Forward open and close it too. */
  shown: ArtifactOpenShown | null;
  /** Open one from the page's list: a new history entry over the list's. */
  open: (target: ArtifactLinkTarget, source: ArtifactOpenSource) => void;
  /**
   * Close it as Back would (raft-design navigation, Going back): opened from
   * the page, history back to the list's entry; opened by an address (a cold
   * link, a reload in a new tab), the list's address in its place, so close
   * never leaves the app.
   */
  close: () => void;
  /** Another version of the one open (null: the latest), in the same entry. */
  showVersion: (version: number | null) => void;
}

/**
 * The Artifact the canonical link's route names (`/artifacts/:id`,
 * `/artifacts/:id/v/:version`; artifactUrl), or null when the id isn't a
 * bare Artifact id (the short id links carry, or an older link's `pt_…`,
 * both read as `pt_…`) or the version isn't a positive integer.
 */
export function artifactPermalinkTarget(id: string | undefined, version: string | undefined): ArtifactLinkTarget | null {
  if (!id) return null;
  const parsed = parseArtifactId(id);
  if (parsed === null) return null;
  if (version === undefined) return { id: parsed, version: null };
  const pinned = versionOf(version);
  return pinned === null ? null : { id: parsed, version: pinned };
}
