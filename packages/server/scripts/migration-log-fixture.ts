#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Agent Migration Log fixture: fills the seeded server with computers, agents
 * and three weeks of agent moves, so the owner/admin page at
 * /s/<slug>/migrations shows realistic data instead of its empty state.
 *
 *   ./raftdev script migration-log-fixture --env <name>
 *
 * For the seeded server and owner in the environment's seed file it:
 *   - upserts 12 computers (a machines row plus its active computers row, as
 *     `raft-computer setup` leaves them), keyed by name;
 *   - upserts 10 agents, keyed by name, each assigned to the computer its last
 *     completed move ended on;
 *   - replaces the fixture's ~60 agent_migrations rows (support_ref
 *     mig_fixture_*): completed moves, failed ones (too large / network), a few
 *     canceled ones and one to Raft hosted.
 *
 * Re-running converges to the same state; nothing else on the server is touched.
 * Moves are historical rows: their receipt DMs are not created, so the
 * completed-receipt trigger is disabled around the inserts (as the log API test
 * does), inside one transaction.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import argon2 from "argon2";
import pg from "pg";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import type { AgentMigrationTransferSummary } from "@botiverse/raft-shared";
import { getDb, initDatabase } from "../src/db/index";
import { agentMigrations, agents, computers, machines, serverAgentMembers, servers } from "../src/db/schema";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SUPPORT_REF_PREFIX = "mig_fixture_";
const RECEIPT_TRIGGER = "agent_migration_completed_receipt_required";
const TOO_LARGE_MESSAGE = "transferSummary.includedBytes: Number must be less than or equal to 10737418240";

type ComputerSpec = { name: string; os: string; deviceClass: string | null; hostProvider: string | null };

const COMPUTERS: ComputerSpec[] = [
  ...["hetzner-ex63-3", "hetzner-ex63-4", "hetzner-ex63-5", "hetzner-ex63-6", "hetzner-ex63-7"]
    .map((name) => ({ name, os: "linux", deviceClass: "server", hostProvider: "hetzner" })),
  // DEVICE_CLASSES has no single-board class; "mini" is the closest small box.
  ...["armbian-1", "armbian-lab", "armbian-kitchen", "armbian-den"]
    .map((name) => ({ name, os: "linux", deviceClass: "mini", hostProvider: null })),
  { name: "Alices-MacBook-Air.local", os: "darwin", deviceClass: "laptop", hostProvider: null },
  { name: "Bobs-MacBook-Pro", os: "darwin", deviceClass: "laptop", hostProvider: null },
  { name: "mesa", os: "linux", deviceClass: "desktop", hostProvider: null },
];

type Outcome = "completed" | "too_large" | "network" | "canceled";
/** One move attempt; `to: "hosted"` targets Raft hosted. Only completed moves change the agent's computer. */
type Step = { to: string; outcome: Outcome };
type AgentSpec = { name: string; runtime: string; model: string; start: string; steps: Step[] };

const ok = (to: string): Step => ({ to, outcome: "completed" });
const large = (to: string): Step => ({ to, outcome: "too_large" });
const net = (to: string): Step => ({ to, outcome: "network" });
const cancel = (to: string): Step => ({ to, outcome: "canceled" });

