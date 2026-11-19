// Builds packages/shared/src/sealedInputs.v1.vector.json (RFC 086 §5.3), the
// shared sealing vectors. Deterministic: every key (the App's and each
// case's ephemeral one) is derived from a fixed label (d = SHA-256 of it), and
// each case's IV from its name, so the same jose version writes the same
// bytes. Run `pnpm --filter @botiverse/raft-shared generate:sealed-inputs-vectors`
// (scripts/generate-sealed-inputs-vectors.ts) to rewrite the file;
// sealedInputs.vector.test.ts fails while the committed file differs.
//
// A fixed ephemeral key and IV are for vectors only: a real seal
// (`sealInputs`) draws both fresh every time.
import { createECDH, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompactEncrypt, importJWK } from "jose";
import {
  sealedInputsProtectedHeader, type SealedInputsBinding, type SealedInputsBindingInputs, type SealedInputsPrivateJwk, type SealedInputsPublicJwk,
  type SealedInputsRefusal,
} from "./sealedInputs";

export const SEALED_INPUTS_VECTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), "sealedInputs.v1.vector.json");
export const SEALED_INPUTS_VECTOR_SHA256_PATH = SEALED_INPUTS_VECTOR_PATH.replace(/\.json$/, ".sha256");

export interface SealedInputsVectorKey { label: string; publicJwk: SealedInputsPublicJwk; privateJwk: SealedInputsPrivateJwk }
export type SealedInputsVectorExpect = { ok: true; values: Record<string, string> } | { ok: false; reason: SealedInputsRefusal };
export interface SealedInputsOpenCase {
  name: string; note: string; jwe: string; keys: string[]; claims: Record<string, unknown>; now: number;
  accepted: { hnd: string; crq: string; exp: number }[]; expect: SealedInputsVectorExpect;
}
export interface SealedInputsSealCase {
  name: string; note: string; key: string; handle: string; bindingInputs: SealedInputsBindingInputs; binding: SealedInputsBinding; values: Record<string, string>;
  header: Record<string, string | number>; claims: Record<string, unknown>; now: number;
}
export interface SealedInputsVectors {
  contract: "sealed-inputs.v1"; schemaVersion: 1; testOnly: true; warning: string; notes: string; generator: string;
  keys: SealedInputsVectorKey[]; open: SealedInputsOpenCase[]; seal: SealedInputsSealCase[];
}

const BOUND_FIELDS = ["aud", "srv", "sub", "hnd", "act", "pid", "pdg", "crq", "exp"] as const;
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();
const sha256Hex = (text: string) => sha256(text).toString("hex");
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A P-256 private JWK whose `d` is SHA-256 of the label (Node's ECDH computes the point). */
function derivedJwk(label: string, kid?: string): SealedInputsPrivateJwk {
  const d = sha256(`raft sealed-inputs v1 test key: ${label}`);
  const scalar = BigInt(`0x${d.toString("hex")}`);
  if (scalar === 0n || scalar >= P256_ORDER) throw new Error(`label ${label} gives no P-256 scalar; pick another`);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return { kty: "EC", crv: "P-256", kid: kid ?? label, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)), d: b64u(d) };
}

function vectorKey(kid: string, label: string): SealedInputsVectorKey {
  const privateJwk = { ...derivedJwk(kid), use: "enc" as const, alg: "ECDH-ES" as const };
  const { kty, crv, x, y } = privateJwk;
  return { label, publicJwk: { kty, crv, use: "enc", alg: "ECDH-ES", kid, x, y }, privateJwk };
}

const KEY_A = vectorKey("test-2026-11-a", "TEST ONLY, never use: the App's key in force (as registered with PUT /api/oauth/link-preview/encryption-key)");
const KEY_B = vectorKey("test-2026-11-b", "TEST ONLY, never use: a second key the App also holds");
const KEY_C = vectorKey("test-2026-11-c", "TEST ONLY, never use: a key the App does not hold (another App's, or one it dropped)");
const KEYS = [KEY_A, KEY_B, KEY_C];
const APP_KEYS = [KEY_A.publicJwk.kid, KEY_B.publicJwk.kid];

