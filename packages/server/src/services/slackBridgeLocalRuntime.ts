import {
  createHash,
  createDecipheriv,
  createCipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  clearClockTimeout,
  currentDate,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { constants } from "node:fs";
import { open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DEFAULT_APP_URL, normalizeAppUrl } from "../config/appUrl.js";
import { getDb, type Database, type DatabaseExecutor } from "../db/index.js";
import {
  agents,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppIngressEndpoints,
  externalAppInstalls,
  externalAppManifestReceipts,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAuthorPolicies,
  externalChannelBindings,
  externalMessageLinks,
  messages,
  users,
} from "../db/schema.js";
import type { SlackBridgeRouteDependencies } from "../routes/slackBridge.js";
import type { ExternalIngressRuntimeResolver } from "./externalAppIngressService.js";
import type { ExternalAuthorPolicyRuntimeAuthority } from "./externalAppControlPlaneService.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";
import {
  effectiveAgentSenderName,
  effectiveUserSenderName,
} from "./effectiveSenderName.js";
import {
  installOrdinaryMessageOutboundRuntime,
  mintSlackBridgeReconciliationMarker,
  type OrdinaryMessageOutboundAuthorizationResolver,
  type ProviderNeutralOutboundBindingAuthority,
} from "./externalDeliveryOutboxService.js";
import {
  processExternalDeliveryPartitionHead,
  type ExternalDeliveryCredentialLease,
  type ExternalDeliveryWorkerDependencies,
} from "./externalDeliveryWorkerService.js";
import {
  resolveSlackBridgeBindingActive,
  SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA,
  SLACK_BRIDGE_RELEASE_CONTRACT_REVISION,
  type SlackBridgeAppMembershipDecision,
  type SlackBridgeBindingActiveDecision,
  type SlackBridgeReleaseOracleDecision,
  type SlackBridgeRuntimeLevel,
} from "./slackBridgeRuntimeService.js";
import { createSlackBridgeOAuthCompletionRedirectPathResolver } from "./slackBridgeOAuthCompletionRedirect.js";
import {
  createSlackOAuthExchangeAdapter,
  createSlackProviderPreparation,
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
  SLACK_OAUTH_CODE_HANDLE_SCHEMA,
  type SlackBridgeCredentialHandle,
  type SlackJsonObject,
  type SlackOAuthExchangeTransportResult,
  type SlackProviderAuthorityFence,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter.js";

const CONFIG_SCHEMA = "slack-bridge-local-runtime.v1" as const;
const MANIFEST_MANAGER_CREDENTIAL_SCHEMA = "slack-bridge-local-manifest-manager-credential.v1" as const;
const OAUTH_ENDPOINT = "https://slack.com/api/oauth.v2.access";
const MANIFEST_EXPORT_ENDPOINT = "https://slack.com/api/apps.manifest.export";
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_MANAGER_CREDENTIAL_BYTES = 16 * 1024;
const MAX_MANAGER_TOKEN_BYTES = 4 * 1024;
const MAX_PROVIDER_REQUEST_BYTES = 64 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const APP_LEASE_TTL_MS = 5 * 60_000;
const CODE_HANDLE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const CREDENTIAL_LEASE_TTL_MS = 60_000;
const MANIFEST_AUTHORITY_MAX_TTL_MS = 60 * 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FetchLike = typeof fetch;

interface LocalRuntimeConfig {
  schema: typeof CONFIG_SCHEMA;
  environment: "test";
  publicOrigin: string;
  registrationId: string;
  providerAppId: string;
  providerOAuthClientId: string;
  oauthClientSecret: string;
  signingSecret: string;
  signingSecretRef: string;
  signingSecretRevision: number;
  envelopeKeyId: string;
  envelopeKeyBase64: string;
  outbound?: LocalOutboundConfig;
  realAuthority?: LocalRealAuthorityReceipt;
}

const REAL_AUTHORITY_SCHEMA = "slack-bridge-local-real-authority.v1" as const;
const MANIFEST_AUTHORITY_SCHEMA = "slack-bridge-local-manifest-authority.v1" as const;

type LocalRealActorKind = "human" | "guest" | "remote";

interface LocalRealAuthorityActor {
  externalActorId: string;
  displayName: string;
  handles: string[];
  actorKind: LocalRealActorKind;
  projectionRevision: number;
}

export interface SlackBridgeLocalOutboundBootstrapInput {
  workerId: string;
  pollIntervalMs: number;
  raftAppOrigin: string;
  bindings: Array<{
    serverId: string;
    sourceConversationId: string;
    canonicalRootMessageId: string | null;
    bindingId: string;
    connectionEpoch: number;
    bindingEpoch: number;
    consentRevision: number;
    level: SlackBridgeRuntimeLevel;
    membership: {
      registrationId: string;
      installId: string;
      bindingId: string;
      connectionEpoch: number;
      bindingEpoch: number;
      providerAuthorityId: string;
      providerConversationId: string;
      receiptRevision: number;
      expiresAt: string;
    };
    oracle: {
      bindingId: string;
      connectionEpoch: number;
      bindingEpoch: number;
      privacyClass: "public" | "private";
      level: SlackBridgeRuntimeLevel;
      releaseContractRevision: typeof SLACK_BRIDGE_RELEASE_CONTRACT_REVISION;
      oracleReceiptSchema: typeof SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA;
      oracleReceiptRevision: number;
      inboundGreen: boolean;
      outboundGreen: boolean;
      expiresAt: string;
    };
  }>;
}

interface LocalRealAuthorityReceipt {
  schema: typeof REAL_AUTHORITY_SCHEMA;
  registrationId: string;
  installId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  providerConversationKind: "public_channel" | "private_channel";
  privacyClass: "public" | "private";
  connectionEpoch: number;
  credentialRevision: number;
  bindingId: string;
  bindingEpoch: number;
  memberRevision: number;
  contextRevision: number;
  consentRevision: number;
  actorCount: number;
  actorsDigest: string;
  observedAt: Date;
  expiresAt: Date;
}

export interface SlackBridgeLocalRealAuthorityInput {
  schema: typeof REAL_AUTHORITY_SCHEMA;
  registrationId: string;
  installId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  providerConversationKind: "public_channel" | "private_channel";
  privacyClass: "public" | "private";
  connectionEpoch: number;
  credentialRevision: number;
  bindingId: string;
  bindingEpoch: number;
  memberRevision: number;
  contextRevision: number;
  consentRevision: number;
  observedAt: string;
  expiresAt: string;
  actors: LocalRealAuthorityActor[];
  /**
   * Existing owner-controlled outbound authority to restore when the runtime
   * config predates outbound support. The replacement still proves every Raft
   * target against existing locked database rows before committing anything.
   */
  outboundBootstrap?: SlackBridgeLocalOutboundBootstrapInput;
}

export interface SlackBridgeLocalRealAuthorityVerificationReceipt {
  registrationId: string;
  installId: string;
  connectionEpoch: number;
  credentialRevision: number;
  bindingId: string;
  bindingEpoch: number;
  memberRevision: number;
  contextRevision: number;
  actorCount: number;
  addressabilityCount: number;
  authorPolicyCount: number;
  actorsDigest: string;
}

export interface SlackBridgeLocalManifestAuthorityInput {
  schema: typeof MANIFEST_AUTHORITY_SCHEMA;
  registrationId: string;
  receiptRevision: number;
  managerCredentialRevision: number;
  providerAppId: string;
  normalizedManifestHash: string;
  normalizedScopes: string[];
  normalizedEvents: string[];
  normalizedSettings: Record<string, unknown>;
  observedAt: string;
  expiresAt: string;
}

export interface SlackBridgeLocalManifestAuthorityVerificationReceipt {
  registrationId: string;
  receiptRevision: number;
  managerCredentialRevision: number;
  providerAppId: string;
  normalizedManifestHash: string;
  observedAt: string;
  expiresAt: string;
}

interface LocalManifestManagerCredential {
  schema: typeof MANIFEST_MANAGER_CREDENTIAL_SCHEMA;
  registrationId: string;
  providerAppId: string;
  encryptedSecretRef: string;
  envelopeKeyId: string;
  aadVersion: 1;
  secretRevision: number;
  token: string;
}

interface SlackBridgeLocalManifestObservationDependencies {
  db?: Database;
  now?: () => Date;
  fetch?: FetchLike;
  fetchTimeoutMs?: number;
}

interface LocalMembershipReceipt {
  registrationId: string;
  installId: string;
  bindingId: string;
  connectionEpoch: number;
  bindingEpoch: number;
  providerAuthorityId: string;
  providerConversationId: string;
  receiptRevision: number;
  expiresAt: Date;
}

interface LocalOracleReceipt {
  bindingId: string;
  connectionEpoch: number;
  bindingEpoch: number;
  privacyClass: "public" | "private";
  level: SlackBridgeRuntimeLevel;
  releaseContractRevision: typeof SLACK_BRIDGE_RELEASE_CONTRACT_REVISION;
  oracleReceiptSchema: typeof SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA;
  oracleReceiptRevision: number;
  inboundGreen: boolean;
  outboundGreen: boolean;
  expiresAt: Date;
}

interface LocalOutboundBinding {
  serverId: string;
  sourceConversationId: string;
  canonicalRootMessageId: string | null;
  bindingId: string;
  connectionEpoch: number;
  bindingEpoch: number;
  consentRevision: number;
  level: SlackBridgeRuntimeLevel;
  membership: LocalMembershipReceipt;
  oracle: LocalOracleReceipt;
}

interface LocalOutboundConfig {
  workerId: string;
  pollIntervalMs: number;
  raftAppOrigin: string;
  bindings: LocalOutboundBinding[];
}

interface LocalAppLease {
  attemptId: string;
  clientSecret: string;
  providerAppId: string;
  providerOAuthClientId: string;
  expiresAt: Date;
}

interface LocalCodeHandle {
  authorizationCode: string;
  attemptId: string;
  providerOAuthClientId: string;
  expiresAt: Date;
}

interface LocalProviderCredentialLease {
  accessToken: string;
  authority: SlackProviderAuthorityFence;
  deliveryId: string;
  reconciliationMarker: string | null;
  expiresAt: Date;
}

export interface SlackBridgeLocalRuntime extends SlackBridgeRouteDependencies {
  start(): void;
  stop(): Promise<void>;
}

export interface SlackBridgeLocalRuntimeDependencies {
  fetch: FetchLike;
  fetchTimeoutMs: number;
  now(): Date;
  db: Database;
  runWorkerOnce(input: {
    db: Database;
    bindingId: string;
    bindingEpoch: number;
    leaseOwner: string;
    dependencies: ExternalDeliveryWorkerDependencies;
  }): ReturnType<typeof processExternalDeliveryPartitionHead>;
  verifyIngressAuthority(input: {
    config: LocalRuntimeConfig;
    now: Date;
  }): Promise<SlackBridgeLocalIngressAuthorityReceipt>;
}

export interface SlackBridgeLocalIngressAuthorityReceipt {
  registrationId: string;
  endpointId: string;
  endpointRevision: number;
  exactRequestUrl: string;
  signingSecretRevision: number;
  signingSecretRef: string;
  envelopeKeyId: string;
}

interface SlackBridgeLocalIngressAuthorityRows {
  registration: typeof externalAppRegistrations.$inferSelect;
  endpoint: typeof externalAppIngressEndpoints.$inferSelect;
  signingSecret: typeof externalAppRegistrationSecrets.$inferSelect;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(
  input: Record<string, unknown>,
  key: keyof LocalRuntimeConfig,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Slack Bridge local runtime config field ${key} is invalid`);
  }
  return value;
}

function requiredRecord(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = object(input[key]);
  if (!value) throw new Error(`Slack Bridge local runtime config field ${key} is invalid`);
  return value;
}

function requiredNestedString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Slack Bridge local runtime config field ${key} is invalid`);
  }
  return value;
}

function requiredPositiveInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Slack Bridge local runtime config field ${key} is invalid`);
  }
  return Number(value);
}

function requiredDate(input: Record<string, unknown>, key: string): Date {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`Slack Bridge local runtime config field ${key} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Slack Bridge local runtime config field ${key} is invalid`);
  }
  return parsed;
}

function parseOutboundBinding(value: unknown): LocalOutboundBinding {
  const input = object(value);
  if (!input) throw new Error("Slack Bridge local outbound binding is invalid");
  const level = input.level;
  if (level !== "top_level" && level !== "thread") {
    throw new Error("Slack Bridge local outbound binding level is invalid");
  }
  const canonicalRootMessageId = input.canonicalRootMessageId;
  if (
    (level === "top_level" && canonicalRootMessageId !== null)
    || (level === "thread" && (typeof canonicalRootMessageId !== "string" || !canonicalRootMessageId.trim()))
  ) {
    throw new Error("Slack Bridge local outbound binding root is invalid");
  }
  const membershipInput = requiredRecord(input, "membership");
  const oracleInput = requiredRecord(input, "oracle");
  const privacyClass = oracleInput.privacyClass;
  if (privacyClass !== "public" && privacyClass !== "private") {
    throw new Error("Slack Bridge local outbound Oracle privacy class is invalid");
  }
  if (
    oracleInput.level !== level
    || oracleInput.releaseContractRevision !== SLACK_BRIDGE_RELEASE_CONTRACT_REVISION
    || oracleInput.oracleReceiptSchema !== SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA
    || typeof oracleInput.inboundGreen !== "boolean"
    || typeof oracleInput.outboundGreen !== "boolean"
  ) {
    throw new Error("Slack Bridge local outbound Oracle receipt is invalid");
  }
  return {
    serverId: requiredNestedString(input, "serverId"),
    sourceConversationId: requiredNestedString(input, "sourceConversationId"),
    canonicalRootMessageId: canonicalRootMessageId as string | null,
    bindingId: requiredNestedString(input, "bindingId"),
    connectionEpoch: requiredPositiveInteger(input, "connectionEpoch"),
    bindingEpoch: requiredPositiveInteger(input, "bindingEpoch"),
    consentRevision: requiredPositiveInteger(input, "consentRevision"),
    level,
    membership: {
      registrationId: requiredNestedString(membershipInput, "registrationId"),
      installId: requiredNestedString(membershipInput, "installId"),
      bindingId: requiredNestedString(membershipInput, "bindingId"),
      connectionEpoch: requiredPositiveInteger(membershipInput, "connectionEpoch"),
      bindingEpoch: requiredPositiveInteger(membershipInput, "bindingEpoch"),
      providerAuthorityId: requiredNestedString(membershipInput, "providerAuthorityId"),
      providerConversationId: requiredNestedString(membershipInput, "providerConversationId"),
      receiptRevision: requiredPositiveInteger(membershipInput, "receiptRevision"),
      expiresAt: requiredDate(membershipInput, "expiresAt"),
    },
    oracle: {
      bindingId: requiredNestedString(oracleInput, "bindingId"),
      connectionEpoch: requiredPositiveInteger(oracleInput, "connectionEpoch"),
      bindingEpoch: requiredPositiveInteger(oracleInput, "bindingEpoch"),
      privacyClass,
      level,
      releaseContractRevision: SLACK_BRIDGE_RELEASE_CONTRACT_REVISION,
      oracleReceiptSchema: SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA,
      oracleReceiptRevision: requiredPositiveInteger(oracleInput, "oracleReceiptRevision"),
      inboundGreen: oracleInput.inboundGreen,
      outboundGreen: oracleInput.outboundGreen,
      expiresAt: requiredDate(oracleInput, "expiresAt"),
    },
  };
}

function parseOutboundConfig(value: unknown): LocalOutboundConfig | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (!input || !Array.isArray(input.bindings) || input.bindings.length === 0) {
    throw new Error("Slack Bridge local outbound config is invalid");
  }
  const raftAppOrigin = normalizeAppUrl(requiredNestedString(input, "raftAppOrigin"));
  if (!raftAppOrigin || !raftAppOrigin.startsWith("https://")) {
    throw new Error("Slack Bridge local outbound Raft app origin is invalid");
  }
  const pollIntervalMs = requiredPositiveInteger(input, "pollIntervalMs");
  if (pollIntervalMs > 60_000) {
    throw new Error("Slack Bridge local outbound poll interval is invalid");
  }
  const bindings = input.bindings.map(parseOutboundBinding);
  const identities = new Set<string>();
  for (const binding of bindings) {
    const identity = `${binding.sourceConversationId}:${binding.level}`;
    if (identities.has(identity)) {
      throw new Error("Slack Bridge local outbound binding identity is duplicated");
    }
    identities.add(identity);
  }
  return {
    workerId: requiredNestedString(input, "workerId"),
    pollIntervalMs,
    raftAppOrigin,
    bindings,
  };
}

function sortedUniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Slack Bridge local real-authority ${field} is invalid`);
  }
  const strings = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item !== item.trim()) {
      throw new Error(`Slack Bridge local real-authority ${field} is invalid`);
    }
    return item;
  });
  const sorted = [...new Set(strings)].sort((left, right) => left.localeCompare(right));
  if (sorted.length !== strings.length || sorted.some((item, index) => item !== strings[index])) {
    throw new Error(`Slack Bridge local real-authority ${field} must be sorted and unique`);
  }
  return sorted;
}

