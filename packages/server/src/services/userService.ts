import { revokeSocketAccess } from "../socket/accessRevocation.js";
import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
import { eq, and, asc, gt, isNull, sql } from "drizzle-orm";
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";
import type { DatabaseExecutor } from "../db/index.js";
import { users, emailVerifications, passwordResets, userAuthIdentities, sessionFamilies, sessions, userRetirementReceipts } from "../db/schema.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "./emailService.js";
import { normalizeEmail } from "./emailNormalization.js";
import { syncNewsletterSignup } from "./newsletterService.js";
import { enqueueOnboardingEmailJourneyForUser } from "./onboardingEmailJourneyService.js";
import { assertRegistrationEnabled } from "./registrationPolicy.js";
import type { SocialAuthProfile, SocialAuthProvider } from "./socialAuthService.js";
import * as legalAcceptanceService from "./legalAcceptanceService.js";
import { currentDate, isReservedAgentName, validateName } from "@botiverse/raft-shared";
import { requestExternalAuthorAvatarSync } from "./externalAuthorAvatarSyncRuntime.js";
import { createSession, revokeAllUserSessionsInTransaction } from "./sessionService.js";
import { isStoredUserAvatarUrl, materializeUserProviderAvatar } from "./avatarService.js";

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
    gravatarHash: createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex"),
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

function shouldReplaceSocialAvatar(existingAvatarUrl: string | null): boolean {
  return !existingAvatarUrl || isProviderHotlinkedAvatarUrl(existingAvatarUrl);
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

// ── User CRUD ──

export async function createUser(
  email: string,
  password: string,
  name: string | null,
  legalAcceptance: legalAcceptanceService.LegalAcceptanceInput,
  legalMetadata: legalAcceptanceService.LegalAcceptanceMetadata = {},
  legalSource: Extract<legalAcceptanceService.LegalAcceptanceSource, "signup" | "invite"> = "signup",
  options: { deferProfileSetup?: boolean; stagingSelfAccountCapability?: string } = {},
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
      legalAcceptanceService.requireCurrentLegalAcceptance(legalAcceptance);

      const pendingHandle = options.deferProfileSetup ? createPendingHandle() : null;
      const suggestedHandle = options.deferProfileSetup
        ? await generateAvailableUserName(name ?? normalizedEmail.split("@")[0] ?? "user", transaction)
        : null;
      const [user] = await transaction.insert(users).values({
        email: normalizedEmail,
        name: pendingHandle ?? name!,
        displayName: options.deferProfileSetup ? null : name,
        passwordHash,
        passwordCredentialEstablishedAt: currentDate(),
        profileSetupCompletedAt: options.deferProfileSetup ? null : currentDate(),
        profileSetupSuggestedHandle: suggestedHandle,
        stagingSelfAccountCapabilityHash: options.stagingSelfAccountCapability
          ? hashToken(options.stagingSelfAccountCapability)
          : null,
      }).returning();

      await legalAcceptanceService.insertUserLegalAcceptance(transaction, user.id, legalSource, legalMetadata);
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

  await sendVerificationEmail(normalizedEmail, options.deferProfileSetup ? "there" : name!, token);

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

export async function authenticateUser(email: string, password: string) {
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  if (!user) {
    throw new EmailLoginRejectedError("user_missing");
  }
  if (user.retiredAt) {
    throw new EmailLoginRejectedError("user_retired");
  }

  // Social-only users also have a non-null hash for rolling-schema
  // compatibility, but it is an unknowable random placeholder. Verifying the
  // supplied password is therefore the safe provenance test: a real legacy
  // password succeeds even if the human later linked a social identity, while
  // a placeholder remains unusable. Only a successful verification may heal
  // the durable marker.
  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    throw new EmailLoginRejectedError("password_mismatch");
  }

  // Argon2 is deliberately outside the lock. Revalidate its exact hash under
  // the same user lock held by password changes and session issuance.
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
    if (!current || current.retiredAt) throw new EmailLoginRejectedError("user_retired");
    if (current.passwordHash !== user.passwordHash) throw new EmailLoginRejectedError("password_mismatch");
    if (!current.passwordCredentialEstablishedAt) {
      await tx.update(users).set({
        passwordCredentialEstablishedAt: currentDate(),
      }).where(and(
        eq(users.id, user.id),
        isNull(users.passwordCredentialEstablishedAt),
      ));
    }
    const session = await createSession(user.id, tx);
    return {
      user: toPublicUser({
        ...current,
        profileSetupProvider: await getProfileSetupProvider(tx, user.id),
      }),
      session,
    };
  });
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
    const [updated] = await tx.update(users).set({ retiredAt: now, retiredReason: "staging_self_account" })
      .where(and(eq(users.id, userId), isNull(users.retiredAt))).returning({ id: users.id });
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
    const [receipt] = await tx.insert(userRetirementReceipts).values({
      userId, actorUserId, environment: "staging", terminalState: "retired",
      sessionsRevoked: activeSessions.length,
    }).onConflictDoNothing().returning();
    return receipt ?? null;
  });
  await revokeSocketAccess({ userId });
  return result;
}

