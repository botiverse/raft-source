import assert from "node:assert/strict";
import { test } from "vitest";

import { CANONICAL_MESSAGE_MANIFEST } from "@botiverse/raft-shared";
import type { EnrichedMessageRow, FrontendConversationContext } from "./messageService.js";

/**
 * Producer gate for the canonical message manifest (contract v3.1 → RFC 043
 * amendment): the nested wire shapes in the manifest must equal the shapes the
 * server enrichment path actually emits. The maps below are compile-time — if
 * the producer shape gains/loses/renames a field, or the manifest drifts from
 * the producer, typecheck fails before tests run.
 */

type EnrichedAttachment = NonNullable<EnrichedMessageRow["attachments"]>[number];
type EnrichedReaction = NonNullable<EnrichedMessageRow["reactions"]>[number];
type EnrichedMention = NonNullable<EnrichedMessageRow["mentions"]>[number];
type EnrichedCommentRef = NonNullable<EnrichedMessageRow["commentRef"]>;
type EnrichedHostSource = NonNullable<EnrichedCommentRef["hostSource"]>;
type EnrichedConversationContext = FrontendConversationContext;
type EnrichedExternalAuthor = NonNullable<EnrichedMessageRow["externalAuthor"]>;

type ManifestNestedNames<S extends keyof typeof CANONICAL_MESSAGE_MANIFEST.nestedWireShapes> =
  (typeof CANONICAL_MESSAGE_MANIFEST.nestedWireShapes)[S][number]["name"];

// Both directions per shape: producer key set == manifest nested field set.
const ATTACHMENT_FORWARD: { [K in ManifestNestedNames<"attachment">]: K & keyof EnrichedAttachment } = {
  filename: "filename", height: "height", id: "id",
  mimeType: "mimeType", sizeBytes: "sizeBytes", thumbnailUrl: "thumbnailUrl", width: "width",
};
// commentCount is producer-emitted but viewer-scoped (manifest exclusions
// .viewerScopedFields) — exempted from the canonical shape both directions.
const ATTACHMENT_REVERSE: { [K in Exclude<keyof EnrichedAttachment, "commentCount">]: K & ManifestNestedNames<"attachment"> } = {
  filename: "filename", height: "height", id: "id",
  mimeType: "mimeType", sizeBytes: "sizeBytes", thumbnailUrl: "thumbnailUrl", width: "width",
};

const REACTION_FORWARD: { [K in ManifestNestedNames<"reaction">]: K & keyof EnrichedReaction } = {
  count: "count", emoji: "emoji", reactorIds: "reactorIds", reactorNames: "reactorNames",
};
const REACTION_REVERSE: { [K in keyof EnrichedReaction]: K & ManifestNestedNames<"reaction"> } = {
  count: "count", emoji: "emoji", reactorIds: "reactorIds", reactorNames: "reactorNames",
};

const MENTION_FORWARD: { [K in ManifestNestedNames<"mention">]: K & keyof EnrichedMention } = {
  id: "id", name: "name", type: "type",
};
const MENTION_REVERSE: { [K in keyof EnrichedMention]: K & ManifestNestedNames<"mention"> } = {
  id: "id", name: "name", type: "type",
};

const COMMENT_REF_FORWARD: { [K in ManifestNestedNames<"commentRef">]: K & keyof EnrichedCommentRef } = {
  anchorLabel: "anchorLabel", anchorQuote: "anchorQuote", attachmentId: "attachmentId",
  filename: "filename", hostMessageId: "hostMessageId", hostSource: "hostSource",
};
const COMMENT_REF_REVERSE: { [K in keyof EnrichedCommentRef]: K & ManifestNestedNames<"commentRef"> } = {
  anchorLabel: "anchorLabel", anchorQuote: "anchorQuote", attachmentId: "attachmentId",
  filename: "filename", hostMessageId: "hostMessageId", hostSource: "hostSource",
};

const HOST_SOURCE_FORWARD: { [K in ManifestNestedNames<"commentRefHostSource">]: K & keyof EnrichedHostSource } = {
  channelId: "channelId", parentMessageId: "parentMessageId", rootThreadChannelId: "rootThreadChannelId",
  routeKind: "routeKind", threadChannelId: "threadChannelId", type: "type",
};
const HOST_SOURCE_REVERSE: { [K in keyof EnrichedHostSource]: K & ManifestNestedNames<"commentRefHostSource"> } = {
  channelId: "channelId", parentMessageId: "parentMessageId", rootThreadChannelId: "rootThreadChannelId",
  routeKind: "routeKind", threadChannelId: "threadChannelId", type: "type",
};

