import { createHash, createPublicKey, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { currentTimeMs, sanitizeAppLocalReturnPath } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { oauthTransactions, socialAuthCompletions, userAuthIdentities } from "../db/schema.js";
import { getAppUrl as getConfiguredOrDefaultAppUrl } from "../config/appUrl.js";
import { findExistingSocialLoginUser } from "./userService.js";

export type SocialAuthProvider = "google" | "github" | "apple";
export type SocialAuthMode = "login" | "link";
export type SocialAuthStateKind = "web" | "mobile";
export type MobileOAuthRequestStatus =
  | "pending_provider"
  | "provider_processing"
  | "provider_completed"
  | "completed"
  | "failed"
  | "expired";

export interface SocialAuthProviderConfig {
  id: SocialAuthProvider;
  label: string;
}

export interface SocialAuthProfile {
  provider: SocialAuthProvider;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface SocialAuthStatePayload {
  kind?: SocialAuthStateKind;
  provider: SocialAuthProvider;
  mode: SocialAuthMode;
  nonce: string;
  linkUserId?: string;
  returnTo?: string;
  mobileRequestId?: string;
  desktopNonce?: string;
}

interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
}

export interface SocialAuthCompletionResult {
  provider: SocialAuthProvider;
  mode: SocialAuthMode;
  intendedAction: SocialAuthMode;
  returnTo: string;
  providerUserId?: string;
  providerEmail?: string;
  providerDisplayName?: string;
  providerAvatarUrl?: string;
  userId?: string;
}

export interface MobileOAuthStartResult {
  requestId: string;
  authorizationUrl: string;
  returnUri: string;
  expiresAt: Date;
}

export interface NativeAppleMobileOAuthStartResult {
  requestId: string;
  requestToken: string;
  returnUri: string;
  expiresAt: Date;
}

export interface NativeAppleMobileOAuthAuthorizationResult {
  requestId: string;
  handoffCode: string;
  provider: "apple";
  mode: SocialAuthMode;
}

export interface MobileOAuthProviderCompletionResult {
  requestId: string;
  redirectUri: string;
  handoffCode?: string;
  error?: string;
}

export interface MobileOAuthCompletionResult {
  requestId: string;
  provider: SocialAuthProvider;
  mode: SocialAuthMode;
  returnUri: string;
  userId?: string;
  providerUserId?: string;
  providerEmail?: string;
  providerDisplayName?: string;
  providerAvatarUrl?: string;
}

export const SOCIAL_AUTH_PROVIDERS: SocialAuthProviderConfig[] = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
  { id: "apple", label: "Apple" },
];

const DEFAULT_MOBILE_OAUTH_RETURN_URIS = [
  "raft://oauth/callback",
  "raft-alpha://oauth/callback",
  "raft-beta://oauth/callback",
  "raft-debug://oauth/callback",
  // Transitional compatibility for clients shipped before the variant-specific
  // callback migration. Remove only after the minimum supported client no
  // longer emits this URI.
  "raft-dev://oauth/callback",
];

