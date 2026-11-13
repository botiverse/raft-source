import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { currentDate, type ServerRole } from "@botiverse/raft-shared";

const AUTHORIZATION_CODE_PREFIX = "raft_oidc_";
const AUTHORIZATION_CODE_VERSION = 1;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

type OidcAuthorizationCodePayload = {
  v: typeof AUTHORIZATION_CODE_VERSION;
  requestId: string;
  clientId: string;
  redirectUri: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  issuedAt: number;
};

export type OidcAuthorizationContext = Omit<OidcAuthorizationCodePayload, "v" | "issuedAt">;

export type OidcIdentity = {
  sub: string;
  clientId: string;
  scopes: readonly string[];
  type: "human" | "agent";
  serverId: string;
  serverSlug: string;
  serverRole: string;
  name?: string | null;
  preferredUsername?: string | null;
  picture?: string | null;
  email?: string | null;
  emailVerified?: boolean | null;
};

/**
 * An account-mode login's identity (RFC 079 phase 3a): a person's, on no
 * Server, so without the server claims (design §1 row 7).
 */
export type OidcAccountIdentity = Omit<OidcIdentity, "type" | "serverId" | "serverSlug" | "serverRole"> & { type: "human" };

type OidcJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d?: string;
  kid: string;
  use: "sig";
  alg: "ES256";
};

type DerivedSigningKey = {
  privateKey: KeyObject;
  publicJwk: OidcJwk;
};

let cachedSigningSecret: string | null = null;
let cachedSigningKey: DerivedSigningKey | null = null;

function requiredRootSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

function deriveKey(label: string, length: number): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(requiredRootSecret(), "utf8"),
    Buffer.from("raft-oidc-v1", "utf8"),
    Buffer.from(label, "utf8"),
    length,
  ));
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function encodeUnsignedInteger(value: bigint, width: number): Buffer {
  const hex = value.toString(16).padStart(width * 2, "0");
  return Buffer.from(hex, "hex");
}

function deriveSigningKey(): DerivedSigningKey {
  const secret = requiredRootSecret();
  if (cachedSigningKey && cachedSigningSecret === secret) return cachedSigningKey;

  const seed = deriveKey("id-token-es256-private", 32);
  const scalar = (BigInt(`0x${seed.toString("hex")}`) % (P256_ORDER - 1n)) + 1n;
  const privateBytes = encodeUnsignedInteger(scalar, 32);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateBytes);
  const publicBytes = ecdh.getPublicKey(undefined, "uncompressed");
  const x = publicBytes.subarray(1, 33);
  const y = publicBytes.subarray(33, 65);
  const kid = toBase64Url(createHash("sha256").update(publicBytes).digest().subarray(0, 16));
  const privateJwk: OidcJwk = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(x),
    y: toBase64Url(y),
    d: toBase64Url(privateBytes),
    alg: "ES256",
    use: "sig",
    kid,
  };
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  const publicJwk: OidcJwk = {
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x,
    y: privateJwk.y,
    alg: "ES256",
    use: "sig",
    kid,
  };

  cachedSigningSecret = secret;
  const signingKey = { privateKey, publicJwk };
  cachedSigningKey = signingKey;
  return signingKey;
}

function configuredSigningKey(): DerivedSigningKey {
  const pem = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY?.trim();
  if (!pem) return deriveSigningKey();
  try {
    const privateKey = createPrivateKey(pem);
    const exported = createPublicKey(privateKey).export({ format: "jwk" });
    if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y) throw new Error();
    const publicBytes = Buffer.concat([Buffer.from([4]), Buffer.from(exported.x, "base64url"), Buffer.from(exported.y, "base64url")]);
    const kid = toBase64Url(createHash("sha256").update(publicBytes).digest().subarray(0, 16));
    return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: exported.x, y: exported.y, kid, alg: "ES256", use: "sig" } };
  } catch {
    throw new Error("Invalid OIDC signing key configuration");
  }
}

