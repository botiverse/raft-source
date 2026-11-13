// RFC 077 step 1: a personal assistant's contact rules, quiet hours and
// "already told" facts, kept by Raft. Pins: subjects resolve with the owner's
// visibility (unseen = not found), the same effect on the same subject
// updates, the limits, the import's idempotency and legacy counting, told
// validation, the 30-day sweep, and deletion with the assistant.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, assistantContactRules, assistantContactSettings, assistantTold, featureFlags } from "../db/schema";
import { createAgent, deleteAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addMember } from "../services/serverService";
import { addHuman, createChannel, findOrCreateUserDM, getOrCreateThread, removeHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { sweepAssistantTold } from "../services/assistantContactRulesService";
import { createServer, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function enableAssistants() {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
}

async function seed() {
  await enableAssistants();
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`contact-owner-${suffix}@slock.test`, `contact-owner-${suffix}`);
  const peer = await seedUser(`contact-peer-${suffix}@slock.test`, `contact-peer-${suffix}`);
  const server = await createServer("Contact Server", `contact-${suffix}`, owner.id);
  await addMember(server.id, peer.id);
  const room = await createChannel(server.id, `room-${suffix}`);
  await addHuman(room.id, owner.id);
  await addHuman(room.id, peer.id);
  const roomMessage = await createMessage(room.id, "user", peer.id, "room activity");
  const thread = await getOrCreateThread(roomMessage.id, peer.id, "user");
  const secret = await createChannel(server.id, `secret-${suffix}`, undefined, "private");
  await addHuman(secret.id, peer.id);
  const secretMessage = await createMessage(secret.id, "user", peer.id, "private chatter");
  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);
  const assistant = await createAgent(server.id, `contact-helper-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "contact-test", issuedVia: "computer", createdByUserId: null });
  return { suffix, owner, peer, server, room, roomMessage, thread, secret, secretMessage, dm, assistant, apiKey };
}

async function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const rulesOf = (agentId: string) => getDb().select().from(assistantContactRules).where(eq(assistantContactRules.agentId, agentId));

test("add, list, update and remove a rule; the confirmation is written from what was stored", async ({ app }) => {
  const f = await seed();
  const add = (body: unknown) => call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules", body);

  const muted = await add({ effect: "mute", subject: `#${f.room.name}` });
  assert.equal(muted.status, 200, JSON.stringify(muted.body));
  assert.equal(muted.body.updated, false);
  assert.deepEqual(muted.body.rule.subject, { kind: "channel", id: f.room.id, name: f.room.name });
  assert.equal(muted.body.confirmation, `General chat in #${f.room.name} won't notify you anymore; @mentions of you still will.`);

  // The same effect on the same subject updates that rule.
  const until = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const again = await add({ effect: "mute", subject: f.room.id, until, note: "just today" });
  assert.deepEqual([again.status, again.body.updated, again.body.rule.id, again.body.rule.note], [200, true, muted.body.rule.id, "just today"]);
  assert.match(again.body.confirmation, /won't notify you anymore, until /);
  assert.equal((await rulesOf(f.assistant.id)).length, 1);

  const always = await add({ effect: "always", subject: `@${f.peer.name}`, anytime: true });
  assert.equal(always.body.confirmation, `I'll tell you right away about @${f.peer.name}, nights included.`);
  const digest = await add({ effect: "digest", subject: "kind:decided" });
  assert.equal(digest.body.confirmation, "Decisions others made go in your morning brief only.");
  const thread = await add({ effect: "mute", subject: `#${f.room.name}:${f.roomMessage.id.slice(0, 8)}` });
  assert.deepEqual(thread.body.rule.subject, { kind: "thread", id: f.thread.id, ref: `#${f.room.name}:${f.roomMessage.id.slice(0, 8)}` });
  assert.equal((await add({ effect: "mute", subject: "dms" })).body.confirmation, "I won't tell you about your DMs anymore.");
  assert.equal((await add({ effect: "mute", subject: "dms" })).body.updated, true, "dms (a null subject id) is unique too");

  const listed = await call(app.baseUrl, f.apiKey, "GET", "/assistant/contact-rules");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.rules.length, 5);
  assert.deepEqual(listed.body.settings.quiet, { from: "22:00", to: "08:00" }, "no settings row: the default quiet hours");
  assert.match(listed.body.lines.defaults, /^By default you hear about @mentions of you/);
  assert.ok((listed.body.rules as Array<{ line: string }>).some((rule) => rule.line === `${always.body.rule.id.slice(0, 8)} · always @${f.peer.name} (any time)`));

  const removed = await call(app.baseUrl, f.apiKey, "DELETE", `/assistant/contact-rules/${digest.body.rule.id.slice(0, 8)}`);
  assert.deepEqual([removed.status, removed.body.confirmation], [200, "Removed: digest kind decided."]);
  assert.equal((await call(app.baseUrl, f.apiKey, "DELETE", `/assistant/contact-rules/${digest.body.rule.id}`)).body.code, "contact_rule_not_found");
});

