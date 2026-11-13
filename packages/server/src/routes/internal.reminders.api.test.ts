import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { refusalBody } from "../lib/refusal";
import { AGENT_CHANNEL_NOT_FOUND_REFUSAL } from "./agentRouteRefusals";

import { getDb } from "../db/index";
import { eq } from "drizzle-orm";
import { agents, jointChannels, jointChannelServers, reminders, serverMembers, threadFollows, users } from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createMessage } from "../services/messageService";
import { createAppReminder } from "../apps/reminder/crud";
import { createFeatureFlag, createFeatureFlagRule, REMINDER_APP_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import * as channelService from "../services/channelService";
import {
  fireReminder,
  getReminderById,
  markReminderMigrated,
  replaceReminder,
  type ReminderRow,
} from "../apps/reminder/service";
import { revealAllChannelForTest } from "../test/allChannelFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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
    // Reminder events are published per socket. Model one connected socket per
    // server member, carrying the handshake role exactly like production
    // sockets; a delivery is recorded against that member's user room.
    local: {
      in(rooms: string | string[]) {
        const serverId = String(Array.isArray(rooms) ? rooms[0] : rooms).slice("server:".length);
        return {
          async fetchSockets() {
            const members = await getDb()
              .select({ userId: serverMembers.userId, serverRole: serverMembers.role })
              .from(serverMembers)
              .where(eq(serverMembers.serverId, serverId));
            return members.map(({ userId, serverRole }) => ({
              data: { userId, serverRole },
              emit(event: string, payload: unknown) {
                events.push({ room: `user:${userId}`, event, payload });
              },
            }));
          },
        };
      },
    },
  };
  app.set("io", fakeIo);
  return events;
}

/**
 * Three more connected humans around the seeded owner: an admin (holds
 * `editAgents`), the agent's human creator (plain member), and a plain member
 * with no relation to the agent. Only the first two may inspect the agent.
 */
async function seedReminderViewers(serverId: string, agentId: string) {
  const db = getDb();
  const [admin, creator, bystander] = await db
    .insert(users)
    .values(["admin", "creator", "bystander"].map((name) => ({
      email: `internal-reminders-${name}@slock.test`,
      name: `internal-reminders-${name}`,
      displayName: name,
      passwordHash: "unused",
      emailVerified: true,
    })))
    .returning();
  await addMember(serverId, admin.id, "admin");
  await addMember(serverId, creator.id);
  await addMember(serverId, bystander.id);
  await db.update(agents).set({ creatorType: "user", creatorId: creator.id }).where(eq(agents.id, agentId));
  return { admin, creator, bystander };
}

function deliveredTo(events: EmittedEvent[], event: string): string[] {
  return events.filter((e) => e.event === event).map((e) => e.room).sort();
}

