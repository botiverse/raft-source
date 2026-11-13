import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { currentDate, type SlackBridgeProvisioningFailureReason } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { lockSlackInstallConversations, SlackInstallLockSetChanged } from "./slackBridgeRowLocks";
import { newSlackMentionAuthorizationId } from "./slackMentionReconcileState";
import {
  channels,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrationSecrets,
  externalAppRegistrations,
  externalAppServerGrants,
  externalChannelBindings,
  externalOAuthAttempts,
  oauthClientInstalls,
  serverMembers,
  servers,
} from "../db/schema";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";

const EXTERNAL_OAUTH_ATTEMPT_TTL_MS = 10 * 60_000;

type DbLike = ReturnType<typeof getDb>;
type RegistrationRow = typeof externalAppRegistrations.$inferSelect;
type GrantRow = typeof externalAppServerGrants.$inferSelect;

export type ExternalAppControlPlaneErrorCode =
  | "external_app_not_authorized"
  | "external_app_invalid_state"
  | "external_app_install_conflict"
  | "external_app_workspace_mismatch"
  | "external_app_scope_mismatch"
  | "external_app_persist_failed";

export class ExternalAppControlPlaneError extends Error {
  constructor(
    message: string,
    readonly code: ExternalAppControlPlaneErrorCode,
    readonly reason?: SlackBridgeProvisioningFailureReason,
  ) {
    super(message);
    this.name = "ExternalAppControlPlaneError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = canonicalStrings(left);
  const b = canonicalStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Every required scope is present in actual. Extras allowed. */
function scopesCover(actual: string[], required: string[]): boolean {
  const have = new Set(canonicalStrings(actual));
  return required.every((s) => have.has(s));
}

async function requireOAuthManager(tx: DbLike, serverId: string, requestingUserId: string, lock: boolean): Promise<void> {
  const query = tx.select({ role: serverMembers.role }).from(serverMembers).where(and(
    eq(serverMembers.serverId, serverId), eq(serverMembers.userId, requestingUserId),
  )).limit(1);
  const [membership] = lock ? await query.for("update") : await query;
  if (membership?.role !== "owner" && membership?.role !== "admin") {
    throw new ExternalAppControlPlaneError("External app operation is not authorized", "external_app_not_authorized");
  }
}

/** Retry only discovery races after their transaction rolls back; never mask a deadlock. */
export async function retryExternalAppInstallLockSet<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); } catch (error) {
      if (!(error instanceof SlackInstallLockSetChanged)) throw error;
      if (attempt >= 2) throw new ExternalAppControlPlaneError(
        "External workspace changed during the operation; retry", "external_app_install_conflict");
    }
  }
}

async function loadCurrentGrant(
  tx: DbLike,
  input: {
    serverId: string;
    registrationId: string;
    serverGrantId: string;
    grantEpoch: number;
    requestingUserId?: string;
    lock?: boolean;
  },
): Promise<{ registration: RegistrationRow; grant: GrantRow }> {
  // Keep the manager fence before install/shared authority locks, as in the
  // provisioning control plane. Begin/claim must not hold registration while
  // waiting for an OAuth completion's manager row.
  if (input.requestingUserId) await requireOAuthManager(tx, input.serverId, input.requestingUserId, input.lock ?? false);
  const registrationQuery = tx
    .select()
    .from(externalAppRegistrations)
    .where(and(
      eq(externalAppRegistrations.id, input.registrationId),
      eq(externalAppRegistrations.state, "active"),
    ))
    .limit(1);
  const [registration] = input.lock
    ? await registrationQuery.for("update")
    : await registrationQuery;
  if (!registration) {
    throw new ExternalAppControlPlaneError(
      "External app authority is unavailable",
      "external_app_not_authorized",
    );
  }

  const grantQuery = tx
    .select()
    .from(externalAppServerGrants)
    .where(and(
      eq(externalAppServerGrants.id, input.serverGrantId),
      eq(externalAppServerGrants.serverId, input.serverId),
      eq(externalAppServerGrants.registrationId, registration.id),
      eq(externalAppServerGrants.state, "active"),
      eq(externalAppServerGrants.grantEpoch, input.grantEpoch),
    ))
    .limit(1);
  const [grant] = input.lock ? await grantQuery.for("update") : await grantQuery;
  if (
    !grant
    || grant.grantedManifestVersion !== registration.capabilityManifestVersion
    || grant.grantedManifestHash !== registration.capabilityManifestHash
    || !sameStrings(grant.grantedCapabilities, registration.requiredCapabilities)
  ) {
    throw new ExternalAppControlPlaneError(
      "External app grant is stale or revoked",
      "external_app_not_authorized",
    );
  }

  const presenceQuery = tx
    .select({ id: oauthClientInstalls.id })
    .from(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.serverId, input.serverId),
      eq(oauthClientInstalls.clientId, registration.oauthClientId),
    ))
    .limit(1);
  const [presence] = input.lock
    ? await presenceQuery.for("update")
    : await presenceQuery;
  if (!presence) {
    throw new ExternalAppControlPlaneError(
      "External app installation is not present",
      "external_app_not_authorized",
    );
  }

  return { registration, grant };
}