test("a subject resolves only to what the owner can see; refusals write nothing", async ({ app }) => {
  const f = await seed();
  const add = (body: unknown) => call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules", body);
  const missing = await add({ effect: "mute", subject: `#nowhere-${f.suffix}` });
  assert.deepEqual([missing.status, missing.body.code], [400, "subject_not_found"]);
  for (const subject of [`#${f.secret.name}`, f.secret.id, f.dm!.id, `@nobody-${f.suffix}`]) {
    const res = await add({ effect: "mute", subject });
    assert.deepEqual([res.status, res.body], [400, missing.body], `${subject} is answered like nothing`);
  }
  assert.equal((await add({ effect: "mute", subject: "kind:gossip" })).body.code, "invalid_subject");
  assert.equal((await add({ effect: "mute", subject: "dms", anytime: true })).body.code, "invalid_anytime");
  assert.equal((await add({ effect: "mute", subject: "dms", until: new Date(Date.now() + 91 * 24 * 3_600_000).toISOString() })).body.code, "invalid_until");
  assert.equal((await add({ effect: "mute", subject: "dms", until: new Date(Date.now() - 1000).toISOString() })).body.code, "invalid_until");
  assert.equal((await rulesOf(f.assistant.id)).length, 0);

  // At most 50 rules.
  await getDb().insert(assistantContactRules).values(Array.from({ length: 50 }, (_, i) => ({
    agentId: f.assistant.id, serverId: f.server.id, effect: "mute" as const, subjectKind: "legacy" as const, subjectId: `seed-${i}`,
  })));
  const full = await add({ effect: "mute", subject: "dms" });
  assert.deepEqual([full.status, full.body.code], [409, "contact_rules_full"]);
});

test("quiet hours: set, turn off, refuse a bad shape", async ({ app }) => {
  const f = await seed();
  const put = (quiet: unknown) => call(app.baseUrl, f.apiKey, "PUT", "/assistant/contact-settings", { quiet });
  assert.equal((await put({ from: "23:00", to: "23:00" })).body.code, "invalid_quiet");
  assert.equal((await put({ from: "7am", to: "08:00" })).body.code, "invalid_quiet");
  const set = await put({ from: "23:00", to: "07:30" });
  assert.equal(set.status, 200);
  assert.match(set.body.confirmation, /^Quiet hours are now 23:00-07:30 \(UTC\)/);
  const off = await put(null);
  assert.match(off.body.confirmation, /^Quiet hours are off/);
  const listed = await call(app.baseUrl, f.apiKey, "GET", "/assistant/contact-rules");
  assert.equal(listed.body.settings.quiet, null);
  assert.equal(listed.body.lines.quiet, "no quiet hours (UTC)");
});

