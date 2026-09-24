import "@typespec/http";
import "@typespec/json-schema";
import "@typespec/openapi3";

using TypeSpec.Http;
using TypeSpec.JsonSchema;

@service(#{ title: "Raft Activity Sync Contract v1 (experimental successor)" })
@route("/api/channels")
@jsonSchema
namespace Raft.ActivitySync.V1;

@pattern("^(0|[1-9][0-9]*)$")
scalar UInt64String extends string;

scalar OpaqueId extends string;
scalar UtcInstantString extends string;

enum ActivityFilter {
  all,
  unread,
  mentions,
}

enum ActorKind {
  user,
  agent,
  system,
  external_projection,
}

enum ChannelKind {
  channel,
  private,
  joint,
  dm,
}

enum ActivitySyncState {
  empty,
  loading,
  ready,
  stale,
  recovering,
}

enum TombstoneReason {
  done,
  deleted,
  outOfWindow,
}

enum ContractErrorCode {
  invalidRequest,
  staleVersion,
  unauthorized,
  forbidden,
  conflict,
  unavailable,
  internal,
}

model ActivityScope {
  serverId: OpaqueId;
  principalId: OpaqueId;
  filter: ActivityFilter;
  windowId: OpaqueId;
}

model ActivityRowCommon {
  rowId: OpaqueId;
  rowVersion: UInt64String;
  /** Authoritative content-frontier message seq (DB bigint canonical decimal string).
   * The Done/read/reactivation marker authority — replyCount is display-only and must
   * never veto it (task #361 three-axis contract). Required non-null: every row kind
   * carries it same-source (thread = latest reply seq, zero-reply = parent seq; channel/dm
   * = last message seq; mention = mention seq). Canonical decimal string, no leading zeros,
   * safe up to 2^53. */
  latestActivitySeq: UInt64String;
  lastActivityAt: UtcInstantString;
  unreadCount: uint32;
  hasMention: boolean;
  firstUnreadMessageId: OpaqueId | null;
  firstMentionMessageId: OpaqueId | null;
  maxReadSeq: UInt64String;
  readStateVersion: UInt64String;
}

model ChannelActivityRow {
  ...ActivityRowCommon;
  type: "channel";
  channelId: OpaqueId;
  channelName: string;
  channelKind: "channel" | "private" | "joint";
  lastMessageId: OpaqueId;
  lastMessagePreview: string;
  lastMessageSenderKind: ActorKind;
  lastMessageSenderId: OpaqueId;
  lastMessageSenderName: string | null;
}

model DmActivityRow {
  ...ActivityRowCommon;
  type: "dm";
  channelId: OpaqueId;
  channelName: string;
  channelKind: "dm";
  lastMessageId: OpaqueId;
  lastMessagePreview: string;
  lastMessageSenderKind: ActorKind;
  lastMessageSenderId: OpaqueId;
  lastMessageSenderName: string | null;
}

model ThreadActivityRow {
  ...ActivityRowCommon;
  type: "thread";
  threadChannelId: OpaqueId;
  parentMessageId: OpaqueId;
  parentChannelId: OpaqueId;
  parentChannelName: string;
  parentChannelKind: ChannelKind;
  parentMessagePreview: string;
  parentMessageSenderKind: "user" | "agent" | "external_projection";
  parentMessageSenderId: OpaqueId;
  latestActivityPreview: string;
  latestActivitySenderKind: ActorKind;
  latestActivitySenderId: OpaqueId;
  latestActivitySenderName: string | null;
  latestActivityMessageId: OpaqueId;
  /** Follow state affects controls and attention only. Unfollowed rows remain
   * in the All feed while not Done, with unreadCount=0 and hasMention=false. */
  isFollowing: boolean;
  replyCount: uint32;
  lastReplyAt: UtcInstantString | null;
  taskNumber: uint32 | null;
  taskStatus: string | null;
  taskClaimedByName: string | null;
}

@discriminated(#{
  envelope: "none",
  discriminatorPropertyName: "type"
})
@oneOf
union ActivityRow {
  channel: ChannelActivityRow,
  dm: DmActivityRow,
  thread: ThreadActivityRow,
}

