import { createHash, randomUUID } from "node:crypto";
import {
  clearClockTimeout,
  currentDate,
  setClockTimeout,
} from "@botiverse/raft-shared";
import type { SealedExternalCredential } from "./externalAppControlPlaneService.js";
import {
  ExternalAppIngressError,
  verifyAndAdmitSlackIngress,
  type ExternalIngressPayloadSealer,
  type ExternalIngressRuntimeResolver,
  type ExternalIngressSecretResolver,
  type SlackIngressAdmission,
} from "./externalAppIngressService.js";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService.js";

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
}

export type SlackBridgeProviderDispatchOutcome =
  | { kind: "accepted"; providerMessageId: string; providerThreadId?: string | null; reconciled?: boolean }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; baseDelayMs: number }
  | { kind: "deterministic_failure" }
  | { kind: "outcome_unknown" };

export type SlackBridgeProviderPreparation =
  | { ready: false; reason: string }
  | { ready: true; dispatch(): Promise<SlackBridgeProviderDispatchOutcome> };

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

export type SlackWebApiMethod =
  | "chat.postMessage"
  | "conversations.history"
  | "conversations.replies"
  | "reactions.add"
  | "reactions.remove"
  | "reactions.get"
  | "files.info"
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
  | { active: false; reason: "missing" | "stale" | "mismatch" }
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

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left.map((value) => value.trim()).filter(Boolean))].sort();
  const b = [...new Set(right.map((value) => value.trim()).filter(Boolean))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authorityFromDispatch(
  input: SlackBridgeProviderDispatchInput,
): SlackProviderAuthorityFence {
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
    : { kind: "deterministic_failure" };
}

export type SlackOutboundReconciliationResult =
  | {
    kind: "found";
    providerMessageId: string;
    providerThreadId: string | null;
  }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: string };

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
  authority: SlackProviderAuthorityFence;
  reconciliationMarker: string;
  providerThreadId?: string | null;
  now: Date;
  maxPages?: number;
}): Promise<SlackOutboundReconciliationResult> {
  if (
    !validDate(input.now)
    || !/^[A-Za-z0-9_-]{43}$/.test(input.reconciliationMarker)
  ) return { kind: "unavailable", reason: "reconciliation_preflight_invalid" };
  const threadId = input.providerThreadId?.trim() || null;
  if (threadId && !/^[0-9]{1,20}\.[0-9]{1,20}$/.test(threadId)) {
    return { kind: "unavailable", reason: "reconciliation_thread_invalid" };
  }
  const maxPages = input.maxPages ?? 10;
  if (!positiveSafeInteger(maxPages) || maxPages > 100) {
    return { kind: "unavailable", reason: "reconciliation_page_limit_invalid" };
  }
  let cursor: string | null = null;
  let match: { providerMessageId: string; providerThreadId: string | null } | null = null;
  let sawBridgeBotWithoutMetadata = false;
  for (let page = 0; page < maxPages; page += 1) {
    const body: SlackJsonObject = threadId
      ? {
        channel: input.authority.providerConversationId,
        ts: threadId,
        limit: 100,
        include_all_metadata: true,
        ...(cursor ? { cursor } : {}),
      }
      : {
        channel: input.authority.providerConversationId,
        limit: 100,
        include_all_metadata: true,
        ...(cursor ? { cursor } : {}),
      };
    const credentialHandle = await input.leaseCredential();
    if (!credentialHandle || !credentialMatchesAuthority(credentialHandle, input.authority, input.now)) {
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
    if (result.status === 429) return { kind: "unavailable", reason: "reconciliation_rate_limited" };
    if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
      return {
        kind: "unavailable",
        reason: nonEmptyString(result.body.error) ?? "reconciliation_provider_error",
      };
    }
    const messages = Array.isArray(result.body.messages)
      ? result.body.messages.filter(isRecord)
      : null;
    if (!messages) return { kind: "unavailable", reason: "reconciliation_messages_invalid" };
    for (const message of messages) {
      const channel = nonEmptyString(message.channel);
      if (channel && channel !== input.authority.providerConversationId) continue;
      // Slack keeps the originating app_id on bot-authored history entries even
      // when message metadata is omitted/stripped. Treat such an entry as a
      // positive control: a missing marker is then ambiguous, never proof of
      // absence. Human messages (and unrelated apps) do not affect not_found.
      const authoredByBridgeApp = nonEmptyString(message.app_id) === input.authority.providerAppId;
      // files.completeUploadExternal creates a file-share message in the same
      // channel but has no metadata parameter by contract; it is not evidence
      // that metadata on chat.postMessage entries is invisible.
      if (authoredByBridgeApp && !slackMessageIsFileShare(message)) {
        if (!slackMessageReconciliationMarker(message)) sawBridgeBotWithoutMetadata = true;
      }
      if (slackMessageReconciliationMarker(message) !== input.reconciliationMarker) continue;
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
      if (match) return { kind: "unavailable", reason: "reconciliation_marker_conflict" };
      match = found;
    }
    const responseMetadata = isRecord(result.body.response_metadata)
      ? result.body.response_metadata
      : null;
    const nextCursor = responseMetadata ? nonEmptyString(responseMetadata.next_cursor) : null;
    if (!nextCursor) {
      if (match) return { kind: "found", ...match };
      if (sawBridgeBotWithoutMetadata) {
        return { kind: "unavailable", reason: "reconciliation_bridge_metadata_missing" };
      }
      return { kind: "not_found" };
    }
    cursor = nextCursor;
  }
  return { kind: "unavailable", reason: "reconciliation_page_limit_exceeded" };
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

function renderSlackBridgeText(snapshot: SlackBridgeRenderSnapshot): string | null {
  let text = snapshot.sanitizedText;
  const placeholders: Array<{ token: string; providerUserId: string }> = [];
  const mentions = [...snapshot.externalMentions]
    .sort((left, right) => right.handleSnapshot.length - left.handleSnapshot.length);
  for (const [index, mention] of mentions.entries()) {
    if (
      !/^[UW][A-Z0-9]{2,}$/.test(mention.externalActorId)
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
  text = escapeSlackMrkdwn(text);
  for (const placeholder of placeholders) {
    text = text.replaceAll(placeholder.token, `<@${placeholder.providerUserId}>`);
  }
  return text;
}

function renderSlackBridgeUsername(authorName: string): string | null {
  const suffix = " from Raft";
  const normalized = authorName.trim();
  const boundedName = Array.from(normalized).slice(0, 80 - suffix.length).join("").trimEnd();
  const username = `${boundedName}${suffix}`;
  if (!boundedName || /[\u0000-\u001f\u007f]/u.test(username)) return null;
  return username;
}

function buildPostMessageRequest(input: {
  dispatch: SlackBridgeProviderDispatchInput;
  providerThreadId: string | null;
}): SlackWebApiRequest | null {
  const authority = authorityFromDispatch(input.dispatch);
  const snapshot = input.dispatch.renderSnapshot;
  const text = renderSlackBridgeText(snapshot);
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
    metadata: {
      event_type: "raft_message",
      event_payload: {
        delivery_id: input.dispatch.deliveryId,
        reconciliation_marker: input.dispatch.reconciliationMarker,
        source_message_id: snapshot.sourceMessageId,
        source_permalink: snapshot.sourcePermalink,
        source_sender_type: snapshot.senderType,
        connection_epoch: authority.connectionEpoch,
        binding_epoch: authority.bindingEpoch,
      },
    },
  };
  if (snapshot.authorPolicy.avatar) body.icon_url = snapshot.authorPolicy.avatar.publicUrl;
  else body.icon_emoji = snapshot.senderType === "agent" ? ":robot_face:" : ":bust_in_silhouette:";
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
        return { ready: false, reason: `provider_thread_receipt_${thread.reason}` };
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
        dispatched ??= dependencies.transport.call(request)
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
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_SLACK_AUTH_TEST_ENDPOINT = "https://slack.com/api/auth.test";

export type SlackOAuthExchangeOutcome =
  | Extract<SlackOAuthExchangeTransportResult, { kind: "authorized" }>
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; retryAfterMs: number }
  | {
      kind: "deterministic_failure";
      reason: "provider_rejected" | "scope_mismatch";
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
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_SLACK_OAUTH_TIMEOUT_MS;
  const maxResponseBytes = dependencies.maxResponseBytes
    ?? DEFAULT_SLACK_OAUTH_MAX_RESPONSE_BYTES;
  if (
    !validSlackOAuthEndpoint(endpoint)
    || !validSlackOAuthEndpoint(authTestEndpoint)
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
      : { kind: "deterministic_failure", reason: "provider_rejected" };
  }
  if (input.result.providerAppId !== input.request.expectedProviderAppId) {
    return { kind: "identity_conflict", reason: "app" };
  }
  if (input.result.providerEnterpriseId !== null) {
    return { kind: "identity_conflict", reason: "enterprise" };
  }
  if (!input.result.providerTeamId.trim()) {
    return { kind: "identity_conflict", reason: "team" };
  }
  if (!exactStrings(
    input.result.installedScopes,
    input.request.expectedScopes,
  )) {
    return { kind: "deterministic_failure", reason: "scope_mismatch" };
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
