import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import { jointChannels, jointChannelServers, reminders, threadFollows, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createMessage } from "../services/messageService.js";
import * as channelService from "../services/channelService.js";
import {
  fireReminder,
  getReminderById,
  replaceReminder,
  type ReminderRow,
} from "../apps/reminder/service.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * These route tests create reminders through the HTTP surface, so their fireAt
 * is legitimately in the future. Firing one directly is scaffolding for a later
 * state, not a claim that it is due -- and the server now independently checks
 * dueness (task #674), so the scaffolding has to make it genuinely due.
 *
 * We move the row's fireAt into the past rather than handing fireReminder a
 * future clock: a future clock also timestamps the `fired` event, which
 * reorders the reminder event log relative to the surrounding real-time
 * snooze/update events and breaks assertions that read that order.
 */
async function makeDue(reminderId: string) {
  await getDb()
    .update(reminders)
    .set({ fireAt: new Date(Date.now() - 1_000) })
    .where(eq(reminders.id, reminderId));
  const refreshed = await getReminderById(reminderId);
  assert.ok(refreshed);
  return refreshed;
}

/**
 * Unwrap a fire that must have succeeded. Fails loudly, naming the refusal
 * reason, instead of surfacing as `undefined is not an object` three lines
 * later. (task #674)
 */
function firedOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const reason = (result as { reason?: string }).reason ?? "unknown";
    throw new Error(`expected a fire, got refusal: ${reason}`);
  }
  return result as Extract<T, { ok: true }>;
}

