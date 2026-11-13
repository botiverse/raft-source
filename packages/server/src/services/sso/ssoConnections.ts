/**
 * A Server's SSO connection (rfcs/083-server-sso.md §4): its configuration,
 * sealed OIDC client secret and sign-in rules.
 *
 * Draft and live: a connection that signs no one in yet (`draft`) or any
 * more (`disabled`) is edited in place. An `active` connection keeps its live
 * `config` while an edit waits in `draft_config` until a test sign-in passes
 * (RFC 083 §4), so an edit can never lock the company out. The display name
 * and the rules are not sign-in configuration and apply at once.
 */
import { randomUUID, X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { serverSsoConnections } from "../../db/schema";
import { getServerUrl } from "../socialAuthService";
import { isSealedUnderCurrentKey, resealSsoClientSecret, sealSsoClientSecret } from "./ssoConnectionSecret";
import { entraTenantOf } from "./ssoOidc";
import type { OidcConnectionConfig, SamlConnectionConfig, SsoConnectionConfig } from "./ssoConnectionConfig";

export type ServerSsoConnectionRow = typeof serverSsoConnections.$inferSelect;

export const SSO_SESSION_MAX_AGE_DAYS_MIN = 1;
export const SSO_SESSION_MAX_AGE_DAYS_MAX = 30;
const MAX_DISPLAY_NAME = 80;
const MAX_TEXT = 2048;
const MAX_CERTIFICATES = 2;

export class SsoConnectionInputError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "SsoConnectionInputError";
  }
}

/** Local IdPs (a developer's Keycloak) may use http only when this is set. */
function allowsHttpIdp(env: NodeJS.ProcessEnv): boolean {
  return env.RAFT_SSO_ALLOW_HTTP_IDP === "1" && env.NODE_ENV !== "production";
}

