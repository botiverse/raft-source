// antiproton's approval hint, verified (docs/contracts/hosted-agent-approvals.md):
// an Ed25519 signature of "<timestamp>.<raw body>" under the public key its
// key id names, from the configured keys of a target; the same 300 s window as
// before; the canary with keys of its own; a bad key value refused whole. The
// route's own tests are routes/antiprotonApprovals.api.test.ts.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, vi } from "vitest";
import { ed25519PublicKeyProblem } from "../lib/ed25519PublicKey";
import {
  ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV,
  ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV,
  APPROVAL_HINT_MAX_SKEW_SECONDS,
  approvalTargetConfig,
  configuredApprovalTargets,
  parseApprovalHintPublicKeys,
  parseApprovalHintSignature,
  verifyApprovalHint,
  type ApprovalHintVerdict,
} from "./agentRuntimeApprovalService";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test vectors: the configured keys, the headers and the raw body as they go
// over the wire, and whether the signature counts.
//
// antiproton's vector (botiverse/antiproton#1164, docs/raft-approvals.md) is
// copied verbatim below: the same bytes antiproton's own tests sign. The other
// rows are Raft's own, made with node:crypto from the RFC 8032 §7.1 TEST 1 and
// TEST 2 key pairs (whose private keys are public: never configure them); the
// antiproton vector's private key is a test key too.

interface HintVector {
  name: string;
  /** The ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS value. */
  publicKeys: string;
  /** X-Antiproton-Timestamp; the vector is checked at this time. */
  timestamp: string;
  /** The raw body, as UTF-8. */
  body: string;
  /** X-Antiproton-Signature. */
  signature: string;
  accepted: boolean;
  /** Hex Ed25519 seeds by key id, when the vector gives them: each accepted row is re-signed with its key id's seed. */
  seeds?: Record<string, string>;
}

const VECTOR_SEEDS = {
  "raft-test-1": "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "raft-test-2": "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
};
const VECTOR_KEYS = '{"raft-test-1":"11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","raft-test-2":"PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="}';
const VECTOR_BODY_1 = '{"type":"approval.requested","operationId":"op_vector_1","raftAgentId":"0b1e7c4e-1d2a-4f6b-9c3d-5e7f8a9b0c1d","raftServerId":"5c0a8f2e-7b4d-4e19-a6c3-2d9e8f1b7a40"}';
const VECTOR_BODY_2 = '{"type":"approval.decided","operationId":"op_vector_2","raftAgentId":"0b1e7c4e-1d2a-4f6b-9c3d-5e7f8a9b0c1d","raftServerId":"5c0a8f2e-7b4d-4e19-a6c3-2d9e8f1b7a40","note":"décidé ✓"}';
const VECTOR_SIGNATURE_1 = "keyid=raft-test-1; ed25519=WKHH84Fi2jknGLBtIFj46ErtqXvo0bUNhY46sIQMG8pj4r4PiovY3yjpmx8O0/1ws38/578rela5jqEkX6qdCg==";

const ANTIPROTON_VECTOR_KEYS = '{"ed95939c506fd5c5":"Qh0z7hW/fenoBF+qTen6HVDqIJuJq6qUsKmxxpTeaZk="}';
const ANTIPROTON_VECTOR_BODY = '{"type":"approval.requested","operationId":"op_test_vector","providerAgentId":"raft_01TESTVECTOR","raftAgentId":"01TESTVECTOR","raftServerId":"srv-test","status":"pending"}';
const ANTIPROTON_VECTOR_SIGNATURE = "keyid=ed95939c506fd5c5; ed25519=HKqyRp+2SGY4L0Fpdl3JGP4j+vGq0JWTbPUYwBJpqy+VFJjTTPC47vonSyDQoU42C0MzEIW08bQ0pex6eU4CBQ==";
const ANTIPROTON_VECTOR_SEEDS = { ed95939c506fd5c5: "c7fab0ce7c9378d8c68e787384d9ee503f6a36fa61534f85e624db0620f6ea6c" };

