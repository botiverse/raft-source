import { createHash } from "node:crypto";
import {
  currentDate,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  validateEmailAddress,
  validateName,
} from "@botiverse/raft-shared";

export const SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA =
  "slack-bridge-full-flow-preflight.v1" as const;
export const SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_MARGIN_MS = 35_000;

const REQUIRED_FLAGS = Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS);

export type SlackBridgeFullFlowPreflightGate =
  | "registration_input"
  | "user_ready"
  | "audience"
  | "topology"
  | "registration"
  | "grant_install"
  | "credential"
  | "manifest"
  | "binding"
  | "membership"
  | "oracle"
  | "author_policy"
  | "flags"
  | "baseline"
  | "network_fence";

export class SlackBridgeFullFlowPreflightError extends Error {
  constructor(readonly gate: SlackBridgeFullFlowPreflightGate) {
    super(`Slack Bridge full-flow preflight failed: ${gate}`);
    this.name = "SlackBridgeFullFlowPreflightError";
  }
}

export interface SlackBridgeFullFlowPreflightInput {
  schema: typeof SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA;
  identity: {
    userId: string;
    email: string;
    name: string;
    displayName: string;
    password: string;
    emailVerified: boolean;
    profileSetupCompleted: boolean;
  };
  audience: {
    serverId: string;
    channelId: string;
    ownerId: string;
    memberIds: string[];
    channelHumanIds: string[];
  };
  topology: {
    requestedChannelType: string;
    canonicalJointRows: number;
    localJointRows: number;
    externalBindingRows: number;
    runtimeBuildFingerprint: string;
    expectedRuntimeBuildFingerprint: string;
  };
  registration: {
    id: string;
    provider: string;
    environment: string;
    providerAppId: string;
    oauthClientId: string;
    oauthClientInstalled: boolean;
    manifestVersion: number;
    manifestHash: string;
  };
  grant: {
    id: string;
    serverId: string;
    registrationId: string;
    grantEpoch: number;
    manifestVersion: number;
    manifestHash: string;
  };
  install: {
    id: string;
    serverId: string;
    registrationId: string;
    serverGrantId: string;
    state: string;
    grantEpoch: number;
    connectionEpoch: number;
    credentialRevision: number;
    providerAppId: string;
    providerAuthorityId: string;
  };
  credential: {
    installId: string;
    state: string;
    credentialRevision: number;
    envelopeKeyId: string;
    aadVersion: number;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
  };
  manifest: {
    registrationId: string;
    status: string;
    receiptRevision: number;
    managerCredentialRevision: number;
    providerAppId: string;
    normalizedManifestHash: string;
    expiresAt: string;
  };
  signingSecret: {
    registrationId: string;
    purpose: string;
    secretRevision: number;
    envelopeKeyId: string;
    aadVersion: number;
  };
  binding: {
    id: string;
    serverId: string;
    registrationId: string;
    installId: string;
    channelId: string;
    state: string;
    connectionEpoch: number;
    bindingEpoch: number;
    privacyClass: string;
    providerConversationId: string;
    consentRevision: number;
  };
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
    privacyClass: string;
    level: string;
    releaseContractRevision: string;
    oracleReceiptSchema: string;
    oracleReceiptRevision: number;
    inboundGreen: boolean;
    outboundGreen: boolean;
    expiresAt: string;
  };
  authorPolicy: {
    serverId: string;
    provider: string;
    registrationId: string;
    installId: string;
    bindingId: string;
    bindingEpoch: number;
    authorId: string;
    displayName: string;
    consentRevision: number;
    state: string;
  };
  flags: {
    configRevision: number;
    enabled: Record<string, boolean>;
  };
  baseline: {
    sourceMessages: number;
    outboundDeliveries: number;
    providerLinks: number;
    deliveryAttempts: number;
    activeCredentialLeases: number;
  };
  executionFence: {
    providerNetworkDisabled: boolean;
    localSlackSinkOnly: boolean;
  };
}

function fail(gate: SlackBridgeFullFlowPreflightGate): never {
  throw new SlackBridgeFullFlowPreflightError(gate);
}