interface GoogleProfileResponse {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubProfileResponse {
  id: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface GitHubEmailResponse {
  email: string;
  verified: boolean;
  primary: boolean;
}

interface AppleTokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface AppleIdTokenPayload extends jwt.JwtPayload {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  nonce?: string;
}

interface NativeAppleRequestTokenPayload extends jwt.JwtPayload {
  kind?: "native_apple_ios";
  requestId?: string;
  mode?: SocialAuthMode;
  codeChallenge?: string;
  userId?: string;
}

type AppleJsonWebKey = Record<string, unknown> & { kid?: string };

interface AppleJwksResponse {
  keys?: AppleJsonWebKey[];
}

let applePublicKeyCache = {
  expiresAt: 0,
  keysByKid: new Map<string, string>(),
};

function requireStateSecret(): string {
  const secret = process.env.SOCIAL_AUTH_STATE_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("SOCIAL_AUTH_STATE_SECRET or JWT_SECRET must be configured");
  }
  return secret;
}

function requireNativeAppleStateSecret(): string {
  return process.env.NATIVE_APPLE_AUTH_STATE_SECRET || requireStateSecret();
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hashPkceVerifier(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function getConfiguredMobileReturnUris(): string[] {
  const configured = parseConfiguredMobileReturnUris(process.env.MOBILE_OAUTH_RETURN_URI);
  if (configured.length > 0) return configured;

  const legacyConfigured = parseConfiguredMobileReturnUris(process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS);
  if (legacyConfigured.length > 0) return legacyConfigured;

  return DEFAULT_MOBILE_OAUTH_RETURN_URIS;
}

function parseConfiguredMobileReturnUris(raw: string | undefined): string[] {
  return (raw || "").split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
}

function parseMobileReturnUrl(returnUri: string): URL {
  try {
    return new URL(returnUri);
  } catch {
    throw new Error("return_uri_not_allowed");
  }
}

function isDesktopLoopbackReturnUri(returnUri: string, url: URL): boolean {
  if (url.toString() !== returnUri) return false;
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return false;
  if (url.username || url.password || url.search || url.pathname !== "/auth/done") return false;

  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port < 1024 || port > 65535) return false;

  return /^#state=[A-Za-z0-9_-]{16,256}$/.test(url.hash);
}

function getDesktopNonceFromReturnUri(returnUri: string): string | undefined {
  const url = parseMobileReturnUrl(returnUri);
  if (!isDesktopLoopbackReturnUri(returnUri, url)) return undefined;
  return url.hash.slice("#state=".length);
}

export function validateMobileOAuthReturnUri(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("return_uri_not_allowed");
  }
  const returnUri = input.trim();
  const url = parseMobileReturnUrl(returnUri);
  if (!isDesktopLoopbackReturnUri(returnUri, url) && !getConfiguredMobileReturnUris().includes(returnUri)) {
    throw new Error("return_uri_not_allowed");
  }
  return returnUri;
}

function appendMobileOAuthReturnParams(returnUri: string, params: {
  provider: SocialAuthProvider;
  mode: SocialAuthMode;
  code?: string;
  error?: string;
}): string {
  const url = new URL(returnUri);
  url.searchParams.set("provider", params.provider);
  url.searchParams.set("mode", params.mode);
  if (params.code) url.searchParams.set("code", params.code);
  if (params.error) url.searchParams.set("error", params.error);
  return url.toString();
}

function getStoredMobileReturnUri(request: typeof oauthTransactions.$inferSelect): string {
  const returnUri = request.returnTo?.trim();
  if (!returnUri) {
    throw new Error("mobile_oauth_state_invalid");
  }
  parseMobileReturnUrl(returnUri);
  return returnUri;
}

function parseMobileOAuthMode(value: unknown): SocialAuthMode {
  if (value === "login" || value === "link") return value;
  throw new Error("mode must be login or link");
}

function parseRequiredBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} is too long`);
  }
  return normalized;
}

function assertS256CodeChallenge(value: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new Error("codeChallenge must be a PKCE S256 challenge");
  }
}

function getAppleClientId(): string {
  return process.env.APPLE_CLIENT_ID || process.env.APPLE_WEB_CLIENT_ID || "";
}

function getNativeAppleClientId(): string {
  return process.env.APPLE_IOS_CLIENT_ID || "";
}

function getApplePrivateKey(): string {
  return (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

function createGeneratedAppleClientSecret(clientId: string): string {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = getApplePrivateKey();
  if (!clientId || !teamId || !keyId || !privateKey) {
    throw new Error("Apple sign-in is not configured");
  }

  return jwt.sign({}, privateKey, {
    algorithm: "ES256",
    audience: "https://appleid.apple.com",
    expiresIn: "5m",
    issuer: teamId,
    keyid: keyId,
    subject: clientId,
  });
}

function createAppleClientSecret(): string {
  if (process.env.APPLE_CLIENT_SECRET) return process.env.APPLE_CLIENT_SECRET;
  return createGeneratedAppleClientSecret(getAppleClientId());
}

function createNativeAppleClientSecret(): string {
  if (process.env.APPLE_IOS_CLIENT_SECRET) return process.env.APPLE_IOS_CLIENT_SECRET;
  return createGeneratedAppleClientSecret(getNativeAppleClientId());
}

export function isNativeAppleSignInConfigured(): boolean {
  if (!getNativeAppleClientId()) return false;
  return !!process.env.APPLE_IOS_CLIENT_SECRET || (
    !!process.env.APPLE_TEAM_ID &&
    !!process.env.APPLE_KEY_ID &&
    !!getApplePrivateKey()
  );
}

function getStateCookieName(provider: SocialAuthProvider): string {
  return `slock_${provider}_oauth_nonce`;
}

function shouldUseSecureCookie(): boolean {
  return getServerUrl().startsWith("https://");
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((accumulator, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return accumulator;
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

export function buildStateCookie(provider: SocialAuthProvider, nonce: string): string {
  // Apple requires `form_post` whenever any scopes are requested. That
  // callback is a cross-site POST from appleid.apple.com, so a Lax cookie would
  // be withheld and every web login would fail the browser-bound nonce check.
  // Apple web return URLs must be HTTPS, which also lets us require Secure.
  const usesCrossSiteFormPost = provider === "apple";
  return serializeCookie(getStateCookieName(provider), nonce, {
    httpOnly: true,
    sameSite: usesCrossSiteFormPost ? "None" : "Lax",
    secure: usesCrossSiteFormPost || shouldUseSecureCookie(),
    path: `/api/auth/${provider}/callback`,
    maxAge: 10 * 60,
  });
}

export function clearStateCookie(provider: SocialAuthProvider): string {
  const usesCrossSiteFormPost = provider === "apple";
  return serializeCookie(getStateCookieName(provider), "", {
    httpOnly: true,
    sameSite: usesCrossSiteFormPost ? "None" : "Lax",
    secure: usesCrossSiteFormPost || shouldUseSecureCookie(),
    path: `/api/auth/${provider}/callback`,
    expires: new Date(0),
  });
}

export function readStateCookie(provider: SocialAuthProvider, cookieHeader: string | undefined): string | null {
  return parseCookieHeader(cookieHeader)[getStateCookieName(provider)] || null;
}

export function getServerUrl(): string {
  return (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, "");
}

export function getAppUrl(): string {
  return getConfiguredOrDefaultAppUrl();
}

export function sanitizeReturnTo(input: unknown): string {
  return sanitizeAppLocalReturnPath(input);
}

export function assertVerifiedSocialAuthProfile(profile: SocialAuthProfile): void {
  if (!profile.providerUserId || !profile.email) {
    throw new Error(`${profile.provider} profile is missing required identity fields`);
  }
  if (!profile.emailVerified) {
    throw new Error(`${profile.provider} account email is not verified`);
  }
}

export function createSocialAuthNonce(): string {
  return randomBytes(16).toString("hex");
}

export function signSocialAuthState(payload: SocialAuthStatePayload): string {
  return jwt.sign(payload, requireStateSecret(), {
    expiresIn: "10m",
    issuer: "slock-social-auth",
    audience: "social-auth-state",
  });
}

export function verifySocialAuthState(state: string): SocialAuthStatePayload {
  return jwt.verify(state, requireStateSecret(), {
    issuer: "slock-social-auth",
    audience: "social-auth-state",
  }) as SocialAuthStatePayload;
}

export function validateSocialAuthCallbackState(
  provider: SocialAuthProvider,
  stateToken: string,
  cookieHeader: string | undefined,
): { state: SocialAuthStatePayload & { mode: SocialAuthMode }; returnTo: string } {
  const state = verifySocialAuthState(stateToken);
  if ((state.kind ?? "web") !== "web") {
    throw new Error("Social sign-in browser state mismatch");
  }
  if (state.provider !== provider) {
    throw new Error("Social sign-in browser state mismatch");
  }
  if (state.mode !== "login" && state.mode !== "link") {
    throw new Error("Social sign-in browser state mismatch");
  }

  // Login flow starts as a top-level navigation, so we can require the nonce
  // cookie as an additional browser-state check. Link flow starts from a
  // cross-origin XHR in Settings, where modern browsers may not persist that
  // cookie consistently; the signed state token remains the source of truth.
  if (state.mode === "login") {
    const stateCookie = readStateCookie(provider, cookieHeader);
    if (!stateCookie || stateCookie !== state.nonce) {
      throw new Error("Social sign-in browser state mismatch");
    }
  }

  return {
    state: state as SocialAuthStatePayload & { mode: SocialAuthMode },
    returnTo: sanitizeReturnTo(state.returnTo),
  };
}

export async function createMobileOAuthStart(params: {
  provider: SocialAuthProvider;
  mode: unknown;
  returnUri: unknown;
  codeChallenge: unknown;
  userId?: string;
}): Promise<MobileOAuthStartResult> {
  const mode = parseMobileOAuthMode(params.mode);
  if (mode === "link" && !params.userId) {
    throw new Error("link mode requires authentication");
  }
  const returnUri = validateMobileOAuthReturnUri(params.returnUri);
  const codeChallenge = parseRequiredBoundedString(params.codeChallenge, "codeChallenge", 256);
  assertS256CodeChallenge(codeChallenge);

  const database = getDb();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const [request] = await database.insert(oauthTransactions).values({
    provider: params.provider,
    mode,
    intendedAction: mode,
    status: "pending_provider",
    codeChallenge,
    returnTo: returnUri,
    userId: params.userId ?? null,
    expiresAt,
  }).returning();

  const nonce = createSocialAuthNonce();
  const state = signSocialAuthState({
    kind: "mobile",
    provider: params.provider,
    mode,
    nonce,
    mobileRequestId: request.id,
    desktopNonce: getDesktopNonceFromReturnUri(returnUri),
  });

  return {
    requestId: request.id,
    authorizationUrl: buildAuthorizationUrl(params.provider, state, mode, nonce),
    returnUri,
    expiresAt,
  };
}

function signNativeAppleRequestToken(payload: {
  kind: "native_apple_ios";
  requestId: string;
  mode: SocialAuthMode;
  codeChallenge: string;
  userId?: string;
}): string {
  return jwt.sign(payload, requireNativeAppleStateSecret(), {
    algorithm: "HS256",
    expiresIn: "10m",
    issuer: "slock-native-apple-auth",
    audience: "native-apple-auth-request",
  });
}

function verifyNativeAppleRequestToken(token: unknown): NativeAppleRequestTokenPayload {
  const boundedToken = parseRequiredBoundedString(token, "requestToken", 4096);
  let payload: NativeAppleRequestTokenPayload;
  try {
    payload = jwt.verify(boundedToken, requireNativeAppleStateSecret(), {
      algorithms: ["HS256"],
      issuer: "slock-native-apple-auth",
      audience: "native-apple-auth-request",
    }) as NativeAppleRequestTokenPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("native_apple_request_expired");
    }
    throw new Error("native_apple_request_invalid");
  }
  if (
    payload.kind !== "native_apple_ios" ||
    !payload.requestId ||
    (payload.mode !== "login" && payload.mode !== "link") ||
    !payload.codeChallenge
  ) {
    throw new Error("native_apple_request_invalid");
  }
  assertS256CodeChallenge(payload.codeChallenge);
  return payload;
}

export async function createNativeAppleMobileOAuthStart(params: {
  mode: unknown;
  returnUri: unknown;
  codeChallenge: unknown;
  userId?: string;
}): Promise<NativeAppleMobileOAuthStartResult> {
  const mode = parseMobileOAuthMode(params.mode);
  if (mode === "link" && !params.userId) {
    throw new Error("link mode requires authentication");
  }
  const returnUri = validateMobileOAuthReturnUri(params.returnUri);
  const codeChallenge = parseRequiredBoundedString(params.codeChallenge, "codeChallenge", 256);
  assertS256CodeChallenge(codeChallenge);

  const database = getDb();
  const expiresAt = new Date(currentTimeMs() + 10 * 60 * 1000);
  const [request] = await database.insert(oauthTransactions).values({
    provider: "apple",
    mode,
    intendedAction: mode,
    status: "pending_provider",
    codeChallenge,
    returnTo: returnUri,
    userId: params.userId ?? null,
    expiresAt,
  }).returning();

  return {
    requestId: request.id,
    requestToken: signNativeAppleRequestToken({
      kind: "native_apple_ios",
      requestId: request.id,
      mode,
      codeChallenge,
      userId: params.userId,
    }),
    returnUri,
    expiresAt,
  };
}

async function loadMobileOAuthRequest(id: string) {
  const database = getDb();
  const [request] = await database.select().from(oauthTransactions).where(eq(oauthTransactions.id, id)).limit(1);
  return request;
}

async function markMobileOAuthRequestTerminal(
  id: string,
  status: Extract<MobileOAuthRequestStatus, "failed" | "expired">,
) {
  const database = getDb();
  await database.update(oauthTransactions).set({
    status,
  }).where(and(
    eq(oauthTransactions.id, id),
    eq(oauthTransactions.status, "pending_provider"),
  ));
}

function classifyMobileOAuthProviderFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (message.includes("email already exists")) {
    return "account_conflict";
  }
  if (message.includes("Registration is currently disabled")) {
    return "registration_disabled";
  }
  return "provider_exchange_failed";
}

export async function completeMobileOAuthProviderCallback(params: {
  provider: SocialAuthProvider;
  state: SocialAuthStatePayload;
  providerCode?: string;
  providerError?: string;
}): Promise<MobileOAuthProviderCompletionResult> {
  if (params.state.kind !== "mobile" || params.state.provider !== params.provider || !params.state.mobileRequestId) {
    throw new Error("mobile_oauth_state_invalid");
  }
  const request = await loadMobileOAuthRequest(params.state.mobileRequestId);
  if (!request || request.provider !== params.provider || request.mode !== params.state.mode) {
    throw new Error("mobile_oauth_state_invalid");
  }
  if (!request.codeChallenge) {
    throw new Error("mobile_oauth_state_invalid");
  }
  const returnUri = getStoredMobileReturnUri(request);
  const expectedDesktopNonce = getDesktopNonceFromReturnUri(returnUri);
  if (expectedDesktopNonce !== (params.state.desktopNonce || undefined)) {
    throw new Error("mobile_oauth_state_invalid");
  }

  if (request.expiresAt < new Date()) {
    await markMobileOAuthRequestTerminal(request.id, "expired");
    return {
      requestId: request.id,
      redirectUri: appendMobileOAuthReturnParams(returnUri, { provider: params.provider, mode: request.mode, error: "expired" }),
      error: "expired",
    };
  }
  if (request.status !== "pending_provider") {
    return {
      requestId: request.id,
      redirectUri: appendMobileOAuthReturnParams(returnUri, { provider: params.provider, mode: request.mode, error: "request_not_pending" }),
      error: "request_not_pending",
    };
  }
  if (!params.providerCode) {
    const error = params.providerError || "provider_cancelled";
    await markMobileOAuthRequestTerminal(request.id, "failed");
    return {
      requestId: request.id,
      redirectUri: appendMobileOAuthReturnParams(returnUri, { provider: params.provider, mode: request.mode, error }),
      error,
    };
  }

  let profile: SocialAuthProfile;
  let existingUser = null as Awaited<ReturnType<typeof findExistingSocialLoginUser>> | null;
  try {
    const { accessToken } = await exchangeProviderCode(params.provider, params.providerCode);
    profile = await fetchSocialAuthProfile(params.provider, accessToken, params.state.nonce);
    assertVerifiedSocialAuthProfile(profile);
    existingUser = request.mode === "login" ? await findExistingSocialLoginUser(profile) : null;
  } catch (err) {
    const error = classifyMobileOAuthProviderFailure(err);
    await markMobileOAuthRequestTerminal(request.id, "failed");
    return {
      requestId: request.id,
      redirectUri: appendMobileOAuthReturnParams(returnUri, { provider: params.provider, mode: request.mode, error }),
      error,
    };
  }
  const handoffCode = randomBytes(32).toString("hex");
  const codeHash = hashValue(handoffCode);

  const database = getDb();
  await database.update(oauthTransactions).set({
    status: "provider_completed",
    codeHash,
    userId: request.mode === "link" ? request.userId : existingUser?.id ?? null,
    providerUserId: profile.providerUserId,
    providerEmail: profile.email,
    providerDisplayName: profile.displayName ?? null,
    providerAvatarUrl: profile.avatarUrl ?? null,
  }).where(and(
    eq(oauthTransactions.id, request.id),
    eq(oauthTransactions.status, "pending_provider"),
  ));

  return {
    requestId: request.id,
    handoffCode,
    redirectUri: appendMobileOAuthReturnParams(returnUri, { provider: params.provider, mode: request.mode, code: handoffCode }),
  };
}

export async function completeNativeAppleMobileOAuthAuthorization(params: {
  requestId: unknown;
  requestToken: unknown;
  authorizationCode: unknown;
  identityToken: unknown;
  authenticatedUserId?: string;
}): Promise<NativeAppleMobileOAuthAuthorizationResult> {
  const requestId = parseRequiredBoundedString(params.requestId, "requestId", 128);
  const authorizationCode = parseRequiredBoundedString(params.authorizationCode, "authorizationCode", 4096);
  const identityToken = parseRequiredBoundedString(params.identityToken, "identityToken", 16384);
  const requestToken = verifyNativeAppleRequestToken(params.requestToken);
  if (requestToken.requestId !== requestId) {
    throw new Error("native_apple_request_invalid");
  }

  const request = await loadMobileOAuthRequest(requestId);
  if (
    !request ||
    request.provider !== "apple" ||
    request.mode !== requestToken.mode ||
    !request.codeChallenge ||
    request.codeChallenge !== requestToken.codeChallenge ||
    request.userId !== (requestToken.userId ?? null)
  ) {
    throw new Error("native_apple_request_invalid");
  }
  getStoredMobileReturnUri(request);
  if (request.mode === "link") {
    if (!params.authenticatedUserId) {
      throw new Error("native_apple_auth_required");
    }
    if (!request.userId || request.userId !== params.authenticatedUserId) {
      throw new Error("native_apple_link_user_mismatch");
    }
  }
  if (request.expiresAt.getTime() < currentTimeMs()) {
    await markMobileOAuthRequestTerminal(request.id, "expired");
    throw new Error("native_apple_request_expired");
  }
  if (request.status !== "pending_provider") {
    throw new Error("native_apple_request_consumed");
  }

  const database = getDb();
  const [claimed] = await database.update(oauthTransactions).set({
    status: "provider_processing",
  }).where(and(
    eq(oauthTransactions.id, request.id),
    eq(oauthTransactions.status, "pending_provider"),
  )).returning({ id: oauthTransactions.id });
  if (!claimed) {
    throw new Error("native_apple_request_consumed");
  }

  try {
    const clientId = getNativeAppleClientId();
    if (!clientId || !isNativeAppleSignInConfigured()) {
      throw new Error("native_apple_not_configured");
    }
    const suppliedPayload = await verifyAppleIdToken(identityToken, clientId);
    const exchangedIdentityToken = await exchangeNativeAppleAuthorizationCode(authorizationCode);
    const exchangedPayload = await verifyAppleIdToken(exchangedIdentityToken, clientId);

    if (
      !suppliedPayload.sub ||
      !exchangedPayload.sub ||
      suppliedPayload.sub !== exchangedPayload.sub
    ) {
      throw new Error("native_apple_identity_mismatch");
    }
    if (
      suppliedPayload.nonce !== request.codeChallenge ||
      exchangedPayload.nonce !== request.codeChallenge
    ) {
      throw new Error("native_apple_nonce_mismatch");
    }

    const suppliedEmail = appleTokenEmail(suppliedPayload);
    const exchangedEmail = appleTokenEmail(exchangedPayload);
    if (
      suppliedEmail &&
      exchangedEmail &&
      suppliedEmail.toLowerCase() !== exchangedEmail.toLowerCase()
    ) {
      throw new Error("native_apple_identity_mismatch");
    }
    const email = suppliedEmail || exchangedEmail || await storedAppleIdentityEmail(suppliedPayload.sub);
    if (!email) {
      throw new Error("native_apple_email_required");
    }

    const profile: SocialAuthProfile = {
      provider: "apple",
      providerUserId: suppliedPayload.sub,
      email,
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    };
    assertVerifiedSocialAuthProfile(profile);
    const existingUser = request.mode === "login" ? await findExistingSocialLoginUser(profile) : null;
    const handoffCode = randomBytes(32).toString("hex");
    const codeHash = hashValue(handoffCode);

    const [completed] = await database.update(oauthTransactions).set({
      status: "provider_completed",
      codeHash,
      userId: request.mode === "link" ? request.userId : existingUser?.id ?? null,
      providerUserId: profile.providerUserId,
      providerEmail: profile.email,
      providerDisplayName: null,
      providerAvatarUrl: null,
    }).where(and(
      eq(oauthTransactions.id, request.id),
      eq(oauthTransactions.status, "provider_processing"),
    )).returning({ id: oauthTransactions.id });
    if (!completed) {
      throw new Error("native_apple_request_consumed");
    }

    return {
      requestId: request.id,
      handoffCode,
      provider: "apple",
      mode: request.mode,
    };
  } catch (error) {
    await database.update(oauthTransactions).set({
      status: "failed",
    }).where(and(
      eq(oauthTransactions.id, request.id),
      eq(oauthTransactions.status, "provider_processing"),
    ));
    throw error;
  }
}

function toMobileOAuthCompletionResult(request: typeof oauthTransactions.$inferSelect): MobileOAuthCompletionResult {
  if (request.mode !== "login" && request.mode !== "link") {
    throw new Error("handoff_code_invalid");
  }
  if (!request.codeChallenge) {
    throw new Error("handoff_code_invalid");
  }
  const returnUri = getStoredMobileReturnUri(request);
  return {
    requestId: request.id,
    provider: request.provider,
    mode: request.mode,
    returnUri,
    userId: request.userId ?? undefined,
    providerUserId: request.providerUserId ?? undefined,
    providerEmail: request.providerEmail ?? undefined,
    providerDisplayName: request.providerDisplayName ?? undefined,
    providerAvatarUrl: request.providerAvatarUrl ?? undefined,
  };
}

export async function getMobileOAuthCompletion(handoffCode: string, codeVerifier: string): Promise<MobileOAuthCompletionResult> {
  const database = getDb();
  const codeHash = hashValue(parseRequiredBoundedString(handoffCode, "handoffCode", 256));
  const verifier = parseRequiredBoundedString(codeVerifier, "codeVerifier", 256);
  const [request] = await database.select().from(oauthTransactions)
    .where(and(
      eq(oauthTransactions.codeHash, codeHash),
      isNotNull(oauthTransactions.codeChallenge),
    ))
    .limit(1);

  if (!request) {
    throw new Error("handoff_code_invalid");
  }
  if (request.status === "completed") {
    throw new Error("handoff_code_consumed");
  }
  if (request.status === "expired" || request.expiresAt < new Date()) {
    await database.update(oauthTransactions).set({ status: "expired" })
      .where(eq(oauthTransactions.id, request.id));
    throw new Error("handoff_code_expired");
  }
  if (request.status !== "provider_completed") {
    throw new Error("handoff_code_invalid");
  }
  if (hashPkceVerifier(verifier) !== request.codeChallenge) {
    await database.update(oauthTransactions).set({
      status: "failed",
    }).where(and(
      eq(oauthTransactions.id, request.id),
      eq(oauthTransactions.status, "provider_completed"),
    ));
    throw new Error("pkce_mismatch");
  }
  return toMobileOAuthCompletionResult(request);
}

export async function markMobileOAuthCompletionConsumed(requestId: string): Promise<void> {
  const database = getDb();
  const [updated] = await database.update(oauthTransactions).set({
    status: "completed",
  }).where(and(
    eq(oauthTransactions.id, requestId),
    eq(oauthTransactions.status, "provider_completed"),
  )).returning({ id: oauthTransactions.id });
  if (!updated) {
    throw new Error("handoff_code_consumed");
  }
}

export function getSocialAuthProvider(providerId: string): SocialAuthProviderConfig | null {
  return SOCIAL_AUTH_PROVIDERS.find((provider) => provider.id === providerId) || null;
}

export function isSocialAuthProviderConfigured(provider: SocialAuthProvider): boolean {
  switch (provider) {
    case "google":
      return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
    case "github":
      return !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET;
    case "apple":
      return !!getAppleClientId() && (
        !!process.env.APPLE_CLIENT_SECRET ||
        (!!process.env.APPLE_TEAM_ID && !!process.env.APPLE_KEY_ID && !!process.env.APPLE_PRIVATE_KEY)
      );
    default:
      return false;
  }
}

export function getSocialAuthRedirectUri(provider: SocialAuthProvider): string {
  switch (provider) {
    case "google":
      if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
      return `${getServerUrl()}/api/auth/google/callback`;
    case "github":
      if (process.env.GITHUB_REDIRECT_URI) return process.env.GITHUB_REDIRECT_URI;
      return `${getServerUrl()}/api/auth/github/callback`;
    case "apple":
      if (process.env.APPLE_REDIRECT_URI) return process.env.APPLE_REDIRECT_URI;
      return `${getServerUrl()}/api/auth/apple/callback`;
    default:
      throw new Error(`Unsupported social auth provider: ${provider satisfies never}`);
  }
}

export function buildAuthorizationUrl(
  provider: SocialAuthProvider,
  state: string,
  mode: SocialAuthMode,
  nonce: string,
): string {
  switch (provider) {
    case "google": {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        redirect_uri: getSocialAuthRedirectUri("google"),
        response_type: "code",
        scope: "openid email profile",
        state,
      });
      if (mode === "link") {
        params.set("prompt", "select_account");
      }
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }
    case "github": {
      const params = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID!,
        redirect_uri: getSocialAuthRedirectUri("github"),
        scope: "read:user user:email",
        state,
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    }
    case "apple": {
      const params = new URLSearchParams({
        client_id: getAppleClientId(),
        redirect_uri: getSocialAuthRedirectUri("apple"),
        response_type: "code",
        // Apple requires form_post when any scopes are requested.
        response_mode: "form_post",
        // Raft's required identity-setup step collects the user-chosen display
        // name, so do not request Apple's one-time name payload only to discard
        // it. Any requested scope still requires form_post.
        scope: "email",
        state,
        nonce,
      });
      return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
    }
    default:
      throw new Error(`Unsupported social auth provider: ${provider satisfies never}`);
  }
}

export async function exchangeProviderCode(provider: SocialAuthProvider, code: string): Promise<{ accessToken: string }> {
  switch (provider) {
    case "google": {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: getSocialAuthRedirectUri("google"),
          grant_type: "authorization_code",
        }),
      });

      if (!response.ok) {
        throw new Error(`Google token exchange failed (${response.status})`);
      }

      const data = await response.json() as { access_token?: string };
      if (!data.access_token) {
        throw new Error("Google token exchange returned no access token");
      }

      return { accessToken: data.access_token };
    }
    case "github": {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          client_id: process.env.GITHUB_CLIENT_ID!,
          client_secret: process.env.GITHUB_CLIENT_SECRET!,
          redirect_uri: getSocialAuthRedirectUri("github"),
        }),
      });

      if (!response.ok) {
        throw new Error(`GitHub token exchange failed (${response.status})`);
      }

      const data = await response.json() as GitHubTokenResponse;
      if (!data.access_token) {
        if (data.error_description) {
          throw new Error(`GitHub token exchange failed: ${data.error_description}`);
        }
        throw new Error("GitHub token exchange returned no access token");
      }

      return { accessToken: data.access_token };
    }
    case "apple": {
      const response = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          client_id: getAppleClientId(),
          client_secret: createAppleClientSecret(),
          redirect_uri: getSocialAuthRedirectUri("apple"),
          grant_type: "authorization_code",
        }),
      });

      if (!response.ok) {
        throw new Error(`Apple token exchange failed (${response.status})`);
      }

      const data = await response.json() as AppleTokenResponse;
      if (!data.id_token) {
        if (data.error_description) {
          throw new Error(`Apple token exchange failed: ${data.error_description}`);
        }
        throw new Error("Apple token exchange returned no identity token");
      }

      return { accessToken: data.id_token };
    }
    default:
      throw new Error(`Unsupported social auth provider: ${provider satisfies never}`);
  }
}

async function fetchGitHubPrimaryEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "slock-social-auth",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub email fetch failed (${response.status})`);
  }

  const emails = await response.json() as GitHubEmailResponse[];
  const primaryVerifiedEmail = emails.find((email) => email.primary && email.verified && !!email.email);
  if (!primaryVerifiedEmail) {
    throw new Error("GitHub account does not have a verified primary email");
  }

  return primaryVerifiedEmail.email;
}