const HINT_VECTORS: HintVector[] = [
  {
    name: "antiproton's published vector (antiproton#1164) verifies",
    publicKeys: ANTIPROTON_VECTOR_KEYS, timestamp: "1767225600", body: ANTIPROTON_VECTOR_BODY, signature: ANTIPROTON_VECTOR_SIGNATURE,
    accepted: true, seeds: ANTIPROTON_VECTOR_SEEDS,
  },
  {
    name: "antiproton's vector with one byte of its body changed",
    publicKeys: ANTIPROTON_VECTOR_KEYS, timestamp: "1767225600", body: ANTIPROTON_VECTOR_BODY.replace("pending", "Pending"), signature: ANTIPROTON_VECTOR_SIGNATURE,
    accepted: false,
  },
  {
    name: "raft-test-1 signs a hint",
    publicKeys: VECTOR_KEYS, timestamp: "1793836800", body: VECTOR_BODY_1, signature: VECTOR_SIGNATURE_1, accepted: true, seeds: VECTOR_SEEDS,
  },
  {
    name: "raft-test-2, the second key during a rotation, signs a body with non-ASCII text",
    publicKeys: VECTOR_KEYS, timestamp: "1793836860", body: VECTOR_BODY_2,
    signature: "keyid=raft-test-2; ed25519=fzzaPnVy1lzdS4/H4HIk3HMJaqdR0axeFIFZ7tWMI2Xhccm3BZL3K1rGpOuH7mR7PK6tBsoT6HVZciqgAUU5BQ==",
    accepted: true, seeds: VECTOR_SEEDS,
  },
  {
    name: "raft-test-1's signature named as raft-test-2's",
    publicKeys: VECTOR_KEYS, timestamp: "1793836860", body: VECTOR_BODY_2,
    signature: "keyid=raft-test-2; ed25519=j7uXFZiMe0rzxkGmT9s7MVNdk70KvuJ9MKlqNU3mCQ2MnuyRVBAoExZ6bzBlkozn9ma3u4XeoblzXNDQgEYJCA==",
    accepted: false, seeds: VECTOR_SEEDS,
  },
  {
    name: "the first vector with its body changed",
    publicKeys: VECTOR_KEYS, timestamp: "1793836800", body: VECTOR_BODY_1.replace("op_vector_1", "op_vector_9"), signature: VECTOR_SIGNATURE_1, accepted: false,
  },
  {
    name: "the first vector with its timestamp changed",
    publicKeys: VECTOR_KEYS, timestamp: "1793836801", body: VECTOR_BODY_1, signature: VECTOR_SIGNATURE_1, accepted: false,
  },
  {
    name: "the first vector, its key id not configured",
    publicKeys: '{"raft-test-2":"PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="}', timestamp: "1793836800", body: VECTOR_BODY_1, signature: VECTOR_SIGNATURE_1, accepted: false,
  },
];

const PKCS8_ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const privateKeyFromSeed = (seedHex: string) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });

test("the test vectors: each signature counts exactly when the vector says", () => {
  for (const vector of HINT_VECTORS) {
    assert.equal(parseApprovalHintPublicKeys(vector.publicKeys).ok, true, `${vector.name}: its keys are a valid config value`);
    const verdict = verifyApprovalHint({
      body: Buffer.from(vector.body, "utf8"),
      timestamp: vector.timestamp,
      signature: vector.signature,
      nowMs: Number(vector.timestamp) * 1000,
      env: { ...PROVIDERS, [ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV]: vector.publicKeys },
    });
    // A vector's body need not name a Raft agent: past the signature, that is a 400, not a 401.
    const signatureCounted = verdict.ok || verdict.code === "approval_hint_invalid";
    assert.equal(signatureCounted, vector.accepted, `${vector.name}: ${JSON.stringify(verdict)}`);
    if (!vector.accepted) assert.deepEqual(verdict, SIGNATURE_INVALID, vector.name);
  }
});

