// RFC 086 §5.3: an App-sent card's SecretInput values reach the App sealed on
// the person's device, a JWE compact string (`alg: ECDH-ES`, `enc: A256GCM`,
// the App's `kid`) whose protected header binds the request it was sealed
// for. This is the one implementation of both sides, for the web, Apps and
// Node clients alike (`@botiverse/raft-sdk/app` re-exports it):
// `sealedInputsBinding` builds that header binding from what a client has,
// `sealInputs` seals (the client path: the web, and Node clients), and
// `openSealedInputs` is the App-side reference check: it compares the header
// with the claims of the execute JWT the App verified (never with the request
// body), decrypts with the App's private key, checks the plaintext and refuses
// a second delivery of the same (hnd, crq). The JOSE work is `jose`'s, on
// WebCrypto (`globalThis.crypto.subtle`) in browsers and Node alike; nothing
// here composes ECDH, the KDF or AES-GCM by hand, and nothing imports a Node
// builtin.
//
// The shared vectors (sealedInputs.v1.vector.json beside this file) pin both
// sides; web, iOS, Android and Vault run the same file.
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, importJWK } from "jose";

// Copies of messageCardActions.ts's limits, so this module (and the SDK's
// `./app`, which bundles it) doesn't pull in the card schemas;
// sealedInputs.vector.test.ts pins them to the originals. Not on `./app`.
/** A SecretInput value's cap in UTF-8 bytes (RFC 086 §5.1; shared `MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes`). */
export const SECRET_INPUT_MAX_BYTES = 4096;
/** `sealed_inputs`' cap (RFC 086 §5.4; shared `MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES`). A JWE compact string is ASCII. */
export const SEALED_INPUTS_MAX_BYTES = 8 * 1024;
/** Five base64url segments (shared `MESSAGE_CARD_SEALED_INPUTS_PATTERN`). */
export const JWE_COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The execute JWT's audience is this prefix and the App's client id; the header's `aud` is the client id alone. */
const CARD_ACTION_AUDIENCE_PREFIX = "urn:raft:card-action:";
const ALG = "ECDH-ES";
const ENC = "A256GCM";

/** The App's card encryption public key as Raft stores and serves it (`app.encryption_key`, RFC 086 §5.2). */
export interface SealedInputsPublicJwk {
  kty: "EC";
  crv: "P-256";
  use: "enc";
  alg: "ECDH-ES";
  kid: string;
  x: string;
  y: string;
}

/** One of the App's private keys: the public members plus `d`. Only the App holds it. */
export interface SealedInputsPrivateJwk {
  kty: "EC";
  crv: "P-256";
  kid: string;
  x: string;
  y: string;
  d: string;
  use?: "enc";
  alg?: "ECDH-ES";
}

/**
 * What the protected header binds (RFC 086 §5.3), each equal to a claim of the
 * execute JWT: `aud` the App's client id (the JWT's `aud` without
 * `urn:raft:card-action:`), `srv` `server_id`, `sub` `sub`, `hnd`
 * `handle_sha256` (SHA-256 of the handle string, lowercase hex), `act`
 * `action_id`, `pid` / `pdg` `prepared_action_id` / `prepared_digest` (after
 * a confirmation; absent on both sides otherwise), `crq` `client_request_id`,
 * `exp` `handle_exp` (the handle's expiry in seconds, not the JWT's own `exp`).
 */
export interface SealedInputsBinding {
  aud: string;
  srv: string;
  sub: string;
  hnd: string;
  act: string;
  pid?: string;
  pdg?: string;
  crq: string;
  exp: number;
}

/**
 * Why `openSealedInputs` refused, in the order it checks. The values never
 * appear in a refusal; log the reason, not the ciphertext.
 */
