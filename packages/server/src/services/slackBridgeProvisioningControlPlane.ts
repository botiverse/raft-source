import { createHash, randomBytes } from "node:crypto";

import {
  SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
  type SlackBridgeChannelPair,
  type SlackBridgePreflight,
  type SlackBridgeProvisioningResponse,
  type SlackBridgeRawHealth,
} from "@botiverse/raft-shared";
import { and, desc, eq, gt, inArray, isNull, notInArray, or } from "drizzle-orm";

import {
  getDb,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "../db/index.js";
import {
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppIngressEndpoints,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalAuthorPolicies,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalHumanIdentityLinks,
  jointChannels,
  jointChannelServers,
  notificationRecipients,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthAppInstallationTokens,
  oauthAppPermissionRevisions,
  oauthAppWebhookConfigs,
  oauthClientMaintainers,
  oauthClientInstalls,
  oauthClientShareLinks,
  oauthClients,
  oauthGrants,
  serverMembers,
  thirdPartyAgentEvents,
  users,
} from "../db/schema.js";
import {
  type SlackBridgeProvisioningControlPlane,
  type SlackBridgeProvisioningRequestAuthority,
} from "../routes/slackBridge.js";
import { ExternalAppControlPlaneError } from "./externalAppControlPlaneService.js";
import { effectiveUserSenderName } from "./effectiveSenderName.js";
import {
  SLACK_BRIDGE_INSTALL_GRANT_FRESHNESS_MS,
  slackBridgeInstallGrantHash,
  slackBridgeInstallGrantMatchesInstall,
} from "./slackBridgeInstallGrantService.js";
import {
  SLACK_BRIDGE_ACTIVE_BOT_SCOPES,
  SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
} from "./slackBridgeProductionAppContract.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHANNELS = 500;
const AVATAR_MATERIALIZATION_CONCURRENCY = 8;
const AUDIENCE_FRESHNESS_MS = 30 * 60_000;
const CONNECTION_FRESHNESS_MS = 30 * 60_000;
const PROVISIONING_PENDING_REASON = "provisioning_preflight_pending";
const PROVISIONING_PASSED_REASON = "provisioning_preflight_passed";
const PROVISIONING_REPLACED_REASON = "provisioning_pair_replaced";
const PROVISIONING_REMOVED_REASON = "provisioning_pair_removed";
const PROVISIONING_UNBOUND_REASON = "manager_unbound_workspace";

type Tx = DatabaseTransaction;
type Install = typeof externalAppInstalls.$inferSelect;
type Credential = typeof externalAppCredentials.$inferSelect;
type Binding = typeof externalChannelBindings.$inferSelect;
type InstallGrantReceipt = typeof externalAppInstallGrantReceipts.$inferSelect;

export interface SlackBridgeProvisioningSecretAuthority {
  encryptedSecretRef: string;
  envelopeKeyId: string;
  secretRevision: number;
}

export interface SlackBridgeProvisioningBootstrapAuthority {
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
  oauthRedirectUri: string;
  eventsRequestUrl: string;
  capabilityManifestVersion: number;
  capabilityManifestHash: string;
  requiredCapabilities: readonly string[];
  signingSecret: SlackBridgeProvisioningSecretAuthority;
  oauthClientSecret: SlackBridgeProvisioningSecretAuthority;
}

export interface SlackBridgeProvisioningProviderChannel {
  id: string;
  name: string;
  privacyClass: "public" | "private";
  isMember?: boolean;
}

export interface SlackBridgeProvisioningProviderUser {
  id: string;
  displayName: string;
  handle: string | null;
  actorKind: "human" | "guest" | "remote";
  /** Transient locator; null means explicitly removed, omitted means unknown. */
  avatarLocator?: string | null;
}

type ExistingSlackActorProjection = Pick<
  typeof externalActorProjections.$inferSelect,
  "displayName" | "handles" | "actorKind" | "state" | "deactivated" | "projectionRevision"
>;

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => typeof item === "string" && item === expected[index]);
}

export function slackActorProjectionRevisionAfterRefresh(
  existing: ExistingSlackActorProjection,
  observed: SlackBridgeProvisioningProviderUser,
): number {
  const observedHandles = observed.handle ? [observed.handle] : [];
  const materiallyCurrent = existing.displayName === observed.displayName
    && exactStringArray(existing.handles, observedHandles)
    && existing.actorKind === observed.actorKind
    && existing.state === "active"
    && !existing.deactivated;
  return materiallyCurrent
    ? existing.projectionRevision
    : existing.projectionRevision + 1;
}

export interface SlackBridgeProvisioningProviderAuthority {
  installId: string;
  providerAppId: string;
  providerAuthorityId: string;
  botUserId: string;
  connectionEpoch: number;
  credentialRevision: number;
  now: Date;
}

export interface SlackBridgeProvisioningInstallGrant {
  providerAppId: string;
  providerAuthorityId: string;
  botUserId: string;
  providerBotId: string;
  grantedScopes: readonly string[];
}

export type SlackBridgeProvisioningProviderResult<T> =
  | { kind: "fact"; fact: T }
  | { kind: "failed" }
  | { kind: "unverified" };

export interface SlackBridgeProvisioningProvider {
  readInstallGrant(input: SlackBridgeProvisioningProviderAuthority): Promise<
    SlackBridgeProvisioningProviderResult<SlackBridgeProvisioningInstallGrant>
  >;
  readWorkspace(input: SlackBridgeProvisioningProviderAuthority): Promise<
    SlackBridgeProvisioningProviderResult<{
      workspaceName: string | null;
      channels: readonly SlackBridgeProvisioningProviderChannel[];
    }>
  >;
  readConversationAudience(input: SlackBridgeProvisioningProviderAuthority & {
    providerConversationId: string;
  }): Promise<SlackBridgeProvisioningProviderResult<{
    providerMemberIds: readonly string[];
    users: readonly SlackBridgeProvisioningProviderUser[];
  }>>;
}

export interface SlackBridgeProvisioningControlPlaneDependencies {
  db?: Database;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  provider: SlackBridgeProvisioningProvider;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  authorAvatarMaterializer?(policyId: string): Promise<unknown>;
}

export interface SlackBridgeAvatarMaterializer {
  materializeExternalProjection(input: {
    projectionId: string;
    expectedProjectionRevision: number;
    expectedObservedAt?: Date;
    sourceLocator: string | null;
  }): Promise<unknown>;
}

interface CurrentAuthority {
  grant: typeof externalAppServerGrants.$inferSelect | null;
  install: Install | null;
  credential: Credential | null;
  installGrantReceipt: InstallGrantReceipt | null;
  bindings: Binding[];
}

interface ProviderObservation {
  status: "passed" | "failed" | "unverified";
  workspaceName: string | null;
  channels: SlackBridgeProvisioningProviderChannel[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalStrings(left);
  const b = canonicalStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function requireManagerInput(input: SlackBridgeProvisioningRequestAuthority): void {
  if (
    !UUID_PATTERN.test(input.serverId)
    || !UUID_PATTERN.test(input.requestingUserId)
    || !validDate(input.now)
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge provisioning authority is invalid",
      "external_app_invalid_state",
    );
  }
}

async function requireManager(
  executor: Database | Tx,
  input: SlackBridgeProvisioningRequestAuthority,
  lock = false,
): Promise<void> {
  requireManagerInput(input);
  const query = executor.select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.requestingUserId),
    ))
    .limit(1);
  const [membership] = lock ? await query.for("update") : await query;
  if (membership?.role !== "owner" && membership?.role !== "admin") {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge provisioning operation is not authorized",
      "external_app_not_authorized",
    );
  }
}

function assertBootstrap(bootstrap: SlackBridgeProvisioningBootstrapAuthority): void {
  if (
    !UUID_PATTERN.test(bootstrap.registrationId)
    || !bootstrap.providerAppId.trim()
    || !bootstrap.providerOAuthClientId.trim()
    || !validHttps(bootstrap.oauthRedirectUri)
    || !validHttps(bootstrap.eventsRequestUrl)
    || !Number.isSafeInteger(bootstrap.capabilityManifestVersion)
    || bootstrap.capabilityManifestVersion <= 0
    || !bootstrap.capabilityManifestHash.trim()
    || canonicalStrings(bootstrap.requiredCapabilities).length === 0
  ) {
    throw new Error("Slack Bridge provisioning bootstrap authority is invalid");
  }
  for (const secret of [bootstrap.signingSecret, bootstrap.oauthClientSecret]) {
    if (
      !secret.encryptedSecretRef.trim()
      || !secret.envelopeKeyId.trim()
      || !Number.isSafeInteger(secret.secretRevision)
      || secret.secretRevision <= 0
    ) throw new Error("Slack Bridge provisioning secret authority is invalid");
  }
}

function assertRegistration(
  registration: typeof externalAppRegistrations.$inferSelect,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): void {
  if (
    registration.id !== bootstrap.registrationId
    || registration.provider !== "slack"
    || registration.environment !== bootstrap.environment
    || registration.state !== "active"
    || registration.providerAppId !== bootstrap.providerAppId
    || registration.providerOAuthClientId !== bootstrap.providerOAuthClientId
    || registration.capabilityManifestVersion !== bootstrap.capabilityManifestVersion
    || registration.capabilityManifestHash !== bootstrap.capabilityManifestHash
    || !exactStrings(registration.requiredCapabilities, bootstrap.requiredCapabilities)
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge registration conflicts with runtime authority",
      "external_app_install_conflict",
    );
  }
}

export type SlackBridgeOAuthIdentityAppType = "slock_builtin" | "third_party_global";

function assertBootstrapClient(
  client: typeof oauthClients.$inferSelect,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): asserts client is typeof oauthClients.$inferSelect & {
  appType: SlackBridgeOAuthIdentityAppType;
} {
  if (
    client.clientId !== `slack-bridge:${bootstrap.registrationId}`
    // Rollout compatibility is intentionally two-state: source must accept
    // the exact legacy identity before the separately authorized reconcile,
    // and accept the standard installed identity afterwards. No other app
    // type or loose client-id prefix is valid.
    || (client.appType !== "slock_builtin" && client.appType !== "third_party_global")
    || client.enabled !== true
    || client.publishStatus !== "published"
    || client.humanMarketplaceVisible !== false
    || !exactStrings(client.allowedScopes ?? [], [])
    || client.name !== "Slack Bridge"
    || client.description !== "Raft first-party Slack Bridge control plane"
    || client.homepageUrl !== null
    || client.returnUrl !== null
    || client.agentManifestUrl !== null
    || client.logoUrl !== null
    || client.logoStorageKey !== null
    || client.category !== "Other"
    || client.dataAccessSummary !== null
    || client.publishRequestedAt !== null
    || client.publishReviewedAt !== null
    || client.publishReviewedByUserId !== null
    || client.publishRejectionReason !== null
    || client.ownerAgentId !== null
    || client.outboundRequestRevision !== 0
    || client.outboundCurrentRevisionId !== null
    || client.outboundPendingRevisionId !== null
    || !exactStrings(client.outboundCurrentGroups, [])
    || !exactStrings(client.outboundCurrentEvents, [])
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge OAuth client conflicts with runtime authority",
      "external_app_install_conflict",
    );
  }
}

export interface SlackBridgeOAuthIdentityReconcileReceipt {
  registrationId: string;
  clientId: string;
  previousAppType: SlackBridgeOAuthIdentityAppType;
  nextAppType: SlackBridgeOAuthIdentityAppType;
  changed: boolean;
  installCount: number;
  authoritySha256: string;
}

function identityMigrationConflict(message: string): never {
  throw new ExternalAppControlPlaneError(message, "external_app_install_conflict");
}

function exactStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Explicit, reversible data reconcile for the Slack Bridge OAuth identity.
 * It is never called from ordinary provisioning. A deployment may therefore
 * accept the legacy identity without silently mutating it; an operator must
 * separately invoke this reviewed transition under live-write authority.
 */
