import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import { machines } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { SearchQueryAbortedError } from "../db/index";
import {
  buildOnboardingFunnelSql,
  classifyOnboardingFunnelFailure,
  onboardingFunnelSlotKey,
  parseOnboardingFunnelRows,
  recordMachineFirstConnected,
  runOnboardingFunnel,
  startMachineFirstConnectRecorder,
  summarizeOnboardingFunnel,
  type OnboardingFunnelServerRow,
} from "./onboardingFunnel";

const OWNER_1 = "11111111-1111-4111-8111-111111111111";
const OWNER_2 = "22222222-2222-4222-8222-222222222222";
const SERVER_A = "a0000000-0000-4000-8000-000000000001";
const SERVER_B = "b0000000-0000-4000-8000-000000000002";
const SERVER_C = "c0000000-0000-4000-8000-000000000003";
const SERVER_OLD = "d0000000-0000-4000-8000-000000000004";
const SERVER_JOINT = "e0000000-0000-4000-8000-000000000005";
const CHANNEL_A = "a1000000-0000-4000-8000-000000000001";
const MACHINE_A1 = "a2000000-0000-4000-8000-000000000001";
const MACHINE_A2 = "a2000000-0000-4000-8000-000000000002";
const AGENT_A = "a3000000-0000-4000-8000-000000000001";
const CINDY_A = "a3000000-0000-4000-8000-000000000002";
const AGENT_C = "c3000000-0000-4000-8000-000000000001";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function at(base: string, offsetMs: number): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

const A = "2026-10-10T10:00:00.000Z";
const C = "2026-10-10T23:00:00.000Z";

/**
 * A: owner 1's first server; a Computer added and connected, a hosted Cindy
 * that answers first, then the owner's own agent (opener, then a real reply).
 * B: owner 1's second server, nothing in it. C: owner 2's (an older server
 * outside the window exists), one agent that never ran. Plus a joint storage
 * server, which is not a cohort member.
 */
async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await client.exec(`
    INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
      ('${OWNER_1}', 'funnel-1@slock.test', 'funnel-1', 'test'),
      ('${OWNER_2}', 'funnel-2@slock.test', 'funnel-2', 'test');
    INSERT INTO "servers" ("id", "name", "slug", "owner_id", "kind", "created_at") VALUES
      ('${SERVER_A}', 'A', 'funnel-a', '${OWNER_1}', 'normal', '${A}'),
      ('${SERVER_B}', 'B', 'funnel-b', '${OWNER_1}', 'normal', '2026-10-11T00:00:00.000Z'),
      ('${SERVER_C}', 'C', 'funnel-c', '${OWNER_2}', 'normal', '${C}'),
      ('${SERVER_OLD}', 'Old', 'funnel-old', '${OWNER_2}', 'normal', '2026-09-01T00:00:00.000Z'),
      ('${SERVER_JOINT}', 'Joint', 'funnel-joint', '${OWNER_2}', 'joint_storage', '2026-10-12T00:00:00.000Z');
    INSERT INTO "channels" ("id", "server_id", "name") VALUES ('${CHANNEL_A}', '${SERVER_A}', 'general');
    INSERT INTO "daemons" ("id", "server_id", "user_id", "name", "api_key_hash", "created_at", "first_connected_at") VALUES
      ('${MACHINE_A1}', '${SERVER_A}', '${OWNER_1}', 'laptop', 'x', '${at(A, 5 * MIN)}', '${at(A, 20 * MIN)}'),
      ('${MACHINE_A2}', '${SERVER_A}', '${OWNER_1}', 'desktop', 'x', '${at(A, 2 * HOUR)}', NULL);
    INSERT INTO "agents" ("id", "server_id", "name", "created_at") VALUES
      ('${CINDY_A}', '${SERVER_A}', 'cindy', '${at(A, 1 * MIN)}'),
      ('${AGENT_A}', '${SERVER_A}', 'helper', '${at(A, 30 * MIN)}'),
      ('${AGENT_C}', '${SERVER_C}', 'helper', '${at(C, DAY + HOUR)}');
    INSERT INTO "agent_runtime_provisions" ("agent_id", "server_id", "provider", "state", "provisioned_name", "provisioned_instructions", "import_source")
      VALUES ('${CINDY_A}', '${SERVER_A}', 'antiproton', 'active', 'cindy', '', 'cindy_seed');
    INSERT INTO "agent_activity_events" ("id", "agent_id", "activity", "detail", "entries", "created_at") VALUES
      (gen_random_uuid(), '${CINDY_A}', 'thinking', '', '[]', '${at(A, 2 * MIN)}'),
      (gen_random_uuid(), '${AGENT_A}', 'online', '', '[]', '${at(A, 31 * MIN)}'),
      (gen_random_uuid(), '${AGENT_A}', 'thinking', '', '[]', '${at(A, 32 * MIN)}'),
      (gen_random_uuid(), '${AGENT_A}', 'working', '', '[]', '${at(A, 33 * MIN)}'),
      (gen_random_uuid(), '${AGENT_C}', 'online', '', '[]', '${at(C, DAY + 2 * HOUR)}');
    INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content", "agent_send_key", "created_at") VALUES
      (gen_random_uuid(), '${CHANNEL_A}', 'agent', '${CINDY_A}', 'hi', NULL, '${at(A, 3 * MIN)}'),
      (gen_random_uuid(), '${CHANNEL_A}', 'agent', '${AGENT_A}', 'opener', 'owner-opener-v2.0:${SERVER_A}:${OWNER_1}:intro', '${at(A, 31 * MIN)}'),
      (gen_random_uuid(), '${CHANNEL_A}', 'agent', '${AGENT_A}', 'hello', NULL, '${at(A, 35 * MIN)}'),
      (gen_random_uuid(), '${CHANNEL_A}', 'user', '${OWNER_1}', 'hey', NULL, '${at(A, 34 * MIN)}');
  `);
  return { client, db };
}

