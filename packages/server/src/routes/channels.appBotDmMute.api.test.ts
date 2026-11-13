import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { withChannelDelivery } from "../test/orchestratorStub";
import { getDb } from "../db/index";
import { inboxNotificationFacts, inboxTargetMuteStates, notificationOutbox, oauthClientInstalls } from "../db/schema";
import { createAgent } from "../services/agentService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { createManagedAppBot, uninstallManagedAppBot } from "../services/appBotIdentityService";
import { findOrCreateDM, findOrCreateUserDM } from "../services/channelService";
import { broadcastAndDeliver } from "../services/messageService";
import { createOAuthClient } from "../services/oauthService";
import { addMember } from "../services/serverService";
import { withTraceRoot } from "../tracing/semanticTrace";
import { createServer, headers, installFakeIo, seedUser } from "./channels.api.fixtures";

// A person can Activity-mute a DM with an App bot, and only that DM
// (artin 2026-10-28, #proj-apps:6c85e2b5). DMs with a person or an ordinary
// agent stay direct. A stored mute stays readable after the bot is removed, so
// the person can always undo it.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type MuteView = { id?: string; activityMuted?: boolean; muteFromSeq?: number | null; activityMuteSupported?: boolean };

async function seedAppBot(serverId: string, ownerId: string) {
  const { client } = await createOAuthClient({
    serverId,
    createdByUserId: ownerId,
    clientId: `dm-mute-bot-${randomUUID().slice(0, 8)}`,
    name: "DM Mute Bot",
    enableBot: true,
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId,
    clientId: client.id,
    installedByUserId: ownerId,
    status: "active",
    botGrant: "granted",
  }).returning();
  const bot = await getDb().transaction((tx) => createManagedAppBot(tx, { installId: install!.id, serverId }));
  return { installId: install!.id, agentId: bot.agentId };
}

