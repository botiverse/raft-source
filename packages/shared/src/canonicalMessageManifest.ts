/**
 * Canonical message field manifest — the single machine-readable source for
 * the cross-platform message-domain fold contract (RFC 043 §6.3 amendment,
 * contract draft v3.1, #raft-mobile-reconcile 2026-07-11).
 *
 * Source-of-truth rule: every shape here mirrors the SERVER `message:*`
 * producer wire (messageService enrichment + the #4584 task-status projector),
 * NOT any client domain model. Web/KMP domain types are projections.
 *
 * Consumers:
 * - server: compile-time producer parity maps (enriched row nested shapes ==
 *   manifest) — the producer gate.
 * - web: compile-time bidirectional maps (fold-facing `Message` surface ==
 *   manifest top level) — G2 web half.
 * - mobile (KMP): generated JSON snapshot (`canonicalMessageManifest.json`),
 *   header-pinned to source commit + SHA-256, asserted against
 *   `CanonicalMessageRow` — G2 mobile half. T8 verifies both ends by hash.
 */

export const CANONICAL_MESSAGE_MANIFEST_VERSION = 5 as const;

export type CanonicalFieldClass = "canonicalRequired" | "optionalAggregate";

/**
 * Wire types are producer-contract types, not client decode conveniences.
 * - "string-union-raw": a server string union; consumers MUST keep the raw
 *   string in canonical state (unknown values preserved, never collapsed to
 *   null/default enums). Projection layers may parse.
 * - "structured-json": raw structured value; unknown keys MUST be preserved
 *   (typed head + extras). Parsing into business shapes is projection-only.
 */
export type CanonicalWireType =
  | "string"
  | "number"
  | "string-union-raw"
  | "structured-json"
  | "array<attachment>"
  | "array<reaction>"
  | "array<mention>"
  | "object<commentRef>"
  | "object<conversationContext>"
  | "object<externalAuthor>";

/** Presence of the field's key on a producer surface's frames. */
export type FamilyPresence = "present" | "absent";

/**
 * Field-level merge policy at fold ingress:
 * - "overwrite": present key overwrites (canonicalRequired fields).
 * - "present-overwrite": explicit presence; absent=preserve, present=overwrite
 *   (present-empty / present-null clears where nullable).
 * - "shared-null-preserve": a null VALUE on a shared (room-broadcast) surface
 *   is privacy-scrub, NOT a clear — preserve existing. Only a receiver-private
 *   authoritative surface may clear. (commentRef; settled 2026-07-11.)
 */
export type CanonicalMergePolicy = "overwrite" | "present-overwrite" | "shared-null-preserve";

export interface CanonicalFieldDescriptor {
  name: string;
  class: CanonicalFieldClass;
  wireType: CanonicalWireType;
  /** Whether the VALUE may be null when the key is present. */
  nullable: boolean;
  mergePolicy: CanonicalMergePolicy;
  /** Key presence per producer surface (verified against producer types, not
   *  client models). canonicalRequired fields are present on all surfaces by
   *  definition (absence = schema-invalid, fail closed).
   *  - messageNew: `message:new` broadcast (enriched row + conversationContext)
   *  - enrichedUpdated: `message:updated` via getMessageContext reload
   *    (NO conversationContext — it is creation-time identity, never updated)
   *  - taskStatusUpdated: `message:updated` via the #4584 task projector */
  presence: {
    messageNew: FamilyPresence;
    enrichedUpdated: FamilyPresence;
    taskStatusUpdated: FamilyPresence;
  };
}

export interface CanonicalNestedFieldDescriptor {
  name: string;
  wireType:
    | "string"
    | "number"
    | "string-union-raw"
    | "array<string>"
    | "object<hostSource>";
  nullable: boolean;
  /** Key may be omitted inside the nested object (producer builds it conditionally). */
  optionalKey?: true;
}

const present = { messageNew: "present", enrichedUpdated: "present", taskStatusUpdated: "present" } as const;
const enrichedOnly = { messageNew: "present", enrichedUpdated: "present", taskStatusUpdated: "absent" } as const;
const newOnly = { messageNew: "present", enrichedUpdated: "absent", taskStatusUpdated: "absent" } as const;