function normalizeRealAuthorityActors(value: unknown): LocalRealAuthorityActor[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Slack Bridge local real-authority actors are invalid");
  }
  const actors = value.map((item, index) => {
    const actor = object(item);
    if (!actor) throw new Error("Slack Bridge local real-authority actor is invalid");
    const actorKind = actor.actorKind;
    if (actorKind !== "human" && actorKind !== "guest" && actorKind !== "remote") {
      throw new Error("Slack Bridge local real-authority actor kind is invalid");
    }
    return {
      externalActorId: requiredNestedString(actor, "externalActorId"),
      displayName: requiredNestedString(actor, "displayName"),
      handles: sortedUniqueStrings(actor.handles, `actors[${index}].handles`),
      actorKind: actorKind as LocalRealActorKind,
      projectionRevision: requiredPositiveInteger(actor, "projectionRevision"),
    };
  }).sort((left, right) => left.externalActorId.localeCompare(right.externalActorId));
  if (new Set(actors.map((actor) => actor.externalActorId)).size !== actors.length) {
    throw new Error("Slack Bridge local real-authority actor identity is duplicated");
  }
  return actors;
}

function digestRealAuthorityActors(actors: LocalRealAuthorityActor[]): string {
  return createHash("sha256").update(JSON.stringify(actors)).digest("hex");
}

function parseRealAuthorityReceipt(value: unknown): LocalRealAuthorityReceipt | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (!input || input.schema !== REAL_AUTHORITY_SCHEMA) {
    throw new Error("Slack Bridge local real-authority schema is invalid");
  }
  const providerConversationKind = input.providerConversationKind;
  const privacyClass = input.privacyClass;
  if (
    (providerConversationKind !== "public_channel" && providerConversationKind !== "private_channel")
    || (privacyClass !== "public" && privacyClass !== "private")
    || (providerConversationKind === "public_channel") !== (privacyClass === "public")
  ) {
    throw new Error("Slack Bridge local real-authority privacy is invalid");
  }
  const actorsDigest = requiredNestedString(input, "actorsDigest");
  if (!/^[0-9a-f]{64}$/.test(actorsDigest)) {
    throw new Error("Slack Bridge local real-authority actor digest is invalid");
  }
  const actorCount = requiredPositiveInteger(input, "actorCount");
  const observedAt = requiredDate(input, "observedAt");
  const expiresAt = requiredDate(input, "expiresAt");
  if (expiresAt <= observedAt) {
    throw new Error("Slack Bridge local real-authority freshness window is invalid");
  }
  return {
    schema: REAL_AUTHORITY_SCHEMA,
    registrationId: requiredNestedString(input, "registrationId"),
    installId: requiredNestedString(input, "installId"),
    providerAuthorityId: requiredNestedString(input, "providerAuthorityId"),
    providerConversationId: requiredNestedString(input, "providerConversationId"),
    providerConversationKind,
    privacyClass,
    connectionEpoch: requiredPositiveInteger(input, "connectionEpoch"),
    credentialRevision: requiredPositiveInteger(input, "credentialRevision"),
    bindingId: requiredNestedString(input, "bindingId"),
    bindingEpoch: requiredPositiveInteger(input, "bindingEpoch"),
    memberRevision: requiredPositiveInteger(input, "memberRevision"),
    contextRevision: requiredPositiveInteger(input, "contextRevision"),
    consentRevision: requiredPositiveInteger(input, "consentRevision"),
    actorCount,
    actorsDigest,
    observedAt,
    expiresAt,
  };
}

function normalizeRealAuthorityInput(input: SlackBridgeLocalRealAuthorityInput): {
  receipt: LocalRealAuthorityReceipt;
  actors: LocalRealAuthorityActor[];
} {
  const actors = normalizeRealAuthorityActors(input.actors);
  const receipt = parseRealAuthorityReceipt({
    ...input,
    actorCount: actors.length,
    actorsDigest: digestRealAuthorityActors(actors),
  });
  if (!receipt || receipt.registrationId !== input.registrationId || receipt.installId !== input.installId) {
    throw new Error("Slack Bridge local real-authority input is invalid");
  }
  if (!UUID_PATTERN.test(receipt.registrationId) || !UUID_PATTERN.test(receipt.installId) || !UUID_PATTERN.test(receipt.bindingId)) {
    throw new Error("Slack Bridge local real-authority identifiers are invalid");
  }
  return { receipt, actors };
}

function parseConfig(raw: string): LocalRuntimeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Slack Bridge local runtime config is not valid JSON");
  }
  const input = object(parsed);
  if (!input || input.schema !== CONFIG_SCHEMA || input.environment !== "test") {
    throw new Error("Slack Bridge local runtime config schema/environment is invalid");
  }
  const publicOrigin = requiredString(input, "publicOrigin");
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("Slack Bridge local runtime publicOrigin is invalid");
  }
  if (
    origin.protocol !== "https:"
    || origin.username
    || origin.password
    || origin.search
    || origin.hash
    || origin.pathname !== "/"
  ) {
    throw new Error("Slack Bridge local runtime publicOrigin must be a bare HTTPS origin");
  }
  const signingSecretRevision = input.signingSecretRevision;
  if (!Number.isSafeInteger(signingSecretRevision) || Number(signingSecretRevision) < 1) {
    throw new Error("Slack Bridge local runtime signingSecretRevision is invalid");
  }
  const envelopeKeyBase64 = requiredString(input, "envelopeKeyBase64");
  const envelopeKey = Buffer.from(envelopeKeyBase64, "base64");
  if (envelopeKey.length !== 32 || envelopeKey.toString("base64") !== envelopeKeyBase64) {
    throw new Error("Slack Bridge local runtime envelope key must be canonical base64 for 32 bytes");
  }
  const registrationId = requiredString(input, "registrationId");
  if (!UUID_PATTERN.test(registrationId)) {
    throw new Error("Slack Bridge local runtime registrationId is invalid");
  }
  const config: LocalRuntimeConfig = {
    schema: CONFIG_SCHEMA,
    environment: "test",
    publicOrigin: origin.origin,
    registrationId,
    providerAppId: requiredString(input, "providerAppId"),
    providerOAuthClientId: requiredString(input, "providerOAuthClientId"),
    oauthClientSecret: requiredString(input, "oauthClientSecret"),
    signingSecret: requiredString(input, "signingSecret"),
    signingSecretRef: requiredString(input, "signingSecretRef"),
    signingSecretRevision: Number(signingSecretRevision),
    envelopeKeyId: requiredString(input, "envelopeKeyId"),
    envelopeKeyBase64,
    outbound: parseOutboundConfig(input.outbound),
    realAuthority: parseRealAuthorityReceipt(input.realAuthority),
  };
  if (config.realAuthority) {
    if (!config.outbound || config.realAuthority.registrationId !== config.registrationId) {
      throw new Error("Slack Bridge local real-authority receipt is detached from runtime config");
    }
    const bindings = config.outbound.bindings.filter((binding) =>
      binding.bindingId === config.realAuthority!.bindingId
      && binding.connectionEpoch === config.realAuthority!.connectionEpoch
      && binding.bindingEpoch === config.realAuthority!.bindingEpoch
      && binding.consentRevision === config.realAuthority!.consentRevision
      && binding.membership.registrationId === config.realAuthority!.registrationId
      && binding.membership.installId === config.realAuthority!.installId
      && binding.membership.providerAuthorityId === config.realAuthority!.providerAuthorityId
      && binding.membership.providerConversationId === config.realAuthority!.providerConversationId
      && binding.membership.receiptRevision === config.realAuthority!.memberRevision
    );
    if (bindings.length !== config.outbound.bindings.length) {
      throw new Error("Slack Bridge local real-authority receipt does not cover every outbound binding");
    }
    for (const binding of bindings) {
      if (
        binding.oracle.bindingId !== config.realAuthority.bindingId
        || binding.oracle.connectionEpoch !== config.realAuthority.connectionEpoch
        || binding.oracle.bindingEpoch !== config.realAuthority.bindingEpoch
        || binding.oracle.privacyClass !== config.realAuthority.privacyClass
        || binding.oracle.oracleReceiptRevision !== config.realAuthority.contextRevision
        || binding.membership.expiresAt.getTime() !== config.realAuthority.expiresAt.getTime()
        || binding.oracle.expiresAt.getTime() !== config.realAuthority.expiresAt.getTime()
      ) {
        throw new Error("Slack Bridge local real-authority receipt does not match outbound receipts");
      }
    }
  }
  return config;
}

async function readProtectedConfig(path: string): Promise<LocalRuntimeConfig> {
  if (!isAbsolute(path)) {
    throw new Error("Slack Bridge local runtime config path must be absolute");
  }
  if (await realpath(path) !== path) {
    throw new Error("Slack Bridge local runtime config path must be canonical");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("Slack Bridge local runtime config must be a regular file");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Slack Bridge local runtime config permissions must be 0600 or stricter");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Slack Bridge local runtime config must be owned by the server process user");
    }
    if (metadata.size <= 0 || metadata.size > MAX_CONFIG_BYTES) {
      throw new Error("Slack Bridge local runtime config size is invalid");
    }
    return parseConfig(await handle.readFile({ encoding: "utf8" }));
  } finally {
    await handle.close();
  }
}

function parseManifestManagerCredential(raw: string): LocalManifestManagerCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Slack Bridge local manifest-manager credential is not valid JSON");
  }
  const input = object(parsed);
  const expectedKeys = [
    "aadVersion",
    "encryptedSecretRef",
    "envelopeKeyId",
    "providerAppId",
    "registrationId",
    "schema",
    "secretRevision",
    "token",
  ];
  if (
    !input
    || input.schema !== MANIFEST_MANAGER_CREDENTIAL_SCHEMA
    || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedKeys)
    || input.aadVersion !== 1
  ) {
    throw new Error("Slack Bridge local manifest-manager credential schema is invalid");
  }
  const token = requiredNestedString(input, "token");
  if (Buffer.byteLength(token, "utf8") > MAX_MANAGER_TOKEN_BYTES || /\s/.test(token)) {
    throw new Error("Slack Bridge local manifest-manager credential token is invalid");
  }
  const registrationId = requiredNestedString(input, "registrationId");
  if (!UUID_PATTERN.test(registrationId)) {
    throw new Error("Slack Bridge local manifest-manager credential registration is invalid");
  }
  return {
    schema: MANIFEST_MANAGER_CREDENTIAL_SCHEMA,
    registrationId,
    providerAppId: requiredNestedString(input, "providerAppId"),
    encryptedSecretRef: requiredNestedString(input, "encryptedSecretRef"),
    envelopeKeyId: requiredNestedString(input, "envelopeKeyId"),
    aadVersion: 1,
    secretRevision: requiredPositiveInteger(input, "secretRevision"),
    token,
  };
}

async function readProtectedManifestManagerCredential(path: string): Promise<LocalManifestManagerCredential> {
  if (!isAbsolute(path)) {
    throw new Error("Slack Bridge local manifest-manager credential path must be absolute");
  }
  if (await realpath(path) !== path) {
    throw new Error("Slack Bridge local manifest-manager credential path must be canonical");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("Slack Bridge local manifest-manager credential must be a regular file");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Slack Bridge local manifest-manager credential permissions must be 0600 or stricter");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Slack Bridge local manifest-manager credential must be owned by the server process user");
    }
    if (metadata.size <= 0 || metadata.size > MAX_MANAGER_CREDENTIAL_BYTES) {
      throw new Error("Slack Bridge local manifest-manager credential size is invalid");
    }
    return parseManifestManagerCredential(await handle.readFile({ encoding: "utf8" }));
  } finally {
    await handle.close();
  }
}

function eventsRequestUrl(config: LocalRuntimeConfig): string {
  return `${config.publicOrigin}/api/slack-bridge/events`;
}

function configPathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const configPath = env.SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE?.trim();
  if (!configPath) return undefined;
  if (env.NODE_ENV === "production") {
    throw new Error("Slack Bridge local runtime is forbidden in production");
  }
  return configPath;
}

function manifestManagerCredentialPathFromEnv(env: NodeJS.ProcessEnv, configPath: string): string {
  const path = env.SLACK_BRIDGE_LOCAL_MANIFEST_MANAGER_CREDENTIAL_FILE?.trim();
  if (!path) throw new Error("Slack Bridge local manifest-manager credential file is required");
  if (path === configPath) {
    throw new Error("Slack Bridge local manifest-manager credential must use independent custody");
  }
  return path;
}

function assertLocalIngressAuthority(
  config: LocalRuntimeConfig,
  rows: SlackBridgeLocalIngressAuthorityRows,
  now: Date,
): SlackBridgeLocalIngressAuthorityReceipt {
  const { registration, endpoint, signingSecret } = rows;
  if (
    registration.id !== config.registrationId
    || registration.provider !== "slack"
    || registration.environment !== "test"
    || registration.state !== "active"
    || registration.providerAppId !== config.providerAppId
    || registration.providerOAuthClientId !== config.providerOAuthClientId
  ) {
    throw new Error("Slack Bridge local ingress registration authority mismatch");
  }
  if (
    endpoint.registrationId !== config.registrationId
    || endpoint.environment !== "test"
    || endpoint.state !== "active"
  ) {
    throw new Error("Slack Bridge local ingress endpoint authority mismatch");
  }
  if (endpoint.exactRequestUrl !== eventsRequestUrl(config)) {
    throw new Error("Slack Bridge local ingress Events request URL mismatch");
  }
  if (
    endpoint.signingSecretRevision !== config.signingSecretRevision
    || signingSecret.secretRevision !== config.signingSecretRevision
  ) {
    throw new Error("Slack Bridge local ingress signing-secret revision mismatch");
  }
  if (
    signingSecret.registrationId !== config.registrationId
    || signingSecret.purpose !== "signing_secret"
    || signingSecret.revokedAt !== null
  ) {
    throw new Error("Slack Bridge local ingress signing-secret authority mismatch");
  }
  if (signingSecret.encryptedSecretRef !== config.signingSecretRef) {
    throw new Error("Slack Bridge local ingress signing-secret reference mismatch");
  }
  if (signingSecret.envelopeKeyId !== config.envelopeKeyId) {
    throw new Error("Slack Bridge local ingress signing-secret envelope mismatch");
  }
  if (signingSecret.aadVersion !== 1) {
    throw new Error("Slack Bridge local ingress signing-secret AAD mismatch");
  }
  if (
    (signingSecret.leaseOwner === null) !== (signingSecret.leaseExpiresAt === null)
    || (
      signingSecret.leaseOwner !== null
      && signingSecret.leaseExpiresAt !== null
      && signingSecret.leaseExpiresAt > now
    )
  ) {
    throw new Error("Slack Bridge local ingress signing-secret lease is active or inconsistent");
  }
  return {
    registrationId: registration.id,
    endpointId: endpoint.id,
    endpointRevision: endpoint.endpointRevision,
    exactRequestUrl: endpoint.exactRequestUrl,
    signingSecretRevision: signingSecret.secretRevision,
    signingSecretRef: signingSecret.encryptedSecretRef,
    envelopeKeyId: signingSecret.envelopeKeyId,
  };
}

async function loadLocalIngressAuthority(
  executor: DatabaseExecutor,
  config: LocalRuntimeConfig,
  lock: boolean,
): Promise<SlackBridgeLocalIngressAuthorityRows> {
  const registrationQuery = executor.select().from(externalAppRegistrations).where(eq(
    externalAppRegistrations.id,
    config.registrationId,
  )).limit(2);
  const registrations = lock ? await registrationQuery.for("update") : await registrationQuery;
  if (registrations.length !== 1) {
    throw new Error("Slack Bridge local ingress registration authority is missing or duplicated");
  }

  const endpointQuery = executor.select().from(externalAppIngressEndpoints).where(eq(
    externalAppIngressEndpoints.registrationId,
    config.registrationId,
  )).limit(2);
  const endpoints = lock ? await endpointQuery.for("update") : await endpointQuery;
  if (endpoints.length !== 1) {
    throw new Error("Slack Bridge local ingress endpoint authority is missing or duplicated");
  }

  const signingSecretQuery = executor.select().from(externalAppRegistrationSecrets).where(and(
    eq(externalAppRegistrationSecrets.registrationId, config.registrationId),
    eq(externalAppRegistrationSecrets.purpose, "signing_secret"),
  )).limit(2);
  const signingSecrets = lock ? await signingSecretQuery.for("update") : await signingSecretQuery;
  if (signingSecrets.length !== 1) {
    throw new Error("Slack Bridge local ingress signing-secret authority is missing or duplicated");
  }
  return {
    registration: registrations[0]!,
    endpoint: endpoints[0]!,
    signingSecret: signingSecrets[0]!,
  };
}

