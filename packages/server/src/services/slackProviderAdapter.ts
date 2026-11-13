import type { SlackTestIdentityObserver } from "./slackInboundIdentityObservation";
import type { SlackLifecycleMemberProfile } from "./slackChannelLifecycleObservation";
import { parseSlackHistoryCursor, parseSlackReconciliationScan, type SlackReconciliationScan, type SlackReconciliationUnconfirmableReason } from "./slackReconciliationScan";
import { CONFIRMED_THREAD_ROOT_MISSING, type ExternalProviderPreparation } from "./externalProviderPreparation";
import { createHash, randomUUID } from "node:crypto";
import {
  clearClockTimeout,
  currentDate,
  setClockTimeout,
} from "@botiverse/raft-shared";
import type { SealedExternalCredential } from "./externalAppControlPlaneService";
import {
  ExternalAppIngressError,
  verifyAndAdmitSlackIngress,
  type ExternalIngressPayloadSealer,
  type ExternalIngressRuntimeResolver,
  type ExternalIngressSecretResolver,
  type SlackIngressAdmission,
} from "./externalAppIngressService";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import type { SlackVerifiedIngressPayloadCrypto } from "./slackVerifiedIngressContracts";

export const SLACK_PROVIDER_ADAPTER_CONTRACT_VERSION =
  "slack-provider-adapter.v1" as const;
export const SLACK_OAUTH_CODE_HANDLE_SCHEMA =
  "slack-oauth-code-handle.v1" as const;
export const SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA =
  "slack-oauth-app-credential-handle.v1" as const;

const DEFAULT_TRANSIENT_RETRY_BASE_MS = 1_000;
const INVALID_RETRY_AFTER_FALLBACK_MS = 60_000;

export const SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA =
  "slack-bridge-credential-lease.v1" as const;

export interface SlackBridgeCredentialHandle {
  schema: typeof SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA;
  leaseId: string;
  installId: string;
  providerAppId: string;
  providerAuthorityId: string;
  connectionEpoch: number;
  credentialRevision: number;
  leaseExpiresAt: Date;
}

export interface SlackBridgeProviderDispatchInput {
  deliveryId: string;
  reconciliationMarker: string;
  renderSnapshot: SlackBridgeRenderSnapshot;
  credentialHandle: SlackBridgeCredentialHandle;
  /** Current I/O authority; the original render snapshot remains immutable. */
  operationAuthority?: SlackProviderAuthorityFence;
  /** Applied after current mention rendering without changing the frozen snapshot. */
  decorateRenderedText?(text: string): string;
  /** Recheck current membership at the last boundary before publishing a notification. */
  resolveCurrentRenderMentions?(): Promise<Pick<SlackBridgeRenderSnapshot, "externalMentions" | "raftMentionSubstitutions">>;
}

export type SlackBridgeProviderDispatchOutcome =
  | { kind: "accepted"; providerMessageId: string; providerThreadId?: string | null; reconciled?: boolean }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; baseDelayMs: number }
  | { kind: "deterministic_failure"; pairBlockedReason?: "provider_credential_revoked" | "provider_app_identity_conflict" | "provider_authority_identity_conflict" | "provider_conversation_identity_conflict" | "slack_not_in_channel" | "slack_permission_missing" | "slack_workspace_admin_required" | "slack_channel_not_found" | "slack_channel_archived" }
  | { kind: "outcome_unknown" };

export type SlackBridgeProviderPreparation = ExternalProviderPreparation<SlackBridgeProviderDispatchOutcome>;

export type SlackJsonPrimitive = string | number | boolean | null;
export type SlackJsonValue =
  | SlackJsonPrimitive
  | SlackJsonValue[]
  | { [key: string]: SlackJsonValue };
export type SlackJsonObject = { [key: string]: SlackJsonValue };

export interface SlackObservedAuthority {
  providerAppId: string;
  providerAuthorityId: string;
}

export interface SlackProviderAuthorityFence {
  installId: string;
  providerAppId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  connectionEpoch: number;
  credentialRevision: number;
  bindingId: string;
  bindingEpoch: number;
}

export interface SlackAudienceCredentialResolver {
  resolve(input: {
    authority: SlackProviderAuthorityFence;
    now: Date;
  }): Promise<SlackBridgeCredentialHandle | null>;
}

export type SlackWebApiMethod =
  | "chat.postMessage"
  | "chat.update"
  | "conversations.history"
  | "conversations.replies"
  | "reactions.add"
  | "reactions.remove"
  | "reactions.get"
  | "files.info"
  | "bots.info"
  | "users.info"
  | "conversations.info"
  | "conversations.members";

export interface SlackWebApiRequest {
  method: SlackWebApiMethod;
  credentialHandle: SlackBridgeCredentialHandle;
  authority: SlackProviderAuthorityFence;
  body: SlackJsonObject;
}

export interface SlackWebApiHttpResponse {
  kind: "response";
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: SlackJsonObject;
  observedAuthority?: SlackObservedAuthority;
}

export interface SlackWebApiTransportFailure {
  kind: "transport_failure";
  phase: "before_send" | "after_send" | "unknown";
  code:
    | "aborted"
    | "connection_reset"
    | "dns"
    | "timeout"
    | "tls"
    | "unavailable";
}

export type SlackWebApiTransportResult =
  | SlackWebApiHttpResponse
  | SlackWebApiTransportFailure;

export interface SlackWebApiTransport {
  /**
   * `double` receipts are executable development evidence only. They must
   * never be promoted to bounded-live or release-Oracle evidence.
   */
  readonly evidence: "double" | "live";
  call(request: SlackWebApiRequest): Promise<SlackWebApiTransportResult>;
}

export interface SlackProviderAuthorityQuarantineSink {
  quarantine(input: SlackProviderAuthorityFence & {
    reason:
      | "provider_app_identity_conflict"
      | "provider_authority_identity_conflict"
      | "provider_conversation_identity_conflict"
      | "provider_credential_revoked";
  }): Promise<"applied" | "already_fenced" | "fence_mismatch">;
}

export type SlackProviderThreadAuthorityDecision =
  | { active: false; reason: "missing" | "stale" | "mismatch" | "conflict" | "unavailable" }
  | {
      active: true;
      fact: {
        providerThreadId: string;
        rootLinkRevision: number;
        installId: string;
        providerAuthorityId: string;
        providerConversationId: string;
        connectionEpoch: number;
        bindingId: string;
        bindingEpoch: number;
      };
    };

export interface SlackProviderThreadAuthorityResolver {
  resolve(input: {
    canonicalRootMessageId: string;
    authority: SlackProviderAuthorityFence;
  }): Promise<SlackProviderThreadAuthorityDecision>;
}

export interface SlackProviderAdapterDependencies {
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  threadAuthority?: SlackProviderThreadAuthorityResolver;
  now?(): Date;
}

function nonEmptyString(value: SlackJsonValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: SlackJsonValue | undefined): value is SlackJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authorityFromDispatch(
  input: SlackBridgeProviderDispatchInput,
): SlackProviderAuthorityFence {
  if (input.operationAuthority) return input.operationAuthority;
  const authority = input.renderSnapshot.bindingAuthority;
  return {
    installId: authority.installId,
    providerAppId: input.credentialHandle.providerAppId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    connectionEpoch: authority.connectionEpoch,
    credentialRevision: input.credentialHandle.credentialRevision,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
  };
}

function credentialMatchesAuthority(
  credential: SlackBridgeCredentialHandle,
  authority: SlackProviderAuthorityFence,
  now: Date,
): boolean {
  return credential.installId === authority.installId
    && credential.providerAppId === authority.providerAppId
    && credential.providerAuthorityId === authority.providerAuthorityId
    && credential.connectionEpoch === authority.connectionEpoch
    && credential.credentialRevision === authority.credentialRevision
    && credential.leaseId.trim().length > 0
    && validDate(credential.leaseExpiresAt)
    && credential.leaseExpiresAt > now;
}

function providerThreadAuthorityMatches(
  authority: SlackProviderAuthorityFence,
  decision: Extract<SlackProviderThreadAuthorityDecision, { active: true }>["fact"],
): boolean {
  return decision.installId === authority.installId
    && decision.providerAuthorityId === authority.providerAuthorityId
    && decision.providerConversationId === authority.providerConversationId
    && decision.connectionEpoch === authority.connectionEpoch
    && decision.bindingId === authority.bindingId
    && decision.bindingEpoch === authority.bindingEpoch
    && decision.providerThreadId.trim().length > 0
    && positiveSafeInteger(decision.rootLinkRevision);
}

function parseRetryAfterMs(
  headers: Readonly<Record<string, string | undefined>>,
): number {
  const raw = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (!raw || !/^[0-9]+$/.test(raw.trim())) {
    return INVALID_RETRY_AFTER_FALLBACK_MS;
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return INVALID_RETRY_AFTER_FALLBACK_MS;
  }
  return Math.min(2_147_483_647, seconds * 1_000);
}

const AUTH_REVOKED_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
]);

const AMBIGUOUS_PROVIDER_ERRORS = new Set([
  "fatal_error",
  "internal_error",
  "request_timeout",
  "service_unavailable",
]);

const DETERMINISTIC_PROVIDER_ERRORS = new Set([
  "access_denied",
  "app_access_restricted",
  "cannot_reply_to_message",
  "channel_not_found",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "invalid_arguments",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "is_archived",
  "message_limit_exceeded",
  "messages_tab_disabled",
  "missing_scope",
  "msg_blocks_too_long",
  "no_permission",
  "no_text",
  "not_allowed_token_type",
  "not_in_channel",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
]);

async function quarantineBeforeTerminalFailure(input: {
  sink: SlackProviderAuthorityQuarantineSink;
  authority: SlackProviderAuthorityFence;
  reason:
    | "provider_app_identity_conflict"
    | "provider_authority_identity_conflict"
    | "provider_conversation_identity_conflict"
    | "provider_credential_revoked";
}): Promise<SlackBridgeProviderDispatchOutcome> {
  const fenced = await input.sink.quarantine({
    ...input.authority,
    reason: input.reason,
  });
  return fenced === "fence_mismatch"
    ? { kind: "outcome_unknown" }
    : { kind: "deterministic_failure", pairBlockedReason: input.reason };
}

export type SlackOutboundReconciliationResult =
  | {
    kind: "found";
    providerMessageId: string;
    providerThreadId: string | null;
  }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: string; retryAfterMs?: number; unconfirmable?: SlackReconciliationUnconfirmableReason };

function slackMessageReconciliationMarker(message: SlackJsonObject): string | null {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const payload = metadata && isRecord(metadata.event_payload)
    ? metadata.event_payload
    : null;
  if (metadata?.event_type !== "raft_message" || !payload) return null;
  return nonEmptyString(payload.reconciliation_marker);
}

function slackProviderMessageId(message: SlackJsonObject): string | null {
  const value = nonEmptyString(message.ts);
  return value && /^[0-9]{1,20}\.[0-9]{1,20}$/.test(value) ? value : null;
}

function slackMessageIsFileShare(message: SlackJsonObject): boolean {
  return message.subtype === "file_share" || Array.isArray(message.files);
}

/**
 * Reconcile an ambiguous outbound post using the marker embedded in Slack
 * message metadata. This is read-only provider I/O; callers decide whether a
 * not-found result is safe to redispatch and must never treat an unavailable
 * or conflicted scan as proof of absence.
 */
