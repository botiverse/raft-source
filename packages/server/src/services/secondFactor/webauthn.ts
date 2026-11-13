/**
 * WebAuthn (passkeys) for two-step verification (design v8 §1, §5; rollout
 * PR 4a): the relying-party configuration and the one adapter over
 * `@simplewebauthn/server`. Nothing else imports that library; passkeys.ts
 * holds the storage and challenge rules on top of this.
 *
 * Relying party (explicit, never derived: once anyone registers a passkey the
 * RP ID can never change, every passkey is bound to it):
 *   - `WEBAUTHN_RP_ID`: the RP ID, e.g. `raft.build` in production (covers
 *     `app.raft.build`), the staging domain on staging, `localhost` locally.
 *     It must be the APP_URL hostname or a registrable suffix of it.
 *   - `WEBAUTHN_ORIGINS`: comma-separated web origins a passkey ceremony may
 *     come from, e.g. `https://app.raft.build`. Each is https (plain http only
 *     for localhost outside production) and its host is the RP ID or below it.
 *     Desktop's `app://raft` cannot carry an RP ID and is never one (design §5).
 * Both unset: passkeys are unavailable (the passkey routes answer 503
 * `passkeys_unavailable`; nothing else changes). Set but inconsistent: the
 * server refuses to start (server.ts calls readWebauthnRelyingParty).
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { getAppUrl } from "../../config/appUrl";

export const WEBAUTHN_RP_ID_ENV = "WEBAUTHN_RP_ID";
export const WEBAUTHN_ORIGINS_ENV = "WEBAUTHN_ORIGINS";
const RP_NAME = "Raft";
const CEREMONY_TIMEOUT_MS = 5 * 60_000;

export type RelyingParty = { rpID: string; origins: string[] };

export class WebauthnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebauthnConfigError";
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost";
}

function isWithin(hostname: string, rpID: string): boolean {
  return hostname === rpID || hostname.endsWith(`.${rpID}`);
}

/**
 * The relying party from the environment: null when neither variable is set
 * (passkeys off); throws WebauthnConfigError when either is set but the pair
 * is inconsistent with itself or with APP_URL.
 */
export function readWebauthnRelyingParty(env: NodeJS.ProcessEnv = process.env): RelyingParty | null {
  const rpID = env[WEBAUTHN_RP_ID_ENV]?.trim().toLowerCase() ?? "";
  const rawOrigins = (env[WEBAUTHN_ORIGINS_ENV] ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!rpID && rawOrigins.length === 0) return null;
  if (!rpID) throw new WebauthnConfigError(`${WEBAUTHN_ORIGINS_ENV} is set but ${WEBAUTHN_RP_ID_ENV} is not`);
  if (rawOrigins.length === 0) throw new WebauthnConfigError(`${WEBAUTHN_RP_ID_ENV} is set but ${WEBAUTHN_ORIGINS_ENV} is not`);
  // A registrable domain has a dot (no bare TLD), or is localhost.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(rpID) || (!rpID.includes(".") && !isLocalhost(rpID))) {
    throw new WebauthnConfigError(`${WEBAUTHN_RP_ID_ENV} "${rpID}" is not a domain`);
  }
  const appHost = new URL(getAppUrl()).hostname;
  if (!isWithin(appHost, rpID)) {
    throw new WebauthnConfigError(`${WEBAUTHN_RP_ID_ENV} "${rpID}" must be the APP_URL hostname "${appHost}" or a suffix of it`);
  }
  const production = env.NODE_ENV === "production";
  const origins = rawOrigins.map((raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new WebauthnConfigError(`${WEBAUTHN_ORIGINS_ENV} entry "${raw}" is not a URL`);
    }
    if (url.origin !== raw.replace(/\/$/, "")) throw new WebauthnConfigError(`${WEBAUTHN_ORIGINS_ENV} entry "${raw}" must be a bare origin`);
    const httpAllowed = !production && isLocalhost(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && httpAllowed)) {
      throw new WebauthnConfigError(`${WEBAUTHN_ORIGINS_ENV} entry "${raw}" must be https (plain http only for localhost outside production)`);
    }
    if (!isWithin(url.hostname, rpID)) {
      throw new WebauthnConfigError(`${WEBAUTHN_ORIGINS_ENV} entry "${raw}" is not on ${WEBAUTHN_RP_ID_ENV} "${rpID}"`);
    }
    return url.origin;
  });
  return { rpID, origins: [...new Set(origins)] };
}

