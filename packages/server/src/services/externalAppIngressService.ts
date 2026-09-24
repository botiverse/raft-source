import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { currentDate, SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppIngressEndpoints,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalChannelBindings,
  externalIngressDiscardReceipts,
  externalInboundEvents,
} from "../db/schema.js";
import {
  resolveExternalBindingAuthority,
  type ExternalBindingAuthorityDecision,
} from "./externalAppControlPlaneService.js";
import { reconcileSlackChannelLifecycle } from "./slackBindingLifecycleService.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";
import { slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority.js";

const SLACK_SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;
const EXTERNAL_EVENT_PAYLOAD_TTL_MS = 24 * 60 * 60_000;
const PAYLOAD_AAD_PURPOSE = "external-inbound-normalized-event" as const;
const NORMALIZED_PAYLOAD_SCHEMA = "external-inbound-normalized-event.v2" as const;
const NORMALIZED_REACTION_PAYLOAD_SCHEMA = "external-inbound-normalized-reaction.v1" as const;
const SLACK_ATTACHMENT_ONLY_MESSAGE = "[Attachment]";
const MAX_SLACK_FILES_PER_MESSAGE = 10;

type Environment = "test" | "production";
type ActiveBindingAuthority = Extract<ExternalBindingAuthorityDecision, { active: true }>["fact"];
type EventStatus = "queued" | "quarantined" | "paused" | "revoked" | "unsupported" | "committed" | "duplicate" | "echo" | "dead";
type IntentionalDiscardReason =
  | "unsupported_event"
  | "provider_tokens_unrelated"
  | "provider_loop_suppressed"
  | "unsupported_message_subtype"
  | "capability_disabled";

export type ExternalAppIngressErrorCode =
  | "external_ingress_endpoint_unavailable"
  | "external_ingress_signature_invalid"
  | "external_ingress_payload_invalid"
  | "external_ingress_authority_unavailable"
  | "external_ingress_seal_failed";

export class ExternalAppIngressError extends Error {
  constructor(message: string, readonly code: ExternalAppIngressErrorCode) {
    super(message);
    this.name = "ExternalAppIngressError";
  }
}

export interface ExternalIngressSecretResolver {
  resolveSigningSecret(input: {
    registrationId: string;
    environment: Environment;
    encryptedSecretRef: string;
    envelopeKeyId: string;
    aadVersion: number;
    secretRevision: number;
  }): Promise<string>;
}

export type ExternalInboundPayloadAad = {
  purpose: typeof PAYLOAD_AAD_PURPOSE;
  aadVersion: 1;
  schemaVersion: 1 | 2 | 3;
  provider: "slack";
  environment: Environment;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  providerEventId: string;
  bindingId: string;
  bindingEpoch: number;
  connectionEpoch: number;
  runtimeRevision: string;
  raftChannelId: string;
  privacyClass: "public" | "private";
};

export interface ExternalIngressPayloadSealer {
  sealNormalizedPayload(input: {
    plaintext: string;
    aad: ExternalInboundPayloadAad;
  }): Promise<{
    encryptedPayload: string;
    envelopeKeyId: string;
    aadVersion: number;
  }>;
}

export interface ExternalIngressRuntimeResolver {
  resolveCurrentRuntime(input: {
    authority: ActiveBindingAuthority;
    projectionId: string;
    actorProjectionRevision: number;
    externalActorId: string;
    memberRevision: number;
    contextRevision: number;
    requiredCapabilities?: readonly ("attachment_transfer" | "reaction_sync")[];
    now: Date;
  }): Promise<{ runtimeRevision: string } | null>;
}

export type SlackIngressAdmission =
  | {
      kind: "url_verification";
      challenge: string;
      endpointRevision: number;
      signingSecretRevision: number;
    }
  | {
      kind: "event";
      eventInboxId: string;
      duplicate: boolean;
      status: EventStatus;
      reason: string | null;
      authority: null | {
        provider: "slack";
        environment: Environment;
        registrationId: string;
        installId: string;
        bindingId: string;
        serverId: string;
        serverGrantId: string;
        grantEpoch: number;
        connectionEpoch: number;
        scopeRevision: number;
        bindingEpoch: number;
        privacyClass: "public" | "private";
        channelId: string;
        providerAuthorityId: string;
        providerConversationId: string;
        installGrantReceiptRevision: number;
        audienceRevision: number | null;
        signingSecretRevision: number;
        endpointRevision: number;
      };
    };

type SlackEnvelope = {
  type?: unknown;
  api_app_id?: unknown;
  team_id?: unknown;
  enterprise_id?: unknown;
  event_id?: unknown;
  challenge?: unknown;
  event?: {
    type?: unknown;
    subtype?: unknown;
    channel?: unknown;
    user?: unknown;
    text?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    bot_id?: unknown;
    app_id?: unknown;
    files?: unknown;
    reaction?: unknown;
    event_ts?: unknown;
    item?: {
      type?: unknown;
      channel?: unknown;
      ts?: unknown;
    };
    tokens?: {
      bot?: unknown;
      oauth?: unknown;
    };
  };
};

function parseSlackProviderFileIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SLACK_FILES_PER_MESSAGE) {
    return null;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = nonEmpty((raw as { id?: unknown }).id, 320);
    if (!id || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function slackEventClock(value: unknown): { sequence: number; occurredAt: Date } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,10})\.(\d{1,6})$/u.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]);
  const micros = Number(match[2]!.padEnd(6, "0"));
  const sequence = seconds * 1_000_000 + micros;
  const occurredAt = new Date(seconds * 1_000 + Math.floor(micros / 1_000));
  return Number.isSafeInteger(sequence) && sequence > 0 && Number.isFinite(occurredAt.getTime())
    ? { sequence, occurredAt }
    : null;
}

function nonEmpty(value: unknown, max = 320): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value
    : null;
}

function optionalHeader(value: string | null | undefined, max: number, label: string): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ExternalAppIngressError(`Slack ${label} header is invalid`, "external_ingress_payload_invalid");
  }
  return normalized;
}

function validNow(now: Date): boolean {
  return Number.isFinite(now.getTime());
}