test("reminder route families bind CRUD to the App-owned service and sync lifecycle revisions to Computer", () => {
  for (const routeFile of ["./internal.ts", "./internalAgentApi.ts"]) {
    const source = readFileSync(new URL(routeFile, import.meta.url), "utf8");
    const operations = [
      "createAppReminder",
      "cancelAppReminder",
      "snoozeAppReminder",
      "updateAppReminder",
      "listAppReminders",
      "getAppReminderById",
    ];
    operations.push(routeFile === "./internalAgentApi.ts"
      ? "listAppReminderEventsForOwner"
      : "listAppReminderEvents");
    for (const operation of operations) {
      assert.match(source, new RegExp(`reminderCrud\\.${operation}\\(`), `${routeFile} must use ${operation}`);
    }
    if (routeFile === "./internalAgentApi.ts") {
      assert.match(source, /reminderCrud\.resolveAppHistoricalReminderIdForOwner\(/);
      const logRouteStart = source.indexOf('registerAgentApiRoute("reminderLog"');
      const nextRouteStart = source.indexOf("\nregisterAgentApiRoute(", logRouteStart + 1);
      const logRouteSource = source.slice(logRouteStart, nextRouteStart);
      assert.doesNotMatch(
        logRouteSource,
        /loadOwnedReminder\(/,
        "historical source actions must not require ownership of the current reminder row",
      );
    }
    assert.doesNotMatch(
      source,
      /reminderService\.(?:createReminder|cancelReminder|snoozeReminder|updateReminder|listReminders|listReminderEvents|getReminderById)\(/,
      `${routeFile} must not bypass the App-owned CRUD boundary`,
    );
    assert.match(source, /pushReminderUpsert\(/, `${routeFile} must sync scheduled revisions`);
    assert.match(source, /pushReminderCancel\(/, `${routeFile} must sync canceled revisions`);
    assert.equal(
      source.match(/expectedVersion: existing\.version/g)?.length,
      3,
      `${routeFile} must bind cancel, snooze, and update to the caller-observed row version`,
    );
  }
});

// Agent-facing write path emits live Reminders-tab updates via socket. This
// pairs the server contract with the new human-facing tab on agent profile
// (AgentRemindersTab) so `reminder:scheduled` and `reminder:canceled` don't
// quietly regress without a test catching it.

interface EmittedEvent {
  room: string;
  event: string;
  payload: unknown;
}

function installFakeIo(app: { set: (k: string, v: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  const fakeIo = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
  };
  app.set("io", fakeIo);
  return events;
}

function installReminderOrchestratorStub(app: {
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
}): { upserts: Array<{ agentId: string; row: ReminderRow }>; cancels: Array<{ agentId: string; reminderId: string; version: number }> } {
  const existing = (app.get("agentOrchestrator") as Record<string, unknown>) ?? {};
  const upserts: Array<{ agentId: string; row: ReminderRow }> = [];
  const cancels: Array<{ agentId: string; reminderId: string; version: number }> = [];
  app.set("agentOrchestrator", {
    ...existing,
    pushReminderUpsert: (agentId: string, row: ReminderRow) => {
      upserts.push({ agentId, row });
      return true;
    },
    pushReminderCancel: (agentId: string, reminderId: string, version: number) => {
      cancels.push({ agentId, reminderId, version });
      return true;
    },
  });
  return { upserts, cancels };
}

async function seed() {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "internal-reminders-owner@slock.test",
      name: "internal-reminders-owner",
      displayName: "Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  const server = await createServer("Internal Reminders", "internal-reminders", owner.id);
  const agent = await createAgent(server.id, "r-agent", { runtime: "claude" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "dev-machine");
  await assignMachine(agent.id, machine.id);
  const [channel] = await channelService.listChannels(server.id);
  const anchor = await createMessage(channel.id, "user", owner.id, "anchor reminder here");
  return { owner, server, agent, machine, apiKey, anchorId: anchor.id };
}

async function seedHiddenReminderAnchor(input: { owner: { id: string }; server: { id: string } }) {
  const hiddenChannel = await channelService.createChannel(
    input.server.id,
    "hidden-reminder-anchor",
    "owner-only reminder anchor",
    "private",
  );
  await channelService.addHuman(hiddenChannel.id, input.owner.id);
  return createMessage(hiddenChannel.id, "user", input.owner.id, "private reminder anchor");
}

async function seedJointReminderAnchor(input: { server: { id: string }; agent: { id: string } }) {
  const db = getDb();
  const [hostOwner] = await db.insert(users).values({
    email: "joint-reminder-host@slock.test",
    name: "joint-reminder-host",
    displayName: "Joint Reminder Host",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const hostServer = await createServer("Joint Reminder Host", "joint-reminder-host", hostOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, "joint-reminder-storage", undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, "Github-Runner运维", undefined, "joint");
  const localProjection = await channelService.createChannel(input.server.id, "Github-Runner运维", undefined, "joint");
  await channelService.addAgent(localProjection.id, input.agent.id);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: input.server.id,
      localChannelId: localProjection.id,
      role: "participant",
      joinedByUserId: null,
    },
  ]);

  return createMessage(canonical.id, "user", hostOwner.id, "joint reminder anchor");
}

function machineHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function agentApiKey(agentId: string): Promise<string> {
  const minted = await mintAgentCredential({
    agentId,
    scopes: ["read", "tasks"],
    name: "internal-reminders-agent-api",
    createdByUserId: null,
  });
  return minted.apiKey;
}

function agentHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

test("POST /internal/agent/:id/reminders emits reminder:scheduled on the server room", async ({ app }) => {
  const { server, agent, apiKey, anchorId } = await seed();
  const sync = installReminderOrchestratorStub(app.app);
  const events = installFakeIo(app.app);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({
      title: "standup",
      delaySeconds: 60,
      msgId: anchorId,
    }),
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}`);
  const body = (await res.json()) as { reminder: { reminderId: string; ownerAgentId: string } };
  assert.equal(body.reminder.ownerAgentId, agent.id);

  const scheduledEvents = events.filter((e) => e.event === "reminder:scheduled");
  assert.equal(scheduledEvents.length, 1, "expected exactly one reminder:scheduled event");
  const [evt] = scheduledEvents;
  assert.equal(evt.room, `server:${server.id}`);
  const payload = evt.payload as { reminder: { reminderId: string; ownerAgentId: string; title: string } };
  assert.equal(payload.reminder.reminderId, body.reminder.reminderId);
  assert.equal(payload.reminder.ownerAgentId, agent.id);
  assert.equal(payload.reminder.title, "standup");
  assert.deepEqual(sync.upserts.map(({ agentId, row }) => [agentId, row.id, row.version]), [
    [agent.id, body.reminder.reminderId, 1],
  ]);
  assert.deepEqual(sync.cancels, []);
});

test("agent-api reminder routes use bound credential identity without legacy agent id", async ({ app }) => {
  const { server, agent, anchorId } = await seed();
  const sync = installReminderOrchestratorStub(app.app);
  const events = installFakeIo(app.app);
  const apiKey = await agentApiKey(agent.id);
  const headers = agentHeaders(apiKey);

  const createRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "agent-api", delaySeconds: 120, msgId: anchorId }),
  });
  assert.equal(createRes.status, 201, `expected 201, got ${createRes.status}`);
  const createBody = (await createRes.json()) as { reminder: { reminderId: string; ownerAgentId: string; title: string } };
  assert.equal(createBody.reminder.ownerAgentId, agent.id);
  assert.equal(createBody.reminder.title, "agent-api");
  assert.equal(events.filter((e) => e.event === "reminder:scheduled").length, 1);
  assert.equal(events[0].room, `server:${server.id}`);

  const listRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders?status=scheduled,fired`, { headers });
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { reminders: Array<{ reminderId: string; ownerAgentId: string }> };
  assert.deepEqual(listBody.reminders.map((r) => [r.reminderId, r.ownerAgentId]), [[createBody.reminder.reminderId, agent.id]]);

  const updateRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${createBody.reminder.reminderId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "agent-api-updated" }),
  });
  assert.equal(updateRes.status, 200);
  const updateBody = (await updateRes.json()) as { reminder: { title: string; status: string } };
  assert.equal(updateBody.reminder.title, "agent-api-updated");
  assert.equal(updateBody.reminder.status, "scheduled");

  const beforeFire = await getReminderById(createBody.reminder.reminderId);
  assert.ok(beforeFire);
  const fired = firedOk(await fireReminder(beforeFire.id, (await makeDue(beforeFire.id)).version));
  assert.ok(fired);
  assert.equal(fired.row.status, "fired");

  const snoozeRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${createBody.reminder.reminderId}/snooze`, {
    method: "POST",
    headers,
    body: JSON.stringify({ delaySeconds: 300 }),
  });
  assert.equal(snoozeRes.status, 200);
  const snoozeBody = (await snoozeRes.json()) as { reminder: { status: string } };
  assert.equal(snoozeBody.reminder.status, "scheduled");

  const logRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${createBody.reminder.reminderId}/log`, { headers });
  assert.equal(logRes.status, 200);
  const logBody = (await logRes.json()) as { events: Array<{ eventType: string }> };
  assert.deepEqual(logBody.events.map((e) => e.eventType), ["snoozed", "fired", "updated", "scheduled"]);

  const cancelRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${createBody.reminder.reminderId}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(cancelRes.status, 200);
  const cancelBody = (await cancelRes.json()) as { reminder: { status: string; ownerAgentId: string } };
  assert.equal(cancelBody.reminder.status, "canceled");
  assert.equal(cancelBody.reminder.ownerAgentId, agent.id);
  const canceledEvents = events.filter((e) => e.event === "reminder:canceled");
  assert.equal(canceledEvents.length, 1);
  assert.deepEqual(canceledEvents[0].payload, {
    reminderId: createBody.reminder.reminderId,
    ownerAgentId: agent.id,
  });
  assert.deepEqual(sync.upserts.map(({ row }) => row.version), [1, 2, 4]);
  assert.deepEqual(sync.cancels.map(({ reminderId, version }) => [reminderId, version]), [
    [createBody.reminder.reminderId, 5],
  ]);
});

