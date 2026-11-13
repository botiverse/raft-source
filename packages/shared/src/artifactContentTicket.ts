// The content ticket (S2, docs/development/workspace-artifacts-content-origin.md,
// "Tickets"): what Raft's server signs when it answers a frame (the frame
// route, the viewer's `frame`, the signed-out frame) and the content Worker
// (packages/content-worker) verifies at `<origin>/_raft/open` before it opens
// the frame's Porthole session. The server signs it itself, so a frame costs
// no call to the Worker; the Worker still asks Raft's authorize on every load.
//
// `rct1.<kid>.<claims>.<mac>`: `claims` is base64url JSON of exactly
// ArtifactContentTicketClaims, `mac` base64url HMAC-SHA-256 over
// `rct1.<kid>.<claims>` with the key `kid` names. Keys come from a shared
// secret of at least 32 bytes (Raft's ARTIFACTS_CONTENT_WORKER_TOKEN, one of
// the Worker's RAFT_TOKENS): the MAC key and the kid are each derived from it
// with HMAC under their own label, never the secret itself. The Worker keeps
// every listed secret's key, so a rotation (add the new secret to the
// Worker's list, switch the server, remove the old one) never breaks a ticket
// already issued. WebCrypto only: the same code runs on Node and Workers.
//
// A publish check's ticket (viewer ARTIFACT_CONTENT_CHECK_VIEWER, signed only
// by the server's check task) is a ticket like any other: the check's headless
// browser opens it top-level, so it names no frame ancestor. No ticket names
// one (task #proj-workspace:#130, Tenny's design change): signing throws for
// claims with any field but ArtifactContentTicketClaims' (an `ancestor`
// included, a check ticket's first of all), and verifying refuses such claims
// (`malformed`), so the Worker refuses a check ticket with an ancestor before
// it touches anything.
//
// A door ticket (Porthole P125, P126) is the one exception to "exactly the
// claims": it also says `door: true`, and only ever `true`. It opens the
// frame's door (ARTIFACT_CONTENT_DOOR_PATH), a page of Porthole's the host
// frames first, and nothing else; every other ticket opens only
// `/_raft/open`. The server signs one beside each reader's and visitor's
// ticket, with its own nonce and the same claims; a check ticket has none
// (signing throws, verifying is `malformed`, as for any other claim a ticket
// can't carry). A verifier older than the door reads its claims as
// `malformed`, so it never opens content.
//
// A page ticket (#proj-workspace:#272) is the other one: it also says `page`,
// the page of the version's files the frame opens at instead of the entry
// (`artifactContentTicketPage` of that file's path; Porthole's `issue(…, {
// page })`, P125). A reader's or a visitor's only, and its door ticket says the
// same `page` (the door answers for the page the frame opens at). A check
// ticket never has one: a check opens the entry. A verifier older than this
// reads a page ticket as `malformed` and opens nothing, so the content Worker
// that knows `page` is deployed before any server signs one.

/** How long a ticket may be opened after it is signed: Porthole's own ticket lifetime. */
export const ARTIFACT_CONTENT_TICKET_SECONDS = 60;
/** A ticket whose expiry is further away than this is refused, whoever signed it (clock skew included). */
export const ARTIFACT_CONTENT_TICKET_MAX_SECONDS = 300;
/** Where a ticket is opened on its Artifact's content origin: `<origin>/_raft/open?ticket=<ticket>`. */
export const ARTIFACT_CONTENT_OPEN_PATH = "/_raft/open";
/**
 * Where an embedded public Artifact opens on its own content origin (Porthole P143):
 * `<origin>/_raft/embed`, no ticket and no query. The content Worker serves it only below its
 * embed host's outer page, as an embed session of that origin's own Artifact's current version.
 */
