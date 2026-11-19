// The shared sealing vectors (RFC 086 §5.3; sealedInputs.v1.vector.json) against
// the one implementation (sealedInputs.ts, which @botiverse/raft-sdk/app
// re-exports): every open case gives its result, every seal case's binding
// is what sealedInputsBinding builds from the client's inputs and round-trips
// through the check, and the committed file is what the generator writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { decodeProtectedHeader } from "jose";
import { appCardEncryptionKeySchema, type AppCardEncryptionKey } from "./appLinkPreview";
import { MESSAGE_CARD_FORM_LIMITS, MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES, MESSAGE_CARD_SEALED_INPUTS_PATTERN } from "./messageCardActions";
import {
  createSealedInputsMemory, JWE_COMPACT, openSealedInputs, sealedInputsBinding, sealInputs, SEALED_INPUTS_MAX_BYTES, SECRET_INPUT_MAX_BYTES,
  type SealedInputsBindingInputs, type SealedInputsPublicJwk,
} from "./sealedInputs";
import {
  SEALED_INPUTS_VECTOR_PATH, SEALED_INPUTS_VECTOR_SHA256_PATH, sealedInputsVectorText,
  type SealedInputsOpenCase, type SealedInputsVectors,
} from "./sealedInputsVectors.testkit";

const committed = readFileSync(SEALED_INPUTS_VECTOR_PATH, "utf8");
const vectors = JSON.parse(committed) as SealedInputsVectors;
const privateKeys = (kids: readonly string[]) => kids.map((kid) => {
  const key = vectors.keys.find((k) => k.publicJwk.kid === kid);
  assert.ok(key, `vector key ${kid}`);
  return key.privateJwk;
});
const at = (seconds: number) => new Date(seconds * 1000);

async function open(c: SealedInputsOpenCase, memory = createSealedInputsMemory({ now: () => at(c.now) })) {
  for (const delivery of c.accepted) assert.equal(memory.remember(delivery), true);
  return openSealedInputs({ jwe: c.jwe, keys: privateKeys(c.keys), claims: c.claims, now: at(c.now), remember: memory.remember });
}

test("the committed vectors are what the generator writes, and the .sha256 pins them (re-run generate:sealed-inputs-vectors and tell web, mobile and Vault)", async () => {
  assert.equal(await sealedInputsVectorText(), committed);
  const [sha, name] = readFileSync(SEALED_INPUTS_VECTOR_SHA256_PATH, "utf8").trim().split(/\s+/);
  assert.equal(name, "sealedInputs.v1.vector.json");
  assert.equal(createHash("sha256").update(committed, "utf8").digest("hex"), sha);
});

test("the file says at its top that its keys are test-only", () => {
  assert.equal(vectors.testOnly, true);
  assert.match(vectors.warning, /^TEST ONLY: .*Never register/);
  assert.deepEqual(Object.keys(vectors).slice(0, 4), ["contract", "schemaVersion", "testOnly", "warning"]);
});

test("every open case gives its expected result", async () => {
  assert.ok(vectors.open.length > 0);
  for (const c of vectors.open) assert.deepEqual(await open(c), c.expect, c.name);
});

test("every ok case is refused as replayed when the same ciphertext is delivered again", async () => {
  for (const c of vectors.open.filter((v) => v.expect.ok)) {
    const memory = createSealedInputsMemory({ now: () => at(c.now) });
    assert.equal((await open(c, memory)).ok, true, c.name);
    assert.deepEqual(await open({ ...c, accepted: [] }, memory), { ok: false, reason: "replayed" }, c.name);
  }
});

test("the refusal cases cover every reason the check gives, and each bound member once", () => {
  const reasons = new Set(vectors.open.flatMap((c) => (c.expect.ok ? [] : [c.expect.reason])));
  for (const reason of [
    "claims_invalid", "malformed", "compression_not_allowed", "unsupported_algorithm", "unknown_kid",
    "aud_mismatch", "srv_mismatch", "sub_mismatch", "hnd_mismatch", "act_mismatch", "pid_mismatch", "pdg_mismatch", "crq_mismatch", "exp_mismatch",
    "expired", "decryption_failed", "plaintext_invalid", "value_too_long", "replayed",
  ]) assert.ok(reasons.has(reason as never), `a case refused with ${reason}`);
});

test("sealedInputsBinding builds each seal case's binding from the case's client inputs", async () => {
  assert.ok(vectors.seal.length > 0);
  for (const c of vectors.seal) {
    assert.equal(c.bindingInputs.handle, c.handle, c.name);
    assert.equal(createHash("sha256").update(c.handle, "utf8").digest("hex"), c.binding.hnd, `${c.name}: hnd is the handle's SHA-256`);
    const binding = await sealedInputsBinding(c.bindingInputs);
    assert.deepEqual(binding, c.binding, c.name);
    assert.deepEqual(Object.keys(binding), Object.keys(c.binding), `${c.name}: in the header's order`);
  }
});

