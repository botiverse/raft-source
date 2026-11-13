// RFC 074 §2 personal assistant: the two assistant-only reads and the
// one-DM confinement. The assistant always calls with its own credential;
// these tests pin that every read re-checks the link, that
// DMs (and threads under DMs) never come back, and that reading changes none
// of the owner's state.
import assert from "node:assert/strict";
import { insertLinkedAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import { getDb } from "../db/index";
import { agentApiContract, DELEGATED_RECEIPT_KIND, normalizeLegacyRetraction, projectRaftMessage, projectRaftMessagesInTarget, type AgentApiMessageEnvelope } from "@botiverse/raft-shared";
import { agentCredentials, agents, assistantDoorbells, thirdPartyAgentEvents, serverMembers, servers, attachmentObjectHolds, attachmentObjects, attachments, channelAgents, channels, featureFlags, externalAppInstalls, externalAppRegistrations, externalAppServerGrants, externalChannelBindings, integrationAuditEvents, jointChannels, oauthClients, jointChannelServers, messages, threadFollows, users } from "../db/schema";
import { Readable } from "node:stream";
import { __setStorageForTests, resetStorageForTests } from "../services/storageService";
import { ASSISTANT_ALLOWED_AGENT_API_ROUTES, isAssistantAgentApiRequestAllowed } from "../services/assistantRouteAllowlist";
import { assistantDoorbellCoalesceMs, isDmScopedChannel, recordAssistantDoorbells, setAssistantReadsDms } from "../services/assistantService";
import { delegatedReceiptsQuery, retractDelegatedMessage, setAssistantSendAsOwner } from "../services/assistantSendAsOwnerService";
import { mutateMessageReaction } from "../services/messageReactionService";
import { addMember, removeMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient } from "../services/oauthService";
import { renameOAuthClientKey } from "../services/oauthClientKeys";
import { mintAgentCredential, type AgentCapability } from "../services/agentCredentialService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addAgent, addHuman, archiveChannel, canAgentPostToChannel, createChannel, setInboxTargetActivityMuteState, findOrCreateAgentDM, findOrCreateDM, findOrCreateUserDM, findHumanAgentDmChannelId, getChannel, isChannelHuman, getJointThreadProjectionByLocalThread, getSystemAllChannel, getOrCreateThread, removeAgent } from "../services/channelService";
import { __setMessageServiceDepsForTests, __resetMessageServiceDepsForTests, __setExternalAgentInboxChainSelectorForTests, appendAgentFacingForwardedSnapshot, createMessage } from "../services/messageService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// CI has no RisingWave: an external agent's inbox pull reads the test-only reference chain.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

async function enableBorrowing(enabled = true) {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: enabled }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: enabled });
}

async function seedFixture() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`assistant-owner-${suffix}@slock.test`, `assistant-owner-${suffix}`);
  const peer = await seedUser(`assistant-peer-${suffix}@slock.test`, `assistant-peer-${suffix}`);
  const server = await createServer("Assistant Server", `assistant-${suffix}`, owner.id);
  await addMember(server.id, peer.id);

  const room = await createChannel(server.id, `room-${suffix}`);
  await addHuman(room.id, owner.id);
  await addHuman(room.id, peer.id);
  const roomMessage = await createMessage(room.id, "user", peer.id, "room activity");
  const roomThread = await getOrCreateThread(roomMessage.id, peer.id, "user");
  await createMessage(roomThread.id, "user", peer.id, "room thread reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: roomThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: roomMessage.id,
    reason: "manual",
  });

  // A private channel the owner is NOT in: never visible to the assistant.
  const secret = await createChannel(server.id, `secret-${suffix}`, undefined, "private");
  await addHuman(secret.id, peer.id);
  await createMessage(secret.id, "user", peer.id, "private chatter");

  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);
  const dmMessage = await createMessage(dm.id, "user", peer.id, "dm activity");
  const dmThread = await getOrCreateThread(dmMessage.id, peer.id, "user");
  await createMessage(dmThread.id, "user", peer.id, "dm thread reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: dmThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: dmMessage.id,
    reason: "manual",
  });

  const assistant = await createAgent(server.id, `assistant-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const credential = await mintAgentCredential({ agentId: assistant.id, scopes: ["read"], name: "assistant-test", issuedVia: "computer", createdByUserId: null });
  return { owner, peer, server, room, roomThread, secret, dm, dmThread, assistant, apiKey: credential.apiKey };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/** The SDK projection's targets for an owner-messages page; throws if it would drop an envelope. */
function projectedTargets(body: Record<string, any>): string[] {
  return (body.messages as AgentApiMessageEnvelope[]).map((envelope, index) => {
    const projected = projectRaftMessage(envelope);
    assert.ok(projected, `message ${index} names no conversation: ${JSON.stringify(envelope)}`);
    return projected.target;
  });
}

async function agentGet(baseUrl: string, apiKey: string, path: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

/** Links (or clears) the fixture agent as the owner's assistant, as POST /assistant would. */
async function setAssistant(f: Fixture, linked: boolean, agentId = f.assistant.id) {
  await getDb().update(agents).set({ assistantOwnerUserId: linked ? f.owner.id : null }).where(eq(agents.id, agentId));
}

async function ownerUnread(baseUrl: string, f: Fixture): Promise<Record<string, number>> {
  const token = await tokenForHuman(f.owner.email);
  const res = await fetch(`${baseUrl}/api/channels/inbox?filter=unread&limit=100`, { headers: headers(token, f.server.id) });
  assert.equal(res.status, 200);
  const body = await res.json() as { items: Array<{ kind: string; channelId?: string; threadChannelId?: string; unreadCount: number }> };
  return Object.fromEntries(body.items.map((item) => [item.kind === "thread" ? item.threadChannelId! : item.channelId!, item.unreadCount]));
}

test("the owner inbox lists what the owner sees, DMs included unless the owner turns that off, never the assistant's own DM, and reads nothing", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  // The assistant's own DM with its owner, with something unread in it.
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  await createMessage(ownDm.id, "agent", f.assistant.id, "assistant summary");
  const before = await ownerUnread(app.baseUrl, f);
  assert.ok(before[f.dm.id] && before[f.dmThread.id], "fixture: the owner has unread DM activity");

  const inbox = await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox?filter=unread&limit=50");
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.body.owner, { userId: f.owner.id });
  const items = inbox.body.items as Array<Record<string, any>>;
  const ids = items.map((item) => item.channelId);
  assert.ok(ids.includes(f.room.id));
  assert.ok(ids.includes(f.roomThread.id));
  // RFC 077: DMs (and threads under them) come back, named from the owner's side.
  const dmItem = items.find((item) => item.channelId === f.dm.id);
  assert.equal(dmItem?.channelType, "dm");
  assert.equal(dmItem?.channelName, f.peer.name, "a DM is named by the other person, not its storage name");
  const dmThreadItem = items.find((item) => item.channelId === f.dmThread.id);
  assert.equal(dmThreadItem?.kind, "thread");
  assert.equal(dmThreadItem?.channelName, f.peer.name);
  assert.ok(!ids.includes(ownDm.id), "never the assistant's own DM with its owner");
  assert.ok(!ids.includes(f.secret.id), "a channel the owner cannot see never comes back");
  const thread = items.find((item) => item.channelId === f.roomThread.id);
  assert.equal(thread?.kind, "thread");
  assert.equal(thread?.parentChannelId, f.room.id);
  // `latestSeq` is the conversation's latest message seq, matched against a doorbell's `sources[].max_seq`.
  const latestSeqOf = async (channelId: string) => Math.max(...(await getDb().select({ seq: messages.seq }).from(messages).where(eq(messages.channelId, channelId))).map((row) => Number(row.seq)));
  const room = items.find((item) => item.channelId === f.room.id);
  assert.equal(room?.latestSeq, await latestSeqOf(f.room.id));
  assert.equal(thread?.latestSeq, await latestSeqOf(f.roomThread.id));

  // The owner turns DM reading off: DMs drop out at once.
  await setAssistantReadsDms(f.assistant.id, false);
  const closed = await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox?filter=unread&limit=50");
  const closedIds = (closed.body.items as Array<{ channelId: string }>).map((item) => item.channelId);
  assert.ok(closedIds.includes(f.room.id));
  assert.ok(!closedIds.includes(f.dm.id) && !closedIds.includes(f.dmThread.id), "no DM once the owner turns it off");

  assert.deepEqual(await ownerUnread(app.baseUrl, f), before, "listing changes none of the owner's read state");
});

test("owner messages reads what the owner can see, DMs included unless turned off, never the assistant's own DM, with the neutral 404", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  const before = await ownerUnread(app.baseUrl, f);

  const room = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${f.room.id}`);
  assert.equal(room.status, 200);
  assert.deepEqual((room.body.messages as Array<{ content: string }>).map((m) => m.content), ["room activity"]);
  const thread = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${f.roomThread.id}`);
  assert.equal(thread.status, 200);
  assert.deepEqual((thread.body.messages as Array<{ content: string }>).map((m) => m.content), ["room thread reply"]);
  // Contract with the SDK: every envelope names its conversation, so
  // `projectRaftMessage` keeps it (it drops an envelope without one).
  assert.deepEqual(projectedTargets(room.body), [`#${f.room.name}`]);
  const threadRow = await getChannel(f.roomThread.id);
  assert.deepEqual(projectedTargets(thread.body), [`#${f.room.name}:${threadRow!.name.replace(/^thread-/, "")}`]);

  // RFC 077: the owner's DMs read as `dm:@<peer>` from the owner's side.
  const dm = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${f.dm.id}`);
  assert.equal(dm.status, 200);
  assert.deepEqual((dm.body.messages as Array<{ content: string }>).map((m) => m.content), ["dm activity"]);
  assert.deepEqual(projectedTargets(dm.body), [`dm:@${f.peer.name}`]);
  const dmThread = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${f.dmThread.id}`);
  assert.equal(dmThread.status, 200);
  const dmThreadRow = await getChannel(f.dmThread.id);
  assert.deepEqual(projectedTargets(dmThread.body), [`dm:@${f.peer.name}:${dmThreadRow!.name.replace(/^thread-/, "")}`]);

  for (const channelId of [ownDm.id, f.secret.id, randomUUID()]) {
    const refused = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${channelId}`);
    assert.equal(refused.status, 404, channelId);
    assert.deepEqual(refused.body, { error: "Channel not found or not visible", code: "channel_not_found", errorCode: "channel_not_found" });
  }
  await setAssistantReadsDms(f.assistant.id, false);
  for (const channelId of [f.dm.id, f.dmThread.id]) {
    const refused = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${channelId}`);
    assert.equal(refused.status, 404, `DM reading off: ${channelId}`);
  }

  assert.deepEqual(await ownerUnread(app.baseUrl, f), before, "reading changes none of the owner's read state");
});

