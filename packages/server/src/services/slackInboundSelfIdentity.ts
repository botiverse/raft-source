import { and, desc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalAppInstallGrantReceipts, externalAppInstalls, externalAppRegistrations } from "../db/schema";
export type SlackInboundIdentityScope = {
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
  providerAuthorityId: string;
};

/**
 * Read only positive, provider-verified historical self identities. Expiry
 * limits use as a current grant, not proof that the observed bot was ours.
 * Missing history never proves a sender is foreign. The caller must use the
 * exact authenticated event scope and revalidate before committing a decision.
 */
export async function readSlackInboundSelfIdentity(input: {
  db: DatabaseExecutor;
  aad: SlackInboundIdentityScope;
}): Promise<{ providerAppId: string; installations: { botUserId: string; botId: string }[] } | null> {
  const { db, aad } = input;
  const [registration] = await db.select({ id: externalAppRegistrations.id })
    .from(externalAppRegistrations).where(and(
      eq(externalAppRegistrations.id, aad.registrationId),
      eq(externalAppRegistrations.provider, "slack"),
      eq(externalAppRegistrations.environment, aad.environment),
      eq(externalAppRegistrations.providerAppId, aad.providerAppId),
    )).limit(1);
  if (!registration) return null;
  const observations = await db.selectDistinct({
    botUserId: externalAppInstallGrantReceipts.botUserId,
    botId: externalAppInstallGrantReceipts.providerBotId,
  }).from(externalAppInstallGrantReceipts)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalAppInstallGrantReceipts.installId))
    .where(and(
      eq(externalAppInstallGrantReceipts.registrationId, registration.id),
      eq(externalAppInstallGrantReceipts.providerAppId, aad.providerAppId),
      eq(externalAppInstallGrantReceipts.providerAuthorityId, aad.providerAuthorityId),
      eq(externalAppInstallGrantReceipts.observationSource, "token_introspection"),
      eq(externalAppInstallGrantReceipts.status, "valid"),
      eq(externalAppInstalls.registrationId, registration.id),
      eq(externalAppInstalls.providerAppId, aad.providerAppId),
      eq(externalAppInstalls.providerAuthorityId, aad.providerAuthorityId),
    ));
  return { providerAppId: aad.providerAppId, installations: observations };
}

/**
 * Extract a bot ID only from the latest receipt for a currently authorized
 * installation. `authority` must be a fresh successful
 * resolveExternalBindingAuthority result: it also validates the grant hash,
 * server grant and scopes. Re-resolve it in the final decision transaction;
 * this lookup alone is not sufficient authority to discard an event.
 *
 * Historical receipts remain available to the observation path above, but
 * they are not the self-ID set for new inbound message classification.
 */
export async function readSlackInboundCurrentSelfBotId(input: {
  db: DatabaseExecutor;
  authority: SlackInboundIdentityScope & { installId: string; connectionEpoch: number; scopeRevision: number;
    credentialRevision: number; installGrantReceiptRevision: number };
  now: Date;
}): Promise<string | null> {
  const { db, authority, now } = input;
  if (!Number.isFinite(now.getTime())) return null;
  const [row] = await db.select({ receipt: externalAppInstallGrantReceipts, install: externalAppInstalls })
    .from(externalAppInstallGrantReceipts)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalAppInstallGrantReceipts.installId))
    .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalAppInstalls.registrationId))
    .where(and(
      eq(externalAppInstalls.id, authority.installId),
      eq(externalAppRegistrations.id, authority.registrationId),
      eq(externalAppRegistrations.provider, "slack"),
      eq(externalAppRegistrations.environment, authority.environment),
      eq(externalAppRegistrations.providerAppId, authority.providerAppId),
    )).orderBy(desc(externalAppInstallGrantReceipts.receiptRevision)).limit(1);
  if (!row) return null;
  const { receipt, install } = row;
  if (install.state !== "active" || install.providerAppId !== authority.providerAppId
    || install.providerAuthorityId !== authority.providerAuthorityId
    || install.connectionEpoch !== authority.connectionEpoch || install.scopeRevision !== authority.scopeRevision
    || install.credentialRevision !== authority.credentialRevision
    || receipt.registrationId !== authority.registrationId || receipt.providerAppId !== authority.providerAppId
    || receipt.providerAuthorityId !== authority.providerAuthorityId
    || receipt.receiptRevision !== authority.installGrantReceiptRevision
    || receipt.connectionEpoch !== authority.connectionEpoch || receipt.scopeRevision !== authority.scopeRevision
    || receipt.credentialRevision !== authority.credentialRevision || receipt.status !== "valid"
    || receipt.observationSource !== "token_introspection" || receipt.expiresAt <= now
    || receipt.botUserId !== install.botUserId
    || (install.providerBotId !== null && install.providerBotId !== receipt.providerBotId)
    || !receipt.providerBotId.trim()) return null;
  return receipt.providerBotId;
}