model ActivityRowTombstone {
  rowId: OpaqueId;
  rowVersion: UInt64String;
  reason: TombstoneReason;
}

model ActivityWindow {
  rows: ActivityRow[];
  tombstones: ActivityRowTombstone[];
  nextCursor: string | null;
  hasMore: boolean;
  complete: boolean;
  totalCount: uint32;
  totalUnreadCount: uint32;
}

model AffectedReadState {
  scopeId: OpaqueId;
  channelId: OpaqueId | null;
  maxReadSeq: UInt64String;
  readStateVersion: UInt64String;
}

/**
 * FUTURE (V2) — not returned by any V1 route.
 *
 * Kept as frozen vocabulary so the V2 command protocol has a stable shape, and
 * so the ingress union can carry a receipt once the server emits one. Attaching
 * it to a V1 200 response is what made the contract lie; do not re-attach it
 * without a route that actually returns it.
 */
model ActivityCommandReceipt {
  commandId: OpaqueId;
  applied: boolean;
  activityVersion: UInt64String;
  affectedScopes: AffectedReadState[];
  tombstones: ActivityRowTombstone[];
}

model ContractError {
  code: ContractErrorCode;
  message: string;
  retryable: boolean;
}

model SnapshotIngress {
  type: "snapshot";
  requestId: OpaqueId;
  scope: ActivityScope;
  epoch: UInt64String;
  watermark: UInt64String;
  activityVersion: UInt64String;
  window: ActivityWindow;
}

model NotModifiedIngress {
  type: "notModified";
  requestId: OpaqueId;
  scope: ActivityScope;
  epoch: UInt64String;
  watermark: UInt64String;
  activityVersion: UInt64String;
}

model DifferenceIngress {
  type: "difference";
  requestId: OpaqueId;
  scope: ActivityScope;
  epoch: UInt64String;
  fromSeq: UInt64String;
  toSeq: UInt64String;
  activityVersion: UInt64String;
  rows: ActivityRow[];
  tombstones: ActivityRowTombstone[];
  nextCursor: string | null;
  hasMore: boolean;
  complete: boolean;
  totalCount: uint32;
  totalUnreadCount: uint32;
  nextFromSeq: UInt64String | null;
}

model FrameIngress {
  type: "frame";
  scope: ActivityScope;
  epoch: UInt64String;
  seq: UInt64String;
  activityVersion: UInt64String;
  rows: ActivityRow[];
  tombstones: ActivityRowTombstone[];
}

model CommandReceiptIngress {
  type: "commandReceipt";
  scope: ActivityScope;
  receipt: ActivityCommandReceipt;
}

model CommandRejectedIngress {
  type: "commandRejected";
  scope: ActivityScope;
  commandId: OpaqueId;
  activityVersion: UInt64String | null;
  error: ContractError;
}

model ReadStateUpdatedIngress {
  type: "readStateUpdated";
  scope: ActivityScope;
  epoch: UInt64String;
  seq: UInt64String;
  activityVersion: UInt64String;
  updates: AffectedReadState[];
}

@discriminated(#{
  envelope: "none",
  discriminatorPropertyName: "type"
})
@oneOf
union ActivityIngress {
  snapshot: SnapshotIngress,
  notModified: NotModifiedIngress,
  difference: DifferenceIngress,
  frame: FrameIngress,
  commandReceipt: CommandReceiptIngress,
  commandRejected: CommandRejectedIngress,
  readStateUpdated: ReadStateUpdatedIngress,
}

model EnsureWindowIntent {
  type: "ensureWindow";
  scope: ActivityScope;
}

model RefreshIntent {
  type: "refresh";
  scope: ActivityScope;
}

model LoadMoreIntent {
  type: "loadMore";
  scope: ActivityScope;
  cursor: string;
}