test("every read re-checks the link, the owner's membership, and the flag", async ({ app }) => {
  const f = await seedFixture();
  const expectRefused = async (label: string) => {
    for (const path of ["/assistant/owner-inbox", `/assistant/owner-messages?channelId=${f.room.id}`]) {
      const res = await agentGet(app.baseUrl, f.apiKey, path);
      assert.equal(res.status, 403, `${label}: ${path}`);
      assert.equal(res.body.code, "assistant_not_enabled", `${label}: ${path}`);
    }
  };

  await enableBorrowing();
  await expectRefused("not an assistant");
  await setAssistant(f, true);
  assert.equal((await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox")).status, 200);

  await enableBorrowing(false);
  await expectRefused("flag off");
  await enableBorrowing(true);
  assert.equal((await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox")).status, 200);

  await setAssistant(f, false);
  await expectRefused("link cleared");
  await setAssistant(f, true);

  // The owner leaves the server (here: the peer's server, so removal is allowed).
  const suffix = randomUUID().slice(0, 8);
  const host = await seedUser(`assistant-host-${suffix}@slock.test`, `assistant-host-${suffix}`);
  const hosted = await createServer("Hosted", `assistant-hosted-${suffix}`, host.id);
  await addMember(hosted.id, f.owner.id);
  const hostedAssistant = await createAgent(hosted.id, `hosted-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: f.owner.id });
  const hostedKey = (await mintAgentCredential({ agentId: hostedAssistant.id, scopes: ["read"], name: "hosted", issuedVia: "computer", createdByUserId: null })).apiKey;
  await getDb().update(agents).set({ assistantOwnerUserId: f.owner.id }).where(eq(agents.id, hostedAssistant.id));
  assert.equal((await agentGet(app.baseUrl, hostedKey, "/assistant/owner-inbox")).status, 200);
  // Every read re-checks the owner's membership (the row gone, however it went).
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, hosted.id), eq(serverMembers.userId, f.owner.id)));
  const withoutMembership = await agentGet(app.baseUrl, hostedKey, "/assistant/owner-inbox");
  assert.equal(withoutMembership.status, 403);
  assert.equal(withoutMembership.body.code, "assistant_not_enabled");
  // Removed through removeMember: the assistant is archived with its owner and its credentials revoked.
  await addMember(hosted.id, f.owner.id);
  assert.equal((await agentGet(app.baseUrl, hostedKey, "/assistant/owner-inbox")).status, 200);
  await removeMember(hosted.id, f.owner.id);
  assert.equal((await agentGet(app.baseUrl, hostedKey, "/assistant/owner-inbox")).status, 401);
});

async function agentSend(baseUrl: string, apiKey: string, target: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/v2/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target, content: `to ${target}`, idempotencyKey: randomUUID() }),
  });
  return { status: res.status, body: await res.text() };
}

test("an assistant is only in its DM with its owner: link, add, DM and send are all held to it", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();

  await setAssistant(f, true);

  // Nobody can add it to a channel afterwards.
  const ownerToken = await tokenForHuman(f.owner.email);
  const add = await fetch(`${app.baseUrl}/api/channels/${f.room.id}/members`, {
    method: "POST",
    headers: headers(ownerToken, f.server.id),
    body: JSON.stringify({ agentId: f.assistant.id }),
  });
  assert.equal(add.status, 403);
  assert.equal((await add.json() as { code?: string }).code, "assistant_channel_forbidden");
  await assert.rejects(addAgent(f.room.id, f.assistant.id), /only be in its DM with its owner/);

  // Only the owner gets a DM with it; other people and agents get none.
  assert.equal(await findOrCreateDM(f.server.id, f.peer.id, f.assistant.id), null);
  const other = await createAgent(f.server.id, `other-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  assert.equal(await findOrCreateAgentDM(f.server.id, other.id, f.assistant.id), null);

  // It posts only in the owner DM (and its threads): not a channel, not #all, not a DM with anyone else.
  const sendKey = (await mintAgentCredential({ agentId: f.assistant.id, scopes: ["send", "read"], name: "assistant-send", issuedVia: "computer", createdByUserId: null })).apiKey;
  assert.equal((await agentSend(app.baseUrl, sendKey, `dm:@${f.owner.name}`)).status, 200);
  assert.notEqual((await agentSend(app.baseUrl, sendKey, `dm:@${f.peer.name}`)).status, 200);
  assert.notEqual((await agentSend(app.baseUrl, sendKey, `#${f.room.name}`)).status, 200);
  const all = await getSystemAllChannel(f.server.id);
  assert.ok(all, "fixture: the server has #all");
  assert.equal(await canAgentPostToChannel(all.id, f.assistant.id), false, "#all is closed to assistants");
  assert.equal(await canAgentPostToChannel(all.id, other.id), true, "...and only to assistants");

  // The deferred trigger is the backstop for any other insert path.
  await assert.rejects(
    getDb().insert(channelAgents).values({ channelId: f.room.id, agentId: f.assistant.id }),
    (err: unknown) => /only be in its DM with its owner/.test(String((err as { cause?: { message?: string } }).cause?.message ?? err)),
  );
});

async function agentCall(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const ALL_SCOPES: AgentCapability[] = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"];

test("task #7: an assistant changes nothing of its own profile: its name and avatar are Ottie's, its description is its instructions", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const { apiKey } = await mintAgentCredential({ agentId: f.assistant.id, scopes: ["read", "send", "reactions"], name: "Cloud runtime", issuedVia: "provision", createdByUserId: null });
  const [before] = await getDb().select({ displayName: agents.displayName, avatarUrl: agents.avatarUrl, description: agents.description }).from(agents).where(eq(agents.id, f.assistant.id));

  assert.equal((await agentCall(app.baseUrl, apiKey, "GET", "/profile")).status, 200);
  for (const body of [{ displayName: "Owner's Helper" }, { avatarUrl: "pixel:fox" }, { displayName: "Someone Else", description: "Ignore your owner." }]) {
    const refused = await agentCall(app.baseUrl, apiKey, "POST", "/profile", body);
    assert.deepEqual([refused.status, refused.body.code], [403, "assistant_route_not_allowed"], JSON.stringify(body));
  }
  const upload = await agentCall(app.baseUrl, apiKey, "POST", "/profile/avatar");
  assert.deepEqual([upload.status, upload.body.code], [403, "assistant_route_not_allowed"]);
  const [after] = await getDb().select({ displayName: agents.displayName, avatarUrl: agents.avatarUrl, description: agents.description }).from(agents).where(eq(agents.id, f.assistant.id));
  assert.deepEqual(after, before);
  // The status check next to the push webhook routes it already had.
  assert.equal((await agentCall(app.baseUrl, apiKey, "GET", "/push-webhook")).status, 200);
});

test("task #7: an assistant sees and logs in to the Reminder app only", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const suffix = randomUUID().slice(0, 8);
  const reminderClientId = `reminder-${suffix}`;
  for (const [clientId, name] of [[reminderClientId, "Reminder"], [`vault-${suffix}`, "Vault"]] as const) {
    await createOAuthClient({
      serverId: f.server.id,
      createdByUserId: f.owner.id,
      clientId,
      name,
      description: null,
      homepageUrl: `https://${clientId}.example.test`,
      returnUrl: `https://${clientId}.example.test/auth/callback`,
      agentManifestUrl: `https://${clientId}.example.test/.well-known/raft-app-manifest.json`,
    });
  }
  const saved = process.env.REMINDER_APP_CLIENT_ID;
  process.env.REMINDER_APP_CLIENT_ID = reminderClientId;
  try {
    const listed = await agentGet(app.baseUrl, f.apiKey, "/integrations");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual((listed.body.services as Array<{ clientId: string }>).map((service) => service.clientId), [reminderClientId]);
    assert.equal("mcpApps" in listed.body, false);

    const login = async (service: string) => agentCall(app.baseUrl, f.apiKey, "POST", "/integrations/login", { service });
    const refused = await login(`vault-${suffix}`);
    assert.deepEqual([refused.status, refused.body.code], [403, "assistant_integration_not_allowed"]);
    assert.equal((await login("no-such-app")).body.code, "assistant_integration_not_allowed", "an unknown service is refused the same way");
    const ok = await login(reminderClientId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "logged_in");
    assert.deepEqual((await agentGet(app.baseUrl, f.apiKey, "/integrations")).body.activeLogins.map((item: { clientId: string }) => item.clientId), [reminderClientId]);

    // RFC 084: the deployment's setting keeps the old id, and the trust follows the App.
    const renamed = `reminder-renamed-${suffix}`;
    const reminderApp = (await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.clientId, reminderClientId)))[0];
    await getDb().transaction((tx) => renameOAuthClientKey(tx, { clientId: reminderApp.id, newKey: renamed, actor: { type: "human", id: f.owner.id } }));
    const afterRename = await agentGet(app.baseUrl, f.apiKey, "/integrations");
    assert.deepEqual((afterRename.body.services as Array<{ clientId: string }>).map((service) => service.clientId), [renamed]);
    assert.deepEqual(afterRename.body.activeLogins.map((item: { clientId: string }) => item.clientId), [renamed]);
    assert.equal((await login(reminderClientId)).status, 200, "the old id still logs in");
    assert.equal((await login(renamed)).status, 200, "the new id logs in");
    assert.equal((await login(`vault-${suffix}`)).status, 403, "still the only App it may use");

    // No Reminder app on this deployment: no app at all.
    delete process.env.REMINDER_APP_CLIENT_ID;
    assert.deepEqual((await agentGet(app.baseUrl, f.apiKey, "/integrations")).body.services, []);
    assert.equal((await login(reminderClientId)).status, 403);
  } finally {
    if (saved === undefined) delete process.env.REMINDER_APP_CLIENT_ID; else process.env.REMINDER_APP_CLIENT_ID = saved;
  }
});

test("an assistant's credential reaches only the allowlisted routes; every other route answers 403", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const key = (await mintAgentCredential({ agentId: f.assistant.id, scopes: ALL_SCOPES, name: "assistant-all", issuedVia: "computer", createdByUserId: null })).apiKey;
  const allowed = new Set<string>(ASSISTANT_ALLOWED_AGENT_API_ROUTES);

  // Every contract route: refused at authentication unless allowlisted.
  for (const [key_, route] of Object.entries(agentApiContract)) {
    const path = route.path.replace(/:[A-Za-z]+/g, randomUUID());
    assert.equal(isAssistantAgentApiRequestAllowed(route.method, `/internal/agent-api${path}`), allowed.has(key_), key_);
    if (allowed.has(key_)) continue;
    const res = await agentCall(app.baseUrl, key, route.method, path, route.method === "GET" ? undefined : {});
    assert.equal(res.status, 403, `${key_}: ${route.method} ${path}`);
    assert.equal(res.body.code, "assistant_route_not_allowed", `${key_}: ${route.method} ${path}`);
  }
  // Routes outside the contract, and the legacy send, too.
  for (const [method, path] of [
    ["POST", "/send"],
    ["GET", "/wake-hints"],
    ["GET", "/wake-hints/stream"],
    ["POST", "/server/avatar"],
    ["GET", `/mentions/${randomUUID()}/delivery`],
    ["GET", `/messages/${randomUUID()}/mention-deliveries`],
    ["POST", `/attachments/${randomUUID()}/comments`],
    ["GET", "/no-such-route"],
  ] as const) {
    const res = await agentCall(app.baseUrl, key, method, path, method === "GET" ? undefined : {});
    // A few of these sit behind another auth surface that refuses an agent credential outright.
    if (res.status === 401) continue;
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.code, "assistant_route_not_allowed", `${method} ${path}`);
  }
  // The allowlisted self routes work.
  assert.equal((await agentCall(app.baseUrl, key, "GET", "")).status, 200, "whoami");
  assert.equal((await agentCall(app.baseUrl, key, "GET", "/context")).status, 200);
  assert.equal((await agentCall(app.baseUrl, key, "GET", "/assistant/owner-inbox")).status, 200);

  // An ordinary agent is untouched; an assistant whose link is cleared is ordinary again.
  await setAssistant(f, false);
  const wake = await agentCall(app.baseUrl, key, "GET", "/wake-hints");
  assert.notEqual(wake.body.code, "assistant_route_not_allowed");
});

test("an assistant reads and reacts only in its DM with its owner", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const dm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(dm, "fixture: the owner DM");
  const key = (await mintAgentCredential({ agentId: f.assistant.id, scopes: ["read", "send", "reactions"], name: "assistant-dm", issuedVia: "computer", createdByUserId: null })).apiKey;
  const dmMessage = await createMessage(dm.id, "user", f.owner.id, "hello assistant");
  const roomMessage = await createMessage(f.room.id, "user", f.peer.id, "public room message");

  const dmHistory = await agentCall(app.baseUrl, key, "GET", `/history?channel=${encodeURIComponent(`dm:@${f.owner.name}`)}&consume=false`);
  assert.equal(dmHistory.status, 200);
  assert.ok((dmHistory.body.messages as Array<{ content: string }>).some((m) => m.content === "hello assistant"));
  // A public channel any ordinary agent could read is not the assistant's.
  const roomHistory = await agentCall(app.baseUrl, key, "GET", `/history?channel=${encodeURIComponent(`#${f.room.name}`)}&consume=false`);
  assert.equal(roomHistory.status, 404);

  assert.equal((await agentCall(app.baseUrl, key, "POST", `/messages/${dmMessage.id}/reactions`, { emoji: "👍" })).status, 200);
  assert.equal((await agentCall(app.baseUrl, key, "POST", `/messages/${roomMessage.id}/reactions`, { emoji: "👍" })).status, 404);
});

test("a joint thread the owner can see is readable and rings the doorbell; a DM thread does not when DM reading is off", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const db = getDb();
  // A joint channel hosted on the peer's server, projected into the owner's server.
  const suffix = randomUUID().slice(0, 8);
  const host = await createServer("Joint Host", `assistant-joint-host-${suffix}`, f.peer.id);
  const [canonical, hostLocal, local] = await db.insert(channels).values([
    { serverId: host.id, name: `joint-canonical-${suffix}`, type: "joint" },
    { serverId: host.id, name: `joint-host-${suffix}`, type: "joint" },
    { serverId: f.server.id, name: `joint-local-${suffix}`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: host.id, createdByUserId: f.peer.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: f.peer.id },
    { jointChannelId: joint!.id, serverId: f.server.id, localChannelId: local!.id, role: "participant", status: "active", joinedByUserId: f.owner.id },
  ]);
  await addHuman(local!.id, f.owner.id);
  const root = await createMessage(canonical!.id, "user", f.peer.id, "joint thread root");
  const [canonicalThread, localThread] = await db.insert(channels).values([
    { serverId: host.id, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: root.id },
    { serverId: f.server.id, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: null },
  ]).returning();
  await db.update(messages).set({ threadId: canonicalThread!.id }).where(eq(messages.id, root.id));
  const [jointThread] = await db.insert(jointChannels).values({ canonicalChannelId: canonicalThread!.id, createdByServerId: host.id, createdByUserId: f.peer.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: jointThread!.id, serverId: f.server.id, localChannelId: localThread!.id, role: "participant", status: "active", joinedByUserId: f.owner.id });
  assert.ok(await getJointThreadProjectionByLocalThread(localThread!.id, f.server.id), "fixture: a live joint thread projection");
  const reply = await createMessage(canonicalThread!.id, "user", f.peer.id, "joint thread reply");

  assert.equal(await isDmScopedChannel(localThread!), false, "a joint thread is not a DM thread");
  const dmThreadRow = await getChannel(f.dmThread.id);
  assert.ok(dmThreadRow);
  assert.equal(await isDmScopedChannel(dmThreadRow), true);

  const read = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${localThread!.id}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(projectedTargets(read.body), [`#${local!.name}:${localThread!.name.replace(/^thread-/, "")}`]);
  assert.equal((read.body.messages as Array<Record<string, unknown>>)[0]?.parent_channel_type, "joint");

  await db.delete(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id));
  const fact = (sourceChannelId: string) => ({
    receiverType: "user" as const, receiverId: f.owner.id, serverId: f.server.id, kind: "thread" as const,
    sourceChannelId, messageId: reply.id, messageSeq: reply.seq, activityAt: new Date(),
  });
  await setAssistantReadsDms(f.assistant.id, false);
  assert.equal(await recordAssistantDoorbells([fact(f.dmThread.id)], db), 0, "a DM thread does not ring once the owner turns DM reading off");
  assert.equal(await recordAssistantDoorbells([fact(localThread!.id)], db), 1, "a joint thread rings");
});