const CONTEXT_FORWARD: { [K in ManifestNestedNames<"conversationContext">]: K & keyof EnrichedConversationContext } = {
  channelType: "channelType", parentChannelId: "parentChannelId",
  parentChannelType: "parentChannelType", parentMessageId: "parentMessageId",
};
const CONTEXT_REVERSE: { [K in keyof EnrichedConversationContext]: K & ManifestNestedNames<"conversationContext"> } = {
  channelType: "channelType", parentChannelId: "parentChannelId",
  parentChannelType: "parentChannelType", parentMessageId: "parentMessageId",
};

const EXTERNAL_AUTHOR_FORWARD: { [K in ManifestNestedNames<"externalAuthor">]: K & keyof EnrichedExternalAuthor } = {
  actorKind: "actorKind", actorProjectionRevision: "actorProjectionRevision",
  appRegistrationId: "appRegistrationId", avatarDigest: "avatarDigest", avatarUrl: "avatarUrl",
  displayName: "displayName", externalActorId: "externalActorId",
  externalConversationId: "externalConversationId", externalMessageId: "externalMessageId",
  installId: "installId", projectionId: "projectionId", provider: "provider", workspaceId: "workspaceId",
};
const EXTERNAL_AUTHOR_REVERSE: { [K in keyof EnrichedExternalAuthor]: K & ManifestNestedNames<"externalAuthor"> } = {
  actorKind: "actorKind", actorProjectionRevision: "actorProjectionRevision",
  appRegistrationId: "appRegistrationId", avatarDigest: "avatarDigest", avatarUrl: "avatarUrl",
  displayName: "displayName", externalActorId: "externalActorId",
  externalConversationId: "externalConversationId", externalMessageId: "externalMessageId",
  installId: "installId", projectionId: "projectionId", provider: "provider", workspaceId: "workspaceId",
};

test("producer nested shapes == canonical manifest (compile-time maps, runtime count pin)", () => {
  const maps: Array<[Record<string, string>, keyof typeof CANONICAL_MESSAGE_MANIFEST.nestedWireShapes]> = [
    [ATTACHMENT_FORWARD, "attachment"],
    [REACTION_FORWARD, "reaction"],
    [MENTION_FORWARD, "mention"],
    [COMMENT_REF_FORWARD, "commentRef"],
    [HOST_SOURCE_FORWARD, "commentRefHostSource"],
    [CONTEXT_FORWARD, "conversationContext"],
    [EXTERNAL_AUTHOR_FORWARD, "externalAuthor"],
  ];
  for (const [forward, shape] of maps) {
    assert.deepEqual(
      Object.keys(forward).sort(),
      CANONICAL_MESSAGE_MANIFEST.nestedWireShapes[shape].map((f) => f.name).sort(),
      `${String(shape)} manifest names must equal the compile-checked producer map`,
    );
  }
  // Reverse maps participate at compile time only; reference them so they are not dead code.
  void ATTACHMENT_REVERSE; void REACTION_REVERSE; void MENTION_REVERSE;
  void COMMENT_REF_REVERSE; void HOST_SOURCE_REVERSE; void CONTEXT_REVERSE;
  void EXTERNAL_AUTHOR_REVERSE;
});

// ——— Type-level descriptor validation (exhaustive; AD2 review round 3) ———
// Every descriptor facet (wireType family, value nullability, per-surface key
// presence, nested optionalKey) is validated by mapped types that traverse the
// FULL descriptor set — no hand-listed assertions. Each `AssertAll<...>` fails
// typecheck if ANY field's check resolves to a mismatch object instead of
// literal `true`. Negative fixtures at the bottom prove the gates fire.

import type { CANONICAL_MESSAGE_FIELD_DESCRIPTORS } from "@botiverse/raft-shared";
import type { projectTaskMessageUpdated } from "./taskRealtimeEvents.js";

type Descriptors = typeof CANONICAL_MESSAGE_FIELD_DESCRIPTORS;
type TaskRow = ReturnType<typeof projectTaskMessageUpdated>;
/** `message:new` broadcast payload: enriched row + conversationContext
 *  (withFrontendConversationContext is applied on every message:new emit). */
type MessageNewRow = EnrichedMessageRow & { conversationContext: FrontendConversationContext };
/** `message:updated` enriched reload payload: getMessageContext messages —
 *  enriched row WITHOUT conversationContext (creation-time identity). */
type EnrichedUpdatedRow = EnrichedMessageRow;

type AssertAll<_T extends Record<string, true>> = true;

type WireFamily<V> = [NonNullable<V>] extends [string] ? "string-family"
  : [NonNullable<V>] extends [number] ? "number"
  : [NonNullable<V>] extends [Date] ? "string-family" // ISO string on the wire
  : [NonNullable<V>] extends [ReadonlyArray<unknown>] ? "array"
  : "object";