export const ARTIFACT_CONTENT_EMBED_PATH = "/_raft/embed";
/**
 * Where a door ticket is opened on its Artifact's content origin:
 * `<origin>/__porthole/door/_raft?ticket=<door ticket>`. Under Porthole's
 * `DOOR_PATH` (`/__porthole/door/`), where the host takes a door from (P125),
 * and never one of Porthole's own door keys (16 base32 letters), so the
 * content Worker answers it, not Porthole's door route (P126).
 */
export const ARTIFACT_CONTENT_DOOR_PATH = "/__porthole/door/_raft";
/** A shared secret is at least this many bytes. */
export const ARTIFACT_CONTENT_SECRET_MIN_BYTES = 32;

const VERSION = "rct1";
const KEY_LABEL = "raft/artifact-content-ticket/key/v1";
const KID_LABEL = "raft/artifact-content-ticket/kid/v1";
/** The longest ticket a verifier reads (a few hundred characters in practice). */
const MAX_TICKET_LENGTH = 4_096;
const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The viewer of a publish check's ticket: Raft's server opening one version
 * top-level in a headless browser, never a person (no user, no session, no
 * runtime capability). Its ticket names no ancestor, as no ticket does.
 */
export const ARTIFACT_CONTENT_CHECK_VIEWER = "system:check";

/** What a ticket says, all of it signed. */
export interface ArtifactContentTicketClaims {
  /** The Artifact, `pt_<uuid>`. */
  artifact: string;
  /** The version opened, `v_<uuid>`. */
  version: string;
  /**
   * Who reads: `user:<uuid>`, `anonymous` for a signed-out visitor of a
   * public Artifact, or ARTIFACT_CONTENT_CHECK_VIEWER for a publish check.
   */
  viewer: string;
  /** What the Worker hands back to Raft's authorize on every load (`v1:…`). */
  subject: string;
  /** The content origin it opens on, `<scheme>://w-<uuid>.<content domain>`: that Artifact's own. */
  origin: string;
  /** Epoch seconds: refused from then on. */
  expires: number;
  /** 128 random bits, base64url: the Worker opens a ticket once, by this. */
  nonce: string;
  /**
   * A door ticket only, and always `true` there: it opens the frame's door
   * (ARTIFACT_CONTENT_DOOR_PATH) and nothing else. Absent (never `false`) on
   * every other ticket, which never opens a door. Never on a check ticket.
   */
  door?: true;
  /**
   * The page the frame opens at, when it isn't the version's entry: a file of
   * the version as a URL path below its base (`artifactContentTicketPage`,
   * `isArtifactContentTicketPage`). Absent on a ticket that opens the entry.
   * On a frame's door ticket too, the same. Never on a check ticket.
   */
  page?: string;
}

/** Every ticket's keys, sorted: exactly these, on every ticket (a check's too). */
const CLAIM_KEYS = ["artifact", "expires", "nonce", "origin", "subject", "version", "viewer"] as const satisfies readonly (keyof ArtifactContentTicketClaims)[];
/** What a reader's or a visitor's ticket may say besides: a door's `door`, a page's `page`. */
const OPTIONAL_CLAIM_KEYS = ["door", "page"] as const satisfies readonly (keyof ArtifactContentTicketClaims)[];
const ALL_CLAIM_KEYS: readonly string[] = [...CLAIM_KEYS, ...OPTIONAL_CLAIM_KEYS];

/** The longest `page` a ticket carries: what Porthole takes as a path (its `MAX_PATH`). */
const MAX_PAGE_LENGTH = 2_048;

/**
 * Whether `page` is what a ticket's `page` may be: a relative URL path below a
 * version's base, of URL path characters, no empty segment, no dot segment
 * (escaped or not), no query or fragment. No looser than what Porthole's
 * `issue` takes as a page (its `isPageRest`), so the content Worker never
 * hands Porthole a page it throws for; stricter in one thing, a trailing `/`
 * (a directory), which no file's path has.
 */
export function isArtifactContentTicketPage(page: unknown): page is string {
  return typeof page === "string"
    && page.length > 0
    && page.length <= MAX_PAGE_LENGTH
    && /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(page)
    && page.split("/").every((segment) => segment !== "" && !/^(?:\.|%2e){1,2}$/i.test(segment));
}

