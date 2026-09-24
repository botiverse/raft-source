import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
import { Router, urlencoded, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import multer from "multer";
import { z } from "zod";
import * as userService from "../services/userService.js";
import * as sessionService from "../services/sessionService.js";
import * as inviteService from "../services/inviteService.js";
import * as onboardingService from "../services/onboardingService.js";
import * as serverService from "../services/serverService.js";
import * as featureFlagService from "../services/featureFlagService.js";
import * as legalAcceptanceService from "../services/legalAcceptanceService.js";
import * as serverAgreementService from "../services/serverAgreementService.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import {
  getBearerAccessUserId,
  signAccessToken,
  requireAuth,
  requireRetirementAuth,
  requireProfileSetupComplete,
  respondInvalidOrExpiredToken,
} from "../middleware/auth.js";
import { attachAuthTraceIdentity } from "../middleware/requestObservability.js";
import { recordEmailLoginRejectedTrace } from "./authLoginTrace.js";
import {
  authRefreshAttemptIdFromHeader,
  authRefreshInstallationIdFromHeader,
  recordAuthRefreshTrace,
  recordAuthSessionIssuedTrace,
} from "./authRefreshTrace.js";
import {
  isReservedAgentName,
  isSignupRoleId,
  REFERRAL_SOURCES,
  REFERRAL_SOURCES_LEGACY,
  normalizeTimeFormatPreference,
  normalizeTranslationLanguageCode,
  normalizeDisplayLocale,
  validateName,
  type TimeFormatPreference,
} from "@botiverse/raft-shared";
import { getRegistrationBlockedReason } from "../services/registrationPolicy.js";
import {
  createAvatarUpload,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
  runSingleAvatarUpload,
  storeUserAvatar,
} from "../services/avatarService.js";
import {
  assertVerifiedSocialAuthProfile,
  buildAuthorizationUrl,
  buildSocialAuthCallbackUrl,
  buildStateCookie,
  clearStateCookie,
  completeNativeAppleMobileOAuthAuthorization,
  completeMobileOAuthProviderCallback,
  createNativeAppleMobileOAuthStart,
  createMobileOAuthStart,
  createSocialAuthCompletion,
  createSocialAuthNonce,
  exchangeProviderCode,
  exchangeSocialAuthCompletion,
  fetchSocialAuthProfile,
  getMobileOAuthCompletion,
  getSocialAuthCompletion,
  getSocialAuthProvider,
  isNativeAppleSignInConfigured,
  isSocialAuthProviderConfigured,
  markMobileOAuthCompletionConsumed,
  readStateCookie,
  sanitizeReturnTo,
  signSocialAuthState,
  validateSocialAuthCallbackState,
  verifySocialAuthState,
} from "../services/socialAuthService.js";
import type { SocialAuthMode, SocialAuthProfile, SocialAuthProvider } from "../services/socialAuthService.js";

export const authRouter: RouterType = Router();
const MAX_USER_DESCRIPTION_LENGTH = 3000;
const MAX_PREFERRED_TIMEZONE_LENGTH = 128;
const userAvatarUpload = createAvatarUpload();
// Write-side validation accepts retired ids too (`hn_reddit`, before Hacker News and
// Reddit were split apart): an older client is still entitled to be understood.
const REFERRAL_SOURCE_OPTIONS = new Set<string>([
  ...REFERRAL_SOURCES.map((source) => source.id),
  ...REFERRAL_SOURCES_LEGACY.map((source) => source.id),
]);

const emailRegisterRequestSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  name: z.string().min(1).optional(),
  stagingSelfAccountCapability: z.string().min(32).max(256).optional(),
}).passthrough();

const completeProfileRequestSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().trim().min(1).max(80),
}).strict();

const emailLoginRequestSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
}).passthrough();

const timezoneObservationRequestSchema = z.object({
  timezone: z.string(),
}).strict();

type EmailRegisterRequest = z.infer<typeof emailRegisterRequestSchema>;
type EmailLoginRequest = z.infer<typeof emailLoginRequestSchema>;

function formatBodyIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function parseEmailRegisterRequest(rawBody: unknown, res: Response): EmailRegisterRequest | null {
  const parsed = emailRegisterRequestSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid email registration body",
      code: "email_register_body_invalid",
      issues: formatBodyIssues(parsed.error),
    });
    return null;
  }
  return parsed.data;
}

function parseEmailLoginRequest(rawBody: unknown, res: Response): EmailLoginRequest | null {
  const parsed = emailLoginRequestSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid email login body",
      code: "email_login_body_invalid",
      issues: formatBodyIssues(parsed.error),
    });
    return null;
  }
  return parsed.data;
}

function getProviderParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function getSocialAuthCallbackParam(req: Request, key: "code" | "error" | "state"): string {
  const value = req.method === "POST" ? req.body?.[key] : req.query[key];
  return typeof value === "string" ? value : "";
}

function errorMessage(err: unknown, fallback = ""): string {
  return err instanceof Error ? err.message : fallback;
}

function parsePreferredLanguage(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error("preferredLanguage must be a string or null");
  }
  const value = raw.trim();
  if (!value) return null;
  const normalized = normalizeTranslationLanguageCode(value);
  if (!normalized) {
    throw new Error("preferredLanguage must be a supported language tag");
  }
  return normalized;
}

function parseIanaTimezone(raw: string, fieldName: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`${fieldName} must be a non-empty IANA timezone`);
  }
  if (value.length > MAX_PREFERRED_TIMEZONE_LENGTH) {
    throw new Error(`${fieldName} must be at most 128 characters`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`${fieldName} must be an IANA timezone`);
  }
  return value;
}

function parseCanonicalBrowserTimezone(raw: string): string {
  const timezone = parseIanaTimezone(raw, "timezone");
  if (timezone !== "UTC" && !timezone.includes("/")) {
    throw new Error("timezone must be a canonical IANA timezone");
  }
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    .resolvedOptions().timeZone;
  if (canonical !== "UTC" && !canonical.includes("/")) {
    throw new Error("timezone must be a canonical IANA timezone");
  }
  return canonical;
}

// UI display language (app-chrome i18n). Validated against the DISPLAY locale
// taxonomy — the set the web app ships a catalog for (en | zh-cn) — NOT the
// message-translation taxonomy. Region/script variants normalize within a
// shipped base (en-US→en, zh-Hans→zh-cn); anything we cannot render (fr, zh-tw,
// …) is rejected so we never persist a preference that silently no-ops on read.
function parseDisplayLanguage(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error("displayLanguage must be a string or null");
  }
  const value = raw.trim();
  if (!value) return null;
  const normalized = normalizeDisplayLocale(value);
  if (!normalized) {
    throw new Error("displayLanguage must be a supported UI display locale");
  }
  return normalized;
}

function parsePreferredTimezone(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error("preferredTimezone must be a string or null");
  }
  const value = raw.trim();
  if (!value) return null;
  return parseIanaTimezone(value, "preferredTimezone");
}

function parseAutoTranslationEnabled(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new Error("autoTranslationEnabled must be a boolean");
  }
  return raw;
}

type PreferredTranslationDisplay = "translated" | "original" | "bilingual";
type PreferredTranslationMode = "auto" | "manual" | "off";