async function verifyLocalIngressAuthority(input: {
  config: LocalRuntimeConfig;
  db: Database;
  now: Date;
}): Promise<SlackBridgeLocalIngressAuthorityReceipt> {
  return input.db.transaction(async (tx) => {
    const rows = await loadLocalIngressAuthority(tx, input.config, false);
    return assertLocalIngressAuthority(input.config, rows, input.now);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * Verifies that the local owner-only runtime config and durable ingress rows
 * identify the same active test endpoint and signing-secret authority.
 */
export async function verifySlackBridgeLocalIngressAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { db?: Database; now?: () => Date } = {},
): Promise<SlackBridgeLocalIngressAuthorityReceipt | undefined> {
  const configPath = configPathFromEnv(env);
  if (!configPath) return undefined;
  const config = await readProtectedConfig(configPath);
  return verifyLocalIngressAuthority({
    config,
    db: dependencies.db ?? getDb(),
    now: (dependencies.now ?? currentDate)(),
  });
}

/**
 * Explicit test-only repair for a rotated local config. It updates the existing
 * endpoint and signing-secret rows atomically; it never creates or re-enables
 * authority and is forbidden in production.
 */
export async function rebindSlackBridgeLocalIngressAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { db?: Database; now?: () => Date } = {},
): Promise<SlackBridgeLocalIngressAuthorityReceipt> {
  const configPath = configPathFromEnv(env);
  if (!configPath) throw new Error("Slack Bridge local runtime config is required for ingress rebind");
  const config = await readProtectedConfig(configPath);
  const db = dependencies.db ?? getDb();
  const now = (dependencies.now ?? currentDate)();
  return db.transaction(async (tx) => {
    const before = await loadLocalIngressAuthority(tx, config, true);
    if (
      before.registration.provider !== "slack"
      || before.registration.environment !== "test"
      || before.registration.state !== "active"
      || before.registration.providerAppId !== config.providerAppId
      || before.registration.providerOAuthClientId !== config.providerOAuthClientId
    ) {
      throw new Error("Slack Bridge local ingress registration authority mismatch");
    }
    if (before.endpoint.environment !== "test" || before.endpoint.state !== "active") {
      throw new Error("Slack Bridge local ingress endpoint is not active test authority");
    }
    if (before.signingSecret.revokedAt !== null) {
      throw new Error("Slack Bridge local ingress signing secret is revoked");
    }
    if (
      (before.signingSecret.leaseOwner === null) !== (before.signingSecret.leaseExpiresAt === null)
      || (
        before.signingSecret.leaseOwner !== null
        && before.signingSecret.leaseExpiresAt !== null
        && before.signingSecret.leaseExpiresAt > now
      )
    ) {
      throw new Error("Slack Bridge local ingress signing-secret lease is active or inconsistent");
    }
    if (before.signingSecret.secretRevision > config.signingSecretRevision) {
      throw new Error("Slack Bridge local ingress signing-secret revision cannot move backward");
    }

    const authorityChanged = before.endpoint.exactRequestUrl !== eventsRequestUrl(config)
      || before.endpoint.signingSecretRevision !== config.signingSecretRevision
      || before.signingSecret.encryptedSecretRef !== config.signingSecretRef
      || before.signingSecret.envelopeKeyId !== config.envelopeKeyId
      || before.signingSecret.aadVersion !== 1
      || before.signingSecret.secretRevision !== config.signingSecretRevision;
    if (authorityChanged && before.endpoint.endpointRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Slack Bridge local ingress endpoint revision is exhausted");
    }

    if (authorityChanged) {
      await tx.update(externalAppRegistrationSecrets).set({
        encryptedSecretRef: config.signingSecretRef,
        envelopeKeyId: config.envelopeKeyId,
        aadVersion: 1,
        secretRevision: config.signingSecretRevision,
        updatedAt: now,
      }).where(eq(externalAppRegistrationSecrets.id, before.signingSecret.id));
      await tx.update(externalAppIngressEndpoints).set({
        exactRequestUrl: eventsRequestUrl(config),
        signingSecretRevision: config.signingSecretRevision,
        endpointRevision: before.endpoint.endpointRevision + 1,
        updatedAt: now,
      }).where(eq(externalAppIngressEndpoints.id, before.endpoint.id));
    }

    const after = await loadLocalIngressAuthority(tx, config, false);
    return assertLocalIngressAuthority(config, after, now);
  });
}

interface SlackBridgeLocalRealAuthorityRows {
  registration: typeof externalAppRegistrations.$inferSelect;
  install: typeof externalAppInstalls.$inferSelect;
  credential: typeof externalAppCredentials.$inferSelect;
  binding: typeof externalChannelBindings.$inferSelect;
  actors: Array<typeof externalActorProjections.$inferSelect>;
  addressability: Array<typeof externalAddressabilityProjections.$inferSelect>;
  authorPolicies: Array<typeof externalAuthorPolicies.$inferSelect>;
  effectiveAuthorNames: Map<string, string>;
}

type SlackBridgeLocalRealAuthorityPhase =
  | "after_binding_update"
  | "after_freshness_update"
  | "before_db_commit"
  | "after_db_commit"
  | "before_config_rename";

interface SlackBridgeLocalRealAuthorityDependencies {
  db?: Database;
  now?: () => Date;
  onPhase?: (phase: SlackBridgeLocalRealAuthorityPhase) => void | Promise<void>;
}

function normalizedConfigDigest(config: LocalRuntimeConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function sameRealAuthorityStaticIdentity(
  left: LocalRealAuthorityReceipt,
  right: LocalRealAuthorityReceipt,
): boolean {
  return left.schema === right.schema
    && left.registrationId === right.registrationId
    && left.installId === right.installId
    && left.providerAuthorityId === right.providerAuthorityId
    && left.providerConversationId === right.providerConversationId
    && left.providerConversationKind === right.providerConversationKind
    && left.privacyClass === right.privacyClass
    && left.bindingId === right.bindingId
    && left.bindingEpoch === right.bindingEpoch
    && left.consentRevision === right.consentRevision
    && left.actorCount === right.actorCount;
}

function sameRealAuthorityReceipt(
  left: LocalRealAuthorityReceipt,
  right: LocalRealAuthorityReceipt,
): boolean {
  return sameRealAuthorityCoordinates(left, right)
    && left.observedAt.getTime() === right.observedAt.getTime()
    && left.expiresAt.getTime() === right.expiresAt.getTime();
}

function sameRealAuthorityCoordinates(
  left: LocalRealAuthorityReceipt,
  right: LocalRealAuthorityReceipt,
): boolean {
  return sameRealAuthorityStaticIdentity(left, right)
    && left.connectionEpoch === right.connectionEpoch
    && left.credentialRevision === right.credentialRevision
    && left.memberRevision === right.memberRevision
    && left.contextRevision === right.contextRevision
    && left.actorsDigest === right.actorsDigest;
}

function configWithRealAuthority(
  config: LocalRuntimeConfig,
  receipt: LocalRealAuthorityReceipt,
  outboundBootstrap?: LocalOutboundConfig,
): LocalRuntimeConfig {
  if (config.outbound && outboundBootstrap) {
    throw new Error("Slack Bridge local real-authority replacement rejects outbound config piggyback");
  }
  if (!config.outbound && !outboundBootstrap) {
    throw new Error("Slack Bridge local real-authority replacement requires outbound config or bootstrap");
  }
  const outbound = config.outbound ?? outboundBootstrap!;
  const staleBindings = outbound.bindings;
  if (staleBindings.some((binding) =>
    binding.bindingId !== receipt.bindingId
    || binding.membership.registrationId !== receipt.registrationId
    || binding.membership.installId !== receipt.installId
    || binding.bindingEpoch !== receipt.bindingEpoch
    || binding.membership.bindingEpoch !== receipt.bindingEpoch
    || binding.oracle.bindingEpoch !== receipt.bindingEpoch
    || binding.consentRevision !== receipt.consentRevision
    || binding.connectionEpoch > receipt.connectionEpoch
    || binding.membership.connectionEpoch > receipt.connectionEpoch
    || binding.oracle.connectionEpoch > receipt.connectionEpoch
  )) {
    throw new Error("Slack Bridge local real-authority config has detached or future outbound authority");
  }
  const previousConnectionEpoch = receipt.connectionEpoch - 1;
  const previousMemberRevision = receipt.memberRevision - 1;
  const previousContextRevision = receipt.contextRevision - 1;
  if (
    previousConnectionEpoch < 1
    || previousMemberRevision < 1
    || previousContextRevision < 1
  ) {
    throw new Error("Slack Bridge local real-authority replacement has no previous revision");
  }
  let configIsCurrent = false;
  if (config.realAuthority) {
    if (sameRealAuthorityReceipt(config.realAuthority, receipt)) {
      configIsCurrent = true;
    } else if (
      sameRealAuthorityCoordinates(config.realAuthority, receipt)
      && config.realAuthority.observedAt < receipt.observedAt
    ) {
      // A fresh provider observation may renew only the bounded freshness
      // window while every identity and revision coordinate remains fixed.
      // Same-observation expiry extensions and timestamp rewinds fail closed.
      configIsCurrent = true;
    } else if (
      sameRealAuthorityStaticIdentity(config.realAuthority, receipt)
      && config.realAuthority.connectionEpoch === previousConnectionEpoch
      && config.realAuthority.credentialRevision === receipt.credentialRevision - 1
      && config.realAuthority.memberRevision === previousMemberRevision
      && config.realAuthority.contextRevision === previousContextRevision
      && config.realAuthority.observedAt <= receipt.observedAt
    ) {
      configIsCurrent = false;
    } else {
      throw new Error("Slack Bridge local real-authority config receipt is partial or skipped");
    }
  }
  if (staleBindings.some((binding) => {
    const expectedConnectionEpoch = configIsCurrent
      ? receipt.connectionEpoch
      : previousConnectionEpoch;
    const expectedMemberRevision = configIsCurrent
      ? receipt.memberRevision
      : previousMemberRevision;
    const expectedContextRevision = configIsCurrent
      ? receipt.contextRevision
      : previousContextRevision;
    return binding.connectionEpoch !== expectedConnectionEpoch
      || binding.membership.connectionEpoch !== expectedConnectionEpoch
      || binding.oracle.connectionEpoch !== expectedConnectionEpoch
      || binding.membership.receiptRevision !== expectedMemberRevision
      || binding.oracle.oracleReceiptRevision !== expectedContextRevision;
  })) {
    throw new Error("Slack Bridge local real-authority config revision is partial or skipped");
  }
  const expiresAt = receipt.expiresAt;
  return {
    ...config,
    outbound: {
      ...outbound,
      bindings: staleBindings.map((binding) => ({
        ...binding,
        connectionEpoch: receipt.connectionEpoch,
        membership: {
          ...binding.membership,
          registrationId: receipt.registrationId,
          installId: receipt.installId,
          bindingId: receipt.bindingId,
          connectionEpoch: receipt.connectionEpoch,
          bindingEpoch: receipt.bindingEpoch,
          providerAuthorityId: receipt.providerAuthorityId,
          providerConversationId: receipt.providerConversationId,
          receiptRevision: receipt.memberRevision,
          expiresAt,
        },
        oracle: {
          ...binding.oracle,
          bindingId: receipt.bindingId,
          connectionEpoch: receipt.connectionEpoch,
          bindingEpoch: receipt.bindingEpoch,
          privacyClass: receipt.privacyClass,
          oracleReceiptRevision: receipt.contextRevision,
          expiresAt,
        },
      })),
    },
    realAuthority: receipt,
  };
}

async function replaceProtectedConfigAtomically(input: {
  path: string;
  expectedDigest: string;
  config: LocalRuntimeConfig;
  beforeRename?: () => void | Promise<void>;
}): Promise<void> {
  const current = await readProtectedConfig(input.path);
  if (normalizedConfigDigest(current) !== input.expectedDigest) {
    throw new Error("Slack Bridge local runtime config changed during real-authority replacement");
  }
  const body = `${JSON.stringify(input.config)}\n`;
  if (Buffer.byteLength(body) <= 0 || Buffer.byteLength(body) > MAX_CONFIG_BYTES) {
    throw new Error("Slack Bridge local runtime config size is invalid after real-authority replacement");
  }
  // Parsing before the database commit is not enough: validate the exact bytes
  // that will become authoritative before touching the destination inode.
  parseConfig(body);
  const temporaryPath = join(
    dirname(input.path),
    `.${basename(input.path)}.authority-${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let renamed = false;
  try {
    await handle.writeFile(body, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    await input.beforeRename?.();
    const beforeRename = await readProtectedConfig(input.path);
    if (normalizedConfigDigest(beforeRename) !== input.expectedDigest) {
      throw new Error("Slack Bridge local runtime config changed during real-authority replacement");
    }
    await rename(temporaryPath, input.path);
    renamed = true;
    const directory = await open(dirname(input.path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    try {
      await handle.close();
    } catch {
      // The happy path closes before rename so Windows/POSIX both permit it.
    }
    if (!renamed) await rm(temporaryPath, { force: true });
  }
  await readProtectedConfig(input.path);
}

async function loadLocalRealAuthority(
  executor: DatabaseExecutor,
  receipt: LocalRealAuthorityReceipt,
  lock: boolean,
): Promise<SlackBridgeLocalRealAuthorityRows> {
  const registrationQuery = executor.select().from(externalAppRegistrations).where(eq(
    externalAppRegistrations.id,
    receipt.registrationId,
  )).limit(2);
  const registrations = lock ? await registrationQuery.for("update") : await registrationQuery;
  if (registrations.length !== 1) {
    throw new Error("Slack Bridge local real-authority registration is missing or duplicated");
  }

  const installQuery = executor.select().from(externalAppInstalls).where(and(
    eq(externalAppInstalls.registrationId, receipt.registrationId),
    eq(externalAppInstalls.state, "active"),
  )).limit(2);
  const installs = lock ? await installQuery.for("update") : await installQuery;
  if (installs.length !== 1 || installs[0]!.id !== receipt.installId) {
    throw new Error("Slack Bridge local real-authority active install is missing or duplicated");
  }

  const credentialQuery = executor.select().from(externalAppCredentials).where(eq(
    externalAppCredentials.installId,
    receipt.installId,
  )).limit(2);
  const credentials = lock ? await credentialQuery.for("update") : await credentialQuery;
  if (credentials.length !== 1) {
    throw new Error("Slack Bridge local real-authority credential is missing or duplicated");
  }

  const bindingQuery = executor.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.registrationId, receipt.registrationId),
    inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
  )).limit(2);
  const bindings = lock ? await bindingQuery.for("update") : await bindingQuery;
  if (bindings.length !== 1 || bindings[0]!.id !== receipt.bindingId) {
    throw new Error("Slack Bridge local real-authority binding is missing or duplicated");
  }

  const actorQuery = executor.select().from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, receipt.registrationId),
    eq(externalActorProjections.installId, receipt.installId),
  )).limit(receipt.actorCount + 1);
  const actors = lock ? await actorQuery.for("update") : await actorQuery;
  if (actors.length !== receipt.actorCount) {
    throw new Error("Slack Bridge local real-authority actor set is incomplete or has extras");
  }

  const addressabilityQuery = executor.select().from(externalAddressabilityProjections).where(eq(
    externalAddressabilityProjections.bindingId,
    receipt.bindingId,
  )).limit(receipt.actorCount + 1);
  const addressability = lock ? await addressabilityQuery.for("update") : await addressabilityQuery;
  if (addressability.length !== receipt.actorCount) {
    throw new Error("Slack Bridge local real-authority addressability set is incomplete or has extras");
  }

  const authorPolicyQuery = executor.select().from(externalAuthorPolicies).where(and(
    eq(externalAuthorPolicies.serverId, bindings[0]!.serverId),
    eq(externalAuthorPolicies.provider, "slack"),
    eq(externalAuthorPolicies.appRegistrationId, receipt.registrationId),
    eq(externalAuthorPolicies.installId, receipt.installId),
    eq(externalAuthorPolicies.bindingId, receipt.bindingId),
    eq(externalAuthorPolicies.bindingEpoch, receipt.bindingEpoch),
    eq(externalAuthorPolicies.consentRevision, receipt.consentRevision),
    eq(externalAuthorPolicies.state, "granted"),
  ));
  const authorPolicies = lock ? await authorPolicyQuery.for("update") : await authorPolicyQuery;
  const effectiveAuthorNames = new Map<string, string>();
  for (const authorPolicy of authorPolicies) {
    const authorQuery = authorPolicy.authorType === "user"
      ? executor.select({ name: users.name, displayName: users.displayName }).from(users)
        .where(eq(users.id, authorPolicy.authorId)).limit(2)
      : executor.select({ name: agents.name, displayName: agents.displayName }).from(agents)
        .where(and(
          eq(agents.id, authorPolicy.authorId),
          isNull(agents.deletedAt),
        )).limit(2);
    const authors = lock ? await authorQuery.for("update") : await authorQuery;
    if (authors.length !== 1) {
      throw new Error("Slack Bridge local real-authority policy author is missing or duplicated");
    }
    effectiveAuthorNames.set(
      authorPolicy.id,
      authorPolicy.authorType === "user"
        ? effectiveUserSenderName(authors[0]!)
        : effectiveAgentSenderName(authors[0]!),
    );
  }

  return {
    registration: registrations[0]!,
    install: installs[0]!,
    credential: credentials[0]!,
    binding: bindings[0]!,
    actors,
    addressability,
    authorPolicies,
    effectiveAuthorNames,
  };
}

function assertLocalRealAuthority(input: {
  config: LocalRuntimeConfig;
  receipt: LocalRealAuthorityReceipt;
  rows: SlackBridgeLocalRealAuthorityRows;
  now: Date;
  verifyAuthorDisplayName?: boolean;
  verifyReceiptFreshness?: boolean;
}): SlackBridgeLocalRealAuthorityVerificationReceipt {
  const { config, receipt, rows, now } = input;
  if (
    config.registrationId !== receipt.registrationId
    || rows.registration.id !== receipt.registrationId
    || rows.registration.provider !== "slack"
    || rows.registration.environment !== "test"
    || rows.registration.state !== "active"
    || rows.registration.providerAppId !== config.providerAppId
    || rows.registration.providerOAuthClientId !== config.providerOAuthClientId
  ) {
    throw new Error("Slack Bridge local real-authority registration mismatch");
  }
  if (
    rows.install.id !== receipt.installId
    || rows.install.registrationId !== receipt.registrationId
    || rows.install.serverId !== rows.binding.serverId
    || rows.install.state !== "active"
    || rows.install.connectionEpoch !== receipt.connectionEpoch
    || rows.install.credentialRevision !== receipt.credentialRevision
    || rows.install.providerAppId !== config.providerAppId
    || rows.install.authorityType !== "team"
    || rows.install.providerTeamId !== receipt.providerAuthorityId
    || rows.install.providerEnterpriseId !== null
    || rows.install.providerAuthorityId !== receipt.providerAuthorityId
  ) {
    throw new Error("Slack Bridge local real-authority install mismatch");
  }
  if (
    rows.credential.installId !== receipt.installId
    || rows.credential.state !== "active"
    || rows.credential.credentialRevision !== receipt.credentialRevision
    || rows.credential.envelopeKeyId !== config.envelopeKeyId
    || rows.credential.aadVersion !== 1
    || rows.credential.revokedAt !== null
    || rows.credential.leaseOwner !== null
    || rows.credential.leaseExpiresAt !== null
  ) {
    throw new Error("Slack Bridge local real-authority credential mismatch");
  }
  if (
    rows.binding.id !== receipt.bindingId
    || rows.binding.registrationId !== receipt.registrationId
    || rows.binding.installId !== receipt.installId
    || rows.binding.state !== "active"
    || rows.binding.connectionEpoch !== receipt.connectionEpoch
    || rows.binding.bindingEpoch !== receipt.bindingEpoch
    || rows.binding.providerConversationId !== receipt.providerConversationId
    || rows.binding.providerConversationKind !== receipt.providerConversationKind
    || rows.binding.privacyClass !== receipt.privacyClass
    || rows.binding.grantEpoch !== rows.install.grantEpoch
  ) {
    throw new Error("Slack Bridge local real-authority binding mismatch");
  }
  if (!config.outbound || config.outbound.bindings.some((binding) =>
    binding.serverId !== rows.binding.serverId
    || binding.bindingId !== rows.binding.id
  )) {
    throw new Error("Slack Bridge local real-authority Raft target mismatch");
  }
  if (input.verifyReceiptFreshness !== false && (receipt.expiresAt <= now || receipt.observedAt > now)) {
    throw new Error("Slack Bridge local real-authority receipt is stale or from the future");
  }

  const actors = rows.actors.map((actor): LocalRealAuthorityActor => {
    if (
      actor.provider !== "slack"
      || actor.appRegistrationId !== receipt.registrationId
      || actor.installId !== receipt.installId
      || actor.workspaceId !== receipt.providerAuthorityId
      || actor.state !== "active"
      || actor.deactivated
      || actor.observedAt.getTime() !== receipt.observedAt.getTime()
      || (actor.actorKind !== "human" && actor.actorKind !== "guest" && actor.actorKind !== "remote")
    ) {
      throw new Error("Slack Bridge local real-authority actor mismatch");
    }
    return {
      externalActorId: actor.externalActorId,
      displayName: actor.displayName,
      handles: sortedUniqueStrings(actor.handles, "stored actor handles"),
      actorKind: actor.actorKind,
      projectionRevision: actor.projectionRevision,
    };
  }).sort((left, right) => left.externalActorId.localeCompare(right.externalActorId));
  if (digestRealAuthorityActors(actors) !== receipt.actorsDigest) {
    throw new Error("Slack Bridge local real-authority actor digest mismatch");
  }

  const actorIds = new Set(rows.actors.map((actor) => actor.id));
  const addressedActorIds = new Set<string>();
  for (const address of rows.addressability) {
    if (
      !actorIds.has(address.projectionId)
      || addressedActorIds.has(address.projectionId)
      || address.provider !== "slack"
      || address.appRegistrationId !== receipt.registrationId
      || address.installId !== receipt.installId
      || address.workspaceId !== receipt.providerAuthorityId
      || address.connectionEpoch !== receipt.connectionEpoch
      || address.bindingId !== receipt.bindingId
      || address.bindingEpoch !== receipt.bindingEpoch
      || address.conversationId !== receipt.providerConversationId
      || address.memberRevision !== receipt.memberRevision
      || address.contextRevision !== receipt.contextRevision
      || address.state !== "active"
      || address.observedAt.getTime() !== receipt.observedAt.getTime()
      || address.expiresAt.getTime() !== receipt.expiresAt.getTime()
    ) {
      throw new Error("Slack Bridge local real-authority addressability mismatch");
    }
    addressedActorIds.add(address.projectionId);
  }
  if (addressedActorIds.size !== receipt.actorCount) {
    throw new Error("Slack Bridge local real-authority addressability is incomplete");
  }
  for (const authorPolicy of rows.authorPolicies) {
    if (
      authorPolicy.serverId !== rows.binding.serverId
      || authorPolicy.provider !== "slack"
      || authorPolicy.appRegistrationId !== receipt.registrationId
      || authorPolicy.installId !== receipt.installId
      || authorPolicy.bindingId !== receipt.bindingId
      || authorPolicy.bindingEpoch !== receipt.bindingEpoch
      || authorPolicy.consentRevision !== receipt.consentRevision
      || authorPolicy.state !== "granted"
      || authorPolicy.fallbackKind !== (authorPolicy.authorType === "user" ? "human" : "agent")
    ) {
      throw new Error("Slack Bridge local real-authority author policy mismatch");
    }
    if (
      input.verifyAuthorDisplayName !== false
      && authorPolicy.displayName !== rows.effectiveAuthorNames.get(authorPolicy.id)
    ) {
      throw new Error("Slack Bridge local real-authority author policy display name mismatch");
    }
  }
  return {
    registrationId: receipt.registrationId,
    installId: receipt.installId,
    connectionEpoch: receipt.connectionEpoch,
    credentialRevision: receipt.credentialRevision,
    bindingId: receipt.bindingId,
    bindingEpoch: receipt.bindingEpoch,
    memberRevision: receipt.memberRevision,
    contextRevision: receipt.contextRevision,
    actorCount: actors.length,
    addressabilityCount: rows.addressability.length,
    authorPolicyCount: rows.authorPolicies.length,
    actorsDigest: receipt.actorsDigest,
  };
}

async function assertLocalRealAuthorityOutboundTargets(input: {
  executor: DatabaseExecutor;
  config: LocalRuntimeConfig;
  rows: SlackBridgeLocalRealAuthorityRows;
}): Promise<void> {
  const outbound = input.config.outbound;
  if (!outbound) {
    throw new Error("Slack Bridge local real-authority Raft target mismatch");
  }
  for (const binding of outbound.bindings) {
    if (binding.level === "top_level") {
      if (binding.sourceConversationId !== input.rows.binding.channelId) {
        throw new Error("Slack Bridge local real-authority Raft target mismatch");
      }
      continue;
    }

    const [threadChannels, roots] = await Promise.all([
      input.executor.select({
        id: channels.id,
        serverId: channels.serverId,
        type: channels.type,
        parentMessageId: channels.parentMessageId,
        deletedAt: channels.deletedAt,
      }).from(channels).where(eq(channels.id, binding.sourceConversationId)).limit(2),
      input.executor.select({
        id: messages.id,
        channelId: messages.channelId,
        threadId: messages.threadId,
      }).from(messages).where(eq(messages.id, binding.canonicalRootMessageId!)).limit(2),
    ]);
    const thread = threadChannels.length === 1 ? threadChannels[0]! : null;
    const root = roots.length === 1 ? roots[0]! : null;
    if (
      !thread
      || thread.serverId !== input.rows.binding.serverId
      || thread.type !== "thread"
      || thread.parentMessageId !== binding.canonicalRootMessageId
      || thread.deletedAt !== null
      || !root
      || root.channelId !== input.rows.binding.channelId
      || root.threadId !== thread.id
    ) {
      throw new Error("Slack Bridge local real-authority Raft target mismatch");
    }
  }
}

async function verifyLocalRealAuthority(input: {
  config: LocalRuntimeConfig;
  db: Database;
  now: Date;
}): Promise<SlackBridgeLocalRealAuthorityVerificationReceipt | undefined> {
  if (!input.config.realAuthority) return undefined;
  return input.db.transaction(async (tx) => {
    const rows = await loadLocalRealAuthority(tx, input.config.realAuthority!, false);
    const receipt = assertLocalRealAuthority({
      config: input.config,
      receipt: input.config.realAuthority!,
      rows,
      now: input.now,
    });
    await assertLocalRealAuthorityOutboundTargets({ executor: tx, config: input.config, rows });
    return receipt;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * Read-only pre-start verification for a source-controlled real-authority
 * replacement. It proves that every persisted actor/addressability row and
 * every outbound receipt still matches the owner-only config.
 */
export async function verifySlackBridgeLocalRealAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { db?: Database; now?: () => Date } = {},
): Promise<SlackBridgeLocalRealAuthorityVerificationReceipt | undefined> {
  const configPath = configPathFromEnv(env);
  if (!configPath) return undefined;
  const config = await readProtectedConfig(configPath);
  return verifyLocalRealAuthority({
    config,
    db: dependencies.db ?? getDb(),
    now: (dependencies.now ?? currentDate)(),
  });
}

/**
 * Existing-only, test-environment replacement of stale post-OAuth channel,
 * actor, and addressability authority. Database rows move in one transaction;
 * the owner-only outbound config is atomically replaced only after commit.
 * A config-write failure therefore remains fail-closed and is repairable by
 * replaying the exact same input packet without creating or revising rows.
 */
export async function replaceSlackBridgeLocalRealAuthorityFromEnv(
  authorityInput: SlackBridgeLocalRealAuthorityInput,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SlackBridgeLocalRealAuthorityDependencies = {},
): Promise<SlackBridgeLocalRealAuthorityVerificationReceipt> {
  const configPath = configPathFromEnv(env);
  if (!configPath) throw new Error("Slack Bridge local runtime config is required for real-authority replacement");
  const config = await readProtectedConfig(configPath);
  const configDigest = normalizedConfigDigest(config);
  const { receipt, actors } = normalizeRealAuthorityInput(authorityInput);
  if (receipt.registrationId !== config.registrationId) {
    throw new Error("Slack Bridge local real-authority input registration mismatch");
  }
  const now = (dependencies.now ?? currentDate)();
  if (!validNow(now) || receipt.observedAt > now || receipt.expiresAt <= now) {
    throw new Error("Slack Bridge local real-authority input is stale or from the future");
  }
  const outboundBootstrap = authorityInput.outboundBootstrap === undefined
    ? undefined
    : parseOutboundConfig(authorityInput.outboundBootstrap);
  if (config.outbound && outboundBootstrap) {
    throw new Error("Slack Bridge local real-authority replacement rejects outbound config piggyback");
  }
  if (!config.outbound && !outboundBootstrap) {
    throw new Error("Slack Bridge local real-authority replacement requires outbound config or bootstrap");
  }
  const db = dependencies.db ?? getDb();
  let nextConfig: LocalRuntimeConfig | undefined;

  await db.transaction(async (tx) => {
    const rows = await loadLocalRealAuthority(tx, receipt, true);
    const candidateConfig = configWithRealAuthority(config, receipt, outboundBootstrap);
    // The bootstrap may name only the already-locked binding target. Validate
    // the complete post-commit bytes before any durable row is changed.
    parseConfig(JSON.stringify(candidateConfig));
    if (
      rows.install.connectionEpoch !== receipt.connectionEpoch
      || rows.install.credentialRevision !== receipt.credentialRevision
      || rows.install.providerAuthorityId !== receipt.providerAuthorityId
      || rows.install.providerAppId !== config.providerAppId
      || rows.credential.state !== "active"
      || rows.credential.credentialRevision !== receipt.credentialRevision
      || rows.credential.envelopeKeyId !== config.envelopeKeyId
      || rows.credential.aadVersion !== 1
      || rows.credential.revokedAt !== null
      || rows.credential.leaseOwner !== null
      || rows.credential.leaseExpiresAt !== null
    ) {
      throw new Error("Slack Bridge local real-authority current install/credential precheck failed");
    }
    if (
      rows.binding.state !== "active"
      || rows.binding.installId !== receipt.installId
      || rows.binding.bindingEpoch !== receipt.bindingEpoch
      || rows.binding.connectionEpoch > receipt.connectionEpoch
      || receipt.connectionEpoch - rows.binding.connectionEpoch > 1
    ) {
      throw new Error("Slack Bridge local real-authority existing binding precheck failed");
    }
    if (!config.outbound && candidateConfig.outbound!.bindings.some((binding) =>
      binding.serverId !== rows.binding.serverId
      || binding.sourceConversationId !== rows.binding.channelId
      || binding.bindingId !== rows.binding.id
    )) {
      throw new Error("Slack Bridge local real-authority bootstrap Raft target mismatch");
    }
    // Reject every configured Raft surface before any authority revision is
    // mutated. A transaction rollback is not an excuse to let a wrong thread
    // target reach the binding/actor update phases.
    await assertLocalRealAuthorityOutboundTargets({ executor: tx, config: candidateConfig, rows });
    const actorInput = new Map(actors.map((actor) => [actor.externalActorId, actor]));
    const addressByProjection = new Map(rows.addressability.map((address) => [address.projectionId, address]));
    let alreadyCurrent = false;
    let freshnessRenewal = false;
    try {
      assertLocalRealAuthority({
        config: candidateConfig,
        receipt,
        rows,
        now,
        verifyAuthorDisplayName: false,
      });
      alreadyCurrent = true;
    } catch {
      const currentReceipt = config.realAuthority;
      if (
        currentReceipt
        && sameRealAuthorityCoordinates(currentReceipt, receipt)
        && currentReceipt.observedAt < receipt.observedAt
      ) {
        // Prove the complete persisted preimage against the currently sealed
        // receipt before changing only observation/expiry timestamps. The old
        // receipt may be expired; identity/revision conservation must still be
        // exact and no stale observation may be extended in place.
        assertLocalRealAuthority({
          config,
          receipt: currentReceipt,
          rows,
          now,
          verifyAuthorDisplayName: false,
          verifyReceiptFreshness: false,
        });
        await assertLocalRealAuthorityOutboundTargets({ executor: tx, config, rows });
        alreadyCurrent = true;
        freshnessRenewal = true;
      } else {
        // A stale all-previous-revision preimage is replaceable. A mixture of
        // current and stale coordinates is partial authority and must not be
        // normalized in place under the same revisions.
        if (
          rows.binding.connectionEpoch === receipt.connectionEpoch
          || rows.actors.some((actor) =>
            actorInput.get(actor.externalActorId)?.projectionRevision === actor.projectionRevision
          )
          || rows.addressability.some((address) =>
            address.connectionEpoch === receipt.connectionEpoch
            || address.memberRevision === receipt.memberRevision
            || address.contextRevision === receipt.contextRevision
          )
        ) {
          throw new Error("Slack Bridge local real-authority partial current state is not replaceable");
        }
        if (receipt.connectionEpoch !== rows.binding.connectionEpoch + 1) {
          throw new Error("Slack Bridge local real-authority binding revision must advance exactly once");
        }
      }
    }
    for (const actor of rows.actors) {
      const desired = actorInput.get(actor.externalActorId);
      if (
        !desired
        || actor.workspaceId !== receipt.providerAuthorityId
        || actor.projectionRevision > desired.projectionRevision
        || desired.projectionRevision - actor.projectionRevision > 1
        || (!alreadyCurrent && desired.projectionRevision !== actor.projectionRevision + 1)
      ) {
        throw new Error("Slack Bridge local real-authority existing actor precheck failed");
      }
    }
    for (const actor of rows.actors) {
      const address = addressByProjection.get(actor.id);
      if (
        !address
        || address.connectionEpoch > receipt.connectionEpoch
        || address.bindingEpoch !== receipt.bindingEpoch
        || address.memberRevision > receipt.memberRevision
        || address.contextRevision > receipt.contextRevision
        || receipt.memberRevision - address.memberRevision > 1
        || receipt.contextRevision - address.contextRevision > 1
        || (!alreadyCurrent && receipt.memberRevision !== address.memberRevision + 1)
        || (!alreadyCurrent && receipt.contextRevision !== address.contextRevision + 1)
      ) {
        throw new Error("Slack Bridge local real-authority existing addressability precheck failed");
      }
    }

    if (!alreadyCurrent) {
      await tx.update(externalChannelBindings).set({
        installId: receipt.installId,
        providerConversationId: receipt.providerConversationId,
        providerConversationKind: receipt.providerConversationKind,
        privacyClass: receipt.privacyClass,
        grantEpoch: rows.install.grantEpoch,
        connectionEpoch: receipt.connectionEpoch,
        updatedAt: now,
      }).where(eq(externalChannelBindings.id, receipt.bindingId));
      await dependencies.onPhase?.("after_binding_update");

      for (const actor of rows.actors) {
        const desired = actorInput.get(actor.externalActorId)!;
        await tx.update(externalActorProjections).set({
          workspaceId: receipt.providerAuthorityId,
          displayName: desired.displayName,
          handles: desired.handles,
          actorKind: desired.actorKind,
          state: "active",
          deactivated: false,
          projectionRevision: desired.projectionRevision,
          observedAt: receipt.observedAt,
          updatedAt: now,
        }).where(eq(externalActorProjections.id, actor.id));
        await tx.update(externalAddressabilityProjections).set({
          provider: "slack",
          appRegistrationId: receipt.registrationId,
          installId: receipt.installId,
          workspaceId: receipt.providerAuthorityId,
          connectionEpoch: receipt.connectionEpoch,
          bindingId: receipt.bindingId,
          bindingEpoch: receipt.bindingEpoch,
          conversationId: receipt.providerConversationId,
          memberRevision: receipt.memberRevision,
          contextRevision: receipt.contextRevision,
          state: "active",
          observedAt: receipt.observedAt,
          expiresAt: receipt.expiresAt,
          updatedAt: now,
        }).where(eq(externalAddressabilityProjections.id, addressByProjection.get(actor.id)!.id));
      }
    } else if (freshnessRenewal) {
      for (const actor of rows.actors) {
        await tx.update(externalActorProjections).set({
          observedAt: receipt.observedAt,
          updatedAt: now,
        }).where(eq(externalActorProjections.id, actor.id));
        await tx.update(externalAddressabilityProjections).set({
          observedAt: receipt.observedAt,
          expiresAt: receipt.expiresAt,
          updatedAt: now,
        }).where(eq(externalAddressabilityProjections.id, addressByProjection.get(actor.id)!.id));
      }
      await dependencies.onPhase?.("after_freshness_update");
    }

    const after = await loadLocalRealAuthority(tx, receipt, false);
    assertLocalRealAuthority({ config: candidateConfig, receipt, rows: after, now });
    await assertLocalRealAuthorityOutboundTargets({ executor: tx, config: candidateConfig, rows: after });
    nextConfig = candidateConfig;
    await dependencies.onPhase?.("before_db_commit");
  });
  await dependencies.onPhase?.("after_db_commit");

  if (!nextConfig) {
    throw new Error("Slack Bridge local real-authority replacement did not produce config authority");
  }
  if (normalizedConfigDigest(nextConfig) !== configDigest) {
    await replaceProtectedConfigAtomically({
      path: configPath,
      expectedDigest: configDigest,
      config: nextConfig,
      beforeRename: () => dependencies.onPhase?.("before_config_rename"),
    });
  }
  const verified = await verifySlackBridgeLocalRealAuthorityFromEnv(env, {
    db,
    now: () => now,
  });
  if (!verified) throw new Error("Slack Bridge local real-authority verification receipt is missing");
  return verified;
}

interface LocalManifestAuthorityObservation {
  schema: typeof MANIFEST_AUTHORITY_SCHEMA;
  registrationId: string;
  receiptRevision: number;
  managerCredentialRevision: number;
  providerAppId: string;
  normalizedManifestHash: string;
  normalizedScopes: string[];
  normalizedEvents: string[];
  normalizedSettings: Record<string, unknown>;
  observedAt: Date;
  expiresAt: Date;
}

type SlackBridgeLocalManifestAuthorityPhase =
  | "after_manifest_insert"
  | "before_db_commit"
  | "after_db_commit";

interface SlackBridgeLocalManifestAuthorityDependencies {
  db?: Database;
  now?: () => Date;
  onPhase?: (phase: SlackBridgeLocalManifestAuthorityPhase) => void | Promise<void>;
}

function isBoundedManifestJsonValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): boolean {
  state.nodes += 1;
  if (state.nodes > 512 || depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isBoundedManifestJsonValue(item, state, depth + 1));
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, item]) =>
    key.length > 0 && isBoundedManifestJsonValue(item, state, depth + 1)
  );
}

function normalizeManifestSettings(value: unknown): Record<string, unknown> {
  if (!object(value) || !isBoundedManifestJsonValue(value, { nodes: 0 })) {
    throw new Error("Slack Bridge local manifest-authority settings are invalid");
  }
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("Slack Bridge local manifest-authority settings are invalid");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeManifestAuthorityInput(
  value: SlackBridgeLocalManifestAuthorityInput,
): LocalManifestAuthorityObservation {
  const input = object(value);
  if (!input || input.schema !== MANIFEST_AUTHORITY_SCHEMA) {
    throw new Error("Slack Bridge local manifest-authority schema is invalid");
  }
  const observedAt = requiredDate(input, "observedAt");
  const expiresAt = requiredDate(input, "expiresAt");
  if (
    expiresAt <= observedAt
    || expiresAt.getTime() - observedAt.getTime() > MANIFEST_AUTHORITY_MAX_TTL_MS
  ) {
    throw new Error("Slack Bridge local manifest-authority freshness window is invalid");
  }
  const normalizedScopes = sortedUniqueStrings(input.normalizedScopes, "manifest scopes");
  const normalizedEvents = sortedUniqueStrings(input.normalizedEvents, "manifest events");
  const normalizedSettings = normalizeManifestSettings(input.normalizedSettings);
  const observation: LocalManifestAuthorityObservation = {
    schema: MANIFEST_AUTHORITY_SCHEMA,
    registrationId: requiredNestedString(input, "registrationId"),
    receiptRevision: requiredPositiveInteger(input, "receiptRevision"),
    managerCredentialRevision: requiredPositiveInteger(input, "managerCredentialRevision"),
    providerAppId: requiredNestedString(input, "providerAppId"),
    normalizedManifestHash: requiredNestedString(input, "normalizedManifestHash"),
    normalizedScopes,
    normalizedEvents,
    normalizedSettings,
    observedAt,
    expiresAt,
  };
  if (Buffer.byteLength(canonicalJson({
    ...observation,
    observedAt: observation.observedAt.toISOString(),
    expiresAt: observation.expiresAt.toISOString(),
  }), "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("Slack Bridge local manifest-authority observation is too large");
  }
  return observation;
}

function sameManifestStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameManifestObservation(
  row: typeof externalAppManifestReceipts.$inferSelect,
  observation: LocalManifestAuthorityObservation,
): boolean {
  return row.registrationId === observation.registrationId
    && row.receiptRevision === observation.receiptRevision
    && row.managerCredentialRevision === observation.managerCredentialRevision
    && row.providerAppId === observation.providerAppId
    && row.normalizedManifestHash === observation.normalizedManifestHash
    && sameManifestStrings(row.normalizedScopes, observation.normalizedScopes)
    && sameManifestStrings(row.normalizedEvents, observation.normalizedEvents)
    && canonicalJson(row.normalizedSettings) === canonicalJson(observation.normalizedSettings)
    && row.status === "valid"
    && row.errorCode === null
    && row.observedAt.getTime() === observation.observedAt.getTime()
    && row.expiresAt.getTime() === observation.expiresAt.getTime();
}

function manifestVerificationReceipt(
  observation: LocalManifestAuthorityObservation,
): SlackBridgeLocalManifestAuthorityVerificationReceipt {
  return {
    registrationId: observation.registrationId,
    receiptRevision: observation.receiptRevision,
    managerCredentialRevision: observation.managerCredentialRevision,
    providerAppId: observation.providerAppId,
    normalizedManifestHash: observation.normalizedManifestHash,
    observedAt: observation.observedAt.toISOString(),
    expiresAt: observation.expiresAt.toISOString(),
  };
}

/**
 * Append one provider-authoritative manifest observation for the local test
 * bridge. Existing receipts are immutable. The registration row serializes
 * competing observations; an exact lost-response replay is a no-op, while a
 * different observation at the same revision fails closed.
 */
export async function renewSlackBridgeLocalManifestAuthorityFromEnv(
  manifestInput: SlackBridgeLocalManifestAuthorityInput,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SlackBridgeLocalManifestAuthorityDependencies = {},
): Promise<SlackBridgeLocalManifestAuthorityVerificationReceipt> {
  const configPath = configPathFromEnv(env);
  if (!configPath) throw new Error("Slack Bridge local runtime config is required for manifest renewal");
  const config = await readProtectedConfig(configPath);
  const observation = normalizeManifestAuthorityInput(manifestInput);
  if (
    observation.registrationId !== config.registrationId
    || observation.providerAppId !== config.providerAppId
  ) {
    throw new Error("Slack Bridge local manifest-authority config identity mismatch");
  }
  const now = (dependencies.now ?? currentDate)();
  if (!validNow(now) || observation.observedAt > now || observation.expiresAt <= now) {
    throw new Error("Slack Bridge local manifest-authority input is stale or from the future");
  }
  if (!config.realAuthority) {
    throw new Error("Slack Bridge local manifest-authority requires sealed real authority");
  }
  const realAuthority = config.realAuthority;
  const db = dependencies.db ?? getDb();

  await db.transaction(async (tx) => {
    const registrations = await tx.select().from(externalAppRegistrations).where(eq(
      externalAppRegistrations.id,
      observation.registrationId,
    )).limit(2).for("update");
    if (registrations.length !== 1) {
      throw new Error("Slack Bridge local manifest-authority registration is missing or duplicated");
    }
    const registration = registrations[0]!;
    if (
      registration.provider !== "slack"
      || registration.environment !== "test"
      || registration.state !== "active"
      || registration.providerAppId !== observation.providerAppId
      || registration.capabilityManifestHash !== observation.normalizedManifestHash
    ) {
      throw new Error("Slack Bridge local manifest-authority registration mismatch");
    }

    const installs = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.id, realAuthority.installId),
      eq(externalAppInstalls.registrationId, observation.registrationId),
    )).limit(2).for("update");
    if (installs.length !== 1) {
      throw new Error("Slack Bridge local manifest-authority install is missing or duplicated");
    }
    const install = installs[0]!;
    if (
      install.state !== "active"
      || install.providerAppId !== observation.providerAppId
      || install.id !== realAuthority.installId
      || !sameManifestStrings(install.installedScopes, observation.normalizedScopes)
    ) {
      throw new Error("Slack Bridge local manifest-authority install mismatch");
    }

    const secrets = await tx.select().from(externalAppRegistrationSecrets).where(eq(
      externalAppRegistrationSecrets.registrationId,
      observation.registrationId,
    )).limit(3).for("update");
    const manager = secrets.filter((secret) => secret.purpose === "manifest_manager");
    const signing = secrets.filter((secret) => secret.purpose === "signing_secret");
    if (
      secrets.length !== 2
      || manager.length !== 1
      || signing.length !== 1
      || manager[0]!.revokedAt !== null
      || signing[0]!.revokedAt !== null
      || manager[0]!.leaseOwner !== null
      || manager[0]!.leaseExpiresAt !== null
      || signing[0]!.leaseOwner !== null
      || signing[0]!.leaseExpiresAt !== null
      || !manager[0]!.encryptedSecretRef.trim()
      || !signing[0]!.encryptedSecretRef.trim()
      || manager[0]!.envelopeKeyId !== config.envelopeKeyId
      || signing[0]!.envelopeKeyId !== config.envelopeKeyId
      || manager[0]!.aadVersion !== 1
      || signing[0]!.aadVersion !== 1
      || manager[0]!.secretRevision !== observation.managerCredentialRevision
      || signing[0]!.secretRevision !== config.signingSecretRevision
      || signing[0]!.encryptedSecretRef !== config.signingSecretRef
    ) {
      throw new Error("Slack Bridge local manifest-authority secret reference mismatch");
    }

    const receipts = await tx.select().from(externalAppManifestReceipts).where(eq(
      externalAppManifestReceipts.registrationId,
      observation.registrationId,
    )).orderBy(desc(externalAppManifestReceipts.receiptRevision)).limit(2).for("update");
    const latest = receipts[0];
    if (!latest) {
      throw new Error("Slack Bridge local manifest-authority current receipt is missing");
    }
    if (latest.receiptRevision === observation.receiptRevision) {
      if (!sameManifestObservation(latest, observation)) {
        throw new Error("Slack Bridge local manifest-authority replay conflicts with current receipt");
      }
    } else {
      if (
        observation.receiptRevision !== latest.receiptRevision + 1
        || latest.status !== "valid"
        || latest.errorCode !== null
        || latest.managerCredentialRevision !== observation.managerCredentialRevision
        || latest.providerAppId !== observation.providerAppId
        || latest.normalizedManifestHash !== observation.normalizedManifestHash
        || !sameManifestStrings(latest.normalizedScopes, observation.normalizedScopes)
        || !sameManifestStrings(latest.normalizedEvents, observation.normalizedEvents)
        || canonicalJson(latest.normalizedSettings) !== canonicalJson(observation.normalizedSettings)
        || latest.observedAt >= observation.observedAt
      ) {
        throw new Error("Slack Bridge local manifest-authority current receipt preimage mismatch");
      }
      await tx.insert(externalAppManifestReceipts).values({
        registrationId: observation.registrationId,
        receiptRevision: observation.receiptRevision,
        managerCredentialRevision: observation.managerCredentialRevision,
        providerAppId: observation.providerAppId,
        normalizedManifestHash: observation.normalizedManifestHash,
        normalizedScopes: observation.normalizedScopes,
        normalizedEvents: observation.normalizedEvents,
        normalizedSettings: observation.normalizedSettings,
        status: "valid",
        errorCode: null,
        observedAt: observation.observedAt,
        expiresAt: observation.expiresAt,
      });
      await dependencies.onPhase?.("after_manifest_insert");
    }

    const [after] = await tx.select().from(externalAppManifestReceipts).where(and(
      eq(externalAppManifestReceipts.registrationId, observation.registrationId),
      eq(externalAppManifestReceipts.receiptRevision, observation.receiptRevision),
    )).limit(2);
    if (!after || !sameManifestObservation(after, observation)) {
      throw new Error("Slack Bridge local manifest-authority post-image mismatch");
    }
    await dependencies.onPhase?.("before_db_commit");
  });
  await dependencies.onPhase?.("after_db_commit");
  return manifestVerificationReceipt(observation);
}

async function readBoundedProviderBody(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^[0-9]+$/.test(contentLength)) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_PROVIDER_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(new Error("Slack OAuth provider response deadline exceeded"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may still be settling on an adversarial response body.
    }
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

interface LocalManifestManagerAuthoritySnapshot {
  registration: typeof externalAppRegistrations.$inferSelect;
  install: typeof externalAppInstalls.$inferSelect;
  manager: typeof externalAppRegistrationSecrets.$inferSelect;
  signing: typeof externalAppRegistrationSecrets.$inferSelect;
  latest: typeof externalAppManifestReceipts.$inferSelect;
}

async function loadManifestManagerAuthoritySnapshot(
  db: Database,
  config: LocalRuntimeConfig,
): Promise<LocalManifestManagerAuthoritySnapshot> {
  if (!config.realAuthority) {
    throw new Error("Slack Bridge local manifest observation requires sealed real authority");
  }
  const realAuthority = config.realAuthority;
  return db.transaction(async (tx) => {
    const registrations = await tx.select().from(externalAppRegistrations).where(eq(
      externalAppRegistrations.id,
      config.registrationId,
    )).limit(2).for("update");
    const installs = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.id, realAuthority.installId),
      eq(externalAppInstalls.registrationId, config.registrationId),
    )).limit(2).for("update");
    const secrets = await tx.select().from(externalAppRegistrationSecrets).where(eq(
      externalAppRegistrationSecrets.registrationId,
      config.registrationId,
    )).limit(3).for("update");
    const receipts = await tx.select().from(externalAppManifestReceipts).where(eq(
      externalAppManifestReceipts.registrationId,
      config.registrationId,
    )).orderBy(desc(externalAppManifestReceipts.receiptRevision)).limit(2).for("update");
    const manager = secrets.filter((secret) => secret.purpose === "manifest_manager");
    const signing = secrets.filter((secret) => secret.purpose === "signing_secret");
    if (
      registrations.length !== 1
      || installs.length !== 1
      || secrets.length !== 2
      || manager.length !== 1
      || signing.length !== 1
      || !receipts[0]
    ) {
      throw new Error("Slack Bridge local manifest-manager authority is missing or duplicated");
    }
    const registration = registrations[0]!;
    const install = installs[0]!;
    const latest = receipts[0]!;
    if (
      registration.provider !== "slack"
      || registration.environment !== "test"
      || registration.state !== "active"
      || registration.providerAppId !== config.providerAppId
      || install.state !== "active"
      || install.providerAppId !== config.providerAppId
      || install.id !== realAuthority.installId
      || latest.status !== "valid"
      || latest.errorCode !== null
      || latest.providerAppId !== config.providerAppId
      || latest.normalizedManifestHash !== registration.capabilityManifestHash
      || latest.managerCredentialRevision !== manager[0]!.secretRevision
      || !sameManifestStrings(install.installedScopes, latest.normalizedScopes)
    ) {
      throw new Error("Slack Bridge local manifest-manager authority preimage mismatch");
    }
    if (
      manager[0]!.revokedAt !== null
      || signing[0]!.revokedAt !== null
      || manager[0]!.leaseOwner !== null
      || manager[0]!.leaseExpiresAt !== null
      || signing[0]!.leaseOwner !== null
      || signing[0]!.leaseExpiresAt !== null
      || !manager[0]!.encryptedSecretRef.trim()
      || manager[0]!.envelopeKeyId !== config.envelopeKeyId
      || manager[0]!.aadVersion !== 1
      || signing[0]!.encryptedSecretRef !== config.signingSecretRef
      || signing[0]!.envelopeKeyId !== config.envelopeKeyId
      || signing[0]!.aadVersion !== 1
      || signing[0]!.secretRevision !== config.signingSecretRevision
    ) {
      throw new Error("Slack Bridge local manifest-manager secret reference mismatch");
    }
    return { registration, install, manager: manager[0]!, signing: signing[0]!, latest };
  });
}

function manifestManagerAuthorityFingerprint(snapshot: LocalManifestManagerAuthoritySnapshot): string {
  const row = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(
    ([key, item]) => [key, item instanceof Date ? item.toISOString() : item],
  ));
  return createHash("sha256").update(canonicalJson({
    registration: row(snapshot.registration),
    install: row(snapshot.install),
    manager: row(snapshot.manager),
    signing: row(snapshot.signing),
    latest: row(snapshot.latest),
  })).digest("hex");
}

function normalizeProviderManifestStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Slack Bridge provider manifest ${field} is invalid`);
  }
  const strings = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item !== item.trim()) {
      throw new Error(`Slack Bridge provider manifest ${field} is invalid`);
    }
    return item;
  });
  const normalized = [...new Set(strings)].sort((left, right) => left.localeCompare(right));
  if (normalized.length !== strings.length) {
    throw new Error(`Slack Bridge provider manifest ${field} is invalid`);
  }
  return normalized;
}

