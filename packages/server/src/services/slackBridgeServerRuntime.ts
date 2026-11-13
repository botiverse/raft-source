import { parseSlackAttachmentFallbackDeployment, SLACK_ATTACHMENT_FALLBACK_ENV_KEYS } from "./slackAttachmentFallbackDeployment";
import { randomUUID } from "node:crypto";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS, type Tracer } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";

import { getDb, getRootDb, type Database, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { createSlackVerifiedIngressAdmission } from "./slackVerifiedIngressAdmission";
import { createSlackVerifiedIngressEnvCrypto } from "./slackVerifiedIngressEnvCrypto";
import { createSlackVerifiedIngressPreparer } from "./slackVerifiedIngressPrepare";
import { createSlackBotProfileRefresher } from "./slackBotProfileRefresh";
import { createSlackVerifiedIngressWorkerRuntime } from "./slackVerifiedIngressRuntime";
import {
  externalActorProjections,
  externalAppInstalls,
  externalChannelBindings,
} from "../db/schema";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import {
  createExternalInboundWorkerRuntime,
  type ExternalInboundWorkerDependencies,
} from "./externalInboundWorkerService";
import type { ExternalDeliveryAuthorityAlert } from "./externalDeliveryWorkerService";
import {
  createExternalInboundAttachmentWorkerRuntime,
  type ExternalInboundAttachmentWorkerDependencies,
} from "./externalInboundAttachmentWorkerService";
import type { ExternalAttachmentAuthority } from "./externalAttachmentProviderAdapter";
import {
  createSlackDatabaseInboundWorkerRuntimeResolver,
  createSlackDatabaseIngressRuntimeResolver,
} from "./slackBridgeDatabaseRuntimeAuthority";
import { createSlackBridgeDatabaseOutboundRuntime } from "./slackBridgeDatabaseOutboundRuntime";
import { createSlackCardEditProductionDependencies, createSlackCardEditWorkerRuntime } from "./slackCardEditWorkerService";
import {
  createSlackBridgeEnvSecretBackends,
  slackBridgeKeyFromEnv,
  slackBridgePayloadKeyringFromEnv,
  SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF,
  SLACK_BRIDGE_SIGNING_SECRET_REF,
} from "./slackBridgeEnvSecrets";
import {
  createSlackBridgeManagedRuntime,
  type SlackBridgeManagedRuntime,
} from "./slackBridgeManagedRuntime";
import { createSlackBridgeOAuthCompletionRedirectPathResolver } from "./slackBridgeOAuthCompletionRedirect";
import {
  createSlackBridgeProductionLifecycle,
} from "./slackBridgeProductionLifecycle";
import {
  createSlackBridgeProviderRuntime,
  type SlackInstallTokenRevokeOutcome,
} from "./slackBridgeProviderRuntime";
import {
  createSlackBridgeProvisioningControlPlane,
  slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
} from "./slackBridgeProvisioningControlPlane";
import type {
  SlackBridgeLifecycleExecutionReceipt,
  SlackBridgePersistentWorkerClock,
} from "./slackBridgeWorkerLifecycle";
import { evaluateFeatureFlag } from "./featureFlagService";
import { getAttachmentFileSizeLimitBytes } from "./attachmentUploadPolicy";
import { getFileUploadQuotaSummary } from "./fileUploadQuotaService";
import { getCdnStorage, getStorage } from "./storageService";
import { createSlackInboundAttachmentAdapter } from "./slackInboundAttachmentAdapter";
import { hasVerifiedSlackFileFact } from "./slackVerifiedInboundFileProvenance";
import { applySlackVerifiedIngressDeployment, parseSlackVerifiedIngressDeployment } from "./slackVerifiedIngressDeployment";
import { createSlackAvatarSourceAdapter } from "./slackAvatarSourceAdapter";
import { materializeExternalProjectionAvatar } from "./externalAvatarMaterializerService";
import { installExternalReactionCommandHandler } from "./externalReactionCommandRuntime";
import { enqueueSlackReactionAggregateTransition } from "./externalReactionSyncService";
import { createExternalReactionWorkerRuntime } from "./externalReactionWorkerService";
import { refreshSlackChannelBindingsPrivacy } from "./slackBindingPrivacyFreshnessService";
import type { SlackMentionReconcileClaim } from "./slackMentionReconcileClaim";
import {
  createSlackBridgeQueueMetricsSampler,
  observeSlackInboundWorkerResult,
  observeSlackLifecycleHealth,
} from "./slackBridgeQueueMetrics";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SlackBridgeProductionServerRuntime extends SlackBridgeManagedRuntime {
  start(): void;
  revalidateChannelPrivacy(input: { serverId: string; channelId: string; now: Date }): Promise<readonly { kind: string; reason?: string }[]>;
  /** auth.revoke for an install's stored token (the closed-server purge; slackBridgeProviderRuntime.ts). */
  revokeInstallToken(installId: string): Promise<SlackInstallTokenRevokeOutcome>;
  inboundWorkerDependencies: Pick<
    ExternalInboundWorkerDependencies,
    "decryptNormalizedPayload" | "resolveCurrentRuntime" | "resolveProviderMentionProfiles"
      | "resolveProviderAgentMentionHandles"
  >;
  inboundAttachmentWorkerDependencies: ExternalInboundAttachmentWorkerDependencies;
}

export type SlackBridgeServerRuntime = SlackBridgeProductionServerRuntime;

export interface SlackBridgeServerRuntimeDependencies {
  db?: Database;
  fetch?: typeof fetch;
  now?: () => Date;
  lifecycleClock?: SlackBridgePersistentWorkerClock;
  lifecycleIntervalMs?: number;
  claimLifecycleRun?(): Promise<SlackMentionReconcileClaim | null>;
  claimAgentMentionReconcile?(
    serverId: string,
    installId: string,
  ): Promise<SlackMentionReconcileClaim | null>;
  inboundWorkerLeaseOwner?: string;
  inboundWorkerIntervalMs?: number;
  verifiedIngressWorkerLeaseOwner?: string;
  verifiedIngressWorkerIntervalMs?: number;
  inboundAttachmentWorkerLeaseOwner?: string;
  inboundAttachmentWorkerIntervalMs?: number;
  outboundWorkerLeaseOwner?: string;
  outboundWorkerIntervalMs?: number;
  reactionWorkerLeaseOwner?: string;
  reactionWorkerIntervalMs?: number;
  cardEditWorkerLeaseOwner?: string;
  cardEditWorkerIntervalMs?: number;
  onLifecycleReceipt?(receipt: SlackBridgeLifecycleExecutionReceipt): void;
  onLifecycleError?(error: unknown): void;
  onInboundMessageCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onInboundMessageEdited?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onInboundReactionCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onInboundRealtimeError?(error: unknown): void;
  onOutboundAuthorityAlert?(alert: ExternalDeliveryAuthorityAlert): void;
  onOutboundError?(error: unknown): void;
  onInboundError?(error: unknown): void;
  onInboundAttachmentError?(error: unknown): void;
  onQueueMetricsError?(error: unknown): void;
  queueMetricsIntervalMs?: number;
  tracer?: Tracer;
}

export async function slackAttachmentAuthorityIsCurrent(
  executor: DatabaseExecutor,
  authority: ExternalAttachmentAuthority,
  sourceActorProjectionId: string,
  custody?: { factId: string; eventId: string; providerFileId: string },
): Promise<boolean | "paused"> {
  if (
    authority.provider !== "slack"
    || authority.workspaceId !== authority.providerAuthorityId
  ) return false;
  const rows = await executor.select({
    installId: externalAppInstalls.id,
    serverId: externalChannelBindings.serverId,
    registrationId: externalChannelBindings.registrationId,
    bindingGrantEpoch: externalChannelBindings.grantEpoch,
  }).from(externalAppInstalls)
    .innerJoin(externalChannelBindings, eq(externalChannelBindings.installId, externalAppInstalls.id))
    .where(and(
      eq(externalAppInstalls.id, authority.installId),
      eq(externalAppInstalls.registrationId, authority.appRegistrationId),
      eq(externalAppInstalls.providerAuthorityId, authority.providerAuthorityId),
      eq(externalAppInstalls.connectionEpoch, authority.connectionEpoch),
      eq(externalAppInstalls.state, "active"),
      eq(externalChannelBindings.id, authority.bindingId),
      eq(externalChannelBindings.providerConversationId, authority.providerConversationId),
      eq(externalChannelBindings.connectionEpoch, authority.connectionEpoch),
      eq(externalChannelBindings.bindingEpoch, authority.bindingEpoch),
      eq(externalChannelBindings.state, "active"),
    )).limit(2);
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  const serverAuthority = await resolveExternalInstallServerGrantAuthority(executor, {
    installId: row.installId,
    serverId: row.serverId,
    registrationId: row.registrationId,
  });
  if (!serverAuthority.current || row.bindingGrantEpoch !== serverAuthority.grant.grantEpoch) {
    return false;
  }
  const [actor] = await executor.select({ id: externalActorProjections.id, state: externalActorProjections.state,
    deactivated: externalActorProjections.deactivated, actorKind: externalActorProjections.actorKind })
    .from(externalActorProjections)
    .where(and(
      eq(externalActorProjections.id, sourceActorProjectionId),
      eq(externalActorProjections.provider, authority.provider),
      eq(externalActorProjections.appRegistrationId, authority.appRegistrationId),
      eq(externalActorProjections.installId, authority.installId),
      eq(externalActorProjections.workspaceId, authority.workspaceId),
    )).limit(2);
  if (!actor) return false;
  if (["unknown", "guest", "remote"].includes(actor.actorKind) && (!custody || !await hasVerifiedSlackFileFact(executor, {
    ...custody, projectionId: actor.id,
  }))) return false;
  if (actor.state !== "active" || actor.deactivated) {
    if (!(["human", "guest", "remote", "unknown"].includes(actor.actorKind)) || !custody || !await hasVerifiedSlackFileFact(executor, {
      ...custody, projectionId: actor.id,
    })) return false;
  }
  return (await evaluateFeatureFlag({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    serverId: row.serverId,
  }, executor as Database)).enabled ? true : "paused";
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Slack Bridge production runtime requires ${name}`);
  return value;
}

function httpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Slack Bridge production runtime ${name} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Slack Bridge production runtime ${name} must be credential-free HTTPS`);
  }
  return url.toString();
}

