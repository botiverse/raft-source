/**
 * SSO sign-in over OIDC (rfcs/083-server-sso.md §5.1, §5.2, §5.6), mounted at
 * /api/auth/sso, unauthenticated, behind authLimiter. SAML joins in step 4.
 *
 * A leg: start (a transaction row, a state cookie, a redirect to the IdP) →
 * the IdP's callback (code exchanged, ID token checked, the verified profile
 * stored with a one-time completion code) → the client completes with that
 * code (POST /complete), where the person is resolved and the session issued
 * (services/sso/ssoSignIn.ts). Web legs return to APP_URL; app legs (desktop
 * loopback, mobile scheme) return to their validated return URI and must
 * present their PKCE verifier. An owner's test leg writes no person: it only
 * proves the connection works and then activates it or promotes its draft.
 *
 * The source-available edition has no SSO (edition.ts): every route here
 * answers 404 before it reads anything (refuseWithoutEnterpriseSso).
 */
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import { Router, urlencoded, type Request, type Response, type Router as RouterType } from "express";
import { createHash, hkdfSync } from "node:crypto";
import { openAesGcmEnvelope, sealAesGcmEnvelope } from "../services/aesGcmEnvelope";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { serverSsoConnections, serverSsoDomains, ssoIdentities } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { evaluateFeatureFlag, SERVER_SSO_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { recordIntegrationAuditEventBestEffort, recordIntegrationAuditEvent } from "../services/integrationAuditService";
import type { LegalAcceptanceInput } from "../services/legalAcceptanceService";
import { startSecondFactorSignIn } from "../services/secondFactor/signIn";
import { getAppUrl, getServerUrl, sanitizeReturnTo, validateMobileOAuthReturnUri } from "../services/socialAuthService";
import { normalizeEmail } from "../services/emailNormalization";
import { openSsoClientSecret } from "../services/sso/ssoConnectionSecret";
import type { OidcConnectionConfig, SsoConnectionConfig } from "../services/sso/ssoConnectionConfig";
import { normalizeSsoDomain } from "../services/sso/ssoDomains";
import { completeOidc, discoverOidc, oidcAuthorizationUrl } from "../services/sso/ssoOidc";
import { completeSaml, samlAuthorizeUrl, samlServiceProviderMetadata, SsoSamlError } from "../services/sso/ssoSaml";
import { autoJoinAfterSsoSignIn, completeSsoSignIn, type SsoProfile, type SsoSignInResult } from "../services/sso/ssoSignIn";
import {
  createSsoTransaction,
  finishSsoTransaction,
  claimSsoTransactionForCallback,
  ssoTransactionExists,
  storeSsoProfile,
  releaseSsoCompletion,
  setSsoTransactionSamlRequest,
  type SsoAuthTransaction,
  takeSsoCompletion,
  SSO_TRANSACTION_TTL_MS,
} from "../services/sso/ssoTransactions";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clientIpForRateLimit } from "../lib/clientIpForRateLimit";
import { serverMembers, servers } from "../db/schema";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import type { ServerRole } from "@botiverse/raft-shared";
import {
  clearCompletionBindingCookie,
  completionBindingCookie,
  completionIsBound,
  type CompletionBrowserBinding,
} from "../services/completionBrowserBinding";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { refuse } from "../lib/refusal";
import { enterpriseSsoAllowed } from "../edition";
import { EnterpriseSsoUnavailableError } from "../services/sso/ssoEdition";

/** A 404 for an edition without SSO (services/sso/ssoEdition.ts); false when the error is something else. */
export function enterpriseSsoUnavailableResponse(res: Response, err: unknown): boolean {
  if (!(err instanceof EnterpriseSsoUnavailableError)) return false;
  refuse(res, 404, { code: err.code, error: err.message });
  return true;
}

/**
 * Middleware ahead of every SSO route, sign-in (here) and settings
 * (serverSso.ts): an edition without SSO refuses before a body, code or
 * assertion is read.
 */