export async function reconcileSlackBridgeOAuthIdentityAppType(input: {
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  expectedAppType: SlackBridgeOAuthIdentityAppType;
  nextAppType: SlackBridgeOAuthIdentityAppType;
  expectedAuthoritySha256?: string;
  dryRun?: boolean;
  db?: Database;
}): Promise<SlackBridgeOAuthIdentityReconcileReceipt> {
  assertBootstrap(input.bootstrap);
  if (!input.dryRun && input.expectedAppType === input.nextAppType) {
    identityMigrationConflict("Slack Bridge OAuth identity reconcile types must differ");
  }
  if (
    !input.dryRun
    && !/^[0-9a-f]{64}$/.test(input.expectedAuthoritySha256 ?? "")
  ) {
    identityMigrationConflict("Slack Bridge OAuth identity expected authority fingerprint is invalid");
  }
  const db = input.db ?? getDb();
  return db.transaction(async (tx) => {
    const registrations = await tx.select().from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, input.bootstrap.registrationId))
      .limit(2)
      .for("update");
    if (registrations.length !== 1) {
      identityMigrationConflict("Slack Bridge OAuth identity registration is missing or ambiguous");
    }
    const registration = registrations[0]!;
    assertRegistration(registration, input.bootstrap);

    const clients = await tx.select().from(oauthClients)
      .where(eq(oauthClients.id, registration.oauthClientId))
      .limit(2)
      .for("update");
    if (clients.length !== 1) {
      identityMigrationConflict("Slack Bridge OAuth identity client is missing or ambiguous");
    }
    const client = clients[0]!;
    assertBootstrapClient(client, input.bootstrap);
    if (client.clientSecret !== null) {
      identityMigrationConflict("Slack Bridge OAuth identity client shape has drifted");
    }
    if (
      !input.dryRun
      && client.appType !== input.expectedAppType
      && client.appType !== input.nextAppType
    ) {
      identityMigrationConflict("Slack Bridge OAuth identity app type has drifted");
    }

    const [installs, grants, accessRequests, accessGrants, accessTokens, maintainers,
      permissionRevisions, installationTokens, webhookConfigs, shareLinks, agentEvents] = await Promise.all([
      tx.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id)).for("update"),
      tx.select().from(externalAppServerGrants).where(eq(externalAppServerGrants.registrationId, registration.id)).for("update"),
      tx.select({ id: oauthAccessRequests.id }).from(oauthAccessRequests).where(eq(oauthAccessRequests.clientId, client.id)).limit(1),
      tx.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, client.id)).limit(1),
      tx.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, client.id)).limit(1),
      tx.select({ id: oauthClientMaintainers.id }).from(oauthClientMaintainers).where(eq(oauthClientMaintainers.clientId, client.id)).limit(1),
      tx.select({ id: oauthAppPermissionRevisions.id }).from(oauthAppPermissionRevisions).where(eq(oauthAppPermissionRevisions.clientId, client.id)).limit(1),
      tx.select({ id: oauthAppInstallationTokens.id }).from(oauthAppInstallationTokens).where(eq(oauthAppInstallationTokens.clientId, client.id)).limit(1),
      tx.select({ id: oauthAppWebhookConfigs.id }).from(oauthAppWebhookConfigs).where(eq(oauthAppWebhookConfigs.clientId, client.id)).limit(1),
      tx.select({ id: oauthClientShareLinks.id }).from(oauthClientShareLinks).where(eq(oauthClientShareLinks.clientId, client.id)).limit(1),
      tx.select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.clientId, client.id)).limit(1),
    ]);

    const activeGrantServers = grants
      .filter((grant) => grant.state === "active")
      .map((grant) => grant.serverId);
    const activeInstallServers = installs
      .filter((install) => install.status === "active")
      .map((install) => install.serverId);
    if (
      installs.length === 0
      || grants.length !== installs.length
      || installs.some((install) => (
        install.status !== "active"
        || install.installedByUserId === null
        || install.installedByAgentId !== null
        || install.approvedRequestRevisionId !== null
        || install.approvedGroups.length !== 0
        || install.subscribedEvents.length !== 0
        || install.grantRevision !== 0
        || install.subscriptionRevision !== 0
      ))
      || grants.some((grant) => (
        grant.state !== "active"
        || !grantMatchesCurrentRegistration(grant, registration)
        || !Number.isSafeInteger(grant.grantEpoch)
        || grant.grantEpoch <= 0
        || grant.grantedByType !== "human"
        || !UUID_PATTERN.test(grant.grantedById)
        || grant.revokedAt !== null
        || grant.revokeReason !== null
      ))
      || !exactStringSet(activeInstallServers, activeGrantServers)
      || accessRequests.length > 0
      || accessGrants.length > 0
      || accessTokens.length > 0
      || maintainers.length > 0
      || permissionRevisions.length > 0
      || installationTokens.length > 0
      || webhookConfigs.length > 0
      || shareLinks.length > 0
      || agentEvents.length > 0
    ) {
      identityMigrationConflict("Slack Bridge OAuth identity authority has unexpected generic App state");
    }

    const notifications = await tx.select({ id: notificationRecipients.id })
      .from(notificationRecipients)
      .where(and(
        eq(notificationRecipients.recipientType, "app_installation"),
        inArray(notificationRecipients.recipientId, installs.map((install) => install.id)),
      ))
      .limit(1);
    if (notifications.length > 0) {
      identityMigrationConflict("Slack Bridge OAuth identity has unexpected App Notification state");
    }

    const authoritySha256 = sha256(JSON.stringify({
      registration,
      client: {
        ...client,
        clientSecretHash: sha256(client.clientSecretHash),
        clientSecret: client.clientSecret === null ? null : "present",
      },
      installs: [...installs].sort((left, right) => left.id.localeCompare(right.id)),
      grants: [...grants].sort((left, right) => left.id.localeCompare(right.id)),
      genericStateIds: {
        accessRequests: accessRequests.map(({ id }) => id).sort(),
        accessGrants: accessGrants.map(({ id }) => id).sort(),
        accessTokens: accessTokens.map(({ id }) => id).sort(),
        maintainers: maintainers.map(({ id }) => id).sort(),
        permissionRevisions: permissionRevisions.map(({ id }) => id).sort(),
        installationTokens: installationTokens.map(({ id }) => id).sort(),
        webhookConfigs: webhookConfigs.map(({ id }) => id).sort(),
        shareLinks: shareLinks.map(({ id }) => id).sort(),
        agentEvents: agentEvents.map(({ id }) => id).sort(),
        notifications: notifications.map(({ id }) => id).sort(),
      },
    }));

    if (input.dryRun) {
      return {
        registrationId: registration.id,
        clientId: client.id,
        previousAppType: client.appType,
        nextAppType: client.appType,
        changed: false,
        installCount: installs.length,
        authoritySha256,
      };
    }
    if (authoritySha256 !== input.expectedAuthoritySha256) {
      identityMigrationConflict("Slack Bridge OAuth identity authority fingerprint changed; run a fresh preflight");
    }

    if (client.appType === input.nextAppType) {
      return {
        registrationId: registration.id,
        clientId: client.id,
        previousAppType: input.nextAppType,
        nextAppType: input.nextAppType,
        changed: false,
        installCount: installs.length,
        authoritySha256,
      };
    }

    const [updated] = await tx.update(oauthClients)
      .set({ appType: input.nextAppType, updatedAt: new Date() })
      .where(and(
        eq(oauthClients.id, client.id),
        eq(oauthClients.appType, input.expectedAppType),
      ))
      .returning({ id: oauthClients.id, appType: oauthClients.appType });
    if (!updated || updated.appType !== input.nextAppType) {
      identityMigrationConflict("Slack Bridge OAuth identity reconcile lost its exact compare-and-set");
    }
    return {
      registrationId: registration.id,
      clientId: updated.id,
      previousAppType: input.expectedAppType,
      nextAppType: input.nextAppType,
      changed: true,
      installCount: installs.length,
      authoritySha256,
    };
  });
}

async function assertBootstrapRows(
  executor: Database | Tx,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): Promise<typeof externalAppRegistrations.$inferSelect | null> {
  const registrations = await executor.select().from(externalAppRegistrations)
    .where(eq(externalAppRegistrations.id, bootstrap.registrationId)).limit(2);
  if (registrations.length === 0) return null;
  if (registrations.length !== 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge registration authority is ambiguous",
      "external_app_install_conflict",
    );
  }
  const registration = registrations[0]!;
  assertRegistration(registration, bootstrap);
  const clients = await executor.select().from(oauthClients)
    .where(eq(oauthClients.id, registration.oauthClientId)).limit(2);
  if (clients.length !== 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge OAuth client authority is missing or ambiguous",
      "external_app_install_conflict",
    );
  }
  assertBootstrapClient(clients[0]!, bootstrap);

  const secrets = await executor.select().from(externalAppRegistrationSecrets)
    .where(eq(externalAppRegistrationSecrets.registrationId, registration.id));
  const assertSecret = (
    purpose: "signing_secret" | "oauth_client_secret",
    expected: SlackBridgeProvisioningSecretAuthority,
  ) => {
    const matches = secrets.filter((secret) => secret.purpose === purpose);
    const secret = matches[0];
    if (
      matches.length !== 1
      || !secret
      || secret.revokedAt !== null
      || secret.leaseOwner !== null
      || secret.leaseExpiresAt !== null
      || secret.encryptedSecretRef !== expected.encryptedSecretRef
      || secret.envelopeKeyId !== expected.envelopeKeyId
      || secret.aadVersion !== 1
      || secret.secretRevision !== expected.secretRevision
    ) {
      throw new ExternalAppControlPlaneError(
        `Slack Bridge ${purpose} authority conflicts with runtime authority`,
        "external_app_install_conflict",
      );
    }
  };
  assertSecret("signing_secret", bootstrap.signingSecret);
  assertSecret("oauth_client_secret", bootstrap.oauthClientSecret);

  const endpoints = await executor.select().from(externalAppIngressEndpoints)
    .where(eq(externalAppIngressEndpoints.registrationId, registration.id)).limit(2);
  const endpoint = endpoints[0];
  if (
    endpoints.length !== 1
    || !endpoint
    || endpoint.environment !== bootstrap.environment
    || endpoint.state !== "active"
    || endpoint.exactRequestUrl !== bootstrap.eventsRequestUrl
    || endpoint.signingSecretRevision !== bootstrap.signingSecret.secretRevision
  ) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge ingress endpoint conflicts with runtime authority",
      "external_app_install_conflict",
    );
  }
  return registration;
}

async function loadCurrentAuthority(
  db: Database,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
  serverId: string,
): Promise<CurrentAuthority> {
  const grants = await db.select().from(externalAppServerGrants).where(and(
    eq(externalAppServerGrants.serverId, serverId),
    eq(externalAppServerGrants.registrationId, bootstrap.registrationId),
  )).limit(2);
  if (grants.length > 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge server grant authority is ambiguous",
      "external_app_install_conflict",
    );
  }
  const grant = grants[0] ?? null;
  const installs = await db.select().from(externalAppInstalls).where(and(
    eq(externalAppInstalls.serverId, serverId),
    eq(externalAppInstalls.registrationId, bootstrap.registrationId),
  )).orderBy(desc(externalAppInstalls.updatedAt)).limit(2);
  if (installs.length > 1 && installs.filter((install) => install.state !== "revoked").length > 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge server has multiple current workspace installs",
      "external_app_install_conflict",
    );
  }
  const install = installs.find((candidate) => candidate.state !== "revoked") ?? installs[0] ?? null;
  const credentials = install
    ? await db.select().from(externalAppCredentials)
      .where(eq(externalAppCredentials.installId, install.id)).limit(2)
    : [];
  if (credentials.length > 1) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge credential authority is ambiguous",
      "external_app_install_conflict",
    );
  }
  const bindings = install
    ? await db.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.serverId, serverId),
      eq(externalChannelBindings.registrationId, bootstrap.registrationId),
      eq(externalChannelBindings.installId, install.id),
      eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
    )).orderBy(externalChannelBindings.createdAt)
    : [];
  const installGrantReceipts = install
    ? await db.select().from(externalAppInstallGrantReceipts).where(and(
      eq(externalAppInstallGrantReceipts.registrationId, bootstrap.registrationId),
      eq(externalAppInstallGrantReceipts.installId, install.id),
    )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(2)
    : [];
  return {
    grant,
    install,
    credential: credentials[0] ?? null,
    installGrantReceipt: installGrantReceipts[0] ?? null,
    bindings: bindings.filter((binding) =>
      binding.stateReason !== PROVISIONING_REPLACED_REASON
      && binding.stateReason !== PROVISIONING_REMOVED_REASON),
  };
}

function currentGrant(
  authority: CurrentAuthority,
  bootstrap: SlackBridgeProvisioningBootstrapAuthority,
): CurrentAuthority["grant"] {
  const grant = authority.grant;
  if (
    !grant
    || grant.state !== "active"
    || grant.registrationId !== bootstrap.registrationId
    || grant.grantedManifestVersion !== bootstrap.capabilityManifestVersion
    || grant.grantedManifestHash !== bootstrap.capabilityManifestHash
    || !exactStrings(grant.grantedCapabilities, bootstrap.requiredCapabilities)
  ) return null;
  return grant;
}