model MarkChannelReadAllIntent {
  type: "markChannelReadAll";
  scope: ActivityScope;
  commandId: OpaqueId;
  channelId: OpaqueId;
  throughSeq: UInt64String;
}

model MarkInboxReadAllIntent {
  type: "markInboxReadAll";
  scope: ActivityScope;
  commandId: OpaqueId;
  throughSeq: UInt64String;
}

model MarkThreadDoneIntent {
  type: "markThreadDone";
  scope: ActivityScope;
  commandId: OpaqueId;
  threadChannelId: OpaqueId;
  /** Authoritative content-frontier seq this Done covers. Monotonic write:
   * must be a positive canonical decimal string (`0` is invalid);
   * server sets doneThrough = max(existing, throughActivitySeq) and rejects
   * throughActivitySeq > currentLatest with 409 + zero write (never clamps).
   * Replaces the strict-CAS expectedRowVersion (task #361 Gate B2). */
  throughActivitySeq: UInt64String;
}

model MarkInboxDoneIntent {
  type: "markInboxDone";
  scope: ActivityScope;
  commandId: OpaqueId;
  rowId: OpaqueId;
  /** Authoritative content-frontier seq this Done covers. Monotonic write:
   * must be a positive canonical decimal string (`0` is invalid);
   * server sets doneThrough = max(existing, throughActivitySeq) and rejects
   * throughActivitySeq > currentLatest with 409 + zero write (never clamps).
   * Replaces the strict-CAS expectedRowVersion (task #361 Gate B2). */
  throughActivitySeq: UInt64String;
}

@discriminated(#{
  envelope: "none",
  discriminatorPropertyName: "type"
})
@oneOf
union ActivityIntent {
  ensureWindow: EnsureWindowIntent,
  refresh: RefreshIntent,
  loadMore: LoadMoreIntent,
  markChannelReadAll: MarkChannelReadAllIntent,
  markInboxReadAll: MarkInboxReadAllIntent,
  markThreadDone: MarkThreadDoneIntent,
  markInboxDone: MarkInboxDoneIntent,
}

model ActivityScopeState {
  scope: ActivityScope;
  epoch: UInt64String | null;
  watermark: UInt64String | null;
  activityVersion: UInt64String | null;
  revision: UInt64String;
  syncState: ActivitySyncState;
  window: ActivityWindow;
}

model FixtureInitialState {
  scopes: ActivityScopeState[];
}

model IngestFixtureStep {
  type: "ingest";
  stepId: OpaqueId;
  ingress: ActivityIngress;
}

model DispatchFixtureStep {
  type: "dispatch";
  stepId: OpaqueId;
  intent: ActivityIntent;
}

model CheckpointFixtureStep {
  type: "checkpoint";
  stepId: OpaqueId;
  checkpointId: OpaqueId;
}

model RestartFixtureStep {
  type: "restart";
  stepId: OpaqueId;
  mode: "cold" | "persisted";
}

@discriminated(#{
  envelope: "none",
  discriminatorPropertyName: "type"
})
@oneOf
union ActivityFixtureStep {
  ingest: IngestFixtureStep,
  dispatch: DispatchFixtureStep,
  checkpoint: CheckpointFixtureStep,
  restart: RestartFixtureStep,
}

model ActivityFixtureEnvelope {
  contract: "raft.activity-sync";
  contractVersion: 1;
  runnerProtocol: 1;
  status: "experimental";
  caseId: OpaqueId;
  description: string;
  initialState: FixtureInitialState;
  steps: ActivityFixtureStep[];
}

enum ConstraintClass {
  positive,
  structural,
  valueDomain,
}

enum ContractVerdict {
  accept,
  reject,
  exempt,
}

model ContractVectorExpectation {
  validator: ContractVerdict;
  typescriptStatic: ContractVerdict;
  kotlinRuntime: ContractVerdict;
}

model ContractVectorEnvelope {
  vectorId: OpaqueId;
  constraintClass: ConstraintClass;
  candidate: unknown;
  expectation: ContractVectorExpectation;
  reason: string;
}