/** Top-level canonical fields: 10 required + 10 optionalAggregate = 20. */
export const CANONICAL_MESSAGE_FIELD_DESCRIPTORS = Object.freeze([
  // —— canonicalRequired (fail-closed; resolved rows use non-null types for
  //    id/channelId/senderType/senderId/content/createdAt) ——
  { name: "channelId", class: "canonicalRequired", wireType: "string", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "content", class: "canonicalRequired", wireType: "string", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "createdAt", class: "canonicalRequired", wireType: "string", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "id", class: "canonicalRequired", wireType: "string", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "messageType", class: "canonicalRequired", wireType: "string-union-raw", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "randomId", class: "canonicalRequired", wireType: "string", nullable: true, mergePolicy: "overwrite", presence: present },
  { name: "senderId", class: "canonicalRequired", wireType: "string", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "senderType", class: "canonicalRequired", wireType: "string-union-raw", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "seq", class: "canonicalRequired", wireType: "number", nullable: false, mergePolicy: "overwrite", presence: present },
  { name: "threadId", class: "canonicalRequired", wireType: "string", nullable: true, mergePolicy: "overwrite", presence: present },
  // —— optionalAggregate (explicit presence; absent=preserve, present=overwrite) ——
  { name: "actionMetadata", class: "optionalAggregate", wireType: "structured-json", nullable: true, mergePolicy: "present-overwrite", presence: present },
  { name: "attachments", class: "optionalAggregate", wireType: "array<attachment>", nullable: false, mergePolicy: "present-overwrite", presence: enrichedOnly },
  { name: "commentRef", class: "optionalAggregate", wireType: "object<commentRef>", nullable: true, mergePolicy: "shared-null-preserve", presence: enrichedOnly },
  { name: "conversationContext", class: "optionalAggregate", wireType: "object<conversationContext>", nullable: false, mergePolicy: "present-overwrite", presence: newOnly },
  { name: "externalAuthor", class: "optionalAggregate", wireType: "object<externalAuthor>", nullable: true, mergePolicy: "present-overwrite", presence: enrichedOnly },
  { name: "mentions", class: "optionalAggregate", wireType: "array<mention>", nullable: false, mergePolicy: "present-overwrite", presence: enrichedOnly },
  { name: "reactions", class: "optionalAggregate", wireType: "array<reaction>", nullable: false, mergePolicy: "present-overwrite", presence: enrichedOnly },
  { name: "senderDescription", class: "optionalAggregate", wireType: "string", nullable: true, mergePolicy: "present-overwrite", presence: enrichedOnly },
  { name: "senderMembershipStatus", class: "optionalAggregate", wireType: "string-union-raw", nullable: true, mergePolicy: "present-overwrite", presence: enrichedOnly },
  { name: "senderName", class: "optionalAggregate", wireType: "string", nullable: false, mergePolicy: "present-overwrite", presence: present },
] as const) satisfies ReadonlyArray<CanonicalFieldDescriptor>;

/**
 * Nested wire shapes, mirrored from the server producer exactly:
 * - attachment: messageService enrichment map (8 fields — NO
 *   rasterPreviewUrl/localPreviewUrl; those are a separate attachments route
 *   and a web-optimistic blob respectively, not message wire).
 * - reaction / mention / commentRef / conversationContext: enrichment shapes.
 */
function nestedShape<const T extends ReadonlyArray<CanonicalNestedFieldDescriptor>>(fields: T): T {
  return Object.freeze(fields);
}

