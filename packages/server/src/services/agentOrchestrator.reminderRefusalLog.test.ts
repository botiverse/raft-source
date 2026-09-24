import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";

import { getDb } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import { createReminder } from "../apps/reminder/service.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import type { MachineToServerMessage } from "@botiverse/raft-shared";


/**
 * The refusal branch of `reminder.fire_receipt` is the ONLY place that reports
 * machineId, sourceId, reason, now and dueAt together. It is the entry point
 * for diagnosing the #674 class of bug -- a Computer asking the Server to fire
 * something that is not due yet -- and until this file existed the repository
 * had ZERO checked-in assertions on it: every one of those five fields could be
 * deleted and CI stayed green (@Hipp's controlled search, task #224).
 *
 * That is not hypothetical. While fixing an app-name-ratchet red on #6247 the
 * author of this test deleted the entire warn call to make the gate go green,
 * taking machineId and two of the three refusal reasons with it; it was caught
 * by human review, not by any check. This file is that check.
 *
 * ⚠️ ASSERT VALUES, NEVER WORDING. The phrasing of this log is governed by the
 * app-name-ratchet (an OS-layer file may not name an app), so a reviewer
 * rewording it must NOT redden this test -- that would be a false red pushing
 * people to fight two gates at once. Field presence is the contract here;
 * wording is the other gate's contract.
 */

afterEach(async () => {
  await closeTestDatabase();
});

const MACHINE_ID = "machine-refusal-log";
const DUE_AT = new Date("2099-01-01T00:00:00.000Z"); // far future => refused as premature

async function seed() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-4111-8111-1111111111aa",
    email: "refusal-log-owner@example.com",
    name: "Refusal Log Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-4222-8222-2222222222aa",
    name: "Refusal Log Server",
    slug: "refusal-log-server",
    ownerId: user.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    id: "33333333-3333-4333-8333-3333333333aa",
    serverId: server.id,
    name: "refusal-log-agent",
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();
  return { user, server, agent };
}

function fireReceipt(agentId: string, reminderId: string, version: number): MachineToServerMessage {
  return {
    type: "reminder.fire_receipt",
    agentId,
    reminderId,
    version,
    firedAtClient: new Date().toISOString(),
    catchup: false,
  };
}

/** Fails naming the field that vanished, and shows what was actually logged. */
function assertCarries(payload: string, field: string, value: string) {
  assert.ok(
    payload.includes(value),
    `refusal log dropped the "${field}" field: expected the payload to carry `
    + `${JSON.stringify(value)}, but got: ${JSON.stringify(payload)}`,
  );
}

test("a refused fire receipt logs machineId, sourceId, reason, now and dueAt", async ({ db }) => {

  const { user, server, agent } = await seed();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "not due for decades",
    fireAt: DUE_AT,
    payload: null,
    createdBy: { type: "human", id: user.id },
  });

  const orchestrator = new AgentOrchestrator();
  (orchestrator as unknown as {
    validateMachineAgentMessage: () => Promise<{ id: string; serverId: string }>;
  }).validateMachineAgentMessage = async () => agent;

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

  const before = Date.now();
  try {
    await orchestrator.handleMachineMessage(
      MACHINE_ID,
      fireReceipt(agent.id, reminder.id, reminder.version),
    );
  } finally {
    console.warn = realWarn;
  }
  const after = Date.now();

  // Deliberately do NOT select the line by any field under test. Keying the
  // lookup on e.g. the reminder id or the reason would mean that deleting THAT
  // field fails with "no log emitted" instead of naming the field that went
  // missing -- the acceptance for this tooth is that each deletion reddens
  // while quoting the field it lost.
  // Two warnings reach here: the owning app service logs the premature case
  // first, then this OS layer logs the refusal. Take the LAST one -- selecting
  // by position keeps the lookup independent of every field under test, so a
  // deleted field reddens by NAME below instead of collapsing into a
  // "no log found" failure. (If the OS-layer line were deleted outright, the
  // service line remains and carries no machineId, so that assertion still
  // names the field that went missing.)
  assert.ok(
    warnings.length >= 1,
    `no refusal log was emitted for a not-yet-due fire; console.warn saw: ${JSON.stringify(warnings)}`,
  );
  const payload = warnings[warnings.length - 1];

  assertCarries(payload, "machineId", MACHINE_ID);
  assertCarries(payload, "sourceId", reminder.id);
  assertCarries(payload, "reason", "premature_fire");
  assertCarries(payload, "dueAt", DUE_AT.toISOString());

  // `now` is real wall-clock, so pin it as a value in the window the call
  // occupied rather than as a literal -- still field presence, not wording.
  const stamps = (payload.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [])
    .filter((s) => s !== DUE_AT.toISOString())
    .map((s) => Date.parse(s));
  assert.ok(
    stamps.some((t) => t >= before - 1000 && t <= after + 1000),
    `refusal log dropped the "now" field: expected an ISO timestamp inside `
    + `[${new Date(before).toISOString()}, ${new Date(after).toISOString()}], `
    + `but got: ${JSON.stringify(payload)}`,
  );
});