export async function beginExternalOAuthAttempt(input: {
  serverId: string;
  registrationId: string;
  serverGrantId: string;
  grantEpoch: number;
  requestingUserId: string;
  redirectUri: string;
  requestedScopes: string[];
  grantIntent: string;
}): Promise<{
  attemptId: string;
  state: string;
  expiresAt: Date;
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
  /** Current workspace hint only; completion rechecks the provider response. */
  providerTeamId: string | null;
}> {
  const state = randomBytes(32).toString("base64url");
  const stateHash = sha256(state);
  const now = currentDate();
  const expiresAt = new Date(now.getTime() + EXTERNAL_OAUTH_ATTEMPT_TTL_MS);

  const attempt = await getDb().transaction(async (tx) => {
    const { registration } = await loadCurrentGrant(tx as DbLike, {
      ...input,
      lock: true,
    });
    const requestedScopes = canonicalStrings(input.requestedScopes);
    if (!input.redirectUri || !requestedScopes.length || !input.grantIntent) {
      throw new ExternalAppControlPlaneError(
        "External OAuth request is incomplete",
        "external_app_invalid_state",
      );
    }

    const workspaces = await tx.select({ teamId: externalAppInstalls.providerTeamId })
      .from(externalAppInstallServerGrants)
      .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalAppInstallServerGrants.installId))
      .where(and(
        eq(externalAppInstallServerGrants.serverId, input.serverId),
        eq(externalAppInstallServerGrants.registrationId, registration.id),
        eq(externalAppInstallServerGrants.state, "active"),
      )).limit(2);
    if (workspaces.length > 1) throw new ExternalAppControlPlaneError(
      "Slack Bridge server has multiple current workspace authorities", "external_app_install_conflict");

    const [created] = await tx
      .insert(externalOAuthAttempts)
      .values({
        serverId: input.serverId,
        registrationId: registration.id,
        serverGrantId: input.serverGrantId,
        grantEpoch: input.grantEpoch,
        requestingUserId: input.requestingUserId,
        stateHash,
        environment: registration.environment,
        redirectUri: input.redirectUri,
        requestedScopes,
        manifestVersion: registration.capabilityManifestVersion,
        manifestHash: registration.capabilityManifestHash,
        grantIntentHash: sha256(input.grantIntent),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: externalOAuthAttempts.id });
    if (!created) {
      throw new ExternalAppControlPlaneError(
        "External OAuth attempt could not be persisted",
        "external_app_persist_failed",
      );
    }
    return {
      attemptId: created.id,
      environment: registration.environment,
      providerAppId: registration.providerAppId,
      providerOAuthClientId: registration.providerOAuthClientId,
      providerTeamId: workspaces[0]?.teamId ?? null,
    };
  });

  return { ...attempt, state, expiresAt };
}