test("the test vectors' keys and accepted signatures are what their seeds make", () => {
  for (const vector of HINT_VECTORS.filter((row) => row.seeds)) {
    const parsed = parseApprovalHintPublicKeys(vector.publicKeys);
    assert.ok(parsed.ok);
    for (const key of parsed.keys) {
      const seed = vector.seeds![key.keyId];
      assert.ok(seed, `${vector.name}: a seed for ${key.keyId}`);
      assert.equal(rawOf(createPublicKey(privateKeyFromSeed(seed))), key.raw.toString("base64"), `${vector.name}: ${key.keyId}`);
    }
    if (!vector.accepted) continue;
    const header = parseApprovalHintSignature(vector.signature)!;
    const resigned = sign(null, Buffer.from(`${vector.timestamp}.${vector.body}`, "utf8"), privateKeyFromSeed(vector.seeds![header.keyId]!));
    assert.equal(resigned.toString("base64"), header.signature.toString("base64"), vector.name);
  }
});

// ---------------------------------------------------------------------------
// Behaviour

const AGENT = "0b1e7c4e-1d2a-4f6b-9c3d-5e7f8a9b0c1d";
const SERVER = "5c0a8f2e-7b4d-4e19-a6c3-2d9e8f1b7a40";
/** Both targets' provider configured (canary: staging only). */
const PROVIDERS = { DEPLOYMENT_ENV: "staging", ANTIPROTON_PROVISIONING_TOKEN: "pt-default", ANTIPROTON_CANARY_PROVISIONING_TOKEN: "pt-canary" };
const NOW_S = 1_793_836_800;
const BODY = JSON.stringify({ type: "approval.requested", operationId: "op_1", raftAgentId: AGENT, raftServerId: SERVER });

const rawOf = (publicKey: KeyObject) => Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawOf(publicKey) };
}
const K1 = keyPair();
const K2 = keyPair();
const C1 = keyPair();
const STRANGER = keyPair();

const DEFAULT_ACCEPTED: ApprovalHintVerdict = { ok: true, target: "default", raftAgentId: AGENT, raftServerId: SERVER };
const CANARY_ACCEPTED: ApprovalHintVerdict = { ok: true, target: "canary", raftAgentId: AGENT, raftServerId: SERVER };
const SIGNATURE_INVALID: ApprovalHintVerdict = { ok: false, status: 401, code: "approval_hint_signature_invalid" };
const TIMESTAMP_INVALID: ApprovalHintVerdict = { ok: false, status: 401, code: "approval_hint_timestamp_invalid" };
const NOT_FOUND: ApprovalHintVerdict = { ok: false, status: 404, code: "not_found" };

function envWith(keys: { default?: Record<string, string> | string; canary?: Record<string, string> | string; extra?: Record<string, string> }): NodeJS.ProcessEnv {
  const value = (v: Record<string, string> | string | undefined) => (typeof v === "string" ? v : v ? JSON.stringify(v) : undefined);
  return {
    ...PROVIDERS,
    ...(keys.default !== undefined ? { [ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV]: value(keys.default) } : {}),
    ...(keys.canary !== undefined ? { [ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV]: value(keys.canary) } : {}),
    ...keys.extra,
  };
}

const ONE_KEY = envWith({ default: { k1: K1.raw } });

function signatureHeader(keyId: string, privateKey: KeyObject, timestamp: string | number, body: string): string {
  return `keyid=${keyId}; ed25519=${sign(null, Buffer.from(`${timestamp}.${body}`, "utf8"), privateKey).toString("base64")}`;
}

/** A hint signed with `key` under `keyId` at `signedTs` over `signedBody`, sent with `ts` and `body`, checked at `nowS`. */
function hint(env: NodeJS.ProcessEnv, options: {
  keyId?: string; key?: KeyObject; ts?: number | string; signedTs?: number | string; body?: string; signedBody?: string; signature?: string; nowS?: number;
} = {}): ApprovalHintVerdict {
  const ts = options.ts ?? NOW_S;
  const body = options.body ?? BODY;
  const signature = options.signature
    ?? signatureHeader(options.keyId ?? "k1", options.key ?? K1.privateKey, options.signedTs ?? ts, options.signedBody ?? body);
  return verifyApprovalHint({ body: Buffer.from(body, "utf8"), timestamp: String(ts), signature, nowMs: (options.nowS ?? NOW_S) * 1000, env });
}

