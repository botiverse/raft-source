// A personal assistant acting as its owner on the owner's own web routes
// (#proj-assistant:#19; services/assistantOwnerActions.ts,
// middleware/assistantAsOwner.ts). Pins: mute / unmute and a notification
// level change the OWNER's state through the owner's own handlers; the
// response carries Raft's done and undo lines (undo with the value before);
// each change is one audit row; and every other way in is refused before any
// handler runs: an ordinary agent, a route not in the table, an extra body
// field, a query, another server's target, another server header. A person's
// own token is unaffected.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, featureFlags, integrationAuditEvents } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { findOrCreateUserDM } from "../services/channelService";
import * as serverService from "../services/serverService";
import { addMember } from "../services/serverService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function enableAssistants() {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
}

async function json(res: Response) {
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

async function seed(baseUrl: string) {
  await enableAssistants();
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`oa-owner-${suffix}@slock.test`, `oa-owner-${suffix}`);
  const server = await createServer("Owner Actions", `oa-${suffix}`, owner.id);
  const otherServer = await createServer("Other", `oa-other-${suffix}`, owner.id);
  const assistant = await createAgent(server.id, `oa-helper-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "oa-test", issuedVia: "computer", createdByUserId: null });
  const ordinary = await createAgent(server.id, `oa-ordinary-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const { apiKey: ordinaryKey } = await mintAgentCredential({ agentId: ordinary.id, scopes: ["read", "send"], name: "oa-ordinary", issuedVia: "computer", createdByUserId: null });
  const ownerToken = await tokenForHuman(owner.email);
  const createChannel = async (serverId: string, name: string) => {
    const res = await json(await fetch(`${baseUrl}/api/channels`, { method: "POST", headers: headers(ownerToken, serverId), body: JSON.stringify({ name }) }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.channel ?? res.body) as { id: string; name: string };
  };
  const design = await createChannel(server.id, `design-${suffix}`);
  const elsewhere = await createChannel(otherServer.id, `elsewhere-${suffix}`);
  return { owner, server, otherServer, assistant, ordinary, apiKey, ordinaryKey, ownerToken, design, elsewhere };
}

function asAgent(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(json);
}

async function ownerMuted(baseUrl: string, token: string, serverId: string, channelId: string) {
  const res = await json(await fetch(`${baseUrl}/api/channels/${channelId}/notification-settings`, { headers: headers(token, serverId) }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.activityMuted as boolean;
}

const auditRowsOf = (agentId: string) => getDb().select().from(integrationAuditEvents)
  .where(and(eq(integrationAuditEvents.actorId, agentId), eq(integrationAuditEvents.eventType, "assistant.owner_action")));

test("mute and unmute: the owner's mute changes, the response says what changed and how to undo it, each change is audited", async ({ app }) => {
  const f = await seed(app.baseUrl);
  const path = `/api/channels/${f.design.id}/notification-settings`;

  const mute = await asAgent(app.baseUrl, f.apiKey, "PATCH", path, { activityMuted: true });
  assert.equal(mute.status, 200, JSON.stringify(mute.body));
  assert.equal(mute.body.activityMuted, true);
  assert.equal(await ownerMuted(app.baseUrl, f.ownerToken, f.server.id, f.design.id), true);
  assert.equal(mute.body.assistant.done, `Muted #${f.design.name} for ${f.owner.displayName ?? f.owner.name}.`);
  assert.deepEqual(mute.body.assistant.undo, {
    tool: "mute_conversation",
    args: { target: `#${f.design.name}`, muted: false },
    text: `To undo: mute_conversation(target: "#${f.design.name}", muted: false).`,
  });

  // The same again changes nothing: no undo, no audit row.
  const again = await asAgent(app.baseUrl, f.apiKey, "PATCH", path, { activityMuted: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.assistant.undo, null);
  assert.match(again.body.assistant.done, /^Nothing changed: #\S+ was already muted/);

  const unmute = await asAgent(app.baseUrl, f.apiKey, "PATCH", path, { activityMuted: false });
  assert.equal(unmute.status, 200);
  assert.equal(await ownerMuted(app.baseUrl, f.ownerToken, f.server.id, f.design.id), false);
  assert.match(unmute.body.assistant.done, /^Unmuted #/);

  const rows = await auditRowsOf(f.assistant.id);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.subjectId, f.owner.id);
    assert.equal(row.serverId, f.server.id);
    assert.equal((row.metadata as Record<string, unknown>).action, "conversationMute");
    assert.equal((row.metadata as Record<string, unknown>).targetId, f.design.id);
  }
  assert.deepEqual(rows.map((row) => (row.metadata as Record<string, unknown>).nextValue).sort(), [false, true]);
});

test("a notification level: set as the owner, the web's label in the done line, undo carries the level before; none on a channel is a mute", async ({ app }) => {
  const f = await seed(app.baseUrl);
  // Silencing one channel: refused before the handler, pointing at mute_conversation (Sage).
  const silence = await asAgent(app.baseUrl, f.apiKey, "PUT", "/api/notification-levels", { scope: "channel", id: f.design.id, level: "none" });
  assert.equal(silence.status, 400, JSON.stringify(silence.body));
  assert.equal(silence.body.code, "assistant_owner_action_use_mute");
  assert.equal(silence.body.error, "To silence a channel, use mute_conversation; none is for the whole server.");
  assert.equal((await auditRowsOf(f.assistant.id)).length, 0);

  const set = await asAgent(app.baseUrl, f.apiKey, "PUT", "/api/notification-levels", { scope: "channel", id: f.design.id, level: "mentions" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.level, "mentions");
  assert.match(set.body.assistant.done, /^Set #.* to "Only what involves me" for /);
  assert.deepEqual(set.body.assistant.undo.args, { target: `#${f.design.name}`, level: "default" });
  assert.match(set.body.assistant.undo.text, /, the level before this change\.$/);

  const levels = await json(await fetch(`${app.baseUrl}/api/notification-levels`, { headers: headers(f.ownerToken, f.server.id) }));
  assert.equal(levels.body.channels.find((row: { id: string }) => row.id === f.design.id)?.level, "mentions");

  const server = await asAgent(app.baseUrl, f.apiKey, "PUT", "/api/notification-levels", { scope: "server", id: f.server.id, level: "none" });
  assert.equal(server.status, 200, JSON.stringify(server.body));
  assert.match(server.body.assistant.done, /^Set this server to "Nothing" for /);
  assert.equal(server.body.assistant.undo.args.target, "server");
  assert.equal(typeof server.body.assistant.undo.args.level, "string");
});

test("refused before any handler runs: another agent, a route not in the table, an extra field, a query, another server", async ({ app }) => {
  const f = await seed(app.baseUrl);
  const path = `/api/channels/${f.design.id}/notification-settings`;

  // Any agent key that is not a live assistant: exactly the 401 an agent key got on a web route before #19.
  const ordinary = await asAgent(app.baseUrl, f.ordinaryKey, "PATCH", path, { activityMuted: true });
  assert.equal(ordinary.status, 401);
  assert.deepEqual(ordinary.body, { error: "Invalid or expired token", code: "auth_required" });
  const ordinaryElsewhere = await asAgent(app.baseUrl, f.ordinaryKey, "POST", `/api/channels/${f.design.id}/leave`, {});
  assert.equal(ordinaryElsewhere.status, 401);
  assert.deepEqual(ordinaryElsewhere.body, { error: "Invalid or expired token", code: "auth_required" });

  // A live assistant on a route outside the table: 401, with the NOT_ALLOWED text (its context lists the table).
  const notInTable = await asAgent(app.baseUrl, f.apiKey, "POST", `/api/channels/${f.design.id}/leave`, {});
  assert.equal(notInTable.status, 401);
  assert.equal(notInTable.body.code, "assistant_owner_action_not_allowed");
  assert.match(notInTable.body.error, /the owner-action tools you were given are the full list/);
  assert.ok(notInTable.body.suggestedNextAction);
  const read = await asAgent(app.baseUrl, f.apiKey, "GET", "/api/auth/me");
  assert.equal(read.status, 401);
  assert.equal(read.body.code, "assistant_owner_action_not_allowed");

  const extra = await asAgent(app.baseUrl, f.apiKey, "PATCH", path, { activityMuted: true, receiverId: randomUUID() });
  assert.equal(extra.status, 403);
  const query = await asAgent(app.baseUrl, f.apiKey, "PATCH", `${path}?x=1`, { activityMuted: true });
  assert.equal(query.status, 403);

  const otherTarget = await asAgent(app.baseUrl, f.apiKey, "PATCH", `/api/channels/${f.elsewhere.id}/notification-settings`, { activityMuted: true });
  assert.equal(otherTarget.status, 404);
  assert.equal(otherTarget.body.code, "assistant_owner_action_target_not_found");
  const otherServerLevel = await asAgent(app.baseUrl, f.apiKey, "PUT", "/api/notification-levels", { scope: "server", id: f.otherServer.id, level: "none" });
  assert.equal(otherServerLevel.status, 404);
  const otherHeader = await asAgent(app.baseUrl, f.apiKey, "PATCH", path, { activityMuted: true }, { "X-Server-Id": f.otherServer.id });
  assert.equal(otherHeader.status, 403);

  assert.equal(await ownerMuted(app.baseUrl, f.ownerToken, f.server.id, f.design.id), false);
  assert.equal(await ownerMuted(app.baseUrl, f.ownerToken, f.otherServer.id, f.elsewhere.id), false);
  assert.equal((await auditRowsOf(f.assistant.id)).length, 0);

  // A paused assistant is not a live one: the old 401.
  await getDb().update(agents).set({ assistantPausedAt: new Date() }).where(eq(agents.id, f.assistant.id));
  const paused = await asAgent(app.baseUrl, f.apiKey, "PATCH", path, { activityMuted: true });
  assert.equal(paused.status, 401);
  assert.deepEqual(paused.body, { error: "Invalid or expired token", code: "auth_required" });
});

test("the owner's own token works exactly as before, and the assistant's context lists its owner actions", async ({ app }) => {
  const f = await seed(app.baseUrl);
  const own = await json(await fetch(`${app.baseUrl}/api/channels/${f.design.id}/notification-settings`, {
    method: "PATCH", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ activityMuted: true }),
  }));
  assert.equal(own.status, 200);
  assert.equal(own.body.activityMuted, true);
  assert.equal(own.body.assistant, undefined);

  const context = await json(await fetch(`${app.baseUrl}/internal/agent-api/context`, { headers: { Authorization: `Bearer ${f.apiKey}` } }));
  assert.equal(context.status, 200, JSON.stringify(context.body));
  const actions = context.body.agent.assistantOf.ownerActions as Array<{ tool: string; tier: string; description: string; method: string; path: string }>;
  assert.deepEqual(actions.map((action) => action.tool), ["mute_conversation", "set_notification_level", "move_conversation", "pin_conversation", "arrange_conversations", "move_agent", "save_message", "list_owner_channels", "get_owner_notification_settings", "get_owner_sidebar", "list_owner_agents", "list_owner_computers", "list_owner_saved_messages"]);
  assert.deepEqual(actions.map((action) => action.tier), ["direct", "direct", "direct", "direct", "direct", "confirm", "direct", "read", "read", "read", "read", "read", "read"]);
  // A read words its own description (Sage), and its filter is optional.
  const channelsRead = actions.find((action) => action.tool === "list_owner_channels") as unknown as { description: string; params: Array<Record<string, unknown>>; mapping: unknown[] };
  assert.match(channelsRead.description, /^The channels your owner is in on this server: .+ To change one, use mute_conversation or set_notification_level\./);
  assert.deepEqual(channelsRead.params, [{ name: "filter", kind: "text", description: "Optional: part of a name (any case), to list only those that contain it.", optional: true }]);
  assert.deepEqual(channelsRead.mapping, [{ param: "filter", into: "query", field: "filter" }]);
  assert.match(actions[0]!.description, /^Mute or unmute a conversation as .+\. Runs right away and affects only .+; it can be undone\./);
  assert.equal(actions[0]!.path, "/api/channels/:id/notification-settings");
});

test("a DM target: dm:@peer resolves to the owner's existing DM (never a new one) and is admitted, the owner's own mute rule applies; someone else's DM is refused", async ({ app }) => {
  const f = await seed(app.baseUrl);
  const suffix = randomUUID().slice(0, 8);
  const peer = await seedUser(`oa-peer-${suffix}@slock.test`, `oa-peer-${suffix}`);
  const third = await seedUser(`oa-third-${suffix}@slock.test`, `oa-third-${suffix}`);
  await addMember(f.server.id, peer.id);
  await addMember(f.server.id, third.id);
  const ownerDm = await findOrCreateUserDM(f.server.id, f.owner.id, peer.id);
  const othersDm = await findOrCreateUserDM(f.server.id, peer.id, third.id);
  assert.ok(ownerDm && othersDm);

  // owner-resolve: the owner's DM with the peer; none with the third person (never created).
  const resolved = await asAgent(app.baseUrl, f.apiKey, "GET", `/internal/agent-api/assistant/owner-resolve?name=${encodeURIComponent(`dm:@${peer.name}`)}`);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.deepEqual(resolved.body, { id: ownerDm.id, type: "dm", name: peer.name });
  const noDm = await asAgent(app.baseUrl, f.apiKey, "GET", `/internal/agent-api/assistant/owner-resolve?name=${encodeURIComponent(`dm:@${third.name}`)}`);
  assert.equal(noDm.status, 404);

  // Admitted as the owner's own DM; the owner's handler then applies its own rule
  // (only an app bot's DM can be muted), unchanged, and nothing is audited.
  const mute = await asAgent(app.baseUrl, f.apiKey, "PATCH", `/api/channels/${ownerDm.id}/notification-settings`, { activityMuted: true });
  assert.equal(mute.status, 400, JSON.stringify(mute.body));
  assert.equal(mute.body.code, "ACTIVITY_MUTE_NOT_SUPPORTED");
  // Raft's own words for the assistant (Sage), the handler's code kept.
  assert.equal(mute.body.error, `Raft can't mute a DM with a person, only channels and DMs with app bots. Tell ${f.owner.name}.`);
  assert.equal(mute.body.assistant, undefined);
  assert.equal((await auditRowsOf(f.assistant.id)).length, 0);

  // A DM between two other people: refused before the handler, the owner's state untouched.
  const refused = await asAgent(app.baseUrl, f.apiKey, "PATCH", `/api/channels/${othersDm.id}/notification-settings`, { activityMuted: true });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, "assistant_owner_action_target_not_found");
});

test("the owner's settings page lists what the assistant did as them, newest first, named as they see it", async ({ app }) => {
  const f = await seed(app.baseUrl);
  await asAgent(app.baseUrl, f.apiKey, "PATCH", `/api/channels/${f.design.id}/notification-settings`, { activityMuted: true });
  await asAgent(app.baseUrl, f.apiKey, "PUT", "/api/notification-levels", { scope: "server", id: f.server.id, level: "mentions" });
  const mine = await json(await fetch(`${app.baseUrl}/api/servers/${f.server.id}/assistant/setting-changes`, { headers: headers(f.ownerToken, f.server.id) }));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const changes = mine.body.changes as Array<Record<string, unknown>>;
  assert.deepEqual(changes.map(({ setting, targetRef, previousValue, nextValue, agentId }) => ({ setting, targetRef, previousValue, nextValue, agentId })), [
    { setting: "notificationLevel", targetRef: "server", previousValue: "all", nextValue: "mentions", agentId: f.assistant.id },
    { setting: "conversationMute", targetRef: `#${f.design.name}`, previousValue: false, nextValue: true, agentId: f.assistant.id },
  ]);
  // Not in the other server's list.
  const elsewhere = await json(await fetch(`${app.baseUrl}/api/servers/${f.otherServer.id}/assistant/setting-changes`, { headers: headers(f.ownerToken, f.otherServer.id) }));
  assert.deepEqual(elsewhere.body.changes, []);
});

async function ownerSidebar(baseUrl: string, token: string, serverId: string) {
  const res = await json(await fetch(`${baseUrl}/api/servers/${serverId}/sidebar-order`, { headers: headers(token, serverId) }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { channelOrder: string[]; pinned: Array<{ kind: string; id: string }> };
}

test("move_conversation: Raft computes the owner's order in the same request (top, after, bottom), undo puts it back; a sorted list, a pin, another server and a mixed body are refused", async ({ app }) => {
  const f = await seed(app.baseUrl);
  const suffix = randomUUID().slice(0, 8);
  const create = async (name: string) => {
    const res = await json(await fetch(`${app.baseUrl}/api/channels`, { method: "POST", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ name }) }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.channel ?? res.body) as { id: string; name: string };
  };
  const alpha = await create(`alpha-${suffix}`);
  const beta = await create(`beta-${suffix}`);
  const ours = [f.design.id, alpha.id, beta.id];
  const sidebarPath = `/api/servers/${f.server.id}/sidebar-order`;
  const order = async () => (await ownerSidebar(app.baseUrl, f.ownerToken, f.server.id)).channelOrder.filter((id) => ours.includes(id));

  // Pin the starting order the way a person's drag would (full manual order).
  const start = await json(await fetch(`${app.baseUrl}${sidebarPath}`, { method: "PATCH", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ channelOrder: ours }) }));
  assert.equal(start.status, 200, JSON.stringify(start.body));

  const top = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: beta.id, position: "top" });
  assert.equal(top.status, 200, JSON.stringify(top.body));
  assert.deepEqual(await order(), [beta.id, f.design.id, alpha.id]);
  assert.equal(top.body.assistant.done, `Moved #${beta.name} to the top of ${f.owner.name}'s sidebar.`);
  assert.deepEqual(top.body.assistant.undo.args, { target: `#${beta.name}`, position: { after: `#${alpha.name}` } });
  assert.equal(top.body.assistant.undo.text, `To undo: move_conversation(target: "#${beta.name}", position: { after: "#${alpha.name}" }), where it was before.`);

  // The undo, as the SDK sends it (refs resolved to ids): back where it was.
  const undo = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: beta.id, position: { after: alpha.id } });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.deepEqual(await order(), ours);

  const after = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: f.design.id, position: { after: alpha.id } });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(await order(), [alpha.id, f.design.id, beta.id]);
  assert.deepEqual(after.body.assistant.undo.args, { target: `#${f.design.name}`, position: "top" });

  const bottom = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: alpha.id, position: "bottom" });
  assert.equal(bottom.status, 200, JSON.stringify(bottom.body));
  assert.equal((await order()).at(-1), alpha.id);
  assert.match(bottom.body.assistant.done, /to the bottom of /);

  const again = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: alpha.id, position: "bottom" });
  assert.equal(again.status, 200);
  assert.equal(again.body.assistant.undo, null);
  assert.match(again.body.assistant.done, /^Nothing changed: \S+ was already there/);

  const moves = (await auditRowsOf(f.assistant.id)).filter((row) => row.metadata?.action === "sidebarMove");
  assert.equal(moves.length, 4, "every real move is audited, the no-op is not");

  // Refusals, before the handler: a mixed body, a channel of another server, a bad position, after itself.
  const mixed = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: beta.id, position: "top", pinned: true });
  assert.equal(mixed.status, 403);
  const raw = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { channelOrder: [beta.id] });
  assert.equal(raw.status, 403, "the route's own fields are Raft's, never the assistant's");
  const foreign = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: f.elsewhere.id, position: "top" });
  assert.equal(foreign.status, 404);
  const otherPath = await asAgent(app.baseUrl, f.apiKey, "PATCH", `/api/servers/${f.otherServer.id}/sidebar-order`, { targetId: beta.id, position: "top" });
  assert.equal(otherPath.status, 404);
  const badPosition = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: beta.id, position: "middle" });
  assert.equal(badPosition.status, 400);
  assert.equal(badPosition.body.code, "assistant_owner_action_invalid_position");
  const self = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: beta.id, position: { after: beta.id } });
  assert.equal(self.status, 400);

  // Pinned: keeps its own order.
  const pin = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: beta.id, pinned: true });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  const pinnedMove = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: beta.id, position: "top" });
  assert.equal(pinnedMove.status, 409);
  assert.equal(pinnedMove.body.code, "assistant_owner_action_pinned");

  // Sorted by name, then by recent activity: manual order wouldn't show, so it is refused with Tenny's text.
  for (const [mode, words] of [["az", "by name"], ["recent", "by recent activity"]] as const) {
    const sort = await json(await fetch(`${app.baseUrl}${sidebarPath}`, { method: "PATCH", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ channelSortMode: mode }) }));
    assert.equal(sort.status, 200, JSON.stringify(sort.body));
    const sorted = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: f.design.id, position: "top" });
    assert.equal(sorted.status, 409, JSON.stringify(sorted.body));
    assert.equal(sorted.body.code, "assistant_owner_action_sidebar_sorted");
    assert.equal(sorted.body.error, `${f.owner.name}'s sidebar is sorted ${words}, so manual order doesn't apply; they can switch it in settings.`);
  }
});

