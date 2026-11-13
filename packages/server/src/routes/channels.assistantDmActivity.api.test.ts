import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { withChannelDelivery } from "../test/orchestratorStub";
import { getDb } from "../db/index";
import { agents, inboxNotificationFacts, inboxTargetMuteStates, notificationOutbox } from "../db/schema";
import { createAgent, deleteAgent } from "../services/agentService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { keepAssistantDmOutOfActivity } from "../services/assistantService";
import { findOrCreateDM, getInboxTargetActivityMuteState, setInboxTargetActivityMuteState } from "../services/channelService";
import { broadcastAndDeliver } from "../services/messageService";
import { drainNotificationOutbox, drainNotificationTasksForTests } from "../services/notifications/dispatcher";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

// An owner's DM with their personal assistant stays out of their Activity
// (tygg, #proj-assistant a859e8fd): no row, no Activity count. The DM keeps its
// own unread count (the composer's otter reads it) and its notifications: the
// sending transaction writes the owner's notification_outbox row (every
// transport drains from it; docs/contracts/notifications.md).

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedAssistantDm(label: string) {
  const owner = await seedUser(`assistant-dm-${label}@slock.test`, `assistant-dm-${label}`);
  const server = await createServer(`Assistant DM ${label}`, `assistant-dm-${label}`, owner.id);
  const assistant = await createAgent(server.id, `assistant-dm-${label}-otter`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const dm = await findOrCreateDM(server.id, owner.id, assistant.id);
  assert.ok(dm);
  await keepAssistantDmOutOfActivity({ serverId: server.id, ownerUserId: owner.id, dmChannelId: dm.id });
  return { owner, server, assistant, dm };
}

function assistantSays(app: { io: Parameters<typeof broadcastAndDeliver>[0] }, f: Awaited<ReturnType<typeof seedAssistantDm>>) {
  const orchestrator = withChannelDelivery({ deliverMessage: async () => {} }) as unknown as AgentOrchestrator;
  return async (content: string) => {
    const message = await broadcastAndDeliver(app.io, orchestrator, {
      channelId: f.dm.id,
      senderType: "agent",
      senderId: f.assistant.id,
      senderName: "Otter",
      content,
    });
    // The send drains its own rows in the background; settle it, then anything it left.
    await drainNotificationTasksForTests();
    await drainNotificationOutbox(100);
    const outbox = await getDb().select({ category: notificationOutbox.category, decision: notificationOutbox.decision }).from(notificationOutbox).where(and(
      eq(notificationOutbox.messageId, message.id),
      eq(notificationOutbox.receiverType, "user"),
      eq(notificationOutbox.receiverId, f.owner.id),
    ));
    assert.ok(outbox.every((row) => row.category === "dm"), JSON.stringify(outbox));
    const facts = await getDb().select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, message.id),
      eq(inboxNotificationFacts.receiverType, "user"),
      eq(inboxNotificationFacts.receiverId, f.owner.id),
    ));
    return { outboxRows: outbox.length, decisions: outbox.map((row) => row.decision), facts: facts.length };
  };
}

test("an assistant's message stays out of its owner's Activity and its count, keeps the DM's unread count and its push", async ({ app }) => {
  const f = await seedAssistantDm("quiet");
  const ownerHeaders = headers(await tokenForHuman(f.owner.email), f.server.id);
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: ownerHeaders });
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return await res.json() as T;
  };
  const says = assistantSays(app, f);

  // Notifications: an outbox row and an inbox fact per message, as for any DM,
  // and the dispatcher notifies (the Activity-only mute is not a notification mute).
  assert.deepEqual(await says("Morning brief: two things wait for you"), { outboxRows: 1, decisions: ["notify"], facts: 1 });
  assert.deepEqual(await says("and a third"), { outboxRows: 1, decisions: ["notify"], facts: 1 });

  // Activity: no row, and nothing counted.
  for (const filter of ["all", "unread"]) {
    const inbox = await get<{ items: Array<{ channelId?: string; threadChannelId?: string }>; totalUnreadCount: number }>(`/api/channels/inbox?filter=${filter}&limit=100`);
    assert.ok(!inbox.items.some((item) => item.channelId === f.dm.id), `${filter}: ${JSON.stringify(inbox.items)}`);
    assert.equal(inbox.totalUnreadCount, 0, filter);
  }

  // The DM's own unread count stays.
  const summary = await get<{ channels: Record<string, { unreadCount: number }> }>("/api/channels/unread?summary=1");
  assert.equal(summary.channels[f.dm.id]?.unreadCount, 2, JSON.stringify(summary));

  // It never reads as a mute the owner chose.
  const dms = await get<Array<{ id: string; activityMuted?: boolean }>>("/api/channels/dm");
  assert.equal(dms.find((dm) => dm.id === f.dm.id)?.activityMuted, false, JSON.stringify(dms));
});