export async function reconcileSlackOutboundDelivery(input: {
  transport: SlackWebApiTransport;
  leaseCredential(): Promise<SlackBridgeCredentialHandle | null>;
  releaseCredential(handle: SlackBridgeCredentialHandle): Promise<void>;
  authority: SlackProviderAuthorityFence;
  reconciliationMarker: string;
  providerThreadId?: string | null;
  now: Date;
  firstAttemptAt: Date;
  providerAttempt: number;
  scan?: SlackReconciliationScan | null;
  saveScan?(scan: SlackReconciliationScan | null): Promise<void>;
  maxPages?: number;
}): Promise<SlackOutboundReconciliationResult> {
  if (
    !validDate(input.now) || !validDate(input.firstAttemptAt)
    || input.firstAttemptAt.getTime() < 0 || input.firstAttemptAt > input.now
    || !positiveSafeInteger(input.providerAttempt)
    || !/^[A-Za-z0-9_-]{43}$/.test(input.reconciliationMarker)
  ) return { kind: "unavailable", reason: "reconciliation_preflight_invalid" };
  const threadId = input.providerThreadId?.trim() || null;
  if (threadId && !/^[0-9]{1,20}\.[0-9]{1,20}$/.test(threadId)) {
    return { kind: "unavailable", reason: "reconciliation_thread_invalid" };
  }
  // Two default 15-second reads fit inside the worker's 60-second lease. Longer scans
  // continue from durable progress on the next tick, never from page one.
  const maxPages = input.maxPages ?? 2;
  if (!positiveSafeInteger(maxPages) || maxPages > 100) {
    return { kind: "unavailable", reason: "reconciliation_page_limit_invalid" };
  }
  const stamp = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;
  // This is an I/O search bound, not a message retention/age cutoff. Retain a
  // minute before the first recorded attempt for host/provider clock skew.
  const oldest = stamp(Math.max(0, input.firstAttemptAt.getTime() - 60_000));
  const scopeKey = createHash("sha256").update(JSON.stringify([
    input.authority.installId, input.authority.providerAppId, input.authority.providerAuthorityId,
    input.authority.providerConversationId, input.authority.connectionEpoch,
    input.authority.bindingId, input.authority.bindingEpoch, threadId, input.reconciliationMarker,
  ])).digest("hex");
  const previous = parseSlackReconciliationScan(input.scan);
  const micros = (ts: string) => { const [sec, fraction] = ts.split("."); return BigInt(sec!) * (10n ** 20n) + BigInt(fraction!.padEnd(20, "0")); };
  const fresh: SlackReconciliationScan = { schema: "slack-reconciliation-scan.v3", providerAttempt: input.providerAttempt,
    scopeKey, oldest, latest: stamp(input.now.getTime() + 60_000), cursor: null, match: null, metadataMissing: previous?.metadataMissing ?? false, markerUnconfirmed: previous?.markerUnconfirmed ?? false, historyLimited: previous?.historyLimited ?? false };
  let scan = previous && previous.providerAttempt === input.providerAttempt && previous.scopeKey === scopeKey
    && previous.oldest === oldest && micros(previous.latest) <= micros(fresh.latest)
    && micros(previous.latest) >= micros(oldest) ? previous : fresh;
  if (scan.conclusion && Date.parse(scan.conclusion.recheckAt) > input.now.getTime()) {
    return { kind: "unavailable", reason: scan.conclusion.reason, unconfirmable: scan.conclusion.reason,
      retryAfterMs: Date.parse(scan.conclusion.recheckAt) - input.now.getTime() };
  }
  if (scan.conclusion) scan = { ...scan, conclusion: undefined };
  let cursor = scan.cursor;
  let match = scan.match;
  // A completed observation can be checked again after a bounded cooldown:
  // a verified original can now resolve uncertainty. Time alone is not evidence
  // that an earlier potentially sent message never existed.
  let sawBridgeBotWithoutMetadata = scan.metadataMissing;
  let sawUnconfirmedMarker = scan.markerUnconfirmed;
  let historyLimited = scan.historyLimited;
  const visited = new Set(cursor ? [cursor] : []);
  for (let page = 0; page < maxPages; page += 1) {
    const body: SlackJsonObject = threadId
      ? {
        channel: input.authority.providerConversationId,
        ts: threadId,
        limit: 100,
        include_all_metadata: true,
        oldest: scan.oldest, latest: scan.latest, inclusive: true,
        ...(cursor ? { cursor } : {}),
      }
      : {
        channel: input.authority.providerConversationId,
        limit: 100,
        include_all_metadata: true,
        oldest: scan.oldest, latest: scan.latest, inclusive: true,
        ...(cursor ? { cursor } : {}),
      };
    const credentialHandle = await input.leaseCredential();
    if (!credentialHandle || !credentialMatchesAuthority(credentialHandle, input.authority, input.now)) {
      if (credentialHandle) await input.releaseCredential(credentialHandle);
      return { kind: "unavailable", reason: "reconciliation_credential_unavailable" };
    }
    const result = await input.transport.call({
      method: threadId ? "conversations.replies" : "conversations.history",
      credentialHandle,
      authority: input.authority,
      body,
    });
    if (result.kind === "transport_failure") {
      return { kind: "unavailable", reason: `reconciliation_transport_${result.code}` };
    }
    // Persist every observation that prevents absence BEFORE parsing the page.
    // Malformed siblings or pagination must not erase an earlier witness when
    // the message/visibility evidence disappears before the next read.
    const observedMessages = Array.isArray(result.body.messages) ? result.body.messages.filter(isRecord) : [];
    const markerObserved = observedMessages.some(message => slackMessageReconciliationMarker(message) === input.reconciliationMarker);
    const metadataMissing = observedMessages.some(message => {
      if (nonEmptyString(message.app_id) !== input.authority.providerAppId
        || slackMessageIsFileShare(message) || slackMessageReconciliationMarker(message)) return false;
      const ts = slackProviderMessageId(message);
      return !ts || (micros(ts) >= micros(scan.oldest) && micros(ts) <= micros(scan.latest));
    });
    const limited = result.body.is_limited === true
      && micros(scan.oldest) <= micros(stamp(Math.max(0, input.now.getTime() - 90 * 24 * 60 * 60_000 + 60_000)));
    if ((markerObserved && !sawUnconfirmedMarker) || (metadataMissing && !sawBridgeBotWithoutMetadata) || (limited && !historyLimited)) {
      sawUnconfirmedMarker ||= markerObserved;
      sawBridgeBotWithoutMetadata ||= metadataMissing;
      historyLimited ||= limited;
      await input.saveScan?.({ ...scan, cursor, match, markerUnconfirmed: sawUnconfirmedMarker,
        metadataMissing: sawBridgeBotWithoutMetadata, historyLimited });
    }
    if (result.status === 429) return { kind: "unavailable", reason: "reconciliation_rate_limited", retryAfterMs: parseRetryAfterMs(result.headers) };
    if (result.body.error === "invalid_cursor" && cursor) {
      await input.saveScan?.({ ...scan, cursor: null, match, metadataMissing: sawBridgeBotWithoutMetadata, markerUnconfirmed: sawUnconfirmedMarker, historyLimited });
      return { kind: "unavailable", reason: "reconciliation_cursor_expired", retryAfterMs: 30_000 };
    }
    if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
      return {
        kind: "unavailable",
        reason: nonEmptyString(result.body.error) ?? "reconciliation_provider_error",
      };
    }
    if (result.body.has_more !== undefined && typeof result.body.has_more !== "boolean") {
      return { kind: "unavailable", reason: "reconciliation_pagination_invalid" };
    }
    if (result.body.is_limited !== undefined && typeof result.body.is_limited !== "boolean") {
      return { kind: "unavailable", reason: "reconciliation_pagination_invalid" };
    }
    const messages = Array.isArray(result.body.messages)
      ? result.body.messages.filter(isRecord)
      : null;
    if (!messages || messages.length !== (result.body.messages as SlackJsonValue[]).length) {
      return { kind: "unavailable", reason: "reconciliation_messages_invalid" };
    }
    for (const message of messages) {
      const timestamp = slackProviderMessageId(message);
      if (!timestamp) return { kind: "unavailable", reason: "reconciliation_message_id_invalid" };
      const marker = slackMessageReconciliationMarker(message);
      const sourceAppId = nonEmptyString(message.app_id);
      const authoredByBridgeApp = sourceAppId === input.authority.providerAppId;
      const inWindow = micros(timestamp) >= micros(scan.oldest) && micros(timestamp) <= micros(scan.latest);
      if (!inWindow) {
        if (marker === input.reconciliationMarker && authoredByBridgeApp) {
          return { kind: "unavailable", reason: "reconciliation_marker_outside_window" };
        }
        continue; // replies may include the root outside the requested interval
      }
      const channel = nonEmptyString(message.channel);
      if (channel && channel !== input.authority.providerConversationId) {
        return { kind: "unavailable", reason: "reconciliation_channel_conflict" };
      }
      if (marker !== input.reconciliationMarker) continue;
      // Metadata can be copied by another app. Slack's message-level app_id is
      // publishing authority, not a field inside the app-supplied metadata.
      // It survives bot/credential rotation; a bot ID alone is not app proof.
      if (!authoredByBridgeApp) continue;
      const providerMessageId = slackProviderMessageId(message);
      if (!providerMessageId) return { kind: "unavailable", reason: "reconciliation_message_id_invalid" };
      const messageThreadId = nonEmptyString(message.thread_ts);
      if (messageThreadId && !/^[0-9]{1,20}\.[0-9]{1,20}$/.test(messageThreadId)) {
        return { kind: "unavailable", reason: "reconciliation_thread_invalid" };
      }
      const found = {
        providerMessageId,
        providerThreadId: threadId ? (messageThreadId ?? threadId) : null,
      };
      if (threadId && messageThreadId && messageThreadId !== threadId) return { kind: "unavailable", reason: "reconciliation_thread_conflict" };
      if (match && (match.providerMessageId !== found.providerMessageId || match.providerThreadId !== found.providerThreadId)) {
        return { kind: "unavailable", reason: "reconciliation_marker_conflict" };
      }
      match = found;
    }
    const responseMetadata = isRecord(result.body.response_metadata)
      ? result.body.response_metadata
      : null;
    const rawCursor = responseMetadata?.next_cursor;
    const nextCursor = parseSlackHistoryCursor(rawCursor);
    if (rawCursor !== undefined && rawCursor !== null && rawCursor !== "" && !nextCursor) return { kind: "unavailable", reason: "reconciliation_cursor_invalid" };
    if (!nextCursor) {
      if (result.body.has_more === true || (result.body.has_more !== false && rawCursor !== "")) {
        return { kind: "unavailable", reason: "reconciliation_pagination_incomplete" };
      }
      if (match) {
        await input.saveScan?.(null);
        return { kind: "found", ...match };
      }
      if (historyLimited || sawUnconfirmedMarker || sawBridgeBotWithoutMetadata) {
        const reason = historyLimited ? "reconciliation_history_limited"
          : sawUnconfirmedMarker ? "reconciliation_marker_unconfirmed" : "reconciliation_bridge_metadata_missing";
        const retryAfterMs = 15 * 60_000;
        await input.saveScan?.({ ...scan, cursor: null, match, metadataMissing: sawBridgeBotWithoutMetadata, markerUnconfirmed: sawUnconfirmedMarker, historyLimited,
          conclusion: { reason, recheckAt: new Date(input.now.getTime() + retryAfterMs).toISOString() } });
        return { kind: "unavailable", reason, unconfirmable: reason, retryAfterMs };
      }
      await input.saveScan?.(null);
      return { kind: "not_found" };
    }
    if (visited.has(nextCursor)) return { kind: "unavailable", reason: "reconciliation_cursor_loop" };
    cursor = nextCursor;
    visited.add(cursor);
    await input.saveScan?.({ ...scan, conclusion: undefined, cursor, match, metadataMissing: sawBridgeBotWithoutMetadata, markerUnconfirmed: sawUnconfirmedMarker, historyLimited });
  }
  return { kind: "unavailable", reason: "reconciliation_scan_pending", retryAfterMs: 30_000 };
}

