/**
 * Benchmark: GET /api/messages/channel/:channelId page-load path.
 *
 * Run: npx tsx packages/server/scripts/perf/messagePageBench.ts
 *
 * Seeds an in-memory PGlite database with N messages in a single channel,
 * mixed user and agent senders, some with attachments, then exercises
 * `listMessages` (the handler's hot path). This isolates the enrichment +
 * attachment + membership lookup cost from Express/socket overhead so any
 * query-count regression is unambiguous.
 *
 * The path under test today calls, per page request:
 *   1. SELECT messages WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT N
 *   2. (if any user senders) SELECT users WHERE id IN (...)
 *   3. (if any user senders) SELECT channels WHERE id IN (...)
 *   4. (if any user senders) SELECT server_members WHERE server_id IN (...) AND user_id IN (...)
 *   5. (if any agent senders) SELECT agents WHERE id IN (...)
 *   6. SELECT attachments WHERE message_id IN (...)
 *
 * Total: at most 6 queries, independent of page size N. This bench prints
 * per-call latency at scales 100 / 500 / 1000 so any future change that
 * flips a per-message query back into the loop shows up as O(N) growth
 * in the latency curve before it surfaces in Telescope.
 */
import { initDatabase, getDb, closeDatabase } from "../../src/db/index.js";
import {
  users,
  servers,
  serverMembers,
  channels,
  channelHumans,
  channelAgents,
  agents,
  messages,
  attachments,
} from "../../src/db/schema.js";
import { listMessages } from "../../src/services/messageService.js";

type Scale = { label: string; messages: number };

const SCALES: Scale[] = [
  { label: "N=100", messages: 100 },
  { label: "N=500", messages: 500 },
  { label: "N=1000", messages: 1000 },
];

// Sender mix, applied uniformly across seeded messages:
//   60% user-typed (split across 3 distinct user senders)
//   30% agent-typed (split across 2 distinct agent senders)
//   10% with an attachment (always image/png, fixed size)
const USER_SENDER_IDS = [
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3",
];
const AGENT_SENDER_IDS = [
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
];
const OWNER_USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SERVER_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const CHANNEL_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