test("an assistant reports its own events delivered; another agent's row it names stays exactly as it was", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const db = getDb();
  const other = await createAgent(f.server.id, `other-${randomUUID().slice(0, 8)}`, { runtime: "codex", creatorType: "user", creatorId: f.peer.id });
  const row = (agentId: string) => ({
    serverId: f.server.id, agentId, systemApp: "system.assistant" as const, kind: "notification" as const, summary: "doorbell",
    payload: {}, payloadHash: randomUUID(), resource: "urn:test", status: "delivering" as const, expiresAt: new Date(Date.now() + 3_600_000),
  });
  const [own, theirs] = await db.insert(thirdPartyAgentEvents).values([row(f.assistant.id), row(other.id)]).returning();
  const before = (await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, theirs!.id)))[0];

  const reported = await agentCall(app.baseUrl, f.apiKey, "POST", "/third-party-events/delivered", { eventIds: [own!.id, theirs!.id] });
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.equal(reported.body.delivered, 1, "only its own row moves");
  const [mine] = await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, own!.id));
  assert.equal(mine?.status, "delivered");
  assert.ok(mine?.deliveredAt, "delivered_at is set");
  const after = (await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, theirs!.id)))[0];
  assert.deepEqual(after, before, "the other agent's still-delivering row is untouched");

  const alone = await agentCall(app.baseUrl, f.apiKey, "POST", "/third-party-events/delivered", { eventIds: [theirs!.id] });
  assert.equal(alone.status, 200);
  assert.equal(alone.body.delivered, 0);
  assert.deepEqual((await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, theirs!.id)))[0], before);
});

test("a channel the owner muted neither rings the assistant nor shows in its owner inbox, unless the owner is @mentioned", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const db = getDb();
  const muted = await createChannel(f.server.id, `muted-${randomUUID().slice(0, 8)}`);
  await addHuman(muted.id, f.owner.id);
  await addHuman(muted.id, f.peer.id);
  await setInboxTargetActivityMuteState({ receiverType: "user", receiverId: f.owner.id, serverId: f.server.id, sourceChannelId: muted.id, activityMuted: true });
  await db.delete(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id));
  const chatter = await createMessage(muted.id, "user", f.peer.id, "chatter after the mute");
  const fact = (personalMention: boolean) => ({
    receiverType: "user" as const, receiverId: f.owner.id, serverId: f.server.id, kind: "channel" as const,
    sourceChannelId: muted.id, messageId: chatter.id, messageSeq: chatter.seq, activityAt: new Date(), personalMention,
  });
  await db.delete(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id));
  assert.equal(await recordInboxNotificationFacts([fact(false)], db), 0, "chatter in a muted channel is not promoted");
  assert.equal((await db.select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id))).length, 0, "and does not ring");

  // The assistant reads the owner's inbox the way the owner sees it.
  const ownerSees = muted.id in await ownerUnread(app.baseUrl, f);
  const inbox = await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox?filter=unread&limit=50");
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  const assistantSees = (inbox.body.items as Array<{ channelId: string }>).some((item) => item.channelId === muted.id);
  assert.equal(ownerSees, false, "fixture: the owner's own Activity leaves the muted channel out");
  assert.equal(assistantSees, false, "and so does the assistant's owner inbox");

  assert.equal(await recordInboxNotificationFacts([fact(true)], db), 1, "an @mention pierces the mute");
  assert.equal((await db.select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id))).length, 1, "and rings");
});

test("an assistant's private surfaces are its owner's alone: no admin override", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  // The peer's assistant (created by the server owner, who is also an admin here).
  await getDb().update(agents).set({ assistantOwnerUserId: f.peer.id }).where(eq(agents.id, f.assistant.id));
  const activityLog = async (email: string, agentId = f.assistant.id) => {
    const token = await tokenForHuman(email);
    return (await fetch(`${app.baseUrl}/api/agents/${agentId}/activity-log`, { headers: headers(token, f.server.id) })).status;
  };
  assert.equal(await activityLog(f.owner.email), 404, "the server owner (and the agent's creator) finds no such agent");
  assert.equal(await activityLog(f.peer.email), 200, "the assistant's owner sees it");

  // An ordinary agent keeps the creator/admin rule.
  const ordinary = await createAgent(f.server.id, `ordinary-${randomUUID().slice(0, 8)}`, { runtime: "codex", creatorType: "user", creatorId: f.peer.id });
  assert.equal(await activityLog(f.owner.email, ordinary.id), 200, "admins still see ordinary agents");
});

test("the doorbell window is 5 minutes, overridable within bounds", () => {
  assert.equal(assistantDoorbellCoalesceMs({}), 5 * 60_000);
  assert.equal(assistantDoorbellCoalesceMs({ ASSISTANT_DOORBELL_COALESCE_MS: "30000" }), 30_000);
  assert.equal(assistantDoorbellCoalesceMs({ ASSISTANT_DOORBELL_COALESCE_MS: "10" }), 5 * 60_000, "below 1 s is ignored");
  assert.equal(assistantDoorbellCoalesceMs({ ASSISTANT_DOORBELL_COALESCE_MS: "nope" }), 5 * 60_000);
});

test("an assistant downloads attachments only from its owner DM", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const dm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(dm);
  const dmAttachment = randomUUID();
  const roomAttachment = randomUUID();
  await insertLinkedAttachmentsWithObjects([dmAttachment, roomAttachment].map((id) => ({
    id,
    channelId: id === dmAttachment ? dm.id : f.room.id,
    uploaderId: f.owner.id,
    uploaderType: "user" as const,
    filename: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    storageKey: `${f.server.id}/${id}.txt`,
  })));
  __setStorageForTests({
    put: async () => {},
    get: async () => Readable.from(Buffer.from("bytes")),
    delete: async () => {},
    getPresignedUrl: async () => "https://objects.example.test/signed",
  });
  try {
    assert.equal((await agentGet(app.baseUrl, f.apiKey, `/attachments/${dmAttachment}/url`)).status, 200);
    assert.equal((await agentGet(app.baseUrl, f.apiKey, `/attachments/${roomAttachment}/url`)).status, 404, "a public channel's attachment");
    const viaDownload = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${roomAttachment}`, { headers: { Authorization: `Bearer ${f.apiKey}` }, redirect: "manual" });
    assert.equal(viaDownload.status, 404);
    // An ordinary agent reads the same public attachment.
    await setAssistant(f, false);
    assert.equal((await agentGet(app.baseUrl, f.apiKey, `/attachments/${roomAttachment}/url`)).status, 200);
  } finally {
    resetStorageForTests();
  }
});

// RFC 077 PR 2a: send as the owner.
async function sendAsOwner(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/assistant/send-as-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function seedSender() {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const credential = await mintAgentCredential({ agentId: f.assistant.id, scopes: ["read", "send"], name: "assistant-send-test", issuedVia: "computer", createdByUserId: null });
  return { ...f, sendKey: credential.apiKey };
}

const delegatedRows = (agentId: string) => getDb().select().from(messages).where(eq(messages.delegatedByAgentId, agentId));

test("send as owner is refused while the owner has not turned it on (the default), and writes nothing", async ({ app }) => {
  const f = await seedSender();
  const roomBefore = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, f.room.id));
  const refused = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "hello as owner" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "assistant_send_as_owner_off");
  const roomAfter = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, f.room.id));
  assert.equal(roomAfter.length, roomBefore.length, "no message written");
  assert.deepEqual(await delegatedRows(f.assistant.id), []);
  const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.actorId, f.assistant.id));
  assert.deepEqual(audits.filter((row) => row.eventType === "assistant.send_as_owner"), [], "no audit row");
});

test("send as owner: the owner is the author with delegated_by, in their channels, threads and existing DMs; never the assistant's own DM; refusals write nothing", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);

  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "on it, thanks @" + f.peer.name });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.channelId, f.room.id);
  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  assert.deepEqual([row!.senderType, row!.senderId, row!.delegatedByAgentId, row!.channelId], ["user", f.owner.id, f.assistant.id, f.room.id]);
  // Every reader sees the label: agents in the message header, clients as `delegatedBy`.
  const roomRead = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${f.room.id}`);
  const envelope = (roomRead.body.messages as AgentApiMessageEnvelope[]).find((message) => (message as { id?: string }).id === sent.body.messageId)!;
  assert.match(projectRaftMessage(envelope)!.text, new RegExp(`type=human delegated_by=@${f.assistant.name}\\]`));
  assert.deepEqual((envelope as { delegatedBy?: unknown }).delegatedBy, { id: f.assistant.id, name: f.assistant.name, displayName: f.assistant.displayName ?? f.assistant.name, avatarUrl: f.assistant.avatarUrl ?? null, deleted: false });
  const [audit] = (await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.actorId, f.assistant.id)))
    .filter((event) => event.eventType === "assistant.send_as_owner");
  assert.equal(audit?.subjectId, f.owner.id);
  assert.equal(JSON.stringify(audit?.metadata).includes("on it"), false, "the audit never carries the text");

  // A reply under a message: lands in (and creates) its thread.
  const [roomMessage] = await getDb().select().from(messages).where(and(eq(messages.channelId, f.room.id), eq(messages.content, "room activity"))).limit(1);
  const reply = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, parentMessageId: roomMessage!.id, content: "replying in the thread" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.channelId, f.roomThread.id);

  // An existing DM with someone else.
  const dm = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.dm.id, content: "replying to your DM" });
  assert.equal(dm.status, 200, JSON.stringify(dm.body));

  const before = (await delegatedRows(f.assistant.id)).length;
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  for (const [body, status, code] of [
    [{ channelId: ownDm.id, content: "to myself" }, 404, "channel_not_found"],
    [{ channelId: f.secret.id, content: "private" }, 404, "channel_not_found"],
    [{ channelId: randomUUID(), content: "nowhere" }, 404, "channel_not_found"],
    [{ channelId: f.room.id, content: "hey @everyone" }, 400, "mass_mention_not_allowed"],
    [{ channelId: f.room.id, content: "  " }, 400, "invalid_content"],
    [{ channelId: f.room.id, parentMessageId: randomUUID(), content: "x" }, 404, "message_not_found"],
  ] as const) {
    const refused = await sendAsOwner(app.baseUrl, f.sendKey, body);
    assert.equal(refused.status, status, JSON.stringify(body));
    assert.equal(refused.body.code, code, JSON.stringify(body));
  }
  assert.equal((await delegatedRows(f.assistant.id)).length, before, "refusals write nothing");

  // DM reading off: sending to DMs is closed too (reads and sends agree).
  await setAssistantReadsDms(f.assistant.id, false);
  assert.equal((await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.dm.id, content: "dm again" })).body.code, "channel_not_found");
  assert.equal((await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "room still fine" })).status, 200);
  await setAssistantReadsDms(f.assistant.id, true);

  // Turning it off takes effect on the next send.
  await setAssistantSendAsOwner(f.assistant.id, false);
  assert.equal((await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "again" })).body.code, "assistant_send_as_owner_off");
});

test("send as owner has no rate limit (RFC 077 v3.2): more than the old 5 per conversation and 20 per owner an hour", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  for (let i = 0; i < 6; i += 1) {
    assert.equal((await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: `note ${i}` })).status, 200, `note ${i}`);
  }
  // 6 recorded; 20 more inserted directly put the owner past the old 20 an hour.
  const [template] = await delegatedRows(f.assistant.id);
  await getDb().insert(messages).values(Array.from({ length: 20 }, (_, i) => ({
    channelId: f.roomThread.id, senderType: "user" as const, senderId: f.owner.id, content: `filler ${i}`, messageType: "chat" as const, delegatedByAgentId: template!.delegatedByAgentId,
  })));
  assert.equal((await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.dm.id, content: "still fine" })).status, 200);
});