export function refuseWithoutEnterpriseSso(_req: Request, res: Response, next: () => void): void {
  if (!enterpriseSsoAllowed() && enterpriseSsoUnavailableResponse(res, new EnterpriseSsoUnavailableError())) return;
  next();
}

export const ssoRouter: RouterType = Router();
ssoRouter.use(refuseWithoutEnterpriseSso);

const STATE_COOKIE_PREFIX = "raft_sso_";
/** A web leg's completion code works only in the browser the IdP answered (login CSRF). */
const COMPLETION_BINDING: CompletionBrowserBinding = { prefix: "raft_sso_done_", completePath: "/api/auth/sso/complete" };
const CALLBACK_PATH = "/api/auth/sso/oidc/callback";
const START_TOKEN_SCHEMA = "raft.sso.start.v1";
const START_TOKEN_TTL_MS = 10 * 60 * 1000;

type ServerSsoConnectionRow = typeof serverSsoConnections.$inferSelect;
type StartToken = { cid: string; test?: { uid: string; draft: boolean } };

/** A key only for start links, derived from the server secret (HKDF). */
function startTokenKey(): Buffer {
  const secret = process.env.SOCIAL_AUTH_STATE_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for SSO");
  return Buffer.from(hkdfSync("sha256", secret, "raft-sso", "start-link-v1", 32));
}

/**
 * A short-lived link to start a leg. Encrypted, not just signed (Tenny
 * 9088ae1c): it names no Server and no connection, so two domains' links
 * cannot be compared to learn they belong to the same Server (RFC 083 §5.1).
 */
export function ssoStartUrl(token: StartToken): string {
  const t = sealAesGcmEnvelope({
    label: "SSO start link",
    schema: START_TOKEN_SCHEMA,
    // A fresh IV per seal: the same connection never yields the same link.
    plaintext: JSON.stringify({ ...token, exp: Date.now() + START_TOKEN_TTL_MS }),
    aad: { kind: "sso_start_link" },
    key: startTokenKey(),
    maxPlaintextBytes: 1024,
  });
  return `${getServerUrl()}/api/auth/sso/start?${new URLSearchParams({ t }).toString()}`;
}

function readStartToken(raw: unknown): StartToken | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const opened = openAesGcmEnvelope({ label: "SSO start link", envelope: raw, schema: START_TOKEN_SCHEMA, aad: { kind: "sso_start_link" }, key: startTokenKey(), maxBytes: 1024 });
  if (!opened) return null;
  try {
    const payload = JSON.parse(opened) as Partial<StartToken> & { exp?: unknown };
    if (typeof payload.cid !== "string" || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return { cid: payload.cid, ...(payload.test ? { test: payload.test } : {}) };
  } catch {
    return null;
  }
}

async function ssoEnabledFor(serverId: string): Promise<boolean> {
  return (await evaluateFeatureFlag({ key: SERVER_SSO_FEATURE_FLAG_KEY, serverId }).catch(() => ({ enabled: false }))).enabled;
}

function isSecure(): boolean {
  return getServerUrl().startsWith("https://");
}

/** One cookie per leg, named after its state, so two legs in one browser don't overwrite each other. */
function stateCookieName(state: string): string {
  return `${STATE_COOKIE_PREFIX}${createHash("sha256").update(state).digest("hex").slice(0, 16)}`;
}

