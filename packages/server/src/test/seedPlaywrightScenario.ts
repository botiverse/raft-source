import argon2 from "argon2";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, channels, tasks, userAnnouncementDismissals, servers, serverMembers } from "../db/schema.js";
import { createServer, addMember } from "../services/serverService.js";
import { createMessage } from "../services/messageService.js";
import { createAgent } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import * as announcementService from "../services/announcementService.js";

export type PlaywrightSeedState = {
  user: {
    email: string;
    password: string;
    name: string;
  };
  server: {
    id: string;
    slug: string;
    name: string;
  };
  channel: {
    id: string;
    name: string;
  };
  messages: {
    total: number;
    latestContent: string;
    focusMessageId: string;
  };
  agent: {
    id: string;
    name: string;
  };
  machine: {
    id: string;
    name: string;
  };
  extraHuman: {
    userId: string;
    email: string;
    password: string;
    name: string;
  };
  legacyTask: {
    id: string;
    taskNumber: number;
    title: string;
  };
  announcement: {
    id: string;
    title: string;
    pages: Array<{ title?: string; body: string }>;
  };
};

type PlaywrightSeedOptions = {
  messageCount?: number;
  focusFromEnd?: number;
};

const PLAYWRIGHT_USER = {
  email: "playwright-owner@slock.test",
  password: "playwright-password-123",
  name: "playwright-owner",
};

const PLAYWRIGHT_EXTRA_HUMAN = {
  email: "playwright-extra@slock.test",
  password: "playwright-password-123",
  name: "playwright-extra",
  displayName: "Playwright Extra",
};

const PROFILE_SETUP_COMPLETED_AT_ISO = "2026-07-13T00:00:00.000Z";

async function grandfatherPlaywrightFixtures(input: {
  serverId: string;
  userIds: string[];
}) {
  const db = getDb();

  // PGlite applies every migration before this scenario inserts its rows, so the
  // production grandfathering backfills never see these otherwise-legacy fixtures.
  // Replay only their terminal outcomes here; real newly-created users and servers
  // keep the production defaults and must still complete onboarding normally.
  await db
    .update(users)
    .set({
      signupSurveyCompletedAt: new Date(PROFILE_SETUP_COMPLETED_AT_ISO),
      // Migration 0209 derives this account-global terminal fact from the
      // legacy profile/setup rows. These fixtures are inserted after every
      // migration has already run, so replay the same outcome explicitly.
      firstOnboardingCompletedAt: new Date(PROFILE_SETUP_COMPLETED_AT_ISO),
    })
    .where(inArray(users.id, input.userIds));

  await db
    .update(serverMembers)
    .set({
      setupStatus: "complete",
      setupCompletionReason: "grandfathered",
    })
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      inArray(serverMembers.userId, input.userIds),
    ));
}