model InboxQuery {
  filter?: ActivityFilter;
  cursor?: string;
  limit?: uint32;
  epoch?: UInt64String;
  activityVersion?: UInt64String;
}

model CommandRequest {
  commandId: OpaqueId;
  expectedActivityVersion: UInt64String;
}

model MarkChannelReadAllRequest {
  commandId: OpaqueId;
  expectedActivityVersion: UInt64String;
  throughSeq: UInt64String;
}

model MarkInboxReadAllRequest {
  commandId: OpaqueId;
  expectedActivityVersion: UInt64String;
  throughSeq: UInt64String;
}

@error
model BadRequestResponse {
  @statusCode statusCode: 400;
  @body body: ContractError;
}

@error
model UnauthorizedResponse {
  @statusCode statusCode: 401;
  @body body: ContractError;
}

@error
model ForbiddenResponse {
  @statusCode statusCode: 403;
  @body body: ContractError;
}

@error
model ConflictResponse {
  @statusCode statusCode: 409;
  @body body: ContractError;
}

/**
 * The server fail-closes with 404 rather than 403 for scope/permission
 * failures, so an unauthorized caller cannot probe existence. Verified against
 * the live routes ("Thread not found" / "Chat not found"), and it is the status
 * @John's non-thread scope gate returns. Omitting it left the contract unable
 * to describe the single most common failure these routes produce.
 */
@error
model NotFoundResponse {
  @statusCode statusCode: 404;
  @body body: ContractError;
}

@error
model UnavailableResponse {
  @statusCode statusCode: 503;
  @body body: ContractError;
}

/**
 * V1 error body — what every route-level failure actually returns.
 *
 * The contract previously declared `ContractError {code,message,retryable}`,
 * which no route emits. The real shape is a single `error` string; a client
 * generated from the old contract could not decode a 400/404/500 at all.
 */
/**
 * Real V1 request bodies, taken from the router.
 *
 * The contract previously required `commandId`/`expectedActivityVersion`/
 * `throughSeq` on all four routes — V2 vocabulary the server never reads —
 * while omitting the only fields it does read. A client generated from that
 * would have sent the wrong payload to every write route.
 */
model V1MarkInboxDoneRequest {
  channelId: OpaqueId;
  /** Positive canonical decimal content frontier; `0` is invalid. */
  throughActivitySeq: UInt64String;
  /** Sequence-space identity required before the strict Done guard runs. */
  frontierSpace: "storage";
}

model V1MarkThreadDoneRequest {
  threadChannelId: OpaqueId;
  /** Positive canonical decimal content frontier; `0` is invalid. */
  throughActivitySeq: UInt64String;
  /** Sequence-space identity required before the strict Done guard runs. */
  frontierSpace: "storage";
}

/**
 * Real `GET /api/channels/inbox` page body.
 *
 * The contract declared this route as returning the future sync ingress union
 * (SnapshotIngress or DifferenceIngress). The live route returns an inbox PAGE.
 * That declaration survived three earlier corrections because the audits
 * targeted the write routes and never questioned the read.
 */
model V1InboxPage {
  items: unknown[];
  hasMore: boolean;
  totalCount: SafeUnsignedCounter;
  totalUnreadCount: SafeUnsignedCounter;
  activeUnreadCount: SafeUnsignedCounter;
}

model V1ErrorBody {
  error: string;
}

/** Done shares legacy request validation with a machine-readable frontier gate. */
model V1DoneBadRequestBody {
  error: string;
  code?: string;
}

model V1DoneConflictBody {
  error: string;
  code: string;
}

/** `requireAuth` adds a machine-readable `code` alongside the message. */
model V1AuthErrorBody {
  error: string;
  code: string;
}

@error
model V1UnauthorizedResponse {
  @statusCode statusCode: 401;
  @body body: V1AuthErrorBody;
}

@error
model V1ForbiddenResponse {
  @statusCode statusCode: 403;
  @body body: V1ErrorBody;
}