test("the funnel query derives each cohort server's milestones from the tables", async () => {
  const { client } = await fixture();
  try {
    const sqlText = buildOnboardingFunnelSql(new Date("2026-10-03T00:00:00.000Z"), new Date("2026-10-16T12:00:00.000Z"));
    const result = await client.query<Record<string, unknown>>(sqlText);
    const rows = parseOnboardingFunnelRows(result.rows)
      .sort((x, y) => (x.msToMilestone.first_agent_created ?? -1) - (y.msToMilestone.first_agent_created ?? -1)
        || x.cohortDay.localeCompare(y.cohortDay));
    assert.deepEqual(rows, [
      {
        cohortDay: "2026-10-11",
        ownerFirstServer: false,
        msToMilestone: {
          server_created: 0,
          computer_added: null,
          first_machine_connected: null,
          first_agent_created: null,
          first_agent_turn_started: null,
          first_agent_reply: null,
          first_result: null,
        },
      },
      {
        cohortDay: "2026-10-10",
        ownerFirstServer: true,
        msToMilestone: {
          server_created: 0,
          computer_added: 5 * MIN,
          first_machine_connected: 20 * MIN,
          // Hosted Cindy (created at +1 min, replying at +3) is not the owner's agent,
          // and the templated opener at +31 min is not a reply.
          first_agent_created: 30 * MIN,
          first_agent_turn_started: 32 * MIN,
          first_agent_reply: 35 * MIN,
          // No attachment and no finished task in this fixture.
          first_result: null,
        },
      },
      {
        // An older server outside the window still makes this not the owner's first.
        cohortDay: "2026-10-10",
        ownerFirstServer: false,
        msToMilestone: {
          server_created: 0,
          computer_added: null,
          first_machine_connected: null,
          first_agent_created: DAY + HOUR,
          first_agent_turn_started: null,
          first_agent_reply: null,
          first_result: null,
        },
      },
    ]);
  } finally {
    await client.close();
  }
});

const CHANNEL_B = "b1000000-0000-4000-8000-000000000001";
const CHANNEL_C = "c1000000-0000-4000-8000-000000000001";
const AGENT_B = "b3000000-0000-4000-8000-000000000001";
const BOT_A = "a3000000-0000-4000-8000-000000000003";
const INSTALL_A = "a4000000-0000-4000-8000-000000000001";
const B = "2026-10-11T00:00:00.000Z";

function messageId(n: number): string {
  return `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A chat message by an agent, with or without one attachment. */
function agentMessage(n: number, channelId: string, serverId: string, agentId: string, when: string, opts: { sendKey?: string; attach?: boolean } = {}): string {
  const id = messageId(n);
  const key = opts.sendKey ? `'${opts.sendKey}'` : "NULL";
  let sqlText = `
    INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content", "agent_send_key", "created_at")
      VALUES ('${id}', '${channelId}', 'agent', '${agentId}', 'm${n}', ${key}, '${when}');`;
  if (opts.attach) {
    const objectId = `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    sqlText += `
    INSERT INTO "attachment_objects" ("id", "origin_server_id", "uploader_id", "uploader_type", "storage_key", "mime_type", "size_bytes")
      VALUES ('${objectId}', '${serverId}', '${agentId}', 'agent', 'k${n}', 'text/plain', 1);
    INSERT INTO "attachments" ("id", "object_id", "message_id", "channel_id", "uploader_id", "uploader_type", "filename", "created_at")
      VALUES (gen_random_uuid(), '${objectId}', '${id}', '${channelId}', '${agentId}', 'agent', 'f${n}.txt', '${when}');`;
  }
  return sqlText;
}

