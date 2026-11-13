import { revokeSocketAccess } from "../socket/accessRevocation";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { eq, and, asc, gt, isNull, sql } from "drizzle-orm";
import argon2 from "argon2";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { getDb } from "../db/index";
import type { DatabaseExecutor } from "../db/index";
import { users, emailVerifications, passwordResets, userAuthIdentities, userBackupCodes, userTotp, webauthnCredentials, sessionFamilies, sessions, userRetirementReceipts } from "../db/schema";
import { sendVerificationEmail, sendPasswordResetEmail } from "./emailService";
import { normalizeEmail } from "./emailNormalization";
import { syncNewsletterSignup } from "./newsletterService";
import { enqueueOnboardingEmailJourneyForUser } from "./onboardingEmailJourneyService";
import { assertRegistrationEnabled } from "./registrationPolicy";
import type { SocialAuthProfile, SocialAuthProvider } from "./socialAuthService";
import * as legalAcceptanceService from "./legalAcceptanceService";
import { DEPRECATED_GRAVATAR_HASH, currentDate, isReservedAgentName, normalizeRailTabOrder, normalizeShortcutOverrides, validateName } from "@botiverse/raft-shared";
import type { StoredComposerSendKey, StoredShortcutOverrides } from "@botiverse/raft-shared";
import { createSession, denyLoginCodesApprovedBy, revokeAllUserSessionsInTransaction } from "./sessionService";
import { revokeKeysOfRevokedDeviceSessions } from "./deviceSessionKeys";
import type { ApproverSessionRevokeTrigger } from "./approverSessionGrants";
import { runSecurityRevokeCascade } from "./securityRevokeCascade";
import { isStoredUserAvatarUrl, materializeUserProviderAvatar } from "./avatarService";
import { isAutoHumanAvatarUrl, randomHumanAvatarRecipe, serializeHumanAvatarRecipe } from "@botiverse/raft-shared/src/humanAvatar";
import { isHumanAvatarBuilderOnForServer } from "./humanAvatarBuilderFlag";
import { forgetTraceUserId } from "../tracing/traceUserId";
import { proofForPasswordLogin, type SessionIssueProof } from "./sessionIssueGate";
import { passwordFingerprint } from "./secondFactor/signIn";

export const PROFILE_SETUP_PLACEHOLDER_PREFIX = "pending_";
const PROFILE_SETUP_PLACEHOLDER_RANDOM_BYTES = 10;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  preferredLanguage?: string | null;
  displayLanguage?: string | null;
  preferredTimezone?: string | null;
  firstObservedTimezone?: string | null;
  firstObservedTimezoneAt?: Date | null;
  lastObservedTimezone?: string | null;
  lastObservedTimezoneAt?: Date | null;
  autoTranslationEnabled?: boolean | null;
  preferredTranslationMode?: "auto" | "manual" | "off" | null;
  preferredTranslationDisplay?: "translated" | "original" | "bilingual" | null;
  preferredTimeFormat?: "12h" | "24h" | null;
  preferredMessageBodyFontSize?: "sm" | "md" | "lg" | null;
  railTabOrder?: string[] | null;
  assistantOtterVisible?: boolean | null;
  assistantOtterShortcut?: string | null;
  composerSendKey?: StoredComposerSendKey;
  shortcutOverrides?: StoredShortcutOverrides | null;
  shareUsageData?: boolean | null;
  referralSource?: string | null;
  referralSourceOther?: string | null;
  referralSourceSkippedAt?: Date | null;
  profileSetupCompletedAt?: Date | null;
  profileSetupSuggestedHandle?: string | null;
  profileSetupProvider?: SocialAuthProvider | null;
  signupRole?: string | null;
  signupSurveyCompletedAt?: Date | null;
}) {
  const preferredTranslationMode =
    user.preferredTranslationMode
    ?? (user.autoTranslationEnabled === false ? "off" : "auto");
  return {
    id: user.id,
    email: user.email,
    gravatarHash: DEPRECATED_GRAVATAR_HASH,
    name: user.name,
    displayName: user.displayName,
    description: user.description,
    avatarUrl: user.avatarUrl,
    emailVerified: user.emailVerified,
    preferredLanguage: user.preferredLanguage ?? null,
    displayLanguage: user.displayLanguage ?? null,
    preferredTimezone: user.preferredTimezone ?? null,
    firstObservedTimezone: user.firstObservedTimezone ?? null,
    firstObservedTimezoneAt: user.firstObservedTimezoneAt ?? null,
    // During a rolling deploy, a pre-0187 server can still populate only the
    // immutable first pair. Treat that accepted intermediate state as the
    // latest observation until a new server writes the mutable last pair.
    lastObservedTimezone: user.lastObservedTimezone ?? user.firstObservedTimezone ?? null,
    lastObservedTimezoneAt: user.lastObservedTimezoneAt ?? user.firstObservedTimezoneAt ?? null,
    preferredTranslationMode,
    autoTranslationEnabled: preferredTranslationMode === "auto",
    preferredTranslationDisplay: user.preferredTranslationDisplay ?? "translated",
    preferredTimeFormat: user.preferredTimeFormat ?? null,
    preferredMessageBodyFontSize: user.preferredMessageBodyFontSize ?? null,
    // null = the default order; a stored order comes back complete.
    railTabOrder: user.railTabOrder == null ? null : normalizeRailTabOrder(user.railTabOrder),
    // #proj-assistant:#21: the otter over every page (on unless turned off) and its shortcut (null = the default, "off" = none).
    assistantOtterVisible: user.assistantOtterVisible ?? true,
    assistantOtterShortcut: user.assistantOtterShortcut ?? null,
    // #triage:#210: how the message box sends (null = Enter, the default).
    composerSendKey: user.composerSendKey ?? null,
    // #proj-frontend:#37: the keyboard shortcuts the person changed (null = every default).
    shortcutOverrides: user.shortcutOverrides == null ? null : normalizeShortcutOverrides(user.shortcutOverrides),
    // RFC-067 "Share usage data"; null = not chosen yet.
    shareUsageData: user.shareUsageData ?? null,
    referralSource: user.referralSource ?? null,
    referralSourceOther: user.referralSourceOther ?? null,
    referralSourceSkippedAt: user.referralSourceSkippedAt ?? null,
    profileSetupCompletedAt: user.profileSetupCompletedAt ?? null,
    profileSetupSuggestedHandle: user.profileSetupSuggestedHandle ?? null,
    // The client gates on this: null = the signup survey has not been answered.
    signupSurveyCompletedAt: user.signupSurveyCompletedAt ?? null,
    signupRole: user.signupRole ?? null,
    profileSetupProvider: user.profileSetupProvider ?? null,
  };
}

type PublicUser = ReturnType<typeof toPublicUser>;

export type CompleteProfileErrorCode =
  | "PROFILE_SETUP_ALREADY_COMPLETED"
  | "PROFILE_SETUP_NAME_INVALID"
  | "PROFILE_SETUP_NAME_TAKEN"
  | "PROFILE_SETUP_USER_NOT_FOUND";

export class CompleteProfileError extends Error {
  constructor(public readonly code: CompleteProfileErrorCode, message: string) {
    super(message);
    this.name = "CompleteProfileError";
  }
}

export type EmailLoginRejectionReason = "user_missing" | "password_mismatch" | "user_retired";

/**
 * Internal-only discriminator for email-login rejection observability.
 *
 * The public route deliberately maps both reasons to the same 401 response so
 * callers cannot enumerate accounts. Keeping the reason on the typed error
 * lets the request trace record a closed, PII-free diagnostic fact without
 * parsing an error message or attaching a user/email/password.
 */
export class EmailLoginRejectedError extends Error {
  constructor(public readonly reason: EmailLoginRejectionReason) {
    super("Invalid email or password");
    this.name = "EmailLoginRejectedError";
  }
}

/**
 * A social login whose verified email already belongs to an account that has
 * no identity for this provider. The message is the user-facing sentence older
 * clients and the `email already exists` classifiers still match; `userId` is
 * the existing account, so a client that opted in can link inline instead.
 */
