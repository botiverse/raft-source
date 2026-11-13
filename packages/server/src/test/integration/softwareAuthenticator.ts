/**
 * A software WebAuthn authenticator for tests: an ES256 (P-256) key from
 * node:crypto producing real registration (attestation `none`) and assertion
 * responses, as a browser's `PublicKeyCredential.toJSON()` would send them.
 * Every field the server checks can be bent per call (origin, RP ID, user
 * verification, counter, backup flags) to drive the rejection cases.
 * Credentials are discoverable: registration keeps the user handle from the
 * options, and assertions return it (`response.userHandle`), as a passkey
 * offered by conditional mediation does.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

// --- a minimal CBOR encoder: unsigned/negative ints, byte and text strings, maps ---

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

type Cbor = number | string | Buffer | Map<number | string, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  const parts: Buffer[] = [cborHead(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

// --- authenticator data flags ---
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

export type CeremonyOptions = {
  /** clientDataJSON.origin (default: the authenticator's origin). */
  origin?: string;
  /** The RP ID whose hash goes in authenticatorData (default: the authenticator's RP ID). */
  rpId?: string;
  /** User verified (default true). */
  userVerified?: boolean;
};

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  /** The last counter reported; 0 = not in use (synced passkeys), otherwise each assertion counts up. */
  counter: number;
  /** Backup eligible / backed up (a synced passkey): both true by default. */
  synced: boolean;
  /** The user handle (base64url) the last registration was made for; returned by assertions. */
  userHandle: string | null = null;

  constructor(
    readonly rpId: string,
    readonly origin: string,
    options: { counter?: number; synced?: boolean; aaguid?: string } = {},
  ) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.counter = options.counter ?? 0;
    this.synced = options.synced ?? true;
    this.aaguid = options.aaguid ?? "00000000-0000-0000-0000-000000000000";
  }

  readonly aaguid: string;

  get id(): string {
    return this.credentialId.toString("base64url");
  }

  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" });
    return cbor(new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]));
  }

  private authData(options: CeremonyOptions, counter: number, attested: boolean): Buffer {
    const flags = UP
      | (options.userVerified === false ? 0 : UV)
      | (this.synced ? BE | BS : 0)
      | (attested ? AT : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter, 0);
    const parts: Buffer[] = [sha256(options.rpId ?? this.rpId), Buffer.from([flags]), count];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length, 0);
      parts.push(Buffer.from(this.aaguid.replace(/-/g, ""), "hex"), idLength, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, options: CeremonyOptions): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: options.origin ?? this.origin, crossOrigin: false }), "utf8");
  }

  /** Answer registration options (`options.challenge` from the server) with attestation `none`. */
  register(serverOptions: { challenge: string; user?: unknown }, options: CeremonyOptions = {}) {
    const user = serverOptions.user as { id?: unknown } | undefined;
    if (typeof user?.id === "string") this.userHandle = user.id;
    const authData = this.authData(options, this.counter, true);
    const attestationObject = cbor(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: this.clientData("webauthn.create", serverOptions.challenge, options).toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answer assertion options; a counter in use counts up first (`options.counter` overrides it). */
  assert(serverOptions: { challenge: string }, options: CeremonyOptions & { counter?: number } = {}) {
    if (options.counter === undefined && this.counter > 0) this.counter += 1;
    const counter = options.counter ?? this.counter;
    const authData = this.authData(options, counter, false);
    const clientDataJSON = this.clientData("webauthn.get", serverOptions.challenge, options);
    const signature = createSign("sha256").update(Buffer.concat([authData, sha256(clientDataJSON)])).sign(this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