export type SealedInputsRefusal =
  /** The claims given are not an execute JWT's (a request claim missing or of the wrong type, `aud` not a card action audience). */
  | "claims_invalid"
  /** Not a JWE compact string within 8 KiB, or its protected header is not a JSON object. */
  | "malformed"
  /** The header has `zip`: compression is not allowed. */
  | "compression_not_allowed"
  /** `alg` is not `ECDH-ES` or `enc` is not `A256GCM`. */
  | "unsupported_algorithm"
  /** No key of the App's has the header's `kid` (a rotated or another App's key). */
  | "unknown_kid"
  /** The header's member disagrees with the execute JWT's claim (or is missing, or of another type). */
  | "aud_mismatch" | "srv_mismatch" | "sub_mismatch" | "hnd_mismatch" | "act_mismatch"
  | "pid_mismatch" | "pdg_mismatch" | "crq_mismatch" | "exp_mismatch"
  /** The handle's expiry has passed (now at or after `exp`). */
  | "expired"
  /** It does not decrypt and authenticate with that key: a changed header, IV, ciphertext or tag, or another key. */
  | "decryption_failed"
  /** The plaintext is not UTF-8 JSON of an object whose values are all strings. */
  | "plaintext_invalid"
  /** A value is over 4096 UTF-8 bytes. */
  | "value_too_long"
  /** This (hnd, crq) was accepted before. */
  | "replayed";

export type OpenSealedInputsResult =
  | { ok: true; values: Readonly<Record<string, string>> }
  | { ok: false; reason: SealedInputsRefusal };

/** An accepted delivery, remembered until `exp` (seconds). */
export interface SealedInputsDelivery {
  hnd: string;
  crq: string;
  exp: number;
}

export interface OpenSealedInputsOptions {
  /** `sealed_inputs` from the execute request body. */
  jwe: string;
  /** The App's private keys; the header's `kid` picks one. */
  keys: readonly SealedInputsPrivateJwk[];
  /** The payload of the execute JWT you verified (signature, `iss`, `aud`, `exp`, `phase`): the header is compared with these, never with the body. */
  claims: Readonly<Record<string, unknown>>;
  /**
   * Records an accepted delivery; true when it is new, false when this
   * (hnd, crq) was remembered already. Keep each until `exp`. Called only once
   * everything else passed, so a forgery never takes a slot. Must be atomic
   * across your instances (e.g. a unique row on (hnd, crq) with its expiry);
   * `createSealedInputsMemory` is one process's.
   */
  remember: (delivery: SealedInputsDelivery) => boolean | Promise<boolean>;
  /** The time to judge `exp` by; defaults to now. */
  now?: Date;
}