test("import: idempotent by the runtime's rule id; legacy kept and counted; expired and unreadable skipped", async ({ app }) => {
  const f = await seed();
  const now = Date.now();
  const rules = [
    { id: "r1", effect: "mute", subject: { kind: "channel", id: f.room.id, name: f.room.name }, anytime: false, until: null, note: "too chatty", createdAt: new Date(now - 60_000).toISOString() },
    { id: "r2", effect: "always", subject: { kind: "person", id: f.peer.id, type: "human", name: f.peer.name }, anytime: true, until: null, note: null, createdAt: null },
    { id: "r3", channel: f.room.name, note: "v1, one name" },
    { id: "r4", channel: f.room.name, sender: f.peer.name, note: "v1, two names" },
    { id: "r5", effect: "digest", subject: { kind: "kind", value: "decided" }, anytime: false, until: new Date(now - 1000).toISOString(), note: null, createdAt: null },
    { id: "r6", effect: "mute", subject: { kind: "nonsense" } },
    { effect: "mute", subject: { kind: "dms" } },
    { id: "r8", effect: "mute", subject: { kind: "person", id: null, type: null, name: `ghost-${f.suffix}` }, anytime: false, until: null, note: null, createdAt: null },
  ];
  const body = { rules, contact: { quiet: { from: "21:00", to: "07:00" } }, statedTimezone: "Asia/Shanghai" };
  const first = await call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules/import", body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // r1, r2 imported; r3 (v1, one channel name) lands on r1's subject: skipped, never overwrites another rule;
  // r4 (two names) and r8 (a name the owner cannot resolve) kept as legacy; r5 expired, r6 unreadable, the id-less one: skipped.
  assert.deepEqual(first.body, { imported: 4, updated: 0, skipped: 4, legacy: 2 });
  const stored = await rulesOf(f.assistant.id);
  assert.equal(stored.length, 4);
  assert.equal(stored.filter((row) => row.subjectKind === "legacy").length, 2);
  const [settings] = await getDb().select().from(assistantContactSettings).where(eq(assistantContactSettings.agentId, f.assistant.id));
  assert.deepEqual([settings!.quiet, settings!.statedTimezone], [{ from: "21:00", to: "07:00" }, "Asia/Shanghai"]);

  const second = await call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules/import", body);
  assert.deepEqual(second.body, { imported: 0, updated: 4, skipped: 4, legacy: 2 }, "a repeated push adds nothing and flips nothing");
  assert.equal((await rulesOf(f.assistant.id)).length, 4);

  const listed = await call(app.baseUrl, f.apiKey, "GET", "/assistant/contact-rules");
  assert.equal(listed.body.settings.timezone, "Asia/Shanghai", "the stated zone is the fallback while Raft knows none");
  assert.ok((listed.body.rules as Array<{ line: string }>).some((rule) => rule.line.endsWith("(an older rule; say it again to replace it)")));
});

test("told: only owner-visible messages in this server; listed since a time; swept after 30 days", async ({ app }) => {
  const f = await seed();
  const other = await seed();
  const otherMessage = await createMessage(other.room.id, "user", other.peer.id, "elsewhere");
  const recorded = await call(app.baseUrl, f.apiKey, "POST", "/assistant/told", {
    messageIds: [f.roomMessage.id, f.secretMessage.id, otherMessage.id, randomUUID(), "not-an-id"],
    via: "notify",
  });
  assert.deepEqual(recorded.body, { recorded: 1, skipped: 4 });
  const since = new Date(Date.now() - 60_000).toISOString();
  const listed = await call(app.baseUrl, f.apiKey, "GET", `/assistant/told?since=${encodeURIComponent(since)}`);
  assert.deepEqual((listed.body.items as Array<{ messageId: string; via: string }>).map((item) => [item.messageId, item.via]), [[f.roomMessage.id, "notify"]]);
  assert.equal((await call(app.baseUrl, f.apiKey, "GET", "/assistant/told?since=nope")).body.code, "invalid_since");

  await getDb().update(assistantTold).set({ toldAt: new Date(Date.now() - 31 * 24 * 3_600_000) }).where(eq(assistantTold.agentId, f.assistant.id));
  assert.ok(await sweepAssistantTold() >= 1);
  assert.equal((await getDb().select().from(assistantTold).where(eq(assistantTold.agentId, f.assistant.id))).length, 0);
});

