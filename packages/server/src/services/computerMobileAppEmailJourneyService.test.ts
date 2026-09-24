import { fixturePasswordHash } from "../test/integration/credentials.js";
import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  computers,
  machines,
  newsletterAudienceContacts,
  onboardingEmailJourneys,
  servers,
  users,
} from "../db/schema.js";
import {
  enqueueComputerMobileAppEmailJourney,
  resetComputerMobileAppEmailJourneyTestOverrides,
  setComputerMobileAppEmailJourneyConfigForTest,
  suppressScheduledComputerMobileAppEmailJourneys,
} from "./computerMobileAppEmailJourneyService.js";


async function seedUserAndComputer(input: {
  email: string;
  connectedAt: Date;
  emailVerified?: boolean;
  displayLanguage?: string | null;
}) {
  const [user] = await getDb().insert(users).values({
    email: input.email,
    name: input.email.split("@")[0] ?? "mobile-user",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: input.emailVerified ?? true,
    displayLanguage: input.displayLanguage ?? null,
  }).returning();
  const [server] = await getDb().insert(servers).values({
    name: "Mobile lifecycle test",
    slug: `mobile-${user.id}`,
    ownerId: user.id,
  }).returning();
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: user.id,
    name: "first-computer-machine",
    apiKeyHash: "machine-hash",
    apiKeyPrefix: `machine-${user.id}`,
  }).returning();
  const [computer] = await getDb().insert(computers).values({
    serverId: server.id,
    name: "first-computer",
    apiKeyHash: "hash",
    apiKeyPrefix: `prefix-${user.id}`,
    attachedByUserId: user.id,
    createdAt: input.connectedAt,
    machineId: machine.id,
  }).returning();
  return { user, server, computer, machine };
}

async function getJourney(userId: string) {
  const [journey] = await getDb().select().from(onboardingEmailJourneys).where(and(
    eq(onboardingEmailJourneys.userId, userId),
    eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
  ));
  return journey ?? null;
}

afterEach(async () => {
  resetComputerMobileAppEmailJourneyTestOverrides();
  await closeTestDatabase().catch(() => {});
});

test("first Computer schedules one mobile-app email exactly 48 hours later", async ({ db }) => {

  setComputerMobileAppEmailJourneyConfigForTest({ mode: "all", delayHours: 48 });
  const connectedAt = new Date("2026-08-22T00:00:00.000Z");
  const { user, computer } = await seedUserAndComputer({
    email: "first-computer@example.com",
    connectedAt,
  });
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (message?: unknown, ...rest: unknown[]) => {
    logs.push([message, ...rest].map(String).join(" "));
  };

  try {
    assert.deepEqual(
      await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
      { status: "scheduled" },
    );
    assert.deepEqual(
      await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
      { status: "already_started" },
    );
  } finally {
    console.log = originalLog;
  }

  const journey = await getJourney(user.id);
  assert.equal(journey?.qualifiedAt.toISOString(), connectedAt.toISOString());
  assert.equal(journey?.day0Status, "skipped");
  assert.equal(journey?.day1Status, "scheduled");
  assert.equal(journey?.day1ScheduledAt?.toISOString(), "2026-08-24T00:00:00.000Z");
  assert.equal(journey?.lastError, null);

  const output = logs.join("\n");
  assert.match(output, /From: Raft <notifications@raft\.build>/);
  assert.match(output, /Reply-To: contact@raft\.build/);
  assert.match(output, /Scheduled At: 2026-08-24T00:00:00\.000Z/);
  assert.equal((output.match(/Subject: Take Raft with you/g) ?? []).length, 1);
});

test("a later Computer cannot create the first-connection journey", async ({ db }) => {

  setComputerMobileAppEmailJourneyConfigForTest({ mode: "dry_run" });
  const { user, server, machine } = await seedUserAndComputer({
    email: "later-computer@example.com",
    connectedAt: new Date("2026-08-20T00:00:00.000Z"),
  });
  const [later] = await getDb().insert(computers).values({
    serverId: server.id,
    name: "later-computer",
    apiKeyHash: "hash-2",
    apiKeyPrefix: `prefix-2-${user.id}`,
    attachedByUserId: user.id,
    createdAt: new Date("2026-08-21T00:00:00.000Z"),
    machineId: machine.id,
  }).returning();

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: later.id }),
    { status: "skipped", reason: "not_first_computer" },
  );
  assert.equal(await getJourney(user.id), null);
});