type ExecuteClaims = { aud: string; srv: string; sub: string; hnd: string; act: string; pid: string | undefined; pdg: string | undefined; crq: string; exp: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optional = (value: unknown): value is string | undefined => value === undefined || nonEmpty(value);

function executeClaims(claims: Readonly<Record<string, unknown>>): ExecuteClaims | null {
  const { aud, sub, server_id, handle_sha256, action_id, client_request_id, handle_exp, prepared_action_id, prepared_digest } = claims;
  if (typeof aud !== "string" || !aud.startsWith(CARD_ACTION_AUDIENCE_PREFIX) || aud.length === CARD_ACTION_AUDIENCE_PREFIX.length) return null;
  if (!nonEmpty(sub) || !nonEmpty(server_id) || typeof handle_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(handle_sha256)) return null;
  if (!nonEmpty(action_id) || !nonEmpty(client_request_id) || !Number.isSafeInteger(handle_exp)) return null;
  if (!optional(prepared_action_id) || !optional(prepared_digest) || (prepared_action_id === undefined) !== (prepared_digest === undefined)) return null;
  return {
    aud: aud.slice(CARD_ACTION_AUDIENCE_PREFIX.length), srv: server_id, sub, hnd: handle_sha256, act: action_id,
    pid: prepared_action_id, pdg: prepared_digest, crq: client_request_id, exp: handle_exp as number,
  };
}

/** The header members compared, in this order (the vectors' order too). */
const BOUND = ["aud", "srv", "sub", "hnd", "act", "pid", "pdg", "crq", "exp"] as const;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * Opens a card form's `sealed_inputs` (RFC 086 §5.3) for the execute request
 * whose JWT you verified: `{ ok: true, values }` (SecretInput values by field
 * id; check the ids against your form) or `{ ok: false, reason }`. Never
 * echo the values, or anything derived from one, in an answer, a card or a
 * log (§5.4). Throws only when a key in `keys` can't be imported.
 *
 * `expired` can be a legitimate press: the handle expired between Raft
 * admitting the execute and this check (Raft checks the handle when it
 * admits the press, the App checks `exp` when the request arrives). Answer
 * the person "try again", not as if the request were forged.
 */
export async function openSealedInputs(options: OpenSealedInputsOptions): Promise<OpenSealedInputsResult> {
  const refuse = (reason: SealedInputsRefusal): OpenSealedInputsResult => ({ ok: false, reason });
  const claims = isRecord(options.claims) ? executeClaims(options.claims) : null;
  if (!claims) return refuse("claims_invalid");
  const { jwe } = options;
  if (typeof jwe !== "string" || jwe.length > SEALED_INPUTS_MAX_BYTES || !JWE_COMPACT.test(jwe)) return refuse("malformed");
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(jwe) as Record<string, unknown>;
  } catch {
    return refuse("malformed");
  }
  if (Object.hasOwn(header, "zip")) return refuse("compression_not_allowed");
  if (header.alg !== ALG || header.enc !== ENC) return refuse("unsupported_algorithm");
  const jwk = typeof header.kid === "string" ? options.keys.find((key) => key.kid === header.kid) : undefined;
  if (!jwk) return refuse("unknown_kid");
  for (const member of BOUND) {
    if (header[member] !== claims[member]) return refuse(`${member}_mismatch`);
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (now >= claims.exp) return refuse("expired");
  const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, ALG);
  let plaintext: Uint8Array;
  try {
    ({ plaintext } = await compactDecrypt(jwe, key, { keyManagementAlgorithms: [ALG], contentEncryptionAlgorithms: [ENC] }));
  } catch {
    return refuse("decryption_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    return refuse("plaintext_invalid");
  }
  if (!isRecord(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) return refuse("plaintext_invalid");
  const values = parsed as Record<string, string>;
  if (Object.values(values).some((value) => utf8Bytes(value) > SECRET_INPUT_MAX_BYTES)) return refuse("value_too_long");
  if (!(await options.remember({ hnd: claims.hnd, crq: claims.crq, exp: claims.exp }))) return refuse("replayed");
  return { ok: true, values: Object.freeze({ ...values }) };
}

/** What a client has when it seals, from which `sealedInputsBinding` builds the header binding (RFC 086 §5.3). */
export interface SealedInputsBindingInputs {
  /** The action's `handle` from the handle read (`hnd` is its SHA-256). */
  handle: string;
  /** The Server the card is read in (`srv`). */
  serverId: string;
  /** The person's own user id (`sub`). */
  userId: string;
  /** The read answer's `app.client_key` (`aud`). */
  appClientKey: string;
  /** The action's `action_id` (`act`). */
  actionId: string;
  /** The prepare answer's `prepared_action_id` and `prepared_digest` (`pid`, `pdg`); null without a confirmation (a SecretInput button always has one). */
  prepared: { id: string; digest: string } | null;
  /** The `client_request_id` the execute request sends (`crq`). */
  clientRequestId: string;
  /** The action's `handle_exp`, Unix seconds (`exp`). */
  handleExp: number;
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The protected header's binding (RFC 086 §5.3) from what a client has: each
 * member is what the App will find in the execute JWT. `hnd` is the lowercase
 * hex SHA-256 of the handle string's UTF-8 bytes (WebCrypto's
 * `subtle.digest`, in browsers and Node). Throws a TypeError for an empty
 * string, a `handleExp` that is not an integer, or a `prepared` with an empty
 * member: the App would refuse such a binding.
 */
export async function sealedInputsBinding(inputs: SealedInputsBindingInputs): Promise<SealedInputsBinding> {
  const { handle, serverId, userId, appClientKey, actionId, prepared, clientRequestId, handleExp } = inputs;
  if (![handle, serverId, userId, appClientKey, actionId, clientRequestId].every(nonEmpty) || !Number.isSafeInteger(handleExp)
    || (prepared !== null && (!nonEmpty(prepared?.id) || !nonEmpty(prepared.digest)))) {
    throw new TypeError("sealedInputsBinding: every member is a non-empty string, handleExp an integer, prepared null or { id, digest }");
  }
  const hnd = hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(handle)));
  return {
    aud: appClientKey, srv: serverId, sub: userId, hnd, act: actionId,
    ...(prepared !== null ? { pid: prepared.id, pdg: prepared.digest } : {}),
    crq: clientRequestId, exp: handleExp,
  };
}

