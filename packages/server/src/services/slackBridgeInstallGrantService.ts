import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";

import { getDb, type Database } from "../db/index.js";
import {
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
} from "../db/schema.js";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge.js";
import type {
  SlackBridgeProvisioningInstallGrant,
  SlackBridgeProvisioningProvider,
} from "./slackBridgeProvisioningControlPlane.js";

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
    && exactScopes(grant.grantedScopes, install.installedScopes)
    && exactScopes(grant.grantedScopes, SLACK_BRIDGE_REQUIRED_BOT_SCOPES);
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
    grant: externalAppServerGrants,
    install: externalAppInstalls,
    credential: externalAppCredentials,
  }).from(externalAppInstalls)
    .innerJoin(externalAppRegistrations, and(
      eq(externalAppRegistrations.id, externalAppInstalls.registrationId),
      eq(externalAppRegistrations.provider, "slack"),
      eq(externalAppRegistrations.state, "active"),
    ))
    .innerJoin(externalAppServerGrants, and(
      eq(externalAppServerGrants.id, externalAppInstalls.serverGrantId),
      eq(externalAppServerGrants.state, "active"),
      eq(externalAppServerGrants.grantEpoch, externalAppInstalls.grantEpoch),
    ))
    .innerJoin(externalAppCredentials, and(
      eq(externalAppCredentials.installId, externalAppInstalls.id),
      eq(externalAppCredentials.state, "active"),
      eq(externalAppCredentials.credentialRevision, externalAppInstalls.credentialRevision),
      or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, input.now)),
    ))
    .where(eq(externalAppInstalls.state, "active"));

  for (const candidate of candidates) {
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
      const observation = await input.provider.readInstallGrant({
        installId: candidate.install.id,
        providerAppId: candidate.install.providerAppId,
        providerAuthorityId: candidate.install.providerAuthorityId,
        botUserId: candidate.install.botUserId!,
        connectionEpoch: candidate.install.connectionEpoch,
        credentialRevision: candidate.install.credentialRevision,
        now: input.now,
      });
      if (
        observation.kind !== "fact"
        || !slackBridgeInstallGrantMatchesInstall(candidate.install, observation.fact)
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
        const [install] = await tx.select().from(externalAppInstalls).where(and(
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
        const [grant] = await tx.select().from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.id, candidate.grant.id),
          eq(externalAppServerGrants.state, "active"),
          eq(externalAppServerGrants.grantEpoch, candidate.install.grantEpoch),
        )).for("update").limit(1);
        const [credential] = await tx.select().from(externalAppCredentials).where(and(
          eq(externalAppCredentials.id, candidate.credential.id),
          eq(externalAppCredentials.state, "active"),
          eq(externalAppCredentials.credentialRevision, candidate.install.credentialRevision),
          or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, input.now)),
        )).for("update").limit(1);
        if (
          !install
          || !registration
          || !grant
          || !credential
          || !slackBridgeInstallGrantMatchesInstall(install, observation.fact)
        ) return false;

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