/** The person's request every case starts from: an execute after a confirmation. */
const CLIENT_ID = "app_test_vault";
const SERVER_ID = "95f993fa-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const USER_ID = "4b1f0c5e-8d2a-4e3b-9c6f-7a8b9c0d1e2f";
const HANDLE = "v1.test-handle-kid.eyJraW5kIjoiaGFuZGxlIiwidGVzdCI6dHJ1ZX0.dGVzdC1oYW5kbGUtbWFjLW5vdC1yZWFs";
const HANDLE_EXP = 1794700800;
const NOW = HANDLE_EXP - 120;
const BINDING: SealedInputsBinding = {
  aud: CLIENT_ID, srv: SERVER_ID, sub: USER_ID, hnd: sha256Hex(HANDLE), act: "save_key",
  pid: "0b9d6c3e-2f4a-4b5c-8d6e-7f8a9b0c1d2e", pdg: sha256Hex("test prepared description"),
  crq: "crq-test-2026-11-14-0001", exp: HANDLE_EXP,
};
/** What the client has that BINDING is built from (the handle read, the prepare answer, its own request id). */
const BINDING_INPUTS: SealedInputsBindingInputs = {
  handle: HANDLE, serverId: SERVER_ID, userId: USER_ID, appClientKey: CLIENT_ID, actionId: BINDING.act,
  prepared: { id: BINDING.pid!, digest: BINDING.pdg! }, clientRequestId: BINDING.crq, handleExp: HANDLE_EXP,
};

/** The verified execute JWT's payload for a binding, as oidcService.ts signs it (the JWT's own `exp` is 30 s, not the handle's). */
function claimsFor(binding: SealedInputsBinding, now = NOW): Record<string, unknown> {
  return {
    iss: `https://api.raft.build/oidc/${binding.srv}`, aud: `urn:raft:card-action:${binding.aud}`, sub: binding.sub,
    iat: now, nbf: now, exp: now + 30, jti: "5f0c7c1e-3a2b-8c4d-9e5f-6a7b8c9d0e1f",
    token_use: "card_action", type: "human", phase: "execute",
    server_id: binding.srv, server_role: "member", installation_id: "test-installation", message_id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    url_sha256: sha256Hex("https://vault.example/cards/save"), body_sha256: sha256Hex("test execute body"),
    handle_sha256: binding.hnd, action_id: binding.act, client_request_id: binding.crq, handle_exp: binding.exp,
    ...(binding.pid !== undefined ? { prepared_action_id: binding.pid } : {}),
    ...(binding.pdg !== undefined ? { prepared_digest: binding.pdg } : {}),
  };
}

/**
 * jose's JWE with a fixed ephemeral key and IV (both from the case name), and
 * a fixed CEK where one is wrapped (ECDH-ES+A256KW). `header` is the whole
 * protected header but `epk`.
 */