function isFutureBeyondMargin(value: string, capturedAtMs: number): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
    && parsed.getTime() > capturedAtMs + SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_MARGIN_MS;
}

function sameMembers(left: string[], right: string[]): boolean {
  return [...new Set(left)].sort().join("\0") === [...new Set(right)].sort().join("\0");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/**
 * Final execution preflight for the provider-disabled full-flow harness.
 *
 * The clock is intentionally sampled inside this entry point. Receipts are
 * nested authoritative objects; there are no detached expiry overrides that
 * can make an expired resolver input appear fresh.
 */
export function runSlackBridgeFullFlowPreflight(input: SlackBridgeFullFlowPreflightInput): {
  schema: typeof SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA;
  capturedAt: string;
  validThrough: string;
  inputDigest: string;
} {
  const capturedAt = currentDate();
  const capturedAtMs = capturedAt.getTime();

  if (
    input.schema !== SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA
    || validateName(input.identity.name, "Name", 5) !== null
    || input.identity.displayName.trim().length === 0
    || validateEmailAddress(input.identity.email) !== null
    || input.identity.password.length < 8
  ) fail("registration_input");
  if (!input.identity.userId || !input.identity.emailVerified || !input.identity.profileSetupCompleted) {
    fail("user_ready");
  }
  if (
    !input.audience.serverId
    || !input.audience.channelId
    || input.audience.ownerId !== input.identity.userId
    || input.audience.memberIds.length !== 2
    || input.audience.channelHumanIds.length !== 2
    || !sameMembers(input.audience.memberIds, input.audience.channelHumanIds)
    || !input.audience.memberIds.includes(input.identity.userId)
  ) fail("audience");
  if (
    input.topology.requestedChannelType !== "channel"
    || input.topology.canonicalJointRows !== 0
    || input.topology.localJointRows !== 0
    || input.topology.externalBindingRows !== 1
    || !/^[0-9a-f]{64}$/.test(input.topology.runtimeBuildFingerprint)
    || !/^[0-9a-f]{64}$/.test(input.topology.expectedRuntimeBuildFingerprint)
    || input.topology.runtimeBuildFingerprint !== input.topology.expectedRuntimeBuildFingerprint
  ) fail("topology");
  if (
    !input.registration.id
    || input.registration.provider !== "slack"
    || input.registration.environment !== "test"
    || !input.registration.providerAppId
    || !input.registration.oauthClientId
    || !input.registration.oauthClientInstalled
    || input.registration.manifestVersion <= 0
    || !input.registration.manifestHash
  ) fail("registration");
  if (
    !input.grant.id
    || input.grant.serverId !== input.audience.serverId
    || input.grant.registrationId !== input.registration.id
    || input.grant.grantEpoch <= 0
    || input.grant.manifestVersion !== input.registration.manifestVersion
    || input.grant.manifestHash !== input.registration.manifestHash
    || input.install.serverId !== input.audience.serverId
    || input.install.registrationId !== input.registration.id
    || input.install.serverGrantId !== input.grant.id
    || input.install.state !== "active"
    || input.install.grantEpoch !== input.grant.grantEpoch
    || input.install.connectionEpoch <= 0
    || input.install.credentialRevision <= 0
    || input.install.providerAppId !== input.registration.providerAppId
    || !input.install.providerAuthorityId
  ) fail("grant_install");
  if (
    input.credential.installId !== input.install.id
    || input.credential.state !== "active"
    || input.credential.credentialRevision !== input.install.credentialRevision
    || !input.credential.envelopeKeyId
    || input.credential.aadVersion !== 1
    || input.credential.leaseOwner !== null
    || input.credential.leaseExpiresAt !== null
  ) fail("credential");
  if (
    input.manifest.registrationId !== input.registration.id
    || input.manifest.status !== "valid"
    || input.manifest.receiptRevision <= 0
    || input.manifest.managerCredentialRevision <= 0
    || input.manifest.providerAppId !== input.registration.providerAppId
    || input.manifest.normalizedManifestHash !== input.registration.manifestHash
    || !isFutureBeyondMargin(input.manifest.expiresAt, capturedAtMs)
    || input.signingSecret.registrationId !== input.registration.id
    || input.signingSecret.purpose !== "signing_secret"
    || input.signingSecret.secretRevision <= 0
    || input.signingSecret.envelopeKeyId !== input.credential.envelopeKeyId
    || input.signingSecret.aadVersion !== 1
  ) fail("manifest");
  if (
    !input.binding.id
    || input.binding.serverId !== input.audience.serverId
    || input.binding.registrationId !== input.registration.id
    || input.binding.installId !== input.install.id
    || input.binding.channelId !== input.audience.channelId
    || input.binding.state !== "active"
    || input.binding.connectionEpoch !== input.install.connectionEpoch
    || input.binding.bindingEpoch <= 0
    || input.binding.privacyClass !== "public"
    || !input.binding.providerConversationId
    || input.binding.consentRevision <= 0
  ) fail("binding");
  if (
    input.membership.registrationId !== input.registration.id
    || input.membership.installId !== input.install.id
    || input.membership.bindingId !== input.binding.id
    || input.membership.connectionEpoch !== input.binding.connectionEpoch
    || input.membership.bindingEpoch !== input.binding.bindingEpoch
    || input.membership.providerAuthorityId !== input.install.providerAuthorityId
    || input.membership.providerConversationId !== input.binding.providerConversationId
    || input.membership.receiptRevision <= 0
    || !isFutureBeyondMargin(input.membership.expiresAt, capturedAtMs)
  ) fail("membership");
  if (
    input.oracle.bindingId !== input.binding.id
    || input.oracle.connectionEpoch !== input.binding.connectionEpoch
    || input.oracle.bindingEpoch !== input.binding.bindingEpoch
    || input.oracle.privacyClass !== input.binding.privacyClass
    || input.oracle.level !== "top_level"
    || input.oracle.releaseContractRevision !== "slack-bridge-revision-5"
    || input.oracle.oracleReceiptSchema !== "slack-bridge-oracle-receipt.v1"
    || input.oracle.oracleReceiptRevision <= 0
    || !input.oracle.inboundGreen
    || !input.oracle.outboundGreen
    || !isFutureBeyondMargin(input.oracle.expiresAt, capturedAtMs)
  ) fail("oracle");
  if (
    input.authorPolicy.serverId !== input.audience.serverId
    || input.authorPolicy.provider !== "slack"
    || input.authorPolicy.registrationId !== input.registration.id
    || input.authorPolicy.installId !== input.install.id
    || input.authorPolicy.bindingId !== input.binding.id
    || input.authorPolicy.bindingEpoch !== input.binding.bindingEpoch
    || input.authorPolicy.authorId !== input.identity.userId
    || input.authorPolicy.displayName !== input.identity.displayName
    || input.authorPolicy.consentRevision !== input.binding.consentRevision
    || input.authorPolicy.state !== "granted"
  ) fail("author_policy");
  if (
    input.flags.configRevision <= 0
    || REQUIRED_FLAGS.some((key) => input.flags.enabled[key] !== true)
  ) fail("flags");
  if (
    input.baseline.sourceMessages !== 0
    || input.baseline.outboundDeliveries !== 0
    || input.baseline.providerLinks !== 0
    || input.baseline.deliveryAttempts !== 0
    || input.baseline.activeCredentialLeases !== 0
  ) fail("baseline");
  if (!input.executionFence.providerNetworkDisabled || !input.executionFence.localSlackSinkOnly) {
    fail("network_fence");
  }

  const inputDigest = createHash("sha256")
    .update(JSON.stringify(canonicalize(input)), "utf8")
    .digest("hex");
  return {
    schema: SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_SCHEMA,
    capturedAt: capturedAt.toISOString(),
    validThrough: new Date(capturedAtMs + SLACK_BRIDGE_FULL_FLOW_PREFLIGHT_MARGIN_MS).toISOString(),
    inputDigest,
  };
}