function parseTimestamp(value: string, now: Date): number {
  if (!/^[0-9]{1,12}$/.test(value)) {
    throw new ExternalAppIngressError("Slack request timestamp is invalid", "external_ingress_signature_invalid");
  }
  const timestamp = Number(value);
  if (
    !Number.isSafeInteger(timestamp)
    || Math.abs(Math.floor(now.getTime() / 1_000) - timestamp) > SLACK_SIGNATURE_MAX_SKEW_SECONDS
  ) {
    throw new ExternalAppIngressError("Slack request timestamp is outside the accepted window", "external_ingress_signature_invalid");
  }
  return timestamp;
}

function verifySlackSignature(input: {
  rawBody: Buffer;
  timestamp: number;
  signature: string;
  signingSecret: string;
}): void {
  if (!/^v0=[a-f0-9]{64}$/.test(input.signature) || !input.signingSecret) {
    throw new ExternalAppIngressError("Slack request signature is invalid", "external_ingress_signature_invalid");
  }
  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${input.timestamp}:`, "utf8")
    .update(input.rawBody)
    .digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "ascii");
  const actualBytes = Buffer.from(input.signature, "ascii");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new ExternalAppIngressError("Slack request signature is invalid", "external_ingress_signature_invalid");
  }
}

function parseEnvelope(rawBody: Buffer): SlackEnvelope {
  if (rawBody.byteLength === 0 || rawBody.byteLength > 1024 * 1024) {
    throw new ExternalAppIngressError("Slack request body is invalid", "external_ingress_payload_invalid");
  }
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as SlackEnvelope;
  } catch {
    throw new ExternalAppIngressError("Slack request body is invalid", "external_ingress_payload_invalid");
  }
}

async function loadEndpoint(requestUrl: string, environment: Environment) {
  return getDb().transaction(async (tx) => {
    const [endpoint] = await tx.select().from(externalAppIngressEndpoints).where(and(
      eq(externalAppIngressEndpoints.environment, environment),
      eq(externalAppIngressEndpoints.exactRequestUrl, requestUrl),
      eq(externalAppIngressEndpoints.state, "active"),
    )).limit(1);
    if (!endpoint) return null;
    const [registration] = await tx.select().from(externalAppRegistrations).where(and(
      eq(externalAppRegistrations.id, endpoint.registrationId),
      eq(externalAppRegistrations.environment, environment),
      eq(externalAppRegistrations.state, "active"),
    )).limit(1);
    const [secret] = await tx.select().from(externalAppRegistrationSecrets).where(and(
      eq(externalAppRegistrationSecrets.registrationId, endpoint.registrationId),
      eq(externalAppRegistrationSecrets.purpose, "signing_secret"),
      eq(externalAppRegistrationSecrets.secretRevision, endpoint.signingSecretRevision),
    )).limit(1);
    if (!registration || !secret || secret.revokedAt) return null;
    return { endpoint, registration, secret };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function endpointStillCurrent(input: {
  executor: DatabaseExecutor;
  endpointId: string;
  registrationId: string;
  provider: "slack";
  providerAppId: string;
  environment: Environment;
  requestUrl: string;
  endpointRevision: number;
  signingSecretRevision: number;
}): Promise<boolean> {
  const [registration] = await input.executor.select().from(externalAppRegistrations).where(and(
    eq(externalAppRegistrations.id, input.registrationId),
    eq(externalAppRegistrations.provider, input.provider),
    eq(externalAppRegistrations.providerAppId, input.providerAppId),
    eq(externalAppRegistrations.environment, input.environment),
    eq(externalAppRegistrations.state, "active"),
  )).for("update").limit(1);
  const [endpoint] = await input.executor.select().from(externalAppIngressEndpoints).where(and(
    eq(externalAppIngressEndpoints.id, input.endpointId),
    eq(externalAppIngressEndpoints.registrationId, input.registrationId),
    eq(externalAppIngressEndpoints.environment, input.environment),
    eq(externalAppIngressEndpoints.exactRequestUrl, input.requestUrl),
    eq(externalAppIngressEndpoints.state, "active"),
    eq(externalAppIngressEndpoints.endpointRevision, input.endpointRevision),
    eq(externalAppIngressEndpoints.signingSecretRevision, input.signingSecretRevision),
  )).for("update").limit(1);
  const [secret] = await input.executor.select().from(externalAppRegistrationSecrets).where(and(
    eq(externalAppRegistrationSecrets.registrationId, input.registrationId),
    eq(externalAppRegistrationSecrets.purpose, "signing_secret"),
    eq(externalAppRegistrationSecrets.secretRevision, input.signingSecretRevision),
  )).for("update").limit(1);
  return Boolean(registration && endpoint && secret && !secret.revokedAt);
}

async function recordIntentionalDiscard(input: {
  endpointId: string;
  registrationId: string;
  providerAppId: string;
  environment: Environment;
  requestUrl: string;
  endpointRevision: number;
  signingSecretRevision: number;
  providerAuthorityId: string;
  providerConversationId: string | null;
  providerEventId: string;
  outcomeReason: IntentionalDiscardReason;
  slackRetryNumHeader?: string | null;
  slackRetryReasonHeader?: string | null;
  rawBody: Buffer;
  now: Date;
}): Promise<string> {
  const slackRetryNum = optionalHeader(input.slackRetryNumHeader, 32, "retry number");
  const slackRetryReason = optionalHeader(input.slackRetryReasonHeader, 160, "retry reason");
  const receiptId = await getDb().transaction(async (tx) => {
    if (!await endpointStillCurrent({
      executor: tx,
      endpointId: input.endpointId,
      registrationId: input.registrationId,
      provider: "slack",
      providerAppId: input.providerAppId,
      environment: input.environment,
      requestUrl: input.requestUrl,
      endpointRevision: input.endpointRevision,
      signingSecretRevision: input.signingSecretRevision,
    })) return null;
    const [created] = await tx.insert(externalIngressDiscardReceipts).values({
      provider: "slack",
      environment: input.environment,
      appRegistrationId: input.registrationId,
      endpointId: input.endpointId,
      endpointRevision: input.endpointRevision,
      signingSecretRevision: input.signingSecretRevision,
      providerAuthorityId: input.providerAuthorityId,
      providerConversationId: input.providerConversationId,
      providerEventId: input.providerEventId,
      outcomeReason: input.outcomeReason,
      slackRetryNum,
      slackRetryReason,
      payloadDigest: sha256(input.rawBody),
      receivedAt: input.now,
    }).returning({ id: externalIngressDiscardReceipts.id });
    return created?.id ?? null;
  });
  if (!receiptId) {
    throw new ExternalAppIngressError("External ingress authority changed", "external_ingress_endpoint_unavailable");
  }
  return receiptId;
}

function admissionAuthority(input: {
  authority: ActiveBindingAuthority;
  environment: Environment;
  signingSecretRevision: number;
  endpointRevision: number;
}): Extract<SlackIngressAdmission, { kind: "event" }>["authority"] {
  const { authority } = input;
  return {
    provider: "slack",
    environment: input.environment,
    registrationId: authority.registrationId,
    installId: authority.installId,
    bindingId: authority.bindingId,
    serverId: authority.serverId,
    serverGrantId: authority.serverGrantId,
    grantEpoch: authority.grantEpoch,
    connectionEpoch: authority.connectionEpoch,
    scopeRevision: authority.scopeRevision,
    bindingEpoch: authority.bindingEpoch,
    privacyClass: authority.privacyClass,
    channelId: authority.channelId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    installGrantReceiptRevision: authority.installGrantReceiptRevision,
    audienceRevision: authority.audienceRevision,
    signingSecretRevision: input.signingSecretRevision,
    endpointRevision: input.endpointRevision,
  };
}

async function revokeInstallForLifecycleEvent(input: {
  endpointId: string;
  registrationId: string;
  provider: "slack";
  providerAppId: string;
  environment: Environment;
  requestUrl: string;
  endpointRevision: number;
  signingSecretRevision: number;
  providerAuthorityId: string;
  reason: "provider_app_uninstalled" | "provider_tokens_revoked";
  revokedBotUserIds?: ReadonlySet<string>;
  now: Date;
}): Promise<{ authorityCurrent: boolean; changed: boolean }> {
  return getDb().transaction(async (tx) => {
    if (!await endpointStillCurrent({
      executor: tx,
      endpointId: input.endpointId,
      registrationId: input.registrationId,
      provider: input.provider,
      providerAppId: input.providerAppId,
      environment: input.environment,
      requestUrl: input.requestUrl,
      endpointRevision: input.endpointRevision,
      signingSecretRevision: input.signingSecretRevision,
    })) {
      return { authorityCurrent: false, changed: false };
    }
    let changed = false;
    const installs = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, input.registrationId),
      eq(externalAppInstalls.providerAuthorityId, input.providerAuthorityId),
    )).for("update");
    for (const install of installs) {
      if (install.state !== "active") continue;
      if (
        input.reason === "provider_tokens_revoked"
        && (!install.botUserId || !input.revokedBotUserIds?.has(install.botUserId))
      ) continue;
      const nextConnectionEpoch = install.connectionEpoch + 1;
      const bindings = await tx.select().from(externalChannelBindings).where(and(
        eq(externalChannelBindings.installId, install.id),
        eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
      )).for("update");
      await tx.update(externalAppInstalls).set({
        state: input.reason === "provider_app_uninstalled" ? "revoked" : "reauth_required",
        stateReason: input.reason,
        connectionEpoch: nextConnectionEpoch,
        disconnectedAt: input.now,
        updatedAt: input.now,
      }).where(eq(externalAppInstalls.id, install.id));
      await tx.update(externalAppCredentials).set({
        state: "revoked",
        leaseOwner: null,
        leaseExpiresAt: null,
        revokedAt: input.now,
        updatedAt: input.now,
      }).where(eq(externalAppCredentials.installId, install.id));
      for (const binding of bindings) {
        await tx.update(externalChannelBindings).set({
          state: "revoked",
          stateReason: input.reason,
          connectionEpoch: nextConnectionEpoch,
          bindingEpoch: binding.bindingEpoch + 1,
          updatedAt: input.now,
        }).where(and(
          eq(externalChannelBindings.id, binding.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
          eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
        ));
      }
      changed = true;
    }
    return { authorityCurrent: true, changed };
  });
}

export async function verifyAndAdmitSlackIngress(input: {
  requestUrl: string;
  environment: Environment;
  rawBody: Buffer;
  timestampHeader: string;
  signatureHeader: string;
  slackRetryNumHeader?: string | null;
  slackRetryReasonHeader?: string | null;
  secretResolver: ExternalIngressSecretResolver;
  payloadSealer: ExternalIngressPayloadSealer;
  runtimeResolver?: ExternalIngressRuntimeResolver;
  now?: Date;
}): Promise<SlackIngressAdmission> {
  const now = input.now ?? currentDate();
  if (!validNow(now) || !input.requestUrl.startsWith("https://")) {
    throw new ExternalAppIngressError("External ingress endpoint is unavailable", "external_ingress_endpoint_unavailable");
  }
  const loaded = await loadEndpoint(input.requestUrl, input.environment);
  if (!loaded) {
    throw new ExternalAppIngressError("External ingress endpoint is unavailable", "external_ingress_endpoint_unavailable");
  }
  const timestamp = parseTimestamp(input.timestampHeader, now);
  const signingSecret = await input.secretResolver.resolveSigningSecret({
    registrationId: loaded.registration.id,
    environment: input.environment,
    encryptedSecretRef: loaded.secret.encryptedSecretRef,
    envelopeKeyId: loaded.secret.envelopeKeyId,
    aadVersion: loaded.secret.aadVersion,
    secretRevision: loaded.secret.secretRevision,
  });
  verifySlackSignature({ rawBody: input.rawBody, timestamp, signature: input.signatureHeader, signingSecret });
  const envelope = parseEnvelope(input.rawBody);
  const providerAppId = nonEmpty(envelope.api_app_id);

  if (envelope.type === "url_verification") {
    // Slack's URL-verification payload does not promise api_app_id. The exact
    // endpoint, active registration, signing-secret revision, and verified
    // signature already pin the app authority for this handshake. If Slack
    // does supply api_app_id, it must still match that pinned registration.
    if (envelope.api_app_id !== undefined && providerAppId !== loaded.registration.providerAppId) {
      throw new ExternalAppIngressError("Slack application identity is invalid", "external_ingress_authority_unavailable");
    }
    const challenge = nonEmpty(envelope.challenge, 4_096);
    if (!challenge) {
      throw new ExternalAppIngressError("Slack verification challenge is invalid", "external_ingress_payload_invalid");
    }
    const current = await getDb().transaction((tx) => endpointStillCurrent({
      executor: tx,
      endpointId: loaded.endpoint.id,
      registrationId: loaded.registration.id,
      provider: loaded.registration.provider,
      providerAppId: loaded.registration.providerAppId,
      environment: input.environment,
      requestUrl: input.requestUrl,
      endpointRevision: loaded.endpoint.endpointRevision,
      signingSecretRevision: loaded.endpoint.signingSecretRevision,
    }));
    if (!current) {
      throw new ExternalAppIngressError("External ingress authority changed", "external_ingress_endpoint_unavailable");
    }
    return {
      kind: "url_verification",
      challenge,
      endpointRevision: loaded.endpoint.endpointRevision,
      signingSecretRevision: loaded.endpoint.signingSecretRevision,
    };
  }

  if (providerAppId !== loaded.registration.providerAppId) {
    throw new ExternalAppIngressError("Slack application identity is invalid", "external_ingress_authority_unavailable");
  }

  const providerEventId = nonEmpty(envelope.event_id);
  const providerAuthorityId = nonEmpty(envelope.team_id) ?? nonEmpty(envelope.enterprise_id);
  if (!providerEventId || !providerAuthorityId) {
    throw new ExternalAppIngressError("Slack event identity is invalid", "external_ingress_payload_invalid");
  }
  const lifecycleType = envelope.type === "event_callback"
    && (envelope.event?.type === "app_uninstalled" || envelope.event?.type === "tokens_revoked")
    ? envelope.event.type
    : null;
  if (lifecycleType) {
    const reason = lifecycleType === "app_uninstalled" ? "provider_app_uninstalled" : "provider_tokens_revoked";
    const revokedBotUserIds = lifecycleType === "tokens_revoked" && Array.isArray(envelope.event?.tokens?.bot)
      ? new Set(envelope.event.tokens.bot.map((value: unknown) => nonEmpty(value, 160)).filter((value): value is string => Boolean(value)))
      : undefined;
    const lifecycleResult = await revokeInstallForLifecycleEvent({
      endpointId: loaded.endpoint.id,
      registrationId: loaded.registration.id,
      provider: loaded.registration.provider,
      providerAppId: loaded.registration.providerAppId,
      environment: input.environment,
      requestUrl: input.requestUrl,
      endpointRevision: loaded.endpoint.endpointRevision,
      signingSecretRevision: loaded.endpoint.signingSecretRevision,
      providerAuthorityId,
      reason,
      revokedBotUserIds,
      now,
    });
    if (!lifecycleResult.authorityCurrent) {
      throw new ExternalAppIngressError("External ingress authority changed", "external_ingress_endpoint_unavailable");
    }
    if (lifecycleType === "tokens_revoked" && !lifecycleResult.changed) {
      const discardReceiptId = await recordIntentionalDiscard({
        endpointId: loaded.endpoint.id,
        registrationId: loaded.registration.id,
        providerAppId: loaded.registration.providerAppId,
        environment: input.environment,
        requestUrl: input.requestUrl,
        endpointRevision: loaded.endpoint.endpointRevision,
        signingSecretRevision: loaded.endpoint.signingSecretRevision,
        providerAuthorityId,
        providerConversationId: null,
        providerEventId,
        outcomeReason: "provider_tokens_unrelated",
        slackRetryNumHeader: input.slackRetryNumHeader,
        slackRetryReasonHeader: input.slackRetryReasonHeader,
        rawBody: input.rawBody,
        now,
      });
      return {
        kind: "event",
        eventInboxId: discardReceiptId,
        duplicate: false,
        status: "unsupported",
        reason: "provider_tokens_unrelated",
        authority: null,
      };
    }
    return {
      kind: "event",
      eventInboxId: providerEventId,
      duplicate: false,
      status: "revoked",
      reason,
      authority: null,
    };
  }
  const channelLifecycleType = envelope.type === "event_callback"
    && (
      envelope.event?.type === "channel_archive"
      || envelope.event?.type === "channel_deleted"
      || envelope.event?.type === "group_archive"
      || envelope.event?.type === "group_deleted"
    )
    ? envelope.event.type
    : null;
  if (channelLifecycleType) {
    const providerConversationId = nonEmpty(envelope.event?.channel, 160);
    if (!providerConversationId) {
      throw new ExternalAppIngressError("Slack channel lifecycle event is invalid", "external_ingress_payload_invalid");
    }
    const [install] = await getDb().select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, loaded.registration.id),
      eq(externalAppInstalls.providerAuthorityId, providerAuthorityId),
      eq(externalAppInstalls.state, "active"),
    )).limit(1);
    if (!install) {
      throw new ExternalAppIngressError("Slack install authority is unavailable", "external_ingress_authority_unavailable");
    }
    const [binding] = await getDb().select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.installId, install.id),
      eq(externalChannelBindings.providerConversationId, providerConversationId),
    )).limit(1);
    if (!binding) {
      throw new ExternalAppIngressError("Slack binding authority is unavailable", "external_ingress_authority_unavailable");
    }
    const expectsPrivateBinding = channelLifecycleType === "group_archive"
      || channelLifecycleType === "group_deleted";
    if ((binding.privacyClass === "private") !== expectsPrivateBinding) {
      throw new ExternalAppIngressError("Slack channel lifecycle authority is mismatched", "external_ingress_authority_unavailable");
    }
    const lifecycle = await reconcileSlackChannelLifecycle({
      serverId: binding.serverId,
      registrationId: loaded.registration.id,
      installId: install.id,
      bindingId: binding.id,
      providerAuthorityId,
      providerConversationId,
      expectedConnectionEpoch: install.connectionEpoch,
      expectedBindingEpoch: binding.bindingEpoch,
      event: channelLifecycleType === "channel_archive" || channelLifecycleType === "group_archive"
        ? "channel_archived"
        : "channel_deleted",
      now,
    });
    if (lifecycle.kind === "fence_mismatch") {
      throw new ExternalAppIngressError("Slack binding authority changed", "external_ingress_authority_unavailable");
    }
    return {
      kind: "event",
      eventInboxId: providerEventId,
      duplicate: lifecycle.kind === "unchanged",
      status: "paused",
      reason: channelLifecycleType === "channel_archive" || channelLifecycleType === "group_archive"
        ? "provider_channel_archived"
        : "provider_channel_deleted",
      authority: null,
    };
  }
  const reactionType = envelope.type === "event_callback"
    && (envelope.event?.type === "reaction_added" || envelope.event?.type === "reaction_removed")
    ? envelope.event.type
    : null;
  if (reactionType) {
    const event = envelope.event!;
    const providerConversationId = nonEmpty(event.item?.channel, 160);
    const providerMessageId = nonEmpty(event.item?.ts, 160);
    const externalActorId = nonEmpty(event.user, 160);
    const providerReactionKey = nonEmpty(event.reaction, 160);
    const eventClock = slackEventClock(event.event_ts);
    if (
      event.item?.type !== "message"
      || !providerConversationId
      || !providerMessageId
      || !/^[0-9]{1,20}\.[0-9]{1,20}$/u.test(providerMessageId)
      || !externalActorId
      || !providerReactionKey
      || !/^[a-z0-9_+:-]+$/u.test(providerReactionKey)
      || !eventClock
    ) {
      const discardReceiptId = await recordIntentionalDiscard({
        endpointId: loaded.endpoint.id,
        registrationId: loaded.registration.id,
        providerAppId: loaded.registration.providerAppId,
        environment: input.environment,
        requestUrl: input.requestUrl,
        endpointRevision: loaded.endpoint.endpointRevision,
        signingSecretRevision: loaded.endpoint.signingSecretRevision,
        providerAuthorityId,
        providerConversationId,
        providerEventId,
        outcomeReason: "unsupported_event",
        slackRetryNumHeader: input.slackRetryNumHeader,
        slackRetryReasonHeader: input.slackRetryReasonHeader,
        rawBody: input.rawBody,
        now,
      });
      return {
        kind: "event",
        eventInboxId: discardReceiptId,
        duplicate: false,
        status: "unsupported",
        reason: "unsupported_event",
        authority: null,
      };
    }
    const [install] = await getDb().select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, loaded.registration.id),
      eq(externalAppInstalls.providerAuthorityId, providerAuthorityId),
      eq(externalAppInstalls.state, "active"),
    )).limit(1);
    if (!install?.botUserId) {
      throw new ExternalAppIngressError("Slack install authority is unavailable", "external_ingress_authority_unavailable");
    }
    const [binding] = await getDb().select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.installId, install.id),
      eq(externalChannelBindings.providerConversationId, providerConversationId),
      eq(externalChannelBindings.state, "active"),
    )).limit(1);
    if (!binding) {
      throw new ExternalAppIngressError("Slack binding authority is unavailable", "external_ingress_authority_unavailable");
    }
    const authorityDecision = await resolveExternalBindingAuthority({
      serverId: binding.serverId,
      bindingId: binding.id,
      expectedConnectionEpoch: binding.connectionEpoch,
      expectedBindingEpoch: binding.bindingEpoch,
      now,
    });
    if (!authorityDecision.active) {
      throw new ExternalAppIngressError("Slack binding authority is inactive", "external_ingress_authority_unavailable");
    }
    const authority = authorityDecision.fact;
    const master = await evaluateFeatureFlag({
      key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
      serverId: binding.serverId,
    });
    const reactionFlag = await evaluateFeatureFlag({
      key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync,
      serverId: binding.serverId,
    });
    if (!master.enabled || !reactionFlag.enabled) {
      const discardReceiptId = await recordIntentionalDiscard({
        endpointId: loaded.endpoint.id,
        registrationId: loaded.registration.id,
        providerAppId: loaded.registration.providerAppId,
        environment: input.environment,
        requestUrl: input.requestUrl,
        endpointRevision: loaded.endpoint.endpointRevision,
        signingSecretRevision: loaded.endpoint.signingSecretRevision,
        providerAuthorityId,
        providerConversationId,
        providerEventId,
        outcomeReason: "capability_disabled",
        slackRetryNumHeader: input.slackRetryNumHeader,
        slackRetryReasonHeader: input.slackRetryReasonHeader,
        rawBody: input.rawBody,
        now,
      });
      return {
        kind: "event",
        eventInboxId: discardReceiptId,
        duplicate: false,
        status: "unsupported",
        reason: "capability_disabled",
        authority: null,
      };
    }
    let runtimeRevision = slackBridgeDatabaseRuntimeRevision(authority);
    if (externalActorId !== install.botUserId) {
      if (!input.runtimeResolver) {
        throw new ExternalAppIngressError("Slack runtime authority is unavailable", "external_ingress_authority_unavailable");
      }
      const [projection] = await getDb().select().from(externalActorProjections).where(and(
        eq(externalActorProjections.provider, "slack"),
        eq(externalActorProjections.appRegistrationId, authority.registrationId),
        eq(externalActorProjections.installId, authority.installId),
        eq(externalActorProjections.workspaceId, authority.providerAuthorityId),
        eq(externalActorProjections.externalActorId, externalActorId),
        eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false),
      )).limit(1);
      if (!projection) {
        throw new ExternalAppIngressError("Slack actor projection is unavailable", "external_ingress_authority_unavailable");
      }
      const [addressability] = await getDb().select().from(externalAddressabilityProjections).where(and(
        eq(externalAddressabilityProjections.projectionId, projection.id),
        eq(externalAddressabilityProjections.connectionEpoch, authority.connectionEpoch),
        eq(externalAddressabilityProjections.bindingId, authority.bindingId),
        eq(externalAddressabilityProjections.bindingEpoch, authority.bindingEpoch),
        eq(externalAddressabilityProjections.conversationId, authority.providerConversationId),
        eq(externalAddressabilityProjections.state, "active"),
      )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1);
      if (!addressability || addressability.expiresAt <= now) {
        throw new ExternalAppIngressError("Slack actor addressability is unavailable", "external_ingress_authority_unavailable");
      }
      const runtime = await input.runtimeResolver.resolveCurrentRuntime({
        authority,
        projectionId: projection.id,
        actorProjectionRevision: projection.projectionRevision,
        externalActorId,
        memberRevision: addressability.memberRevision,
        contextRevision: addressability.contextRevision,
        requiredCapabilities: ["reaction_sync"],
        now,
      });
      if (!runtime || !nonEmpty(runtime.runtimeRevision)) {
        throw new ExternalAppIngressError("Slack runtime authority is unavailable", "external_ingress_authority_unavailable");
      }
      runtimeRevision = runtime.runtimeRevision;
    }
    const normalizedPayload = JSON.stringify({
      schema: NORMALIZED_REACTION_PAYLOAD_SCHEMA,
      operation: reactionType === "reaction_added" ? "add" : "remove",
      providerMessageId,
      externalActorId,
      providerReactionKey,
      eventOccurredAt: eventClock.occurredAt.toISOString(),
      eventSequence: eventClock.sequence,
      botUserId: install.botUserId,
    });
    const aad: ExternalInboundPayloadAad = {
      purpose: PAYLOAD_AAD_PURPOSE,
      aadVersion: 1,
      schemaVersion: 3,
      provider: "slack",
      environment: input.environment,
      appRegistrationId: authority.registrationId,
      installId: authority.installId,
      workspaceId: authority.providerAuthorityId,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      providerEventId,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
      connectionEpoch: authority.connectionEpoch,
      runtimeRevision,
      raftChannelId: authority.channelId,
      privacyClass: authority.privacyClass,
    };
    let sealed: Awaited<ReturnType<ExternalIngressPayloadSealer["sealNormalizedPayload"]>>;
    try {
      sealed = await input.payloadSealer.sealNormalizedPayload({ plaintext: normalizedPayload, aad });
    } catch {
      throw new ExternalAppIngressError("Slack payload sealing failed", "external_ingress_seal_failed");
    }
    if (!sealed.encryptedPayload.trim() || !sealed.envelopeKeyId.trim() || sealed.aadVersion !== 1) {
      throw new ExternalAppIngressError("Slack payload sealing receipt is invalid", "external_ingress_seal_failed");
    }
    const payloadDigest = sha256(normalizedPayload);
    const admitted = await getDb().transaction(async (tx) => {
      if (!await endpointStillCurrent({
        executor: tx,
        endpointId: loaded.endpoint.id,
        registrationId: loaded.registration.id,
        provider: loaded.registration.provider,
        providerAppId: loaded.registration.providerAppId,
        environment: input.environment,
        requestUrl: input.requestUrl,
        endpointRevision: loaded.endpoint.endpointRevision,
        signingSecretRevision: loaded.endpoint.signingSecretRevision,
      })) return null;
      const [created] = await tx.insert(externalInboundEvents).values({
        provider: "slack",
        environment: input.environment,
        appRegistrationId: authority.registrationId,
        installId: authority.installId,
        workspaceId: authority.providerAuthorityId,
        providerAuthorityId: authority.providerAuthorityId,
        providerConversationId: authority.providerConversationId,
        providerEventId,
        bindingId: authority.bindingId,
        bindingEpoch: authority.bindingEpoch,
        connectionEpoch: authority.connectionEpoch,
        runtimeRevision,
        raftChannelId: authority.channelId,
        privacyClass: authority.privacyClass,
        status: "queued",
        normalizedPayloadDigest: payloadDigest,
        encryptedPayload: sealed.encryptedPayload,
        envelopeKeyId: sealed.envelopeKeyId,
        payloadAadPurpose: PAYLOAD_AAD_PURPOSE,
        payloadAadVersion: 1,
        payloadSchemaVersion: 3,
        payloadExpiresAt: new Date(now.getTime() + EXTERNAL_EVENT_PAYLOAD_TTL_MS),
        receivedAt: now,
        updatedAt: now,
      }).onConflictDoNothing({
        target: [
          externalInboundEvents.provider,
          externalInboundEvents.appRegistrationId,
          externalInboundEvents.providerEventId,
        ],
      }).returning({ id: externalInboundEvents.id, status: externalInboundEvents.status });
      if (created) return { ...created, duplicate: false };
      const [existing] = await tx.select().from(externalInboundEvents).where(and(
        eq(externalInboundEvents.provider, "slack"),
        eq(externalInboundEvents.appRegistrationId, authority.registrationId),
        eq(externalInboundEvents.providerEventId, providerEventId),
      )).limit(1);
      return existing
        && existing.normalizedPayloadDigest === payloadDigest
        && existing.bindingId === authority.bindingId
        && existing.bindingEpoch === authority.bindingEpoch
        && existing.connectionEpoch === authority.connectionEpoch
        ? { id: existing.id, status: existing.status, duplicate: true }
        : null;
    });
    if (!admitted) {
      throw new ExternalAppIngressError("Slack reaction admission conflicted", "external_ingress_authority_unavailable");
    }
    return {
      kind: "event",
      eventInboxId: admitted.id,
      duplicate: admitted.duplicate,
      status: admitted.status === "processing" ? "queued" : admitted.status,
      reason: null,
      authority: admissionAuthority({
        authority,
        environment: input.environment,
        signingSecretRevision: loaded.endpoint.signingSecretRevision,
        endpointRevision: loaded.endpoint.endpointRevision,
      }),
    };
  }
  if (envelope.type !== "event_callback" || envelope.event?.type !== "message") {
    const discardReceiptId = await recordIntentionalDiscard({
      endpointId: loaded.endpoint.id,
      registrationId: loaded.registration.id,
      providerAppId: loaded.registration.providerAppId,
      environment: input.environment,
      requestUrl: input.requestUrl,
      endpointRevision: loaded.endpoint.endpointRevision,
      signingSecretRevision: loaded.endpoint.signingSecretRevision,
      providerAuthorityId,
      providerConversationId: nonEmpty(envelope.event?.channel, 160),
      providerEventId,
      outcomeReason: "unsupported_event",
      slackRetryNumHeader: input.slackRetryNumHeader,
      slackRetryReasonHeader: input.slackRetryReasonHeader,
      rawBody: input.rawBody,
      now,
    });
    return {
      kind: "event",
      eventInboxId: discardReceiptId,
      duplicate: false,
      status: "unsupported",
      reason: "unsupported_event",
      authority: null,
    };
  }

  const event = envelope.event;
  const providerConversationId = nonEmpty(event.channel, 160);
  const unsupportedMessageSubtype = event.subtype !== undefined && event.subtype !== "file_share";
  const discardReason: IntentionalDiscardReason | null = event.bot_id !== undefined || event.app_id !== undefined
    ? "provider_loop_suppressed"
    : unsupportedMessageSubtype
      ? "unsupported_message_subtype"
      : null;
  const providerMessageId = nonEmpty(event.ts, 160);
  const providerThreadId = event.thread_ts === undefined ? null : nonEmpty(event.thread_ts, 160);
  if (
    !providerConversationId
    || (!unsupportedMessageSubtype && (
      !providerMessageId
      || !/^[0-9]{1,20}\.[0-9]{1,20}$/.test(providerMessageId)
      || (event.thread_ts !== undefined && !providerThreadId)
    ))
  ) {
    throw new ExternalAppIngressError("Slack message event is invalid", "external_ingress_payload_invalid");
  }
  if (discardReason) {
    const discardReceiptId = await recordIntentionalDiscard({
      endpointId: loaded.endpoint.id,
      registrationId: loaded.registration.id,
      providerAppId: loaded.registration.providerAppId,
      environment: input.environment,
      requestUrl: input.requestUrl,
      endpointRevision: loaded.endpoint.endpointRevision,
      signingSecretRevision: loaded.endpoint.signingSecretRevision,
      providerAuthorityId,
      providerConversationId,
      providerEventId,
      outcomeReason: discardReason,
      slackRetryNumHeader: input.slackRetryNumHeader,
      slackRetryReasonHeader: input.slackRetryReasonHeader,
      rawBody: input.rawBody,
      now,
    });
    return {
      kind: "event",
      eventInboxId: discardReceiptId,
      duplicate: false,
      status: "unsupported",
      reason: discardReason,
      authority: null,
    };
  }
  if (!providerMessageId) {
    throw new ExternalAppIngressError("Slack message event is invalid", "external_ingress_payload_invalid");
  }
  const externalActorId = nonEmpty(event.user, 160);
  const providerFileIds = parseSlackProviderFileIds(event.files);
  if (providerFileIds === null) {
    throw new ExternalAppIngressError("Slack message event is invalid", "external_ingress_payload_invalid");
  }
  const hasAttachments = providerFileIds.length > 0;
  if ((event.subtype === "file_share") !== hasAttachments) {
    throw new ExternalAppIngressError("Slack file-share event is invalid", "external_ingress_payload_invalid");
  }
  const rawContent = nonEmpty(event.text, 40_000);
  if (
    !externalActorId
    || (!hasAttachments && !rawContent)
    || (event.text !== undefined && typeof event.text !== "string")
    || (typeof event.text === "string" && event.text.trim().length > 0 && !rawContent)
  ) {
    throw new ExternalAppIngressError("Slack message event is invalid", "external_ingress_payload_invalid");
  }
  const content = rawContent ?? SLACK_ATTACHMENT_ONLY_MESSAGE;
  if (!input.runtimeResolver) {
    throw new ExternalAppIngressError("Slack runtime authority is unavailable", "external_ingress_authority_unavailable");
  }

  const [install] = await getDb().select().from(externalAppInstalls).where(and(
    eq(externalAppInstalls.registrationId, loaded.registration.id),
    eq(externalAppInstalls.providerAuthorityId, providerAuthorityId),
    eq(externalAppInstalls.state, "active"),
  )).limit(1);
  if (!install) {
    throw new ExternalAppIngressError("Slack install authority is unavailable", "external_ingress_authority_unavailable");
  }
  const [binding] = await getDb().select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.installId, install.id),
    eq(externalChannelBindings.providerConversationId, providerConversationId),
    eq(externalChannelBindings.state, "active"),
  )).limit(1);
  if (!binding) {
    throw new ExternalAppIngressError("Slack binding authority is unavailable", "external_ingress_authority_unavailable");
  }
  const authorityDecision = await resolveExternalBindingAuthority({
    serverId: binding.serverId,
    bindingId: binding.id,
    expectedConnectionEpoch: binding.connectionEpoch,
    expectedBindingEpoch: binding.bindingEpoch,
    now,
  });
  if (!authorityDecision.active) {
    throw new ExternalAppIngressError("Slack binding authority is inactive", "external_ingress_authority_unavailable");
  }
  const authority = authorityDecision.fact;
  if (
    authority.registrationId !== loaded.registration.id
    || authority.providerAppId !== loaded.registration.providerAppId
    || authority.providerAuthorityId !== providerAuthorityId
    || authority.providerConversationId !== providerConversationId
  ) {
    throw new ExternalAppIngressError("Slack binding authority is mismatched", "external_ingress_authority_unavailable");
  }

  const [projection] = await getDb().select().from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, authority.registrationId),
    eq(externalActorProjections.installId, authority.installId),
    eq(externalActorProjections.workspaceId, authority.providerAuthorityId),
    eq(externalActorProjections.externalActorId, externalActorId),
    eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false),
  )).limit(1);
  if (!projection) {
    throw new ExternalAppIngressError("Slack actor projection is unavailable", "external_ingress_authority_unavailable");
  }
  const [addressability] = await getDb().select().from(externalAddressabilityProjections).where(and(
    eq(externalAddressabilityProjections.projectionId, projection.id),
    eq(externalAddressabilityProjections.provider, "slack"),
    eq(externalAddressabilityProjections.appRegistrationId, authority.registrationId),
    eq(externalAddressabilityProjections.installId, authority.installId),
    eq(externalAddressabilityProjections.workspaceId, authority.providerAuthorityId),
    eq(externalAddressabilityProjections.connectionEpoch, authority.connectionEpoch),
    eq(externalAddressabilityProjections.bindingId, authority.bindingId),
    eq(externalAddressabilityProjections.bindingEpoch, authority.bindingEpoch),
    eq(externalAddressabilityProjections.conversationId, authority.providerConversationId),
    eq(externalAddressabilityProjections.state, "active"),
  )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1);
  if (!addressability || addressability.expiresAt <= now) {
    throw new ExternalAppIngressError("Slack actor addressability is unavailable", "external_ingress_authority_unavailable");
  }

  const runtime = await input.runtimeResolver.resolveCurrentRuntime({
    authority,
    projectionId: projection.id,
    actorProjectionRevision: projection.projectionRevision,
    externalActorId,
    memberRevision: addressability.memberRevision,
    contextRevision: addressability.contextRevision,
    requiredCapabilities: hasAttachments ? ["attachment_transfer"] : [],
    now,
  });
  if (!runtime || !nonEmpty(runtime.runtimeRevision)) {
    throw new ExternalAppIngressError("Slack runtime authority is unavailable", "external_ingress_authority_unavailable");
  }

  const normalizedPayload = JSON.stringify({
    schema: NORMALIZED_PAYLOAD_SCHEMA,
    projectionId: projection.id,
    actorProjectionRevision: projection.projectionRevision,
    externalActorId,
    providerMessageId,
    providerThreadId,
    providerFileIds,
    content,
    createdAt: new Date(Number(providerMessageId.split(".")[0]) * 1_000).toISOString(),
  });
  const aad: ExternalInboundPayloadAad = {
    purpose: PAYLOAD_AAD_PURPOSE,
    aadVersion: 1,
    schemaVersion: 2,
    provider: "slack",
    environment: input.environment,
    appRegistrationId: authority.registrationId,
    installId: authority.installId,
    workspaceId: authority.providerAuthorityId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    providerEventId,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
    connectionEpoch: authority.connectionEpoch,
    runtimeRevision: runtime.runtimeRevision,
    raftChannelId: authority.channelId,
    privacyClass: authority.privacyClass,
  };
  let sealed: Awaited<ReturnType<ExternalIngressPayloadSealer["sealNormalizedPayload"]>>;
  try {
    sealed = await input.payloadSealer.sealNormalizedPayload({ plaintext: normalizedPayload, aad });
  } catch {
    throw new ExternalAppIngressError("Slack payload sealing failed", "external_ingress_seal_failed");
  }
  if (!sealed.encryptedPayload.trim() || !sealed.envelopeKeyId.trim() || sealed.aadVersion !== 1) {
    throw new ExternalAppIngressError("Slack payload sealing receipt is invalid", "external_ingress_seal_failed");
  }

  const payloadDigest = sha256(normalizedPayload);
  const payloadExpiresAt = new Date(now.getTime() + EXTERNAL_EVENT_PAYLOAD_TTL_MS);
  const admitted = await getDb().transaction(async (tx) => {
    if (!await endpointStillCurrent({
      executor: tx,
      endpointId: loaded.endpoint.id,
      registrationId: loaded.registration.id,
      provider: loaded.registration.provider,
      providerAppId: loaded.registration.providerAppId,
      environment: input.environment,
      requestUrl: input.requestUrl,
      endpointRevision: loaded.endpoint.endpointRevision,
      signingSecretRevision: loaded.endpoint.signingSecretRevision,
    })) return null;
    const [created] = await tx.insert(externalInboundEvents).values({
      provider: "slack",
      environment: input.environment,
      appRegistrationId: authority.registrationId,
      installId: authority.installId,
      workspaceId: authority.providerAuthorityId,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      providerEventId,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
      connectionEpoch: authority.connectionEpoch,
      runtimeRevision: runtime.runtimeRevision,
      raftChannelId: authority.channelId,
      privacyClass: authority.privacyClass,
      status: "queued",
      normalizedPayloadDigest: payloadDigest,
      encryptedPayload: sealed.encryptedPayload,
      envelopeKeyId: sealed.envelopeKeyId,
      payloadAadPurpose: PAYLOAD_AAD_PURPOSE,
      payloadAadVersion: 1,
      payloadSchemaVersion: 2,
      payloadExpiresAt,
      receivedAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [
        externalInboundEvents.provider,
        externalInboundEvents.appRegistrationId,
        externalInboundEvents.providerEventId,
      ],
    }).returning({ id: externalInboundEvents.id, status: externalInboundEvents.status });
    if (created) return { ...created, duplicate: false };
    const [existing] = await tx.select({
      id: externalInboundEvents.id,
      status: externalInboundEvents.status,
      digest: externalInboundEvents.normalizedPayloadDigest,
      bindingId: externalInboundEvents.bindingId,
      bindingEpoch: externalInboundEvents.bindingEpoch,
      connectionEpoch: externalInboundEvents.connectionEpoch,
    }).from(externalInboundEvents).where(and(
      eq(externalInboundEvents.provider, "slack"),
      eq(externalInboundEvents.appRegistrationId, authority.registrationId),
      eq(externalInboundEvents.providerEventId, providerEventId),
    )).limit(1);
    if (
      !existing
      || existing.digest !== payloadDigest
      || existing.bindingId !== authority.bindingId
      || existing.bindingEpoch !== authority.bindingEpoch
      || existing.connectionEpoch !== authority.connectionEpoch
    ) return null;
    return { id: existing.id, status: existing.status, duplicate: true };
  });
  if (!admitted) {
    throw new ExternalAppIngressError("Slack event admission conflicted", "external_ingress_authority_unavailable");
  }
  return {
    kind: "event",
    eventInboxId: admitted.id,
    duplicate: admitted.duplicate,
    status: admitted.status === "processing" ? "queued" : admitted.status,
    reason: null,
    authority: admissionAuthority({
      authority,
      environment: input.environment,
      signingSecretRevision: loaded.endpoint.signingSecretRevision,
      endpointRevision: loaded.endpoint.endpointRevision,
    }),
  };
}