test("a signature by the key its key id names is accepted, for that key's target", () => {
  assert.deepEqual(hint(ONE_KEY), DEFAULT_ACCEPTED);
  const upper = JSON.stringify({ raftAgentId: AGENT.toUpperCase(), raftServerId: SERVER.toUpperCase() });
  assert.deepEqual(hint(ONE_KEY, { body: upper }), DEFAULT_ACCEPTED, "ids lowercased as before");
  const notIds = JSON.stringify({ raftAgentId: "nope", raftServerId: SERVER });
  assert.deepEqual(hint(ONE_KEY, { body: notIds }), { ok: false, status: 400, code: "approval_hint_invalid" }, "signed, but not ids: 400 as before");
});

test("a signature by another key under a configured key id is refused", () => {
  assert.deepEqual(hint(ONE_KEY, { key: STRANGER.privateKey }), SIGNATURE_INVALID);
  assert.deepEqual(hint(ONE_KEY, { key: K2.privateKey }), SIGNATURE_INVALID);
});

test("an unknown key id is refused without trying the other keys, even when one of them made the signature", () => {
  // K1 made each of these signatures and is configured as k1: trying any other key, or every key, would accept them.
  assert.deepEqual(hint(ONE_KEY, { keyId: "k9" }), SIGNATURE_INVALID, "a key id not configured");
  const two = envWith({ default: { k1: K1.raw, k2: K2.raw } });
  assert.deepEqual(hint(two, { keyId: "k2" }), SIGNATURE_INVALID, "another configured key id: only the key it names is tried");
  const withCanary = envWith({ default: { k1: K1.raw }, canary: { c1: C1.raw } });
  assert.deepEqual(hint(withCanary, { keyId: "c1" }), SIGNATURE_INVALID, "the canary's key id: only the canary's key is tried");
  assert.deepEqual(hint(withCanary, { keyId: "K1" }), SIGNATURE_INVALID, "key ids are compared exactly");
});

test("rotation: two key ids at once both count, and a retired one stops", () => {
  const both = envWith({ default: { k1: K1.raw, k2: K2.raw } });
  assert.deepEqual(hint(both, { keyId: "k1", key: K1.privateKey }), DEFAULT_ACCEPTED, "the old key");
  assert.deepEqual(hint(both, { keyId: "k2", key: K2.privateKey }), DEFAULT_ACCEPTED, "the new key");
  const retired = envWith({ default: { k2: K2.raw } });
  assert.deepEqual(hint(retired, { keyId: "k1", key: K1.privateKey }), SIGNATURE_INVALID, "the old key, retired");
  assert.deepEqual(hint(retired, { keyId: "k2", key: K2.privateKey }), DEFAULT_ACCEPTED);
});

test("a changed body or timestamp is refused", () => {
  assert.deepEqual(hint(ONE_KEY, { signedBody: BODY.replace("op_1", "op_2") }), SIGNATURE_INVALID, "another body");
  assert.deepEqual(hint(ONE_KEY, { body: `${BODY} `, signedBody: BODY }), SIGNATURE_INVALID, "a byte added to the body");
  assert.deepEqual(hint(ONE_KEY, { body: BODY.replace("op_1", "op_2"), signedBody: BODY }), SIGNATURE_INVALID, "the body changed after signing");
  assert.deepEqual(hint(ONE_KEY, { ts: NOW_S, signedTs: NOW_S - 1 }), SIGNATURE_INVALID, "another timestamp, still in the window");
  assert.deepEqual(hint(ONE_KEY, { signature: `keyid=k1; ed25519=${sign(null, Buffer.from(BODY), K1.privateKey).toString("base64")}` }), SIGNATURE_INVALID, "the body signed without the timestamp");
  assert.deepEqual(hint(ONE_KEY, { signature: `keyid=k1; ed25519=${sign(null, Buffer.from(`${NOW_S}${BODY}`), K1.privateKey).toString("base64")}` }), SIGNATURE_INVALID, "no dot between them");
});

