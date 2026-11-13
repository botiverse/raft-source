import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../lib/canonicalJson";

// Interactive link cards (RFC 076 §5.1). Rendering a card must not write to
// Postgres or Redis, so the read ticket and each button's handle are signed by
// the server and carried by the client. A row is written only once a person
// clicks; "consuming" a handle is inserting its SHA-256 into
// link_card_handle_uses, whose primary key rejects a second use.
//
// Format: `v1.<kid>.<base64url payload>.<base64url HMAC-SHA256>`. Every token
// has exactly one valid spelling: verification recomputes the MAC and requires
// the exact encoded string, so `handle + "="` or an altered padding bit never
// verifies, and the SHA-256 that one-time use relies on is stable. Tickets,
// handles and the operation lookup's page cursors use different HKDF-derived
// keys, so one never verifies as another.
// Rotating = bumping the info label and kid; old tokens then fail closed,
// which costs at most a card refresh (both live ≤ 10 minutes).
//
// The identity domain is carried in the clear (it is not secret: the viewer
// already knows the message, URL and App), because execute needs it to look up
// the client request before anything else (RFC 076 §3.5).

export type LinkCardReadTicket = string & { readonly __linkCardReadTicket: unique symbol };
export type LinkCardHandle = string & { readonly __linkCardHandle: unique symbol };
export type LinkCardOperationsCursor = string & { readonly __linkCardOperationsCursor: unique symbol };

/** Longest a ticket or handle may live (Tenny 46f26196). */
export const LINK_CARD_TOKEN_MAX_TTL_SECONDS = 600;
const MAX_TOKEN_LENGTH = 4096;
const MAX_FIELD_LENGTH = 512;
const MAX_CAPABILITIES = 16;
const MAX_IAT_SKEW_SECONDS = 30;

const KID = "k1";
const PREFIX = `v1.${KID}.`;
const HKDF_SALT = "raft-link-card";
const HKDF_INFO = { ticket: "raft-link-card-ticket-v1", handle: "raft-link-card-handle-v1", cursor: "raft-link-card-cursor-v1" } as const;
type TokenKind = keyof typeof HKDF_INFO;

export type LinkCardProviderKind = "app" | "native";

/** Who and where a card view is, independent of what it shows. */
export type LinkCardViewBinding = {
  viewerId: string;
  serverId: string;
  providerKind: LinkCardProviderKind;
  providerKey: string;
  /** The installation id for an app, `native:<serverId>:<providerKey>` for a native provider. Never empty. */
  installationKey: string;
  messageId: string;
  urlSha256: string;
  registrationRevision: string;
  capabilities: readonly string[];
};

export type LinkCardReadTicketClaims = {
  viewInstanceId: string;
  viewNonce: string;
  /** Links tickets into a chain only. Display order is the client's own request sequence. */
  epoch: number;
  binding: LinkCardViewBinding;
  iat: number;
  exp: number;
};

export type LinkCardHandleClaims = LinkCardReadTicketClaims & {
  actionId: string;
  cardRevision: string;
  businessRevision: string;
  /** Label, disabled, parameters, target, confirmation requirement and execution mode. */
  descriptorSha256: string;
  messageContentSha256: string;
  /**
   * Whether execute must present a prepared record (Tenny 47bc58b7). Raft reads
   * it from the signed handle instead of trusting the client: true without a
   * valid prepared record, or false with one, is refused before the App is
   * called. The App decides again from its own policy; the stricter side wins.
   */
  requiresPrepare: boolean;
};

export type VerifiedLinkCardHandle = {
  /** The canonical spelling, the only one that verifies. */
  handle: LinkCardHandle;
  /** The value stored in link_card_handle_uses; the handle itself is never stored. */
  handleSha256: string;
  claims: LinkCardHandleClaims;
};

export function nativeInstallationKey(serverId: string, providerKey: string): string {
  return `native:${serverId}:${providerKey}`;
}

/**
 * `url_sha256` (protocol §11): lowercase hex SHA-256 of the WHATWG `href`, so an
 * explicit `:443` and the bare host are one URL. The preview JWT's claim hashes
 * the same string: preview URLs are already in `href` form.
 */
export function linkCardUrlSha256(url: string): string {
  return createHash("sha256").update(new URL(url).href, "utf8").digest("hex");
}

/** A fresh server-random nonce for a new ticket chain, so a reused client view id never continues an old one. */
export function newLinkCardViewNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * `messageContentSha256` (protocol §3.3): lowercase hex SHA-256 of the message's
 * visible content, as the viewer was shown it. The read signs it into each
 * handle and prepare/execute compare it with the live message, so both must
 * hash the same string the same way.
 */