test("sealedInputsBinding without a confirmation leaves pid and pdg out, and refuses what the App would", async () => {
  const inputs: SealedInputsBindingInputs = vectors.seal[0]!.bindingInputs;
  const { pid: _pid, pdg: _pdg, ...unconfirmed } = vectors.seal[0]!.binding;
  assert.deepEqual(await sealedInputsBinding({ ...inputs, prepared: null }), unconfirmed);
  for (const bad of [{ handle: "" }, { appClientKey: "" }, { clientRequestId: "" }, { handleExp: 1.5 }, { handleExp: "1794700800" }, { prepared: { id: "p", digest: "" } }, { prepared: undefined }]) {
    await assert.rejects(sealedInputsBinding({ ...inputs, ...bad } as never), TypeError, JSON.stringify(bad));
  }
});

test("seal round-trips: a fresh JWE with exactly the case's header (but epk) that the reference check opens to the values", async () => {
  for (const c of vectors.seal) {
    const key = vectors.keys.find((k) => k.publicJwk.kid === c.key)!;
    const binding = await sealedInputsBinding(c.bindingInputs);
    const jwe = await sealInputs({ key: key.publicJwk, binding, values: c.values });
    const again = await sealInputs({ key: key.publicJwk, binding, values: c.values });
    assert.notEqual(jwe, again, `${c.name}: a fresh ephemeral key and IV each time`);
    assert.equal(jwe.split(".")[1], "", "no encrypted key under ECDH-ES");
    const { epk, ...header } = decodeProtectedHeader(jwe);
    assert.ok(epk, c.name);
    assert.deepEqual(header, c.header, c.name);
    const opened = await openSealedInputs({ jwe, keys: [key.privateJwk], claims: c.claims, now: at(c.now), remember: createSealedInputsMemory().remember });
    assert.deepEqual(opened, { ok: true, values: c.values }, c.name);
  }
});

test("sealInputs refuses what a device must not send", async () => {
  const { publicJwk } = vectors.keys[0]!;
  const binding = vectors.seal[0]!.binding;
  await assert.rejects(sealInputs({ key: publicJwk, binding, values: { value: "a".repeat(4097) } }), TypeError);
  await assert.rejects(sealInputs({ key: publicJwk, binding, values: { value: 1 } as never }), TypeError);
  await assert.rejects(sealInputs({ key: { ...publicJwk, alg: "ECDH-ES+A256KW" } as never, binding, values: {} }), TypeError);
});

test("the memory forgets a delivery once its handle expired", () => {
  let now = 1000;
  const memory = createSealedInputsMemory({ now: () => at(now) });
  assert.equal(memory.remember({ hnd: "h", crq: "c", exp: 1010 }), true);
  assert.equal(memory.remember({ hnd: "h", crq: "c", exp: 1010 }), false);
  assert.equal(memory.remember({ hnd: "h", crq: "d", exp: 1010 }), true, "another crq is another delivery");
  now = 1010;
  assert.equal(memory.remember({ hnd: "h", crq: "c", exp: 1020 }), true);
});

test("the vectors' public keys are what Raft stores, and the SDK's limits are shared's", () => {
  for (const { publicJwk } of vectors.keys) assert.equal(appCardEncryptionKeySchema.safeParse(publicJwk).success, true, publicJwk.kid);
  const sameShape: SealedInputsPublicJwk = {} as AppCardEncryptionKey;
  void sameShape;
  assert.equal(SECRET_INPUT_MAX_BYTES, MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes);
  assert.equal(SEALED_INPUTS_MAX_BYTES, MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES);
  assert.equal(JWE_COMPACT.source, MESSAGE_CARD_SEALED_INPUTS_PATTERN.source);
});

// The web seals with this same module. Shared has no browser test environment
// (jsdom has no SubtleCrypto either), so the browser path is checked as what
// it depends on: the module imports nothing but jose, jose resolves to its one
// WebCrypto build (the one a browser bundle gets), and a seal and open with a
// key made by globalThis.crypto.subtle, nothing from node:crypto, round-trips.
test("the browser path: only jose's WebCrypto build, and seal then open on globalThis.crypto.subtle alone", async () => {
  const source = readFileSync(fileURLToPath(new URL("./sealedInputs.ts", import.meta.url)), "utf8");
  const imports = [...source.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map((m) => m[1]);
  assert.deepEqual(imports, ["jose"]);
  assert.doesNotMatch(source, /\bBuffer\b|\brequire\(|\bprocess\./);
  const jose = createRequire(import.meta.url).resolve("jose");
  assert.match(jose, /[\\/]jose[\\/]dist[\\/]webapi[\\/]index\.js$/);

  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const { kty, crv, x, y, d } = await subtle.exportKey("jwk", pair.privateKey);
  const key = { kty, crv, use: "enc", alg: "ECDH-ES", kid: "browser-path", x, y } as SealedInputsPublicJwk;
  const inputs = { ...vectors.seal[0]!.bindingInputs, handle: "v1.browser-path-handle" };
  const binding = await sealedInputsBinding(inputs);
  const jwe = await sealInputs({ key, binding, values: { value: "from the web" } });
  const claims = {
    aud: `urn:raft:card-action:${binding.aud}`, sub: binding.sub, server_id: binding.srv, handle_sha256: binding.hnd, action_id: binding.act,
    prepared_action_id: binding.pid, prepared_digest: binding.pdg, client_request_id: binding.crq, handle_exp: binding.exp,
  };
  const opened = await openSealedInputs({ jwe, keys: [{ ...key, d: d! }], claims, now: at(binding.exp - 60), remember: createSealedInputsMemory().remember });
  assert.deepEqual(opened, { ok: true, values: { value: "from the web" } });
});