test("the timestamp window is the same as before: 300 s either way, checked before the signature", () => {
  assert.equal(APPROVAL_HINT_MAX_SKEW_SECONDS, 300);
  assert.deepEqual(hint(ONE_KEY, { ts: NOW_S - 300 }), DEFAULT_ACCEPTED, "300 s old");
  assert.deepEqual(hint(ONE_KEY, { ts: NOW_S + 300 }), DEFAULT_ACCEPTED, "300 s ahead");
  assert.deepEqual(hint(ONE_KEY, { ts: NOW_S - 301 }), TIMESTAMP_INVALID, "301 s old");
  assert.deepEqual(hint(ONE_KEY, { ts: NOW_S + 301 }), TIMESTAMP_INVALID, "301 s ahead");
  for (const ts of ["", " ", "-1", "1793836800.5", "0x6aeb5000", "1e9", "1793836800000", "١٧٩٣٨٣٦٨٠٠"]) {
    assert.deepEqual(hint(ONE_KEY, { ts }), TIMESTAMP_INVALID, JSON.stringify(ts));
  }
  assert.deepEqual(verifyApprovalHint({ body: Buffer.from(BODY), timestamp: undefined, signature: signatureHeader("k1", K1.privateKey, NOW_S, BODY), nowMs: NOW_S * 1000, env: ONE_KEY }), TIMESTAMP_INVALID, "no timestamp");
  assert.deepEqual(hint(ONE_KEY, { ts: NOW_S - 301, signature: "nonsense" }), TIMESTAMP_INVALID, "a stale timestamp is reported before a bad signature");
});

test("replay: as before, only the signed timestamp bounds it (a hint names what to pull, nothing more)", () => {
  const headers = { ts: NOW_S, signature: signatureHeader("k1", K1.privateKey, NOW_S, BODY) };
  assert.deepEqual(hint(ONE_KEY, headers), DEFAULT_ACCEPTED, "first delivery");
  assert.deepEqual(hint(ONE_KEY, { ...headers, nowS: NOW_S + 60 }), DEFAULT_ACCEPTED, "the same hint again in the window: no replay cache, as before");
  assert.deepEqual(hint(ONE_KEY, { ...headers, nowS: NOW_S + 301 }), TIMESTAMP_INVALID, "the same hint after the window");
  assert.deepEqual(hint(ONE_KEY, { ...headers, ts: NOW_S + 301, nowS: NOW_S + 301 }), SIGNATURE_INVALID, "its signature under a fresh timestamp");
});

