import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../src/db/index.js";
import { serverMembers, users } from "../src/db/schema.js";

type UserOnboardingValues = Pick<
  typeof users.$inferInsert,
  "profileSetupCompletedAt" | "signupSurveyCompletedAt"
>;

type MembershipOnboardingValues = Pick<
  typeof serverMembers.$inferInsert,
  | "setupModalReminderOptOut"
  | "onboardingWizardCurrentStep"
  | "setupStatus"
  | "setupDeferredAt"
  | "setupCompletionReason"
  | "setupContractVersion"
> & Partial<Pick<
  typeof serverMembers.$inferInsert,
  "setupHandoffAcknowledgedAt"
>>;

export type DevSeedOnboardingValues = {
  user: UserOnboardingValues;
  membership: MembershipOnboardingValues;
};

/**
 * Canonical durable onboarding state for the built-in raftdev fixture.
 *
 * Routine product work needs a seeded workspace that opens directly on the
 * surface under test. `--with-onboarding` deliberately restores production's
 * fresh-account defaults so onboarding itself remains testable. Keeping this
 * as persisted server truth avoids browser-local query/localStorage bypasses.
 */
export function devSeedOnboardingValues(
  withOnboarding: boolean,
  now: Date,
  existingUser: Partial<UserOnboardingValues> = {},
): DevSeedOnboardingValues {
  if (withOnboarding) {
    return {
      user: {
        profileSetupCompletedAt: null,
        signupSurveyCompletedAt: null,
      },
      membership: {
        setupModalReminderOptOut: false,
        onboardingWizardCurrentStep: null,
        setupStatus: "not_started",
        setupDeferredAt: null,
        setupCompletionReason: null,
        setupContractVersion: "onboarding-setup-v2",
        setupHandoffAcknowledgedAt: null,
      },
    };
  }

  return {
    user: {
      profileSetupCompletedAt: existingUser.profileSetupCompletedAt ?? now,
      signupSurveyCompletedAt: existingUser.signupSurveyCompletedAt ?? now,
    },
    membership: {
      setupModalReminderOptOut: true,
      onboardingWizardCurrentStep: "complete",
      setupStatus: "complete",
      setupDeferredAt: null,
      // This is fixture/backfill truth, not a claim that the developer walked
      // through the live owner flow. It also suppresses the post-setup survey
      // and handoff, which are intentionally ineligible for grandfathered rows.
      setupCompletionReason: "grandfathered",
      setupContractVersion: "onboarding-setup-v2",
    },
  };
}

/**
 * Persist one exact raftdev fixture mode for the selected user + membership.
 *
 * The account completion timestamps are user-scoped, while setup and handoff
 * state belong to one `(serverId, userId)` membership. Keeping the exact
 * membership predicate here gives the reseed contract a directly testable
 * isolation boundary instead of relying on the large seed script's shape.
 */
export async function applyDevSeedOnboardingFixture(
  db: DatabaseExecutor,
  input: {
    userId: string;
    serverId: string;
    withOnboarding: boolean;
    now: Date;
  },
): Promise<DevSeedOnboardingValues> {
  const [existingUser] = await db
    .select({
      profileSetupCompletedAt: users.profileSetupCompletedAt,
      signupSurveyCompletedAt: users.signupSurveyCompletedAt,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  const values = devSeedOnboardingValues(input.withOnboarding, input.now, existingUser ?? {});
  await db
    .update(users)
    .set(values.user)
    .where(eq(users.id, input.userId));
  await db
    .update(serverMembers)
    .set(values.membership)
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.userId),
    ));

  return values;
}
