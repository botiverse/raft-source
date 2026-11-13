// What an agent may pass where an Artifact is expected (`raft artifact read
// <a>`): an id or a link, parsed here, or a title (or the old name of an
// Artifact from before titles), which this leaves to the Server (`invalid`
// `unrecognised` for a title that isn't a name). Parsing a link only says
// which Artifact it names; whether the caller may see it is the Server's
// answer, per request. The agent API itself takes an id, a title or an old
// name; clients parse links with this first (agentOps resolveArtifactRef).
//
// An id is written two ways: `pt_<uuid>` (the API's `id` fields, the
// database) and, in every link Raft builds, the uuid's 22-character Base58
// short id (artifactShortId.ts). Both read as the same ArtifactId, `pt_<uuid>`.
import { decodeArtifactShortId, encodeArtifactShortId } from "./artifactShortId";
import { asArtifactId, type ArtifactId } from "./workspaceArtifacts";

export type ParsedArtifactRef =
  | { kind: "id"; id: ArtifactId; version?: number }
  /**
   * A name in a server. `server` is the server slug a legacy
   * `raft-artifacts.com/p/<server>/<name>` link carried; a bare name has none
   * (the caller's server).
   */
  | { kind: "name"; name: string; server?: string; version?: number }
  /**
   * `unrecognised`: not an id, a name or an Artifact link.
   * `legacy_version_link`: an old per-version link (`raft-artifacts.com/a/<token>`),
   * which names a version by a token, not the Artifact.
   */
  | { kind: "invalid"; reason: "unrecognised" | "legacy_version_link" };

const ID = /^pt_[A-Za-z0-9-]{1,64}$/;
/** What every Artifact's id is (publish, save and import make them): the form a short id stands for. */
const UUID_ID = /^pt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Raft Artifacts' names: lowercase letters, digits and inner hyphens, up to 63. */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION = /^[1-9]\d{0,8}$/;
/** The standalone Raft Artifacts app's hosts (wrangler routes). */
export const ARTIFACT_LEGACY_HOSTS: readonly string[] = ["raft-artifacts.com", "www.raft-artifacts.com", "artifact-share.botiverse.dev"];
const LEGACY_HOSTS: ReadonlySet<string> = new Set(ARTIFACT_LEGACY_HOSTS);
/** The standalone app's canonical host: an imported Artifact's note names its old link on it. */
const LEGACY_CANONICAL_HOST = "raft-artifacts.com";
/** The content origin: `a-pt-<uuid>.raftusercontent.com` serves Artifact `pt_<uuid>`. */
const CONTENT_HOST = /^a-pt-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.raftusercontent\.com$/;

/**
 * Hosts whose Artifact links mean the same everywhere: the redirect host and
 * the standalone app's. The content origin (`a-pt-<uuid>.raftusercontent.com`)
 * is recognised by pattern. A deployment's own app host (production, staging,
 * a preview, self-hosted) comes from its configuration as `appHosts`.
 */
export const ARTIFACT_LINK_FIXED_HOSTS: readonly string[] = ["artifacts.raft.build", ...LEGACY_HOSTS];

export interface ParseArtifactRefOptions {
  /**
   * The Raft app's hostnames for this deployment: `URL.hostname` values, no
   * port, IDNs in punycode (`app.raft.build`, not `new URL(appUrl).host`,
   * which may carry a port and then matches nothing). Given (turning a link in a
   * message into a card), `/artifacts/<id>` counts only on these hosts, so
   * `evil.example/artifacts/pt_x` stays a plain link instead of wearing a
   * real Artifact's card (Tenny, #proj-workspace:ee8634e1 f58546ee). Omitted
   * (an agent passing a link to `raft artifact`), any host: the id is still
   * checked against what the caller may see.
   */
  appHosts?: readonly string[];
}

/**
 * A bare Artifact id, exactly as written (no trimming, no link): `pt_…`, or a
 * short id (22 characters of Base58 that fit 16 bytes), which reads as
 * `pt_<its uuid>`. Null for anything else. A short id that is also a name
 * (isArtifactName: a digit, then digits and lowercase) is an id first: the
 * server looks it up as a name only when no Artifact has that id at all
 * (resolveVisibleItem). New names that read as one are reserved
 * (isReservedArtifactName).
 */
export function parseArtifactId(value: string): ArtifactId | null {
  if (ID.test(value)) return asArtifactId(value);
  const uuid = decodeArtifactShortId(value);
  return uuid === null ? null : asArtifactId(`pt_${uuid}`);
}

/**
 * How a link writes an Artifact's id: the short id of `pt_<uuid>`; any other
 * id (a fixture's, `pt_fake-…`) as it is, which parseArtifactId reads back.
 */
export function artifactLinkId(id: ArtifactId): string {
  const uuid = UUID_ID.exec(id)?.[1];
  return uuid === undefined ? id : encodeArtifactShortId(uuid);
}

/**
 * An Artifact's page in the Raft app, the path of its canonical link (G2):
 * `/artifacts/<short id>`, `/v/<n>` when pinned. Every link Raft builds
 * (the web's, the server's `url` fields, its messages) starts from this.
 */
export function artifactPagePath(id: ArtifactId, version: number | null = null): string {
  return `/artifacts/${artifactLinkId(id)}${version === null ? "" : `/v/${version}`}`;
}

/** Whether `value` has the form of an Artifact name: lowercase letters, digits and inner hyphens, up to 63. */
export function isArtifactName(value: string): boolean {
  return NAME.test(value);
}

const invalid = (reason: "unrecognised" | "legacy_version_link"): ParsedArtifactRef => ({ kind: "invalid", reason });