function parsePreferredTranslationMode(raw: unknown): PreferredTranslationMode | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error("preferredTranslationMode must be auto, manual, or off");
  }
  const value = raw.trim().toLowerCase();
  if (value !== "auto" && value !== "manual" && value !== "off") {
    throw new Error("preferredTranslationMode must be auto, manual, or off");
  }
  return value;
}

function parsePreferredTranslationDisplay(raw: unknown): PreferredTranslationDisplay | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error("preferredTranslationDisplay must be translated, original, or bilingual");
  }
  const value = raw.trim().toLowerCase();
  if (value !== "translated" && value !== "original" && value !== "bilingual") {
    throw new Error("preferredTranslationDisplay must be translated, original, or bilingual");
  }
  return value;
}

function parsePreferredTimeFormat(raw: unknown): TimeFormatPreference | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error("preferredTimeFormat must be 12h, 24h, or null");
  }
  const normalized = normalizeTimeFormatPreference(raw);
  if (!normalized) {
    throw new Error("preferredTimeFormat must be 12h, 24h, or null");
  }
  return normalized;
}

type MessageBodyFontSizePreference = "sm" | "md" | "lg";

function parsePreferredMessageBodyFontSize(raw: unknown): MessageBodyFontSizePreference | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error("preferredMessageBodyFontSize must be sm, md, lg, or null");
  }
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value !== "sm" && value !== "md" && value !== "lg") {
    throw new Error("preferredMessageBodyFontSize must be sm, md, lg, or null");
  }
  return value;
}

function parseLegalAcceptance(raw: any): legalAcceptanceService.LegalAcceptanceInput {
  return {
    acceptTerms: raw?.acceptTerms === true,
    termsVersion: typeof raw?.termsVersion === "string" ? raw.termsVersion : undefined,
    privacyVersion: typeof raw?.privacyVersion === "string" ? raw.privacyVersion : undefined,
  };
}

function parseEmailAccountCreationSource(raw: any): "signup" | "invite" {
  return raw?.legalAcceptanceSource === "invite" ? "invite" : "signup";
}

function parseSocialAccountCreationSource(raw: any): "oauth" | "invite" {
  return raw?.legalAcceptanceSource === "invite" ? "invite" : "oauth";
}

function getAgreementRequestMetadata(req: { ip?: string; get: (name: string) => string | undefined }) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

function socialProfileFromCompletion(provider: NonNullable<ReturnType<typeof getSocialAuthProvider>>, completion: {
  providerUserId?: string;
  providerEmail?: string;
  providerDisplayName?: string;
  providerAvatarUrl?: string;
}): SocialAuthProfile {
  if (!completion.providerUserId || !completion.providerEmail) {
    throw new Error(`${provider.label} sign-in is missing required identity fields`);
  }
  return {
    provider: provider.id,
    providerUserId: completion.providerUserId,
    email: completion.providerEmail,
    // Completion records are written only after the provider profile passes
    // assertVerifiedSocialAuthProfile. Do not persist unverified profiles.
    emailVerified: true,
    displayName: completion.providerDisplayName ?? null,
    avatarUrl: completion.providerAvatarUrl ?? null,
  };
}

async function isSocialAuthProviderGateOpen(
  provider: SocialAuthProvider,
  platform: featureFlagService.FeatureFlagPlatform,
): Promise<boolean> {
  if (provider !== "apple") return true;
  const evaluation = await featureFlagService.evaluateFeatureFlag({
    key: featureFlagService.APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
    platform,
  });
  return evaluation.enabled;
}

async function isSocialAuthProviderAvailable(
  provider: NonNullable<ReturnType<typeof getSocialAuthProvider>>,
  platform: featureFlagService.FeatureFlagPlatform,
): Promise<boolean> {
  if (!isSocialAuthProviderConfigured(provider.id)) return false;
  return isSocialAuthProviderGateOpen(provider.id, platform);
}

async function isNativeAppleMobileAuthAvailable(): Promise<boolean> {
  return isNativeAppleSignInConfigured() && isSocialAuthProviderGateOpen("apple", "mobile");
}

async function startMobileOAuthResponse(req: Request, res: Response, params: {
  providerId: string;
  mode: unknown;
  returnUri: unknown;
  codeChallenge: unknown;
  authenticatedUserId?: string;
}) {
  const provider = getSocialAuthProvider(params.providerId);
  if (!provider) {
    res.status(400).json({ code: "provider_invalid", error: "provider must be google, github, or apple" });
    return;
  }
  if (!(await isSocialAuthProviderAvailable(provider, "mobile"))) {
    res.status(404).json({ code: "provider_not_configured", error: `${provider.label} sign-in is not configured` });
    return;
  }

  const userId = params.mode === "link"
    ? params.authenticatedUserId ?? (await getBearerAccessUserId(req.headers.authorization)) ?? undefined
    : undefined;
  if (params.mode === "link" && !userId) {
    res.status(401).json({ code: "auth_required", error: "link mode requires authentication" });
    return;
  }

  const started = await createMobileOAuthStart({
    provider: provider.id,
    mode: params.mode,
    returnUri: params.returnUri,
    codeChallenge: params.codeChallenge,
    userId: userId ?? undefined,
  });
  res.status(201).json({
    requestId: started.requestId,
    authorizationUrl: started.authorizationUrl,
    returnUri: started.returnUri,
    expiresAt: started.expiresAt.toISOString(),
  });
}

function mobileOAuthErrorResponse(res: Response, err: unknown, operation: "start" | "complete"): boolean {
  const message = errorMessage(err, `mobile_oauth_${operation}_failed`);
  if (message === "return_uri_not_allowed") {
    res.status(400).json({ code: "return_uri_not_allowed", error: "Mobile OAuth return URI is not allowed" });
    return true;
  }
  if (message === "handoff_code_consumed") {
    res.status(410).json({ code: "handoff_code_consumed", error: "Mobile OAuth code has already been consumed" });
    return true;
  }
  if (message === "handoff_code_expired") {
    res.status(410).json({ code: "handoff_code_expired", error: "Mobile OAuth code has expired" });
    return true;
  }
  if (message === "pkce_mismatch") {
    res.status(400).json({ code: "pkce_mismatch", error: "PKCE verifier did not match the OAuth request" });
    return true;
  }
  if (message.includes("already linked to another") || message.includes("belongs to another")) {
    res.status(409).json({ code: "provider_conflict", error: message });
    return true;
  }
  if (message.includes("invalid") || message.includes("required") || message.includes("must be") || message.includes("too long")) {
    res.status(400).json({ code: "invalid_request", error: message });
    return true;
  }
  return false;
}