/**
 * The relying party for a request: null when passkeys are unavailable (unset,
 * or inconsistent; a server that started has already refused the latter).
 */
export function webauthnRelyingParty(): RelyingParty | null {
  try {
    return readWebauthnRelyingParty();
  } catch (err) {
    console.error("[second-factor] WebAuthn configuration is invalid; passkeys are unavailable:", err);
    return null;
  }
}

/**
 * The handle passkeys registered before `users.webauthn_user_handle` existed
 * carry (an HMAC of the person's id under JWT_SECRET, domain-separated).
 * Only to backfill that column for a person who already has such passkeys
 * (passkeyManagement.ts), so their authenticators keep seeing one account;
 * everyone else gets 32 random bytes (newWebauthnUserHandle). Never used to
 * find anyone.
 */
export function legacyWebauthnUserHandle(userId: string): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for legacy WebAuthn user handles");
  return createHmac("sha256", secret).update(`webauthn-user-handle:${userId}`).digest();
}

/** A new person's WebAuthn user handle: opaque, random, never their id or email. */
export function newWebauthnUserHandle(): Buffer {
  return randomBytes(32);
}

/** A browser's `PublicKeyCredential.toJSON()` from `navigator.credentials.create()`, shape-checked. */
export type PasskeyRegistrationResponse = RegistrationResponseJSON & { readonly __passkeyRegistration: unique symbol };
/** A browser's `PublicKeyCredential.toJSON()` from `navigator.credentials.get()`, shape-checked. */
export type PasskeyAssertionResponse = AuthenticationResponseJSON & { readonly __passkeyAssertion: unique symbol };

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const MAX_FIELD = 16_384;

function b64urlField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD && B64URL.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function credentialShape(raw: unknown, fields: string[]): Record<string, unknown> | null {
  const body = record(raw);
  const response = record(body?.response);
  if (!body || !response || body.type !== "public-key" || !b64urlField(body.id) || body.rawId !== body.id) return null;
  if (!fields.every((field) => b64urlField(response[field]))) return null;
  return body;
}

export function parsePasskeyRegistrationResponse(raw: unknown): PasskeyRegistrationResponse | null {
  const body = credentialShape(raw, ["clientDataJSON", "attestationObject"]);
  if (!body) return null;
  return { clientExtensionResults: {}, ...body } as PasskeyRegistrationResponse;
}

export function parsePasskeyAssertionResponse(raw: unknown): PasskeyAssertionResponse | null {
  const body = credentialShape(raw, ["clientDataJSON", "authenticatorData", "signature"]);
  const response = record(body?.response);
  if (!body || !response) return null;
  if (response.userHandle !== undefined && response.userHandle !== null && !b64urlField(response.userHandle)) return null;
  return { clientExtensionResults: {}, ...body } as PasskeyAssertionResponse;
}

/** The `challenge` a ceremony's clientDataJSON carries (unverified: only to find its row). */
export function ceremonyChallenge(response: PasskeyRegistrationResponse | PasskeyAssertionResponse): string | null {
  try {
    const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")) as unknown;
    const challenge = record(clientData)?.challenge;
    return typeof challenge === "string" ? challenge : null;
  } catch {
    return null;
  }
}

/** The raw credential id an assertion names. */
export function assertionCredentialId(response: PasskeyAssertionResponse): Buffer {
  return Buffer.from(response.rawId, "base64url");
}

