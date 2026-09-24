import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  clearClockTimeout,
  currentDate,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";

import { getDb, type Database, type DatabaseTransaction } from "../db/index.js";
import {
  externalAppCredentials,
  externalAppInstalls,
  externalChannelBindings,
  externalMessageLinks,
} from "../db/schema.js";
import type { SlackAudienceCredentialResolver } from "./slackAudienceRefreshService.js";
import type { SlackBridgeCredentialCipher } from "./slackBridgeEnvSecrets.js";
import type { ExternalAttachmentAuthority } from "./externalAttachmentProviderAdapter.js";
import {
  SlackInboundAttachmentError,
  type SlackInboundAttachmentTransport,
} from "./slackInboundAttachmentAdapter.js";
import {
  SlackOutboundAttachmentError,
  type SlackOutboundAttachmentTransport,
} from "./slackOutboundAttachmentAdapter.js";
import type {
  SlackBridgeProvisioningProvider,
  SlackBridgeProvisioningProviderAuthority,
  SlackBridgeProvisioningProviderResult,
  SlackBridgeProvisioningProviderUser,
} from "./slackBridgeProvisioningControlPlane.js";
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
const DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_PROVIDER_REQUEST_BYTES = 256 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const MAX_PROVIDER_PAGES = 100;
const SLACK_AUTH_REVOKED_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
]);
const SLACK_QUERY_METHODS = new Set([
  "conversations.list",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "conversations.members",
  "files.info",
  "files.getUploadURLExternal",
  "conversations.history",
  "conversations.replies",
  "reactions.get",
  "users.info",
]);

type Tx = DatabaseTransaction;

interface CredentialAuthority {
  serverId: string;
  installId: string;
  providerAppId: string;
  providerTeamId: string;
  providerAuthorityId: string;
  botUserId: string;
  connectionEpoch: number;
  credentialRevision: number;
}

interface ProviderCredentialLease {
  leaseId: string;
  accessToken: string;
  authority: CredentialAuthority;
  expiresAt: Date;
}

