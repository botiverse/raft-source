import { serializeErrorForLog } from "../tracing/safeErrorLog";
import {
  completionBindingCookie,
  completionIsBound,
  socialCompletionBinding,
  SOCIAL_COMPLETION_BINDING_TTL_SECONDS,
} from "../services/completionBrowserBinding";
import { finishSsoSecondStep, SsoSecondStepRefusedError, type SsoSignInResult } from "../services/sso/ssoSignIn";
import { enterpriseSsoUnavailableResponse, sendSsoSignIn } from "./sso";
import { anySsoSignInOffered } from "../services/sso/ssoEnforcement";
import { kickAppNotificationDelivery } from "../services/appNotificationDeliveryService";
import { Router, urlencoded, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import multer from "multer";
import { z } from "zod";
import * as userService from "../services/userService";
import { HumanSeatLimitError } from "../services/planService";
import { DeploymentUserLimitError, deploymentUserLimitReached as isDeploymentUserLimitReached } from "../services/deploymentUserLimit";
import { getDb, type DatabaseExecutor } from "../db/index";
import { findPendingAccountDeletion } from "../services/accountDeletion/requests";
import { setProductAnalyticsOptOut } from "../services/productAnalyticsGate";
import { requestClientPlatform } from "../services/productEventContext";
import { getProductEventSink } from "../services/productEventIngest";
import { recordServerProductEvent } from "../services/serverProductEvents";
import {
  recordAccountProfileCompleted,
  recordEmailVerificationSent,
  recordEmailVerified,
} from "../services/onboardingProductEvents";
import * as sessionService from "../services/sessionService";
import * as inviteService from "../services/inviteService";
import * as seatJoinBlockService from "../services/seatJoinBlockService";
import { coalesceListChanges } from "../services/listChangedRealtime";
import * as onboardingService from "../services/onboardingService";
import * as serverService from "../services/serverService";
import { announceUserProfileUpdated } from "../services/userProfileEvents";
import * as legalAcceptanceService from "../services/legalAcceptanceService";
import { rejectLegacyMobileOAuthLogin, rejectLegacyPrivacyVersionRegister } from "../services/legacyMobileOAuthUpgrade";
import * as serverAgreementService from "../services/serverAgreementService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  getBearerAccessSession,
  getBearerAccessUserId,
  signAccessToken,
  requireAuth,
  requireRetirementAuth,
  requireProfileSetupComplete,
  requireVerified,
  respondInvalidOrExpiredToken,
} from "../middleware/auth";
import { attachAuthTraceIdentity, setRequestTraceErrorCode } from "../middleware/requestObservability";
import { recordEmailLoginRejectedTrace } from "./authLoginTrace";
import {
  authRefreshAttemptIdFromHeader,
  authRefreshInstallationIdFromHeader,
  recordAuthRefreshTrace,
  recordAuthSessionIssuedTrace,
} from "./authRefreshTrace";
import { sendJsonServerError } from "./errorResponse";
import {
  replaceAgentLineBreaks,
  isReservedAgentName,
  isSignupRoleId,
  REFERRAL_SOURCES,
  REFERRAL_SOURCES_LEGACY,
  normalizeTimeFormatPreference,
  normalizeTranslationLanguageCode,
  normalizeRailTabOrder,
  parseAssistantOtterShortcutPreference,
  parseComposerSendKeyPreference,
  parseShortcutOverridesPreference,
  validateName,
  type RailTabId,
  type StoredComposerSendKey,
  type StoredShortcutOverrides,
  type TimeFormatPreference,
} from "@botiverse/raft-shared";
import { getRegistrationBlockedReason } from "../services/registrationPolicy";
import {
  createAvatarUpload,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
  runSingleAvatarUpload,
  deleteReplacedUserAvatar,
  storedUserAvatarContentHash,
  storeUserAvatar,
} from "../services/avatarService";
import {
  isAutoHumanAvatarUrl,
  parseHumanAvatarRecipe,
  serializeHumanAvatarRecipe,
  setHumanAvatarRecipeBodySchema,
} from "@botiverse/raft-shared/src/humanAvatar";
import { isHumanAvatarBuilderOnForPerson } from "../services/humanAvatarBuilderFlag";
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
  assertPendingSocialLinkFor,
  assertPendingSocialLinkForHash,
  cancelPendingSocialLink,
  claimPendingSocialLinkByHash,
  pendingSocialLinkTokenHash,
  pkceS256Challenge,
  exchangeMobileConflictCompletionForPendingLink,
  exchangeWebConflictCompletionForPendingLink,
  PendingSocialLinkError,
  type PendingSocialLink,
  SocialLoginUnavailableError,
  isNativeAppleSignInConfigured,
  isSocialAuthProviderConfigured,
  markMobileOAuthCompletionConsumed,
  readStateCookie,
  sanitizeReturnTo,
  signSocialAuthState,
  validateSocialAuthCallbackState,
  verifySocialAuthState,
} from "../services/socialAuthService";
import type { SocialAuthMode, SocialAuthProfile, SocialAuthProvider } from "../services/socialAuthService";
import { socialLoginAllowed } from "../edition";
import { refuse } from "../lib/refusal";
import { parseCanonicalBrowserTimezone } from "../lib/ianaTimezone";
import { parseDisplayLanguage, parsePreferredTimezone } from "../lib/accountPreferenceParsers";
import { proofForMobileSocialLogin, proofForSignup, proofForSocialLogin, type SessionIssueProof } from "../services/sessionIssueGate";
import { parseAuthChallengeToken } from "../services/secondFactor/authChallenges";
import { PasskeySignInError, startPasskeySignIn, verifyPasskeySignIn } from "../services/secondFactor/passkeySignIn";
import { parsePasskeyAssertionResponse } from "../services/secondFactor/webauthn";
import { refuseWithoutRecentSecondFactor } from "./secondFactor";
import {
  completeSecondFactorRecoverySignIn,
  isSecondFactorRecoveryAnswer,
  parseSecondFactorSignInAnswer,
  SecondFactorSignInError,
  startSecondFactorSignIn,
  verifySecondFactorSignIn,
  type SecondFactorSignInContext,
  type SignInFinish,
} from "../services/secondFactor/signIn";
import {
  isWebClientTooOldForSecondFactor,
  WEB_CLIENT_TOO_OLD_CODE,
  WEB_CLIENT_TOO_OLD_STATUS,
  webClientTooOldBody,
} from "../services/secondFactor/oldWebClient";

export const authRouter: RouterType = Router();
/** /api/invites: what an invite's page tells the server (beside accept-invite and invite-info below). */
export const invitesRouter: RouterType = Router();
const MAX_USER_DESCRIPTION_LENGTH = 3000;
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

/** `undefined` = not sent; `null` = invalid, and a 400 was sent. */
function parsePendingLinkToken(body: unknown, res: Response): string | undefined | null {
  const value = (body as { pendingLinkToken?: unknown } | undefined)?.pendingLinkToken;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 256) {
    res.status(400).json({ code: "pending_link_token_invalid", error: "pendingLinkToken must be a string" });
    return null;
  }
  return value;
}

async function sendAccountLinkRequired(res: Response, pending: PendingSocialLink, extra: { returnTo?: string; returnUri?: string }) {
  const methods = await userService.getUserAuthMethods(pending.userId);
  res.status(409).json({
    code: "account_link_required",
    error: "An account with this email already exists. Sign in to it to connect this provider.",
    pendingLinkToken: pending.token,
    provider: pending.provider,
    email: pending.email,
    expiresAt: pending.expiresAt.toISOString(),
    signInMethods: {
      // "Known to be set": a few legacy accounts with a provider have a working
      // password but no recorded credential; they can use `providers`.
      password: methods?.passwordConfigured ?? false,
      providers: (methods?.identities ?? []).map((identity) => identity.provider),
    },
    ...extra,
  });
}