async function seed(messageCount: number) {
  const db = getDb();

  // One server owner — also a server member so the membership batch returns rows.
  await db.insert(users).values({
    id: OWNER_USER_ID,
    email: "owner@bench.local",
    name: "owner",
    passwordHash: "h",
    emailVerified: true,
  });
  for (const id of USER_SENDER_IDS) {
    await db.insert(users).values({
      id,
      email: `${id.slice(-4)}@bench.local`,
      name: `user-${id.slice(-4)}`,
      passwordHash: "h",
      emailVerified: true,
    });
  }

  await db.insert(servers).values({
    id: SERVER_ID,
    name: "Bench",
    slug: "bench-message-page",
    ownerId: OWNER_USER_ID,
  });
  for (const userId of [OWNER_USER_ID, ...USER_SENDER_IDS]) {
    await db.insert(serverMembers).values({
      serverId: SERVER_ID,
      userId,
      role: userId === OWNER_USER_ID ? "owner" : "member",
    });
  }

  // Agents — batched to avoid N inserts when we grow the sender set later.
  await db.insert(agents).values(
    AGENT_SENDER_IDS.map((id, i) => ({
      id,
      serverId: SERVER_ID,
      name: `agent-${i}`,
      displayName: `Agent ${i}`,
      status: "inactive" as const,
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc" as const,
    })),
  );

  await db.insert(channels).values({
    id: CHANNEL_ID,
    serverId: SERVER_ID,
    name: "bench",
    type: "channel",
  });
  // channelHumans + channelAgents so `canUserAccessChannel` and membership
  // resolution see the senders as channel members (not strictly required for
  // `listMessages`, but keeps the fixture faithful to the real route).
  await db.insert(channelHumans).values(
    [OWNER_USER_ID, ...USER_SENDER_IDS].map((userId) => ({
      channelId: CHANNEL_ID,
      userId,
    })),
  );
  await db.insert(channelAgents).values(
    AGENT_SENDER_IDS.map((agentId) => ({
      channelId: CHANNEL_ID,
      agentId,
    })),
  );

  // Build message rows in one batch. Drizzle's `values(rows)` issues a single
  // multi-row INSERT — fine for N=1000.
  const rows: typeof messages.$inferInsert[] = [];
  for (let i = 0; i < messageCount; i++) {
    const mod = i % 10;
    const isAgent = mod >= 6 && mod < 9;
    const senderType: "user" | "agent" = isAgent ? "agent" : "user";
    const senderId = isAgent
      ? AGENT_SENDER_IDS[i % AGENT_SENDER_IDS.length]!
      : USER_SENDER_IDS[i % USER_SENDER_IDS.length]!;
    rows.push({
      channelId: CHANNEL_ID,
      senderType,
      senderId,
      messageType: "chat",
      content: `bench message ${i}`,
    });
  }
  const inserted = await db.insert(messages).values(rows).returning({ id: messages.id, seq: messages.seq });

  // 10% of messages get an attachment. Linked rows push
  // `getAttachmentsForMessages` onto the hot path.
  const attachmentRows: typeof attachments.$inferInsert[] = [];
  for (let i = 0; i < inserted.length; i++) {
    if (i % 10 !== 0) continue;
    attachmentRows.push({
      messageId: inserted[i]!.id,
      channelId: CHANNEL_ID,
      uploaderId: OWNER_USER_ID,
      uploaderType: "user",
      filename: `bench-${i}.png`,
      mimeType: "image/png",
      sizeBytes: 1024,
      storageKey: `bench/${i}.png`,
    });
  }
  if (attachmentRows.length > 0) {
    await db.insert(attachments).values(attachmentRows);
  }

  return { channelId: CHANNEL_ID, seededMessageCount: inserted.length };
}

function formatMs(ms: number): string {
  return ms.toFixed(1).padStart(8);
}

async function main() {
  await initDatabase("pglite://");
  for (const scale of SCALES) {
    await closeDatabase();
    await initDatabase("pglite://");
    const { channelId, seededMessageCount } = await seed(scale.messages);

    // Page size mirrors the route's default (limit=50). Any change to `listMessages`
    // that, for example, drops the attachment batch and calls `getAttachmentsForMessages`
    // per message will show up here as the page-load latency climbs with N.
    const PAGE_LIMIT = 50;

    // Warm run: pglite compiles/loads statements on first exec.
    await listMessages(channelId, PAGE_LIMIT);

    const REPS = 10;
    const latenciesMs: number[] = [];
    for (let i = 0; i < REPS; i++) {
      const t0 = performance.now();
      const page = await listMessages(channelId, PAGE_LIMIT);
      const t1 = performance.now();
      latenciesMs.push(t1 - t0);
      if (page.length !== Math.min(PAGE_LIMIT, seededMessageCount)) {
        throw new Error(
          `page size mismatch: got ${page.length} expected ${Math.min(PAGE_LIMIT, seededMessageCount)}`,
        );
      }
    }
    latenciesMs.sort((a, b) => a - b);
    const p50 = latenciesMs[Math.floor(REPS * 0.5)]!;
    const p95 = latenciesMs[Math.floor(REPS * 0.95)]!;
    const min = latenciesMs[0]!;
    const max = latenciesMs[REPS - 1]!;
    console.log(
      `${scale.label.padEnd(8)} seeded=${seededMessageCount.toString().padStart(5)}  ` +
      `page=${PAGE_LIMIT}  min=${formatMs(min)}ms  p50=${formatMs(p50)}ms  ` +
      `p95=${formatMs(p95)}ms  max=${formatMs(max)}ms`,
    );
  }
  await closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