async function normalizePostMessageResult(input: {
  result: SlackWebApiTransportResult;
  authority: SlackProviderAuthorityFence;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  providerThreadId: string | null;
}): Promise<SlackBridgeProviderDispatchOutcome> {
  if (input.result.kind === "transport_failure") {
    return input.result.phase === "before_send"
      ? {
        kind: "transient_failure",
        baseDelayMs: DEFAULT_TRANSIENT_RETRY_BASE_MS,
      }
      : { kind: "outcome_unknown" };
  }
  if (input.result.status === 429) {
    return {
      kind: "rate_limited",
      retryAfterMs: parseRetryAfterMs(input.result.headers),
    };
  }

  const observed = input.result.observedAuthority;
  if (observed?.providerAppId !== undefined
    && observed.providerAppId !== input.authority.providerAppId) {
    return quarantineBeforeTerminalFailure({
      sink: input.quarantineSink,
      authority: input.authority,
      reason: "provider_app_identity_conflict",
    });
  }
  if (observed?.providerAuthorityId !== undefined
    && observed.providerAuthorityId !== input.authority.providerAuthorityId) {
    return quarantineBeforeTerminalFailure({
      sink: input.quarantineSink,
      authority: input.authority,
      reason: "provider_authority_identity_conflict",
    });
  }

  const error = nonEmptyString(input.result.body.error);
  if (input.result.body.ok === true) {
    const providerConversationId = nonEmptyString(input.result.body.channel);
    const providerMessageId = nonEmptyString(input.result.body.ts);
    if (
      input.result.status < 200
      || input.result.status >= 300
      || !providerConversationId
      || !providerMessageId
      || !/^[0-9]{1,20}\.[0-9]{1,20}$/.test(providerMessageId)
    ) {
      return { kind: "outcome_unknown" };
    }
    if (providerConversationId !== input.authority.providerConversationId) {
      return quarantineBeforeTerminalFailure({
        sink: input.quarantineSink,
        authority: input.authority,
        reason: "provider_conversation_identity_conflict",
      });
    }
    return {
      kind: "accepted",
      providerMessageId,
      providerThreadId: input.providerThreadId,
    };
  }
  if (!error) return { kind: "outcome_unknown" };
  if (error === "rate_limited" || error === "ratelimited") {
    return {
      kind: "rate_limited",
      retryAfterMs: parseRetryAfterMs(input.result.headers),
    };
  }
  if (AUTH_REVOKED_ERRORS.has(error)) {
    return quarantineBeforeTerminalFailure({
      sink: input.quarantineSink,
      authority: input.authority,
      reason: "provider_credential_revoked",
    });
  }
  if (AMBIGUOUS_PROVIDER_ERRORS.has(error) || input.result.status >= 500) {
    return { kind: "outcome_unknown" };
  }
  if (["not_in_channel", "missing_scope", "no_permission", "access_denied", "app_access_restricted", "channel_not_found"].includes(error)) {
    // channel_not_found can also mean access was revoked; it does not prove
    // permanent deletion. Keep custody rather than declaring the target gone.
    return { kind: "deterministic_failure", pairBlockedReason: error === "not_in_channel" ? "slack_not_in_channel"
      : error === "channel_not_found" ? "slack_channel_not_found"
        : error === "app_access_restricted" ? "slack_workspace_admin_required" : "slack_permission_missing" };
  }
  if (error === "is_archived") return { kind: "deterministic_failure", pairBlockedReason: "slack_channel_archived" };
  if (DETERMINISTIC_PROVIDER_ERRORS.has(error)) {
    return { kind: "deterministic_failure" };
  }
  return { kind: "outcome_unknown" };
}

function escapeSlackMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ambiguousSlackMentionHandles(snapshot: SlackBridgeRenderSnapshot): Set<string> {
  // A handle claimed by more than one DISTINCT provider target — an external
  // fact and a Raft substitution, two external facts, or two Raft
  // substitutions — is genuinely ambiguous: the same `@handle` text could
  // mean any of them and there is no per-occurrence position data to tell
  // them apart. Rather than letting pass order pick a winner (which would
  // silently notify the wrong principal or drop a target), ambiguous handles
  // stay literal — no Slack-side notification for any interpretation. Two
  // rows that resolve to the SAME provider token are one target, not a
  // collision.
  const targetsByHandle = new Map<string, Set<string>>();
  const noteHandle = (handle: string, providerToken: string) => {
    const set = targetsByHandle.get(handle) ?? new Set<string>();
    set.add(providerToken);
    targetsByHandle.set(handle, set);
  };
  for (const mention of snapshot.externalMentions) {
    noteHandle(mention.handleSnapshot, `<@${mention.externalActorId}>`);
  }
  for (const substitution of snapshot.raftMentionSubstitutions ?? []) {
    noteHandle(substitution.handle, substitution.token);
  }
  return new Set(
    [...targetsByHandle].filter(([, targets]) => targets.size > 1).map(([handle]) => handle),
  );
}

export function renderSlackBridgeText(snapshot: SlackBridgeRenderSnapshot): string | null {
  let text = snapshot.sanitizedText;
  const placeholders: Array<{
    token: string;
    providerUserId?: string;
    providerToken?: string;
  }> = [];
  const ambiguousHandles = ambiguousSlackMentionHandles(snapshot);
  const mentions = [...snapshot.externalMentions]
    .filter((mention) => !ambiguousHandles.has(mention.handleSnapshot))
    .sort((left, right) => right.handleSnapshot.length - left.handleSnapshot.length);
  for (const [index, mention] of mentions.entries()) {
    // Protocol 3 readers can safely consume a bot fact before mapping support
    // is enabled. Keep its handle literal; never turn a bot ID into a Slack ping.
    if (/^B[A-Z0-9]{2,159}$/u.test(mention.externalActorId)) continue;
    if (
      !/^[UW][A-Z0-9_]{2,}$/.test(mention.externalActorId)
      || !mention.handleSnapshot.trim()
      || /[@<>&\s\u0000-\u001f\u007f]/u.test(mention.handleSnapshot)
    ) return null;
    const token = `\u0000SLACK_MENTION_${index}\u0000`;
    const pattern = new RegExp(
      `(^|[\\s([{])@${escapeRegex(mention.handleSnapshot)}(?=$|[\\s.,!?;:)}\\]])`,
      "gu",
    );
    text = text.replace(pattern, (_match, prefix: string) => `${prefix}${token}`);
    placeholders.push({ token, providerUserId: mention.externalActorId });
  }
  // Raft-principal mentions were frozen to their exact Slack token at
  // enqueue (link/usergroup identity at send time, never re-derived here).
  // A row that fails validation makes the whole render fail closed rather
  // than leaking a malformed token — same posture as externalMentions above.
  const raftSubstitutions = [...(snapshot.raftMentionSubstitutions ?? [])]
    .filter((substitution) => !ambiguousHandles.has(substitution.handle))
    .sort((left, right) => right.handle.length - left.handle.length);
  for (const [index, substitution] of raftSubstitutions.entries()) {
    if (
      !substitution.handle.trim()
      || /[@<>&\s\u0000-\u001f\u007f]/u.test(substitution.handle)
      || !(substitution.kind === "user"
        ? /^<@[UW][A-Z0-9_]{2,}>$/u.test(substitution.token)
        : /^<!subteam\^S[A-Z0-9_]{2,}>$/u.test(substitution.token))
    ) return null;
    const placeholderToken = `\u0000RAFT_MENTION_${index}\u0000`;
    const pattern = new RegExp(
      `(^|[\\s([{])@${escapeRegex(substitution.handle)}(?=$|[\\s.,!?;:)}\\]])`,
      "gu",
    );
    text = text.replace(pattern, (_match, prefix: string) => `${prefix}${placeholderToken}`);
    placeholders.push({ token: placeholderToken, providerToken: substitution.token });
  }
  // Escape once, after every placeholder is in place: the NUL tokens contain
  // no &<> characters and the provider tokens substitute in after escaping,
  // so escaping at each stage would double-encode user text.
  text = escapeSlackMrkdwn(text);
  for (const placeholder of placeholders) {
    text = text.replaceAll(
      placeholder.token,
      placeholder.providerToken ?? `<@${placeholder.providerUserId}>`,
    );
  }
  return text;
}

export function renderSlackBridgeUsername(authorName: string): string | null {
  const suffix = " from Raft";
  const normalized = authorName.trim();
  const boundedName = Array.from(normalized).slice(0, 80 - suffix.length).join("").trimEnd();
  const username = `${boundedName}${suffix}`;
  if (!boundedName || /[\u0000-\u001f\u007f]/u.test(username)) return null;
  return username;
}

/** What a bridged post carries in Slack's message metadata (reconciliation reads it back). */
export interface SlackBridgeMessageMetadataInput {
  deliveryId: string;
  reconciliationMarker: string;
  sourceMessageId: string;
  sourcePermalink: string;
  senderType: "user" | "agent";
  connectionEpoch: number;
  bindingEpoch: number;
}

function slackBridgeMessageMetadata(input: SlackBridgeMessageMetadataInput, cardRevision?: number): SlackJsonObject {
  return {
    event_type: "raft_message",
    event_payload: {
      delivery_id: input.deliveryId,
      reconciliation_marker: input.reconciliationMarker,
      source_message_id: input.sourceMessageId,
      source_permalink: input.sourcePermalink,
      source_sender_type: input.senderType,
      connection_epoch: input.connectionEpoch,
      binding_epoch: input.bindingEpoch,
      ...(cardRevision !== undefined ? { card_revision: cardRevision } : {}),
    },
  };
}

function buildPostMessageRequest(input: {
  dispatch: SlackBridgeProviderDispatchInput;
  providerThreadId: string | null;
}): SlackWebApiRequest | null {
  const authority = authorityFromDispatch(input.dispatch);
  const snapshot = input.dispatch.renderSnapshot;
  const renderedText = renderSlackBridgeText(snapshot);
  const text = renderedText === null ? null : input.dispatch.decorateRenderedText?.(renderedText) ?? renderedText;
  const username = renderSlackBridgeUsername(snapshot.authorName);
  if (!text || !username) {
    return null;
  }
  const body: SlackJsonObject = {
    channel: authority.providerConversationId,
    text,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
    username,
    metadata: slackBridgeMessageMetadata({
      deliveryId: input.dispatch.deliveryId,
      reconciliationMarker: input.dispatch.reconciliationMarker,
      sourceMessageId: snapshot.sourceMessageId,
      sourcePermalink: snapshot.sourcePermalink,
      senderType: snapshot.senderType,
      connectionEpoch: authority.connectionEpoch,
      bindingEpoch: authority.bindingEpoch,
    }),
  };
  if (snapshot.authorPresentation.avatar) {
    body.icon_url = snapshot.authorPresentation.avatar.publicUrl;
  } else {
    body.icon_emoji = snapshot.senderType === "agent" ? ":robot_face:" : ":bust_in_silhouette:";
  }
  if (input.providerThreadId) body.thread_ts = input.providerThreadId;
  return {
    method: "chat.postMessage",
    credentialHandle: input.dispatch.credentialHandle,
    authority,
    body,
  };
}