/**
 * A pending social link, checked against the account that is signing in and
 * its avatar fetched (outside any lock); the step it returns claims and
 * links it inside that sign-in's transaction, before the session. Carried by
 * the token's stored hash, which is also what a second-factor challenge
 * keeps (services/secondFactor/signIn.ts).
 */
type PendingSocialLinkStep = (tx: DatabaseExecutor) => Promise<{ provider: SocialAuthProvider; afterCommit: () => Promise<void> }>;

async function preparePendingSocialLink(tokenHash: string, userId: string): Promise<PendingSocialLinkStep> {
  const profile = await assertPendingSocialLinkForHash(tokenHash, userId);
  const prepared = await userService.prepareSocialLink(userId, profile);
  return async (tx) => {
    const claimed = await claimPendingSocialLinkByHash(tokenHash, userId, tx);
    const { afterCommit } = await userService.linkSocialIdentityTx(tx, userId, claimed, prepared);
    return { provider: claimed.provider, afterCommit };
  };
}

/** A password sign-in's link step (userService.PasswordSignInLinkStep), reporting the provider it linked. */
function passwordSignInLinkStep(link: PendingSocialLinkStep, onLinked: (provider: SocialAuthProvider) => void): userService.PasswordSignInLinkStep {
  return async (tx) => {
    const { provider, afterCommit } = await link(tx);
    onLinked(provider);
    return afterCommit;
  };
}

type CreatedSession = Awaited<ReturnType<typeof sessionService.createSession>>;
type SocialSignInFinished = { session: CreatedSession; linkedProvider?: SocialAuthProvider; afterCommit?: () => Promise<void> };

/**
 * The end of a web or mobile social sign-in, inside its transaction: commit
 * the pending link if any, then the session. Shared by the social endpoints
 * and their second step (POST /second-factor/verify).
 */
async function finishSocialSignIn(tx: DatabaseExecutor, proof: SessionIssueProof, link: PendingSocialLinkStep | null): Promise<SocialSignInFinished> {
  const linked = link ? await link(tx) : null;
  const session = await sessionService.createSession(proof, tx);
  return { session, ...(linked ? { linkedProvider: linked.provider, afterCommit: linked.afterCommit } : {}) };
}

/**
 * A social sign-in's first factor passed for `userId`: the gate runs inside
 * the transaction that would issue the session. Null when two-step
 * verification is on (nothing written: no link, no session).
 */
async function signInWithSocialFirstFactor(
  flow: "social_login" | "mobile_social_login",
  userId: string,
  link: PendingSocialLinkStep | null,
): Promise<SocialSignInFinished | null> {
  const finished = await getDb().transaction(async (tx) => {
    const gate = flow === "social_login" ? await proofForSocialLogin(userId, tx) : await proofForMobileSocialLogin(userId, tx);
    if (gate.secondFactorRequired) return null;
    return finishSocialSignIn(tx, gate.proof, link);
  });
  await finished?.afterCommit?.();
  return finished;
}

/** Extra success-body fields a second step adds (after a backup code). */
type SecondStepExtra = { backupCodesRemaining?: number };

/**
 * The password sign-in's success body; passkey sign-in answers with the same (only its trace differs).
 * A person with a scheduled account deletion also gets `accountDeletion: { status, scheduledFor }`,
 * so the web shows the pending-deletion page at once instead of probing first (Kirby, #triage:d10ace06).
 */
async function sendPasswordSignIn(
  req: Request,
  res: Response,
  signedIn: { user: { id: string }; session: CreatedSession; linkedProvider?: SocialAuthProvider },
  extra: SecondStepExtra = {},
  trace: "email_login" | "passkey_login" = "email_login",
) {
  const { user, session, linkedProvider } = signedIn;
  const accessToken = signAccessToken(user.id, session.familyId);
  attachAuthTraceIdentity(req, { userId: user.id, sessionId: session.sessionId, source: trace });
  recordAuthSessionIssuedTrace({ flow: trace, userId: user.id, sessionId: session.sessionId });
  const pendingDeletion = await findPendingAccountDeletion(getDb(), user.id).catch(() => null);
  res.json({
    user, accessToken, refreshToken: session.refreshToken,
    ...(linkedProvider ? { linkedProvider } : {}),
    ...extra,
    ...(pendingDeletion ? { accountDeletion: { status: "scheduled", scheduledFor: pendingDeletion.scheduledFor.toISOString() } } : {}),
  });
}

function sendWebSocialSignIn(
  req: Request,
  res: Response,
  signedIn: { userId: string; provider: SocialAuthProvider; returnTo: string | undefined; finished: SocialSignInFinished },
  extra: SecondStepExtra = {},
) {
  const { userId, finished: { session, linkedProvider } } = signedIn;
  const accessToken = signAccessToken(userId, session.familyId);
  attachAuthTraceIdentity(req, { userId, sessionId: session.sessionId, source: "social_oauth" });
  recordAuthSessionIssuedTrace({ flow: "social_oauth", userId, sessionId: session.sessionId });
  res.json({
    provider: signedIn.provider,
    mode: "login",
    returnTo: signedIn.returnTo,
    accessToken,
    refreshToken: session.refreshToken,
    ...(linkedProvider ? { linkedProvider } : {}),
    ...extra,
  });
}

function sendMobileSocialSignIn(
  req: Request,
  res: Response,
  signedIn: { user: { id: string }; provider: SocialAuthProvider; returnUri: string; finished: SocialSignInFinished },
  extra: SecondStepExtra = {},
) {
  const { user, finished: { session, linkedProvider } } = signedIn;
  res.json({
    user,
    provider: signedIn.provider,
    mode: "login",
    returnUri: signedIn.returnUri,
    accessToken: signAccessToken(user.id, session.familyId),
    refreshToken: session.refreshToken,
    ...(linkedProvider ? { linkedProvider } : {}),
    ...extra,
  });
}

function traceMobileSocialSignIn(req: Request, userId: string, session: CreatedSession) {
  attachAuthTraceIdentity(req, { userId, sessionId: session.sessionId, source: "mobile_oauth" });
  recordAuthSessionIssuedTrace({ flow: "mobile_oauth", userId, sessionId: session.sessionId });
}

/** An edition without social login (edition.ts): the same 404 the starts give an unconfigured provider. */
function socialLoginUnavailableResponse(res: Response, err: unknown): boolean {
  if (!(err instanceof SocialLoginUnavailableError)) return false;
  refuse(res, 404, { code: err.code, error: err.message });
  return true;
}

/** Refuses a social callback or completion before it reads its code (socialAuthService.assertSocialLoginAllowed). */
function refuseWithoutSocialLogin(res: Response): boolean {
  return !socialLoginAllowed() && socialLoginUnavailableResponse(res, new SocialLoginUnavailableError());
}

function pendingSocialLinkErrorResponse(res: Response, err: unknown): boolean {
  if (socialLoginUnavailableResponse(res, err)) return true;
  if (socialLinkEmailUnverifiedResponse(res, err)) return true;
  if (err instanceof PendingSocialLinkError) {
    res.status(err.code === "pending_link_expired" ? 410 : 403).json({ code: err.code, error: err.message });
    return true;
  }
  const message = errorMessage(err);
  if (message.includes("already linked to another") || message.includes("belongs to another")) {
    res.status(409).json({ code: "provider_conflict", error: message });
    return true;
  }
  return false;
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

function parseAutoTranslationEnabled(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new Error("autoTranslationEnabled must be a boolean");
  }
  return raw;
}

