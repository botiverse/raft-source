#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Docs screenshot fixture: the "Raft Workshop" cast used by the app
 * screenshots on docs.raft.build (botiverse/raft-docs, scripts/screenshots).
 *
 *   ./raftdev script docs-fixture --env <name>
 *
 * Every run rebuilds the fixture servers from scratch (delete + create), so the
 * scenes always start in the same state: the same unread counts, read cursors,
 * saved items and "a few minutes ago" timestamps. Accounts are upserted and
 * kept. Nothing outside the fixture servers is touched.
 *
 *   ./raftdev script docs-fixture --env <name> --tutorial-stage <stage>
 *
 * rebuilds only raft-workshop-tutorial, as it stands at one step of the
 * tutorials (onboarding | handoff | progress | full; full is the default), so
 * each tutorial screenshot shows only what exists at that step.
 *
 * Servers (all owned by the fixture viewer, Alex):
 *   raft-workshop           Feature pages: channels, threads, tasks, DMs,
 *                           agents, computers, saved items, files, comments,
 *                           a joint channel, a Login with Raft app.
 *   raft-workshop-tutorial  Tutorial pages: a server just after onboarding
 *                           (#all, #onboarding-owner, Cindy) and the first
 *                           tasks handed to her.
 *   workshop                A brand-new server with the owner setup wizard
 *                           still open, for the "Meet your onboarding agent"
 *                           steps.
 *   partner-labs, atlas-studio  The two partner servers of #partner-launch.
 *
 * Accounts (password = the seed password, password123):
 *   alex@example.com (Alex, the viewer), maya@example.com, taylor@example.com,
 *   mira@partner-labs.example, jun@atlas-studio.example, and
 *   new-owner@example.com (Alex again, with no server yet)
 *
 * The viewer is a dedicated account rather than dev@slock.ai: Raft has no
 * per-server display name, and a separate account keeps the dev servers out of
 * the server switcher in every screenshot.
 *
 * Connected computers. Without a live daemon a machine reads as offline. For
 * screenshots the fixture marks its machines online by writing the Redis
 * replica-owner key a connected daemon would own (slock:machine:<id>:replica)
 * plus the live meta mirror (runtime versions, computer version). That is
 * enough for every read path (status dots, Connected badges, detected
 * runtimes, the setup wizard's checks). Anything that needs a real round trip
 * to the computer (live model lists, the agent Workspace file browser,
 * starting an agent) stays unavailable. Pass --no-fake-online to skip it.
 * The keys have no TTL; `./raftdev stop` removes them with the Redis container.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import argon2 from "argon2";
import pg from "pg";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import Redis from "ioredis";
import type { AgentRuntimeErrorState } from "@botiverse/raft-shared";
import { getDb, initDatabase } from "../src/db/index";
import * as schema from "../src/db/schema";
import { getOrCreateThread } from "../src/services/channelService";
import { recordInboxFactsForPersistedMessages } from "../src/services/messageService";
import { buildSearchText } from "../src/services/searchTokenizer";
import { getStorage } from "../src/services/storageService";

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
  messageMentions,
  messageReactions,
  userChannelReadCursors,
  threadFollows,
  tasks,
  attachmentObjects,
  attachments,
  attachmentCommentRefs,
  agentCredentials,
  userSaved,
  oauthClients,
  jointChannels,
  jointChannelServers,
} = schema;

const PASSWORD = "password123";
const FIXTURE_REPLICA_ID = "docs-fixture";
const MINUTE = 60_000;

type Db = ReturnType<typeof getDb>;
type User = typeof users.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Channel = typeof channels.$inferSelect;
type Message = typeof messages.$inferSelect;
type Actor = { type: "user"; row: User } | { type: "agent"; row: Agent };

const TUTORIAL_STAGES = ["onboarding", "handoff", "progress", "full"] as const;
type TutorialStage = (typeof TUTORIAL_STAGES)[number];

interface Options {
  fakeOnline: boolean;
  /** Rebuild only raft-workshop-tutorial, at this stage. Null: rebuild everything. */
  tutorialStage: TutorialStage | null;
  webUrl: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { fakeOnline: true, webUrl: "", tutorialStage: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-fake-online") options.fakeOnline = false;
    else if (arg === "--tutorial-stage") {
      const value = argv[++i] as TutorialStage | undefined;
      if (!value || !TUTORIAL_STAGES.includes(value)) {
        throw new Error(`--tutorial-stage must be one of: ${TUTORIAL_STAGES.join(", ")}`);
      }
      options.tutorialStage = value;
    }
    else if (arg === "--web-url") options.webUrl = argv[++i] ?? "";
    // Passed by ./raftdev script for every script; not needed here.
    else if (arg === "--server-url" || arg === "--seed-file") i += 1;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Small PNG encoder for the "launch visual" image attachment (no image deps).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
type Rect = { x: number; y: number; w: number; h: number; rgb: [number, number, number] };
function encodePng(width: number, height: number, background: [number, number, number], rects: Rect[]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      let rgb = background;
      for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) rgb = r.rgb;
      raw.set(rgb, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A flat "launch visual" poster: yellow canvas, white card, headline bars. */
function launchVisualPng(): { bytes: Buffer; width: number; height: number } {
  const width = 640;
  const height = 400;
  const black: [number, number, number] = [17, 17, 17];
  const white: [number, number, number] = [255, 255, 255];
  const pink: [number, number, number] = [255, 133, 178];
  const grey: [number, number, number] = [200, 200, 200];
  const rects: Rect[] = [
    { x: 64, y: 56, w: 520, h: 296, rgb: black }, // card shadow
    { x: 56, y: 48, w: 520, h: 296, rgb: black }, // card border
    { x: 60, y: 52, w: 512, h: 288, rgb: white },
    { x: 92, y: 88, w: 72, h: 72, rgb: pink },
    { x: 92, y: 188, w: 320, h: 28, rgb: black },
    { x: 92, y: 232, w: 420, h: 14, rgb: grey },
    { x: 92, y: 258, w: 380, h: 14, rgb: grey },
    { x: 92, y: 284, w: 200, h: 14, rgb: grey },
  ];
  return { bytes: encodePng(width, height, [255, 214, 51], rects), width, height };
}

// ---------------------------------------------------------------------------

// TODO(#triage:a7190e7f): RisingWave doesn't compute firstMentionMessageId
// yet (always null; Postgres has it). Until it does, a mismatch made only of
// that field is reported, not fatal. Delete this special case once RW projects
// the field.
const KNOWN_RW_GAP = "#triage:a7190e7f (RisingWave has no firstMentionMessageId)";

/** True when every PG/RW item pair in the verifier's output differs only in
 * firstMentionMessageId, with Postgres set and RisingWave null. */
function isOnlyKnownRisingWaveGap(output: string): boolean {
  const pgLine = output.split("\n").find((line) => line.startsWith("PG: "));
  const rwLine = output.split("\n").find((line) => line.startsWith("RW: "));
  if (!pgLine || !rwLine) return false;
  let pg: Record<string, unknown>[];
  let rw: Record<string, unknown>[];
  try {
    pg = JSON.parse(pgLine.slice(4));
    rw = JSON.parse(rwLine.slice(4));
  } catch {
    return false;
  }
  if (!Array.isArray(pg) || !Array.isArray(rw) || pg.length !== rw.length) return false;
  let gaps = 0;
  for (let i = 0; i < pg.length; i++) {
    const keys = new Set([...Object.keys(pg[i]), ...Object.keys(rw[i])]);
    for (const key of keys) {
      if (JSON.stringify(pg[i][key]) === JSON.stringify(rw[i][key])) continue;
      if (key !== "firstMentionMessageId" || pg[i][key] == null || rw[i][key] !== null) return false;
      gaps++;
    }
  }
  return gaps > 0;
}

/** Runs scripts/verify-risingwave-inbox-parity.ts for one user and server,
 * one filter at a time, retrying while RisingWave catches up; throws if a
 * filter never matches, except for the known gap above. */
function verifyRisingWaveParity(serverId: string, userId: string, label: string) {
  const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const filter of ["all", "unread", "mentions"]) {
    let output = "";
    let matched = false;
    for (let attempt = 1; attempt <= 30; attempt++) {
      const result = spawnSync(process.execPath, [
        "--import", "@oxc-node/core/register",
        "scripts/verify-risingwave-inbox-parity.ts",
        "--server-id", serverId,
        "--user-id", userId,
        "--filter", filter,
        "--limit", "100",
        "--offset", "0",
      ], {
        cwd: serverDir,
        env: { ...process.env, RISINGWAVE_INBOX_RFC056_SERVING_MODE: "on" },
        encoding: "utf8",
        timeout: 15_000,
      });
      output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      if (result.status === 0) {
        matched = true;
        break;
      }
      // RisingWave has caught up once the only difference left is the known
      // gap; it won't go away by waiting.
      if (attempt >= 3 && isOnlyKnownRisingWaveGap(output)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    }
    if (matched) {
      console.error(`RisingWave inbox parity OK for ${label} (${filter})`);
    } else if (isOnlyKnownRisingWaveGap(output)) {
      console.error(`RisingWave inbox parity for ${label} (${filter}): only the known gap ${KNOWN_RW_GAP}; not failing.\n${output}`);
    } else {
      throw new Error(`RisingWave inbox parity failed for ${label} (${filter}):\n${output}`);
    }
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required; run through ./raftdev script docs-fixture");
  // This script deletes and rebuilds servers. Refuse anything but a local
  // database, whatever DATABASE_URL a shell happens to carry. Check the host
  // pg will actually connect to (a `?host=` parameter overrides the URL's),
  // and the URL's own host too.
  const localHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
  const databaseHosts = [new URL(databaseUrl).hostname, String(new pg.Client({ connectionString: databaseUrl }).host)];
  const remoteHost = databaseHosts.find((host) => !localHosts.includes(host));
  if (remoteHost !== undefined) {
    throw new Error(`docs-fixture only runs against a local database; DATABASE_URL points at ${remoteHost || "a socket"}`);
  }
  const options = parseArgs(process.argv.slice(2));
  // The S3 SDK logger forwards trace/debug/info to the console; keep the
  // fixture's own output readable.
  console.trace = () => {};
  console.debug = () => {};
  console.info = () => {};
  await initDatabase(databaseUrl);
  const db = getDb();
  const redis = options.fakeOnline && process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);

  try {
    // ----- Accounts ---------------------------------------------------------
    const passwordHash = await argon2.hash(PASSWORD);
    const ensureUser = async (email: string, name: string, displayName = name): Promise<User> => {
      const values = {
        name,
        displayName,
        emailVerified: true,
        passwordCredentialEstablishedAt: new Date(now),
        profileSetupCompletedAt: new Date(now),
        signupSurveyCompletedAt: new Date(now),
        preferredTimeFormat: "12h" as const,
        updatedAt: new Date(now),
      };
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing) {
        const [row] = await db.update(users).set(values).where(eq(users.id, existing.id)).returning();
        return row;
      }
      const [row] = await db.insert(users).values({ email, passwordHash, ...values }).returning();
      return row;
    };
    const alex = await ensureUser("alex@example.com", "Alex");
    const maya = await ensureUser("maya@example.com", "Maya");
    const taylor = await ensureUser("taylor@example.com", "Taylor");
    const mira = await ensureUser("mira@partner-labs.example", "Mira");
    const jun = await ensureUser("jun@atlas-studio.example", "Jun");
    // A signed-in account with no server yet: the "create your first server" page.
    await ensureUser("new-owner@example.com", "alex-new", "Alex");

    // ----- Rebuild: drop the previous fixture servers ------------------------
    const onlyTutorial = options.tutorialStage !== null;
    const FIXTURE_SLUGS = onlyTutorial
      ? ["raft-workshop-tutorial"]
      : ["raft-workshop", "raft-workshop-tutorial", "workshop", "partner-labs", "atlas-studio"];
    // Only servers this fixture's own accounts own: a server someone made by
    // hand with one of these slugs is left alone.
    const fixtureOwnerIds = [alex.id, mira.id, jun.id];
    const oldServers = await db
      .select({ id: servers.id })
      .from(servers)
      .where(and(inArray(servers.slug, FIXTURE_SLUGS), inArray(servers.ownerId, fixtureOwnerIds)));
    const oldIds = oldServers.map((s) => s.id);
    if (oldIds.length > 0) {
      // Joint channels keep their messages in the shared joint-storage server.
      const oldJoint = await db
        .select({ jointChannelId: jointChannelServers.jointChannelId, canonical: jointChannels.canonicalChannelId })
        .from(jointChannelServers)
        .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
        .where(inArray(jointChannelServers.serverId, oldIds));
      for (const j of oldJoint) {
        await db.delete(jointChannels).where(eq(jointChannels.id, j.jointChannelId));
        await db.delete(channels).where(eq(channels.id, j.canonical));
      }
      // Rows that point at fixture messages/agents without ON DELETE CASCADE.
      await db.execute(sql`delete from tasks where channel_id in (select id from channels where server_id in ${oldIds})`);
      // Restrict-FKs the UI can create while screenshots are taken: a workflow
      // run holds its channel, an agent runtime profile holds its machine.
      await db.execute(sql`delete from workflow_instances where server_id in ${oldIds}`);
      await db.execute(sql`delete from agent_runtime_profiles where server_id in ${oldIds}`);
      await db.execute(sql`update servers set onboarding_agent_id = null where id in ${oldIds}`);
      for (const id of oldIds) {
        await db.delete(servers).where(eq(servers.id, id));
      }
      console.error(`Removed ${oldIds.length} previous fixture server(s)`);
    }

    // ----- Builders ---------------------------------------------------------
    const createServer = async (input: { name: string; slug: string; owner: User }) => {
      const [server] = await db.insert(servers).values({
        name: input.name,
        slug: input.slug,
        ownerId: input.owner.id,
        agentAllChannelGreetingEnabled: false,
        createdAt: at(60 * 24 * 3),
      }).returning();
      return server;
    };
    type MemberSetup = Pick<
      typeof serverMembers.$inferInsert,
      "setupModalReminderOptOut" | "onboardingWizardCurrentStep" | "setupStatus" | "setupCompletionReason" | "setupContractVersion"
    >;
    const completedSetup: MemberSetup = {
      setupModalReminderOptOut: true,
      onboardingWizardCurrentStep: "complete" as const,
      setupStatus: "complete" as const,
      setupCompletionReason: "grandfathered" as const,
      setupContractVersion: "onboarding-setup-v2",
    };
    const addMember = async (serverId: string, user: User, role: "owner" | "admin" | "member", setup = completedSetup) => {
      await db.insert(serverMembers).values({ serverId, userId: user.id, role, ...setup, joinedAt: at(60 * 24 * 3) });
    };
    const createChannel = async (serverId: string, name: string, description: string, type: "channel" | "private" | "joint" | "dm") => {
      const [channel] = await db.insert(channels).values({ serverId, name, description, type, createdAt: at(60 * 24 * 3) }).returning();
      return channel;
    };
    const join = async (channel: Channel, members: Actor[]) => {
      for (const m of members) {
        // Joined before the backdated history, so Activity and unread counts
        // include it (both start at the membership's join time).
        if (m.type === "user") await db.insert(channelHumans).values({ channelId: channel.id, userId: m.row.id, joinedAt: channel.createdAt }).onConflictDoNothing();
        else await db.insert(channelAgents).values({ channelId: channel.id, agentId: m.row.id, addedAt: channel.createdAt }).onConflictDoNothing();
      }
    };
    const createMachine = async (serverId: string, input: { name: string; hostname: string; runtimes: string[] }) => {
      const key = `sk_machine_${randomBytes(32).toString("hex")}`;
      const [machine] = await db.insert(machines).values({
        serverId,
        userId: alex.id,
        name: input.name,
        apiKeyHash: await argon2.hash(key),
        apiKeyPrefix: key.slice(0, 20),
        runtimes: input.runtimes,
        hostname: input.hostname,
        os: "darwin",
        daemonVersion: "1.4.0",
        lastHeartbeat: new Date(now),
        createdAt: at(60 * 24 * 3),
      }).returning();
      // A Raft Computer (not a legacy daemon): an active computers row linked
      // to the machine, as `raft-computer setup` creates.
      const computerKey = `sk_computer_${randomBytes(32).toString("hex")}`;
      await db.insert(computers).values({
        serverId,
        name: input.name,
        apiKeyHash: await argon2.hash(computerKey),
        apiKeyPrefix: computerKey.slice(0, 16),
        attachedByUserId: alex.id,
        machineId: machine.id,
      });
      if (redis) {
        await redis.set(`slock:machine:${machine.id}:replica`, FIXTURE_REPLICA_ID);
        const versions: Record<string, string> = {
          claude: "2.4.1", codex: "0.162.0", cursor: "2026.10.02", builtin: "1.4.0", "kimi-sdk": "1.4.0", pi: "0.71.0",
        };
        await redis.hset(`slock:machine:${machine.id}:meta`, {
          computerVersion: "1.4.0",
          computerVersionObservedAt: new Date(now).toISOString(),
          daemonVersion: "1.4.0",
          hostname: input.hostname,
          os: "darwin",
          runtimeVersions: JSON.stringify(Object.fromEntries(input.runtimes.map((r) => [r, versions[r] ?? "1.0.0"]))),
        });
      }
      return machine;
    };
    const createAgent = async (serverId: string, input: {
      name: string;
      description: string;
      runtime: string;
      model: string;
      machineId: string | null;
      status?: "active" | "inactive" | "stopped";
      reasoningEffort?: "low" | "medium" | "high" | null;
      createdAt?: Date;
    }) => {
      const [agent] = await db.insert(agents).values({
        serverId,
        name: input.name,
        displayName: input.name,
        description: input.description,
        runtime: input.runtime,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        status: input.status ?? "active",
        machineId: input.machineId,
        creatorType: "user",
        creatorId: alex.id,
        createdAt: input.createdAt ?? at(60 * 24 * 3),
      }).returning();
      await db.insert(serverAgentMembers).values({ serverId, agentId: agent.id, role: "member", joinedAt: agent.createdAt, updatedAt: new Date(now) });
      return agent;
    };

    const handleOf = (a: Actor) => a.row.name;
    /**
     * Insert a message the way the send path leaves it: search text, the
     * @mention rows, and the Activity facts (through the server's own fact
     * recorder). `@Name` tokens matching a channel member become mentions.
     */
    const post = async (channel: Channel, from: Actor, content: string, minutesAgo: number, audience: Actor[] = []) => {
      const createdAt = at(minutesAgo);
      const [message] = await db.insert(messages).values({
        channelId: channel.id,
        senderType: from.type,
        senderId: from.row.id,
        content,
        searchText: buildSearchText(content),
        createdAt,
        updatedAt: createdAt,
      }).returning();
      const mentioned = audience.filter((a) => a.row.id !== from.row.id && new RegExp(`@${handleOf(a)}\\b`).test(content));
      for (const target of mentioned) {
        await db.insert(messageMentions).values({
          messageId: message.id,
          messageSeq: message.seq,
          serverId: channel.serverId,
          channelId: channel.id,
          targetType: target.type,
          targetId: target.row.id,
          handleAtSendTime: handleOf(target),
          createdAt,
        }).onConflictDoNothing();
      }
      await recordInboxFactsForPersistedMessages([message], {
        inboxFactPolicy: { mode: "record", producer: "test.docs_fixture", reason: "Docs screenshot fixture message" },
      });
      return message;
    };
    const thread = async (parent: Message, starter: Actor) => {
      const created = await getOrCreateThread(parent.id, starter.row.id, starter.type);
      const [row] = await db.select().from(channels).where(eq(channels.id, created.id)).limit(1);
      return row;
    };
    const follow = async (threadChannel: Channel, parent: Message, who: Actor[], reason: "authored" | "replied" | "manual" = "replied") => {
      for (const w of who) {
        await db.insert(threadFollows).values({
          threadChannelId: threadChannel.id,
          followerType: w.type === "user" ? "user" : "agent",
          followerId: w.row.id,
          parentMessageId: parent.id,
          reason,
        }).onConflictDoNothing();
      }
    };
    const task = async (input: {
      host: Message;
      number: number;
      title: string;
      status: "todo" | "in_progress" | "in_review" | "done" | "closed";
      creator: Actor;
      assignee?: Actor | null;
    }) => {
      const t = input.host.createdAt.getTime();
      await db.insert(tasks).values({
        channelId: input.host.channelId,
        taskNumber: input.number,
        title: input.title,
        status: input.status,
        createdByType: input.creator.type,
        createdById: input.creator.row.id,
        claimedByType: input.assignee?.type ?? null,
        claimedById: input.assignee?.row.id ?? null,
        claimedAt: input.assignee ? new Date(t + MINUTE) : null,
        completedAt: input.status === "done" ? new Date(t + 2 * MINUTE) : null,
        closedAt: input.status === "closed" ? new Date(t + 2 * MINUTE) : null,
        closedByType: input.status === "closed" ? input.creator.type : null,
        closedById: input.status === "closed" ? input.creator.row.id : null,
        messageId: input.host.id,
        createdAt: input.host.createdAt,
        updatedAt: input.host.createdAt,
      });
    };
    /** Mark a conversation read for `user` up to (and including) `message`. */
    const readUpTo = async (user: User, channelId: string, message: Message | null) => {
      const seq = message?.seq ?? 0;
      await db.insert(userChannelReadCursors).values({ userId: user.id, channelId, lastReadSeq: seq, lastReadSeq8: BigInt(seq) })
        .onConflictDoUpdate({
          target: [userChannelReadCursors.userId, userChannelReadCursors.channelId],
          set: { lastReadSeq: seq, lastReadSeq8: BigInt(seq), updatedAt: new Date(now) },
        });
    };
    const lastMessage = async (channelId: string) => {
      const [row] = await db.select().from(messages).where(eq(messages.channelId, channelId)).orderBy(sql`${messages.seq} desc`).limit(1);
      return row ?? null;
    };
    const attach = async (input: {
      message: Message;
      uploader: Actor;
      filename: string;
      mimeType: string;
      bytes: Buffer;
      width?: number;
      height?: number;
    }) => {
      const storage = getStorage();
      if (!storage) throw new Error("Object storage is not configured (S3_* env); run through ./raftdev script docs-fixture");
      const storageKey = `docs-fixture/${input.message.channelId}/${input.filename}`;
      await storage.put(storageKey, input.bytes, input.mimeType);
      // The bytes' metadata lives on the immutable object; the projection is
      // this occurrence of it in the message.
      const [channel] = await db.select({ serverId: channels.serverId }).from(channels)
        .where(eq(channels.id, input.message.channelId)).limit(1);
      if (!channel) throw new Error(`docs-fixture: channel ${input.message.channelId} not found`);
      const [object] = await db.insert(attachmentObjects).values({
        originServerId: channel.serverId,
        uploaderId: input.uploader.row.id,
        uploaderType: input.uploader.type,
        storageKey,
        contentHash: createHash("sha256").update(input.bytes).digest("hex"),
        mimeType: input.mimeType,
        sizeBytes: input.bytes.length,
        width: input.width ?? null,
        height: input.height ?? null,
        createdAt: input.message.createdAt,
      }).returning({ id: attachmentObjects.id });
      const [row] = await db.insert(attachments).values({
        objectId: object!.id,
        messageId: input.message.id,
        channelId: input.message.channelId,
        uploaderId: input.uploader.row.id,
        uploaderType: input.uploader.type,
        filename: input.filename,
        createdAt: input.message.createdAt,
      }).returning();
      return row;
    };
    const save = async (user: User, serverId: string, message: Message, minutesAgo: number) => {
      await db.insert(userSaved).values({ userId: user.id, serverId, messageId: message.id, createdAt: at(minutesAgo) }).onConflictDoNothing();
    };
    const react = async (message: Message, who: Actor, emoji: string) => {
      await db.insert(messageReactions).values({ messageId: message.id, reactorType: who.type, reactorId: who.row.id, emoji }).onConflictDoNothing();
    };
    const dm = async (serverId: string, user: User, other: Actor) => {
      const name = other.type === "agent" ? `dm-${user.id.slice(0, 8)}-${other.row.id.slice(0, 8)}` : `dm-${[user.id, other.row.id].sort().join("-").slice(0, 40)}`;
      const channel = await createChannel(serverId, name, "", "dm");
      await join(channel, [{ type: "user", row: user }, other]);
      return channel;
    };

    const A = (row: User): Actor => ({ type: "user", row });
    const G = (row: Agent): Actor => ({ type: "agent", row });

    if (!onlyTutorial) {
      // =======================================================================
      // 1. raft-workshop — feature pages
      // =======================================================================
      const ws = await createServer({ name: "Raft Workshop", slug: "raft-workshop", owner: alex });
      await addMember(ws.id, alex, "owner");
      await addMember(ws.id, maya, "admin");
      await addMember(ws.id, taylor, "member");
      const macbook = await createMachine(ws.id, {
        name: "Alex MacBook Pro",
        hostname: "alex-macbook-pro",
        runtimes: ["claude", "codex", "builtin", "kimi-sdk", "cursor", "pi"],
      });
      const cindy = await createAgent(ws.id, { name: "Cindy", description: "Onboarding Agent", runtime: "claude", model: "opus", machineId: macbook.id, createdAt: at(60 * 24 * 3) });
      const koda = await createAgent(ws.id, { name: "Koda", description: "Screenshot and docs helper", runtime: "codex", model: "gpt-5", reasoningEffort: "medium", machineId: macbook.id });
      const maggie = await createAgent(ws.id, { name: "Maggie", description: "Docs writer and reviewer", runtime: "cursor", model: "composer-2", machineId: macbook.id });
      const walter = await createAgent(ws.id, { name: "Walter", description: "Research coordinator", runtime: "claude", model: "sonnet", machineId: macbook.id });
      const scout = await createAgent(ws.id, { name: "Scout", description: "Release notes scout", runtime: "pi", model: "default", machineId: macbook.id, status: "stopped" });
      await db.update(servers).set({ onboardingAgentId: cindy.id }).where(eq(servers.id, ws.id));
      // Statuses for the lifecycle page: Cindy online (derived), Koda working,
      // Maggie error, Scout offline (stopped).
      const maggieError: AgentRuntimeErrorState = { message: "Cursor CLI exited during startup", at: at(4).toISOString(), actionRequired: false };
      await db.update(agents).set({ lastRuntimeError: maggieError }).where(eq(agents.id, maggie.id));
      if (redis) {
        const far = String(now + 365 * 24 * 60 * MINUTE);
        await redis.hset(`slock:agent:${koda.id}:activity`, {
          activity: "working",
          detail: "Capturing docs screenshots",
          detailKind: "tool",
          updatedAt: far,
          observedAtMs: far,
          carriers: "",
        });
        await redis.del(`slock:agent:${maggie.id}:runtime_error`);
      }

      // External agents, one per External setup state.
      const externalAgent = async (name: string, description: string) =>
        createAgent(ws.id, { name, description, runtime: "external", model: "external", machineId: null, createdAt: at(60 * 24) });
      await externalAgent("Relay", "Hermes gateway for partner updates");
      const courier = await externalAgent("Courier", "Claude Code session on the build box");
      const automationShell = await externalAgent("AutomationShell", "Connected over the Raft SDK");
      const mintCredential = async (agent: Agent, lastUsedAt: Date | null) => {
        const key = `sk_agent_${randomBytes(24).toString("hex")}`;
        await db.insert(agentCredentials).values({
          agentId: agent.id,
          apiKeyHash: await argon2.hash(key),
          apiKeyPrefix: key.slice(0, 16),
          name: `${agent.name} login`,
          scopes: ["agent"],
          createdByUserId: alex.id,
          createdAt: at(90),
          lastUsedAt,
        });
      };
      await mintCredential(courier, null);
      await mintCredential(automationShell, at(12));

      const workshopHumans = [A(alex), A(maya), A(taylor)];
      const coreAgents = [G(koda), G(maggie), G(cindy)];
      const all = await createChannel(ws.id, "all", "General channel for all members", "channel");
      const launchRoom = await createChannel(ws.id, "launch-room", "Launch planning and weekly coordination", "channel");
      const docsReview = await createChannel(ws.id, "docs-review", "Drafts, review notes, and screenshots", "channel");
      const customerFeedback = await createChannel(ws.id, "customer-feedback", "Customer notes and beta feedback", "channel");
      const leadershipRoom = await createChannel(ws.id, "leadership-room", "Decisions for the launch leads", "private");
      await join(all, [...workshopHumans, ...coreAgents, G(walter), G(scout)]);
      await join(launchRoom, [...workshopHumans, G(koda), G(maggie)]);
      await join(docsReview, [...workshopHumans, G(koda), G(maggie)]);
      await join(customerFeedback, [...workshopHumans, G(koda), G(cindy)]);
      await join(leadershipRoom, [A(alex), A(maya)]);

      // #all: the reminder thread first, then the welcome round (server overview).
      const reminderAsk = await post(all, A(alex), "@Koda please remind me to review the agent onboarding checklist tomorrow.", 70, [G(koda)]);
      const reminderThread = await thread(reminderAsk, A(alex));
      await post(reminderThread, G(koda), "Reminder set for tomorrow at 9:00 AM. I'll bring the checklist back into this thread.", 69, [A(alex)]);
      await post(reminderThread, G(koda), "@Alex reminder fired: time to review the agent onboarding checklist. Here is the current draft with the two open questions marked.", 2, [A(alex)]);
      await follow(reminderThread, reminderAsk, [A(alex)], "authored");
      await follow(reminderThread, reminderAsk, [G(koda)]);
      await post(all, A(alex), "Welcome to the server. Use #launch-room for planning and #customer-feedback for product notes.", 40);
      await post(all, G(cindy), "I pinned the launch room and docs review channel so the team can get back to them quickly.", 39);
      await post(all, A(maya), "I joined the server and can see the shared channels now.", 38);
      await post(all, G(koda), "The server sidebar groups pinned items, channels, and direct messages in one place.", 37);
      await post(all, G(maggie), "I can keep docs feedback organized and link the right channel when copy is ready.", 36);
      await readUpTo(alex, all.id, await lastMessage(all.id));
      await readUpTo(alex, reminderThread.id, null);

      // #launch-room
      // Taylor's ask sits low in the channel, so the reaction and message-menu
      // scenes open on messages already in view (no scroll, no "Back to Bottom").
      await post(launchRoom, A(maya), "Please quote this decision in the weekly update.", 30);
      const checklistParent = await post(launchRoom, A(alex), "Let's keep launch checklist questions in this thread.", 28);
      const checklistThread = await thread(checklistParent, A(alex));
      await post(checklistThread, G(koda), "I pulled the latest tasks into one checklist and tagged owners.", 27);
      await post(checklistThread, A(taylor), "Great. I will review the customer notes after lunch.", 26);
      await post(checklistThread, G(maggie), "I will watch this thread for docs copy changes.", 25);
      await follow(checklistThread, checklistParent, [A(alex)], "authored");
      await follow(checklistThread, checklistParent, [G(koda), A(taylor), G(maggie)]);
      const reactAsk = await post(launchRoom, A(taylor), "Can someone react when the launch checklist looks good?", 24.5);
      await react(reactAsk, A(maya), "👍");
      await post(launchRoom, A(maya), "Turn this into a follow-up task for release notes.", 24);
      const taskSpecs = [
        { title: "Draft channel onboarding copy", status: "todo" as const, assignee: null },
        { title: "Review launch checklist", status: "in_progress" as const, assignee: G(koda) },
        { title: "Approve screenshots", status: "in_review" as const, assignee: G(maggie) },
        { title: "Collect customer examples", status: "done" as const, assignee: A(taylor) },
        { title: "Retire old docs route", status: "closed" as const, assignee: A(alex) },
      ];
      for (let i = 0; i < taskSpecs.length; i += 1) {
        const spec = taskSpecs[i];
        const host = await post(launchRoom, A(alex), spec.title, 23 - i);
        await task({ host, number: i + 1, title: spec.title, status: spec.status, creator: A(alex), assignee: spec.assignee });
      }
      await readUpTo(alex, launchRoom.id, await lastMessage(launchRoom.id));
      await readUpTo(alex, checklistThread.id, null);

      // #docs-review: a shared visual + brief, a saved draft note, and the
      // release-notes file that carries an anchored comment.
      const releaseNotes = Buffer.from([
        "# Release Notes Review",
        "",
        "A short, non-sensitive file for the docs walkthrough of comments on files.",
        "",
        "## Activation Checklist",
        "",
        "Check the confirmation copy, status wording, and follow-up owner before publishing.",
        "",
        "## Launch Notes",
        "",
        "Keep the update concise and link back to the source thread.",
        "",
      ].join("\n"), "utf-8");
      const releaseMsg = await post(docsReview, A(maya), "Release notes draft for review.", 50);
      const releaseFile = await attach({ message: releaseMsg, uploader: A(maya), filename: "release-notes-review.md", mimeType: "text/markdown", bytes: releaseNotes });
      const releaseThread = await thread(releaseMsg, A(alex));
      const comment = await post(releaseThread, A(alex), "This wording is ready for the docs example.", 48);
      await db.insert(attachmentCommentRefs).values({
        commentMessageId: comment.id,
        attachmentId: releaseFile.id,
        anchorType: "md-section",
        anchorData: {
          headingId: "activation-checklist",
          headingTitle: "Activation Checklist",
          quote: "Check the confirmation copy, status wording, and follow-up owner before publishing.",
        },
      });
      await follow(releaseThread, releaseMsg, [A(maya)], "authored");
      await follow(releaseThread, releaseMsg, [A(alex)]);
      const visual = launchVisualPng();
      const briefMsg = await post(docsReview, A(alex), "Sharing the launch visual and brief for review.", 20);
      await attach({ message: briefMsg, uploader: A(alex), filename: "launch-visual.png", mimeType: "image/png", bytes: visual.bytes, width: visual.width, height: visual.height });
      await attach({
        message: briefMsg,
        uploader: A(alex),
        filename: "launch-brief.md",
        mimeType: "text/markdown",
        bytes: Buffer.from("# Launch brief\n\nAudience, timeline, and the three messages every channel should repeat.\n\n## Timeline\n\n- Beta wrap-up\n- Launch day\n- Follow-up survey\n", "utf-8"),
      });
      await readUpTo(alex, docsReview.id, briefMsg);
      await readUpTo(alex, releaseThread.id, await lastMessage(releaseThread.id));
      const draftNote = await post(docsReview, G(maggie), "Saved draft note: place the channel screenshot before the thread walkthrough.", 12);

      // #customer-feedback (one unread customer note)
      const customerNote = await post(customerFeedback, A(taylor), "Customer note: the invite copy is clearer when it says who will join the server.", 10);
      await readUpTo(alex, customerFeedback.id, null);

      // #leadership-room (private)
      await post(leadershipRoom, A(maya), "Pricing stays as proposed for launch. Let's confirm the beta label on Thursday.", 120);
      await readUpTo(alex, leadershipRoom.id, await lastMessage(leadershipRoom.id));

      // DMs: Alex ↔ Koda (read), Alex ↔ Taylor (one unread)
      const kodaDm = await dm(ws.id, alex, G(koda));
      await post(kodaDm, A(alex), "Can you summarize the launch risks from #customer-feedback?", 8);
      await post(kodaDm, G(koda), "Summary ready: onboarding friction is the top risk, followed by invite clarity. I also drafted next steps.", 7);
      await readUpTo(alex, kodaDm.id, await lastMessage(kodaDm.id));
      const taylorDm = await dm(ws.id, alex, A(taylor));
      await post(taylorDm, A(taylor), "I reviewed the channel list and saved the examples we need.", 5);
      await readUpTo(alex, taylorDm.id, null);

      // Saved items (newest first in the Saved view)
      await save(alex, ws.id, reactAsk, 9);
      await save(alex, ws.id, draftNote, 6);
      await save(alex, ws.id, customerNote, 3);

      // Pinned: #launch-room and #docs-review.
      await db.update(serverMembers).set({
        pinnedRefs: [
          { kind: "channel", id: launchRoom.id },
          { kind: "channel", id: docsReview.id },
        ],
        pinnedChannelIds: [launchRoom.id, docsReview.id],
        pinnedOrder: [launchRoom.id, docsReview.id],
        pinnedVersion: 1,
        sidebarChannelOrder: [all.id, launchRoom.id, docsReview.id, customerFeedback.id, leadershipRoom.id],
      }).where(and(eq(serverMembers.serverId, ws.id), eq(serverMembers.userId, alex.id)));

      // Login with Raft: a private app registered on this server.
      const clientSecret = `docs-fixture-${randomBytes(16).toString("hex")}`;
      await db.insert(oauthClients).values({
        serverId: ws.id,
        clientId: "workshop-notes",
        clientSecretHash: await argon2.hash(clientSecret),
        appType: "server_local",
        name: "Workshop Notes",
        description: "Private app for drafting notes from Raft channel discussions.",
        homepageUrl: "https://workshop-notes.example/",
        returnUrl: "https://workshop-notes.example/auth/callback",
        allowedScopes: ["openid", "profile"],
        category: "Productivity",
        humanMarketplaceVisible: false,
        createdByUserId: alex.id,
      }).onConflictDoNothing();

      // =======================================================================
      // 2. partner-labs + atlas-studio, and #partner-launch joined across all 3
      // =======================================================================
      const partnerLabs = await createServer({ name: "Partner Labs", slug: "partner-labs", owner: mira });
      await addMember(partnerLabs.id, mira, "owner");
      const atlasStudio = await createServer({ name: "Atlas Studio", slug: "atlas-studio", owner: jun });
      await addMember(atlasStudio.id, jun, "owner");
      for (const [server, owner] of [[partnerLabs, mira], [atlasStudio, jun]] as const) {
        const home = await createChannel(server.id, "all", "General channel for all members", "channel");
        await join(home, [A(owner)]);
      }
      let [jointStorage] = await db.select().from(servers).where(eq(servers.kind, "joint_storage")).limit(1);
      if (!jointStorage) {
        [jointStorage] = await db.insert(servers).values({
          name: "Joint Storage Namespace",
          slug: "__joint_storage__",
          kind: "joint_storage",
          ownerId: alex.id,
          plan: "founder",
          agentAllChannelGreetingEnabled: false,
        }).returning();
      }
      const jointDescription = "Joint channel with Partner Labs and Atlas Studio";
      const storageChannel = await createChannel(jointStorage.id, `joint-partner-launch-${randomBytes(4).toString("hex")}`, jointDescription, "channel");
      const [joint] = await db.insert(jointChannels).values({
        canonicalChannelId: storageChannel.id,
        createdByServerId: ws.id,
        createdByUserId: alex.id,
      }).returning();
      const projections: Array<{ server: typeof ws; member: User; role: "host" | "participant" }> = [
        { server: ws, member: alex, role: "host" },
        { server: partnerLabs, member: mira, role: "participant" },
        { server: atlasStudio, member: jun, role: "participant" },
      ];
      let hostProjection: Channel | null = null;
      for (const p of projections) {
        const local = await createChannel(p.server.id, "partner-launch", jointDescription, "joint");
        await db.insert(jointChannelServers).values({
          jointChannelId: joint.id,
          serverId: p.server.id,
          localChannelId: local.id,
          role: p.role,
          status: "active",
          joinedByUserId: p.member.id,
        });
        await join(local, [A(p.member)]);
        if (p.role === "host") hostProjection = local;
      }
      await post(storageChannel, A(alex), "Raft Workshop is sharing the launch brief here.", 16);
      await post(storageChannel, A(mira), "Partner Labs can review assets in the same joint channel.", 15);
      await post(storageChannel, A(jun), "Atlas Studio will add the rollout notes by Friday.", 14);
      if (hostProjection) await readUpTo(alex, hostProjection.id, null);
      await readUpTo(alex, storageChannel.id, await lastMessage(storageChannel.id));
    }

    // =======================================================================
    // 3. raft-workshop-tutorial — the tutorial pages, one stage at a time.
    //    onboarding: Cindy's opener in #onboarding-owner (meet your onboarding agent)
    //    handoff:    + Alex's three messages in #all     (hand off your first task, step 1)
    //    progress:   + task #1 and Cindy's progress thread (step 3)
    //    full:       + task #2 and its breakdown, #launch-room, #customer-feedback
    //                (divide the work, catch up, search)
    // =======================================================================
    const stage = TUTORIAL_STAGES.indexOf(options.tutorialStage ?? "full");
    const atLeast = (name: TutorialStage) => stage >= TUTORIAL_STAGES.indexOf(name);
    const tut = await createServer({ name: "Raft Workshop", slug: "raft-workshop-tutorial", owner: alex });
    await addMember(tut.id, alex, "owner");
    const tutMac = await createMachine(tut.id, { name: "Alex MacBook Pro", hostname: "alex-macbook-pro", runtimes: ["claude", "codex", "builtin", "kimi-sdk", "pi"] });
    const tCindy = await createAgent(tut.id, { name: "Cindy", description: "Onboarding Agent", runtime: "claude", model: "opus", machineId: tutMac.id });
    await db.update(servers).set({ onboardingAgentId: tCindy.id }).where(eq(servers.id, tut.id));
    const C = G(tCindy);
    const tAll = await createChannel(tut.id, "all", "General channel for all members", "channel");
    const tOwner = await createChannel(tut.id, "onboarding-owner", "Your private onboarding space", "private");
    for (const ch of [tAll, tOwner]) await join(ch, [A(alex), C]);

    // onboarding: Cindy's opener.
    await post(tOwner, C, [
      "Hi Alex, I'm Cindy. I help you turn this server into a working agent team. Anything you need here, just ask me. I know Raft inside out.",
      "",
      "Raft is where your agents go into team mode. I dropped a short example in the thread right here — open it.",
      "",
      "Message them like teammates — any channel, anytime, half-formed is fine.",
      "",
      "Would you want me to look at your current agents setup on this computer and propose you a starter team? Or just tell me what you're working on.",
    ].join("\n"), 180, [A(alex)]);
    await readUpTo(alex, tOwner.id, await lastMessage(tOwner.id));

    if (atLeast("handoff")) {
      await post(tAll, A(alex), "Can you turn the customer notes into a launch checklist?", 90);
      await post(tAll, A(alex), "Use the beta feedback thread as the source of truth.", 89);
      await post(tAll, A(alex), "Also flag anything that still needs a human decision.", 88);
    }
    if (atLeast("progress")) {
      const handoff = await post(tAll, A(alex), "Turn the customer notes into a launch checklist", 87);
      await task({ host: handoff, number: 1, title: "Turn the customer notes into a launch checklist", status: "in_progress", creator: A(alex), assignee: C });
      const handoffThread = await thread(handoff, A(alex));
      await post(handoffThread, C, "I'm reading the beta feedback and grouping the notes by launch risk.", 86);
      await post(handoffThread, C, "Drafted the checklist structure: onboarding, billing, docs, and owner follow-up.", 80);
      await post(handoffThread, C, "One human decision remains: whether the invite email should mention the beta label.", 75);
      await follow(handoffThread, handoff, [A(alex)], "authored");
      await follow(handoffThread, handoff, [C]);
      await readUpTo(alex, handoffThread.id, await lastMessage(handoffThread.id));
    }
    if (atLeast("full")) {
      const goal = await post(tAll, A(alex), "Ship the launch checklist by Friday", 60);
      await task({ host: goal, number: 2, title: "Ship the launch checklist by Friday", status: "todo", creator: A(alex) });
      const goalThread = await thread(goal, A(alex));
      await post(goalThread, C, [
        "I'd split this into four tasks before anyone starts:",
        "#3 Gather the launch notes and source links.",
        "#4 Draft the checklist sections and owners.",
        "#5 Review open decisions with the team.",
        "#6 Turn the final checklist into a launch-ready doc.",
      ].join("\n"), 59);
      await follow(goalThread, goal, [A(alex)], "authored");
      await follow(goalThread, goal, [C]);
      const subtasks = [
        { title: "Gather the launch notes and source links", status: "in_progress" as const },
        { title: "Draft the checklist sections and owners", status: "in_progress" as const },
        { title: "Review open decisions with the team", status: "in_progress" as const },
        { title: "Turn the final checklist into a launch-ready doc", status: "todo" as const },
      ];
      for (let i = 0; i < subtasks.length; i += 1) {
        const s = subtasks[i];
        const host = await post(tAll, C, s.title, 58 - i);
        await task({ host, number: 3 + i, title: s.title, status: s.status, creator: C, assignee: s.status === "todo" ? null : C });
      }
      const ownersAsk = await post(tAll, A(alex), "Review launch checklist owners", 20);
      const ownersThread = await thread(ownersAsk, A(alex));
      await follow(ownersThread, ownersAsk, [A(alex)], "authored");
      await readUpTo(alex, goalThread.id, await lastMessage(goalThread.id));
      await readUpTo(alex, ownersThread.id, null);
      await post(ownersThread, C, "@Alex owner review is ready. The checklist is waiting on the invite email decision.", 4, [A(alex)]);

      // Other channels for Activity and Search.
      const tLaunch = await createChannel(tut.id, "launch-room", "Launch planning", "channel");
      const tFeedback = await createChannel(tut.id, "customer-feedback", "Customer notes and beta feedback", "channel");
      for (const ch of [tLaunch, tFeedback]) await join(ch, [A(alex), C]);
      const keepMoving = await post(tLaunch, A(alex), "Please keep the launch checklist moving.", 30);
      await readUpTo(alex, tLaunch.id, keepMoving);
      await post(tLaunch, C, "@Alex I pulled the blocker list together and marked the owner decisions.", 6, [A(alex)]);
      await post(tFeedback, C, "I found three beta notes that affect launch copy and pricing.", 5);
      await readUpTo(alex, tFeedback.id, null);
    }
    await readUpTo(alex, tAll.id, await lastMessage(tAll.id));

    if (!onlyTutorial) {
      // =======================================================================
      // 4. workshop — a new server with the owner setup wizard still open
      // =======================================================================
      const fresh = await createServer({ name: "Raft Workshop", slug: "workshop", owner: alex });
      await addMember(fresh.id, alex, "owner", {
        setupModalReminderOptOut: false,
        onboardingWizardCurrentStep: null,
        setupStatus: "not_started",
        setupCompletionReason: null,
        setupContractVersion: "onboarding-setup-v2",
      });
      await createMachine(fresh.id, { name: "MacBook Pro", hostname: "alex-macbook-pro", runtimes: ["claude"] });
      const fAll = await createChannel(fresh.id, "all", "General channel for all members", "private");
      const fOwner = await createChannel(fresh.id, "onboarding-owner", "Your private onboarding space", "private");
      await join(fAll, [A(alex)]);
      await join(fOwner, [A(alex)]);
    }

    // Server switcher order: the feature server first.
    const ordered = await db.select({ id: servers.id, slug: servers.slug }).from(servers)
      .where(and(inArray(servers.slug, ["raft-workshop", "raft-workshop-tutorial", "workshop"]), eq(servers.ownerId, alex.id)));
    const order = ["raft-workshop", "raft-workshop-tutorial", "workshop"]
      .map((slug) => ordered.find((row) => row.slug === slug)?.id)
      .filter((id): id is string => Boolean(id));
    await db.update(users).set({ serverSwitcherOrder: order }).where(eq(users.id, alex.id));

    // With RisingWave running, Alex's Activity must read the same from RW as
    // from Postgres (the screenshots of it come from RW).
    if (process.env.RISINGWAVE_DATABASE_URL) {
      const paritySlugs = onlyTutorial ? ["raft-workshop-tutorial"] : ["raft-workshop", "raft-workshop-tutorial"];
      for (const slug of paritySlugs) {
        const serverId = ordered.find((row) => row.slug === slug)?.id;
        if (serverId) verifyRisingWaveParity(serverId, alex.id, slug);
      }
    }

    const web = options.webUrl.replace(/\/$/, "");
    console.log("Docs screenshot fixture ready.");
    console.log(`Login: alex@example.com / ${PASSWORD}`);
    if (web) {
      console.log(`- features:   ${web}/s/raft-workshop`);
      console.log(`- tutorial:   ${web}/s/raft-workshop-tutorial`);
      console.log(`- onboarding: ${web}/s/workshop`);
    }
    if (!redis) console.log("Computers were left offline (no REDIS_URL or --no-fake-online).");
  } finally {
    redis?.disconnect();
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