test("the assistant DM reads the same mute state from the DM list and from every single-DM read", async ({ app }) => {
  const f = await seedAssistantDm("same-state");
  const ownerHeaders = headers(await tokenForHuman(f.owner.email), f.server.id);
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: ownerHeaders });
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return await res.json() as T;
  };
  type MuteState = { activityMuted?: boolean; muteFromSeq?: number | null; activityMuteSupported?: boolean };
  const pick = (state: MuteState | undefined) => ({
    activityMuted: state?.activityMuted,
    muteFromSeq: state?.muteFromSeq,
    activityMuteSupported: state?.activityMuteSupported,
  });
  const expected = { activityMuted: false, muteFromSeq: null, activityMuteSupported: false };

  const dms = await get<Array<MuteState & { id: string }>>("/api/channels/dm");
  assert.deepEqual(pick(dms.find((dm) => dm.id === f.dm.id)), expected, "GET /channels/dm");
  assert.deepEqual(pick(await get<MuteState>(`/api/channels/${f.dm.id}`)), expected, "GET /channels/:id");
  assert.deepEqual(pick(await get<MuteState>(`/api/channels/${f.dm.id}/notification-settings`)), expected, "GET /channels/:id/notification-settings");
  const service = await getInboxTargetActivityMuteState("user", f.owner.id, f.dm.id);
  assert.equal(service.activityMuted, false);
  assert.equal(service.muteFromSeq, null);

  // Unmuting what already reads as unmuted changes nothing: the row that keeps
  // the DM out of Activity stays.
  const unmute = await setInboxTargetActivityMuteState({
    receiverType: "user",
    receiverId: f.owner.id,
    serverId: f.server.id,
    sourceChannelId: f.dm.id,
    activityMuted: false,
  });
  assert.equal(unmute.changed, false);
  const [row] = await getDb().select().from(inboxTargetMuteStates).where(and(
    eq(inboxTargetMuteStates.receiverType, "user"),
    eq(inboxTargetMuteStates.receiverId, f.owner.id),
    eq(inboxTargetMuteStates.sourceChannelId, f.dm.id),
  ));
  assert.equal(row?.activityMuted, true);
  assert.equal(row?.pushMuted, false);
});

test("the owner's own mute of the assistant DM silences its notifications like any mute; deleting the assistant makes it an ordinary DM", async ({ app }) => {
  const f = await seedAssistantDm("owned");
  const says = assistantSays(app, f);
  const mute = (activityMuted: boolean) => setInboxTargetActivityMuteState({
    receiverType: "user",
    receiverId: f.owner.id,
    serverId: f.server.id,
    sourceChannelId: f.dm.id,
    activityMuted,
  });
  await mute(true);
  assert.deepEqual(await says("while muted"), { outboxRows: 0, decisions: [], facts: 0 });

  // Deleting the assistant drops only its DM's row, not a mute the owner chose.
  const other = await seedAssistantDm("deleted");
  const [kept] = await getDb().select().from(inboxTargetMuteStates).where(eq(inboxTargetMuteStates.sourceChannelId, f.dm.id));
  assert.equal(kept?.pushMuted, true);
  await deleteAgent(f.assistant.id);
  await deleteAgent(other.assistant.id);
  const rows = await getDb().select({ sourceChannelId: inboxTargetMuteStates.sourceChannelId }).from(inboxTargetMuteStates)
    .where(eq(inboxTargetMuteStates.receiverType, "user"));
  const channels = rows.map((row) => row.sourceChannelId);
  assert.ok(channels.includes(f.dm.id), "the owner's own mute stays");
  assert.ok(!channels.includes(other.dm.id), "the assistant DM's row goes with the assistant");
});