/** An id, then an optional `/v/<n>`; anything after that (a file path, `/raw`) is ignored. */
function idWithVersion(segments: readonly string[]): ParsedArtifactRef {
  const [segment, v, n] = segments;
  const id = segment === undefined ? null : parseArtifactId(segment);
  if (id === null) return invalid("unrecognised");
  if (v === "v" && n !== undefined) {
    return VERSION.test(n) ? { kind: "id", id, version: Number(n) } : invalid("unrecognised");
  }
  return { kind: "id", id };
}

/** The standalone app's paths: /p/<server>/<name>[/v/<n>][/raw] (the url_key is `<server>/<name>`), and /a/<token>. */
function legacyPath(segments: readonly string[]): ParsedArtifactRef {
  if (segments[0] === "a") return invalid("legacy_version_link");
  const [p, server, name, v, n] = segments;
  if (p !== "p" || !server || !name || !NAME.test(name)) return invalid("unrecognised");
  if (v === "v" && n !== undefined) {
    return VERSION.test(n) ? { kind: "name", name, server, version: Number(n) } : invalid("unrecognised");
  }
  return { kind: "name", name, server };
}

function pathSegments(url: URL): string[] | null {
  try {
    return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

function parseLink(url: URL, options: ParseArtifactRefOptions): ParsedArtifactRef {
  const segments = pathSegments(url);
  if (!segments) return invalid("unrecognised");
  const host = url.hostname.toLowerCase();
  const content = CONTENT_HOST.exec(host);
  if (content) return { kind: "id", id: asArtifactId(`pt_${content[1]}`) };
  if (host === "artifacts.raft.build") return idWithVersion(segments);
  if (LEGACY_HOSTS.has(host)) return legacyPath(segments);
  // The Raft app: /artifacts/<id>[/v/<n>], and /s/<server>/artifacts/<id>[/v/<n>]
  // (accepted; the canonical link has no server). On any host unless
  // `appHosts` names this deployment's.
  if (options.appHosts && !options.appHosts.some((appHost) => appHost.toLowerCase() === host)) return invalid("unrecognised");
  if (segments[0] === "artifacts") return idWithVersion(segments.slice(1));
  if (segments[0] === "s" && segments[2] === "artifacts") return idWithVersion(segments.slice(3));
  return invalid("unrecognised");
}

/**
 * Parse an Artifact reference: `pt_…` or a short id, a bare name, or a link
 * (`https://app.raft.build/artifacts/<id>[/v/<n>]`,
 * `…/s/<server>/artifacts/<id>`, `https://artifacts.raft.build/<id>`, the
 * content origin `a-pt-<uuid>.raftusercontent.com`, and the standalone app's
 * `raft-artifacts.com/p/<server>/<name>[/v/<n>]`).
 */
export function parseArtifactRef(input: string, options: ParseArtifactRefOptions = {}): ParsedArtifactRef {
  const value = input.trim();
  const id = parseArtifactId(value);
  if (id !== null) return { kind: "id", id };
  if (NAME.test(value)) return { kind: "name", name: value };
  if (!/^https?:\/\//i.test(value)) return invalid("unrecognised");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("unrecognised");
  }
  return parseLink(url, options);
}

/** A link to an Artifact of the standalone app, as an import names it. */
export type ParsedLegacyArtifactLink =
  | {
    kind: "legacy";
    /** The server slug the link carries (the Raft server's slug). */
    server: string;
    name: string;
    /** The link in its canonical form, `https://raft-artifacts.com/p/<server>/<name>`. */
    link: string;
  }
  /**
   * `not_a_link`: not an http(s) URL. `host`: a URL on a host that is not the
   * standalone app's. `legacy_version_link`: an old per-version link
   * (`/a/<token>`), which names no Artifact. `unrecognised`: the app's host,
   * but not an Artifact's path.
   */
  | { kind: "invalid"; reason: "not_a_link" | "host" | "legacy_version_link" | "unrecognised" };

/**
 * A link to an Artifact of the standalone Raft Artifacts app, for importing
 * it: `https://raft-artifacts.com/p/<server>/<name>[/v/<n>][/raw]` on one of
 * ARTIFACT_LEGACY_HOSTS or `extraHosts` (a deployment's configured legacy
 * hosts; `URL.hostname` values). Only the server slug and the name come out
 * of it: an importer never requests the link itself. A pinned version is
 * ignored (an import takes the Artifact, not a version).
 */
export function parseLegacyArtifactLink(input: string, options: { extraHosts?: readonly string[] } = {}): ParsedLegacyArtifactLink {
  const value = input.trim();
  if (!/^https?:\/\//i.test(value)) return { kind: "invalid", reason: "not_a_link" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid", reason: "not_a_link" };
  }
  const host = url.hostname.toLowerCase();
  const allowed = LEGACY_HOSTS.has(host) || (options.extraHosts ?? []).some((extra) => extra.trim().toLowerCase() === host);
  if (!allowed) return { kind: "invalid", reason: "host" };
  const segments = pathSegments(url);
  const parsed = segments ? legacyPath(segments) : invalid("unrecognised");
  if (parsed.kind !== "name" || parsed.server === undefined) {
    return { kind: "invalid", reason: parsed.kind === "invalid" && parsed.reason === "legacy_version_link" ? "legacy_version_link" : "unrecognised" };
  }
  return {
    kind: "legacy",
    server: parsed.server,
    name: parsed.name,
    link: `https://${LEGACY_CANONICAL_HOST}/p/${encodeURIComponent(parsed.server)}/${parsed.name}`,
  };
}