// Publish prospective and retiring public keys independently of the active
// signer. Operators pre-publish before switching and retain until all tokens
// (including one-hour ID tokens) expire. Never change JWT_SECRET to rotate here.
export function getOidcJwks() {
  const active = configuredSigningKey().publicJwk;
  const keys: OidcJwk[] = [active];
  const raw = process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS?.trim();
  if (!raw) return { keys };
  try {
    const extra: unknown = JSON.parse(raw);
    if (!Array.isArray(extra) || extra.length > 10) throw new Error();
    for (const value of extra) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const item = value as Record<string, unknown>;
      if (Object.keys(item).some((key) => !["kty", "crv", "x", "y", "kid", "alg", "use"].includes(key))) throw new Error();
      if (item.kty !== "EC" || item.crv !== "P-256" || item.alg !== "ES256" || item.use !== "sig"
        || typeof item.x !== "string" || typeof item.y !== "string" || typeof item.kid !== "string"
        || !/^[A-Za-z0-9_-]{43}$/.test(item.x) || !/^[A-Za-z0-9_-]{43}$/.test(item.y)) throw new Error();
      const publicBytes = Buffer.concat([Buffer.from([4]), Buffer.from(item.x, "base64url"), Buffer.from(item.y, "base64url")]);
      const kid = toBase64Url(createHash("sha256").update(publicBytes).digest().subarray(0, 16));
      if (kid !== item.kid) throw new Error();
      const key: OidcJwk = { kty: "EC", crv: "P-256", x: item.x, y: item.y, kid, alg: "ES256", use: "sig" };
      createPublicKey({ key, format: "jwk" });
      if (!keys.some((existing) => existing.kid === kid)) keys.push(key);
    }
    return { keys };
  } catch {
    throw new Error("Invalid OIDC public key configuration");
  }
}

const SERVER_ROLES: readonly ServerRole[] = ["owner", "admin", "member", "guest"];

/**
 * The `server_role` claim value (protocol v3.2 §9). It is the viewer's role at
 * signing time, for that one request, and never an authorization. Anything
 * that is not one of the four roles reads as guest, the least privileged
 * (Tenny 0021ea3f); Apps treat a missing claim the same way.
 */
export function serverRoleClaim(value: unknown): ServerRole {
  return SERVER_ROLES.includes(value as ServerRole) ? value as ServerRole : "guest";
}