export function linkCardMessageContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * `action_endpoint_sha256` (protocol §5.4): lowercase hex SHA-256 of the action
 * endpoint's WHATWG `href`, the form registrations store. An operation records
 * the one its execute went to, so status can stay pinned to it.
 */
export function linkCardActionEndpointSha256(endpoint: string): string {
  return createHash("sha256").update(new URL(endpoint).href, "utf8").digest("hex");
}

/**
 * The execute dispatch record's jti for an operation (protocol §5.3.4): derived
 * from the operation id, so link_card_attempts' primary key also makes the
 * dispatch record unique per operation (Tenny 52bb9eb4) without another index.
 * A UUIDv8 (custom) layout, so it can never equal a random v4 jti of a prepare
 * or status attempt.
 */
export function linkCardExecuteJti(operationId: string): string {
  const bytes = createHash("sha256").update(`raft-link-card-execute-v1:${operationId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What execute's recovery lookup reads from a handle's plain text before any MAC check. */
export type LinkCardHandleSelector = {
  providerKind: LinkCardProviderKind;
  providerKey: string;
  installationKey: string;
  urlSha256: string;
  actionId: string;
  /** SHA-256 of the handle as presented: the request digest covers it. */
  handleSha256: string;
};

/**
 * The selector in a handle's plain text (protocol §5.3.1), or null (400). It is
 * NOT verified: it only picks which client request to look up, together with
 * the authenticated viewer and Server, and a stored request digest decides
 * whether the lookup hit is this request. Never trust it for anything else.
 */
export function readLinkCardHandleSelector(raw: unknown): LinkCardHandleSelector | null {
  if (typeof raw !== "string" || raw.length > MAX_TOKEN_LENGTH || !raw.startsWith(PREFIX)) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= PREFIX.length) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw.slice(PREFIX.length, dot), "base64url").toString("utf8"));
  } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const v = payload as Record<string, unknown>;
  const binding = v.binding && typeof v.binding === "object" && !Array.isArray(v.binding) ? v.binding as Record<string, unknown> : null;
  if (v.kind !== "handle" || !binding || (binding.providerKind !== "app" && binding.providerKind !== "native")
    || !field(binding.providerKey) || !field(binding.installationKey) || !field(binding.urlSha256) || !field(v.actionId)) return null;
  return {
    providerKind: binding.providerKind, providerKey: binding.providerKey, installationKey: binding.installationKey,
    urlSha256: binding.urlSha256, actionId: v.actionId, handleSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
  };
}

/**
 * After the MAC (Tenny, #10971 review): the plain-text selector the recovery
 * lookup used must be the signed binding, field for field, and the digest the
 * handle that verified. Today both are read from the same bytes, so they never
 * differ; checking it keeps what selected a client request and what was signed
 * from ever drifting apart (a new intent with a mismatch is 410).
 */
export function linkCardSelectorMatchesHandle(selector: LinkCardHandleSelector, verified: VerifiedLinkCardHandle): boolean {
  const { binding, actionId } = verified.claims;
  return selector.providerKind === binding.providerKind && selector.providerKey === binding.providerKey
    && selector.installationKey === binding.installationKey && selector.urlSha256 === binding.urlSha256
    && selector.actionId === actionId && selector.handleSha256 === verified.handleSha256;
}

let cachedRoot: string | null = null;
const cachedKeys = new Map<TokenKind, Buffer>();

function key(kind: TokenKind): Buffer {
  const root = process.env.JWT_SECRET?.trim();
  if (!root) throw new Error("JWT_SECRET is required for link card tokens");
  if (cachedRoot !== root) {
    cachedKeys.clear();
    cachedRoot = root;
  }
  let value = cachedKeys.get(kind);
  if (!value) {
    value = Buffer.from(hkdfSync("sha256", Buffer.from(root, "utf8"), Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO[kind], "utf8"), 32));
    cachedKeys.set(kind, value);
  }
  return value;
}

function mac(kind: TokenKind, signingInput: string): string {
  return createHmac("sha256", key(kind)).update(signingInput, "utf8").digest("base64url");
}

const field = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;

function parseBinding(value: unknown): LinkCardViewBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = ["viewerId", "serverId", "providerKey", "installationKey", "messageId", "urlSha256", "registrationRevision"] as const;
  if (!keys.every((name) => field(v[name])) || (v.providerKind !== "app" && v.providerKind !== "native")) return null;
  const capabilities = v.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITIES || !capabilities.every(field)) return null;
  const binding: LinkCardViewBinding = {
    viewerId: v.viewerId as string, serverId: v.serverId as string, providerKind: v.providerKind, providerKey: v.providerKey as string,
    installationKey: v.installationKey as string, messageId: v.messageId as string, urlSha256: v.urlSha256 as string,
    registrationRevision: v.registrationRevision as string, capabilities: [...capabilities as string[]],
  };
  const nativeKey = nativeInstallationKey(binding.serverId, binding.providerKey);
  if (binding.providerKind === "native" ? binding.installationKey !== nativeKey : binding.installationKey.startsWith("native:")) return null;
  return binding;
}

function parseTicketClaims(v: Record<string, unknown>): LinkCardReadTicketClaims | null {
  const binding = parseBinding(v.binding);
  if (!binding || !field(v.viewInstanceId) || !field(v.viewNonce) || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 1
    || !Number.isSafeInteger(v.iat) || !Number.isSafeInteger(v.exp)) return null;
  return { viewInstanceId: v.viewInstanceId, viewNonce: v.viewNonce, epoch: v.epoch as number, binding, iat: v.iat as number, exp: v.exp as number };
}

function parseHandleClaims(v: Record<string, unknown>): LinkCardHandleClaims | null {
  const ticket = parseTicketClaims(v);
  const names = ["actionId", "cardRevision", "businessRevision", "descriptorSha256", "messageContentSha256"] as const;
  if (!ticket || !names.every((name) => field(v[name])) || typeof v.requiresPrepare !== "boolean") return null;
  return {
    ...ticket, actionId: v.actionId as string, cardRevision: v.cardRevision as string, businessRevision: v.businessRevision as string,
    descriptorSha256: v.descriptorSha256 as string, messageContentSha256: v.messageContentSha256 as string, requiresPrepare: v.requiresPrepare,
  };
}

/** Only named fields go into the payload; extra properties on a wider object are never signed. */
function payloadOf(kind: TokenKind, claims: LinkCardReadTicketClaims | LinkCardHandleClaims): Record<string, unknown> {
  const b = claims.binding;
  const base = {
    kind, viewInstanceId: claims.viewInstanceId, viewNonce: claims.viewNonce, epoch: claims.epoch, iat: claims.iat, exp: claims.exp,
    binding: {
      viewerId: b.viewerId, serverId: b.serverId, providerKind: b.providerKind, providerKey: b.providerKey, installationKey: b.installationKey,
      messageId: b.messageId, urlSha256: b.urlSha256, registrationRevision: b.registrationRevision, capabilities: [...new Set(b.capabilities)].sort(),
    },
  };
  if (kind === "ticket") return base;
  const h = claims as LinkCardHandleClaims;
  return { ...base, actionId: h.actionId, cardRevision: h.cardRevision, businessRevision: h.businessRevision,
    descriptorSha256: h.descriptorSha256, messageContentSha256: h.messageContentSha256, requiresPrepare: h.requiresPrepare };
}

function sign(kind: "ticket" | "handle", claims: LinkCardReadTicketClaims | LinkCardHandleClaims): string {
  const { iat, exp } = claims;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > LINK_CARD_TOKEN_MAX_TTL_SECONDS) {
    throw new RangeError("link card tokens live at most 10 minutes");
  }
  const payload = payloadOf(kind, claims);
  // The same rules verification applies, so a token is never minted that can't be used.
  if (!(kind === "ticket" ? parseTicketClaims(payload) : parseHandleClaims(payload))) throw new RangeError("link card token fields out of bounds");
  const signingInput = `${PREFIX}${Buffer.from(canonicalJson(payload), "utf8").toString("base64url")}`;
  const token = `${signingInput}.${mac(kind, signingInput)}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new RangeError("link card token too long");
  return token;
}

function verify(kind: TokenKind, raw: unknown, now: Date): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > MAX_TOKEN_LENGTH || !raw.startsWith(PREFIX)) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= PREFIX.length) return null;
  const signingInput = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), "utf8");
  const expected = Buffer.from(mac(kind, signingInput), "utf8");
  // Compare the encoded strings, not decoded bytes: lenient base64url decoding
  // would accept several spellings of one MAC.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(signingInput.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch { return null; }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const v = claims as Record<string, unknown>;
  if (v.kind !== kind || typeof v.iat !== "number" || typeof v.exp !== "number" || v.exp - v.iat > LINK_CARD_TOKEN_MAX_TTL_SECONDS) return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds < v.iat - MAX_IAT_SKEW_SECONDS || nowSeconds >= v.exp) return null;
  return v;
}

