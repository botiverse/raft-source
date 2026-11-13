/**
 * The browser half of passkeys (#triage:#135, design v2 §3): turn the
 * server's WebAuthn options (JSON, base64url) into what
 * `navigator.credentials` takes, and the credential it gives back into the
 * JSON the server reads (`PublicKeyCredential.toJSON()`; server
 * services/secondFactor/webauthn.ts shape-checks it).
 *
 * Uses the browser's own JSON helpers (parseRequestOptionsFromJSON,
 * parseCreationOptionsFromJSON, credential.toJSON()) where it has them and
 * converts by hand where it doesn't; no library.
 *
 * Raft Desktop (app://raft) can't use passkeys (design A5): it counts as a
 * browser without them, so nothing here is offered there.
 */
import { isElectronDesktopShell } from "../../utils/desktopShell";

/** A credential the options name (base64url id). */
export interface PasskeyDescriptorJSON {
  id: string;
  type: "public-key";
  transports?: string[];
}

/** PublicKeyCredentialRequestOptionsJSON, as the server's options carry it. */
export interface PasskeyRequestOptionsJSON {
  /** base64url: the server's single-use challenge token. */
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: PasskeyDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
  hints?: string[];
  extensions?: Record<string, unknown>;
}

/** PublicKeyCredentialCreationOptionsJSON, as the server's options carry it. */
export interface PasskeyCreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: PasskeyDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  hints?: string[];
  extensions?: Record<string, unknown>;
}

interface CredentialJSON {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: string;
  clientExtensionResults: Record<string, unknown>;
}

/** The browser's answer to an assertion, as JSON; only getPasskeyAssertion makes one. */
export type PasskeyAssertionJSON = CredentialJSON & {
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
} & { readonly __passkeyAssertion: unique symbol };

/** The browser's new passkey, as JSON; only createPasskey makes one. */
export type PasskeyRegistrationJSON = CredentialJSON & {
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
    publicKeyAlgorithm?: number;
    publicKey?: string;
    authenticatorData?: string;
  };
} & { readonly __passkeyRegistration: unique symbol };

// ── base64url ──

function toBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── What this browser can do ──

type PublicKeyCredentialStatics = {
  parseRequestOptionsFromJSON?: (json: PasskeyRequestOptionsJSON) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (json: PasskeyCreationOptionsJSON) => PublicKeyCredentialCreationOptions;
  isConditionalMediationAvailable?: () => Promise<boolean>;
};

function publicKeyCredential(): PublicKeyCredentialStatics | null {
  const ctor = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  return typeof ctor === "function" ? (ctor as unknown as PublicKeyCredentialStatics) : null;
}

function credentials(): CredentialsContainer | null {
  if (typeof navigator === "undefined") return null;
  return navigator.credentials ?? null;
}

/** Whether this browser can sign in or verify with a passkey (never in Raft Desktop). */
export function canUsePasskeys(): boolean {
  if (isElectronDesktopShell()) return false;
  return publicKeyCredential() !== null && typeof credentials()?.get === "function";
}

/** Whether this browser can create a passkey (Settings › Account › Passkeys). */
export function canCreatePasskeys(): boolean {
  if (isElectronDesktopShell()) return false;
  return publicKeyCredential() !== null && typeof credentials()?.create === "function";
}