test("dry-run records the first-Computer plan without sending", async ({ db }) => {

  setComputerMobileAppEmailJourneyConfigForTest({ mode: "dry_run", delayHours: 48 });
  const connectedAt = new Date("2026-08-22T01:02:03.000Z");
  const { user, computer } = await seedUserAndComputer({
    email: "dry-run-mobile@example.com",
    connectedAt,
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
    { status: "dry_run" },
  );
  const journey = await getJourney(user.id);
  assert.equal(journey?.releaseMode, "dry_run");
  assert.equal(journey?.day0Status, "dry_run");
  assert.equal(journey?.day1Status, "dry_run");
  assert.equal(journey?.day1ScheduledAt?.toISOString(), "2026-08-24T01:02:03.000Z");
  assert.equal(journey?.day1EmailId, null);
});

test("newsletter unsubscribe, bounce, and complaint each suppress the mobile lifecycle email", async ({ db }) => {

  setComputerMobileAppEmailJourneyConfigForTest({ mode: "all" });
  for (const [index, status] of (["unsubscribed", "bounced", "complained"] as const).entries()) {
    const { user, computer } = await seedUserAndComputer({
      email: `mobile-${status}@example.com`,
      connectedAt: new Date(`2026-08-22T00:00:0${index}.000Z`),
    });
    await getDb().insert(newsletterAudienceContacts).values({
      userId: user.id,
      email: user.email,
      audienceId: "newsletter-segment",
      status,
    });

    assert.deepEqual(
      await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
      { status: "skipped", reason: status },
    );
    const journey = await getJourney(user.id);
    assert.equal(journey?.day1Status, "skipped");
    assert.equal(journey?.suppressedReason, status);
  }
});

test("suppression racing the provider schedule cancels the accepted email", async ({ db }) => {

  const canceled: string[] = [];
  const connectedAt = new Date("2026-08-22T00:00:00.000Z");
  const { user, computer } = await seedUserAndComputer({
    email: "schedule-race@example.com",
    connectedAt,
  });
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async () => {
      // Simulate the webhook landing after the pre-schedule suppression read
      // but before Resend's accepted schedule is durably recorded locally.
      await getDb().insert(newsletterAudienceContacts).values({
        userId: user.id,
        email: user.email,
        audienceId: "newsletter-segment",
        status: "complained",
      });
      return "race-scheduled-email";
    },
    cancelEmail: async (emailId) => {
      canceled.push(emailId);
    },
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
    { status: "skipped", reason: "complained" },
  );
  assert.deepEqual(canceled, ["race-scheduled-email"]);
  const journey = await getJourney(user.id);
  assert.equal(journey?.day1Status, "skipped");
  assert.equal(journey?.day1EmailId, "race-scheduled-email");
  assert.equal(journey?.suppressedReason, "complained");
  assert.ok(journey?.canceledAt);
});

test("provider acceptance followed by ledger persistence failure compensates the scheduled email", async ({ db }) => {

  const canceled: string[] = [];
  const { user, computer } = await seedUserAndComputer({
    email: "accepted-ledger-failure@example.com",
    connectedAt: new Date("2026-08-22T00:00:00.000Z"),
  });
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async () => "accepted-provider-email",
    persistAcceptedEmail: async () => {
      throw new Error("ledger unavailable after provider acceptance");
    },
    cancelEmail: async (emailId) => {
      canceled.push(emailId);
    },
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
    { status: "failed" },
  );
  assert.deepEqual(canceled, ["accepted-provider-email"]);
  const journey = await getJourney(user.id);
  assert.equal(journey?.day1Status, "failed");
  assert.equal(journey?.day1EmailId, "accepted-provider-email");
  assert.equal(journey?.cancelReason, "schedule_persist_failed");
  assert.equal(journey?.lastError, "ledger unavailable after provider acceptance");
  assert.ok(journey?.canceledAt);
});