test("deleting the assistant deletes its rules, settings and told facts; an unlinked agent gets 403", async ({ app }) => {
  const f = await seed();
  await call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules", { effect: "mute", subject: "dms" });
  await call(app.baseUrl, f.apiKey, "PUT", "/assistant/contact-settings", { quiet: null });
  await call(app.baseUrl, f.apiKey, "POST", "/assistant/told", { messageIds: [f.roomMessage.id], via: "chat" });

  await getDb().update(agents).set({ assistantOwnerUserId: null }).where(eq(agents.id, f.assistant.id));
  assert.equal((await call(app.baseUrl, f.apiKey, "GET", "/assistant/contact-rules")).status, 403);
  await getDb().update(agents).set({ assistantOwnerUserId: f.owner.id }).where(eq(agents.id, f.assistant.id));

  await deleteAgent(f.assistant.id);
  assert.equal((await rulesOf(f.assistant.id)).length, 0);
  assert.equal((await getDb().select().from(assistantContactSettings).where(eq(assistantContactSettings.agentId, f.assistant.id))).length, 0);
  assert.equal((await getDb().select().from(assistantTold).where(eq(assistantTold.agentId, f.assistant.id))).length, 0);
});

test("import holds every rule to the add limits and the owner's visibility", async ({ app }) => {
  const f = await seed();
  const stranger = await seedUser(`contact-stranger-${f.suffix}@slock.test`, `contact-stranger-${f.suffix}`);
  const now = Date.now();
  const rules = [
    // Someone outside this server, by id: never named from their id.
    { id: "p1", effect: "mute", subject: { kind: "person", id: stranger.id, type: "human", name: "whoever" }, anytime: false, until: null, note: null },
    { id: "x".repeat(65), effect: "mute", subject: { kind: "dms" } },
    { id: "u1", effect: "mute", subject: { kind: "dms" }, until: new Date(now + 91 * 24 * 3_600_000).toISOString() },
    { id: "n1", effect: "mute", subject: { kind: "dms" }, note: "n".repeat(201) },
    { id: "l1", effect: "mute", subject: { kind: "legacy", channel: "c".repeat(201), sender: null, itemKind: null } },
    { id: "l2", effect: "mute", subject: { kind: "legacy", channel: f.room.name, sender: null, itemKind: "constructor" } },
    { id: "c1", effect: "mute", subject: { kind: "kind", value: "question" }, createdAt: "2000-01-01T00:00:00.000Z" },
  ];
  const res = await call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules/import", { rules, contact: { quiet: { from: "nope", to: "08:00" } }, statedTimezone: "Mars/Olympus" });
  // p1 kept as legacy by the caller's own name; l2 and c1 imported; 4 rules over limits plus bad quiet and zone skipped.
  assert.deepEqual(res.body, { imported: 3, updated: 0, skipped: 6, legacy: 2 });
  const listed = await call(app.baseUrl, f.apiKey, "GET", "/assistant/contact-rules");
  const lines = (listed.body.rules as Array<{ line: string; createdAt: string }>);
  assert.equal(JSON.stringify(listed.body).includes(stranger.name), false, "an unseen person's name never comes back");
  assert.ok(lines.some((rule) => rule.line.includes(`mute #${f.room.name} (an older rule`)), "an unknown itemKind renders as nothing");
  assert.equal(JSON.stringify(listed.body).includes("function"), false);
  assert.ok(lines.every((rule) => !rule.createdAt.startsWith("2000")), "the caller's createdAt is not taken");
});

test("a rule on something the owner can no longer see is still listed (unnamed) and removable; ambiguous prefixes are refused", async ({ app }) => {
  const f = await seed();
  const club = await createChannel(f.server.id, `club-${f.suffix}`, undefined, "private");
  await addHuman(club.id, f.owner.id);
  const added = await call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules", { effect: "digest", subject: `#${club.name}` });
  assert.equal(added.status, 200);
  await removeHuman(club.id, f.owner.id, { self: true });
  const listed = await call(app.baseUrl, f.apiKey, "GET", "/assistant/contact-rules");
  const rule = (listed.body.rules as Array<{ id: string; line: string; subject: { name: string | null } }>).find((r) => r.id === added.body.rule.id);
  assert.ok(rule, "still listed");
  assert.equal(rule!.subject.name, null);
  assert.equal(rule!.line, `${rule!.id.slice(0, 8)} · digest a channel you can no longer see (chat only; @mentions still come)`);
  assert.equal(JSON.stringify(listed.body).includes(club.name), false, "a channel the owner left is not named");
  assert.equal((await call(app.baseUrl, f.apiKey, "DELETE", `/assistant/contact-rules/${rule!.id}`)).status, 200);

  await getDb().insert(assistantContactRules).values(["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"].map((id, i) => ({
    id, agentId: f.assistant.id, serverId: f.server.id, effect: "mute" as const, subjectKind: "legacy" as const, subjectId: `amb-${i}`,
  })));
  const ambiguous = await call(app.baseUrl, f.apiKey, "DELETE", "/assistant/contact-rules/aaaaaaaa");
  assert.deepEqual([ambiguous.status, ambiguous.body.code], [409, "contact_rule_ambiguous"]);
  assert.equal((await call(app.baseUrl, f.apiKey, "POST", "/assistant/contact-rules", { effect: "mute", subject: "dms", note: "n".repeat(201) })).status, 400);
});