/**
 * Creates the provider adapter at the worker's pre-I/O seam. Every receipt is
 * checked before `provider_io_started`; the returned closure memoizes its one
 * transport call so an unknown outcome is never blindly re-issued in-process.
 */
export function createSlackProviderPreparation(
  dependencies: SlackProviderAdapterDependencies,
): (
  input: SlackBridgeProviderDispatchInput,
) => Promise<SlackBridgeProviderPreparation> {
  return async (input) => {
    const now = dependencies.now?.() ?? currentDate();
    const authority = authorityFromDispatch(input);
    if (
      !validDate(now)
      || input.deliveryId.trim().length === 0
      || !/^[A-Za-z0-9_-]{43}$/.test(input.reconciliationMarker)
      || !credentialMatchesAuthority(input.credentialHandle, authority, now)
      || authority.providerAuthorityId !== input.renderSnapshot.bindingAuthority.providerAuthorityId
      || authority.providerConversationId !== input.renderSnapshot.bindingAuthority.providerConversationId
    ) {
      return { ready: false, reason: "provider_preflight_receipt_invalid" };
    }

    let providerThreadId: string | null = null;
    if (input.renderSnapshot.level === "thread") {
      const canonicalRootMessageId = input.renderSnapshot.canonicalRootMessageId;
      if (!canonicalRootMessageId || !dependencies.threadAuthority) {
        return { ready: false, reason: "provider_thread_receipt_missing" };
      }
      const thread = await dependencies.threadAuthority.resolve({
        canonicalRootMessageId,
        authority,
      });
      if (!thread.active) {
        return thread.reason === "missing"
          ? { ready: false, disposition: "discard", reason: CONFIRMED_THREAD_ROOT_MISSING }
          : { ready: false, reason: "provider_thread_receipt_" + thread.reason };
      }
      if (!providerThreadAuthorityMatches(authority, thread.fact)) {
        return { ready: false, reason: "provider_thread_receipt_mismatch" };
      }
      providerThreadId = thread.fact.providerThreadId;
    }

    const request = buildPostMessageRequest({ dispatch: input, providerThreadId });
    if (!request) return { ready: false, reason: "provider_render_snapshot_invalid" };
    let dispatched: Promise<SlackBridgeProviderDispatchOutcome> | null = null;
    return {
      ready: true,
      dispatch() {
        dispatched ??= (async () => {
          if (!input.resolveCurrentRenderMentions) return dependencies.transport.call(request);
          const mentions = await input.resolveCurrentRenderMentions();
          const currentRequest = buildPostMessageRequest({ dispatch: { ...input,
            renderSnapshot: { ...input.renderSnapshot, ...mentions } }, providerThreadId });
          if (!currentRequest) throw new Error("Current Slack message render is invalid");
          return dependencies.transport.call(currentRequest);
        })()
          .then((result) => normalizePostMessageResult({
            result,
            authority,
            quarantineSink: dependencies.quarantineSink,
            providerThreadId,
          }))
          .catch((): SlackBridgeProviderDispatchOutcome => ({
            kind: "outcome_unknown",
          }));
        return dispatched;
      },
    };
  };
}

// ---------------------------------------------------------------------------
// RFC 082 §4.6: a card update edits its bridged Slack copy (chat.update), and
// a read-back (conversations.history / conversations.replies by ts) tells
// which card revision Slack shows. The edit is the original's structure: text
// plus the original's metadata (with card_revision), never blocks or files.

/** The send path's Slack length rule (outbound admission): no NUL and at most 40,000 UTF-8 bytes. */
export const SLACK_BRIDGE_MAX_TEXT_BYTES = 40_000;

export function slackBridgeTextWithinSendRule(text: string): boolean {
  return text.length > 0 && !text.includes("\0") && Buffer.byteLength(text, "utf8") <= SLACK_BRIDGE_MAX_TEXT_BYTES;
}

/**
 * A card edit's text, with every mention form as plain text (an update
 * notifies no one, §4.2; the send-time mention rendering is not reused).
 * Escaping `&`, `<` and `>` turns Slack markup (`<@U…>`, `<!subteam^…>`,
 * `<!here>`, `<!channel>`, `<!everyone>`) into literal text, and a WORD JOINER
 * after each `@` keeps `@handle`, `@here`, `@channel` and `@everyone` literal
 * whatever the parse mode. Nothing else changes visibly.
 */
export function renderSlackCardEditText(content: string): string {
  return escapeSlackMrkdwn(content).replace(/@(?=[\p{L}\p{N}_.-])/gu, "@⁠");
}

export interface SlackCardEditRequestInput {
  credentialHandle: SlackBridgeCredentialHandle;
  authority: SlackProviderAuthorityFence;
  /** The confirmed original's Slack ts; never guessed. */
  providerMessageId: string;
  /** The revision's fallback text, as stored. */
  content: string;
  cardRevision: number;
  /** The original post's metadata, unchanged apart from card_revision. */
  original: SlackBridgeMessageMetadataInput;
}

/** The chat.update body: text plus the original's metadata and card_revision; no blocks, no attachments. */
export function buildSlackCardEditRequest(input: SlackCardEditRequestInput): SlackWebApiRequest | null {
  if (!/^[0-9]{1,20}\.[0-9]{1,20}$/u.test(input.providerMessageId)
    || !Number.isSafeInteger(input.cardRevision) || input.cardRevision < 2
    || !slackBridgeTextWithinSendRule(input.content)) return null;
  return {
    method: "chat.update",
    credentialHandle: input.credentialHandle,
    authority: input.authority,
    body: {
      channel: input.authority.providerConversationId,
      ts: input.providerMessageId,
      text: renderSlackCardEditText(input.content),
      // Never link names or special mentions, whatever the text says.
      parse: "none",
      link_names: false,
      metadata: slackBridgeMessageMetadata(input.original, input.cardRevision),
    },
  };
}

/**
 * A kept failure: a recoverable access or channel state, shown to the pair's
 * admins like a pair block. The same revision is tried again once the pair is
 * usable; never proof the target is gone, never a refusal of the revision.
 */
export type SlackCardEditKeptReason =
  | "slack_not_in_channel" | "slack_channel_not_found" | "slack_permission_missing"
  | "slack_workspace_admin_required" | "slack_channel_archived" | "slack_channel_inactive"
  | "slack_channel_restricted" | "provider_credential_revoked";

export type SlackCardEditOutcome =
  | { kind: "succeeded" }
  /** Slack definitely did not apply it (not sent, or rate limited): try again later. */
  | { kind: "not_sent"; reason: string; retryAfterMs: number }
  | { kind: "unknown"; reason: string }
  /** A definite, non-retryable refusal of this revision (msg_too_long and the like). */
  | { kind: "refused"; reason: string }
  | { kind: "message_not_found" }
  | { kind: "kept"; reason: SlackCardEditKeptReason }
  | { kind: "identity_changed"; reason: string };

/** Content-level refusals of this revision's request: final for the revision (a newer one still goes). */
const SLACK_CARD_EDIT_REFUSALS = new Set([
  "msg_too_long", "edit_window_closed", "no_text", "invalid_arguments", "invalid_metadata_format",
  "invalid_metadata_schema", "metadata_too_large", "metadata_must_be_sent_from_app", "invalid_blocks",
  "invalid_blocks_format", "msg_blocks_too_long", "too_many_attachments",
]);

/** Access and channel-state errors: recoverable, so held and retried, never a refusal. */
const SLACK_CARD_EDIT_KEPT: Record<string, SlackCardEditKeptReason> = {
  not_in_channel: "slack_not_in_channel",
  channel_not_found: "slack_channel_not_found",
  missing_scope: "slack_permission_missing",
  no_permission: "slack_permission_missing",
  access_denied: "slack_permission_missing",
  ekm_access_denied: "slack_permission_missing",
  app_access_restricted: "slack_workspace_admin_required",
  is_archived: "slack_channel_archived",
  // A frozen or archived channel (Slack's chat.update): it can come back.
  is_inactive: "slack_channel_inactive",
  restricted_action: "slack_channel_restricted",
  restricted_action_read_only_channel: "slack_channel_restricted",
  restricted_action_thread_only_channel: "slack_channel_restricted",
  restricted_action_thread_locked: "slack_channel_restricted",
};

/** Classify Slack's answer to one chat.update; anything not definite is unknown. */
export function classifySlackCardEditResult(
  result: SlackWebApiTransportResult,
  expected: { authority: SlackProviderAuthorityFence; providerMessageId: string },
): SlackCardEditOutcome {
  if (result.kind === "transport_failure") {
    return result.phase === "before_send"
      ? { kind: "not_sent", reason: "slack_request_not_sent", retryAfterMs: DEFAULT_TRANSIENT_RETRY_BASE_MS }
      : { kind: "unknown", reason: `slack_transport_${result.code}` };
  }
  const error = nonEmptyString(result.body.error);
  if (result.status === 429 || error === "ratelimited" || error === "rate_limited") {
    return { kind: "not_sent", reason: "slack_rate_limited", retryAfterMs: parseRetryAfterMs(result.headers) };
  }
  const observed = result.observedAuthority;
  if ((observed?.providerAppId !== undefined && observed.providerAppId !== expected.authority.providerAppId)
    || (observed?.providerAuthorityId !== undefined && observed.providerAuthorityId !== expected.authority.providerAuthorityId)) {
    return { kind: "identity_changed", reason: "slack_identity_conflict" };
  }
  if (result.body.ok === true) {
    // Only Slack's own receipt for this message in this conversation counts.
    return result.status >= 200 && result.status < 300
      && nonEmptyString(result.body.channel) === expected.authority.providerConversationId
      && nonEmptyString(result.body.ts) === expected.providerMessageId
      ? { kind: "succeeded" }
      : { kind: "unknown", reason: "slack_receipt_mismatch" };
  }
  if (!error) return { kind: "unknown", reason: "slack_outcome_unknown" };
  if (error === "message_not_found") return { kind: "message_not_found" };
  if (error === "cant_update_message") return { kind: "identity_changed", reason: "slack_cant_update_message" };
  if (AUTH_REVOKED_ERRORS.has(error)) return { kind: "kept", reason: "provider_credential_revoked" };
  const kept = SLACK_CARD_EDIT_KEPT[error];
  if (kept) return { kind: "kept", reason: kept };
  if (AMBIGUOUS_PROVIDER_ERRORS.has(error) || result.status >= 500) return { kind: "unknown", reason: "slack_outcome_unknown" };
  if (SLACK_CARD_EDIT_REFUSALS.has(error)) return { kind: "refused", reason: error };
  return { kind: "unknown", reason: "slack_outcome_unknown" };
}

export type SlackCardReadBack =
  /** The bridged message as Slack shows it; card_revision 1 is the original's first text. */
  | { kind: "shown"; revision: number }
  /** The message could not be read back (missing, not ours, no metadata, or Slack refused the read). */
  | { kind: "unreadable"; reason: string }
  /** Not read (rate limited or not sent): read again later, in the same stage. */
  | { kind: "retry"; reason: string; retryAfterMs: number };

