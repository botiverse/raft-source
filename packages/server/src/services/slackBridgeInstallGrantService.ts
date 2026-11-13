import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";

import { getDb, type Database } from "../db/index";
import {
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppRegistrations,
} from "../db/schema";
import { SLACK_BRIDGE_CORE_BOT_SCOPES } from "./slackBridgeProductionAppContract";
import type {
  SlackBridgeProvisioningInstallGrant,
  SlackBridgeProvisioningProvider,
} from "./slackBridgeProvisioningControlPlane";
import { findAnyCurrentExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";

// A receipt bounds revocation exposure to 30 minutes. The production lifecycle
// runs every five minutes and starts renewal ten minutes before expiry, leaving
// two scheduled attempts before a healthy receipt fails closed. There is no
// immediate retry: provider failure waits for the next bounded lifecycle tick.
export const SLACK_BRIDGE_INSTALL_GRANT_FRESHNESS_MS = 30 * 60_000;
export const SLACK_BRIDGE_INSTALL_GRANT_RENEWAL_LEAD_MS = 10 * 60_000;
const INSTALL_GRANT_RENEWAL_LEASE_MS = 60_000;
const INSTALL_GRANT_RENEWAL_JITTER_MS = 60_000;
const INSTALL_GRANT_RETRY_BASE_MS = 5 * 60_000;

type Install = typeof externalAppInstalls.$inferSelect;

export function canonicalSlackInstallGrantScopes(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function exactScopes(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalSlackInstallGrantScopes(left);
  const b = canonicalSlackInstallGrantScopes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A granted scope set supports the runtime when the core contract is covered.
 * Extra scopes (e.g. usergroups:* observed after a Slack-side app change, or
 * any future Slack-granted scope) are tolerated — matching the #9179/#9185
 * contract that a broader grant is not a mismatch.
 */
export function slackBridgeGrantScopesSupportRuntime(values: readonly string[]): boolean {
  const scopes = canonicalSlackInstallGrantScopes(values);
  return SLACK_BRIDGE_CORE_BOT_SCOPES.every((scope) => scopes.includes(scope));
}



export function slackBridgeInstallGrantHash(input: {
  providerAppId: string;
  providerAuthorityId: string;
  botUserId: string;
  providerBotId: string;
  grantedScopes: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    provider: "slack",
    providerAppId: input.providerAppId,
    providerAuthorityId: input.providerAuthorityId,
    botUserId: input.botUserId,
    providerBotId: input.providerBotId,
    grantedScopes: canonicalSlackInstallGrantScopes(input.grantedScopes),
  }), "utf8").digest("hex");
}

export function slackBridgeInstallGrantMatchesInstall(
  install: Install,
  grant: SlackBridgeProvisioningInstallGrant,
): boolean {
  return grant.providerAppId === install.providerAppId
    && grant.providerAuthorityId === install.providerAuthorityId
    && grant.botUserId === install.botUserId
    && grant.providerBotId.trim().length > 0
    && (install.providerBotId === null || grant.providerBotId === install.providerBotId)
    // grant.grantedScopes and install.installedScopes are both the actual
    // token scopes (x-oauth-scopes from auth.test); extras like usergroups:*
    // appear in both. The contract check is: exact set match against the
    // recorded install plus core ⊆ granted ⊆ allowed — a granted-but-different
    // set is classified as scope_drift by the caller, not a match.
    && exactScopes(grant.grantedScopes, install.installedScopes)
    && slackBridgeGrantScopesSupportRuntime(grant.grantedScopes);
}

export type SlackInstallGrantClassification = "match" | "scope_drift" | "mismatch";

/**
 * Classifies a live auth.test install-grant fact against the stored install.
 *
 * "scope_drift": identity fields all match and the granted set still covers
 * the required contract, but the granted scope set differs from the recorded
 * install.installedScopes. This happens when Slack-side app scopes change
 * without a Raft re-OAuth (e.g. usergroups:* added to the app on 2026-09-25
 * rotated the token's scope set, but the install row still recorded the
 * install-time 11 scopes). The install record is stale, not the grant — the
 * caller should update installed_scopes + bump scope_revision in the same
 * transaction as the new receipt so every server sharing the install converges.
 *
 * "mismatch": any identity field differs, or the granted set no longer
 * covers the required bot scopes. A real authority conflict — do not write.
 */
export function classifySlackInstallGrantObservation(
  install: Install,
  grant: SlackBridgeProvisioningInstallGrant,
): SlackInstallGrantClassification {
  if (slackBridgeInstallGrantMatchesInstall(install, grant)) return "match";
  const identityMatches = grant.providerAppId === install.providerAppId
    && grant.providerAuthorityId === install.providerAuthorityId
    && grant.botUserId === install.botUserId
    && grant.providerBotId.trim().length > 0
    && (install.providerBotId === null || grant.providerBotId === install.providerBotId)
    && slackBridgeGrantScopesSupportRuntime(grant.grantedScopes);
  return identityMatches ? "scope_drift" : "mismatch";
}

interface InstallGrantScopeDriftLogger {
  (event: {
    source: "renewal" | "enable";
    installId: string;
    previousScopes: readonly string[];
    observedScopes: readonly string[];
  }): void;
}

const defaultScopeDriftLogger: InstallGrantScopeDriftLogger = (event) => {
  console.warn("[Slock] Slack Bridge install scope drift reconciled", JSON.stringify({
    source: event.source,
    installId: event.installId,
    previousScopes: event.previousScopes,
    observedScopes: event.observedScopes,
  }));
};

/**
 * Applies a scope_drift reconciliation against the locked install row: the
 * recorded installed_scopes and scopeRevision are brought in line with the
 * observed token fact. Callers must hold the install row lock inside the
 * same transaction that writes the resulting receipt — bumping
 * scope_revision invalidates every existing receipt on this shared install,
 * and each server's next renewal writes a fresh one. Returns null when the
 * install row changed under the lock (a concurrent OAuth or drift repair);
 * the caller should then fall back to its authority-changed path instead of
 * writing a receipt against stale epochs.
 */
export async function applySlackInstallGrantScopeDrift(input: {
  tx: Pick<Database, "update">;
  install: Install;
  grant: SlackBridgeProvisioningInstallGrant;
  now: Date;
  source: "renewal" | "enable";
  log?: InstallGrantScopeDriftLogger;
}): Promise<number | null> {
  const nextScopeRevision = input.install.scopeRevision + 1;
  const installedScopes = canonicalSlackInstallGrantScopes(input.grant.grantedScopes);
  const updated = await input.tx.update(externalAppInstalls).set({
    installedScopes,
    scopeRevision: nextScopeRevision,
    providerBotId: input.grant.providerBotId,
    lastVerifiedAt: input.now,
    updatedAt: input.now,
  }).where(and(
    eq(externalAppInstalls.id, input.install.id),
    eq(externalAppInstalls.state, "active"),
    eq(externalAppInstalls.connectionEpoch, input.install.connectionEpoch),
    eq(externalAppInstalls.scopeRevision, input.install.scopeRevision),
    eq(externalAppInstalls.credentialRevision, input.install.credentialRevision),
  )).returning({ id: externalAppInstalls.id });
  if (updated.length !== 1) return null;
  (input.log ?? defaultScopeDriftLogger)({
    source: input.source,
    installId: input.install.id,
    previousScopes: input.install.installedScopes,
    observedScopes: installedScopes,
  });
  return nextScopeRevision;
}

function deterministicJitterMs(installId: string): number {
  const prefix = createHash("sha256").update(installId, "utf8").digest().readUInt32BE(0);
  return prefix % INSTALL_GRANT_RENEWAL_JITTER_MS;
}

function currentReceipt(input: {
  receipt: typeof externalAppInstallGrantReceipts.$inferSelect | null;
  install: Install;
  now: Date;
}): boolean {
  const { receipt, install, now } = input;
  return Boolean(
    receipt
    && receipt.status === "valid"
    && receipt.expiresAt > now
    && receipt.registrationId === install.registrationId
    && receipt.installId === install.id
    && receipt.connectionEpoch === install.connectionEpoch
    && receipt.scopeRevision === install.scopeRevision
    && receipt.credentialRevision === install.credentialRevision
    && receipt.providerAppId === install.providerAppId
    && receipt.providerAuthorityId === install.providerAuthorityId
    && receipt.botUserId === install.botUserId
    && (install.providerBotId === null || receipt.providerBotId === install.providerBotId)
    && exactScopes(receipt.grantedScopes, install.installedScopes)
    && receipt.grantHash === slackBridgeInstallGrantHash(receipt)
  );
}

export interface SlackBridgeInstallGrantRefreshResult {
  considered: number;
  renewed: number;
  skipped: number;
  failed: number;
}

/**
 * Periodically renews provider-authoritative install-grant snapshots. A
 * renewal is always a fresh, single auth.test response: identity comes from
 * its body and the current grant comes from that same response's
 * x-oauth-scopes header. Lifecycle signals never extend a receipt.
 */
export async function refreshSlackBridgeInstallGrantReceipts(input: {
  db?: Database;
  provider: SlackBridgeProvisioningProvider;
  now: Date;
  onError?(error: unknown): void;
  isRunHeld?(): Promise<boolean>;
  onScopeDrift?(event: {
    source: "renewal" | "enable";
    installId: string;
    previousScopes: readonly string[];
    observedScopes: readonly string[];
  }): void;
}): Promise<SlackBridgeInstallGrantRefreshResult> {
  const db = input.db ?? getDb();
  const result: SlackBridgeInstallGrantRefreshResult = {
    considered: 0,
    renewed: 0,
    skipped: 0,
    failed: 0,
  };
  const candidates = await db.select({
    registration: externalAppRegistrations,
    install: externalAppInstalls,
    credential: externalAppCredentials,
  }).from(externalAppInstalls)
    .innerJoin(externalAppRegistrations, and(
      eq(externalAppRegistrations.id, externalAppInstalls.registrationId),
      eq(externalAppRegistrations.provider, "slack"),
      eq(externalAppRegistrations.state, "active"),
    ))
    .innerJoin(externalAppCredentials, and(
      eq(externalAppCredentials.installId, externalAppInstalls.id),
      eq(externalAppCredentials.state, "active"),
      eq(externalAppCredentials.credentialRevision, externalAppInstalls.credentialRevision),
      or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, input.now)),
    ))
    .where(eq(externalAppInstalls.state, "active"));

  for (const candidate of candidates) {
    if (input.isRunHeld && !await input.isRunHeld()) break;
    result.considered += 1;
    const renewBefore = new Date(
      input.now.getTime()
      + SLACK_BRIDGE_INSTALL_GRANT_RENEWAL_LEAD_MS
      + deterministicJitterMs(candidate.install.id),
    );
    const [latest] = await db.select().from(externalAppInstallGrantReceipts).where(and(
      eq(externalAppInstallGrantReceipts.registrationId, candidate.registration.id),
      eq(externalAppInstallGrantReceipts.installId, candidate.install.id),
    )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(1);
    if (
      currentReceipt({ receipt: latest ?? null, install: candidate.install, now: input.now })
      && latest!.expiresAt > renewBefore
    ) {
      result.skipped += 1;
      continue;
    }

    const leaseOwner = `slack-install-grant:${randomUUID()}`;
    const leaseExpiresAt = new Date(input.now.getTime() + INSTALL_GRANT_RENEWAL_LEASE_MS);
    const [claimed] = await db.update(externalAppInstalls).set({
      installGrantRenewalLeaseOwner: leaseOwner,
      installGrantRenewalLeaseExpiresAt: leaseExpiresAt,
      updatedAt: input.now,
    }).where(and(
      eq(externalAppInstalls.id, candidate.install.id),
      eq(externalAppInstalls.state, "active"),
      eq(externalAppInstalls.connectionEpoch, candidate.install.connectionEpoch),
      eq(externalAppInstalls.scopeRevision, candidate.install.scopeRevision),
      eq(externalAppInstalls.credentialRevision, candidate.install.credentialRevision),
      or(
        isNull(externalAppInstalls.installGrantRenewalLeaseExpiresAt),
        lte(externalAppInstalls.installGrantRenewalLeaseExpiresAt, input.now),
      ),
      or(
        isNull(externalAppInstalls.installGrantRenewalNextAttemptAt),
        lte(externalAppInstalls.installGrantRenewalNextAttemptAt, input.now),
      ),
    )).returning({ id: externalAppInstalls.id });
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    try {
      if (!await findAnyCurrentExternalInstallServerGrantAuthority(db, {
        installId: candidate.install.id,
        registrationId: candidate.registration.id,
      })) {
        result.skipped += 1;
        continue;
      }
      if (input.isRunHeld && !await input.isRunHeld()) {
        result.skipped += 1;
        continue;
      }
      const observation = await input.provider.readInstallGrant({
        installId: candidate.install.id,
        providerAppId: candidate.install.providerAppId,
        providerAuthorityId: candidate.install.providerAuthorityId,
        botUserId: candidate.install.botUserId!,
        connectionEpoch: candidate.install.connectionEpoch,
        credentialRevision: candidate.install.credentialRevision,
        now: input.now,
        isRunHeld: input.isRunHeld,
      });
      if (input.isRunHeld && !await input.isRunHeld()) {
        result.skipped += 1;
        continue;
      }
      if (
        observation.kind !== "fact"
        || classifySlackInstallGrantObservation(candidate.install, observation.fact) === "mismatch"
      ) {
        result.failed += 1;
        await db.update(externalAppInstalls).set({
          installGrantRenewalNextAttemptAt: new Date(
            input.now.getTime()
            + INSTALL_GRANT_RETRY_BASE_MS
            + deterministicJitterMs(candidate.install.id),
          ),
          updatedAt: input.now,
        }).where(and(
          eq(externalAppInstalls.id, candidate.install.id),
          eq(externalAppInstalls.installGrantRenewalLeaseOwner, leaseOwner),
        ));
        continue;
      }
      const grantHash = slackBridgeInstallGrantHash(observation.fact);
      const renewed = await db.transaction(async (tx) => {
        const [lockedInstall] = await tx.select().from(externalAppInstalls).where(and(
          eq(externalAppInstalls.id, candidate.install.id),
          eq(externalAppInstalls.state, "active"),
          eq(externalAppInstalls.connectionEpoch, candidate.install.connectionEpoch),
          eq(externalAppInstalls.scopeRevision, candidate.install.scopeRevision),
          eq(externalAppInstalls.credentialRevision, candidate.install.credentialRevision),
          eq(externalAppInstalls.installGrantRenewalLeaseOwner, leaseOwner),
          eq(externalAppInstalls.installGrantRenewalLeaseExpiresAt, leaseExpiresAt),
        )).for("update").limit(1);
        const [registration] = await tx.select().from(externalAppRegistrations).where(and(
          eq(externalAppRegistrations.id, candidate.registration.id),
          eq(externalAppRegistrations.state, "active"),
        )).for("update").limit(1);
        const [credential] = await tx.select().from(externalAppCredentials).where(and(
          eq(externalAppCredentials.id, candidate.credential.id),
          eq(externalAppCredentials.state, "active"),
          eq(externalAppCredentials.credentialRevision, candidate.install.credentialRevision),
          or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, input.now)),
        )).for("update").limit(1);
        const currentServerAuthority = lockedInstall && registration
          ? await findAnyCurrentExternalInstallServerGrantAuthority(tx, {
              installId: lockedInstall.id,
              registrationId: registration.id,
            }, { lock: true })
          : null;
        if (
          !lockedInstall
          || !registration
          || !credential
          || !currentServerAuthority
        ) return false;
        const classification = classifySlackInstallGrantObservation(lockedInstall, observation.fact);
        let install = lockedInstall;
        if (classification === "mismatch") return false;
        if (classification === "scope_drift") {
          const nextScopeRevision = await applySlackInstallGrantScopeDrift({
            tx,
            install: lockedInstall,
            grant: observation.fact,
            now: input.now,
            source: "renewal",
            log: input.onScopeDrift,
          });
          if (nextScopeRevision === null) return false;
          install = { ...lockedInstall, installedScopes: canonicalSlackInstallGrantScopes(observation.fact.grantedScopes), scopeRevision: nextScopeRevision };
        }

        const receipts = await tx.select().from(externalAppInstallGrantReceipts).where(and(
          eq(externalAppInstallGrantReceipts.registrationId, registration.id),
          eq(externalAppInstallGrantReceipts.installId, install.id),
        )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(2).for("update");
        const current = receipts[0] ?? null;
        if (
          currentReceipt({ receipt: current, install, now: input.now })
          && current!.expiresAt > renewBefore
        ) return false;

        await tx.insert(externalAppInstallGrantReceipts).values({
          registrationId: registration.id,
          installId: install.id,
          receiptRevision: (current?.receiptRevision ?? 0) + 1,
          connectionEpoch: install.connectionEpoch,
          scopeRevision: install.scopeRevision,
          credentialRevision: install.credentialRevision,
          providerAppId: observation.fact.providerAppId,
          providerAuthorityId: observation.fact.providerAuthorityId,
          botUserId: observation.fact.botUserId,
          providerBotId: observation.fact.providerBotId,
          grantedScopes: canonicalSlackInstallGrantScopes(observation.fact.grantedScopes),
          grantHash,
          observationSource: "token_introspection",
          status: "valid",
          errorCode: null,
          observedAt: input.now,
          expiresAt: new Date(input.now.getTime() + SLACK_BRIDGE_INSTALL_GRANT_FRESHNESS_MS),
          createdAt: input.now,
        });
        await tx.update(externalAppInstalls).set({
          providerBotId: observation.fact.providerBotId,
          lastVerifiedAt: input.now,
          installGrantRenewalLeaseOwner: null,
          installGrantRenewalLeaseExpiresAt: null,
          installGrantRenewalNextAttemptAt: null,
          updatedAt: input.now,
        }).where(and(
          eq(externalAppInstalls.id, install.id),
          eq(externalAppInstalls.connectionEpoch, install.connectionEpoch),
          eq(externalAppInstalls.scopeRevision, install.scopeRevision),
          eq(externalAppInstalls.credentialRevision, install.credentialRevision),
          eq(externalAppInstalls.installGrantRenewalLeaseOwner, leaseOwner),
        ));
        return true;
      });
      if (renewed) result.renewed += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      input.onError?.(error);
      await db.update(externalAppInstalls).set({
        installGrantRenewalNextAttemptAt: new Date(
          input.now.getTime()
          + INSTALL_GRANT_RETRY_BASE_MS
          + deterministicJitterMs(candidate.install.id),
        ),
        updatedAt: input.now,
      }).where(and(
        eq(externalAppInstalls.id, candidate.install.id),
        eq(externalAppInstalls.installGrantRenewalLeaseOwner, leaseOwner),
      ));
    } finally {
      await db.update(externalAppInstalls).set({
        installGrantRenewalLeaseOwner: null,
        installGrantRenewalLeaseExpiresAt: null,
        updatedAt: input.now,
      }).where(and(
        eq(externalAppInstalls.id, candidate.install.id),
        eq(externalAppInstalls.installGrantRenewalLeaseOwner, leaseOwner),
      ));
    }
  }
  return result;
}