function currentInstall(authority: CurrentAuthority): Install | null {
  const install = authority.install;
  const grant = authority.grant;
  if (
    !install
    || !grant
    || grant.state !== "active"
    || install.serverGrantId !== grant.id
    || install.grantEpoch !== grant.grantEpoch
  ) return null;
  return install;
}

function grantMatchesCurrentRegistration(
  grant: NonNullable<CurrentAuthority["grant"]>,
  registration: typeof externalAppRegistrations.$inferSelect,
): boolean {
  return registration.state === "active"
    && grant.registrationId === registration.id
    && grant.grantedManifestVersion === registration.capabilityManifestVersion
    && grant.grantedManifestHash === registration.capabilityManifestHash
    && exactStrings(grant.grantedCapabilities, registration.requiredCapabilities);
}

function activeProviderAuthority(
  authority: CurrentAuthority,
  now: Date,
): SlackBridgeProvisioningProviderAuthority | null {
  const install = currentInstall(authority);
  const credential = authority.credential;
  if (
    !install
    || install.state !== "active"
    || !credential
    || credential.state !== "active"
    || credential.credentialRevision !== install.credentialRevision
    || (credential.expiresAt !== null && credential.expiresAt <= now)
    || !install.providerAuthorityId.trim()
    || !install.botUserId?.trim()
  ) return null;
  return {
    installId: install.id,
    providerAppId: install.providerAppId,
    providerAuthorityId: install.providerAuthorityId,
    botUserId: install.botUserId,
    connectionEpoch: install.connectionEpoch,
    credentialRevision: install.credentialRevision,
    now,
  };
}

function currentInstallGrantReceipt(
  authority: CurrentAuthority,
  now: Date,
): InstallGrantReceipt | null {
  const install = currentInstall(authority);
  const receipt = authority.installGrantReceipt;
  if (
    !install
    || !receipt
    || receipt.status !== "valid"
    || receipt.expiresAt <= now
    || receipt.registrationId !== install.registrationId
    || receipt.installId !== install.id
    || receipt.connectionEpoch !== install.connectionEpoch
    || receipt.scopeRevision !== install.scopeRevision
    || receipt.credentialRevision !== install.credentialRevision
    || !slackBridgeInstallGrantMatchesInstall(install, receipt)
    || receipt.grantHash !== slackBridgeInstallGrantHash(receipt)
  ) return null;
  return receipt;
}

async function observeProvider(
  provider: SlackBridgeProvisioningProvider,
  authority: CurrentAuthority,
  now: Date,
): Promise<ProviderObservation> {
  const providerAuthority = activeProviderAuthority(authority, now);
  if (!providerAuthority) {
    return { status: "unverified", workspaceName: authority.install?.workspaceName ?? null, channels: [] };
  }
  let result: Awaited<ReturnType<SlackBridgeProvisioningProvider["readWorkspace"]>>;
  try {
    result = await provider.readWorkspace(providerAuthority);
  } catch {
    result = { kind: "unverified" };
  }
  if (result.kind !== "fact") {
    return {
      status: result.kind,
      workspaceName: authority.install?.workspaceName ?? null,
      channels: [],
    };
  }
  const seen = new Set<string>();
  const providerChannels = result.fact.channels.filter((channel) => {
    if (
      !channel.id.trim()
      || !channel.name.trim()
      || channel.id.length > 256
      || channel.name.length > 200
      || seen.has(channel.id)
    ) return false;
    seen.add(channel.id);
    return true;
  }).slice(0, MAX_CHANNELS);
  return {
    status: "passed",
    workspaceName: result.fact.workspaceName?.trim() || authority.install?.workspaceName || null,
    channels: providerChannels,
  };
}

async function observeInstallGrant(
  provider: SlackBridgeProvisioningProvider,
  authority: CurrentAuthority,
  now: Date,
): Promise<Awaited<ReturnType<SlackBridgeProvisioningProvider["readInstallGrant"]>>> {
  const providerAuthority = activeProviderAuthority(authority, now);
  if (!providerAuthority) return { kind: "unverified" };
  try {
    return await provider.readInstallGrant(providerAuthority);
  } catch {
    return { kind: "unverified" };
  }
}

function installGrantMatchesAuthority(
  authority: CurrentAuthority,
  grant: SlackBridgeProvisioningInstallGrant,
): boolean {
  const install = currentInstall(authority);
  return Boolean(install && slackBridgeInstallGrantMatchesInstall(install, grant));
}

export async function listSlackBridgeRaftConversationTargets(db: Database, serverId: string) {
  const ordinary = await db.select({ id: channels.id, name: channels.name, type: channels.type })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, ["channel", "private"]),
      isNull(channels.archivedAt),
      isNull(channels.deletedAt),
    )).orderBy(channels.name).limit(MAX_CHANNELS);
  const jointHosts = await db.select({ id: channels.id, name: channels.name, type: channels.type })
    .from(channels)
    .innerJoin(jointChannelServers, and(
      eq(jointChannelServers.localChannelId, channels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.role, "host"),
      eq(jointChannelServers.status, "active"),
    ))
    .innerJoin(jointChannels, and(
      eq(jointChannels.id, jointChannelServers.jointChannelId),
      eq(jointChannels.status, "active"),
    ))
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "joint"),
      isNull(channels.archivedAt),
      isNull(channels.deletedAt),
    )).orderBy(channels.name).limit(MAX_CHANNELS);
  return [...ordinary, ...jointHosts]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_CHANNELS);
}

async function audienceStatuses(
  db: Database,
  bindings: readonly Binding[],
  now: Date,
  providerObservation: ProviderObservation,
): Promise<Array<{ bindingId: string; status: "matched" | "mismatch" | "unavailable" }>> {
  const results: Array<{ bindingId: string; status: "matched" | "mismatch" | "unavailable" }> = [];
  const providerChannels = new Map(providerObservation.channels.map((channel) => [channel.id, channel]));
  for (const binding of bindings) {
    const providerChannel = providerChannels.get(binding.providerConversationId);
    if (
      providerObservation.status === "passed"
      && (
        !providerChannel
        || providerChannel.privacyClass !== binding.privacyClass
        || providerChannel.isMember !== true
      )
    ) {
      results.push({ bindingId: binding.id, status: "mismatch" });
      continue;
    }
    const status = await currentConversationAuthorityStatus(db, binding, now);
    results.push({
      bindingId: binding.id,
      status,
    });
  }
  return results;
}