export async function claimExternalOAuthAttempt(input: {
  state: string;
  expectedEnvironment: "test" | "production";
  expectedRedirectUri: string;
}): Promise<{
  attemptId: string;
  serverId: string;
  registrationId: string;
  requestingUserId: string;
  requestedScopes: string[];
  environment: "test" | "production";
  providerAppId: string;
  providerOAuthClientId: string;
}> {
  const stateHash = sha256(input.state);
  const now = currentDate();

  return getDb().transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(externalOAuthAttempts)
      .where(and(
        eq(externalOAuthAttempts.stateHash, stateHash),
        eq(externalOAuthAttempts.status, "pending"),
        gt(externalOAuthAttempts.expiresAt, now),
      ))
      .limit(1)
      .for("update");
    if (
      !attempt
      || attempt.environment !== input.expectedEnvironment
      || attempt.redirectUri !== input.expectedRedirectUri
    ) {
      throw new ExternalAppControlPlaneError(
        "External OAuth state is invalid",
        "external_app_invalid_state",
      );
    }

    const { registration } = await loadCurrentGrant(tx as DbLike, {
      serverId: attempt.serverId,
      registrationId: attempt.registrationId,
      serverGrantId: attempt.serverGrantId,
      grantEpoch: attempt.grantEpoch,
      requestingUserId: attempt.requestingUserId,
      lock: true,
    });
    if (
      attempt.manifestVersion !== registration.capabilityManifestVersion
      || attempt.manifestHash !== registration.capabilityManifestHash
      || attempt.environment !== registration.environment
    ) {
      throw new ExternalAppControlPlaneError(
        "External OAuth authority changed",
        "external_app_not_authorized",
      );
    }

    const [claimed] = await tx
      .update(externalOAuthAttempts)
      .set({
        status: "exchanging",
        exchangeStartedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(externalOAuthAttempts.id, attempt.id),
        eq(externalOAuthAttempts.status, "pending"),
      ))
      .returning({ id: externalOAuthAttempts.id });
    if (!claimed) {
      throw new ExternalAppControlPlaneError(
        "External OAuth state is invalid",
        "external_app_invalid_state",
      );
    }

    return {
      attemptId: attempt.id,
      serverId: attempt.serverId,
      registrationId: attempt.registrationId,
      requestingUserId: attempt.requestingUserId,
      requestedScopes: [...attempt.requestedScopes],
      environment: registration.environment,
      providerAppId: registration.providerAppId,
      providerOAuthClientId: registration.providerOAuthClientId,
    };
  });
}

export interface SealedExternalCredential {
  encryptedMaterial: string;
  envelopeKeyId: string;
  aadVersion: number;
  expiresAt?: Date | null;
}