/**
 * The protected header a sealed value carries: `alg`, `enc`, `kid`, then the
 * binding in BOUND's order (`pid` / `pdg` only when given). `jose` adds `epk`.
 */
export function sealedInputsProtectedHeader(kid: string, binding: SealedInputsBinding): Record<string, string | number> {
  return {
    alg: ALG, enc: ENC, kid,
    aud: binding.aud, srv: binding.srv, sub: binding.sub, hnd: binding.hnd, act: binding.act,
    ...(binding.pid !== undefined ? { pid: binding.pid } : {}),
    ...(binding.pdg !== undefined ? { pdg: binding.pdg } : {}),
    crq: binding.crq, exp: binding.exp,
  };
}

export interface SealInputsOptions {
  /** The App's public key from the handle read (`app.encryption_key`), never from card content. */
  key: SealedInputsPublicJwk;
  /** The header binding; `sealedInputsBinding` builds it from what the client has. */
  binding: SealedInputsBinding;
  /** The SecretInput values by field id, each at most 4096 UTF-8 bytes. */
  values: Readonly<Record<string, string>>;
}

/**
 * Seals SecretInput values to the App's key (RFC 086 §5.3), as the person's
 * device does: a JWE compact string with a fresh ephemeral key and IV. The
 * client path for the web (WebCrypto, through jose), Node clients and tests;
 * build `binding` with `sealedInputsBinding`. Throws a TypeError for a key
 * that is not a P-256 ECDH-ES key or a value that is not a string within the
 * cap.
 */
export async function sealInputs(options: SealInputsOptions): Promise<string> {
  const { key, binding, values } = options;
  if (key?.kty !== "EC" || key.crv !== "P-256" || key.alg !== ALG || key.use !== "enc" || !nonEmpty(key.kid)) {
    throw new TypeError("sealInputs: key is not the App's P-256 ECDH-ES encryption key");
  }
  if (!isRecord(values) || !Object.values(values).every((value) => typeof value === "string" && utf8Bytes(value) <= SECRET_INPUT_MAX_BYTES)) {
    throw new TypeError("sealInputs: values must be strings of at most 4096 UTF-8 bytes by field id");
  }
  const publicKey = await importJWK({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }, ALG);
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(values)))
    .setProtectedHeader(sealedInputsProtectedHeader(key.kid, binding) as { alg: string; enc: string })
    .encrypt(publicKey);
}

/**
 * One process's memory of accepted deliveries for `openSealedInputs`'
 * `remember`: each (hnd, crq) until its `exp`, then forgotten. An App with
 * more than one instance needs a shared store instead.
 */
export function createSealedInputsMemory(options: { now?: () => Date } = {}): { remember: (delivery: SealedInputsDelivery) => boolean } {
  const accepted = new Map<string, number>();
  return {
    remember({ hnd, crq, exp }) {
      const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
      for (const [pair, until] of accepted) if (until <= now) accepted.delete(pair);
      const pair = JSON.stringify([hnd, crq]);
      if (accepted.has(pair)) return false;
      accepted.set(pair, exp);
      return true;
    },
  };
}