function installReminderOrchestratorStub(app: {
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
}): { upserts: Array<{ agentId: string; row: ReminderRow }>; cancels: Array<{ agentId: string; reminderId: string; version: number; canceled: boolean }> } {
  const existing = (app.get("agentOrchestrator") as Record<string, unknown>) ?? {};
  const upserts: Array<{ agentId: string; row: ReminderRow }> = [];
  const cancels: Array<{ agentId: string; reminderId: string; version: number; canceled: boolean }> = [];
  app.set("agentOrchestrator", {
    ...existing,
    pushReminderUpsert: (agentId: string, row: ReminderRow) => {
      upserts.push({ agentId, row });
      return true;
    },
    pushReminderCancel: (agentId: string, reminderId: string, version: number, opts?: { canceled?: boolean }) => {
      cancels.push({ agentId, reminderId, version, canceled: opts?.canceled === true });
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
  await revealAllChannelForTest(server.id);
  const agent = await createAgent(server.id, "r-agent", { runtime: "claude" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "dev-machine");
  await placeAgentOnMachine(agent.id, machine.id);
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

  await channelService.addAgent(localProjection.id, input.agent.id);

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
    issuedVia: "computer",
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

test("POST /internal/agent/:id/reminders delivers reminder:scheduled only to users who may inspect the owner agent", async ({ app }) => {
  const { owner, server, agent, apiKey, anchorId } = await seed();
  const { admin, creator } = await seedReminderViewers(server.id, agent.id);
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

  // The summary carries the title and anchor permalink, so the bystander's
  // socket in the same server room must not receive it.
  assert.deepEqual(
    deliveredTo(events, "reminder:scheduled"),
    [owner, admin, creator].map((user) => `user:${user.id}`).sort(),
  );
  for (const evt of events.filter((e) => e.event === "reminder:scheduled")) {
    const payload = evt.payload as { reminder: { reminderId: string; ownerAgentId: string; title: string } };
    assert.equal(payload.reminder.reminderId, body.reminder.reminderId);
    assert.equal(payload.reminder.ownerAgentId, agent.id);
    assert.equal(payload.reminder.title, "standup");
  }
  assert.deepEqual(sync.upserts.map(({ agentId, row }) => [agentId, row.id, row.version]), [
    [agent.id, body.reminder.reminderId, 1],
  ]);
  assert.deepEqual(sync.cancels, []);
});

test("agent-api refuses reminder mutations for external agents with an explicit 409 and schedules nothing", async ({ app }) => {
  const { server, anchorId } = await seed();
  const sync = installReminderOrchestratorStub(app.app);
  const events = installFakeIo(app.app);
  const external = await createAgent(server.id, "r-external", { runtime: "external", model: "external" });
  const [channel] = await channelService.listChannels(server.id);
  await channelService.addAgent(channel.id, external.id);
  const headers = agentHeaders(await agentApiKey(external.id));
  // A reminder that predates the refusal (or was created by another path).
  const legacy = await createAppReminder({
    serverId: server.id,
    ownerAgentId: external.id,
    targetChannelId: null,
    msgId: anchorId,
    title: "pre-existing",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    recurrence: null,
    createdBy: { type: "agent", id: external.id },
  });

  const refused = [
    await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "never fires", delaySeconds: 60, msgId: anchorId }),
    }),
    // Refused before request validation: an invalid body still gets the 409.
    await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    }),
    await fetch(`${app.baseUrl}/internal/agent-api/reminders/${legacy.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "changed" }),
    }),
    await fetch(`${app.baseUrl}/internal/agent-api/reminders/${legacy.id}/snooze`, {
      method: "POST",
      headers,
      body: JSON.stringify({ delaySeconds: 300 }),
    }),
  ];
  for (const res of refused) {
    assert.equal(res.status, 409);
    const body = await res.json() as { code?: string; error?: string };
    assert.equal(body.code, "reminders_unsupported_for_external_agents");
    assert.match(body.error ?? "", /not yet supported for external agents/);
  }
  const rows = await getDb().select().from(reminders).where(eq(reminders.ownerAgentId, external.id));
  assert.deepEqual(rows.map((row) => [row.title, row.version]), [["pre-existing", legacy.version]]);
  assert.deepEqual(sync.upserts, []);
  assert.equal(events.filter((e) => e.event === "reminder:scheduled").length, 0);

  // Reads and cancel stay truthful for an external agent.
  const listRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders?status=scheduled,fired`, { headers });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as { reminders: Array<{ reminderId: string }> };
  assert.deepEqual(listBody.reminders.map((r) => r.reminderId), [legacy.id]);
  const logRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${legacy.id}/log`, { headers });
  assert.equal(logRes.status, 200);
  const cancelRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${legacy.id}`, { method: "DELETE", headers });
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json() as { reminder: { status: string } }).reminder.status, "canceled");
});