const AGENTS: AgentSpec[] = [
  {
    name: "Aspen", runtime: "claude", model: "sonnet", start: "armbian-lab",
    steps: [
      ok("armbian-1"), ok("armbian-kitchen"), ok("armbian-1"), ok("hetzner-ex63-4"),
      large("hetzner-ex63-3"), large("hetzner-ex63-3"), net("hetzner-ex63-3"), ok("hetzner-ex63-3"),
      net("hetzner-ex63-5"), net("hetzner-ex63-5"), cancel("hetzner-ex63-5"), ok("hetzner-ex63-5"),
      ok("hetzner-ex63-7"), ok("Alices-MacBook-Air.local"),
    ],
  },
  {
    name: "Birch", runtime: "codex", model: "gpt-5.5", start: "hetzner-ex63-5",
    steps: [ok("hetzner-ex63-6"), net("mesa"), ok("mesa"), ok("hetzner-ex63-6"), ok("hetzner-ex63-5")],
  },
  {
    name: "Cedar", runtime: "claude", model: "opus", start: "armbian-den",
    steps: [ok("armbian-1"), large("hetzner-ex63-3"), large("hetzner-ex63-3"), ok("hetzner-ex63-4"), ok("hetzner-ex63-6")],
  },
  {
    name: "Dune", runtime: "codex", model: "gpt-5.5", start: "Bobs-MacBook-Pro",
    steps: [ok("hetzner-ex63-7"), ok("mesa"), ok("hetzner-ex63-7"), cancel("armbian-kitchen"), ok("Bobs-MacBook-Pro")],
  },
  {
    name: "Ember", runtime: "claude", model: "sonnet", start: "Bobs-MacBook-Pro",
    steps: [ok("hetzner-ex63-3"), net("hetzner-ex63-4"), ok("hetzner-ex63-4"), ok("hetzner-ex63-3"), ok("mesa")],
  },
  {
    name: "Fern", runtime: "claude", model: "haiku", start: "armbian-lab",
    steps: [ok("armbian-kitchen"), ok("armbian-den"), net("armbian-1"), ok("armbian-1"), ok("armbian-lab")],
  },
  {
    name: "Grove", runtime: "codex", model: "gpt-5.5", start: "mesa",
    steps: [ok("hetzner-ex63-6"), ok("hetzner-ex63-5"), large("Alices-MacBook-Air.local"), ok("hetzner-ex63-7"), ok("mesa")],
  },
  {
    name: "Harbor", runtime: "claude", model: "opus", start: "hetzner-ex63-4",
    steps: [ok("hetzner-ex63-5"), ok("hetzner-ex63-6"), ok("hetzner-ex63-3"), cancel("mesa"), ok("hetzner-ex63-4")],
  },
  {
    name: "Iris", runtime: "claude", model: "sonnet", start: "Alices-MacBook-Air.local",
    steps: [ok("armbian-den"), net("armbian-kitchen"), ok("armbian-kitchen"), ok("hetzner-ex63-6"), ok("hetzner-ex63-5")],
  },
  {
    name: "Juniper", runtime: "codex", model: "gpt-5.5", start: "armbian-1",
    steps: [ok("armbian-den"), ok("hetzner-ex63-5"), cancel("hosted"), net("mesa"), ok("mesa"), ok("hetzner-ex63-4")],
  },
];

interface Options {
  seedFile: string;
  webUrl: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { seedFile: "", webUrl: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed-file") options.seedFile = argv[++i] ?? "";
    else if (arg === "--web-url") options.webUrl = argv[++i] ?? "";
    // Passed by ./raftdev script for every script; not needed here.
    else if (arg === "--server-url") i += 1;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.seedFile) throw new Error("--seed-file is required; run through ./raftdev script migration-log-fixture");
  return options;
}

function readSeed(seedFile: string): { serverId: string; slug: string; ownerId: string } {
  const seed = JSON.parse(readFileSync(seedFile, "utf8")) as {
    server?: { id?: unknown; slug?: unknown };
    user?: { id?: unknown };
  };
  const serverId = seed.server?.id;
  const slug = seed.server?.slug;
  const ownerId = seed.user?.id;
  if (typeof serverId !== "string" || typeof slug !== "string" || typeof ownerId !== "string") {
    throw new Error(`seed file ${seedFile} is missing server.id, server.slug or user.id`);
  }
  return { serverId, slug, ownerId };
}