async function getApplePublicKeysByKid(forceRefresh = false): Promise<Map<string, string>> {
  if (!forceRefresh && applePublicKeyCache.expiresAt > currentTimeMs()) {
    return applePublicKeyCache.keysByKid;
  }

  const response = await fetch("https://appleid.apple.com/auth/keys", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Apple public key fetch failed (${response.status})`);
  }

  const data = await response.json() as AppleJwksResponse;
  const keysByKid = new Map<string, string>();
  for (const jwk of data.keys ?? []) {
    if (!jwk.kid) continue;
    const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    keysByKid.set(jwk.kid, key.export({ format: "pem", type: "spki" }).toString());
  }
  applePublicKeyCache = {
    expiresAt: currentTimeMs() + 60 * 60 * 1000,
    keysByKid,
  };
  return keysByKid;
}

async function verifyAppleIdToken(
  idToken: string,
  audience: string = getAppleClientId(),
): Promise<AppleIdTokenPayload> {
  const decoded = jwt.decode(idToken, { complete: true });
  const kid = typeof decoded === "object" && decoded?.header && typeof decoded.header.kid === "string"
    ? decoded.header.kid
    : null;
  if (!kid) {
    throw new Error("Apple identity token is missing a key id");
  }

  let publicKey = (await getApplePublicKeysByKid()).get(kid);
  // Apple may rotate signing keys while our bounded cache is still warm. A
  // token returned directly by Apple's code exchange should get one refresh
  // before we reject an otherwise-new key id.
  if (!publicKey) {
    publicKey = (await getApplePublicKeysByKid(true)).get(kid);
  }
  if (!publicKey) {
    throw new Error("Apple identity token key is not recognized");
  }

  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ["RS256"],
    audience,
    issuer: "https://appleid.apple.com",
  }) as AppleIdTokenPayload;
  if (typeof payload.exp !== "number") {
    throw new Error("Apple identity token is missing an expiration");
  }
  return payload;
}

function appleTokenEmail(payload: AppleIdTokenPayload): string | null {
  const email = payload.email?.trim();
  if (!email) return null;
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new Error("native_apple_email_unverified");
  }
  return email;
}

async function exchangeNativeAppleAuthorizationCode(code: string): Promise<string> {
  const clientId = getNativeAppleClientId();
  if (!clientId || !isNativeAppleSignInConfigured()) {
    throw new Error("native_apple_not_configured");
  }
  const response = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: createNativeAppleClientSecret(),
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new Error("native_apple_code_exchange_failed");
  }
  const data = await response.json() as AppleTokenResponse;
  if (!data.id_token) {
    throw new Error("native_apple_code_exchange_failed");
  }
  return data.id_token;
}

async function storedAppleIdentityEmail(providerUserId: string): Promise<string | null> {
  const [identity] = await getDb().select({
    providerEmail: userAuthIdentities.providerEmail,
  }).from(userAuthIdentities).where(and(
    eq(userAuthIdentities.provider, "apple"),
    eq(userAuthIdentities.providerUserId, providerUserId),
  )).limit(1);
  return identity?.providerEmail?.trim() || null;
}

export async function fetchSocialAuthProfile(
  provider: SocialAuthProvider,
  accessToken: string,
  expectedNonce?: string,
): Promise<SocialAuthProfile> {
  switch (provider) {
    case "google": {
      const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`Google profile fetch failed (${response.status})`);
      }

      const profile = await response.json() as GoogleProfileResponse;
      return {
        provider: "google",
        providerUserId: profile.sub,
        email: profile.email,
        emailVerified: !!profile.email_verified,
        displayName: profile.name ?? null,
        avatarUrl: profile.picture ?? null,
      };
    }
    case "github": {
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "slock-social-auth",
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub profile fetch failed (${response.status})`);
      }

      const profile = await response.json() as GitHubProfileResponse;
      const email = await fetchGitHubPrimaryEmail(accessToken);
      return {
        provider: "github",
        providerUserId: String(profile.id),
        email,
        emailVerified: true,
        displayName: profile.name ?? profile.login ?? null,
        avatarUrl: profile.avatar_url ?? null,
      };
    }
    case "apple": {
      const profile = await verifyAppleIdToken(accessToken);
      if (!expectedNonce || profile.nonce !== expectedNonce) {
        throw new Error("Apple identity token nonce does not match the authorization request");
      }
      if (!profile.sub) {
        throw new Error("Apple identity token is missing a subject");
      }
      if (!profile.email) {
        throw new Error("Apple identity token is missing an email");
      }
      return {
        provider: "apple",
        providerUserId: profile.sub,
        email: profile.email,
        emailVerified: profile.email_verified === true || profile.email_verified === "true",
        displayName: null,
        avatarUrl: null,
      };
    }
    default:
      throw new Error(`Unsupported social auth provider: ${provider satisfies never}`);
  }
}