/**
 * Read back one bridged message by its ts and say which card revision it
 * shows. Read-only. The message must be the bridge App's (Slack's app_id, not
 * anything in the message) and carry this delivery's metadata.
 */
export async function readBackSlackCardRevision(input: {
  transport: SlackWebApiTransport;
  credentialHandle: SlackBridgeCredentialHandle;
  authority: SlackProviderAuthorityFence;
  providerMessageId: string;
  providerThreadId: string | null;
  deliveryId: string;
}): Promise<SlackCardReadBack> {
  const ts = input.providerMessageId;
  const thread = input.providerThreadId && input.providerThreadId !== ts ? input.providerThreadId : null;
  let result: SlackWebApiTransportResult;
  try {
    result = await input.transport.call({
      method: thread ? "conversations.replies" : "conversations.history",
      credentialHandle: input.credentialHandle,
      authority: input.authority,
      body: {
        channel: input.authority.providerConversationId,
        ...(thread ? { ts: thread } : {}),
        latest: ts,
        oldest: ts,
        inclusive: true,
        // A replies page always leads with its root.
        limit: thread ? 2 : 1,
        include_all_metadata: true,
      },
    });
  } catch {
    return { kind: "unreadable", reason: "readback_transport_exception" };
  }
  if (result.kind === "transport_failure") {
    return result.phase === "before_send"
      ? { kind: "retry", reason: "readback_not_sent", retryAfterMs: DEFAULT_TRANSIENT_RETRY_BASE_MS }
      : { kind: "unreadable", reason: `readback_transport_${result.code}` };
  }
  if (result.status === 429 || result.body.error === "ratelimited") {
    return { kind: "retry", reason: "readback_rate_limited", retryAfterMs: parseRetryAfterMs(result.headers) };
  }
  if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
    return { kind: "unreadable", reason: `readback_${nonEmptyString(result.body.error) ?? "provider_error"}`.slice(0, 160) };
  }
  const messages = Array.isArray(result.body.messages) ? result.body.messages.filter(isRecord) : [];
  const message = messages.find((candidate) => slackProviderMessageId(candidate) === ts);
  if (!message) return { kind: "unreadable", reason: "readback_message_missing" };
  if (nonEmptyString(message.app_id) !== input.authority.providerAppId) {
    return { kind: "unreadable", reason: "readback_author_conflict" };
  }
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const payload = metadata?.event_type === "raft_message" && isRecord(metadata.event_payload) ? metadata.event_payload : null;
  if (!payload) return { kind: "unreadable", reason: "readback_metadata_missing" };
  if (payload.delivery_id !== input.deliveryId) return { kind: "unreadable", reason: "readback_delivery_conflict" };
  const revision = payload.card_revision;
  if (revision === undefined) return { kind: "shown", revision: 1 };
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 2
    ? { kind: "shown", revision }
    : { kind: "unreadable", reason: "readback_revision_invalid" };
}

export interface SlackOAuthCodeHandle {
  schema: typeof SLACK_OAUTH_CODE_HANDLE_SCHEMA;
  handleId: string;
  expiresAt: Date;
}

export interface SlackOAuthAppCredentialHandle {
  schema: typeof SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA;
  handleId: string;
  providerAppId: string;
  environment: "test" | "production";
}

export interface SlackOAuthExchangeRequest {
  serverId: string;
  authorizationCode: SlackOAuthCodeHandle;
  appCredential: SlackOAuthAppCredentialHandle;
  redirectUri: string;
  expectedProviderAppId: string;
  expectedScopes: string[];
  now: Date;
}

export interface SlackOAuthExchangeTransport {
  /** Doubles are never live OAuth or release evidence. */
  readonly evidence: "double" | "live";
  exchange(
    request: SlackOAuthExchangeRequest,
  ): Promise<SlackOAuthExchangeTransportResult>;
}

export type SlackOAuthExchangeTransportResult =
  | {
      kind: "authorized";
      providerAppId: string;
      providerTeamId: string;
      providerEnterpriseId: string | null;
      providerUserId: string;
      /** Verified against users.info for this exact OAuth human and workspace. */
      workspaceAdminVerified?: boolean;
      botUserId: string;
      providerBotId: string | null;
      workspaceName: string | null;
      installedScopes: string[];
      sealedCredential: SealedExternalCredential;
    }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "rejected"; error: string }
  | { kind: "transport_failure"; phase: "before_send" | "after_send" | "unknown" };

export interface SlackOAuthHandleMaterial {
  providerOAuthClientId: string;
  clientSecret: string;
  authorizationCode: string;
}

export interface SlackOAuthHandleMaterialStore {
  /**
   * Atomically consumes both one-use handles before provider I/O. A missing or
   * mismatched handle must return null; consumed handles are never restored
   * after an ambiguous provider outcome.
   */
  consume(input: {
    authorizationCode: SlackOAuthCodeHandle;
    appCredential: SlackOAuthAppCredentialHandle;
    expectedProviderAppId: string;
    now: Date;
  }): Promise<SlackOAuthHandleMaterial | null>;
}

export interface SlackOAuthAppSecretLeaseProvider {
  /**
   * Resolves one short-lived app secret lease from the deployment secret
   * manager. The returned plaintext must never leave the coordinator below.
   */
  lease(input: {
    registrationId: string;
    providerAppId: string;
    providerOAuthClientId: string;
    environment: "test" | "production";
    audience: "slack-oauth-exchange";
    attemptId: string;
    now: Date;
  }): Promise<{
    providerOAuthClientId: string;
    clientSecret: string;
    expiresAt: Date;
  } | null>;
}

export interface SlackOAuthManagedHandleCoordinator {
  leaseAppCredential(input: {
    registrationId: string;
    providerAppId: string;
    providerOAuthClientId: string;
    environment: "test" | "production";
    audience: "slack-oauth-exchange";
    attemptId: string;
    now: Date;
  }): Promise<{
    handle: SlackOAuthAppCredentialHandle;
    leaseExpiresAt: Date;
  } | null>;
  captureAuthorizationCode(input: {
    attemptId: string;
    providerOAuthClientId: string;
    authorizationCode: string;
    now: Date;
  }): Promise<SlackOAuthCodeHandle>;
  handles: SlackOAuthHandleMaterialStore;
  stop(): void;
}

interface ManagedSlackOAuthAppLease {
  attemptId: string;
  providerAppId: string;
  providerOAuthClientId: string;
  environment: "test" | "production";
  clientSecret: string;
  expiresAt: Date;
}

interface ManagedSlackOAuthCodeLease {
  attemptId: string;
  providerOAuthClientId: string;
  authorizationCode: string;
  expiresAt: Date;
}

const DEFAULT_SLACK_OAUTH_HANDLE_TTL_MS = 60_000;

/**
 * Keeps raw OAuth app secrets and authorization codes inside one process for
 * only the callback's exchange window. Handles bind both materials to the same
 * durable attempt and are deleted before provider I/O, including mismatches.
 * A deployment supplies the secret-manager lease provider; no secret reference
 * or plaintext is returned through the route-facing handles.
 */
export function createSlackOAuthManagedHandleCoordinator(input: {
  appSecrets: SlackOAuthAppSecretLeaseProvider;
  handleTtlMs?: number;
  randomHandleId?: () => string;
}): SlackOAuthManagedHandleCoordinator {
  const handleTtlMs = input.handleTtlMs ?? DEFAULT_SLACK_OAUTH_HANDLE_TTL_MS;
  if (!validPositiveLimit(handleTtlMs)) {
    throw new Error("Slack OAuth handle coordinator configuration is invalid");
  }
  const randomHandleId = input.randomHandleId ?? randomUUID;
  const appLeases = new Map<string, ManagedSlackOAuthAppLease>();
  const codeLeases = new Map<string, ManagedSlackOAuthCodeLease>();
  const appHandleByAttempt = new Map<string, string>();
  const codeHandleByAttempt = new Map<string, string>();
  let stopped = false;

  const deleteApp = (handleId: string) => {
    const lease = appLeases.get(handleId);
    appLeases.delete(handleId);
    if (lease && appHandleByAttempt.get(lease.attemptId) === handleId) {
      appHandleByAttempt.delete(lease.attemptId);
    }
  };
  const deleteCode = (handleId: string) => {
    const lease = codeLeases.get(handleId);
    codeLeases.delete(handleId);
    if (lease && codeHandleByAttempt.get(lease.attemptId) === handleId) {
      codeHandleByAttempt.delete(lease.attemptId);
    }
  };
  const prune = (now: Date) => {
    for (const [handleId, lease] of appLeases) {
      if (lease.expiresAt <= now) deleteApp(handleId);
    }
    for (const [handleId, lease] of codeLeases) {
      if (lease.expiresAt <= now) deleteCode(handleId);
    }
  };
  const freshHandleId = (prefix: "app" | "code"): string => {
    const value = randomHandleId().trim();
    if (!value) throw new Error("Slack OAuth handle generation failed");
    return `slack-oauth-${prefix}:${value}`;
  };

  return {
    async leaseAppCredential(request) {
      if (
        stopped
        || !validDate(request.now)
        || !request.registrationId.trim()
        || !request.providerAppId.trim()
        || !request.providerOAuthClientId.trim()
        || !request.attemptId.trim()
        || request.audience !== "slack-oauth-exchange"
      ) return null;
      prune(request.now);
      if (
        appHandleByAttempt.has(request.attemptId)
        || codeHandleByAttempt.has(request.attemptId)
      ) return null;

      let material: Awaited<ReturnType<SlackOAuthAppSecretLeaseProvider["lease"]>>;
      try {
        material = await input.appSecrets.lease(request);
      } catch {
        return null;
      }
      if (
        stopped
        || !material
        || material.providerOAuthClientId !== request.providerOAuthClientId
        || !material.clientSecret
        || !validDate(material.expiresAt)
        || material.expiresAt <= request.now
      ) return null;

      const expiresAt = new Date(Math.min(
        material.expiresAt.getTime(),
        request.now.getTime() + handleTtlMs,
      ));
      const handleId = freshHandleId("app");
      if (appLeases.has(handleId) || codeLeases.has(handleId)) {
        throw new Error("Slack OAuth handle collision");
      }
      appLeases.set(handleId, {
        attemptId: request.attemptId,
        providerAppId: request.providerAppId,
        providerOAuthClientId: request.providerOAuthClientId,
        environment: request.environment,
        clientSecret: material.clientSecret,
        expiresAt,
      });
      appHandleByAttempt.set(request.attemptId, handleId);
      return {
        handle: {
          schema: SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
          handleId,
          providerAppId: request.providerAppId,
          environment: request.environment,
        },
        leaseExpiresAt: expiresAt,
      };
    },

    async captureAuthorizationCode(request) {
      if (
        stopped
        || !validDate(request.now)
        || !request.attemptId.trim()
        || !request.providerOAuthClientId.trim()
        || !request.authorizationCode
      ) throw new Error("Slack OAuth authorization-code capture rejected");
      prune(request.now);
      const appHandleId = appHandleByAttempt.get(request.attemptId);
      const appLease = appHandleId ? appLeases.get(appHandleId) : undefined;
      if (
        !appLease
        || appLease.expiresAt <= request.now
        || appLease.providerOAuthClientId !== request.providerOAuthClientId
        || codeHandleByAttempt.has(request.attemptId)
      ) throw new Error("Slack OAuth authorization-code capture rejected");

      const expiresAt = new Date(Math.min(
        appLease.expiresAt.getTime(),
        request.now.getTime() + handleTtlMs,
      ));
      const handleId = freshHandleId("code");
      if (appLeases.has(handleId) || codeLeases.has(handleId)) {
        throw new Error("Slack OAuth handle collision");
      }
      codeLeases.set(handleId, {
        attemptId: request.attemptId,
        providerOAuthClientId: request.providerOAuthClientId,
        authorizationCode: request.authorizationCode,
        expiresAt,
      });
      codeHandleByAttempt.set(request.attemptId, handleId);
      return {
        schema: SLACK_OAUTH_CODE_HANDLE_SCHEMA,
        handleId,
        expiresAt,
      };
    },

    handles: {
      async consume(request) {
        if (stopped || !validDate(request.now)) return null;
        prune(request.now);
        const appLease = appLeases.get(request.appCredential.handleId);
        const codeLease = codeLeases.get(request.authorizationCode.handleId);
        // Consume both caller-presented handles before checking the pair. A
        // confused or substituted callback must not retain retryable material.
        deleteApp(request.appCredential.handleId);
        deleteCode(request.authorizationCode.handleId);
        if (
          !appLease
          || !codeLease
          || appLease.expiresAt <= request.now
          || codeLease.expiresAt <= request.now
          || appLease.attemptId !== codeLease.attemptId
          || appLease.providerAppId !== request.expectedProviderAppId
          || appLease.providerAppId !== request.appCredential.providerAppId
          || appLease.environment !== request.appCredential.environment
          || appLease.providerOAuthClientId !== codeLease.providerOAuthClientId
        ) return null;
        return {
          providerOAuthClientId: appLease.providerOAuthClientId,
          clientSecret: appLease.clientSecret,
          authorizationCode: codeLease.authorizationCode,
        };
      },
    },

    stop() {
      stopped = true;
      appLeases.clear();
      codeLeases.clear();
      appHandleByAttempt.clear();
      codeHandleByAttempt.clear();
    },
  };
}