test("historical short log remains usable after owner transfer without exposing the new owner", async ({ app }) => {
  const { server, agent: oldOwner, anchorId } = await seed();
  installReminderOrchestratorStub(app.app);
  installFakeIo(app.app);
  const newOwner = await createAgent(server.id, "replacement-agent", { runtime: "claude" });
  const unrelated = await createAgent(server.id, "unrelated-agent", { runtime: "claude" });
  const oldHeaders = agentHeaders(await agentApiKey(oldOwner.id));
  const newHeaders = agentHeaders(await agentApiKey(newOwner.id));
  const unrelatedHeaders = agentHeaders(await agentApiKey(unrelated.id));

  const createRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
    method: "POST",
    headers: oldHeaders,
    body: JSON.stringify({ title: "old-owner-visible-title", delaySeconds: 120, msgId: anchorId }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as { reminder: { reminderId: string } };
  const first = await getReminderById(created.reminder.reminderId);
  assert.ok(first);
  const oldOccurrence = firedOk(await fireReminder(first.id, (await makeDue(first.id)).version));
  assert.ok(oldOccurrence);

  const rebound = await replaceReminder(first.id, {
    serverId: server.id,
    ownerAgentId: newOwner.id,
    targetChannelId: null,
    msgId: anchorId,
    title: "new-owner-private-initial",
    fireAt: new Date(Date.now() + 10 * 60_000),
    payload: null,
    recurrence: null,
    createdBy: { type: "agent", id: newOwner.id },
  }, {
    expectedVersion: oldOccurrence.row.version,
    actor: { type: "agent", id: newOwner.id },
  });
  assert.ok(rebound);

  const updateRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${first.id}`, {
    method: "PATCH",
    headers: newHeaders,
    body: JSON.stringify({ title: "new-owner-secret-title" }),
  });
  assert.equal(updateRes.status, 200);
  const current = await getReminderById(first.id);
  assert.ok(current);
  const newOccurrence = firedOk(await fireReminder(current.id, (await makeDue(current.id)).version));
  assert.ok(newOccurrence);

  const shortId = first.id.slice(0, 8);
  const oldLogRes = await fetch(
    `${app.baseUrl}/internal/agent-api/reminders/${shortId}/log`,
    { headers: oldHeaders },
  );
  assert.equal(oldLogRes.status, 200, "the unchanged historical Inbox action must remain executable");
  const oldLogText = await oldLogRes.text();
  const oldLog = JSON.parse(oldLogText) as { events: Array<{ eventType: string; reminderId: string }> };
  assert.deepEqual(oldLog.events.map((event) => event.eventType), ["fired", "scheduled"]);
  assert.ok(oldLog.events.every((event) => event.reminderId === first.id));
  assert.doesNotMatch(oldLogText, /new-owner-private-initial|new-owner-secret-title/);
  assert.doesNotMatch(oldLogText, new RegExp(newOwner.id));

  const newLogRes = await fetch(
    `${app.baseUrl}/internal/agent-api/reminders/${shortId}/log`,
    { headers: newHeaders },
  );
  assert.equal(newLogRes.status, 200);
  const newLogText = await newLogRes.text();
  assert.match(newLogText, /new-owner-secret-title/,
    "the isolation assertion must prove the private event exists, not merely omit absent data");

  const unrelatedLog = await fetch(
    `${app.baseUrl}/internal/agent-api/reminders/${shortId}/log`,
    { headers: unrelatedHeaders },
  );
  assert.equal(unrelatedLog.status, 404);
});

test("agent-api recurring create preserves --channel as lifecycle metadata without a Server fire carrier", async ({ app }) => {
  const { owner, server, agent, anchorId } = await seed();
  installReminderOrchestratorStub(app.app);
  installFakeIo(app.app);
  const ownerChannel = await channelService.createChannel(
    server.id,
    "onboarding-owner",
    "owner-only onboarding",
    "private",
  );
  await channelService.addHuman(ownerChannel.id, owner.id);
  await channelService.addAgent(ownerChannel.id, agent.id);

  const thread = await channelService.getOrCreateThread(anchorId, agent.id, "agent");
  const threadMessage = await createMessage(
    thread.id,
    "agent",
    agent.id,
    "legacy consent reply anchor",
  );
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: agent.id,
    parentMessageId: anchorId,
    reason: "manual",
  });

  const apiKey = await agentApiKey(agent.id);
  const createRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
    method: "POST",
    headers: agentHeaders(apiKey),
    body: JSON.stringify({
      title: "Daily recap",
      repeat: "daily@10:00",
      tz: "Asia/Shanghai",
      channel: "#onboarding-owner",
      msgId: threadMessage.id,
    }),
  });
  assert.equal(createRes.status, 201, `expected 201, got ${createRes.status}`);
  const createBody = (await createRes.json()) as {
    reminder: { reminderId: string; msgRef: string | null; recurrence: { kind: string } | null };
  };
  assert.equal(createBody.reminder.msgRef, "#onboarding-owner");
  assert.equal(createBody.reminder.recurrence?.kind, "daily");

  const reminder = await getReminderById(createBody.reminder.reminderId);
  assert.ok(reminder);
  assert.equal(reminder.targetChannelId, ownerChannel.id);
  assert.equal(reminder.msgId, threadMessage.id);
  assert.equal((reminder.recurrence as any)?.rule?.kind, "daily");
});

test("agent-api reminder create cloaks anchors the bound agent cannot read", async ({ app }) => {
  const { owner, server, agent } = await seed();
  installReminderOrchestratorStub(app.app);
  const events = installFakeIo(app.app);
  const hiddenMessage = await seedHiddenReminderAnchor({ owner, server });

  const apiKey = await agentApiKey(agent.id);
  const headers = agentHeaders(apiKey);
  for (const msgId of [hiddenMessage.id, hiddenMessage.id.slice(0, 8)]) {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `hidden-${msgId.length}`, delaySeconds: 120, msgId }),
    });
    assert.equal(res.status, 404, `expected hidden anchor ${msgId} to be cloaked`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "message not found");
  }
  assert.equal(events.filter((e) => e.event === "reminder:scheduled").length, 0);

  const listRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders?status=scheduled,fired`, { headers });
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { reminders: unknown[] };
  assert.deepEqual(listBody.reminders, []);
});