export async function seedPlaywrightScenario(
  options: PlaywrightSeedOptions = {},
): Promise<PlaywrightSeedState> {
  const db = getDb();
  const messageCount = options.messageCount ?? 150;
  const focusFromEnd = options.focusFromEnd ?? 50;
  const passwordHash = await argon2.hash(PLAYWRIGHT_USER.password);

  const [user] = await db.insert(users).values({
    email: PLAYWRIGHT_USER.email,
    name: PLAYWRIGHT_USER.name,
    displayName: "Playwright Owner",
    passwordHash,
    emailVerified: true,
    profileSetupCompletedAt: new Date(PROFILE_SETUP_COMPLETED_AT_ISO),
    referralSourceSkippedAt: new Date(),
  }).returning();

  const server = await createServer("Playwright Server", "playwright-server", user.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await db.update(serverMembers).set({
    setupModalReminderOptOut: true,
    dismissedAddComputerStepAt: new Date(),
    dismissedCreateAgentStepAt: new Date(),
    dismissedCommunityStepAt: new Date(),
    dismissedNotificationStepAt: new Date(),
  }).where(eq(serverMembers.userId, user.id));
  const [allChannel] = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(eq(channels.serverId, server.id));

  if (!allChannel) {
    throw new Error("Failed to resolve seeded #all channel");
  }

  const createdMessages: Array<{ id: string; content: string }> = [];
  for (let idx = 1; idx <= messageCount; idx += 1) {
    const message = await createMessage(
      allChannel.id,
      "user",
      user.id,
      `Seed message ${idx.toString().padStart(3, "0")}`,
    );
    createdMessages.push({ id: message.id, content: message.content });
  }

  const focusIndex = Math.max(0, createdMessages.length - focusFromEnd);
  const focusMessage = createdMessages[focusIndex];
  const latestMessage = createdMessages[createdMessages.length - 1];

  if (!focusMessage || !latestMessage) {
    throw new Error("Failed to seed message fixtures");
  }

  // Extra entities used by mobile-back deep-URL e2e tests so each detail
  // panel route resolves to a real id.
  const { machine } = await registerMachine(server.id, user.id, "playwright-machine");
  const agent = await createAgent(server.id, "playwright-agent", { machineId: machine.id });

  const extraHumanPasswordHash = await argon2.hash(PLAYWRIGHT_EXTRA_HUMAN.password);
  const [extraHuman] = await db.insert(users).values({
    email: PLAYWRIGHT_EXTRA_HUMAN.email,
    name: PLAYWRIGHT_EXTRA_HUMAN.name,
    displayName: PLAYWRIGHT_EXTRA_HUMAN.displayName,
    passwordHash: extraHumanPasswordHash,
    emailVerified: true,
    profileSetupCompletedAt: new Date(PROFILE_SETUP_COMPLETED_AT_ISO),
    referralSourceSkippedAt: new Date(),
  }).returning();
  await addMember(server.id, extraHuman.id, "member");
  await db.update(serverMembers).set({
    setupModalReminderOptOut: true,
    dismissedAddComputerStepAt: new Date(),
    dismissedCreateAgentStepAt: new Date(),
    dismissedCommunityStepAt: new Date(),
    dismissedNotificationStepAt: new Date(),
  }).where(eq(serverMembers.userId, extraHuman.id));

  await grandfatherPlaywrightFixtures({
    serverId: server.id,
    userIds: [user.id, extraHuman.id],
  });

  // Account-level announcement fixture. Seeded once so the announcement
  // contract test (`announcement-modal.spec.ts`) has a known row to drive,
  // but pre-dismissed for the playwright owner so every other test (which
  // logs in as that owner) does not see the modal in the way of its UI.
  const announcementPages = [
    { title: "Page 1", body: "First page **markdown** body." },
    { title: "Page 2", body: "Second page body." },
    { body: "Final page (no inline title)." },
  ];
  const announcementRow = await announcementService.publish({
    title: "Playwright announcement fixture",
    pages: announcementPages,
  });
  await db.insert(userAnnouncementDismissals).values({
    userId: user.id,
    announcementId: announcementRow.id,
  });

  // Legacy task (old tasks table) so detail-panel-layout tests can open the
  // LegacyTaskPanel. status=done keeps it out of the board's default buckets.
  const [legacyTaskRow] = await db.insert(tasks).values({
    channelId: allChannel.id,
    taskNumber: 1001,
    title: "Playwright legacy task fixture",
    status: "done",
    createdByType: "user",
    createdById: user.id,
    claimedByType: "user",
    claimedById: user.id,
    completedAt: new Date(),
  }).returning();

  return {
    user: PLAYWRIGHT_USER,
    server: {
      id: server.id,
      slug: server.slug,
      name: server.name,
    },
    channel: {
      id: allChannel.id,
      name: allChannel.name,
    },
    messages: {
      total: createdMessages.length,
      latestContent: latestMessage.content,
      focusMessageId: focusMessage.id,
    },
    agent: {
      id: agent.id,
      name: agent.name,
    },
    machine: {
      id: machine.id,
      name: machine.name,
    },
    extraHuman: {
      userId: extraHuman.id,
      email: PLAYWRIGHT_EXTRA_HUMAN.email,
      password: PLAYWRIGHT_EXTRA_HUMAN.password,
      name: PLAYWRIGHT_EXTRA_HUMAN.name,
    },
    legacyTask: {
      id: legacyTaskRow.id,
      taskNumber: legacyTaskRow.taskNumber,
      title: legacyTaskRow.title,
    },
    announcement: {
      id: announcementRow.id,
      title: announcementRow.title,
      pages: announcementPages,
    },
  };
}