type DescriptorWireFamily<W> = W extends "string" | "string-union-raw" ? "string-family"
  : W extends "number" ? "number"
  : W extends `array<${string}>` ? "array"
  : "object";
type ValueNullable<T, K> = K extends keyof T ? (null extends T[K] ? true : false) : never;
type KeyPresent<T, K> = K extends keyof T ? "present" : "absent";

/** Value facets (nullability + wire family) checked on a surface where the
 *  descriptor declares the key present. */
type CheckValue<D extends Descriptors[number], T> =
  D["name"] extends keyof T
    ? [ValueNullable<T, D["name"]>] extends [D["nullable"]]
      ? [WireFamily<T[D["name"] & keyof T]>] extends [DescriptorWireFamily<D["wireType"]>]
        ? true
        : { wireTypeMismatch: D["name"] }
      : { nullabilityMismatch: D["name"] }
    : { missingOnDeclaredPresentSurface: D["name"] };

/** Presence facet on one surface: declared == actual key existence. */
type CheckPresence<D extends Descriptors[number], T, S extends keyof D["presence"]> =
  [KeyPresent<T, D["name"]>] extends [D["presence"][S]] ? true : { presenceMismatch: [S, D["name"]] };

// —— Full traversal: value facets on message:new (every field is declared
//    present there), presence facets on all three surfaces. ——
type _valuesOnNew = AssertAll<{
  [D in Descriptors[number] as D["name"]]: CheckValue<D, MessageNewRow>;
}>;
type _presenceNew = AssertAll<{
  [D in Descriptors[number] as D["name"]]: CheckPresence<D, MessageNewRow, "messageNew">;
}>;
type _presenceEnrichedUpdated = AssertAll<{
  [D in Descriptors[number] as D["name"]]: CheckPresence<D, EnrichedUpdatedRow, "enrichedUpdated">;
}>;
type _presenceTaskUpdated = AssertAll<{
  [D in Descriptors[number] as D["name"]]: CheckPresence<D, TaskRow, "taskStatusUpdated">;
}>;
// Value facets additionally re-checked on the task projector for its present fields.
type _valuesOnTask = AssertAll<{
  [D in Descriptors[number] as D["presence"]["taskStatusUpdated"] extends "present" ? D["name"] : never]:
    CheckValue<D, TaskRow>;
}>;

// —— Nested shapes: full traversal of every field's wireType + nullability +
//    optionalKey against the producer nested types. ——
type Shapes = typeof CANONICAL_MESSAGE_MANIFEST.nestedWireShapes;
type NestedWireFamilyOf<W> = W extends "string" | "string-union-raw" ? "string-family"
  : W extends "number" ? "number"
  : W extends "array<string>" ? "array"
  : "object";
type KeyOptional<T, K> = K extends keyof T ? ({} extends Pick<T, K & keyof T> ? true : false) : never;
type CheckNested<D extends { name: string; wireType: string; nullable: boolean; optionalKey?: true }, T> =
  D["name"] extends keyof T
    ? [ValueNullable<T, D["name"]>] extends [D["nullable"]]
      ? [KeyOptional<T, D["name"]>] extends [D extends { optionalKey: true } ? true : false]
        ? [WireFamily<T[D["name"] & keyof T]>] extends [NestedWireFamilyOf<D["wireType"]>]
          ? true
          : { nestedWireTypeMismatch: D["name"] }
        : { nestedOptionalKeyMismatch: D["name"] }
      : { nestedNullabilityMismatch: D["name"] }
    : { nestedMissingOnProducer: D["name"] };
type NestedFieldDescriptorShape = { name: string; wireType: string; nullable: boolean; optionalKey?: true };
type CheckShape<A extends ReadonlyArray<NestedFieldDescriptorShape>, T> = {
  [D in A[number] as D["name"]]: CheckNested<D, T>;
};

type _attachmentShape = AssertAll<CheckShape<Shapes["attachment"], EnrichedAttachment>>;
type _reactionShape = AssertAll<CheckShape<Shapes["reaction"], EnrichedReaction>>;
type _mentionShape = AssertAll<CheckShape<Shapes["mention"], EnrichedMention>>;
type _commentRefShape = AssertAll<CheckShape<Shapes["commentRef"], EnrichedCommentRef>>;
type _hostSourceShape = AssertAll<CheckShape<Shapes["commentRefHostSource"], EnrichedHostSource>>;
type _conversationContextShape = AssertAll<CheckShape<Shapes["conversationContext"], EnrichedConversationContext>>;
type _externalAuthorShape = AssertAll<CheckShape<Shapes["externalAuthor"], EnrichedExternalAuthor>>;

// —— Negative fixtures: prove the gates fire (AD2's three cases). ——
// @ts-expect-error sizeBytes declared as string must fail the wire-family check
type _negWireType = AssertAll<{ sizeBytes: CheckNested<{ name: "sizeBytes"; wireType: "string"; nullable: false }, EnrichedAttachment> }>;

