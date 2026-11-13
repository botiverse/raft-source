import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "../lib/canonicalJson";
import { parseStrictJson, parseStrictJsonBytes, StrictJsonError } from "../lib/strictJson";
import { isLinkCardStringTree, isStrictRfc3339Utc, linkCardPreparedDigest, parseLinkCardPreparedDescription } from "./linkCardDescription";

// The shared vectors for prepared_digest (protocol v3.2.2 §10.2), from yanyongyu
// (#raft-botiverse:cbfc8eef aaf93675; how to run them: the README beside the
// fixture). Raft, Stamp and Vault run the same file; when the protocol updates
// the vectors, replace the fixture and its pinned SHA-256 below. This copy adds
// the C0-key rule (addendum 4 §4): 145 vectors, 72 ok and 73 reject.
type Vector = {
  name: string;
  layer: "jcs" | "description";
  input_json: string;
  canonical: string | null;
  sha256_hex: string | null;
  expect: "ok" | "reject";
  note: string;
};
const VECTORS_SHA256 = "52dc8b28dbf7799dc35d71da33df4eb09bab3639c9e1193c8cc29cc0dca3ecbd";
const vectorBytes = readFileSync(new URL("../lib/fixtures/link-card-jcs/jcs-vectors.json", import.meta.url));
const vectors: Vector[] = JSON.parse(vectorBytes.toString("utf8"));

function run(vector: Vector): { canonical: string; sha256: string } {
  const value = parseStrictJson(vector.input_json);
  if (vector.layer === "description") {
    const parsed = parseLinkCardPreparedDescription(value);
    if (!parsed.ok) throw new Error(parsed.reason);
    return { canonical: canonicalJson(parsed.description), sha256: linkCardPreparedDigest(parsed.description) };
  }
  // The jcs layer is the general parser alone: numbers, booleans and null are fine there.
  return { canonical: canonicalJson(value), sha256: canonicalJsonSha256(value) };
}

test("the shared vectors: exactly the published file, 72 accepted byte for byte, 73 rejected", () => {
  assert.equal(createHash("sha256").update(vectorBytes).digest("hex"), VECTORS_SHA256, "the fixture is the published vector file");
  assert.equal(vectors.length, 145);
  assert.equal(vectors.filter((v) => v.expect === "ok").length, 72);
  assert.equal(vectors.filter((v) => v.expect === "reject").length, 73);
  for (const vector of vectors) {
    if (vector.expect === "ok") {
      const out = run(vector);
      assert.equal(out.canonical, vector.canonical, `${vector.name}: canonical bytes`);
      assert.equal(out.sha256, vector.sha256_hex, `${vector.name}: digest`);
    } else {
      assert.throws(() => run(vector), `${vector.name} must be rejected (${vector.note})`);
    }
  }
});

test("vector pairs that must and must not share a digest", () => {
  const digest = (name: string) => {
    const vector = vectors.find((v) => v.name === name);
    assert.ok(vector, name);
    return run(vector).sha256;
  };
  for (const [a, b] of [
    ["jcs_solidus_escaped", "jcs_solidus_raw"],
    ["jcs_u2028_u2029_escaped_input", "jcs_u2028_u2029_raw_input"],
    ["jcs_non_ascii_escaped_input", "jcs_non_ascii_raw_input"],
    ["desc_stamp_merge_zh_CN", "desc_stamp_merge_zh_CN_escaped"],
    ["desc_vault_approve_zh_CN", "desc_vault_approve_zh_CN_escaped"],
    ["jcs_u_fffd_escaped_is_valid", "jcs_u_fffd_raw_is_valid"],
    ["jcs_noncharacters_escaped", "jcs_noncharacters_raw"],
    ["desc_title_120_supplementary", "desc_title_120_supplementary_escaped"],
  ]) assert.equal(digest(a), digest(b), `${a} = ${b}`);
  for (const [a, b] of [
    ["jcs_nfc_precomposed", "jcs_nfd_decomposed"],
    ["desc_stamp_merge_zh_CN", "desc_stamp_merge_en"],
    ["desc_vault_approve_zh_CN", "desc_vault_approve_en"],
    ["desc_vault_approve_zh_CN", "desc_vault_approve_locale_field_only_differs"],
    ["desc_minimal_required_only", "desc_minimal_with_empty_body"],
    ["desc_minimal_required_only", "desc_minimal_with_empty_rows_and_terms"],
    ["desc_read_at_millis_trailing_zero", "desc_read_at_two_digit_fraction"],
    ["desc_read_at_seconds", "desc_read_at_millis"],
  ]) assert.notEqual(digest(a), digest(b), `${a} != ${b}`);
});

test("__proto__ stays an own key through parsing, validation and the digest", () => {
  const value = parseStrictJson('{"__proto__":"p","a":"b"}');
  assert.deepEqual(Object.keys(value), ["__proto__", "a"]);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(canonicalJson(value), '{"__proto__":"p","a":"b"}');

  const base = vectors.find((v) => v.name === "desc_minimal_required_only")!;
  const withTerms = `${base.input_json.trim().slice(0, -1)},"terms":{"__proto__":"x","k":"v"}}`;
  const parsed = parseLinkCardPreparedDescription(parseStrictJson(withTerms));
  assert.ok(parsed.ok);
  assert.deepEqual(Object.keys(parsed.description.terms!), ["__proto__", "k"]);
  assert.match(canonicalJson(parsed.description), /"terms":\{"__proto__":"x","k":"v"\}/);
});

test("bytes: invalid UTF-8 and a leading BOM are rejected before parsing", () => {
  assert.deepEqual(parseStrictJsonBytes(new TextEncoder().encode('{"a":"é"}')), { a: "é" });
  assert.throws(() => parseStrictJsonBytes(Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), StrictJsonError);
  assert.throws(() => parseStrictJsonBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), StrictJsonError);
});