export async function completeExternalOAuthAttempt(input: {
  attemptId: string;
  providerAppId: string;
  providerTeamId: string;
  providerEnterpriseId?: string | null;
  providerUserId: string;
  workspaceAdminVerified?: boolean;
  botUserId: string;
  providerBotId?: string | null;
  workspaceName?: string | null;
  installedScopes: string[];
  sealedCredential: SealedExternalCredential;
}): Promise<{
  installId: string;
  connectionEpoch: number;
  credentialRevision: number;
}> {
  const now = currentDate();
  const providerTeamId = input.providerTeamId.trim();
  const providerUserId = input.providerUserId.trim();
  const botUserId = input.botUserId.trim();
  return retryExternalAppInstallLockSet(() => getDb().transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(externalOAuthAttempts)
      .where(and(
        eq(externalOAuthAttempts.id, input.attemptId),
        eq(externalOAuthAttempts.status, "exchanging"),
        isNull(externalOAuthAttempts.consumedAt),
      ))
      .limit(1)
      .for("update");
    if (!attempt) {
      throw new ExternalAppControlPlaneError(
        "External OAuth attempt is not exchangeable",
        "external_app_invalid_state",
      );
    }

    const [server] = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(and(
        eq(servers.id, attempt.serverId),
        ne(servers.kind, "joint_storage"),
        isNull(servers.deletedAt),
      ))
      .limit(1)
      // Block deletion/tombstoning, but allow other control-plane FK inserts.
      .for("share");
    if (!server) {
      throw new ExternalAppControlPlaneError(
        "External app server is unavailable",
        "external_app_not_authorized",
      );
    }

    await requireOAuthManager(tx as DbLike, attempt.serverId, attempt.requestingUserId, true);
    const [candidateInstall] = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, attempt.registrationId),
      eq(externalAppInstalls.authorityType, "team"), eq(externalAppInstalls.providerAuthorityId, providerTeamId),
    )).limit(1);
    const scope = candidateInstall ? await lockSlackInstallConversations(tx, candidateInstall.id) : null;
    const { registration } = await loadCurrentGrant(tx as DbLike, {
      serverId: attempt.serverId,
      registrationId: attempt.registrationId,
      serverGrantId: attempt.serverGrantId,
      grantEpoch: attempt.grantEpoch,
      lock: true,
    });
    if (
      input.providerAppId !== registration.providerAppId
      || !providerTeamId
      || !providerUserId
      || providerUserId.length > 160 || /[\r\n\0]/u.test(providerUserId)
      || !botUserId
      || providerUserId === botUserId
      || (
        input.providerEnterpriseId !== undefined
        && input.providerEnterpriseId !== null
      )
    ) {
      throw new ExternalAppControlPlaneError(
        "External provider identity does not match the registration",
        "external_app_not_authorized",
      );
    }
    const installedScopes = canonicalStrings(input.installedScopes);
    if (!scopesCover(installedScopes, attempt.requestedScopes)) {
      throw new ExternalAppControlPlaneError(
        "External provider scopes do not match the authorized request",
        "external_app_scope_mismatch",
      );
    }
    if (
      !input.sealedCredential.encryptedMaterial
      || !input.sealedCredential.envelopeKeyId
      || input.sealedCredential.aadVersion < 1
    ) {
      throw new ExternalAppControlPlaneError(
        "External credential is not sealed",
        "external_app_invalid_state",
      );
    }

    // An absent install is serialized by the registration lock. If another
    // completion created it while we waited, restart before locking that row.
    const [currentInstall] = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, registration.id), eq(externalAppInstalls.authorityType, "team"),
      eq(externalAppInstalls.providerAuthorityId, providerTeamId),
    )).limit(1);
    if (currentInstall?.id !== scope?.install.id) throw new SlackInstallLockSetChanged();
    const existing = scope?.install;
    // One server selects one workspace per registration. The registration lock
    // above serializes completions, including attempts started before another
    // workspace was connected. Reject a different workspace before changing any
    // install, credential or association; switching requires an explicit disconnect.
    const currentWorkspaceGrants = await tx.select({ installId: externalAppInstallServerGrants.installId })
      .from(externalAppInstallServerGrants).where(and(
        eq(externalAppInstallServerGrants.serverId, attempt.serverId),
        eq(externalAppInstallServerGrants.registrationId, registration.id),
        eq(externalAppInstallServerGrants.state, "active"),
      ));
    if (currentWorkspaceGrants.some((grant) => grant.installId !== existing?.id)) {
      throw new ExternalAppControlPlaneError(
        "You selected another Slack workspace. Reauthorize the connected workspace, or disconnect it before switching.",
        "external_app_workspace_mismatch",
      );
    }
    // A provider token belongs to the workspace rather than a Raft server.
    // Reuse (including reauthorization of a shared install) therefore needs
    // a fresh positive role observation of the human who completed this OAuth.
    const [otherServerGrant] = existing
      ? await tx.select({ id: externalAppInstallServerGrants.id })
        .from(externalAppInstallServerGrants).where(and(
          eq(externalAppInstallServerGrants.installId, existing.id),
          ne(externalAppInstallServerGrants.serverId, attempt.serverId),
          eq(externalAppInstallServerGrants.state, "active"),
        )).limit(1)
      : [];
    if (existing && (existing.serverId !== attempt.serverId || otherServerGrant)
      && input.workspaceAdminVerified !== true) {
      throw new ExternalAppControlPlaneError(
        "A Slack workspace administrator must authorize a shared installation",
        "external_app_not_authorized",
      );
    }
    const [existingCredential] = existing
      ? await tx.select().from(externalAppCredentials).where(and(
          eq(externalAppCredentials.installId, existing.id),
          eq(externalAppCredentials.credentialRevision, existing.credentialRevision),
        )).for("update").limit(1)
      : [];
    const existingCredentialUsable = Boolean(
      existing
      && existing.state === "active"
      && existingCredential?.state === "active"
      && (existingCredential.expiresAt === null || existingCredential.expiresAt > now),
    );
    const sharedInstallIdentityMatches = Boolean(
      existing
      && existing.providerAppId === input.providerAppId
      && existing.providerTeamId === providerTeamId
      && existing.providerAuthorityId === providerTeamId
      && existing.botUserId === botUserId
      && (existing.providerBotId === null || existing.providerBotId === (input.providerBotId ?? null))
      // The shared install must itself satisfy the contract — not the new
      // token (already checked upstream). If the existing install predates
      // a required scope, this server must re-authorize, not silently share.
      && scopesCover(existing.installedScopes, attempt.requestedScopes),
    );
    if (
      existing
      && existing.serverId !== attempt.serverId
      && existingCredentialUsable
      && !sharedInstallIdentityMatches
    ) {
      throw new ExternalAppControlPlaneError(
        "External workspace identity conflicts with the shared installation",
        "external_app_install_conflict",
      );
    }
    const sharedGrantOnly = Boolean(
      existing
      && existing.serverId !== attempt.serverId
      && existingCredentialUsable
      && sharedInstallIdentityMatches,
    );
    const connectionEpoch = existing
      ? sharedGrantOnly ? existing.connectionEpoch : existing.connectionEpoch + 1
      : 1;
    const credentialRevision = existing
      ? sharedGrantOnly ? existing.credentialRevision : existing.credentialRevision + 1
      : 1;
    const slackMentionCapability = {
      authorizationId: newSlackMentionAuthorizationId(), result: "unverified" as const, connectionEpoch, credentialRevision,
    };
    const [install] = sharedGrantOnly
      ? await tx.update(externalAppInstalls).set({ slackMentionCapability })
        .where(eq(externalAppInstalls.id, existing!.id)).returning()
      : existing
      ? await tx
        .update(externalAppInstalls)
        .set({
          // The install row's server coordinates are the credential-AAD
          // steward, not the complete authorization set. The exact set lives
          // in external_app_install_server_grants below. A fresh OAuth
          // exchange reseals the one shared token for the authorizing server.
          serverId: attempt.serverId,
          serverGrantId: attempt.serverGrantId,
          grantEpoch: attempt.grantEpoch,
          state: "active",
          stateReason: null,
          connectionEpoch,
          scopeRevision: existing.scopeRevision + 1,
          credentialRevision,
          slackMentionCapability,
          installedScopes,
          providerAppId: input.providerAppId,
          providerTeamId,
          providerEnterpriseId: null,
          providerAuthorityId: providerTeamId,
          botUserId,
          providerBotId: input.providerBotId ?? null,
          workspaceName: input.workspaceName ?? null,
          lastVerifiedAt: now,
          disconnectedAt: null,
          updatedAt: now,
        })
        .where(eq(externalAppInstalls.id, existing.id))
        .returning()
      : await tx
        .insert(externalAppInstalls)
        .values({
          serverId: attempt.serverId,
          registrationId: registration.id,
          serverGrantId: attempt.serverGrantId,
          grantEpoch: attempt.grantEpoch,
          state: "active",
          connectionEpoch,
          scopeRevision: 1,
          credentialRevision,
          slackMentionCapability,
          installedScopes,
          providerAppId: input.providerAppId,
          providerTeamId,
          providerEnterpriseId: null,
          authorityType: "team",
          providerAuthorityId: providerTeamId,
          botUserId,
          providerBotId: input.providerBotId ?? null,
          workspaceName: input.workspaceName ?? null,
          lastVerifiedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    if (!install) {
      throw new ExternalAppControlPlaneError(
        "External app install could not be persisted",
        "external_app_persist_failed",
      );
    }

    if (existing && !sharedGrantOnly) {
      const currentBindings = scope!.bindings.filter(binding => binding.connectionEpoch === existing.connectionEpoch);
      for (const binding of currentBindings) {
        const [frozen] = await tx.update(externalChannelBindings).set({
          state: "paused",
          stateReason: "provider_reauthorized_review_required",
          connectionEpoch,
          bindingEpoch: binding.bindingEpoch + 1,
          updatedAt: now,
        }).where(and(
          eq(externalChannelBindings.id, binding.id),
          eq(externalChannelBindings.state, binding.state),
          eq(externalChannelBindings.connectionEpoch, binding.connectionEpoch),
          eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
        )).returning({ id: externalChannelBindings.id });
        if (!frozen) {
          throw new ExternalAppControlPlaneError(
            "External workspace bindings changed during reauthorization",
            "external_app_install_conflict",
          );
        }
      }
    }

    await tx
      .insert(externalAppInstallServerGrants)
      .values({
        installId: install.id,
        serverId: attempt.serverId,
        registrationId: registration.id,
        serverGrantId: attempt.serverGrantId,
        grantEpoch: attempt.grantEpoch,
        state: "active",
        authorizedByType: "human",
        authorizedById: attempt.requestingUserId,
        providerAuthorizingUserId: providerUserId,
        revokedAt: null,
        revokeReason: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          externalAppInstallServerGrants.installId,
          externalAppInstallServerGrants.serverId,
        ],
        set: {
          registrationId: registration.id,
          serverGrantId: attempt.serverGrantId,
          grantEpoch: attempt.grantEpoch,
          state: "active",
          authorizedByType: "human",
          authorizedById: attempt.requestingUserId,
          providerAuthorizingUserId: providerUserId,
          revokedAt: null,
          revokeReason: null,
          updatedAt: now,
        },
      });

    if (!sharedGrantOnly) {
      await tx
        .insert(externalAppCredentials)
        .values({
          installId: install.id,
          state: "active",
          encryptedMaterial: input.sealedCredential.encryptedMaterial,
          envelopeKeyId: input.sealedCredential.envelopeKeyId,
          aadVersion: input.sealedCredential.aadVersion,
          credentialRevision,
          expiresAt: input.sealedCredential.expiresAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: externalAppCredentials.installId,
          set: {
            state: "active",
            encryptedMaterial: input.sealedCredential.encryptedMaterial,
            envelopeKeyId: input.sealedCredential.envelopeKeyId,
            aadVersion: input.sealedCredential.aadVersion,
            credentialRevision,
            expiresAt: input.sealedCredential.expiresAt ?? null,
            leaseOwner: null,
            leaseExpiresAt: null,
            revokedAt: null,
            updatedAt: now,
          },
        });
    }

    const [consumed] = await tx
      .update(externalOAuthAttempts)
      .set({ status: "consumed", consumedAt: now, updatedAt: now })
      .where(and(
        eq(externalOAuthAttempts.id, attempt.id),
        eq(externalOAuthAttempts.status, "exchanging"),
      ))
      .returning({ id: externalOAuthAttempts.id });
    if (!consumed) {
      throw new ExternalAppControlPlaneError(
        "External OAuth completion lost its state fence",
        "external_app_persist_failed",
      );
    }

    return {
      installId: install.id,
      connectionEpoch,
      credentialRevision,
    };
  }));
}