test("arrange_conversations (#proj-assistant:#28): a whole list in one call, pinned ones included; undo restores; refusals change nothing", async ({ app }) => {
  const f = await seed(app.baseUrl);
  const suffix = randomUUID().slice(0, 8);
  const create = async (name: string) => {
    const res = await json(await fetch(`${app.baseUrl}/api/channels`, { method: "POST", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ name }) }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.channel ?? res.body) as { id: string; name: string };
  };
  const alpha = await create(`alpha-${suffix}`);
  const beta = await create(`beta-${suffix}`);
  const gamma = await create(`gamma-${suffix}`);
  const ours = [f.design.id, alpha.id, beta.id, gamma.id];
  const sidebarPath = `/api/servers/${f.server.id}/sidebar-order`;
  const order = async () => (await ownerSidebar(app.baseUrl, f.ownerToken, f.server.id)).channelOrder.filter((id) => ours.includes(id));
  const pinnedIds = async () => (await ownerSidebar(app.baseUrl, f.ownerToken, f.server.id)).pinned.filter((ref) => ref.kind === "channel").map((ref) => ref.id);
  const start = await json(await fetch(`${app.baseUrl}${sidebarPath}`, { method: "PATCH", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ channelOrder: ours }) }));
  assert.equal(start.status, 200, JSON.stringify(start.body));

  // Channels: these first, in this order; the one left out keeps its place after them.
  const arranged = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "channels", orderIds: [gamma.id, alpha.id, f.design.id] });
  assert.equal(arranged.status, 200, JSON.stringify(arranged.body));
  assert.deepEqual(await order(), [gamma.id, alpha.id, f.design.id, beta.id]);
  assert.match(arranged.body.assistant.done, new RegExp(`^Arranged ${f.owner.name}'s channels in the sidebar: #gamma`));
  assert.deepEqual(arranged.body.assistant.undo.args.list, "channels");
  // The undo, as the SDK sends it: back as it was.
  // (The owner's other channels are in it too; ours are the ones this test checks.)
  const undoIds = (arranged.body.assistant.undo.args.order as string[])
    .map((ref) => [f.design, alpha, beta, gamma].find((c) => `#${c.name}` === ref)?.id)
    .filter((id): id is string => Boolean(id));
  assert.deepEqual(undoIds, ours, "the undo names the order before");
  const undo = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "channels", orderIds: undoIds });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.deepEqual(await order(), ours);

  // Pinned: exactly these, in this order, in one call; then a reorder of the pinned ones, and unpin all.
  const pin = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "pinned", orderIds: [beta.id, alpha.id] });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.deepEqual(await pinnedIds(), [beta.id, alpha.id]);
  const repin = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "pinned", orderIds: [alpha.id, gamma.id] });
  assert.equal(repin.status, 200, JSON.stringify(repin.body));
  assert.deepEqual(await pinnedIds(), [alpha.id, gamma.id], "beta unpinned, gamma pinned, alpha first");
  const none = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "pinned", orderIds: [] });
  assert.equal(none.status, 200, JSON.stringify(none.body));
  assert.deepEqual(await pinnedIds(), []);
  const same = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "pinned", orderIds: [] });
  assert.equal(same.body.assistant.undo, null);
  assert.match(same.body.assistant.done, /^Nothing changed/);

  // Refusals change nothing: a pinned one in a list, a duplicate, a bad list, another server's channel.
  await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "pinned", orderIds: [beta.id] });
  const before = await order();
  const pinnedInList = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "channels", orderIds: [alpha.id, beta.id] });
  assert.equal(pinnedInList.status, 409);
  assert.equal(pinnedInList.body.code, "assistant_owner_action_pinned");
  const dup = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "channels", orderIds: [alpha.id, alpha.id] });
  assert.equal(dup.status, 400);
  const badList = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "agents", orderIds: [alpha.id] });
  assert.equal(badList.status, 400);
  const foreign = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "channels", orderIds: [alpha.id, f.elsewhere.id] });
  assert.equal(foreign.status, 404);
  assert.deepEqual(await order(), before);
  assert.deepEqual(await pinnedIds(), [beta.id]);

  // Pins the assistant can't see stay, through an arrangement and its undo (Tenny, #14060):
  // an agent pinned with no DM. (A pin on an archived channel is dropped by the
  // route on any write of the pins, the owner's own included; not this action's.)
  const ownerPins = [{ kind: "channel", id: beta.id }, { kind: "agent", id: f.ordinary.id }];
  const setPins = await json(await fetch(`${app.baseUrl}${sidebarPath}`, { method: "PATCH", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ pinned: ownerPins }) }));
  assert.equal(setPins.status, 200, JSON.stringify(setPins.body));
  // As stored.
  const pinnedRefs = async () => ((await serverService.getSanitizedMemberSidebarOrder(f.server.id, f.owner.id))?.pinned ?? []).map((ref) => `${ref.kind}:${ref.id}`);
  assert.deepEqual(await pinnedRefs(), [`channel:${beta.id}`, `agent:${f.ordinary.id}`]);
  const arrangePins = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "pinned", orderIds: [gamma.id] });
  assert.equal(arrangePins.status, 200, JSON.stringify(arrangePins.body));
  assert.deepEqual(await pinnedRefs(), [`channel:${gamma.id}`, `agent:${f.ordinary.id}`], "beta (which it can see) unpinned; the agent with no DM kept, after the ones it named");
  const undoPins = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { list: "pinned", orderIds: arrangePins.body.assistant.undo.args.order.map((ref: string) => (ref === `#${beta.name}` ? beta.id : ref)) });
  assert.equal(undoPins.status, 200, JSON.stringify(undoPins.body));
  assert.deepEqual(await pinnedRefs(), [`channel:${beta.id}`, `agent:${f.ordinary.id}`], "after the undo, as the owner had them");

  // The settings page lists it (every real arrangement, not the no-op).
  const mine = await json(await fetch(`${app.baseUrl}/api/servers/${f.server.id}/assistant/setting-changes`, { headers: headers(f.ownerToken, f.server.id) }));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const arrangedRows = (mine.body.changes as Array<{ setting: string }>).filter((change) => change.setting === "sidebarArrange");
  assert.equal(arrangedRows.length, 8);
});