/** A callback identity assertion, never an OAuth access or ID token. */
export function signAppLinkPreviewAssertion(input: {
  issuer: string; clientKey: string; userId: string; serverId: string; serverRole: ServerRole;
  installationId: string; url: string; requestId: string; now: Date;
}): string {
  const { privateKey, publicJwk } = configuredSigningKey();
  getOidcJwks();
  const now = Math.floor(input.now.getTime() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "ES256", kid: publicJwk.kid, typ: "raft-link-preview+jwt" }));
  const payload = toBase64Url(JSON.stringify({
    iss: input.issuer, aud: `urn:raft:link-preview:${input.clientKey}`, sub: input.userId,
    iat: now, nbf: now, exp: now + 30, jti: input.requestId,
    token_use: "link_preview", type: "human", server_id: input.serverId,
    server_role: serverRoleClaim(input.serverRole), installation_id: input.installationId,
    url_sha256: createHash("sha256").update(input.url).digest("hex"),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${toBase64Url(signature)}`;
}

/**
 * A resource-resolve assertion (#proj-workspace): the next version of the link
 * preview assertion above. Raft asks a first-party resource provider (first:
 * Artifacts) what one actor of one Server may see of a batch of refs. Same
 * signing key and JWKS; its own `typ` / `token_use` / audience, so neither
 * assertion can be replayed as the other, and `body_sha256` binds it to the
 * exact request body. Never an OAuth access or ID token.
 */
export function signResourceResolveAssertion(input: {
  issuer: string; clientKey: string; actorType: "human" | "agent"; actorId: string;
  serverId: string; serverRole: string; installationId: string; body: string;
  requestId: string; now: Date;
}): string {
  const { privateKey, publicJwk } = configuredSigningKey();
  getOidcJwks();
  const now = Math.floor(input.now.getTime() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "ES256", kid: publicJwk.kid, typ: "raft-resolve+jwt" }));
  const payload = toBase64Url(JSON.stringify({
    iss: input.issuer, aud: `urn:raft:resolve:${input.clientKey}`, sub: input.actorId,
    iat: now, nbf: now, exp: now + 60, jti: input.requestId,
    token_use: "resolve", type: input.actorType, server_id: input.serverId,
    server_role: input.serverRole, installation_id: input.installationId,
    body_sha256: createHash("sha256").update(input.body).digest("hex"),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${toBase64Url(signature)}`;
}

export type CardActionPhase = "prepare" | "execute" | "status";

type CardActionAssertionBase = {
  clientKey: string; userId: string; serverId: string; serverRole: ServerRole;
  installationId: string; messageId: string; urlSha256: string; body: string | Uint8Array;
  jti: string; now: Date;
};
/** Execute always carries the first-send deadline; prepare and status may. */
export type CardActionAssertionInput =
  | CardActionAssertionBase & { phase: "execute"; notAfter: Date }
  | CardActionAssertionBase & { phase: Exclude<CardActionPhase, "execute">; notAfter?: Date };

/** The operation's first-send deadline has passed: do not sign, do not send. */
export class CardActionPastDeadlineError extends Error {
  constructor() { super("card action deadline has passed"); this.name = "CardActionPastDeadlineError"; }
}

/**
 * A card-action assertion (RFC 076): Raft tells an App which human pressed
 * which card button. Same signing key and JWKS as the link-preview assertion,
 * but its own `typ` / `token_use` / audience, so the read-only preview
 * credential can never be replayed as an action and vice versa. `phase` must
 * equal the body's phase, and `body_sha256` binds the exact bytes sent.
 * `server_role` is the clicker's role at signing time, for this request only.
 * The URL is passed as its SHA-256: status is signed from a stored operation,
 * and raw URLs are never stored. `body` must be the exact bytes sent.
 * `notAfter` caps `exp` (whole seconds), and nothing is signed at or after it.
 * Execute must pass it, as the operation's first-send deadline, so no execute
 * credential outlives that deadline (protocol v3.2.3 §5.3.4); for prepare and
 * status it is optional.
 * `iss` is always `<origin>/oidc/<server_id>`, derived here from `serverId`
 * (addendum 1 §5): a slug can be renamed, and Apps require `iss` to equal the
 * `server_id` claim's issuer, so no caller can sign it any other way.
 * Never an OAuth access or ID token.
 */
export function signCardActionAssertion(input: CardActionAssertionInput): string {
  if (!/^[0-9a-f]{64}$/.test(input.urlSha256)) throw new Error("urlSha256 must be a hex SHA-256");
  if (input.phase === "execute" && !(input.notAfter instanceof Date)) throw new Error("an execute assertion needs notAfter (the first-send deadline)");
  const now = Math.floor(input.now.getTime() / 1000);
  const notAfter = input.notAfter ? Math.floor(input.notAfter.getTime() / 1000) : Number.POSITIVE_INFINITY;
  if (!(now < notAfter)) throw new CardActionPastDeadlineError();
  const { privateKey, publicJwk } = configuredSigningKey();
  getOidcJwks();
  const header = toBase64Url(JSON.stringify({ alg: "ES256", kid: publicJwk.kid, typ: "raft-card-action+jwt" }));
  const payload = toBase64Url(JSON.stringify({
    iss: oidcIssuer(undefined, input.serverId), aud: `urn:raft:card-action:${input.clientKey}`, sub: input.userId,
    iat: now, nbf: now, exp: Math.min(now + 30, notAfter), jti: input.jti,
    token_use: "card_action", type: "human", phase: input.phase,
    server_id: input.serverId, server_role: serverRoleClaim(input.serverRole), installation_id: input.installationId,
    message_id: input.messageId,
    url_sha256: input.urlSha256,
    body_sha256: createHash("sha256").update(input.body).digest("hex"),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${toBase64Url(signature)}`;
}

export function signAgentAccessJwt(input: {
  issuer: string; agentId: string; clientId: string; serverId: string;
  serverSlug: string; serverRole: string; agentName: string; displayName: string;
  jti: string; now: Date;
}): string {
  const now = Math.floor(input.now.getTime() / 1000);
  const { privateKey, publicJwk } = configuredSigningKey();
  // Validate the publication configuration before issuing credentials.
  getOidcJwks();
  const header = toBase64Url(JSON.stringify({ alg: "ES256", kid: publicJwk.kid, typ: "at+jwt" }));
  const payload = toBase64Url(JSON.stringify({
    iss: input.issuer, aud: input.clientId, sub: input.agentId,
    iat: now, nbf: now, exp: now + 300, jti: input.jti,
    token_use: "agent_access", type: "agent", server_id: input.serverId,
    server_slug: input.serverSlug, server_role: input.serverRole,
    preferred_username: input.agentName, name: input.displayName,
    login: `raft-agent-${input.agentId}`,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${toBase64Url(signature)}`;
}

export function encodeOidcAuthorizationCode(context: OidcAuthorizationContext): string {
  const payload: OidcAuthorizationCodePayload = {
    v: AUTHORIZATION_CODE_VERSION,
    ...context,
    issuedAt: currentDate().getTime(),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("authorization-code-aead", 32), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${AUTHORIZATION_CODE_PREFIX}${toBase64Url(Buffer.concat([iv, tag, ciphertext]))}`;
}

export function decodeOidcAuthorizationCode(code: string): OidcAuthorizationContext | null {
  if (!code.startsWith(AUTHORIZATION_CODE_PREFIX)) return null;
  try {
    const packed = fromBase64Url(code.slice(AUTHORIZATION_CODE_PREFIX.length));
    if (packed.length < 29) throw new Error("invalid_oidc_authorization_code");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey("authorization-code-aead", 32), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8")) as Partial<OidcAuthorizationCodePayload>;
    if (
      payload.v !== AUTHORIZATION_CODE_VERSION
      || typeof payload.requestId !== "string"
      || typeof payload.clientId !== "string"
      || typeof payload.redirectUri !== "string"
      || typeof payload.issuedAt !== "number"
      || (payload.nonce !== undefined && typeof payload.nonce !== "string")
      || (payload.codeChallenge !== undefined && typeof payload.codeChallenge !== "string")
      || (payload.codeChallengeMethod !== undefined && payload.codeChallengeMethod !== "S256")
    ) {
      throw new Error("invalid_oidc_authorization_code");
    }
    const { v: _version, issuedAt: _issuedAt, ...context } = payload as OidcAuthorizationCodePayload;
    return context;
  } catch {
    throw new Error("invalid_oidc_authorization_code");
  }
}

function safeEqualStrings(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateOidcAuthorizationCode(input: {
  context: OidcAuthorizationContext | null;
  clientId: string;
  redirectUri: unknown;
  codeVerifier: unknown;
}): void {
  // RFC 9700 §4.8.2: a verifier is valid only for an authorization that
  // included a challenge. Legacy raw codes have no OIDC/PKCE context.
  if (input.codeVerifier !== undefined && !input.context?.codeChallenge) {
    throw new Error("unexpected_oidc_code_verifier");
  }
  if (!input.context) return;
  if (!safeEqualStrings(input.context.clientId, input.clientId)) {
    throw new Error("invalid_oidc_authorization_code");
  }
  if (typeof input.redirectUri !== "string" || !safeEqualStrings(input.context.redirectUri, input.redirectUri)) {
    throw new Error("invalid_oidc_redirect_uri");
  }
  if (!input.context.codeChallenge) return;
  if (typeof input.codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
    throw new Error("invalid_oidc_code_verifier");
  }
  const actual = toBase64Url(createHash("sha256").update(input.codeVerifier, "ascii").digest());
  if (!safeEqualStrings(input.context.codeChallenge, actual)) {
    throw new Error("invalid_oidc_code_verifier");
  }
}

type OidcIdTokenInput<TIdentity> = {
  issuer: string;
  identity: TIdentity;
  nonce?: string;
  expiresInSeconds: number;
  now?: Date;
};

/**
 * The ID token's claims up to and including `type`, in the order they are
 * signed: the whole payload of an account-mode login, and the head of a
 * server-mode one, which adds the server claims after it.
 */
function idTokenClaims(input: OidcIdTokenInput<OidcIdentity | OidcAccountIdentity>) {
  const nowSeconds = Math.floor((input.now ?? currentDate()).getTime() / 1000);
  const profile = input.identity.scopes.includes("profile")
    ? {
        ...(input.identity.name ? { name: input.identity.name } : {}),
        ...(input.identity.preferredUsername ? { preferred_username: input.identity.preferredUsername } : {}),
        ...(input.identity.picture ? { picture: input.identity.picture } : {}),
      }
    : {};
  const email = input.identity.type === "human" && input.identity.scopes.includes("email") && input.identity.email
    ? {
        email: input.identity.email,
        email_verified: input.identity.emailVerified === true,
      }
    : {};
  return {
    iss: input.issuer,
    sub: input.identity.sub,
    aud: input.identity.clientId,
    iat: nowSeconds,
    exp: nowSeconds + input.expiresInSeconds,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...profile,
    ...email,
    type: input.identity.type,
  };
}

export function signOidcIdToken(input: OidcIdTokenInput<OidcIdentity>): string {
  return signIdTokenPayload({
    ...idTokenClaims(input),
    server_id: input.identity.serverId,
    server_slug: input.identity.serverSlug,
    server_role: input.identity.serverRole,
  });
}

/**
 * An account-mode login's ID token (RFC 079 phase 3a): server mode's payload,
 * claim for claim and in its order, without server_id, server_slug and
 * server_role. The caller passes the root issuer (D21).
 */
export function signOidcAccountIdToken(input: OidcIdTokenInput<OidcAccountIdentity>): string {
  return signIdTokenPayload(idTokenClaims(input));
}

function signIdTokenPayload(payload: Record<string, unknown>): string {
  const { privateKey, publicJwk } = configuredSigningKey();
  const header = { alg: "ES256", typ: "JWT", kid: publicJwk.kid };
  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${toBase64Url(signature)}`;
}

export function oidcCodeChallenge(verifier: string): string {
  return toBase64Url(createHash("sha256").update(verifier, "ascii").digest());
}

export const OIDC_SERVER_SEGMENT_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Server-scoping lives in the issuer PATH, not in a query parameter.
 *
 * Some OIDC clients (observed: Aliyun) accept only a bare issuer/discovery URL
 * and reject query or fragment components, so `?server=` could never reach
 * them. A path-scoped issuer is the interoperable form, and it is what Azure
 * does with tenants.
 *
 * `serverSegment` is a Server ID or slug. When absent this returns the legacy
 * unscoped issuer, which still serves existing integrations; retiring it is a
 * separate scheduled cutover, not part of this function's contract.
 */
export function oidcIssuer(
  rawServerUrl = process.env.SERVER_URL ?? "http://localhost:3001",
  serverSegment?: string,
): string {
  const value = rawServerUrl?.trim().replace(/\/+$/, "");
  if (!value) throw new Error("SERVER_URL environment variable is required for OIDC");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SERVER_URL must be an HTTP(S) origin for OIDC");
  }
  if (serverSegment === undefined) return parsed.origin;
  // Refuse rather than silently falling back to the unscoped issuer: a bad
  // segment must not mint a token whose `iss` is wider than the caller asked
  // for.
  if (!OIDC_SERVER_SEGMENT_PATTERN.test(serverSegment)) {
    throw new Error("OIDC server segment must be a Server ID or slug");
  }
  return `${parsed.origin}/oidc/${serverSegment}`;
}

/**
 * `serverSegment` scopes the whole endpoint family, not just the issuer: the
 * advertised authorization/token URLs carry the server in their path so the
 * client never has to add a parameter of its own.
 *
 * The returned `issuer` is always CONCRETE. Azure's multi-tenant `common`
 * endpoint returns a literal `{tenantid}` placeholder here, which breaks client
 * libraries that compare `iss` verbatim -- do not imitate that.
 */
export function oidcDiscoveryDocument(serverSegment?: string) {
  const issuer = oidcIssuer(undefined, serverSegment);
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    userinfo_endpoint: `${issuer}/api/oauth/userinfo`,
    jwks_uri: `${issuer}/api/oauth/jwks`,
    agents_endpoint: `${issuer}/api/oauth/agents`,
    serverinfo_endpoint: `${issuer}/api/oauth/serverinfo`,
    grant_types_supported: ["authorization_code", "urn:slock:grant-type:agent_request"],
    scopes_supported: [] as string[],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "sub",
      "name",
      "preferred_username",
      "picture",
      "email",
      "email_verified",
      "type",
      "server_id",
      "server_slug",
      "server_role",
    ],
  };
}

export function oidcAuthorizationCodePrefix(): string {
  return AUTHORIZATION_CODE_PREFIX;
}
