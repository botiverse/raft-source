import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";

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

export function getOidcJwks() {
  return { keys: [deriveSigningKey().publicJwk] };
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
  context: OidcAuthorizationContext;
  clientId: string;
  redirectUri: unknown;
  codeVerifier: unknown;
}): void {
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

export function signOidcIdToken(input: {
  issuer: string;
  identity: OidcIdentity;
  nonce?: string;
  expiresInSeconds: number;
  now?: Date;
}): string {
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
  const payload = {
    iss: input.issuer,
    sub: input.identity.sub,
    aud: input.identity.clientId,
    iat: nowSeconds,
    exp: nowSeconds + input.expiresInSeconds,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...profile,
    ...email,
    type: input.identity.type,
    server_id: input.identity.serverId,
    server_slug: input.identity.serverSlug,
    server_role: input.identity.serverRole,
  };
  const { privateKey, publicJwk } = deriveSigningKey();
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

export function oidcIssuer(rawServerUrl = process.env.SERVER_URL ?? "http://localhost:3001"): string {
  const value = rawServerUrl?.trim().replace(/\/+$/, "");
  if (!value) throw new Error("SERVER_URL environment variable is required for OIDC");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SERVER_URL must be an HTTP(S) origin for OIDC");
  }
  return parsed.origin;
}

export function oidcDiscoveryDocument() {
  const issuer = oidcIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    userinfo_endpoint: `${issuer}/api/oauth/userinfo`,
    jwks_uri: `${issuer}/api/oauth/jwks`,
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