// RFC-067 "Share usage data": true / false, or null to go back to "not chosen"
// (the regional default, productAnalyticsGate.SHARE_USAGE_DATA_DEFAULT).
function parseShareUsageData(raw: unknown): boolean | null | undefined {
  if (raw === undefined) return undefined;
  if (raw !== null && typeof raw !== "boolean") {
    throw new Error("shareUsageData must be a boolean or null");
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

/** #proj-assistant:#21: show the assistant's otter over every page. */
function parseAssistantOtterVisible(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new Error("assistantOtterVisible must be a boolean");
  return raw;
}

// The rail tab order: null resets to the default; an array is stored complete
// (unknown ids dropped, missing tabs appended in their default place).
function parseRailTabOrder(raw: unknown): RailTabId[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 50 || raw.some((id) => typeof id !== "string")) {
    throw new Error("railTabOrder must be an array of tab ids, or null");
  }
  return normalizeRailTabOrder(raw);
}

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

// account_created (xxchan, 2026-10-22, task #13): where new accounts come
// from. The client is what the signup request says (X-Raft-Client-Platform),
// `unknown` when it does not; best effort, never delays the signup.
function recordAccountCreated(
  req: Request,
  userId: string,
  method: "email" | SocialAuthProvider,
  creationSource: "signup" | "oauth" | "invite",
): void {
  void recordServerProductEvent(getProductEventSink(req.app), {
    event: "account_created",
    userId,
    serverId: null,
    properties: {
      platform: requestClientPlatform(req.get("x-raft-client-platform"), req.get("user-agent")),
      method,
      invited: creationSource === "invite",
    },
  });
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

async function startMobileOAuthResponse(req: Request, res: Response, params: {
  providerId: string;
  mode: unknown;
  returnUri: unknown;
  codeChallenge: unknown;
  authenticatedUserId?: string;
  linkOnConflict?: boolean;
}) {
  const provider = getSocialAuthProvider(params.providerId);
  if (!provider) {
    res.status(400).json({ code: "provider_invalid", error: "provider must be google, github, or apple" });
    return;
  }
  if (!isSocialAuthProviderConfigured(provider.id)) {
    res.status(404).json({ code: "provider_not_configured", error: `${provider.label} sign-in is not configured` });
    return;
  }

  // An optional bearer (POST /mobile/oauth/start { mode: "link" }) has not
  // been gated by step-up yet; `authenticatedUserId` callers gate before this.
  const bearer = params.mode === "link" && !params.authenticatedUserId ? await getBearerAccessSession(req.headers.authorization) : null;
  const userId = params.mode === "link" ? params.authenticatedUserId ?? bearer?.userId : undefined;
  if (params.mode === "link" && !userId) {
    res.status(401).json({ code: "auth_required", error: "link mode requires authentication" });
    return;
  }
  // The complete leg is bound to this start's transaction: gating the start gates the link.
  if (bearer && await refuseWithoutRecentSecondFactor(res, bearer.userId, bearer.webFamilyId, "identity_link")) return;

  const started = await createMobileOAuthStart({
    provider: provider.id,
    mode: params.mode,
    returnUri: params.returnUri,
    codeChallenge: params.codeChallenge,
    userId: userId ?? undefined,
    linkOnConflict: params.linkOnConflict,
  });
  res.status(201).json({
    requestId: started.requestId,
    authorizationUrl: started.authorizationUrl,
    returnUri: started.returnUri,
    expiresAt: started.expiresAt.toISOString(),
  });
}

function socialLinkEmailUnverifiedResponse(res: Response, err: unknown): boolean {
  if (!(err instanceof userService.SocialLinkEmailUnverifiedError)) return false;
  res.status(403).json({ code: err.code, error: err.message });
  return true;
}

function mobileOAuthErrorResponse(res: Response, err: unknown, operation: "start" | "complete"): boolean {
  if (socialLinkEmailUnverifiedResponse(res, err)) return true;
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
  pendingLinkToken?: string;
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

  if (completion.mode === "login" && completion.intendedAction === "link") {
    const pending = await exchangeMobileConflictCompletionForPendingLink(completion.requestId);
    await sendAccountLinkRequired(res, pending, { returnUri: completion.returnUri });
    return;
  }
  // Refuse a wrong account before anything one-time is spent.
  if (completion.mode === "login" && params.pendingLinkToken) {
    await assertPendingSocialLinkFor(params.pendingLinkToken, completion.userId);
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
    const creationSource = parseSocialAccountCreationSource(req.body);
    user = await userService.createSocialUser(
      profile,
      parseLegalAcceptance(req.body),
      legalAcceptanceService.getRequestLegalMetadata(req),
      creationSource,
      { deferProfileSetup: true },
    );
    recordAccountCreated(req, user.id, completion.provider, creationSource);
  }

  const pendingLinkTokenHash = params.pendingLinkToken ? pendingSocialLinkTokenHash(params.pendingLinkToken) : null;
  const link = pendingLinkTokenHash ? await preparePendingSocialLink(pendingLinkTokenHash, user.id) : null;
  const finished = await signInWithSocialFirstFactor("mobile_social_login", user.id, link);
  if (!finished) {
    // Two-step verification is on: the handoff code is spent now, and the
    // challenge carries the rest (the link stays pending; PKCE-bound).
    await markMobileOAuthCompletionConsumed(completion.requestId);
    attachAuthTraceIdentity(req, { userId: user.id, source: "mobile_oauth", reason: "second_factor_required" });
    res.json(await startSecondFactorSignIn(user.id, {
      flow: "mobile_social_login",
      provider: completion.provider,
      returnUri: completion.returnUri,
      codeChallenge: pkceS256Challenge(params.codeVerifier),
      pendingLinkTokenHash,
    }));
    return;
  }
  traceMobileSocialSignIn(req, user.id, finished.session);
  await markMobileOAuthCompletionConsumed(completion.requestId);
  sendMobileSocialSignIn(req, res, { user, provider: completion.provider, returnUri: completion.returnUri, finished });
}

// Register
authRouter.post("/register", async (req, res) => {
  const registrationBlockedReason = getRegistrationBlockedReason();
  if (registrationBlockedReason) {
    res.status(403).json({ error: registrationBlockedReason });
    return;
  }
  try {
    if (await rejectLegacyPrivacyVersionRegister(req, res)) return;
  } catch (err) {
    sendJsonServerError(req, res, { error: "Registration failed", logPrefix: "Register error:", err });
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
      if (isReservedAgentName(name)) {
        res.status(400).json({ error: "This username is reserved. Choose another name." });
        return;
      }
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const creationSource = parseEmailAccountCreationSource(req.body);
    let verificationEmail: "sent" | "failed" | undefined;
    const user = await userService.createUser(
      email,
      password,
      name?.trim() ?? null,
      parseLegalAcceptance(req.body),
      legalAcceptanceService.getRequestLegalMetadata(req),
      creationSource,
      {
        deferProfileSetup: true,
        stagingSelfAccountCapability,
        verificationReturnTo: verificationReturnTo(req.body?.returnTo),
        onVerificationEmail: (result) => { verificationEmail = result; },
      },
    );
    recordAccountCreated(req, user.id, "email", creationSource);
    if (verificationEmail) recordEmailVerificationSent(req, user.id, "signup", verificationEmail);
    // E2E-only opt-in: verify ephemeral test users (e.g. the removed-dm DM-seed
    // peer) so they can post. Double-gated — the SLOCK_E2E_AUTO_VERIFY_EMAIL
    // test-env flag AND an explicit per-request opt-in — so the normal signup
    // flow still lands on the unverified email-verification screen (register.spec).
    // Never reachable in prod/staging (the env flag is only set in playwright.config.ts).
    if (process.env.SLOCK_E2E_AUTO_VERIFY_EMAIL === "1" && req.body?.__e2eAutoVerify === true) {
      await userService.markEmailVerifiedForTest(user.id);
    }
    const { sessionId, familyId, refreshToken } = await sessionService.createSession(await proofForSignup(user.id));
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
      sendJsonServerError(req, res, {
        error: "Registration failed",
        logPrefix: "Register error:",
        err,
      });
    }
  }
});

authRouter.get("/providers", async (req, res) => {
  // `platform` (web | mobile, default web) is still validated for older clients
  // that send it, but every platform sees the same list: a provider is offered
  // exactly when it is configured, matching what its start routes accept.
  const platformParam = typeof req.query.platform === "string" ? req.query.platform : "web";
  if (platformParam !== "web" && platformParam !== "mobile") {
    res.status(400).json({ code: "platform_invalid", error: "platform must be web or mobile" });
    return;
  }

  const providerConfigs = ["google", "github", "apple"]
    .map((providerId) => getSocialAuthProvider(providerId))
    .filter((provider): provider is NonNullable<typeof provider> => !!provider);

  const providers = providerConfigs.map((provider) => ({
    id: provider.id,
    label: provider.label,
    enabled: isSocialAuthProviderConfigured(provider.id),
  }));
  // RFC 083: "Continue with SSO" is offered once some Server has single sign-on on.
  const sso = await anySsoSignInOffered().catch(() => false);
  // The sign-up page's notice (source-available only; always false in cloud,
  // without a query): the deployment already has as many people as the Raft
  // License allows. Signing up still works; joining is what is refused.
  const deploymentUserLimitReached = await isDeploymentUserLimitReached().catch(() => false);

  res.json({ providers, sso, deploymentUserLimitReached });
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
    sendJsonServerError(req, res, {
      error: "Failed to load linked accounts",
      logPrefix: "List auth identities error:",
      err,
    });
  }
});