test("only a DM with an App bot can be muted, on every surface that says so; a removed bot's mute stays undoable", async ({ app }) => {
  const owner = await seedUser("bot-dm-mute-owner@slock.test", "bot-dm-mute-owner");
  const peer = await seedUser("bot-dm-mute-peer@slock.test", "bot-dm-mute-peer");
  const server = await createServer("Bot DM Mute", "bot-dm-mute", owner.id);
  await addMember(server.id, peer.id);
  const bot = await seedAppBot(server.id, owner.id);
  const plain = await createAgent(server.id, "bot-dm-mute-plain", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const ownerHeaders = headers(await tokenForHuman(owner.email), server.id);
  const call = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<MuteView> => {
    const res = await fetch(`${app.baseUrl}/api/channels${path}`, {
      method: init.method ?? "GET",
      headers: ownerHeaders,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return await res.json() as MuteView;
  };
  const openDm = (body: { agentId: string } | { userId: string }) => call("/dm", { method: "POST", body });
  const setMuted = (dmId: string, activityMuted: boolean) =>
    call(`/${dmId}/notification-settings`, { method: "PATCH", body: { activityMuted } });
  const supportedOn = async (dmId: string) => {
    const list = await (await fetch(`${app.baseUrl}/api/channels/dm`, { headers: ownerHeaders })).json() as MuteView[];
    return {
      list: list.find((row) => row.id === dmId)?.activityMuteSupported,
      detail: (await call(`/${dmId}`)).activityMuteSupported,
      settings: (await call(`/${dmId}/notification-settings`)).activityMuteSupported,
    };
  };

  const botDm = await openDm({ agentId: bot.agentId });
  const plainDm = await openDm({ agentId: plain.id });
  const humanDm = await openDm({ userId: peer.id });
  assert.ok(botDm.id && plainDm.id && humanDm.id);
  assert.equal(botDm.activityMuteSupported, true, "POST /dm: App bot DM");
  assert.equal(plainDm.activityMuteSupported, false, "POST /dm: ordinary agent DM");
  assert.equal(humanDm.activityMuteSupported, false, "POST /dm: human DM");
  assert.deepEqual(await supportedOn(botDm.id), { list: true, detail: true, settings: true });
  assert.deepEqual(await supportedOn(plainDm.id), { list: false, detail: false, settings: false });
  assert.deepEqual(await supportedOn(humanDm.id), { list: false, detail: false, settings: false });

  const muted = await setMuted(botDm.id, true);
  assert.equal(muted.activityMuted, true);
  assert.equal(muted.activityMuteSupported, true);
  // Every read the client replaces its DM row with carries the stored mute.
  for (const view of [await call(`/${botDm.id}`), await openDm({ agentId: bot.agentId })]) {
    assert.equal(view.activityMuted, true);
    assert.equal(view.muteFromSeq, muted.muteFromSeq);
  }

  // The bot is removed: the DM can no longer be muted, but its stored mute is
  // still reported, and unmuting it is still accepted.
  await getDb().transaction((tx) => uninstallManagedAppBot(tx, { installId: bot.installId }));
  for (const view of [await call(`/${botDm.id}`), await call(`/${botDm.id}/notification-settings`)]) {
    assert.equal(view.activityMuteSupported, false);
    assert.equal(view.activityMuted, true);
  }
  const unmuted = await setMuted(botDm.id, false);
  assert.equal(unmuted.activityMuted, false);
  assert.equal(unmuted.activityMuteSupported, false);
});

test("muting a DM that cannot be muted is refused and changes nothing; unmuting is always accepted", async ({ app }) => {
  const events = installFakeIo(app.app);
  const owner = await seedUser("dm-mute-refused-owner@slock.test", "dm-mute-refused-owner");
  const peer = await seedUser("dm-mute-refused-peer@slock.test", "dm-mute-refused-peer");
  const server = await createServer("DM Mute Refused", "dm-mute-refused", owner.id);
  await addMember(server.id, peer.id);
  const bot = await seedAppBot(server.id, owner.id);
  const plain = await createAgent(server.id, "dm-mute-refused-plain", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const humanDm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  const plainDm = await findOrCreateDM(server.id, owner.id, plain.id);
  const botDm = await findOrCreateDM(server.id, owner.id, bot.agentId);
  assert.ok(humanDm && plainDm && botDm);
  const ownerHeaders = headers(await tokenForHuman(owner.email), server.id);
  const patch = (dmId: string, activityMuted: boolean) => fetch(`${app.baseUrl}/api/channels/${dmId}/notification-settings`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ activityMuted }),
  });
  const refused = async (dmId: string, label: string) => {
    const res = await patch(dmId, true);
    assert.equal(res.status, 400, label);
    assert.deepEqual(await res.json(), { error: "This conversation can't be muted", code: "ACTIVITY_MUTE_NOT_SUPPORTED" }, label);
  };
  const stored = async (dmId: string) => (await getDb()
    .select({ activityMuted: inboxTargetMuteStates.activityMuted, prefsVersion: inboxTargetMuteStates.prefsVersion })
    .from(inboxTargetMuteStates)
    .where(and(eq(inboxTargetMuteStates.receiverId, owner.id), eq(inboxTargetMuteStates.sourceChannelId, dmId))))[0] ?? null;
  const prefsEvents = () => events.filter((event) => event.event === "notification_prefs:updated").length;

  await refused(humanDm.id, "a DM with a person");
  await refused(plainDm.id, "a DM with an ordinary agent");
  assert.equal(await stored(humanDm.id), null, "no mute row for the person DM");
  assert.equal(await stored(plainDm.id), null, "no mute row for the ordinary agent DM");
  assert.equal(prefsEvents(), 0, "a refused mute emits nothing");
  assert.equal((await patch(humanDm.id, false)).status, 200, "unmuting a DM that cannot be muted is accepted");

  // An App bot DM can be muted; once its bot is removed, the stored mute can
  // be undone, but the DM cannot be muted again.
  assert.equal((await patch(botDm.id, true)).status, 200, "an App bot DM can be muted");
  assert.equal(prefsEvents(), 1);
  await getDb().transaction((tx) => uninstallManagedAppBot(tx, { installId: bot.installId }));
  await refused(botDm.id, "a removed bot's DM, still muted");
  assert.equal((await patch(botDm.id, false)).status, 200, "a removed bot's DM can be unmuted");
  const unmuted = await stored(botDm.id);
  assert.equal(unmuted?.activityMuted, false);
  assert.equal(prefsEvents(), 2);
  await refused(botDm.id, "a removed bot's DM, unmuted");
  assert.deepEqual(await stored(botDm.id), unmuted, "a refused mute leaves the stored state alone");
  assert.equal(prefsEvents(), 2, "a refused mute emits nothing");
});

test("a muted App bot DM keeps the bot's messages out of Activity and push; an @mention still reaches the person", async ({ app }) => {
  const owner = await seedUser("bot-dm-quiet-owner@slock.test", "bot-dm-quiet-owner");
  const server = await createServer("Bot DM Quiet", "bot-dm-quiet", owner.id);
  const bot = await seedAppBot(server.id, owner.id);
  const dm = await findOrCreateDM(server.id, owner.id, bot.agentId);
  assert.ok(dm);
  const ownerHeaders = headers(await tokenForHuman(owner.email), server.id);
  const muteRes = await fetch(`${app.baseUrl}/api/channels/${dm.id}/notification-settings`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ activityMuted: true }),
  });
  assert.equal(muteRes.status, 200);

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const orchestrator = withChannelDelivery({ deliverMessage: async () => {} }) as unknown as AgentOrchestrator;
  const botSays = async (content: string) => {
    sink.clear();
    const message = await withTraceRoot(tracer, "test.bot_dm.message", { surface: "server", kind: "server" }, () =>
      broadcastAndDeliver(app.io, orchestrator, {
        channelId: dm.id,
        senderType: "agent",
        senderId: bot.agentId,
        senderName: "DM Mute Bot",
        content,
      }));
    // Every transport's audience is the notification outbox (services/notifications/enqueue.ts).
    const outbox = await getDb().select({ id: notificationOutbox.id }).from(notificationOutbox).where(and(
      eq(notificationOutbox.messageId, message.id),
      eq(notificationOutbox.receiverId, owner.id),
    ));
    const facts = await getDb().select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, message.id),
      eq(inboxNotificationFacts.receiverType, "user"),
      eq(inboxNotificationFacts.receiverId, owner.id),
    ));
    return { notificationTargets: outbox.length, facts: facts.length };
  };
  const dmInActivity = async (filter: "all" | "mentions") => {
    const res = await fetch(`${app.baseUrl}/api/channels/inbox?filter=${filter}`, { headers: ownerHeaders });
    assert.equal(res.status, 200);
    const body = await res.json() as { items: Array<{ kind: string; channelId?: string }> };
    return body.items.some((item) => item.channelId === dm.id);
  };

  assert.deepEqual(await botSays("ordinary bot update"), { notificationTargets: 0, facts: 0 });
  assert.equal(await dmInActivity("all"), false, "a muted bot message adds no Activity row");

  assert.deepEqual(await botSays(`@${owner.name} this one is for you`), { notificationTargets: 1, facts: 1 });
  assert.equal(await dmInActivity("mentions"), true, "a personal @mention pierces the DM mute");
});
