import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { newsletterAudienceContacts, onboardingEmailJourneys } from "../db/schema.js";
import { normalizeEmail } from "./emailNormalization.js";
import {
  sendOnboardingDayOneCheckInEmail,
  sendOnboardingWelcomeEmail,
} from "./emailService.js";

type JourneyReleaseMode = "disabled" | "dry_run" | "allowlist" | "all";
type SuppressionStatus = "unsubscribed" | "bounced" | "complained";

const JOURNEY_KEY = "new_user_day0_day1";
const SUPPRESSION_STATUSES: SuppressionStatus[] = ["unsubscribed", "bounced", "complained"];
const DEFAULT_DAY_1_DELAY_HOURS = 24;

type OnboardingUser = {
  id: string;
  email: string;
  name: string;
  displayName?: string | null;
  emailVerified: boolean;
};

type TestConfig = {
  enabled?: boolean;
  mode?: JourneyReleaseMode;
  allowlist?: string[];
  day1DelayHours?: number;
  now?: Date;
};

let testConfig: TestConfig | null = null;

function parseNumber(raw: unknown, fallback: number, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function parseReleaseMode(raw: unknown): JourneyReleaseMode | null {
  switch (raw) {
    case "disabled":
    case "dry_run":
    case "allowlist":
    case "all":
      return raw;
    default:
      return null;
  }
}

function parseAllowlist(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => normalizeEmail(String(item))).filter(Boolean);
  if (typeof raw !== "string") return [];
  return raw.split(",").map((item) => normalizeEmail(item)).filter(Boolean);
}

function getReleaseMode(): JourneyReleaseMode {
  if (testConfig?.mode) return testConfig.mode;
  const envMode = parseReleaseMode(process.env.ONBOARDING_EMAIL_JOURNEY_MODE);
  if (envMode) return envMode;
  if (testConfig?.enabled === true) return "all";
  if (testConfig?.enabled === false) return "disabled";
  if (process.env.ONBOARDING_EMAIL_JOURNEY_ENABLED === "true") return "all";
  return "all";
}

function getConfig() {
  return {
    mode: getReleaseMode(),
    allowlist: parseAllowlist(testConfig?.allowlist ?? process.env.ONBOARDING_EMAIL_ALLOWLIST),
    day1DelayHours: parseNumber(
      testConfig?.day1DelayHours ?? process.env.ONBOARDING_EMAIL_DAY_1_DELAY_HOURS,
      DEFAULT_DAY_1_DELAY_HOURS,
      1,
    ),
    now: testConfig?.now ?? new Date(),
  };
}

function summarizeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

function displayNameForUser(user: Pick<OnboardingUser, "name" | "displayName">) {
  return user.displayName?.trim() || user.name;
}

function isAllowlisted(email: string, allowlist: string[]): boolean {
  return allowlist.includes(normalizeEmail(email));
}

function day1ScheduledAt(qualifiedAt: Date, delayHours: number): Date {
  return new Date(qualifiedAt.getTime() + delayHours * 60 * 60 * 1000);
}

function idempotencyKey(userId: string, step: "day0" | "day1"): string {
  return `onboarding:${JOURNEY_KEY}:${userId}:${step}`;
}

export function isOnboardingEmailJourneyEnabled(): boolean {
  return getReleaseMode() !== "disabled";
}

export function setOnboardingEmailJourneyConfigForTest(config: TestConfig): void {
  testConfig = config;
}

export function resetOnboardingEmailJourneyTestOverrides(): void {
  testConfig = null;
}

async function findSuppressionReason(userId: string, email: string): Promise<SuppressionStatus | null> {
  const [row] = await getDb().select({
    status: newsletterAudienceContacts.status,
  }).from(newsletterAudienceContacts).where(and(
    or(
      eq(newsletterAudienceContacts.userId, userId),
      eq(newsletterAudienceContacts.email, normalizeEmail(email)),
    ),
    inArray(newsletterAudienceContacts.status, SUPPRESSION_STATUSES),
  )).limit(1);

  return (row?.status as SuppressionStatus | undefined) ?? null;
}

async function getExistingJourney(userId: string) {
  const [journey] = await getDb().select()
    .from(onboardingEmailJourneys)
    .where(and(
      eq(onboardingEmailJourneys.userId, userId),
      eq(onboardingEmailJourneys.journeyKey, JOURNEY_KEY),
    ))
    .limit(1);
  return journey ?? null;
}