function nativeAppleOAuthErrorResponse(res: Response, err: unknown): boolean {
  const message = errorMessage(err, "native_apple_auth_failed");
  if (message === "native_apple_not_configured") {
    res.status(404).json({ code: "provider_not_configured", error: "Apple sign-in is not configured" });
    return true;
  }
  if (message === "native_apple_auth_required" || message === "link mode requires authentication") {
    res.status(401).json({ code: "auth_required", error: "Apple account linking requires authentication" });
    return true;
  }
  if (message === "native_apple_link_user_mismatch") {
    res.status(403).json({ code: "link_user_mismatch", error: "Apple account linking does not match the authenticated user" });
    return true;
  }
  if (message === "native_apple_request_expired") {
    res.status(410).json({ code: "native_apple_request_expired", error: "Apple sign-in request expired" });
    return true;
  }
  if (message === "native_apple_request_consumed") {
    res.status(410).json({ code: "native_apple_request_consumed", error: "Apple sign-in request was already used" });
    return true;
  }
  if (message.includes("email already exists")) {
    res.status(409).json({ code: "account_conflict", error: message });
    return true;
  }
  if (message.includes("Registration is currently disabled")) {
    res.status(403).json({ code: "registration_disabled", error: "New account registration is currently unavailable" });
    return true;
  }
  if (
    message.startsWith("native_apple_") ||
    message.includes("jwt") ||
    message.includes("signature") ||
    message.includes("token") ||
    message.includes("required") ||
    message.includes("too long")
  ) {
    res.status(400).json({ code: "native_apple_invalid_credential", error: "Apple sign-in credential was invalid" });
    return true;
  }
  return false;
}

async function completeMobileOAuthResponse(req: Request, res: Response, params: {
  providerId?: string;
  expectedMode?: SocialAuthMode;
  code: string;
  codeVerifier: string;
  authenticatedUserId?: string;
}) {
  const completion = await getMobileOAuthCompletion(params.code, params.codeVerifier);
  if (params.providerId && completion.provider !== params.providerId) {
    res.status(400).json({ code: "provider_mismatch", error: "Mobile OAuth code does not match the requested provider" });
    return;
  }
  if (params.expectedMode && completion.mode !== params.expectedMode) {
    res.status(400).json({ code: "mode_mismatch", error: "Mobile OAuth code does not match the requested mode" });
    return;
  }

  if (completion.mode === "link") {
    const userId = params.authenticatedUserId ?? (await getBearerAccessUserId(req.headers.authorization));
    if (!userId) {
      res.status(401).json({ code: "auth_required", error: "link mode requires authentication" });
      return;
    }
    if (!completion.userId || completion.userId !== userId) {
      res.status(403).json({ code: "link_user_mismatch", error: "Mobile OAuth link request does not match the authenticated user" });
      return;
    }
    const profile = socialProfileFromCompletion(getSocialAuthProvider(completion.provider)!, completion);
    await userService.linkSocialIdentity(userId, profile);
    await markMobileOAuthCompletionConsumed(completion.requestId);
    const identities = await userService.listUserAuthIdentities(userId);
    res.json({
      provider: completion.provider,
      mode: completion.mode,
      returnUri: completion.returnUri,
      identities,
    });
    return;
  }

  let user = completion.userId ? await userService.getUser(completion.userId) : null;
  if (completion.userId && !user) {
    throw new Error("Mobile OAuth completion user was not found");
  }
  if (!user) {
    legalAcceptanceService.requireCurrentLegalAcceptance(parseLegalAcceptance(req.body));
    const profile = socialProfileFromCompletion(getSocialAuthProvider(completion.provider)!, completion);
    user = await userService.createSocialUser(
      profile,
      parseLegalAcceptance(req.body),
      legalAcceptanceService.getRequestLegalMetadata(req),
      parseSocialAccountCreationSource(req.body),
      { deferProfileSetup: true },
    );
  }

  const { sessionId, familyId, refreshToken } = await sessionService.createSession(user.id);
  const accessToken = signAccessToken(user.id, familyId);
  attachAuthTraceIdentity(req, { userId: user.id, sessionId, source: "mobile_oauth" });
  recordAuthSessionIssuedTrace({ flow: "mobile_oauth", userId: user.id, sessionId });
  await markMobileOAuthCompletionConsumed(completion.requestId);
  res.json({
    user,
    provider: completion.provider,
    mode: completion.mode,
    returnUri: completion.returnUri,
    accessToken,
    refreshToken,
  });
}

// Register
authRouter.post("/register", async (req, res) => {
  const registrationBlockedReason = getRegistrationBlockedReason();
  if (registrationBlockedReason) {
    res.status(403).json({ error: registrationBlockedReason });
    return;
  }
  const body = parseEmailRegisterRequest(req.body, res);
  if (!body) return;
  req.body = body;

  try {
    const { email, password, name, stagingSelfAccountCapability } = body;
    if (stagingSelfAccountCapability && (process.env.SLOCK_RELEASE_BRANCH !== "staging" || !/@mail\.build$/i.test(email))) {
      res.status(403).json({ error: "Staging self-account registration is unavailable" });
      return;
    }
    if (name) {
      const nameError = validateName(name, "Name", 5);
      if (nameError) {
        res.status(400).json({ error: nameError });
        return;
      }
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const user = await userService.createUser(
      email,
      password,
      name?.trim() ?? null,
      parseLegalAcceptance(req.body),
      legalAcceptanceService.getRequestLegalMetadata(req),
      parseEmailAccountCreationSource(req.body),
      { deferProfileSetup: true, stagingSelfAccountCapability },
    );
    // E2E-only opt-in: verify ephemeral test users (e.g. the removed-dm DM-seed
    // peer) so they can post. Double-gated — the SLOCK_E2E_AUTO_VERIFY_EMAIL
    // test-env flag AND an explicit per-request opt-in — so the normal signup
    // flow still lands on the unverified email-verification screen (register.spec).
    // Never reachable in prod/staging (the env flag is only set in playwright.config.ts).
    if (process.env.SLOCK_E2E_AUTO_VERIFY_EMAIL === "1" && req.body?.__e2eAutoVerify === true) {
      await userService.markEmailVerifiedForTest(user.id);
    }
    const { sessionId, familyId, refreshToken } = await sessionService.createSession(user.id);
    const accessToken = signAccessToken(user.id, familyId);
    attachAuthTraceIdentity(req, { userId: user.id, sessionId, source: "email_register" });
    recordAuthSessionIssuedTrace({ flow: "email_register", userId: user.id, sessionId });

    res.json({ user, accessToken, refreshToken });
  } catch (err: any) {
    const legalResponse = legalAcceptanceService.legalAcceptanceErrorResponse(err);
    if (legalResponse) {
      res.status(legalResponse.status).json(legalResponse.body);
      return;
    }
    const msg = err?.message || "";
    if (msg === "Username is already taken") {
      res.status(409).json({ code: "AUTH_USERNAME_TAKEN", error: msg });
    } else if (msg.includes("already registered") || msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else {
      console.error("Register error:", serializeErrorForLog(err));
      res.status(500).json({ error: "Registration failed" });
    }
  }
});

authRouter.get("/providers", async (req, res) => {
  // `platform` selects which platform stage gates provider visibility. Default `web`
  // preserves the original Web-login behavior; `mobile` lets native clients show a
  // provider button only when the backend would also accept its mobile start call.
  const platformParam = typeof req.query.platform === "string" ? req.query.platform : "web";
  if (platformParam !== "web" && platformParam !== "mobile") {
    res.status(400).json({ code: "platform_invalid", error: "platform must be web or mobile" });
    return;
  }
  const platform: featureFlagService.FeatureFlagPlatform = platformParam;

  const providerConfigs = ["google", "github", "apple"]
    .map((providerId) => getSocialAuthProvider(providerId))
    .filter((provider): provider is NonNullable<typeof provider> => !!provider);

  const providers = await Promise.all(providerConfigs.map(async (provider) => ({
      id: provider.id,
      label: provider.label,
      enabled: await isSocialAuthProviderAvailable(provider, platform),
    })));

  res.json({ providers });
});

authRouter.get("/identities", requireAuth, async (req, res) => {
  try {
    const methods = await userService.getUserAuthMethods(req.userId!);
    if (!methods) {
      respondInvalidOrExpiredToken(res);
      return;
    }
    res.json(methods);
  } catch (err) {
    console.error("List auth identities error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load linked accounts" });
  }
});

authRouter.delete("/identities/:provider", requireAuth, async (req, res) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    res.status(404).json({ code: "AUTH_PROVIDER_NOT_FOUND", error: "Unknown sign-in provider" });
    return;
  }

  try {
    const result = await userService.unlinkSocialIdentity(req.userId!, provider.id);
    res.json(result);
  } catch (err) {
    if (err instanceof userService.PasswordCredentialRequiredError) {
      res.status(409).json({ code: err.code, error: err.message });
      return;
    }
    if (err instanceof Error && err.message === "User not found") {
      respondInvalidOrExpiredToken(res);
      return;
    }
    console.error("Unlink auth identity error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to disconnect linked account" });
  }
});