async function sealFixed(name: string, to: SealedInputsVectorKey, header: Record<string, unknown>, plaintext: Uint8Array): Promise<string> {
  const alg = String(header.alg);
  const epk = await importJWK(derivedJwk(`epk ${name}`), "ECDH-ES", { extractable: true });
  const jwe = new CompactEncrypt(plaintext)
    .setProtectedHeader(header as { alg: string; enc: string })
    .setKeyManagementParameters({ epk })
    .setInitializationVector(new Uint8Array(sha256(`iv ${name}`).subarray(0, 12)));
  if (alg !== "ECDH-ES") jwe.setContentEncryptionKey(new Uint8Array(sha256(`cek ${name}`).subarray(0, header.enc === "A128GCM" ? 16 : 32)));
  const { kty, crv, x, y } = to.publicJwk;
  return jwe.encrypt(await importJWK({ kty, crv, x, y }, alg));
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const headerOf = (key: SealedInputsVectorKey, binding = BINDING) => sealedInputsProtectedHeader(key.publicJwk.kid, binding);

/** Rewrites a JWE's segment `index` (0 header, 2 IV, 3 ciphertext, 4 tag). */
function withSegment(jwe: string, index: number, change: (bytes: Buffer) => Buffer): string {
  const parts = jwe.split(".");
  parts[index] = change(Buffer.from(parts[index]!, "base64url")).toString("base64url");
  return parts.join(".");
}
const flipLastBit = (bytes: Buffer) => { const out = Buffer.from(bytes); out[out.length - 1]! ^= 1; return out; };
const rewriteHeader = (jwe: string, change: (header: Record<string, unknown>) => Record<string, unknown>) =>
  withSegment(jwe, 0, (bytes) => Buffer.from(JSON.stringify(change(JSON.parse(bytes.toString("utf8")))), "utf8"));

const NOTES = [
  "Shared vectors for RFC 086 §5.3 (sealed SecretInput values), for web, iOS, Android and Vault. Generated by packages/shared/scripts/generate-sealed-inputs-vectors.ts (deterministic; pinned by sealedInputs.v1.vector.sha256). The one implementation is packages/shared/src/sealedInputs.ts (@botiverse/raft-shared/src/sealedInputs; re-exported by @botiverse/raft-sdk/app): openSealedInputs is the reference App-side check, sealInputs and sealedInputsBinding the client side.",
  "keys[]: TEST-ONLY P-256 keys (each d is SHA-256 of a label); publicJwk is the shape Raft stores and serves as app.encryption_key, privateJwk is for App-side tests. Never use them for anything else.",
  "A sealed value is a JWE compact string: alg ECDH-ES (direct key agreement, so the encrypted key segment is empty), enc A256GCM, kid the App key's kid, no zip. Plaintext: UTF-8 JSON of an object of SecretInput values by field id, each a string of at most 4096 UTF-8 bytes. Protected header members, in this order: alg, enc, kid, aud, srv, sub, hnd, act, pid, pdg, crq, exp, then epk (the library adds it). pid and pdg are present only after a confirmation (always, for a SecretInput button). exp is a number (seconds); every other bound member is a string.",
  "Each bound member equals a claim of the execute JWT Raft signed (oidcService.ts signCardActionAssertion), never the request body: aud = the JWT's aud without the prefix urn:raft:card-action: (the App's client id); srv = server_id; sub = sub; hnd = handle_sha256 (lowercase hex SHA-256 of the handle string's UTF-8 bytes); act = action_id; pid = prepared_action_id; pdg = prepared_digest; crq = client_request_id; exp = handle_exp (the handle's expiry, not the JWT's own exp). Absent equals absent; compare with the JSON types (a number never equals a string).",
  "open[]: run the App-side check on jwe with the private keys of the kids in keys[], the JWT payload claims, the time now (seconds) and a replay memory already holding accepted[]. expect is {ok: true, values} or {ok: false, reason}. The check runs in this order and refuses with the first reason that applies: claims_invalid (a request claim missing or mistyped: handle_sha256 64 lowercase hex, handle_exp an integer, aud a string starting urn:raft:card-action:, prepared_action_id and prepared_digest both or neither), malformed (not five base64url segments within 8192 characters, or a protected header that is not a JSON object), compression_not_allowed (zip present), unsupported_algorithm (alg not ECDH-ES or enc not A256GCM), unknown_kid, then aud_mismatch, srv_mismatch, sub_mismatch, hnd_mismatch, act_mismatch, pid_mismatch, pdg_mismatch, crq_mismatch, exp_mismatch in that order, expired (now >= exp), decryption_failed (any failure to decrypt and authenticate, the protected header segment as sent being the AAD), plaintext_invalid, value_too_long, and last replayed: the check remembers (hnd, crq) until exp only after everything else passed, and refuses a pair it remembers. After an ok case, opening the same jwe again (same memory) is replayed.",
  "seal[]: what a client must produce: seal values to the key's publicJwk with binding (handle is the handle string binding.hnd hashes). bindingInputs is what the client has (handle, serverId, userId, appClientKey = the read's app.client_key, actionId, prepared = the prepare answer's {id, digest} or null, clientRequestId, handleExp = the action's handle_exp); building the binding from it must give binding exactly. Ciphertexts are randomized, so conformance is a round trip: the client's JWE has exactly header as its protected header apart from epk, and the reference check (the key's privateJwk, claims, now) opens it to values. A client should also decrypt the open[] cases whose expect is ok with the private key, for its library's interop.",
].join("\n");

export async function buildSealedInputsVectors(): Promise<SealedInputsVectors> {
  const open: SealedInputsOpenCase[] = [];
  const add = (c: Omit<SealedInputsOpenCase, "keys" | "claims" | "now" | "accepted"> & Partial<SealedInputsOpenCase>) =>
    open.push({ name: c.name, note: c.note, jwe: c.jwe, keys: c.keys ?? APP_KEYS, claims: c.claims ?? claimsFor(BINDING), now: c.now ?? NOW, accepted: c.accepted ?? [], expect: c.expect });
  const ok = (values: Record<string, string>) => ({ ok: true as const, values });
  const refused = (reason: SealedInputsRefusal) => ({ ok: false as const, reason });
  const sealValues = (name: string, values: unknown, to = KEY_A, header = headerOf(to)) => sealFixed(name, to, header, json(values));

  const base = await sealValues("base", { value: "sk-test-0123456789abcdef" });
  add({ name: "ok_one_secret", note: "One SecretInput, sealed to the key in force.", jwe: base, expect: ok({ value: "sk-test-0123456789abcdef" }) });
  const unicode = { token: "pässwörd ✓ 🔑", value: "汉字 and \"quotes\" \\ back" };
  add({ name: "ok_two_secrets_unicode", note: "Two SecretInputs with non-ASCII, quotes and a backslash.", jwe: await sealValues("ok_two_secrets_unicode", unicode), expect: ok(unicode) });
  add({ name: "ok_no_values", note: "Every SecretInput left empty and omitted: an empty object opens.", jwe: await sealValues("ok_no_values", {}), expect: ok({}) });
  add({ name: "ok_empty_string", note: "A SecretInput left empty and sent as \"\".", jwe: await sealValues("ok_empty_string", { value: "" }), expect: ok({ value: "" }) });
  const atCap = "€".repeat(1365) + "a";
  add({ name: "ok_value_at_cap", note: "A value of exactly 4096 UTF-8 bytes (1366 code points): bytes are counted, not characters.", jwe: await sealValues("ok_value_at_cap", { value: atCap }), expect: ok({ value: atCap }) });
  add({ name: "ok_second_key", note: "Sealed to the App's other key; the kid picks it.", jwe: await sealValues("ok_second_key", { value: "b" }, KEY_B), expect: ok({ value: "b" }) });
  add({ name: "ok_last_second", note: "now is exp - 1: still open.", jwe: base, now: HANDLE_EXP - 1, expect: ok({ value: "sk-test-0123456789abcdef" }) });

  const withoutHandleSha = claimsFor(BINDING);
  delete withoutHandleSha.handle_sha256;
  add({ name: "claims_without_handle_sha256", note: "The JWT's payload has no handle_sha256 (not an RFC 086 execute JWT).", jwe: base, claims: withoutHandleSha, expect: refused("claims_invalid") });
  add({ name: "claims_link_preview_audience", note: "The JWT's aud is not a card action audience.", jwe: base, claims: { ...claimsFor(BINDING), aud: `urn:raft:link-preview:${CLIENT_ID}` }, expect: refused("claims_invalid") });

  add({ name: "malformed_three_segments", note: "Not a JWE compact string.", jwe: base.split(".").slice(0, 3).join("."), expect: refused("malformed") });
  add({ name: "malformed_header_not_json", note: "The protected header segment is not JSON.", jwe: withSegment(base, 0, () => Buffer.from("not json", "utf8")), expect: refused("malformed") });
  const big = { a: "x".repeat(3000), b: "y".repeat(3000) };
  add({ name: "malformed_over_8_kib", note: "A well-formed JWE over 8192 characters (Raft refuses it on execute already).", jwe: await sealValues("malformed_over_8_kib", big), expect: refused("malformed") });
  add({ name: "compression_zip", note: "zip in the header (the header rewritten; refused before any decryption).", jwe: rewriteHeader(base, (h) => ({ ...h, zip: "DEF" })), expect: refused("compression_not_allowed") });
  add({ name: "alg_ecdh_es_a256kw", note: "alg ECDH-ES+A256KW (a real JWE, with an encrypted key).", jwe: await sealFixed("alg_ecdh_es_a256kw", KEY_A, { ...headerOf(KEY_A), alg: "ECDH-ES+A256KW" }, json({ value: "x" })), expect: refused("unsupported_algorithm") });
  add({ name: "enc_a128gcm", note: "enc A128GCM (a real JWE).", jwe: await sealFixed("enc_a128gcm", KEY_A, { ...headerOf(KEY_A), enc: "A128GCM" }, json({ value: "x" })), expect: refused("unsupported_algorithm") });
  add({ name: "unknown_kid", note: "Sealed to a key the App doesn't hold.", jwe: await sealValues("unknown_kid", { value: "x" }, KEY_C), expect: refused("unknown_kid") });
  add({ name: "kid_dropped_after_rotation", note: "Sealed to key A after the App rotated to B and dropped A (fails closed, §5.2).", jwe: base, keys: [KEY_B.publicJwk.kid], expect: refused("unknown_kid") });

  const other: Record<(typeof BOUND_FIELDS)[number], Partial<SealedInputsBinding>> = {
    aud: { aud: "app_other_client" }, srv: { srv: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5" }, sub: { sub: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b" },
    hnd: { hnd: sha256Hex(`${HANDLE}-another`) }, act: { act: "delete_key" }, pid: { pid: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b" },
    pdg: { pdg: sha256Hex("another prepared description") }, crq: { crq: "crq-test-2026-11-14-0002" }, exp: { exp: HANDLE_EXP + 60 },
  };
  for (const field of BOUND_FIELDS) {
    add({ name: `${field}_mismatch`, note: `The execute JWT names another ${field} than the header (the ciphertext moved to another request).`, jwe: base,
      claims: claimsFor({ ...BINDING, ...other[field] }), expect: refused(`${field}_mismatch`) });
  }
  const { pid: _pid, pdg: _pdg, ...unconfirmed } = BINDING;
  add({ name: "pid_missing_from_header", note: "The header has no pid / pdg; the JWT names a prepared action.", jwe: await sealValues("pid_missing_from_header", { value: "x" }, KEY_A, headerOf(KEY_A, unconfirmed)), expect: refused("pid_mismatch") });
  add({ name: "exp_as_string", note: "The header's exp is the string of the right number.", jwe: rewriteHeader(base, (h) => ({ ...h, exp: String(h.exp) })), expect: refused("exp_mismatch") });
  add({ name: "expired", note: "now equals exp. A legitimate press can get here (the handle expired between Raft admitting the execute and the App's check): the App answers the person \"try again\".", jwe: base, now: HANDLE_EXP, expect: refused("expired") });

  add({ name: "tampered_ciphertext", note: "A ciphertext bit flipped.", jwe: withSegment(base, 3, flipLastBit), expect: refused("decryption_failed") });
  add({ name: "tampered_tag", note: "A tag bit flipped.", jwe: withSegment(base, 4, flipLastBit), expect: refused("decryption_failed") });
  add({ name: "tampered_iv", note: "An IV bit flipped.", jwe: withSegment(base, 2, flipLastBit), expect: refused("decryption_failed") });
  add({ name: "tampered_header_reencoded", note: "The header re-encoded with the same members in another order: every comparison passes, the AAD differs.",
    jwe: rewriteHeader(base, (h) => Object.fromEntries(Object.entries(h).reverse())), expect: refused("decryption_failed") });
  add({ name: "tampered_header_rebound", note: "The header rewritten to another action, with a JWT for that action: the binding is authenticated, so it fails.",
    jwe: rewriteHeader(base, (h) => ({ ...h, act: "delete_key" })), claims: claimsFor({ ...BINDING, act: "delete_key" }), expect: refused("decryption_failed") });
  add({ name: "sealed_to_another_key", note: "The header names key A, but the value was sealed to key B.", jwe: await sealFixed("sealed_to_another_key", KEY_B, headerOf(KEY_A), json({ value: "x" })), expect: refused("decryption_failed") });

  add({ name: "plaintext_array", note: "The plaintext is a JSON array.", jwe: await sealValues("plaintext_array", ["x"]), expect: refused("plaintext_invalid") });
  add({ name: "plaintext_number_value", note: "A value is a number.", jwe: await sealValues("plaintext_number_value", { value: 1 }), expect: refused("plaintext_invalid") });
  add({ name: "plaintext_nested_object", note: "A value is an object.", jwe: await sealValues("plaintext_nested_object", { value: { inner: "x" } }), expect: refused("plaintext_invalid") });
  add({ name: "plaintext_not_json", note: "The plaintext is not JSON.", jwe: await sealFixed("plaintext_not_json", KEY_A, headerOf(KEY_A), new TextEncoder().encode("value=x")), expect: refused("plaintext_invalid") });
  add({ name: "plaintext_not_utf8", note: "The plaintext is not UTF-8.", jwe: await sealFixed("plaintext_not_utf8", KEY_A, headerOf(KEY_A), Uint8Array.from([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), expect: refused("plaintext_invalid") });
  add({ name: "value_over_cap", note: "A value of 4097 UTF-8 bytes (1367 code points).", jwe: await sealValues("value_over_cap", { value: "€".repeat(1365) + "ab" }), expect: refused("value_too_long") });

  add({ name: "replayed", note: "The same (hnd, crq) was accepted before: a second delivery of the same ciphertext.", jwe: base,
    accepted: [{ hnd: BINDING.hnd, crq: BINDING.crq, exp: BINDING.exp }], expect: refused("replayed") });

  const sealCase = (name: string, note: string, to: SealedInputsVectorKey, values: Record<string, string>): SealedInputsSealCase =>
    ({ name, note, key: to.publicJwk.kid, handle: HANDLE, bindingInputs: BINDING_INPUTS, binding: BINDING, values, header: headerOf(to), claims: claimsFor(BINDING), now: NOW });
  const seal = [
    sealCase("seal_one_secret", "One SecretInput.", KEY_A, { value: "sk-test-0123456789abcdef" }),
    sealCase("seal_unicode", "Non-ASCII, quotes and a backslash.", KEY_A, unicode),
    sealCase("seal_value_at_cap", "A value of exactly 4096 UTF-8 bytes.", KEY_A, { value: atCap }),
    sealCase("seal_no_values", "Every SecretInput left empty.", KEY_A, {}),
    sealCase("seal_second_key", "To the App's other key.", KEY_B, { value: "b" }),
  ];

  return {
    contract: "sealed-inputs.v1", schemaVersion: 1, testOnly: true,
    warning: "TEST ONLY: every key here, private ones included, is published. Never register, accept or seal real values to them.",
    notes: NOTES,
    generator: "pnpm --filter @botiverse/raft-shared generate:sealed-inputs-vectors",
    keys: KEYS, open, seal,
  };
}

/** The file's exact text. */
export async function sealedInputsVectorText(): Promise<string> {
  return `${JSON.stringify(await buildSealedInputsVectors(), null, 2)}\n`;
}