function managedAppOrigin(
  value: string,
  runtimeEnvironment: "test" | "production",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Slack Bridge production runtime app URL is invalid");
  }
  const protocolAllowed = runtimeEnvironment === "production"
    ? url.protocol === "https:"
    : url.protocol === "https:" || url.protocol === "http:";
  if (!protocolAllowed || url.username || url.password) {
    const protocol = runtimeEnvironment === "production" ? "HTTPS" : "HTTP(S)";
    throw new Error(
      `Slack Bridge production runtime app URL must be credential-free ${protocol}`,
    );
  }
  return url.origin;
}

function environment(value: string): "test" | "production" {
  if (value === "test" || value === "production") return value;
  throw new Error("Slack Bridge production runtime environment is invalid");
}

function registrationId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("Slack Bridge registration id is invalid");
  return value;
}

const PRODUCTION_ENV_KEYS = [
  "SLACK_BRIDGE_ENVIRONMENT",
  "SLACK_BRIDGE_REGISTRATION_ID",
  "SLACK_BRIDGE_PROVIDER_APP_ID",
  "SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID",
  "SLACK_BRIDGE_OAUTH_REDIRECT_URI",
  "SLACK_BRIDGE_EVENTS_REQUEST_URL",
  "SLACK_BRIDGE_SIGNING_SECRET",
  "SLACK_BRIDGE_OAUTH_CLIENT_SECRET",
  "SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY",
  "SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY",
  "SLACK_BRIDGE_PAYLOAD_ACTIVE_KEY_ID",
  "SLACK_BRIDGE_PAYLOAD_DECRYPTION_KEYS",
] as const;

