import { randomUUID } from "node:crypto";

import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  clearClockTimeout,
  currentDate,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";

import { getDb, type Database } from "../db/index.js";
import {
  externalAppCredentials,
  externalAppInstalls,
  externalChannelBindings,
  externalMessageLinks,
} from "../db/schema.js";
import type { SlackAudienceCredentialResolver } from "./slackAudienceRefreshService.js";
import {
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  type SlackBridgeCredentialHandle,
  type SlackJsonObject,
  type SlackProviderAuthorityFence,
  type SlackProviderAuthorityQuarantineSink,
  type SlackWebApiRequest,
  type SlackWebApiTransport,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter.js";

const DEFAULT_CREDENTIAL_LEASE_TTL_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_REQUEST_BYTES = 256 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const BOT_CREDENTIAL_AAD_VERSION = 1;

interface AwsCommandClient {
  send(command: unknown): Promise<unknown>;
}

interface ProviderCredentialLease {
  accessToken: string;
  authority: SlackProviderAuthorityFence;
  expiresAt: Date;
}

export interface SlackBridgeAwsAudienceProviderRuntime {
  credentialResolver: SlackAudienceCredentialResolver;
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  stop(): Promise<void>;
}

export interface SlackBridgeAwsAudienceProviderDependencies {
  db?: Database;
  kms?: AwsCommandClient;
  credentialKmsKeyId: string;
  fetch?: typeof fetch;
  now?: () => Date;
  credentialLeaseTtlMs?: number;
  fetchTimeoutMs?: number;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function nonEmpty(value: unknown, max = 4_096): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= max;
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

function sameHandle(
  handle: SlackBridgeCredentialHandle,
  lease: ProviderCredentialLease,
): boolean {
  return handle.schema === SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA
    && handle.installId === lease.authority.installId
    && handle.providerAppId === lease.authority.providerAppId
    && handle.providerAuthorityId === lease.authority.providerAuthorityId
    && handle.connectionEpoch === lease.authority.connectionEpoch
    && handle.credentialRevision === lease.authority.credentialRevision
    && handle.leaseExpiresAt.getTime() === lease.expiresAt.getTime();
}

function credentialEncryptionContext(input: {
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

function encryptedCiphertext(value: string): Uint8Array | null {
  if (!value.startsWith("kms:v1:")) return null;
  const encoded = value.slice("kms:v1:".length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.byteLength > 0 ? bytes : null;
}

function accessTokenFromPlaintext(value: unknown): string | null {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value).toString("utf8")) as Record<string, unknown>;
    return parsed.tokenType === "bot" && nonEmpty(parsed.accessToken)
      ? parsed.accessToken
      : null;
  } catch {
    return null;
  }
}

function responseBody(value: string): SlackJsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as SlackJsonObject
      : {};
  } catch {
    return {};
  }
}

/**
 * AWS-managed, one-use Slack Web API custody for audience reconciliation. The
 * database lease is claimed before KMS decrypt and released before provider
 * I/O; plaintext tokens live only in this process and are consumed once.
 */