authRouter.delete("/identities/:provider", requireAuth, async (req, res) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    res.status(404).json({ code: "AUTH_PROVIDER_NOT_FOUND", error: "Unknown sign-in provider" });
    return;
  }

  try {
    if (await refuseWithoutRecentSecondFactor(res, req.userId!, sessionService.webSessionFamilyOf(req), "identity_unlink")) return;
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
    sendJsonServerError(req, res, {
      error: "Failed to disconnect linked account",
      logPrefix: "Unlink auth identity error:",
      err,
    });
  }
});

authRouter.post("/mobile/oauth/apple/native/start", async (req, res) => {
  try {
    if (!isNativeAppleSignInConfigured()) {
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
    const bearer = mode === "link" ? await getBearerAccessSession(req.headers.authorization) : null;
    // /authorize is bound to this start (signed request token, its stored
    // mode and user): gating the start gates linking Apple.
    if (bearer && await refuseWithoutRecentSecondFactor(res, bearer.userId, bearer.webFamilyId, "identity_link")) return;
    const started = await createNativeAppleMobileOAuthStart({
      mode,
      returnUri: req.body?.returnUri,
      codeChallenge: req.body?.codeChallenge,
      userId: bearer?.userId,
    });
    res.status(201).json({
      requestId: started.requestId,
      requestToken: started.requestToken,
      returnUri: started.returnUri,
      expiresAt: started.expiresAt.toISOString(),
    });
  } catch (err: unknown) {
    if (nativeAppleOAuthErrorResponse(res, err) || mobileOAuthErrorResponse(res, err, "start")) return;
    sendJsonServerError(req, res, {
      error: "Failed to start Apple sign-in",
      code: "native_apple_start_failed",
      logPrefix: "Native Apple OAuth start error:",
      err,
    });
  }
});

authRouter.post("/mobile/oauth/apple/native/authorize", async (req, res) => {
  try {
    if (!isNativeAppleSignInConfigured()) {
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
    if (await rejectLegacyMobileOAuthLogin(req, res)) return;
    await startMobileOAuthResponse(req, res, {
      providerId: typeof req.body?.provider === "string" ? req.body.provider : "",
      mode: req.body?.mode,
      returnUri: req.body?.returnUri,
      codeChallenge: req.body?.codeChallenge,
      linkOnConflict: req.body?.linkOnConflict === true,
    });
  } catch (err: unknown) {
    if (mobileOAuthErrorResponse(res, err, "start")) return;
    sendJsonServerError(req, res, {
      error: "Failed to start mobile OAuth",
      code: "mobile_oauth_start_failed",
      logPrefix: "Mobile OAuth start error:",
      err,
    });
  }
});

authRouter.post("/mobile/oauth/:provider/link/start", requireAuth, async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  try {
    // The complete leg is bound to this start's transaction: gating the start gates the link.
    if (await refuseWithoutRecentSecondFactor(res, req.userId!, sessionService.webSessionFamilyOf(req), "identity_link")) return;
    await startMobileOAuthResponse(req, res, {
      providerId: provider.id,
      mode: "link",
      returnUri: req.body?.returnUri,
      codeChallenge: req.body?.codeChallenge,
      authenticatedUserId: req.userId!,
    });
  } catch (err: unknown) {
    if (mobileOAuthErrorResponse(res, err, "start")) return;
    sendJsonServerError(req, res, {
      error: "Failed to start mobile OAuth link",
      code: "mobile_oauth_link_start_failed",
      logPrefix: "Mobile OAuth link start error:",
      err,
    });
  }
});

authRouter.post("/mobile/oauth/complete", async (req, res) => {
  if (refuseWithoutSocialLogin(res)) return;
  try {
    if (await rejectLegacyMobileOAuthLogin(req, res)) return;
    const pendingLinkToken = parsePendingLinkToken(req.body, res);
    if (pendingLinkToken === null) return;
    await completeMobileOAuthResponse(req, res, {
      code: req.body?.code,
      codeVerifier: req.body?.codeVerifier,
      pendingLinkToken,
    });
  } catch (err: unknown) {
    const legalResponse = legalAcceptanceService.legalAcceptanceErrorResponse(err);
    if (legalResponse) {
      res.status(legalResponse.status).json(legalResponse.body);
      return;
    }
    if (pendingSocialLinkErrorResponse(res, err)) return;
    if (mobileOAuthErrorResponse(res, err, "complete")) return;
    sendJsonServerError(req, res, {
      error: "Failed to complete mobile OAuth",
      code: "mobile_oauth_complete_failed",
      logPrefix: "Mobile OAuth completion error:",
      err,
    });
  }
});

authRouter.post("/mobile/oauth/:provider/link/complete", requireAuth, async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }
  if (refuseWithoutSocialLogin(res)) return;

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
    sendJsonServerError(req, res, {
      error: "Failed to complete mobile OAuth link",
      code: "mobile_oauth_link_complete_failed",
      logPrefix: "Mobile OAuth link completion error:",
      err,
    });
  }
});

