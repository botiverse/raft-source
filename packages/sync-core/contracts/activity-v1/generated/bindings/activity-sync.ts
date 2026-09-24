// Generated directly from activity-sync.tsp via the TypeSpec compiler semantic graph.

// DO NOT EDIT. JSON Schema and OpenAPI are parallel outputs, not inputs.

// Runtime raw-byte validation remains mandatory; TypeScript types are erased.



export type OpaqueId = string;

export type SafeUnsignedCounter = number;

/** Runtime-only constraint: "^(0|[1-9][0-9]*)$". Static TypeScript cannot enforce this pattern. */
export type UInt64String = string;

export type UtcInstantString = string;

export type ActivityFilter = "all" | "unread" | "mentions";

export type ActivitySyncState = "empty" | "loading" | "ready" | "stale" | "recovering";

export type ActorKind = "user" | "agent" | "system" | "external_projection";

export type ChannelKind = "channel" | "private" | "joint" | "dm";

export type ConstraintClass = "positive" | "structural" | "valueDomain";

export type ContractErrorCode = "invalidRequest" | "staleVersion" | "unauthorized" | "forbidden" | "conflict" | "unavailable" | "internal";

export type ContractVerdict = "accept" | "reject" | "exempt";

export type TombstoneReason = "done" | "deleted" | "outOfWindow";

export interface ActivityCommandReceipt {
  readonly commandId: OpaqueId;
  readonly applied: boolean;
  readonly activityVersion: UInt64String;
  readonly affectedScopes: ReadonlyArray<AffectedReadState>;
  readonly tombstones: ReadonlyArray<ActivityRowTombstone>;
}

export interface ActivityFixtureEnvelope {
  readonly contract: "raft.activity-sync";
  readonly contractVersion: 1;
  readonly runnerProtocol: 1;
  readonly status: "experimental";
  readonly caseId: OpaqueId;
  readonly description: string;
  readonly initialState: FixtureInitialState;
  readonly steps: ReadonlyArray<IngestFixtureStep | DispatchFixtureStep | CheckpointFixtureStep | RestartFixtureStep>;
}

export interface ActivityRowCommon {
  readonly rowId: OpaqueId;
  readonly rowVersion: UInt64String;
  readonly latestActivitySeq: UInt64String;
  readonly lastActivityAt: UtcInstantString;
  readonly unreadCount: number;
  readonly hasMention: boolean;
  readonly firstUnreadMessageId: OpaqueId | null;
  readonly firstMentionMessageId: OpaqueId | null;
  readonly maxReadSeq: UInt64String;
  readonly readStateVersion: UInt64String;
}

export interface ActivityRowTombstone {
  readonly rowId: OpaqueId;
  readonly rowVersion: UInt64String;
  readonly reason: TombstoneReason;
}

export interface ActivityScope {
  readonly serverId: OpaqueId;
  readonly principalId: OpaqueId;
  readonly filter: ActivityFilter;
  readonly windowId: OpaqueId;
}

export interface ActivityScopeState {
  readonly scope: ActivityScope;
  readonly epoch: UInt64String | null;
  readonly watermark: UInt64String | null;
  readonly activityVersion: UInt64String | null;
  readonly revision: UInt64String;
  readonly syncState: ActivitySyncState;
  readonly window: ActivityWindow;
}

export interface ActivityWindow {
  readonly rows: ReadonlyArray<ChannelActivityRow | DmActivityRow | ThreadActivityRow>;
  readonly tombstones: ReadonlyArray<ActivityRowTombstone>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly complete: boolean;
  readonly totalCount: number;
  readonly totalUnreadCount: number;
}

export interface AffectedReadState {
  readonly scopeId: OpaqueId;
  readonly channelId: OpaqueId | null;
  readonly maxReadSeq: UInt64String;
  readonly readStateVersion: UInt64String;
}

export interface BadRequestResponse {
  readonly statusCode: 400;
  readonly body: ContractError;
}

export interface ChannelActivityRow {
  readonly rowId: OpaqueId;
  readonly rowVersion: UInt64String;
  readonly latestActivitySeq: UInt64String;
  readonly lastActivityAt: UtcInstantString;
  readonly unreadCount: number;
  readonly hasMention: boolean;
  readonly firstUnreadMessageId: OpaqueId | null;
  readonly firstMentionMessageId: OpaqueId | null;
  readonly maxReadSeq: UInt64String;
  readonly readStateVersion: UInt64String;
  readonly type: "channel";
  readonly channelId: OpaqueId;
  readonly channelName: string;
  readonly channelKind: "channel" | "private" | "joint";
  readonly lastMessageId: OpaqueId;
  readonly lastMessagePreview: string;
  readonly lastMessageSenderKind: ActorKind;
  readonly lastMessageSenderId: OpaqueId;
  readonly lastMessageSenderName: string | null;
}