@error
model V1BadRequestResponse {
  @statusCode statusCode: 400;
  @body body: V1ErrorBody;
}

@error
model V1DoneBadRequestResponse {
  @statusCode statusCode: 400;
  @body body: V1DoneBadRequestBody;
}

/** A bounded Done frontier is beyond the target or its active cursor authority. */
@error
model V1ConflictResponse {
  @statusCode statusCode: 409;
  @body body: V1DoneConflictBody;
}

/** A pre-upgrade request has no sequence-space identity and must refresh. */
@error
model V1PreconditionFailedResponse {
  @statusCode statusCode: 412;
  @body body: V1DoneConflictBody;
}

@error
model V1NotFoundResponse {
  @statusCode statusCode: 404;
  @body body: V1ErrorBody;
}

@error
model V1InternalErrorResponse {
  @statusCode statusCode: 500;
  @body body: V1ErrorBody;
}

/**
 * Real 202 admission outcome (`sendCompatibilityReadPending`).
 *
 * A compatibility read-mutation may be admitted rather than committed; the
 * caller must poll `frontierUrl`. This existed in production and was entirely
 * absent from the contract, so a generated client had no way to represent
 * "accepted, outcome unknown" and would treat it as an unexpected status.
 */
model V1AdmittedResponse {
  code: string;
  status: "admitted";
  outcome: "unknown";
  mutationId: string;
  authoritySeq: SafeUnsignedCounter;
  frontierUrl: string;
}

/**
 * V1 write responses — what the CURRENT server actually returns.
 *
 * These are deliberately NOT `ActivityCommandReceipt`. The contract previously
 * declared all four write operations as returning a full receipt while the live
 * server returns these shapes, i.e. the transport contract described a protocol
 * nobody implements. Describing reality is the point of this file.
 *
 * NOTE — these seq/version fields are LEGACY LOSSY NUMBERS.
 *
 * The server types them `number` (`channelService.ts` `maxReadSeq: number`), so
 * they cross the wire as JSON numbers with JS Number precision — the live V1
 * routes already truncate above 2^53 today.
 *
 * They are `safeint`, deliberately NOT `int64` and NOT `UInt64String`:
 *   - `UInt64String` would claim an exactness the wire does not have;
 *   - `int64` would claim the full signed-64 range, which is also false —
 *     anything past 2^53 is already lossy before it reaches a consumer.
 * `safeint` states the real guarantee: an integer only trustworthy inside the
 * JS safe range.
 *
 * HARD RULE: these values must never be promoted into the core's authoritative
 * `bigint` sequence path. The core's exactness proof depends on values that
 * were exact on the wire; laundering a lossy number into a `SyncSeq` would
 * silently reintroduce the precision defect the whole contract exists to
 * prevent. Exact representation arrives with the V2 receipt.
 */
@doc("Legacy lossy counter: a JSON number trustworthy only within the JS safe-integer range. Bounds are explicit because bare `safeint` emitted an unbounded integer to JSON Schema and `format: int64` to OpenAPI, overstating a range the wire cannot carry.")
@minValue(0)
@maxValue(9007199254740991)
scalar SafeUnsignedCounter extends safeint;

model V1AffectedReadState {
  scopeId: OpaqueId;
  maxReadSeq: SafeUnsignedCounter;
  readStateVersion: SafeUnsignedCounter;
}

model V1MarkInboxReadAllResponse {
  /** Literal: the server only emits this body on success. */
  ok: true;
  @minValue(0) markedCount: int32;
  scopes: V1AffectedReadState[];
}

model V1MarkChannelReadAllResponse {
  ok: true;
  seq: SafeUnsignedCounter;
  readStateVersion: SafeUnsignedCounter;
}

/** Both `done` routes return only an HTTP-success acknowledgement today. */
model V1AckResponse {
  ok: true;
}

/**
 * Explicit repair outcome. A caller with an old epoch, a future watermark, or
 * a watermark older than the retained dense journal must fetch a snapshot;
 * the server never fabricates continuity.
 */
