#!/usr/bin/env -S node --import tsx
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
import argon2 from "argon2";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import {
  agents,
  channelHumans,
  channels,
  machines,
  serverMembers,
  servers,
  users,
} from "../src/db/schema.js";
import {
  extractApiKeyFingerprint,
  extractApiKeyPrefix,
} from "../src/services/machineService.js";

type Scenario = "matrix" | "add-computer" | "offline-computer" | "runtime-ready" | "community-gated";

interface SeedData {
  user: { email: string; password: string };
  server: { id: string; slug?: string };
  machine: { id: string };
}

interface Options {
  scenario: Scenario;
  serverUrl: string;
  webUrl: string;
  seedFile: string;
}

const SCENARIOS: Scenario[] = ["matrix", "add-computer", "offline-computer", "runtime-ready", "community-gated"];

function usage(): never {
  console.error(
    "Usage: ./raftdev script onboarding-scenarios --env <name> --scenario <matrix|add-computer|offline-computer|runtime-ready|community-gated>",
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  let scenario: Scenario = "matrix";
  let serverUrl = "";
  let webUrl = "";
  let seedFile = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--scenario": {
        const value = argv[index + 1] as Scenario | undefined;
        if (!value || !SCENARIOS.includes(value)) {
          throw new Error(`Unknown scenario: ${value ?? ""}`);
        }
        scenario = value;
        index += 1;
        break;
      }
      case "--server-url":
        serverUrl = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--web-url":
        webUrl = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--seed-file":
        seedFile = argv[index + 1] ?? "";
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!serverUrl || !webUrl || !seedFile) usage();
  return { scenario, serverUrl, webUrl, seedFile };
}

async function readSeedFile(seedFile: string): Promise<SeedData> {
  const raw = await readFile(seedFile, "utf8");
  return JSON.parse(raw) as SeedData;
}

function scenarioUrl(webUrl: string, slug: string): string {
  return `${webUrl.replace(/\/$/, "")}/s/${slug}`;
}