export interface CheckpointFixtureStep {
  readonly type: "checkpoint";
  readonly stepId: OpaqueId;
  readonly checkpointId: OpaqueId;
}

export interface CommandReceiptIngress {
  readonly type: "commandReceipt";
  readonly scope: ActivityScope;
  readonly receipt: ActivityCommandReceipt;
}

export interface CommandRejectedIngress {
  readonly type: "commandRejected";
  readonly scope: ActivityScope;
  readonly commandId: OpaqueId;
  readonly activityVersion: UInt64String | null;
  readonly error: ContractError;
}

export interface CommandRequest {
  readonly commandId: OpaqueId;
  readonly expectedActivityVersion: UInt64String;
}

export interface ConflictResponse {
  readonly statusCode: 409;
  readonly body: ContractError;
}

export interface ContractError {
  readonly code: ContractErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ContractVectorEnvelope {
  readonly vectorId: OpaqueId;
  readonly constraintClass: ConstraintClass;
  readonly candidate: unknown;
  readonly expectation: ContractVectorExpectation;
  readonly reason: string;
}

export interface ContractVectorExpectation {
  readonly validator: ContractVerdict;
  readonly typescriptStatic: ContractVerdict;
  readonly kotlinRuntime: ContractVerdict;
}

export interface DifferenceIngress {
  readonly type: "difference";
  readonly requestId: OpaqueId;
  readonly scope: ActivityScope;
  readonly epoch: UInt64String;
  readonly fromSeq: UInt64String;
  readonly toSeq: UInt64String;
  readonly activityVersion: UInt64String;
  readonly rows: ReadonlyArray<ChannelActivityRow | DmActivityRow | ThreadActivityRow>;
  readonly tombstones: ReadonlyArray<ActivityRowTombstone>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly complete: boolean;
  readonly totalCount: number;
  readonly totalUnreadCount: number;
  readonly nextFromSeq: UInt64String | null;
}

export interface DispatchFixtureStep {
  readonly type: "dispatch";
  readonly stepId: OpaqueId;
  readonly intent: EnsureWindowIntent | RefreshIntent | LoadMoreIntent | MarkChannelReadAllIntent | MarkInboxReadAllIntent | MarkThreadDoneIntent | MarkInboxDoneIntent;
}

export interface DmActivityRow {
  readonly rowId: OpaqueId;
  readonly rowVersion: UInt64String;
  readonly latestActivitySeq: UInt64String;
  readonly lastActivityAt: UtcInstantString;
  readonly unreadCount: number;
  readonly hasMention: boolean;
  readonly firstUnreadMessageId: OpaqueId | null;
  readonly firstMentionMessageId: OpaqueId | null;
  readonly maxReadSeq: UInt64String;
  readonly readStateVersion: UInt64String;
  readonly type: "dm";
  readonly channelId: OpaqueId;
  readonly channelName: string;
  readonly channelKind: "dm";
  readonly lastMessageId: OpaqueId;
  readonly lastMessagePreview: string;
  readonly lastMessageSenderKind: ActorKind;
  readonly lastMessageSenderId: OpaqueId;
  readonly lastMessageSenderName: string | null;
}

export interface EnsureWindowIntent {
  readonly type: "ensureWindow";
  readonly scope: ActivityScope;
}

export interface FixtureInitialState {
  readonly scopes: ReadonlyArray<ActivityScopeState>;
}

export interface ForbiddenResponse {
  readonly statusCode: 403;
  readonly body: ContractError;
}

export interface FrameIngress {
  readonly type: "frame";
  readonly scope: ActivityScope;
  readonly epoch: UInt64String;
  readonly seq: UInt64String;
  readonly activityVersion: UInt64String;
  readonly rows: ReadonlyArray<ChannelActivityRow | DmActivityRow | ThreadActivityRow>;
  readonly tombstones: ReadonlyArray<ActivityRowTombstone>;
}

export interface InboxQuery {
  readonly filter?: ActivityFilter;
  readonly cursor?: string;
  readonly limit?: number;
  readonly epoch?: UInt64String;
  readonly activityVersion?: UInt64String;
}

export interface IngestFixtureStep {
  readonly type: "ingest";
  readonly stepId: OpaqueId;
  readonly ingress: SnapshotIngress | NotModifiedIngress | DifferenceIngress | FrameIngress | CommandReceiptIngress | CommandRejectedIngress | ReadStateUpdatedIngress;
}

export interface LoadMoreIntent {
  readonly type: "loadMore";
  readonly scope: ActivityScope;
  readonly cursor: string;
}

export interface MarkChannelReadAllIntent {
  readonly type: "markChannelReadAll";
  readonly scope: ActivityScope;
  readonly commandId: OpaqueId;
  readonly channelId: OpaqueId;
  readonly throughSeq: UInt64String;
}

export interface MarkChannelReadAllRequest {
  readonly commandId: OpaqueId;
  readonly expectedActivityVersion: UInt64String;
  readonly throughSeq: UInt64String;
}

export interface MarkInboxDoneIntent {
  readonly type: "markInboxDone";
  readonly scope: ActivityScope;
  readonly commandId: OpaqueId;
  readonly rowId: OpaqueId;
  readonly throughActivitySeq: UInt64String;
}

export interface MarkInboxReadAllIntent {
  readonly type: "markInboxReadAll";
  readonly scope: ActivityScope;
  readonly commandId: OpaqueId;
  readonly throughSeq: UInt64String;
}

export interface MarkInboxReadAllRequest {
  readonly commandId: OpaqueId;
  readonly expectedActivityVersion: UInt64String;
  readonly throughSeq: UInt64String;
}

export interface MarkThreadDoneIntent {
  readonly type: "markThreadDone";
  readonly scope: ActivityScope;
  readonly commandId: OpaqueId;
  readonly threadChannelId: OpaqueId;
  readonly throughActivitySeq: UInt64String;
}

export interface NotFoundResponse {
  readonly statusCode: 404;
  readonly body: ContractError;
}

export interface NotModifiedIngress {
  readonly type: "notModified";
  readonly requestId: OpaqueId;
  readonly scope: ActivityScope;
  readonly epoch: UInt64String;
  readonly watermark: UInt64String;
  readonly activityVersion: UInt64String;
}

export interface ReadStateUpdatedIngress {
  readonly type: "readStateUpdated";
  readonly scope: ActivityScope;
  readonly epoch: UInt64String;
  readonly seq: UInt64String;
  readonly activityVersion: UInt64String;
  readonly updates: ReadonlyArray<AffectedReadState>;
}

export interface RefreshIntent {
  readonly type: "refresh";
  readonly scope: ActivityScope;
}

export interface RestartFixtureStep {
  readonly type: "restart";
  readonly stepId: OpaqueId;
  readonly mode: "cold" | "persisted";
}

export interface SnapshotIngress {
  readonly type: "snapshot";
  readonly requestId: OpaqueId;
  readonly scope: ActivityScope;
  readonly epoch: UInt64String;
  readonly watermark: UInt64String;
  readonly activityVersion: UInt64String;
  readonly window: ActivityWindow;
}

export interface SnapshotRequiredBody {
  readonly snapshotRequired: true;
  readonly requestId: OpaqueId;
  readonly scope: ActivityScope;
  readonly epoch: UInt64String;
  readonly watermark: UInt64String;
  readonly activityVersion: UInt64String;
}

export interface SnapshotRequiredResponse {
  readonly statusCode: 409;
  readonly body: SnapshotRequiredBody;
}

export interface ThreadActivityRow {
  readonly rowId: OpaqueId;
  readonly rowVersion: UInt64String;
  readonly latestActivitySeq: UInt64String;
  readonly lastActivityAt: UtcInstantString;
  readonly unreadCount: number;
  readonly hasMention: boolean;
  readonly firstUnreadMessageId: OpaqueId | null;
  readonly firstMentionMessageId: OpaqueId | null;
  readonly maxReadSeq: UInt64String;
  readonly readStateVersion: UInt64String;
  readonly type: "thread";
  readonly threadChannelId: OpaqueId;
  readonly parentMessageId: OpaqueId;
  readonly parentChannelId: OpaqueId;
  readonly parentChannelName: string;
  readonly parentChannelKind: ChannelKind;
  readonly parentMessagePreview: string;
  readonly parentMessageSenderKind: "user" | "agent" | "external_projection";
  readonly parentMessageSenderId: OpaqueId;
  readonly latestActivityPreview: string;
  readonly latestActivitySenderKind: ActorKind;
  readonly latestActivitySenderId: OpaqueId;
  readonly latestActivitySenderName: string | null;
  readonly latestActivityMessageId: OpaqueId;
  readonly isFollowing: boolean;
  readonly replyCount: number;
  readonly lastReplyAt: UtcInstantString | null;
  readonly taskNumber: number | null;
  readonly taskStatus: string | null;
  readonly taskClaimedByName: string | null;
}

export interface UnauthorizedResponse {
  readonly statusCode: 401;
  readonly body: ContractError;
}

export interface UnavailableResponse {
  readonly statusCode: 503;
  readonly body: ContractError;
}

export interface V1AckResponse {
  readonly ok: true;
}

export interface V1AdmittedResponse {
  readonly code: string;
  readonly status: "admitted";
  readonly outcome: "unknown";
  readonly mutationId: string;
  readonly authoritySeq: SafeUnsignedCounter;
  readonly frontierUrl: string;
}

export interface V1AffectedReadState {
  readonly scopeId: OpaqueId;
  readonly maxReadSeq: SafeUnsignedCounter;
  readonly readStateVersion: SafeUnsignedCounter;
}

export interface V1AuthErrorBody {
  readonly error: string;
  readonly code: string;
}

export interface V1BadRequestResponse {
  readonly statusCode: 400;
  readonly body: V1ErrorBody;
}

export interface V1ConflictResponse {
  readonly statusCode: 409;
  readonly body: V1DoneConflictBody;
}

export interface V1DoneBadRequestBody {
  readonly error: string;
  readonly code?: string;
}

export interface V1DoneBadRequestResponse {
  readonly statusCode: 400;
  readonly body: V1DoneBadRequestBody;
}

export interface V1DoneConflictBody {
  readonly error: string;
  readonly code: string;
}

export interface V1ErrorBody {
  readonly error: string;
}

export interface V1ForbiddenResponse {
  readonly statusCode: 403;
  readonly body: V1ErrorBody;
}

export interface V1InboxPage {
  readonly items: ReadonlyArray<unknown>;
  readonly hasMore: boolean;
  readonly totalCount: SafeUnsignedCounter;
  readonly totalUnreadCount: SafeUnsignedCounter;
  readonly activeUnreadCount: SafeUnsignedCounter;
}

export interface V1InternalErrorResponse {
  readonly statusCode: 500;
  readonly body: V1ErrorBody;
}

export interface V1MarkChannelReadAllResponse {
  readonly ok: true;
  readonly seq: SafeUnsignedCounter;
  readonly readStateVersion: SafeUnsignedCounter;
}

export interface V1MarkInboxDoneRequest {
  readonly channelId: OpaqueId;
  readonly throughActivitySeq: UInt64String;
  readonly frontierSpace: "storage";
}

export interface V1MarkInboxReadAllResponse {
  readonly ok: true;
  readonly markedCount: number;
  readonly scopes: ReadonlyArray<V1AffectedReadState>;
}

export interface V1MarkThreadDoneRequest {
  readonly threadChannelId: OpaqueId;
  readonly throughActivitySeq: UInt64String;
  readonly frontierSpace: "storage";
}

export interface V1NotFoundResponse {
  readonly statusCode: 404;
  readonly body: V1ErrorBody;
}

export interface V1PreconditionFailedResponse {
  readonly statusCode: 412;
  readonly body: V1DoneConflictBody;
}

export interface V1UnauthorizedResponse {
  readonly statusCode: 401;
  readonly body: V1AuthErrorBody;
}

export type ActivityFixtureStep =
  | IngestFixtureStep
  | DispatchFixtureStep
  | CheckpointFixtureStep
  | RestartFixtureStep;

export type ActivityIngress =
  | SnapshotIngress
  | NotModifiedIngress
  | DifferenceIngress
  | FrameIngress
  | CommandReceiptIngress
  | CommandRejectedIngress
  | ReadStateUpdatedIngress;

export type ActivityIntent =
  | EnsureWindowIntent
  | RefreshIntent
  | LoadMoreIntent
  | MarkChannelReadAllIntent
  | MarkInboxReadAllIntent
  | MarkThreadDoneIntent
  | MarkInboxDoneIntent;

export type ActivityRow =
  | ChannelActivityRow
  | DmActivityRow
  | ThreadActivityRow;