function projectProviderManifestSettings(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error("Slack Bridge provider manifest settings mismatch");
    }
    return actual.map((item, index) => projectProviderManifestSettings(item, expected[index]));
  }
  const expectedRecord = object(expected);
  if (expectedRecord) {
    const actualRecord = object(actual);
    if (!actualRecord) throw new Error("Slack Bridge provider manifest settings mismatch");
    return Object.fromEntries(Object.keys(expectedRecord).map((key) => {
      if (!(key in actualRecord)) throw new Error("Slack Bridge provider manifest settings mismatch");
      return [key, projectProviderManifestSettings(actualRecord[key], expectedRecord[key])];
    }));
  }
  if (actual !== expected) throw new Error("Slack Bridge provider manifest settings mismatch");
  return actual;
}

function parseProviderManifestObservation(
  raw: string,
  expected: LocalManifestManagerAuthoritySnapshot["latest"],
): Pick<SlackBridgeLocalManifestAuthorityInput, "normalizedScopes" | "normalizedEvents" | "normalizedSettings"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Slack Bridge provider manifest response is invalid");
  }
  const envelope = object(parsed);
  const manifest = object(envelope?.manifest);
  const oauthConfig = object(manifest?.oauth_config);
  const scopes = object(oauthConfig?.scopes);
  const settings = object(manifest?.settings);
  const eventSubscriptions = object(settings?.event_subscriptions);
  if (!envelope || envelope.ok !== true || !manifest || !oauthConfig || !scopes || !settings) {
    throw new Error("Slack Bridge provider manifest response is invalid");
  }
  const normalizedScopes = normalizeProviderManifestStrings(scopes.bot, "bot scopes");
  const normalizedEvents = expected.normalizedEvents.length === 0 && !eventSubscriptions
    ? []
    : normalizeProviderManifestStrings(eventSubscriptions?.bot_events, "bot events");
  const normalizedSettings = projectProviderManifestSettings(
    settings,
    normalizeManifestSettings(expected.normalizedSettings),
  ) as Record<string, unknown>;
  if (
    !sameManifestStrings(normalizedScopes, expected.normalizedScopes)
    || !sameManifestStrings(normalizedEvents, expected.normalizedEvents)
    || canonicalJson(normalizedSettings) !== canonicalJson(expected.normalizedSettings)
  ) {
    throw new Error("Slack Bridge provider manifest observation mismatch");
  }
  return { normalizedScopes, normalizedEvents, normalizedSettings };
}