test("told pages by (time, id): a batch recorded at one instant is never cut in half", async ({ app }) => {
  const f = await seed();
  const more = [await createMessage(f.room.id, "user", f.peer.id, "two"), await createMessage(f.room.id, "user", f.peer.id, "three")];
  await call(app.baseUrl, f.apiKey, "POST", "/assistant/told", { messageIds: [f.roomMessage.id, ...more.map((m) => m.id)], via: "notify" });
  const since = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
  const first = await call(app.baseUrl, f.apiKey, "GET", `/assistant/told?since=${since}&limit=2`);
  assert.deepEqual([first.body.items.length, first.body.hasMore], [2, true]);
  const second = await call(app.baseUrl, f.apiKey, "GET", `/assistant/told?cursor=${encodeURIComponent(first.body.nextCursor)}&limit=2`);
  assert.deepEqual([second.body.items.length, second.body.hasMore, second.body.nextCursor], [1, false, null]);
  const seen = [...first.body.items, ...second.body.items].map((item: { messageId: string }) => item.messageId).sort();
  assert.deepEqual(seen, [f.roomMessage.id, ...more.map((m) => m.id)].sort());
  assert.equal((await call(app.baseUrl, f.apiKey, "GET", "/assistant/told?cursor=garbage")).body.code, "invalid_cursor");
});

test("contact settings change only what is given: quiet, the stated zone, or both", async ({ app }) => {
  const f = await seed();
  const put = (body: unknown) => call(app.baseUrl, f.apiKey, "PUT", "/assistant/contact-settings", body);
  assert.equal((await put({})).body.code, "invalid_settings");
  assert.equal((await put({ statedTimezone: "Mars/Olympus" })).body.code, "invalid_timezone");
  const zone = await put({ statedTimezone: "Asia/Shanghai" });
  assert.deepEqual([zone.status, zone.body.settings], [200, { quiet: { from: "22:00", to: "08:00" }, statedTimezone: "Asia/Shanghai" }]);
  assert.equal(zone.body.confirmation, "I'll use Asia/Shanghai for your morning brief and quiet hours.");
  const quiet = await put({ quiet: { from: "23:00", to: "07:00" } });
  assert.deepEqual(quiet.body.settings, { quiet: { from: "23:00", to: "07:00" }, statedTimezone: "Asia/Shanghai" }, "the zone is left as it was");
  const forget = await put({ statedTimezone: null });
  assert.deepEqual(forget.body.settings, { quiet: { from: "23:00", to: "07:00" }, statedTimezone: null }, "quiet hours are left as they were");
});

test("told accepts #channel:msgid refs (short or full id), only what the owner can see, with the conversation and seq", async ({ app }) => {
  const f = await seed();
  const short = `#${f.room.name}:${f.roomMessage.id.slice(0, 8)}`;
  const res = await call(app.baseUrl, f.apiKey, "POST", "/assistant/told", {
    refs: [short, `#${f.secret.name}:${f.secretMessage.id.slice(0, 8)}`, `#${f.room.name}:deadbeef`, "not a ref"],
    via: "chat",
  });
  assert.deepEqual(res.body, { recorded: 1, skipped: 3 });
  const [row] = await getDb().select().from(assistantTold).where(eq(assistantTold.agentId, f.assistant.id));
  assert.deepEqual([row?.messageId, row?.channelId, row?.seq], [f.roomMessage.id, f.room.id, Number(f.roomMessage.seq)]);
  assert.equal((await call(app.baseUrl, f.apiKey, "POST", "/assistant/told", { via: "chat" })).status, 400, "messageIds or refs");
});