export interface SlackBotCredentialSealer {
  /** Raw Slack tokens may cross only this in-process seam. */
  seal(input: {
    serverId: string;
    accessToken: string;
    tokenType: "bot";
    providerAppId: string;
    providerTeamId: string;
    botUserId: string;
    now: Date;
  }): Promise<SealedExternalCredential>;
}

export interface SlackOAuthHttpTransportDependencies {
  handles: SlackOAuthHandleMaterialStore;
  credentialSealer: SlackBotCredentialSealer;
  fetch?: typeof fetch;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (timeout: unknown) => void;
  endpoint?: string;
  authTestEndpoint?: string;
  userInfoEndpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_SLACK_AUTH_TEST_ENDPOINT = "https://slack.com/api/auth.test";
const DEFAULT_SLACK_USER_INFO_ENDPOINT = "https://slack.com/api/users.info";

export type SlackOAuthExchangeOutcome =
  | Extract<SlackOAuthExchangeTransportResult, { kind: "authorized" }>
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; retryAfterMs: number }
  | {
      kind: "deterministic_failure";
      reason: "provider_rejected" | "scope_mismatch";
      /** Diagnostic detail: Slack's error string on provider_rejected;
       * the actual scope diff (missing/extra) on scope_mismatch. Neither
       * carries credential material. */
      providerError?: string;
    }
  | {
      kind: "identity_conflict";
      reason: "app" | "enterprise" | "team";
    }
  | { kind: "outcome_unknown" }
  | { kind: "preflight_rejected" };

function validSlackOAuthExchangeRequest(
  request: SlackOAuthExchangeRequest,
): boolean {
  return validDate(request.now)
    && request.serverId.trim().length > 0
    && request.authorizationCode.schema === SLACK_OAUTH_CODE_HANDLE_SCHEMA
    && request.authorizationCode.handleId.trim().length > 0
    && validDate(request.authorizationCode.expiresAt)
    && request.authorizationCode.expiresAt > request.now
    && request.appCredential.schema
      === SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA
    && request.appCredential.handleId.trim().length > 0
    && request.appCredential.providerAppId === request.expectedProviderAppId
    && request.redirectUri.trim().length > 0
    && request.expectedScopes.length > 0;
}

const DEFAULT_SLACK_OAUTH_ENDPOINT = "https://slack.com/api/oauth.v2.access";
const DEFAULT_SLACK_OAUTH_TIMEOUT_MS = 10_000;
const DEFAULT_SLACK_OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;

function validPositiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 16 * 1024 * 1024;
}

function validSlackOAuthEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:"
      && endpoint.username === ""
      && endpoint.password === "";
  } catch {
    return false;
  }
}

async function readBoundedSlackOAuthBody(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    return null;
  }
}

function slackOAuthString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function slackOAuthObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function slackOAuthScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))]
    .sort();
}

/**
 * Creates the live Slack OAuth HTTP transport while keeping secret custody in
 * injected stores. Both handles are consumed before the request. A response
 * after that point is never automatically retried, including HTTP 429.
 */
export function createSlackOAuthHttpTransport(
  dependencies: SlackOAuthHttpTransportDependencies,
): SlackOAuthExchangeTransport {
  const fetchImpl = dependencies.fetch ?? fetch;
  const scheduleTimeout = dependencies.scheduleTimeout ?? setClockTimeout;
  const cancelTimeout = dependencies.cancelTimeout ?? clearClockTimeout;
  const endpoint = dependencies.endpoint ?? DEFAULT_SLACK_OAUTH_ENDPOINT;
  const authTestEndpoint = dependencies.authTestEndpoint ?? DEFAULT_SLACK_AUTH_TEST_ENDPOINT;
  const userInfoEndpoint = dependencies.userInfoEndpoint ?? DEFAULT_SLACK_USER_INFO_ENDPOINT;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_SLACK_OAUTH_TIMEOUT_MS;
  const maxResponseBytes = dependencies.maxResponseBytes
    ?? DEFAULT_SLACK_OAUTH_MAX_RESPONSE_BYTES;
  if (
    !validSlackOAuthEndpoint(endpoint)
    || !validSlackOAuthEndpoint(authTestEndpoint)
    || !validSlackOAuthEndpoint(userInfoEndpoint)
    || !validPositiveLimit(timeoutMs)
    || !validPositiveLimit(maxResponseBytes)
  ) {
    throw new Error("Slack OAuth HTTP transport configuration is invalid");
  }

  return {
    evidence: "live",
    async exchange(request): Promise<SlackOAuthExchangeTransportResult> {
      if (!validSlackOAuthExchangeRequest(request)) {
        return { kind: "rejected", error: "invalid_request" };
      }

      let material: SlackOAuthHandleMaterial | null;
      try {
        material = await dependencies.handles.consume({
          authorizationCode: request.authorizationCode,
          appCredential: request.appCredential,
          expectedProviderAppId: request.expectedProviderAppId,
          now: request.now,
        });
      } catch {
        return { kind: "transport_failure", phase: "before_send" };
      }
      if (
        !material
        || !material.providerOAuthClientId.trim()
        || !material.clientSecret
        || !material.authorizationCode
      ) {
        return { kind: "rejected", error: "handle_unavailable" };
      }

      const controller = new AbortController();
      const timeout = scheduleTimeout(() => controller.abort(), timeoutMs);
      let receivedHeaders = false;
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: material.providerOAuthClientId,
            client_secret: material.clientSecret,
            code: material.authorizationCode,
            redirect_uri: request.redirectUri,
          }),
          redirect: "error",
          signal: controller.signal,
        });
        receivedHeaders = true;
        if (response.status === 429) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: "transport_failure", phase: "after_send" };
        }
        const text = await readBoundedSlackOAuthBody(response, maxResponseBytes);
        if (text === null) {
          return { kind: "transport_failure", phase: "after_send" };
        }
        let body: Record<string, unknown> | null;
        try {
          body = slackOAuthObject(JSON.parse(text));
        } catch {
          body = null;
        }
        if (!body) return { kind: "transport_failure", phase: "after_send" };
        if (response.status < 200 || response.status >= 300) {
          return { kind: "transport_failure", phase: "after_send" };
        }
        if (body.ok !== true) {
          return {
            kind: "rejected",
            error: slackOAuthString(body.error) ?? "provider_rejected",
          };
        }

        const providerAppId = slackOAuthString(body.app_id);
        const accessToken = slackOAuthString(body.access_token);
        const tokenType = slackOAuthString(body.token_type);
        const botUserId = slackOAuthString(body.bot_user_id);
        const authedUser = slackOAuthObject(body.authed_user);
        const providerUserId = slackOAuthString(authedUser?.id);
        const team = slackOAuthObject(body.team);
        const enterprise = slackOAuthObject(body.enterprise);
        const providerTeamId = slackOAuthString(team?.id);
        if (
          !providerAppId
          || !accessToken
          || tokenType !== "bot"
          || !botUserId
          || !providerUserId
          || providerUserId === botUserId
          || !providerTeamId
        ) {
          return { kind: "transport_failure", phase: "after_send" };
        }

        // Cross-bind the OAuth response to the token's effective identity and
        // grant before persistence. App identity comes from oauth.v2.access
        // and is checked against the expected registration by the normalized
        // outcome below; Slack's auth.test does not return app_id. The live
        // token response proves team, bot-user and bot identity, while scopes
        // come from that same response's x-oauth-scopes header. The similarly
        // named x-accepted-oauth-scopes header is never authority.
        const authResponse = await fetchImpl(authTestEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(),
          redirect: "error",
          signal: controller.signal,
        });
        const authText = await readBoundedSlackOAuthBody(authResponse, maxResponseBytes);
        if (authText === null || authResponse.status < 200 || authResponse.status >= 300) {
          return { kind: "transport_failure", phase: "after_send" };
        }
        let authBody: Record<string, unknown> | null;
        try {
          authBody = slackOAuthObject(JSON.parse(authText));
        } catch {
          authBody = null;
        }
        const authScopesHeader = authResponse.headers.get("x-oauth-scopes");
        const authScopes = typeof authScopesHeader === "string"
          ? slackOAuthScopes(authScopesHeader)
          : [];
        const oauthScopes = slackOAuthScopes(body.scope);
        const normalizedAuthScopes = [...new Set(authScopes)].sort();
        const normalizedOauthScopes = [...new Set(oauthScopes)].sort();
        const authBotId = slackOAuthString(authBody?.bot_id);
        if (
          authBody?.ok !== true
          || slackOAuthString(authBody.team_id) !== providerTeamId
          || slackOAuthString(authBody.user_id) !== botUserId
          || !authBotId
          || normalizedAuthScopes.length === 0
          || normalizedAuthScopes.length !== normalizedOauthScopes.length
          || normalizedAuthScopes.some((scope, index) => scope !== normalizedOauthScopes[index])
        ) {
          return { kind: "transport_failure", phase: "after_send" };
        }

        // Verify the exact OAuth human with the newly issued bot token before
        // persisting or rotating the shared credential: a real, current,
        // non-bot member of the workspace. Carry the independently observed
        // role to the transaction that decides whether this is a shared install.
        const userInfoResponse = await fetchImpl(userInfoEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ user: providerUserId }),
          redirect: "error",
          signal: controller.signal,
        });
        const userInfoText = await readBoundedSlackOAuthBody(userInfoResponse, maxResponseBytes);
        if (
          userInfoText === null
          || userInfoResponse.status < 200
          || userInfoResponse.status >= 300
        ) {
          return { kind: "transport_failure", phase: "after_send" };
        }
        let userInfoBody: Record<string, unknown> | null;
        try {
          userInfoBody = slackOAuthObject(JSON.parse(userInfoText));
        } catch {
          userInfoBody = null;
        }
        const installer = slackOAuthObject(userInfoBody?.user);
        if (
          userInfoBody?.ok !== true
          || !installer
          || slackOAuthString(installer?.id) !== providerUserId
          || installer.team_id !== providerTeamId
          || installer.deleted !== false
          || installer.is_bot !== false
          || installer.is_app_user === true
          || installer.is_stranger === true
          || installer.is_external === true
        ) {
          return { kind: "transport_failure", phase: "after_send" };
        }
        let sealedCredential: SealedExternalCredential;
        try {
          sealedCredential = await dependencies.credentialSealer.seal({
            serverId: request.serverId,
            accessToken,
            tokenType: "bot",
            providerAppId,
            providerTeamId,
            botUserId,
            now: request.now,
          });
        } catch {
          return { kind: "transport_failure", phase: "after_send" };
        }
        if (
          !sealedCredential.encryptedMaterial
          || !sealedCredential.envelopeKeyId
          || !positiveSafeInteger(sealedCredential.aadVersion)
        ) {
          return { kind: "transport_failure", phase: "after_send" };
        }
        return {
          kind: "authorized",
          providerAppId,
          providerTeamId,
          providerEnterpriseId: slackOAuthString(enterprise?.id),
          providerUserId,
          workspaceAdminVerified: installer.team_id === providerTeamId
            && installer.deleted === false && installer.is_bot === false
            && (installer.is_admin === true || installer.is_owner === true),
          botUserId,
          providerBotId: authBotId,
          workspaceName: slackOAuthString(team?.name),
          installedScopes: normalizedAuthScopes,
          sealedCredential,
        };
      } catch {
        return {
          kind: "transport_failure",
          phase: receivedHeaders ? "after_send" : "unknown",
        };
      } finally {
        cancelTimeout(timeout);
      }
    },
  };
}