test("two layers: the parser takes any JSON value type, the description schema takes only strings", () => {
  const parsed = parseStrictJson('{"n":-0.5e2,"t":true,"f":false,"z":null,"a":[0,1]}');
  assert.deepEqual(parsed, { n: -50, t: true, f: false, z: null, a: [0, 1] });
  for (const bad of ['{"n":01}', '{"n":1.}', '{"n":.5}', '{"n":+1}', '{"n":1e400}', '{"n":NaN}', '{"t":tru}', '{"t":truex}', '{"n":-}']) {
    assert.throws(() => parseStrictJson(bad), StrictJsonError, bad);
  }
  assert.equal(isLinkCardStringTree(parsed), false);
  const base = JSON.parse(vectors.find((v) => v.name === "desc_minimal_required_only")!.canonical!);
  for (const patch of [{ body: 1 }, { target: true }, { fine_print: null }, { rows: [{ label: "l", value: 2 }] }, { terms: { k: false } }]) {
    assert.ok(!parseLinkCardPreparedDescription({ ...base, ...patch }).ok, JSON.stringify(patch));
  }
});

test("read_at is strict RFC 3339 UTC on a real calendar date", () => {
  // Leap years as Go's time.Date: 0000 is one (divisible by 400), 1900 is not.
  for (const ok of ["2026-10-21T08:15:30Z", "2026-10-21T08:15:30.123Z", "2024-02-29T23:59:59.999999999Z", "2000-02-29T00:00:00Z",
    "0000-02-29T00:00:00Z"]) assert.ok(isStrictRfc3339Utc(ok), ok);
  for (const bad of ["2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z",
    "2026-10-00T00:00:00Z", "2026-10-21T24:00:00Z", "2026-10-21T08:60:00Z", "2026-10-21T08:15:60Z", "2026-10-21T08:15:30+00:00",
    "2026-10-21t08:15:30z", "2026-10-21 08:15:30Z", "2026-10-21T08:15:30.Z", "2026-10-21T08:15:30.1234567890Z"]) {
    assert.ok(!isStrictRfc3339Utc(bad), bad);
  }
});

test("lengths count code points, so an emoji is one character", () => {
  const base = JSON.parse(vectors.find((v) => v.name === "desc_minimal_required_only")!.canonical!);
  assert.ok(parseLinkCardPreparedDescription({ ...base, confirm_label: "😀".repeat(40) }).ok, "40 code points, 80 UTF-16 units");
  assert.ok(!parseLinkCardPreparedDescription({ ...base, confirm_label: "😀".repeat(41) }).ok);
  assert.ok(parseLinkCardPreparedDescription({ ...base, title: "a".repeat(120) }).ok);
  assert.ok(!parseLinkCardPreparedDescription({ ...base, title: "a".repeat(121) }).ok);
});

test("a valid U+FFFD is accepted, raw or escaped; only broken surrogates are refused", () => {
  assert.deepEqual(parseStrictJson('{"a":"\ufffd","b":"�"}'), { a: "�", b: "�" });
  assert.deepEqual(parseStrictJson('{"e":"\ud83d\ude00"}'), { e: "😀" });
  assert.throws(() => parseStrictJson('{"e":"\ude00\ud83d"}'), /lone surrogate/);
});

test("nesting is bounded", () => {
  assert.doesNotThrow(() => parseStrictJson(`{"a":${"[".repeat(31)}${"]".repeat(31)}}`));
  assert.throws(() => parseStrictJson(`{"a":${"[".repeat(40)}${"]".repeat(40)}}`), /nesting too deep/);
});

test("description schema: required fields, exact rows, at most 16 terms, no other limits", () => {
  const base = JSON.parse(vectors.find((v) => v.name === "desc_minimal_required_only")!.canonical!);
  const check = (patch: Record<string, unknown>) => parseLinkCardPreparedDescription({ ...base, ...patch });
  assert.ok(check({}).ok);
  assert.ok(!check({ prepared_action_id: "not-a-uuid" }).ok);
  assert.ok(!check({ action_id: "Merge" }).ok);
  assert.ok(!check({ read_at: "2026-10-21 08:15:30" }).ok, "must be RFC 3339 UTC");
  assert.ok(!check({ read_at: "2026-13-41T08:15:30Z" }).ok, "must be a real date");
  assert.ok(!check({ confirm_label: "x".repeat(41) }).ok);
  assert.ok(check({ rows: Array.from({ length: 8 }, (_, n) => ({ label: `l${n}`, value: "v" })) }).ok);
  assert.ok(!check({ rows: [{ label: "l" }] }).ok);
  assert.ok(check({ terms: Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`k${n}`, "v"])) }).ok);
  assert.ok(!check({ terms: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`k${n}`, "v"])) }).ok, "a 17th term");
  // §5.2 sets no length limits on these; only the 32 KiB body bounds them.
  assert.ok(check({ target: "" }).ok, "empty target");
  assert.ok(check({ execution_mode: "" }).ok, "empty execution_mode");
  assert.ok(check({ execution_account: "a".repeat(250) }).ok, "250-character execution_account");
  assert.ok(check({ terms: { "": "", ["k".repeat(100)]: "v".repeat(1000) } }).ok, "term keys and values of any length");
  assert.ok(!check({ target: ["t"] }).ok, "target must still be a string");
  // business_revision keeps its 512 maximum: the handle could never carry a longer one.
  assert.ok(check({ business_revision: "r".repeat(512) }).ok);
  assert.ok(!check({ business_revision: "r".repeat(513) }).ok);
  assert.ok(!check({ business_revision: "" }).ok);
});
