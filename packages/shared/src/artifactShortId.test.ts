import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { ARTIFACT_SHORT_ID_LENGTH, decodeArtifactShortId, encodeArtifactShortId } from "./artifactShortId";

// Computed independently (BigInt base conversion of the uuid's 128-bit value).
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ["cf5d7bb5-6bbe-4304-bc87-1ab40601a98e", "ScAiFjjtiUvoyEYA6Ry12u"],
  ["0b6f1c2e-5d4a-4c3b-9a8e-7f6d5c4b3a21", "2QthvfPeGfDnqwr7LG6itx"],
  ["00000000-0000-0000-0000-000000000000", "1111111111111111111111"],
  ["00000000-0000-0000-0000-000000000001", "1111111111111111111112"],
  ["00000000-0000-0000-0000-00000000003a", "1111111111111111111121"],
  ["000000ff-1234-4abc-8def-0123456789ab", "1111NFEXzsdjftgCj4zz5g"],
  ["00000000-0000-0000-00ab-cdef01234567", "1111111111117Wcifcskyk"],
  ["ffffffff-ffff-ffff-ffff-ffffffffffff", "YcVfxkQb6JRzqk5kF2tNLv"],
];

test("known vectors, both ways", () => {
  for (const [uuid, short] of VECTORS) {
    assert.equal(encodeArtifactShortId(uuid), short, uuid);
    assert.equal(decodeArtifactShortId(short), uuid, short);
  }
});

test("encoding takes any case and always writes 22 characters", () => {
  assert.equal(encodeArtifactShortId("CF5D7BB5-6BBE-4304-BC87-1AB40601A98E"), "ScAiFjjtiUvoyEYA6Ry12u");
  for (let i = 0; i < 200; i += 1) {
    const uuid = randomUUID();
    const short = encodeArtifactShortId(uuid);
    assert.equal(short.length, ARTIFACT_SHORT_ID_LENGTH, uuid);
    assert.equal(decodeArtifactShortId(short), uuid, uuid);
  }
});

test("round trips with leading zero bytes", () => {
  for (let zeros = 1; zeros <= 15; zeros += 1) {
    const hex = "00".repeat(zeros) + randomUUID().replace(/-/g, "").slice(zeros * 2);
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const short = encodeArtifactShortId(uuid);
    assert.equal(short.length, 22, uuid);
    assert.ok(short.startsWith("1"), `${uuid} -> ${short}`);
    assert.equal(decodeArtifactShortId(short), uuid, uuid);
  }
});

test("encoding refuses what isn't a uuid", () => {
  for (const bad of ["", "pt_cf5d7bb5-6bbe-4304-bc87-1ab40601a98e", "cf5d7bb56bbe4304bc871ab40601a98e", "cf5d7bb5-6bbe-4304-bc87-1ab40601a98", "gf5d7bb5-6bbe-4304-bc87-1ab40601a98e"]) {
    assert.throws(() => encodeArtifactShortId(bad), RangeError, bad);
  }
});

test("decoding is strict: 22 characters of the alphabet, at most 16 bytes", () => {
  for (const bad of [
    "",
    "ScAiFjjtiUvoyEYA6Ry12", // 21
    "ScAiFjjtiUvoyEYA6Ry12uu", // 23
    "ScAiFjjtiUvoyEYA6Ry120", // 0 isn't in the alphabet
    "ScAiFjjtiUvoyEYA6Ry12O", // nor O
    "ScAiFjjtiUvoyEYA6Ry12I", // nor I
    "ScAiFjjtiUvoyEYA6Ry12l", // nor l
    "ScAiFjjtiUvoyEYA6Ry1-u",
    " ScAiFjjtiUvoyEYA6Ry12u",
    "YcVfxkQb6JRzqk5kF2tNLw", // 2^128: one over 16 bytes
    "zzzzzzzzzzzzzzzzzzzzzz",
    "a111111111111111111111", // any lowercase lead is over 16 bytes
  ]) {
    assert.equal(decodeArtifactShortId(bad), null, bad);
  }
});