test("reminder_app on: legacy reminder writes are refused with reminders_moved_to_app on both route families; reads and cancel stay", async ({ app }) => {
  const { server, agent, apiKey, anchorId } = await seed();
  const sync = installReminderOrchestratorStub(app.app);
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const existing = await createAppReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: null,
    msgId: anchorId,
    title: "made before the move",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    recurrence: null,
    createdBy: { type: "agent", id: agent.id },
  });
  await createFeatureFlag({ key: REMINDER_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  await createFeatureFlagRule({ flagKey: REMINDER_APP_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [server.id] });
  const agentApi = agentHeaders(await agentApiKey(agent.id));
  const machine = machineHeaders(apiKey);
  const create = { title: "after the move", delaySeconds: 60, msgId: anchorId };

  const refused = [
    await fetch(`${app.baseUrl}/internal/agent-api/reminders`, { method: "POST", headers: agentApi, body: JSON.stringify(create) }),
    // Refused before request validation, like the external-agent refusal.
    await fetch(`${app.baseUrl}/internal/agent-api/reminders`, { method: "POST", headers: agentApi, body: JSON.stringify({}) }),
    await fetch(`${app.baseUrl}/internal/agent-api/reminders/${existing.id}`, { method: "PATCH", headers: agentApi, body: JSON.stringify({ title: "changed" }) }),
    await fetch(`${app.baseUrl}/internal/agent-api/reminders/${existing.id}/snooze`, { method: "POST", headers: agentApi, body: JSON.stringify({ delaySeconds: 300 }) }),
    // Older Computers call the machine-key routes.
    await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, { method: "POST", headers: machine, body: JSON.stringify(create) }),
    await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders/${existing.id}`, { method: "PATCH", headers: machine, body: JSON.stringify({ title: "changed" }) }),
    await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders/${existing.id}/snooze`, { method: "POST", headers: machine, body: JSON.stringify({ delaySeconds: 300 }) }),
  ];
  for (const res of refused) {
    assert.equal(res.status, 409);
    const body = await res.json() as { code?: string; error?: string; suggestedNextAction?: string };
    assert.equal(body.code, "reminders_moved_to_app");
    assert.match(body.error ?? "", /moved to the Reminder app/);
    // The sentence names no command; the next step does.
    assert.doesNotMatch(body.error ?? "", /raft /);
    assert.match(body.suggestedNextAction ?? "", /raft integration invoke --service <id> --list-actions/);
  }
  const requestSpans = sink.getAllSpans().filter((span) => span.name === "server.http.request");
  assert.equal(requestSpans.filter((span) => span.attrs?.error_code === "reminders_moved_to_app").length, refused.length);
  const rows = await getDb().select().from(reminders).where(eq(reminders.ownerAgentId, agent.id));
  assert.deepEqual(rows.map((row) => [row.title, row.version]), [["made before the move", existing.version]]);
  assert.deepEqual(sync.upserts, []);

  const listRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders?status=scheduled`, { headers: agentApi });
  assert.equal(listRes.status, 200);
  assert.deepEqual((await listRes.json() as { reminders: Array<{ reminderId: string }> }).reminders.map((r) => r.reminderId), [existing.id]);
  const legacyListRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/reminders`, { headers: machine });
  assert.equal(legacyListRes.status, 200);
  const logRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${existing.id}/log`, { headers: agentApi });
  assert.equal(logRes.status, 200);
  const cancelRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${existing.id}`, { method: "DELETE", headers: agentApi });
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json() as { reminder: { status: string } }).reminder.status, "canceled");
});

test("every agent-api 4xx is classified on the request span (error_code + reason_class), never with the body's text", async ({ app }) => {
  const { agent, server } = await seed();
  const [visible] = await channelService.listChannels(server.id);
  await channelService.addAgent(visible!.id, agent.id);
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const headers = agentHeaders(await agentApiKey(agent.id));
  const read = (query: string) => fetch(`${app.baseUrl}/internal/agent-api/history?${query}`, { headers });

  const missing = await read(`channel=${encodeURIComponent("#no-such-channel")}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), refusalBody(AGENT_CHANNEL_NOT_FOUND_REFUSAL), "the caller still gets the neutral body");
  const missingThread = await read(`channel=${encodeURIComponent("#no-such-channel:deadbeef")}`);
  assert.equal(missingThread.status, 404);
  const invalid = await read(`channel=${encodeURIComponent(`#${visible!.name}`)}&unread=true&before=1`);
  assert.equal(invalid.status, 400);
  const badBody = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.ok(badBody.status >= 400 && badBody.status < 500);

  const spans = sink.getAllSpans().filter((span) => span.name === "server.http.request" && span.attrs?.error_code !== undefined);
  assert.equal(spans.length, 4, "each refusal is classified once");
  const classified = spans.map((span) => [span.attrs?.error_code, span.attrs?.reason_class]);
  assert.deepEqual(classified.slice(0, 3), [
    ["channel_not_found", "not_found"],
    ["thread_parent_channel_not_found", "not_found"],
    // refuse() records the refusal's own code, as sent (INVALID_ARG).
    ["INVALID_ARG", "invalid_input"],
  ]);
  const last = classified.at(-1)!;
  assert.equal(last[1], "invalid_input");
  assert.ok(typeof last[0] === "string" && last[0].length > 0, "a validator's refusal is classified too");
  for (const span of spans) {
    assert.doesNotMatch(JSON.stringify(span.attrs), /no-such-channel/, "no request text on the span");
  }

  // Mounted before auth: an auth refusal is classified as well.
  const before = sink.getAllSpans().length;
  const unauthenticated = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent("#x")}`, { headers: { authorization: "Bearer sk_agent_not_a_real_key" } });
  assert.ok(unauthenticated.status === 401 || unauthenticated.status === 403, String(unauthenticated.status));
  const authSpan = sink.getAllSpans().slice(before).find((span) => span.name === "server.http.request");
  assert.equal(authSpan?.attrs?.reason_class, "forbidden");
  assert.ok(typeof authSpan?.attrs?.error_code === "string" && authSpan.attrs.error_code.length > 0);
});