/** A task in the channel and one event on it. */
function taskEvent(n: number, channelId: string, creatorId: string, event: { type: string; actorType: string; actorId: string; to: string; when: string }): string {
  const taskId = `f2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return `
    INSERT INTO "tasks" ("id", "channel_id", "task_number", "title", "created_by_type", "created_by_id")
      VALUES ('${taskId}', '${channelId}', ${n}, 't${n}', 'user', '${creatorId}');
    INSERT INTO "task_events" ("id", "task_id", "event_type", "actor_type", "actor_id", "payload", "created_at")
      VALUES (gen_random_uuid(), '${taskId}', '${event.type}', '${event.actorType}', '${event.actorId}', '{"from":"in_progress","to":"${event.to}","forced":false}', '${event.when}');`;
}

test("first_result is the own agents' first attached message or first finished task, whichever came first", async () => {
  const { client } = await fixture();
  try {
    await client.exec(`
      INSERT INTO "channels" ("id", "server_id", "name") VALUES
        ('${CHANNEL_B}', '${SERVER_B}', 'general'), ('${CHANNEL_C}', '${SERVER_C}', 'general');
      INSERT INTO "agents" ("id", "server_id", "name", "created_at") VALUES
        ('${AGENT_B}', '${SERVER_B}', 'helper', '${at(B, 1 * MIN)}');
      -- An app-managed bot in A. The install row is beside the point here, so its foreign key is not checked.
      SET session_replication_role = replica;
      INSERT INTO "agents" ("id", "server_id", "name", "created_at", "managed_by_app_install_id") VALUES
        ('${BOT_A}', '${SERVER_A}', 'bot', '${at(A, 2 * MIN)}', '${INSTALL_A}');
      SET session_replication_role = DEFAULT;
      ${[
        // A: none of the first four count (hosted Cindy, an app-managed bot, the owner opener, a person finishing a task).
        agentMessage(1, CHANNEL_A, SERVER_A, CINDY_A, at(A, 4 * MIN), { attach: true }),
        agentMessage(2, CHANNEL_A, SERVER_A, BOT_A, at(A, 10 * MIN), { attach: true }),
        agentMessage(3, CHANNEL_A, SERVER_A, AGENT_A, at(A, 31 * MIN), { attach: true, sendKey: `owner-opener-v2.0:${SERVER_A}:${OWNER_1}:files` }),
        taskEvent(1, CHANNEL_A, OWNER_1, { type: "status_changed", actorType: "user", actorId: OWNER_1, to: "done", when: at(A, 36 * MIN) }),
        // ...nor does the agent moving a task somewhere other than done, or a reply with no attachment.
        taskEvent(2, CHANNEL_A, OWNER_1, { type: "status_changed", actorType: "agent", actorId: AGENT_A, to: "in_progress", when: at(A, 37 * MIN) }),
        agentMessage(4, CHANNEL_A, SERVER_A, AGENT_A, at(A, 37 * MIN)),
        // A has both: the task finished at +38 min comes before the attachment at +40.
        taskEvent(3, CHANNEL_A, OWNER_1, { type: "status_changed", actorType: "agent", actorId: AGENT_A, to: "done", when: at(A, 38 * MIN) }),
        agentMessage(5, CHANNEL_A, SERVER_A, AGENT_A, at(A, 40 * MIN), { attach: true }),
        // B: an attachment only, twice; the first one counts.
        agentMessage(6, CHANNEL_B, SERVER_B, AGENT_B, at(B, 10 * MIN), { attach: true }),
        agentMessage(7, CHANNEL_B, SERVER_B, AGENT_B, at(B, 20 * MIN), { attach: true }),
        // C: a finished task only (a reopened task put back to done counts the same).
        taskEvent(4, CHANNEL_C, OWNER_2, { type: "reopened", actorType: "agent", actorId: AGENT_C, to: "done", when: at(C, DAY + 3 * HOUR) }),
      ].join("\n")}
    `);
    const sqlText = buildOnboardingFunnelSql(new Date("2026-10-03T00:00:00.000Z"), new Date("2026-10-16T12:00:00.000Z"));
    const rows = parseOnboardingFunnelRows((await client.query<Record<string, unknown>>(sqlText)).rows);
    assert.equal(rows.length, 3);
    const byDay = (day: string, first: boolean) => rows.find((row) => row.cohortDay === day && row.ownerFirstServer === first)?.msToMilestone;
    const a = byDay("2026-10-10", true);
    assert.equal(a?.first_result, 38 * MIN);
    // The stricter milestone leaves the reply where it was (the bot's and Cindy's messages are not replies either).
    assert.equal(a?.first_agent_reply, 35 * MIN);
    assert.equal(byDay("2026-10-11", false)?.first_result, 10 * MIN);
    assert.equal(byDay("2026-10-10", false)?.first_result, DAY + 3 * HOUR);
  } finally {
    await client.close();
  }
});

test("first_connected_at is written once; a reconnect keeps the first time", async () => {
  const { client, db } = await fixture();
  try {
    await recordMachineFirstConnected(MACHINE_A2, db);
    const [first] = await db.select({ at: machines.firstConnectedAt }).from(machines).where(eq(machines.id, MACHINE_A2));
    assert.ok(first?.at);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordMachineFirstConnected(MACHINE_A2, db);
    await recordMachineFirstConnected(MACHINE_A1, db);
    const rows = await db.select({ id: machines.id, at: machines.firstConnectedAt }).from(machines);
    const byId = new Map(rows.map((row) => [row.id, row.at?.toISOString()]));
    assert.equal(byId.get(MACHINE_A2), first.at.toISOString());
    assert.equal(byId.get(MACHINE_A1), at(A, 20 * MIN));
  } finally {
    await client.close();
  }
});

function server(cohortDay: string, ownerFirstServer: boolean, reply: number | null): OnboardingFunnelServerRow {
  return {
    cohortDay,
    ownerFirstServer,
    msToMilestone: {
      server_created: 0,
      computer_added: null,
      first_machine_connected: null,
      first_agent_created: null,
      first_agent_turn_started: null,
      first_agent_reply: reply,
      first_result: null,
    },
  };
}

test("aggregates count reach by window; percentiles cover only servers that reached the milestone", () => {
  const rows = [
    server("2026-10-10", true, 10 * MIN),
    server("2026-10-10", true, 2 * HOUR),
    server("2026-10-10", true, 3 * DAY),
    server("2026-10-10", true, null),
    server("2026-10-10", false, 5 * MIN),
  ];
  const aggregates = summarizeOnboardingFunnel(rows);
  // 2 cohorts x 7 milestones, no server ids anywhere.
  assert.equal(aggregates.length, 14);
  assert.ok(aggregates.every((row) => !Object.keys(row).some((key) => key.includes("server_id"))));
  const reply = aggregates.find((row) => row.owner_first_server && row.milestone === "first_agent_reply");
  assert.deepEqual(reply, {
    cohort_day: "2026-10-10",
    owner_first_server: true,
    milestone: "first_agent_reply",
    cohort_size: 4,
    reached: 3,
    reached_1h: 1,
    reached_24h: 2,
    reached_7d: 3,
    p50_ms: 2 * HOUR,
    p90_ms: Math.round(2 * HOUR + (3 * DAY - 2 * HOUR) * 0.8),
  });
  const created = aggregates.find((row) => row.owner_first_server && row.milestone === "server_created");
  assert.equal(created?.reached, 4);
  const connected = aggregates.find((row) => !row.owner_first_server && row.milestone === "first_machine_connected");
  assert.deepEqual([connected?.reached, connected?.p50_ms, connected?.p90_ms], [0, 0, 0]);
});

test("slots are UTC 6-hour buckets", () => {
  assert.equal(onboardingFunnelSlotKey(new Date("2026-10-16T05:59:59.000Z")), "2026-10-16T00");
  assert.equal(onboardingFunnelSlotKey(new Date("2026-10-16T06:00:00.000Z")), "2026-10-16T06");
  assert.equal(onboardingFunnelSlotKey(new Date("2026-10-16T23:10:00.000Z")), "2026-10-16T18");
});

function tracer() {
  const sink = new MemoryTraceSink();
  return { sink, tracer: new BasicTracer({ sink }) };
}

test("a run claims its slot, queries the last 14 days of cohorts and emits one event per aggregate", async () => {
  const { sink, tracer: t } = tracer();
  const claimed: string[] = [];
  const queries: string[] = [];
  const result = await runOnboardingFunnel({
    now: () => new Date("2026-10-16T19:30:00.000Z"),
    claimSlot: async (slot) => { claimed.push(slot); return true; },
    queryPg: async (sqlText) => {
      queries.push(sqlText);
      return [{ cohort_day: "2026-10-16", owner_first_server: true, replied_ms: 1234.4, result_ms: 5678.6 }];
    },
    tracer: t,
  });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(claimed, ["2026-10-16T18"]);
  assert.match(queries[0]!, /s\.created_at >= '2026-10-03T00:00:00\.000Z'::timestamptz AND s\.created_at < '2026-10-16T19:30:00\.000Z'::timestamptz/);
  const events = sink.getAllLogEvents().filter((e) => e.name === "server.onboarding.funnel");
  assert.equal(events.length, 7);
  assert.deepEqual(events.find((e) => e.attrs?.milestone === "first_agent_reply")?.attrs, {
    cohort_day: "2026-10-16",
    owner_first_server: true,
    milestone: "first_agent_reply",
    cohort_size: 1,
    reached: 1,
    reached_1h: 1,
    reached_24h: 1,
    reached_7d: 1,
    p50_ms: 1234,
    p90_ms: 1234,
    slot: "2026-10-16T18",
  });
  const firstResult = events.find((e) => e.attrs?.milestone === "first_result")?.attrs;
  assert.deepEqual([firstResult?.reached, firstResult?.p50_ms], [1, 5679]);
});

test("a failure names its path, reason and SQLSTATE, never the message", () => {
  // Drizzle wraps the pg error, without a name, and puts the SQL in the message.
  const drizzleWrapped = (cause: unknown) => Object.assign(new Error("Failed query: WITH cohort AS (...)"), { cause });
  assert.deepEqual(
    classifyOnboardingFunnelFailure(drizzleWrapped(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }))),
    { reason: "statement_timeout", sqlstate: "57014" },
  );
  assert.deepEqual(classifyOnboardingFunnelFailure(new SearchQueryAbortedError()), { reason: "aborted", sqlstate: "" });
  assert.deepEqual(
    classifyOnboardingFunnelFailure(drizzleWrapped(Object.assign(new Error("relation does not exist"), { code: "42P01" }))),
    { reason: "query_error", sqlstate: "42P01" },
  );
  assert.deepEqual(classifyOnboardingFunnelFailure(Object.assign(new Error("x"), { code: "ECONNRESET" })), { reason: "other", sqlstate: "" });
  assert.deepEqual(classifyOnboardingFunnelFailure("boom"), { reason: "other", sqlstate: "" });
});

test("another replica's claim skips the run; a failed query emits no aggregates", async () => {
  const { sink, tracer: t } = tracer();
  let queried = false;
  const skipped = await runOnboardingFunnel({
    claimSlot: async () => false,
    queryPg: async () => { queried = true; return []; },
    tracer: t,
  });
  assert.equal(skipped.outcome, "skipped_claimed");
  assert.equal(queried, false);

  const failed = await runOnboardingFunnel({
    claimSlot: async () => true,
    queryPath: "primary",
    queryPg: async () => {
      throw Object.assign(new Error("Failed query: WITH cohort AS (...)"), { cause: Object.assign(new Error("timeout"), { code: "57014" }) });
    },
    tracer: t,
  });
  assert.equal(failed.outcome, "error");
  assert.equal(sink.getAllLogEvents().filter((e) => e.name === "server.onboarding.funnel").length, 0);
  const span = sink.getAllSpans().find((s) => s.name === "server.onboarding_funnel.compute");
  assert.equal(span?.status, "error");
  assert.deepEqual(
    [span?.attrs?.path, span?.attrs?.reason, span?.attrs?.sqlstate, span?.attrs?.error_class],
    ["primary", "statement_timeout", "57014", "Error"],
  );
  assert.ok(!JSON.stringify(span?.attrs).includes("WITH cohort"));
});

test("machine:online stamps the machine; a failed write never throws into the reconnect", async () => {
  const orchestrator = new EventEmitter();
  const recorded: string[] = [];
  const stop = startMachineFirstConnectRecorder({
    orchestrator: orchestrator as unknown as AgentOrchestrator,
    record: async (machineId) => {
      recorded.push(machineId);
      if (machineId === "bad") throw new Error("db down");
    },
  });
  orchestrator.emit("machine:online", { machineId: MACHINE_A1, serverId: SERVER_A });
  orchestrator.emit("machine:online", { machineId: "bad", serverId: SERVER_A });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(recorded, [MACHINE_A1, "bad"]);
  stop();
  orchestrator.emit("machine:online", { machineId: MACHINE_A2, serverId: SERVER_A });
  assert.deepEqual(recorded, [MACHINE_A1, "bad"]);
});