export interface SlackBridgeAudienceProviderRuntime {
  credentialResolver: SlackAudienceCredentialResolver;
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  inboundAttachmentTransport: SlackInboundAttachmentTransport;
  createOutboundAttachmentTransport(
    handle: SlackBridgeCredentialHandle,
    authority: SlackProviderAuthorityFence,
  ): Promise<SlackOutboundAttachmentTransport | null>;
  releaseCredential(handle: SlackBridgeCredentialHandle): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackBridgeProviderRuntime extends SlackBridgeAudienceProviderRuntime {
  provisioningProvider: SlackBridgeProvisioningProvider;
}

export interface SlackBridgeProviderRuntimeDependencies {
  credentialCipher: SlackBridgeCredentialCipher;
  db?: Database;
  fetch?: typeof fetch;
  now?: () => Date;
  credentialLeaseTtlMs?: number;
  fetchTimeoutMs?: number;
  attachmentDownloadTimeoutMs?: number;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function nonEmpty(value: unknown, max = 4_096): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= max
    && !/[\r\n\0]/u.test(value);
}

/** users.info omits is_custom_image/image_original for its generated default profile. */
export function slackProfileAvatarLocator(profile: Record<string, unknown>): string | null | undefined {
  const locator = nonEmpty(profile.image_72, 4_096) ? profile.image_72
    : nonEmpty(profile.image_48, 4_096) ? profile.image_48 : undefined;
  if (profile.is_custom_image === false || (
    profile.is_custom_image === undefined
    && locator !== undefined
    && nonEmpty(profile.avatar_hash, 512)
    && !nonEmpty(profile.image_original, 4_096)
  )) return null;
  // Missing/partial profile data is unknown, never an instruction to clear.
  return locator;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): SlackJsonObject {
  return record(value) ? value as SlackJsonObject : {};
}

function sameAuthority(left: SlackProviderAuthorityFence, right: CredentialAuthority): boolean {
  return left.installId === right.installId
    && left.providerAppId === right.providerAppId
    && left.providerAuthorityId === right.providerAuthorityId
    && left.connectionEpoch === right.connectionEpoch
    && left.credentialRevision === right.credentialRevision;
}

function sameHandle(handle: SlackBridgeCredentialHandle, lease: ProviderCredentialLease): boolean {
  return handle.schema === SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA
    && handle.installId === lease.authority.installId
    && handle.providerAppId === lease.authority.providerAppId
    && handle.providerAuthorityId === lease.authority.providerAuthorityId
    && handle.connectionEpoch === lease.authority.connectionEpoch
    && handle.credentialRevision === lease.authority.credentialRevision
    && handle.leaseExpiresAt.getTime() === lease.expiresAt.getTime();
}

function exactProvisioningAuthority(
  request: SlackBridgeProvisioningProviderAuthority,
  authority: CredentialAuthority,
): boolean {
  return request.installId === authority.installId
    && request.providerAppId === authority.providerAppId
    && request.providerAuthorityId === authority.providerAuthorityId
    && request.botUserId === authority.botUserId
    && request.connectionEpoch === authority.connectionEpoch
    && request.credentialRevision === authority.credentialRevision;
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function retryAfterMs(headers: Readonly<Record<string, string | undefined>>): number {
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (!raw || !/^\d+$/.test(raw.trim())) return 60_000;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0
    ? Math.min(2_147_483_647, seconds * 1_000)
    : 60_000;
}

function nextCursor(body: Record<string, unknown>): string | null | undefined {
  if (!record(body.response_metadata) || typeof body.response_metadata.next_cursor !== "string") {
    return undefined;
  }
  return body.response_metadata.next_cursor.trim() || null;
}

function providerQuery(body: Record<string, unknown>): string | null {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (!nonEmpty(key, 160)) return null;
    if (typeof value === "string" || typeof value === "boolean") {
      query.set(key, String(value));
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      query.set(key, String(value));
      continue;
    }
    return null;
  }
  return query.toString();
}

/**
 * Database-backed one-use Slack credential custody. Runtime-generated bot
 * tokens remain encrypted at rest with an env master key; plaintext exists
 * only inside a claimed lease and is released before provider I/O.
 */
export function createSlackBridgeProviderRuntime(
  dependencies: SlackBridgeProviderRuntimeDependencies,
): SlackBridgeProviderRuntime {
  const leaseTtlMs = dependencies.credentialLeaseTtlMs ?? DEFAULT_CREDENTIAL_LEASE_TTL_MS;
  const fetchTimeoutMs = dependencies.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const attachmentDownloadTimeoutMs = dependencies.attachmentDownloadTimeoutMs
    ?? DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 || leaseTtlMs > 5 * 60_000) {
    throw new Error("Slack provider credential lease TTL is invalid");
  }
  if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
    throw new Error("Slack provider fetch timeout is invalid");
  }
  if (
    !Number.isSafeInteger(attachmentDownloadTimeoutMs)
    || attachmentDownloadTimeoutMs <= 0
    || attachmentDownloadTimeoutMs > 30 * 60_000
  ) {
    throw new Error("Slack provider attachment download timeout is invalid");
  }
  const db = dependencies.db ?? getDb();
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? currentDate;
  const credentialLeases = new Map<string, ProviderCredentialLease>();
  const providerAbortControllers = new Set<AbortController>();
  let stopped = false;

  const releaseCredentialLease = async (
    installId: string,
    credentialRevision: number,
    leaseId: string,
    at: Date,
  ): Promise<void> => {
    await db.update(externalAppCredentials).set({
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: at,
    }).where(and(
      eq(externalAppCredentials.installId, installId),
      eq(externalAppCredentials.credentialRevision, credentialRevision),
      eq(externalAppCredentials.leaseOwner, leaseId),
    ));
  };

  const selectCredential = async (
    tx: Tx,
    request: {
      installId: string;
      providerAppId: string;
      providerAuthorityId: string;
      connectionEpoch: number;
      credentialRevision: number;
      binding?: Pick<SlackProviderAuthorityFence, "bindingId" | "bindingEpoch" | "providerConversationId">;
    },
    requestedAt: Date,
  ) => {
    const fields = {
      serverId: externalAppInstalls.serverId,
      installId: externalAppInstalls.id,
      installState: externalAppInstalls.state,
      providerAppId: externalAppInstalls.providerAppId,
      providerTeamId: externalAppInstalls.providerTeamId,
      providerAuthorityId: externalAppInstalls.providerAuthorityId,
      botUserId: externalAppInstalls.botUserId,
      connectionEpoch: externalAppInstalls.connectionEpoch,
      installCredentialRevision: externalAppInstalls.credentialRevision,
      credentialId: externalAppCredentials.id,
      credentialState: externalAppCredentials.state,
      encryptedMaterial: externalAppCredentials.encryptedMaterial,
      envelopeKeyId: externalAppCredentials.envelopeKeyId,
      aadVersion: externalAppCredentials.aadVersion,
      credentialRevision: externalAppCredentials.credentialRevision,
    };
    const common = and(
      eq(externalAppInstalls.id, request.installId),
      eq(externalAppInstalls.state, "active"),
      eq(externalAppInstalls.providerAppId, request.providerAppId),
      eq(externalAppInstalls.providerAuthorityId, request.providerAuthorityId),
      eq(externalAppInstalls.connectionEpoch, request.connectionEpoch),
      eq(externalAppInstalls.credentialRevision, request.credentialRevision),
      eq(externalAppCredentials.state, "active"),
      eq(externalAppCredentials.credentialRevision, request.credentialRevision),
      or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, requestedAt)),
      or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, requestedAt)),
    );
    if (request.binding) {
      return tx.select(fields).from(externalAppCredentials)
        .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalAppCredentials.installId))
        .innerJoin(externalChannelBindings, and(
          eq(externalChannelBindings.id, request.binding.bindingId),
          eq(externalChannelBindings.installId, externalAppInstalls.id),
        ))
        .where(and(
          common,
          eq(externalChannelBindings.state, "active"),
          eq(externalChannelBindings.providerConversationId, request.binding.providerConversationId),
          eq(externalChannelBindings.connectionEpoch, request.connectionEpoch),
          eq(externalChannelBindings.bindingEpoch, request.binding.bindingEpoch),
        )).for("update").limit(2);
    }
    return tx.select(fields).from(externalAppCredentials)
      .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalAppCredentials.installId))
      .where(common).for("update").limit(2);
  };

  const claimCredential = async (
    request: {
      installId: string;
      providerAppId: string;
      providerAuthorityId: string;
      connectionEpoch: number;
      credentialRevision: number;
      binding?: Pick<SlackProviderAuthorityFence, "bindingId" | "bindingEpoch" | "providerConversationId">;
    },
    requestedAt: Date,
  ): Promise<ProviderCredentialLease | null> => {
    if (stopped || !validDate(requestedAt)) return null;
    const leaseId = `slack-provider:${randomUUID()}`;
    const leaseExpiresAt = new Date(requestedAt.getTime() + leaseTtlMs);
    const row = await db.transaction(async (tx) => {
      const candidates = await selectCredential(tx, request, requestedAt);
      if (candidates.length !== 1) return null;
      const current = candidates[0]!;
      if (
        current.installState !== "active"
        || current.credentialState !== "active"
        || current.providerAppId !== request.providerAppId
        || current.providerAuthorityId !== request.providerAuthorityId
        || current.connectionEpoch !== request.connectionEpoch
        || current.installCredentialRevision !== request.credentialRevision
        || current.credentialRevision !== request.credentialRevision
        || !nonEmpty(current.serverId)
        || !nonEmpty(current.providerTeamId)
        || !nonEmpty(current.botUserId)
      ) return null;
      const claimed = await tx.update(externalAppCredentials).set({
        leaseOwner: leaseId,
        leaseExpiresAt,
        updatedAt: requestedAt,
      }).where(and(
        eq(externalAppCredentials.id, current.credentialId),
        eq(externalAppCredentials.state, "active"),
        eq(externalAppCredentials.credentialRevision, request.credentialRevision),
        or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, requestedAt)),
      )).returning({ id: externalAppCredentials.id });
      return claimed.length === 1 ? current : null;
    });
    if (!row) return null;
    const material = dependencies.credentialCipher.unseal({
      serverId: row.serverId,
      providerAppId: row.providerAppId,
      providerTeamId: row.providerTeamId!,
      botUserId: row.botUserId!,
      encryptedMaterial: row.encryptedMaterial,
      envelopeKeyId: row.envelopeKeyId,
      aadVersion: row.aadVersion,
    });
    if (!material || stopped) {
      await releaseCredentialLease(row.installId, row.credentialRevision, leaseId, requestedAt);
      return null;
    }
    return {
      leaseId,
      accessToken: material.accessToken,
      expiresAt: leaseExpiresAt,
      authority: {
        serverId: row.serverId,
        installId: row.installId,
        providerAppId: row.providerAppId,
        providerTeamId: row.providerTeamId!,
        providerAuthorityId: row.providerAuthorityId,
        botUserId: row.botUserId!,
        connectionEpoch: row.connectionEpoch,
        credentialRevision: row.credentialRevision,
      },
    };
  };

  const callWithToken = async (input: {
    method: string;
    body: Record<string, unknown>;
    accessToken: string;
  }): Promise<SlackWebApiTransportResult> => {
    const queryMethod = SLACK_QUERY_METHODS.has(input.method);
    const requestBody = queryMethod ? providerQuery(input.body) : JSON.stringify(input.body);
    if (requestBody === null || Buffer.byteLength(requestBody, "utf8") > MAX_PROVIDER_REQUEST_BYTES) {
      return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
    }
    const requestUrl = `https://slack.com/api/${input.method}`
      + (queryMethod && requestBody ? `?${requestBody}` : "");
    const controller = new AbortController();
    providerAbortControllers.add(controller);
    const timeout = setClockTimeout(() => controller.abort(), fetchTimeoutMs);
    let receivedHeaders = false;
    try {
      const response = await fetcher(requestUrl, {
        method: queryMethod ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          ...(queryMethod ? {} : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(queryMethod ? {} : { body: requestBody }),
        redirect: "error",
        signal: controller.signal,
      });
      receivedHeaders = true;
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
        return { kind: "transport_failure", phase: "after_send", code: "unavailable" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
      return {
        kind: "response",
        status: response.status,
        headers: responseHeaders(response.headers),
        body: jsonObject(parsed),
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
  };

  const attachmentFailure = (
    failureClass: "rate_limited" | "transient" | "deterministic" | "authority_revoked",
    reason: string,
    retryAfterMs: number | null = null,
    scope: "asset_global" | "occurrence_local" = "asset_global",
  ) => new SlackInboundAttachmentError({ class: failureClass, reason, retryAfterMs, scope });

  const resolveAttachmentCredentialRequest = async (authority: ExternalAttachmentAuthority) => {
    if (authority.provider !== "slack" || authority.workspaceId !== authority.providerAuthorityId) return null;
    const rows = await db.select({
      installId: externalAppInstalls.id,
      registrationId: externalAppInstalls.registrationId,
      installState: externalAppInstalls.state,
      providerAppId: externalAppInstalls.providerAppId,
      providerAuthorityId: externalAppInstalls.providerAuthorityId,
      connectionEpoch: externalAppInstalls.connectionEpoch,
      credentialRevision: externalAppInstalls.credentialRevision,
      bindingId: externalChannelBindings.id,
      bindingState: externalChannelBindings.state,
      providerConversationId: externalChannelBindings.providerConversationId,
      bindingConnectionEpoch: externalChannelBindings.connectionEpoch,
      bindingEpoch: externalChannelBindings.bindingEpoch,
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
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (
      row.installState !== "active"
      || row.bindingState !== "active"
      || row.registrationId !== authority.appRegistrationId
      || row.providerAuthorityId !== authority.providerAuthorityId
      || row.connectionEpoch !== authority.connectionEpoch
      || row.bindingConnectionEpoch !== authority.connectionEpoch
      || row.bindingEpoch !== authority.bindingEpoch
      || row.bindingId !== authority.bindingId
      || row.providerConversationId !== authority.providerConversationId
    ) return null;
    return {
      installId: row.installId,
      providerAppId: row.providerAppId,
      providerAuthorityId: row.providerAuthorityId,
      connectionEpoch: row.connectionEpoch,
      credentialRevision: row.credentialRevision,
      binding: {
        bindingId: row.bindingId,
        bindingEpoch: row.bindingEpoch,
        providerConversationId: row.providerConversationId,
      },
    };
  };

  const claimInboundAttachmentCredential = async (
    authority: ExternalAttachmentAuthority,
    requestedAt: Date,
  ) => {
    const request = validDate(requestedAt)
      ? await resolveAttachmentCredentialRequest(authority)
      : null;
    if (!request) {
      throw attachmentFailure(
        "authority_revoked",
        "provider_attachment_authority_unavailable",
        null,
        "occurrence_local",
      );
    }
    const lease = await claimCredential(request, requestedAt);
    if (lease) return lease;

    // A credential lease is intentionally exclusive across Server replicas.
    // Losing that short race means the credential is busy, not revoked. Keep
    // the attachment queued so it can retry after the competing provider call
    // releases the lease.
    const credentials = await db.select({
      state: externalAppCredentials.state,
      credentialRevision: externalAppCredentials.credentialRevision,
      expiresAt: externalAppCredentials.expiresAt,
    }).from(externalAppCredentials).where(and(
      eq(externalAppCredentials.installId, request.installId),
      eq(externalAppCredentials.credentialRevision, request.credentialRevision),
    )).limit(2);
    const credential = credentials.length === 1 ? credentials[0]! : null;
    if (
      credential?.state === "active"
      && credential.credentialRevision === request.credentialRevision
      && (credential.expiresAt === null || credential.expiresAt > requestedAt)
    ) {
      throw attachmentFailure(
        "transient",
        "provider_attachment_credential_busy",
        null,
        "occurrence_local",
      );
    }
    throw attachmentFailure(
      "authority_revoked",
      "provider_attachment_authority_unavailable",
      null,
      "occurrence_local",
    );
  };

  const inboundAttachmentTransport: SlackInboundAttachmentTransport = {
    async inspect({ authority, providerFileId }) {
      const requestedAt = now();
      const lease = await claimInboundAttachmentCredential(authority, requestedAt);
      try {
        const response = await callWithToken({
          method: "files.info",
          body: { file: providerFileId },
          accessToken: lease.accessToken,
        });
        if (response.kind === "transport_failure") {
          throw attachmentFailure("transient", "provider_file_metadata_unavailable");
        }
        const providerError = nonEmpty(response.body.error, 160) ? response.body.error : null;
        if (response.status === 429) {
          throw attachmentFailure(
            "rate_limited",
            "provider_file_metadata_rate_limited",
            retryAfterMs(response.headers),
          );
        }
        if (providerError && SLACK_AUTH_REVOKED_ERRORS.has(providerError)) {
          throw attachmentFailure(
            "authority_revoked",
            "provider_attachment_authority_revoked",
            null,
            "occurrence_local",
          );
        }
        if (response.status < 200 || response.status >= 300 || response.body.ok !== true) {
          throw attachmentFailure(
            providerError === "file_not_found" || providerError === "missing_scope"
              ? "deterministic"
              : "transient",
            providerError === "file_not_found"
              ? "provider_file_not_found"
              : providerError === "missing_scope"
                ? "provider_file_scope_missing"
                : "provider_file_metadata_unavailable",
            null,
            providerError === "missing_scope" ? "occurrence_local" : "asset_global",
          );
        }
        const file = record(response.body.file) ? response.body.file : null;
        const id = file && nonEmpty(file.id, 320) ? file.id : null;
        const user = file && nonEmpty(file.user, 160) ? file.user : null;
        const name = file && nonEmpty(file.name, 1024) ? file.name : null;
        const mimetype = file && nonEmpty(file.mimetype, 255) ? file.mimetype : null;
        const urlPrivateDownload = file && nonEmpty(file.url_private_download, 4096)
          ? file.url_private_download
          : file && nonEmpty(file.url_private, 4096)
            ? file.url_private
            : null;
        const size = file?.size;
        const timestamp = file?.timestamp;
        if (!id || !user || !name || !mimetype || !urlPrivateDownload || typeof size !== "number") {
          throw attachmentFailure("deterministic", "provider_file_metadata_invalid");
        }
        return {
          id,
          user,
          name,
          mimetype,
          size,
          timestamp: typeof timestamp === "number" ? timestamp : null,
          urlPrivateDownload,
        };
      } finally {
        const releasedAt = now();
        await releaseCredentialLease(
          lease.authority.installId,
          lease.authority.credentialRevision,
          lease.leaseId,
          validDate(releasedAt) ? releasedAt : currentDate(),
        );
      }
    },
    async *download({ authority, privateUrl, maximumBytes, signal }) {
      let parsedPrivateUrl: URL;
      try {
        parsedPrivateUrl = new URL(privateUrl);
      } catch {
        throw attachmentFailure("deterministic", "provider_file_download_locator_invalid");
      }
      if (
        parsedPrivateUrl.protocol !== "https:"
        || parsedPrivateUrl.hostname !== "files.slack.com"
        || parsedPrivateUrl.username
        || parsedPrivateUrl.password
        || parsedPrivateUrl.hash
      ) throw attachmentFailure("deterministic", "provider_file_download_locator_invalid");
      const requestedAt = now();
      const lease = await claimInboundAttachmentCredential(authority, requestedAt);
      const controller = new AbortController();
      providerAbortControllers.add(controller);
      const abortFromCaller = () => controller.abort();
      signal.addEventListener("abort", abortFromCaller, { once: true });
      const timeout = setClockTimeout(() => controller.abort(), attachmentDownloadTimeoutMs);
      try {
        const response = await fetcher(privateUrl, {
          method: "GET",
          headers: { authorization: `Bearer ${lease.accessToken}` },
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          throw attachmentFailure(
            "authority_revoked",
            "provider_attachment_authority_revoked",
            null,
            "occurrence_local",
          );
        }
        if (response.status === 404 || response.status === 410) {
          throw attachmentFailure("deterministic", "provider_file_not_found");
        }
        if (response.status === 429) {
          throw attachmentFailure(
            "rate_limited",
            "provider_file_download_rate_limited",
            retryAfterMs(responseHeaders(response.headers)),
          );
        }
        if (!response.ok || !response.body) {
          throw attachmentFailure("transient", "provider_file_download_unavailable");
        }
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader) {
          const contentLength = /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : Number.NaN;
          if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
            throw attachmentFailure("deterministic", "provider_file_content_length_invalid");
          }
          if (contentLength > maximumBytes) {
            throw attachmentFailure(
              "deterministic",
              "provider_file_size_exceeds_plan",
              null,
              "occurrence_local",
            );
          }
        }
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          yield chunk;
        }
      } catch (error) {
        if (error instanceof SlackInboundAttachmentError) throw error;
        throw attachmentFailure(
          controller.signal.aborted ? "transient" : "transient",
          controller.signal.aborted ? "provider_file_download_timeout" : "provider_file_download_unavailable",
        );
      } finally {
        clearClockTimeout(timeout);
        signal.removeEventListener("abort", abortFromCaller);
        providerAbortControllers.delete(controller);
        const releasedAt = now();
        await releaseCredentialLease(
          lease.authority.installId,
          lease.authority.credentialRevision,
          lease.leaseId,
          validDate(releasedAt) ? releasedAt : currentDate(),
        );
      }
    },
  };

  const createOutboundAttachmentTransport = async (
    handle: SlackBridgeCredentialHandle,
    attachmentAuthority: SlackProviderAuthorityFence,
  ): Promise<SlackOutboundAttachmentTransport | null> => {
    const lease = credentialLeases.get(handle.leaseId);
    const preparedAt = now();
    if (
      !lease
      || !sameHandle(handle, lease)
      || !sameAuthority(attachmentAuthority, lease.authority)
      || !validDate(preparedAt)
      || handle.leaseExpiresAt <= preparedAt
      || stopped
    ) return null;
    credentialLeases.delete(handle.leaseId);
    await releaseCredentialLease(
      lease.authority.installId,
      lease.authority.credentialRevision,
      lease.leaseId,
      preparedAt,
    );
    const fail = (
      failureClass: "rate_limited" | "transient" | "deterministic" | "outcome_unknown" | "authority_revoked",
      reason: string,
      retryAfterValue: number | null = null,
    ) => new SlackOutboundAttachmentError({
      class: failureClass,
      reason,
      retryAfterMs: retryAfterValue,
      scope: "occurrence_local",
    });
    const assertAuthority = (authority: ExternalAttachmentAuthority) => {
      const calledAt = now();
      if (
        !validDate(calledAt)
        || stopped
        || authority.provider !== "slack"
        || authority.installId !== lease.authority.installId
        || authority.workspaceId !== lease.authority.providerAuthorityId
        || authority.providerAuthorityId !== lease.authority.providerAuthorityId
        || authority.providerConversationId !== attachmentAuthority.providerConversationId
        || authority.connectionEpoch !== lease.authority.connectionEpoch
        || authority.bindingId !== attachmentAuthority.bindingId
        || authority.bindingEpoch !== attachmentAuthority.bindingEpoch
      ) throw fail("authority_revoked", "provider_attachment_authority_mismatch");
    };
    const authorizeProviderCall = async (authority: ExternalAttachmentAuthority): Promise<string> => {
      assertAuthority(authority);
      const requestedAt = now();
      if (!validDate(requestedAt)) throw fail("authority_revoked", "provider_attachment_authority_mismatch");
      const currentLease = await claimCredential({
        installId: attachmentAuthority.installId,
        providerAppId: attachmentAuthority.providerAppId,
        providerAuthorityId: attachmentAuthority.providerAuthorityId,
        connectionEpoch: attachmentAuthority.connectionEpoch,
        credentialRevision: attachmentAuthority.credentialRevision,
        binding: {
          bindingId: attachmentAuthority.bindingId,
          bindingEpoch: attachmentAuthority.bindingEpoch,
          providerConversationId: attachmentAuthority.providerConversationId,
        },
      }, requestedAt);
      if (!currentLease) throw fail("authority_revoked", "provider_attachment_authority_unavailable");
      await releaseCredentialLease(
        currentLease.authority.installId,
        currentLease.authority.credentialRevision,
        currentLease.leaseId,
        requestedAt,
      );
      return currentLease.accessToken;
    };
    const providerCall = async (
      authority: ExternalAttachmentAuthority,
      method: string,
      body: Record<string, unknown>,
    ) => {
      const accessToken = await authorizeProviderCall(authority);
      const response = await callWithToken({ method, body, accessToken });
      if (response.kind === "transport_failure") {
        throw fail(
          response.phase === "before_send" ? "transient" : "outcome_unknown",
          response.phase === "before_send" ? "provider_request_not_sent" : "provider_request_outcome_unknown",
        );
      }
      const error = nonEmpty(response.body.error, 160) ? response.body.error : null;
      if (response.status === 429) {
        throw fail("rate_limited", "provider_rate_limited", retryAfterMs(response.headers));
      }
      if (error && SLACK_AUTH_REVOKED_ERRORS.has(error)) {
        throw fail("authority_revoked", "provider_attachment_authority_revoked");
      }
      if (response.status < 200 || response.status >= 300 || response.body.ok !== true) {
        throw fail(
          error === "file_not_found" || error === "channel_not_found" || error === "missing_scope"
            ? "deterministic"
            : "transient",
          error === "file_not_found"
            ? "provider_file_not_found"
            : error === "channel_not_found"
              ? "provider_channel_not_found"
              : error === "missing_scope"
                ? "provider_file_scope_missing"
                : "provider_attachment_request_failed",
        );
      }
      return response.body;
    };
    return {
      async createUpload({ authority, asset }) {
        assertAuthority(authority);
        const body = await providerCall(authority, "files.getUploadURLExternal", {
          filename: asset.filename,
          length: asset.byteSize,
        });
        if (!nonEmpty(body.file_id, 320) || !nonEmpty(body.upload_url, 4096)) {
          throw fail("deterministic", "provider_upload_ticket_invalid");
        }
        return { providerFileId: body.file_id, uploadUrl: body.upload_url };
      },
      async upload({ authority, uploadUrl, bytes, expectedByteSize, expectedContentDigest, signal }) {
        await authorizeProviderCall(authority);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        providerAbortControllers.add(controller);
        const timeout = setClockTimeout(() => controller.abort(), attachmentDownloadTimeoutMs);
        let byteSize = 0;
        const hash = createHash("sha256");
        const verified = async function* () {
          for await (const raw of bytes) {
            const chunk = Buffer.from(raw);
            byteSize += chunk.length;
            if (byteSize > expectedByteSize) throw fail("deterministic", "attachment_upload_size_mismatch");
            hash.update(chunk);
            yield chunk;
          }
          if (byteSize !== expectedByteSize) throw fail("deterministic", "attachment_upload_size_mismatch");
          if (hash.digest("hex") !== expectedContentDigest) {
            throw fail("deterministic", "attachment_upload_digest_mismatch");
          }
        };
        try {
          const response = await fetcher(uploadUrl, {
            method: "POST",
            body: Readable.from(verified()),
            redirect: "error",
            signal: controller.signal,
            duplex: "half",
          } as unknown as RequestInit & { duplex: "half" });
          if (!response.ok) {
            throw fail(
              response.status === 429 ? "rate_limited" : response.status >= 500 ? "outcome_unknown" : "deterministic",
              response.status === 429 ? "provider_upload_rate_limited" : "provider_upload_failed",
              response.status === 429 ? retryAfterMs(responseHeaders(response.headers)) : null,
            );
          }
          return { uploadedByteSize: byteSize, uploadedContentDigest: expectedContentDigest };
        } catch (error) {
          if (error instanceof SlackOutboundAttachmentError) throw error;
          throw fail(controller.signal.aborted ? "outcome_unknown" : "outcome_unknown", "provider_upload_outcome_unknown");
        } finally {
          clearClockTimeout(timeout);
          signal.removeEventListener("abort", abort);
          providerAbortControllers.delete(controller);
        }
      },
      async complete({ authority, completion }) {
        assertAuthority(authority);
        const body = await providerCall(authority, "files.completeUploadExternal", {
          files: completion.providerFileIds.map((id) => ({ id })),
          channel_id: completion.providerConversationId,
          ...(completion.providerRootThreadId ? { thread_ts: completion.providerRootThreadId } : {}),
          ...(completion.renderedText ? { initial_comment: completion.renderedText } : {}),
        });
        if (!Array.isArray(body.files)) throw fail("outcome_unknown", "provider_completion_receipt_invalid");
        const returnedIds = body.files.flatMap((file) => (
          record(file) && nonEmpty(file.id, 320) ? [file.id] : []
        )).sort();
        const expectedIds = [...completion.providerFileIds].sort();
        if (returnedIds.length !== expectedIds.length || returnedIds.some((id, index) => id !== expectedIds[index])) {
          throw fail("outcome_unknown", "provider_completion_file_set_mismatch");
        }
        return { kind: "accepted_pending_correlation" };
      },
      async correlate({ authority, correlation }) {
        assertAuthority(authority);
        const method = correlation.providerRootThreadId
          ? "conversations.replies"
          : "conversations.history";
        const body = await providerCall(authority, method, {
          channel: correlation.providerConversationId,
          ...(correlation.providerRootThreadId ? { ts: correlation.providerRootThreadId } : {}),
          limit: 100,
        });
        const expected = [...correlation.providerFileIds].sort();
        const matches = Array.isArray(body.messages) ? body.messages.flatMap((message) => {
          if (!record(message) || !nonEmpty(message.ts, 160) || !Array.isArray(message.files)) return [];
          const ids = message.files.flatMap((file) => (
            record(file) && nonEmpty(file.id, 320) ? [file.id] : []
          )).sort();
          return ids.length === expected.length && ids.every((id, index) => id === expected[index])
            ? [message.ts]
            : [];
        }) : [];
        if (matches.length === 0) return { kind: "pending" };
        if (matches.length !== 1) return { kind: "conflict", reason: "provider_file_set_correlation_ambiguous" };
        return { kind: "matched", providerMessageId: matches[0]! };
      },
      classify(error) {
        return error instanceof SlackOutboundAttachmentError
          ? error.failure
          : {
            class: "outcome_unknown",
            reason: "provider_attachment_io_exception",
            retryAfterMs: null,
            scope: "occurrence_local",
          };
      },
    };
  };

  const credentialResolver: SlackAudienceCredentialResolver = {
    async resolve({ authority, now: requestedAt }) {
      const lease = await claimCredential({
        installId: authority.installId,
        providerAppId: authority.providerAppId,
        providerAuthorityId: authority.providerAuthorityId,
        connectionEpoch: authority.connectionEpoch,
        credentialRevision: authority.credentialRevision,
        binding: {
          bindingId: authority.bindingId,
          bindingEpoch: authority.bindingEpoch,
          providerConversationId: authority.providerConversationId,
        },
      }, requestedAt);
      if (!lease) return null;
      credentialLeases.set(lease.leaseId, lease);
      return {
        schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
        leaseId: lease.leaseId,
        installId: authority.installId,
        providerAppId: authority.providerAppId,
        providerAuthorityId: authority.providerAuthorityId,
        connectionEpoch: authority.connectionEpoch,
        credentialRevision: authority.credentialRevision,
        leaseExpiresAt: lease.expiresAt,
      };
    },
  };

  const transport: SlackWebApiTransport = {
    evidence: "live",
    async call(request: SlackWebApiRequest): Promise<SlackWebApiTransportResult> {
      const lease = credentialLeases.get(request.credentialHandle.leaseId);
      credentialLeases.delete(request.credentialHandle.leaseId);
      if (!lease) return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      const calledAt = now();
      const releaseAt = validDate(calledAt) ? calledAt : currentDate();
      await releaseCredentialLease(
        lease.authority.installId,
        lease.authority.credentialRevision,
        lease.leaseId,
        releaseAt,
      );
      if (
        stopped
        || !validDate(calledAt)
        || lease.expiresAt <= calledAt
        || !sameAuthority(request.authority, lease.authority)
        || !sameHandle(request.credentialHandle, lease)
      ) return { kind: "transport_failure", phase: "before_send", code: "unavailable" };
      return callWithToken({
        method: request.method,
        body: request.body,
        accessToken: lease.accessToken,
      });
    },
  };

  const releaseCredential = async (handle: SlackBridgeCredentialHandle): Promise<void> => {
    const lease = credentialLeases.get(handle.leaseId);
    credentialLeases.delete(handle.leaseId);
    if (!lease || !sameHandle(handle, lease)) return;
    const releasedAt = now();
    await releaseCredentialLease(
      lease.authority.installId,
      lease.authority.credentialRevision,
      lease.leaseId,
      validDate(releasedAt) ? releasedAt : currentDate(),
    );
  };

  const quarantineSink: SlackProviderAuthorityQuarantineSink = {
    async quarantine(fence) {
      return db.transaction(async (tx) => {
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

  const provisioningCall = async (
    authority: SlackBridgeProvisioningProviderAuthority,
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackBridgeProvisioningProviderResult<Record<string, unknown>>> => {
    const result = await provisioningCallWithMetadata(authority, method, body);
    return result.kind === "fact"
      ? { kind: "fact", fact: result.fact.body }
      : result;
  };

  const provisioningCallWithMetadata = async (
    authority: SlackBridgeProvisioningProviderAuthority,
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackBridgeProvisioningProviderResult<{
    body: Record<string, unknown>;
    headers: Readonly<Record<string, string | undefined>>;
  }>> => {
    const lease = await claimCredential({
      installId: authority.installId,
      providerAppId: authority.providerAppId,
      providerAuthorityId: authority.providerAuthorityId,
      connectionEpoch: authority.connectionEpoch,
      credentialRevision: authority.credentialRevision,
    }, authority.now);
    if (!lease) return { kind: "unverified" };
    await releaseCredentialLease(
      lease.authority.installId,
      lease.authority.credentialRevision,
      lease.leaseId,
      authority.now,
    );
    if (
      stopped
      || lease.expiresAt <= authority.now
      || !exactProvisioningAuthority(authority, lease.authority)
    ) return { kind: "unverified" };
    const result = await callWithToken({ method, body, accessToken: lease.accessToken });
    if (result.kind !== "response") return { kind: "unverified" };
    const responseBody = result.body as Record<string, unknown>;
    if (result.status === 429 || result.status >= 500) return { kind: "unverified" };
    if (responseBody.ok !== true) return { kind: "failed" };
    return {
      kind: "fact",
      fact: { body: responseBody, headers: result.headers },
    };
  };

  const provisioningProvider: SlackBridgeProvisioningProvider = {
    async readInstallGrant(authority) {
      if (stopped || !validDate(authority.now)) return { kind: "unverified" };
      const auth = await provisioningCallWithMetadata(authority, "auth.test", {});
      if (auth.kind !== "fact") return auth;
      const observedTeamId = auth.fact.body.team_id;
      const observedBotUserId = auth.fact.body.user_id;
      const observedBotId = auth.fact.body.bot_id;
      const scopesHeader = auth.fact.headers["x-oauth-scopes"];
      if (
        observedTeamId !== authority.providerAuthorityId
        || observedBotUserId !== authority.botUserId
        || !nonEmpty(observedBotId, 160)
        || !nonEmpty(scopesHeader, 8_192)
      ) return { kind: "failed" };
      const grantedScopes = [...new Set(scopesHeader.split(",")
        .map((scope) => scope.trim())
        .filter((scope) => nonEmpty(scope, 160)))]
        .sort();
      if (grantedScopes.length === 0) return { kind: "unverified" };
      return {
        kind: "fact",
        fact: {
          // auth.test intentionally does not claim app identity. The provider
          // app is the durable install/credential authority that had to match
          // before the token lease was released for this call.
          providerAppId: authority.providerAppId,
          providerAuthorityId: observedTeamId,
          botUserId: observedBotUserId,
          providerBotId: observedBotId,
          grantedScopes,
        },
      };
    },

    async readWorkspace(authority) {
      if (stopped || !validDate(authority.now)) return { kind: "unverified" };
      const auth = await provisioningCall(authority, "auth.test", {});
      if (auth.kind !== "fact") return auth;
      const observedTeamId = auth.fact.team_id;
      const observedAppId = auth.fact.api_app_id;
      const observedBotUserId = auth.fact.user_id;
      if (
        observedTeamId !== authority.providerAuthorityId
        || (observedAppId !== undefined && observedAppId !== authority.providerAppId)
        || (observedBotUserId !== undefined && observedBotUserId !== authority.botUserId)
      ) return { kind: "failed" };
      const workspaceName = nonEmpty(auth.fact.team, 512) ? auth.fact.team : null;
      const channels = new Map<string, {
        id: string;
        name: string;
        privacyClass: "public" | "private";
        isMember: boolean;
      }>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
        const body: Record<string, unknown> = {
          exclude_archived: true,
          limit: 200,
          types: "public_channel,private_channel",
        };
        if (cursor) body.cursor = cursor;
        const response = await provisioningCall(authority, "conversations.list", body);
        if (response.kind !== "fact") return response;
        if (!Array.isArray(response.fact.channels)) return { kind: "unverified" };
        for (const item of response.fact.channels) {
          if (!record(item)) return { kind: "unverified" };
          if (item.is_archived === true) continue;
          if (!nonEmpty(item.id, 160) || !nonEmpty(item.name, 512)) {
            return { kind: "unverified" };
          }
          const privacyClass = item.is_private === true ? "private" as const : "public" as const;
          const isMember = item.is_member === true;
          const previous = channels.get(item.id);
          if (previous && (
            previous.name !== item.name
            || previous.privacyClass !== privacyClass
            || previous.isMember !== isMember
          )) {
            return { kind: "unverified" };
          }
          channels.set(item.id, { id: item.id, name: item.name, privacyClass, isMember });
        }
        const next = nextCursor(response.fact);
        if (next === undefined) return { kind: "unverified" };
        if (next === null) {
          return {
            kind: "fact",
            fact: {
              workspaceName,
              channels: [...channels.values()].sort((left, right) => left.id.localeCompare(right.id)),
            },
          };
        }
        if (seenCursors.has(next)) return { kind: "unverified" };
        seenCursors.add(next);
        cursor = next;
      }
      return { kind: "unverified" };
    },

    async readConversationAudience(authority) {
      if (
        stopped
        || !validDate(authority.now)
        || !nonEmpty(authority.providerConversationId, 160)
      ) return { kind: "unverified" };
      const providerMemberIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let completed = false;
      for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
        const body: Record<string, unknown> = {
          channel: authority.providerConversationId,
          limit: 200,
        };
        if (cursor) body.cursor = cursor;
        const response = await provisioningCall(authority, "conversations.members", body);
        if (response.kind !== "fact") return response;
        if (!Array.isArray(response.fact.members)) return { kind: "unverified" };
        for (const item of response.fact.members) {
          if (!nonEmpty(item, 160)) return { kind: "unverified" };
          providerMemberIds.add(item);
        }
        const next = nextCursor(response.fact);
        if (next === undefined) return { kind: "unverified" };
        if (next === null) {
          completed = true;
          break;
        }
        if (seenCursors.has(next)) return { kind: "unverified" };
        seenCursors.add(next);
        cursor = next;
      }
      if (!completed) return { kind: "unverified" };

      const users: SlackBridgeProvisioningProviderUser[] = [];
      const observableMemberIds = [...providerMemberIds]
        .filter((providerUserId) => providerUserId !== authority.botUserId)
        .sort();
      if (observableMemberIds.length === 0 || observableMemberIds.length > 500) {
        return { kind: "unverified" };
      }
      for (const providerUserId of observableMemberIds) {
        const response = await provisioningCall(authority, "users.info", { user: providerUserId });
        if (response.kind !== "fact") return response;
        if (!record(response.fact.user) || response.fact.user.id !== providerUserId) {
          return { kind: "failed" };
        }
        const profile = record(response.fact.user.profile) ? response.fact.user.profile : {};
        const displayName = nonEmpty(profile.display_name, 512)
          ? profile.display_name
          : nonEmpty(profile.real_name, 512)
            ? profile.real_name
            : nonEmpty(response.fact.user.name, 512)
              ? response.fact.user.name
              : providerUserId;
        const handle = nonEmpty(response.fact.user.name, 512) ? response.fact.user.name : null;
        const actorKind = response.fact.user.is_bot === true || response.fact.user.is_app_user === true
          ? "remote" as const
          : response.fact.user.is_restricted === true || response.fact.user.is_ultra_restricted === true
            ? "guest" as const
            : "human" as const;
        const avatarLocator = slackProfileAvatarLocator(profile);
        users.push({ id: providerUserId, displayName, handle, actorKind, avatarLocator });
      }
      return {
        kind: "fact",
        fact: {
          providerMemberIds: [...providerMemberIds].sort(),
          users,
        },
      };
    },
  };

  return {
    credentialResolver,
    transport,
    inboundAttachmentTransport,
    createOutboundAttachmentTransport,
    quarantineSink,
    releaseCredential,
    provisioningProvider,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const controller of providerAbortControllers) controller.abort();
      const leases = [...credentialLeases.values()];
      credentialLeases.clear();
      const stoppedAt = now();
      if (!validDate(stoppedAt)) return;
      await Promise.all(leases.map((lease) => releaseCredentialLease(
        lease.authority.installId,
        lease.authority.credentialRevision,
        lease.leaseId,
        stoppedAt,
      )));
    },
  };
}