export async function getUser(userId: string) {
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
    preferredTranslationMode: users.preferredTranslationMode,
    preferredTranslationDisplay: users.preferredTranslationDisplay,
    preferredTimeFormat: users.preferredTimeFormat,
    preferredMessageBodyFontSize: users.preferredMessageBodyFontSize,
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
    profileSetupProvider: await getProfileSetupProvider(db, user.id),
  });
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
    preferredTranslationMode: users.preferredTranslationMode,
    preferredTranslationDisplay: users.preferredTranslationDisplay,
    preferredTimeFormat: users.preferredTimeFormat,
    preferredMessageBodyFontSize: users.preferredMessageBodyFontSize,
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

export async function updateUser(userId: string, fields: {
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
  referralSource?: string | null;
  referralSourceOther?: string | null;
  referralSourceSkippedAt?: Date | null;
  signupRole?: string | null;
  signupSurveyCompletedAt?: Date | null;
}) {
  const db = getDb();
  await db.update(users).set({
    ...fields,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));
  const user = await getUser(userId);
  if (fields.avatarUrl !== undefined && user) {
    await requestExternalAuthorAvatarSync({ authorType: "user", authorId: userId });
  }
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
    preferredTranslationMode: users.preferredTranslationMode,
    preferredTranslationDisplay: users.preferredTranslationDisplay,
    preferredTimeFormat: users.preferredTimeFormat,
    preferredMessageBodyFontSize: users.preferredMessageBodyFontSize,
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

export async function linkSocialIdentity(userId: string, profile: SocialAuthProfile) {
  const db = getDb();
  assertUsableSocialProfile(profile);
  let shouldStartOnboardingJourney = false;
  const [currentUser] = await db.select({
    avatarUrl: users.avatarUrl,
  }).from(users).where(eq(users.id, userId));
  if (!currentUser) {
    throw new Error("User not found");
  }
  const normalizedEmail = normalizeEmail(profile.email);
  const [existingEmailUser] = await db.select({
    id: users.id,
  }).from(users).where(eq(users.email, normalizedEmail));
  if (existingEmailUser && existingEmailUser.id !== userId) {
    throw new Error(`This ${getProviderLabel(profile.provider)} account email belongs to another Raft account`);
  }
  const materializedAvatarUrl = await materializeSocialAvatar(currentUser.avatarUrl, profile);

  try {
    const linkedUser = await db.transaction(async (transaction) => {
      const [user] = await transaction.select({
        id: users.id,
        email: users.email,
        avatarUrl: users.avatarUrl,
        emailVerified: users.emailVerified,
      }).from(users).where(eq(users.id, userId)).for("update");

      if (!user) {
        throw new Error("User not found");
      }

      const [conflictingEmailUser] = await transaction.select({
        id: users.id,
      }).from(users).where(eq(users.email, normalizedEmail));

      if (conflictingEmailUser && conflictingEmailUser.id !== userId) {
        throw new Error(`This ${getProviderLabel(profile.provider)} account email belongs to another Raft account`);
      }

      await upsertSocialIdentityTx(transaction, userId, profile);

      const shouldVerifyEmail = normalizeEmail(user.email) === normalizedEmail;
      shouldStartOnboardingJourney = shouldVerifyEmail && !user.emailVerified;
      await transaction.update(users).set({
        avatarUrl: chooseSocialAvatarUrl(user.avatarUrl, materializedAvatarUrl),
        emailVerified: shouldVerifyEmail ? true : user.emailVerified,
        updatedAt: new Date(),
      }).where(eq(users.id, userId));

      return getPublicUserByIdTx(transaction, userId);
    });

    if (!linkedUser) {
      throw new Error("Failed to link social account");
    }

    if (shouldStartOnboardingJourney) {
      await enqueueOnboardingEmailJourneyFailOpen(linkedUser);
    }

    return linkedUser;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error(`This ${getProviderLabel(profile.provider)} account was linked concurrently. Please try again.`);
    }
    throw err;
  }
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
      await requestExternalAuthorAvatarSync({ authorType: "user", authorId: existingIdentity.userId });
      linkedUser = await getPublicUserByIdTx(db, existingIdentity.userId);
      if (!linkedUser) {
        throw new Error("Linked user not found");
      }
    }
    return linkedUser;
  }

  const [existingEmailUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail));
  if (existingEmailUser) {
    throw new Error(`An account with this email already exists. Sign in with email and password first, then connect ${getProviderLabel(profile.provider)} in Settings.`);
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
  legalAcceptanceService.requireCurrentLegalAcceptance(legalAcceptance);
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
          avatarUrl: materializedAvatarUrl,
          passwordHash,
          emailVerified: true,
          profileSetupCompletedAt: options.deferProfileSetup ? null : currentDate(),
          profileSetupSuggestedHandle: options.deferProfileSetup ? suggestedHandle : null,
        }).returning();

        await transaction.insert(userAuthIdentities).values({
          userId: newUser.id,
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          providerEmail: normalizedEmail,
        });

        await legalAcceptanceService.insertUserLegalAcceptance(transaction, newUser.id, legalSource, legalMetadata);
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