export async function createSocialAuthCompletion(params: {
  provider: SocialAuthProvider;
  mode: SocialAuthMode;
  intendedAction: SocialAuthMode;
  userId?: string;
  providerUserId?: string;
  providerEmail?: string;
  providerDisplayName?: string | null;
  providerAvatarUrl?: string | null;
  providerEmailVerified: boolean;
  returnTo?: string;
}): Promise<string> {
  assertVerifiedSocialAuthProfile({
    provider: params.provider,
    providerUserId: params.providerUserId ?? "",
    email: params.providerEmail ?? "",
    emailVerified: params.providerEmailVerified,
    displayName: params.providerDisplayName,
    avatarUrl: params.providerAvatarUrl,
  });

  const database = getDb();
  const code = randomBytes(32).toString("hex");
  const codeHash = hashValue(code);

  await cleanupExpiredSocialAuthCompletions();

  await database.insert(socialAuthCompletions).values({
    codeHash,
    provider: params.provider,
    mode: params.mode,
    intendedAction: params.intendedAction,
    status: "provider_completed",
    userId: params.userId ?? null,
    providerUserId: params.providerUserId ?? null,
    providerEmail: params.providerEmail ?? null,
    providerDisplayName: params.providerDisplayName ?? null,
    providerAvatarUrl: params.providerAvatarUrl ?? null,
    returnTo: sanitizeReturnTo(params.returnTo),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  return code;
}

function toSocialAuthCompletionResult(completion: typeof socialAuthCompletions.$inferSelect): SocialAuthCompletionResult {
  if (completion.mode !== "login" && completion.mode !== "link") {
    throw new Error("Social auth completion mode mismatch");
  }
  return {
    provider: completion.provider,
    mode: completion.mode,
    intendedAction: completion.intendedAction,
    returnTo: sanitizeReturnTo(completion.returnTo),
    userId: completion.userId ?? undefined,
    providerUserId: completion.providerUserId ?? undefined,
    providerEmail: completion.providerEmail ?? undefined,
    providerDisplayName: completion.providerDisplayName ?? undefined,
    providerAvatarUrl: completion.providerAvatarUrl ?? undefined,
  };
}

function validateSocialAuthCompletion(provider: SocialAuthProvider, completion: typeof socialAuthCompletions.$inferSelect | undefined) {
  if (!completion) {
    throw new Error("Invalid or expired social auth completion");
  }
  if (completion.codeChallenge) {
    throw new Error("Invalid or expired social auth completion");
  }
  if (completion.provider !== provider) {
    throw new Error("Social auth completion provider mismatch");
  }
  if (completion.expiresAt < new Date()) {
    throw new Error("Social auth completion expired");
  }
}

export async function getSocialAuthCompletion(provider: SocialAuthProvider, code: string): Promise<SocialAuthCompletionResult> {
  const database = getDb();
  const codeHash = hashValue(code);

  const [completion] = await database.select()
    .from(socialAuthCompletions)
    .where(and(
      eq(socialAuthCompletions.codeHash, codeHash),
      isNull(socialAuthCompletions.codeChallenge),
    ))
    .limit(1);

  validateSocialAuthCompletion(provider, completion);
  return toSocialAuthCompletionResult(completion);
}

export async function exchangeSocialAuthCompletion(provider: SocialAuthProvider, code: string): Promise<SocialAuthCompletionResult> {
  const database = getDb();
  const codeHash = hashValue(code);

  const [completion] = await database.delete(socialAuthCompletions)
    .where(and(
      eq(socialAuthCompletions.codeHash, codeHash),
      isNull(socialAuthCompletions.codeChallenge),
    ))
    .returning();

  validateSocialAuthCompletion(provider, completion);
  return toSocialAuthCompletionResult(completion);
}

export async function cleanupExpiredSocialAuthCompletions(): Promise<void> {
  const database = getDb();
  await database.delete(socialAuthCompletions).where(lt(socialAuthCompletions.expiresAt, new Date()));
}

export function buildSocialAuthCallbackUrl(params: {
  provider: SocialAuthProvider;
  mode: SocialAuthMode;
  returnTo?: string;
  code?: string;
  error?: string;
}): string {
  const url = new URL(getAppUrl());
  url.searchParams.set("auth_callback", "social");
  url.searchParams.set("provider", params.provider);
  url.searchParams.set("mode", params.mode);
  if (params.returnTo) url.searchParams.set("returnTo", params.returnTo);
  if (params.code) url.searchParams.set("code", params.code);
  if (params.error) url.searchParams.set("error", params.error);
  return url.toString();
}