test("send as owner needs a live assistant link, like the owner reads", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  await setAssistant(f, false);
  const refused = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "hi" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "assistant_not_enabled");
});

// RFC 077 PR 2b: receipts and retraction.
async function retract(baseUrl: string, email: string, serverId: string, messageId: string) {
  const token = await tokenForHuman(email);
  const res = await fetch(`${baseUrl}/api/servers/${serverId}/assistant/delegated/${messageId}`, { method: "DELETE", headers: headers(token, serverId) });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const receiptsIn = async (dmId: string) => (await getDb().select().from(messages).where(and(eq(messages.channelId, dmId), eq(messages.messageType, "system"))))
  .filter((row) => (row.actionMetadata as { kind?: string } | null)?.kind === "delegated-receipt");

test("every delegated send leaves a receipt in the owner's DM with the assistant; the owner retracts it, and only the owner, only a delegated message", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);

  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "first line here\nsecond line" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const [receipt] = await receiptsIn(ownDm.id);
  assert.ok(receipt, "a receipt in the owner's DM with the assistant");
  assert.equal(receipt.content, `Sent for you in #${f.room.name}: "first line here"`);
  const stored = receipt.actionMetadata as { kind: string; delegatedReceipt: Record<string, unknown> };
  assert.equal(stored.kind, DELEGATED_RECEIPT_KIND);
  assert.deepEqual({ ...stored.delegatedReceipt, sentAt: typeof stored.delegatedReceipt.sentAt }, {
    messageId: sent.body.messageId,
    channelId: f.room.id,
    deletedAt: null,
    conversationRef: `#${f.room.name}`,
    conversationType: f.room.type,
    parentChannelId: null,
    parentMessageId: null,
    preview: "first line here",
    sentAt: "string",
    retractable: true,
  });
  assert.equal(receipt.systemSubtype, "assistant.delegated_receipt");

  // A DM send names the conversation from the owner's side.
  const dmSent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.dm.id, content: "ok!" });
  assert.equal(dmSent.status, 200);
  assert.ok((await receiptsIn(ownDm.id)).some((row) => row.content === `Sent for you in dm:@${f.peer.name}: "ok!"`));

  // Only the owner, only a delegated message.
  assert.equal((await retract(app.baseUrl, f.peer.email, f.server.id, sent.body.messageId)).status, 404, "not the author");
  const ownMessage = await createMessage(f.room.id, "user", f.owner.id, "typed myself");
  assert.equal((await retract(app.baseUrl, f.owner.email, f.server.id, ownMessage.id)).status, 404, "not delegated");

  const retracted = await retract(app.baseUrl, f.owner.email, f.server.id, sent.body.messageId);
  assert.equal(retracted.status, 200, JSON.stringify(retracted.body));
  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  assert.equal(row!.content, "This message was retracted by its sender.");
  assert.equal(row!.searchText, "");
  assert.ok(row!.deletedAt);
  assert.equal(row!.channelId, f.room.id, "the row stays where it was");
  const [updatedReceipt] = await getDb().select().from(messages).where(eq(messages.id, receipt.id));
  assert.equal((updatedReceipt!.actionMetadata as { delegatedReceipt: { deletedAt: string | null } }).delegatedReceipt.deletedAt, retracted.body.deletedAt);
  // What an agent reads (history, owner reads): the receipt now says it was retracted.
  assert.equal(appendAgentFacingForwardedSnapshot(receipt.content, receipt.actionMetadata), receipt.content, "not marked before");
  assert.equal(
    appendAgentFacingForwardedSnapshot(updatedReceipt!.content, updatedReceipt!.actionMetadata),
    `${receipt.content} [retracted by the owner at ${retracted.body.deletedAt}]`,
  );
  const audits = (await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.actorId, f.owner.id)))
    .filter((event) => event.eventType === "assistant.send_as_owner.deleted");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.targetId, sent.body.messageId);

  // Idempotent.
  const again = await retract(app.baseUrl, f.owner.email, f.server.id, sent.body.messageId);
  assert.deepEqual([again.status, again.body.deletedAt], [200, retracted.body.deletedAt]);
});

// Canonical message manifest v7 / V2 retraction fact: the realtime frame the retraction emits
// carries deletedAt, so the V2 fact a client normalizes from it carries deletedAt too; the
// receipt's frame in the same emit (a live message) carries null and its V2 fact omits the key.
test("the retraction's message:updated carries deletedAt into the V2 fact; a live message's frame omits it", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "delegated, then retracted" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const [receipt] = await receiptsIn(ownDm.id);
  assert.ok(receipt);

  const frames: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  const io = {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => {
      // Socket.io serializes through JSON: compare what a client receives.
      frames.push({ room, event, payload: JSON.parse(JSON.stringify(payload)) });
    } }),
    in: () => ({ socketsJoin: () => undefined }),
  };
  const result = await retractDelegatedMessage({
    io: io as unknown as Parameters<typeof retractDelegatedMessage>[0]["io"],
    serverId: f.server.id,
    userId: f.owner.id,
    messageId: sent.body.messageId,
  });

  const updated = frames.filter((frame) => frame.event === "message:updated");
  const retracted = updated.find((frame) => frame.payload.id === sent.body.messageId);
  assert.ok(retracted, "the retracted message is re-emitted");
  assert.equal(retracted.room, `channel:${f.room.id}`);
  assert.equal(retracted.payload.deletedAt, result.deletedAt, "V1 frame carries the ISO retraction time");
  assert.deepEqual(normalizeLegacyRetraction(retracted.payload.deletedAt), { deletedAt: result.deletedAt });

  const live = updated.find((frame) => frame.payload.id === receipt.id);
  assert.ok(live, "the receipt is re-emitted in the same retraction");
  assert.ok("deletedAt" in live.payload, "enriched message:updated always carries the key");
  assert.equal(live.payload.deletedAt, null);
  assert.deepEqual(normalizeLegacyRetraction(live.payload.deletedAt), {}, "a live message's V2 fact omits deletedAt");
});

test("the retraction finds receipts only in the owner's DM with the assistant, on the channel index", async ({ app }) => {
  assert.ok(app);
  // Unscoped, this lookup scanned every message and hit statement_timeout on staging.
  const ownDmId = randomUUID();
  const query = delegatedReceiptsQuery(getDb(), ownDmId, randomUUID()).toSQL();
  assert.match(query.sql, /"messages"\."channel_id" = \$1/);
  assert.equal(query.params[0], ownDmId);
  const plan = await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const sqlText = query.sql.replace(/\$(\d+)/g, (_, index) => `'${String(query.params[Number(index) - 1]).replace(/'/g, "''")}'`);
    return (await tx.execute(sql.raw(`explain ${sqlText}`))).rows.map((row) => String(Object.values(row)[0])).join("\n");
  });
  assert.doesNotMatch(plan, /Seq Scan on messages/, plan);
});

test("no delegated send into a conversation bridged to an external chat (or a thread under one)", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [client] = await db.insert(oauthClients).values({
    serverId: f.server.id, clientId: `bridge-${suffix}`, clientSecretHash: "hash", appType: "slock_builtin", name: "Slack", createdByUserId: f.owner.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client!.id, provider: "slack", environment: "test", providerAppId: `A_${suffix}`, providerOAuthClientId: `c-${suffix}`,
    capabilityManifestVersion: 1, capabilityManifestHash: "manifest", requiredCapabilities: [],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: f.server.id, registrationId: registration!.id, state: "active", grantEpoch: 1, grantedManifestVersion: 1,
    grantedManifestHash: "manifest", grantedCapabilities: [], grantedByType: "human", grantedById: f.owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: f.server.id, registrationId: registration!.id, serverGrantId: grant!.id, grantEpoch: 1, state: "active", connectionEpoch: 1,
    scopeRevision: 1, credentialRevision: 1, installedScopes: [], providerAppId: `A_${suffix}`, providerTeamId: `T_${suffix}`,
    authorityType: "team", providerAuthorityId: `T_${suffix}`, botUserId: "U_BOT", providerBotId: "B_BOT",
  }).returning();
  await db.insert(externalChannelBindings).values({
    serverId: f.server.id, registrationId: registration!.id, installId: install!.id, channelId: f.room.id,
    providerConversationId: `C_${suffix}`, providerConversationKind: "public_channel", privacyClass: "public", state: "active",
    grantEpoch: 1, connectionEpoch: 1, bindingEpoch: 1, consentedByType: "human", consentedById: f.owner.id, consentedAt: new Date(),
  });
  const before = (await delegatedRows(f.assistant.id)).length;
  for (const channelId of [f.room.id, f.roomThread.id]) {
    const refused = await sendAsOwner(app.baseUrl, f.sendKey, { channelId, content: "into the bridge" });
    assert.equal(refused.status, 403, channelId);
    assert.equal(refused.body.code, "owner_cannot_post", channelId);
  }
  assert.equal((await delegatedRows(f.assistant.id)).length, before);
});

// RFC 077 owner actions: the owner-activity read.
test("owner activity lists what the owner did themself (sends, reactions, task changes) as references; never delegated messages, the assistant's own DM, or DMs once turned off", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  const since = new Date(Date.now() - 1000).toISOString();
  const sent = await createMessage(f.room.id, "user", f.owner.id, "I'll take it");
  const delegated = await createMessage(f.room.id, "user", f.owner.id, "sent for me");
  await getDb().update(messages).set({ delegatedByAgentId: f.assistant.id }).where(eq(messages.id, delegated.id));
  await createMessage(ownDm.id, "user", f.owner.id, "to my assistant");
  const inDm = await createMessage(f.dm.id, "user", f.owner.id, "dm reply");
  const peerMessage = await createMessage(f.room.id, "user", f.peer.id, "please review");
  await mutateMessageReaction({ channelId: f.room.id, messageId: peerMessage.id, emoji: "👍", actor: { kind: "user", id: f.owner.id }, operation: "add" });

  const read = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-activity?since=${encodeURIComponent(since)}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const items = read.body.items as Array<Record<string, any>>;
  assert.deepEqual(items.filter((item) => item.kind === "message").map((item) => item.messageId).sort(), [sent.id, inDm.id].sort());
  assert.ok(items.some((item) => item.kind === "reaction" && item.messageId === peerMessage.id && item.emoji === "👍"));
  assert.ok(!items.some((item) => item.messageId === delegated.id), "never a message the assistant sent for them");
  assert.ok(!items.some((item) => item.channelId === ownDm.id), "never the assistant's own DM");
  assert.equal(JSON.stringify(read.body).includes("I'll take it"), false, "references only, no text");
  assert.equal(read.body.nextSince, items.at(-1)!.at);

  await setAssistantReadsDms(f.assistant.id, false);
  const closed = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-activity?since=${encodeURIComponent(since)}`);
  assert.ok(!(closed.body.items as Array<{ channelId: string }>).some((item) => item.channelId === f.dm.id), "no DMs once turned off");

  const later = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-activity?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
  assert.deepEqual([later.body.items, later.body.nextSince], [[], null]);
  assert.equal((await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-activity?since=not-a-date")).body.code, "invalid_since");
});

test("owner inbox rows carry the latest sender, a DM's peer, and whether the owner wrote in a thread", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const rows = async () => (await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox?filter=all&limit=50")).body.items as Array<Record<string, any>>;
  const before = await rows();
  const room = before.find((item) => item.channelId === f.room.id);
  assert.deepEqual([room?.latestSenderId, room?.latestSenderType, room?.peer], [f.peer.id, "human", null]);
  const dm = before.find((item) => item.channelId === f.dm.id);
  assert.deepEqual(dm?.peer, { id: f.peer.id, type: "human" });
  assert.deepEqual(before.find((item) => item.channelId === f.dmThread.id)?.peer, { id: f.peer.id, type: "human" }, "a thread in a DM names the DM's peer");
  assert.equal(before.find((item) => item.channelId === f.roomThread.id)?.ownerParticipated, false);
  assert.equal(before.find((item) => item.channelId === f.dmThread.id)?.ownerParticipated, false);

  await createMessage(f.roomThread.id, "user", f.owner.id, "on it");
  const after = await rows();
  assert.equal(after.find((item) => item.channelId === f.roomThread.id)?.ownerParticipated, true);
  assert.equal(after.find((item) => item.channelId === f.dmThread.id)?.ownerParticipated, false);
});

test("owner resolve names whoever the owner can see; anyone else is the same 404 as no one", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const resolve = (name: string) => agentGet(app.baseUrl, f.apiKey, `/assistant/owner-resolve?name=${encodeURIComponent(name)}`);
  assert.deepEqual((await resolve(`@${f.peer.name}`)).body, { id: f.peer.id, type: "human", name: f.peer.name });
  assert.deepEqual((await resolve(f.assistant.name)).body, { id: f.assistant.id, type: "agent", name: f.assistant.name });
  assert.equal((await resolve(`${f.peer.name}~agent`)).status, 404, "~agent never matches a human");

  // Someone who exists but the owner cannot see: not a member here; an agent
  // of another server; a member hidden from the directory with no shared channel.
  const suffix = randomUUID().slice(0, 8);
  const stranger = await seedUser(`assistant-stranger-${suffix}@slock.test`, `assistant-stranger-${suffix}`);
  const elsewhere = await createServer("Elsewhere", `elsewhere-${suffix}`, stranger.id);
  const otherAgent = await createAgent(elsewhere.id, `elsewhere-agent-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: stranger.id });
  const hidden = await seedUser(`assistant-hidden-${suffix}@slock.test`, `assistant-hidden-${suffix}`);
  await addMember(f.server.id, hidden.id);
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.owner.id)));
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, f.server.id));

  const missing = await resolve(`nobody-${suffix}`);
  assert.deepEqual([missing.status, missing.body.code], [404, "owner_resolve_not_found"]);
  for (const name of [stranger.name, otherAgent.name, hidden.name]) {
    const res = await resolve(name);
    assert.deepEqual([res.status, res.body], [404, missing.body], `${name} is answered exactly like no one`);
  }
  assert.equal((await resolve(f.peer.name)).body.id, f.peer.id, "a hidden directory still shows people who share a channel");
});