model SnapshotRequiredBody {
  snapshotRequired: true;
  requestId: OpaqueId;
  scope: ActivityScope;
  epoch: UInt64String;
  watermark: UInt64String;
  activityVersion: UInt64String;
}

@error
model SnapshotRequiredResponse {
  @statusCode statusCode: 409;
  @body body: SnapshotRequiredBody;
}

@route("/activity/snapshot")
@get
op getActivitySnapshot(
  @query requestId: OpaqueId,
  @query filter?: ActivityFilter,
  @query windowId?: "main",
):
  | {
      @statusCode statusCode: 200;
      @body body: SnapshotIngress;
    }
  | V1BadRequestResponse
  | V1UnauthorizedResponse
  | V1ForbiddenResponse
  | V1InternalErrorResponse;

@route("/activity/difference")
@get
op getActivityDifference(
  @query requestId: OpaqueId,
  @query epoch: UInt64String,
  @query afterWatermark: UInt64String,
  @query filter?: ActivityFilter,
  @query windowId?: "main",
):
  | {
      @statusCode statusCode: 200;
      @body body: DifferenceIngress | NotModifiedIngress;
    }
  | SnapshotRequiredResponse
  | V1BadRequestResponse
  | V1UnauthorizedResponse
  | V1ForbiddenResponse
  | V1InternalErrorResponse;

@route("/inbox")
@get
op getInbox(
  @query filter?: ActivityFilter,
  @query limit?: int32,
  @query offset?: int32,
  @query channelId?: OpaqueId,
  @query q?: string,
  @query sort?: "asc" | "desc",
):
  | {
      @statusCode statusCode: 200;
      @body body: V1InboxPage;
    }
  | V1BadRequestResponse
  | V1UnauthorizedResponse
  | V1ForbiddenResponse
  | V1InternalErrorResponse;

@route("/inbox/read-all")
@post
// No request body: the handler derives everything from serverId/userId.
op markInboxReadAll():
  | {
      @statusCode statusCode: 200;
      @body body: V1MarkInboxReadAllResponse;
    }
  | {
      @statusCode statusCode: 202;
      @body body: V1AdmittedResponse;
    }
  | V1BadRequestResponse
  | V1UnauthorizedResponse
  | V1ForbiddenResponse
  | V1InternalErrorResponse;

@route("/{channelId}/read-all")
@post
// Scope comes from the path; the handler ignores the body.
op markChannelReadAll(@path channelId: OpaqueId):
  | {
      @statusCode statusCode: 200;
      @body body: V1MarkChannelReadAllResponse;
    }
  | {
      @statusCode statusCode: 202;
      @body body: V1AdmittedResponse;
    }
  | V1BadRequestResponse
  | V1UnauthorizedResponse
  | V1ForbiddenResponse
  | V1NotFoundResponse
  | V1InternalErrorResponse;

@route("/inbox/done")
@post
op markInboxDone(@body request: V1MarkInboxDoneRequest):
  | {
      @statusCode statusCode: 200;
      @body body: V1AckResponse;
    }
  | {
      @statusCode statusCode: 202;
      @body body: V1AdmittedResponse;
    }
  | V1DoneBadRequestResponse
  | V1ConflictResponse
  | V1PreconditionFailedResponse
  | V1UnauthorizedResponse
  | V1ForbiddenResponse
  | V1NotFoundResponse
  | V1InternalErrorResponse;

@route("/threads/done")
@post
op markThreadDone(@body request: V1MarkThreadDoneRequest):
  | {
      @statusCode statusCode: 200;
      @body body: V1AckResponse;
    }
  | {
      @statusCode statusCode: 202;
      @body body: V1AdmittedResponse;
    }
  | V1DoneBadRequestResponse
  | V1ConflictResponse
  | V1PreconditionFailedResponse
  | V1UnauthorizedResponse
  | V1ForbiddenResponse
  | V1NotFoundResponse
  | V1InternalErrorResponse;