authRouter.post("/mobile/oauth/apple/native/start", async (req, res) => {
  try {
    if (!(await isNativeAppleMobileAuthAvailable())) {
      res.status(404).json({ code: "provider_not_configured", error: "Apple sign-in is not configured" });
      return;
    }
    if (req.body?.platform !== "ios" || typeof req.body?.appEnv !== "string" || !req.body.appEnv.trim()) {
      res.status(400).json({ code: "invalid_request", error: "Native Apple sign-in requires the iOS platform and app environment" });
      return;
    }
    if (req.body?.codeChallengeMethod !== "S256") {
      res.status(400).json({ code: "invalid_request", error: "Native Apple sign-in requires an S256 challenge" });
      return;
    }
    const mode = req.body?.mode;
    const authenticatedUserId = (await getBearerAccessUserId(req.headers.authorization)) ?? undefined;
    const started = await createNativeAppleMobileOAuthStart({
      mode,
      returnUri: req.body?.returnUri,
      codeChallenge: req.body?.codeChallenge,
      userId: mode === "link" ? authenticatedUserId : undefined,
    });
    res.status(201).json({
      requestId: started.requestId,
      requestToken: started.requestToken,
      returnUri: started.returnUri,
      expiresAt: started.expiresAt.toISOString(),
    });
  } catch (err: unknown) {
    if (nativeAppleOAuthErrorResponse(res, err) || mobileOAuthErrorResponse(res, err, "start")) return;
    console.error("Native Apple OAuth start error:", serializeErrorForLog(err));
    res.status(500).json({ code: "native_apple_start_failed", error: "Failed to start Apple sign-in" });
  }
});

authRouter.post("/mobile/oauth/apple/native/authorize", async (req, res) => {
  try {
    if (!(await isNativeAppleMobileAuthAvailable())) {
      res.status(404).json({ code: "provider_not_configured", error: "Apple sign-in is not configured" });
      return;
    }
    const completed = await completeNativeAppleMobileOAuthAuthorization({
      requestId: req.body?.requestId,
      requestToken: req.body?.requestToken,
      authorizationCode: req.body?.authorizationCode,
      identityToken: req.body?.identityToken,
      authenticatedUserId: (await getBearerAccessUserId(req.headers.authorization)) ?? undefined,
    });
    res.json({
      requestId: completed.requestId,
      handoffCode: completed.handoffCode,
      provider: completed.provider,
      mode: completed.mode,
    });
  } catch (err: unknown) {
    if (nativeAppleOAuthErrorResponse(res, err)) return;
    console.error("Native Apple OAuth authorization error:", serializeErrorForLog(err));
    res.status(502).json({ code: "native_apple_provider_unavailable", error: "Apple sign-in could not be verified" });
  }
});

authRouter.post("/mobile/oauth/start", async (req, res) => {
  try {
    await startMobileOAuthResponse(req, res, {
      providerId: typeof req.body?.provider === "string" ? req.body.provider : "",
      mode: req.body?.mode,
      returnUri: req.body?.returnUri,
      codeChallenge: req.body?.codeChallenge,
    });
  } catch (err: unknown) {
    if (mobileOAuthErrorResponse(res, err, "start")) return;
    console.error("Mobile OAuth start error:", serializeErrorForLog(err));
    res.status(500).json({ code: "mobile_oauth_start_failed", error: "Failed to start mobile OAuth" });
  }
});

authRouter.post("/mobile/oauth/:provider/link/start", requireAuth, async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  try {
    await startMobileOAuthResponse(req, res, {
      providerId: provider.id,
      mode: "link",
      returnUri: req.body?.returnUri,
      codeChallenge: req.body?.codeChallenge,
      authenticatedUserId: req.userId!,
    });
  } catch (err: unknown) {
    if (mobileOAuthErrorResponse(res, err, "start")) return;
    console.error("Mobile OAuth link start error:", serializeErrorForLog(err));
    res.status(500).json({ code: "mobile_oauth_link_start_failed", error: "Failed to start mobile OAuth link" });
  }
});

authRouter.post("/mobile/oauth/complete", async (req, res) => {
  try {
    await completeMobileOAuthResponse(req, res, {
      code: req.body?.code,
      codeVerifier: req.body?.codeVerifier,
    });
  } catch (err: unknown) {
    const legalResponse = legalAcceptanceService.legalAcceptanceErrorResponse(err);
    if (legalResponse) {
      res.status(legalResponse.status).json(legalResponse.body);
      return;
    }
    if (mobileOAuthErrorResponse(res, err, "complete")) return;
    console.error("Mobile OAuth completion error:", serializeErrorForLog(err));
    res.status(500).json({ code: "mobile_oauth_complete_failed", error: "Failed to complete mobile OAuth" });
  }
});

authRouter.post("/mobile/oauth/:provider/link/complete", requireAuth, async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  try {
    await completeMobileOAuthResponse(req, res, {
      providerId: provider.id,
      expectedMode: "link",
      code: req.body?.code,
      codeVerifier: req.body?.codeVerifier,
      authenticatedUserId: req.userId!,
    });
  } catch (err: unknown) {
    if (mobileOAuthErrorResponse(res, err, "complete")) return;
    console.error("Mobile OAuth link completion error:", serializeErrorForLog(err));
    res.status(500).json({ code: "mobile_oauth_link_complete_failed", error: "Failed to complete mobile OAuth link" });
  }
});