/** Passkeys in the email field's autofill (`mediation: "conditional"`); false when unknown. */
export async function canAutofillPasskeys(): Promise<boolean> {
  if (!canUsePasskeys()) return false;
  try {
    return (await publicKeyCredential()?.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

// ── Ceremonies ──

function requestOptions(json: PasskeyRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  const parse = publicKeyCredential()?.parseRequestOptionsFromJSON;
  if (parse) {
    try {
      return parse(json);
    } catch {
      // An older parser that refuses a field: convert by hand below.
    }
  }
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    allowCredentials: json.allowCredentials?.map((credential) => ({
      ...credential,
      id: toBuffer(credential.id),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
  } as PublicKeyCredentialRequestOptions;
}

function creationOptions(json: PasskeyCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  const parse = publicKeyCredential()?.parseCreationOptionsFromJSON;
  if (parse) {
    try {
      return parse(json);
    } catch {
      // As above.
    }
  }
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    user: { ...json.user, id: toBuffer(json.user.id) },
    excludeCredentials: json.excludeCredentials?.map((credential) => ({
      ...credential,
      id: toBuffer(credential.id),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
  } as PublicKeyCredentialCreationOptions;
}

type BrowserCredential = PublicKeyCredential & { toJSON?: () => unknown };

/** The browser's own toJSON(), when it has one and it looks right. */
function browserJSON(credential: BrowserCredential, field: string): Record<string, unknown> | null {
  if (typeof credential.toJSON !== "function") return null;
  try {
    const raw: unknown = credential.toJSON();
    const json = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const response = json?.response as Record<string, unknown> | undefined;
    if (json && typeof json.id === "string" && typeof json.rawId === "string" && typeof response?.[field] === "string") return json;
  } catch {
    // Some password-manager extensions break toJSON(): convert by hand.
  }
  return null;
}

function credentialFields(credential: BrowserCredential): CredentialJSON {
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: "public-key",
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
    clientExtensionResults: (credential.getClientExtensionResults?.() ?? {}) as Record<string, unknown>,
  };
}

/**
 * Ask the browser for a passkey answering `options`. `conditional`: offered
 * in the email field's autofill instead of a prompt, until `signal` aborts.
 * A closed prompt or an abort rejects (isPasskeyCancel).
 */
export async function getPasskeyAssertion(
  options: PasskeyRequestOptionsJSON,
  { conditional = false, signal }: { conditional?: boolean; signal?: AbortSignal } = {},
): Promise<PasskeyAssertionJSON> {
  const container = credentials();
  if (!container) throw new DOMException("Passkeys are not available in this browser.", "NotSupportedError");
  const credential = await container.get({
    publicKey: requestOptions(options),
    ...(conditional ? { mediation: "conditional" as CredentialMediationRequirement } : {}),
    ...(signal ? { signal } : {}),
  }) as BrowserCredential | null;
  if (!credential) throw new DOMException("No passkey was chosen.", "NotAllowedError");
  const json = browserJSON(credential, "signature");
  if (json) return json as unknown as PasskeyAssertionJSON;
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    ...credentialFields(credential),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      ...(response.userHandle ? { userHandle: toBase64url(response.userHandle) } : {}),
    },
  } as PasskeyAssertionJSON;
}

/** Ask the browser to create a passkey for `options`. A closed prompt rejects (isPasskeyCancel). */
export async function createPasskey(options: PasskeyCreationOptionsJSON): Promise<PasskeyRegistrationJSON> {
  const container = credentials();
  if (!container) throw new DOMException("Passkeys are not available in this browser.", "NotSupportedError");
  const credential = await container.create({ publicKey: creationOptions(options) }) as BrowserCredential | null;
  if (!credential) throw new DOMException("No passkey was created.", "NotAllowedError");
  const json = browserJSON(credential, "attestationObject");
  if (json) return json as unknown as PasskeyRegistrationJSON;
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey?.();
  const authenticatorData = response.getAuthenticatorData?.();
  return {
    ...credentialFields(credential),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
      ...(typeof response.getPublicKeyAlgorithm === "function" ? { publicKeyAlgorithm: response.getPublicKeyAlgorithm() } : {}),
      ...(publicKey ? { publicKey: toBase64url(publicKey) } : {}),
      ...(authenticatorData ? { authenticatorData: toBase64url(authenticatorData) } : {}),
    },
  } as PasskeyRegistrationJSON;
}

function errorName(err: unknown): string | null {
  return err && typeof err === "object" && typeof (err as { name?: unknown }).name === "string"
    ? (err as { name: string }).name
    : null;
}

/** The person closed the browser's prompt (or it was aborted): not an error to show as one. */
export function isPasskeyCancel(err: unknown): boolean {
  const name = errorName(err);
  return name === "NotAllowedError" || name === "AbortError";
}

/** The authenticator already holds a passkey for this account (excludeCredentials). */
export function isPasskeyAlreadyOnDevice(err: unknown): boolean {
  return errorName(err) === "InvalidStateError";
}