async function currentConversationAuthorityStatus(
  executor: DatabaseExecutor,
  binding: Binding,
  now: Date,
): Promise<"matched" | "mismatch" | "unavailable"> {
  const [install] = await executor.select({
    providerAuthorityId: externalAppInstalls.providerAuthorityId,
  }).from(externalAppInstalls).where(and(
    eq(externalAppInstalls.id, binding.installId),
    eq(externalAppInstalls.serverId, binding.serverId),
    eq(externalAppInstalls.registrationId, binding.registrationId),
    eq(externalAppInstalls.connectionEpoch, binding.connectionEpoch),
    eq(externalAppInstalls.state, "active"),
  )).limit(1);
  if (!install) return "unavailable";
  const snapshotConditions = [
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
  ];
  if (binding.privacyClass === "private") {
    snapshotConditions.push(eq(
      externalBindingAudienceSnapshots.audienceRevision,
      binding.audienceRevision ?? -1,
    ));
  }
  const [snapshot] = await executor.select().from(externalBindingAudienceSnapshots).where(and(
    ...snapshotConditions,
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
  if (!snapshot || snapshot.expiresAt <= now || snapshot.status !== "matched") {
    return snapshot?.status === "mismatch" ? "mismatch" : "unavailable";
  }

  const rows = await executor.select({
    projectionId: externalActorProjections.id,
    externalActorId: externalActorProjections.externalActorId,
    actorProvider: externalActorProjections.provider,
    actorRegistrationId: externalActorProjections.appRegistrationId,
    actorInstallId: externalActorProjections.installId,
    actorWorkspaceId: externalActorProjections.workspaceId,
    actorKind: externalActorProjections.actorKind,
    actorState: externalActorProjections.state,
    actorDeactivated: externalActorProjections.deactivated,
    addressProvider: externalAddressabilityProjections.provider,
    addressRegistrationId: externalAddressabilityProjections.appRegistrationId,
    addressInstallId: externalAddressabilityProjections.installId,
    addressWorkspaceId: externalAddressabilityProjections.workspaceId,
    addressConnectionEpoch: externalAddressabilityProjections.connectionEpoch,
    memberRevision: externalAddressabilityProjections.memberRevision,
    contextRevision: externalAddressabilityProjections.contextRevision,
  }).from(externalAddressabilityProjections).innerJoin(
    externalActorProjections,
    eq(externalActorProjections.id, externalAddressabilityProjections.projectionId),
  ).where(and(
    eq(externalAddressabilityProjections.bindingId, binding.id),
    eq(externalAddressabilityProjections.bindingEpoch, binding.bindingEpoch),
    eq(externalAddressabilityProjections.conversationId, binding.providerConversationId),
    eq(externalAddressabilityProjections.state, "active"),
    gt(externalAddressabilityProjections.expiresAt, now),
  ));
  const externalActorIds = rows.map((row) => row.externalActorId).sort();
  const exactAuthority = rows.length > 0
    && rows.length === snapshot.externalMemberCount
    && rows.length === snapshot.raftMemberCount
    && new Set(rows.map((row) => row.projectionId)).size === rows.length
    && new Set(externalActorIds).size === rows.length
    && rows.every((row) =>
      row.actorProvider === "slack"
      && row.actorRegistrationId === binding.registrationId
      && row.actorInstallId === binding.installId
      && row.actorWorkspaceId === install.providerAuthorityId
      && ["human", "guest", "remote"].includes(row.actorKind)
      && row.actorState === "active"
      && !row.actorDeactivated
      && row.addressProvider === "slack"
      && row.addressRegistrationId === binding.registrationId
      && row.addressInstallId === binding.installId
      && row.addressWorkspaceId === row.actorWorkspaceId
      && row.addressConnectionEpoch === binding.connectionEpoch
      && row.memberRevision === snapshot.audienceRevision
      && row.contextRevision === snapshot.audienceRevision)
    && snapshot.externalAudienceDigest === sha256(JSON.stringify([
      "slack-external-audience",
      externalActorIds,
    ]))
    && snapshot.raftAudienceDigest === sha256(JSON.stringify([
      "raft-authorized-provider-audience",
      externalActorIds,
    ]));
  return exactAuthority ? "matched" : "unavailable";
}

function preflightFor(input: {
  authority: CurrentAuthority;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  audiences: readonly { bindingId: string; status: "matched" | "mismatch" | "unavailable" }[];
  connection: "passed" | "failed" | "unverified";
}): SlackBridgePreflight {
  const install = currentInstall(input.authority);
  const credential = input.authority.credential;
  const oauth = install?.state === "active" && credential?.state === "active"
    ? input.connection
    : install && ["reauth_required", "disconnected", "revoked", "quarantined"].includes(install.state)
        || credential?.state === "revoked"
      ? "failed"
      : "unverified";
  const endpoint = currentGrant(input.authority, input.bootstrap) ? "passed" : "failed";
  const scope = install?.state === "active"
    ? exactStrings(install.installedScopes, SLACK_BRIDGE_REQUIRED_BOT_SCOPES)
      ? "passed"
      : "failed"
    : "unverified";
  const audience = input.authority.bindings.length === 0
    ? "unverified"
    : input.audiences.some((item) => item.status === "mismatch")
      ? "failed"
      : input.audiences.some((item) => item.status === "unavailable")
        ? "unverified"
        : "passed";
  const checks: SlackBridgePreflight["checks"] = [
    { id: "oauth", state: oauth },
    { id: "endpoint", state: endpoint },
    { id: "scope", state: scope },
    { id: "audience", state: audience },
  ];
  return {
    state: checks.every((check) => check.state === "passed")
      ? "passed"
      : checks.some((check) => check.state === "failed")
        ? "failed"
        : "pending",
    checks,
  };
}

function rawHealth(input: {
  authority: CurrentAuthority;
  audiences: readonly { bindingId: string; status: "matched" | "mismatch" | "unavailable" }[];
  connection: ProviderObservation["status"];
  preflight: SlackBridgePreflight;
}): SlackBridgeRawHealth {
  const install = input.authority.install;
  const credential = input.authority.credential;
  const bindings = input.authority.bindings.map((binding) => ({
    id: binding.id,
    state: binding.state,
    bindingEpoch: binding.bindingEpoch,
  }));
  const failingSurface: SlackBridgeRawHealth["failingSurface"] = !install || install.state !== "active"
    ? "install"
    : !credential || credential.state !== "active"
      ? "credential"
      : bindings.some((binding) => binding.state === "quarantined" || binding.state === "revoked")
        ? "binding"
        : input.audiences.some((audience) => audience.status !== "matched")
          ? "audience"
          : input.preflight.checks.find((check) => check.id === "scope")?.state === "failed"
            ? "scope"
            : input.connection !== "passed"
              ? "connection"
              : null;
  return {
    install: install ? {
      state: install.state,
      epochs: {
        grant: String(install.grantEpoch),
        connection: String(install.connectionEpoch),
        scope: String(install.scopeRevision),
        credential: String(install.credentialRevision),
      },
    } : null,
    credential: credential ? { state: credential.state } : null,
    bindings,
    audiences: [...input.audiences],
    lastVerifiedAt: install?.lastVerifiedAt?.toISOString() ?? null,
    failingSurface,
  };
}

function stageFor(
  authority: CurrentAuthority,
  preflight: SlackBridgePreflight,
  now: Date,
  managerHasOutboundConsent: boolean,
): SlackBridgeProvisioningResponse["snapshot"]["stage"] {
  const grant = authority.grant;
  const install = currentInstall(authority);
  if (!grant || grant.state !== "active") return "connect";
  if (!install || install.state !== "active" || authority.credential?.state !== "active") return "oauth";
  if (authority.bindings.length === 0) return "channels";
  if (authority.bindings.some((binding) => binding.state === "active")) {
    return preflight.state === "passed"
      && currentInstallGrantReceipt(authority, now)
      && managerHasOutboundConsent
      ? "health"
      : "enable";
  }
  if (
    preflight.state === "passed"
    && authority.bindings.every((binding) =>
      binding.state === "paused" && binding.stateReason === PROVISIONING_PASSED_REASON)
  ) return "enable";
  return "preflight";
}

async function managerHasCurrentOutboundConsent(input: {
  db: Database;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  authority: CurrentAuthority;
  request: SlackBridgeProvisioningRequestAuthority;
}): Promise<boolean> {
  const install = currentInstall(input.authority);
  const activeBindings = input.authority.bindings.filter((binding) => binding.state === "active");
  if (!install || activeBindings.length === 0) return true;
  const policies = await input.db.select().from(externalAuthorPolicies).where(and(
    eq(externalAuthorPolicies.serverId, input.request.serverId),
    eq(externalAuthorPolicies.provider, "slack"),
    eq(externalAuthorPolicies.appRegistrationId, input.bootstrap.registrationId),
    eq(externalAuthorPolicies.installId, install.id),
    inArray(externalAuthorPolicies.bindingId, activeBindings.map((binding) => binding.id)),
    eq(externalAuthorPolicies.authorType, "user"),
    eq(externalAuthorPolicies.authorId, input.request.requestingUserId),
    eq(externalAuthorPolicies.state, "granted"),
  ));
  return activeBindings.every((binding) => policies.some((policy) =>
    policy.bindingId === binding.id
    && policy.bindingEpoch === binding.bindingEpoch
    && policy.consentRevision === binding.bindingEpoch));
}

async function grantManagerCurrentOutboundConsent(input: {
  tx: Tx;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  install: Install;
  bindings: readonly Binding[];
  request: SlackBridgeProvisioningRequestAuthority;
}): Promise<void> {
  const [manager] = await input.tx.select({ name: users.name, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, input.request.requestingUserId))
    .for("update")
    .limit(1);
  if (!manager) {
    throw new ExternalAppControlPlaneError(
      "Slack Bridge manager identity is unavailable",
      "external_app_invalid_state",
    );
  }
  const displayName = effectiveUserSenderName(manager);
  for (const binding of input.bindings) {
    const identity = and(
      eq(externalAuthorPolicies.provider, "slack"),
      eq(externalAuthorPolicies.installId, input.install.id),
      eq(externalAuthorPolicies.bindingId, binding.id),
      eq(externalAuthorPolicies.bindingEpoch, binding.bindingEpoch),
      eq(externalAuthorPolicies.authorType, "user"),
      eq(externalAuthorPolicies.authorId, input.request.requestingUserId),
    );
    const [existing] = await input.tx.select().from(externalAuthorPolicies)
      .where(identity)
      .for("update")
      .limit(1);
    if (
      existing
      && (
        existing.serverId !== input.request.serverId
        || existing.appRegistrationId !== input.bootstrap.registrationId
        || existing.consentRevision > binding.bindingEpoch
      )
    ) {
      throw new ExternalAppControlPlaneError(
        "Slack Bridge manager consent conflicts with current binding authority",
        "external_app_invalid_state",
      );
    }
    const values = {
      serverId: input.request.serverId,
      provider: "slack",
      appRegistrationId: input.bootstrap.registrationId,
      installId: input.install.id,
      bindingId: binding.id,
      bindingEpoch: binding.bindingEpoch,
      authorType: "user" as const,
      authorId: input.request.requestingUserId,
      displayName,
      fallbackKind: "human" as const,
      consentRevision: binding.bindingEpoch,
      state: "granted" as const,
      updatedAt: input.request.now,
    };
    if (existing) {
      await input.tx.update(externalAuthorPolicies).set(values)
        .where(eq(externalAuthorPolicies.id, existing.id));
    } else {
      await input.tx.insert(externalAuthorPolicies).values({
        ...values,
        avatarArtifactId: null,
        createdAt: input.request.now,
      }).onConflictDoUpdate({
        target: [
          externalAuthorPolicies.provider,
          externalAuthorPolicies.installId,
          externalAuthorPolicies.bindingId,
          externalAuthorPolicies.bindingEpoch,
          externalAuthorPolicies.authorType,
          externalAuthorPolicies.authorId,
        ],
        set: values,
      });
    }
  }
}

function providerChannelFallback(bindings: readonly Binding[]): SlackBridgeProvisioningProviderChannel[] {
  return bindings.map((binding) => ({
    id: binding.providerConversationId,
    name: `Slack channel ${binding.providerConversationId}`.slice(0, 200),
    privacyClass: binding.privacyClass,
  }));
}

async function responseFor(input: {
  db: Database;
  bootstrap: SlackBridgeProvisioningBootstrapAuthority;
  authority: CurrentAuthority;
  providerObservation: ProviderObservation;
  request: SlackBridgeProvisioningRequestAuthority;
}): Promise<SlackBridgeProvisioningResponse> {
  const raft = await listSlackBridgeRaftConversationTargets(input.db, input.request.serverId);
  const audiences = await audienceStatuses(
    input.db,
    input.authority.bindings,
    input.request.now,
    input.providerObservation,
  );
  const preflight = preflightFor({
    authority: input.authority,
    bootstrap: input.bootstrap,
    audiences,
    connection: input.providerObservation.status,
  });
  const managerHasOutboundConsent = await managerHasCurrentOutboundConsent(input);
  const stage = stageFor(
    input.authority,
    preflight,
    input.request.now,
    managerHasOutboundConsent,
  );
  const providerChannels = new Map<string, SlackBridgeProvisioningProviderChannel>();
  for (const channel of [
    ...input.providerObservation.channels,
    ...providerChannelFallback(input.authority.bindings),
  ]) {
    if (!providerChannels.has(channel.id)) providerChannels.set(channel.id, channel);
  }
  const pairs = input.authority.bindings.map((binding) => ({
    raftChannelId: binding.channelId,
    slackChannelId: binding.providerConversationId,
    bindingEpoch: binding.bindingEpoch,
  }));
  const visibleRaft = new Map(raft.map((channel) => [channel.id, { id: channel.id, name: channel.name }]));
  if (pairs.some((pair) => !visibleRaft.has(pair.raftChannelId))) {
    const boundRows = await input.db.select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(inArray(channels.id, pairs.map((pair) => pair.raftChannelId)));
    for (const channel of boundRows) visibleRaft.set(channel.id, channel);
  }
  const health = rawHealth({
    authority: input.authority,
    audiences,
    connection: input.providerObservation.status,
    preflight,
  });
  const grant = currentGrant(input.authority, input.bootstrap);
  return {
    protocolVersion: SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
    snapshot: {
      stage,
      workspaceName: stage === "connect"
        ? null
        : input.providerObservation.workspaceName ?? input.authority.install?.workspaceName ?? null,
      raftChannels: [...visibleRaft.values()].slice(0, MAX_CHANNELS),
      slackChannels: stage === "connect"
        ? []
        : [...providerChannels.values()].map(({ id, name, privacyClass, isMember }) => ({
          id,
          name,
          privacyClass,
          ...(isMember === undefined ? {} : { isMember }),
        })).slice(0, MAX_CHANNELS),
      channelPairs: stage === "connect" ? [] : pairs,
      preflight: stage === "connect" || stage === "oauth" || stage === "channels" ? null : preflight,
      rawHealth: health,
    },
    oauthAuthority: stage === "oauth" && grant ? {
      registrationId: input.bootstrap.registrationId,
      serverGrantId: grant.id,
      grantEpoch: grant.grantEpoch,
    } : null,
  };
}

async function recordConversationAuthority(input: {
  db: Database;
  provider: SlackBridgeProvisioningProvider;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  serverId: string;
  now: Date;
  authority: CurrentAuthority;
  binding: Binding;
}): Promise<void> {
  const providerAuthority = activeProviderAuthority(input.authority, input.now);
  const install = currentInstall(input.authority);
  if (!providerAuthority || !install) return;

  const privateBinding = input.binding.privacyClass === "private";
  const humanRows = privateBinding
    ? await input.db.select({ userId: channelHumans.userId })
      .from(channelHumans)
      .innerJoin(serverMembers, and(
        eq(serverMembers.serverId, input.serverId),
        eq(serverMembers.userId, channelHumans.userId),
      ))
      .where(eq(channelHumans.channelId, input.binding.channelId))
    : [];
  const userIds = [...new Set(humanRows.map((row) => row.userId))].sort();
  const links = privateBinding && userIds.length > 0
    ? await input.db.select().from(externalHumanIdentityLinks).where(and(
      eq(externalHumanIdentityLinks.serverId, input.serverId),
      eq(externalHumanIdentityLinks.installId, install.id),
      eq(externalHumanIdentityLinks.state, "active"),
      inArray(externalHumanIdentityLinks.userId, userIds),
    ))
    : [];
  const linkByUser = new Map(links.map((link) => [link.userId, link]));
  const mappingUnavailable = privateBinding && (
    userIds.length === 0
    || links.length !== userIds.length
    || links.some((link) =>
      link.providerAuthorityId !== install.providerAuthorityId
      || link.observedConnectionEpoch !== install.connectionEpoch)
    || userIds.some((userId) => !linkByUser.has(userId))
  );

  let providerResult: Awaited<ReturnType<SlackBridgeProvisioningProvider["readConversationAudience"]>> = {
    kind: "unverified",
  };
  const providerUserIds = mappingUnavailable
    ? []
    : userIds.map((userId) => linkByUser.get(userId)!.providerUserId).sort();
  if (!mappingUnavailable) {
    try {
      providerResult = await input.provider.readConversationAudience({
        ...providerAuthority,
        providerConversationId: input.binding.providerConversationId,
      });
    } catch {
      providerResult = { kind: "unverified" };
    }
  }

  let status: "matched" | "mismatch" | "unavailable" = "unavailable";
  let externalMembers: string[] = [];
  let providerUsers: SlackBridgeProvisioningProviderUser[] = [];
  let unavailableReason = mappingUnavailable
    ? "identity_mapping_unavailable"
    : providerResult.kind === "failed"
      ? "provider_failed"
      : "provider_unavailable";
  if (!mappingUnavailable && providerResult.kind === "fact") {
    const providerHasBot = Boolean(
      install.botUserId && providerResult.fact.providerMemberIds.includes(install.botUserId),
    );
    externalMembers = canonicalStrings(providerResult.fact.providerMemberIds)
      .filter((memberId) => memberId !== install.botUserId);
    providerUsers = [...providerResult.fact.users];
    const usersById = new Map(providerUsers.map((user) => [user.id, user]));
    const completeProviderIdentity = externalMembers.length > 0
      && usersById.size === providerUsers.length
      && providerUsers.length === externalMembers.length
      && externalMembers.every((providerUserId) => usersById.has(providerUserId));
    if (!providerHasBot) {
      status = "mismatch";
      unavailableReason = "provider_bot_not_in_conversation";
    } else if (!completeProviderIdentity) {
      unavailableReason = externalMembers.length === 0
        ? "provider_audience_empty"
        : "provider_identity_unavailable";
    } else {
      status = privateBinding && !exactStrings(externalMembers, providerUserIds)
        ? "mismatch"
        : "matched";
    }
  }

  const committed = await input.db.transaction(async (tx) => {
    const [binding] = await tx.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.id, input.binding.id),
      eq(externalChannelBindings.serverId, input.serverId),
      eq(externalChannelBindings.installId, install.id),
      inArray(externalChannelBindings.state, ["paused", "active"]),
      eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
      eq(externalChannelBindings.bindingEpoch, input.binding.bindingEpoch),
    )).for("update").limit(1);
    if (!binding || binding.privacyClass !== input.binding.privacyClass) return false;

    if (privateBinding) {
      if (!binding.audienceRevision || binding.audienceRevision !== input.binding.audienceRevision) return false;
      const currentHumanRows = await tx.select({ userId: channelHumans.userId })
        .from(channelHumans)
        .innerJoin(serverMembers, and(
          eq(serverMembers.serverId, input.serverId),
          eq(serverMembers.userId, channelHumans.userId),
        ))
        .where(eq(channelHumans.channelId, binding.channelId));
      const currentUserIds = [...new Set(currentHumanRows.map((row) => row.userId))].sort();
      if (!exactStrings(currentUserIds, userIds)) return false;
    }

    const [latestSnapshot] = await tx.select({
      audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
    }).from(externalBindingAudienceSnapshots).where(and(
      eq(externalBindingAudienceSnapshots.bindingId, binding.id),
      eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
    )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1).for("update");
    const nextRevision = privateBinding
      ? binding.audienceRevision! + 1
      : (latestSnapshot?.audienceRevision ?? 0) + 1;
    const expiresAt = new Date(input.now.getTime() + AUDIENCE_FRESHNESS_MS);
    const existingAddresses = await tx.select().from(externalAddressabilityProjections).where(and(
      eq(externalAddressabilityProjections.bindingId, binding.id),
      eq(externalAddressabilityProjections.bindingEpoch, binding.bindingEpoch),
      eq(externalAddressabilityProjections.conversationId, binding.providerConversationId),
    )).for("update");
    const addressedProjectionIds = new Set<string>();
    if (status === "matched") {
      for (const fact of providerUsers) {
        const providerUserId = fact.id;
        const existingRows = await tx.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.provider, "slack"),
          eq(externalActorProjections.appRegistrationId, install.registrationId),
          eq(externalActorProjections.installId, install.id),
          eq(externalActorProjections.workspaceId, install.providerAuthorityId),
          eq(externalActorProjections.externalActorId, providerUserId),
        )).for("update").limit(2);
        if (existingRows.length > 1) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge provider identity is ambiguous",
            "external_app_invalid_state",
          );
        }
        const [projection] = existingRows.length === 1
          ? await tx.update(externalActorProjections).set({
            displayName: fact.displayName,
            handles: fact.handle ? [fact.handle] : [],
            actorKind: fact.actorKind,
            state: "active",
            deactivated: false,
            // projectionRevision is an authority/content version, not an
            // observation counter. Advancing it for a freshness-only audience
            // refresh can revoke an ingress event between enqueue and worker
            // commit even though the Slack actor is still the same authority.
            projectionRevision: slackActorProjectionRevisionAfterRefresh(existingRows[0]!, fact),
            observedAt: input.now,
            updatedAt: input.now,
          }).where(eq(externalActorProjections.id, existingRows[0]!.id)).returning()
          : await tx.insert(externalActorProjections).values({
            provider: "slack",
            appRegistrationId: install.registrationId,
            installId: install.id,
            workspaceId: install.providerAuthorityId,
            externalActorId: providerUserId,
            displayName: fact.displayName,
            handles: fact.handle ? [fact.handle] : [],
            actorKind: fact.actorKind,
            state: "active",
            deactivated: false,
            projectionRevision: 1,
            observedAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          }).returning();
        if (!projection) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge provider identity could not be persisted",
            "external_app_persist_failed",
          );
        }
        addressedProjectionIds.add(projection.id);
        const addresses = existingAddresses.filter((address) =>
          address.projectionId === projection.id);
        if (addresses.length > 1) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge provider addressability is ambiguous",
            "external_app_invalid_state",
          );
        }
        const addressValues = {
          provider: "slack",
          appRegistrationId: install.registrationId,
          installId: install.id,
          workspaceId: install.providerAuthorityId,
          connectionEpoch: install.connectionEpoch,
          bindingId: binding.id,
          bindingEpoch: binding.bindingEpoch,
          conversationId: binding.providerConversationId,
          memberRevision: nextRevision,
          contextRevision: nextRevision,
          state: "active" as const,
          observedAt: input.now,
          expiresAt,
          updatedAt: input.now,
        };
        if (addresses[0]) {
          await tx.update(externalAddressabilityProjections).set(addressValues)
            .where(eq(externalAddressabilityProjections.id, addresses[0].id));
        } else {
          await tx.insert(externalAddressabilityProjections).values({
            projectionId: projection.id,
            ...addressValues,
            createdAt: input.now,
          });
        }
      }
    }

    for (const address of existingAddresses) {
      if (addressedProjectionIds.has(address.projectionId)) continue;
      await tx.update(externalAddressabilityProjections).set({
        memberRevision: nextRevision,
        contextRevision: nextRevision,
        state: status === "mismatch" ? "removed" : "stale",
        observedAt: input.now,
        expiresAt,
        updatedAt: input.now,
      }).where(eq(externalAddressabilityProjections.id, address.id));
    }

    const externalAudienceDigest = status === "unavailable"
      ? sha256(JSON.stringify(["slack-external-audience-unavailable", unavailableReason]))
      : sha256(JSON.stringify(["slack-external-audience", externalMembers]));
    const authorizedProviderMembers = privateBinding ? providerUserIds : externalMembers;
    const raftAudienceDigest = status === "unavailable"
      ? sha256(JSON.stringify(["raft-authorized-audience-unavailable", unavailableReason]))
      : sha256(JSON.stringify(["raft-authorized-provider-audience", authorizedProviderMembers]));
    if (privateBinding) {
      const [updated] = await tx.update(externalChannelBindings).set({
        audienceRevision: nextRevision,
        audienceFreshUntil: expiresAt,
        updatedAt: input.now,
      }).where(and(
        eq(externalChannelBindings.id, binding.id),
        eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
        eq(externalChannelBindings.audienceRevision, binding.audienceRevision!),
      )).returning({ id: externalChannelBindings.id });
      if (!updated) return false;
    }
    await tx.insert(externalBindingAudienceSnapshots).values({
      bindingId: binding.id,
      bindingEpoch: binding.bindingEpoch,
      audienceRevision: nextRevision,
      externalMemberCount: status === "unavailable" ? 0 : externalMembers.length,
      externalAudienceDigest,
      raftMemberCount: status === "unavailable" ? 0 : authorizedProviderMembers.length,
      raftAudienceDigest,
      status,
      observedAt: input.now,
      expiresAt,
      createdAt: input.now,
    });
    return true;
  });
  if (!committed || status !== "matched" || !input.avatarMaterializer) return;
  const avatarUsers = providerUsers.filter((user) => user.avatarLocator !== undefined);
  if (avatarUsers.length === 0) return;
  const projections = await input.db.select({
    id: externalActorProjections.id,
    externalActorId: externalActorProjections.externalActorId,
    projectionRevision: externalActorProjections.projectionRevision,
  }).from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, install.registrationId),
    eq(externalActorProjections.installId, install.id),
    eq(externalActorProjections.workspaceId, install.providerAuthorityId),
    eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false),
    eq(externalActorProjections.observedAt, input.now),
    inArray(externalActorProjections.externalActorId, avatarUsers.map((user) => user.id)),
  ));
  const byExternalId = new Map(projections.map((projection) => [projection.externalActorId, projection]));
  const queue = avatarUsers.flatMap((user) => {
    const projection = byExternalId.get(user.id);
    return projection && user.avatarLocator !== undefined
      ? [{ projection, sourceLocator: user.avatarLocator }] : [];
  });
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(AVATAR_MATERIALIZATION_CONCURRENCY, queue.length) },
    async () => {
      while (cursor < queue.length) {
        const work = queue[cursor++];
        if (!work) return;
        try {
          await input.avatarMaterializer!.materializeExternalProjection({
            projectionId: work.projection.id,
            expectedProjectionRevision: work.projection.projectionRevision,
            expectedObservedAt: input.now,
            sourceLocator: work.sourceLocator,
          });
        } catch {
          // Avatar refresh is deliberately non-authoritative for membership. A
          // failed image keeps the prior artifact/fallback without degrading
          // the audience snapshot that was independently verified above.
        }
      }
    },
  ));
}

