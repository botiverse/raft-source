import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_FACT_SOLE_APPLY_ELIGIBLE,
  CANONICAL_MESSAGE_V2_ENVELOPE_KIND,
  CANONICAL_MESSAGE_V2_MANIFEST,
  CANONICAL_MESSAGE_V2_SCHEMA_VERSION,
  canonicalReactionFactsJson,
  isCanonicalMessageV2SoleApplyEligible,
  normalizeLegacyReactionRoster,
  reactionViewerOverlaySnapshotJson,
  type LegacyReactionRosterDto,
  type NormalizeLegacyReactionRosterInput,
} from "./canonicalMessageV2.js";

const here = dirname(fileURLToPath(import.meta.url));

const baseInput = {
  serverId: "server-a",
  parentScopeKey: { serverId: "server-a", scopeKind: "channel", scopeId: "channel-a" },
  messageId: "message-a",
  source: "receiver-private",
  viewerUserId: "actor-b",
} as const;

const roster: readonly LegacyReactionRosterDto[] = [
  {
    emoji: "👍",
    count: 4,
    reactorIds: ["actor-d", "actor-b", "actor-a", "actor-c"],
    reactorNames: ["Dee", "Bee", "Ada", "Cee"],
  },
];

function normalize(
  reactions: readonly LegacyReactionRosterDto[],
  overrides: Partial<NormalizeLegacyReactionRosterInput> = {},
) {
  return normalizeLegacyReactionRoster({ ...baseInput, reactions, ...overrides });
}

test("canonical message V2 manifest separates the normalized envelope from V1 shadow eligibility", () => {
  assert.equal(CANONICAL_FACT_SOLE_APPLY_ELIGIBLE, false);
  assert.equal(CANONICAL_MESSAGE_V2_MANIFEST.schemaVersion, 5);
  assert.equal(CANONICAL_MESSAGE_V2_MANIFEST.soleApplyEligible, true);
  assert.deepEqual(CANONICAL_MESSAGE_V2_MANIFEST.reactions.fields, ["count", "emoji", "previewK"]);
  assert.deepEqual(CANONICAL_MESSAGE_V2_MANIFEST.forbiddenCanonicalPaths, [
    "reactions[].reactorIds",
    "reactions[].reactorNames",
  ]);
});

test("legacy roster normalizer splits shared fact, viewer overlay, and cache seed in one pure step", () => {
  const input = { ...baseInput, reactions: roster };
  const before = structuredClone(input);
  const result = normalizeLegacyReactionRoster(input);

  assert.deepEqual(input, before, "normalization must not mutate producer input");
  assert.deepEqual(result, {
    sharedFact: [{
      emoji: "👍",
      count: 4,
      previewK: [],
    }],
    viewerOverlay: {
      serverId: "server-a",
      messageId: "message-a",
      completeness: "complete",
      reactedEmojis: ["👍"],
    },
    readCacheSeed: [{
      parentScopeKey: { serverId: "server-a", scopeKind: "channel", scopeId: "channel-a" },
      messageId: "message-a",
      emoji: "👍",
      actors: [
        { id: "actor-a", displayName: "Ada" },
        { id: "actor-b", displayName: "Bee" },
        { id: "actor-c", displayName: "Cee" },
        { id: "actor-d", displayName: "Dee" },
      ],
      completeness: "complete",
    }],
    violations: [],
  });
});

test("canonical reaction bytes are permutation-stable and cannot serialize roster keys", () => {
  const permuted = [{
    ...roster[0]!,
    reactorIds: ["actor-c", "actor-a", "actor-d", "actor-b"],
    reactorNames: ["Cee", "Ada", "Dee", "Bee"],
  }];
  const first = normalize(roster);
  const second = normalize(permuted);
  const firstJson = canonicalReactionFactsJson(first.sharedFact);
  const secondJson = canonicalReactionFactsJson(second.sharedFact);

  assert.equal(firstJson, secondJson);
  assert.equal(firstJson.includes("reactorIds"), false);
  assert.equal(firstJson.includes("reactorNames"), false);
  assert.equal(
    createHash("sha256").update(firstJson).digest("hex"),
    "ecbec9c24b6578b1326a44a163c5c6fdd7b7be92b062e91c9a6308d2191307b6",
    "golden canonical bytes are cross-platform pinning material",
  );
});