authRouter.get("/:provider/start", async (req, res, next) => {
  const provider = getSocialAuthProvider(getProviderParam(req.params.provider));
  if (!provider) {
    next();
    return;
  }

  if (!isSocialAuthProviderConfigured(provider.id)) {
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
    ...(req.query.linkOnConflict === "1" ? { linkOnConflict: true } : {}),
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

  if (!isSocialAuthProviderConfigured(provider.id)) {
    res.status(404).json({ error: `${provider.label} sign-in is not configured` });
    return;
  }

  // The callback is bound to this start's signed state: gating the start gates the link.
  if (await refuseWithoutRecentSecondFactor(res, req.userId!, sessionService.webSessionFamilyOf(req), "identity_link")) return;

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
  if (refuseWithoutSocialLogin(res)) return;

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

      res.append("Set-Cookie", completionBindingCookie(socialCompletionBinding(provider.id), completionCode, SOCIAL_COMPLETION_BINDING_TTL_SECONDS));
      res.redirect(buildSocialAuthCallbackUrl({
        provider: provider.id,
        mode: "link",
        returnTo,
        code: completionCode,
      }));
      return;
    }

    let user: Awaited<ReturnType<typeof userService.findExistingSocialLoginUser>> = null;
    let emailConflict = false;
    try {
      user = await userService.findExistingSocialLoginUser(profile);
    } catch (err) {
      if (!(err instanceof userService.SocialEmailConflictError) || !state.linkOnConflict) throw err;
      emailConflict = true;
    }
    const completionCode = await createSocialAuthCompletion({
      provider: provider.id,
      mode: "login",
      // A conflict completion carries no userId, so a server that predates
      // pending links cannot read it as "sign in to the existing account".
      intendedAction: emailConflict ? "link" : "login",
      userId: user?.id,
      providerUserId: profile.providerUserId,
      providerEmail: profile.email,
      providerDisplayName: profile.displayName,
      providerAvatarUrl: profile.avatarUrl,
      providerEmailVerified: profile.emailVerified,
      returnTo,
    });

    // The code completes only in this browser (login CSRF; apps use PKCE).
    res.append("Set-Cookie", completionBindingCookie(socialCompletionBinding(provider.id), completionCode, SOCIAL_COMPLETION_BINDING_TTL_SECONDS));
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
  if (refuseWithoutSocialLogin(res)) return;

  try {
    const { code } = req.body;
    if (!code) {
      setRequestTraceErrorCode(res, "completion_code_required");
      res.status(400).json({ error: "Sign-in completion code is required" });
      return;
    }
    // Only the browser the provider answered can complete (login CSRF). Checked
    // before any lookup: another browser gets the same answer whether or not
    // the code exists, and spends nothing.
    const binding = socialCompletionBinding(provider.id);
    // Every client, whatever version it names (#raft-architecture:#32 retired
    // social_completion_binding with this as the permanent behaviour).
    if (typeof code !== "string" || !completionIsBound(binding, req.headers.cookie, code)) {
      setRequestTraceErrorCode(res, "browser_mismatch");
      res.status(400).json({ error: "This sign-in could not be finished. Refresh the page and sign in again.", code: "browser_mismatch" });
      return;
    }

    const pendingLinkToken = parsePendingLinkToken(req.body, res);
    if (pendingLinkToken === null) return;

    const pendingCompletion = await getSocialAuthCompletion(provider.id, code);
    if (pendingCompletion.mode === "login" && pendingCompletion.intendedAction === "link") {
      const pending = await exchangeWebConflictCompletionForPendingLink(provider.id, code);
      await sendAccountLinkRequired(res, pending, { returnTo: pendingCompletion.returnTo });
      return;
    }
    // Refuse a wrong account before the one-time completion code is spent.
    if (pendingCompletion.mode === "login" && pendingLinkToken) {
      await assertPendingSocialLinkFor(pendingLinkToken, pendingCompletion.userId);
    }
    if (pendingCompletion.mode === "login" && !pendingCompletion.userId) {
      legalAcceptanceService.requireCurrentLegalAcceptance(parseLegalAcceptance(req.body));
    }

    let authenticatedLinkUserId: string | null = null;
    if (pendingCompletion.mode === "link") {
      authenticatedLinkUserId = (await getBearerAccessUserId(req.headers.authorization));
      if (!authenticatedLinkUserId) {
        setRequestTraceErrorCode(res, "auth_required");
        res.status(401).json({ code: "auth_required", error: "Authentication is required to link an account" });
        return;
      }
      if (!pendingCompletion.userId || pendingCompletion.userId !== authenticatedLinkUserId) {
        setRequestTraceErrorCode(res, "link_user_mismatch");
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

    let userId = completion.userId;
    if (!userId) {
      const profile = socialProfileFromCompletion(provider, completion);
      const creationSource = parseSocialAccountCreationSource(req.body);
      const user = await userService.createSocialUser(
        profile,
        parseLegalAcceptance(req.body),
        legalAcceptanceService.getRequestLegalMetadata(req),
        creationSource,
        { deferProfileSetup: true },
      );
      recordAccountCreated(req, user.id, provider.id, creationSource);
      userId = user.id;
    }

    // A new account never has a pending link (refused above for no account).
    const pendingLinkTokenHash = pendingLinkToken ? pendingSocialLinkTokenHash(pendingLinkToken) : null;
    const link = pendingLinkTokenHash ? await preparePendingSocialLink(pendingLinkTokenHash, userId) : null;
    const finished = await signInWithSocialFirstFactor("social_login", userId, link);
    if (!finished) {
      // Two-step verification is on: the completion code is spent, the
      // challenge carries the rest (the link stays pending until it passes).
      if (isWebClientTooOldForSecondFactor((name) => req.header(name))) {
        attachAuthTraceIdentity(req, { userId, source: "social_oauth", reason: WEB_CLIENT_TOO_OLD_CODE });
        setRequestTraceErrorCode(res, WEB_CLIENT_TOO_OLD_CODE);
        res.status(WEB_CLIENT_TOO_OLD_STATUS).json(webClientTooOldBody);
        return;
      }
      attachAuthTraceIdentity(req, { userId, source: "social_oauth", reason: "second_factor_required" });
      res.json(await startSecondFactorSignIn(userId, {
        flow: "social_login",
        provider: completion.provider,
        returnTo: completion.returnTo ?? null,
        pendingLinkTokenHash,
      }));
      return;
    }
    sendWebSocialSignIn(req, res, { userId, provider: completion.provider, returnTo: completion.returnTo, finished });
  } catch (err: any) {
    const legalResponse = legalAcceptanceService.legalAcceptanceErrorResponse(err);
    if (legalResponse) {
      setRequestTraceErrorCode(res, legalResponse.body.error);
      res.status(legalResponse.status).json(legalResponse.body);
      return;
    }
    if (pendingSocialLinkErrorResponse(res, err)) return;
    const message = err?.message || "";
    if (message.includes("Invalid") || message.includes("expired") || message.includes("mismatch")) {
      setRequestTraceErrorCode(res, "completion_invalid");
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to complete sign-in",
      logPrefix: `${provider.label} auth completion error:`,
      err,
    });
  }
});

// Login
authRouter.post("/login", async (req, res) => {
  const body = parseEmailLoginRequest(req.body, res);
  if (!body) return;
  req.body = body;

  const pendingLinkToken = parsePendingLinkToken(body, res);
  if (pendingLinkToken === null) return;

  try {
    const { email, password } = body;

    let linkedProvider: SocialAuthProvider | undefined;
    // Read only once the password verified, as before.
    let pendingLinkTokenHash: string | null = null;
    const signedIn = await userService.authenticateUser(email, password, pendingLinkToken
      ? {
          prepareLink: async (userId) => {
            pendingLinkTokenHash = pendingSocialLinkTokenHash(pendingLinkToken);
            return passwordSignInLinkStep(
              await preparePendingSocialLink(pendingLinkTokenHash, userId),
              (provider) => { linkedProvider = provider; },
            );
          },
        }
      : {});
    if (signedIn.secondFactorRequired) {
      // Two-step verification is on: no session and no link yet.
      if (isWebClientTooOldForSecondFactor((name) => req.header(name))) {
        attachAuthTraceIdentity(req, { userId: signedIn.userId, source: "email_login", reason: WEB_CLIENT_TOO_OLD_CODE });
        res.status(WEB_CLIENT_TOO_OLD_STATUS).json(webClientTooOldBody);
        return;
      }
      attachAuthTraceIdentity(req, { userId: signedIn.userId, source: "email_login", reason: "second_factor_required" });
      res.json(await startSecondFactorSignIn(signedIn.userId, {
        flow: "password_login",
        passwordFingerprint: signedIn.passwordFingerprint,
        pendingLinkTokenHash,
      }));
      return;
    }
    await sendPasswordSignIn(req, res, { user: signedIn.user, session: signedIn.session, linkedProvider });
  } catch (err: any) {
    if (pendingSocialLinkErrorResponse(res, err)) return;
    if (err instanceof userService.EmailLoginRejectedError) {
      attachAuthTraceIdentity(req, { source: "email_login", reason: err.reason });
      const traceId = recordEmailLoginRejectedTrace(err.reason);
      if (traceId) {
        res.setHeader("X-Slock-Trace-Id", traceId);
      }
      res.status(401).json({ code: "AUTH_INVALID_CREDENTIALS", error: err.message });
    } else {
      sendJsonServerError(req, res, {
        error: "Login failed",
        logPrefix: "Login error:",
        err,
      });
    }
  }
});

type SsoSignedIn = Extract<SsoSignInResult, { kind: "signed_in" }>;

type SecondStepFinished =
  | { flow: "password_login"; user: { id: string }; session: CreatedSession; linkedProvider?: SocialAuthProvider; afterCommit?: () => Promise<void> }
  | { flow: "social_login"; userId: string; provider: SocialAuthProvider; returnTo: string | undefined; finished: SocialSignInFinished }
  | { flow: "mobile_social_login"; user: { id: string }; provider: SocialAuthProvider; returnUri: string; finished: SocialSignInFinished }
  | { flow: "sso_login"; signedIn: SsoSignedIn; returnTo: string | null };

/**
 * POST /api/auth/second-factor/verify { challenge, code (or totp) | backupCode |
 * webauthn, codeVerifier? (mobile) }: the second step of a password or social
 * sign-in (services/secondFactor/signIn.ts). Unauthenticated, behind
 * authLimiter like /login (mounted in app.ts ahead of the second-factor
 * management router, which requires a session). On success it answers
 * exactly as the first step would have without two-step verification (same
 * finish, same body), plus `backupCodesRemaining` after a backup code.
 *
 * `{ challenge, recovery: true, codeVerifier? }` instead finishes the
 * person's two-step verification recovery request (offered as `recovery` in
 * the challenge's methods once it is ready; services/secondFactor/recovery.ts):
 * the same finish and body, with every factor removed and every other sign-in
 * signed out; 409 `recovery_not_ready` (with `eligibleAt`) or
 * `recovery_not_found` otherwise.
 */
export async function secondFactorVerifyHandler(req: Request, res: Response): Promise<void> {
  const challenge = parseAuthChallengeToken(req.body?.challenge);
  const recovery = isSecondFactorRecoveryAnswer(req.body);
  const answer = recovery ? null : parseSecondFactorSignInAnswer(req.body);
  if (!challenge || (!answer && !recovery)) {
    res.status(400).json({ code: "invalid_request", error: "Send the sign-in challenge with a code from your authenticator app, a backup code or a passkey." });
    return;
  }
  const codeVerifier = typeof req.body?.codeVerifier === "string" ? req.body.codeVerifier : null;
  try {
    const prepare = async (context: SecondFactorSignInContext, userId: string): Promise<SignInFinish<SecondStepFinished>> => {
      const link = context.pendingLinkTokenHash ? await preparePendingSocialLink(context.pendingLinkTokenHash, userId) : null;
      if (context.flow === "password_login") {
        return async (tx, proof) => {
          let linkedProvider: SocialAuthProvider | undefined;
          const signedIn = await userService.finishPasswordSignInAfterSecondFactor(tx, {
            userId,
            passwordFingerprint: context.passwordFingerprint,
            proof,
            ...(link ? { linkInLock: passwordSignInLinkStep(link, (provider) => { linkedProvider = provider; }) } : {}),
          });
          // The password changed since the first step: start again.
          if (!signedIn) throw new SecondFactorSignInError("challenge_expired", "This sign-in has expired. Sign in again.");
          return { flow: "password_login", ...signedIn, linkedProvider };
        };
      }
      if (context.flow === "social_login") {
        const { provider, returnTo } = context;
        return async (tx, proof) => ({
          flow: "social_login",
          userId,
          provider,
          returnTo: returnTo ?? undefined,
          finished: await finishSocialSignIn(tx, proof, link),
        });
      }
      if (context.flow === "sso_login") {
        const { ssoConnectionId, returnTo } = context;
        return async (tx, proof) => ({
          flow: "sso_login",
          signedIn: await finishSsoSecondStep(tx, proof, { userId, connectionId: ssoConnectionId }),
          returnTo,
        });
      }
      // Mobile answers with the account as it was before the link, like its first step.
      const user = await userService.getUser(userId);
      if (!user) throw new SecondFactorSignInError("challenge_expired", "This sign-in has expired. Sign in again.");
      const { provider, returnUri } = context;
      return async (tx, proof) => ({ flow: "mobile_social_login", user, provider, returnUri, finished: await finishSocialSignIn(tx, proof, link) });
    };
    const verified = answer
      ? await verifySecondFactorSignIn<SecondStepFinished>({ challenge, answer, codeVerifier }, prepare)
      : await completeSecondFactorRecoverySignIn<SecondStepFinished>({ challenge, codeVerifier }, prepare);
    const { result } = verified;
    const extra: SecondStepExtra = verified.backupCodesRemaining === null ? {} : { backupCodesRemaining: verified.backupCodesRemaining };
    switch (result.flow) {
      case "password_login":
        await result.afterCommit?.();
        await sendPasswordSignIn(req, res, result, extra);
        return;
      case "social_login":
        await result.finished.afterCommit?.();
        sendWebSocialSignIn(req, res, result, extra);
        return;
      case "mobile_social_login":
        await result.finished.afterCommit?.();
        traceMobileSocialSignIn(req, result.user.id, result.finished.session);
        sendMobileSocialSignIn(req, res, result, extra);
        return;
      case "sso_login":
        await sendSsoSignIn(req, res, result.signedIn, result.returnTo, extra);
        return;
      default:
        throw new Error(`second factor verify: unhandled flow ${(result satisfies never as { flow: string }).flow}`);
    }
  } catch (err) {
    if (err instanceof SecondFactorSignInError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
      return;
    }
    if (err instanceof SsoSecondStepRefusedError) {
      res.status(403).json({ error: "This single sign-on can't sign you in right now.", code: err.reason });
      return;
    }
    // An edition without SSO (services/sso/ssoEdition.ts): an sso_login challenge issued before finishes nothing.
    if (enterpriseSsoUnavailableResponse(res, err)) return;
    if (pendingSocialLinkErrorResponse(res, err)) return;
    sendJsonServerError(req, res, { error: "Sign-in failed", logPrefix: "Second-factor sign-in error:", err });
  }
}

/**
 * Passkey sign-in (design v8 §1, §2 D3; rollout PR 4b;
 * services/secondFactor/passkeySignIn.ts): unauthenticated, behind authLimiter
 * like /login. A passkey with user verification is both factors, so a person
 * with two-step verification on is not asked for a second step. Open only to
 * an active account; anyone else's passkey is
 * `passkey_not_recognized`, like an unknown one. 404 `passkeys_unavailable`
 * without a WebAuthn relying party (an expected answer to every login page's
 * autofill request, so not a 5xx).
 *
 *   POST /passkey/options {}                    -> { options, expiresAt }
 *   POST /passkey/verify { challenge, response } -> exactly /login's success body
 */
function sendPasskeySignInError(req: Request, res: Response, err: unknown, failure: string): void {
  if (err instanceof PasskeySignInError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  sendJsonServerError(req, res, { error: failure, logPrefix: `[passkey-sign-in] ${failure}:`, err });
}

authRouter.post("/passkey/options", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await startPasskeySignIn());
  } catch (err) {
    sendPasskeySignInError(req, res, err, "Failed to start passkey sign-in");
  }
});