test("a malformed signature header is refused, each way, with the same answer", () => {
  const good = signatureHeader("k1", K1.privateKey, NOW_S, BODY);
  const sig = good.slice("keyid=k1; ed25519=".length);
  const bytes = Buffer.from(sig, "base64");
  const lastChar = sig.at(-3)!;
  const nonCanonical = `${sig.slice(0, -3)}${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(lastChar) ^ 1]}==`;
  assert.equal(Buffer.from(nonCanonical, "base64").equals(bytes), true, "the same bytes, but not canonical base64");
  const malformed: Array<[string, string | undefined]> = [
    ["absent", undefined],
    ["empty", ""],
    ["the HMAC format", `sha256=${"a".repeat(64)}`],
    ["only the key id", "keyid=k1"],
    ["only the signature", `ed25519=${sig}`],
    ["the fields swapped", `ed25519=${sig}; keyid=k1`],
    ["the key id twice", `keyid=k1; keyid=k1; ed25519=${sig}`],
    ["the signature twice", `keyid=k1; ed25519=${sig}; ed25519=${sig}`],
    ["a third field", `keyid=k1; ed25519=${sig}; alg=ed25519`],
    ["a trailing separator", `${good};`],
    ["two headers joined", `${good}, ${good}`],
    ["keyId", `keyId=k1; ed25519=${sig}`],
    ["KEYID", `KEYID=k1; ed25519=${sig}`],
    ["key_id", `key_id=k1; ed25519=${sig}`],
    ["Ed25519", `keyid=k1; Ed25519=${sig}`],
    ["sig", `keyid=k1; sig=${sig}`],
    ["no space", `keyid=k1;ed25519=${sig}`],
    ["two spaces", `keyid=k1;  ed25519=${sig}`],
    ["a comma", `keyid=k1, ed25519=${sig}`],
    ["spaces around =", `keyid = k1; ed25519 = ${sig}`],
    ["a quoted key id", `keyid="k1"; ed25519=${sig}`],
    ["an empty key id", `keyid=; ed25519=${sig}`],
    ["a key id with a space", `keyid=k 1; ed25519=${sig}`],
    ["a key id of 65 characters", `keyid=${"k".repeat(65)}; ed25519=${sig}`],
    ["an empty signature", "keyid=k1; ed25519="],
    ["base64url", `keyid=k1; ed25519=${bytes.toString("base64url")}`],
    ["unpadded", `keyid=k1; ed25519=${sig.replace(/=+$/u, "")}`],
    ["hex", `keyid=k1; ed25519=${bytes.toString("hex")}`],
    ["63 bytes", `keyid=k1; ed25519=${bytes.subarray(0, 63).toString("base64")}`],
    ["65 bytes", `keyid=k1; ed25519=${Buffer.concat([bytes, Buffer.from([0])]).toString("base64")}`],
    ["non-canonical base64", `keyid=k1; ed25519=${nonCanonical}`],
    ["a character outside base64", `keyid=k1; ed25519=${sig.slice(0, 10)}!${sig.slice(11)}`],
  ];
  assert.deepEqual(hint(ONE_KEY, { signature: good }), DEFAULT_ACCEPTED, "the well-formed one");
  assert.deepEqual(hint(ONE_KEY, { signature: ` ${good} ` }), DEFAULT_ACCEPTED, "surrounding whitespace is trimmed, as before");
  for (const [label, header] of malformed) {
    assert.equal(parseApprovalHintSignature(header), null, label);
    assert.deepEqual(
      verifyApprovalHint({ body: Buffer.from(BODY), timestamp: String(NOW_S), signature: header, nowMs: NOW_S * 1000, env: ONE_KEY }),
      SIGNATURE_INVALID,
      label,
    );
  }
});

test("no public keys, or the old HMAC secret only: hints are refused as with no secret before (404), and no target serves approvals", () => {
  assert.deepEqual(hint(envWith({})), NOT_FOUND);
  assert.deepEqual(hint(envWith({ default: "  " })), NOT_FOUND, "blank is unset");
  assert.deepEqual(hint(envWith({ extra: { ANTIPROTON_APPROVAL_HINT_SECRET: "the-old-secret", ANTIPROTON_CANARY_APPROVAL_HINT_SECRET: "the-old-canary-secret" } })), NOT_FOUND, "the HMAC secrets mean nothing now");
  assert.deepEqual(configuredApprovalTargets(envWith({})), []);
  assert.equal(approvalTargetConfig("default", envWith({})), null);
  assert.deepEqual(configuredApprovalTargets(envWith({ default: { k1: K1.raw }, canary: { c1: C1.raw } })), ["default", "canary"]);
  const noProvider = { [ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV]: JSON.stringify({ k1: K1.raw }) };
  assert.deepEqual(configuredApprovalTargets(noProvider), [], "keys without a provider token serve nothing, as before");
});

