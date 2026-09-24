import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  computers,
  newsletterAudienceContacts,
  onboardingEmailJourneys,
  users,
} from "../db/schema.js";
import { normalizeEmail } from "./emailNormalization.js";
import { cancelScheduledEmail, sendMobileAppDownloadEmail } from "./emailService.js";

type JourneyReleaseMode = "disabled" | "dry_run" | "allowlist" | "all";
type SuppressionStatus = "unsubscribed" | "bounced" | "complained";

const JOURNEY_KEY = "first_computer_mobile_app_48h";
const DEFAULT_DELAY_HOURS = 48;
const SUPPRESSION_STATUSES: SuppressionStatus[] = ["unsubscribed", "bounced", "complained"];

type TestConfig = {
  mode?: JourneyReleaseMode;
  allowlist?: string[];
  delayHours?: number;
  sendEmail?: typeof sendMobileAppDownloadEmail;
  cancelEmail?: typeof cancelScheduledEmail;
  persistAcceptedEmail?: (journeyId: string, emailId: string | null) => Promise<void>;
  beforeEnqueue?: () => void;
};

let testConfig: TestConfig | null = null;

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

function parseDelayHours(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_DELAY_HOURS;
  return Math.max(1, value);
}

function getConfig() {
  return {
    mode:
      testConfig?.mode
      ?? parseReleaseMode(process.env.MOBILE_APP_EMAIL_JOURNEY_MODE)
      ?? "all",
    allowlist: parseAllowlist(testConfig?.allowlist ?? process.env.MOBILE_APP_EMAIL_ALLOWLIST),
    // Product contract: first successful Computer connection + exactly 48h.
    // Test-only override keeps boundary tests deterministic without creating a
    // production knob that can silently drift the lifecycle timing.
    delayHours: parseDelayHours(testConfig?.delayHours ?? DEFAULT_DELAY_HOURS),
  };
}

function scheduledAt(connectedAt: Date, delayHours: number): Date {
  return new Date(connectedAt.getTime() + delayHours * 60 * 60 * 1000);
}