test("owner resolve finds a #channel the owner can see; a private one they are not in is the same 404 as none", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  await setAssistant(f, true);
  const resolve = (name: string) => agentGet(app.baseUrl, f.apiKey, `/assistant/owner-resolve?name=${encodeURIComponent(name)}`);
  assert.deepEqual((await resolve(`#${f.room.name}`)).body, { id: f.room.id, type: "channel", name: f.room.name });
  const missing = await resolve(`#nowhere-${randomUUID().slice(0, 8)}`);
  assert.deepEqual([missing.status, missing.body.code], [404, "owner_resolve_not_found"]);
  const secret = await resolve(`#${f.secret.name}`);
  assert.deepEqual([secret.status, secret.body], [404, missing.body], "a private channel the owner is not in is answered like none");
  assert.equal((await resolve("#")).status, 404);
});

test("task #6: the web sees the delegated label in search and Activity, and a receipt's retractable follows the sent message, not the receipt", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  const ownerToken = await tokenForHuman(f.owner.email);
  const get = async (path: string, token = ownerToken) => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: headers(token, f.server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as any;
  };
  const receiptOnPage = async () => {
    const page = await get(`/api/messages/channel/${ownDm.id}`);
    const list = (Array.isArray(page) ? page : page.messages) as Array<{ actionMetadata?: { kind?: string; delegatedReceipt?: { retractable?: boolean; deletedAt?: string | null } } }>;
    return list.filter((row) => row.actionMetadata?.kind === DELEGATED_RECEIPT_KIND).map((row) => row.actionMetadata!.delegatedReceipt!);
  };

  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "delegated searchable zebra" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  // A thread under it, followed by the peer: its Activity row's parent is the delegated message.
  const thread = await getOrCreateThread(sent.body.messageId, f.peer.id, "user");
  await createMessage(thread.id, "user", f.peer.id, "reply under the delegated message");
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id, followerType: "user", followerId: f.peer.id, parentMessageId: sent.body.messageId, reason: "manual",
  }).onConflictDoNothing();
  const threadRowOf = (page: { items: Array<{ kind: string; threadChannelId?: string; parentRetracted?: boolean; latestRetracted?: boolean }> }) =>
    page.items.find((item) => item.kind === "thread" && item.threadChannelId === thread.id);

  // Search and Activity carry who sent it for the owner.
  const search = await get(`/api/messages/search?q=${encodeURIComponent("zebra")}&limit=10`, await tokenForHuman(f.peer.email));
  const hit = (search.results as Array<{ id: string; delegatedBy?: { id: string } | null }>).find((row) => row.id === sent.body.messageId);
  assert.equal(hit?.delegatedBy?.id, f.assistant.id);
  // The thread row's face is its latest reply's sender (the peer), not the
  // parent's (the owner, who has no stored avatar).
  const peerAvatarUrl = "/api/avatars/users/0123456789abcdef0123456789abcdef.webp";
  await getDb().update(users).set({ avatarUrl: peerAvatarUrl }).where(eq(users.id, f.peer.id));
  const inbox = await get(`/api/channels/inbox?filter=all`, await tokenForHuman(f.peer.email));
  const row = (inbox.items as Array<{ channelId?: string; latestDelegatedBy?: { id: string } | null }>).find((item) => item.channelId === f.room.id);
  assert.equal(row?.latestDelegatedBy?.id, f.assistant.id);
  assert.equal((row as { senderAvatarUrl?: string | null } | undefined)?.senderAvatarUrl, null);
  assert.equal((threadRowOf(inbox) as { senderAvatarUrl?: string | null } | undefined)?.senderAvatarUrl, peerAvatarUrl);
  assert.equal((row as { latestRetracted?: boolean } | undefined)?.latestRetracted, false);
  assert.deepEqual([threadRowOf(inbox)?.parentRetracted, threadRowOf(inbox)?.latestRetracted], [false, false]);
  assert.equal((hit as { retracted?: boolean } | undefined)?.retracted, false);

  // Served retractable: true while the message is live.
  assert.deepEqual((await receiptOnPage()).map((r) => r.retractable), [true]);

  // Retracted, but the receipt still says otherwise (as an older receipt can, e.g. retracted after
  // its assistant was deleted): the served retractable follows the sent message.
  assert.equal((await retract(app.baseUrl, f.owner.email, f.server.id, sent.body.messageId)).status, 200);
  const [stale] = await receiptsIn(ownDm.id);
  const staleMetadata = stale!.actionMetadata as { kind: string; delegatedReceipt: Record<string, unknown> };
  await getDb().update(messages)
    .set({ actionMetadata: { ...staleMetadata, delegatedReceipt: { ...staleMetadata.delegatedReceipt, deletedAt: null, retractable: true } } })
    .where(eq(messages.id, stale!.id));
  const [after] = await receiptOnPage();
  assert.equal(after?.deletedAt ?? null, null, "the receipt says nothing");
  assert.equal(after?.retractable, false, "but the server says it can no longer be retracted");
  // Activity says the latest message is retracted, so the web needs no text matching.
  const inboxAfter = await get(`/api/channels/inbox?filter=all`, await tokenForHuman(f.peer.email));
  const rowAfter = (inboxAfter.items as Array<{ channelId?: string; latestRetracted?: boolean }>).find((item) => item.channelId === f.room.id);
  assert.equal(rowAfter?.latestRetracted, true);
  // The thread row says its parent is retracted; its own latest reply is not.
  assert.deepEqual([threadRowOf(inboxAfter)?.parentRetracted, threadRowOf(inboxAfter)?.latestRetracted], [true, false]);
});

test("an agent reading a message an assistant sent for its owner sees delegated_by: live, history, thread, resolve and search alike", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  // An ordinary agent in the room (an external runtime, so its live messages come from the durable inbox pull).
  const reader = await createAgent(f.server.id, `delegated-reader-${randomUUID().slice(0, 8)}`, { runtime: "external", model: "external", creatorType: "user", creatorId: f.owner.id });
  await addAgent(f.room.id, reader.id);
  const { apiKey } = await mintAgentCredential({ agentId: reader.id, scopes: ["read"], name: "reader", issuedVia: "computer", createdByUserId: null });
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const readerGet = async (path: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as Record<string, any>;
  };
  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "delegated quokka note" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const reply = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, parentMessageId: sent.body.messageId, content: "delegated quokka reply" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const label = { name: f.assistant.name };

  // Live: the events the agent pulls.
  const events = (await readerGet("/events")).events as Array<Record<string, any>>;
  assert.deepEqual(events.find((event) => event.message_id === sent.body.messageId)?.delegated_by, label, "live");
  // History of the room, and of the thread under the delegated message: the line the agent reads.
  const readLine = async (target: string, messageId: string) => {
    const page = await readerGet(`/history?channel=${encodeURIComponent(target)}&consume=false`);
    const message = projectRaftMessagesInTarget(page.messages as AgentApiMessageEnvelope[], target).find((row) => row.id === messageId);
    assert.ok(message, `${messageId} in ${target}`);
    return message.text;
  };
  const header = new RegExp(`type=human delegated_by=@${f.assistant.name}\\]`);
  assert.match(await readLine(`#${f.room.name}`, sent.body.messageId), header, "history");
  assert.match(await readLine(`#${f.room.name}:${sent.body.messageId.slice(0, 8)}`, reply.body.messageId), header, "thread");
  // Resolving its short id.
  const resolved = (await readerGet(`/messages/${sent.body.messageId.slice(0, 8)}/resolve`)).message as AgentApiMessageEnvelope;
  assert.match(projectRaftMessage(resolved)?.text ?? "", header, "resolve");
  // Search.
  const hit = ((await readerGet(`/search?${new URLSearchParams({ q: "quokka", sort: "recent", limit: "10" })}`)).results as Array<Record<string, unknown>>)
    .find((row) => row.id === sent.body.messageId);
  assert.deepEqual(hit?.delegated_by, label, "search");
  assert.equal("delegatedBy" in (hit ?? {}), false, "the web's label shape stays off the agent surface");
});

