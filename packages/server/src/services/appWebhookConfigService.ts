import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { currentDate } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { oauthAppWebhookConfigs, oauthClients } from "../db/schema.js";
import { ensureLocalAppSourceInstallation } from "./appSourceInstallationService.js";
import * as integrationAuditService from "./integrationAuditService.js";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy.js";

const WEBHOOK_SECRET_PREFIX = "raft_webhook_secret_";
export const APP_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const APP_WEBHOOK_CLOCK_SKEW_MS = 60 * 1000;
export const APP_WEBHOOK_ROTATION_GRACE_MS = APP_WEBHOOK_REPLAY_WINDOW_MS + APP_WEBHOOK_CLOCK_SKEW_MS;
const ENCRYPTION_KEY_ENV = "RAFT_APP_WEBHOOK_ENCRYPTION_KEY";

type EncryptedSecret = { ciphertext: string; iv: string; authTag: string };

let testEncryptionKey: Buffer | null = null;

export class AppWebhookConfigError extends Error {}

export function __setAppWebhookEncryptionKeyForTests(key: Buffer | null) {
  testEncryptionKey = key;
}

function encryptionKey(): Buffer {
  if (testEncryptionKey) return testEncryptionKey;
  const raw = process.env[ENCRYPTION_KEY_ENV]?.trim();
  if (!raw) throw new AppWebhookConfigError(`${ENCRYPTION_KEY_ENV} is required`);
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new AppWebhookConfigError(`${ENCRYPTION_KEY_ENV} must decode to 32 bytes`);
  return key;
}

function encryptSecret(secret: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(encrypted: EncryptedSecret): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppWebhookConfigError("Webhook signing secret cannot be decrypted");
  }
}

const NON_PUBLIC_WEBHOOK_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_WEBHOOK_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_WEBHOOK_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export function isPublicWebhookAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  const version = isIP(normalized);
  if (version === 4) return !NON_PUBLIC_WEBHOOK_ADDRESSES.check(normalized, "ipv4");
  if (version === 6) {
    if (normalized.startsWith("::ffff:")) return isPublicWebhookAddress(normalized.slice("::ffff:".length));
    return !NON_PUBLIC_WEBHOOK_ADDRESSES.check(normalized, "ipv6");
  }
  return false;
}

export function normalizeAppWebhookEndpoint(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new AppWebhookConfigError("endpointUrl is required");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppWebhookConfigError("endpointUrl must be a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppWebhookConfigError("endpointUrl must be credential-free HTTPS");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new AppWebhookConfigError("endpointUrl must use a public host");
  }
  if (isIP(hostname) && !isPublicWebhookAddress(hostname)) {
    throw new AppWebhookConfigError("endpointUrl must not use a private or special-use address");
  }
  url.hash = "";
  return url.toString();
}

function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function endpointOrigin(endpointUrl: string): string {
  return new URL(endpointUrl).origin;
}

export async function configureAppWebhook(input: {
  clientId: string;
  actorUserId: string;
  endpointUrl: unknown;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  const endpointUrl = normalizeAppWebhookEndpoint(input.endpointUrl);
  return dbOrTx.transaction(async (tx) => {
    const [client] = await tx.select({
      id: oauthClients.id,
      serverId: oauthClients.serverId,
      clientKey: oauthClients.clientId,
    }).from(oauthClients).where(and(
      eq(oauthClients.id, input.clientId),
      oauthClientIsUserManagedPredicate(),
    )).limit(1);
    if (!client) return null;
    await ensureLocalAppSourceInstallation(client.id, tx);
    const [existing] = await tx.select().from(oauthAppWebhookConfigs)
      .where(eq(oauthAppWebhookConfigs.clientId, client.id)).limit(1).for("update");

    let secret: string | undefined;
    let revision: number;
    if (!existing) {
      secret = generateWebhookSecret();
      const encrypted = encryptSecret(secret);
      const [created] = await tx.insert(oauthAppWebhookConfigs).values({
        clientId: client.id,
        endpointUrl,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        revision: 1,
        enabled: true,
        updatedByUserId: input.actorUserId,
      }).returning();
      revision = created.revision;
    } else {
      revision = existing.revision + 1;
      await tx.update(oauthAppWebhookConfigs).set({
        endpointUrl,
        enabled: true,
        revision,
        updatedByUserId: input.actorUserId,
        updatedAt: currentDate(),
      }).where(eq(oauthAppWebhookConfigs.id, existing.id));
    }

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: client.serverId,
      clientId: client.id,
      eventType: "webhook.configured",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.actorUserId },
      subject: { type: "app", id: client.id },
      target: { type: "app", id: client.id },
      metadata: { clientKey: client.clientKey, configRevision: revision, endpointOrigin: endpointOrigin(endpointUrl) },
    }, tx);
    return { endpointUrl, revision, enabled: true, secret };
  });
}