test("canonical fact size stays bounded when a compatibility roster grows to 5000 actors", () => {
  const actors = Array.from({ length: 5_000 }, (_, index) => {
    const id = `actor-${String(index).padStart(4, "0")}`;
    return { id, displayName: `Person ${index}` };
  });
  const result = normalize([{
    emoji: "🔥",
    count: actors.length,
    reactorIds: actors.map((actor) => actor.id),
    reactorNames: actors.map((actor) => actor.displayName),
  }]);
  const canonicalBytes = canonicalReactionFactsJson(result.sharedFact);

  assert.equal(result.readCacheSeed[0]?.actors.length, 5_000, "actor detail stays outside the fact");
  assert.equal(result.sharedFact[0]?.previewK.length, 0);
  assert.ok(Buffer.byteLength(canonicalBytes) < 256, "canonical bytes must be O(emoji), not O(actors)");
  assert.equal(canonicalBytes.includes("actor-0000"), false, "legacy roster names cannot enter shared bytes");
});

test("channel-room normalization can never mutate receiver-private overlay", () => {
  const result = normalize(roster, { source: "channel-room", viewerUserId: "actor-b" });
  assert.equal(result.viewerOverlay, null);
  assert.equal(result.sharedFact[0]?.count, 4);
  assert.equal(result.readCacheSeed[0]?.actors.length, 4);
});

test("malformed rosters never masquerade as a complete actor cache", () => {
  const malformed = normalize([{
    emoji: "👍",
    count: 2,
    reactorIds: ["actor-a", "actor-a", ""],
    reactorNames: ["Ada", "Conflicting Ada", "Nobody"],
  }]);

  assert.deepEqual(malformed.sharedFact, [{ emoji: "👍", count: 2, previewK: [] }]);
  assert.equal(malformed.viewerOverlay, null);
  assert.deepEqual(malformed.readCacheSeed, []);
  assert.deepEqual(malformed.violations, [
    { kind: "duplicate_actor_id", emoji: "👍" },
    { kind: "empty_actor_id", emoji: "👍" },
    { kind: "actor_count_mismatch", emoji: "👍" },
  ]);
});

test("duplicate emoji rejects that canonical reaction instead of choosing one producer row", () => {
  const duplicated = normalize([roster[0]!, roster[0]!]);
  assert.deepEqual(duplicated.sharedFact, []);
  assert.equal(duplicated.viewerOverlay, null);
  assert.deepEqual(duplicated.readCacheSeed, []);
  assert.deepEqual(duplicated.violations, [{ kind: "duplicate_emoji", emoji: "👍" }]);
});

test("sole-apply tripwire accepts only exact normalized V2 reaction facts", () => {
  const normalized = normalize(roster);
  const eligible = {
    schemaVersion: CANONICAL_MESSAGE_V2_SCHEMA_VERSION,
    kind: CANONICAL_MESSAGE_V2_ENVELOPE_KIND,
    fact: { reactions: normalized.sharedFact },
  };
  assert.equal(isCanonicalMessageV2SoleApplyEligible(eligible), true);

  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...eligible,
    schemaVersion: 4,
  }), false, "V1 can never become eligible through the old shadow flag");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...eligible,
    fact: {
      reactions: [{
        ...normalized.sharedFact[0],
        reactorIds: ["actor-a"],
        reactorNames: ["Ada"],
      }],
    },
  }), false, "wider/raw roster shapes fail closed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...eligible,
    fact: {
      reactions: [{ emoji: "👍", count: 4, previewK: Array(4).fill({ id: "x", displayName: "X" }) }],
    },
  }), false, "previewK cannot exceed the manifest bound");
});