// @ts-expect-error seq declared nullable must fail the value-nullability check
type _negNullable = AssertAll<{ seq: CheckValue<{ name: "seq"; class: "canonicalRequired"; wireType: "number"; nullable: true; presence: typeof CANONICAL_MESSAGE_FIELD_DESCRIPTORS[8]["presence"] }, MessageNewRow> }>;
// @ts-expect-error a required key missing from the task projector must fail presence
type _negTaskPresence = AssertAll<{ id: CheckPresence<{ name: "id"; class: "canonicalRequired"; wireType: "string"; nullable: false; presence: { messageNew: "present"; enrichedUpdated: "present"; taskStatusUpdated: "present" } }, Omit<TaskRow, "id">, "taskStatusUpdated"> }>;

// Reference the assert aliases so they are not reported unused.
export type _CanonicalManifestTypeGates = [
  _valuesOnNew, _presenceNew, _presenceEnrichedUpdated, _presenceTaskUpdated, _valuesOnTask,
  _attachmentShape, _reactionShape, _mentionShape, _commentRefShape, _hostSourceShape,
  _conversationContextShape, _negWireType, _negNullable, _negTaskPresence,
  _externalAuthorShape,
];

// ——— G6 reverse closure (AD2 round-4): every registry producer's
//     post-projection payload key must be canonical or explicitly excluded ———

import {
  MESSAGE_REALTIME_PRODUCER_REGISTRY,
  attachmentCommentPrivacyScrubPayloadKeys,
} from "./messageRealtimeProducerRegistry.js";
import {
  CANONICAL_MESSAGE_EXCLUSIONS,
  CANONICAL_REQUIRED_MESSAGE_FIELDS,
  OPTIONAL_AGGREGATE_MESSAGE_FIELDS,
} from "@botiverse/raft-shared";

const CANONICAL_FIELD_SET = new Set<string>([
  ...CANONICAL_REQUIRED_MESSAGE_FIELDS,
  ...OPTIONAL_AGGREGATE_MESSAGE_FIELDS,
]);
const EXCLUDED_FIELD_SET = new Set<string>([
  ...CANONICAL_MESSAGE_EXCLUSIONS.taskDomainProjection.fields,
  ...CANONICAL_MESSAGE_EXCLUSIONS.emittedUnconsumed.fields,
]);
const SEALED_FIELD_SET = new Set<string>(CANONICAL_MESSAGE_EXCLUSIONS.storageOnlySealed.fields);
const PRIVACY_SCRUB_ID = "services/attachmentCommentService.ts#attachment-comment.privacy-scrub#message:updated";

function unclassifiedProducerKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !CANONICAL_FIELD_SET.has(key) && !EXCLUDED_FIELD_SET.has(key));
}

test("G6: every registry producer payload key is canonical or explicitly excluded", () => {
  assert.ok(MESSAGE_REALTIME_PRODUCER_REGISTRY.length >= 15, "registry must enumerate the closed producer set");
  for (const entry of MESSAGE_REALTIME_PRODUCER_REGISTRY) {
    if (entry.id === PRIVACY_SCRUB_ID) continue;
    const unclassified = unclassifiedProducerKeys(entry.payloadKeys);
    assert.deepEqual(
      unclassified,
      [],
      `${entry.id}: emitted keys missing from manifest canonical fields AND exclusion ledger — classify before emitting`,
    );
    for (const key of entry.payloadKeys) {
      assert.ok(!SEALED_FIELD_SET.has(key), `${entry.id}: ${key} is storage-only sealed and must never be post-projection wire`);
    }
  }
});

test("G6: the privacy-scrub surface is exactly {channelId, commentRef, id} and applies nowhere", () => {
  const entry = MESSAGE_REALTIME_PRODUCER_REGISTRY.find((candidate) => candidate.id === PRIVACY_SCRUB_ID);
  assert.ok(entry, "privacy-scrub surface must stay registered");
  assert.deepEqual([...entry.payloadKeys].sort(), ["channelId", "commentRef", "id"]);
  assert.deepEqual([...attachmentCommentPrivacyScrubPayloadKeys].sort(), ["channelId", "commentRef", "id"]);
  assert.match(entry.applyTarget, /no canonical|shared privacy-scrub|refresh/i,
    "privacy-scrub frames must not apply to canonical or overlay state");
});

test("G6 negative: an unclassified producer key is rejected", () => {
  const smuggled = unclassifiedProducerKeys(["id", "channelId", "mysteryInternalField"]);
  assert.deepEqual(smuggled, ["mysteryInternalField"], "closure helper must flag unclassified keys");
});