export class SocialEmailConflictError extends Error {
  constructor(public readonly userId: string, provider: SocialAuthProvider) {
    super(`An account with this email already exists. Sign in with email and password first, then connect ${getProviderLabel(provider)} in Settings.`);
    this.name = "SocialEmailConflictError";
  }
}

export class PasswordCredentialRequiredError extends Error {
  readonly code = "PASSWORD_CREDENTIAL_REQUIRED";

  constructor() {
    super("Set a password before disconnecting your final sign-in account.");
    this.name = "PasswordCredentialRequiredError";
  }
}

async function enqueueOnboardingEmailJourneyFailOpen(user: PublicUser): Promise<void> {
  try {
    await enqueueOnboardingEmailJourneyForUser(user);
  } catch (err) {
    console.warn(`[OnboardingEmailJourney] Failed to enqueue for user ${user.id}:`, err);
  }
}

async function runCompletedProfileSideEffects(user: PublicUser): Promise<void> {
  await syncNewsletterSignup(user);
  if (user.emailVerified) {
    await enqueueOnboardingEmailJourneyFailOpen(user);
  }
}

function createPendingHandle(): string {
  return `${PROFILE_SETUP_PLACEHOLDER_PREFIX}${randomBytes(PROFILE_SETUP_PLACEHOLDER_RANDOM_BYTES).toString("hex")}`;
}

/**
 * True when `name` is not already taken by an existing user. Exact,
 * case-sensitive match on `users.name` — the same uniqueness contract enforced
 * on insert (createUser) and completeProfile. Used by the identity-setup
 * on-blur precheck; the authoritative check still happens at completeProfile
 * (this is UX, not a gate — a name can be taken between blur and submit).
 */
export async function isUsernameAvailable(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const db = getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.name, trimmed));
  return !existing;
}

async function getProfileSetupProvider(
  database: DatabaseExecutor,
  userId: string,
): Promise<SocialAuthProvider | null> {
  const [identity] = await database.select({
    provider: userAuthIdentities.provider,
  }).from(userAuthIdentities)
    .where(eq(userAuthIdentities.userId, userId))
    .orderBy(asc(userAuthIdentities.createdAt), asc(userAuthIdentities.id))
    .limit(1);
  return identity?.provider ?? null;
}

type PgErrorLike = {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
};

function findPgError(err: unknown): PgErrorLike | null {
  let current = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as PgErrorLike;
    if (candidate.code === "23505") return candidate;
    current = candidate.cause;
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return findPgError(err) !== null;
}

function isExactUserNameUniqueViolation(err: unknown): boolean {
  return findPgError(err)?.constraint === "idx_users_name_exact_unique";
}

function getProviderLabel(provider: SocialAuthProvider): string {
  switch (provider) {
    case "google":
      return "Google";
    case "github":
      return "GitHub";
    case "apple":
      return "Apple";
    default:
      return provider;
  }
}

function slugifyUserName(seed: string): string {
  const normalized = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const withLetterPrefix = /^[a-z]/.test(normalized) ? normalized : `user-${normalized}`;
  const compact = withLetterPrefix.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const fallback = compact || "user-account";
  return fallback.length >= 5 ? fallback : `${fallback}-user`;
}