export interface SlackPublicConversationAuthorityRefreshReceipt {
  bindingId: string;
  audienceStatus: "matched" | "mismatch" | "unavailable";
  observedAtMs: number;
  reason?: "authority_quarantined" | "identity_mapping_unavailable" | "provider_unavailable";
  revision?: number;
}

/**
 * Refreshes one active public binding from the same provider-backed producer
 * used by self-serve setup. The lifecycle caller gets no synthetic fallback:
 * every DB authority row and the current install-grant receipt must still
 * match before provider identity can extend actor addressability.
 */
export async function refreshSlackPublicConversationAuthority(input: {
  db?: Database;
  provider: SlackBridgeProvisioningProvider;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  bindingId: string;
  now: Date;
}): Promise<SlackPublicConversationAuthorityRefreshReceipt> {
  const db = input.db ?? getDb();
  const unavailable = (
    reason: NonNullable<SlackPublicConversationAuthorityRefreshReceipt["reason"]>,
  ): SlackPublicConversationAuthorityRefreshReceipt => ({
    bindingId: input.bindingId,
    audienceStatus: "unavailable",
    observedAtMs: input.now.getTime(),
    reason,
  });
  if (!input.bindingId.trim() || !validDate(input.now)) {
    return unavailable("identity_mapping_unavailable");
  }

  const bindings = await db.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, input.bindingId),
    eq(externalChannelBindings.privacyClass, "public"),
    eq(externalChannelBindings.state, "active"),
  )).limit(2);
  if (bindings.length !== 1) return unavailable("identity_mapping_unavailable");
  const binding = bindings[0]!;
  const installs = await db.select().from(externalAppInstalls).where(and(
    eq(externalAppInstalls.id, binding.installId),
    eq(externalAppInstalls.serverId, binding.serverId),
    eq(externalAppInstalls.registrationId, binding.registrationId),
  )).limit(2);
  if (installs.length !== 1) return unavailable("identity_mapping_unavailable");
  const install = installs[0]!;
  const registrations = await db.select().from(externalAppRegistrations).where(and(
    eq(externalAppRegistrations.id, binding.registrationId),
    eq(externalAppRegistrations.state, "active"),
  )).limit(2);
  const grants = await db.select().from(externalAppServerGrants).where(and(
    eq(externalAppServerGrants.id, install.serverGrantId),
    eq(externalAppServerGrants.serverId, binding.serverId),
    eq(externalAppServerGrants.registrationId, binding.registrationId),
  )).limit(2);
  const credentials = await db.select().from(externalAppCredentials)
    .where(eq(externalAppCredentials.installId, install.id)).limit(2);
  const receipts = await db.select().from(externalAppInstallGrantReceipts).where(and(
    eq(externalAppInstallGrantReceipts.registrationId, binding.registrationId),
    eq(externalAppInstallGrantReceipts.installId, install.id),
  )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(2);
  if (registrations.length !== 1 || grants.length !== 1 || credentials.length !== 1) {
    return unavailable("identity_mapping_unavailable");
  }
  if (!grantMatchesCurrentRegistration(grants[0]!, registrations[0]!)) {
    return unavailable("authority_quarantined");
  }
  const authority: CurrentAuthority = {
    grant: grants[0]!,
    install,
    credential: credentials[0]!,
    installGrantReceipt: receipts[0] ?? null,
    bindings: [binding],
  };
  if (!currentInstallGrantReceipt(authority, input.now)) {
    return unavailable("authority_quarantined");
  }

  await recordConversationAuthority({
    db,
    provider: input.provider,
    avatarMaterializer: input.avatarMaterializer,
    serverId: binding.serverId,
    now: input.now,
    authority,
    binding,
  });
  const currentBindings = await db.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, binding.id),
    eq(externalChannelBindings.serverId, binding.serverId),
    eq(externalChannelBindings.registrationId, binding.registrationId),
    eq(externalChannelBindings.installId, binding.installId),
    eq(externalChannelBindings.connectionEpoch, binding.connectionEpoch),
    eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
    eq(externalChannelBindings.privacyClass, "public"),
    eq(externalChannelBindings.state, "active"),
  )).limit(2);
  if (currentBindings.length !== 1) return unavailable("identity_mapping_unavailable");
  const status = await currentConversationAuthorityStatus(db, currentBindings[0]!, input.now);
  const [snapshot] = await db.select({
    audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
  }).from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
  return {
    bindingId: binding.id,
    audienceStatus: status,
    observedAtMs: input.now.getTime(),
    ...(status === "unavailable" ? { reason: "provider_unavailable" as const } : {}),
    ...(snapshot ? { revision: snapshot.audienceRevision } : {}),
  };
}