function randomMachineApiKey(): string {
  return `sk_machine_${randomBytes(32).toString("hex")}`;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; run through ./raftdev script onboarding-scenarios");
  }

  const options = parseArgs(process.argv.slice(2));
  const seed = await readSeedFile(options.seedFile);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    const [owner] = await db.select().from(users).where(eq(users.email, seed.user.email)).limit(1);
    if (!owner) throw new Error(`Seed user not found: ${seed.user.email}`);

    await db.update(users).set({
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
      updatedAt: new Date(),
    }).where(eq(users.id, owner.id));

    const prepared: Array<{ label: string; slug: string; expected: string; note?: string }> = [];

    async function ensureChannel(serverId: string, name: string, description: string) {
      let [channel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.serverId, serverId), eq(channels.name, name), eq(channels.type, "channel"), isNull(channels.deletedAt)))
        .limit(1);
      if (!channel) {
        [channel] = await db.insert(channels).values({
          serverId,
          name,
          description,
          type: "channel",
        }).returning();
      }
      await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id }).onConflictDoNothing();
      return channel;
    }

    async function resetMemberWizardState(serverId: string) {
      await db.update(serverMembers).set({
        setupModalReminderOptOut: false,
        dismissedAddComputerStepAt: null,
        dismissedCreateAgentStepAt: null,
        dismissedInviteStepAt: null,
        dismissedCommunityStepAt: null,
        dismissedNotificationStepAt: null,
        onboardingWizardCurrentStep: null,
        onboardingDmSentAt: null,
        onboardingDmSentByAgentId: null,
        onboardingOwnerOpenerV2SentAt: null,
        onboardingOwnerOpenerV2SentByAgentId: null,
        onboardingOwnerOpenerV2MessageIds: [],
        onboardingOwnerOpenerV2Version: null,
        onboardingOwnerOpenerV2Topics: [],
        crossChannelHintShownAt: null,
      }).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, owner.id)));
    }

    async function ensureScenarioServer(input: { slug: string; name: string }) {
      let [server] = await db
        .select()
        .from(servers)
        .where(and(eq(servers.slug, input.slug), isNull(servers.deletedAt)))
        .limit(1);
      if (!server) {
        [server] = await db.insert(servers).values({
          name: input.name,
          slug: input.slug,
          ownerId: owner.id,
          onboardingAgentId: null,
          agentAllChannelGreetingEnabled: false,
        }).returning();
      } else {
        [server] = await db.update(servers).set({
          name: input.name,
          ownerId: owner.id,
          onboardingAgentId: null,
          agentAllChannelGreetingEnabled: false,
          updatedAt: new Date(),
        }).where(eq(servers.id, server.id)).returning();
      }

      await db.insert(serverMembers).values({
        serverId: server.id,
        userId: owner.id,
        role: "owner",
      }).onConflictDoNothing();
      await resetMemberWizardState(server.id);
      await ensureChannel(server.id, "all", "General channel for onboarding preview checks");
      return server;
    }

    async function clearScenarioMachinesAndAgents(serverId: string) {
      await db.update(agents).set({
        status: "inactive",
        deletedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
      await db.delete(machines).where(eq(machines.serverId, serverId));
      await db.update(servers).set({ onboardingAgentId: null, updatedAt: new Date() }).where(eq(servers.id, serverId));
    }

    async function ensureOfflineMachine(serverId: string) {
      const apiKey = randomMachineApiKey();
      const apiKeyHash = await argon2.hash(apiKey);
      await db.insert(machines).values({
        serverId,
        userId: owner.id,
        name: "preview-offline-computer",
        description: "Offline Computer for onboarding failure preview.",
        apiKeyHash,
        apiKeyPrefix: extractApiKeyPrefix(apiKey),
        apiKeyFingerprint: extractApiKeyFingerprint(apiKey),
        runtimes: ["codex"],
        hostname: "preview-offline.local",
        os: "darwin",
        daemonVersion: "0.72.0",
        lastHeartbeat: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
    }

    async function prepareAddComputer() {
      const server = await ensureScenarioServer({
        slug: "onboarding-add-computer",
        name: "Onboarding Preview - No Computer",
      });
      await clearScenarioMachinesAndAgents(server.id);
      prepared.push({
        label: "add-computer",
        slug: server.slug,
        expected: "ADD A COMPUTER",
      });
    }

    async function prepareOfflineComputer() {
      const server = await ensureScenarioServer({
        slug: "onboarding-offline-computer",
        name: "Onboarding Preview - Offline Computer",
      });
      await clearScenarioMachinesAndAgents(server.id);
      await ensureOfflineMachine(server.id);
      prepared.push({
        label: "offline-computer",
        slug: server.slug,
        expected: "DETECT RUNTIME with offline-computer copy",
      });
    }

    async function prepareCommunityGated() {
      const server = await ensureScenarioServer({
        slug: "community",
        name: "Community Preview - Wizard Gated",
      });
      await clearScenarioMachinesAndAgents(server.id);
      prepared.push({
        label: "community-gated",
        slug: server.slug,
        expected: "no owner onboarding wizard",
        note: "Uses the server-side community slug hard gate from #4212.",
      });
    }

    async function prepareRuntimeReady() {
      const [server] = await db.select().from(servers).where(eq(servers.id, seed.server.id)).limit(1);
      if (!server) throw new Error(`Seed server not found: ${seed.server.id}`);
      await resetMemberWizardState(server.id);
      await db.update(agents).set({
        status: "inactive",
        deletedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(agents.serverId, server.id), isNull(agents.deletedAt)));
      await db.update(servers).set({ onboardingAgentId: null, updatedAt: new Date() }).where(eq(servers.id, server.id));
      prepared.push({
        label: "runtime-ready",
        slug: server.slug,
        expected: "YOUR ONBOARDING AGENT when the raftdev daemon is online and reports a supported runtime",
        note: "This scenario intentionally uses the live seeded raftdev daemon; if the daemon is stopped it will fall back to DETECT RUNTIME.",
      });
    }

    if (options.scenario === "matrix" || options.scenario === "add-computer") await prepareAddComputer();
    if (options.scenario === "matrix" || options.scenario === "offline-computer") await prepareOfflineComputer();
    if (options.scenario === "matrix" || options.scenario === "runtime-ready") await prepareRuntimeReady();
    if (options.scenario === "matrix" || options.scenario === "community-gated") await prepareCommunityGated();

    console.log("Onboarding preview scenarios prepared.");
    console.log(`Login: ${seed.user.email} / ${seed.user.password}`);
    console.log(`API: ${options.serverUrl}`);
    for (const item of prepared) {
      console.log(`- ${item.label}: ${scenarioUrl(options.webUrl, item.slug)}`);
      console.log(`  expected: ${item.expected}`);
      if (item.note) console.log(`  note: ${item.note}`);
    }
    console.log("");
    console.log("Switch scenarios by rerunning this command with --scenario <name>; use ./raftdev seed <env> to restore the default seed data.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