async function generateAvailableUserName(seed: string, database: DatabaseExecutor): Promise<string> {
  const base = slugifyUserName(seed);

  for (let suffix = 0; suffix < 100; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const [existingUser] = await database.select({ id: users.id }).from(users).where(eq(users.name, candidate));
    if (!existingUser) return candidate;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${base}-${randomBytes(2).toString("hex")}`;
    const [existingUser] = await database.select({ id: users.id }).from(users).where(eq(users.name, candidate));
    if (!existingUser) return candidate;
  }

  throw new Error("Failed to allocate a unique username");
}

function assertUsableSocialProfile(profile: SocialAuthProfile): asserts profile is SocialAuthProfile & {
  email: string;
  providerUserId: string;
} {
  if (!profile.email || !profile.providerUserId) {
    throw new Error(`${getProviderLabel(profile.provider)} profile is missing required identity fields`);
  }
  if (!profile.emailVerified) {
    throw new Error(`${getProviderLabel(profile.provider)} account email is not verified`);
  }
}

function isProviderHotlinkedAvatarUrl(avatarUrl: string | null): boolean {
  if (!avatarUrl || isStoredUserAvatarUrl(avatarUrl)) return false;
  try {
    const url = new URL(avatarUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// A provider's photo replaces no avatar, an old hotlink, or the built avatar
// the Server picked for a new account (`/auto`); never one the person chose.
function shouldReplaceSocialAvatar(existingAvatarUrl: string | null): boolean {
  return !existingAvatarUrl || isProviderHotlinkedAvatarUrl(existingAvatarUrl) || isAutoHumanAvatarUrl(existingAvatarUrl);
}

function chooseSocialAvatarUrl(existingAvatarUrl: string | null, materializedAvatarUrl: string | null): string | null {
  if (!shouldReplaceSocialAvatar(existingAvatarUrl)) return existingAvatarUrl;
  return materializedAvatarUrl ?? existingAvatarUrl;
}

async function materializeSocialAvatar(existingAvatarUrl: string | null, profile: SocialAuthProfile): Promise<string | null> {
  if (!shouldReplaceSocialAvatar(existingAvatarUrl)) return null;
  return materializeUserProviderAvatar({
    existingAvatarUrl,
    providerAvatarUrl: profile.avatarUrl,
  });
}

/**
 * A random built pixel avatar, marked as picked by the Server (`/auto`), so
 * the builder opens on it, and a provider's photo (a social sign-in or link
 * later) may still replace it.
 */
export function newAccountAvatarUrl(): string {
  return serializeHumanAvatarRecipe(randomHumanAvatarRecipe(() => randomInt(0, 2 ** 32) / 2 ** 32), { auto: true });
}

/**
 * A new account's avatar, behind human_avatar_builder_v0 for the server the
 * account is joining: a random built one where it is on, else none (the
 * generic person icon, as before). Sign-up that knows no server (email,
 * social) passes none and gets none. Accounts made before keep what they had.
 */
export async function newAccountAvatarUrlFor(
  joiningServerId: string | null,
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  return (await isHumanAvatarBuilderOnForServer(joiningServerId, executor)) ? newAccountAvatarUrl() : null;
}

// ── User CRUD ──

export async function createUser(
  email: string,
  password: string,
  name: string | null,
  legalAcceptance: legalAcceptanceService.LegalAcceptanceInput,
  legalMetadata: legalAcceptanceService.LegalAcceptanceMetadata = {},
  legalSource: Extract<legalAcceptanceService.LegalAcceptanceSource, "signup" | "invite"> = "signup",
  options: {
    deferProfileSetup?: boolean;
    stagingSelfAccountCapability?: string;
    /** Where the verification link lands after verifying (an Artifact link signed up from); sanitized by the email. */
    verificationReturnTo?: string;
    /** Told whether the provider took the verification email (the product event `email_verification_sent`). */
    onVerificationEmail?: (result: "sent" | "failed") => void;
  } = {},
) {
  const db = getDb();
  const normalizedEmail = normalizeEmail(email);

  if (!options.deferProfileSetup && !name) {
    throw new Error("Username is required");
  }

  const [existingEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail));
  if (existingEmail) {
    throw new Error("Email is already registered");
  }

  if (!options.deferProfileSetup && name) {
    const [existingName] = await db.select({ id: users.id }).from(users).where(eq(users.name, name));
    if (existingName) {
      throw new Error("Username is already taken");
    }
  }

  const passwordHash = await argon2.hash(password);

  const token = randomBytes(32).toString("hex");

  let publicUser: PublicUser;
  try {
    publicUser = await db.transaction(async (transaction) => {
      const accepted = legalAcceptanceService.requireCurrentLegalAcceptance(legalAcceptance);

      const pendingHandle = options.deferProfileSetup ? createPendingHandle() : null;
      const suggestedHandle = options.deferProfileSetup
        ? await generateAvailableUserName(name ?? normalizedEmail.split("@")[0] ?? "user", transaction)
        : null;
      const [user] = await transaction.insert(users).values({
        email: normalizedEmail,
        name: pendingHandle ?? name!,
        displayName: options.deferProfileSetup ? null : name,
        // Email sign-up joins no server yet: no avatar (newAccountAvatarUrlFor).
        passwordHash,
        passwordCredentialEstablishedAt: currentDate(),
        profileSetupCompletedAt: options.deferProfileSetup ? null : currentDate(),
        profileSetupSuggestedHandle: suggestedHandle,
        stagingSelfAccountCapabilityHash: options.stagingSelfAccountCapability
          ? hashToken(options.stagingSelfAccountCapability)
          : null,
        // Signed up on a page without the usage-data clause: not told, not on.
        ...(accepted.sawUsageDataNotice ? {} : { shareUsageData: false }),
      }).returning();

      await legalAcceptanceService.insertUserLegalAcceptance(transaction, user.id, legalSource, legalMetadata, accepted);
      await transaction.insert(emailVerifications).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
      });

      return toPublicUser(user);
    });
  } catch (err) {
    if (isExactUserNameUniqueViolation(err)) {
      throw new Error("Username is already taken");
    }
    throw err;
  }

  // The account is committed above: a verification email the provider refuses
  // must not turn a created account into "Registration failed" (the retry then
  // says "already registered"). The user lands on the verify-email screen and
  // can resend from there (task #55).
  try {
    await sendVerificationEmail(normalizedEmail, options.deferProfileSetup ? "there" : name!, token, options.verificationReturnTo);
    options.onVerificationEmail?.("sent");
  } catch (err) {
    console.error("[userService] Verification email failed after account creation:", serializeErrorForLog(err));
    options.onVerificationEmail?.("failed");
  }

  if (!options.deferProfileSetup) {
    await syncNewsletterSignup(publicUser);
  }

  return publicUser;
}

/**
 * E2E-only: force-verify a freshly-registered user's email so an ephemeral test
 * user can post (real email verification can't complete in e2e). The caller
 * (auth register route) double-gates this on the SLOCK_E2E_AUTO_VERIFY_EMAIL
 * test-env flag AND an explicit per-request opt-in, so the normal signup flow
 * (and its register.spec coverage) still lands on the unverified screen. Never
 * reachable in prod/staging — the env flag is only set in playwright.config.ts.
 */
export async function markEmailVerifiedForTest(userId: string): Promise<void> {
  const db = getDb();
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
}

/**
 * Pending social link (task #1304) for a password sign-in. `prepare` runs
 * after the password verifies, outside the lock; the step it returns runs
 * inside the locked transaction, after the hash is revalidated and before
 * the session is created, and returns what to run after commit. A
 * credential rejected at any point leaves no link behind, and a failed
 * session rolls the link back.
 */
export type PasswordSignInLinkStep = (tx: DatabaseExecutor) => Promise<() => Promise<void>>;

export type PasswordSignInResult =
  | { secondFactorRequired: false; user: ReturnType<typeof toPublicUser>; session: Awaited<ReturnType<typeof createSession>> }
  /** Two-step verification is on: no session, no link; the caller starts the second step. */
  | { secondFactorRequired: true; userId: string; passwordFingerprint: string };

type LockedPasswordUser = typeof users.$inferSelect;

/**
 * The end of a password sign-in, inside the transaction that holds the
 * person's row (`current`, FOR UPDATE): commit the pending link if any, heal
 * the password marker, create the session with `proof`. Shared by the
 * password step itself and by its second step (services/secondFactor/signIn.ts).
 */
async function finishPasswordSignInLocked(
  tx: DatabaseExecutor,
  current: LockedPasswordUser,
  proof: SessionIssueProof,
  linkInLock: PasswordSignInLinkStep | undefined,
) {
  let linked: LockedPasswordUser | undefined;
  let afterCommit: (() => Promise<void>) | undefined;
  if (linkInLock) {
    afterCommit = await linkInLock(tx);
    [linked] = await tx.select().from(users).where(eq(users.id, current.id));
  }
  await healPasswordCredentialMarker(tx, current);
  return { ...(await signInLocked(tx, linked ?? current, proof)), afterCommit };
}

/** The session and the public account a sign-in answers with, for the person's locked row. */
async function signInLocked(tx: DatabaseExecutor, current: LockedPasswordUser, proof: SessionIssueProof) {
  const session = await createSession(proof, tx);
  return {
    user: toPublicUser({
      ...current,
      profileSetupProvider: await getProfileSetupProvider(tx, current.id),
    }),
    session,
  };
}

/**
 * A passkey sign-in passed (services/secondFactor/passkeySignIn.ts): inside
 * its transaction, after the gate, issue the session and answer with the
 * account exactly as a password sign-in would. The gate already checked the
 * account is active under the same row lock.
 */
export async function finishPasskeySignIn(tx: DatabaseExecutor, proof: SessionIssueProof) {
  const [current] = await tx.select().from(users).where(eq(users.id, proof.userId)).for("update");
  if (!current || current.retiredAt) throw new Error("finishPasskeySignIn: the gate admitted an inactive account");
  return signInLocked(tx, current, proof);
}

/**
 * Social-only users also have a non-null hash for rolling-schema
 * compatibility, but it is an unknowable random placeholder. Verifying the
 * supplied password is therefore the safe provenance test: a real legacy
 * password succeeds even if the human later linked a social identity, while
 * a placeholder remains unusable. Only a successful verification may heal
 * the durable marker.
 */
async function healPasswordCredentialMarker(tx: DatabaseExecutor, current: LockedPasswordUser): Promise<void> {
  if (current.passwordCredentialEstablishedAt) return;
  await tx.update(users).set({
    passwordCredentialEstablishedAt: currentDate(),
  }).where(and(
    eq(users.id, current.id),
    isNull(users.passwordCredentialEstablishedAt),
  ));
}

export async function authenticateUser(
  email: string,
  password: string,
  options: { prepareLink?: (userId: string) => Promise<PasswordSignInLinkStep> } = {},
): Promise<PasswordSignInResult> {
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  if (!user) {
    throw new EmailLoginRejectedError("user_missing");
  }
  if (user.retiredAt) {
    throw new EmailLoginRejectedError("user_retired");
  }

  // See healPasswordCredentialMarker: the placeholder hash of a social-only
  // account never verifies.
  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    throw new EmailLoginRejectedError("password_mismatch");
  }
  const linkInLock = await options.prepareLink?.(user.id);

  // Argon2 is deliberately outside the lock. Revalidate its exact hash under
  // the same user lock held by password changes and session issuance.
  let afterCommit: (() => Promise<void>) | undefined;
  const result = await db.transaction(async (tx): Promise<PasswordSignInResult> => {
    const [current] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
    if (!current || current.retiredAt) throw new EmailLoginRejectedError("user_retired");
    if (current.passwordHash !== user.passwordHash) throw new EmailLoginRejectedError("password_mismatch");
    const gate = await proofForPasswordLogin(user.id, tx);
    if (gate.secondFactorRequired) {
      await healPasswordCredentialMarker(tx, current);
      return { secondFactorRequired: true, userId: user.id, passwordFingerprint: passwordFingerprint(current.passwordHash) };
    }
    const finished = await finishPasswordSignInLocked(tx, current, gate.proof, linkInLock);
    afterCommit = finished.afterCommit;
    return { secondFactorRequired: false, user: finished.user, session: finished.session };
  });
  await afterCommit?.();
  return result;
}

/**
 * The password sign-in's second step passed (services/secondFactor/signIn.ts):
 * finish it inside the verify transaction, exactly as the password step
 * would have. Null when the password changed since the first step (or the
 * account was retired): the challenge no longer stands. The caller runs
 * `afterCommit` once the transaction commits.
 */
export async function finishPasswordSignInAfterSecondFactor(
  tx: DatabaseExecutor,
  input: { userId: string; passwordFingerprint: string; proof: SessionIssueProof; linkInLock?: PasswordSignInLinkStep },
) {
  const [current] = await tx.select().from(users).where(eq(users.id, input.userId)).for("update");
  if (!current || current.retiredAt || passwordFingerprint(current.passwordHash) !== input.passwordFingerprint) return null;
  return finishPasswordSignInLocked(tx, current, input.proof, input.linkInLock);
}

export async function retireStagingSelfAccount(userId: string, actorUserId: string, capability: string) {
  if (process.env.SLOCK_RELEASE_BRANCH !== "staging") {
    throw new Error("STAGING_SELF_ACCOUNT_ONLY");
  }
  if (userId !== actorUserId) throw new Error("RETIREMENT_OWNER_MISMATCH");
  if (!capability || typeof capability !== "string") throw new Error("RETIREMENT_CAPABILITY_INVALID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("RETIREMENT_USER_NOT_FOUND");
  }
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const existing = await tx.select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      retiredAt: users.retiredAt,
      capabilityHash: users.stagingSelfAccountCapabilityHash,
    })
      .from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (!existing[0]) throw new Error("RETIREMENT_USER_NOT_FOUND");
    if (!existing[0].emailVerified || !/@mail\.build$/i.test(existing[0].email)) {
      throw new Error("RETIREMENT_ACCOUNT_CLASS_MISMATCH");
    }
    if (!existing[0].capabilityHash || existing[0].capabilityHash !== hashToken(capability)) {
      throw new Error("RETIREMENT_CAPABILITY_INVALID");
    }
    if (existing[0].retiredAt) {
      const [receipt] = await tx.select().from(userRetirementReceipts)
        .where(eq(userRetirementReceipts.userId, userId)).limit(1);
      return receipt ?? null;
    }
    const now = currentDate();
    // Rotating trace_user_id unlinks the account from its traces (kept indefinitely).
    const [updated] = await tx.update(users)
      .set({ retiredAt: now, retiredReason: "staging_self_account", traceUserId: sql`gen_random_uuid()` })
      .where(and(eq(users.id, userId), isNull(users.retiredAt))).returning({ id: users.id });
    forgetTraceUserId(userId);
    if (!updated) {
      const [raceReceipt] = await tx.select().from(userRetirementReceipts)
        .where(eq(userRetirementReceipts.userId, userId)).limit(1);
      if (raceReceipt) return raceReceipt;
      throw new Error("RETIREMENT_RACE");
    }
    const activeSessions = await tx.select({ id: sessions.id }).from(sessions)
      .where(eq(sessions.userId, userId));
    await tx.update(sessionFamilies).set({ revokedAt: now, revokedReason: "staging_self_account" })
      .where(and(eq(sessionFamilies.userId, userId), isNull(sessionFamilies.revokedAt)));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await denyLoginCodesApprovedBy(tx, userId, "all", now);
    const [receipt] = await tx.insert(userRetirementReceipts).values({
      userId, actorUserId, environment: "staging", terminalState: "retired",
      sessionsRevoked: activeSessions.length,
    }).onConflictDoNothing().returning();
    return receipt ?? null;
  });
  try {
    await revokeSocketAccess({ userId });
  } finally {
    await revokeDeviceSessionKeysAfterSignOut(userId);
    await revokeWhatSessionsApprovedAfterSecurityRevoke(userId, "account_retired", null);
  }
  return result;
}

export async function getUser(userId: string): Promise<ReturnType<typeof toPublicUser> | null>;
export async function getUser(
  userId: string,
  options: { withDesktopAppHint: true },
): Promise<(ReturnType<typeof toPublicUser> & { usedDesktopAppRecently: boolean }) | null>;
export async function getUser(userId: string, options: { withDesktopAppHint?: boolean } = {}) {
  const db = getDb();
  const [row] = await db.select({
    id: users.id,
    email: users.email,
    name: users.name,
    displayName: users.displayName,
    description: users.description,
    avatarUrl: users.avatarUrl,
    emailVerified: users.emailVerified,
    preferredLanguage: users.preferredLanguage,
    displayLanguage: users.displayLanguage,
    preferredTimezone: users.preferredTimezone,
    firstObservedTimezone: users.firstObservedTimezone,
    firstObservedTimezoneAt: users.firstObservedTimezoneAt,
    lastObservedTimezone: users.lastObservedTimezone,
    lastObservedTimezoneAt: users.lastObservedTimezoneAt,
    autoTranslationEnabled: users.autoTranslationEnabled,
    shareUsageData: users.shareUsageData,
    preferredTranslationMode: users.preferredTranslationMode,
    preferredTranslationDisplay: users.preferredTranslationDisplay,
    preferredTimeFormat: users.preferredTimeFormat,
    preferredMessageBodyFontSize: users.preferredMessageBodyFontSize,
    railTabOrder: users.railTabOrder,
    assistantOtterVisible: users.assistantOtterVisible,
    assistantOtterShortcut: users.assistantOtterShortcut,
    composerSendKey: users.composerSendKey,
    shortcutOverrides: users.shortcutOverrides,
    referralSource: users.referralSource,
    referralSourceOther: users.referralSourceOther,
    referralSourceSkippedAt: users.referralSourceSkippedAt,
    profileSetupCompletedAt: users.profileSetupCompletedAt,
    profileSetupSuggestedHandle: users.profileSetupSuggestedHandle,
    signupRole: users.signupRole,
    signupSurveyCompletedAt: users.signupSurveyCompletedAt,
    lastDesktopAppSeenAt: users.lastDesktopAppSeenAt,
  }).from(users).where(eq(users.id, userId));
  if (!row) return null;
  const { lastDesktopAppSeenAt, ...user } = row;
  const publicUser = toPublicUser({
    ...user,
    profileSetupProvider: await getProfileSetupProvider(db, user.id),
  });
  if (!options.withDesktopAppHint) return publicUser;
  return { ...publicUser, usedDesktopAppRecently: isRecentDesktopAppUse(lastDesktopAppSeenAt) };
}

export async function getUserByEmail(email: string) {
  const db = getDb();
  const [user] = await db.select({
    id: users.id,
    email: users.email,
    name: users.name,
    displayName: users.displayName,
    description: users.description,
    avatarUrl: users.avatarUrl,
    emailVerified: users.emailVerified,
    preferredLanguage: users.preferredLanguage,
    displayLanguage: users.displayLanguage,
    preferredTimezone: users.preferredTimezone,
    firstObservedTimezone: users.firstObservedTimezone,
    firstObservedTimezoneAt: users.firstObservedTimezoneAt,
    lastObservedTimezone: users.lastObservedTimezone,
    lastObservedTimezoneAt: users.lastObservedTimezoneAt,
    autoTranslationEnabled: users.autoTranslationEnabled,
    shareUsageData: users.shareUsageData,
    preferredTranslationMode: users.preferredTranslationMode,
    preferredTranslationDisplay: users.preferredTranslationDisplay,
    preferredTimeFormat: users.preferredTimeFormat,
    preferredMessageBodyFontSize: users.preferredMessageBodyFontSize,
    railTabOrder: users.railTabOrder,
    assistantOtterVisible: users.assistantOtterVisible,
    assistantOtterShortcut: users.assistantOtterShortcut,
    composerSendKey: users.composerSendKey,
    shortcutOverrides: users.shortcutOverrides,
    referralSource: users.referralSource,
    referralSourceOther: users.referralSourceOther,
    referralSourceSkippedAt: users.referralSourceSkippedAt,
    profileSetupCompletedAt: users.profileSetupCompletedAt,
    profileSetupSuggestedHandle: users.profileSetupSuggestedHandle,
    signupRole: users.signupRole,
    signupSurveyCompletedAt: users.signupSurveyCompletedAt,
  }).from(users).where(eq(users.email, normalizeEmail(email)));
  if (!user) return null;
  return toPublicUser({
    ...user,
    profileSetupProvider: await getProfileSetupProvider(db, user.id),
  });
}

export type UserUpdateFields = {
  displayName?: string;
  description?: string | null;
  avatarUrl?: string | null;
  preferredLanguage?: string | null;
  displayLanguage?: string | null;
  preferredTimezone?: string | null;
  autoTranslationEnabled?: boolean;
  preferredTranslationMode?: "auto" | "manual" | "off";
  preferredTranslationDisplay?: "translated" | "original" | "bilingual";
  preferredTimeFormat?: "12h" | "24h" | null;
  preferredMessageBodyFontSize?: "sm" | "md" | "lg" | null;
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
};

/** The write half of updateUser, on a caller's transaction (assistantOwnerSettingsService). */
export async function writeUserFields(userId: string, fields: UserUpdateFields, db: DatabaseExecutor = getDb()): Promise<void> {
  await db.update(users).set({
    ...fields,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));
}

export async function updateUser(userId: string, fields: UserUpdateFields) {
  await writeUserFields(userId, fields);
  const user = await getUser(userId);
  return user;
}

export async function recordBrowserTimezoneObservation(userId: string, timezone: string) {
  const db = getDb();
  // Use PostgreSQL's statement clock as the authoritative arrival time. App
  // replicas can have skewed host clocks; statement_timestamp() is stable for
  // every expression in this UPDATE while still advancing between requests.
  const observedAt = sql<Date>`statement_timestamp()`;
  const [recorded] = await db.update(users).set({
    firstObservedTimezone: sql`coalesce(${users.firstObservedTimezone}, ${timezone})`,
    firstObservedTimezoneAt: sql`coalesce(${users.firstObservedTimezoneAt}, ${observedAt})`,
    lastObservedTimezone: sql`case
      when ${users.lastObservedTimezoneAt} is null or ${users.lastObservedTimezoneAt} <= ${observedAt}
        then ${timezone}
      else ${users.lastObservedTimezone}
    end`,
    lastObservedTimezoneAt: sql`greatest(coalesce(${users.lastObservedTimezoneAt}, ${observedAt}), ${observedAt})`,
  }).where(eq(users.id, userId)).returning({
    firstObservedTimezone: users.firstObservedTimezone,
    firstObservedTimezoneAt: users.firstObservedTimezoneAt,
    lastObservedTimezone: users.lastObservedTimezone,
    lastObservedTimezoneAt: users.lastObservedTimezoneAt,
  });
  return recorded ?? null;
}

/** How long a Raft Desktop sign-in counts as "uses the desktop app" for the desktop-browser banner. */
export const DESKTOP_APP_RECENT_USE_DAYS = 30;

/**
 * Deep links (task 1d): a request from Raft Desktop stamps
 * users.last_desktop_app_seen_at, at most once a day so the profile load
 * stays a read. getUser({ withDesktopAppHint }) reads it back as "used Raft
 * Desktop in the last {@link DESKTOP_APP_RECENT_USE_DAYS} days". A hint only:
 * it decides whether a desktop browser offers "Open in Raft Desktop", never
 * anything that matters for access.
 */
export async function recordDesktopAppSeen(userId: string): Promise<void> {
  await getDb().update(users).set({
    lastDesktopAppSeenAt: sql`statement_timestamp()`,
  }).where(and(
    eq(users.id, userId),
    sql`(${users.lastDesktopAppSeenAt} is null or ${users.lastDesktopAppSeenAt} < statement_timestamp() - interval '1 day')`,
  ));
}

function isRecentDesktopAppUse(seenAt: Date | null): boolean {
  if (!seenAt) return false;
  return Date.now() - seenAt.getTime() < DESKTOP_APP_RECENT_USE_DAYS * 24 * 60 * 60 * 1000;
}

async function listUserAuthIdentitiesTx(database: DatabaseExecutor, userId: string) {
  return database.select({
    provider: userAuthIdentities.provider,
    providerEmail: userAuthIdentities.providerEmail,
  }).from(userAuthIdentities)
    .where(eq(userAuthIdentities.userId, userId))
    .orderBy(asc(userAuthIdentities.createdAt), asc(userAuthIdentities.id));
}

export async function listUserAuthIdentities(userId: string) {
  return listUserAuthIdentitiesTx(getDb(), userId);
}

export async function getUserAuthMethods(userId: string) {
  const db = getDb();
  const [user] = await db.select({
    passwordCredentialEstablishedAt: users.passwordCredentialEstablishedAt,
  }).from(users).where(eq(users.id, userId));
  if (!user) return null;

  return {
    identities: await listUserAuthIdentitiesTx(db, userId),
    passwordConfigured: user.passwordCredentialEstablishedAt !== null,
  };
}

export async function unlinkSocialIdentity(userId: string, provider: SocialAuthProvider) {
  const db = getDb();
  return db.transaction(async (transaction) => {
    // One account row serializes concurrent unlink/link decisions. Without the
    // lock, two DELETEs could each observe two identities and remove both.
    const [user] = await transaction.select({
      id: users.id,
      passwordCredentialEstablishedAt: users.passwordCredentialEstablishedAt,
    }).from(users).where(eq(users.id, userId)).for("update");
    if (!user) {
      throw new Error("User not found");
    }

    const identities = await transaction.select({
      id: userAuthIdentities.id,
      provider: userAuthIdentities.provider,
      providerEmail: userAuthIdentities.providerEmail,
    }).from(userAuthIdentities)
      .where(eq(userAuthIdentities.userId, userId))
      .orderBy(asc(userAuthIdentities.createdAt), asc(userAuthIdentities.id));
    const identity = identities.find((candidate) => candidate.provider === provider);

    if (!identity) {
      return {
        unlinked: false,
        identities: identities.map(({ provider: id, providerEmail }) => ({ provider: id, providerEmail })),
        passwordConfigured: user.passwordCredentialEstablishedAt !== null,
      };
    }

    if (identities.length === 1 && !user.passwordCredentialEstablishedAt) {
      throw new PasswordCredentialRequiredError();
    }

    await transaction.delete(userAuthIdentities).where(and(
      eq(userAuthIdentities.id, identity.id),
      eq(userAuthIdentities.userId, userId),
    ));

    return {
      unlinked: true,
      identities: identities
        .filter((candidate) => candidate.id !== identity.id)
        .map(({ provider: id, providerEmail }) => ({ provider: id, providerEmail })),
      passwordConfigured: user.passwordCredentialEstablishedAt !== null,
    };
  });
}

async function getPublicUserByIdTx(database: DatabaseExecutor, userId: string) {
  const [user] = await database.select({
    id: users.id,
    email: users.email,
    name: users.name,
    displayName: users.displayName,
    description: users.description,
    avatarUrl: users.avatarUrl,
    emailVerified: users.emailVerified,
    preferredLanguage: users.preferredLanguage,
    displayLanguage: users.displayLanguage,
    preferredTimezone: users.preferredTimezone,
    firstObservedTimezone: users.firstObservedTimezone,
    firstObservedTimezoneAt: users.firstObservedTimezoneAt,
    lastObservedTimezone: users.lastObservedTimezone,
    lastObservedTimezoneAt: users.lastObservedTimezoneAt,
    autoTranslationEnabled: users.autoTranslationEnabled,
    shareUsageData: users.shareUsageData,
    preferredTranslationMode: users.preferredTranslationMode,
    preferredTranslationDisplay: users.preferredTranslationDisplay,
    preferredTimeFormat: users.preferredTimeFormat,
    preferredMessageBodyFontSize: users.preferredMessageBodyFontSize,
    railTabOrder: users.railTabOrder,
    assistantOtterVisible: users.assistantOtterVisible,
    assistantOtterShortcut: users.assistantOtterShortcut,
    composerSendKey: users.composerSendKey,
    shortcutOverrides: users.shortcutOverrides,
    referralSource: users.referralSource,
    referralSourceOther: users.referralSourceOther,
    referralSourceSkippedAt: users.referralSourceSkippedAt,
    profileSetupCompletedAt: users.profileSetupCompletedAt,
    profileSetupSuggestedHandle: users.profileSetupSuggestedHandle,
    signupRole: users.signupRole,
    signupSurveyCompletedAt: users.signupSurveyCompletedAt,
  }).from(users).where(eq(users.id, userId));

  if (!user) return null;
  return toPublicUser({
    ...user,
    profileSetupProvider: await getProfileSetupProvider(database, user.id),
  });
}

async function upsertSocialIdentityTx(
  database: DatabaseExecutor,
  userId: string,
  profile: SocialAuthProfile,
) {
  const normalizedEmail = normalizeEmail(profile.email);
  const [existingIdentity] = await database.select({
    id: userAuthIdentities.id,
    userId: userAuthIdentities.userId,
  }).from(userAuthIdentities).where(and(
    eq(userAuthIdentities.provider, profile.provider),
    eq(userAuthIdentities.providerUserId, profile.providerUserId),
  ));

  if (existingIdentity && existingIdentity.userId !== userId) {
    throw new Error(`This ${getProviderLabel(profile.provider)} account is already linked to another Raft account`);
  }

  if (existingIdentity) {
    await database.update(userAuthIdentities).set({
      providerEmail: normalizedEmail,
      updatedAt: new Date(),
    }).where(eq(userAuthIdentities.id, existingIdentity.id));
    return;
  }

  await database.insert(userAuthIdentities).values({
    userId,
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    providerEmail: normalizedEmail,
  });
}

/**
 * The checks and avatar fetch for a social link that must run outside any
 * transaction. Pass the result to linkSocialIdentityTx.
 */
export async function prepareSocialLink(userId: string, profile: SocialAuthProfile) {
  const db = getDb();
  assertUsableSocialProfile(profile);
  const [currentUser] = await db.select({
    avatarUrl: users.avatarUrl,
  }).from(users).where(eq(users.id, userId));
  if (!currentUser) {
    throw new Error("User not found");
  }
  return { materializedAvatarUrl: await materializeSocialAvatar(currentUser.avatarUrl, profile) };
}

/**
 * An account whose email is not verified may link only a provider that
 * vouches for that same email: otherwise whoever registered someone
 * else's address could attach their own Google/GitHub/Apple and keep signing
 * in after the real owner takes the account over with a password reset.
 */
export class SocialLinkEmailUnverifiedError extends Error {
  readonly code = "email_verification_required";
  constructor() {
    super("Verify your email before connecting a sign-in provider");
  }
}

/**
 * Link inside the caller's transaction. Returns what to run after commit.
 */
export async function linkSocialIdentityTx(
  transaction: DatabaseExecutor,
  userId: string,
  profile: SocialAuthProfile,
  prepared: { materializedAvatarUrl: string | null },
) {
  const normalizedEmail = normalizeEmail(profile.email);
  const [user] = await transaction.select({
    id: users.id,
    email: users.email,
    avatarUrl: users.avatarUrl,
    emailVerified: users.emailVerified,
  }).from(users).where(eq(users.id, userId)).for("update");

  if (!user) {
    throw new Error("User not found");
  }
  if (!user.emailVerified && normalizeEmail(user.email) !== normalizedEmail) {
    throw new SocialLinkEmailUnverifiedError();
  }

  // Another account registered with the provider's email does not block the
  // link: sign-in resolves by provider user id first, so this identity signs
  // in as this account, and the email is left as it is. Refusing here let
  // anyone who registered someone else's address keep its owner from
  // connecting their own provider account.
  try {
    await upsertSocialIdentityTx(transaction, userId, profile);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error(`This ${getProviderLabel(profile.provider)} account was linked concurrently. Please try again.`);
    }
    throw err;
  }

  const shouldVerifyEmail = normalizeEmail(user.email) === normalizedEmail;
  const shouldStartOnboardingJourney = shouldVerifyEmail && !user.emailVerified;
  await transaction.update(users).set({
    avatarUrl: chooseSocialAvatarUrl(user.avatarUrl, prepared.materializedAvatarUrl),
    emailVerified: shouldVerifyEmail ? true : user.emailVerified,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  const linkedUser = await getPublicUserByIdTx(transaction, userId);
  if (!linkedUser) {
    throw new Error("Failed to link social account");
  }
  return {
    linkedUser,
    afterCommit: async () => {
      if (shouldStartOnboardingJourney) {
        await enqueueOnboardingEmailJourneyFailOpen(linkedUser);
      }
    },
  };
}

export async function linkSocialIdentity(userId: string, profile: SocialAuthProfile) {
  const prepared = await prepareSocialLink(userId, profile);
  const { linkedUser, afterCommit } = await getDb().transaction(
    (transaction) => linkSocialIdentityTx(transaction, userId, profile, prepared),
  );
  await afterCommit();
  return linkedUser;
}

export async function findExistingSocialLoginUser(profile: SocialAuthProfile): Promise<PublicUser | null> {
  const db = getDb();
  assertUsableSocialProfile(profile);
  const normalizedEmail = normalizeEmail(profile.email);

  const [existingIdentity] = await db.select({
    userId: userAuthIdentities.userId,
  }).from(userAuthIdentities).where(and(
    eq(userAuthIdentities.provider, profile.provider),
    eq(userAuthIdentities.providerUserId, profile.providerUserId),
  ));

  if (existingIdentity) {
    await upsertSocialIdentityTx(db, existingIdentity.userId, profile);
    let linkedUser = await getPublicUserByIdTx(db, existingIdentity.userId);
    if (!linkedUser) {
      throw new Error("Linked user not found");
    }
    const materializedAvatarUrl = await materializeSocialAvatar(linkedUser.avatarUrl, profile);
    const nextAvatarUrl = chooseSocialAvatarUrl(linkedUser.avatarUrl, materializedAvatarUrl);
    if (nextAvatarUrl !== linkedUser.avatarUrl) {
      await db.update(users).set({
        avatarUrl: nextAvatarUrl,
        updatedAt: new Date(),
      }).where(eq(users.id, existingIdentity.userId));
      linkedUser = await getPublicUserByIdTx(db, existingIdentity.userId);
      if (!linkedUser) {
        throw new Error("Linked user not found");
      }
    }
    return linkedUser;
  }

  const [existingEmailUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail));
  if (existingEmailUser) {
    throw new SocialEmailConflictError(existingEmailUser.id, profile.provider);
  }

  assertRegistrationEnabled();
  return null;
}

export async function createSocialUser(
  profile: SocialAuthProfile,
  legalAcceptance: legalAcceptanceService.LegalAcceptanceInput,
  legalMetadata: legalAcceptanceService.LegalAcceptanceMetadata = {},
  legalSource: Extract<legalAcceptanceService.LegalAcceptanceSource, "oauth" | "invite"> = "oauth",
  options: { deferProfileSetup?: boolean } = {},
) {
  const db = getDb();
  assertUsableSocialProfile(profile);
  const normalizedEmail = normalizeEmail(profile.email);
  const accepted = legalAcceptanceService.requireCurrentLegalAcceptance(legalAcceptance);
  assertRegistrationEnabled();
  const [existingEmailUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail));
  if (existingEmailUser) {
    throw new Error(`An account with this email already exists. Sign in with email and password first, then connect ${getProviderLabel(profile.provider)} in Settings.`);
  }
  const materializedAvatarUrl = await materializeSocialAvatar(null, profile);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const user = await db.transaction(async (transaction) => {
        const [conflictingEmailUser] = await transaction.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail));
        if (conflictingEmailUser) {
          throw new Error(`An account with this email already exists. Sign in with email and password first, then connect ${getProviderLabel(profile.provider)} in Settings.`);
        }

        assertRegistrationEnabled();

        const providerDisplayName = profile.displayName?.trim() || null;
        const nameSeed = providerDisplayName || normalizedEmail.split("@")[0] || "user";
        const suggestedHandle = await generateAvailableUserName(nameSeed, transaction);
        const userName = options.deferProfileSetup ? createPendingHandle() : suggestedHandle;
        const passwordHash = await argon2.hash(randomBytes(32).toString("hex"));

        const [newUser] = await transaction.insert(users).values({
          email: normalizedEmail,
          name: userName,
          // A deferred account's `userName` is an internal pending_* reservation,
          // never a person-facing identity default. When a provider such as Apple
          // omits a name, align the editable display name with the already-generated
          // public handle suggestion instead.
          displayName: providerDisplayName ?? suggestedHandle,
          // The provider's photo when it could be stored. Social sign-up joins
          // no server yet, so no built one (newAccountAvatarUrlFor).
          avatarUrl: materializedAvatarUrl,
          passwordHash,
          emailVerified: true,
          profileSetupCompletedAt: options.deferProfileSetup ? null : currentDate(),
          profileSetupSuggestedHandle: options.deferProfileSetup ? suggestedHandle : null,
          // Signed up on a page without the usage-data clause: not told, not on.
          ...(accepted.sawUsageDataNotice ? {} : { shareUsageData: false }),
        }).returning();

        await transaction.insert(userAuthIdentities).values({
          userId: newUser.id,
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          providerEmail: normalizedEmail,
        });

        await legalAcceptanceService.insertUserLegalAcceptance(transaction, newUser.id, legalSource, legalMetadata, accepted);
        return toPublicUser({ ...newUser, profileSetupProvider: profile.provider });
      });

      if (!options.deferProfileSetup) {
        await runCompletedProfileSideEffects(user);
      }
      return user;
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Social sign-in conflicted with another concurrent account change. Please try again.");
}

/**
 * The account a first SSO sign-in creates (rfcs/083-server-sso.md §5.3), in
 * the caller's transaction (services/sso/ssoSignIn.ts links the identity and
 * issues the session in the same one). As for a social sign-up: the IdP
 * proved the email (on a domain the Server verified), there is no password
 * credential, and profile setup is deferred. A unique violation (someone took
 * the email or handle meanwhile) propagates for the caller to retry.
 */
export async function createSsoUserInTransaction(
  tx: DatabaseExecutor,
  input: {
    email: string;
    displayName: string | null;
    legalAcceptance: legalAcceptanceService.LegalAcceptanceInput;
    legalMetadata?: legalAcceptanceService.LegalAcceptanceMetadata;
    /** The SSO connection's server, which the account joins: decides its avatar. */
    joiningServerId: string;
  },
): Promise<{ id: string; email: string }> {
  const normalizedEmail = normalizeEmail(input.email);
  const accepted = legalAcceptanceService.requireCurrentLegalAcceptance(input.legalAcceptance);
  assertRegistrationEnabled();
  const displayName = input.displayName?.trim() || null;
  const suggestedHandle = await generateAvailableUserName(displayName || normalizedEmail.split("@")[0] || "user", tx);
  const [created] = await tx.insert(users).values({
    email: normalizedEmail,
    name: createPendingHandle(),
    displayName: displayName ?? suggestedHandle,
    avatarUrl: await newAccountAvatarUrlFor(input.joiningServerId, tx),
    passwordHash: await argon2.hash(randomBytes(32).toString("hex")),
    emailVerified: true,
    profileSetupCompletedAt: null,
    profileSetupSuggestedHandle: suggestedHandle,
    ...(accepted.sawUsageDataNotice ? {} : { shareUsageData: false }),
  }).returning({ id: users.id, email: users.email });
  await legalAcceptanceService.insertUserLegalAcceptance(tx, created!.id, "oauth", input.legalMetadata ?? {}, accepted);
  return created!;
}

// ── Email Verification ──

/**
 * Verifies the address the token was sent for: the user, and whether this call is what verified it
 * (false when it already was, e.g. by a password reset or a concurrent use of the same link); null for
 * an unknown or expired token.
 */
export async function verifyEmailToken(token: string): Promise<{ userId: string; newlyVerified: boolean } | null> {
  const db = getDb();
  const tokenHash = hashToken(token);

  const [record] = await db.select().from(emailVerifications)
    .where(eq(emailVerifications.tokenHash, tokenHash));

  if (!record) return null;
  // email_verifications.user_id is nullable in the schema (a column kept from the
  // reverted OTP feature). A password-flow verification row always has a user_id;
  // a row without one cannot verify a user, so treat it as invalid.
  if (!record.userId) return null;
  if (new Date(record.expiresAt) < new Date()) {
    await db.delete(emailVerifications).where(eq(emailVerifications.id, record.id));
    return null;
  }

  // Mark user verified + delete token
  const newlyVerified = (await db.update(users).set({ emailVerified: true, updatedAt: new Date() })
    .where(and(eq(users.id, record.userId), eq(users.emailVerified, false)))
    .returning({ id: users.id })).length > 0;
  await db.delete(emailVerifications).where(eq(emailVerifications.userId, record.userId));

  const verifiedUser = await getPublicUserByIdTx(db, record.userId);
  if (verifiedUser?.profileSetupCompletedAt) {
    await enqueueOnboardingEmailJourneyFailOpen(verifiedUser);
  }

  return { userId: record.userId, newlyVerified };
}

/** `returnTo`: where the new link lands after verifying, as at sign-up (sanitized by the email). */
export async function resendVerificationEmail(userId: string, returnTo?: string): Promise<void> {
  const db = getDb();

  const user = await getUser(userId);
  if (!user) throw new Error("User not found");
  if (user.emailVerified) throw new Error("Email is already verified");

  // Rate limit: check tokens created in the last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentTokens = await db.select({ id: emailVerifications.id, createdAt: emailVerifications.createdAt })
    .from(emailVerifications)
    .where(and(
      eq(emailVerifications.userId, userId),
      gt(emailVerifications.createdAt, oneHourAgo),
    ));

  if (recentTokens.length >= 5) {
    throw new Error("Too many verification emails. Please try again later.");
  }

  // 60-second cooldown
  if (recentTokens.length > 0) {
    const latest = recentTokens.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];
    const elapsed = Date.now() - new Date(latest.createdAt).getTime();
    if (elapsed < 60_000) {
      throw new Error("Please wait before requesting another verification email.");
    }
  }

  // Expire the older links instead of deleting their rows: the hourly limit above counts these rows,
  // so deleting them reset the count on every resend and only the 60-second cooldown ever applied.
  await db.update(emailVerifications).set({ expiresAt: new Date(0) })
    .where(eq(emailVerifications.userId, userId));

  const token = randomBytes(32).toString("hex");
  await db.insert(emailVerifications).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
  });

  await sendVerificationEmail(
    user.email,
    user.profileSetupCompletedAt ? user.name : "there",
    token,
    returnTo,
  );
}

export async function completeProfile(
  userId: string,
  input: { name: string; displayName: string },
  /** Called once the setup committed, only by the request that completed it (not a same-payload replay). */
  onCompleted?: () => void,
): Promise<PublicUser> {
  const db = getDb();
  const name = input.name.trim();
  const displayName = input.displayName.trim();
  const nameError = validateName(name, "Name", 5);
  if (
    nameError
    || name.toLowerCase().startsWith(PROFILE_SETUP_PLACEHOLDER_PREFIX)
    || isReservedAgentName(name)
  ) {
    throw new CompleteProfileError(
      "PROFILE_SETUP_NAME_INVALID",
      nameError ?? "This username is reserved. Choose another name.",
    );
  }
  if (!displayName || displayName.length > 80) {
    throw new CompleteProfileError(
      "PROFILE_SETUP_NAME_INVALID",
      "Display name must be between 1 and 80 characters",
    );
  }

  let completed: PublicUser;
  let completedNow = false;
  try {
    completed = await db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(users)
        .set({
          name,
          displayName,
          profileSetupCompletedAt: currentDate(),
          profileSetupSuggestedHandle: null,
          updatedAt: currentDate(),
        })
        .where(and(eq(users.id, userId), isNull(users.profileSetupCompletedAt)))
        .returning();

      if (updated) {
        completedNow = true;
        return toPublicUser({
          ...updated,
          profileSetupProvider: await getProfileSetupProvider(transaction, userId),
        });
      }

      const existing = await getPublicUserByIdTx(transaction, userId);
      if (!existing) {
        throw new CompleteProfileError("PROFILE_SETUP_USER_NOT_FOUND", "User not found");
      }
      if (existing.name !== name || existing.displayName !== displayName) {
        throw new CompleteProfileError(
          "PROFILE_SETUP_ALREADY_COMPLETED",
          "Profile setup is already complete",
        );
      }
      return existing;
    });
  } catch (err) {
    if (isExactUserNameUniqueViolation(err)) {
      throw new CompleteProfileError("PROFILE_SETUP_NAME_TAKEN", "Username is already taken");
    }
    throw err;
  }

  if (completedNow) onCompleted?.();
  // Both the newsletter upsert and onboarding-journey insert are idempotent.
  // Re-run them on same-payload replay so a post-commit transient can recover.
  await runCompletedProfileSideEffects(completed);
  return completed;
}

// ── Password Reset ──

export async function requestPasswordReset(email: string): Promise<void> {
  const db = getDb();
  const normalizedEmail = normalizeEmail(email);

  const [user] = await db.select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.email, normalizedEmail));
  if (!user) return; // Don't reveal whether user exists

  // Rate limit: 5 per hour per user
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentTokens = await db.select({ id: passwordResets.id })
    .from(passwordResets)
    .where(and(
      eq(passwordResets.userId, user.id),
      gt(passwordResets.createdAt, oneHourAgo),
    ));

  if (recentTokens.length >= 5) return; // Silently fail, don't reveal rate limit

  // Expire the older links instead of deleting their rows, so the hourly limit above can count them.
  await db.update(passwordResets).set({ expiresAt: new Date(0) })
    .where(eq(passwordResets.userId, user.id));

  const token = randomBytes(32).toString("hex");
  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h
  });

  await sendPasswordResetEmail(user.email, user.name, token);
}

export async function resetPassword(token: string, newPassword: string): Promise<{ success: boolean; userId?: string }> {
  const db = getDb();
  const tokenHash = hashToken(token);

  const [record] = await db.select().from(passwordResets)
    .where(eq(passwordResets.tokenHash, tokenHash));

  if (!record) return { success: false };
  if (new Date(record.expiresAt) < new Date()) {
    await db.delete(passwordResets).where(eq(passwordResets.id, record.id));
    return { success: false };
  }

  const passwordHash = await argon2.hash(newPassword);
  const result = await db.transaction(async (tx) => {
    const [user] = await tx.select({ retiredAt: users.retiredAt, emailVerified: users.emailVerified }).from(users)
      .where(eq(users.id, record.userId)).for("update");
    if (!user || user.retiredAt) return { success: false };
    const [consumed] = await tx.delete(passwordResets).where(and(
      eq(passwordResets.id, record.id), gt(passwordResets.expiresAt, currentDate()),
    )).returning({ userId: passwordResets.userId });
    if (!consumed) return { success: false };
    // The reset link proves the mailbox. Sign-in providers linked before
    // anyone had proved it may belong to whoever registered the address,
    // so they go, and the email counts as verified from now on.
    if (!user.emailVerified) {
      await tx.delete(userAuthIdentities).where(eq(userAuthIdentities.userId, record.userId));
      // Second factors set up before the mailbox was proved go too, for the
      // same reason: a passkey is a sign-in by itself, and someone else's
      // authenticator app would lock the owner out (#raft-architecture:102593c2).
      await tx.delete(userTotp).where(eq(userTotp.userId, record.userId));
      await tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, record.userId));
      await tx.update(webauthnCredentials).set({ revokedAt: currentDate() })
        .where(and(eq(webauthnCredentials.userId, record.userId), isNull(webauthnCredentials.revokedAt)));
      await tx.update(users).set({ secondFactorRequiredAt: null }).where(eq(users.id, record.userId));
    }
    await tx.update(users).set({
      passwordHash, passwordCredentialEstablishedAt: currentDate(), updatedAt: currentDate(), emailVerified: true,
    }).where(eq(users.id, record.userId));
    await tx.delete(passwordResets).where(eq(passwordResets.userId, record.userId));
    await revokeAllUserSessionsInTransaction(tx, record.userId);
    return { success: true, userId: record.userId };
  });
  // No session asked for a reset (an emailed link): every one is revoked, with what it issued.
  if (result.success) await revokeAccessAfterCredentialChange(record.userId, "password_reset", null);
  return result;
}

/** The reset token is consumed and every family is revoked once the
 * transaction commits, so the caller has nothing idempotent to retry with.
 * New handshakes are rejected by the DB state; a failed fanout only leaves
 * already-open sockets on other replicas until they reconnect. The keys a
 * device login's session handed out go with it (deviceSessionKeys.ts); if
 * that fails here, hourly maintenance revokes them. Also what a finished
 * two-step verification recovery runs after its commit
 * (services/secondFactor/recovery.ts): the same after-commit half of a
 * security revoke of every family. */
export async function revokeAccessAfterCredentialChange(
  userId: string,
  trigger: "password_change" | "password_reset" | "second_factor_recovered",
  /** The family of the session that changed the password: what it issued or approved is kept. */
  exemptFamilyId: string | null,
): Promise<void> {
  try {
    await revokeSocketAccess({ userId });
  } catch (err) {
    console.error("[userService] Socket revocation after credential change failed:", serializeErrorForLog(err));
  }
  await revokeDeviceSessionKeysAfterSignOut(userId);
  await revokeWhatSessionsApprovedAfterSecurityRevoke(userId, trigger, exemptFamilyId);
}

/**
 * After a security revoke of every family of the person (a password change or
 * reset, the account's retirement): what those sessions approved through
 * one-time device-login grants and the keys and Computers they issued
 * themselves, but the session that changed the password (`exemptFamilyId`),
 * then one email (securityRevokeCascade.ts). Logged, not thrown: the revoke
 * has committed, and hourly maintenance repairs it from state.
 */
async function revokeWhatSessionsApprovedAfterSecurityRevoke(userId: string, trigger: ApproverSessionRevokeTrigger, exemptFamilyId: string | null): Promise<void> {
  try {
    await runSecurityRevokeCascade({ userId, exemptFamilyId }, trigger);
  } catch (err) {
    console.error(`[userService] Revoking what the person's sessions approved or issued after ${trigger} failed:`, serializeErrorForLog(err));
  }
}

