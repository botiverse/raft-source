#!/usr/bin/env tsx
/**
 * Seed script for dev environments.
 * Creates minimal test data directly via Drizzle ORM (no running server needed).
 *
 * Usage:
 *   DATABASE_URL="..." tsx scripts/seed.ts [--output <file>] [--with-onboarding]
 *
 * Idempotent: skips creation if data already exists.
 * Outputs JSON with credentials to stdout (or --output file).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, isNull, desc } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import * as schema from "../src/db/schema.js";
import { buildSearchText } from "../src/services/searchService.js";
import { getStorage } from "../src/services/storageService.js";
import { applyDevSeedOnboardingFixture } from "./devSeedOnboarding.js";

const {
  users,
  servers,
  serverMembers,
  serverAgentMembers,
  machines,
  computers,
  agents,
  channels,
  channelAgents,
  channelHumans,
  messages,
  messageReactions,
  userChannelReadCursors,
  threadFollows,
  tasks,
  taskEvents,
  agentRuntimeProfiles,
  agentChannelReadCursors,
  attachments,
  agentActivityEvents,
  reminders,
  userSaved,
  announcements,
  featureFlags,
  rapAppConfigs,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
} = schema;

// --- Config ---
const SEED_USER_EMAIL = "dev@slock.ai";
const SEED_USER_PASSWORD = "password123";
const SEED_USER_NAME = "Developer";
const SEED_SERVER_NAME = "Dev Workspace";
const SEED_SERVER_SLUG = "dev";
const SEED_MACHINE_NAME = "dev-machine";
const SEED_AGENT_NAME = "assistant";
const SEED_CHANNEL_NAME = "general";
const SEED_DM_CHANNEL_NAME = "assistant-dm";

const THREAD_SEED_CONTENT = {
  generalUnreadParent: "Could you review the onboarding copy?",
  generalUnreadReply1: "Can you make the introduction shorter?",
  generalUnreadReply2: "Yes, I can trim the first paragraph.",
  generalUnreadReply3: "Great, please tighten the call to action too.",
  generalReadParent: "Could you review the release note wording?",
  generalReadReply1: "I think the first bullet is too long.",
  generalReadReply2: "Agreed, I'll compress it before merge.",
  dmIntro: "I'm looking at the daemon reconnect logs now.",
  dmParent: "Here is the reconnect stack trace.",
  dmReply1: "Can you annotate the failure window?",
  dmReply2: "I added notes inline. Please take another look.",
  // Extra threads for richer inbox
  bugReportParent: "Bug: sidebar flickers on fast channel switching — looks like the unread count re-render triggers a layout shift. Happens on both desktop and mobile.",
  bugReportReply1: "Reproduced on Chrome 126. The channelStore selector is returning a new array ref every time because of the filter().",
  bugReportReply2: "Good catch. I'll memoize the selector. Should be a one-liner fix.",
  bugReportReply3: "Actually it's two places — channelStore and messageStore both have the same pattern.",
  designReviewParent: "Design review: new settings panel layout — moved the danger zone to a collapsible section at the bottom. Screenshots attached.",
  designReviewReply1: "Looks clean. One thought: can we keep the Delete button visible without expanding? Users might not find it.",
  designReviewReply2: "Fair point. How about a subtle red border on the collapsed header to hint there's something destructive inside?",
  deployParent: "Heads up: deploying v0.30.1 to staging after lunch. Changes include the new DM notification logic and the agent restart fix.",
  deployReply1: "Is the migration backward-compatible? I have a daemon on 0.29 still running.",
  deployReply2: "Yes, no breaking changes. The new column has a default value.",
  deployReply3: "Deployed. Staging looks good so far. Will monitor for 30 min before promoting.",
  deployReply4: "All clear. No errors in the last 30 min. Ready for production whenever.",
  apiDiscussionParent: "Should we version the internal API? Right now /internal/* has no version prefix, which makes daemon backward compat harder to reason about.",
  apiDiscussionReply1: "I'd rather keep it versionless and use feature flags in the handshake. Versioned APIs add a lot of routing complexity.",
} as const;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  // Routine raftdev fixtures bypass account/server onboarding with canonical
  // persisted completion state. Opt in when onboarding itself is under test.
  let outputPath: string | null = null;
  let withOnboarding = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--with-onboarding") {
      withOnboarding = true;
    }
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = drizzle(pool, { schema });

  try {
    // 1. User
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, SEED_USER_EMAIL));
    if (!user) {
      const passwordHash = await argon2.hash(SEED_USER_PASSWORD);
      [user] = await db
        .insert(users)
        .values({
          email: SEED_USER_EMAIL,
          name: SEED_USER_NAME,
          displayName: SEED_USER_NAME,
          passwordHash,
          emailVerified: true,
        })
        .returning();
      console.error(`Created user: ${user.email}`);
    } else {
      console.error(`User already exists: ${user.email}`);
    }

    // 2. Server
    let [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.slug, SEED_SERVER_SLUG));
    if (!server) {
      [server] = await db
        .insert(servers)
        .values({
          name: SEED_SERVER_NAME,
          slug: SEED_SERVER_SLUG,
          ownerId: user.id,
        })
        .returning();
      console.error(`Created server: ${server.name}`);
    } else {
      console.error(`Server already exists: ${server.slug}`);
    }

    // 3. Server membership
    const [existingMembership] = await db
      .select()
      .from(serverMembers)
      .where(eq(serverMembers.serverId, server.id));
    if (!existingMembership) {
      await db.insert(serverMembers).values({
        serverId: server.id,
        userId: user.id,
        role: "owner",
      });
      console.error(`Added user as server owner`);
    }

    // 4. Machine with known API key
    // We generate a deterministic-looking key but still use proper hashing
    const apiKey = `sk_machine_${randomBytes(32).toString("hex")}`;
    const apiKeyHash = await argon2.hash(apiKey);
    const apiKeyPrefix = apiKey.slice(0, 20);

    // Check if machine already exists for this server
    let [machine] = await db
      .select()
      .from(machines)
      .where(eq(machines.serverId, server.id));
    let machineApiKey = apiKey;
    if (!machine) {
      [machine] = await db
        .insert(machines)
        .values({
          serverId: server.id,
          userId: user.id,
          name: SEED_MACHINE_NAME,
          apiKeyHash,
          apiKeyPrefix,
          runtimes: ["claude", "codex", "kimi"],
          hostname: "dev-host-primary",
          os: "darwin",
          daemonVersion: "0.41.0",
          lastHeartbeat: new Date(),
        })
        .returning();
      console.error(`Created machine: ${machine.name}`);
    } else {
      // Machine exists — update its API key so we can output a working one
      await db
        .update(machines)
        .set({
          apiKeyHash,
          apiKeyPrefix,
          runtimes: ["claude", "codex", "kimi"],
          hostname: "dev-host-primary",
          os: "darwin",
          daemonVersion: "0.41.0",
          lastHeartbeat: new Date(),
        })
        .where(eq(machines.id, machine.id));
      console.error(`Machine already exists: ${machine.name} (API key rotated)`);
    }

    // 5. Agent
    let [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.serverId, server.id));
    if (!agent) {
      [agent] = await db
        .insert(agents)
        .values({
          serverId: server.id,
          name: SEED_AGENT_NAME,
          displayName: "Assistant",
          status: "inactive",
          model: "sonnet",
          runtime: "claude",
          machineId: machine.id,
        })
        .returning();
      console.error(`Created agent: ${agent.name}`);
    } else {
      console.error(`Agent already exists: ${agent.name}`);
    }
    await db
      .insert(serverAgentMembers)
      .values({
        serverId: server.id,
        agentId: agent.id,
        role: "member",
        joinedAt: agent.createdAt ?? new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    // The seed is idempotent, so write the selected fixture mode on every run
    // instead of only when rows are first inserted. Developers can deliberately
    // reopen onboarding, then return to the default validation-ready fixture.
    await applyDevSeedOnboardingFixture(db, {
      userId: user.id,
      serverId: server.id,
      withOnboarding,
      now: new Date(),
    });
    console.error(withOnboarding
      ? "Seeded onboarding fixture: fresh owner flow enabled"
      : "Seeded onboarding fixture: canonical gates completed");

    // 6a. #all channel (system channel, created first — matches normal server creation flow)
    const [existingAll] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "all"), eq(channels.type, "channel")));
    let allChannel;
    if (!existingAll) {
      [allChannel] = await db
        .insert(channels)
        .values({
          serverId: server.id,
          name: "all",
          description: "General channel for all members",
          type: "channel",
        })
        .returning();
      // Add user and agent to #all
      await db.insert(channelHumans).values({ channelId: allChannel.id, userId: user.id });
      await db.insert(channelAgents).values({ channelId: allChannel.id, agentId: agent.id });
      console.error(`Created channel: #all`);
    } else {
      allChannel = existingAll;
      console.error(`Channel already exists: #all`);
    }

    // 6b. #general channel
    let [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, SEED_CHANNEL_NAME), eq(channels.type, "channel")));
    if (!channel) {
      [channel] = await db
        .insert(channels)
        .values({
          serverId: server.id,
          name: SEED_CHANNEL_NAME,
          type: "channel",
        })
        .returning();
      console.error(`Created channel: #${channel.name}`);

      // Add agent to channel
      await db.insert(channelAgents).values({
        channelId: channel.id,
        agentId: agent.id,
      });
      console.error(`Added agent to #${channel.name}`);

      // Add user to channel
      await db.insert(channelHumans).values({
        channelId: channel.id,
        userId: user.id,
      });
      console.error(`Added user to #${channel.name}`);
    } else {
      console.error(`Channel already exists: #${channel.name}`);
    }

    const ensureMessage = async (opts: {
      channelId: string;
      senderType: "user" | "agent";
      senderId: string;
      content: string;
      createdAt: Date;
      messageType?: "chat" | "system";
    }) => {
      const [existing] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.channelId, opts.channelId), eq(messages.content, opts.content)))
        .limit(1);
      if (existing) return existing;
      const [created] = await db
        .insert(messages)
        .values({
          channelId: opts.channelId,
          senderType: opts.senderType,
          senderId: opts.senderId,
          messageType: opts.messageType ?? "chat",
          content: opts.content,
          searchText: buildSearchText(opts.content),
          createdAt: opts.createdAt,
          updatedAt: opts.createdAt,
        })
        .returning();
      return created;
    };

    const ensureDmChannel = async () => {
      let [dmChannel] = await db
        .select()
        .from(channels)
        .where(and(
          eq(channels.serverId, server.id),
          eq(channels.name, SEED_DM_CHANNEL_NAME),
          eq(channels.type, "dm"),
          isNull(channels.deletedAt),
        ))
        .limit(1);

      if (!dmChannel) {
        [dmChannel] = await db
          .insert(channels)
          .values({
            serverId: server.id,
            name: SEED_DM_CHANNEL_NAME,
            description: "Seeded DM channel for slockdev thread coverage",
            type: "dm",
          })
          .returning();
        console.error(`Created DM channel: ${SEED_DM_CHANNEL_NAME}`);
      }

      await db.insert(channelHumans).values({ channelId: dmChannel.id, userId: user.id }).onConflictDoNothing();
      await db.insert(channelAgents).values({ channelId: dmChannel.id, agentId: agent.id }).onConflictDoNothing();
      return dmChannel;
    };

    const ensureThreadChannel = async (opts: {
      parentMessageId: string;
      participants: Array<{ type: "user" | "agent"; id: string }>;
    }) => {
      let [threadChannel] = await db
        .select()
        .from(channels)
        .where(and(
          eq(channels.parentMessageId, opts.parentMessageId),
          eq(channels.type, "thread"),
          isNull(channels.deletedAt),
        ))
        .limit(1);

      if (!threadChannel) {
        const threadName = `thread-${opts.parentMessageId.slice(0, 8)}`;
        [threadChannel] = await db
          .insert(channels)
          .values({
            serverId: server.id,
            name: threadName,
            type: "thread",
            parentMessageId: opts.parentMessageId,
          })
          .returning();
      }

      await db
        .update(messages)
        .set({ threadId: threadChannel.id })
        .where(eq(messages.id, opts.parentMessageId));

      for (const participant of opts.participants) {
        await db.insert(threadFollows).values({
          threadChannelId: threadChannel.id,
          followerType: participant.type,
          followerId: participant.id,
          parentMessageId: opts.parentMessageId,
          reason: "replied",
        }).onConflictDoNothing();
      }

      return threadChannel;
    };

    const ensureThreadFollow = async (
      threadChannelId: string,
      parentMessageId: string,
      reason: "replied" | "authored" | "manual",
    ) => {
      await db.insert(threadFollows).values({
        threadChannelId,
        followerType: "user",
        followerId: user.id,
        parentMessageId,
        reason,
      }).onConflictDoNothing();
    };

    const ensureUserReadCursor = async (channelId: string, lastReadSeq: number) => {
      const [existing] = await db
        .select()
        .from(userChannelReadCursors)
        .where(and(
          eq(userChannelReadCursors.userId, user.id),
          eq(userChannelReadCursors.channelId, channelId),
        ))
        .limit(1);

      if (existing) {
        await db
          .update(userChannelReadCursors)
          .set({ lastReadSeq, updatedAt: new Date() })
          .where(and(
            eq(userChannelReadCursors.userId, user.id),
            eq(userChannelReadCursors.channelId, channelId),
          ));
      } else {
        await db.insert(userChannelReadCursors).values({
          userId: user.id,
          channelId,
          lastReadSeq,
        });
      }
    };

    const ensureSeedUser = async (opts: { email: string; name: string; displayName: string }) => {
      let [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.email, opts.email))
        .limit(1);
      if (existingUser) return existingUser;
      const passwordHash = await argon2.hash(SEED_USER_PASSWORD);
      [existingUser] = await db
        .insert(users)
        .values({
          email: opts.email,
          name: opts.name,
          displayName: opts.displayName,
          passwordHash,
          emailVerified: true,
        })
        .returning();
      console.error(`Created seed user: ${existingUser.email}`);
      return existingUser;
    };

    const ensureServerMembership = async (
      serverId: string,
      userId: string,
      role: "owner" | "admin" | "member",
    ) => {
      const [existing] = await db
        .select()
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
        .limit(1);
      if (existing) {
        await db
          .update(serverMembers)
          .set({ role })
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
      } else {
        await db.insert(serverMembers).values({ serverId, userId, role });
      }
    };

    const addHumanToChannel = async (channelId: string, userId: string) => {
      await db.insert(channelHumans).values({ channelId, userId }).onConflictDoNothing();
    };

    const addAgentToChannel = async (channelId: string, agentId: string) => {
      await db.insert(channelAgents).values({ channelId, agentId }).onConflictDoNothing();
    };

    const ensureSeedChannel = async (opts: {
      serverId: string;
      name: string;
      description: string;
      type: "channel" | "private" | "joint";
    }) => {
      let [existingChannel] = await db
        .select()
        .from(channels)
        .where(and(
          eq(channels.serverId, opts.serverId),
          eq(channels.name, opts.name),
          eq(channels.type, opts.type),
          isNull(channels.deletedAt),
        ))
        .limit(1);
      if (!existingChannel) {
        [existingChannel] = await db.insert(channels).values(opts).returning();
      } else if (existingChannel.description !== opts.description) {
        [existingChannel] = await db
          .update(channels)
          .set({ description: opts.description })
          .where(eq(channels.id, existingChannel.id))
          .returning();
      }
      return existingChannel;
    };

    const ensureSeedMachine = async (opts: {
      name: string;
      hostname: string;
      runtimes: string[];
      daemonVersion: string;
      lastHeartbeat: Date | null;
      os: string;
    }) => {
      let [existingMachine] = await db
        .select()
        .from(machines)
        .where(and(eq(machines.serverId, server.id), eq(machines.name, opts.name)))
        .limit(1);
      if (!existingMachine) {
        const extraApiKey = `sk_machine_${randomBytes(32).toString("hex")}`;
        [existingMachine] = await db
          .insert(machines)
          .values({
            serverId: server.id,
            userId: user.id,
            name: opts.name,
            apiKeyHash: await argon2.hash(extraApiKey),
            apiKeyPrefix: extraApiKey.slice(0, 20),
            runtimes: opts.runtimes,
            hostname: opts.hostname,
            os: opts.os,
            daemonVersion: opts.daemonVersion,
            lastHeartbeat: opts.lastHeartbeat,
          })
          .returning();
        console.error(`Created seed machine: ${existingMachine.name}`);
      } else {
        await db
          .update(machines)
          .set({
            runtimes: opts.runtimes,
            hostname: opts.hostname,
            os: opts.os,
            daemonVersion: opts.daemonVersion,
            lastHeartbeat: opts.lastHeartbeat,
          })
          .where(eq(machines.id, existingMachine.id));
      }
      return existingMachine;
    };

    const ensureSeedAgent = async (opts: {
      serverId?: string;
      name: string;
      displayName: string;
      runtime: string;
      model: string;
      status: "active" | "inactive" | "stopped";
      machineId: string | null;
      reasoningEffort?: "low" | "medium" | "high" | "xhigh" | null;
      executionMode?: "byoc" | "cloud";
      description: string;
    }) => {
      let [existingAgent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.serverId, opts.serverId ?? server.id), eq(agents.name, opts.name), isNull(agents.deletedAt)))
        .limit(1);
      const values = {
        displayName: opts.displayName,
        runtime: opts.runtime,
        model: opts.model,
        status: opts.status,
        machineId: opts.machineId,
        reasoningEffort: opts.reasoningEffort ?? null,
        executionMode: opts.executionMode ?? "byoc",
        creatorType: "user" as const,
        creatorId: user.id,
        description: opts.description,
      };
      if (!existingAgent) {
        [existingAgent] = await db
          .insert(agents)
          .values({
            serverId: opts.serverId ?? server.id,
            name: opts.name,
            ...values,
          })
          .returning();
        console.error(`Created seed agent: ${existingAgent.name}`);
      } else {
        await db.update(agents).set(values).where(eq(agents.id, existingAgent.id));
      }
      await db
        .insert(serverAgentMembers)
        .values({
          serverId: opts.serverId ?? server.id,
          agentId: existingAgent.id,
          role: "member",
          joinedAt: existingAgent.createdAt ?? new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      return existingAgent;
    };

    const runtimeFingerprint = (parts: string[]) =>
      createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);

    const ensureRuntimeProfile = async (opts: {
      agentId: string;
      machineId: string;
      runtime: string;
      model: string;
      reasoningEffort?: string | null;
      executionMode?: string;
      daemonVersion: string;
      migrationStatus: "stable" | "pending" | "migrating";
      pendingKind?: "migration" | "daemon_release_notice" | null;
      pendingKey?: string | null;
      before?: { machineId: string; runtime: string; model: string; daemonVersion: string };
    }) => {
      const currentFingerprint = runtimeFingerprint([
        opts.machineId,
        opts.runtime,
        opts.model,
        opts.reasoningEffort ?? "",
        opts.executionMode ?? "byoc",
        opts.daemonVersion,
      ]);
      const before = opts.before ?? {
        machineId: opts.machineId,
        runtime: opts.runtime,
        model: opts.model,
        daemonVersion: opts.daemonVersion,
      };
      const baselineFingerprint = runtimeFingerprint([
        before.machineId,
        before.runtime,
        before.model,
        opts.reasoningEffort ?? "",
        opts.executionMode ?? "byoc",
        before.daemonVersion,
      ]);
      const profileValues = {
        serverId: server.id,
        machineId: opts.machineId,
        runtimeProfileFingerprint: currentFingerprint,
        runtime: opts.runtime,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort ?? null,
        executionMode: opts.executionMode ?? "byoc",
        daemonVersion: opts.daemonVersion,
        workspaceRefLabel: "seed workspace",
        workspaceRefPath: `/tmp/slockdev/${opts.agentId.slice(0, 8)}`,
        workspaceRefMachineId: opts.machineId,
        workspaceRefRuntime: opts.runtime,
        workspaceRefReachable: opts.migrationStatus !== "migrating",
        workspaceRefReason: opts.migrationStatus === "migrating" ? "seeded stuck migration" : null,
        sessionRefLabel: "seed session",
        sessionRefPath: `/tmp/slockdev/sessions/${opts.agentId.slice(0, 8)}.jsonl`,
        sessionRefMachineId: opts.machineId,
        sessionRefRuntime: opts.runtime,
        sessionRefReachable: true,
        baselineRuntimeProfileFingerprint: baselineFingerprint,
        baselineMachineId: before.machineId,
        baselineRuntime: before.runtime,
        baselineModel: before.model,
        baselineReasoningEffort: opts.reasoningEffort ?? null,
        baselineExecutionMode: opts.executionMode ?? "byoc",
        baselineDaemonVersion: before.daemonVersion,
        migrationStatus: opts.migrationStatus,
        pendingKind: opts.pendingKind ?? null,
        pendingKey: opts.pendingKey ?? null,
        pendingBeforeRuntimeProfileFingerprint: opts.pendingKind ? baselineFingerprint : null,
        pendingAfterRuntimeProfileFingerprint: opts.pendingKind ? currentFingerprint : null,
        pendingBeforeMachineId: opts.pendingKind ? before.machineId : null,
        pendingAfterMachineId: opts.pendingKind ? opts.machineId : null,
        pendingBeforeRuntime: opts.pendingKind ? before.runtime : null,
        pendingAfterRuntime: opts.pendingKind ? opts.runtime : null,
        pendingBeforeModel: opts.pendingKind ? before.model : null,
        pendingAfterModel: opts.pendingKind ? opts.model : null,
        pendingBeforeExecutionMode: opts.pendingKind ? "byoc" : null,
        pendingAfterExecutionMode: opts.pendingKind ? opts.executionMode ?? "byoc" : null,
        pendingBeforeDaemonVersion: opts.pendingKind ? before.daemonVersion : null,
        pendingAfterDaemonVersion: opts.pendingKind ? opts.daemonVersion : null,
        pendingPreviousSessionLabel: opts.pendingKind === "migration" ? "previous seed session" : null,
        pendingPreviousSessionPath: opts.pendingKind === "migration" ? `/tmp/slockdev/previous/${opts.agentId.slice(0, 8)}.jsonl` : null,
        pendingPreviousSessionMachineId: opts.pendingKind === "migration" ? before.machineId : null,
        pendingPreviousSessionRuntime: opts.pendingKind === "migration" ? before.runtime : null,
        pendingPreviousSessionReachable: opts.pendingKind === "migration" ? false : null,
        pendingPreviousSessionReason: opts.pendingKind === "migration" ? "old machine is offline in seed data" : null,
        pendingReleaseNotesUrl: null,
        migrationDeliveredAt: opts.pendingKind ? new Date(Date.now() - 9 * 60 * 1000) : null,
        migrationDeliveredLaunchId: opts.pendingKind ? `seed-launch-${opts.agentId.slice(0, 8)}` : null,
        migratingSince: opts.migrationStatus === "migrating" ? new Date(Date.now() - 45 * 60 * 1000) : null,
        lastMigrationNudgeAt: opts.migrationStatus === "migrating" ? new Date(Date.now() - 15 * 60 * 1000) : null,
        migrationNudgeCount: opts.migrationStatus === "migrating" ? 2 : 0,
        migrationHandledAt: null,
        migrationHandledLaunchId: null,
        revision: opts.pendingKind ? 2 : 1,
        observedAt: new Date(),
        updatedAt: new Date(),
      };
      const [existing] = await db
        .select({ agentId: agentRuntimeProfiles.agentId })
        .from(agentRuntimeProfiles)
        .where(eq(agentRuntimeProfiles.agentId, opts.agentId))
        .limit(1);
      if (existing) {
        await db.update(agentRuntimeProfiles).set(profileValues).where(eq(agentRuntimeProfiles.agentId, opts.agentId));
      } else {
        await db.insert(agentRuntimeProfiles).values({ agentId: opts.agentId, ...profileValues });
      }
    };

    const ensureTaskMessage = async (opts: {
      content: string;
      taskNumber: number;
      taskStatus: "todo" | "in_progress" | "in_review" | "done" | "closed";
      assignee?: { type: "user" | "agent"; id: string } | null;
      createdAt: Date;
    }) => {
      const message = await ensureMessage({
        channelId: channel.id,
        senderType: "user",
        senderId: user.id,
        content: opts.content,
        createdAt: opts.createdAt,
      });
      await db
        .update(messages)
        .set({
          taskStatus: opts.taskStatus,
          taskNumber: opts.taskNumber,
          taskAssigneeType: opts.assignee?.type ?? null,
          taskAssigneeId: opts.assignee?.id ?? null,
          taskClaimedAt: opts.assignee ? new Date(opts.createdAt.getTime() + 60 * 1000) : null,
          taskCompletedAt: opts.taskStatus === "done" ? new Date(opts.createdAt.getTime() + 5 * 60 * 1000) : null,
          updatedAt: new Date(),
        })
        .where(eq(messages.id, message.id));
      return message;
    };

    const ensureMessageReaction = async (opts: {
      messageId: string;
      reactorType: "user" | "agent";
      reactorId: string;
      emoji: string;
    }) => {
      await db.insert(messageReactions).values({
        messageId: opts.messageId,
        reactorType: opts.reactorType,
        reactorId: opts.reactorId,
        emoji: opts.emoji,
      }).onConflictDoNothing();
    };

    const seedActivityEvent = async (opts: {
      agentId: string;
      activity: "online" | "thinking" | "working" | "error" | "offline";
      detail: string;
      entries: typeof agentActivityEvents.$inferInsert.entries;
      createdAt: Date;
    }) => {
      const [existing] = await db
        .select({ id: agentActivityEvents.id })
        .from(agentActivityEvents)
        .where(and(eq(agentActivityEvents.agentId, opts.agentId), eq(agentActivityEvents.detail, opts.detail)))
        .limit(1);
      if (existing) return;
      await db.insert(agentActivityEvents).values({
        agentId: opts.agentId,
        activity: opts.activity,
        detail: opts.detail,
        entries: opts.entries,
        createdAt: opts.createdAt,
      });
    };

    const ensureSeedAttachment = async (opts: {
      messageId: string;
      channelId: string;
      uploaderType: "user" | "agent";
      uploaderId: string;
      filename: string;
      mimeType: string;
      bytes: Buffer;
      width?: number;
      height?: number;
    }) => {
      const storage = getStorage();
      if (!storage) return null;
      const storageKey = `seed/${server.id}/${opts.filename}`;
      await storage.put(storageKey, opts.bytes, opts.mimeType);
      const [existing] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.storageKey, storageKey))
        .limit(1);
      const values = {
        messageId: opts.messageId,
        channelId: opts.channelId,
        uploaderId: opts.uploaderId,
        uploaderType: opts.uploaderType,
        filename: opts.filename,
        mimeType: opts.mimeType,
        sizeBytes: opts.bytes.length,
        storageKey,
        contentHash: createHash("sha256").update(opts.bytes).digest("hex"),
        width: opts.width ?? null,
        height: opts.height ?? null,
      };
      if (existing) {
        await db.update(attachments).set(values).where(eq(attachments.id, existing.id));
        return existing;
      }
      const [created] = await db.insert(attachments).values(values).returning();
      return created;
    };

    // 6c. Basic state matrix for local QA/dev screenshots.
    // Keep this intentionally small: representative states, not perf data.
    const adminUser = await ensureSeedUser({ email: "admin@slock.ai", name: "Admin", displayName: "Admin User" });
    const memberUser = await ensureSeedUser({ email: "member@slock.ai", name: "Member", displayName: "Member User" });
    const viewerUser = await ensureSeedUser({ email: "viewer@slock.ai", name: "Viewer", displayName: "Viewer Member" });
    await ensureServerMembership(server.id, user.id, "owner");
    await ensureServerMembership(server.id, adminUser.id, "admin");
    await ensureServerMembership(server.id, memberUser.id, "member");
    await ensureServerMembership(server.id, viewerUser.id, "member");
    for (const seededUser of [adminUser, memberUser, viewerUser]) {
      await applyDevSeedOnboardingFixture(db, {
        userId: seededUser.id,
        serverId: server.id,
        withOnboarding: false,
        now: new Date(),
      });
    }
    for (const member of [adminUser, memberUser, viewerUser]) {
      await addHumanToChannel(allChannel.id, member.id);
    }
    for (const member of [adminUser, memberUser]) {
      await addHumanToChannel(channel.id, member.id);
    }

    const offlineMachine = await ensureSeedMachine({
      name: "seed-offline-laptop",
      hostname: "seed-host-offline",
      runtimes: ["codex"],
      daemonVersion: "0.39.0",
      lastHeartbeat: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      os: "linux",
    });
    const outdatedMachine = await ensureSeedMachine({
      name: "seed-outdated-daemon",
      hostname: "seed-host-outdated",
      runtimes: ["claude"],
      daemonVersion: "0.40.2",
      lastHeartbeat: new Date(Date.now() - 12 * 60 * 1000),
      os: "linux",
    });

    // task #247 — a managed Computer that is set up but offline. An active
    // `computers` row linked via machineId makes the server derive
    // isComputer=true (getComputerLinkedMachineAttachers), and because no
    // real daemon connects in seed the status stays "offline" — exactly the
    // branch the offline recovery card renders. online is never faked (no
    // live WS connection to back it). lastHeartbeat 2h ago drives the
    // "Last seen" line. Idempotent: select-or-insert like ensureSeedMachine.
    const devComputerOffline = await ensureSeedMachine({
      name: "dev-computer-offline",
      hostname: "dev-host-computer",
      runtimes: ["claude", "codex", "kimi"],
      daemonVersion: "0.41.0",
      lastHeartbeat: new Date(Date.now() - 2 * 60 * 60 * 1000),
      os: "darwin",
    });
    {
      const [existingComputer] = await db
        .select()
        .from(computers)
        .where(
          and(
            eq(computers.serverId, server.id),
            eq(computers.machineId, devComputerOffline.id),
            isNull(computers.revokedAt),
          ),
        )
        .limit(1);
      if (!existingComputer) {
        const computerKey = `sk_computer_${randomBytes(32).toString("hex")}`;
        await db.insert(computers).values({
          serverId: server.id,
          name: "dev-computer-offline",
          apiKeyHash: await argon2.hash(computerKey),
          // COMPUTER_API_KEY_PREFIX_LENGTH (computerCredentialService.ts)
          apiKeyPrefix: computerKey.slice(0, 16),
          attachedByUserId: user.id,
          machineId: devComputerOffline.id,
        });
        console.error("Created seed computer: dev-computer-offline");
      }
    }

    await db.update(agents).set({
      displayName: "Claude Assistant",
      runtime: "claude",
      model: "sonnet",
      status: "inactive",
      machineId: machine.id,
      creatorType: "user",
      creatorId: user.id,
      description: "Seeded Claude agent on the primary online machine.",
    }).where(eq(agents.id, agent.id));

    const codexAgent = await ensureSeedAgent({
      name: "codex-reviewer",
      displayName: "Codex Reviewer",
      runtime: "codex",
      model: "gpt-5.3-codex",
      status: "active",
      machineId: machine.id,
      reasoningEffort: "high",
      description: "Active Codex agent for code-review and long-tool activity states.",
    });
    const kimiAgent = await ensureSeedAgent({
      name: "kimi-intern",
      displayName: "Kimi Intern",
      runtime: "kimi",
      model: "kimi-k2",
      status: "inactive",
      machineId: outdatedMachine.id,
      reasoningEffort: "medium",
      description: "Kimi-shaped seed agent on an outdated daemon.",
    });
    const noMachineAgent = await ensureSeedAgent({
      name: "stopped-runner",
      displayName: "Stopped Runner",
      runtime: "claude",
      model: "sonnet",
      status: "stopped",
      machineId: offlineMachine.id,
      description: "Stopped seed agent on a stale/offline machine.",
    });
    for (const seedAgent of [codexAgent, kimiAgent, noMachineAgent]) {
      await addAgentToChannel(allChannel.id, seedAgent.id);
      await addAgentToChannel(channel.id, seedAgent.id);
    }

    await ensureRuntimeProfile({
      agentId: agent.id,
      machineId: machine.id,
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc",
      daemonVersion: "0.41.0",
      migrationStatus: "stable",
    });
    await ensureRuntimeProfile({
      agentId: codexAgent.id,
      machineId: machine.id,
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
      daemonVersion: "0.41.0",
      migrationStatus: "stable",
    });
    await ensureRuntimeProfile({
      agentId: kimiAgent.id,
      machineId: outdatedMachine.id,
      runtime: "kimi",
      model: "kimi-k2",
      reasoningEffort: "medium",
      executionMode: "byoc",
      daemonVersion: "0.40.2",
      migrationStatus: "migrating",
      pendingKind: "migration",
      pendingKey: "seed-migration-stuck",
      before: { machineId: offlineMachine.id, runtime: "claude", model: "sonnet", daemonVersion: "0.39.0" },
    });
    await ensureRuntimeProfile({
      agentId: noMachineAgent.id,
      machineId: offlineMachine.id,
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc",
      daemonVersion: "0.39.0",
      migrationStatus: "pending",
      pendingKind: "daemon_release_notice",
      pendingKey: "seed-daemon-release-notice",
      before: { machineId: offlineMachine.id, runtime: "claude", model: "sonnet", daemonVersion: "0.38.0" },
    });

    const matrixNow = Date.now();
    await seedActivityEvent({
      agentId: codexAgent.id,
      activity: "working",
      detail: "Seed: running a long local validation command",
      entries: [
        { kind: "tool_start", toolName: "exec_command", toolInput: "pnpm --filter @botiverse/raft-web test:e2e" },
        { kind: "status", activity: "working", detail: "Waiting for e2e output" },
      ],
      createdAt: new Date(matrixNow - 11 * 60 * 1000),
    });
    await seedActivityEvent({
      agentId: codexAgent.id,
      activity: "thinking",
      detail: "Seed: compaction still running",
      entries: [
        { kind: "compaction_started" },
        { kind: "system", title: "Compaction", text: "Seeded compaction event for Activity Log QA." },
      ],
      createdAt: new Date(matrixNow - 8 * 60 * 1000),
    });
    await seedActivityEvent({
      agentId: noMachineAgent.id,
      activity: "offline",
      detail: "Seed: stopped agent is pinned to an offline machine",
      entries: [{ kind: "status", activity: "offline", detail: "Machine heartbeat is stale" }],
      createdAt: new Date(matrixNow - 6 * 60 * 1000),
    });

    let [isolationServer] = await db
      .select()
      .from(servers)
      .where(eq(servers.slug, "isolation"))
      .limit(1);
    if (!isolationServer) {
      [isolationServer] = await db.insert(servers).values({
        name: "Partner Workspace",
        slug: "isolation",
        ownerId: user.id,
      }).returning();
      console.error("Created server: isolation");
    } else if (isolationServer.name !== "Partner Workspace") {
      [isolationServer] = await db
        .update(servers)
        .set({ name: "Partner Workspace" })
        .where(eq(servers.id, isolationServer.id))
        .returning();
    }
    await ensureServerMembership(isolationServer.id, user.id, "owner");
    await ensureServerMembership(isolationServer.id, adminUser.id, "admin");
    await ensureServerMembership(isolationServer.id, memberUser.id, "member");
    for (const seededUser of [user, adminUser, memberUser]) {
      await applyDevSeedOnboardingFixture(db, {
        userId: seededUser.id,
        serverId: isolationServer.id,
        withOnboarding: false,
        now: new Date(),
      });
    }
    let [isolationChannel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.serverId, isolationServer.id), eq(channels.name, "isolation"), eq(channels.type, "channel")))
      .limit(1);
    if (!isolationChannel) {
      [isolationChannel] = await db.insert(channels).values({
        serverId: isolationServer.id,
        name: "isolation",
        description: "Minimal second server for cross-server isolation checks.",
        type: "channel",
      }).returning();
    }
    await addHumanToChannel(isolationChannel.id, user.id);
    await addHumanToChannel(isolationChannel.id, adminUser.id);
    await addHumanToChannel(isolationChannel.id, memberUser.id);
    const isolationNoMachineAgent = await ensureSeedAgent({
      serverId: isolationServer.id,
      name: "orphan-agent",
      displayName: "Orphan Agent",
      runtime: "claude",
      model: "sonnet",
      status: "inactive",
      machineId: null,
      description: "Seeded no-machine agent in the isolation server.",
    });
    await addAgentToChannel(isolationChannel.id, isolationNoMachineAgent.id);
    await ensureMessage({
      channelId: isolationChannel.id,
      senderType: "user",
      senderId: user.id,
      content: "This message belongs only to the isolated workspace.",
      createdAt: new Date(matrixNow - 7 * 60 * 1000),
    });

    // A third, deliberately unconnected workspace lets the Joint Channel
    // settings form be exercised end-to-end. `isolation` is already an
    // active projection, so reusing it as an invite target can only produce
    // "already connected" and does not give reviewers a valid form path.
    let [jointInviteTargetServer] = await db
      .select()
      .from(servers)
      .where(eq(servers.slug, "joint-invite-target"))
      .limit(1);
    if (!jointInviteTargetServer) {
      [jointInviteTargetServer] = await db.insert(servers).values({
        name: "Invite Target Workspace",
        slug: "joint-invite-target",
        ownerId: user.id,
      }).returning();
      console.error("Created server: joint-invite-target");
    }

    // Keep one deliberately channel-empty workspace in the representative
    // matrix. It exercises workspace switching and empty-state rendering
    // without weakening the release-QA requirement for four independent,
    // non-storage workspaces.
    let [emptyStateServer] = await db
      .select()
      .from(servers)
      .where(eq(servers.slug, "empty-state"))
      .limit(1);
    if (!emptyStateServer) {
      [emptyStateServer] = await db.insert(servers).values({
        name: "Empty State Workspace",
        slug: "empty-state",
        ownerId: user.id,
      }).returning();
      console.error("Created server: empty-state");
    }
    await ensureServerMembership(emptyStateServer.id, user.id, "owner");
    await applyDevSeedOnboardingFixture(db, {
      userId: user.id,
      serverId: emptyStateServer.id,
      withOnboarding: false,
      now: new Date(),
    });

    // These three workspaces form the task #187 Joint Channel acceptance
    // fixture. Keep the fixture itself on Pro so opening either projection or
    // accepting the clean target invite exercises the product UI instead of
    // stopping at the billing gate. Billing tests own separate fixtures.
    for (const qaServer of [server, isolationServer, jointInviteTargetServer]) {
      if (qaServer.plan === "pro") continue;
      await db
        .update(servers)
        .set({ plan: "pro" })
        .where(eq(servers.id, qaServer.id));
      qaServer.plan = "pro";
    }

    await ensureServerMembership(jointInviteTargetServer.id, user.id, "owner");
    await ensureServerMembership(jointInviteTargetServer.id, adminUser.id, "admin");
    await ensureServerMembership(jointInviteTargetServer.id, memberUser.id, "member");
    for (const seededUser of [user, adminUser, memberUser]) {
      await applyDevSeedOnboardingFixture(db, {
        userId: seededUser.id,
        serverId: jointInviteTargetServer.id,
        withOnboarding: false,
        now: new Date(),
      });
    }
    const jointInviteTargetAllChannel = await ensureSeedChannel({
      serverId: jointInviteTargetServer.id,
      name: "all",
      description: "Accept the qa-joint invitation from this workspace.",
      type: "channel",
    });
    for (const seededUser of [user, adminUser, memberUser]) {
      await addHumanToChannel(jointInviteTargetAllChannel.id, seededUser.id);
    }

    // task #187 preview acceptance matrix. "Ordinary" is a joined standard
    // channel; "Public" is intentionally discoverable-but-not-joined for the
    // member account so the two standard-channel states are visibly distinct.
    const ordinaryChannel = await ensureSeedChannel({
      serverId: server.id,
      name: "qa-ordinary",
      description: "Joined standard channel for ordinary member and settings states.",
      type: "channel",
    });
    const publicChannel = await ensureSeedChannel({
      serverId: server.id,
      name: "qa-public",
      description: "Public discoverable channel; the member fixture starts outside it.",
      type: "channel",
    });
    const privateChannel = await ensureSeedChannel({
      serverId: server.id,
      name: "qa-private",
      description: "Private channel shared with the owner, admin, and member fixtures.",
      type: "private",
    });
    for (const seededUser of [user, adminUser, memberUser]) {
      await addHumanToChannel(ordinaryChannel.id, seededUser.id);
      await addHumanToChannel(privateChannel.id, seededUser.id);
    }
    for (const seededUser of [user, adminUser]) {
      await addHumanToChannel(publicChannel.id, seededUser.id);
    }
    for (const seededAgent of [agent, codexAgent, kimiAgent]) {
      await addAgentToChannel(ordinaryChannel.id, seededAgent.id);
      await addAgentToChannel(privateChannel.id, seededAgent.id);
    }
    await addAgentToChannel(publicChannel.id, codexAgent.id);
    await ensureMessage({
      channelId: ordinaryChannel.id,
      senderType: "user",
      senderId: memberUser.id,
      content: "Ordinary-channel fixture: member is already joined and can use normal channel actions.",
      createdAt: new Date(matrixNow - 6 * 60 * 1000),
    });
    await ensureMessage({
      channelId: publicChannel.id,
      senderType: "user",
      senderId: adminUser.id,
      content: "Public-channel fixture: discoverable to server members before they join.",
      createdAt: new Date(matrixNow - 5 * 60 * 1000),
    });
    await ensureMessage({
      channelId: privateChannel.id,
      senderType: "user",
      senderId: user.id,
      content: "Private-channel fixture: only explicitly added people can see this conversation.",
      createdAt: new Date(matrixNow - 4 * 60 * 1000),
    });

    const partnerAllChannel = await ensureSeedChannel({
      serverId: isolationServer.id,
      name: "all",
      description: "Partner workspace home channel.",
      type: "channel",
    });
    for (const seededUser of [user, adminUser, memberUser]) {
      await addHumanToChannel(partnerAllChannel.id, seededUser.id);
    }
    await addAgentToChannel(partnerAllChannel.id, isolationNoMachineAgent.id);

    let [jointStorageServer] = await db
      .select()
      .from(servers)
      .where(eq(servers.slug, "__joint_storage__"))
      .limit(1);
    if (!jointStorageServer) {
      [jointStorageServer] = await db.insert(servers).values({
        name: "Joint Storage Namespace",
        slug: "__joint_storage__",
        kind: "joint_storage",
        ownerId: user.id,
        plan: "founder",
        agentAllChannelGreetingEnabled: false,
      }).returning();
    }
    const jointStorageChannel = await ensureSeedChannel({
      serverId: jointStorageServer.id,
      name: "joint-storage-qa-preview",
      description: "Storage-only stream for the two preview projections.",
      type: "channel",
    });
    const hostJointChannel = await ensureSeedChannel({
      serverId: server.id,
      name: "qa-joint",
      description: "Joint channel projected into Dev and Partner workspaces.",
      type: "joint",
    });
    const partnerJointChannel = await ensureSeedChannel({
      serverId: isolationServer.id,
      name: "qa-joint",
      description: "Joint channel projected into Dev and Partner workspaces.",
      type: "joint",
    });
    let [jointChannel] = await db
      .select()
      .from(jointChannels)
      .where(eq(jointChannels.canonicalChannelId, jointStorageChannel.id))
      .limit(1);
    if (!jointChannel) {
      [jointChannel] = await db.insert(jointChannels).values({
        canonicalChannelId: jointStorageChannel.id,
        createdByServerId: server.id,
        createdByUserId: user.id,
      }).returning();
    }
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: jointChannel.id,
        serverId: server.id,
        localChannelId: hostJointChannel.id,
        role: "host",
        status: "active",
        joinedByUserId: user.id,
      },
      {
        jointChannelId: jointChannel.id,
        serverId: isolationServer.id,
        localChannelId: partnerJointChannel.id,
        role: "participant",
        status: "active",
        joinedByUserId: user.id,
      },
    ]).onConflictDoNothing();
    for (const seededUser of [user, adminUser, memberUser]) {
      await addHumanToChannel(hostJointChannel.id, seededUser.id);
      await addHumanToChannel(partnerJointChannel.id, seededUser.id);
    }
    await addAgentToChannel(hostJointChannel.id, codexAgent.id);
    await addAgentToChannel(partnerJointChannel.id, isolationNoMachineAgent.id);
    await ensureMessage({
      channelId: jointStorageChannel.id,
      senderType: "user",
      senderId: user.id,
      content: "Joint-channel fixture: this one canonical message is visible from both server projections.",
      createdAt: new Date(matrixNow - 3 * 60 * 1000),
    });

    let [archivedChannel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "archived-reference"), eq(channels.type, "channel")))
      .limit(1);
    if (!archivedChannel) {
      [archivedChannel] = await db.insert(channels).values({
        serverId: server.id,
        name: "archived-reference",
        description: "Seeded archived channel for read-only channel-state QA.",
        type: "channel",
        archivedAt: new Date(matrixNow - 20 * 60 * 1000),
        archivedByUserId: user.id,
      }).returning();
    } else {
      await db
        .update(channels)
        .set({
          description: "Seeded archived channel for read-only channel-state QA.",
          archivedAt: archivedChannel.archivedAt ?? new Date(matrixNow - 20 * 60 * 1000),
          archivedByUserId: archivedChannel.archivedByUserId ?? user.id,
        })
        .where(eq(channels.id, archivedChannel.id));
    }
    await addHumanToChannel(archivedChannel.id, user.id);
    await addHumanToChannel(archivedChannel.id, adminUser.id);
    await addAgentToChannel(archivedChannel.id, codexAgent.id);
    await ensureMessage({
      channelId: archivedChannel.id,
      senderType: "user",
      senderId: user.id,
      content: "Archived rollout notes remain available for reference.",
      createdAt: new Date(matrixNow - 21 * 60 * 1000),
    });

    console.error("Seeded QA matrix: owner/admin/member, ordinary/public/private/joint channels, two active projections, and one clean invite target");

    // 7. Seed messages for testing lazy load and plan history limits
    const [existingMsg] = await db
      .select()
      .from(messages)
      .where(eq(messages.channelId, channel.id))
      .limit(1);
    if (!existingMsg) {
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const senders = [
        { type: "user" as const, id: user.id },
        { type: "agent" as const, id: agent.id },
      ];
      const sampleMessages = [
        "Hey, how's it going?",
        "Working on the new feature",
        "Can you review my PR?",
        "Looks good to me!",
        "I found a bug in the login flow",
        "Let me check that",
        "Fixed it, pushing now",
        "Great work!",
        "Anyone free for a quick sync?",
        "Sure, let me finish this first",
        "The deploy went through successfully",
        "Nice, I'll verify on staging",
        "We need to update the docs too",
        "I'll handle that",
        "Thanks!",
      ];
      const msgValues = [];
      // Generate 150 messages spread over 45 days (some beyond 30-day free limit)
      for (let i = 0; i < 150; i++) {
        const daysAgo = Math.floor((i / 150) * 45); // 0-45 days ago
        const sender = senders[i % 2];
        const ts = new Date(now - daysAgo * DAY - Math.random() * DAY);
        msgValues.push({
          channelId: channel.id,
          senderType: sender.type,
          senderId: sender.id,
          content: sampleMessages[i % sampleMessages.length],
          searchText: buildSearchText(sampleMessages[i % sampleMessages.length]),
          createdAt: ts,
          updatedAt: ts,
        });
      }
      // Sort chronologically (oldest first) so seq order matches time
      msgValues.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      await db.insert(messages).values(msgValues);
      console.error(`Seeded 150 messages in #${channel.name} (spanning 45 days)`);
    } else {
      console.error(`Messages already exist in #${channel.name}, skipping seed`);
    }

    // 8. Seed thread-heavy scenarios for sidebar/thread panel coverage
    const dmChannel = await ensureDmChannel();
    const now = Date.now();
    const MINUTE = 60 * 1000;

    const generalUnreadParent = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: THREAD_SEED_CONTENT.generalUnreadParent,
      createdAt: new Date(now - 30 * MINUTE),
    });
    const generalUnreadThread = await ensureThreadChannel({
      parentMessageId: generalUnreadParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    await ensureThreadFollow(generalUnreadThread.id, generalUnreadParent.id, "authored");
    const generalUnreadReply1 = await ensureMessage({
      channelId: generalUnreadThread.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.generalUnreadReply1,
      createdAt: new Date(now - 29 * MINUTE),
    });
    const generalUnreadReply2 = await ensureMessage({
      channelId: generalUnreadThread.id,
      senderType: "user",
      senderId: user.id,
      content: THREAD_SEED_CONTENT.generalUnreadReply2,
      createdAt: new Date(now - 28 * MINUTE),
    });
    const generalUnreadReply3 = await ensureMessage({
      channelId: generalUnreadThread.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.generalUnreadReply3,
      createdAt: new Date(now - 27 * MINUTE),
    });
    await ensureUserReadCursor(generalUnreadThread.id, generalUnreadReply2.seq ?? 0);

    const generalReadParent = await ensureMessage({
      channelId: channel.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.generalReadParent,
      createdAt: new Date(now - 20 * MINUTE),
    });
    const generalReadThread = await ensureThreadChannel({
      parentMessageId: generalReadParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    const generalReadReply1 = await ensureMessage({
      channelId: generalReadThread.id,
      senderType: "user",
      senderId: user.id,
      content: THREAD_SEED_CONTENT.generalReadReply1,
      createdAt: new Date(now - 19 * MINUTE),
    });
    const generalReadReply2 = await ensureMessage({
      channelId: generalReadThread.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.generalReadReply2,
      createdAt: new Date(now - 18 * MINUTE),
    });
    await ensureThreadFollow(generalReadThread.id, generalReadParent.id, "replied");
    await ensureUserReadCursor(generalReadThread.id, generalReadReply2.seq ?? 0);

    await ensureMessage({
      channelId: dmChannel.id,
      senderType: "user",
      senderId: user.id,
      content: THREAD_SEED_CONTENT.dmIntro,
      createdAt: new Date(now - 12 * MINUTE),
    });
    const dmParent = await ensureMessage({
      channelId: dmChannel.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.dmParent,
      createdAt: new Date(now - 11 * MINUTE),
    });
    const dmThread = await ensureThreadChannel({
      parentMessageId: dmParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    const dmReply1 = await ensureMessage({
      channelId: dmThread.id,
      senderType: "user",
      senderId: user.id,
      content: THREAD_SEED_CONTENT.dmReply1,
      createdAt: new Date(now - 10 * MINUTE),
    });
    const dmReply2 = await ensureMessage({
      channelId: dmThread.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.dmReply2,
      createdAt: new Date(now - 9 * MINUTE),
    });
    await ensureThreadFollow(dmThread.id, dmParent.id, "replied");
    await ensureUserReadCursor(dmThread.id, dmReply2.seq ?? 0);

    // Extra threads for richer inbox
    const bugReportParent = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: THREAD_SEED_CONTENT.bugReportParent,
      createdAt: new Date(now - 50 * MINUTE),
    });
    const bugReportThread = await ensureThreadChannel({
      parentMessageId: bugReportParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    await ensureThreadFollow(bugReportThread.id, bugReportParent.id, "authored");
    await ensureMessage({ channelId: bugReportThread.id, senderType: "agent", senderId: agent.id, content: THREAD_SEED_CONTENT.bugReportReply1, createdAt: new Date(now - 49 * MINUTE) });
    await ensureMessage({ channelId: bugReportThread.id, senderType: "user", senderId: user.id, content: THREAD_SEED_CONTENT.bugReportReply2, createdAt: new Date(now - 48 * MINUTE) });
    const bugReportReply3 = await ensureMessage({ channelId: bugReportThread.id, senderType: "agent", senderId: agent.id, content: THREAD_SEED_CONTENT.bugReportReply3, createdAt: new Date(now - 47 * MINUTE) });
    await ensureUserReadCursor(bugReportThread.id, bugReportReply3.seq ?? 0);

    const designReviewParent = await ensureMessage({
      channelId: channel.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.designReviewParent,
      createdAt: new Date(now - 40 * MINUTE),
    });
    const designReviewThread = await ensureThreadChannel({
      parentMessageId: designReviewParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    await ensureThreadFollow(designReviewThread.id, designReviewParent.id, "replied");
    await ensureMessage({ channelId: designReviewThread.id, senderType: "user", senderId: user.id, content: THREAD_SEED_CONTENT.designReviewReply1, createdAt: new Date(now - 39 * MINUTE) });
    const designReviewReply2 = await ensureMessage({ channelId: designReviewThread.id, senderType: "agent", senderId: agent.id, content: THREAD_SEED_CONTENT.designReviewReply2, createdAt: new Date(now - 38 * MINUTE) });
    await ensureUserReadCursor(designReviewThread.id, (designReviewReply2.seq ?? 1) - 1);

    const deployParent = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: THREAD_SEED_CONTENT.deployParent,
      createdAt: new Date(now - 60 * MINUTE),
    });
    const deployThread = await ensureThreadChannel({
      parentMessageId: deployParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    await ensureThreadFollow(deployThread.id, deployParent.id, "authored");
    await ensureMessage({ channelId: deployThread.id, senderType: "agent", senderId: agent.id, content: THREAD_SEED_CONTENT.deployReply1, createdAt: new Date(now - 59 * MINUTE) });
    await ensureMessage({ channelId: deployThread.id, senderType: "user", senderId: user.id, content: THREAD_SEED_CONTENT.deployReply2, createdAt: new Date(now - 58 * MINUTE) });
    await ensureMessage({ channelId: deployThread.id, senderType: "agent", senderId: agent.id, content: THREAD_SEED_CONTENT.deployReply3, createdAt: new Date(now - 57 * MINUTE) });
    const deployReply4 = await ensureMessage({ channelId: deployThread.id, senderType: "user", senderId: user.id, content: THREAD_SEED_CONTENT.deployReply4, createdAt: new Date(now - 56 * MINUTE) });
    await ensureUserReadCursor(deployThread.id, deployReply4.seq ?? 0);

    const apiDiscussionParent = await ensureMessage({
      channelId: channel.id,
      senderType: "agent",
      senderId: agent.id,
      content: THREAD_SEED_CONTENT.apiDiscussionParent,
      createdAt: new Date(now - 70 * MINUTE),
    });
    const apiDiscussionThread = await ensureThreadChannel({
      parentMessageId: apiDiscussionParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    await ensureThreadFollow(apiDiscussionThread.id, apiDiscussionParent.id, "manual");
    const apiDiscussionReply1 = await ensureMessage({ channelId: apiDiscussionThread.id, senderType: "user", senderId: user.id, content: THREAD_SEED_CONTENT.apiDiscussionReply1, createdAt: new Date(now - 69 * MINUTE) });
    await ensureUserReadCursor(apiDiscussionThread.id, (apiDiscussionReply1.seq ?? 1) - 1);

    // Create a fresh latest #general host message so task acceptance data is
    // immediately visible without scrolling back through older fixtures.
    const taskHistoryHost = await ensureMessage({ channelId: channel.id, senderType: "user", senderId: user.id, content: "Task history acceptance fixture", createdAt: new Date(now) });

    // Create tasks linked to some thread parent messages
    const TASK1_TITLE = "Investigate and permanently fix sidebar flicker during rapid multi-channel switching workflows across desktop, mobile, keyboard navigation, unread markers, thread selection, persisted state, and release validation before shipping this reliability improvement";
    const TASK1_DESCRIPTION = "Investigate the sidebar flicker that appears during rapid channel switching.\n\nReproduce it across desktop and mobile widths, capture timing and affected state transitions, then document the root cause and the smallest safe fix. Check unread markers, thread selection, keyboard navigation, and persisted channel state after the change.\n\nEdge-case reference: https://example.invalid/debug/sidebar-switching/this-is-a-deliberately-long-unbroken-path-for-layout-testing-and-overflow-behavior\n\n请同时验证连续中文换行是否自然，并记录仍需产品评审的边界.";
    await db.insert(tasks).values({
      channelId: channel.id,
      taskNumber: 1,
      title: TASK1_TITLE,
      description: TASK1_DESCRIPTION,
      status: "in_progress",
      createdByType: "user",
      createdById: user.id,
      claimedByType: "agent",
      claimedById: agent.id,
      claimedAt: new Date(now - 45 * MINUTE),
      messageId: taskHistoryHost.id,
    }).onConflictDoUpdate({
      target: [tasks.channelId, tasks.taskNumber],
      set: {
        messageId: taskHistoryHost.id,
        title: TASK1_TITLE,
        description: TASK1_DESCRIPTION,
      },
    });

    // Give the task dialog a deterministic, non-empty history for visual and
    // acceptance testing. Keep this idempotent so repeated raftdev seeds do
    // not duplicate timeline entries.
    const [historyTask] = await db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, 1))).limit(1);
    if (historyTask) {
      const existingHistory = await db.select({ id: taskEvents.id }).from(taskEvents)
        .where(eq(taskEvents.taskId, historyTask.id)).limit(1);
      if (existingHistory.length > 0) await db.delete(taskEvents).where(eq(taskEvents.taskId, historyTask.id));
      {
        const eventBase = { taskId: historyTask.id, actorType: "user" as const, actorId: user.id };
        await db.insert(taskEvents).values([
          { ...eventBase, eventType: "created", payload: { taskNumber: 1, status: "todo", requiresResourceReceipt: false } },
          { ...eventBase, eventType: "status_changed", payload: { from: "todo", to: "in_progress" } },
          { ...eventBase, eventType: "assignee_changed", payload: { assigneeType: "agent", assigneeId: agent.id } },
          { ...eventBase, eventType: "status_changed", payload: { from: "in_progress", to: "in_review" } },
          { ...eventBase, eventType: "assignee_changed", payload: { assigneeType: "user", assigneeId: user.id, previousAssigneeType: "agent", previousAssigneeId: agent.id } },
          { ...eventBase, eventType: "status_changed", payload: { from: "in_review", to: "in_progress" } },
          { ...eventBase, eventType: "amended", payload: { revision: 1, changes: { title: { from: "Fix sidebar flicker", to: "Investigate sidebar flicker during rapid channel switching" }, description: { from: "Reproduce the issue", to: "Reproduce the issue across desktop and mobile layouts, recording timing, unread markers, thread selection, keyboard navigation, and persisted channel state." } } } },
          { ...eventBase, eventType: "amended", payload: { revision: 2, changes: { title: { from: "Investigate sidebar flicker during rapid channel switching", to: "Investigate and permanently fix sidebar flicker during rapid multi-channel switching workflows" }, description: { from: "Reproduce the issue across desktop and mobile layouts", to: "Reproduce across desktop and mobile widths, capture every affected state transition, document the root cause, and verify the smallest safe fix with product review." } } } },
          { ...eventBase, eventType: "amended", payload: { revision: 3, changes: { title: { from: "Investigate and permanently fix sidebar flicker during rapid multi-channel switching workflows", to: "Investigate and permanently fix sidebar flicker during rapid multi-channel switching workflows before release" }, description: { from: "Capture every affected state transition", to: "Capture timing and affected state transitions, then document the root cause and rollout checklist for the final release." } } } },
          { ...eventBase, eventType: "closed", payload: { from: "in_progress", to: "closed", forced: false } },
          { ...eventBase, eventType: "reopened", payload: { from: "closed", to: "in_progress", forced: false } },
          { ...eventBase, eventType: "resource_receipt_recorded", payload: { receipt: { object: "preview" }, expiryFollowupId: null } },
        ]);
      }
    }

    await db.insert(tasks).values({
      channelId: channel.id,
      taskNumber: 2,
      title: "Deploy v0.30.1 to staging",
      status: "done",
      createdByType: "user",
      createdById: user.id,
      claimedByType: "user",
      claimedById: user.id,
      claimedAt: new Date(now - 60 * MINUTE),
      completedAt: new Date(now - 55 * MINUTE),
      messageId: deployParent.id,
    }).onConflictDoNothing();

    await db.insert(tasks).values({
      channelId: channel.id,
      taskNumber: 3,
      title: "Design review: new settings panel layout",
      status: "in_review",
      createdByType: "agent",
      createdById: agent.id,
      claimedByType: "agent",
      claimedById: agent.id,
      claimedAt: new Date(now - 40 * MINUTE),
      messageId: designReviewParent.id,
    }).onConflictDoNothing();

    // Long-title and multi-status tasks for TaskCard clamp/layout testing
    const longTitleTasks = [
      { n: 4, title: "在 mobile 上翻聊天记录时出现严重的闪烁和卡顿问题，尤其是在 iPhone Safari/Chrome 上使用 momentum scroll 向上加载历史消息时，画面会跳动、元素会闪烁，严重影响使用体验，需要排查 Virtuoso prepend 补偿和 useLayoutEffect 同步 scrollTop 写入的相互作用", status: "in_progress" as const },
      { n: 5, title: "Investigate and fix the mobile scrollback flicker on iOS where the chat history list jumps and flashes during momentum scroll — root cause suspected to be synchronous scrollTop writes in a useLayoutEffect fighting WebKit's own scroll compensation, plus an overly-large increaseViewportBy value for narrow viewports", status: "todo" as const },
      { n: 6, title: "Refactor the TaskBoard column layout so that cards with very long multi-line titles don't push the status badge row below the fold and don't cause horizontal overflow on narrow viewports", status: "in_review" as const },
      { n: 7, title: "Short single-line title", status: "todo" as const },
      { n: 8, title: "A title that wraps onto exactly two lines because it is medium length and has several words", status: "in_progress" as const },
      { n: 9, title: "非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的中文标题用来测试 CJK 换行和行数裁剪行为", status: "done" as const },
    ];
    for (const t of longTitleTasks) {
      await db.insert(tasks).values({
        channelId: channel.id,
        taskNumber: t.n,
        title: t.title,
        status: t.status,
        createdByType: "user",
        createdById: user.id,
        claimedByType: t.status === "todo" ? null : "user",
        claimedById: t.status === "todo" ? null : user.id,
        claimedAt: t.status === "todo" ? null : new Date(now - 30 * MINUTE),
        completedAt: t.status === "done" ? new Date(now - 20 * MINUTE) : null,
        messageId: bugReportParent.id,
      }).onConflictDoNothing();
    }

    const messageTasks = [
      {
        taskNumber: 10,
        status: "todo" as const,
        content: "Check workspace member permissions",
        assignee: null,
      },
      {
        taskNumber: 11,
        status: "in_progress" as const,
        content: "Verify attachment preview behavior",
        assignee: { type: "agent" as const, id: codexAgent.id },
      },
      {
        taskNumber: 12,
        status: "in_review" as const,
        content: "Investigate the thread reminder wake issue",
        assignee: { type: "user" as const, id: adminUser.id },
      },
      {
        taskNumber: 13,
        status: "done" as const,
        content: "Confirm archived channel access behavior",
        assignee: { type: "agent" as const, id: agent.id },
      },
      {
        taskNumber: 14,
        status: "todo" as const,
        content: "请检查窄屏下较长任务标题的换行、裁剪和状态标记布局是否稳定",
        assignee: null,
      },
      {
        taskNumber: 15,
        status: "in_review" as const,
        content: "Align inline message chips to a consistent height.",
        assignee: { type: "agent" as const, id: agent.id },
      },
    ];
    let messageChipDemoTask = null as typeof messages.$inferSelect | null;
    for (let i = 0; i < messageTasks.length; i++) {
      const t = messageTasks[i];
      const taskMessage = await ensureTaskMessage({
        content: t.content,
        taskNumber: t.taskNumber,
        taskStatus: t.status,
        assignee: t.assignee,
        createdAt: new Date(now - (25 - i) * MINUTE),
      });
      if (t.taskNumber === 15) messageChipDemoTask = taskMessage;
    }

    const messageChipPermalinkTarget = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: "Review the permalink behavior for this message.",
      createdAt: new Date(now - 8 * MINUTE),
    });
    const messageChipThreadParent = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: "Does this thread permalink open the correct conversation?",
      createdAt: new Date(now - 7 * MINUTE),
    });
    const messageChipThread = await ensureThreadChannel({
      parentMessageId: messageChipThreadParent.id,
      participants: [
        { type: "user", id: user.id },
        { type: "agent", id: agent.id },
      ],
    });
    await ensureThreadFollow(messageChipThread.id, messageChipThreadParent.id, "authored");
    await ensureMessage({
      channelId: messageChipThread.id,
      senderType: "agent",
      senderId: agent.id,
      content: "Confirmed. It opens the expected reply.",
      createdAt: new Date(now - 6 * MINUTE),
    });
    const messageChipThreadRef = messageChipThreadParent.id.slice(0, 8);
    const messageChipPermalink =
      `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=${messageChipPermalinkTarget.id}`;
    const messageChipDemoContent = [
      "**Please review message references in the release notes.**",
      "",
      "Self mention: @Developer should be the attention chip. Normal mentions like @Member and @assistant should stay text-link style.",
      "",
      `Refs in one line: #${channel.name} · task #15 · #${channel.name}:${messageChipThreadRef} · [permalink](${messageChipPermalink})`,
      "",
      `> Quote row repeats the same shapes: @Developer #${channel.name} task #15 #${channel.name}:${messageChipThreadRef} [permalink](${messageChipPermalink})`,
      "",
      "- List row with channel/task/thread/permalink chips should keep the same line height.",
      "- Reaction pill below should remain the current production reaction style, not the theme POC reaction style.",
      "",
      `Code should not become chips: \`@Developer #${channel.name} task #15 #${channel.name}:${messageChipThreadRef}\``,
    ].join("\n");
    const messageChipDemo = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: messageChipDemoContent,
      createdAt: new Date(now - 5 * MINUTE),
    });
    await ensureMessageReaction({
      messageId: messageChipDemo.id,
      reactorType: "user",
      reactorId: user.id,
      emoji: "👍",
    });
    await ensureMessageReaction({
      messageId: messageChipDemo.id,
      reactorType: "agent",
      reactorId: agent.id,
      emoji: "👀",
    });

    await db
      .update(threadFollows)
      .set({ doneAt: new Date(now - 16 * MINUTE) })
      .where(and(
        eq(threadFollows.threadChannelId, generalReadThread.id),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, user.id),
      ));

    const unfollowedParent = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: "I can still open this thread from its parent, but it no longer appears in my followed inbox.",
      createdAt: new Date(now - 34 * MINUTE),
    });
    const unfollowedThread = await ensureThreadChannel({
      parentMessageId: unfollowedParent.id,
      participants: [{ type: "agent", id: agent.id }],
    });
    await ensureMessage({
      channelId: unfollowedThread.id,
      senderType: "agent",
      senderId: agent.id,
      content: "Parent membership still grants read and post access here.",
      createdAt: new Date(now - 33 * MINUTE),
    });
    await db
      .delete(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, unfollowedThread.id),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, user.id),
      ));

    await db.insert(agentChannelReadCursors).values({
      agentId: codexAgent.id,
      channelId: generalUnreadThread.id,
      lastReadSeq: generalUnreadReply2.seq ?? 0,
    }).onConflictDoNothing();

    const upsertReminder = async (opts: typeof reminders.$inferInsert) => {
      const [existing] = await db
        .select({ id: reminders.id })
        .from(reminders)
        .where(and(eq(reminders.ownerAgentId, opts.ownerAgentId), eq(reminders.title, opts.title)))
        .limit(1);
      if (existing) {
        await db.update(reminders).set(opts).where(eq(reminders.id, existing.id));
      } else {
        await db.insert(reminders).values(opts);
      }
    };

    await upsertReminder({
      serverId: server.id,
      ownerAgentId: codexAgent.id,
      msgId: generalUnreadReply1.id,
      title: "Seed fired thread reminder",
      fireAt: new Date(now - 4 * MINUTE),
      payload: { target: "thread", seed: true },
      status: "fired",
      version: 2,
      firedAt: new Date(now - 3 * MINUTE),
      createdByType: "agent",
      createdById: codexAgent.id,
      createdAt: new Date(now - 12 * MINUTE),
      updatedAt: new Date(now - 3 * MINUTE),
    });
    await upsertReminder({
      serverId: server.id,
      ownerAgentId: agent.id,
      msgId: deployParent.id,
      title: "Seed scheduled channel reminder",
      fireAt: new Date(now + 30 * MINUTE),
      payload: { target: "channel", seed: true },
      status: "scheduled",
      version: 1,
      createdByType: "human",
      createdById: user.id,
      createdAt: new Date(now - 2 * MINUTE),
      updatedAt: new Date(now - 2 * MINUTE),
    });

    const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
    const jpegBytes = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z", "base64");
    const textBytes = Buffer.from("Seed attachment text file for slockdev download smoke.\n", "utf-8");
    const threadContextBytes = Buffer.from(
      "Seed thread attachment for Channel Files tab smoke. This file lives on a thread reply but should appear in the parent channel Files view with a #thread ref.\n",
      "utf-8",
    );
    // Long filename markdown so the attachment-card filename truncation
    // behavior is visible in dev without uploading a file. tygg requested
    // this seed entry so anyone running ./raftdev can sanity-check the
    // truncate / preview-modal label badge layout (#proj-uiux task #133).
    const longFilenameMarkdownBytes = Buffer.from(
      "# Seed: long filename truncation\n\nThis markdown attachment exists in the seed data so engineers running slockdev can see how long filenames truncate inside the 176px attachment card and how the preview-modal header reserves a slot for the kind badge on narrow viewports.\n\nReported by @tygg / @Nana7mi via #proj-uiux task #133. Fixed in PR #1456.\n\n## What to look for\n\n- The attachment card below the channel message clips the filename with an ellipsis and stays at 176px wide.\n- Clicking the card opens the markdown preview modal — at any viewport width the **MARKDOWN PREVIEW** badge stays visible while the filename truncates.\n",
      "utf-8",
    );
    const attachmentMessage = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: "PNG, JPEG, and text files are attached for review.",
      createdAt: new Date(now - 15 * MINUTE),
    });
    await ensureSeedAttachment({
      messageId: attachmentMessage.id,
      channelId: channel.id,
      uploaderType: "user",
      uploaderId: user.id,
      filename: "seed-pixel.png",
      mimeType: "image/png",
      bytes: pngBytes,
      width: 1,
      height: 1,
    });
    await ensureSeedAttachment({
      messageId: attachmentMessage.id,
      channelId: channel.id,
      uploaderType: "agent",
      uploaderId: agent.id,
      filename: "seed-photo.jpg",
      mimeType: "image/jpeg",
      bytes: jpegBytes,
      width: 1,
      height: 1,
    });
    await ensureSeedAttachment({
      messageId: attachmentMessage.id,
      channelId: channel.id,
      uploaderType: "user",
      uploaderId: user.id,
      filename: "seed-notes.txt",
      mimeType: "text/plain",
      bytes: textBytes,
    });

    // Separate message so the long-filename markdown chip is the sole
    // attachment in its bubble — easier to spot truncation behavior.
    const longFilenameMessage = await ensureMessage({
      channelId: channel.id,
      senderType: "user",
      senderId: user.id,
      content: "Please review the attached Markdown document with the long filename.",
      createdAt: new Date(now - 14 * MINUTE),
    });
    await ensureSeedAttachment({
      messageId: longFilenameMessage.id,
      channelId: channel.id,
      uploaderType: "user",
      uploaderId: user.id,
      filename:
        "seed-this-is-an-extremely-long-markdown-filename-used-to-verify-attachment-preview-card-truncation-behavior-and-modal-header-label-layout.md",
      mimeType: "text/markdown",
      bytes: longFilenameMarkdownBytes,
    });
    await ensureSeedAttachment({
      messageId: generalReadReply2.id,
      channelId: generalReadThread.id,
      uploaderType: "agent",
      uploaderId: agent.id,
      filename: "seed-thread-context.txt",
      mimeType: "text/plain",
      bytes: threadContextBytes,
    });

    console.error("Seeded thread scenarios: 3 original + 4 extra threads for rich inbox + 3 tasks + 6 long-title tasks");

    // 8b. Bulk-generate extra threads for Threads inbox Load More testing
    const bulkThreadTopics = [
      "Rate limiting strategy for the public API — should we do token bucket or sliding window?",
      "The search indexer is lagging behind by ~10 seconds during peak hours. Need to investigate.",
      "Proposal: switch from REST to tRPC for internal service calls. Thoughts?",
      "CSS grid vs flexbox for the new dashboard layout — grid gives us better alignment but flexbox is simpler.",
      "Memory leak in the daemon process after 48 hours — heap snapshot shows detached DOM nodes.",
      "Should we add E2E tests for the auth flow? Current unit tests don't catch the refresh token race.",
      "The WebSocket reconnection logic needs a jitter factor to avoid thundering herd on server restart.",
      "Thinking about adding keyboard shortcuts — Cmd+K for search, Cmd+/ for threads. Opinions?",
      "Database migration failed on staging because of a NOT NULL column without a default value.",
      "Agent context window management: should we summarize or truncate when hitting the limit?",
      "The avatar upload is accepting files > 5MB. Need to add client-side validation.",
      "Feature flag system: should we use LaunchDarkly or build a simple one in-house?",
      "The notification sound is too aggressive. Can we add a softer option or let users pick?",
      "CI is taking 8 minutes. Most of the time is in the Docker build step — can we cache better?",
      "Accessibility audit: tab navigation is broken in the settings panel and modal dialogs.",
      "Dark mode support: the brutal design system makes this tricky. Bold borders need to invert.",
      "Should we migrate from Zustand to Jotai? Jotai's atom model might be better for our store structure.",
      "The invite link system needs rate limiting. Someone could enumerate valid invite codes.",
      "Performance: the message list re-renders when any agent activity changes. Need to fix selectors.",
      "Documentation: we should auto-generate API docs from the route definitions. Maybe use Swagger.",
    ];
    let bulkThreadCount = 0;
    for (let i = 0; i < bulkThreadTopics.length; i++) {
      const topic = bulkThreadTopics[i];
      const sender = i % 2 === 0
        ? { type: "user" as const, id: user.id }
        : { type: "agent" as const, id: agent.id };
      const responder = i % 2 === 0
        ? { type: "agent" as const, id: agent.id }
        : { type: "user" as const, id: user.id };
      const baseTime = now - (80 + i * 5) * MINUTE;

      const parent = await ensureMessage({
        channelId: channel.id,
        senderType: sender.type,
        senderId: sender.id,
        content: topic,
        createdAt: new Date(baseTime),
      });
      const thread = await ensureThreadChannel({
        parentMessageId: parent.id,
        participants: [
          { type: "user", id: user.id },
          { type: "agent", id: agent.id },
        ],
      });
      await ensureThreadFollow(thread.id, parent.id, i % 3 === 0 ? "authored" : "replied");
      // Add 1-3 replies
      const replyCount = (i % 3) + 1;
      let lastReply = parent;
      for (let r = 0; r < replyCount; r++) {
        const replySender = r % 2 === 0 ? responder : sender;
        lastReply = await ensureMessage({
          channelId: thread.id,
          senderType: replySender.type,
          senderId: replySender.id,
          content: `Reply ${r + 1} to: ${topic.slice(0, 50)}...`,
          createdAt: new Date(baseTime + (r + 1) * MINUTE),
        });
      }
      // Mark some as read, some as unread
      if (i % 3 !== 0) {
        await ensureUserReadCursor(thread.id, lastReply.seq ?? 0);
      } else {
        // Leave unread — or partially read
        if (replyCount > 1) {
          await ensureUserReadCursor(thread.id, (lastReply.seq ?? 1) - 1);
        }
      }
      bulkThreadCount++;
    }
    console.error(`Seeded ${bulkThreadCount} bulk threads for Load More testing`);

    // The production Activity projector is notification-fact driven. Direct
    // seed inserts intentionally bypass the message service, so establish one
    // canonical fact per seeded user target from its latest delivered message.
    // This is visibility evidence, not a historical backfill: older messages
    // retain the v3_3 legacy fallback for unread arithmetic, while a channel
    // membership without a fact remains intentionally absent from Activity.
    const ensureSeedVisibilityFact = async (target: {
      serverId: string;
      sourceChannelId: string;
      kind: "channel" | "dm" | "thread";
    }) => {
      const [latest] = await db
        .select({
          id: messages.id,
          seq: messages.seq,
          senderType: messages.senderType,
          senderId: messages.senderId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.channelId, target.sourceChannelId))
        .orderBy(desc(messages.seq))
        .limit(1);
      if (!latest) return;
      await db.insert(inboxNotificationFacts).values({
        receiverType: "user",
        receiverId: user.id,
        serverId: target.serverId,
        kind: target.kind,
        sourceChannelId: target.sourceChannelId,
        messageId: latest.id,
        messageSeq: latest.seq,
        activityAt: latest.createdAt,
        personalMention: false,
        unreadEligible: !(latest.senderType === "user" && latest.senderId === user.id),
      }).onConflictDoNothing();
    };

    const seedChatTargets = await db
      .select({
        serverId: channels.serverId,
        sourceChannelId: channels.id,
        type: channels.type,
      })
      .from(channels)
      .innerJoin(channelHumans, and(
        eq(channelHumans.channelId, channels.id),
        eq(channelHumans.userId, user.id),
      ));
    for (const target of seedChatTargets) {
      if (target.type === "thread") continue;
      await ensureSeedVisibilityFact({
        serverId: target.serverId,
        sourceChannelId: target.sourceChannelId,
        kind: target.type === "dm" ? "dm" : "channel",
      });
    }

    const seedThreadTargets = await db
      .select({
        serverId: channels.serverId,
        sourceChannelId: channels.id,
      })
      .from(threadFollows)
      .innerJoin(channels, eq(channels.id, threadFollows.threadChannelId))
      .where(and(
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, user.id),
        isNull(threadFollows.doneAt),
        isNull(threadFollows.unfollowedAt),
      ));
    for (const target of seedThreadTargets) {
      await ensureSeedVisibilityFact({ ...target, kind: "thread" });
    }

    // 9. Seed saved messages for testing the Saved panel (need 25+ to test Load More)
    // Grab 30 channel messages from #general to bulk-save
    const generalMsgs = await db.select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.channelId, channel.id))
      .orderBy(desc(messages.createdAt))
      .limit(30);

    const savedMessages: { messageId: string; savedAt: Date }[] = [
      // 20 channel messages from #general (saved at staggered times)
      ...generalMsgs.map((m, i) => ({
        messageId: m.id,
        savedAt: new Date(now - (25 - i) * MINUTE),
      })),
      // Thread replies and parents for variety
      { messageId: generalUnreadParent.id, savedAt: new Date(now - 5 * MINUTE) },
      { messageId: generalUnreadReply1.id, savedAt: new Date(now - 4 * MINUTE) },
      { messageId: dmReply2.id, savedAt: new Date(now - 3 * MINUTE) },
      { messageId: bugReportParent.id, savedAt: new Date(now - 2 * MINUTE) },
      { messageId: designReviewReply2.id, savedAt: new Date(now - 1 * MINUTE) },
    ];
    // Deduplicate by messageId (some thread parents may also be in general msgs)
    const seen = new Set<string>();
    const uniqueSaved = savedMessages.filter((s) => {
      if (seen.has(s.messageId)) return false;
      seen.add(s.messageId);
      return true;
    });
    let savedCount = 0;
    for (const s of uniqueSaved) {
      const result = await db.insert(userSaved).values({
        userId: user.id,
        messageId: s.messageId,
        serverId: server.id,
        createdAt: s.savedAt,
      }).onConflictDoNothing();
      if (result.rowCount && result.rowCount > 0) savedCount++;
    }
    if (savedCount > 0) {
      console.error(`Seeded ${savedCount} saved messages (${uniqueSaved.length} total)`);
    } else {
      console.error("Saved messages already exist, skipping");
    }

    // 10. Seed a demo announcement (account-level popup)
    const demoAnnouncementTitle = "Welcome to Slock";
    const [existingAnnouncement] = await db
      .select()
      .from(announcements)
      .where(eq(announcements.title, demoAnnouncementTitle))
      .limit(1);
    if (!existingAnnouncement) {
      await db.insert(announcements).values({
        title: demoAnnouncementTitle,
        pages: [
          {
            title: "Hello from Slock",
            body: "This is an **account-level** popup. It follows you across every server you belong to — it's not tied to a specific workspace.\n\nClick **Next** to see how paging works.",
          },
          {
            title: "What this is for",
            body: "Use announcements to share:\n\n- Product updates & new features\n- Scheduled maintenance windows\n- Policy or terms-of-service changes\n- Onboarding hints\n\nMarkdown is supported, including [links](https://slock.ai) and `inline code`.",
          },
          {
            title: "How dismissal works",
            body: "Once you click **OK**, this announcement will not appear again — not after refresh, not after logging in on another device.\n\nWhen a new announcement is published, it arrives in real time without needing to reload.",
          },
        ],
      });
      console.error(`Seeded demo announcement: ${demoAnnouncementTitle}`);
    } else {
      console.error(`Announcement already exists: ${demoAnnouncementTitle}`);
    }

    const messagesMissingSearchText = await db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(isNull(messages.searchText));
    for (const message of messagesMissingSearchText) {
      await db
        .update(messages)
        .set({ searchText: buildSearchText(message.content) })
        .where(eq(messages.id, message.id));
    }
    if (messagesMissingSearchText.length > 0) {
      console.error(`Backfilled search_text for ${messagesMissingSearchText.length} existing messages`);
    }

    // 11. Seed feature flags needed for dev/preview environments
    const devFeatureFlags = [
      { key: "onboarding_opener_v2", description: "Enable onboarding opener v2 flow", randomizationUnit: "server" as const },
      { key: "onboarding_owner_wizard_v0", description: "Enable owner onboarding wizard", randomizationUnit: "server" as const },
      { key: "attachment_comments_v0", description: "Enable attachment comments panel", randomizationUnit: "server" as const },
      { key: "topbar_overflow_v0", description: "Enable channel/thread topbar details surfaces", randomizationUnit: "server" as const },
    ];
    for (const flag of devFeatureFlags) {
      const [existing] = await db.select().from(featureFlags).where(eq(featureFlags.key, flag.key)).limit(1);
      if (!existing) {
        await db.insert(featureFlags).values({
          key: flag.key,
          description: flag.description,
          enabled: true,
          killSwitch: false,
          randomizationUnit: flag.randomizationUnit,
          defaultEnabled: true,
          salt: flag.key,
        });
        console.error(`Seeded feature flag: ${flag.key}`);
      }
    }

    // Exercise the durable generic App-config surface rather than letting a
    // release-QA database represent only the built-in manifest defaults.
    await db.insert(rapAppConfigs).values({
      serverId: server.id,
      appId: "system.reminder",
      subjectAgentId: agent.id,
      overrides: {},
      revision: 1,
    }).onConflictDoNothing();
    console.error("Seeded RAP App config: system.reminder");

    // Output credentials
    const output = {
      user: {
        id: user.id,
        email: SEED_USER_EMAIL,
        password: SEED_USER_PASSWORD,
        name: SEED_USER_NAME,
      },
      accounts: {
        owner: { id: user.id, email: SEED_USER_EMAIL, password: SEED_USER_PASSWORD, role: "owner" },
        admin: { id: adminUser.id, email: adminUser.email, password: SEED_USER_PASSWORD, role: "admin" },
        member: { id: memberUser.id, email: memberUser.email, password: SEED_USER_PASSWORD, role: "member" },
      },
      server: {
        id: server.id,
        name: SEED_SERVER_NAME,
        slug: SEED_SERVER_SLUG,
      },
      servers: {
        primary: { id: server.id, name: server.name, slug: server.slug },
        partner: { id: isolationServer.id, name: isolationServer.name, slug: isolationServer.slug },
        inviteTarget: {
          id: jointInviteTargetServer.id,
          name: jointInviteTargetServer.name,
          slug: jointInviteTargetServer.slug,
        },
        emptyState: {
          id: emptyStateServer.id,
          name: emptyStateServer.name,
          slug: emptyStateServer.slug,
        },
      },
      machine: {
        id: machine.id,
        name: SEED_MACHINE_NAME,
        apiKey: machineApiKey,
      },
      agent: {
        id: agent.id,
        name: SEED_AGENT_NAME,
      },
      channel: {
        id: channel.id,
        name: SEED_CHANNEL_NAME,
      },
      qaChannels: {
        ordinary: { id: ordinaryChannel.id, serverSlug: server.slug, name: ordinaryChannel.name },
        public: { id: publicChannel.id, serverSlug: server.slug, name: publicChannel.name },
        private: { id: privateChannel.id, serverSlug: server.slug, name: privateChannel.name },
        jointHost: { id: hostJointChannel.id, serverSlug: server.slug, name: hostJointChannel.name },
        jointPartner: { id: partnerJointChannel.id, serverSlug: isolationServer.slug, name: partnerJointChannel.name },
      },
      dmChannel: {
        id: dmChannel.id,
        name: SEED_DM_CHANNEL_NAME,
      },
      threads: {
        generalUnread: {
          parentMessageId: generalUnreadParent.id,
          threadChannelId: generalUnreadThread.id,
          lastReadSeq: generalUnreadReply2.seq,
          latestReplySeq: generalUnreadReply3.seq,
        },
        generalRead: {
          parentMessageId: generalReadParent.id,
          threadChannelId: generalReadThread.id,
          lastReadSeq: generalReadReply2.seq,
        },
        dmThread: {
          parentMessageId: dmParent.id,
          threadChannelId: dmThread.id,
          lastReadSeq: dmReply2.seq,
          firstReplySeq: dmReply1.seq,
        },
      },
      messageChipDemo: {
        messageId: messageChipDemo.id,
        taskMessageId: messageChipDemoTask?.id ?? null,
        taskNumber: messageChipDemoTask?.taskNumber ?? 15,
        threadParentMessageId: messageChipThreadParent.id,
        threadRef: `#${channel.name}:${messageChipThreadRef}`,
      },
    };

    const json = JSON.stringify(output, null, 2);
    if (outputPath) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outputPath, json, "utf-8");
      console.error(`Credentials written to ${outputPath}`);
    } else {
      console.log(json);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