/**
 * Maps a secret-sealing OAuth transport into the existing control-plane
 * completion shape. Raw authorization codes, app secrets, and access tokens
 * never cross this seam.
 */
export function normalizeSlackOAuthExchangeResult(input: {
  request: SlackOAuthExchangeRequest;
  result: SlackOAuthExchangeTransportResult;
}): SlackOAuthExchangeOutcome {
  if (!validSlackOAuthExchangeRequest(input.request)) {
    return { kind: "preflight_rejected" };
  }

  if (input.result.kind === "transport_failure") {
    return input.result.phase === "before_send"
      ? {
        kind: "transient_failure",
        retryAfterMs: DEFAULT_TRANSIENT_RETRY_BASE_MS,
      }
      : { kind: "outcome_unknown" };
  }
  if (input.result.kind === "rate_limited") {
    return {
      kind: "rate_limited",
      retryAfterMs: Math.max(0, Math.min(
        2_147_483_647,
        Number.isSafeInteger(input.result.retryAfterMs)
          ? input.result.retryAfterMs
          : INVALID_RETRY_AFTER_FALLBACK_MS,
      )),
    };
  }
  if (input.result.kind === "rejected") {
    if (input.result.error === "handle_unavailable") {
      return { kind: "preflight_rejected" };
    }
    return AMBIGUOUS_PROVIDER_ERRORS.has(input.result.error)
      ? { kind: "outcome_unknown" }
      : {
          kind: "deterministic_failure",
          reason: "provider_rejected",
          providerError: input.result.error,
        };
  }
  const authorizedResult = input.result;
  if (input.result.providerAppId !== input.request.expectedProviderAppId) {
    return { kind: "identity_conflict", reason: "app" };
  }
  if (input.result.providerEnterpriseId !== null) {
    return { kind: "identity_conflict", reason: "enterprise" };
  }
  if (!input.result.providerTeamId.trim()) {
    return { kind: "identity_conflict", reason: "team" };
  }
  const missingScopes = input.request.expectedScopes.filter(
    (s) => !authorizedResult.installedScopes.includes(s),
  );
  if (missingScopes.length) {
    return {
      kind: "deterministic_failure",
      reason: "scope_mismatch",
      providerError: `missing:${missingScopes.join(",")}`,
    };
  }
  if (
    !input.result.providerUserId.trim()
    || !input.result.botUserId.trim()
    || input.result.providerUserId.trim() === input.result.botUserId.trim()
    || !input.result.sealedCredential.encryptedMaterial
    || !input.result.sealedCredential.envelopeKeyId
    || !positiveSafeInteger(input.result.sealedCredential.aadVersion)
  ) return { kind: "outcome_unknown" };
  return input.result;
}

export function createSlackOAuthExchangeAdapter(input: {
  transport: SlackOAuthExchangeTransport;
}): (request: SlackOAuthExchangeRequest) => Promise<SlackOAuthExchangeOutcome> {
  return async (request) => {
    if (!validSlackOAuthExchangeRequest(request)) {
      return { kind: "preflight_rejected" };
    }
    let result: SlackOAuthExchangeTransportResult;
    try {
      result = await input.transport.exchange(request);
    } catch {
      return { kind: "outcome_unknown" };
    }
    return normalizeSlackOAuthExchangeResult({ request, result });
  };
}

export type SlackHttpHeaders =
  Readonly<Record<string, string | readonly string[] | undefined>>;

export interface SlackEventsHttpRequest {
  requestUrl: string;
  environment: "test" | "production";
  rawBody: Buffer;
  headers: SlackHttpHeaders;
  secretResolver: ExternalIngressSecretResolver;
  payloadSealer: ExternalIngressPayloadSealer;
  runtimeResolver?: ExternalIngressRuntimeResolver;
  verifiedIngressCrypto?: SlackVerifiedIngressPayloadCrypto;
  testIdentityObserver?: SlackTestIdentityObserver;
  requestLifecycleRefresh?(bindingId: string): void;
  readLifecycleMemberProfile?(bindingId: string, providerUserId: string): Promise<SlackLifecycleMemberProfile | null>;
  now?: Date;
}

export type SlackIngressEventStatus =
  | "queued"
  | "quarantined"
  | "paused"
  | "revoked"
  | "unsupported"
  | "committed"
  | "duplicate"
  | "echo"
  | "dead";

export type SlackEventsHttpResponse =
  | {
      statusCode: 200;
      body: {
        kind: "url_verification";
        challenge: string;
      };
    }
  | {
      statusCode: 200;
      body: {
        kind: "event";
        eventInboxId: string;
        duplicate: boolean;
        status: SlackIngressEventStatus;
      };
    };

export type SlackIngressAuthorityAdapter = (
  input: Parameters<typeof verifyAndAdmitSlackIngress>[0],
) => Promise<SlackIngressAdmission>;

export const SLACK_EVENTS_REQUIRED_HEADER_NAMES = [
  "x-slack-request-timestamp",
  "x-slack-signature",
] as const;

export const SLACK_EVENTS_OPTIONAL_HEADER_NAMES = [
  "x-slack-retry-num",
  "x-slack-retry-reason",
] as const;

export const SLACK_EVENTS_CONSUMED_HEADER_NAMES = [
  ...SLACK_EVENTS_REQUIRED_HEADER_NAMES,
  ...SLACK_EVENTS_OPTIONAL_HEADER_NAMES,
] as const;

function singleHeader(headers: SlackHttpHeaders, expectedName: string): string | null {
  const matches = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === expectedName);
  if (matches.length !== 1) return null;
  const value = matches[0]?.[1];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalSingleHeader(headers: SlackHttpHeaders, expectedName: string): string | null {
  const matches = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === expectedName);
  if (matches.length === 0) return null;
  const value = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExternalAppIngressError(
      `Slack ${expectedName} header is invalid`,
      "external_ingress_payload_invalid",
    );
  }
  return value;
}

/**
 * HTTP-only adapter. It never parses the envelope itself: the unchanged raw
 * bytes and signature headers enter the existing authority seam, which
 * verifies the signature/timestamp before JSON parsing or durable admission.
 */
export function createSlackEventsHttpAdapter(input: {
  admit?: SlackIngressAuthorityAdapter;
} = {}): (request: SlackEventsHttpRequest) => Promise<SlackEventsHttpResponse> {
  const admit = input.admit ?? verifyAndAdmitSlackIngress;
  return async (request) => {
    const timestampHeader = singleHeader(
      request.headers,
      SLACK_EVENTS_REQUIRED_HEADER_NAMES[0],
    );
    const signatureHeader = singleHeader(
      request.headers,
      SLACK_EVENTS_REQUIRED_HEADER_NAMES[1],
    );
    if (!timestampHeader || !signatureHeader) {
      throw new ExternalAppIngressError(
        "Slack signature headers are unavailable",
        "external_ingress_signature_invalid",
      );
    }
    const result = await admit({
      requestUrl: request.requestUrl,
      environment: request.environment,
      rawBody: request.rawBody,
      timestampHeader,
      signatureHeader,
      slackRetryNumHeader: optionalSingleHeader(request.headers, SLACK_EVENTS_OPTIONAL_HEADER_NAMES[0]),
      slackRetryReasonHeader: optionalSingleHeader(request.headers, SLACK_EVENTS_OPTIONAL_HEADER_NAMES[1]),
      secretResolver: request.secretResolver,
      payloadSealer: request.payloadSealer,
      runtimeResolver: request.runtimeResolver,
      verifiedIngressCrypto: request.verifiedIngressCrypto,
      testIdentityObserver: request.testIdentityObserver,
      ...(request.requestLifecycleRefresh ? { requestLifecycleRefresh: request.requestLifecycleRefresh } : {}),
      readLifecycleMemberProfile: request.readLifecycleMemberProfile,
      now: request.now,
    });
    if (result.kind === "url_verification") {
      return {
        statusCode: 200,
        body: { kind: "url_verification", challenge: result.challenge },
      };
    }
    return {
      statusCode: 200,
      body: {
        kind: "event",
        eventInboxId: result.eventInboxId,
        duplicate: result.duplicate,
        status: result.status,
      },
    };
  };
}

export interface SlackProviderUserFact {
  providerUserId: string;
  providerAuthorityId: string;
  displayNameSnapshot: string | null;
  handleSnapshot: string | null;
  avatarUrlDigest: string | null;
  isBot: boolean;
  isDeleted: boolean;
  observedAt: Date;
}

export interface SlackProviderBotFact {
  providerBotId: string;
  providerUserId: string | null;
  providerAppId: string | null;
  providerAuthorityId: string;
  displayNameSnapshot: string | null;
  avatarUrlDigest: string | null;
  isDeleted: boolean | null;
  observedAt: Date;
}

export interface SlackProviderConversationFact {
  providerConversationId: string;
  providerAuthorityId: string;
  nameSnapshot: string | null;
  privacyClass: "public" | "private";
  isArchived: boolean;
  isMemberObserved: boolean;
  observedAt: Date;
}

export interface SlackProviderConversationMembersFact {
  providerConversationId: string;
  providerAuthorityId: string;
  providerMemberIds: string[];
  observedAt: Date;
}

export type SlackProviderDirectoryOutcome<T> =
  | { kind: "fact"; fact: T }
  | { kind: "rate_limited"; retryAfterMs: number }
  | {
      kind: "unavailable";
      reason:
        | "authority_quarantined"
        | "credential_unavailable"
        | "deterministic"
        | "identity_conflict"
        | "outcome_unknown";
    };