test("sole-apply tripwire rejects wider boundaries and non-canonical aggregate order", () => {
  const reaction = {
    ...normalize(roster).sharedFact[0]!,
    previewK: [
      { id: "actor-a", displayName: "Ada" },
      { id: "actor-b", displayName: "Bee" },
    ],
  };
  const valid = {
    schemaVersion: CANONICAL_MESSAGE_V2_SCHEMA_VERSION,
    kind: CANONICAL_MESSAGE_V2_ENVELOPE_KIND,
    fact: { reactions: [reaction] },
  };

  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    legacyRaw: { reactorIds: ["actor-a"] },
  }), false, "unknown envelope keys fail closed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: { ...valid.fact, legacyRaw: { reactorIds: ["actor-a"] } },
  }), false, "unknown fact keys fail closed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: { reactions: [{ emoji: "👍", count: 0, previewK: [{ id: "actor-a", displayName: "Ada" }] }] },
  }), false, "preview length cannot exceed aggregate count");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: { reactions: [{ ...reaction, previewK: [...reaction.previewK].reverse() }] },
  }), false, "preview actor ids must be strictly increasing");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: { reactions: [{ ...reaction, previewK: [reaction.previewK[0]!, reaction.previewK[0]!] }] },
  }), false, "duplicate actor ids fail closed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: { reactions: [{ ...reaction, emoji: "" }] },
  }), false, "empty emoji fails closed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: { reactions: [{ ...reaction, emoji: ` ${reaction.emoji} ` }] },
  }), false, "emoji must already be trimmed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: {
      reactions: [{
        ...reaction,
        previewK: [{ ...reaction.previewK[0]!, id: ` ${reaction.previewK[0]!.id} ` }],
      }],
    },
  }), false, "actor id must already be trimmed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: {
      reactions: [{
        ...reaction,
        previewK: [{
          ...reaction.previewK[0]!,
          displayName: ` ${reaction.previewK[0]!.displayName} `,
        }],
      }],
    },
  }), false, "actor display name must already be trimmed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: { reactions: [reaction, reaction] },
  }), false, "duplicate reaction emoji fails closed");
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    ...valid,
    fact: {
      reactions: [
        { emoji: "👍", count: 0, previewK: [] },
        { emoji: "✅", count: 0, previewK: [] },
      ],
    },
  }), false, "reaction emoji order must be strictly increasing");
});

test("legacy normalization emits trimmed reaction-subtree strings before sole apply", () => {
  const normalized = normalize([{
    emoji: " 👍 ",
    count: 1,
    reactorIds: [" actor-a "],
    reactorNames: [" Ada "],
  }]);
  assert.deepEqual(normalized.sharedFact, [{
    emoji: "👍",
    count: 1,
    previewK: [],
  }]);
  assert.deepEqual(normalized.readCacheSeed[0]?.actors, [
    { id: "actor-a", displayName: "Ada" },
  ]);
  assert.equal(isCanonicalMessageV2SoleApplyEligible({
    schemaVersion: CANONICAL_MESSAGE_V2_SCHEMA_VERSION,
    kind: CANONICAL_MESSAGE_V2_ENVELOPE_KIND,
    fact: { reactions: normalized.sharedFact },
  }), true);
});

test("legacy compatibility produces identical shared bytes for distinct room principals", () => {
  const first = normalize(roster, { source: "channel-room", viewerUserId: "principal-a" });
  const second = normalize(roster, { source: "channel-room", viewerUserId: "principal-b" });
  assert.equal(canonicalReactionFactsJson(first.sharedFact), canonicalReactionFactsJson(second.sharedFact));
  assert.deepEqual(first.sharedFact[0]?.previewK, []);
  assert.equal(
    canonicalReactionFactsJson(first.sharedFact).includes("Ada"),
    false,
    "a hidden actor name can remain viewer-local detail but never enter the shared preview",
  );
});

test("neutral JSON vector executes the normalizer and pins canonical bytes plus SHA", () => {
  const fixture = JSON.parse(readFileSync(join(here, "canonicalMessageV2.vector.json"), "utf8"));
  assert.equal(fixture.cases.length, 4, "private, empty, channel, and malformed semantics are pinned");
  for (const vector of fixture.cases) {
    const result = normalizeLegacyReactionRoster(vector.input);
    const canonicalBytes = canonicalReactionFactsJson(result.sharedFact);
    const overlayBytes = reactionViewerOverlaySnapshotJson(result.viewerOverlay);
    assert.deepEqual(result, vector.expected, vector.name);
    assert.equal(canonicalBytes, vector.canonicalFactJson, vector.name);
    assert.equal(
      createHash("sha256").update(canonicalBytes).digest("hex"),
      vector.canonicalFactSha256,
      vector.name,
    );
    assert.equal(overlayBytes, vector.viewerOverlayJson, vector.name);
    assert.equal(
      createHash("sha256").update(overlayBytes).digest("hex"),
      vector.viewerOverlaySha256,
      vector.name,
    );
  }
});
