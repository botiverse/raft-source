import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { currentDate } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";

import { getDb, type Database } from "../db/index.js";
import {
  externalAppRegistrations,
  externalAppRegistrationSecrets,
} from "../db/schema.js";
import type {
  SlackBotCredentialSealer,
  SlackOAuthAppSecretLeaseProvider,
} from "./slackProviderAdapter.js";

const OAUTH_SECRET_SCHEMA = "slack-oauth-client-secret.v1" as const;
const OAUTH_SECRET_AUDIENCE = "slack-oauth-exchange" as const;
const BOT_CREDENTIAL_AAD_VERSION = 1 as const;
const DEFAULT_SECRET_LEASE_TTL_MS = 60_000;
const MAX_KMS_PLAINTEXT_BYTES = 4_096;

type Environment = "test" | "production";

interface OAuthSecretAuthority {
  registrationId: string;
  providerAppId: string;
  providerOAuthClientId: string;
  environment: Environment;
  secretId: string;
  encryptedSecretRef: string;
  envelopeKeyId: string;
  aadVersion: number;
  secretRevision: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export interface SlackOAuthSecretAuthorityStore {
  claim(input: {
    registrationId: string;
    providerAppId: string;
    providerOAuthClientId: string;
    environment: Environment;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<OAuthSecretAuthority | null>;
  confirm(authority: OAuthSecretAuthority, now: Date): Promise<boolean>;
}

interface AwsCommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface SlackBridgeAwsSecretDependencies {
  authorityStore?: SlackOAuthSecretAuthorityStore;
  db?: Database;
  secretsManager?: AwsCommandClient;
  kms?: AwsCommandClient;
  credentialKmsKeyId: string;
  leaseTtlMs?: number;
  now?: () => Date;
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function nonEmpty(value: unknown, max = 2_048): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= max;
}

function secretArn(value: string): boolean {
  return /^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:[^\s]+$/.test(value);
}

function sameAuthority(
  left: OAuthSecretAuthority,
  right: OAuthSecretAuthority,
): boolean {
  return left.registrationId === right.registrationId
    && left.providerAppId === right.providerAppId
    && left.providerOAuthClientId === right.providerOAuthClientId
    && left.environment === right.environment
    && left.secretId === right.secretId
    && left.encryptedSecretRef === right.encryptedSecretRef
    && left.envelopeKeyId === right.envelopeKeyId
    && left.aadVersion === right.aadVersion
    && left.secretRevision === right.secretRevision
    && left.leaseOwner === right.leaseOwner
    && left.leaseExpiresAt.getTime() === right.leaseExpiresAt.getTime();
}

async function loadAuthority(
  db: Database,
  registrationId: string,
  lock: boolean,
): Promise<{
  registration: typeof externalAppRegistrations.$inferSelect;
  secret: typeof externalAppRegistrationSecrets.$inferSelect;
} | null> {
  return db.transaction(async (tx) => {
    const registrationQuery = tx.select().from(externalAppRegistrations).where(eq(
      externalAppRegistrations.id,
      registrationId,
    )).limit(2);
    const registrations = lock
      ? await registrationQuery.for("update")
      : await registrationQuery;
    const secretQuery = tx.select().from(externalAppRegistrationSecrets).where(and(
      eq(externalAppRegistrationSecrets.registrationId, registrationId),
      eq(externalAppRegistrationSecrets.purpose, "oauth_client_secret"),
    )).limit(2);
    const secrets = lock ? await secretQuery.for("update") : await secretQuery;
    if (registrations.length !== 1 || secrets.length !== 1) return null;
    return { registration: registrations[0]!, secret: secrets[0]! };
  });
}

function authorityFromRows(input: {
  registration: typeof externalAppRegistrations.$inferSelect;
  secret: typeof externalAppRegistrationSecrets.$inferSelect;
}): OAuthSecretAuthority | null {
  if (
    input.registration.provider !== "slack"
    || input.registration.state !== "active"
    || !input.registration.providerAppId
    || !input.registration.providerOAuthClientId
    || input.secret.revokedAt !== null
    || input.secret.purpose !== "oauth_client_secret"
    || !secretArn(input.secret.encryptedSecretRef)
    || !nonEmpty(input.secret.envelopeKeyId)
    || input.secret.aadVersion !== 1
    || input.secret.secretRevision <= 0
    || !input.secret.leaseOwner
    || !input.secret.leaseExpiresAt
  ) return null;
  return {
    registrationId: input.registration.id,
    providerAppId: input.registration.providerAppId,
    providerOAuthClientId: input.registration.providerOAuthClientId,
    environment: input.registration.environment,
    secretId: input.secret.id,
    encryptedSecretRef: input.secret.encryptedSecretRef,
    envelopeKeyId: input.secret.envelopeKeyId,
    aadVersion: input.secret.aadVersion,
    secretRevision: input.secret.secretRevision,
    leaseOwner: input.secret.leaseOwner,
    leaseExpiresAt: input.secret.leaseExpiresAt,
  };
}

export function createSlackOAuthSecretAuthorityStore(
  db?: Database,
): SlackOAuthSecretAuthorityStore {
  return {
    async claim(request) {
      if (
        !validDate(request.now)
        || !validDate(request.leaseExpiresAt)
        || request.leaseExpiresAt <= request.now
        || !nonEmpty(request.leaseOwner, 320)
      ) return null;

      const runtimeDb = db ?? getDb();
      return runtimeDb.transaction(async (tx) => {
        const registrations = await tx.select().from(externalAppRegistrations).where(eq(
          externalAppRegistrations.id,
          request.registrationId,
        )).limit(2).for("update");
        const secrets = await tx.select().from(externalAppRegistrationSecrets).where(and(
          eq(externalAppRegistrationSecrets.registrationId, request.registrationId),
          eq(externalAppRegistrationSecrets.purpose, "oauth_client_secret"),
        )).limit(2).for("update");
        if (registrations.length !== 1 || secrets.length !== 1) return null;
        const registration = registrations[0]!;
        const secret = secrets[0]!;
        if (
          registration.provider !== "slack"
          || registration.state !== "active"
          || registration.environment !== request.environment
          || registration.providerAppId !== request.providerAppId
          || registration.providerOAuthClientId !== request.providerOAuthClientId
          || secret.revokedAt !== null
          || !secretArn(secret.encryptedSecretRef)
          || !nonEmpty(secret.envelopeKeyId)
          || secret.aadVersion !== 1
          || secret.secretRevision <= 0
          || (secret.leaseOwner === null) !== (secret.leaseExpiresAt === null)
          || (
            secret.leaseOwner !== null
            && secret.leaseExpiresAt !== null
            && secret.leaseExpiresAt > request.now
          )
        ) return null;

        await tx.update(externalAppRegistrationSecrets).set({
          leaseOwner: request.leaseOwner,
          leaseExpiresAt: request.leaseExpiresAt,
          updatedAt: request.now,
        }).where(eq(externalAppRegistrationSecrets.id, secret.id));
        return {
          registrationId: registration.id,
          providerAppId: registration.providerAppId,
          providerOAuthClientId: registration.providerOAuthClientId,
          environment: registration.environment,
          secretId: secret.id,
          encryptedSecretRef: secret.encryptedSecretRef,
          envelopeKeyId: secret.envelopeKeyId,
          aadVersion: secret.aadVersion,
          secretRevision: secret.secretRevision,
          leaseOwner: request.leaseOwner,
          leaseExpiresAt: request.leaseExpiresAt,
        };
      });
    },

    async confirm(expected, now) {
      if (!validDate(now) || expected.leaseExpiresAt <= now) return false;
      const rows = await loadAuthority(db ?? getDb(), expected.registrationId, false);
      const current = rows ? authorityFromRows(rows) : null;
      return current !== null
        && current.leaseExpiresAt > now
        && sameAuthority(current, expected);
    },
  };
}

type OAuthSecretBody = {
  schema: typeof OAUTH_SECRET_SCHEMA;
  registrationId: string;
  providerOAuthClientId: string;
  secretRevision: number;
  aadVersion: number;
  clientSecret: string;
};

function parseOAuthSecretBody(value: string): OAuthSecretBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const expectedKeys = [
    "aadVersion",
    "clientSecret",
    "providerOAuthClientId",
    "registrationId",
    "schema",
    "secretRevision",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return null;
  }
  if (
    body.schema !== OAUTH_SECRET_SCHEMA
    || !nonEmpty(body.registrationId, 64)
    || !nonEmpty(body.providerOAuthClientId, 320)
    || !Number.isSafeInteger(body.secretRevision)
    || !Number.isSafeInteger(body.aadVersion)
    || !nonEmpty(body.clientSecret, 4_096)
  ) return null;
  return body as OAuthSecretBody;
}

export function createSlackOAuthSecretsManagerLeaseProvider(input: {
  authorityStore: SlackOAuthSecretAuthorityStore;
  secretsManager: AwsCommandClient;
  leaseTtlMs?: number;
  now?: () => Date;
}): SlackOAuthAppSecretLeaseProvider {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_SECRET_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 || leaseTtlMs > 5 * 60_000) {
    throw new Error("Slack OAuth app-secret lease TTL is invalid");
  }

  return {
    async lease(request) {
      if (
        request.audience !== OAUTH_SECRET_AUDIENCE
        || !validDate(request.now)
        || !nonEmpty(request.registrationId, 64)
        || !nonEmpty(request.providerAppId, 320)
        || !nonEmpty(request.providerOAuthClientId, 320)
        || !nonEmpty(request.attemptId, 320)
      ) return null;
      const expiresAt = new Date(request.now.getTime() + leaseTtlMs);
      const authority = await input.authorityStore.claim({
        registrationId: request.registrationId,
        providerAppId: request.providerAppId,
        providerOAuthClientId: request.providerOAuthClientId,
        environment: request.environment,
        leaseOwner: `slack-oauth:${request.attemptId}`,
        now: request.now,
        leaseExpiresAt: expiresAt,
      });
      if (!authority) return null;

      try {
        const described = await input.secretsManager.send(new DescribeSecretCommand({
          SecretId: authority.encryptedSecretRef,
        })) as { ARN?: unknown; KmsKeyId?: unknown };
        if (
          described.ARN !== authority.encryptedSecretRef
          || described.KmsKeyId !== authority.envelopeKeyId
        ) return null;
        const resolved = await input.secretsManager.send(new GetSecretValueCommand({
          SecretId: authority.encryptedSecretRef,
          VersionStage: "AWSCURRENT",
        })) as {
          ARN?: unknown;
          SecretString?: unknown;
          VersionStages?: unknown;
        };
        if (
          resolved.ARN !== authority.encryptedSecretRef
          || typeof resolved.SecretString !== "string"
          || !Array.isArray(resolved.VersionStages)
          || !resolved.VersionStages.includes("AWSCURRENT")
        ) return null;
        const body = parseOAuthSecretBody(resolved.SecretString);
        const confirmedAt = (input.now ?? currentDate)();
        if (
          !body
          || body.registrationId !== authority.registrationId
          || body.providerOAuthClientId !== authority.providerOAuthClientId
          || body.secretRevision !== authority.secretRevision
          || body.aadVersion !== authority.aadVersion
          || !validDate(confirmedAt)
          || confirmedAt < request.now
          || confirmedAt >= expiresAt
          || !(await input.authorityStore.confirm(authority, confirmedAt))
        ) return null;
        return {
          providerOAuthClientId: authority.providerOAuthClientId,
          clientSecret: body.clientSecret,
          expiresAt,
        };
      } catch {
        return null;
      }
    },
  };
}

function botCredentialEncryptionContext(input: {
  providerAppId: string;
  providerTeamId: string;
  botUserId: string;
}): Record<string, string> {
  return {
    aad_version: String(BOT_CREDENTIAL_AAD_VERSION),
    bot_user_id: input.botUserId,
    provider: "slack",
    provider_app_id: input.providerAppId,
    provider_team_id: input.providerTeamId,
    purpose: "slack_bot_credential",
    token_type: "bot",
  };
}

export function createSlackKmsBotCredentialSealer(input: {
  kms: AwsCommandClient;
  keyId: string;
}): SlackBotCredentialSealer {
  if (!nonEmpty(input.keyId)) {
    throw new Error("Slack bot credential KMS key is required");
  }
  return {
    async seal(request) {
      if (
        request.tokenType !== "bot"
        || !validDate(request.now)
        || !nonEmpty(request.accessToken, MAX_KMS_PLAINTEXT_BYTES)
        || !nonEmpty(request.providerAppId, 320)
        || !nonEmpty(request.providerTeamId, 320)
        || !nonEmpty(request.botUserId, 320)
      ) throw new Error("Slack bot credential cannot be sealed");
      const plaintext = Buffer.from(JSON.stringify({
        accessToken: request.accessToken,
        tokenType: request.tokenType,
      }), "utf8");
      if (plaintext.byteLength > MAX_KMS_PLAINTEXT_BYTES) {
        throw new Error("Slack bot credential cannot be sealed");
      }
      const result = await input.kms.send(new EncryptCommand({
        KeyId: input.keyId,
        Plaintext: plaintext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: botCredentialEncryptionContext(request),
      })) as { CiphertextBlob?: unknown; KeyId?: unknown };
      const ciphertext = result.CiphertextBlob;
      if (
        !(ciphertext instanceof Uint8Array)
        || ciphertext.byteLength === 0
        || result.KeyId !== input.keyId
      ) {
        throw new Error("Slack bot credential KMS response is invalid");
      }
      return {
        encryptedMaterial: `kms:v1:${Buffer.from(ciphertext).toString("base64")}`,
        envelopeKeyId: result.KeyId,
        aadVersion: BOT_CREDENTIAL_AAD_VERSION,
      };
    },
  };
}

export function createSlackBridgeAwsSecretBackends(
  dependencies: SlackBridgeAwsSecretDependencies,
): {
  appSecrets: SlackOAuthAppSecretLeaseProvider;
  credentialSealer: SlackBotCredentialSealer;
} {
  const authorityStore = dependencies.authorityStore
    ?? createSlackOAuthSecretAuthorityStore(dependencies.db);
  const secretsManager = dependencies.secretsManager ?? new SecretsManagerClient({});
  const kms = dependencies.kms ?? new KMSClient({});
  return {
    appSecrets: createSlackOAuthSecretsManagerLeaseProvider({
      authorityStore,
      secretsManager,
      leaseTtlMs: dependencies.leaseTtlMs,
      now: dependencies.now,
    }),
    credentialSealer: createSlackKmsBotCredentialSealer({
      kms,
      keyId: dependencies.credentialKmsKeyId,
    }),
  };
}