authRouter.post("/passkey/verify", async (req, res) => {
  const challenge = parseAuthChallengeToken(req.body?.challenge);
  const response = parsePasskeyAssertionResponse(req.body?.response);
  if (!challenge || !response) {
    res.status(400).json({ code: "invalid_request", error: "Send the passkey sign-in challenge and the passkey from your browser." });
    return;
  }
  try {
    const signedIn = await verifyPasskeySignIn({ challenge, response }, (tx, proof) => userService.finishPasskeySignIn(tx, proof));
    await sendPasswordSignIn(req, res, signedIn, {}, "passkey_login");
  } catch (err) {
    sendPasskeySignInError(req, res, err, "Sign-in failed");
  }
});

// Drop a pending social link (the person chose not to connect the provider).
authRouter.post("/pending-link/cancel", async (req, res) => {
  const pendingLinkToken = parsePendingLinkToken(req.body, res);
  if (pendingLinkToken === null) return;
  if (!pendingLinkToken) {
    res.status(400).json({ code: "pending_link_token_invalid", error: "pendingLinkToken is required" });
    return;
  }
  try {
    await cancelPendingSocialLink(pendingLinkToken);
    res.status(204).end();
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to cancel the pending link",
      logPrefix: "Pending social link cancel error:",
      err,
    });
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
      authRefreshInstallationId,
      refreshToken,
      userAgent: req.get("user-agent"),
    });
    if (!refreshed) {
      if (replayTrace.replayLookupResult === "superseded") {
        // The token this replay would hand back was itself refreshed since:
        // the client lost that rotation (task #72). Still a sign-in, but the
        // client can log why.
        attachAuthTraceIdentity(req, { source: "refresh", reason: "refresh_rotation_superseded" });
        res.status(401).json({ error: "Refresh token was already rotated", code: "refresh_rotation_superseded" });
        return;
      }
      if (await sessionService.isRevokedSessionRefreshToken(refreshToken)) {
        // This sign-in was ended (signed out, or by a security change made
        // from another sign-in such as turning two-step verification on).
        // A 401 like any refresh failure: every client signs in again.
        attachAuthTraceIdentity(req, { source: "refresh", reason: "refresh_session_revoked" });
        refuse(res, 401, { code: "session_revoked", error: "This sign-in was ended. Sign in again." });
        return;
      }
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
    // Additive (deep links, 1d): Raft Desktop's web client sends
    // X-Raft-Client-Platform: desktop_app, so its profile load is the record
    // that this account uses the app (a throttled write). The same read then
    // answers usedDesktopAppRecently; only this account's own /me carries it.
    if (req.get("x-raft-client-platform")?.trim() === "desktop_app") {
      await userService.recordDesktopAppSeen(req.userId!).catch(() => undefined);
    }
    const user = await userService.getUser(req.userId!, { withDesktopAppHint: true });
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
    sendJsonServerError(req, res, {
      error: "Failed to record timezone observation",
      logPrefix: "Record timezone observation error:",
      err,
    });
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
    }, () => recordAccountProfileCompleted(req, req.userId!));
    await announceProfileChange(req, user);
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
    sendJsonServerError(req, res, {
      error: "Failed to complete profile setup",
      logPrefix: "Complete profile error:",
      err,
    });
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
/**
 * A person's name or avatar changed: the viewers who may see them in each of
 * their servers' member lists hear `user:profile-updated` and patch that one
 * member in place (userProfileEvents.ts). Best effort: the change is saved.
 */