test("a bad key value is refused whole, said why once, and leaves its target off", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const zeros = Buffer.alloc(32).toString("base64");
  const offCurve = Buffer.from([2, ...Array<number>(31).fill(0)]).toString("base64");
  const notReduced = Buffer.from("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex").toString("base64");
  const rfcKey = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
  const bad: Array<[string, string, RegExp]> = [
    ["not JSON", `k1=${K1.raw}`, /not a JSON object/u],
    ["a JSON array", JSON.stringify([K1.raw]), /not a JSON object/u],
    ["a JSON string", JSON.stringify(K1.raw), /not a JSON object/u],
    ["trailing content", `${JSON.stringify({ k1: K1.raw })} x`, /not a JSON object/u],
    ["no key", "{}", /no key/u],
    ["a key id twice", `{"k1":"${K1.raw}","k1":"${K2.raw}"}`, /duplicate key/u],
    ["a key id twice, once escaped", `{"k1":"${K1.raw}","\\u006b1":"${K2.raw}"}`, /duplicate key/u],
    ["an empty key id", JSON.stringify({ "": K1.raw }), /key id "" is not/u],
    ["a key id with a space", JSON.stringify({ "k 1": K1.raw }), /key id "k 1" is not/u],
    ["a key id with a semicolon", JSON.stringify({ "k1;": K1.raw }), /key id "k1;" is not/u],
    ["a key id of 65 characters", JSON.stringify({ ["k".repeat(65)]: K1.raw }), /is not 1 to 64/u],
    ["a number", JSON.stringify({ k1: 1 }), /key k1 is not the standard base64/u],
    ["an object", JSON.stringify({ k1: { x: K1.raw } }), /key k1 is not the standard base64/u],
    ["31 bytes", JSON.stringify({ k1: Buffer.alloc(31, 7).toString("base64") }), /key k1 is not the standard base64/u],
    ["33 bytes", JSON.stringify({ k1: Buffer.alloc(33, 7).toString("base64") }), /key k1 is not the standard base64/u],
    ["64 bytes (a private key and its public key)", JSON.stringify({ k1: Buffer.alloc(64, 7).toString("base64") }), /key k1 is not the standard base64/u],
    ["base64url", JSON.stringify({ k1: Buffer.from(rfcKey, "base64").toString("base64url") }), /key k1 is not the standard base64/u],
    ["unpadded", JSON.stringify({ k1: rfcKey.slice(0, -1) }), /key k1 is not the standard base64/u],
    ["non-canonical base64", JSON.stringify({ k1: `${rfcKey.slice(0, -2)}p=` }), /key k1 is not the standard base64/u],
    ["hex", JSON.stringify({ k1: Buffer.from(rfcKey, "base64").toString("hex") }), /key k1 is not the standard base64/u],
    ["whitespace in the key", JSON.stringify({ k1: ` ${K1.raw}` }), /key k1 is not the standard base64/u],
    ["all zeros, a small-order point", JSON.stringify({ k1: zeros }), /key k1 is not a usable Ed25519 public key: a small-order point/u],
    ["not on the curve", JSON.stringify({ k1: offCurve }), /key k1 is not a usable Ed25519 public key: not a point on the curve/u],
    ["y not reduced", JSON.stringify({ k1: notReduced }), /key k1 is not a usable Ed25519 public key: not a canonical point encoding/u],
    ["one key under two ids", JSON.stringify({ k1: K1.raw, k2: K1.raw }), /keys k1 and k2 are the same public key/u],
    ["a good key beside a bad one", JSON.stringify({ k1: K1.raw, k2: zeros }), /key k2 is not a usable/u],
    ["longer than 4096 bytes", JSON.stringify({ k1: K1.raw, pad: "x".repeat(4096) }), /longer than 4096 bytes/u],
  ];
  assert.equal(parseApprovalHintPublicKeys(`{"k1":"${rfcKey}"}`).ok, true, "the rows' good parts are valid");
  for (const [label, value, problem] of bad) {
    const parsed = parseApprovalHintPublicKeys(value);
    assert.equal(parsed.ok, false, label);
    assert.match((parsed as { problem: string }).problem, problem, label);

    errors.mockClear();
    const env = envWith({ default: value });
    assert.equal(approvalTargetConfig("default", env), null, label);
    assert.deepEqual(hint(env), NOT_FOUND, `${label}: no target, as with no keys`);
    assert.equal(errors.mock.calls.length, 1, `${label}: said once`);
    const message = String(errors.mock.calls[0]![0]);
    assert.ok(message.includes(ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV), message);
    assert.match(message, problem, label);
  }
  errors.mockClear();
  const canaryBad = envWith({ default: { k1: K1.raw }, canary: { c1: zeros } });
  assert.deepEqual(hint(canaryBad), DEFAULT_ACCEPTED, "a bad canary value leaves the default target as it is");
  assert.equal(approvalTargetConfig("canary", canaryBad), null);
  assert.ok(String(errors.mock.calls[0]?.[0]).includes(ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV));
});