authRouter.get("/:provider/start", async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  if (!(await isSocialAuthProviderAvailable(provider, "web"))) {
    res.status(404).json({ error: `${provider.label} sign-in is not configured` });
    return;
  }

  const returnTo = sanitizeReturnTo(req.query.returnTo);
  const nonce = createSocialAuthNonce();
  const state = signSocialAuthState({
    provider: provider.id,
    mode: "login",
    nonce,
    returnTo,
  });

  res.setHeader("Set-Cookie", buildStateCookie(provider.id, nonce));
  res.redirect(buildAuthorizationUrl(provider.id, state, "login", nonce));
});

authRouter.post("/:provider/link/start", requireAuth, async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  if (!(await isSocialAuthProviderAvailable(provider, "web"))) {
    res.status(404).json({ error: `${provider.label} sign-in is not configured` });
    return;
  }

  const returnTo = sanitizeReturnTo(req.body?.returnTo);
  const nonce = createSocialAuthNonce();
  const state = signSocialAuthState({
    provider: provider.id,
    mode: "link",
    nonce,
    linkUserId: req.userId!,
    returnTo,
  });

  res.setHeader("Set-Cookie", buildStateCookie(provider.id, nonce));
  res.json({ url: buildAuthorizationUrl(provider.id, state, "link", nonce) });
});

async function handleSocialAuthCallback(req: Request, res: Response, next: NextFunction) {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  let state = null as (ReturnType<typeof verifySocialAuthState> & { mode: SocialAuthMode }) | null;
  let returnTo = "/";

  try {
    const stateToken = getSocialAuthCallbackParam(req, "state");
    const rawState = verifySocialAuthState(stateToken);
    if (rawState.kind === "mobile") {
      try {
        const completed = await completeMobileOAuthProviderCallback({
          provider: provider.id,
          state: rawState,
          providerCode: getSocialAuthCallbackParam(req, "code") || undefined,
          providerError: getSocialAuthCallbackParam(req, "error") || undefined,
        });
        res.redirect(completed.redirectUri);
      } catch {
        res.status(400).send("Invalid mobile OAuth request");
      }
      return;
    }
    const validated = validateSocialAuthCallbackState(provider.id, stateToken, req.headers.cookie);
    state = validated.state;
    returnTo = validated.returnTo;
  } catch {
    res.setHeader("Set-Cookie", clearStateCookie(provider.id));
    res.redirect(buildSocialAuthCallbackUrl({
      provider: provider.id,
      mode: "login",
      error: "This sign-in link is invalid or expired. Please try again.",
    }));
    return;
  }

  try {
    res.setHeader("Set-Cookie", clearStateCookie(provider.id));

    const code = getSocialAuthCallbackParam(req, "code");
    if (!code) {
      const providerError = getSocialAuthCallbackParam(req, "error") || `${provider.label} sign-in was cancelled`;
      res.redirect(buildSocialAuthCallbackUrl({
        provider: provider.id,
        mode: state.mode,
        returnTo,
        error: providerError,
      }));
      return;
    }

    const { accessToken } = await exchangeProviderCode(provider.id, code);
    const profile = await fetchSocialAuthProfile(provider.id, accessToken, state.nonce);
    assertVerifiedSocialAuthProfile(profile);

    if (state.mode === "link") {
      if (!state.linkUserId) {
        throw new Error(`${provider.label} link flow is missing a target user`);
      }

      const completionCode = await createSocialAuthCompletion({
        provider: provider.id,
        mode: "link",
        intendedAction: "link",
        userId: state.linkUserId,
        providerUserId: profile.providerUserId,
        providerEmail: profile.email,
        providerDisplayName: profile.displayName,
        providerAvatarUrl: profile.avatarUrl,
        providerEmailVerified: profile.emailVerified,
        returnTo,
      });

      res.redirect(buildSocialAuthCallbackUrl({
        provider: provider.id,
        mode: "link",
        returnTo,
        code: completionCode,
      }));
      return;
    }

    const user = await userService.findExistingSocialLoginUser(profile);
    const completionCode = await createSocialAuthCompletion({
      provider: provider.id,
      mode: "login",
      intendedAction: "login",
      userId: user?.id,
      providerUserId: profile.providerUserId,
      providerEmail: profile.email,
      providerDisplayName: profile.displayName,
      providerAvatarUrl: profile.avatarUrl,
      providerEmailVerified: profile.emailVerified,
      returnTo,
    });

    res.redirect(buildSocialAuthCallbackUrl({
      provider: provider.id,
      mode: "login",
      returnTo,
      code: completionCode,
    }));
  } catch (err: any) {
    console.error(`${provider.label} auth callback error:`, serializeErrorForLog(err));
    res.redirect(buildSocialAuthCallbackUrl({
      provider: provider.id,
      mode: state.mode,
      returnTo,
      error: err?.message || `${provider.label} sign-in failed`,
    }));
  }
}

authRouter.get("/:provider/callback", handleSocialAuthCallback);
authRouter.post(
  "/:provider/callback",
  urlencoded({ extended: false, limit: "32kb" }),
  handleSocialAuthCallback,
);

authRouter.post("/:provider/complete", async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  try {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ error: "Sign-in completion code is required" });
      return;
    }

    const pendingCompletion = await getSocialAuthCompletion(provider.id, code);
    if (pendingCompletion.mode === "login" && !pendingCompletion.userId) {
      legalAcceptanceService.requireCurrentLegalAcceptance(parseLegalAcceptance(req.body));
    }

    let authenticatedLinkUserId: string | null = null;
    if (pendingCompletion.mode === "link") {
      authenticatedLinkUserId = (await getBearerAccessUserId(req.headers.authorization));
      if (!authenticatedLinkUserId) {
        res.status(401).json({ code: "auth_required", error: "Authentication is required to link an account" });
        return;
      }
      if (!pendingCompletion.userId || pendingCompletion.userId !== authenticatedLinkUserId) {
        res.status(403).json({ code: "link_user_mismatch", error: "Social auth link does not match the authenticated user" });
        return;
      }
    }

    const completion = await exchangeSocialAuthCompletion(provider.id, code);
    if (completion.mode === "link") {
      if (!authenticatedLinkUserId || completion.userId !== authenticatedLinkUserId) {
        throw new Error("Social auth completion link user mismatch");
      }
      const profile = socialProfileFromCompletion(provider, completion);
      await userService.linkSocialIdentity(authenticatedLinkUserId, profile);
      const identities = await userService.listUserAuthIdentities(authenticatedLinkUserId);
      res.json({
        provider: completion.provider,
        mode: completion.mode,
        returnTo: completion.returnTo,
        identities,
      });
      return;
    }

    if (!completion.userId) {
      const profile = socialProfileFromCompletion(provider, completion);
      const user = await userService.createSocialUser(
        profile,
        parseLegalAcceptance(req.body),
        legalAcceptanceService.getRequestLegalMetadata(req),
        parseSocialAccountCreationSource(req.body),
        { deferProfileSetup: true },
      );
      const { sessionId, familyId, refreshToken } = await sessionService.createSession(user.id);
      const accessToken = signAccessToken(user.id, familyId);
      attachAuthTraceIdentity(req, { userId: user.id, sessionId, source: "social_oauth" });
      recordAuthSessionIssuedTrace({ flow: "social_oauth", userId: user.id, sessionId });
      res.json({
        provider: completion.provider,
        mode: completion.mode,
        returnTo: completion.returnTo,
        accessToken,
        refreshToken,
      });
      return;
    }

    const { sessionId, familyId, refreshToken } = await sessionService.createSession(completion.userId);
    const accessToken = signAccessToken(completion.userId, familyId);
    attachAuthTraceIdentity(req, { userId: completion.userId, sessionId, source: "social_oauth" });
    recordAuthSessionIssuedTrace({ flow: "social_oauth", userId: completion.userId, sessionId });
    res.json({
      provider: completion.provider,
      mode: completion.mode,
      returnTo: completion.returnTo,
      accessToken,
      refreshToken,
    });
  } catch (err: any) {
    const legalResponse = legalAcceptanceService.legalAcceptanceErrorResponse(err);
    if (legalResponse) {
      res.status(legalResponse.status).json(legalResponse.body);
      return;
    }
    const message = err?.message || "";
    if (message.includes("Invalid") || message.includes("expired") || message.includes("mismatch")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error(`${provider.label} auth completion error:`, serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to complete sign-in" });
  }
});