/**
 * A file's path in a version (`docs/about us.html`) as a ticket's `page`: each
 * segment percent-encoded, as its address below the version's base is. Null
 * for a path that makes no page a ticket may carry (an empty or dot segment,
 * too long).
 */
export function artifactContentTicketPage(path: string): string | null {
  let page: string;
  try {
    page = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  } catch {
    // A lone surrogate: no address names it.
    return null;
  }
  return isArtifactContentTicketPage(page) ? page : null;
}

/**
 * Why `claims` can't be signed (the rules in the file's header), or null: a
 * field beyond ArtifactContentTicketClaims' (an `ancestor` above all: a
 * check opens top-level, so its ticket names none), a `door` other than
 * `true` or on a check ticket, or a `page` that isn't one or on a check ticket.
 */
function claimsProblem(claims: object): string | null {
  if (Object.hasOwn(claims, "ancestor")) return "no ticket names an ancestor (a publish check opens top-level)";
  const said = claims as { door?: unknown; page?: unknown; viewer?: unknown };
  if (Object.hasOwn(claims, "door") && (said.door !== true || said.viewer === ARTIFACT_CONTENT_CHECK_VIEWER)) {
    return "a door ticket is a reader's or a visitor's, door: true";
  }
  if (Object.hasOwn(claims, "page") && (!isArtifactContentTicketPage(said.page) || said.viewer === ARTIFACT_CONTENT_CHECK_VIEWER)) {
    return "a page ticket is a reader's or a visitor's, page: a path below the version's base";
  }
  const extra = Object.keys(claims).filter((name) => !ALL_CLAIM_KEYS.includes(name));
  return extra.length === 0 ? null : "a ticket names exactly its claims";
}

/** The keys a ticket with these optional claims has, sorted (as it is signed and as it is read). */
const claimKeysOf = (claims: object): readonly (keyof ArtifactContentTicketClaims)[] =>
  [...CLAIM_KEYS, ...OPTIONAL_CLAIM_KEYS.filter((name) => Object.hasOwn(claims, name))].sort();

/** A secret's signing key and the id a ticket names it by. */
export interface ArtifactContentTicketKey {
  readonly kid: string;
  readonly key: CryptoKey;
}

export type ArtifactContentTicketRefusal =
  | "malformed"
  | "unknown-kid"
  | "bad-signature"
  | "expired"
  | "too-long"
  | "wrong-origin"
  | "wrong-artifact";

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return null;
  }
}

async function hmac(secret: Uint8Array<ArrayBuffer>, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(label)));
}

/**
 * The signing key for a shared secret (trimmed; at least
 * ARTIFACT_CONTENT_SECRET_MIN_BYTES, else it throws) and its kid: 12
 * base64url characters derived from the secret, which tell nothing of it.
 */
export async function artifactContentTicketKey(secret: string): Promise<ArtifactContentTicketKey> {
  const bytes = utf8(secret.trim());
  if (bytes.byteLength < ARTIFACT_CONTENT_SECRET_MIN_BYTES) throw new TypeError(`a content ticket secret is at least ${ARTIFACT_CONTENT_SECRET_MIN_BYTES} bytes`);
  const raw = await hmac(bytes, KEY_LABEL);
  const kid = base64url((await hmac(bytes, KID_LABEL)).subarray(0, 9));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return { kid, key };
}