async function announceProfileChange(
  req: Request,
  user: { id: string; name: string; displayName: string | null; avatarUrl: string | null },
): Promise<void> {
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) return;
  const { id: userId, name, displayName, avatarUrl } = user;
  try {
    await announceUserProfileUpdated(io, { userId, name, displayName, avatarUrl });
  } catch (err) {
    console.warn(`[profile] Failed to announce a profile change for ${userId}:`, serializeErrorForLog(err));
  }
}

/**
 * What `PATCH /me { avatarUrl }` may set (Tenny, after #14303): no avatar
 * (null or ""), the photo this person already shows, or a built avatar they
 * chose. A photo is theirs only through `POST /me/avatar`, which stores it and
 * sets it as their avatar; uploads are shared by content hash and record no
 * other owner, so the one stored photo they may name is their current one (any
 * spelling of its URL; the stored value is kept as it is). A built avatar must
 * be a v1 recipe this build knows, without the Server-picked `/auto` marker,
 * and is stored in its canonical form. Anything else is refused.
 */
function patchedAvatarUrl(
  value: unknown,
  currentAvatarUrl: string | null,
): { ok: true; avatarUrl: string | null } | { ok: false; code: string; error: string } {
  if (value === null || value === "") return { ok: true, avatarUrl: null };
  if (typeof value === "string") {
    const hash = storedUserAvatarContentHash(value);
    if (hash) {
      if (hash === storedUserAvatarContentHash(currentAvatarUrl)) return { ok: true, avatarUrl: currentAvatarUrl };
      return {
        ok: false,
        code: "PROFILE_AVATAR_URL_NOT_OWN",
        error: "That photo is not your current avatar: upload the image to make it your avatar.",
      };
    }
    const recipe = isAutoHumanAvatarUrl(value) ? null : parseHumanAvatarRecipe(value);
    if (recipe) return { ok: true, avatarUrl: serializeHumanAvatarRecipe(recipe) };
  }
  return {
    ok: false,
    code: "PROFILE_AVATAR_URL_INVALID",
    error: "An avatar can only be removed (null), your own uploaded photo, or a pixel avatar built from the builder's options.",
  };
}

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

    // The avatar is checked before anything in this request is applied.
    let previousAvatarUrl: string | null = null;
    let nextAvatarUrl: string | null | undefined;
    if (avatarUrl !== undefined) {
      const currentUser = await userService.getUser(req.userId!);
      if (!currentUser) {
        respondInvalidOrExpiredToken(res);
        return;
      }
      previousAvatarUrl = currentUser.avatarUrl ?? null;
      const checked = patchedAvatarUrl(avatarUrl, previousAvatarUrl);
      if (!checked.ok) {
        refuse(res, 400, { code: checked.code, error: checked.error });
        return;
      }
      nextAvatarUrl = checked.avatarUrl;
    }

    // Password change
    if (currentPassword && newPassword) {
      if (newPassword.length < 8) {
        res.status(400).json({ error: "New password must be at least 8 characters" });
        return;
      }
      // Two-step verification on: this sign-in passed it in the last 10
      // minutes, or nothing in this request is applied (stepUpGate.ts).
      if (await refuseWithoutRecentSecondFactor(res, req.userId!, sessionService.webSessionFamilyOf(req), "password_change")) return;
      // The session that gave the current password keeps what it issued (securityRevokeCascade.ts).
      await userService.changePassword(req.userId!, currentPassword, newPassword, sessionService.webSessionFamilyOf(req));
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
      railTabOrder?: string[] | null;
      assistantOtterVisible?: boolean;
      assistantOtterShortcut?: string | null;
      composerSendKey?: StoredComposerSendKey;
      shortcutOverrides?: StoredShortcutOverrides | null;
      shareUsageData?: boolean | null;
      referralSource?: string | null;
      referralSourceOther?: string | null;
      referralSourceSkippedAt?: Date | null;
      signupRole?: string | null;
      signupSurveyCompletedAt?: Date | null;
    } = {};
    // Free text other people's agents read: a display name has no line break, a description only `\n`.
    if (displayName !== undefined) profileFields.displayName = typeof displayName === "string" ? replaceAgentLineBreaks(displayName, " ") : displayName;
    if (description !== undefined) {
      if (description !== null && (typeof description !== "string" || description.length > MAX_USER_DESCRIPTION_LENGTH)) {
        res.status(400).json({ error: `Description must be a string of at most ${MAX_USER_DESCRIPTION_LENGTH} characters` });
        return;
      }
      profileFields.description = typeof description === "string" ? (replaceAgentLineBreaks(description, "\n").trim() || null) : null;
    }
    if (nextAvatarUrl !== undefined) profileFields.avatarUrl = nextAvatarUrl;
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
      const railTabOrder = parseRailTabOrder(req.body?.railTabOrder);
      if (railTabOrder !== undefined) profileFields.railTabOrder = railTabOrder;
      const assistantOtterVisible = parseAssistantOtterVisible(req.body?.assistantOtterVisible);
      if (assistantOtterVisible !== undefined) profileFields.assistantOtterVisible = assistantOtterVisible;
      const assistantOtterShortcut = parseAssistantOtterShortcutPreference(req.body?.assistantOtterShortcut);
      if (assistantOtterShortcut !== undefined) profileFields.assistantOtterShortcut = assistantOtterShortcut;
      const composerSendKey = parseComposerSendKeyPreference(req.body?.composerSendKey);
      if (composerSendKey !== undefined) profileFields.composerSendKey = composerSendKey;
      const shortcutOverrides = parseShortcutOverridesPreference(req.body?.shortcutOverrides);
      if (shortcutOverrides !== undefined) profileFields.shortcutOverrides = shortcutOverrides;
      const shareUsageData = parseShareUsageData(req.body?.shareUsageData);
      if (shareUsageData !== undefined) profileFields.shareUsageData = shareUsageData;
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

    // RFC-067: turning "Share usage data" off unlinks everything recorded so
    // far (deletes the analytics-id mapping); turning it on mints a fresh id.
    if (profileFields.shareUsageData === false || profileFields.shareUsageData === true) {
      await setProductAnalyticsOptOut(getDb(), req.userId!, !profileFields.shareUsageData);
    }

    // Any avatar change (null included): the photo it replaces goes
    // (previousAvatarUrl, read when the avatar was checked).
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
    if (profileFields.displayName !== undefined || profileFields.avatarUrl !== undefined) {
      await announceProfileChange(req, user);
    }
    if (profileFields.avatarUrl !== undefined) await deleteReplacedUserAvatar(previousAvatarUrl, user.avatarUrl);

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
      sendJsonServerError(req, res, {
        error: "Failed to update profile",
        logPrefix: "Update profile error:",
        err,
      });
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
    await announceProfileChange(req, user);

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
    sendJsonServerError(req, res, {
      error: "Failed to upload avatar",
      logPrefix: "User avatar upload error:",
      err,
    });
  }
});

