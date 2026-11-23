import {
  checkPrimeSync,
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
import { AGENT_TOKEN_SIGNING_ALGS, AGENT_TOKEN_TYPES, currentDate, type AgentTokenSigningAlg, type AgentTokenType, type ServerRole } from "@botiverse/raft-shared";

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
  /**
   * An Agent's login only: the `sub` its owner gets when they log in (their
   * Raft user id, as every human `sub` today). Signed as `owner_sub`, after
   * the server claims; absent when the Agent has no owner (findAgentOwner).
   */
  ownerSub?: string | null;
};

/**
 * An account-mode login's identity (RFC 079 phase 3a): a person's, on no
 * Server, so without the server claims (design §1 row 7).
 */
export type OidcAccountIdentity = Omit<OidcIdentity, "type" | "serverId" | "serverSlug" | "serverRole" | "ownerSub"> & { type: "human" };

type OidcEcJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d?: string;
  kid: string;
  use: "sig";
  alg: "ES256";
};

/** A published RSA key: public members only (`n`, `e`), never d/p/q/dp/dq/qi. */
type OidcRsaJwk = {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  use: "sig";
  alg: "RS256";
};

type OidcJwk = OidcEcJwk | OidcRsaJwk;

type DerivedSigningKey = {
  privateKey: KeyObject;
  publicJwk: OidcEcJwk;
};

type RsaSigningKey = {
  privateKey: KeyObject;
  publicJwk: OidcRsaJwk;
};

let cachedSigningSecret: string | null = null;
let cachedSigningKey: DerivedSigningKey | null = null;
let cachedRsaSigningSecret: string | null = null;
let cachedRsaSigningKey: RsaSigningKey | null = null;