test("task #6: a gap sync's copy of a delegated message keeps its label, and a retracted one says it is retracted", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const peerToken = await tokenForHuman(f.peer.email);
  const [{ maxSeq }] = (await getDb().select({ maxSeq: sql<number>`coalesce(max(${messages.seq}), 0)::int` }).from(messages)) as [{ maxSeq: number }];
  const kept = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "delegated and kept" });
  const gone = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "delegated and retracted" });
  assert.deepEqual([kept.status, gone.status], [200, 200]);
  assert.equal((await retract(app.baseUrl, f.owner.email, f.server.id, gone.body.messageId)).status, 200);

  // The client's gap fill: server-wide, and scoped to the channel (both go through the server branch).
  for (const scope of ["", `&channel_id=${f.room.id}`]) {
    const res = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=${maxSeq}${scope}`, { headers: headers(peerToken, f.server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    const byId = new Map((await res.json() as Array<{ id: string; delegatedBy?: { id: string } | null; deletedAt?: string | null }>).map((row) => [row.id, row]));
    assert.equal(byId.get(kept.body.messageId)?.delegatedBy?.id, f.assistant.id, `label${scope}`);
    assert.equal(byId.get(kept.body.messageId)?.deletedAt ?? null, null, `live${scope}`);
    assert.equal(byId.get(gone.body.messageId)?.delegatedBy?.id, f.assistant.id, `retracted label${scope}`);
    assert.ok(byId.get(gone.body.messageId)?.deletedAt, `retracted${scope}`);
    // Catch-up feeds the same V2 retraction fact as realtime (manifest v7).
    assert.deepEqual(normalizeLegacyRetraction(byId.get(gone.body.messageId)?.deletedAt), { deletedAt: byId.get(gone.body.messageId)?.deletedAt }, `retracted V2 fact${scope}`);
    assert.deepEqual(normalizeLegacyRetraction(byId.get(kept.body.messageId)?.deletedAt), {}, `live V2 fact${scope}`);
  }
});

test("task #6: retracting a delegated message revokes its attachments; nothing lists or serves them again", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "see attached" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  // Delegated sends carry no attachments today; one linked by hand stands in for any future path.
  const [attachment] = await insertLinkedAttachmentsWithObjects({
    channelId: f.room.id,
    messageId: sent.body.messageId,
    uploaderId: f.owner.id,
    uploaderType: "user",
    filename: "plan.pdf",
    mimeType: "application/pdf",
    sizeBytes: 3,
    storageKey: `test/${randomUUID()}`,
  });
  // An object-backed one too, holding its bytes as every linked attachment does.
  const [object] = await getDb().insert(attachmentObjects).values({
    originServerId: f.server.id,
    uploaderId: f.owner.id,
    uploaderType: "user",
    storageKey: `test/${randomUUID()}`,
    mimeType: "application/pdf",
    sizeBytes: 3,
  }).returning();
  const [heldAttachment] = await getDb().insert(attachments).values({
    objectId: object!.id,
    channelId: f.room.id,
    messageId: sent.body.messageId,
    messagePosition: 1,
    uploaderId: f.owner.id,
    uploaderType: "user",
    filename: "held.pdf",
  }).returning();
  await getDb().insert(attachmentObjectHolds).values({ holderType: "attachment", holderId: heldAttachment!.id, objectId: object!.id });
  const peerToken = await tokenForHuman(f.peer.email);
  const listed = async () => {
    const page = await (await fetch(`${app.baseUrl}/api/messages/channel/${f.room.id}`, { headers: headers(peerToken, f.server.id) })).json() as any;
    const list = (Array.isArray(page) ? page : page.messages) as Array<{ id: string; attachments?: Array<{ id: string }> }>;
    return (list.find((message) => message.id === sent.body.messageId)?.attachments ?? []).map((a) => a.id);
  };
  assert.deepEqual((await listed()).sort(), [attachment!.id, heldAttachment!.id].sort(), "listed before the retraction");

  assert.equal((await retract(app.baseUrl, f.owner.email, f.server.id, sent.body.messageId)).status, 200);
  const [row] = await getDb().select().from(attachments).where(eq(attachments.id, attachment!.id));
  assert.ok(row!.revokedAt, "revoked with the retraction");
  assert.equal(row!.revokeReason, "delegated_message_retracted");
  assert.deepEqual(await listed(), [], "and no longer listed");
  assert.deepEqual(await getDb().select().from(attachmentObjectHolds).where(eq(attachmentObjectHolds.objectId, object!.id)), [], "its hold is released");
  const [unheld] = await getDb().select().from(attachmentObjects).where(eq(attachmentObjects.id, object!.id));
  assert.equal(unheld!.lifecycleState, "active", "bytes are kept: nothing deletes unheld objects in this release");
  assert.ok(unheld!.unheldSince, "and the object records since when it has no hold");
});

// `dmWith`: whoever the owner can DM themselves, the assistant can DM for them,
// through the web's own "Send DM" path (openDirectMessageForUser).
const dmCount = async (serverId: string) => (await getDb().select({ id: channels.id }).from(channels)
  .where(and(eq(channels.serverId, serverId), eq(channels.type, "dm")))).length;

async function webOpenDm(baseUrl: string, email: string, serverId: string, body: Record<string, unknown>) {
  const token = await tokenForHuman(email);
  const res = await fetch(`${baseUrl}/api/channels/dm`, { method: "POST", headers: headers(token, serverId), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

test("send as owner with dmWith opens the owner's DM with someone they never talked to, as the owner; a second send reuses it; receipt and retraction work", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  const suffix = randomUUID().slice(0, 8);
  const stranger = await seedUser(`assistant-stranger-${suffix}@slock.test`, `assistant-stranger-${suffix}`);
  await addMember(f.server.id, stranger.id);
  const dmsBefore = await dmCount(f.server.id);

  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { dmWith: `@${stranger.name}`, content: "hello from me" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(await dmCount(f.server.id), dmsBefore + 1, "one new DM");
  const dm = await getChannel(sent.body.channelId);
  assert.equal(dm?.type, "dm");
  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  assert.deepEqual([row!.senderType, row!.senderId, row!.delegatedByAgentId, row!.channelId], ["user", f.owner.id, f.assistant.id, dm!.id]);
  // It is the DM the owner's own "Send DM" opens.
  const web = await webOpenDm(app.baseUrl, f.owner.email, f.server.id, { userId: stranger.id });
  assert.equal(web.status, 200);
  assert.equal(web.body.id, dm!.id);
  assert.ok((await receiptsIn(ownDm.id)).some((receipt) => receipt.content === `Sent for you in dm:@${stranger.name}: "hello from me"`), "the receipt is posted");

  // A second send (here with the typed ~human) reuses that DM.
  const again = await sendAsOwner(app.baseUrl, f.sendKey, { dmWith: `@${stranger.name}~human`, content: "one more thing" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.channelId, dm!.id);
  assert.equal(await dmCount(f.server.id), dmsBefore + 1, "no second DM");

  // The owner retracts it like any delegated message.
  const retracted = await retract(app.baseUrl, f.owner.email, f.server.id, sent.body.messageId);
  assert.equal(retracted.status, 200, JSON.stringify(retracted.body));
});

test("send as owner with dmWith reaches an agent the owner can DM", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const helper = await createAgent(f.server.id, `helper-${randomUUID().slice(0, 8)}`, { runtime: "codex", creatorType: "user", creatorId: f.peer.id });
  const sent = await sendAsOwner(app.baseUrl, f.sendKey, { dmWith: `@${helper.name}~agent`, content: "please take a look" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.channelId, await findHumanAgentDmChannelId(f.server.id, f.owner.id, helper.id));
  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  assert.deepEqual([row!.senderType, row!.senderId, row!.delegatedByAgentId], ["user", f.owner.id, f.assistant.id]);
});

test("send as owner with dmWith: every refusal (the web's DM rules, the switches, the other checks) opens no DM and writes nothing", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const suffix = randomUUID().slice(0, 8);
  const guest = await seedUser(`assistant-guest-${suffix}@slock.test`, `assistant-guest-${suffix}`);
  await seedBoundGuest({ serverId: f.server.id, userId: guest.id });
  const stranger = await seedUser(`assistant-stranger-${suffix}@slock.test`, `assistant-stranger-${suffix}`);
  await addMember(f.server.id, stranger.id);
  // Someone else's assistant: never found by name for anyone but its owner.
  const othersAssistant = await createAgent(f.server.id, `others-helper-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: f.peer.id });
  await getDb().update(agents).set({ assistantOwnerUserId: f.peer.id }).where(eq(agents.id, othersAssistant.id));
  const dmsBefore = await dmCount(f.server.id);
  const sentBefore = (await delegatedRows(f.assistant.id)).length;

  for (const [body, status, code] of [
    [{ dmWith: `@${guest.name}`, content: "hi" }, 403, "dm_target_guest"],
    [{ dmWith: `@${othersAssistant.name}`, content: "hi" }, 404, "owner_resolve_not_found"],
    [{ dmWith: `@${f.assistant.name}`, content: "hi" }, 403, "assistant_own_dm"],
    [{ dmWith: "@nobody-by-this-name", content: "hi" }, 404, "owner_resolve_not_found"],
    [{ dmWith: `#${f.room.name}`, content: "hi" }, 400, "invalid_target"],
    [{ dmWith: `@${stranger.name}`, channelId: f.room.id, content: "hi" }, 400, "invalid_target"],
    [{ content: "hi" }, 400, "invalid_target"],
    [{ dmWith: `@${stranger.name}`, parentMessageId: randomUUID(), content: "hi" }, 400, "invalid_target"],
    [{ dmWith: `@${stranger.name}`, content: "hey @here" }, 400, "mass_mention_not_allowed"],
  ] as const) {
    const refused = await sendAsOwner(app.baseUrl, f.sendKey, body);
    assert.equal(refused.status, status, JSON.stringify(body));
    assert.equal(refused.body.code, code, JSON.stringify(body));
  }
  // The web's "Send DM" refuses the guest with the same code.
  const web = await webOpenDm(app.baseUrl, f.owner.email, f.server.id, { userId: guest.id });
  assert.deepEqual([web.status, web.body.code], [403, "dm_target_guest"]);

  // Either switch off: refused before any DM is opened.
  await setAssistantReadsDms(f.assistant.id, false);
  const readsOff = await sendAsOwner(app.baseUrl, f.sendKey, { dmWith: `@${stranger.name}`, content: "hi" });
  assert.deepEqual([readsOff.status, readsOff.body.code], [403, "assistant_reads_dms_off"]);
  await setAssistantReadsDms(f.assistant.id, true);
  await setAssistantSendAsOwner(f.assistant.id, false);
  const sendOff = await sendAsOwner(app.baseUrl, f.sendKey, { dmWith: `@${stranger.name}`, content: "hi" });
  assert.deepEqual([sendOff.status, sendOff.body.code], [403, "assistant_send_as_owner_off"]);

  assert.equal(await dmCount(f.server.id), dmsBefore, "no DM opened");
  assert.equal((await delegatedRows(f.assistant.id)).length, sentBefore, "nothing sent");
});

// RFC 077 forwardAsOwner: whatever the owner can forward, the assistant can
// forward for them, through the web's own forward path (messageForwardService).
async function forwardAsOwner(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/assistant/forward-as-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function seedForwarder() {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  const suffix = randomUUID().slice(0, 8);
  const first = await createMessage(f.room.id, "user", f.peer.id, "forward me, first");
  const second = await createMessage(f.room.id, "user", f.peer.id, "forward me, second");
  const dest = await createChannel(f.server.id, `dest-${suffix}`);
  await addHuman(dest.id, f.owner.id);
  // Public channels the owner has not joined.
  const open = await createChannel(f.server.id, `open-${suffix}`);
  await addHuman(open.id, f.peer.id);
  const other = await createChannel(f.server.id, `other-${suffix}`);
  await addHuman(other.id, f.peer.id);
  const stranger = await seedUser(`assistant-fwd-stranger-${suffix}@slock.test`, `assistant-fwd-stranger-${suffix}`);
  await addMember(f.server.id, stranger.id);
  return { ...f, ownDm, first, second, dest, open, other, stranger, suffix };
}

const forwardReceipts = async (ownDmId: string) => (await receiptsIn(ownDmId))
  .filter((row) => Array.isArray((row.actionMetadata as { delegatedReceipts?: unknown }).delegatedReceipts));

test("forwardAsOwner: several destinations in one request, a partial failure, one receipt with a line each; a retry sends nothing twice; a different forward under the same requestId is request_conflict; one line retracts alone", async ({ app }) => {
  const f = await seedForwarder();
  const requestId = randomUUID();
  const body = {
    // The msg= short id an assistant reads works as well as the full id.
    messages: [f.first.id.slice(0, 8), f.second.id],
    to: [`#${f.dest.name}`, `@${f.stranger.name}`, f.secret.id],
    note: "FYI",
    requestId,
  };
  const sent = await forwardAsOwner(app.baseUrl, f.sendKey, body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const results = sent.body.results as Array<Record<string, any>>;
  assert.deepEqual(results.map((r) => r.status), ["sent", "sent", "failed"]);
  assert.equal(results[0]!.channelId, f.dest.id);
  assert.equal(results[1]!.createsDm, true, "a DM the owner never had is opened");
  assert.equal((await getChannel(results[1]!.channelId))?.type, "dm");
  assert.deepEqual([results[2]!.code, results[2]!.channelId], ["channel_not_found", null], "a private channel the owner is not in");
  assert.match(results[0]!.link, new RegExp(`/channel/${f.dest.id}\\?msg=${results[0]!.messageId}$`));
  for (const result of results.slice(0, 2)) {
    const [row] = await getDb().select().from(messages).where(eq(messages.id, result.messageId));
    assert.deepEqual([row!.senderType, row!.senderId, row!.delegatedByAgentId, row!.content], ["user", f.owner.id, f.assistant.id, "FYI"]);
    assert.equal((row!.actionMetadata as { kind: string }).kind, "forwarded-bundle");
  }

  const [receipt, ...more] = await forwardReceipts(f.ownDm.id);
  assert.ok(receipt, "one receipt for the request");
  assert.equal(more.length, 0);
  assert.equal(receipt.content, `Forwarded 2 messages for you to:\n- #${f.dest.name}\n- dm:@${f.stranger.name}`);
  const lines = (receipt.actionMetadata as { delegatedReceipts: Array<{ messageId: string }> }).delegatedReceipts;
  assert.deepEqual(lines.map((line) => line.messageId), [results[0]!.messageId, results[1]!.messageId]);

  // The same request again: what was sent comes back, nothing is sent twice, no second receipt.
  const delegatedBefore = (await delegatedRows(f.assistant.id)).length;
  const retried = await forwardAsOwner(app.baseUrl, f.sendKey, body);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual((retried.body.results as Array<Record<string, any>>).map((r) => [r.status, r.messageId]), results.map((r) => [r.status, r.messageId]));
  assert.equal((await delegatedRows(f.assistant.id)).length, delegatedBefore);
  assert.equal((await forwardReceipts(f.ownDm.id)).length, 1);

  // A different forward under the same requestId.
  const conflict = await forwardAsOwner(app.baseUrl, f.sendKey, { ...body, note: "something else" });
  assert.equal(conflict.status, 200);
  assert.deepEqual((conflict.body.results as Array<Record<string, any>>).slice(0, 2).map((r) => [r.status, r.code]), [["failed", "request_conflict"], ["failed", "request_conflict"]]);
  assert.match(conflict.body.results[0].error, /send again with the same requestId and the same messages and note/);
  assert.equal((await delegatedRows(f.assistant.id)).length, delegatedBefore);

  // Retract one line: only that one.
  const retracted = await retract(app.baseUrl, f.owner.email, f.server.id, results[0]!.messageId);
  assert.equal(retracted.status, 200, JSON.stringify(retracted.body));
  const [updated] = await getDb().select().from(messages).where(eq(messages.id, receipt.id));
  const updatedLines = (updated!.actionMetadata as { delegatedReceipts: Array<{ messageId: string; deletedAt: string | null }> }).delegatedReceipts;
  assert.deepEqual(updatedLines.map((line) => line.deletedAt), [retracted.body.deletedAt, null]);
  const [gone] = await getDb().select().from(messages).where(eq(messages.id, results[0]!.messageId));
  assert.deepEqual([gone!.content, gone!.actionMetadata], ["This message was retracted by its sender.", null]);
  const [kept] = await getDb().select().from(messages).where(eq(messages.id, results[1]!.messageId));
  assert.equal(kept!.deletedAt, null);
});

test("forwardAsOwner retry: fixing failed destinations under the same requestId sends only those; a destination the owner retracted is retracted_by_owner and is not sent again", async ({ app }) => {
  const f = await seedForwarder();
  const requestId = randomUUID();
  const body = { messages: [f.first.id], note: "FYI", requestId };
  const first = await forwardAsOwner(app.baseUrl, f.sendKey, { ...body, to: [`#${f.dest.name}`, `#${f.open.name}`] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const [sentDest, needsJoin] = first.body.results as Array<Record<string, any>>;
  assert.equal(sentDest!.status, "sent");
  assert.deepEqual([needsJoin!.status, needsJoin!.code], ["failed", "join_required"]);
  assert.match(needsJoin!.error, /then send again with the same requestId\.$/);

  // The fix, under the same requestId: the sent destination comes back as it was, only the fixed one is sent.
  const fixed = await forwardAsOwner(app.baseUrl, f.sendKey, { ...body, to: [`#${f.dest.name}`, { to: `#${f.open.name}`, join: true }] });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const fixedResults = fixed.body.results as Array<Record<string, any>>;
  assert.deepEqual(fixedResults.map((r) => r.status), ["sent", "sent"]);
  assert.equal(fixedResults[0]!.messageId, sentDest!.messageId, "not re-sent");
  assert.equal((await delegatedRows(f.assistant.id)).length, 2);

  // The owner retracts the one in #dest; a retry under the same requestId does not send it again.
  const retracted = await retract(app.baseUrl, f.owner.email, f.server.id, sentDest!.messageId);
  assert.equal(retracted.status, 200, JSON.stringify(retracted.body));
  const destRows = async () => getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, f.dest.id));
  const destBefore = (await destRows()).map((row) => row.id).sort();
  const receiptsBefore = (await forwardReceipts(f.ownDm.id)).length;
  for (const retry of [
    { ...body, to: [`#${f.dest.name}`, { to: `#${f.open.name}`, join: true }] },
    // Decided by the retraction, not by comparing the request: a changed note there is still retracted_by_owner.
    { ...body, note: "changed", to: [`#${f.dest.name}`] },
  ]) {
    const again = await forwardAsOwner(app.baseUrl, f.sendKey, retry);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const [destResult] = again.body.results as Array<Record<string, any>>;
    assert.deepEqual([destResult!.status, destResult!.code, destResult!.channelId], ["failed", "retracted_by_owner", f.dest.id]);
    assert.equal(destResult!.error, "Your owner retracted the message this forward sent here; do not send it again unless your owner asks you to.");
  }
  assert.deepEqual((await destRows()).map((row) => row.id).sort(), destBefore, "no new message in the retracted destination");
  assert.equal((await forwardReceipts(f.ownDm.id)).length, receiptsBefore, "no receipt for nothing sent");
  // A dry run reports it the same way.
  const dry = await forwardAsOwner(app.baseUrl, f.sendKey, { ...body, to: [`#${f.dest.name}`], dryRun: true });
  assert.deepEqual((dry.body.results as Array<Record<string, any>>).map((r) => [r.status, r.code]), [["failed", "retracted_by_owner"]]);
});

test("forwardAsOwner dryRun writes nothing (no DM, no join, no message) and answers the preview, createsDm and join_required", async ({ app }) => {
  const f = await seedForwarder();
  const dmsBefore = await dmCount(f.server.id);
  const touched = [f.open.id, f.other.id, f.dest.id, f.ownDm.id];
  const messagesIn = async () => (await getDb().select({ id: messages.id }).from(messages).where(inArray(messages.channelId, touched))).length;
  const messagesBefore = await messagesIn();
  const dry = await forwardAsOwner(app.baseUrl, f.sendKey, {
    messages: [f.first.id],
    to: [`#${f.open.name}`, { to: `#${f.other.name}`, join: true }, `@${f.stranger.name}`, `#${f.dest.name}`],
    note: "have a look",
    requestId: randomUUID(),
    dryRun: true,
  });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const results = dry.body.results as Array<Record<string, any>>;
  assert.deepEqual([results[0]!.status, results[0]!.code], ["failed", "join_required"]);
  assert.match(results[0]!.error, /join: true/);
  assert.deepEqual([results[1]!.status, results[1]!.joined], ["would_send", true]);
  assert.deepEqual([results[2]!.status, results[2]!.createsDm, results[2]!.channelId], ["would_send", true, null]);
  assert.deepEqual([results[3]!.status, results[3]!.channelId], ["would_send", f.dest.id]);
  assert.match(dry.body.preview, /^have a look\n\nForwarded content snapshot:/);
  assert.match(dry.body.preview, /forward me, first/);

  assert.equal(await dmCount(f.server.id), dmsBefore, "no DM opened");
  assert.equal(await isChannelHuman(f.other.id, f.owner.id), false, "not joined");
  assert.equal(await messagesIn(), messagesBefore, "no message, no receipt");
  assert.equal((await delegatedRows(f.assistant.id)).length, 0);
});

test("forwardAsOwner with join: true joins the owner by the web's join path, and the receipt says so", async ({ app }) => {
  const f = await seedForwarder();
  const sent = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [f.first.id], to: [{ to: `#${f.other.name}`, join: true }], requestId: randomUUID() });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const [result] = sent.body.results as Array<Record<string, any>>;
  assert.deepEqual([result!.status, result!.joined], ["sent", true]);
  assert.equal(await isChannelHuman(f.other.id, f.owner.id), true);
  const [receipt] = await forwardReceipts(f.ownDm.id);
  assert.match(receipt!.content, new RegExp(`Joined #${f.other.name} for you`));
  assert.deepEqual((receipt!.actionMetadata as { joinedChannels: unknown }).joinedChannels, [{ channelId: f.other.id, name: f.other.name }]);
});