test("pin_conversation: pins and unpins as the owner, undo is the opposite; the settings page lists the sidebar changes", async ({ app }) => {
  const f = await seed(app.baseUrl);
  const sidebarPath = `/api/servers/${f.server.id}/sidebar-order`;
  const pinnedIds = async () => (await ownerSidebar(app.baseUrl, f.ownerToken, f.server.id)).pinned.filter((ref) => ref.kind === "channel").map((ref) => ref.id);

  const pin = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: f.design.id, pinned: true });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.deepEqual(await pinnedIds(), [f.design.id]);
  assert.equal(pin.body.assistant.done, `Pinned #${f.design.name} in ${f.owner.name}'s sidebar.`);
  assert.deepEqual(pin.body.assistant.undo.args, { target: `#${f.design.name}`, pinned: false });

  const again = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: f.design.id, pinned: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.assistant.undo, null);

  const unpin = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: f.design.id, pinned: false });
  assert.equal(unpin.status, 200, JSON.stringify(unpin.body));
  assert.deepEqual(await pinnedIds(), []);
  assert.equal(unpin.body.assistant.done, `Unpinned #${f.design.name} in ${f.owner.name}'s sidebar.`);

  const other = await json(await fetch(`${app.baseUrl}/api/channels`, { method: "POST", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ name: `zeta-${randomUUID().slice(0, 8)}` }) }));
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const otherId = ((other.body.channel ?? other.body) as { id: string }).id;
  const move = await asAgent(app.baseUrl, f.apiKey, "PATCH", sidebarPath, { targetId: f.design.id, position: { after: otherId } });
  assert.equal(move.status, 200, JSON.stringify(move.body));

  const mine = await json(await fetch(`${app.baseUrl}/api/servers/${f.server.id}/assistant/setting-changes`, { headers: headers(f.ownerToken, f.server.id) }));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const settings = (mine.body.changes as Array<{ setting: string; targetRef: string; previousValue: unknown; nextValue: unknown }>)
    .filter((change) => change.setting === "sidebarPin" || change.setting === "sidebarMove")
    .map(({ setting, targetRef, previousValue, nextValue }) => ({ setting, targetRef, previousValue, nextValue }));
  const moved = settings[0]!;
  assert.equal(moved.setting, "sidebarMove");
  assert.equal(moved.targetRef, `#${f.design.name}`);
  assert.deepEqual(settings.slice(1), [
    { setting: "sidebarPin", targetRef: `#${f.design.name}`, previousValue: true, nextValue: false },
    { setting: "sidebarPin", targetRef: `#${f.design.name}`, previousValue: false, nextValue: true },
  ]);
});