test("legacy reminder create cloaks anchors the bound agent cannot read", async ({ app }) => {
  const { owner, server, agent, apiKey } = await seed();
  installReminderOrchestratorStub(app.app);
  const events = installFakeIo(app.app);
  const hiddenMessage = await seedHiddenReminderAnchor({ owner, server });

  const headers = machineHeaders(apiKey);
  for (const msgId of [hiddenMessage.id, hiddenMessage.id.slice(0, 8)]) {
    const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `legacy-hidden-${msgId.length}`, delaySeconds: 120, msgId }),
    });
    assert.equal(res.status, 404, `expected hidden anchor ${msgId} to be cloaked`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "message not found");
  }
  assert.equal(events.filter((e) => e.event === "reminder:scheduled").length, 0);

  const listRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders?status=scheduled,fired`, {
    headers,
  });
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { reminders: unknown[] };
  assert.deepEqual(listBody.reminders, []);
});

test("agent-api reminder create resolves visible joint channel anchors through local projection", async ({ app }) => {
  const { server, agent } = await seed();
  installReminderOrchestratorStub(app.app);
  const events = installFakeIo(app.app);
  const anchor = await seedJointReminderAnchor({ server, agent });
  const apiKey = await agentApiKey(agent.id);
  const headers = agentHeaders(apiKey);

  for (const msgId of [anchor.id, anchor.id.slice(0, 8)]) {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `joint-anchor-${msgId.length}`, delaySeconds: 120, msgId }),
    });
    assert.equal(res.status, 201, `expected visible joint anchor ${msgId} to resolve, got ${res.status}`);
    const body = (await res.json()) as { reminder: { reminderId: string; msgRef?: { msgId?: string } } };
    const reminder = await getReminderById(body.reminder.reminderId);
    assert.ok(reminder);
    assert.equal(reminder.msgId, anchor.id);
  }

  assert.equal(events.filter((e) => e.event === "reminder:scheduled").length, 2);
});

test("legacy reminder create resolves visible joint channel anchors through local projection", async ({ app }) => {
  const { server, agent, apiKey } = await seed();
  installReminderOrchestratorStub(app.app);
  const events = installFakeIo(app.app);
  const anchor = await seedJointReminderAnchor({ server, agent });
  const headers = machineHeaders(apiKey);

  for (const msgId of [anchor.id, anchor.id.slice(0, 8)]) {
    const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `legacy-joint-anchor-${msgId.length}`, delaySeconds: 120, msgId }),
    });
    assert.equal(res.status, 201, `expected visible joint anchor ${msgId} to resolve, got ${res.status}`);
    const body = (await res.json()) as { reminder: { reminderId: string; msgRef?: { msgId?: string } } };
    const reminder = await getReminderById(body.reminder.reminderId);
    assert.ok(reminder);
    assert.equal(reminder.msgId, anchor.id);
  }

  assert.equal(events.filter((e) => e.event === "reminder:scheduled").length, 2);
});

test("GET /internal/agent-api/reminders validates the ?status filter", async ({ app }) => {
  const { agent } = await seed();
  const apiKey = await agentApiKey(agent.id);

  const res = await fetch(`${app.baseUrl}/internal/agent-api/reminders?status=bogus`, {
    headers: agentHeaders(apiKey),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Invalid status value");
});

test("DELETE /internal/agent/:id/reminders/:reminderId emits reminder:canceled on the server room", async ({ app }) => {
  const { server, agent, apiKey, anchorId } = await seed();
  installReminderOrchestratorStub(app.app);

  // Create the reminder first via the same route so we exercise the real path.
  const createRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ title: "to-cancel", delaySeconds: 120, msgId: anchorId }),
  });
  assert.equal(createRes.status, 201);
  const createBody = (await createRes.json()) as { reminder: { reminderId: string } };
  const reminderId = createBody.reminder.reminderId;

  // Swap in the fake io AFTER create so we only capture the cancel event,
  // keeping the assertion tight.
  const events = installFakeIo(app.app);

  const delRes = await fetch(
    `${app.baseUrl}/internal/agent/${agent.id}/reminders/${reminderId}`,
    {
      method: "DELETE",
      headers: machineHeaders(apiKey),
    },
  );
  assert.equal(delRes.status, 200, `expected 200, got ${delRes.status}`);

  const canceledEvents = events.filter((e) => e.event === "reminder:canceled");
  assert.equal(canceledEvents.length, 1, "expected exactly one reminder:canceled event");
  const [evt] = canceledEvents;
  assert.equal(evt.room, `server:${server.id}`);
  assert.deepEqual(evt.payload, {
    reminderId,
    ownerAgentId: agent.id,
  });
});

test("POST /internal/agent/:id/reminders rejects missing msgId", async ({ app }) => {
  const { agent, apiKey } = await seed();
  installReminderOrchestratorStub(app.app);

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({
      title: "missing-anchor",
      delaySeconds: 60,
    }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /msgId is required/);
});

test("snooze/update/log routes enforce B-minimal reminder state", async ({ app }) => {
  const { agent, apiKey, anchorId } = await seed();
  installReminderOrchestratorStub(app.app);

  const createRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ title: "b-minimal", delaySeconds: 120, msgId: anchorId }),
  });
  assert.equal(createRes.status, 201);
  const createBody = (await createRes.json()) as { reminder: { reminderId: string; fireAt: string } };
  const reminderId = createBody.reminder.reminderId;

  const updateRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders/${reminderId}`, {
    method: "PATCH",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ title: "updated title" }),
  });
  assert.equal(updateRes.status, 200, `expected scheduled update to work, got ${updateRes.status}`);
  const updateBody = (await updateRes.json()) as { reminder: { title: string; status: string } };
  assert.equal(updateBody.reminder.title, "updated title");
  assert.equal(updateBody.reminder.status, "scheduled");

  const beforeFire = await getReminderById(reminderId);
  assert.ok(beforeFire);
  const fired = firedOk(await fireReminder(beforeFire.id, (await makeDue(beforeFire.id)).version));
  assert.ok(fired);
  assert.equal(fired.row.status, "fired");

  const rejectedUpdate = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders/${reminderId}`, {
    method: "PATCH",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ title: "cannot update fired" }),
  });
  assert.equal(rejectedUpdate.status, 409);
  const rejectedBody = (await rejectedUpdate.json()) as { error?: string };
  assert.match(rejectedBody.error ?? "", /snooze it back to scheduled/);

  const snoozeRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders/${reminderId}/snooze`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ delaySeconds: 300 }),
  });
  assert.equal(snoozeRes.status, 200);
  const snoozeBody = (await snoozeRes.json()) as { reminder: { status: string; fireAt: string } };
  assert.equal(snoozeBody.reminder.status, "scheduled");
  assert.notEqual(snoozeBody.reminder.fireAt, createBody.reminder.fireAt);

  const logRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders/${reminderId}/log`, {
    method: "GET",
    headers: machineHeaders(apiKey),
  });
  assert.equal(logRes.status, 200);
  const logBody = (await logRes.json()) as { events: Array<{ eventType: string }> };
  assert.deepEqual(logBody.events.map((e) => e.eventType), ["snoozed", "fired", "updated", "scheduled"]);
});

test("GET /internal/agent/:id/reminders validates the ?status filter", async ({ app }) => {
  const { agent, apiKey } = await seed();

  // A valid, comma-separated status filter is accepted.
  const okRes = await fetch(
    `${app.baseUrl}/internal/agent/${agent.id}/reminders?status=scheduled,fired`,
    { headers: machineHeaders(apiKey) },
  );
  assert.equal(okRes.status, 200, `expected 200 for valid status, got ${okRes.status}`);

  // An unknown status value is rejected (the isReminderStatus guard path).
  const badRes = await fetch(
    `${app.baseUrl}/internal/agent/${agent.id}/reminders?status=bogus`,
    { headers: machineHeaders(apiKey) },
  );
  assert.equal(badRes.status, 400, `expected 400 for invalid status, got ${badRes.status}`);
  const badBody = (await badRes.json()) as { error: string };
  assert.equal(badBody.error, "Invalid status value");
});