/** After every family of the person was revoked: what their device logins' sessions handed out. Logged, not thrown: maintenance retries. */
async function revokeDeviceSessionKeysAfterSignOut(userId: string): Promise<void> {
  try {
    await revokeKeysOfRevokedDeviceSessions({ userId });
  } catch (err) {
    console.error("[userService] Device session key revocation after sign-out failed:", serializeErrorForLog(err));
  }
}

// ── Password Change (authenticated) ──

/**
 * `requestingFamilyId`: the web (full) session family that asked, having given
 * the current password. It is signed out like the others, but what it issued
 * or approved keeps working (securityRevokeCascade.ts); null for a legacy
 * token with no family.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string, requestingFamilyId: string | null = null): Promise<void> {
  const db = getDb();

  const [user] = await db.select({ passwordHash: users.passwordHash })
    .from(users).where(eq(users.id, userId));
  if (!user) throw new Error("User not found");

  const valid = await argon2.verify(user.passwordHash, currentPassword);
  if (!valid) throw new Error("Current password is incorrect");

  const passwordHash = await argon2.hash(newPassword);
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!current || current.retiredAt || current.passwordHash !== user.passwordHash) {
      throw new Error("Current password is incorrect");
    }
    await tx.update(users).set({
      passwordHash, passwordCredentialEstablishedAt: currentDate(), updatedAt: currentDate(),
    }).where(eq(users.id, userId));
    await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
    await revokeAllUserSessionsInTransaction(tx, userId, { passwordChangedBy: requestingFamilyId });
  });
  await revokeAccessAfterCredentialChange(userId, "password_change", requestingFamilyId);
}

/** users.trace_user_id, the only user identifier written to traces. */
export async function getTraceUserId(userId: string): Promise<string | null> {
  const [user] = await getDb().select({ traceUserId: users.traceUserId })
    .from(users).where(eq(users.id, userId)).limit(1);
  return user?.traceUserId ?? null;
}