async function markPreflightResult(input: {
  db: Database;
  request: SlackBridgeProvisioningRequestAuthority;
  authority: CurrentAuthority;
  passed: boolean;
}): Promise<void> {
  const install = currentInstall(input.authority);
  if (!install) return;
  await input.db.transaction(async (tx) => {
    await requireManager(tx, input.request, true);
    const bindings = await tx.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.serverId, input.request.serverId),
      eq(externalChannelBindings.installId, install.id),
      eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
      eq(externalChannelBindings.state, "paused"),
    )).for("update");
    for (const binding of bindings) {
      await tx.update(externalChannelBindings).set({
        stateReason: input.passed ? PROVISIONING_PASSED_REASON : PROVISIONING_PENDING_REASON,
        updatedAt: input.request.now,
      }).where(and(
        eq(externalChannelBindings.id, binding.id),
        eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
        eq(externalChannelBindings.state, "paused"),
      ));
    }
    if (input.passed) {
      await tx.update(externalAppInstalls).set({
        lastVerifiedAt: input.request.now,
        updatedAt: input.request.now,
      }).where(and(
        eq(externalAppInstalls.id, install.id),
        eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
        eq(externalAppInstalls.credentialRevision, install.credentialRevision),
        eq(externalAppInstalls.state, "active"),
      ));
    }
  });
}

/**
 * Concrete, durable Slack Bridge setup authority. Every operation re-reads
 * registration/grant/install/credential/binding/audience rows and validates
 * the requesting human's current manageServer capability. Provider data is
 * read-only input and is always fenced by the persisted install epochs.
 */