const RSA_PUBLIC_EXPONENT = 65537n;
const RSA_MIN_MODULUS_BITS = 2048;
const RSA_MAX_MODULUS_BITS = 4096;

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
  const privateJwk: OidcEcJwk = {
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
  const publicJwk: OidcEcJwk = {
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

/**
 * A deterministic RSA prime of exactly 1024 bits for the dev/test RS256 key:
 * the first prime at or above an HKDF-derived start (top two bits set, so
 * p*q is exactly 2048 bits) with gcd(e, p-1) = 1. OpenSSL's Miller-Rabin
 * (checkPrimeSync) never rejects a prime, so the result depends only on
 * JWT_SECRET, like the ES256 fallback.
 */
function deriveRsaPrime(label: string): bigint {
  const seed = deriveKey(label, 128);
  let candidate = BigInt(`0x${seed.toString("hex")}`) | (3n << 1022n) | 1n;
  const limit = 1n << 1024n;
  while (candidate < limit) {
    if ((candidate - 1n) % RSA_PUBLIC_EXPONENT !== 0n && checkPrimeSync(candidate)) return candidate;
    candidate += 2n;
  }
  throw new Error("Could not derive the development RS256 signing key");
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let [oldR, r] = [((value % modulus) + modulus) % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1n) throw new Error("not invertible");
  return ((oldS % modulus) + modulus) % modulus;
}

function bigIntToBase64Url(value: bigint): string {
  const hex = value.toString(16);
  return toBase64Url(Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex"));
}

/**
 * The kid of an RSA key: as for ES256, the first 16 bytes of a SHA-256 over
 * the public key, here its DER SubjectPublicKeyInfo, base64url.
 */
function rsaKid(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return toBase64Url(createHash("sha256").update(der).digest().subarray(0, 16));
}

/**
 * The public JWK of an RSA signing key, or a throw unless it is a plain RSA
 * (not RSA-PSS) key of 2048 to 4096 bits with e = 65537. Only `n` and `e`
 * are taken from the key, so no private member can reach the JWKS.
 */
function rsaPublicJwk(key: KeyObject): OidcRsaJwk {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const details = publicKey.asymmetricKeyDetails;
  if (publicKey.asymmetricKeyType !== "rsa" || !details?.modulusLength
    || details.modulusLength < RSA_MIN_MODULUS_BITS || details.modulusLength > RSA_MAX_MODULUS_BITS
    || details.publicExponent !== RSA_PUBLIC_EXPONENT) throw new Error();
  const exported = publicKey.export({ format: "jwk" });
  if (exported.kty !== "RSA" || !exported.n || !exported.e) throw new Error();
  return { kty: "RSA", n: exported.n, e: exported.e, alg: "RS256", use: "sig", kid: rsaKid(publicKey) };
}

/**
 * The dev/test RS256 key, derived from JWT_SECRET like the ES256 fallback, so
 * every process (and every restart) of one environment publishes the same key
 * and kid. RSA has no standard seed-to-key derivation, so the primes are
 * found deterministically from HKDF output (deriveRsaPrime). Computed once
 * per JWT_SECRET per process, about 0.1 s. Never used in production.
 */
function deriveRsaSigningKey(): RsaSigningKey {
  const secret = requiredRootSecret();
  if (cachedRsaSigningKey && cachedRsaSigningSecret === secret) return cachedRsaSigningKey;
  const p = deriveRsaPrime("agent-token-rs256-private-p");
  const q = deriveRsaPrime("agent-token-rs256-private-q");
  if (p === q) throw new Error("Could not derive the development RS256 signing key");
  const d = modInverse(RSA_PUBLIC_EXPONENT, (p - 1n) * (q - 1n));
  const privateKey = createPrivateKey({
    format: "jwk",
    key: {
      kty: "RSA",
      n: bigIntToBase64Url(p * q),
      e: bigIntToBase64Url(RSA_PUBLIC_EXPONENT),
      d: bigIntToBase64Url(d),
      p: bigIntToBase64Url(p),
      q: bigIntToBase64Url(q),
      dp: bigIntToBase64Url(d % (p - 1n)),
      dq: bigIntToBase64Url(d % (q - 1n)),
      qi: bigIntToBase64Url(modInverse(q, p)),
    },
  });
  const signingKey = { privateKey, publicJwk: rsaPublicJwk(privateKey) };
  cachedRsaSigningSecret = secret;
  cachedRsaSigningKey = signingKey;
  return signingKey;
}

/**
 * Where a key derived from JWT_SECRET may stand in for a configured RS256
 * key: development and tests. Vitest counts as a test even where the machine
 * presets NODE_ENV=production (agent VMs; lib/refusal.ts does the same).
 */
function derivedRsaKeyAllowed(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV !== "production";
}

/**
 * The RS256 key for agent tokens of Apps set to RS256, or null when none is
 * configured in production. `RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY` is a PEM
 * RSA private key (2048-4096 bits, e = 65537); without it development and
 * tests use a key derived from JWT_SECRET, and production has no RS256 key:
 * the JWKS publishes only ES256 and signing an RS256 token fails closed.
 */
function configuredRsaSigningKey(): RsaSigningKey | null {
  const pem = process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY?.trim();
  if (!pem) return derivedRsaKeyAllowed() ? deriveRsaSigningKey() : null;
  try {
    const privateKey = createPrivateKey(pem);
    return { privateKey, publicJwk: rsaPublicJwk(privateKey) };
  } catch {
    throw new Error("Invalid OIDC RS256 signing key configuration");
  }
}

/** An App is set to RS256 but this deployment has no RS256 signing key. */
export class OidcRs256SigningKeyUnavailableError extends Error {
  constructor() {
    super("RS256 agent token signing is not configured: set RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY (PEM RSA private key) to sign agent tokens for Apps set to RS256");
    this.name = "OidcRs256SigningKeyUnavailableError";
  }
}

const ADDITIONAL_EC_KEY_MEMBERS = ["kty", "crv", "x", "y", "kid", "alg", "use"];
const ADDITIONAL_RSA_KEY_MEMBERS = ["kty", "n", "e", "kid", "alg", "use"];

function additionalPublicKey(item: Record<string, unknown>): OidcJwk {
  if (item.kty === "RSA") {
    if (Object.keys(item).some((key) => !ADDITIONAL_RSA_KEY_MEMBERS.includes(key))) throw new Error();
    if (item.alg !== "RS256" || item.use !== "sig" || typeof item.n !== "string" || typeof item.e !== "string"
      || typeof item.kid !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.n) || !/^[A-Za-z0-9_-]+$/.test(item.e)) throw new Error();
    const key = rsaPublicJwk(createPublicKey({ key: { kty: "RSA", n: item.n, e: item.e }, format: "jwk" }));
    // The members must be the key's canonical encoding (no leading zeros), and the kid the one derived from it.
    if (key.n !== item.n || key.e !== item.e || key.kid !== item.kid) throw new Error();
    return key;
  }
  if (Object.keys(item).some((key) => !ADDITIONAL_EC_KEY_MEMBERS.includes(key))) throw new Error();
  if (item.kty !== "EC" || item.crv !== "P-256" || item.alg !== "ES256" || item.use !== "sig"
    || typeof item.x !== "string" || typeof item.y !== "string" || typeof item.kid !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(item.x) || !/^[A-Za-z0-9_-]{43}$/.test(item.y)) throw new Error();
  const publicBytes = Buffer.concat([Buffer.from([4]), Buffer.from(item.x, "base64url"), Buffer.from(item.y, "base64url")]);
  const kid = toBase64Url(createHash("sha256").update(publicBytes).digest().subarray(0, 16));
  if (kid !== item.kid) throw new Error();
  const key: OidcEcJwk = { kty: "EC", crv: "P-256", x: item.x, y: item.y, kid, alg: "ES256", use: "sig" };
  createPublicKey({ key, format: "jwk" });
  return key;
}

// Publish prospective and retiring public keys independently of the active
// signer. Operators pre-publish before switching and retain until all tokens
// (including one-hour ID tokens) expire. Never change JWT_SECRET to rotate here.
// The JWKS holds the active ES256 key, then the active RS256 key (when this
// deployment has one), then the additional keys: EC P-256/ES256 or RSA/RS256,
// public members only, each kid recomputed from its key.
export function getOidcJwks() {
  const keys: OidcJwk[] = [configuredSigningKey().publicJwk];
  const rsa = configuredRsaSigningKey();
  if (rsa) keys.push(rsa.publicJwk);
  const raw = process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS?.trim();
  if (!raw) return { keys };
  try {
    const extra: unknown = JSON.parse(raw);
    if (!Array.isArray(extra) || extra.length > 10) throw new Error();
    for (const value of extra) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const key = additionalPublicKey(value as Record<string, unknown>);
      if (!keys.some((existing) => existing.kid === key.kid)) keys.push(key);
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
/**
 * What an execute assertion also names of the person's request (RFC 086 §5.3):
 * the handle used (its SHA-256, lowercase hex), the action, the request id
 * the person's client sent, the handle's expiry (seconds) and, after a
 * confirmation, the prepared action's id and digest. An App compares a sealed
 * value's JWE protected header with these signed claims, never with the body.
 */
export type CardActionExecuteRequestClaims = {
  handleSha256: string; actionId: string; clientRequestId: string; handleExp: number; prepared: { actionId: string; digest: string } | null;
};
/** Execute always carries the first-send deadline and the request's claims; prepare and status may carry the deadline. */
export type CardActionAssertionInput =
  | CardActionAssertionBase & { phase: "execute"; notAfter: Date; request: CardActionExecuteRequestClaims }
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
 * An execute assertion also carries `handle_sha256`, `action_id`,
 * `client_request_id`, `handle_exp` and, after a confirmation,
 * `prepared_action_id` and `prepared_digest` (RFC 086 §5.3): the claims a
 * sealed card form value's JWE header (`hnd`, `act`, `crq`, `exp`, `pid`,
 * `pdg`; with `sub`, `server_id` for `srv` and the audience's client id for
 * `aud`) must equal.
 * `iss` is always `<origin>/oidc/<server_id>`, derived here from `serverId`
 * (addendum 1 §5): a slug can be renamed, and Apps require `iss` to equal the
 * `server_id` claim's issuer, so no caller can sign it any other way.
 * Never an OAuth access or ID token.
 */
export function signCardActionAssertion(input: CardActionAssertionInput): string {
  if (!/^[0-9a-f]{64}$/.test(input.urlSha256)) throw new Error("urlSha256 must be a hex SHA-256");
  if (input.phase === "execute" && !(input.notAfter instanceof Date)) throw new Error("an execute assertion needs notAfter (the first-send deadline)");
  if (input.phase === "execute" && !/^[0-9a-f]{64}$/.test(input.request.handleSha256)) throw new Error("handleSha256 must be a hex SHA-256");
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
    ...(input.phase === "execute" ? {
      handle_sha256: input.request.handleSha256, action_id: input.request.actionId, client_request_id: input.request.clientRequestId,
      handle_exp: input.request.handleExp,
      ...(input.request.prepared ? { prepared_action_id: input.request.prepared.actionId, prepared_digest: input.request.prepared.digest } : {}),
    } : {}),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${toBase64Url(signature)}`;
}

/**
 * An agent token (agent audience JWT). `alg` is the App's stored setting
 * (oauth_clients.agent_token_signing_alg), never a request's: ES256 with the
 * same key as ID tokens, or RS256 with the RS256 key, which fails closed
 * (OidcRs256SigningKeyUnavailableError) where none is configured. `typ` is
 * the App's stored oauth_clients.agent_token_type, also never a request's:
 * at+jwt, or JWT on a token-only App (no redirect URL); header and claims are
 * otherwise the same.
 */
export function signAgentAccessJwt(input: {
  issuer: string; agentId: string; clientId: string; serverId: string;
  serverSlug: string; serverRole: string; agentName: string; displayName: string;
  jti: string; now: Date; alg: AgentTokenSigningAlg; typ: AgentTokenType;
}): string {
  if (!AGENT_TOKEN_SIGNING_ALGS.includes(input.alg)) throw new Error("Unsupported agent token signing algorithm");
  if (!AGENT_TOKEN_TYPES.includes(input.typ)) throw new Error("Unsupported agent token type");
  const now = Math.floor(input.now.getTime() / 1000);
  let signingKey: DerivedSigningKey | RsaSigningKey;
  if (input.alg === "RS256") {
    const rsa = configuredRsaSigningKey();
    if (!rsa) throw new OidcRs256SigningKeyUnavailableError();
    signingKey = rsa;
  } else {
    signingKey = configuredSigningKey();
  }
  const { privateKey, publicJwk } = signingKey;
  // Validate the publication configuration before issuing credentials.
  getOidcJwks();
  const header = toBase64Url(JSON.stringify({ alg: input.alg, kid: publicJwk.kid, typ: input.typ }));
  const payload = toBase64Url(JSON.stringify({
    iss: input.issuer, aud: input.clientId, sub: input.agentId,
    iat: now, nbf: now, exp: now + 300, jti: input.jti,
    token_use: "agent_access", type: "agent", server_id: input.serverId,
    server_slug: input.serverSlug, server_role: input.serverRole,
    preferred_username: input.agentName, name: input.displayName,
    login: `raft-agent-${input.agentId}`,
  }));
  const signingInput = `${header}.${payload}`;
  // RS256 is RSASSA-PKCS1-v1_5 with SHA-256, node's default padding for an RSA key.
  const signature = input.alg === "RS256"
    ? sign("sha256", Buffer.from(signingInput, "ascii"), privateKey)
    : sign("sha256", Buffer.from(signingInput, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" });
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
    // #proj-apps:#75: who the Agent belongs to, from Raft and not from the
    // Agent, so a relying party (AirWing) can apply the owner's own rights.
    // Only on an Agent's token, and only while it has an owner.
    ...(input.identity.type === "agent" && input.identity.ownerSub ? { owner_sub: input.identity.ownerSub } : {}),
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
    // ID tokens are ES256. RS256 is listed for agent tokens of Apps set to
    // RS256 (same issuer and JWKS) only when this deployment has an RS256 key,
    // as the JWKS does: some relying parties (Alibaba Cloud's OIDC provider)
    // refuse an issuer whose discovery lists no RSA algorithm, and none should
    // be told of an algorithm it cannot get a token in.
    id_token_signing_alg_values_supported: configuredRsaSigningKey() ? ["ES256", "RS256"] : ["ES256"],
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
      "owner_sub",
    ],
  };
}

export function oidcAuthorizationCodePrefix(): string {
  return AUTHORIZATION_CODE_PREFIX;
}