function stateCookie(state: string, value: string, maxAgeSeconds: number, crossSitePost = false): string {
  // OIDC returns with a top-level GET (Lax is sent); SAML POSTs from the IdP's origin, which only a
  // SameSite=None cookie survives (it requires Secure; without https, a local setup keeps Lax).
  const sameSite = crossSitePost && isSecure() ? "None" : "Lax";
  return `${stateCookieName(state)}=${value}; Path=/api/auth/sso; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}${isSecure() ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** Who the IdP is: what an identity's subject is relative to. */
function idpIdentityOf(config: SsoConnectionConfig): string {
  return config.protocol === "oidc" ? `oidc:${config.issuer}` : `saml:${config.idpEntityId}`;
}

function legConfigOf(connection: ServerSsoConnectionRow, useDraft: boolean): { config: SsoConnectionConfig; secretCiphertext: string | null } {
  if (useDraft && connection.draftConfig) {
    return { config: connection.draftConfig, secretCiphertext: connection.draftClientSecretCiphertext ?? connection.clientSecretCiphertext };
  }
  return { config: connection.config, secretCiphertext: connection.clientSecretCiphertext };
}

/**
 * The IdP's discovered configuration, cached a few minutes per connection and
 * exact configuration (Tenny 9088ae1c): an unauthenticated /start no longer
 * costs an IdP round trip every time. Any edit changes the key.
 */
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; configuration: Promise<Awaited<ReturnType<typeof discoverOidc>>> }>();

export function clearSsoDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}

async function oidcConfigurationFor(connection: ServerSsoConnectionRow, useDraft: boolean) {
  const { config, secretCiphertext } = legConfigOf(connection, useDraft);
  if (config.protocol !== "oidc") throw new Error("SAML sign-in is not available yet");
  const key = `${connection.id}:${createHash("sha256").update(JSON.stringify(config)).update(secretCiphertext ?? "").digest("hex")}`;
  const cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.configuration;
  const secret = secretCiphertext ? openSsoClientSecret(secretCiphertext, { connectionId: connection.id, serverId: connection.serverId }) : null;
  if (!secret) throw new Error("The connection's client secret is unavailable");
  const configuration = discoverOidc(config as OidcConnectionConfig, secret);
  discoveryCache.set(key, { at: Date.now(), configuration });
  // A failed discovery is not remembered.
  configuration.catch(() => discoveryCache.delete(key));
  if (discoveryCache.size > 500) discoveryCache.delete(discoveryCache.keys().next().value!);
  return configuration;
}

function parseLegalAcceptance(raw: Record<string, unknown> | undefined): LegalAcceptanceInput {
  return {
    acceptTerms: raw?.acceptTerms === true,
    termsVersion: typeof raw?.termsVersion === "string" ? raw.termsVersion : undefined,
    privacyVersion: typeof raw?.privacyVersion === "string" ? raw.privacyVersion : undefined,
  };
}

function failWeb(res: Response, reason: string): void {
  res.redirect(`${getAppUrl()}?${new URLSearchParams({ auth_callback: "sso", error: reason }).toString()}`);
}

/**
 * Per address and normalized domain, on top of authLimiter (RFC 083 §5.6;
 * Tenny 9088ae1c): never a shared cap per domain, which one address or a
 * company's Monday morning would exhaust for everyone.
 */
const discoverDomainLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const raw = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const domain = normalizeSsoDomain(raw.slice(raw.lastIndexOf("@") + 1)) ?? "none";
    return `sso-discover:${ipKeyGenerator(clientIpForRateLimit(req))}:${domain}`;
  },
  message: { error: "Too many single sign-on lookups for this domain. Try again later." },
});

/** POST /discover { email }: the active connections for the email's domain, by display name only, each with an opaque start link. */
ssoRouter.post("/discover", discoverDomainLimiter, async (req, res) => {
  try {
    const raw = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
    const at = raw.lastIndexOf("@");
    const domain = at > 0 ? normalizeSsoDomain(raw.slice(at + 1)) : null;
    if (!domain) {
      res.json({ connections: [] });
      return;
    }
    const rows = await getDb().select({ id: serverSsoConnections.id, serverId: serverSsoConnections.serverId, displayName: serverSsoConnections.displayName })
      .from(serverSsoDomains)
      .innerJoin(serverSsoConnections, eq(serverSsoConnections.serverId, serverSsoDomains.serverId))
      .where(and(eq(serverSsoDomains.domain, domain), isNotNull(serverSsoDomains.verifiedAt), eq(serverSsoConnections.status, "active")));
    const connections: Array<{ displayName: string; startUrl: string }> = [];
    for (const row of rows) {
      if (await ssoEnabledFor(row.serverId)) connections.push({ displayName: row.displayName, startUrl: ssoStartUrl({ cid: row.id }) });
    }
    res.json({ connections });
  } catch (err) {
    console.error("[sso] discover failed:", serializeErrorForLog(err));
    res.status(500).json({ error: "Single sign-on lookup failed" });
  }
});

/** Starting a leg needs no login and writes a row: per address, on top of authLimiter. */
const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `sso-start:${ipKeyGenerator(clientIpForRateLimit(req))}`,
  handler: (_req, res) => failWeb(res, "sso_rate_limited"),
});

/** GET /servers/:serverId/start: the stable link a Server's admins hand out. */
ssoRouter.get("/servers/:serverId/start", startLimiter, async (req, res) => {
  const serverId = typeof req.params.serverId === "string" ? req.params.serverId : "";
  if (!/^[0-9a-f-]{36}$/iu.test(serverId)) {
    failWeb(res, "sso_unavailable");
    return;
  }
  const [connection] = await getDb().select({ id: serverSsoConnections.id }).from(serverSsoConnections)
    .where(and(eq(serverSsoConnections.serverId, serverId), eq(serverSsoConnections.status, "active")));
  if (!connection) {
    failWeb(res, "sso_unavailable");
    return;
  }
  await startLeg(req, res, { cid: connection.id });
});

/** GET /start?t=…[&returnTo][&returnUri&codeChallenge]: begins a leg at the IdP. */
ssoRouter.get("/start", startLimiter, async (req, res) => {
  const token = readStartToken(req.query.t);
  if (!token) {
    failWeb(res, "sso_link_expired");
    return;
  }
  await startLeg(req, res, token);
});

async function startLeg(req: Request, res: Response, token: StartToken): Promise<void> {
  try {
    const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.id, token.cid));
    const testing = !!token.test;
    if (!connection || !(await ssoEnabledFor(connection.serverId)) || (!testing && connection.status !== "active")) {
      failWeb(res, "sso_unavailable");
      return;
    }
    let appReturnUri: string | null = null;
    let appCodeChallenge: string | null = null;
    if (!testing && req.query.returnUri !== undefined) {
      try {
        appReturnUri = validateMobileOAuthReturnUri(req.query.returnUri);
      } catch {
        failWeb(res, "invalid_request");
        return;
      }
      appCodeChallenge = typeof req.query.codeChallenge === "string" && /^[A-Za-z0-9_-]{43}$/u.test(req.query.codeChallenge) ? req.query.codeChallenge : null;
      if (!appCodeChallenge) {
        failWeb(res, "invalid_request");
        return;
      }
    }
    const useDraft = testing && !!token.test?.draft;
    const { config } = legConfigOf(connection, useDraft);
    const configuration = config.protocol === "oidc" ? await oidcConfigurationFor(connection, useDraft) : null;
    const leg = await createSsoTransaction({
      connectionId: connection.id,
      kind: testing ? "test" : appReturnUri ? "app" : "web",
      usesDraft: testing && !!token.test?.draft,
      returnTo: testing ? null : sanitizeReturnTo(req.query.returnTo),
      appReturnUri,
      appCodeChallenge,
      testUserId: token.test?.uid ?? null,
    });
    if (config.protocol === "saml") {
      const request = await samlAuthorizeUrl({ connectionId: connection.id, config, relayState: leg.state, forceLogin: testing });
      await setSsoTransactionSamlRequest(leg.row.id, request.requestId);
      res.append("Set-Cookie", stateCookie(leg.state, leg.state, 600, true));
      res.redirect(request.url);
      return;
    }
    res.append("Set-Cookie", stateCookie(leg.state, leg.state, 600));
    res.redirect(oidcAuthorizationUrl(configuration!, {
      redirectUri: `${getServerUrl()}${CALLBACK_PATH}`,
      state: leg.state,
      nonce: leg.row.nonce,
      codeChallenge: leg.codeChallenge,
      forceLogin: testing,
    }).toString());
  } catch (err) {
    console.error("[sso] start failed:", serializeErrorForLog(err));
    failWeb(res, "sso_unavailable");
  }
}

/** GET /oidc/callback: the IdP's answer. */
ssoRouter.get("/oidc/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookie = state ? readCookie(req, stateCookieName(state)) : null;
  // The browser that started the leg must be the one finishing it (no login CSRF). Nothing is
  // cleared before the match, so a crafted callback cannot wipe a sign-in in progress.
  if (!state || !cookie || cookie !== state) {
    failWeb(res, "sso_state_mismatch");
    return;
  }
  res.append("Set-Cookie", stateCookie(state, "", 0));
  const idpRefused = typeof req.query.error === "string";
  await answerLeg(res, state, idpRefused, async (leg, connection) => {
    const configuration = await oidcConfigurationFor(connection, leg.usesDraft);
    // The registered redirect URI plus only the query the IdP sent (never the request's own path,
    // which a proxy or Express's case-insensitive routing may have changed).
    const callbackUrl = new URL(`${getServerUrl()}${CALLBACK_PATH}`);
    callbackUrl.search = new URL(req.originalUrl, "http://callback.invalid").search;
    const { config: legConfig } = legConfigOf(connection, leg.usesDraft);
    return completeOidc(configuration, {
      issuer: legConfig.protocol === "oidc" ? legConfig.issuer : "",
      callbackUrl,
      state,
      nonce: leg.nonce,
      codeVerifier: leg.codeVerifier,
    });
  });
});

/**
 * POST /saml/acs/:connectionId: the IdP's SAMLResponse. RelayState carries the
 * leg's state, and the leg's cookie must match. No RelayState, or one that
 * names no leg, is IdP-initiated: the response is never validated, and a
 * normal SP-initiated leg starts instead (RFC 083 §7). A RelayState that names
 * a leg without its cookie (another browser, or one that dropped the
 * cross-site cookie) is an error, never a new leg: that would loop forever
 * (review in #raft-architecture:102593c2).
 */
ssoRouter.post("/saml/acs/:connectionId", urlencoded({ extended: false, limit: "512kb" }), async (req, res) => {
  const connectionId = typeof req.params.connectionId === "string" ? req.params.connectionId : "";
  const state = typeof req.body?.RelayState === "string" ? req.body.RelayState : "";
  const cookie = state ? readCookie(req, stateCookieName(state)) : null;
  if (state && cookie !== state && await ssoTransactionExists(state)) {
    failWeb(res, cookie ? "sso_state_mismatch" : "sso_cookie_missing");
    return;
  }
  if (!state || cookie !== state) {
    const [connection] = /^[0-9a-f-]{36}$/iu.test(connectionId)
      ? await getDb().select({ id: serverSsoConnections.id }).from(serverSsoConnections)
        .where(and(eq(serverSsoConnections.id, connectionId), eq(serverSsoConnections.status, "active")))
      : [];
    if (!connection) {
      failWeb(res, "sso_unavailable");
      return;
    }
    // An opaque start link: the answer never reveals the Server (RFC 083 §5.1).
    res.redirect(303, ssoStartUrl({ cid: connectionId }));
    return;
  }
  res.append("Set-Cookie", stateCookie(state, "", 0, true));
  const samlResponse = typeof req.body?.SAMLResponse === "string" ? req.body.SAMLResponse : "";
  await answerLeg(res, state, !samlResponse, async (leg, connection) => {
    if (leg.connectionId !== connectionId) throw new Error("SAML response posted to another connection's ACS");
    const { config } = legConfigOf(connection, leg.usesDraft);
    if (config.protocol !== "saml") throw new Error("Not a SAML connection");
    return completeSaml({ connectionId: connection.id, legId: leg.id, config, samlResponse });
  });
});

/** GET /saml/metadata/:connectionId: the SP metadata an IdP admin imports (also the SP entity ID). */
ssoRouter.get("/saml/metadata/:connectionId", async (req, res) => {
  const connectionId = typeof req.params.connectionId === "string" ? req.params.connectionId : "";
  const [connection] = /^[0-9a-f-]{36}$/iu.test(connectionId)
    ? await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.id, connectionId))
    : [];
  const config = connection ? (connection.draftConfig?.protocol === "saml" ? connection.draftConfig : connection.config) : null;
  if (!connection || !config || config.protocol !== "saml" || !(await ssoEnabledFor(connection.serverId))) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  res.type("application/samlmetadata+xml").send(samlServiceProviderMetadata(connection.id, config));
});

type ProfileReader = (leg: SsoAuthTransaction, connection: ServerSsoConnectionRow) => Promise<SsoProfile>;

/**
 * What every IdP answer shares once its leg's state and cookie matched: the
 * leg is claimed once, the protocol reads the profile (outside any
 * transaction), then a test leg activates or promotes and writes no person,
 * and a sign-in leg stores the profile behind a one-time completion code.
 */
async function answerLeg(res: Response, state: string, idpRefused: boolean, readProfile: ProfileReader): Promise<void> {
  try {
    // Claimed once; a replayed answer finds nothing. The IdP is asked outside any transaction.
    const leg = await claimSsoTransactionForCallback(state);
    if (!leg) {
      failWeb(res, "sso_link_expired");
      return;
    }
    const fail = (reason: string) => {
      if (leg.appReturnUri) {
        const target = new URL(leg.appReturnUri);
        target.searchParams.set("error", reason);
        res.redirect(target.toString());
        return;
      }
      failWeb(res, reason);
    };
    const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.id, leg.connectionId));
    if (!connection) {
      await finishSsoTransaction(leg.id);
      fail("sso_unavailable");
      return;
    }
    if (!(await ssoEnabledFor(connection.serverId))) {
      await finishSsoTransaction(leg.id);
      if (leg.kind === "test") res.redirect(`${getAppUrl()}?${new URLSearchParams({ sso_test: "failed", server: connection.serverId }).toString()}`);
      else fail("sso_unavailable");
      return;
    }
    const testDone = (ok: boolean) => res.redirect(`${getAppUrl()}?${new URLSearchParams({ sso_test: ok ? "ok" : "failed", server: connection.serverId }).toString()}`);

    let profile: SsoProfile | null = null;
    let refusal: string | null = null;
    if (!idpRefused) {
      try {
        profile = await readProfile(leg, connection);
      } catch (err) {
        // Reason classes admins can act on (RFC 083 §7), never the assertion itself.
        if (err instanceof SsoSamlError) refusal = `saml_${err.code}`;
        console.error("[sso] IdP answer refused:", serializeErrorForLog(err));
      }
    }
    if (!profile) {
      await finishSsoTransaction(leg.id);
      await recordIntegrationAuditEventBestEffort({
        serverId: connection.serverId,
        eventType: "sso.sign_in_refused",
        outcome: "failure",
        source: leg.kind === "app" ? "api" : "web",
        actor: { type: "system" },
        target: { type: "sso_connection", id: connection.id },
        metadata: { connectionId: connection.id, reason: idpRefused ? "idp_refused" : refusal ?? (leg.kind === "test" ? "test_exchange_failed" : "exchange_failed") },
      });
      if (leg.kind === "test") testDone(false);
      else fail(idpRefused ? "idp_refused" : "idp_answer_refused");
      return;
    }

    if (leg.kind === "test") {
      // The connection works: the draft becomes live, a draft connection active. No person is written.
      const tested = await getDb().transaction(async (tx) => {
        const [current] = await tx.select().from(serverSsoConnections).where(eq(serverSsoConnections.id, connection.id)).for("update");
        if (!current) return false;
        // Who started the test must still hold manageSso when it lands: an owner by
        // membership, as POST /test checked and as require SSO exempts (not only servers.owner_id).
        const [membership] = leg.testUserId
          ? await tx.select({ role: serverMembers.role }).from(serverMembers).innerJoin(servers, eq(servers.id, serverMembers.serverId))
            .where(and(eq(serverMembers.serverId, current.serverId), eq(serverMembers.userId, leg.testUserId), isNull(servers.deletedAt)))
          : [];
        if (!actorRoleHasServerCapability((membership?.role ?? null) as ServerRole | null, "manageSso")) {
          await finishSsoTransaction(leg.id, tx);
          return false;
        }
        const now = currentDate();
        const update: Partial<ServerSsoConnectionRow> = { lastTestedAt: now, updatedAt: now };
        // Promote only the draft that was tested: one edited meanwhile waits for its own test.
        const promote = leg.usesDraft && current.draftConfig !== null
          && JSON.stringify(current.draftConfig) === JSON.stringify(connection.draftConfig)
          && current.draftClientSecretCiphertext === connection.draftClientSecretCiphertext;
        // A draft that points at another IdP (another issuer or entity id) must not inherit the people
        // linked to the old one: they re-link by verified email at their next sign-in (Tenny 9088ae1c).
        const sameIdp = promote && idpIdentityOf(current.config) === idpIdentityOf(current.draftConfig!);
        let identitiesCleared = 0;
        if (promote && !sameIdp) {
          identitiesCleared = (await tx.delete(ssoIdentities).where(eq(ssoIdentities.connectionId, current.id)).returning({ id: ssoIdentities.id })).length;
        }
        if (promote) {
          update.config = current.draftConfig!;
          update.protocol = current.draftConfig!.protocol;
          update.clientSecretCiphertext = current.draftClientSecretCiphertext ?? current.clientSecretCiphertext;
          update.draftConfig = null;
          update.draftClientSecretCiphertext = null;
        }
        const activate = !leg.usesDraft && current.status !== "active"
          && JSON.stringify(current.config) === JSON.stringify(connection.config);
        if (activate) update.status = "active";
        await tx.update(serverSsoConnections).set(update).where(eq(serverSsoConnections.id, current.id));
        await finishSsoTransaction(leg.id, tx);
        await recordIntegrationAuditEvent({
          serverId: current.serverId,
          eventType: "sso.connection_tested",
          outcome: "success",
          source: "web",
          actor: leg.testUserId ? { type: "human", id: leg.testUserId } : { type: "system" },
          target: { type: "sso_connection", id: current.id },
          metadata: { connectionId: current.id, promotedDraft: promote, activated: activate, identitiesCleared },
        }, tx);
        return true;
      });
      testDone(tested);
      return;
    }

    const code = await storeSsoProfile(leg.id, profile);
    if (leg.kind === "app") {
      const target = new URL(leg.appReturnUri!);
      target.searchParams.set("code", code);
      target.searchParams.set("provider", "sso");
      res.redirect(target.toString());
      return;
    }
    // The code completes only in this browser (login CSRF; an app leg has PKCE).
    res.append("Set-Cookie", completionBindingCookie(COMPLETION_BINDING, code, Math.floor(SSO_TRANSACTION_TTL_MS / 1000)));
    res.redirect(`${getAppUrl()}?${new URLSearchParams({ auth_callback: "sso", code, ...(leg.returnTo ? { returnTo: leg.returnTo } : {}) }).toString()}`);
  } catch (err) {
    console.error("[sso] callback failed:", serializeErrorForLog(err));
    failWeb(res, "sso_unavailable");
  }
}

/**
 * POST /complete { code, codeVerifier?, acceptTerms?, termsVersion?, privacyVersion? }:
 * the person is resolved and the session issued. Answers like a social
 * sign-in: tokens; or the second step; or 409 `legal_acceptance_required`
 * (the same code completes it with acceptance); or 403 with the refusal.
 */
ssoRouter.post("/complete", async (req, res) => {
  try {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const codeVerifier = typeof req.body?.codeVerifier === "string" ? req.body.codeVerifier : null;
    const browserBound = completionIsBound(COMPLETION_BINDING, req.headers.cookie, code);
    // A web code (no PKCE verifier) from another browser: refused before any
    // lookup, the same whether or not the code exists.
    if (!codeVerifier && !browserBound) {
      setRequestTraceErrorCode(res, "browser_mismatch");
      res.status(400).json({ error: "This sign-in could not be finished. Refresh the page and sign in again.", code: "browser_mismatch" });
      return;
    }
    const taken = code ? await takeSsoCompletion(code, { codeVerifier, browserBound }) : { ok: false as const, reason: "invalid_code" as const };
    if (!taken.ok) {
      if (browserBound) res.append("Set-Cookie", clearCompletionBindingCookie(COMPLETION_BINDING, code));
      setRequestTraceErrorCode(res, taken.reason);
      res.status(400).json({ error: "This sign-in has expired. Start again.", code: taken.reason });
      return;
    }
    const leg = taken.row;
    const legal = parseLegalAcceptance(req.body);
    const result = await completeSsoSignIn({
      connectionId: leg.connectionId,
      // A leg stored before linkByEmail existed links nothing by email.
      profile: { ...leg.profile, linkByEmail: leg.profile.linkByEmail ?? "none" },
      legalAcceptance: legal.acceptTerms ? legal : null,
      legalMetadata: { ipAddress: req.ip ?? null, userAgent: req.get("user-agent") ?? null },
    });
    if (result.kind === "refused" && result.reason === "legal_acceptance_required") {
      await releaseSsoCompletion(leg.id);
      setRequestTraceErrorCode(res, "legal_acceptance_required");
      res.status(409).json({ error: "Accept the terms to create your account.", code: "legal_acceptance_required" });
      return;
    }
    await finishSsoTransaction(leg.id);
    if (leg.kind === "web") res.append("Set-Cookie", clearCompletionBindingCookie(COMPLETION_BINDING, code));
    if (result.kind === "refused") {
      setRequestTraceErrorCode(res, result.reason);
      res.status(403).json({ error: "Single sign-on can't sign you in.", code: result.reason });
      return;
    }
    if (result.kind === "second_factor_required") {
      res.json(await startSecondFactorSignIn(result.userId, {
        flow: "sso_login",
        ssoConnectionId: result.connectionId,
        returnTo: leg.returnTo,
        codeChallenge: leg.appCodeChallenge,
        pendingLinkTokenHash: null,
      }));
      return;
    }
    await sendSsoSignIn(req, res, result, leg.returnTo);
  } catch (err) {
    console.error("[sso] complete failed:", serializeErrorForLog(err));
    res.status(500).json({ error: "Sign-in failed" });
  }
});

/** The success body of an SSO sign-in (first step or second): tokens, then auto-join (RFC 083 §6.1). */
export async function sendSsoSignIn(
  _req: Request,
  res: Response,
  signedIn: Extract<SsoSignInResult, { kind: "signed_in" }>,
  returnTo: string | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const accessToken = signAccessToken(signedIn.userId, signedIn.session.familyId);
  let joined: string = "off";
  try {
    joined = (await autoJoinAfterSsoSignIn(signedIn)).kind;
  } catch (err) {
    // The sign-in stands; joining is tried again at the next sign-in.
    console.error("[sso] auto-join failed:", serializeErrorForLog(err));
  }
  res.json({
    provider: "sso",
    mode: "login",
    returnTo,
    accessToken,
    refreshToken: signedIn.session.refreshToken,
    createdAccount: signedIn.createdAccount,
    joined,
    ...extra,
  });
}