async function insertJourney(values: typeof onboardingEmailJourneys.$inferInsert) {
  const [journey] = await getDb().insert(onboardingEmailJourneys)
    .values(values)
    .onConflictDoNothing()
    .returning();
  return journey ?? null;
}

export async function enqueueOnboardingEmailJourneyForUser(user: OnboardingUser): Promise<
  | { status: "skipped"; reason: "disabled" | "unverified" | "missing_email" | "not_allowlisted" | SuppressionStatus }
  | { status: "dry_run" | "started" | "already_started" }
> {
  const config = getConfig();
  if (config.mode === "disabled") return { status: "skipped", reason: "disabled" };
  if (!user.emailVerified) return { status: "skipped", reason: "unverified" };
  if (!user.email?.trim()) return { status: "skipped", reason: "missing_email" };

  const email = normalizeEmail(user.email);
  if (config.mode === "allowlist" && !isAllowlisted(email, config.allowlist)) {
    return { status: "skipped", reason: "not_allowlisted" };
  }

  const existing = await getExistingJourney(user.id);
  if (existing) return { status: "already_started" };

  const qualifiedAt = config.now;
  const scheduledAt = day1ScheduledAt(qualifiedAt, config.day1DelayHours);
  const releaseMode = config.mode;
  const suppressionReason = await findSuppressionReason(user.id, email);

  if (suppressionReason) {
    await insertJourney({
      userId: user.id,
      email,
      journeyKey: JOURNEY_KEY,
      releaseMode,
      qualifiedAt,
      day0Status: "skipped",
      day1Status: "skipped",
      day1ScheduledAt: scheduledAt,
      suppressedReason: suppressionReason,
      cancelReason: suppressionReason,
      canceledAt: qualifiedAt,
      updatedAt: qualifiedAt,
    });
    return { status: "skipped", reason: suppressionReason };
  }

  if (config.mode === "dry_run") {
    await insertJourney({
      userId: user.id,
      email,
      journeyKey: JOURNEY_KEY,
      releaseMode: "dry_run",
      qualifiedAt,
      day0Status: "dry_run",
      day1Status: "dry_run",
      day1ScheduledAt: scheduledAt,
      updatedAt: qualifiedAt,
    });
    return { status: "dry_run" };
  }

  const inserted = await insertJourney({
    userId: user.id,
    email,
    journeyKey: JOURNEY_KEY,
    releaseMode,
    qualifiedAt,
    day0Status: "pending",
    day1Status: "pending",
    day1ScheduledAt: scheduledAt,
    updatedAt: qualifiedAt,
  });
  if (!inserted) return { status: "already_started" };

  const recipientName = displayNameForUser(user);
  let day0Status: "sent" | "failed" = "sent";
  let day0EmailId: string | null = null;
  let day0SentAt: Date | null = qualifiedAt;
  let day1Status: "scheduled" | "failed" = "scheduled";
  let day1EmailId: string | null = null;
  const errors: string[] = [];

  try {
    day0EmailId = await sendOnboardingWelcomeEmail(email, { recipientName }, {
      idempotencyKey: idempotencyKey(user.id, "day0"),
    });
  } catch (err) {
    day0Status = "failed";
    day0SentAt = null;
    errors.push(`day0: ${summarizeError(err)}`);
  }

  try {
    day1EmailId = await sendOnboardingDayOneCheckInEmail(email, { recipientName }, {
      idempotencyKey: idempotencyKey(user.id, "day1"),
      scheduledAt,
    });
  } catch (err) {
    day1Status = "failed";
    errors.push(`day1: ${summarizeError(err)}`);
  }

  await getDb().update(onboardingEmailJourneys)
    .set({
      day0Status,
      day0EmailId,
      day0SentAt,
      day1Status,
      day1EmailId,
      day1ScheduledAt: scheduledAt,
      lastError: errors.length > 0 ? errors.join("; ") : null,
      updatedAt: new Date(),
    })
    .where(eq(onboardingEmailJourneys.id, inserted.id));

  if (errors.length > 0) {
    console.warn(`[OnboardingEmailJourney] Failed to start journey for user ${user.id}: ${errors.join("; ")}`);
  }

  return { status: "started" };
}