export function signLinkCardReadTicket(claims: LinkCardReadTicketClaims): LinkCardReadTicket {
  return sign("ticket", claims) as LinkCardReadTicket;
}

export function verifyLinkCardReadTicket(raw: unknown, now: Date): LinkCardReadTicketClaims | null {
  const claims = verify("ticket", raw, now);
  return claims ? parseTicketClaims(claims) : null;
}

export function signLinkCardHandle(claims: LinkCardHandleClaims): LinkCardHandle {
  return sign("handle", claims) as LinkCardHandle;
}

/** Signature, kind, bounds and lifetime only. The caller must still compare every bound field with live state. */
export function verifyLinkCardHandle(raw: unknown, now: Date): VerifiedLinkCardHandle | null {
  const verified = verify("handle", raw, now);
  const claims = verified ? parseHandleClaims(verified) : null;
  if (!claims) return null;
  const handle = raw as LinkCardHandle;
  return { handle, handleSha256: createHash("sha256").update(handle, "utf8").digest("hex"), claims };
}

/**
 * The by-URL operation lookup's page cursor (RFC 076 §6.4; protocol v3.2.3
 * §5.4): signed by Raft with its own key, opaque to the client, and bound to
 * the viewer, the Server, the identity domain the URL matched, the message,
 * the URL digest and the last sort key of the page it follows. A cursor whose
 * binding differs from the next request's is refused (400), so a changed
 * identity or filter never continues a page. It lives as long as a handle.
 */