/** Deterministic 0..1 noise, so every run builds the same history. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function transferSummary(bytes: number, files: number): AgentMigrationTransferSummary {
  const caches = Math.round(files / 40);
  const deps = Math.round(files / 25);
  return {
    includedFileCount: files,
    includedBytes: bytes,
    excludedRegenerableCount: caches + deps,
    excludedRegenerableByCategory: { thirdPartyDependencies: deps, caches, buildArtifacts: 0, otherRegenerable: 0 },
    keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: files % 2 === 0 },
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required; run through ./raftdev script migration-log-fixture");
  // Writes fixture rows and toggles a trigger: refuse anything but a local database.
  const localHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
  const databaseHosts = [new URL(databaseUrl).hostname, String(new pg.Client({ connectionString: databaseUrl }).host)];
  const remoteHost = databaseHosts.find((host) => !localHosts.includes(host));
  if (remoteHost !== undefined) {
    throw new Error(`migration-log-fixture only runs against a local database; DATABASE_URL points at ${remoteHost || "a socket"}`);
  }
  const options = parseArgs(process.argv.slice(2));
  const { serverId, slug, ownerId } = readSeed(options.seedFile);
  await initDatabase(databaseUrl);
  const summary = await buildMigrationLogFixture({ serverId, ownerId });
  const path = `/s/${slug}/migrations`;
  console.log(`migration-log-fixture: server ${slug} (${serverId})`);
  console.log(`- computers: ${summary.computers}, agents: ${summary.agents}`);
  console.log(`- moves: ${summary.moves} (${summary.completed} completed, ${summary.failed} failed, ${summary.canceled} canceled; ${summary.hosted} to Raft hosted)`);
  console.log(`- page: ${options.webUrl ? `${options.webUrl}${path}` : path} (sign in as the seed owner)`);
}

export type MigrationLogFixtureSummary = {
  computers: number;
  agents: number;
  moves: number;
  completed: number;
  failed: number;
  canceled: number;
  hosted: number;
};

/** Builds (or rebuilds) the fixture on an initialized database. */
export async function buildMigrationLogFixture(input: {
  serverId: string;
  ownerId: string;
  now?: number;
}): Promise<MigrationLogFixtureSummary> {
  const { serverId, ownerId } = input;
  const db = getDb();
  const [server] = await db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) throw new Error(`seeded server ${serverId} not found; reseed with ./raftdev start`);
  const now = input.now ?? Date.now();

  // ----- Computers ---------------------------------------------------------
  const machineIds = new Map<string, string>();
  for (const [index, spec] of COMPUTERS.entries()) {
    const facts = { os: spec.os, hostname: spec.name, deviceClass: spec.deviceClass, hostProvider: spec.hostProvider };
    const [existing] = await db.select({ id: machines.id }).from(machines)
      .where(and(eq(machines.serverId, serverId), eq(machines.name, spec.name))).limit(1);
    if (existing) {
      await db.update(machines).set(facts).where(eq(machines.id, existing.id));
      machineIds.set(spec.name, existing.id);
      continue;
    }
    const key = `sk_machine_${randomBytes(32).toString("hex")}`;
    const [machine] = await db.insert(machines).values({
      serverId,
      userId: ownerId,
      name: spec.name,
      apiKeyHash: await argon2.hash(key),
      apiKeyPrefix: key.slice(0, 20),
      runtimes: ["claude", "codex"],
      daemonVersion: "1.4.0",
      lastHeartbeat: new Date(now - (index + 1) * HOUR),
      createdAt: new Date(now - 30 * DAY),
      ...facts,
    }).returning();
    // A Raft Computer: an active computers row linked to the machine.
    const computerKey = `sk_computer_${randomBytes(32).toString("hex")}`;
    await db.insert(computers).values({
      serverId,
      name: spec.name,
      apiKeyHash: await argon2.hash(computerKey),
      apiKeyPrefix: computerKey.slice(0, 16),
      attachedByUserId: ownerId,
      machineId: machine.id,
    });
    machineIds.set(spec.name, machine.id);
  }
  const machineId = (name: string): string => {
    const id = machineIds.get(name);
    if (!id) throw new Error(`fixture computer ${name} is not defined`);
    return id;
  };

  // ----- Agents ------------------------------------------------------------
  const agentIds = new Map<string, string>();
  for (const spec of AGENTS) {
    const finalComputer = spec.steps.reduce((at, step) => (step.outcome === "completed" ? step.to : at), spec.start);
    const values = {
      displayName: spec.name,
      runtime: spec.runtime,
      model: spec.model,
      machineId: machineId(finalComputer),
      updatedAt: new Date(now),
    };
    const [existing] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.serverId, serverId), eq(agents.name, spec.name), isNull(agents.deletedAt))).limit(1);
    let agentId: string;
    if (existing) {
      await db.update(agents).set(values).where(eq(agents.id, existing.id));
      agentId = existing.id;
    } else {
      const [agent] = await db.insert(agents).values({
        serverId,
        name: spec.name,
        description: `${spec.name}, a migration log fixture agent`,
        status: "inactive",
        creatorType: "user",
        creatorId: ownerId,
        createdAt: new Date(now - 28 * DAY),
        ...values,
      }).returning();
      agentId = agent.id;
    }
    await db.insert(serverAgentMembers).values({ serverId, agentId, role: "member", joinedAt: new Date(now - 28 * DAY), updatedAt: new Date(now) })
      .onConflictDoNothing();
    agentIds.set(spec.name, agentId);
  }

  // ----- Moves -------------------------------------------------------------
  type MigrationInsert = typeof agentMigrations.$inferInsert;
  const rows: MigrationInsert[] = [];
  const windowStart = now - 21 * DAY;
  const deadline = new Date(now + 365 * DAY);
  for (const [agentIndex, spec] of AGENTS.entries()) {
    const agentId = agentIds.get(spec.name)!;
    const moves = spec.steps.filter((s) => s.outcome === "completed").length;
    // Completed moves are spread over the three weeks; a retry follows its
    // failed or canceled attempt within the hour.
    const gap = (20 * DAY) / moves;
    let cursor = windowStart + agentIndex * 3 * HOUR + noise(agentIndex) * 6 * HOUR;
    let at = spec.start;
    for (const [stepIndex, step] of spec.steps.entries()) {
      const r = noise(agentIndex * 100 + stepIndex + 1);
      const supportRef = `${SUPPORT_REF_PREFIX}${spec.name.toLowerCase()}_${String(stepIndex + 1).padStart(2, "0")}`;
      const hosted = step.to === "hosted";
      if (!hosted && step.to === at) throw new Error(`${supportRef}: source and target are both ${at}`);
      const createdAt = new Date(cursor);
      const base: MigrationInsert = {
        serverId,
        agentId,
        sourceMachineId: machineId(at),
        sourceMachineNameSnapshot: at,
        targetKind: hosted ? "hosted" : "computer",
        targetMachineId: hosted ? null : machineId(step.to),
        targetMachineNameSnapshot: hosted ? null : step.to,
        supportRef,
        contractVersion: 2,
        grantKey: `migration-log-fixture:${supportRef}`,
        initiatedByUserId: ownerId,
        prepDeadlineAt: deadline,
        transferDeadlineAt: deadline,
        arrivalDeadlineAt: deadline,
        createdAt,
      };
      let durationMs: number;
      if (step.outcome === "completed") {
        const bytes = Math.round(40_000_000 + r * 3_200_000_000);
        const files = Math.round(300 + r * 38_000);
        durationMs = Math.round(2 * MINUTE + (bytes / 3_200_000_000) * 22 * MINUTE);
        const end = new Date(cursor + durationMs);
        rows.push({
          ...base,
          state: "completed",
          transferSummary: transferSummary(bytes, files),
          readyAt: new Date(cursor + durationMs * 0.3),
          flippedAt: new Date(cursor + durationMs * 0.8),
          arrivedAt: new Date(cursor + durationMs * 0.9),
          completedAt: end,
          updatedAt: end,
        });
      } else if (step.outcome === "too_large") {
        durationMs = Math.round(6 * MINUTE + r * 8 * MINUTE);
        const end = new Date(cursor + durationMs);
        rows.push({
          ...base,
          state: "failed",
          failureReason: "MIGRATION_CONTROL_MANIFEST_INVALID",
          transportErrorCode: "JS_ZodError",
          transportErrorMessage: TOO_LARGE_MESSAGE,
          sourceBuildProgress: {
            phase: "packing",
            files: Math.round(120_000 + r * 90_000),
            bytes: Math.round(11_500_000_000 + r * 6_000_000_000),
            reportedAt: new Date(cursor + durationMs * 0.9).toISOString(),
          },
          abortedAt: end,
          updatedAt: end,
        });
      } else if (step.outcome === "network") {
        durationMs = Math.round(1 * MINUTE + r * 9 * MINUTE);
        const end = new Date(cursor + durationMs);
        rows.push({
          ...base,
          state: "failed",
          failureReason: "MIGRATION_TRANSPORT_FAILED",
          transportErrorCode: "FETCH_ECONNRESET",
          transportErrorMessage: "fetch failed: read ECONNRESET",
          sourceBuildProgress: {
            phase: "packing",
            files: Math.round(500 + r * 20_000),
            bytes: Math.round(80_000_000 + r * 1_500_000_000),
            reportedAt: new Date(cursor + durationMs * 0.7).toISOString(),
          },
          abortedAt: end,
          updatedAt: end,
        });
      } else {
        durationMs = Math.round(1 * MINUTE + r * 3 * MINUTE);
        const end = new Date(cursor + durationMs);
        rows.push({
          ...base,
          state: "canceled_pre_flip",
          cancelDisposition: "pre_flip_source_authoritative",
          cancelRequestedAt: new Date(cursor + durationMs * 0.6),
          cancelRequestedByUserId: ownerId,
          canceledAt: end,
          updatedAt: end,
        });
      }
      if (step.outcome === "completed") {
        at = step.to;
        cursor += durationMs + gap * (0.6 + 0.4 * r);
      } else {
        cursor += durationMs + 10 * MINUTE + r * 40 * MINUTE;
      }
      if (cursor > now - HOUR) cursor = now - HOUR;
    }
  }
  const lastCreatedAt = Math.max(...rows.map((row) => (row.createdAt as Date).getTime()));
  if (lastCreatedAt > now) throw new Error("fixture schedule ran past now");

  const [trigger] = (await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'agent_migrations'::regclass AND tgname = ${RECEIPT_TRIGGER}
    ) AS "exists"
  `)).rows;
  const hasReceiptTrigger = trigger?.exists === true;
  await db.transaction(async (tx) => {
    await tx.delete(agentMigrations).where(and(
      eq(agentMigrations.serverId, serverId),
      like(agentMigrations.supportRef, `${SUPPORT_REF_PREFIX}%`),
    ));
    // Historical rows without their receipt DMs. DDL is transactional: if an
    // insert fails, the rollback also undoes the DISABLE.
    if (hasReceiptTrigger) await tx.execute(sql.raw(`ALTER TABLE agent_migrations DISABLE TRIGGER ${RECEIPT_TRIGGER}`));
    try {
      await tx.insert(agentMigrations).values(rows);
    } finally {
      if (hasReceiptTrigger) await tx.execute(sql.raw(`ALTER TABLE agent_migrations ENABLE TRIGGER ${RECEIPT_TRIGGER}`)).catch(() => {});
    }
  });

  const count = (state: string) => rows.filter((row) => row.state === state).length;
  return {
    computers: COMPUTERS.length,
    agents: AGENTS.length,
    moves: rows.length,
    completed: count("completed"),
    failed: count("failed"),
    canceled: count("canceled_pre_flip"),
    hosted: rows.filter((row) => row.targetKind === "hosted").length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