export const CANONICAL_NESTED_WIRE_SHAPES = Object.freeze({
  attachment: nestedShape([
    // commentCount is viewer-scoped (shared strip forces 0) — excluded from the
    // canonical shared attachment fact; see viewerScopedFields.
    { name: "filename", wireType: "string", nullable: false },
    { name: "height", wireType: "number", nullable: true },
    { name: "id", wireType: "string", nullable: false },
    { name: "mimeType", wireType: "string", nullable: false },
    { name: "sizeBytes", wireType: "number", nullable: false },
    { name: "thumbnailUrl", wireType: "string", nullable: true },
    { name: "width", wireType: "number", nullable: true },
  ]),
  reaction: nestedShape([
    { name: "count", wireType: "number", nullable: false },
    { name: "emoji", wireType: "string", nullable: false },
    { name: "reactorIds", wireType: "array<string>", nullable: false },
    { name: "reactorNames", wireType: "array<string>", nullable: false },
  ]),
  mention: nestedShape([
    { name: "id", wireType: "string", nullable: false },
    { name: "name", wireType: "string", nullable: false },
    { name: "type", wireType: "string-union-raw", nullable: false },
  ]),
  commentRef: nestedShape([
    { name: "anchorLabel", wireType: "string", nullable: true },
    { name: "anchorQuote", wireType: "string", nullable: true },
    { name: "attachmentId", wireType: "string", nullable: false },
    { name: "filename", wireType: "string", nullable: false },
    { name: "hostMessageId", wireType: "string", nullable: true },
    { name: "hostSource", wireType: "object<hostSource>", nullable: true },
  ]),
  commentRefHostSource: nestedShape([
    { name: "channelId", wireType: "string", nullable: false },
    { name: "parentMessageId", wireType: "string", nullable: false, optionalKey: true },
    { name: "rootThreadChannelId", wireType: "string", nullable: false, optionalKey: true },
    { name: "routeKind", wireType: "string-union-raw", nullable: false },
    { name: "threadChannelId", wireType: "string", nullable: false, optionalKey: true },
    { name: "type", wireType: "string-union-raw", nullable: false },
  ]),
  conversationContext: nestedShape([
    { name: "channelType", wireType: "string-union-raw", nullable: false },
    { name: "parentChannelId", wireType: "string", nullable: false, optionalKey: true },
    { name: "parentChannelType", wireType: "string-union-raw", nullable: false, optionalKey: true },
    { name: "parentMessageId", wireType: "string", nullable: false, optionalKey: true },
  ]),
  externalAuthor: nestedShape([
    { name: "actorKind", wireType: "string-union-raw", nullable: false },
    { name: "actorProjectionRevision", wireType: "number", nullable: false },
    { name: "appRegistrationId", wireType: "string", nullable: false },
    { name: "avatarDigest", wireType: "string", nullable: true },
    { name: "avatarUrl", wireType: "string", nullable: true },
    { name: "displayName", wireType: "string", nullable: false },
    { name: "externalActorId", wireType: "string", nullable: false },
    { name: "externalConversationId", wireType: "string", nullable: false },
    { name: "externalMessageId", wireType: "string", nullable: false },
    { name: "installId", wireType: "string", nullable: false },
    { name: "projectionId", wireType: "string", nullable: false },
    { name: "provider", wireType: "string", nullable: false },
    { name: "workspaceId", wireType: "string", nullable: false },
  ]),
} as const);

/** Derived name lists (declaration-sorted) for key-set gates. */
export const CANONICAL_REQUIRED_MESSAGE_FIELDS = Object.freeze(
  CANONICAL_MESSAGE_FIELD_DESCRIPTORS.filter((d) => d.class === "canonicalRequired").map((d) => d.name),
) as readonly string[];
export const OPTIONAL_AGGREGATE_MESSAGE_FIELDS = Object.freeze(
  CANONICAL_MESSAGE_FIELD_DESCRIPTORS.filter((d) => d.class === "optionalAggregate").map((d) => d.name),
) as readonly string[];
export const TASK_STATUS_FAMILY_PRESENT_AGGREGATES = Object.freeze(
  CANONICAL_MESSAGE_FIELD_DESCRIPTORS
    .filter((d) => d.class === "optionalAggregate" && d.presence.taskStatusUpdated === "present")
    .map((d) => d.name),
) as readonly string[];
export const EXCLUDED_CLIENT_ONLY_MESSAGE_FIELDS = Object.freeze(["optimisticDisplaySeq"]) as readonly string[];

/**
 * Explicit exclusion ledger (no-silent-absence). Every field a producer emits
 * that is NOT canonical must appear here with its class and migration status —
 * "excluded from the manifest" never means "safe for a client to drop" until
 * its migrationStatus says so.
 */