export function createSlackBridgeProvisioningControlPlane(
  dependencies: SlackBridgeProvisioningControlPlaneDependencies,
): SlackBridgeProvisioningControlPlane {
  assertBootstrap(dependencies.bootstrap);
  const db = dependencies.db ?? getDb();
  const bootstrap = {
    ...dependencies.bootstrap,
    requiredCapabilities: canonicalStrings(dependencies.bootstrap.requiredCapabilities),
  };

  const load = async (
    request: SlackBridgeProvisioningRequestAuthority,
  ): Promise<SlackBridgeProvisioningResponse> => {
    await requireManager(db, request);
    const registration = await assertBootstrapRows(db, bootstrap);
    const authority = registration
      ? await loadCurrentAuthority(db, bootstrap, request.serverId)
      : {
        grant: null,
        install: null,
        credential: null,
        installGrantReceipt: null,
        bindings: [],
      };
    const observation = registration
      ? await observeProvider(dependencies.provider, authority, request.now)
      : { status: "unverified" as const, workspaceName: null, channels: [] };
    return responseFor({ db, bootstrap, authority, providerObservation: observation, request });
  };

  const loadWithoutProvider = async (
    request: SlackBridgeProvisioningRequestAuthority,
  ): Promise<SlackBridgeProvisioningResponse> => {
    await requireManager(db, request);
    const registration = await assertBootstrapRows(db, bootstrap);
    const authority = registration
      ? await loadCurrentAuthority(db, bootstrap, request.serverId)
      : {
        grant: null,
        install: null,
        credential: null,
        installGrantReceipt: null,
        bindings: [],
      };
    return responseFor({
      db,
      bootstrap,
      authority,
      providerObservation: {
        status: "unverified",
        workspaceName: authority.install?.workspaceName ?? null,
        channels: [],
      },
      request,
    });
  };

  return {
    load,

    async connect(request) {
      requireManagerInput(request);
      await db.transaction(async (tx) => {
        await requireManager(tx, request, true);
        const clientId = `slack-bridge:${bootstrap.registrationId}`;
        let [client] = await tx.select().from(oauthClients)
          .where(eq(oauthClients.clientId, clientId)).for("update").limit(1);
        if (!client) {
          [client] = await tx.insert(oauthClients).values({
            serverId: request.serverId,
            clientId,
            clientSecretHash: sha256(randomBytes(32).toString("base64url")),
            appType: "third_party_global",
            publishStatus: "published",
            name: "Slack Bridge",
            description: "Raft first-party Slack Bridge control plane",
            allowedScopes: [],
            enabled: true,
            humanMarketplaceVisible: false,
            createdByUserId: request.requestingUserId,
            createdAt: request.now,
            updatedAt: request.now,
          }).onConflictDoNothing({ target: oauthClients.clientId }).returning();
          if (!client) {
            [client] = await tx.select().from(oauthClients)
              .where(eq(oauthClients.clientId, clientId)).for("update").limit(1);
          }
        }
        if (!client) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge OAuth client could not be persisted",
            "external_app_persist_failed",
          );
        }
        assertBootstrapClient(client, bootstrap);

        let registration = await assertBootstrapRows(tx, bootstrap);
        if (!registration) {
          [registration] = await tx.insert(externalAppRegistrations).values({
            id: bootstrap.registrationId,
            oauthClientId: client.id,
            provider: "slack",
            environment: bootstrap.environment,
            state: "active",
            providerAppId: bootstrap.providerAppId,
            providerOAuthClientId: bootstrap.providerOAuthClientId,
            capabilityManifestVersion: bootstrap.capabilityManifestVersion,
            capabilityManifestHash: bootstrap.capabilityManifestHash,
            requiredCapabilities: bootstrap.requiredCapabilities,
            createdAt: request.now,
            updatedAt: request.now,
          }).returning();
          if (!registration) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge registration could not be persisted",
              "external_app_persist_failed",
            );
          }
          await tx.insert(externalAppRegistrationSecrets).values([{
            registrationId: registration.id,
            purpose: "signing_secret",
            encryptedSecretRef: bootstrap.signingSecret.encryptedSecretRef,
            envelopeKeyId: bootstrap.signingSecret.envelopeKeyId,
            aadVersion: 1,
            secretRevision: bootstrap.signingSecret.secretRevision,
            createdAt: request.now,
            updatedAt: request.now,
          }, {
            registrationId: registration.id,
            purpose: "oauth_client_secret",
            encryptedSecretRef: bootstrap.oauthClientSecret.encryptedSecretRef,
            envelopeKeyId: bootstrap.oauthClientSecret.envelopeKeyId,
            aadVersion: 1,
            secretRevision: bootstrap.oauthClientSecret.secretRevision,
            createdAt: request.now,
            updatedAt: request.now,
          }]);
          await tx.insert(externalAppIngressEndpoints).values({
            registrationId: registration.id,
            environment: bootstrap.environment,
            exactRequestUrl: bootstrap.eventsRequestUrl,
            state: "active",
            endpointRevision: 1,
            signingSecretRevision: bootstrap.signingSecret.secretRevision,
            createdAt: request.now,
            updatedAt: request.now,
          });
        }
        assertRegistration(registration, bootstrap);
        if (registration.oauthClientId !== client.id) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge registration references a conflicting OAuth client",
            "external_app_install_conflict",
          );
        }
        await assertBootstrapRows(tx, bootstrap);

        await tx.insert(oauthClientInstalls).values({
          serverId: request.serverId,
          clientId: client.id,
          installedByUserId: request.requestingUserId,
          status: "active",
          createdAt: request.now,
          updatedAt: request.now,
        }).onConflictDoUpdate({
          target: [oauthClientInstalls.serverId, oauthClientInstalls.clientId],
          set: {
            installedByUserId: request.requestingUserId,
            installedByAgentId: null,
            status: "active",
            updatedAt: request.now,
          },
        });

        const [existingGrant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.serverId, request.serverId),
          eq(externalAppServerGrants.registrationId, registration.id),
        )).for("update").limit(1);
        if (existingGrant?.state === "active") {
          if (
            existingGrant.grantedManifestVersion !== bootstrap.capabilityManifestVersion
            || existingGrant.grantedManifestHash !== bootstrap.capabilityManifestHash
            || !exactStrings(existingGrant.grantedCapabilities, bootstrap.requiredCapabilities)
          ) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge active grant conflicts with runtime authority",
              "external_app_install_conflict",
            );
          }
        } else if (existingGrant) {
          await tx.update(externalAppServerGrants).set({
            state: "active",
            grantEpoch: existingGrant.grantEpoch + 1,
            grantedManifestVersion: bootstrap.capabilityManifestVersion,
            grantedManifestHash: bootstrap.capabilityManifestHash,
            grantedCapabilities: bootstrap.requiredCapabilities,
            grantedByType: "human",
            grantedById: request.requestingUserId,
            revokedAt: null,
            revokeReason: null,
            updatedAt: request.now,
          }).where(eq(externalAppServerGrants.id, existingGrant.id));
        } else {
          await tx.insert(externalAppServerGrants).values({
            serverId: request.serverId,
            registrationId: registration.id,
            state: "active",
            grantEpoch: 1,
            grantedManifestVersion: bootstrap.capabilityManifestVersion,
            grantedManifestHash: bootstrap.capabilityManifestHash,
            grantedCapabilities: bootstrap.requiredCapabilities,
            grantedByType: "human",
            grantedById: request.requestingUserId,
            createdAt: request.now,
            updatedAt: request.now,
          });
        }
      });
      return load(request);
    },

    async saveChannelPairs(input) {
      requireManagerInput(input);
      const registration = await assertBootstrapRows(db, bootstrap);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before channel selection",
          "external_app_invalid_state",
        );
      }
      const authority = await loadCurrentAuthority(db, bootstrap, input.serverId);
      const providerAuthority = activeProviderAuthority(authority, input.now);
      if (!providerAuthority || !currentGrant(authority, bootstrap)) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge OAuth authority is not active",
          "external_app_not_authorized",
        );
      }
      const observation = await observeProvider(dependencies.provider, authority, input.now);
      if (observation.status !== "passed") {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge provider channel inventory is unavailable",
          "external_app_invalid_state",
        );
      }
      const providerById = new Map(observation.channels.map((channel) => [channel.id, channel]));
      const raft = await listSlackBridgeRaftConversationTargets(db, input.serverId);
      const raftById = new Map(raft.map((channel) => [channel.id, channel]));
      if (input.pairs.some((pair) => {
        const raftChannel = raftById.get(pair.raftChannelId);
        const providerChannel = providerById.get(pair.slackChannelId);
        return !raftChannel
          || !providerChannel
          || providerChannel.isMember !== true
          || (raftChannel.type === "private") !== (providerChannel.privacyClass === "private");
      })) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge channel pairs do not match current channel authority",
          "external_app_invalid_state",
        );
      }

      await db.transaction(async (tx) => {
        await requireManager(tx, input, true);
        const [install] = await tx.select().from(externalAppInstalls).where(and(
          eq(externalAppInstalls.id, providerAuthority.installId),
          eq(externalAppInstalls.serverId, input.serverId),
          eq(externalAppInstalls.registrationId, bootstrap.registrationId),
          notInArray(externalAppInstalls.state, ["revoked"]),
          eq(externalAppInstalls.connectionEpoch, providerAuthority.connectionEpoch),
          eq(externalAppInstalls.credentialRevision, providerAuthority.credentialRevision),
        )).for("update").limit(1);
        if (!install) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge install changed during channel selection",
            "external_app_not_authorized",
          );
        }
        const existing = await tx.select().from(externalChannelBindings).where(and(
          eq(externalChannelBindings.serverId, input.serverId),
          eq(externalChannelBindings.installId, install.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
        )).for("update");
        const desiredKeys = new Set(input.pairs.map((pair) => `${pair.raftChannelId}:${pair.slackChannelId}`));
        const protectedBindings = existing.filter(
          (binding) => binding.state === "active" || binding.state === "quarantined",
        );
        const omitsProtectedBinding = protectedBindings.some((binding) =>
          !desiredKeys.has(`${binding.channelId}:${binding.providerConversationId}`));
        const conflictsWithProtectedBinding = input.pairs.some((pair) =>
          protectedBindings.some((binding) =>
            (binding.channelId === pair.raftChannelId
              || binding.providerConversationId === pair.slackChannelId)
            && (binding.channelId !== pair.raftChannelId
              || binding.providerConversationId !== pair.slackChannelId)));
        if (omitsProtectedBinding || conflictsWithProtectedBinding) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge active or quarantined bindings cannot be omitted or replaced by setup",
            "external_app_install_conflict",
          );
        }
        const collidesWithExistingBinding = input.pairs.some((pair) =>
          existing.some((binding) =>
            !(binding.state === "revoked" && binding.stateReason === PROVISIONING_REMOVED_REASON)
            && (binding.channelId === pair.raftChannelId
              || binding.providerConversationId === pair.slackChannelId)
            && (binding.channelId !== pair.raftChannelId
              || binding.providerConversationId !== pair.slackChannelId)));
        if (collidesWithExistingBinding) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge channel coordinates are already bound to a different pair",
            "external_app_install_conflict",
          );
        }
        for (const binding of existing) {
          const key = `${binding.channelId}:${binding.providerConversationId}`;
          if (binding.state === "paused" && !desiredKeys.has(key)) {
            await tx.update(externalChannelBindings).set({
              state: "revoked",
              stateReason: PROVISIONING_REPLACED_REASON,
              bindingEpoch: binding.bindingEpoch + 1,
              updatedAt: input.now,
            }).where(and(
              eq(externalChannelBindings.id, binding.id),
              eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
              eq(externalChannelBindings.state, "paused"),
            ));
          }
        }
        for (const pair of input.pairs) {
          const providerChannel = providerById.get(pair.slackChannelId)!;
          const protectedExact = protectedBindings.find((binding) =>
            binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (protectedExact) continue;
          const revokedExactWithOtherReason = existing.find((binding) =>
            binding.state === "revoked"
            && binding.stateReason !== PROVISIONING_REMOVED_REASON
            && binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (revokedExactWithOtherReason) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge channel pair is revoked outside provisioning teardown",
              "external_app_install_conflict",
            );
          }
          const revokedExact = existing.find((binding) =>
            binding.state === "revoked"
            && binding.stateReason === PROVISIONING_REMOVED_REASON
            && binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (revokedExact) {
            const [revived] = await tx.update(externalChannelBindings).set({
              state: "paused",
              stateReason: PROVISIONING_PENDING_REASON,
              bindingEpoch: revokedExact.bindingEpoch + 1,
              audienceRevision: providerChannel.privacyClass === "private"
                ? (revokedExact.audienceRevision ?? 0) + 1
                : revokedExact.audienceRevision,
              audienceFreshUntil: providerChannel.privacyClass === "private" ? input.now : null,
              consentedByType: "human",
              consentedById: input.requestingUserId,
              consentedAt: input.now,
              updatedAt: input.now,
            }).where(and(
              eq(externalChannelBindings.id, revokedExact.id),
              eq(externalChannelBindings.bindingEpoch, revokedExact.bindingEpoch),
              eq(externalChannelBindings.state, "revoked"),
              eq(externalChannelBindings.stateReason, PROVISIONING_REMOVED_REASON),
            )).returning({ id: externalChannelBindings.id });
            if (!revived) {
              throw new ExternalAppControlPlaneError(
                "Slack Bridge removed channel pair changed during revival",
                "external_app_install_conflict",
              );
            }
            continue;
          }
          const exact = existing.find((binding) =>
            binding.state === "paused"
            && binding.channelId === pair.raftChannelId
            && binding.providerConversationId === pair.slackChannelId);
          if (exact) {
            await tx.update(externalChannelBindings).set({
              stateReason: PROVISIONING_PENDING_REASON,
              consentedByType: "human",
              consentedById: input.requestingUserId,
              consentedAt: input.now,
              updatedAt: input.now,
            }).where(and(
              eq(externalChannelBindings.id, exact.id),
              eq(externalChannelBindings.bindingEpoch, exact.bindingEpoch),
              eq(externalChannelBindings.state, "paused"),
            ));
            continue;
          }
          await tx.insert(externalChannelBindings).values({
            serverId: input.serverId,
            registrationId: bootstrap.registrationId,
            installId: install.id,
            channelId: pair.raftChannelId,
            providerConversationId: pair.slackChannelId,
            providerConversationKind: providerChannel.privacyClass === "private"
              ? "private_channel"
              : "public_channel",
            privacyClass: providerChannel.privacyClass,
            state: "paused",
            stateReason: PROVISIONING_PENDING_REASON,
            grantEpoch: install.grantEpoch,
            connectionEpoch: install.connectionEpoch,
            bindingEpoch: 1,
            audienceRevision: providerChannel.privacyClass === "private" ? 1 : null,
            audienceFreshUntil: providerChannel.privacyClass === "private" ? input.now : null,
            consentedByType: "human",
            consentedById: input.requestingUserId,
            consentedAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          });
        }
      });
      return load(input);
    },

    async removeChannelPairs(input) {
      requireManagerInput(input);
      const registration = await assertBootstrapRows(db, bootstrap);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before channel removal",
          "external_app_invalid_state",
        );
      }
      const authority = await loadCurrentAuthority(db, bootstrap, input.serverId);
      const install = authority.install;
      if (!install || install.state === "revoked") {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge install is unavailable for channel removal",
          "external_app_invalid_state",
        );
      }
      await db.transaction(async (tx) => {
        await requireManager(tx, input, true);
        const existing = await tx.select().from(externalChannelBindings).where(and(
          eq(externalChannelBindings.serverId, input.serverId),
          eq(externalChannelBindings.registrationId, bootstrap.registrationId),
          eq(externalChannelBindings.installId, install.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
        )).for("update");
        const requested = input.pairs.map((pair) => existing.find((binding) =>
          binding.channelId === pair.raftChannelId
          && binding.providerConversationId === pair.slackChannelId
          && binding.bindingEpoch === pair.expectedBindingEpoch));
        if (requested.some((binding) =>
          !binding || !["active", "paused", "quarantined"].includes(binding.state))) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge channel removal coordinates are stale or unavailable",
            "external_app_install_conflict",
          );
        }
        for (const binding of requested) {
          const exact = binding!;
          const [updated] = await tx.update(externalChannelBindings).set({
            state: "revoked",
            stateReason: PROVISIONING_REMOVED_REASON,
            bindingEpoch: exact.bindingEpoch + 1,
            updatedAt: input.now,
          }).where(and(
            eq(externalChannelBindings.id, exact.id),
            eq(externalChannelBindings.bindingEpoch, exact.bindingEpoch),
            eq(externalChannelBindings.state, exact.state),
          )).returning({ id: externalChannelBindings.id });
          if (!updated) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge channel removal changed during mutation",
              "external_app_install_conflict",
            );
          }
        }
      });
      return loadWithoutProvider(input);
    },

    async disconnect(input) {
      requireManagerInput(input);
      if (!Number.isInteger(input.expectedConnectionEpoch) || input.expectedConnectionEpoch < 1) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge disconnect coordinate is invalid",
          "external_app_invalid_state",
        );
      }
      const registration = await assertBootstrapRows(db, bootstrap);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge is not connected",
          "external_app_invalid_state",
        );
      }
      await db.transaction(async (tx) => {
        await requireManager(tx, input, true);
        const [grant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.serverId, input.serverId),
          eq(externalAppServerGrants.registrationId, registration.id),
          eq(externalAppServerGrants.state, "active"),
        )).for("update").limit(1);
        if (!grant) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge server grant changed before disconnect",
            "external_app_install_conflict",
          );
        }
        const [install] = await tx.select().from(externalAppInstalls).where(and(
          eq(externalAppInstalls.serverId, input.serverId),
          eq(externalAppInstalls.registrationId, registration.id),
          eq(externalAppInstalls.serverGrantId, grant.id),
          eq(externalAppInstalls.grantEpoch, grant.grantEpoch),
          notInArray(externalAppInstalls.state, ["revoked"]),
          eq(externalAppInstalls.connectionEpoch, input.expectedConnectionEpoch),
        )).for("update").limit(1);
        if (!install) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge workspace changed before disconnect",
            "external_app_install_conflict",
          );
        }

        await tx.update(externalAuthorPolicies).set({
          state: "revoked",
          updatedAt: input.now,
        }).where(and(
          eq(externalAuthorPolicies.serverId, input.serverId),
          eq(externalAuthorPolicies.provider, "slack"),
          eq(externalAuthorPolicies.appRegistrationId, registration.id),
          eq(externalAuthorPolicies.installId, install.id),
          eq(externalAuthorPolicies.state, "granted"),
        ));
        await tx.update(externalHumanIdentityLinks).set({
          state: "revoked",
          revokedAt: input.now,
          revokeReason: PROVISIONING_UNBOUND_REASON,
          updatedAt: input.now,
        }).where(and(
          eq(externalHumanIdentityLinks.serverId, input.serverId),
          eq(externalHumanIdentityLinks.installId, install.id),
          eq(externalHumanIdentityLinks.state, "active"),
        ));
        const bindings = await tx.select().from(externalChannelBindings).where(and(
          eq(externalChannelBindings.serverId, input.serverId),
          eq(externalChannelBindings.registrationId, registration.id),
          eq(externalChannelBindings.installId, install.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
          inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
        )).for("update");
        for (const binding of bindings) {
          const [revoked] = await tx.update(externalChannelBindings).set({
            state: "revoked",
            stateReason: PROVISIONING_UNBOUND_REASON,
            bindingEpoch: binding.bindingEpoch + 1,
            updatedAt: input.now,
          }).where(and(
            eq(externalChannelBindings.id, binding.id),
            eq(externalChannelBindings.state, binding.state),
            eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
          )).returning({ id: externalChannelBindings.id });
          if (!revoked) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge binding changed during disconnect",
              "external_app_install_conflict",
            );
          }
        }
        const [credential] = await tx.select().from(externalAppCredentials)
          .where(eq(externalAppCredentials.installId, install.id)).for("update").limit(1);
        if (credential && credential.state !== "revoked") {
          const [revokedCredential] = await tx.update(externalAppCredentials).set({
            state: "revoked",
            leaseOwner: null,
            leaseExpiresAt: null,
            revokedAt: input.now,
            updatedAt: input.now,
          }).where(and(
            eq(externalAppCredentials.id, credential.id),
            eq(externalAppCredentials.state, credential.state),
            eq(externalAppCredentials.credentialRevision, credential.credentialRevision),
          )).returning({ id: externalAppCredentials.id });
          if (!revokedCredential) {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge credential changed during disconnect",
              "external_app_install_conflict",
            );
          }
        }
        const [revokedInstall] = await tx.update(externalAppInstalls).set({
          state: "revoked",
          stateReason: PROVISIONING_UNBOUND_REASON,
          connectionEpoch: install.connectionEpoch + 1,
          disconnectedAt: input.now,
          installGrantRenewalLeaseOwner: null,
          installGrantRenewalLeaseExpiresAt: null,
          installGrantRenewalNextAttemptAt: null,
          updatedAt: input.now,
        }).where(and(
          eq(externalAppInstalls.id, install.id),
          eq(externalAppInstalls.state, install.state),
          eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
        )).returning({ id: externalAppInstalls.id });
        if (!revokedInstall) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge install changed during disconnect",
            "external_app_install_conflict",
          );
        }
        const [revokedGrant] = await tx.update(externalAppServerGrants).set({
          state: "revoked",
          revokedAt: input.now,
          revokeReason: PROVISIONING_UNBOUND_REASON,
          updatedAt: input.now,
        }).where(and(
          eq(externalAppServerGrants.id, grant.id),
          eq(externalAppServerGrants.state, "active"),
          eq(externalAppServerGrants.grantEpoch, grant.grantEpoch),
        )).returning({ id: externalAppServerGrants.id });
        if (!revokedGrant) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge server grant changed during disconnect",
            "external_app_install_conflict",
          );
        }
        const clientId = `slack-bridge:${bootstrap.registrationId}`;
        const [client] = await tx.select({ id: oauthClients.id }).from(oauthClients)
          .where(eq(oauthClients.clientId, clientId)).limit(1);
        if (client) {
          await tx.update(oauthClientInstalls).set({
            status: "suspended",
            updatedAt: input.now,
          }).where(and(
            eq(oauthClientInstalls.serverId, input.serverId),
            eq(oauthClientInstalls.clientId, client.id),
            eq(oauthClientInstalls.status, "active"),
          ));
        }
      });
      return loadWithoutProvider(input);
    },

    async runPreflight(request) {
      await requireManager(db, request);
      const registration = await assertBootstrapRows(db, bootstrap);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before preflight",
          "external_app_invalid_state",
        );
      }
      let authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const observation = await observeProvider(dependencies.provider, authority, request.now);
      for (const binding of authority.bindings) {
        if (binding.state === "paused" || binding.state === "active") {
          await recordConversationAuthority({
            db,
            provider: dependencies.provider,
            avatarMaterializer: dependencies.avatarMaterializer,
            serverId: request.serverId,
            now: request.now,
            authority,
            binding,
          });
        }
      }
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const audiences = await audienceStatuses(db, authority.bindings, request.now, observation);
      const preflight = preflightFor({
        authority,
        bootstrap,
        audiences,
        connection: observation.status,
      });
      await markPreflightResult({ db, request, authority, passed: preflight.state === "passed" });
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      return responseFor({ db, bootstrap, authority, providerObservation: observation, request });
    },

    async enable(request) {
      await requireManager(db, request);
      const registration = await assertBootstrapRows(db, bootstrap);
      if (!registration) {
        throw new ExternalAppControlPlaneError(
          "Slack Bridge connect must complete before enable",
          "external_app_invalid_state",
        );
      }
      let authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const observation = await observeProvider(dependencies.provider, authority, request.now);
      for (const binding of authority.bindings) {
        if (binding.state === "paused" || binding.state === "active") {
          await recordConversationAuthority({
            db,
            provider: dependencies.provider,
            avatarMaterializer: dependencies.avatarMaterializer,
            serverId: request.serverId,
            now: request.now,
            authority,
            binding,
          });
        }
      }
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      const installGrantObservation = await observeInstallGrant(
        dependencies.provider,
        authority,
        request.now,
      );
      const audiences = await audienceStatuses(db, authority.bindings, request.now, observation);
      const preflight = preflightFor({
        authority,
        bootstrap,
        audiences,
        connection: observation.status,
      });
      const repairingActiveBindings = authority.bindings.length > 0
        && authority.bindings.every((binding) => binding.state === "active");
      const activatingPausedBindings = authority.bindings.length > 0
        && authority.bindings.some((binding) => binding.state === "paused")
        && authority.bindings.every((binding) =>
          binding.state === "active"
          || (binding.state === "paused" && binding.stateReason === PROVISIONING_PASSED_REASON));
      if (
        preflight.state !== "passed"
        || (!repairingActiveBindings && !activatingPausedBindings)
        || installGrantObservation.kind !== "fact"
        || !installGrantMatchesAuthority(authority, installGrantObservation.fact)
      ) {
        if (!repairingActiveBindings) {
          await markPreflightResult({ db, request, authority, passed: false });
        }
        authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
        return responseFor({ db, bootstrap, authority, providerObservation: observation, request });
      }
      const install = currentInstall(authority)!;
      const credential = authority.credential!;
      const installGrant = installGrantObservation.fact;
      const observedGrantHash = slackBridgeInstallGrantHash(installGrant);
      const expectedBindings = new Map(authority.bindings.map((binding) => [binding.id, binding]));
      await db.transaction(async (tx) => {
        await requireManager(tx, request, true);
        const [lockedInstall] = await tx.select().from(externalAppInstalls).where(and(
          eq(externalAppInstalls.id, install.id),
          eq(externalAppInstalls.serverId, request.serverId),
          eq(externalAppInstalls.registrationId, bootstrap.registrationId),
          eq(externalAppInstalls.serverGrantId, install.serverGrantId),
          eq(externalAppInstalls.grantEpoch, install.grantEpoch),
          eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
          eq(externalAppInstalls.credentialRevision, install.credentialRevision),
          eq(externalAppInstalls.state, "active"),
        )).for("update").limit(1);
        const [lockedGrant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.id, install.serverGrantId),
          eq(externalAppServerGrants.serverId, request.serverId),
          eq(externalAppServerGrants.registrationId, bootstrap.registrationId),
          eq(externalAppServerGrants.state, "active"),
          eq(externalAppServerGrants.grantEpoch, install.grantEpoch),
        )).for("update").limit(1);
        const [lockedCredential] = await tx.select().from(externalAppCredentials).where(and(
          eq(externalAppCredentials.id, credential.id),
          eq(externalAppCredentials.installId, install.id),
          eq(externalAppCredentials.state, "active"),
          eq(externalAppCredentials.credentialRevision, install.credentialRevision),
          or(
            isNull(externalAppCredentials.expiresAt),
            gt(externalAppCredentials.expiresAt, request.now),
          ),
        )).for("update").limit(1);
        if (
          !lockedInstall
          || !lockedGrant
          || !lockedCredential
          || lockedGrant.grantedManifestVersion !== bootstrap.capabilityManifestVersion
          || lockedGrant.grantedManifestHash !== bootstrap.capabilityManifestHash
          || !exactStrings(lockedGrant.grantedCapabilities, bootstrap.requiredCapabilities)
        ) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge OAuth authority changed before enable",
            "external_app_invalid_state",
          );
        }
        const currentBindings = await tx.select().from(externalChannelBindings).where(and(
          eq(externalChannelBindings.serverId, request.serverId),
          eq(externalChannelBindings.installId, install.id),
          eq(externalChannelBindings.connectionEpoch, install.connectionEpoch),
          or(
            isNull(externalChannelBindings.stateReason),
            notInArray(externalChannelBindings.stateReason, [
              PROVISIONING_REPLACED_REASON,
              PROVISIONING_REMOVED_REASON,
            ]),
          ),
        )).for("update");
        if (
          currentBindings.length !== authority.bindings.length
          || currentBindings.some((binding) => {
            const expected = expectedBindings.get(binding.id);
            return !expected
              || (repairingActiveBindings
                ? binding.state !== "active" || binding.stateReason !== null
                : expected.state === "active"
                  ? binding.state !== "active" || binding.stateReason !== null
                  : binding.state !== "paused" || binding.stateReason !== PROVISIONING_PASSED_REASON)
              || binding.channelId !== expected.channelId
              || binding.providerConversationId !== expected.providerConversationId
              || binding.privacyClass !== expected.privacyClass
              || binding.bindingEpoch !== expected.bindingEpoch
              || binding.audienceRevision !== expected.audienceRevision
              || binding.connectionEpoch !== install.connectionEpoch
              || binding.grantEpoch !== install.grantEpoch;
          })
        ) {
          throw new ExternalAppControlPlaneError(
            "Slack Bridge preflight authority changed before enable",
            "external_app_invalid_state",
          );
        }
        const receipts = await tx.select().from(externalAppInstallGrantReceipts).where(and(
          eq(externalAppInstallGrantReceipts.registrationId, bootstrap.registrationId),
          eq(externalAppInstallGrantReceipts.installId, lockedInstall.id),
        )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(2).for("update");
        const latestReceipt = receipts[0] ?? null;
        const currentReceipt = latestReceipt
          && latestReceipt.status === "valid"
          && latestReceipt.expiresAt > request.now
          && latestReceipt.connectionEpoch === lockedInstall.connectionEpoch
          && latestReceipt.scopeRevision === lockedInstall.scopeRevision
          && latestReceipt.credentialRevision === lockedInstall.credentialRevision
          && latestReceipt.providerAppId === installGrant.providerAppId
          && latestReceipt.providerAuthorityId === installGrant.providerAuthorityId
          && latestReceipt.botUserId === installGrant.botUserId
          && latestReceipt.providerBotId === installGrant.providerBotId
          && exactStrings(latestReceipt.grantedScopes, installGrant.grantedScopes)
          && latestReceipt.grantHash === observedGrantHash;
        if (!currentReceipt) {
          await tx.insert(externalAppInstallGrantReceipts).values({
            registrationId: bootstrap.registrationId,
            installId: lockedInstall.id,
            receiptRevision: (latestReceipt?.receiptRevision ?? 0) + 1,
            connectionEpoch: lockedInstall.connectionEpoch,
            scopeRevision: lockedInstall.scopeRevision,
            credentialRevision: lockedInstall.credentialRevision,
            providerAppId: installGrant.providerAppId,
            providerAuthorityId: installGrant.providerAuthorityId,
            botUserId: installGrant.botUserId,
            providerBotId: installGrant.providerBotId,
            grantedScopes: canonicalStrings(installGrant.grantedScopes),
            grantHash: observedGrantHash,
            observationSource: "token_introspection",
            status: "valid",
            errorCode: null,
            observedAt: request.now,
            expiresAt: new Date(
              request.now.getTime() + SLACK_BRIDGE_INSTALL_GRANT_FRESHNESS_MS,
            ),
            createdAt: request.now,
          });
        }
        if (lockedInstall.providerBotId === null) {
          await tx.update(externalAppInstalls).set({
            providerBotId: installGrant.providerBotId,
            lastVerifiedAt: request.now,
            updatedAt: request.now,
          }).where(and(
            eq(externalAppInstalls.id, lockedInstall.id),
            eq(externalAppInstalls.connectionEpoch, lockedInstall.connectionEpoch),
            eq(externalAppInstalls.scopeRevision, lockedInstall.scopeRevision),
            eq(externalAppInstalls.credentialRevision, lockedInstall.credentialRevision),
            isNull(externalAppInstalls.providerBotId),
          ));
        }
        for (const binding of currentBindings) {
          if (await currentConversationAuthorityStatus(tx, binding, request.now) !== "matched") {
            throw new ExternalAppControlPlaneError(
              "Slack Bridge audience authority changed before enable",
              "external_app_invalid_state",
            );
          }
        }
        if (activatingPausedBindings) {
          for (const binding of currentBindings) {
            await tx.update(externalChannelBindings).set({
              state: "active",
              stateReason: null,
              updatedAt: request.now,
            }).where(and(
              eq(externalChannelBindings.id, binding.id),
              eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
              eq(externalChannelBindings.state, "paused"),
              eq(externalChannelBindings.stateReason, PROVISIONING_PASSED_REASON),
            ));
          }
        }
        await grantManagerCurrentOutboundConsent({
          tx,
          bootstrap,
          install: lockedInstall,
          bindings: currentBindings,
          request,
        });
      });
      if (dependencies.authorAvatarMaterializer) {
        const policies = await db.select({ id: externalAuthorPolicies.id }).from(externalAuthorPolicies).where(and(
          eq(externalAuthorPolicies.serverId, request.serverId),
          eq(externalAuthorPolicies.provider, "slack"),
          eq(externalAuthorPolicies.appRegistrationId, bootstrap.registrationId),
          eq(externalAuthorPolicies.installId, install.id),
          inArray(externalAuthorPolicies.bindingId, authority.bindings.map((binding) => binding.id)),
          eq(externalAuthorPolicies.authorType, "user"),
          eq(externalAuthorPolicies.authorId, request.requestingUserId),
          eq(externalAuthorPolicies.state, "granted"),
        ));
        for (const policy of policies) {
          try {
            await dependencies.authorAvatarMaterializer(policy.id);
          } catch {
            // Consent and audience authority remain valid when a profile image
            // cannot be materialized; the frozen emoji fallback stays active.
          }
        }
      }
      authority = await loadCurrentAuthority(db, bootstrap, request.serverId);
      return responseFor({ db, bootstrap, authority, providerObservation: observation, request });
    },
  };
}

export function slackBridgeProvisioningManifestHash(input: {
  oauthRedirectUri: string;
  eventsRequestUrl: string;
}): string {
  return sha256(JSON.stringify({
    version: 1,
    provider: "slack",
    oauthRedirectUri: input.oauthRedirectUri,
    eventsRequestUrl: input.eventsRequestUrl,
    scopes: [...SLACK_BRIDGE_ACTIVE_BOT_SCOPES],
  }));
}

export const SLACK_BRIDGE_PROVISIONING_CAPABILITIES = [
  "channel_events",
  "external_projection",
  "private_audience",
] as const;