test("failed compensation durably preserves the provider ID for suppression retry", async ({ db }) => {

  let cancelAttempts = 0;
  const { user, computer } = await seedUserAndComputer({
    email: "accepted-cancel-retry@example.com",
    connectedAt: new Date("2026-08-22T00:00:00.000Z"),
  });
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async () => "retryable-provider-email",
    persistAcceptedEmail: async () => {
      throw new Error("ledger unavailable after provider acceptance");
    },
    cancelEmail: async () => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) throw new Error("provider cancellation unavailable");
    },
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
    { status: "failed" },
  );
  let journey = await getJourney(user.id);
  assert.equal(journey?.day1Status, "scheduled");
  assert.equal(journey?.day1EmailId, "retryable-provider-email");
  assert.equal(journey?.lastError, "provider cancellation unavailable");

  assert.deepEqual(
    await suppressScheduledComputerMobileAppEmailJourneys({
      userId: user.id,
      email: user.email,
      status: "unsubscribed",
    }),
    { canceled: 1 },
  );
  assert.equal(cancelAttempts, 2);
  journey = await getJourney(user.id);
  assert.equal(journey?.day1Status, "skipped");
  assert.equal(journey?.suppressedReason, "unsubscribed");
});

test("suppression racing failed compensation cannot be committed before the provider ID is durable", async ({ db }) => {

  let cancelAttempts = 0;
  let pendingSuppressionFailedClosed = false;
  const { user, computer } = await seedUserAndComputer({
    email: "accepted-compensation-race@example.com",
    connectedAt: new Date("2026-08-22T00:00:00.000Z"),
  });
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async () => "raced-provider-email",
    persistAcceptedEmail: async () => {
      throw new Error("ledger unavailable after provider acceptance");
    },
    cancelEmail: async () => {
      cancelAttempts += 1;
      if (cancelAttempts !== 1) return;

      // The webhook lands while the accepted provider ID is not durable. It
      // must fail closed instead of committing a canceled:0 event receipt.
      await getDb().insert(newsletterAudienceContacts).values({
        userId: user.id,
        email: user.email,
        audienceId: "newsletter-segment",
        status: "complained",
      });
      try {
        await suppressScheduledComputerMobileAppEmailJourneys({
          userId: user.id,
          email: user.email,
          status: "complained",
        });
      } catch (error) {
        pendingSuppressionFailedClosed = error instanceof Error
          && /not yet cancelable/.test(error.message);
      }
      throw new Error("provider cancellation unavailable");
    },
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
    { status: "skipped", reason: "complained" },
  );
  assert.equal(pendingSuppressionFailedClosed, true);
  assert.equal(cancelAttempts, 2);
  const journey = await getJourney(user.id);
  assert.equal(journey?.day1Status, "skipped");
  assert.equal(journey?.day1EmailId, "raced-provider-email");
  assert.equal(journey?.suppressedReason, "complained");
  assert.ok(journey?.canceledAt);
});

test("the journey passes the user's display locale to the mobile email renderer", async ({ db }) => {

  const observedLocales: Array<string | null | undefined> = [];
  const chinese = await seedUserAndComputer({
    email: "localized-mobile@example.com",
    connectedAt: new Date("2026-08-22T00:00:00.000Z"),
    displayLanguage: "zh-cn",
  });
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async (_email, options) => {
      observedLocales.push(options?.locale);
      return "localized-email";
    },
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({
      userId: chinese.user.id,
      computerId: chinese.computer.id,
    }),
    { status: "scheduled" },
  );
  assert.deepEqual(observedLocales, ["zh-cn"]);
});

test("unverified users and non-allowlisted users are not scheduled", async ({ db }) => {

  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "allowlist",
    allowlist: ["allowed@example.com"],
  });
  const unverified = await seedUserAndComputer({
    email: "unverified@example.com",
    connectedAt: new Date("2026-08-22T00:00:00.000Z"),
    emailVerified: false,
  });
  const blocked = await seedUserAndComputer({
    email: "blocked@example.com",
    connectedAt: new Date("2026-08-22T00:00:01.000Z"),
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({
      userId: unverified.user.id,
      computerId: unverified.computer.id,
    }),
    { status: "skipped", reason: "unverified" },
  );
  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({
      userId: blocked.user.id,
      computerId: blocked.computer.id,
    }),
    { status: "skipped", reason: "not_allowlisted" },
  );
});

test("email provider failure is recorded without throwing into Computer attach", async ({ db }) => {

  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async () => {
      throw new Error("provider unavailable");
    },
  });
  const { user, computer } = await seedUserAndComputer({
    email: "provider-failure@example.com",
    connectedAt: new Date("2026-08-22T00:00:00.000Z"),
  });

  assert.deepEqual(
    await enqueueComputerMobileAppEmailJourney({ userId: user.id, computerId: computer.id }),
    { status: "failed" },
  );
  const journey = await getJourney(user.id);
  assert.equal(journey?.day1Status, "failed");
  assert.equal(journey?.lastError, "provider unavailable");
});