/** A fresh nonce: 128 random bits, base64url. */
export function artifactContentTicketNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The ticket for `claims`, signed with `key` and naming its kid. Throws for
 * claims with any other field, an `ancestor` included (a check ticket's too),
 * for a `door` other than `true` or on a check ticket, and for a `page` that
 * isn't one (`isArtifactContentTicketPage`) or on a check ticket.
 */
export async function signArtifactContentTicket(key: ArtifactContentTicketKey, claims: ArtifactContentTicketClaims): Promise<string> {
  const problem = claimsProblem(claims);
  if (problem !== null) throw new TypeError(problem);
  const body = Object.fromEntries(claimKeysOf(claims).map((name) => [name, claims[name]]));
  const signed = `${VERSION}.${key.kid}.${base64url(utf8(JSON.stringify(body)))}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key.key, utf8(signed)));
  return `${signed}.${base64url(mac)}`;
}

/**
 * Claims with exactly the expected fields (never an ancestor, a check's
 * included), plus optionally `door: true` (exactly `true`) and `page` (a
 * page, `isArtifactContentTicketPage`), neither ever on a check ticket, each
 * of its type, or null.
 */
function claimsOf(value: unknown): ArtifactContentTicketClaims | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const said = value as Record<string, unknown>;
  const names = claimKeysOf(said);
  if (Object.keys(said).sort().join(",") !== names.join(",")) return null;
  for (const name of names) {
    const ok = name === "door" ? said[name] === true
      : name === "page" ? isArtifactContentTicketPage(said[name])
      : name === "expires" ? Number.isSafeInteger(said[name])
      : typeof said[name] === "string";
    if (!ok) return null;
  }
  if (names.length > CLAIM_KEYS.length && said.viewer === ARTIFACT_CONTENT_CHECK_VIEWER) return null;
  return said as unknown as ArtifactContentTicketClaims;
}

/**
 * The claims of a ticket, if it holds: its format, a kid among `keys` (the
 * current secret's and, while rotating, the previous one's), its MAC
 * (WebCrypto's verify), not expired at `now` (epoch milliseconds) and
 * expiring within ARTIFACT_CONTENT_TICKET_MAX_SECONDS, signed for exactly
 * `origin` (the origin it is being opened on), and that origin the Artifact's
 * own label (`w-<uuid of artifact>.`). Else why not, checked in that order;
 * nothing is read from the claims before the MAC holds. Claims with any
 * field but those (an `ancestor`, on a check ticket or any other) are
 * `malformed`, and so is a `door` other than `true` or on a check ticket, and
 * a `page` that isn't one or on a check ticket.
 * Whether a door ticket or a content ticket is wanted where it is opened is
 * the caller's to check (`claims.door`).
 */
export async function verifyArtifactContentTicket(
  ticket: string,
  keys: readonly ArtifactContentTicketKey[],
  expect: { origin: string; now?: number },
): Promise<{ ok: true; claims: ArtifactContentTicketClaims } | { ok: false; reason: ArtifactContentTicketRefusal }> {
  const refuse = (reason: ArtifactContentTicketRefusal) => ({ ok: false as const, reason });
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return refuse("malformed");
  const parts = ticket.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return refuse("malformed");
  const [, kid, payload, mac] = parts as [string, string, string, string];
  const key = keys.find((each) => each.kid === kid);
  if (!key) return refuse("unknown-kid");
  const given = fromBase64url(mac);
  if (given === null || !(await crypto.subtle.verify("HMAC", key.key, given, utf8(`${VERSION}.${kid}.${payload}`)))) return refuse("bad-signature");
  const bytes = fromBase64url(payload);
  let claims: ArtifactContentTicketClaims | null = null;
  try {
    claims = bytes === null ? null : claimsOf(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    claims = null;
  }
  if (!claims) return refuse("malformed");
  const now = Math.floor((expect.now ?? Date.now()) / 1000);
  if (claims.expires <= now) return refuse("expired");
  if (claims.expires - now > ARTIFACT_CONTENT_TICKET_MAX_SECONDS) return refuse("too-long");
  if (claims.origin !== expect.origin) return refuse("wrong-origin");
  const uuid = /^pt_([0-9a-f-]{36})$/.exec(claims.artifact)?.[1];
  let host: string;
  try {
    host = new URL(claims.origin).hostname;
  } catch {
    return refuse("wrong-origin");
  }
  if (uuid === undefined || !host.startsWith(`w-${uuid}.`)) return refuse("wrong-artifact");
  return { ok: true, claims };
}