// Per-member OAuth identity links are removed: private channels resolve audience
// members from external actor projections like public channels do, and outbound
// Slack mentions use the projections' Slack user IDs. Kept for existing rows
// until the schema migration drops the table.


export async function markExternalOAuthExchangeUnknown(
  attemptId: string,
): Promise<boolean> {
  const now = currentDate();
  const [updated] = await getDb()
    .update(externalOAuthAttempts)
    .set({ status: "exchange_unknown", updatedAt: now })
    .where(and(
      eq(externalOAuthAttempts.id, attemptId),
      eq(externalOAuthAttempts.status, "exchanging"),
      isNull(externalOAuthAttempts.consumedAt),
    ))
    .returning({ id: externalOAuthAttempts.id });
  return Boolean(updated);
}

export type ExternalBindingAuthorityReason =
  | "binding_missing"
  | "binding_inactive"
  | "registration_inactive"
  | "grant_inactive"
  | "install_presence_missing"
  | "install_inactive"
  | "credential_unavailable"
  | "credential_stale"
  | "privacy_stale"
  | "epoch_mismatch"
  | "channel_unavailable"
  /** The Raft channel is still a live top-level ordinary channel, but its
   *  visibility no longer matches the binding's privacy class. Distinct from
   *  `channel_unavailable` so the outbound path can pause the binding with a
   *  reason instead of blocking every send silently. */
  | "raft_privacy_mismatch"
  | "install_grant_unavailable"
  | "secret_reference_unavailable"
  | "install_grant_stale"
  | "install_grant_mismatch"
  | "audience_unavailable"
  | "audience_stale"
  | "audience_mismatch";