// ── Email Verification ──

export async function verifyEmail(token: string): Promise<boolean> {
  const db = getDb();
  const tokenHash = hashToken(token);

  const [record] = await db.select().from(emailVerifications)
    .where(eq(emailVerifications.tokenHash, tokenHash));

  if (!record) return false;
  // email_verifications.user_id is nullable in the schema (a column kept from the
  // reverted OTP feature). A password-flow verification row always has a user_id;
  // a row without one cannot verify a user, so treat it as invalid.
  if (!record.userId) return false;
  if (new Date(record.expiresAt) < new Date()) {
    await db.delete(emailVerifications).where(eq(emailVerifications.id, record.id));
    return false;
  }

  // Mark user verified + delete token
  await db.update(users).set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.id, record.userId));
  await db.delete(emailVerifications).where(eq(emailVerifications.userId, record.userId));

  const verifiedUser = await getPublicUserByIdTx(db, record.userId);
  if (verifiedUser?.profileSetupCompletedAt) {
    await enqueueOnboardingEmailJourneyFailOpen(verifiedUser);
  }

  return true;
}

export async function resendVerificationEmail(userId: string): Promise<void> {
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

  // Delete old tokens and create new one
  await db.delete(emailVerifications).where(eq(emailVerifications.userId, userId));

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
  );
}

export async function completeProfile(
  userId: string,
  input: { name: string; displayName: string },
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

  // Delete old tokens and create new one
  await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));

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
    const [user] = await tx.select({ retiredAt: users.retiredAt }).from(users)
      .where(eq(users.id, record.userId)).for("update");
    if (!user || user.retiredAt) return { success: false };
    const [consumed] = await tx.delete(passwordResets).where(and(
      eq(passwordResets.id, record.id), gt(passwordResets.expiresAt, currentDate()),
    )).returning({ userId: passwordResets.userId });
    if (!consumed) return { success: false };
    await tx.update(users).set({
      passwordHash, passwordCredentialEstablishedAt: currentDate(), updatedAt: currentDate(),
    }).where(eq(users.id, record.userId));
    await tx.delete(passwordResets).where(eq(passwordResets.userId, record.userId));
    await revokeAllUserSessionsInTransaction(tx, record.userId);
    return { success: true, userId: record.userId };
  });
  if (result.success) await revokeSocketAccessAfterCredentialChange(record.userId);
  return result;
}

/** The reset token is consumed and every family is revoked once the
 * transaction commits, so the caller has nothing idempotent to retry with.
 * New handshakes are rejected by the DB state; a failed fanout only leaves
 * already-open sockets on other replicas until they reconnect. */
async function revokeSocketAccessAfterCredentialChange(userId: string): Promise<void> {
  try {
    await revokeSocketAccess({ userId });
  } catch (err) {
    console.error("[userService] Socket revocation after credential change failed:", serializeErrorForLog(err));
  }
}

// ── Password Change (authenticated) ──

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
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
    await revokeAllUserSessionsInTransaction(tx, userId);
  });
  await revokeSocketAccessAfterCredentialChange(userId);
}