// Set the current user's avatar to a built pixel avatar: the options, never an
// image (shared humanAvatar.ts). It replaces whatever avatar was there; a photo
// Raft stored is deleted unless someone else still shows it. It shares the
// /api/auth rate limit and tells the person's servers, like an upload.
//
// Behind human_avatar_builder_v0: the server the request names when the
// person is in it, else any of their servers (humanAvatarBuilderFlag.ts).
authRouter.put("/me/avatar-recipe", requireAuth, async (req, res) => {
  try {
    if (!(await isHumanAvatarBuilderOnForPerson(req.userId!, req.headers["x-server-id"]))) {
      refuse(res, 404, {
        code: "HUMAN_AVATAR_BUILDER_DISABLED",
        error: "Building an avatar isn't available on this server yet: upload a photo instead.",
      });
      return;
    }
    const parsed = setHumanAvatarRecipeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      refuse(res, 400, {
        code: "PROFILE_AVATAR_RECIPE_INVALID",
        error: "That avatar has an option this server doesn't know: pick every part from the builder's own options.",
      });
      return;
    }
    const previous = await userService.getUser(req.userId!);
    const user = await userService.updateUser(req.userId!, { avatarUrl: serializeHumanAvatarRecipe(parsed.data.recipe) });
    if (!user) {
      respondInvalidOrExpiredToken(res);
      return;
    }
    await announceProfileChange(req, user);
    await deleteReplacedUserAvatar(previous?.avatarUrl, user.avatarUrl);
    res.json(user);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to save avatar",
      logPrefix: "User avatar recipe error:",
      err,
    });
  }
});

/**
 * The page a sign-up came from, carried through the verification email and
 * back from verify-email (#88: an Artifact link survives sign-up). Client
 * input: only a same-site relative path survives (sanitizeReturnTo, the
 * social sign-in's validator); anything else is dropped silently (undefined: land on `/`).
 */
function verificationReturnTo(value: unknown): string | undefined {
  const path = sanitizeReturnTo(value);
  return path === "/" ? undefined : path;
}

// Verify email
authRouter.post("/verify-email", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    const verified = await userService.verifyEmailToken(token);
    if (!verified) {
      res.status(400).json({ error: "Invalid or expired verification token" });
      return;
    }
    if (verified.newlyVerified) recordEmailVerified(req, verified.userId);

    // Where the web lands after verifying: the link's returnTo, validated here again (it came back through a URL).
    const returnTo = verificationReturnTo(req.body?.returnTo);
    res.json(returnTo ? { ok: true, returnTo } : { ok: true });
  } catch {
    res.status(500).json({ error: "Email verification failed" });
  }
});

// Resend verification email
authRouter.post("/resend-verification", requireAuth, async (req, res) => {
  try {
    await userService.resendVerificationEmail(req.userId!, verificationReturnTo(req.body?.returnTo));
    recordEmailVerificationSent(req, req.userId!, "resend", "sent");
    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("already verified")) {
      res.status(400).json({ error: msg });
    } else if (msg.includes("Too many") || msg.includes("Please wait")) {
      recordEmailVerificationSent(req, req.userId!, "resend", "rate_limited");
      res.status(429).json({ error: msg });
    } else {
      if (!msg.includes("User not found")) recordEmailVerificationSent(req, req.userId!, "resend", "failed");
      sendJsonServerError(req, res, {
        error: "Failed to resend verification email",
        logPrefix: "Resend verification error:",
        err,
      });
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
authRouter.post("/accept-invite", requireAuth, requireVerified, async (req, res) => {
  try {
    const { token, agreementId } = req.body;
    if (!token) {
      res.status(400).json({ error: "Invite token is required" });
      return;
    }

    // The join and the end of their seat notice commit apart: one seat-join-blocks:changed.
    const result = await coalesceListChanges(async () => {
      const accepted = await inviteService.acceptInvite(token, req.userId!, {
        agreementId: typeof agreementId === "string" ? agreementId : null,
        ...getAgreementRequestMetadata(req),
      });
      // Committed: deliver the server.member_added App Notification now.
      kickAppNotificationDelivery();
      // They're in: a notice that a full link turned them away goes (task #10).
      await seatJoinBlockService.resolveSeatJoinBlock({ serverId: accepted.serverId, userId: req.userId!, reason: "joined" })
        .catch((err: unknown) => console.warn(`[seat-join-blocks] Failed to resolve after invite accept for ${req.userId}:`, serializeErrorForLog(err)));
      return accepted;
    });
    const io = req.app.get("io") as SocketServer | undefined;
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (io) {
      if (result.promotedFromGuest) {
        // A Guest promoted to member (inviteService.promoteGuestByInvite), as a role change by hand announces it.
        io.to(`server:${result.serverId}`).emit("server:member-updated", {
          serverId: result.serverId,
          userId: req.userId!,
          previousRole: result.promotedFromGuest.previousRole,
          role: result.promotedFromGuest.role,
        });
      } else {
        io.to(`server:${result.serverId}`).emit("server:member-added", {
          serverId: result.serverId,
          userId: req.userId!,
        });
      }
      if (agentOrchestrator) {
        // A promoted Guest is onboarded now: Guests skip it.
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
    // The Raft License's user limit (source-available): 403 with its code.
    if (err instanceof DeploymentUserLimitError) {
      refuse(res, err.status, err.refusal);
      return;
    }
    const msg = err?.message || "";
    if (
      msg.includes("Invalid")
      || msg.includes("expired")
      || msg.includes("already")
      || msg.includes("revoked")
      || msg.includes("usage limit")
      || msg.includes("no longer valid")
      || msg.includes("different email")
      || msg.includes("seat limit")
      || msg.includes("limit reached")
    ) {
      // The code only: the invitee isn't a member yet, so no numbers.
      res.status(400).json(err instanceof HumanSeatLimitError ? { error: msg, code: err.code } : { error: msg });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to accept invite",
        logPrefix: "Accept invite error:",
        err,
      });
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

// A signed-in person's page of a full invite or join link says its owners were
// told (task #10, behind pro_seat_add): this tells them. The server checks the
// token, the flag, that they aren't a member and that the seats really are
// full; who made the link comes from the token. seatJoinBlockService.ts.
invitesRouter.post("/seat-blocked", requireAuth, requireProfileSetupComplete, async (req, res) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token) {
      res.status(400).json({ error: "Invite token is required" });
      return;
    }
    const out = await seatJoinBlockService.recordSeatJoinBlock(token, req.userId!);
    if (!out) {
      res.status(404).json({ error: "Invalid or expired invite" });
      return;
    }
    res.json(out);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to record the blocked join",
      logPrefix: "Seat-blocked invite error:",
      err,
    });
  }
});

// Logout
authRouter.post("/logout", async (req, res) => {
  try {
    // No body (or no token) logs nothing out: the client already dropped its tokens.
    const refreshToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : null;
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