export type ExternalBindingAuthorityDecision =
  | {
    active: false;
    reason: ExternalBindingAuthorityReason;
  }
  | {
    active: true;
    fact: {
      provider: "slack";
      environment: "test" | "production";
      registrationId: string;
      serverId: string;
      serverGrantId: string;
      grantEpoch: number;
      installId: string;
      providerAppId: string;
      connectionEpoch: number;
      scopeRevision: number;
      credentialRevision: number;
      bindingId: string;
      bindingEpoch: number;
      privacyClass: "public" | "private";
      channelId: string;
      providerAuthorityId: string;
      providerConversationId: string;
      installGrantReceiptRevision: number;
      audienceRevision: number | null;
    };
  };

export async function resolveExternalBindingAuthority(input: {
  serverId: string;
  bindingId: string;
  expectedConnectionEpoch: number;
  expectedBindingEpoch: number;
  now?: Date;
  allowArchivedForQueuedDelivery?: boolean;
}, db?: DbLike): Promise<ExternalBindingAuthorityDecision> {
  const now = input.now ?? currentDate();
  const resolve = async (tx: DbLike): Promise<ExternalBindingAuthorityDecision> => {
    const [binding] = await tx
      .select()
      .from(externalChannelBindings)
      .where(and(
        eq(externalChannelBindings.id, input.bindingId),
        eq(externalChannelBindings.serverId, input.serverId),
      ))
      .limit(1);
    if (!binding) return { active: false, reason: "binding_missing" };
    if (binding.state !== "active") return { active: false, reason: "binding_inactive" };
    // privacyFreshUntil is directory-cache metadata: visibility no longer
    // decides whether sync is allowed, so a stale privacy cache degrades
    // to the recorded class instead of stopping messages (task #241).

    const [registration] = await tx
      .select()
      .from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, binding.registrationId))
      .limit(1);
    if (!registration || registration.state !== "active") {
      return { active: false, reason: "registration_inactive" };
    }

    const [install] = await tx
      .select()
      .from(externalAppInstalls)
      .where(eq(externalAppInstalls.id, binding.installId))
      .limit(1);
    if (!install || install.state !== "active") {
      return { active: false, reason: "install_inactive" };
    }
    const serverAuthority = await resolveExternalInstallServerGrantAuthority(tx, {
      installId: install.id,
      serverId: input.serverId,
      registrationId: registration.id,
    });
    if (!serverAuthority.current) {
      return {
        active: false,
        reason: serverAuthority.reason === "epoch_mismatch" ? "epoch_mismatch" : "grant_inactive",
      };
    }
    const { association: installServerGrant, grant: currentGrant } = serverAuthority;
    if (
      install.registrationId !== registration.id
      || install.providerAppId !== registration.providerAppId
      || currentGrant.grantedManifestVersion !== registration.capabilityManifestVersion
      || currentGrant.grantedManifestHash !== registration.capabilityManifestHash
      || !sameStrings(
        currentGrant.grantedCapabilities,
        registration.requiredCapabilities,
      )
    ) {
      return { active: false, reason: "grant_inactive" };
    }

    const [presence] = await tx
      .select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, input.serverId),
        eq(oauthClientInstalls.clientId, registration.oauthClientId),
      ))
      .limit(1);
    if (!presence) return { active: false, reason: "install_presence_missing" };

    if (
      binding.grantEpoch !== currentGrant.grantEpoch
      || installServerGrant.grantEpoch !== currentGrant.grantEpoch
      || binding.connectionEpoch !== install.connectionEpoch
      || install.connectionEpoch !== input.expectedConnectionEpoch
      || binding.bindingEpoch !== input.expectedBindingEpoch
    ) {
      return { active: false, reason: "epoch_mismatch" };
    }

    const [credential] = await tx
      .select({
        state: externalAppCredentials.state,
        credentialRevision: externalAppCredentials.credentialRevision,
        expiresAt: externalAppCredentials.expiresAt,
      })
      .from(externalAppCredentials)
      .where(eq(externalAppCredentials.installId, install.id))
      .limit(1);
    if (!credential || credential.state !== "active") {
      return { active: false, reason: "credential_unavailable" };
    }
    if (
      credential.credentialRevision !== install.credentialRevision
      || credential.expiresAt && credential.expiresAt <= now
    ) {
      return { active: false, reason: "credential_stale" };
    }

    const [channel] = await tx
      .select({
        serverId: channels.serverId,
        type: channels.type,
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
      })
      .from(channels)
      .where(eq(channels.id, binding.channelId))
      .limit(1);
    const conversationTarget = channel
      ? await resolveExternalConversationTarget({
        executor: tx,
        authorityChannelId: binding.channelId,
        allowArchivedForQueuedDelivery: input.allowArchivedForQueuedDelivery,
      })
      : null;
    if (
      !channel
      || channel.serverId !== input.serverId
      || channel.deletedAt
      || (channel.archivedAt && !input.allowArchivedForQueuedDelivery)
      || !conversationTarget
      || conversationTarget.serverId !== input.serverId
      || conversationTarget.bindingChannelId !== binding.channelId
      || conversationTarget.level !== "top_level"
    ) {
      return { active: false, reason: "channel_unavailable" };
    }
    // Visibility is per-platform: a binding pair stays live when either
    // side's channel flips public/private — only inaccessibility, unbind or
    // revoke stops sync (yezizp, task #241). Shape still has to be a real
    // binding channel: ordinary (either type) or a Joint host.
    if (
      !(conversationTarget.kind === "ordinary"
        && (channel.type === "channel" || channel.type === "private"))
      && !(conversationTarget.kind === "joint" && conversationTarget.role === "host")
    ) {
      return { active: false, reason: "channel_unavailable" };
    }

    const [installGrant] = await tx
      .select()
      .from(externalAppInstallGrantReceipts)
      .where(and(
        eq(externalAppInstallGrantReceipts.registrationId, registration.id),
        eq(externalAppInstallGrantReceipts.installId, install.id),
      ))
      .orderBy(desc(externalAppInstallGrantReceipts.receiptRevision))
      .limit(1);
    if (!installGrant) return { active: false, reason: "install_grant_unavailable" };
    const secretRefs = await tx
      .select({
        purpose: externalAppRegistrationSecrets.purpose,
        secretRevision: externalAppRegistrationSecrets.secretRevision,
        revokedAt: externalAppRegistrationSecrets.revokedAt,
      })
      .from(externalAppRegistrationSecrets)
      .where(eq(externalAppRegistrationSecrets.registrationId, registration.id));
    const signingSecret = secretRefs.find((secret) =>
      secret.purpose === "signing_secret" && secret.revokedAt === null
    );
    if (
      !signingSecret
    ) {
      return { active: false, reason: "secret_reference_unavailable" };
    }
    if (installGrant.status !== "valid") {
      return { active: false, reason: "install_grant_mismatch" };
    }
    if (installGrant.expiresAt <= now) {
      return { active: false, reason: "install_grant_stale" };
    }
    if (
      installGrant.providerAppId !== registration.providerAppId
      || installGrant.installId !== install.id
      || installGrant.connectionEpoch !== install.connectionEpoch
      || installGrant.scopeRevision !== install.scopeRevision
      || installGrant.credentialRevision !== install.credentialRevision
      || installGrant.providerAuthorityId !== install.providerAuthorityId
      || installGrant.botUserId !== install.botUserId
      || (install.providerBotId !== null && installGrant.providerBotId !== install.providerBotId)
      || !sameStrings(install.installedScopes, installGrant.grantedScopes)
      || installGrant.grantHash !== slackBridgeInstallGrantHash(installGrant)
    ) {
      return { active: false, reason: "install_grant_mismatch" };
    }

    // Private channels reuse the public authority path: a per-member OAuth
    // link and a bounded freshness window are no longer prerequisites. A live
    // install + active binding is sufficient to bridge. audienceRevision is
    // carried verbatim for legacy v1 runtime-revision replay only — it is not
    // an authority coordinate in v2.
    const audienceRevision: number | null = binding.audienceRevision;

    return {
      active: true,
      fact: {
        provider: registration.provider,
        environment: registration.environment,
        registrationId: registration.id,
        serverId: input.serverId,
        serverGrantId: currentGrant.id,
        grantEpoch: currentGrant.grantEpoch,
        installId: install.id,
        providerAppId: install.providerAppId,
        connectionEpoch: install.connectionEpoch,
        scopeRevision: install.scopeRevision,
        credentialRevision: install.credentialRevision,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        privacyClass: binding.privacyClass,
        channelId: binding.channelId,
        providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId,
        installGrantReceiptRevision: installGrant.receiptRevision,
        audienceRevision,
      },
    };
  };
  if (db) return resolve(db);
  return getDb().transaction(async (tx) => resolve(tx as DbLike), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function getExternalAppRegistrationMetadata(
  registrationId: string,
): Promise<{
  id: string;
  provider: "slack";
  environment: "test" | "production";
  state: "active" | "disabled";
  capabilityManifestVersion: number;
  capabilityManifestHash: string;
  latestInstallGrantReceipt: null | {
    revision: number;
    status: "valid" | "mismatch" | "unreadable";
    observedAt: Date;
    expiresAt: Date;
  };
} | null> {
  return getDb().transaction(async (tx) => {
    const [registration] = await tx
      .select({
        id: externalAppRegistrations.id,
        provider: externalAppRegistrations.provider,
        environment: externalAppRegistrations.environment,
        state: externalAppRegistrations.state,
        capabilityManifestVersion: externalAppRegistrations.capabilityManifestVersion,
        capabilityManifestHash: externalAppRegistrations.capabilityManifestHash,
      })
      .from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, registrationId))
      .limit(1);
    if (!registration) return null;

    const [receipt] = await tx
      .select({
        revision: externalAppInstallGrantReceipts.receiptRevision,
        status: externalAppInstallGrantReceipts.status,
        observedAt: externalAppInstallGrantReceipts.observedAt,
        expiresAt: externalAppInstallGrantReceipts.expiresAt,
      })
      .from(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.registrationId, registration.id))
      .orderBy(desc(externalAppInstallGrantReceipts.createdAt))
      .limit(1);
    return {
      ...registration,
      latestInstallGrantReceipt: receipt ?? null,
    };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