/**
 * Challenges are auth_challenges tokens (base64url of 32 random bytes): the
 * ceremony signs over those bytes, so clientDataJSON.challenge is the token.
 */
function challengeBytes(challenge: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(challenge, "base64url"));
}

/** A stored passkey as read back (bytea comes back as a Buffer or a plain Uint8Array, depending on the driver). */
export type StoredPasskey = { credentialId: Uint8Array; publicKey: Uint8Array; transports: string[] | null };

export async function passkeyRegistrationOptions(rp: RelyingParty, input: {
  challenge: string;
  /** The person's stored handle (users.webauthn_user_handle). */
  userHandle: Uint8Array;
  userName: string;
  displayName: string;
  exclude: StoredPasskey[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userID: new Uint8Array(input.userHandle),
    userName: input.userName,
    userDisplayName: input.displayName,
    challenge: challengeBytes(input.challenge),
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: input.exclude.map((passkey) => ({
      id: Buffer.from(passkey.credentialId).toString("base64url"),
      ...(passkey.transports ? { transports: passkey.transports } : {}),
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export type RegisteredPasskey = {
  credentialId: Buffer;
  publicKey: Buffer;
  signCount: number;
  aaguid: string;
  backupEligible: boolean;
  backupState: boolean;
  transports: string[] | null;
};

/**
 * Verify a registration against `challenge` (origin, RP ID, user presence and
 * verification, attestation format). Null when it does not verify.
 */
export async function verifyPasskeyRegistration(rp: RelyingParty, response: PasskeyRegistrationResponse, challenge: string): Promise<RegisteredPasskey | null> {
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo.userVerified) return null;
    const info = result.registrationInfo;
    const transports = response.response.transports?.filter((t): t is string => typeof t === "string" && t.length <= 32).slice(0, 8);
    return {
      credentialId: Buffer.from(info.credential.id, "base64url"),
      publicKey: Buffer.from(info.credential.publicKey),
      signCount: info.credential.counter,
      aaguid: info.aaguid,
      backupEligible: info.credentialDeviceType === "multiDevice",
      backupState: info.credentialBackedUp,
      transports: transports && transports.length > 0 ? transports : null,
    };
  } catch {
    return null;
  }
}

export async function passkeyAssertionOptions(rp: RelyingParty, input: { challenge: string; allow: StoredPasskey[] }): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: challengeBytes(input.challenge),
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: input.allow.map((passkey) => ({
      id: Buffer.from(passkey.credentialId).toString("base64url"),
      ...(passkey.transports ? { transports: passkey.transports } : {}),
    })),
  });
}

/**
 * Verify an assertion by `passkey` against `challenge` (origin, RP ID,
 * signature, user verification). Returns the authenticator's counter; the
 * counter rule (design §5: a regression is a signal, never a refusal) is the
 * caller's, so the library is never given the stored counter to reject on.
 */
export async function verifyPasskeyAssertion(
  rp: RelyingParty,
  response: PasskeyAssertionResponse,
  challenge: string,
  passkey: StoredPasskey,
): Promise<{ counter: number; backupState: boolean } | null> {
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: Buffer.from(passkey.credentialId).toString("base64url"),
        publicKey: new Uint8Array(passkey.publicKey),
        counter: 0,
        ...(passkey.transports ? { transports: passkey.transports } : {}),
      },
    });
    if (!result.verified || !result.authenticationInfo.userVerified) return null;
    return { counter: result.authenticationInfo.newCounter, backupState: result.authenticationInfo.credentialBackedUp };
  } catch {
    return null;
  }
}

/** A few well-known passkey providers by AAGUID, for a default name. */
const PROVIDER_BY_AAGUID: Readonly<Record<string, string>> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "771b48fd-d3d4-4f74-9232-fc157ab0507a": "Edge on Mac",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

export function defaultPasskeyName(aaguid: string | null): string {
  return (aaguid && PROVIDER_BY_AAGUID[aaguid.toLowerCase()]) || "Passkey";
}