export function createSlackBridgeAwsAudienceProviderRuntime(
  dependencies: SlackBridgeAwsAudienceProviderDependencies,
): SlackBridgeAwsAudienceProviderRuntime {
  if (!nonEmpty(dependencies.credentialKmsKeyId)) {
    throw new Error("Slack audience provider credential KMS key is required");
  }
  const leaseTtlMs = dependencies.credentialLeaseTtlMs
    ?? DEFAULT_CREDENTIAL_LEASE_TTL_MS;
  const fetchTimeoutMs = dependencies.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 || leaseTtlMs > 5 * 60_000) {
    throw new Error("Slack audience provider credential lease TTL is invalid");
  }
  if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
    throw new Error("Slack audience provider fetch timeout is invalid");
  }

  const runtimeDb = dependencies.db ?? getDb();
  const kms = dependencies.kms ?? new KMSClient({});
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? currentDate;
  const credentialLeases = new Map<string, ProviderCredentialLease>();
  const providerAbortControllers = new Set<AbortController>();
  let stopped = false;

  const releaseCredentialLease = async (
    authority: SlackProviderAuthorityFence,
    leaseId: string,
    at: Date,
  ): Promise<void> => {
    await runtimeDb.update(externalAppCredentials).set({
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: at,
    }).where(and(
      eq(externalAppCredentials.installId, authority.installId),
      eq(externalAppCredentials.credentialRevision, authority.credentialRevision),
      eq(externalAppCredentials.leaseOwner, leaseId),
    ));
  };

  const credentialResolver: SlackAudienceCredentialResolver = {
    async resolve({ authority, now: requestedAt }) {
      if (stopped || !validDate(requestedAt)) return null;
      const leaseId = `slack-audience:${randomUUID()}`;
      const leaseExpiresAt = new Date(requestedAt.getTime() + leaseTtlMs);
      const row = await runtimeDb.transaction(async (tx) => {
        const candidates = await tx.select({
          installState: externalAppInstalls.state,
          installRegistrationId: externalAppInstalls.registrationId,
          installProviderAppId: externalAppInstalls.providerAppId,
          installProviderTeamId: externalAppInstalls.providerTeamId,
          installProviderAuthorityId: externalAppInstalls.providerAuthorityId,
          installBotUserId: externalAppInstalls.botUserId,
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
          .innerJoin(externalChannelBindings, and(
            eq(externalChannelBindings.id, authority.bindingId),
            eq(externalChannelBindings.installId, externalAppInstalls.id),
          ))
          .where(and(
            eq(externalAppInstalls.id, authority.installId),
            eq(externalAppInstalls.state, "active"),
            eq(externalAppInstalls.providerAppId, authority.providerAppId),
            eq(externalAppInstalls.providerAuthorityId, authority.providerAuthorityId),
            eq(externalAppInstalls.connectionEpoch, authority.connectionEpoch),
            eq(externalAppInstalls.credentialRevision, authority.credentialRevision),
            eq(externalChannelBindings.state, "active"),
            eq(externalChannelBindings.providerConversationId, authority.providerConversationId),
            eq(externalChannelBindings.connectionEpoch, authority.connectionEpoch),
            eq(externalChannelBindings.bindingEpoch, authority.bindingEpoch),
            eq(externalAppCredentials.state, "active"),
            eq(externalAppCredentials.credentialRevision, authority.credentialRevision),
            or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, requestedAt)),
            or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, requestedAt)),
          )).for("update").limit(2);
        if (candidates.length !== 1) return null;
        const current = candidates[0]!;
        if (
          current.installState !== "active"
          || current.credentialState !== "active"
          || current.installProviderAppId !== authority.providerAppId
          || current.installProviderAuthorityId !== authority.providerAuthorityId
          || current.installConnectionEpoch !== authority.connectionEpoch
          || current.installCredentialRevision !== authority.credentialRevision
          || current.credentialRevision !== authority.credentialRevision
          || current.envelopeKeyId !== dependencies.credentialKmsKeyId
          || current.aadVersion !== BOT_CREDENTIAL_AAD_VERSION
          || !nonEmpty(current.installProviderTeamId)
          || !nonEmpty(current.installBotUserId)
        ) return null;
        const claimed = await tx.update(externalAppCredentials).set({
          leaseOwner: leaseId,
          leaseExpiresAt,
          updatedAt: requestedAt,
        }).where(and(
          eq(externalAppCredentials.id, current.credentialId),
          eq(externalAppCredentials.state, "active"),
          eq(externalAppCredentials.credentialRevision, authority.credentialRevision),
          or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, requestedAt)),
        )).returning({ id: externalAppCredentials.id });
        return claimed.length === 1 ? current : null;
      });
      if (!row) return null;

      const ciphertext = encryptedCiphertext(row.encryptedMaterial);
      let accessToken: string | null = null;
      if (ciphertext) {
        try {
          const decrypted = await kms.send(new DecryptCommand({
            KeyId: dependencies.credentialKmsKeyId,
            CiphertextBlob: ciphertext,
            EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
            EncryptionContext: credentialEncryptionContext({
              providerAppId: authority.providerAppId,
              providerTeamId: row.installProviderTeamId!,
              botUserId: row.installBotUserId!,
            }),
          })) as { KeyId?: unknown; Plaintext?: unknown };
          if (decrypted.KeyId === dependencies.credentialKmsKeyId) {
            accessToken = accessTokenFromPlaintext(decrypted.Plaintext);
          }
        } catch {
          accessToken = null;
        }
      }
      if (!accessToken || stopped) {
        await releaseCredentialLease(authority, leaseId, requestedAt);
        return null;
      }
      credentialLeases.set(leaseId, {
        accessToken,
        authority: { ...authority },
        expiresAt: leaseExpiresAt,
      });
      return {
        schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
        leaseId,
        installId: authority.installId,
        providerAppId: authority.providerAppId,
        providerAuthorityId: authority.providerAuthorityId,
        connectionEpoch: authority.connectionEpoch,
        credentialRevision: authority.credentialRevision,
        leaseExpiresAt,
      };
    },
  };

  const transport: SlackWebApiTransport = {
    evidence: "live",
    async call(request: SlackWebApiRequest): Promise<SlackWebApiTransportResult> {
      const lease = credentialLeases.get(request.credentialHandle.leaseId);
      credentialLeases.delete(request.credentialHandle.leaseId);
      if (!lease) {
        return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      }
      const calledAt = now();
      const releaseAt = validDate(calledAt) ? calledAt : currentDate();
      await releaseCredentialLease(lease.authority, request.credentialHandle.leaseId, releaseAt);
      const requestBody = JSON.stringify(request.body);
      if (
        stopped
        || !validDate(calledAt)
        || lease.expiresAt <= calledAt
        || !sameAuthority(lease.authority, request.authority)
        || !sameHandle(request.credentialHandle, lease)
        || Buffer.byteLength(requestBody, "utf8") > MAX_PROVIDER_REQUEST_BYTES
      ) {
        return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      }

      const controller = new AbortController();
      providerAbortControllers.add(controller);
      const timeout = setClockTimeout(() => controller.abort(), fetchTimeoutMs);
      let receivedHeaders = false;
      try {
        const response = await fetcher(`https://slack.com/api/${request.method}`, {
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
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
          return { kind: "transport_failure", phase: "after_send", code: "unavailable" };
        }
        return {
          kind: "response",
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody(text),
        };
      } catch {
        return {
          kind: "transport_failure",
          phase: receivedHeaders ? "after_send" : "unknown",
          code: controller.signal.aborted ? "timeout" : "unavailable",
        };
      } finally {
        clearClockTimeout(timeout);
        providerAbortControllers.delete(controller);
      }
    },
  };

  const quarantineSink: SlackProviderAuthorityQuarantineSink = {
    async quarantine(fence) {
      return runtimeDb.transaction(async (tx) => {
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
        ) return "fence_mismatch";
        if (install.state !== "active" || binding.state !== "active" || credential.state !== "active") {
          return "already_fenced";
        }
        const at = now();
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
        return "applied";
      });
    },
  };

  return {
    credentialResolver,
    transport,
    quarantineSink,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const controller of providerAbortControllers) controller.abort();
      const leases = [...credentialLeases.entries()];
      credentialLeases.clear();
      const stoppedAt = now();
      if (!validDate(stoppedAt)) return;
      await Promise.all(leases.map(([leaseId, lease]) =>
        releaseCredentialLease(lease.authority, leaseId, stoppedAt)));
    },
  };
}