test("forwardAsOwner refusals: a source the owner cannot see is a 404 naming nothing; over 20 is too_many_messages; either switch off; @here; nothing is created", async ({ app }) => {
  const f = await seedForwarder();
  const [secretMessage] = await getDb().select().from(messages).where(eq(messages.channelId, f.secret.id)).limit(1);
  assert.ok(secretMessage);
  const dmsBefore = await dmCount(f.server.id);
  const sentBefore = (await delegatedRows(f.assistant.id)).length;
  const request = (overrides: Record<string, unknown>) => forwardAsOwner(app.baseUrl, f.sendKey, {
    messages: [f.first.id], to: [`#${f.dest.name}`, `@${f.stranger.name}`], requestId: randomUUID(), ...overrides,
  });

  for (const messagesList of [[secretMessage.id], [f.first.id, secretMessage.id], [secretMessage.id.slice(0, 8)]]) {
    const refused = await request({ messages: messagesList });
    assert.deepEqual([refused.status, refused.body.code], [404, "source_not_found"], JSON.stringify(messagesList));
    // Named as the assistant passed it (its own input), never by content or conversation.
    const index = messagesList.length - 1;
    assert.equal(refused.body.error, `messages[${index}] ("${messagesList[index]}") was not found, or you may not read it for your owner. Leave it out.`);
    const text = JSON.stringify(refused.body);
    assert.equal(text.includes("private chatter"), false, "no content");
    assert.equal(text.includes(f.secret.name), false, "no channel name");
    if (messagesList[index]!.length === 8) assert.equal(text.includes(secretMessage.id), false, "a short id is not expanded");
  }
  const overCap = await request({ messages: Array.from({ length: 21 }, () => randomUUID()) });
  assert.deepEqual([overCap.status, overCap.body.code], [400, "too_many_messages"]);
  assert.match(overCap.body.error, /up to 20 messages/);
  const tooManyDestinations = await request({ to: Array.from({ length: 11 }, (_, i) => `#nope-${i}`) });
  assert.deepEqual([tooManyDestinations.status, tooManyDestinations.body.code], [400, "invalid_request"]);
  const massMention = await request({ note: "look @here" });
  assert.deepEqual([massMention.status, massMention.body.code], [400, "mass_mention_not_allowed"]);

  await setAssistantReadsDms(f.assistant.id, false);
  const readsOff = await request({});
  assert.equal(readsOff.status, 200);
  assert.deepEqual((readsOff.body.results as Array<Record<string, any>>).map((r) => [r.status, r.code ?? null]), [["sent", null], ["failed", "assistant_reads_dms_off"]]);
  await setAssistantReadsDms(f.assistant.id, true);
  const sentWithReadsOff = (await delegatedRows(f.assistant.id)).length;
  await setAssistantSendAsOwner(f.assistant.id, false);
  const sendOff = await request({});
  assert.deepEqual([sendOff.status, sendOff.body.code], [403, "assistant_send_as_owner_off"]);

  assert.equal(await dmCount(f.server.id), dmsBefore, "no DM opened by any refusal");
  assert.equal(sentWithReadsOff, sentBefore + 1, "only the channel destination was sent");
  assert.equal((await delegatedRows(f.assistant.id)).length, sentWithReadsOff);
});

// The owner-messages route's DM rule applies to the sources too: with DM
// reading off, a DM message (or one in a thread under a DM) is the same 404 as
// a message the owner cannot see, before any preview, and nothing is written.
test("forwardAsOwner sources follow the assistant's DM rule: with DM reading off a DM or DM-thread source is source_not_found (send and dryRun), no content comes back, nothing is written; never its own DM; a DM the owner is not in looks the same", async ({ app }) => {
  const f = await seedForwarder();
  const [dmMessage] = await getDb().select().from(messages).where(and(eq(messages.channelId, f.dm.id), eq(messages.content, "dm activity")));
  const [dmThreadReply] = await getDb().select().from(messages).where(eq(messages.channelId, f.dmThread.id));
  assert.ok(dmMessage && dmThreadReply);
  const ownDmMessage = await createMessage(f.ownDm.id, "user", f.owner.id, "said to my assistant");
  // A DM the owner is not in.
  const othersDm = await findOrCreateUserDM(f.server.id, f.peer.id, f.stranger.id);
  assert.ok(othersDm);
  const othersDmMessage = await createMessage(othersDm.id, "user", f.peer.id, "between the two of them");
  const messageCount = async () => (await getDb().select({ id: messages.id }).from(messages).where(inArray(messages.channelId, [f.dest.id, f.other.id, f.ownDm.id]))).length;
  const before = await messageCount();
  const refusedText = (passed: string) => `messages[0] ("${passed}") was not found, or you may not read it for your owner. Leave it out.`;
  const expectRefused = async (passed: string, extra: Record<string, unknown> = {}) => {
    const refused = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [passed], to: [`#${f.dest.name}`, { to: `#${f.other.name}`, join: true }], requestId: randomUUID(), ...extra });
    assert.deepEqual([refused.status, refused.body.code, refused.body.error], [404, "source_not_found", refusedText(passed)], `${passed} ${JSON.stringify(refused.body)}`);
    const text = JSON.stringify(refused.body);
    for (const leaked of ["dm activity", "dm thread reply", "said to my assistant", "between the two of them", "preview", "results"]) {
      assert.equal(text.includes(leaked), false, `no ${leaked} in ${text}`);
    }
  };

  await setAssistantReadsDms(f.assistant.id, false);
  for (const passed of [dmMessage.id, dmMessage.id.slice(0, 8), dmThreadReply.id]) {
    await expectRefused(passed);
    await expectRefused(passed, { dryRun: true });
  }
  // DM reading on: its own DM with its owner is still not readable, and a DM the owner is not in reads the same.
  await setAssistantReadsDms(f.assistant.id, true);
  for (const passed of [ownDmMessage.id, othersDmMessage.id]) {
    await expectRefused(passed);
    await expectRefused(passed, { dryRun: true });
  }
  assert.equal(await messageCount(), before, "no message, no receipt");
  assert.equal(await isChannelHuman(f.other.id, f.owner.id), false, "joined nothing");
  assert.equal((await delegatedRows(f.assistant.id)).length, 0);

  // With DM reading on, the same DM sources forward (the rule, not a blanket refusal).
  const allowed = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [dmThreadReply.id], to: [`#${f.dest.name}`], requestId: randomUUID(), dryRun: true });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.match(allowed.body.preview, /dm thread reply/);
});

test("forwardAsOwner destinations: a DM the owner is not in is channel_not_found whatever the DM switch, never assistant_reads_dms_off", async ({ app }) => {
  const f = await seedForwarder();
  const othersDm = await findOrCreateUserDM(f.server.id, f.peer.id, f.stranger.id);
  assert.ok(othersDm);
  for (const readsDms of [false, true]) {
    await setAssistantReadsDms(f.assistant.id, readsDms);
    const dry = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [f.first.id], to: [othersDm.id, f.dm.id], requestId: randomUUID(), dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const [notIn, own] = dry.body.results as Array<Record<string, any>>;
    assert.deepEqual([notIn!.status, notIn!.code, notIn!.channelId], ["failed", "channel_not_found", null], `readsDms=${readsDms}`);
    assert.deepEqual([own!.status, own!.code ?? null], readsDms ? ["would_send", null] : ["failed", "assistant_reads_dms_off"]);
  }
});