const LEGACY_ENV_KEYS = [
  "SLACK_BRIDGE_RUNTIME_MODE",
  "SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE",
  "SLACK_BRIDGE_CREDENTIAL_KMS_KEY_ID",
  "SLACK_BRIDGE_PAYLOAD_KMS_KEY_ID",
] as const;

/**
 * Creates the only deployable Slack Bridge composition. Static app secrets
 * come directly from process env; runtime-generated bot credentials and
 * normalized ingress payloads use env master keys plus tenant/install AAD.
 * Any partial or legacy runtime configuration fails closed at process startup.
 */
export async function createSlackBridgeServerRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SlackBridgeServerRuntimeDependencies = {},
): Promise<SlackBridgeServerRuntime | undefined> {
  const configured = [...PRODUCTION_ENV_KEYS, ...SLACK_ATTACHMENT_FALLBACK_ENV_KEYS].some((key) => Boolean(env[key]?.trim()));
  const legacyConfigured = LEGACY_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
  if (!configured && !legacyConfigured) return undefined;
  if (legacyConfigured) {
    throw new Error("Slack Bridge legacy local/AWS runtime configuration is not supported");
  }

  const runtimeEnvironment = environment(requiredEnv(env, "SLACK_BRIDGE_ENVIRONMENT"));
  const attachmentFallbackDeployment = parseSlackAttachmentFallbackDeployment(env);
  // Invalid or absent diagnostic configuration leaves observation disabled;
  // it must never prevent the bridge itself from starting.
  const observationRaw = env.SLACK_BRIDGE_OBSERVE_CHANNEL_IDS?.trim() ?? "";
  const observationParts = observationRaw ? observationRaw.split(",").map(value => value.trim()) : [];
  const observationChannels = observationParts.length <= 16
    && observationParts.every(value => /^[CG][A-Z0-9]+$/.test(value))
    ? [...new Set(observationParts)] : [];
  if (observationRaw && observationChannels.length === 0) {
    console.warn("Slack identity observation configuration is invalid; observation disabled");
  }
  const runtimeRegistrationId = registrationId(requiredEnv(env, "SLACK_BRIDGE_REGISTRATION_ID"));
  const providerAppId = requiredEnv(env, "SLACK_BRIDGE_PROVIDER_APP_ID");
  const providerOAuthClientId = requiredEnv(env, "SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID");
  const oauthRedirectUri = httpsUrl(
    requiredEnv(env, "SLACK_BRIDGE_OAUTH_REDIRECT_URI"),
    "OAuth redirect URI",
  );
  const eventsRequestUrl = httpsUrl(
    requiredEnv(env, "SLACK_BRIDGE_EVENTS_REQUEST_URL"),
    "events request URL",
  );
  const payloadEncryptionKey = slackBridgeKeyFromEnv(
    env.SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY,
    "SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY",
  );
  const { activePayloadKey, activePayloadKeyId, payloadReadKeys } = slackBridgePayloadKeyringFromEnv(
    payloadEncryptionKey, env.SLACK_BRIDGE_PAYLOAD_ACTIVE_KEY_ID, env.SLACK_BRIDGE_PAYLOAD_DECRYPTION_KEYS,
  );
  const secretBackends = createSlackBridgeEnvSecretBackends({
    registrationId: runtimeRegistrationId,
    environment: runtimeEnvironment,
    providerAppId,
    providerOAuthClientId,
    signingSecret: requiredEnv(env, "SLACK_BRIDGE_SIGNING_SECRET"),
    oauthClientSecret: requiredEnv(env, "SLACK_BRIDGE_OAUTH_CLIENT_SECRET"),
    credentialEncryptionKey: slackBridgeKeyFromEnv(
      env.SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY,
      "SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY",
    ),
    payloadEncryptionKey: activePayloadKey, payloadKeyId: activePayloadKeyId, payloadDecryptionKeys: payloadReadKeys,
  });
  const db = dependencies.db;
  const appOrigin = managedAppOrigin(
    requiredEnv(env, "APP_URL"),
    runtimeEnvironment,
  );
  // Reconcile reviewed deployment config before any ingress or worker is
  // started. Each replica reads the same monotone DB policy thereafter.
  try {
    const ingressDeployment = parseSlackVerifiedIngressDeployment(env);
    if (ingressDeployment) {
      const result = await applySlackVerifiedIngressDeployment({ db: db ?? getDb(), config: ingressDeployment,
        now: dependencies.now?.() ?? new Date() });
      if (result === "conflict") throw new Error("Slack ingress deployment generation conflicts with persisted policy");
    }
  } catch {
    // Fail the new replica's startup rather than advertise a healthy server
    // with a permanently absent bridge. The deployment can retain the prior
    // replicas; it must not start a legacy ingress path on uncertain policy.
    const error = new Error("Slack ingress deployment configuration could not be applied");
    try { dependencies.onInboundError?.(error); } catch { /* reporting must not start the bridge */ }
    throw error;
  }
  const provider = createSlackBridgeProviderRuntime({
    credentialCipher: secretBackends.credentialCipher,
    ...(db ? { db } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const avatarStorage = getCdnStorage() ?? getStorage();
  const avatarSource = createSlackAvatarSourceAdapter(dependencies.fetch ? { fetch: dependencies.fetch } : {});
  const avatarMaterializer = avatarStorage ? {
    materializeExternalProjection: (input: {
      projectionId: string;
      expectedProjectionRevision: number;
      expectedObservedAt?: Date;
      sourceLocator: string | null;
      lockAdditionalAuthority?: (tx: DatabaseTransaction) => Promise<boolean>;
    }) => materializeExternalProjectionAvatar({
      db: db ?? getDb(),
      storage: avatarStorage,
      source: avatarSource,
      publicOrigin: new URL(eventsRequestUrl).origin,
      ...input,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    }),
  } : undefined;
  const provisioning = createSlackBridgeProvisioningControlPlane({
    ...(db ? { db } : {}),
    provider: provider.provisioningProvider,
    ...(avatarMaterializer ? { avatarMaterializer } : {}),
    bootstrap: {
      registrationId: runtimeRegistrationId,
      environment: runtimeEnvironment,
      providerAppId,
      providerOAuthClientId,
      oauthRedirectUri,
      eventsRequestUrl,
      capabilityManifestVersion: 1,
      capabilityManifestHash: slackBridgeProvisioningManifestHash({
        oauthRedirectUri,
        eventsRequestUrl,
      }),
      requiredCapabilities: SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
      signingSecret: {
        encryptedSecretRef: SLACK_BRIDGE_SIGNING_SECRET_REF,
        envelopeKeyId: "env:process",
        secretRevision: 1,
      },
      oauthClientSecret: {
        encryptedSecretRef: SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF,
        envelopeKeyId: "env:process",
        secretRevision: 1,
      },
    },
  });
  const queueMetrics = createSlackBridgeQueueMetricsSampler({
    db: db ?? getDb(),
    registrationId: runtimeRegistrationId,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.queueMetricsIntervalMs ? { intervalMs: dependencies.queueMetricsIntervalMs } : {}),
    onError: dependencies.onQueueMetricsError,
  });
  const lifecycle = createSlackBridgeProductionLifecycle({
    provider,
    pairBacklog: (bindingId) => queueMetrics.pairBacklog(bindingId),
    ...(avatarMaterializer ? { avatarMaterializer } : {}),
    ...(db ? { db } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.lifecycleClock ? { clock: dependencies.lifecycleClock } : {}),
    ...(dependencies.lifecycleIntervalMs ? { intervalMs: dependencies.lifecycleIntervalMs } : {}),
    ...(dependencies.claimLifecycleRun ? { claimRun: dependencies.claimLifecycleRun } : {}),
    ...(dependencies.claimAgentMentionReconcile
      ? { claimAgentMentionReconcile: dependencies.claimAgentMentionReconcile }
      : {}),
    onReceipt(receipt) {
      observeSlackLifecycleHealth(receipt);
      dependencies.onLifecycleReceipt?.(receipt);
    },
    onError: dependencies.onLifecycleError,
    tracer: dependencies.tracer,
  });
  const verifiedIngressCrypto = createSlackVerifiedIngressEnvCrypto({ key: activePayloadKey,
    keyId: activePayloadKeyId, decryptionKeys: payloadReadKeys, registrationId: runtimeRegistrationId,
    environment: runtimeEnvironment, providerAppId });
  const ingressRuntimeResolver = createSlackDatabaseIngressRuntimeResolver(db);
  const botProfiles = createSlackBotProfileRefresher({ db: db ?? getDb(), provider,
    ...(avatarMaterializer ? { avatarMaterializer } : {}), now: dependencies.now ?? (() => new Date()),
    onError: dependencies.onLifecycleError });
  const verifiedIngressWorker = createSlackVerifiedIngressWorkerRuntime({
    db: db ?? getDb(), crypto: verifiedIngressCrypto,
    scope: { registrationId: runtimeRegistrationId, environment: runtimeEnvironment },
    leaseOwner: dependencies.verifiedIngressWorkerLeaseOwner ?? `slack-verified:${runtimeRegistrationId}:${randomUUID()}`,
    leaseMs: 60_000, now: dependencies.now ?? (() => new Date()),
    prepare: createSlackVerifiedIngressPreparer({ db: db ?? getDb(), payloadSealer: secretBackends.payloadSealer,
      runtimeResolver: ingressRuntimeResolver, now: dependencies.now ?? (() => new Date()),
      botSyncEnabled: env.SLACK_BRIDGE_BOT_SYNC_ENABLED === "true" }),
    requestAuthorRefresh: () => lifecycle.requestEventReconcile(),
    requestBotProfileRefresh: hint => botProfiles.request(hint),
    onAuthorRefreshError: dependencies.onLifecycleError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge author refresh hint failed", error);
    }),
    ...(dependencies.verifiedIngressWorkerIntervalMs ? { intervalMs: dependencies.verifiedIngressWorkerIntervalMs } : {}),
    onError: dependencies.onInboundError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge verified ingress worker tick failed", error);
    }),
  });
  const runtime = createSlackBridgeManagedRuntime({
    environment: runtimeEnvironment,
    oauthRedirectUri,
    eventsRequestUrl,
    appOrigin,
    isLaunchEnabled: async ({ serverId }) => (
      await evaluateFeatureFlag(
        { key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId },
        db ?? getDb(),
      )
    ).enabled,
    resolveOAuthCompletionRedirectPath:
      createSlackBridgeOAuthCompletionRedirectPathResolver({ db }),
    appSecrets: secretBackends.appSecrets,
    credentialSealer: secretBackends.credentialCipher.sealer,
    secretResolver: secretBackends.secretResolver,
    payloadSealer: secretBackends.payloadSealer,
    admitSlackIngress: createSlackVerifiedIngressAdmission({
      // Fresh primary reads; never hold an outer transaction across admission
      // (provider/runtime work owns its own short transactions).
      getFenceDb: () => dependencies.db ?? getRootDb(),
      crypto: verifiedIngressCrypto,
    }),
    ...(observationChannels.length ? { testIdentityObserver: {
      providerConversationIds: observationChannels,
      record: (sample: import("./slackInboundIdentityObservation").SlackInboundIdentityObservation) => {
        // Keep this structured object limited to the booleans in its type.
        console.info("slack_test_identity_observation", sample);
      },
    } } : {}),
    provisioning,
    runtimeResolver: ingressRuntimeResolver,
    readLifecycleMemberProfile: (bindingId, userId) => lifecycle.readMemberProfile(bindingId, userId),
    requestLifecycleReconcile: (bindingId) => bindingId
      ? lifecycle.requestConversationReconcile(bindingId) : lifecycle.requestEventReconcile(),
    onLifecycleError: dependencies.onLifecycleError,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const inboundWorkerDependencies = {
    decryptNormalizedPayload: secretBackends.decryptNormalizedPayload,
    resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(db, dependencies.now),
    async resolveProviderMentionProfiles(input: {
      frozenAuthority: Parameters<NonNullable<ExternalInboundWorkerDependencies["resolveProviderMentionProfiles"]>>[0]["frozenAuthority"];
      providerUserIds: readonly string[];
    }) {
      if (input.frozenAuthority.provider !== "slack" || input.providerUserIds.length === 0) return [];
      const executor = db ?? getDb();
      const installs = await executor.select({
        id: externalAppInstalls.id,
        providerAppId: externalAppInstalls.providerAppId,
        providerAuthorityId: externalAppInstalls.providerAuthorityId,
        botUserId: externalAppInstalls.botUserId,
        connectionEpoch: externalAppInstalls.connectionEpoch,
        credentialRevision: externalAppInstalls.credentialRevision,
      }).from(externalAppInstalls).where(and(
        eq(externalAppInstalls.id, input.frozenAuthority.installId),
        eq(externalAppInstalls.registrationId, input.frozenAuthority.appRegistrationId),
        eq(externalAppInstalls.providerAuthorityId, input.frozenAuthority.providerAuthorityId),
        eq(externalAppInstalls.connectionEpoch, input.frozenAuthority.connectionEpoch),
        eq(externalAppInstalls.state, "active"),
      )).limit(2);
      const install = installs.length === 1 ? installs[0]! : null;
      if (!install?.botUserId) return [];
      const observedAt = dependencies.now?.() ?? new Date();
      const resolved = await provider.resolveUsers({
        installId: install.id,
        providerAppId: install.providerAppId,
        providerAuthorityId: install.providerAuthorityId,
        botUserId: install.botUserId,
        connectionEpoch: install.connectionEpoch,
        credentialRevision: install.credentialRevision,
        now: observedAt,
      }, input.providerUserIds);
      return resolved.kind === "fact"
        ? resolved.fact.users.map((user) => ({
          providerUserId: user.id,
          displayName: user.displayName,
          handle: user.handle,
        }))
        : [];
    },
    async resolveProviderAgentMentionHandles(input: {
      frozenAuthority: Parameters<NonNullable<ExternalInboundWorkerDependencies["resolveProviderAgentMentionHandles"]>>[0]["frozenAuthority"];
      providerUsergroupIds: readonly string[];
    }) {
      if (input.frozenAuthority.provider !== "slack" || input.providerUsergroupIds.length === 0) {
        return [];
      }
      const executor = db ?? getDb();
      const [binding] = await executor.select({
        serverId: externalChannelBindings.serverId,
        installId: externalChannelBindings.installId,
        registrationId: externalChannelBindings.registrationId,
      }).from(externalChannelBindings).where(and(
        eq(externalChannelBindings.id, input.frozenAuthority.bindingId),
        eq(externalChannelBindings.installId, input.frozenAuthority.installId),
        eq(externalChannelBindings.registrationId, input.frozenAuthority.appRegistrationId),
        eq(externalChannelBindings.channelId, input.frozenAuthority.raftChannelId),
        eq(externalChannelBindings.bindingEpoch, input.frozenAuthority.bindingEpoch),
        eq(externalChannelBindings.connectionEpoch, input.frozenAuthority.connectionEpoch),
        eq(externalChannelBindings.state, "active"),
      )).limit(2);
      if (!binding) return null;
      const grant = await resolveExternalInstallServerGrantAuthority(executor, {
        installId: binding.installId,
        serverId: binding.serverId,
        registrationId: binding.registrationId,
      });
      if (!grant.current) return null;
      const [install] = await executor.select({
        id: externalAppInstalls.id,
        providerAppId: externalAppInstalls.providerAppId,
        providerAuthorityId: externalAppInstalls.providerAuthorityId,
        botUserId: externalAppInstalls.botUserId,
        connectionEpoch: externalAppInstalls.connectionEpoch,
        credentialRevision: externalAppInstalls.credentialRevision,
        installedScopes: externalAppInstalls.installedScopes,
      }).from(externalAppInstalls).where(and(
        eq(externalAppInstalls.id, binding.installId),
        eq(externalAppInstalls.registrationId, binding.registrationId),
        eq(externalAppInstalls.connectionEpoch, input.frozenAuthority.connectionEpoch),
        eq(externalAppInstalls.state, "active"),
      )).limit(2);
      if (!install?.botUserId) return null;
      // Installs that authorized before the Agent-mention scopes existed keep
      // message sync without usergroup support: treat a scope-less install as
      // "no agent mentions" instead of a provider failure that would block the
      // message forever. The usergroup token still renders as plain text.
      if (!install.installedScopes.includes("usergroups:read")) return [];
      const resolved = await provider.resolveAgentMentionHandles({
        installId: install.id,
        providerAppId: install.providerAppId,
        providerAuthorityId: install.providerAuthorityId,
        botUserId: install.botUserId,
        connectionEpoch: install.connectionEpoch,
        credentialRevision: install.credentialRevision,
        now: dependencies.now?.() ?? new Date(),
      }, {
        serverId: binding.serverId,
        providerUsergroupIds: input.providerUsergroupIds,
      });
      return resolved.kind === "fact"
        ? [...resolved.fact.handles, ...(resolved.fact.humanHandles ?? [])]
        : null;
    },
    ...(dependencies.onInboundMessageCommitted
      ? { onMessageCommitted: dependencies.onInboundMessageCommitted }
      : {}),
    ...(dependencies.onInboundMessageEdited
      ? { onMessageEdited: dependencies.onInboundMessageEdited }
      : {}),
    ...(dependencies.onInboundReactionCommitted
      ? { onReactionCommitted: dependencies.onInboundReactionCommitted }
      : {}),
    onMessageCommittedError: dependencies.onInboundRealtimeError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge inbound realtime emit failed", error);
    }),
    onReactionCommittedError: dependencies.onInboundRealtimeError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge inbound reaction realtime emit failed", error);
    }),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
  const inboundWorker = createExternalInboundWorkerRuntime({
    db: db ?? getDb(),
    slackRolloutDb: db ?? getDb(),
    leaseOwner: dependencies.inboundWorkerLeaseOwner
      ?? `slack-inbound:${runtimeRegistrationId}:${randomUUID()}`,
    dependencies: inboundWorkerDependencies,
    onResult: (result) => observeSlackInboundWorkerResult("event", result),
    onError: dependencies.onInboundError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge inbound worker tick failed", error);
    }),
    ...(dependencies.inboundWorkerIntervalMs
      ? { intervalMs: dependencies.inboundWorkerIntervalMs }
      : {}),
  });
  const attachmentStorage = getStorage();
  if (!attachmentStorage?.putStream) {
    throw new Error("Slack Bridge attachment runtime requires bounded streaming storage");
  }
  const inboundAttachmentAdapter = createSlackInboundAttachmentAdapter(
    provider.inboundAttachmentTransport,
  );
  const inboundAttachmentWorkerDependencies: ExternalInboundAttachmentWorkerDependencies = {
    storage: attachmentStorage,
    resolveAdapter: (requestedProvider) => requestedProvider === inboundAttachmentAdapter.provider
      ? inboundAttachmentAdapter
      : null,
    authorityIsCurrent: (authority, sourceActorProjectionId, executor, custody) => slackAttachmentAuthorityIsCurrent(
      executor ?? db ?? getDb(),
      authority,
      sourceActorProjectionId,
      custody,
    ),
    maximumFileSizeBytes: async (serverId, at) => {
      const quota = await getFileUploadQuotaSummary(serverId, at);
      return getAttachmentFileSizeLimitBytes(quota.plan, at);
    },
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
  const inboundAttachmentWorker = createExternalInboundAttachmentWorkerRuntime({
    db: db ?? getDb(),
    leaseOwner: dependencies.inboundAttachmentWorkerLeaseOwner
      ?? `slack-inbound-attachment:${runtimeRegistrationId}:${randomUUID()}`,
    dependencies: inboundAttachmentWorkerDependencies,
    onResult: (result) => observeSlackInboundWorkerResult("attachment", result),
    onError: dependencies.onInboundAttachmentError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge inbound attachment worker tick failed", error);
    }),
    ...(dependencies.inboundAttachmentWorkerIntervalMs
      ? { intervalMs: dependencies.inboundAttachmentWorkerIntervalMs }
      : {}),
  });
  const outboundWorker = createSlackBridgeDatabaseOutboundRuntime({
    db: db ?? getDb(),
    ...(attachmentFallbackDeployment ? { attachmentFallbackDeployment } : {}),
    provider,
    reconciliationKey: payloadEncryptionKey,
    registrationId: runtimeRegistrationId,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.outboundWorkerLeaseOwner
      ? { workerLeaseOwner: dependencies.outboundWorkerLeaseOwner }
      : {}),
    ...(dependencies.outboundWorkerIntervalMs
      ? { workerIntervalMs: dependencies.outboundWorkerIntervalMs }
      : {}),
    onAuthorityAlert: dependencies.onOutboundAuthorityAlert ?? ((alert) => {
      console.error("[Slock] Slack Bridge outbound authority alert", JSON.stringify(alert));
    }),
    ...(dependencies.onOutboundError ? { onError: dependencies.onOutboundError } : {}),
    tracer: dependencies.tracer,
  });
  const uninstallReactionCommandHandler = installExternalReactionCommandHandler(
    enqueueSlackReactionAggregateTransition,
  );
  const reactionWorker = createExternalReactionWorkerRuntime({
    db: db ?? getDb(),
    provider,
    leaseOwner: dependencies.reactionWorkerLeaseOwner
      ?? `slack-reaction:${runtimeRegistrationId}:${randomUUID()}`,
    ...(dependencies.reactionWorkerIntervalMs
      ? { intervalMs: dependencies.reactionWorkerIntervalMs }
      : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    onError: dependencies.onOutboundError,
    tracer: dependencies.tracer,
  });
  // RFC 082 §4.6: a card update edits its bridged Slack copy.
  const cardEditWorker = createSlackCardEditWorkerRuntime({
    db: db ?? getDb(),
    leaseOwner: dependencies.cardEditWorkerLeaseOwner ?? `slack-card-edit:${runtimeRegistrationId}:${randomUUID()}`,
    dependencies: createSlackCardEditProductionDependencies({
      db: db ?? getDb(), provider, registrationId: runtimeRegistrationId,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    }),
    ...(dependencies.cardEditWorkerIntervalMs ? { intervalMs: dependencies.cardEditWorkerIntervalMs } : {}),
    onError: dependencies.onOutboundError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge card edit worker tick failed", error);
    }),
    tracer: dependencies.tracer,
  });
  return {
    ...runtime,
    revokeInstallToken: (installId) => provider.revokeInstallToken(installId),
    revalidateChannelPrivacy: (input) => refreshSlackChannelBindingsPrivacy({
      ...input,
      provider,
      db: db ?? getDb(),
    }),
    start() {
      queueMetrics.start();
      lifecycle.start();
      inboundAttachmentWorker.start();
      verifiedIngressWorker.start();
      inboundWorker.start();
      outboundWorker.start();
      reactionWorker.start();
      cardEditWorker.start();
    },
    async stop() {
      uninstallReactionCommandHandler();
      await cardEditWorker.stop();
      await reactionWorker.stop();
      await outboundWorker.stop();
      await verifiedIngressWorker.stop();
      await inboundWorker.stop();
      await inboundAttachmentWorker.stop();
      await botProfiles.stop();
      lifecycle.stop();
      await queueMetrics.stop();
      await provider.stop();
      runtime.stop();
    },
    inboundWorkerDependencies,
    inboundAttachmentWorkerDependencies,
  };
}