export type LinkCardOperationsCursorClaims = {
  viewerId: string;
  serverId: string;
  providerKind: LinkCardProviderKind;
  providerKey: string;
  installationKey: string;
  messageId: string;
  urlSha256: string;
  /** The page's last sort key: `created_at` in whole epoch seconds, then `operation_id`. */
  lastCreatedAt: number;
  lastOperationId: string;
  iat: number;
  exp: number;
};

function parseCursorClaims(v: Record<string, unknown>): LinkCardOperationsCursorClaims | null {
  const names = ["viewerId", "serverId", "providerKey", "installationKey", "messageId", "urlSha256", "lastOperationId"] as const;
  if (!names.every((name) => field(v[name])) || (v.providerKind !== "app" && v.providerKind !== "native")
    || !Number.isSafeInteger(v.lastCreatedAt) || (v.lastCreatedAt as number) < 0 || !Number.isSafeInteger(v.iat) || !Number.isSafeInteger(v.exp)) return null;
  return {
    viewerId: v.viewerId as string, serverId: v.serverId as string, providerKind: v.providerKind, providerKey: v.providerKey as string,
    installationKey: v.installationKey as string, messageId: v.messageId as string, urlSha256: v.urlSha256 as string,
    lastCreatedAt: v.lastCreatedAt as number, lastOperationId: v.lastOperationId as string, iat: v.iat as number, exp: v.exp as number,
  };
}

export function signLinkCardOperationsCursor(claims: LinkCardOperationsCursorClaims): LinkCardOperationsCursor {
  const { iat, exp } = claims;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > LINK_CARD_TOKEN_MAX_TTL_SECONDS) {
    throw new RangeError("link card cursors live at most 10 minutes");
  }
  const payload = {
    kind: "cursor", iat, exp, viewerId: claims.viewerId, serverId: claims.serverId, providerKind: claims.providerKind, providerKey: claims.providerKey,
    installationKey: claims.installationKey, messageId: claims.messageId, urlSha256: claims.urlSha256,
    lastCreatedAt: claims.lastCreatedAt, lastOperationId: claims.lastOperationId,
  };
  if (!parseCursorClaims(payload)) throw new RangeError("link card cursor fields out of bounds");
  const signingInput = `${PREFIX}${Buffer.from(canonicalJson(payload), "utf8").toString("base64url")}`;
  return `${signingInput}.${mac("cursor", signingInput)}` as LinkCardOperationsCursor;
}

/** Signature, kind, bounds and lifetime only; the caller compares the binding with the request. */
export function verifyLinkCardOperationsCursor(raw: unknown, now: Date): LinkCardOperationsCursorClaims | null {
  const claims = verify("cursor", raw, now);
  return claims ? parseCursorClaims(claims) : null;
}