export const CANONICAL_MESSAGE_EXCLUSIONS = Object.freeze({
  /** task-domain projection riding the message carrier: authority=task,
   *  applyTarget=task-domain, messageFold=excluded. Fan out to the task
   *  consumer at ingress; message fold never applies these. */
  taskDomainProjection: Object.freeze({
    fields: ["taskAssigneeId", "taskAssigneeName", "taskAssigneeType", "taskClaimedAt", "taskCompletedAt", "taskCurrentProjection", "taskNumber", "taskStatus"] as readonly string[],
    migrationStatus: "active-consumers (web taskStore / KMP task projection); dual-dispatch at ingress",
  }),
  /** Emitted but consumed by no canonical client surface. */
  emittedUnconsumed: Object.freeze({
    fields: ["updatedAt"] as readonly string[],
    migrationStatus: "web canonical zero-consumption; mobile legacy consumption to retire in round-2 (label/event-key/SQL cache -> (epoch,seq,id/revision) adjudication)",
  }),
  /** Viewer-scoped nested metadata: shared broadcasts strip these; truth comes
   *  only from actor-scoped HTTP / receiver-private surfaces. */
  viewerScopedFields: Object.freeze({
    fields: ["attachment.commentCount"] as readonly string[],
    migrationStatus: "overlay-domain data; never apply shared-stripped values to canonical or overlay state",
  }),
  /** Client-local optimistic coordinates, never server facts. */
  clientOnly: Object.freeze({
    fields: ["optimisticDisplaySeq"] as readonly string[],
    migrationStatus: "n/a (never on wire)",
  }),
  /** Storage/idempotency/search-only DB columns. Sealed at the socket boundary
   *  by projectRichMessageSocketPayload (slock#4593, merged b0fcdfd9). Never on
   *  any post-projection wire frame. */
  storageOnlySealed: Object.freeze({
    fields: ["agentSendKey", "searchText", "searchVector"] as readonly string[],
    migrationStatus: "sealed server-side; G6 registry gate enforces post-projection shape",
  }),
});

export type CanonicalMessageField =
  | "channelId" | "content" | "createdAt" | "id" | "messageType" | "randomId"
  | "senderId" | "senderType" | "seq" | "threadId"
  | "actionMetadata" | "attachments" | "commentRef" | "conversationContext"
  | "externalAuthor" | "mentions" | "reactions" | "senderDescription" | "senderMembershipStatus" | "senderName";

export interface CanonicalMessageManifest {
  version: typeof CANONICAL_MESSAGE_MANIFEST_VERSION;
  /** Producer surface registry anchor: slock#4593 merged commit. The registry
   *  (messageRealtimeEvents.test.ts) is the closed set of producer surfaces;
   *  its post-projection payload keys are the G6 source. */
  producerRegistryAnchor: string;
  fields: ReadonlyArray<CanonicalFieldDescriptor>;
  nestedWireShapes: typeof CANONICAL_NESTED_WIRE_SHAPES;
  exclusions: typeof CANONICAL_MESSAGE_EXCLUSIONS;
  excludedClientOnly: ReadonlyArray<string>;
}

export const CANONICAL_MESSAGE_MANIFEST: CanonicalMessageManifest = Object.freeze({
  version: CANONICAL_MESSAGE_MANIFEST_VERSION,
  producerRegistryAnchor: "slock#4593@b0fcdfd9fae9f0af9b32a87a1d5c3e196d3fdaa1",
  fields: CANONICAL_MESSAGE_FIELD_DESCRIPTORS,
  nestedWireShapes: CANONICAL_NESTED_WIRE_SHAPES,
  exclusions: CANONICAL_MESSAGE_EXCLUSIONS,
  excludedClientOnly: EXCLUDED_CLIENT_ONLY_MESSAGE_FIELDS,
});

/** Deterministic serialization for cross-repo SHA-256 pinning. */
export function canonicalMessageManifestJson(): string {
  return `${JSON.stringify(CANONICAL_MESSAGE_MANIFEST, null, 2)}\n`;
}