function idempotencyKey(userId: string): string {
  return `lifecycle:${JOURNEY_KEY}:${userId}`;
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

export function setComputerMobileAppEmailJourneyConfigForTest(config: TestConfig): void {
  testConfig = config;
}

export function resetComputerMobileAppEmailJourneyTestOverrides(): void {
  testConfig = null;
}

async function findSuppressionReason(userId: string, email: string): Promise<SuppressionStatus | null> {
  const [row] = await getDb().select({ status: newsletterAudienceContacts.status })
    .from(newsletterAudienceContacts)
    .where(and(
      or(
        eq(newsletterAudienceContacts.userId, userId),
        eq(newsletterAudienceContacts.email, normalizeEmail(email)),
      ),
      inArray(newsletterAudienceContacts.status, SUPPRESSION_STATUSES),
    ))
    .limit(1);

  return (row?.status as SuppressionStatus | undefined) ?? null;
}

async function insertJourney(values: typeof onboardingEmailJourneys.$inferInsert) {
  const [journey] = await getDb().insert(onboardingEmailJourneys)
    .values(values)
    .onConflictDoNothing()
    .returning();
  return journey ?? null;
}

async function persistAcceptedEmail(journeyId: string, emailId: string | null): Promise<void> {
  await getDb().update(onboardingEmailJourneys).set({
    day1Status: "scheduled",
    day1EmailId: emailId,
    updatedAt: currentDate(),
  }).where(eq(onboardingEmailJourneys.id, journeyId));
}

export async function enqueueComputerMobileAppEmailJourney(input: {
  userId: string;
  computerId: string;
}): Promise<
  | { status: "scheduled" | "dry_run" | "already_started" }
  | {
    status: "skipped";
    reason:
      | "disabled"
      | "not_first_computer"
      | "unverified"
      | "missing_email"
      | "not_allowlisted"
      | SuppressionStatus;
  }
  | { status: "failed" }
> {
  testConfig?.beforeEnqueue?.();
  const config = getConfig();
  if (config.mode === "disabled") return { status: "skipped", reason: "disabled" };

  const [computer] = await getDb().select({
    id: computers.id,
    createdAt: computers.createdAt,
  }).from(computers).where(and(
    eq(computers.id, input.computerId),
    eq(computers.attachedByUserId, input.userId),
    isNotNull(computers.machineId),
  )).limit(1);
  if (!computer) return { status: "skipped", reason: "not_first_computer" };

  const [firstComputer] = await getDb().select({ id: computers.id })
    .from(computers)
    .where(and(
      eq(computers.attachedByUserId, input.userId),
      isNotNull(computers.machineId),
    ))
    .orderBy(asc(computers.createdAt), asc(computers.id))
    .limit(1);
  if (firstComputer?.id !== computer.id) {
    // This journey starts from a newly completed first attach. A later attach
    // never acts as a silent backfill for pre-rollout Computer users.
    return { status: "skipped", reason: "not_first_computer" };
  }

  const [user] = await getDb().select({
    email: users.email,
    emailVerified: users.emailVerified,
    displayLanguage: users.displayLanguage,
  }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user?.emailVerified) return { status: "skipped", reason: "unverified" };
  if (!user.email?.trim()) return { status: "skipped", reason: "missing_email" };

  const email = normalizeEmail(user.email);
  if (config.mode === "allowlist" && !config.allowlist.includes(email)) {
    return { status: "skipped", reason: "not_allowlisted" };
  }

  const deliverAt = scheduledAt(computer.createdAt, config.delayHours);
  const suppressionReason = await findSuppressionReason(input.userId, email);
  if (suppressionReason) {
    await insertJourney({
      userId: input.userId,
      email,
      journeyKey: JOURNEY_KEY,
      releaseMode: config.mode,
      qualifiedAt: computer.createdAt,
      day0Status: "skipped",
      day1Status: "skipped",
      day1ScheduledAt: deliverAt,
      suppressedReason: suppressionReason,
      cancelReason: suppressionReason,
      canceledAt: computer.createdAt,
      updatedAt: computer.createdAt,
    });
    return { status: "skipped", reason: suppressionReason };
  }

  const inserted = await insertJourney({
    userId: input.userId,
    email,
    journeyKey: JOURNEY_KEY,
    releaseMode: config.mode === "dry_run" ? "dry_run" : config.mode,
    qualifiedAt: computer.createdAt,
    day0Status: config.mode === "dry_run" ? "dry_run" : "skipped",
    day1Status: config.mode === "dry_run" ? "dry_run" : "pending",
    day1ScheduledAt: deliverAt,
    updatedAt: computer.createdAt,
  });
  if (!inserted) return { status: "already_started" };
  if (config.mode === "dry_run") return { status: "dry_run" };

  let emailId: string | null = null;
  try {
    const sendEmail = testConfig?.sendEmail ?? sendMobileAppDownloadEmail;
    emailId = await sendEmail(email, {
      idempotencyKey: idempotencyKey(input.userId),
      scheduledAt: deliverAt,
      locale: user.displayLanguage,
    });
    const persistEmail = testConfig?.persistAcceptedEmail ?? persistAcceptedEmail;
    await persistEmail(inserted.id, emailId);
  } catch (error) {
    if (emailId) {
      const cancelEmail = testConfig?.cancelEmail ?? cancelScheduledEmail;
      try {
        // Resend already accepted the +48h schedule. If its ID cannot be made
        // durable, compensate immediately so no undiscoverable mail remains.
        await cancelEmail(emailId);
        await getDb().update(onboardingEmailJourneys).set({
          day1Status: "failed",
          day1EmailId: emailId,
          canceledAt: currentDate(),
          cancelReason: "schedule_persist_failed",
          lastError: summarizeError(error),
          updatedAt: currentDate(),
        }).where(eq(onboardingEmailJourneys.id, inserted.id)).catch(() => {});
      } catch (cancelError) {
        // If compensation is temporarily unavailable, make the provider ID
        // discoverable as scheduled so a suppression webhook can retry cancel.
        await getDb().update(onboardingEmailJourneys).set({
          day1Status: "scheduled",
          day1EmailId: emailId,
          lastError: summarizeError(cancelError),
          updatedAt: currentDate(),
        }).where(eq(onboardingEmailJourneys.id, inserted.id));

        // A suppression webhook may have raced while this row was still
        // pending and deliberately failed closed. Re-read its durable contact
        // state after exposing the provider ID, then cancel immediately rather
        // than depending on a future duplicate delivery.
        const recoverySuppression = await findSuppressionReason(input.userId, email);
        if (recoverySuppression) {
          try {
            await suppressScheduledComputerMobileAppEmailJourneys({
              userId: input.userId,
              email,
              status: recoverySuppression,
            });
            return { status: "skipped", reason: recoverySuppression };
          } catch {
            // Keep scheduled+ID durable. The webhook attempt was not committed,
            // so its normal retry can still find and cancel this schedule.
          }
        }
      }
      return { status: "failed" };
    }
    await getDb().update(onboardingEmailJourneys).set({
      day1Status: "failed",
      lastError: summarizeError(error),
      updatedAt: currentDate(),
    }).where(eq(onboardingEmailJourneys.id, inserted.id));
    return { status: "failed" };
  }

  // Resend accepts the schedule before the journey row records its email ID.
  // Recheck after that durable write so an opt-out webhook racing any part of
  // the scheduling window is observed and the accepted email is canceled.
  const postScheduleSuppression = await findSuppressionReason(input.userId, email);
  if (!postScheduleSuppression) return { status: "scheduled" };

  try {
    await suppressScheduledComputerMobileAppEmailJourneys({
      userId: input.userId,
      email,
      status: postScheduleSuppression,
    });
    return { status: "skipped", reason: postScheduleSuppression };
  } catch (error) {
    // Keep `scheduled` authoritative so a retried webhook can still find and
    // cancel the provider schedule; changing it to `failed` would orphan mail.
    await getDb().update(onboardingEmailJourneys).set({
      lastError: summarizeError(error),
      updatedAt: currentDate(),
    }).where(eq(onboardingEmailJourneys.id, inserted.id));
    return { status: "failed" };
  }
}

export async function suppressScheduledComputerMobileAppEmailJourneys(input: {
  userId?: string | null;
  email: string;
  status: SuppressionStatus;
}): Promise<{ canceled: number }> {
  if (!SUPPRESSION_STATUSES.includes(input.status)) {
    throw new Error("Unsupported mobile lifecycle suppression status");
  }

  const email = normalizeEmail(input.email);
  const identity = input.userId
    ? or(
      eq(onboardingEmailJourneys.userId, input.userId),
      eq(onboardingEmailJourneys.email, email),
    )
    : eq(onboardingEmailJourneys.email, email);
  const rows = await getDb().select({
    id: onboardingEmailJourneys.id,
    status: onboardingEmailJourneys.day1Status,
    emailId: onboardingEmailJourneys.day1EmailId,
  }).from(onboardingEmailJourneys).where(and(
    eq(onboardingEmailJourneys.journeyKey, JOURNEY_KEY),
    inArray(onboardingEmailJourneys.day1Status, ["pending", "scheduled"]),
    identity,
  ));

  if (rows.some((row) => row.status === "pending" || !row.emailId)) {
    throw new Error("Mobile lifecycle schedule is not yet cancelable");
  }

  let canceled = 0;
  const cancelEmail = testConfig?.cancelEmail ?? cancelScheduledEmail;
  for (const row of rows) {
    if (!row.emailId) continue;
    await cancelEmail(row.emailId);
    const updated = await getDb().update(onboardingEmailJourneys).set({
      day1Status: "skipped",
      suppressedReason: input.status,
      cancelReason: input.status,
      canceledAt: currentDate(),
      updatedAt: currentDate(),
    }).where(and(
      eq(onboardingEmailJourneys.id, row.id),
      eq(onboardingEmailJourneys.day1Status, "scheduled"),
      eq(onboardingEmailJourneys.day1EmailId, row.emailId),
    )).returning({ id: onboardingEmailJourneys.id });
    canceled += updated.length;
  }

  return { canceled };
}