function requiredText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) throw new SsoConnectionInputError(field, `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new SsoConnectionInputError(field, `${field} is too long`);
  return trimmed;
}

function idpUrl(value: unknown, field: string, env: NodeJS.ProcessEnv, options: { allowQuery: boolean }): string {
  const text = requiredText(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SsoConnectionInputError(field, `${field} must be a URL`);
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && allowsHttpIdp(env));
  if (!secure) throw new SsoConnectionInputError(field, `${field} must use https`);
  if (url.username || url.password || url.hash) throw new SsoConnectionInputError(field, `${field} must not contain credentials or a fragment`);
  if (!options.allowQuery && url.search) throw new SsoConnectionInputError(field, `${field} must not contain a query`);
  // Stored as typed: OIDC compares the issuer exactly (Auth0's ends in "/"),
  // and a SAML SSO URL with or without its trailing "/" is another endpoint.
  return text;
}

const MAX_CERTIFICATE_CHARS = 16 * 1024;

/** A PEM certificate (or its bare base64 body), normalised to PEM; refuses anything X509 cannot parse. */
export function normalizeIdpCertificate(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SsoConnectionInputError("idpCertificates", "A certificate is empty");
  if (raw.length > MAX_CERTIFICATE_CHARS) throw new SsoConnectionInputError("idpCertificates", "A certificate is too large");
  const body = raw
    .replace(/-----BEGIN CERTIFICATE-----/gu, "")
    .replace(/-----END CERTIFICATE-----/gu, "")
    .replace(/\s+/gu, "");
  if (!body || !/^[A-Za-z0-9+/]+=*$/u.test(body)) {
    throw new SsoConnectionInputError("idpCertificates", "A certificate is not PEM or base64");
  }
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/gu)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  try {
    new X509Certificate(pem);
  } catch {
    throw new SsoConnectionInputError("idpCertificates", "A certificate could not be read");
  }
  return pem;
}

/** Two first saves raced; the caller retries, which now edits the winner. */
export class SsoConnectionConflictError extends Error {
  constructor() {
    super("The SSO connection was created by another request; try again");
    this.name = "SsoConnectionConflictError";
  }
}

export type SsoConnectionInput = {
  config: SsoConnectionConfig;
  displayName: string;
  /** OIDC only; absent means "keep the stored one". */
  clientSecret: string | null;
};

export function parseSsoConnectionInput(body: unknown, env: NodeJS.ProcessEnv = process.env): SsoConnectionInput {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const displayName = requiredText(input.displayName, "displayName", MAX_DISPLAY_NAME);
  if (input.protocol === "oidc") {
    const config: OidcConnectionConfig = {
      protocol: "oidc",
      issuer: idpUrl(input.issuer, "issuer", env, { allowQuery: false }),
      clientId: requiredText(input.clientId, "clientId", 512),
    };
    if (entraTenantOf(config.issuer) === "multi") {
      throw new SsoConnectionInputError(
        "issuer",
        "Use your tenant's issuer (https://login.microsoftonline.com/<tenant-id>/v2.0), not common, organizations or consumers",
      );
    }
    // Not trimmed: a secret's edge whitespace may be part of it.
    const raw = input.clientSecret;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      throw new SsoConnectionInputError("clientSecret", "clientSecret must be a string");
    }
    if (typeof raw === "string" && Buffer.byteLength(raw, "utf8") > 4096) throw new SsoConnectionInputError("clientSecret", "clientSecret is too long");
    const clientSecret = typeof raw === "string" && raw.trim() ? raw : null;
    return { config, displayName, clientSecret };
  }
  if (input.protocol === "saml") {
    const certificates = Array.isArray(input.idpCertificates) ? input.idpCertificates : [];
    if (certificates.length < 1 || certificates.length > MAX_CERTIFICATES) {
      throw new SsoConnectionInputError("idpCertificates", `Provide 1 or ${MAX_CERTIFICATES} signing certificates`);
    }
    const config: SamlConnectionConfig = {
      protocol: "saml",
      idpEntityId: requiredText(input.idpEntityId, "idpEntityId"),
      idpSsoUrl: idpUrl(input.idpSsoUrl, "idpSsoUrl", env, { allowQuery: true }),
      idpCertificates: certificates.map(normalizeIdpCertificate),
      emailManagedByAdmins: input.emailManagedByAdmins === true,
    };
    if (input.clientSecret !== undefined && input.clientSecret !== null && input.clientSecret !== "") {
      throw new SsoConnectionInputError("clientSecret", "A SAML connection has no client secret");
    }
    return { config, displayName, clientSecret: null };
  }
  throw new SsoConnectionInputError("protocol", "protocol must be oidc or saml");
}

export async function getServerSsoConnection(serverId: string, executor: DatabaseExecutor = getDb()) {
  const [row] = await executor.select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, serverId));
  return row ?? null;
}

/**
 * Creates the Server's connection as a draft, or saves an edit: in place
 * while it signs no one in, as the draft while it is active. An OIDC
 * connection needs a client secret before it can be tested; an edit without
 * one keeps the stored secret when the protocol stays OIDC.
 */
export async function saveServerSsoConnection(
  input: { serverId: string; actorUserId: string; connection: SsoConnectionInput },
  executor: DatabaseExecutor = getDb(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ row: ServerSsoConnectionRow; created: boolean }> {
  const now = currentDate();
  const { config, displayName, clientSecret } = input.connection;
  const existing = await getServerSsoConnection(input.serverId, executor);
  const id = existing?.id ?? randomUUID();
  const sealed = clientSecret === null ? null : sealSsoClientSecret(clientSecret, { connectionId: id, serverId: input.serverId }, env);

  if (!existing) {
    if (config.protocol === "oidc" && sealed === null) {
      throw new SsoConnectionInputError("clientSecret", "clientSecret is required");
    }
    const [row] = await executor.insert(serverSsoConnections).values({
      id,
      serverId: input.serverId,
      protocol: config.protocol,
      status: "draft",
      displayName,
      config,
      clientSecretCiphertext: sealed,
      createdByUserId: input.actorUserId,
    }).onConflictDoNothing({ target: serverSsoConnections.serverId }).returning();
    if (row) return { row, created: true };
    // Another first save won the race: this one becomes an edit of it.
    throw new SsoConnectionConflictError();
  }

  if (existing.status !== "active") {
    // A stored secret follows only the same endpoint: a new issuer or client
    // id needs its own secret, or a test sign-in would hand the company's
    // secret to whatever issuer was typed (RFC 083 review).
    const keepSecret = sameOidcClient(config, existing.config) ? existing.clientSecretCiphertext : null;
    const secret = config.protocol === "oidc" ? sealed ?? keepSecret : null;
    if (config.protocol === "oidc" && secret === null) {
      throw new SsoConnectionInputError("clientSecret", "clientSecret is required");
    }
    const [row] = await executor.update(serverSsoConnections).set({
      protocol: config.protocol,
      displayName,
      config,
      clientSecretCiphertext: secret,
      draftConfig: null,
      draftClientSecretCiphertext: null,
      updatedAt: now,
    }).where(eq(serverSsoConnections.id, existing.id)).returning();
    return { row: row!, created: false };
  }

  // Active: the edit waits as the draft. Without a new secret it may keep
  // the draft's (same client as the draft) or the live one (same client as
  // live); any other issuer or client id needs its own.
  const keepsDraftSecret = existing.draftConfig !== null && existing.draftClientSecretCiphertext !== null
    && sameOidcClient(config, existing.draftConfig);
  const keepsLiveSecret = sameOidcClient(config, existing.config);
  if (config.protocol === "oidc" && sealed === null && !keepsDraftSecret && !keepsLiveSecret) {
    throw new SsoConnectionInputError("clientSecret", "clientSecret is required for a new issuer or client id");
  }
  const [row] = await executor.update(serverSsoConnections).set({
    displayName,
    draftConfig: config,
    // Null keeps the live secret when the draft is promoted; an edit of a
    // pending OIDC draft without a new secret keeps the draft's secret.
    draftClientSecretCiphertext: config.protocol !== "oidc"
      ? null
      : sealed ?? (keepsDraftSecret ? existing.draftClientSecretCiphertext : null),
    updatedAt: now,
  }).where(eq(serverSsoConnections.id, existing.id)).returning();
  return { row: row!, created: false };
}

/** Both OIDC with the same issuer and client id: the endpoint a stored secret belongs to. */
function sameOidcClient(next: SsoConnectionConfig, stored: SsoConnectionConfig | null): boolean {
  return next.protocol === "oidc" && stored?.protocol === "oidc"
    && next.issuer === stored.issuer && next.clientId === stored.clientId;
}

export type SsoRulesInput = { autoJoin?: boolean; required?: boolean; sessionMaxAgeDays?: number };

export function parseSsoRulesInput(body: unknown): SsoRulesInput {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rules: SsoRulesInput = {};
  if (input.required !== undefined) {
    if (typeof input.required !== "boolean") throw new SsoConnectionInputError("required", "required must be a boolean");
    rules.required = input.required;
  }
  if (input.autoJoin !== undefined) {
    if (typeof input.autoJoin !== "boolean") throw new SsoConnectionInputError("autoJoin", "autoJoin must be a boolean");
    rules.autoJoin = input.autoJoin;
  }
  if (input.sessionMaxAgeDays !== undefined) {
    const days = input.sessionMaxAgeDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < SSO_SESSION_MAX_AGE_DAYS_MIN || days > SSO_SESSION_MAX_AGE_DAYS_MAX) {
      throw new SsoConnectionInputError(
        "sessionMaxAgeDays",
        `sessionMaxAgeDays must be a whole number from ${SSO_SESSION_MAX_AGE_DAYS_MIN} to ${SSO_SESSION_MAX_AGE_DAYS_MAX}`,
      );
    }
    rules.sessionMaxAgeDays = days;
  }
  if (Object.keys(rules).length === 0) throw new SsoConnectionInputError("rules", "Nothing to change");
  return rules;
}

export async function updateServerSsoRules(connectionId: string, rules: SsoRulesInput, executor: DatabaseExecutor = getDb()) {
  const [row] = await executor.update(serverSsoConnections)
    .set({ ...rules, updatedAt: currentDate() })
    .where(eq(serverSsoConnections.id, connectionId))
    .returning();
  return row ?? null;
}

export async function deleteServerSsoConnection(serverId: string, executor: DatabaseExecutor = getDb()) {
  const [row] = await executor.delete(serverSsoConnections).where(eq(serverSsoConnections.serverId, serverId)).returning();
  return row ?? null;
}

/** What the IdP admin pastes on their side (RFC 083 §5.1). */
export function ssoServiceProviderDetails(connectionId: string) {
  const base = getServerUrl();
  return {
    oidcRedirectUri: `${base}/api/auth/sso/oidc/callback`,
    samlEntityId: `${base}/api/auth/sso/saml/metadata/${connectionId}`,
    samlAcsUrl: `${base}/api/auth/sso/saml/acs/${connectionId}`,
    samlMetadataUrl: `${base}/api/auth/sso/saml/metadata/${connectionId}`,
  };
}

function configView(config: SsoConnectionConfig) {
  if (config.protocol === "oidc") return { protocol: "oidc" as const, issuer: config.issuer, clientId: config.clientId };
  return {
    protocol: "saml" as const,
    idpEntityId: config.idpEntityId,
    idpSsoUrl: config.idpSsoUrl,
    emailManagedByAdmins: config.emailManagedByAdmins === true,
    idpCertificates: config.idpCertificates.map((pem) => {
      try {
        const certificate = new X509Certificate(pem);
        return { pem, subject: certificate.subject, notAfter: new Date(certificate.validTo).toISOString(), readable: true };
      } catch {
        // Validated on save; a stored one that no longer parses shows as such instead of failing the page.
        return { pem, subject: null, notAfter: null, readable: false };
      }
    }),
  };
}

/** Never includes a secret: only whether one is stored. */
export function serverSsoConnectionView(row: ServerSsoConnectionRow) {
  return {
    id: row.id,
    status: row.status,
    displayName: row.displayName,
    config: configView(row.config),
    hasClientSecret: row.clientSecretCiphertext !== null,
    draft: row.draftConfig
      ? { config: configView(row.draftConfig), replacesClientSecret: row.draftClientSecretCiphertext !== null }
      : null,
    rules: { autoJoin: row.autoJoin, required: row.required, sessionMaxAgeDays: row.sessionMaxAgeDays },
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    serviceProvider: ssoServiceProviderDetails(row.id),
  };
}

/**
 * Key rotation (docs/development/sso.md): re-seals every stored client
 * secret, live and draft, under the current key. Run once after moving the
 * old key to RAFT_SSO_SECRET_ENCRYPTION_KEY_PREVIOUS and before dropping it.
 * A secret no configured key opens is left as it is and counted.
 */
export async function resealServerSsoConnectionSecrets(): Promise<{ resealed: number; unreadable: number }> {
  const ids = await getDb().select({ id: serverSsoConnections.id }).from(serverSsoConnections);
  let resealed = 0;
  let unreadable = 0;
  for (const { id } of ids) {
    // One row at a time under FOR UPDATE: a secret saved meanwhile is never
    // overwritten by a re-seal of the one it replaced.
    const outcome = await getDb().transaction(async (tx) => {
      const [row] = await tx.select().from(serverSsoConnections).where(eq(serverSsoConnections.id, id)).for("update");
      if (!row) return { resealed: false, unreadable: 0 };
      const scope = { connectionId: row.id, serverId: row.serverId };
      const update: Partial<ServerSsoConnectionRow> = {};
      let unreadableHere = 0;
      for (const column of ["clientSecretCiphertext", "draftClientSecretCiphertext"] as const) {
        const envelope = row[column];
        if (!envelope || isSealedUnderCurrentKey(envelope)) continue;
        const next = resealSsoClientSecret(envelope, scope);
        if (next === null) unreadableHere += 1;
        else update[column] = next;
      }
      if (Object.keys(update).length > 0) {
        await tx.update(serverSsoConnections).set(update).where(eq(serverSsoConnections.id, row.id));
      }
      return { resealed: Object.keys(update).length > 0, unreadable: unreadableHere };
    });
    if (outcome.resealed) resealed += 1;
    unreadable += outcome.unreadable;
  }
  return { resealed, unreadable };
}