/**
 * Resolve the local test App's manager credential from a separate owner-only
 * file and perform one bounded, read-only Slack manifest export. The token is
 * never returned or stored in the runtime config; DB authority is re-read
 * after provider I/O so any concurrent rotation invalidates the observation.
 */
export async function observeSlackBridgeLocalManifestAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SlackBridgeLocalManifestObservationDependencies = {},
): Promise<SlackBridgeLocalManifestAuthorityInput> {
  const configPath = configPathFromEnv(env);
  if (!configPath) throw new Error("Slack Bridge local runtime config is required for manifest observation");
  const credentialPath = manifestManagerCredentialPathFromEnv(env, configPath);
  const config = await readProtectedConfig(configPath);
  const db = dependencies.db ?? getDb();
  const before = await loadManifestManagerAuthoritySnapshot(db, config);
  const beforeFingerprint = manifestManagerAuthorityFingerprint(before);
  const credential = await readProtectedManifestManagerCredential(credentialPath);
  if (
    credential.registrationId !== config.registrationId
    || credential.providerAppId !== config.providerAppId
    || credential.encryptedSecretRef !== before.manager.encryptedSecretRef
    || credential.envelopeKeyId !== before.manager.envelopeKeyId
    || credential.aadVersion !== before.manager.aadVersion
    || credential.secretRevision !== before.manager.secretRevision
  ) {
    throw new Error("Slack Bridge local manifest-manager credential authority mismatch");
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const fetchTimeoutMs = dependencies.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs <= 0 || fetchTimeoutMs > 60_000) {
    throw new Error("Slack Bridge local manifest-manager provider timeout is invalid");
  }
  const controller = new AbortController();
  const timeout = setClockTimeout(() => controller.abort(), fetchTimeoutMs);
  let responseBody: string | null = null;
  try {
    const response = await fetchImpl(MANIFEST_EXPORT_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ app_id: config.providerAppId }).toString(),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Slack Bridge provider manifest export failed");
    }
    responseBody = await readBoundedProviderBody(response, controller.signal);
    if (responseBody === null) throw new Error("Slack Bridge provider manifest export failed");
  } catch {
    throw new Error("Slack Bridge provider manifest export failed");
  } finally {
    clearClockTimeout(timeout);
  }
  const normalized = parseProviderManifestObservation(responseBody, before.latest);
  const after = await loadManifestManagerAuthoritySnapshot(db, config);
  if (manifestManagerAuthorityFingerprint(after) !== beforeFingerprint) {
    throw new Error("Slack Bridge local manifest-manager authority changed during provider observation");
  }
  const observedAt = (dependencies.now ?? currentDate)();
  if (!validNow(observedAt) || before.latest.observedAt >= observedAt) {
    throw new Error("Slack Bridge provider manifest observation time is invalid");
  }
  const expiresAt = new Date(observedAt.getTime() + MANIFEST_AUTHORITY_MAX_TTL_MS);
  return {
    schema: MANIFEST_AUTHORITY_SCHEMA,
    registrationId: config.registrationId,
    receiptRevision: before.latest.receiptRevision + 1,
    managerCredentialRevision: before.manager.secretRevision,
    providerAppId: config.providerAppId,
    normalizedManifestHash: before.registration.capabilityManifestHash,
    ...normalized,
    observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function seal(input: {
  plaintext: string;
  aad: unknown;
  key: Buffer;
}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(canonicalJson(input.aad), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "local-aes-256-gcm-v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function unseal(input: {
  encryptedMaterial: string;
  aad: unknown;
  key: Buffer;
}): string | null {
  const parts = input.encryptedMaterial.split(".");
  if (parts.length !== 4 || parts[0] !== "local-aes-256-gcm-v1") return null;
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", input.key, iv);
    decipher.setAAD(Buffer.from(canonicalJson(input.aad), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function membershipDecision(binding: LocalOutboundBinding): SlackBridgeAppMembershipDecision {
  return { active: true, fact: { ...binding.membership } };
}

function oracleDecision(binding: LocalOutboundBinding): SlackBridgeReleaseOracleDecision {
  return { active: true, fact: { ...binding.oracle } };
}

function findOutboundBinding(
  outbound: LocalOutboundConfig,
  input: { sourceConversationId: string; level: SlackBridgeRuntimeLevel; bindingId?: string },
): LocalOutboundBinding | null {
  const matches = outbound.bindings.filter((binding) =>
    binding.sourceConversationId === input.sourceConversationId
    && binding.level === input.level
    && (input.bindingId === undefined || binding.bindingId === input.bindingId)
  );
  return matches.length === 1 ? matches[0]! : null;
}

async function resolveConfiguredBinding(
  binding: LocalOutboundBinding,
  input: { now: Date; expectedRuntimePredicateRevision?: string; executor?: DatabaseExecutor },
): Promise<SlackBridgeBindingActiveDecision> {
  return resolveSlackBridgeBindingActive({
    serverId: binding.serverId,
    bindingId: binding.bindingId,
    expectedConnectionEpoch: binding.connectionEpoch,
    expectedBindingEpoch: binding.bindingEpoch,
    level: binding.level,
    expectedRuntimePredicateRevision: input.expectedRuntimePredicateRevision,
    now: input.now,
  }, {
    ...(input.executor
      ? { withReadSnapshot: async <T>(fn: (executor: DatabaseExecutor) => Promise<T>) => fn(input.executor!) }
      : {}),
    resolveAppMembership: async () => membershipDecision(binding),
    resolveReleaseOracle: async () => oracleDecision(binding),
  });
}

async function verifyLocalOutboundAuthority(input: {
  config: LocalRuntimeConfig;
  db: Database;
  now: Date;
}): Promise<void> {
  if (!input.config.outbound) return;
  await input.db.transaction(async (tx) => {
    for (const binding of input.config.outbound!.bindings) {
      const decision = await resolveConfiguredBinding(binding, {
        now: input.now,
        executor: tx,
      });
      if (!decision.active) {
        throw new Error(`Slack Bridge local outbound authority mismatch: ${decision.reason}`);
      }
    }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function verifySlackBridgeLocalOutboundAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { db?: Database; now?: () => Date } = {},
): Promise<void> {
  const configPath = configPathFromEnv(env);
  if (!configPath) return;
  const config = await readProtectedConfig(configPath);
  await verifyLocalOutboundAuthority({
    config,
    db: dependencies.db ?? getDb(),
    now: (dependencies.now ?? currentDate)(),
  });
}

function providerNeutralAuthority(
  binding: LocalOutboundBinding,
  fact: Extract<SlackBridgeBindingActiveDecision, { active: true }>["fact"],
): ProviderNeutralOutboundBindingAuthority {
  const authority = fact.bindingAuthority;
  return {
    provider: authority.provider,
    environment: authority.environment,
    appRegistrationId: authority.registrationId,
    installId: authority.installId,
    workspaceId: authority.providerAuthorityId,
    connectionEpoch: authority.connectionEpoch,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
    memberRevision: binding.membership.receiptRevision,
    contextRevision: binding.oracle.oracleReceiptRevision,
    consentRevision: binding.consentRevision,
    privacyClass: authority.privacyClass,
    raftChannelId: authority.channelId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
  };
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  const text = string(value);
  return text ? text.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function providerError(value: unknown): string {
  return string(value) ?? "provider_rejected";
}

function validNow(now: Date): boolean {
  return Number.isFinite(now.getTime());
}

function sameAuthority(
  left: SlackProviderAuthorityFence,
  right: SlackProviderAuthorityFence,
): boolean {
  return left.installId === right.installId
    && left.providerAppId === right.providerAppId
    && left.providerAuthorityId === right.providerAuthorityId
    && left.providerConversationId === right.providerConversationId
    && left.connectionEpoch === right.connectionEpoch
    && left.credentialRevision === right.credentialRevision
    && left.bindingId === right.bindingId
    && left.bindingEpoch === right.bindingEpoch;
}

function sameAuthorPolicyAuthority(
  left: ExternalAuthorPolicyRuntimeAuthority,
  right: ExternalAuthorPolicyRuntimeAuthority,
): boolean {
  return left.provider === right.provider
    && left.registrationId === right.registrationId
    && left.installId === right.installId
    && left.bindingId === right.bindingId
    && left.bindingEpoch === right.bindingEpoch
    && left.consentRevision === right.consentRevision;
}

function parseCredentialMaterial(plaintext: string): { accessToken: string } | null {
  try {
    const value = object(JSON.parse(plaintext));
    const accessToken = string(value?.accessToken);
    if (!accessToken || value?.tokenType !== "bot") return null;
    return { accessToken };
  } catch {
    return null;
  }
}

function sourcePermalink(origin: string, messageId: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("message", messageId);
  return url.toString();
}

function createLocalOutboundRuntime(input: {
  config: LocalRuntimeConfig;
  outbound: LocalOutboundConfig;
  key: Buffer;
  db: Database;
  now(): Date;
  fetch: FetchLike;
  fetchTimeoutMs: number;
  credentialLeases: Map<string, LocalProviderCredentialLease>;
  providerAbortControllers: Set<AbortController>;
  isStopped(): boolean;
}): {
  authorizationResolver: OrdinaryMessageOutboundAuthorizationResolver;
  workerDependencies: ExternalDeliveryWorkerDependencies;
} {
  const resolveCurrentRuntime: ExternalDeliveryWorkerDependencies["resolveCurrentRuntime"] = async ({
    frozenSnapshot,
  }) => {
    if (input.isStopped()) return null;
    const binding = findOutboundBinding(input.outbound, {
      sourceConversationId: frozenSnapshot.canonicalConversationId,
      level: frozenSnapshot.level,
      bindingId: frozenSnapshot.bindingAuthority.bindingId,
    });
    if (!binding) return null;
    const decision = await resolveConfiguredBinding(binding, {
      now: input.now(),
      expectedRuntimePredicateRevision: frozenSnapshot.enqueueRuntimeRevision,
    });
    if (!decision.active || input.isStopped()) return null;
    return {
      runtimeRevision: decision.fact.runtimePredicateRevision,
      bindingAuthority: providerNeutralAuthority(binding, decision.fact),
    };
  };

  const leaseCredential: ExternalDeliveryWorkerDependencies["leaseCredential"] = async ({
    deliveryId,
    runtime,
  }) => {
    if (input.isStopped()) return null;
    const authority = runtime.bindingAuthority;
    const at = input.now();
    if (!validNow(at) || authority.provider !== "slack") return null;
    const leaseId = `local-provider:${randomUUID()}`;
    const leaseExpiresAt = new Date(at.getTime() + CREDENTIAL_LEASE_TTL_MS);
    const row = await input.db.transaction(async (tx) => {
      const [current] = await tx.select({
        installState: externalAppInstalls.state,
        installRegistrationId: externalAppInstalls.registrationId,
        installProviderAppId: externalAppInstalls.providerAppId,
        installProviderAuthorityId: externalAppInstalls.providerAuthorityId,
        installConnectionEpoch: externalAppInstalls.connectionEpoch,
        installCredentialRevision: externalAppInstalls.credentialRevision,
        credentialId: externalAppCredentials.id,
        credentialState: externalAppCredentials.state,
        encryptedMaterial: externalAppCredentials.encryptedMaterial,
        envelopeKeyId: externalAppCredentials.envelopeKeyId,
        aadVersion: externalAppCredentials.aadVersion,
        credentialRevision: externalAppCredentials.credentialRevision,
      }).from(externalAppCredentials)
        .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalAppCredentials.installId))
        .where(and(
          eq(externalAppInstalls.id, authority.installId),
          eq(externalAppInstalls.state, "active"),
          eq(externalAppInstalls.registrationId, authority.appRegistrationId),
          eq(externalAppInstalls.providerAuthorityId, authority.providerAuthorityId),
          eq(externalAppInstalls.connectionEpoch, authority.connectionEpoch),
          eq(externalAppCredentials.state, "active"),
          or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, at)),
          or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, at)),
        )).for("update").limit(1);
      if (
        !current
        || current.installState !== "active"
        || current.credentialState !== "active"
        || current.installRegistrationId !== authority.appRegistrationId
        || current.installProviderAuthorityId !== authority.providerAuthorityId
        || current.installConnectionEpoch !== authority.connectionEpoch
        || current.installCredentialRevision !== current.credentialRevision
        || current.envelopeKeyId !== input.config.envelopeKeyId
        || current.aadVersion !== 1
      ) return null;
      const claimed = await tx.update(externalAppCredentials).set({
        leaseOwner: leaseId,
        leaseExpiresAt,
        updatedAt: at,
      }).where(and(
        eq(externalAppCredentials.id, current.credentialId),
        eq(externalAppCredentials.state, "active"),
        eq(externalAppCredentials.credentialRevision, current.credentialRevision),
        or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, at)),
      )).returning({ id: externalAppCredentials.id });
      return claimed.length === 1 ? current : null;
    });
    if (!row) return null;
    const providerFence: SlackProviderAuthorityFence = {
      installId: authority.installId,
      providerAppId: row.installProviderAppId,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      connectionEpoch: authority.connectionEpoch,
      credentialRevision: row.credentialRevision,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
    };
    const plaintext = unseal({
      encryptedMaterial: row.encryptedMaterial,
      aad: {
        purpose: "slack_bot_credential",
        providerAppId: providerFence.providerAppId,
        providerTeamId: providerFence.providerAuthorityId,
      },
      key: input.key,
    });
    const credential = plaintext ? parseCredentialMaterial(plaintext) : null;
    if (!credential || input.isStopped()) {
      await input.db.update(externalAppCredentials).set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: at,
      }).where(and(
        eq(externalAppCredentials.installId, providerFence.installId),
        eq(externalAppCredentials.state, "active"),
        eq(externalAppCredentials.credentialRevision, providerFence.credentialRevision),
        eq(externalAppCredentials.leaseOwner, leaseId),
      ));
      return null;
    }
    input.credentialLeases.set(leaseId, {
      accessToken: credential.accessToken,
      authority: providerFence,
      deliveryId,
      reconciliationMarker: null,
      expiresAt: leaseExpiresAt,
    });
    const handle: SlackBridgeCredentialHandle = {
      schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
      leaseId,
      installId: providerFence.installId,
      providerAppId: providerFence.providerAppId,
      providerAuthorityId: providerFence.providerAuthorityId,
      connectionEpoch: providerFence.connectionEpoch,
      credentialRevision: providerFence.credentialRevision,
      leaseExpiresAt,
    };
    const leased: ExternalDeliveryCredentialLease = {
      handle,
      credentialRevision: providerFence.credentialRevision,
      runtimeRevision: runtime.runtimeRevision,
      provider: authority.provider,
      installId: authority.installId,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      connectionEpoch: authority.connectionEpoch,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
    };
    return leased;
  };


  const liveTransport = {
    evidence: "live" as const,
    async call(request: import("./slackProviderAdapter.js").SlackWebApiRequest): Promise<SlackWebApiTransportResult> {
      const lease = input.credentialLeases.get(request.credentialHandle.leaseId);
      input.credentialLeases.delete(request.credentialHandle.leaseId);
      const at = input.now();
      const metadata = object(request.body.metadata);
      const eventPayload = object(metadata?.event_payload);
      const requestBody = JSON.stringify(request.body);
      if (!lease) {
        return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      }
      const releaseAt = validNow(at) ? at : currentDate();
      const releaseLease = () => input.db.update(externalAppCredentials).set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: releaseAt,
      }).where(and(
        eq(externalAppCredentials.installId, lease.authority.installId),
        eq(externalAppCredentials.state, "active"),
        eq(externalAppCredentials.credentialRevision, lease.authority.credentialRevision),
        eq(externalAppCredentials.leaseOwner, request.credentialHandle.leaseId),
      )).returning({ id: externalAppCredentials.id });
      if (
        !validNow(at)
        || lease.expiresAt <= at
        || input.isStopped()
        || !sameAuthority(lease.authority, request.authority)
        || request.method !== "chat.postMessage"
        || eventPayload?.delivery_id !== lease.deliveryId
        || eventPayload?.reconciliation_marker !== lease.reconciliationMarker
        || Buffer.byteLength(requestBody, "utf8") > MAX_PROVIDER_REQUEST_BYTES
      ) {
        await releaseLease();
        return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      }
      const released = await releaseLease();
      if (released.length !== 1) {
        return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      }
      const controller = new AbortController();
      input.providerAbortControllers.add(controller);
      const timeout = setClockTimeout(() => controller.abort(), input.fetchTimeoutMs);
      let receivedHeaders = false;
      try {
        const response = await input.fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            authorization: `Bearer ${lease.accessToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: requestBody,
          redirect: "error",
          signal: controller.signal,
        });
        receivedHeaders = true;
        const headers = Object.fromEntries(response.headers.entries());
        if (response.status === 429) {
          void response.body?.cancel().catch(() => undefined);
          return { kind: "response", status: 429, headers, body: {} };
        }
        const bodyText = await readBoundedProviderBody(response, controller.signal);
        if (bodyText === null) {
          return { kind: "transport_failure", phase: "after_send", code: "timeout" };
        }
        let body: SlackJsonObject = {};
        try {
          body = object(JSON.parse(bodyText)) as SlackJsonObject ?? {};
        } catch {
          // A malformed provider response cannot prove acceptance.
        }
        return { kind: "response", status: response.status, headers, body };
      } catch {
        return {
          kind: "transport_failure",
          phase: receivedHeaders ? "after_send" : "unknown",
          code: controller.signal.aborted ? "timeout" : "unavailable",
        };
      } finally {
        clearClockTimeout(timeout);
        input.providerAbortControllers.delete(controller);
      }
    },
  };

  const quarantineSink = {
    async quarantine(fence: SlackProviderAuthorityFence & { reason: "provider_app_identity_conflict" | "provider_authority_identity_conflict" | "provider_conversation_identity_conflict" | "provider_credential_revoked" }) {
      return input.db.transaction(async (tx) => {
        const [install] = await tx.select().from(externalAppInstalls)
          .where(eq(externalAppInstalls.id, fence.installId)).for("update").limit(1);
        const [binding] = await tx.select().from(externalChannelBindings)
          .where(eq(externalChannelBindings.id, fence.bindingId)).for("update").limit(1);
        const [credential] = await tx.select().from(externalAppCredentials)
          .where(eq(externalAppCredentials.installId, fence.installId)).for("update").limit(1);
        if (
          !install || !binding || !credential
          || install.providerAppId !== fence.providerAppId
          || install.providerAuthorityId !== fence.providerAuthorityId
          || install.connectionEpoch !== fence.connectionEpoch
          || install.credentialRevision !== fence.credentialRevision
          || binding.installId !== fence.installId
          || binding.providerConversationId !== fence.providerConversationId
          || binding.connectionEpoch !== fence.connectionEpoch
          || binding.bindingEpoch !== fence.bindingEpoch
          || credential.credentialRevision !== fence.credentialRevision
        ) return "fence_mismatch" as const;
        if (install.state !== "active" || binding.state !== "active" || credential.state !== "active") {
          return "already_fenced" as const;
        }
        const at = input.now();
        await tx.update(externalAppInstalls).set({
          state: fence.reason === "provider_credential_revoked" ? "reauth_required" : "quarantined",
          stateReason: fence.reason,
          updatedAt: at,
        }).where(and(
          eq(externalAppInstalls.id, fence.installId),
          eq(externalAppInstalls.state, "active"),
          eq(externalAppInstalls.connectionEpoch, fence.connectionEpoch),
          eq(externalAppInstalls.credentialRevision, fence.credentialRevision),
        ));
        await tx.update(externalChannelBindings).set({
          state: "quarantined",
          stateReason: fence.reason,
          updatedAt: at,
        }).where(and(
          eq(externalChannelBindings.id, fence.bindingId),
          eq(externalChannelBindings.state, "active"),
          eq(externalChannelBindings.connectionEpoch, fence.connectionEpoch),
          eq(externalChannelBindings.bindingEpoch, fence.bindingEpoch),
        ));
        if (fence.reason === "provider_credential_revoked") {
          await tx.update(externalAppCredentials).set({
            state: "revoked",
            revokedAt: at,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: at,
          }).where(and(
            eq(externalAppCredentials.id, credential.id),
            eq(externalAppCredentials.state, "active"),
            eq(externalAppCredentials.credentialRevision, fence.credentialRevision),
          ));
        }
        await tx.update(externalMessageLinks).set({
          authorityState: "stale",
          stateReason: fence.reason,
          updatedAt: at,
        }).where(and(
          eq(externalMessageLinks.bindingId, fence.bindingId),
          eq(externalMessageLinks.bindingEpoch, fence.bindingEpoch),
          eq(externalMessageLinks.connectionEpoch, fence.connectionEpoch),
          eq(externalMessageLinks.authorityState, "active"),
        ));
        return "applied" as const;
      });
    },
  };

  const threadAuthority = {
    async resolve({ canonicalRootMessageId, authority }: { canonicalRootMessageId: string; authority: SlackProviderAuthorityFence }) {
      const links = await input.db.select().from(externalMessageLinks).where(and(
        eq(externalMessageLinks.raftMessageId, canonicalRootMessageId),
        eq(externalMessageLinks.provider, "slack"),
        eq(externalMessageLinks.installId, authority.installId),
        eq(externalMessageLinks.providerAuthorityId, authority.providerAuthorityId),
        eq(externalMessageLinks.providerConversationId, authority.providerConversationId),
        eq(externalMessageLinks.bindingId, authority.bindingId),
        eq(externalMessageLinks.bindingEpoch, authority.bindingEpoch),
        eq(externalMessageLinks.connectionEpoch, authority.connectionEpoch),
        eq(externalMessageLinks.outcomeState, "accepted"),
        eq(externalMessageLinks.authorityState, "active"),
      )).limit(2);
      const providerThreadId = links.length === 1 ? links[0]!.providerMessageId : null;
      if (!providerThreadId) {
        return { active: false as const, reason: "missing" as const };
      }
      const link = links[0]!;
      return {
        active: true as const,
        fact: {
          providerThreadId,
          rootLinkRevision: 1,
          installId: authority.installId,
          providerAuthorityId: authority.providerAuthorityId,
          providerConversationId: authority.providerConversationId,
          connectionEpoch: authority.connectionEpoch,
          bindingId: authority.bindingId,
          bindingEpoch: authority.bindingEpoch,
        },
      };
    },
  };

  const authorizationResolver: OrdinaryMessageOutboundAuthorizationResolver = async (request) => {
    if (input.isStopped()) return null;
    if (request.message.channelId !== request.requestedChannelId) return null;
    const candidates = input.outbound.bindings.filter(
      (binding) => binding.sourceConversationId === request.message.channelId,
    );
    if (candidates.length !== 1) return null;
    const binding = candidates[0]!;
    if (
      request.sourceText.includes("\0")
      || Buffer.byteLength(request.sourceText, "utf8") > 40_000
    ) return null;
    const sourceChannels = await request.executor.select({
      id: channels.id,
      serverId: channels.serverId,
    }).from(channels).where(eq(channels.id, request.message.channelId)).limit(2);
    if (sourceChannels.length !== 1 || sourceChannels[0]!.serverId !== binding.serverId) return null;
    const decision = await resolveConfiguredBinding(binding, {
      now: input.now(),
      executor: request.executor,
    });
    if (!decision.active || input.isStopped()) return null;
    const authority = providerNeutralAuthority(binding, decision.fact);
    if (binding.level === "top_level") {
      if (authority.raftChannelId !== request.message.channelId) return null;
    } else {
      const roots = await request.executor.select({
        id: messages.id,
        channelId: messages.channelId,
        threadId: messages.threadId,
      }).from(messages).where(eq(messages.id, binding.canonicalRootMessageId!)).limit(2);
      if (
        roots.length !== 1
        || roots[0]!.channelId !== authority.raftChannelId
        || roots[0]!.threadId !== request.message.channelId
      ) return null;
    }
    return {
      activeRuntime: {
        level: binding.level,
        authorityConversationId: request.requestedChannelId,
        runtimePredicateRevision: decision.fact.runtimePredicateRevision,
        bindingAuthority: authority,
      },
      canonicalConversationId: request.message.channelId,
      canonicalRootMessageId: binding.canonicalRootMessageId,
      sanitizedText: request.sourceText,
    };
  };

  const prepareSlackProvider = createSlackProviderPreparation({
    transport: liveTransport,
    quarantineSink,
    threadAuthority,
    now: input.now,
  });

  const releaseCredential: NonNullable<ExternalDeliveryWorkerDependencies["releaseCredential"]> = async ({
    credentialHandle,
  }) => {
    const handle = object(credentialHandle);
    const leaseId = typeof handle?.leaseId === "string" ? handle.leaseId : "";
    if (!leaseId) return;
    const lease = input.credentialLeases.get(leaseId);
    input.credentialLeases.delete(leaseId);
    if (!lease) return;
    await input.db.update(externalAppCredentials).set({
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.now(),
    }).where(and(
      eq(externalAppCredentials.installId, lease.authority.installId),
      eq(externalAppCredentials.state, "active"),
      eq(externalAppCredentials.credentialRevision, lease.authority.credentialRevision),
      eq(externalAppCredentials.leaseOwner, leaseId),
    ));
  };

  const prepareProvider: NonNullable<ExternalDeliveryWorkerDependencies["prepareProvider"]> = async (request) => {
    const handle = request.credentialHandle as SlackBridgeCredentialHandle;
    const lease = handle?.schema === SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA
      ? input.credentialLeases.get(handle.leaseId)
      : null;
    if (
      !lease
      || lease.deliveryId !== request.deliveryId
      || lease.reconciliationMarker !== null
      || lease.authority.installId !== request.runtime.bindingAuthority.installId
      || lease.authority.providerAuthorityId !== request.runtime.bindingAuthority.providerAuthorityId
      || lease.authority.providerConversationId !== request.runtime.bindingAuthority.providerConversationId
      || lease.authority.connectionEpoch !== request.runtime.bindingAuthority.connectionEpoch
      || lease.authority.bindingId !== request.runtime.bindingAuthority.bindingId
      || lease.authority.bindingEpoch !== request.runtime.bindingAuthority.bindingEpoch
    ) return { ready: false, reason: "provider_preflight_credential_mismatch" };
    lease.reconciliationMarker = request.reconciliationMarker;
    const prepared = await prepareSlackProvider({
      deliveryId: request.deliveryId,
      reconciliationMarker: request.reconciliationMarker,
      renderSnapshot: request.frozenSnapshot,
      credentialHandle: handle,
    });
    if (!prepared.ready) return prepared;
    return {
      ready: true as const,
      async dispatch() {
        const result = await prepared.dispatch();
        if (result.kind === "accepted" || result.kind === "rate_limited") return result;
        if (result.kind === "transient_failure") {
          return { ...result, reasonCode: "provider_transient_failure" } as const;
        }
        if (result.kind === "deterministic_failure") {
          return { kind: "deterministic_failure", reasonCode: "provider_deterministic_failure" } as const;
        }
        return { kind: "outcome_unknown", reasonCode: "provider_outcome_unknown" } as const;
      },
    };
  };

  return {
    authorizationResolver,
    workerDependencies: {
      resolveCurrentRuntime,
      leaseCredential,
      prepareProvider,
      releaseCredential,
      now: input.now,
    },
  };
}

/**
 * Creates the deliberately local-only Slack route runtime used behind a
 * short-lived Cloudflare Tunnel. Secrets come from one owner-only file and
 * are represented outside this module only by expiring, one-use handles.
 */
export async function createSlackBridgeLocalRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: Partial<SlackBridgeLocalRuntimeDependencies> = {},
): Promise<SlackBridgeLocalRuntime | undefined> {
  const configPath = configPathFromEnv(env);
  if (!configPath) return undefined;

  const config = await readProtectedConfig(configPath);
  const key = Buffer.from(config.envelopeKeyBase64, "base64");
  const now = dependencies.now ?? currentDate;
  const fetchImpl = dependencies.fetch ?? fetch;
  const db = dependencies.db ?? (config.outbound ? getDb() : undefined);
  const appOrigin = config.outbound?.raftAppOrigin
    ?? normalizeAppUrl(env.APP_URL)
    ?? DEFAULT_APP_URL;
  const runWorkerOnce = dependencies.runWorkerOnce ?? processExternalDeliveryPartitionHead;
  const fetchTimeoutMs = dependencies.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
    throw new Error("Slack Bridge local runtime provider timeout is invalid");
  }
  if (dependencies.verifyIngressAuthority) {
    await dependencies.verifyIngressAuthority({ config, now: now() });
  } else {
    await verifyLocalIngressAuthority({ config, db: db ?? getDb(), now: now() });
  }
  if (config.realAuthority) {
    await verifyLocalRealAuthority({ config, db: db ?? getDb(), now: now() });
    await verifyLocalOutboundAuthority({ config, db: db ?? getDb(), now: now() });
  }
  const appLeases = new Map<string, LocalAppLease>();
  const codeHandles = new Map<string, LocalCodeHandle>();
  const providerCredentialLeases = new Map<string, LocalProviderCredentialLease>();
  const providerAbortControllers = new Set<AbortController>();

  const prune = (at: Date) => {
    for (const [handleId, lease] of appLeases) {
      if (lease.expiresAt <= at) appLeases.delete(handleId);
    }
    for (const [handleId, code] of codeHandles) {
      if (code.expiresAt <= at) codeHandles.delete(handleId);
    }
  };

  const exchangeOAuth = createSlackOAuthExchangeAdapter({
    transport: {
      evidence: "live",
      async exchange(request): Promise<SlackOAuthExchangeTransportResult> {
        if (stopped) return { kind: "rejected", error: "local_runtime_stopped" };
        prune(request.now);
        const lease = appLeases.get(request.appCredential.handleId);
        const code = codeHandles.get(request.authorizationCode.handleId);
        // Consume both handles before provider I/O. An ambiguous result must be
        // reconciled, never retried with the same authorization code.
        appLeases.delete(request.appCredential.handleId);
        codeHandles.delete(request.authorizationCode.handleId);
        if (
          !lease
          || !code
          || lease.expiresAt <= request.now
          || code.expiresAt <= request.now
          || lease.attemptId !== code.attemptId
          || lease.providerAppId !== request.expectedProviderAppId
          || lease.providerOAuthClientId !== code.providerOAuthClientId
          || lease.providerOAuthClientId !== config.providerOAuthClientId
          || request.redirectUri !== `${config.publicOrigin}/api/slack-bridge/oauth/callback`
        ) {
          return { kind: "rejected", error: "local_handle_mismatch" };
        }

        const controller = new AbortController();
        providerAbortControllers.add(controller);
        const timeout = setClockTimeout(() => controller.abort(), fetchTimeoutMs);
        let receivedHeaders = false;
        try {
          const response = await fetchImpl(OAUTH_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: lease.providerOAuthClientId,
              client_secret: lease.clientSecret,
              code: code.authorizationCode,
              redirect_uri: request.redirectUri,
            }),
            redirect: "error",
            signal: controller.signal,
          });
          receivedHeaders = true;
          if (response.status === 429) {
            void response.body?.cancel().catch(() => undefined);
            // Both one-use handles were consumed before provider I/O. A 429
            // therefore has no safe automatic retry path in this runtime.
            return { kind: "transport_failure", phase: "after_send" };
          }
          const bodyText = await readBoundedProviderBody(response, controller.signal);
          if (bodyText === null) {
            return { kind: "transport_failure", phase: "after_send" };
          }
          let body: Record<string, unknown> | null = null;
          try {
            body = object(JSON.parse(bodyText));
          } catch {
            return { kind: "transport_failure", phase: "after_send" };
          }
          if (!body || body.ok !== true) {
            return { kind: "rejected", error: providerError(body?.error) };
          }
          if (response.status < 200 || response.status >= 300) {
            return { kind: "transport_failure", phase: "after_send" };
          }
          const providerAppId = string(body.app_id);
          const accessToken = string(body.access_token);
          const tokenType = string(body.token_type);
          const botUserId = string(body.bot_user_id);
          const authedUser = object(body.authed_user);
          const providerUserId = string(authedUser?.id);
          const team = object(body.team);
          const enterprise = object(body.enterprise);
          const providerTeamId = string(team?.id);
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
          return {
            kind: "authorized",
            providerAppId,
            providerTeamId,
            providerEnterpriseId: string(enterprise?.id),
            providerUserId,
            botUserId,
            providerBotId: string(body.bot_id),
            workspaceName: string(team?.name),
            installedScopes: stringArray(body.scope),
            sealedCredential: {
              encryptedMaterial: seal({
                plaintext: JSON.stringify({
                  accessToken,
                  tokenType,
                }),
                aad: {
                  purpose: "slack_bot_credential",
                  providerAppId,
                  providerTeamId,
                },
                key,
              }),
              envelopeKeyId: config.envelopeKeyId,
              aadVersion: 1,
            },
          };
        } catch {
          return {
            kind: "transport_failure",
            phase: receivedHeaders ? "after_send" : "unknown",
          };
        } finally {
          clearClockTimeout(timeout);
          providerAbortControllers.delete(controller);
        }
      },
    },
  });

  const routes: SlackBridgeRouteDependencies = {
    environment: "test",
    oauthRedirectUri: `${config.publicOrigin}/api/slack-bridge/oauth/callback`,
    eventsRequestUrl: eventsRequestUrl(config),
    appOrigin,
    isLaunchEnabled: async ({ serverId }) => (
      await evaluateFeatureFlag(
        { key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId },
        dependencies.db,
      )
    ).enabled,
    resolveOAuthCompletionRedirectPath:
      createSlackBridgeOAuthCompletionRedirectPathResolver({ db: dependencies.db }),
    now,
    async leaseOAuthAppCredential(input) {
      const at = now();
      if (
        stopped
        || !validNow(at)
        || !validNow(input.now)
        || Math.abs(input.now.getTime() - at.getTime()) > 5_000
        || input.environment !== "test"
        || input.registrationId !== config.registrationId
        || input.providerAppId !== config.providerAppId
        || input.providerOAuthClientId !== config.providerOAuthClientId
        || input.audience !== "slack-oauth-exchange"
      ) return null;
      prune(at);
      const handleId = `local-app:${randomUUID()}`;
      const expiresAt = new Date(at.getTime() + APP_LEASE_TTL_MS);
      appLeases.set(handleId, {
        attemptId: input.attemptId,
        clientSecret: config.oauthClientSecret,
        providerAppId: config.providerAppId,
        providerOAuthClientId: config.providerOAuthClientId,
        expiresAt,
      });
      return {
        handle: {
          schema: SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
          handleId,
          providerAppId: config.providerAppId,
          environment: "test",
        },
        leaseExpiresAt: expiresAt,
      };
    },
    async captureAuthorizationCode(input) {
      const at = now();
      if (
        stopped
        || !validNow(at)
        || !validNow(input.now)
        || Math.abs(input.now.getTime() - at.getTime()) > 5_000
        || input.providerOAuthClientId !== config.providerOAuthClientId
        || !input.authorizationCode
      ) throw new Error("Slack Bridge local authorization-code capture rejected");
      prune(at);
      const handleId = `local-code:${randomUUID()}`;
      const expiresAt = new Date(at.getTime() + CODE_HANDLE_TTL_MS);
      codeHandles.set(handleId, {
        authorizationCode: input.authorizationCode,
        attemptId: input.attemptId,
        providerOAuthClientId: input.providerOAuthClientId,
        expiresAt,
      });
      return { schema: SLACK_OAUTH_CODE_HANDLE_SCHEMA, handleId, expiresAt };
    },
    exchangeOAuth,
    secretResolver: {
      async resolveSigningSecret(input) {
        if (
          stopped
          || input.environment !== "test"
          || input.registrationId !== config.registrationId
          || input.encryptedSecretRef !== config.signingSecretRef
          || input.envelopeKeyId !== config.envelopeKeyId
          || input.aadVersion !== 1
          || input.secretRevision !== config.signingSecretRevision
        ) throw new Error("Slack Bridge local signing-secret reference mismatch");
        return config.signingSecret;
      },
    },
    payloadSealer: {
      async sealNormalizedPayload(input) {
        if (stopped) throw new Error("Slack Bridge local runtime is stopped");
        return {
          encryptedPayload: seal({
            plaintext: input.plaintext,
            aad: input.aad,
            key,
          }),
          envelopeKeyId: config.envelopeKeyId,
          aadVersion: 1,
        };
      },
    },
    async resolveAuthorPolicyAuthority(policyInput) {
      if (
        stopped
        || !validNow(policyInput.now)
        || !config.outbound
      ) return null;
      const matches = config.outbound.bindings.filter((binding) =>
        binding.serverId === policyInput.serverId
        && binding.bindingId === policyInput.bindingId
      );
      if (matches.length === 0) return null;
      let resolved: ExternalAuthorPolicyRuntimeAuthority | null = null;
      for (const binding of matches) {
        const decision = await resolveConfiguredBinding(binding, {
          now: policyInput.now,
        });
        if (!decision.active || stopped) return null;
        const authority = decision.fact.bindingAuthority;
        if (
          authority.registrationId !== binding.membership.registrationId
          || authority.installId !== binding.membership.installId
          || authority.bindingId !== binding.bindingId
          || authority.bindingEpoch !== binding.bindingEpoch
        ) return null;
        const candidate: ExternalAuthorPolicyRuntimeAuthority = {
          provider: "slack",
          registrationId: authority.registrationId,
          installId: authority.installId,
          bindingId: authority.bindingId,
          bindingEpoch: authority.bindingEpoch,
          consentRevision: binding.consentRevision,
        };
        if (resolved && !sameAuthorPolicyAuthority(resolved, candidate)) return null;
        resolved = candidate;
      }
      return resolved;
    },
    runtimeResolver: config.outbound ? {
      async resolveCurrentRuntime(runtimeInput) {
        if (stopped) return null;
        const matches = config.outbound!.bindings.filter((binding) =>
          binding.level === "top_level"
          && binding.bindingId === runtimeInput.authority.bindingId
          && binding.serverId === runtimeInput.authority.serverId
          && binding.sourceConversationId === runtimeInput.authority.channelId
        );
        if (matches.length !== 1) return null;
        const binding = matches[0]!;
        if (
          binding.membership.receiptRevision !== runtimeInput.memberRevision
          || binding.oracle.oracleReceiptRevision !== runtimeInput.contextRevision
        ) return null;
        const decision = await resolveConfiguredBinding(binding, { now: runtimeInput.now });
        if (!decision.active || stopped) return null;
        const authority = decision.fact.bindingAuthority;
        if (
          authority.registrationId !== runtimeInput.authority.registrationId
          || authority.installId !== runtimeInput.authority.installId
          || authority.providerAuthorityId !== runtimeInput.authority.providerAuthorityId
          || authority.providerConversationId !== runtimeInput.authority.providerConversationId
          || authority.connectionEpoch !== runtimeInput.authority.connectionEpoch
          || authority.bindingEpoch !== runtimeInput.authority.bindingEpoch
          || authority.channelId !== runtimeInput.authority.channelId
        ) return null;
        return { runtimeRevision: decision.fact.runtimePredicateRevision };
      },
    } satisfies ExternalIngressRuntimeResolver : undefined,
  };

  let started = false;
  let stopped = false;
  let workerRunning = false;
  let workerPromise: Promise<unknown> | null = null;
  let timer: unknown | null = null;
  let uninstallOutbound: (() => void) | null = null;
  const outboundRuntime = config.outbound
    ? createLocalOutboundRuntime({
        config,
        outbound: config.outbound,
        key,
        db: db!,
        now,
        fetch: fetchImpl,
        fetchTimeoutMs,
        credentialLeases: providerCredentialLeases,
        providerAbortControllers,
        isStopped: () => stopped,
      })
    : null;

  const pruneProviderCredentials = async (at: Date) => {
    for (const [leaseId, lease] of providerCredentialLeases) {
      if (lease.expiresAt > at) continue;
      await db!.update(externalAppCredentials).set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: at,
      }).where(and(
        eq(externalAppCredentials.installId, lease.authority.installId),
        eq(externalAppCredentials.state, "active"),
        eq(externalAppCredentials.credentialRevision, lease.authority.credentialRevision),
        eq(externalAppCredentials.leaseOwner, leaseId),
        lte(externalAppCredentials.leaseExpiresAt, at),
      ));
      providerCredentialLeases.delete(leaseId);
    }
  };

  const scheduleWorker = (delayMs: number) => {
    if (!outboundRuntime || stopped) return;
    timer = setClockTimeout(() => {
      timer = null;
      if (stopped || workerRunning) return;
      workerRunning = true;
      workerPromise = (async () => {
        await pruneProviderCredentials(now());
        for (const binding of config.outbound!.bindings) {
          if (stopped) return;
          await runWorkerOnce({
            bindingId: binding.bindingId,
            bindingEpoch: binding.bindingEpoch,
            leaseOwner: config.outbound!.workerId,
            dependencies: outboundRuntime.workerDependencies,
            db: db!,
          });
        }
      })().catch(() => undefined).finally(() => {
        workerRunning = false;
        workerPromise = null;
        scheduleWorker(config.outbound!.pollIntervalMs);
      });
    }, delayMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  };

  return {
    ...routes,
    start() {
      if (started || stopped) return;
      started = true;
      if (!outboundRuntime) return;
      uninstallOutbound = installOrdinaryMessageOutboundRuntime({
        authorizationResolver: outboundRuntime.authorizationResolver,
        reconciliationMarkerMinter: ({ deliveryId }) =>
          mintSlackBridgeReconciliationMarker(key, deliveryId),
      });
      scheduleWorker(0);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearClockTimeout(timer);
      timer = null;
      uninstallOutbound?.();
      uninstallOutbound = null;
      for (const controller of providerAbortControllers) controller.abort();
      providerAbortControllers.clear();
      await workerPromise?.catch(() => undefined);
      const outstandingCredentialLeaseIds = [...providerCredentialLeases.keys()];
      appLeases.clear();
      codeHandles.clear();
      providerCredentialLeases.clear();
      if (db && outstandingCredentialLeaseIds.length > 0) {
        await db.update(externalAppCredentials).set({
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now(),
        }).where(and(
          eq(externalAppCredentials.state, "active"),
          inArray(externalAppCredentials.leaseOwner, outstandingCredentialLeaseIds),
        ));
      }
    },
  };
}