test("forwardAsOwner dryRun reports the write's own failures: an archived channel, a thread whose parent message was deleted", async ({ app }) => {
  const f = await seedForwarder();
  const parent = await createMessage(f.dest.id, "user", f.owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, f.owner.id, "user");
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, parent.id));
  const archived = await createChannel(f.server.id, `archived-${f.suffix}`);
  await addHuman(archived.id, f.owner.id);
  await archiveChannel(archived.id, f.owner.id);
  const body = { messages: [f.first.id], to: [archived.id, thread.id], requestId: randomUUID() };
  const dry = await forwardAsOwner(app.baseUrl, f.sendKey, { ...body, dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const dryResults = (dry.body.results as Array<Record<string, any>>).map((r) => [r.status, r.code]);
  assert.deepEqual(dryResults, [["failed", "channel_archived"], ["failed", "destination_unavailable"]]);
  // The send answers the same.
  const sent = await forwardAsOwner(app.baseUrl, f.sendKey, body);
  assert.deepEqual((sent.body.results as Array<Record<string, any>>).map((r) => [r.status, r.code]), dryResults);
  assert.equal((await delegatedRows(f.assistant.id)).length, 0);
});

test("forwardAsOwner join: true, then the forward there fails: the owner still gets a receipt naming the channel they were joined to", async ({ app }) => {
  const f = await seedForwarder();
  // The forward's own write into #other fails (the join's system line is not a forward).
  const trigger = `fail_forward_${f.suffix.replace(/[^a-z0-9]/g, "")}`;
  await getDb().execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forward write refused for test'; END $$ LANGUAGE plpgsql`));
  await getDb().execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON messages FOR EACH ROW WHEN (NEW.channel_id::text = '${f.other.id}' AND NEW.random_id LIKE 'forward:%') EXECUTE FUNCTION ${trigger}()`));
  try {
    const sent = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [f.first.id], to: [{ to: `#${f.other.name}`, join: true }], requestId: randomUUID() });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const [result] = sent.body.results as Array<Record<string, any>>;
    assert.deepEqual([result!.status, result!.joined], ["failed", true], JSON.stringify(result));
  } finally {
    await getDb().execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON messages`));
    await getDb().execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`));
  }
  assert.equal(await isChannelHuman(f.other.id, f.owner.id), true, "the join stays");
  const receipts = await forwardReceipts(f.ownDm.id);
  assert.equal(receipts.length, 1, "a receipt though nothing was sent");
  assert.equal(receipts[0]!.content, `Joined #${f.other.name} for you, but the forward there did not go through. You can leave #${f.other.name} any time.`);
  const metadata = receipts[0]!.actionMetadata as Record<string, unknown>;
  assert.deepEqual([metadata.delegatedReceipts, metadata.delegatedReceipt, metadata.joinedNotForwarded], [[], undefined, [{ channelId: f.other.id, name: f.other.name }]]);
});

test("forwardAsOwner retry of a forward stored without its receipt (delivery or the receipt failed): the replay posts the receipt once", async ({ app }) => {
  const f = await seedForwarder();
  const body = { messages: [f.first.id], to: [`#${f.dest.name}`], requestId: randomUUID() };
  const first = await forwardAsOwner(app.baseUrl, f.sendKey, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const messageId = first.body.results[0].messageId as string;
  // As if the first attempt stopped after the forward was stored: no receipt names it.
  await getDb().update(messages).set({ actionMetadata: null }).where(inArray(messages.id, (await forwardReceipts(f.ownDm.id)).map((row) => row.id)));
  assert.equal((await delegatedReceiptsQuery(getDb(), f.ownDm.id, messageId)).length, 0);

  const retried = await forwardAsOwner(app.baseUrl, f.sendKey, body);
  assert.deepEqual([retried.status, retried.body.results[0].status, retried.body.results[0].messageId], [200, "sent", messageId]);
  const receipts = await delegatedReceiptsQuery(getDb(), f.ownDm.id, messageId);
  assert.equal(receipts.length, 1, "the receipt the owner never got");
  const [receipt] = await getDb().select().from(messages).where(eq(messages.id, receipts[0]!.id));
  assert.equal(receipt!.content, `Forwarded 1 message for you to:\n- #${f.dest.name}`);
  assert.equal(((receipt!.actionMetadata as { delegatedReceipts: Array<{ retractable: boolean }> }).delegatedReceipts)[0]!.retractable, true);

  // Once receipted, a further retry posts no second one.
  await forwardAsOwner(app.baseUrl, f.sendKey, body);
  assert.equal((await delegatedReceiptsQuery(getDb(), f.ownDm.id, messageId)).length, 1);
  assert.equal((await delegatedRows(f.assistant.id)).length, 1, "sent once");
});

test("a forward made by forwardAsOwner is stored exactly like the owner's own web forward of the same messages, apart from delegated_by", async ({ app }) => {
  const f = await seedForwarder();
  const token = await tokenForHuman(f.owner.email);
  const web = await fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: headers(token, f.server.id),
    body: JSON.stringify({ destinationChannelIds: [f.dest.id], requestId: randomUUID(), sourceMessageIds: [f.first.id, f.second.id], note: "FYI" }),
  });
  assert.equal(web.status, 200);
  const webBody = await web.json() as { results: Array<{ status: string; message: { id: string } }> };
  assert.equal(webBody.results[0]!.status, "success");
  const delegated = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [f.first.id, f.second.id], to: [f.dest.id], note: "FYI", requestId: randomUUID() });
  assert.equal(delegated.status, 200, JSON.stringify(delegated.body));

  const [byWeb] = await getDb().select().from(messages).where(eq(messages.id, webBody.results[0]!.message.id));
  const [byAssistant] = await getDb().select().from(messages).where(eq(messages.id, delegated.body.results[0].messageId));
  const shape = (row: typeof byWeb) => {
    const { forwardedAt: _forwardedAt, ...metadata } = row!.actionMetadata as Record<string, unknown>;
    return { channelId: row!.channelId, senderType: row!.senderType, senderId: row!.senderId, messageType: row!.messageType, content: row!.content, metadata };
  };
  assert.deepEqual(shape(byAssistant), shape(byWeb));
  assert.equal(byWeb!.delegatedByAgentId, null);
  assert.equal(byAssistant!.delegatedByAgentId, f.assistant.id);
});

test("searchForwardTargets answers the web picker's search as the owner, with the to to pass back", async ({ app }) => {
  const f = await seedForwarder();
  const search = async (q: string) => agentGet(app.baseUrl, f.sendKey, `/assistant/forward-targets?q=${encodeURIComponent(q)}`);
  const channelsFound = await search(`dest-${f.suffix}`);
  assert.equal(channelsFound.status, 200, JSON.stringify(channelsFound.body));
  assert.deepEqual(channelsFound.body.targets[0], { label: `#${f.dest.name}`, to: `#${f.dest.name}` });
  const notJoined = (await search(`open-${f.suffix}`)).body.targets[0];
  assert.deepEqual(notJoined, { label: `#${f.open.name}`, to: `#${f.open.name}`, requiredAction: "join_channel" });
  const person = (await search(f.stranger.name)).body.targets as Array<Record<string, unknown>>;
  assert.ok(person.some((target) => target.to === `@${f.stranger.name}~human` && target.requiredAction === "create_dm"));
  const self = (await search(f.assistant.name)).body.targets as Array<Record<string, unknown>>;
  assert.equal(self.some((target) => String(target.to).startsWith(`@${f.assistant.name}`)), false, "never its own DM with its owner");
  assert.equal(channelsFound.body.omitted, undefined, "nothing left out while the assistant reads DMs");

  // DMs kept from the assistant: people, agents and DMs are left out, and the answer says so.
  await setAssistantReadsDms(f.assistant.id, false);
  const withoutDms = await search(f.stranger.name);
  assert.equal(withoutDms.status, 200, JSON.stringify(withoutDms.body));
  assert.equal((withoutDms.body.targets as Array<Record<string, unknown>>).some((target) => String(target.to).startsWith("@")), false);
  assert.equal(withoutDms.body.omitted, "assistant_reads_dms_off");
  assert.equal(withoutDms.body.omittedReason, "Your owner has not let you read their DMs, so people, agents and DMs (and threads in DMs) are left out of these results.");
  const channelsStill = await search(`dest-${f.suffix}`);
  assert.deepEqual([channelsStill.body.targets[0]?.to, channelsStill.body.omitted], [`#${f.dest.name}`, "assistant_reads_dms_off"]);
});

test("the web's forward refuses more than 20 messages with too_many_messages", async ({ app }) => {
  const f = await seedForwarder();
  const token = await tokenForHuman(f.owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: headers(token, f.server.id),
    body: JSON.stringify({ channelId: f.dest.id, sourceMessageIds: Array.from({ length: 21 }, () => randomUUID()) }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "You can forward up to 20 messages at a time", code: "too_many_messages" });
});


test("forwardAsOwner refuses persistence when the owner opts out during joining", async ({ app }) => {
  const f = await seedForwarder();
  const trigger = `ark_revoke_${f.suffix.replace(/[^a-z0-9]/g, "")}`;
  await getDb().execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN UPDATE agents SET assistant_send_as_owner = false WHERE id::text = '${f.assistant.id}'; RETURN NEW; END $$ LANGUAGE plpgsql`));
  await getDb().execute(sql.raw(`CREATE TRIGGER ${trigger} AFTER INSERT ON channel_humans FOR EACH ROW WHEN (NEW.channel_id::text = '${f.other.id}' AND NEW.user_id::text = '${f.owner.id}') EXECUTE FUNCTION ${trigger}()`));
  try {
    const sent = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [f.first.id], to: [{ to: `#${f.other.name}`, join: true }], requestId: randomUUID() });
    const [current] = await getDb().select({ on: agents.assistantSendAsOwner }).from(agents).where(eq(agents.id, f.assistant.id));
    assert.equal(current.on, false, "the joining transaction committed the owner's opt-out");
    const persisted = (await delegatedRows(f.assistant.id)).filter(row => row.channelId === f.other.id);
    assert.equal(persisted.length, 0, "a forward must not be persisted after its delegation permission was turned off");
    assert.equal(sent.body.results[0].status, "failed");
    assert.equal(sent.body.results[0].code, "assistant_send_as_owner_off");
  } finally {
    await getDb().execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON channel_humans`));
    await getDb().execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`));
  }
});

// The thread is created after request preflight and before message persistence.
test("sendAsOwner refuses persistence when the owner opts out while the reply thread is created", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  const parent = await createMessage(f.room.id, "user", f.peer.id, "new reply root");
  const trigger = `revoke_on_thread_${f.assistant.id.replaceAll("-", "")}`;
  await getDb().execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN UPDATE agents SET assistant_send_as_owner = false WHERE id::text = '${f.assistant.id}'; RETURN NEW; END $$ LANGUAGE plpgsql`));
  await getDb().execute(sql.raw(`CREATE TRIGGER ${trigger} AFTER INSERT ON channels FOR EACH ROW WHEN (NEW.parent_message_id::text = '${parent.id}') EXECUTE FUNCTION ${trigger}()`));
  try {
    const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, parentMessageId: parent.id, content: "must not send after opt-out" });
    assert.equal(sent.status, 403);
    assert.equal(sent.body.code, "assistant_send_as_owner_off");
    assert.deepEqual(await delegatedRows(f.assistant.id), []);
  } finally {
    await getDb().execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON channels`));
    await getDb().execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`));
  }
});

// Miss only the requested face; subsequent storage-channel and receipt
// lookups use the real DB. The row remains, so an omitted check cannot hide
// behind an FK, and the pre-persisted control can still exercise delivery.
function missRequestedChannelLookup() {
  let first = true;
  __setMessageServiceDepsForTests({ getChannel: async (id) => {
    if (first) { first = false; return getChannel(randomUUID()); }
    return getChannel(id);
  } });
}
test("sendAsOwner fails closed when destination lookup is missing after preflight", async ({ app }) => {
  const f = await seedSender();
  await setAssistantSendAsOwner(f.assistant.id, true);
  missRequestedChannelLookup();
  try {
    const sent = await sendAsOwner(app.baseUrl, f.sendKey, { channelId: f.room.id, content: "must not persist without destination authority" });
    assert.deepEqual(await delegatedRows(f.assistant.id), [], "no delegated message may be saved when its destination cannot be resolved");
    assert.equal(sent.status, 404);
    assert.equal(sent.body.code, "channel_not_found");
  } finally { __resetMessageServiceDepsForTests(); }
});

test("forwardAsOwner delivers an already persisted message when destination lookup is missing", async ({ app }) => {
  const f = await seedForwarder();
  missRequestedChannelLookup();
  try {
    const sent = await forwardAsOwner(app.baseUrl, f.sendKey, { messages: [f.first.id], to: [`#${f.dest.name}`], requestId: randomUUID() });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.results[0].status, "sent", JSON.stringify(sent.body));
    assert.equal((await delegatedRows(f.assistant.id)).filter(row => row.channelId === f.dest.id).length, 1);
  } finally { __resetMessageServiceDepsForTests(); }
});