// Login
authRouter.post("/login", async (req, res) => {
  const body = parseEmailLoginRequest(req.body, res);
  if (!body) return;
  req.body = body;

  try {
    const { email, password } = body;

    const { user, session } = await userService.authenticateUser(email, password);
    const { sessionId, familyId, refreshToken } = session;
    const accessToken = signAccessToken(user.id, familyId);
    attachAuthTraceIdentity(req, { userId: user.id, sessionId, source: "email_login" });
    recordAuthSessionIssuedTrace({ flow: "email_login", userId: user.id, sessionId });

    res.json({ user, accessToken, refreshToken });
  } catch (err: any) {
    if (err instanceof userService.EmailLoginRejectedError) {
      attachAuthTraceIdentity(req, { source: "email_login", reason: err.reason });
      const traceId = recordEmailLoginRejectedTrace(err.reason);
      if (traceId) {
        res.setHeader("X-Slock-Trace-Id", traceId);
      }
      res.status(401).json({ code: "AUTH_INVALID_CREDENTIALS", error: err.message });
    } else {
      console.error("Login error:", serializeErrorForLog(err));
      res.status(500).json({ error: "Login failed" });
    }
  }
});

// Refresh token
authRouter.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      attachAuthTraceIdentity(req, { source: "refresh", reason: "missing_refresh_token" });
      res.status(400).json({ error: "Refresh token is required" });
      return;
    }

    const authRefreshAttemptId = authRefreshAttemptIdFromHeader(
      req.header("X-Slock-Auth-Refresh-Attempt-Id"),
    );
    const installationHeader = req.header("X-Slock-Auth-Installation-Id");
    const authRefreshInstallationId = authRefreshInstallationIdFromHeader(installationHeader);
    if (installationHeader !== undefined && (!authRefreshInstallationId || !authRefreshAttemptId)) {
      attachAuthTraceIdentity(req, { source: "refresh", reason: "invalid_refresh_binding" });
      res.status(400).json({ error: "Invalid refresh replay binding" });
      return;
    }

    const { refreshed, replayTrace } = await sessionService.refreshSessionWithTrace(
      refreshToken,
      authRefreshAttemptId && authRefreshInstallationId
        ? { attemptId: authRefreshAttemptId, installationId: authRefreshInstallationId }
        : undefined,
    );
    recordAuthRefreshTrace(refreshed, replayTrace, {
      authRefreshAttemptId,
    });
    if (!refreshed) {
      attachAuthTraceIdentity(req, { source: "refresh", reason: "invalid_or_expired_refresh" });
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }
    const { refreshToken: newRefreshToken } = refreshed;
    const accessToken = signAccessToken(refreshed.userId, refreshed.familyId);
    attachAuthTraceIdentity(req, {
      userId: refreshed.userId,
      sessionId: refreshed.sessionId,
      source: "refresh",
    });

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch {
    res.status(500).json({ error: "Token refresh failed" });
  }
});

// Get current user
authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    attachAuthTraceIdentity(req, { userId: req.userId!, source: "require_auth" });
    const user = await userService.getUser(req.userId!);
    if (!user) {
      respondInvalidOrExpiredToken(res);
      return;
    }
    res.json(user);
  } catch {
    res.status(500).json({ error: "Failed to get user" });
  }
});

authRouter.post("/me/timezone-observation", requireAuth, async (req, res) => {
  const parsed = timezoneObservationRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid timezone observation body",
      code: "timezone_observation_body_invalid",
      issues: formatBodyIssues(parsed.error),
    });
    return;
  }

  let timezone: string;
  try {
    timezone = parseCanonicalBrowserTimezone(parsed.data.timezone);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid timezone observation",
    });
    return;
  }

  try {
    const observation = await userService.recordBrowserTimezoneObservation(req.userId!, timezone);
    if (!observation) {
      respondInvalidOrExpiredToken(res);
      return;
    }
    res.json(observation);
  } catch (err) {
    console.error("Record timezone observation error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to record timezone observation" });
  }
});

authRouter.post("/me/complete-profile", requireAuth, async (req, res) => {
  const parsed = completeProfileRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid profile setup body",
      code: "PROFILE_SETUP_BODY_INVALID",
      issues: formatBodyIssues(parsed.error),
    });
    return;
  }

  const name = parsed.data.name.trim();
  const nameError = validateName(name, "Name", 5);
  if (nameError) {
    res.status(400).json({ error: nameError, code: "PROFILE_SETUP_NAME_INVALID" });
    return;
  }
  if (
    name.toLowerCase().startsWith(userService.PROFILE_SETUP_PLACEHOLDER_PREFIX)
    || isReservedAgentName(name)
  ) {
    res.status(400).json({
      error: "This username is reserved. Choose another name.",
      code: "PROFILE_SETUP_NAME_RESERVED",
    });
    return;
  }

  try {
    const user = await userService.completeProfile(req.userId!, {
      name,
      displayName: parsed.data.displayName,
    });
    res.json(user);
  } catch (err) {
    if (err instanceof userService.CompleteProfileError) {
      const status = err.code === "PROFILE_SETUP_USER_NOT_FOUND"
        ? 401
        : err.code === "PROFILE_SETUP_NAME_INVALID"
          ? 400
          : 409;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("Complete profile error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to complete profile setup" });
  }
});

// Username availability precheck for the identity-setup on-blur UX. Mirrors the
// validation in POST /me/complete-profile (validate → reserved → uniqueness) but
// only READS — never commits. Behind requireAuth (identity setup is post-login),
// so it is not an anonymous username-enumeration surface. Advisory only: the
// authoritative uniqueness check remains completeProfile (a name can be taken
// between this check and submit).
authRouter.get("/me/username-available", requireAuth, async (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  const nameError = validateName(name, "Username", 5);
  if (nameError) {
    res.json({ available: false, reason: "invalid", message: nameError });
    return;
  }
  if (
    name.toLowerCase().startsWith(userService.PROFILE_SETUP_PLACEHOLDER_PREFIX)
    || isReservedAgentName(name)
  ) {
    res.json({ available: false, reason: "reserved", message: "This username is reserved. Choose another name." });
    return;
  }
  const available = await userService.isUsernameAvailable(name);
  res.json({
    available,
    reason: available ? undefined : "taken",
    message: available ? undefined : "This username is already taken.",
  });
});