export async function rotateAppWebhookSecret(input: {
  clientId: string;
  actorUserId: string;
  emergency?: boolean;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  return dbOrTx.transaction(async (tx) => {
    const [row] = await tx.select({
      config: oauthAppWebhookConfigs,
      serverId: oauthClients.serverId,
      clientKey: oauthClients.clientId,
    }).from(oauthAppWebhookConfigs)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthAppWebhookConfigs.clientId))
      .where(and(
        eq(oauthAppWebhookConfigs.clientId, input.clientId),
        eq(oauthAppWebhookConfigs.enabled, true),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    if (!row) return null;

    const secret = generateWebhookSecret();
    const encrypted = encryptSecret(secret);
    const now = currentDate();
    const previousValidUntil = input.emergency ? now : new Date(now.getTime() + APP_WEBHOOK_ROTATION_GRACE_MS);
    const revision = row.config.revision + 1;
    await tx.update(oauthAppWebhookConfigs).set({
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
      previousSecretCiphertext: input.emergency ? null : row.config.secretCiphertext,
      previousSecretIv: input.emergency ? null : row.config.secretIv,
      previousSecretAuthTag: input.emergency ? null : row.config.secretAuthTag,
      previousValidUntil,
      revision,
      updatedByUserId: input.actorUserId,
      updatedAt: now,
    }).where(eq(oauthAppWebhookConfigs.id, row.config.id));

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: row.serverId,
      clientId: input.clientId,
      eventType: "webhook.rotated",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.actorUserId },
      subject: { type: "app", id: input.clientId },
      target: { type: "app", id: input.clientId },
      metadata: {
        clientKey: row.clientKey,
        configRevision: revision,
        endpointOrigin: endpointOrigin(row.config.endpointUrl),
        previousValidUntil: previousValidUntil.toISOString(),
        emergency: input.emergency === true,
      },
    }, tx);
    return { secret, revision, previousValidUntil, emergency: input.emergency === true };
  });
}

export async function disableAppWebhook(input: {
  clientId: string;
  actorUserId: string;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  return dbOrTx.transaction(async (tx) => {
    const [row] = await tx.select({
      config: oauthAppWebhookConfigs,
      serverId: oauthClients.serverId,
      clientKey: oauthClients.clientId,
    }).from(oauthAppWebhookConfigs)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthAppWebhookConfigs.clientId))
      .where(and(
        eq(oauthAppWebhookConfigs.clientId, input.clientId),
        oauthClientIsUserManagedPredicate(),
      )).limit(1).for("update");
    if (!row) return null;
    const revision = row.config.revision + 1;
    await tx.update(oauthAppWebhookConfigs).set({
      enabled: false,
      revision,
      previousSecretCiphertext: null,
      previousSecretIv: null,
      previousSecretAuthTag: null,
      previousValidUntil: null,
      updatedByUserId: input.actorUserId,
      updatedAt: currentDate(),
    }).where(eq(oauthAppWebhookConfigs.id, row.config.id));
    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: row.serverId,
      clientId: input.clientId,
      eventType: "webhook.disabled",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.actorUserId },
      subject: { type: "app", id: input.clientId },
      target: { type: "app", id: input.clientId },
      metadata: { clientKey: row.clientKey, configRevision: revision },
    }, tx);
    return { revision, enabled: false };
  });
}

export function decryptCurrentAppWebhookSecret(config: {
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
}): string {
  return decryptSecret({
    ciphertext: config.secretCiphertext,
    iv: config.secretIv,
    authTag: config.secretAuthTag,
  });
}

export function decryptAppWebhookSigningSecret(config: {
  revision: number;
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  previousSecretCiphertext: string | null;
  previousSecretIv: string | null;
  previousSecretAuthTag: string | null;
  previousValidUntil: Date | null;
}, deliveryConfigRevision: number, now: Date): string {
  if (deliveryConfigRevision === config.revision - 1
    && config.previousValidUntil
    && config.previousValidUntil.getTime() > now.getTime()
    && config.previousSecretCiphertext
    && config.previousSecretIv
    && config.previousSecretAuthTag) {
    return decryptSecret({
      ciphertext: config.previousSecretCiphertext,
      iv: config.previousSecretIv,
      authTag: config.previousSecretAuthTag,
    });
  }
  return decryptCurrentAppWebhookSecret(config);
}