test("the canary verifies only with its own keys", () => {
  const env = envWith({ default: { k1: K1.raw }, canary: { c1: C1.raw } });
  assert.deepEqual(hint(env, { keyId: "c1", key: C1.privateKey }), CANARY_ACCEPTED, "the canary's key: pulled from the canary");
  assert.deepEqual(hint(env, { keyId: "k1", key: K1.privateKey }), DEFAULT_ACCEPTED, "the default key: pulled from the default target");
  assert.deepEqual(hint(env, { keyId: "c1", key: K1.privateKey }), SIGNATURE_INVALID, "the default key under the canary's key id");
  assert.deepEqual(hint(env, { keyId: "k1", key: C1.privateKey }), SIGNATURE_INVALID, "the canary's key under the default key id");

  const onlyCanary = envWith({ canary: { c1: C1.raw } });
  assert.deepEqual(hint(onlyCanary, { keyId: "c1", key: C1.privateKey }), CANARY_ACCEPTED, "the canary alone");
  assert.deepEqual(hint(onlyCanary, { keyId: "k1", key: K1.privateKey }), SIGNATURE_INVALID);

  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  // A key id is not signed: a key both targets list would let a hint choose its target.
  const sharedId = envWith({ default: { k1: K1.raw }, canary: { k1: C1.raw } });
  assert.equal(approvalTargetConfig("canary", sharedId), null, "a key id the default also lists");
  assert.deepEqual(hint(sharedId, { keyId: "k1", key: K1.privateKey }), DEFAULT_ACCEPTED, "the default target is unaffected");
  assert.deepEqual(hint(sharedId, { keyId: "k1", key: C1.privateKey }), SIGNATURE_INVALID);
  const sharedKey = envWith({ default: { k1: K1.raw }, canary: { c1: K1.raw } });
  assert.equal(approvalTargetConfig("canary", sharedKey), null, "a public key the default also lists, under another id");
  assert.deepEqual(hint(sharedKey, { keyId: "c1", key: K1.privateKey }), SIGNATURE_INVALID, "so its id cannot send a default hint to the canary");
  const messages = errors.mock.calls.map((call) => String(call[0]));
  assert.ok(messages.some((m) => m.includes(ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV) && m.includes("key k1 is also in")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes(ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV) && m.includes("key c1 is also in")), messages.join("\n"));

  const production = { ...envWith({ canary: { c1: C1.raw } }), DEPLOYMENT_ENV: "production" };
  assert.deepEqual(hint(production, { keyId: "c1", key: C1.privateKey }), NOT_FOUND, "no canary outside staging, keys or not");
});

test("a configured key must be a usable Ed25519 point", () => {
  for (let i = 0; i < 64; i++) {
    const { publicKey } = generateKeyPairSync("ed25519");
    assert.equal(ed25519PublicKeyProblem(Buffer.from(rawOf(publicKey), "base64")), null, "a real public key");
  }
  // The 8 small-order points (libsodium's blocklist, both signs of x).
  const smallOrder = [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  ];
  for (const hex of smallOrder) assert.equal(ed25519PublicKeyProblem(Buffer.from(hex, "hex")), "a small-order point", hex);
  assert.equal(ed25519PublicKeyProblem(Buffer.from("0200000000000000000000000000000000000000000000000000000000000000", "hex")), "not a point on the curve");
  assert.equal(ed25519PublicKeyProblem(Buffer.from("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex")), "not a canonical point encoding", "y = p");
  assert.equal(ed25519PublicKeyProblem(Buffer.from("0100000000000000000000000000000000000000000000000000000000000080", "hex")), "not a canonical point encoding", "x = 0 with the sign bit set");
  assert.equal(ed25519PublicKeyProblem(Buffer.alloc(31)), "31 bytes, not 32");
});