async function normalizeDirectoryFailure(input: {
  result: SlackWebApiTransportResult;
  authority: SlackProviderAuthorityFence;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
}): Promise<SlackProviderDirectoryOutcome<never> | null> {
  if (input.result.kind === "transport_failure") {
    return {
      kind: "unavailable",
      reason: input.result.phase === "before_send"
        ? "deterministic"
        : "outcome_unknown",
    };
  }
  if (input.result.status === 429) {
    return {
      kind: "rate_limited",
      retryAfterMs: parseRetryAfterMs(input.result.headers),
    };
  }
  if (
    input.result.observedAuthority
    && (
      input.result.observedAuthority.providerAppId
        !== input.authority.providerAppId
      || input.result.observedAuthority.providerAuthorityId
        !== input.authority.providerAuthorityId
    )
  ) {
    const reason = input.result.observedAuthority.providerAppId
      !== input.authority.providerAppId
      ? "provider_app_identity_conflict" as const
      : "provider_authority_identity_conflict" as const;
    const fenced = await input.quarantineSink.quarantine({
      ...input.authority,
      reason,
    });
    return {
      kind: "unavailable",
      reason: fenced === "fence_mismatch"
        ? "identity_conflict"
        : "authority_quarantined",
    };
  }
  const error = nonEmptyString(input.result.body.error);
  if (AUTH_REVOKED_ERRORS.has(error ?? "")) {
    const fenced = await input.quarantineSink.quarantine({
      ...input.authority,
      reason: "provider_credential_revoked",
    });
    return {
      kind: "unavailable",
      reason: fenced === "fence_mismatch"
        ? "identity_conflict"
        : "authority_quarantined",
    };
  }
  if (input.result.body.ok !== true) {
    return {
      kind: "unavailable",
      reason: AMBIGUOUS_PROVIDER_ERRORS.has(error ?? "")
        || input.result.status >= 500
        ? "outcome_unknown"
        : "deterministic",
    };
  }
  return null;
}

/** Provider lookup only; no user, member or mention authority is created here. */
export async function lookupSlackProviderBot(input: {
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  credentialHandle: SlackBridgeCredentialHandle;
  authority: SlackProviderAuthorityFence;
  providerBotId: string;
  now: Date;
  /** Transient only; callers must pass through the restricted avatar materializer. */
  onAvatarLocator?: (locator: string) => void;
}): Promise<SlackProviderDirectoryOutcome<SlackProviderBotFact>> {
  if (!validDate(input.now) || !/^B[A-Z0-9]{2,159}$/u.test(input.providerBotId)
    || !credentialMatchesAuthority(input.credentialHandle, input.authority, input.now)) {
    return { kind: "unavailable", reason: "deterministic" };
  }
  const result = await input.transport.call({ method: "bots.info", credentialHandle: input.credentialHandle,
    authority: input.authority, body: { bot: input.providerBotId } });
  const failure = await normalizeDirectoryFailure({ result, authority: input.authority, quarantineSink: input.quarantineSink });
  if (failure) return failure;
  if (result.kind !== "response" || !isRecord(result.body.bot)) return { kind: "unavailable", reason: "outcome_unknown" };
  const bot = result.body.bot;
  if (bot.id !== input.providerBotId) return { kind: "unavailable", reason: "identity_conflict" };
  const user = bot.user_id == null ? null : nonEmptyString(bot.user_id);
  const app = bot.app_id == null ? null : nonEmptyString(bot.app_id);
  if ((bot.user_id != null && (!user || !/^[UW][A-Z0-9]{2,159}$/u.test(user)))
    || (bot.app_id != null && (!app || !/^A[A-Z0-9]{2,159}$/u.test(app)))) {
    return { kind: "unavailable", reason: "identity_conflict" };
  }
  const rawName = nonEmptyString(bot.name);
  const name = rawName && Buffer.byteLength(rawName, "utf8") <= 512 && !/[\p{Cc}\p{Cf}]/u.test(rawName) ? rawName : null;
  const icons = isRecord(bot.icons) ? bot.icons : {};
  const avatarUrl = nonEmptyString(icons.image_72) ?? nonEmptyString(icons.image_48);
  if (avatarUrl && Buffer.byteLength(avatarUrl, "utf8") <= 4096) {
    try { input.onAvatarLocator?.(avatarUrl); } catch { /* a display hint cannot invalidate a verified profile */ }
  }
  return { kind: "fact", fact: { providerBotId: input.providerBotId, providerUserId: user, providerAppId: app,
    providerAuthorityId: input.authority.providerAuthorityId, displayNameSnapshot: name,
    avatarUrlDigest: avatarUrl ? sha256(avatarUrl) : null,
    isDeleted: typeof bot.deleted === "boolean" ? bot.deleted : null, observedAt: input.now } };
}

export async function lookupSlackProviderUser(input: {
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  credentialHandle: SlackBridgeCredentialHandle;
  authority: SlackProviderAuthorityFence;
  providerUserId: string;
  now: Date;
}): Promise<SlackProviderDirectoryOutcome<SlackProviderUserFact>> {
  if (
    !validDate(input.now)
    || !input.providerUserId.trim()
    || !credentialMatchesAuthority(
      input.credentialHandle,
      input.authority,
      input.now,
    )
  ) {
    return { kind: "unavailable", reason: "deterministic" };
  }
  const result = await input.transport.call({
    method: "users.info",
    credentialHandle: input.credentialHandle,
    authority: input.authority,
    body: { user: input.providerUserId },
  });
  const failure = await normalizeDirectoryFailure({
    result,
    authority: input.authority,
    quarantineSink: input.quarantineSink,
  });
  if (failure) return failure;
  if (result.kind !== "response" || !isRecord(result.body.user)) {
    return { kind: "unavailable", reason: "outcome_unknown" };
  }
  const providerUserId = nonEmptyString(result.body.user.id);
  if (providerUserId !== input.providerUserId) {
    return { kind: "unavailable", reason: "identity_conflict" };
  }
  const profile: SlackJsonObject = isRecord(result.body.user.profile)
    ? result.body.user.profile
    : {};
  const avatarUrl = nonEmptyString(profile.image_72)
    ?? nonEmptyString(profile.image_48);
  return {
    kind: "fact",
    fact: {
      providerUserId,
      providerAuthorityId: input.authority.providerAuthorityId,
      displayNameSnapshot: nonEmptyString(profile.display_name)
        ?? nonEmptyString(profile.real_name),
      handleSnapshot: nonEmptyString(result.body.user.name),
      avatarUrlDigest: avatarUrl ? sha256(avatarUrl) : null,
      isBot: result.body.user.is_bot === true,
      isDeleted: result.body.user.deleted === true,
      observedAt: input.now,
    },
  };
}

export async function lookupSlackProviderConversation(input: {
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  credentialHandle: SlackBridgeCredentialHandle;
  authority: SlackProviderAuthorityFence;
  providerConversationId: string;
  now: Date;
}): Promise<SlackProviderDirectoryOutcome<SlackProviderConversationFact>> {
  if (
    !validDate(input.now)
    || !input.providerConversationId.trim()
    || input.providerConversationId
      !== input.authority.providerConversationId
    || !credentialMatchesAuthority(
      input.credentialHandle,
      input.authority,
      input.now,
    )
  ) {
    return { kind: "unavailable", reason: "deterministic" };
  }
  const result = await input.transport.call({
    method: "conversations.info",
    credentialHandle: input.credentialHandle,
    authority: input.authority,
    body: { channel: input.providerConversationId },
  });
  const failure = await normalizeDirectoryFailure({
    result,
    authority: input.authority,
    quarantineSink: input.quarantineSink,
  });
  if (failure) return failure;
  if (result.kind !== "response" || !isRecord(result.body.channel)) {
    return { kind: "unavailable", reason: "outcome_unknown" };
  }
  const providerConversationId = nonEmptyString(result.body.channel.id);
  if (providerConversationId !== input.providerConversationId) {
    return { kind: "unavailable", reason: "identity_conflict" };
  }
  return {
    kind: "fact",
    fact: {
      providerConversationId,
      providerAuthorityId: input.authority.providerAuthorityId,
      nameSnapshot: nonEmptyString(result.body.channel.name),
      privacyClass: result.body.channel.is_private === true
        ? "private"
        : "public",
      isArchived: result.body.channel.is_archived === true,
      isMemberObserved: result.body.channel.is_member === true,
      observedAt: input.now,
    },
  };
}

/**
 * Reads the complete current Slack conversation audience through the Web API.
 * Pagination is closed and fail-closed: a repeated cursor, malformed member,
 * partial page, or authority drift returns unavailable rather than a partial
 * audience that could be misclassified as a mismatch.
 */
export async function listSlackProviderConversationMembers(input: {
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  credentialHandleForPage(input: {
    page: number;
    cursor: string | null;
  }): Promise<SlackBridgeCredentialHandle | null>;
  authority: SlackProviderAuthorityFence;
  providerConversationId: string;
  now: Date;
}): Promise<SlackProviderDirectoryOutcome<SlackProviderConversationMembersFact>> {
  if (
    !validDate(input.now)
    || !input.providerConversationId.trim()
    || input.providerConversationId !== input.authority.providerConversationId
  ) {
    return { kind: "unavailable", reason: "deterministic" };
  }

  const providerMemberIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    let credentialHandle: SlackBridgeCredentialHandle | null = null;
    try {
      credentialHandle = await input.credentialHandleForPage({ page, cursor });
    } catch {
      credentialHandle = null;
    }
    if (
      !credentialHandle
      || !credentialMatchesAuthority(credentialHandle, input.authority, input.now)
    ) {
      return { kind: "unavailable", reason: "credential_unavailable" };
    }
    const body: SlackJsonObject = {
      channel: input.providerConversationId,
      limit: 200,
    };
    if (cursor) body.cursor = cursor;
    let result: SlackWebApiTransportResult;
    try {
      result = await input.transport.call({
        method: "conversations.members",
        credentialHandle,
        authority: input.authority,
        body,
      });
    } catch {
      return { kind: "unavailable", reason: "outcome_unknown" };
    }
    const failure = await normalizeDirectoryFailure({
      result,
      authority: input.authority,
      quarantineSink: input.quarantineSink,
    });
    if (failure) return failure;
    if (result.kind !== "response" || !Array.isArray(result.body.members)) {
      return { kind: "unavailable", reason: "outcome_unknown" };
    }
    for (const member of result.body.members) {
      const providerMemberId = nonEmptyString(member);
      if (!providerMemberId || providerMemberId.length > 160) {
        return { kind: "unavailable", reason: "outcome_unknown" };
      }
      providerMemberIds.add(providerMemberId);
    }

    const metadata = isRecord(result.body.response_metadata)
      ? result.body.response_metadata
      : null;
    if (!metadata || typeof metadata.next_cursor !== "string") {
      return { kind: "unavailable", reason: "outcome_unknown" };
    }
    const nextCursor = nonEmptyString(metadata.next_cursor);
    if (!nextCursor) {
      return {
        kind: "fact",
        fact: {
          providerConversationId: input.providerConversationId,
          providerAuthorityId: input.authority.providerAuthorityId,
          providerMemberIds: [...providerMemberIds].sort(),
          observedAt: input.now,
        },
      };
    }
    if (seenCursors.has(nextCursor)) {
      return { kind: "unavailable", reason: "outcome_unknown" };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { kind: "unavailable", reason: "outcome_unknown" };
}