/**
 * TOOTH ② — refusal-handling correctness (task #792, scope added by @Huaihuai).
 * Reported SEPARATELY from tooth ④ above: one guards the diagnostic FIELDS, this
 * guards the BRANCH. "We have teeth on the refusal path" would hide that they
 * protect different things.
 *
 * Guarded byte: `if (!result.ok)` in the reminder.fire_receipt handler. A refusal
 * is an OBJECT and therefore truthy, so reverting to `if (result)` sends a refusal
 * down the success branch, where `result.row` is undefined and the handler reads
 * `fired.ownerAgentId` off it -- a TypeError swallowed by the receipt try/catch
 * and recorded as outcome `convergence_failed`.
 *
 * ⚠️ The red must land on THAT, not on a compile error: this asserts observable
 * behaviour (no convergence failure, no lifecycle emit, no schedule push), so the
 * mutation reddens as functional breakage exactly as it would in production.
 */
test("a refused fire receipt is not handled as a success", async ({ db }) => {

  const { user, server, agent } = await seed();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "refusal must not be mistaken for a fire",
    fireAt: DUE_AT,
    payload: null,
    createdBy: { type: "human", id: user.id },
  });

  const orchestrator = new AgentOrchestrator();
  (orchestrator as unknown as {
    validateMachineAgentMessage: () => Promise<{ id: string; serverId: string }>;
  }).validateMachineAgentMessage = async () => agent;

  const traceOutcomes: string[] = [];
  (orchestrator as unknown as {
    recordBuiltInAppTrace: (name: string, attrs: Record<string, unknown>, level?: string) => void;
  }).recordBuiltInAppTrace = (_name, attrs) => {
    if (typeof attrs.outcome === "string") traceOutcomes.push(attrs.outcome);
  };

  let upserts = 0;
  let cancels = 0;
  orchestrator.pushReminderUpsert = async () => { upserts += 1; return true; };
  orchestrator.pushReminderCancel = async () => { cancels += 1; return true; };

  const emitted: string[] = [];
  (orchestrator as unknown as { io: unknown }).io = {
    to: () => ({ emit: (event: string) => { emitted.push(event); } }),
  };

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    await orchestrator.handleMachineMessage(
      MACHINE_ID,
      fireReceipt(agent.id, reminder.id, reminder.version),
    );
  } finally {
    console.warn = realWarn;
  }

  // PRESENCE ANCHOR, and the reason this test is not purely absence-based.
  // Every other assertion here says "X did not happen", which is also true when
  // the guarded path never executed at all -- a routing change, a receipt-shape
  // change, or stub drift would leave this tooth green while protecting nothing.
  // A refused fire always emits at least one warning, so this pins that the
  // refusal path actually ran. (@Hipp, review of task #792.)
  assert.ok(
    warnings.length >= 1,
    "the refusal path never executed: no warning was emitted, so the assertions "
    + "below would pass vacuously rather than because a refusal was handled correctly",
  );

  assert.ok(
    !traceOutcomes.includes("convergence_failed"),
    "a refused fire was handled as a success: the success branch read an undefined row "
    + `and the receipt handler recorded a convergence failure. Trace outcomes: ${JSON.stringify(traceOutcomes)}`,
  );
  assert.equal(emitted.filter((e) => e === "reminder:fired").length, 0,
    "a refused fire must not emit the reminder:fired lifecycle event");
  assert.equal(upserts, 0, "a refused fire must not push a schedule upsert");
  assert.equal(cancels, 0, "a refused fire must not push a schedule cancel");
});