test("agent-api reminder routes use bound credential identity without legacy agent id", async ({ app }) => {
  const { owner, agent, anchorId } = await seed();
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
  assert.equal(events[0].room, `user:${owner.id}`);

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
  // The push says the reminder itself was canceled: its Computer drops the un-acked items it holds of it (RFC 081 D21).
  assert.deepEqual(sync.cancels.map(({ reminderId, version, canceled }) => [reminderId, version, canceled]), [
    [createBody.reminder.reminderId, 5, true],
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
  // Every new server is born with the owner's private onboarding-owner channel.
  const ownerChannel = (await channelService.listChannels(server.id, owner.id))
    .find((ch) => ch.name === "onboarding-owner");
  assert.ok(ownerChannel);
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
  const body = (await res.json()) as { code?: string; error?: string };
  assert.equal(body.code, "reminder_status_invalid");
  assert.match(body.error ?? "", /scheduled, fired, canceled or migrated/);
});

test("DELETE /internal/agent/:id/reminders/:reminderId delivers reminder:canceled only to users who may inspect the owner agent", async ({ app }) => {
  const { owner, server, agent, apiKey, anchorId } = await seed();
  const { admin, creator } = await seedReminderViewers(server.id, agent.id);
  const sync = installReminderOrchestratorStub(app.app);

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
  assert.deepEqual(sync.cancels.map(({ reminderId, canceled }) => [reminderId, canceled]), [[reminderId, true]]);

  assert.deepEqual(
    deliveredTo(events, "reminder:canceled"),
    [owner, admin, creator].map((user) => `user:${user.id}`).sort(),
  );
  for (const evt of events.filter((e) => e.event === "reminder:canceled")) {
    assert.deepEqual(evt.payload, {
      reminderId,
      ownerAgentId: agent.id,
    });
  }
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
  const body = (await res.json()) as { code?: string; error?: string };
  assert.equal(body.code, "reminder_message_required");
  assert.match(body.error ?? "", /needs the message it is about/);
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
  const badBody = (await badRes.json()) as { code?: string; error: string };
  assert.equal(badBody.code, "reminder_status_invalid");
  assert.match(badBody.error, /scheduled, fired, canceled or migrated/);
});

test("a migrated reminder reaches only clients that ask, and every mutation points to the Reminder app", async ({ app }) => {
  const { agent, anchorId } = await seed();
  installReminderOrchestratorStub(app.app);
  installFakeIo(app.app);
  const headers = agentHeaders(await agentApiKey(agent.id));

  const createRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "moves", delaySeconds: 3600, msgId: anchorId }),
  });
  assert.equal(createRes.status, 201);
  const { reminder } = (await createRes.json()) as { reminder: { reminderId: string } };
  const row = await getReminderById(reminder.reminderId);
  assert.ok(row);
  assert.ok(await markReminderMigrated(row.id, { appReminderId: "app-1" }, { expectedVersion: row.version }));

  const statuses = async (query: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/reminders${query}`, { headers });
    assert.equal(res.status, 200, query);
    return ((await res.json()) as { reminders: Array<{ status: string }> }).reminders.map((r) => r.status);
  };
  // What older CLIs send: never a `migrated` row (their enum would reject the whole list).
  assert.deepEqual(await statuses("?status=scheduled,fired"), []);
  assert.deepEqual(await statuses("?all=true"), []);
  // What a new CLI sends.
  assert.deepEqual(await statuses("?status=scheduled,fired&includeMigrated=true"), ["migrated"]);
  assert.deepEqual(await statuses("?status=migrated"), ["migrated"]);

  for (const [method, path, body] of [
    ["DELETE", "", undefined],
    ["POST", "/snooze", { delaySeconds: 300 }],
    ["PATCH", "", { title: "renamed" }],
  ] as const) {
    const res: Response = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${row.id}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(res.status, 409, `${method} ${path}`);
    const error = (await res.json()) as { error: string; code: string };
    assert.equal(error.code, "reminder_migrated");
    assert.match(error.error, /moved to the Reminder app/);
  }
  const after = await getReminderById(row.id);
  assert.equal(after?.status, "migrated", "nothing was changed");

  const logRes = await fetch(`${app.baseUrl}/internal/agent-api/reminders/${row.id}/log`, { headers });
  assert.equal(logRes.status, 200);
  const log = (await logRes.json()) as { events: Array<{ eventType: string }> };
  assert.deepEqual(log.events.map((e) => e.eventType), ["scheduled"], "the migrated event stays server-side");
});