// Update current user profile
authRouter.patch("/me", requireAuth, async (req, res) => {
  try {
    const {
      displayName,
      description,
      avatarUrl,
      currentPassword,
      newPassword,
      referralSource,
      referralSourceOther,
      referralSourceSkipped,
      signupRole,
      signupSurveyServerId,
    } = req.body;

    // Password change
    if (currentPassword && newPassword) {
      if (newPassword.length < 8) {
        res.status(400).json({ error: "New password must be at least 8 characters" });
        return;
      }
      await userService.changePassword(req.userId!, currentPassword, newPassword);
    }

    // Profile update (name is immutable — set at registration only)
    const profileFields: {
      displayName?: string;
      description?: string | null;
      avatarUrl?: string | null;
      preferredLanguage?: string | null;
      displayLanguage?: string | null;
      preferredTimezone?: string | null;
      autoTranslationEnabled?: boolean;
      preferredTranslationMode?: PreferredTranslationMode;
      preferredTranslationDisplay?: PreferredTranslationDisplay;
      preferredTimeFormat?: TimeFormatPreference | null;
      preferredMessageBodyFontSize?: MessageBodyFontSizePreference | null;
      referralSource?: string | null;
      referralSourceOther?: string | null;
      referralSourceSkippedAt?: Date | null;
      signupRole?: string | null;
      signupSurveyCompletedAt?: Date | null;
    } = {};
    if (displayName !== undefined) profileFields.displayName = displayName;
    if (description !== undefined) {
      if (description !== null && (typeof description !== "string" || description.length > MAX_USER_DESCRIPTION_LENGTH)) {
        res.status(400).json({ error: `Description must be a string of at most ${MAX_USER_DESCRIPTION_LENGTH} characters` });
        return;
      }
      profileFields.description = typeof description === "string" ? (description.trim() || null) : null;
    }
    if (avatarUrl !== undefined) profileFields.avatarUrl = avatarUrl;
    try {
      const preferredLanguage = parsePreferredLanguage(req.body?.preferredLanguage);
      if (preferredLanguage !== undefined) profileFields.preferredLanguage = preferredLanguage;
      const displayLanguage = parseDisplayLanguage(req.body?.displayLanguage);
      if (displayLanguage !== undefined) profileFields.displayLanguage = displayLanguage;
      const preferredTimezone = parsePreferredTimezone(req.body?.preferredTimezone);
      if (preferredTimezone !== undefined) profileFields.preferredTimezone = preferredTimezone;
      const preferredTranslationMode = parsePreferredTranslationMode(req.body?.preferredTranslationMode);
      if (preferredTranslationMode !== undefined) {
        profileFields.preferredTranslationMode = preferredTranslationMode;
        profileFields.autoTranslationEnabled = preferredTranslationMode === "auto";
      }
      const autoTranslationEnabled = parseAutoTranslationEnabled(req.body?.autoTranslationEnabled);
      if (autoTranslationEnabled !== undefined && preferredTranslationMode === undefined) {
        profileFields.autoTranslationEnabled = autoTranslationEnabled;
        profileFields.preferredTranslationMode = autoTranslationEnabled ? "auto" : "off";
      }
      const preferredTranslationDisplay = parsePreferredTranslationDisplay(req.body?.preferredTranslationDisplay);
      if (preferredTranslationDisplay !== undefined) profileFields.preferredTranslationDisplay = preferredTranslationDisplay;
      const preferredTimeFormat = parsePreferredTimeFormat(req.body?.preferredTimeFormat);
      if (preferredTimeFormat !== undefined) profileFields.preferredTimeFormat = preferredTimeFormat;
      const preferredMessageBodyFontSize = parsePreferredMessageBodyFontSize(req.body?.preferredMessageBodyFontSize);
      if (preferredMessageBodyFontSize !== undefined) profileFields.preferredMessageBodyFontSize = preferredMessageBodyFontSize;
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid account preference" });
      return;
    }
    // One timestamp for the whole request: the survey's role and the referral-source
    // skip are two facts recorded by the same PATCH, and reading the clock twice would
    // let them disagree for no reason.
    const stampedAt = new Date();

    // The signup survey writes the role here, alongside the referral source it has
    // always written. Setting the role also closes the survey gate: the two are
    // asked together on one screen, so there is no state where one lands without
    // the other.
    if (signupRole !== undefined) {
      if (signupRole !== null && !isSignupRoleId(signupRole)) {
        res.status(400).json({ error: "Invalid signupRole" });
        return;
      }
      profileFields.signupRole = signupRole;
      profileFields.signupSurveyCompletedAt = stampedAt;
    }

    if (referralSource !== undefined) {
      if (referralSource !== null && (typeof referralSource !== "string" || !REFERRAL_SOURCE_OPTIONS.has(referralSource))) {
        res.status(400).json({ error: "Invalid referralSource" });
        return;
      }
      profileFields.referralSource = referralSource;
      profileFields.referralSourceOther = referralSource === "other" && typeof referralSourceOther === "string"
        ? referralSourceOther.trim().slice(0, 200) || null
        : null;
      profileFields.referralSourceSkippedAt = null;
    } else if (referralSourceOther !== undefined) {
      res.status(400).json({ error: "referralSource is required when referralSourceOther is provided" });
      return;
    }
    if (referralSourceSkipped !== undefined) {
      if (typeof referralSourceSkipped !== "boolean") {
        res.status(400).json({ error: "referralSourceSkipped must be a boolean" });
        return;
      }
      if (referralSourceSkipped) {
        profileFields.referralSourceSkippedAt = stampedAt;
      }
    }

    let user;
    if (Object.keys(profileFields).length > 0) {
      user = await userService.updateUser(req.userId!, profileFields);
    } else {
      user = await userService.getUser(req.userId!);
    }

    if (!user) {
      respondInvalidOrExpiredToken(res);
      return;
    }

    // Brief Cindy at the moment the owner actually enters the server ("Let's go"),
    // not when the survey saves a screen earlier. Her briefing was deferred at agent
    // creation precisely because the role did not exist yet; this fires that same
    // idempotent trigger, now with the role in it, exactly as she is about to be met.
    // Sending it any earlier means she starts talking to an empty room behind a modal.
    if (typeof signupSurveyServerId === "string" && signupSurveyServerId) {
      const io = req.app.get("io") as SocketServer | undefined;
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      const server = await serverService.getServer(signupSurveyServerId);
      if (io && agentOrchestrator && server?.onboardingAgentId && server.ownerId === req.userId) {
        void onboardingService
          .triggerOwnerOnboardingOnAgentActivation(io, agentOrchestrator, signupSurveyServerId, server.onboardingAgentId)
          .catch((err: unknown) => {
            console.warn("[Onboarding] Failed to brief onboarding agent after signup survey:", serializeErrorForLog(err));
          });
      }
    }

    res.json(user);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("Current password is incorrect")) {
      res.status(401).json({ code: "AUTH_CURRENT_PASSWORD_INCORRECT", error: msg });
    } else {
      console.error("Update profile error:", serializeErrorForLog(err));
      res.status(500).json({ error: "Failed to update profile" });
    }
  }
});

// Upload current user's avatar
authRouter.post("/me/avatar", requireAuth, async (req, res) => {
  try {
    const currentUser = await userService.getUser(req.userId!);
    if (!currentUser) {
      respondInvalidOrExpiredToken(res);
      return;
    }

    const uploaded = await runSingleAvatarUpload(userAvatarUpload, req);
    if (!uploaded) {
      res.status(400).json({ error: "No avatar file provided" });
      return;
    }

    const avatarUrl = await storeUserAvatar(currentUser.avatarUrl, uploaded.buffer);
    const user = await userService.updateUser(req.userId!, { avatarUrl });
    if (!user) {
      respondInvalidOrExpiredToken(res);
      return;
    }

    res.json(user);
  } catch (err: any) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        error: PROFILE_AVATAR_TOO_LARGE_MESSAGE,
        errorCode: "PROFILE_AVATAR_TOO_LARGE",
        maxBytes: MAX_PROFILE_AVATAR_BYTES,
      });
      return;
    }
    if (err.message?.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      res.status(400).json({
        error: err.message,
        errorCode: "PROFILE_AVATAR_BAD_FORMAT",
      });
      return;
    }
    console.error("User avatar upload error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to upload avatar" });
  }
});

// Verify email
authRouter.post("/verify-email", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    const success = await userService.verifyEmail(token);
    if (!success) {
      res.status(400).json({ error: "Invalid or expired verification token" });
      return;
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Email verification failed" });
  }
});

// Resend verification email
authRouter.post("/resend-verification", requireAuth, async (req, res) => {
  try {
    await userService.resendVerificationEmail(req.userId!);
    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("already verified")) {
      res.status(400).json({ error: msg });
    } else if (msg.includes("Too many") || msg.includes("Please wait")) {
      res.status(429).json({ error: msg });
    } else {
      console.error("Resend verification error:", serializeErrorForLog(err));
      res.status(500).json({ error: "Failed to resend verification email" });
    }
  }
});

// Forgot password — request reset
authRouter.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    await userService.requestPasswordReset(email);
    // Always return success, don't reveal whether user exists
    res.json({ ok: true, message: "If an account exists with that email, a reset link has been sent." });
  } catch {
    // Still return success to not reveal user existence
    res.json({ ok: true, message: "If an account exists with that email, a reset link has been sent." });
  }
});

// Reset password with token
authRouter.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ error: "Token and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const result = await userService.resetPassword(token, password);
    if (!result.success) {
      res.status(400).json({ error: "Invalid or expired reset token" });
      return;
    }

    // Password update and session revocation committed together in the service.
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Password reset failed" });
  }
});

// Accept invite (authenticated user joins a server)
authRouter.post("/accept-invite", requireAuth, requireProfileSetupComplete, async (req, res) => {
  try {
    const { token, agreementId } = req.body;
    if (!token) {
      res.status(400).json({ error: "Invite token is required" });
      return;
    }

    const result = await inviteService.acceptInvite(token, req.userId!, {
      agreementId: typeof agreementId === "string" ? agreementId : null,
      ...getAgreementRequestMetadata(req),
    });
    const io = req.app.get("io") as SocketServer | undefined;
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (io) {
      io.to(`server:${result.serverId}`).emit("server:member-added", {
        serverId: result.serverId,
        userId: req.userId!,
      });
      if (agentOrchestrator) {
        void onboardingService.triggerNewMemberOnboarding(io, agentOrchestrator, result.serverId, req.userId!).catch((err: unknown) => {
          console.warn(`[Onboarding] Failed to trigger member onboarding after invite accept for ${req.userId}:`, serializeErrorForLog(err));
        });
        // A new human can be the 3rd member that grows the server into a team,
        // so the invite-accept path must also try the #all unlock (idempotent
        // via the atomic claim; a no-op below the 3-member threshold).
        void onboardingService.triggerAllChannelUnlockOnboarding(io, agentOrchestrator, result.serverId).catch((err: unknown) => {
          console.warn(`[Onboarding] Failed to trigger #all unlock after invite accept for ${req.userId}:`, serializeErrorForLog(err));
        });
      }
    }
    res.json(result);
  } catch (err: any) {
    const agreementResponse = serverAgreementService.agreementErrorResponse(err);
    if (agreementResponse) {
      res.status(agreementResponse.status).json(agreementResponse.body);
      return;
    }
    const msg = err?.message || "";
    if (
      msg.includes("Invalid")
      || msg.includes("expired")
      || msg.includes("already")
      || msg.includes("revoked")
      || msg.includes("usage limit")
      || msg.includes("different email")
      || msg.includes("seat limit")
      || msg.includes("limit reached")
    ) {
      res.status(400).json({ error: msg });
    } else {
      console.error("Accept invite error:", serializeErrorForLog(err));
      res.status(500).json({ error: "Failed to accept invite" });
    }
  }
});

// Get invite info (public — for showing server name before login/register)
authRouter.get("/invite-info", async (req, res) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    const info = await inviteService.getInviteInfo(token);
    if (!info) {
      res.status(404).json({ error: "Invalid or expired invite" });
      return;
    }

    res.json(info);
  } catch {
    res.status(500).json({ error: "Failed to get invite info" });
  }
});

// Logout
authRouter.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const revoked = await sessionService.revokeSession(refreshToken);
      if (revoked) {
        attachAuthTraceIdentity(req, {
          userId: revoked.userId,
          sessionId: revoked.sessionId,
          source: "logout",
        });
      } else {
        attachAuthTraceIdentity(req, { source: "logout", reason: "logout_session_not_found" });
      }
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Logout failed" });
  }
});

authRouter.post("/staging-self-account/retire", requireRetirementAuth, async (req, res) => {
  try {
    const userId = typeof req.body?.userId === "string" ? req.body.userId : "";
    const capability = typeof req.body?.capability === "string" ? req.body.capability : "";
    const receipt = await userService.retireStagingSelfAccount(userId, req.userId!, capability);
    if (!receipt) { res.status(500).json({ error: "Retirement receipt unavailable" }); return; }
    res.json({ receipt: {
      userId: receipt.userId, actorUserId: receipt.actorUserId,
      environment: receipt.environment, terminalState: receipt.terminalState,
      sessionsRevoked: receipt.sessionsRevoked,
    } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : undefined;
    if (message === "STAGING_SELF_ACCOUNT_ONLY") return res.status(404).json({ error: "Not found" });
    if (message === "RETIREMENT_OWNER_MISMATCH") return res.status(403).json({ error: "User ownership mismatch" });
    if (message === "RETIREMENT_USER_NOT_FOUND") return res.status(404).json({ error: "User not found" });
    if (message === "RETIREMENT_ACCOUNT_CLASS_MISMATCH") return res.status(403).json({ error: "Unsupported account" });
    if (message === "RETIREMENT_CAPABILITY_INVALID") return res.status(403).json({ error: "Invalid retirement capability" });
    res.status(500).json({ error: "Account retirement failed" });
  }
});
