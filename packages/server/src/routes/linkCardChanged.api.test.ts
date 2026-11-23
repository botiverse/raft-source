import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import { BasicTracer, LINK_CARD_CHANGED_HINTS_FEATURE_FLAG_KEY, MemoryTraceSink } from "@botiverse/raft-shared";
import { LINK_CARD_CHANGED_EVENT } from "@botiverse/raft-shared/src/appLinkPreview";
import { createApiTest } from "../test/integration/apiTest";
import type { Database } from "../db";
import { featureFlagRules, featureFlags, oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthUserConsents } from "../db/schema";
import { __settleAppLinkPreviewRechecksForTests, __setPreviewHttpForTests } from "../services/appLinkPreviewService";
import { addHuman } from "../services/channelService";
import { addMember, removeMember } from "../services/serverService";
import { createOAuthClient } from "../services/oauthService";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import {
  __resetLinkCardChangedLimitsForTests, admitLinkCardChangedObjects, grantLinkCardChangedNudges, LINK_CARD_CHANGED_DROPPED_EVENT, LINK_CARD_CHANGED_MAX_BODY_BYTES,
  LINK_CARD_CHANGED_NUDGES_PER_MINUTE, LINK_CARD_CHANGED_OBJECTS_PER_MINUTE, linkCardReadersStillMembers, sendLinkCardChangedNudges,
} from "../services/linkCardChangedHints";
import { __setLinkCardReaderStoreForTests, __settleLinkCardReadersForTests, memoryLinkCardReaderStore, type LinkCardReaderStore } from "../services/linkCardReaders";
import { tokenForHuman } from "../test/integration/credentials";
import { appAuth, cardFixture, recordEmits, stubApp, type CardFixture, type RecordedEmit } from "../test/linkCardActionFixture";

// Link cards that update themselves (docs/development/app-link-previews.md,
// "Telling Raft a card changed"): a read records its viewer as a recent reader
// of each card whose App named its object (`object_ref`), and
// POST /api/oauth/link-preview/changed nudges those readers, still members of
// the Server they read on, with `link_card.changed { app, object_key_sha256 }`
// in their own user+Server room. Real HTTP, isolated PGlite; the reader store
// is this process's memory (no Redis in the default suite), or a test's.
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  __setLinkCardReaderStoreForTests(null);
});
afterEach(async () => {
  await __settleLinkCardReadersForTests();
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  __setLinkCardReaderStoreForTests(null);
  __resetLinkCardReadBudgetForTests();
  __resetLinkCardChangedLimitsForTests();
  vi.restoreAllMocks();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const REF = "pr:botiverse/slock#15813";
const CAPABILITIES = ["card.v2", "button.v1", "preview.v3", "card.changed.v1"];
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const keyOf = (appId: string, ref: string) => sha256(JSON.stringify([appId, ref]));
const room = (viewerId: string, serverId: string) => `user:${viewerId}:server:${serverId}`;
const nudges = (emits: RecordedEmit[]) => emits.filter((emit) => emit.event === LINK_CARD_CHANGED_EVENT).map((emit) => [emit.room, emit.payload]);

const cardItem = (extra: Record<string, unknown> = {}) => ({
  type: "card", placement: "block", title: "PR #15813", card_revision: "cr-1", business_revision: "br-1",
  card: { root: "root", elements: { root: { type: "Text", props: { text: "Waiting to merge" } } } }, ...extra,
});
/** The App answers version 3 with `object_ref` on its card (or `ref` itself, raw), version 1 likewise at the top. */
function answerWith(ref: unknown) {
  const label = ref === undefined ? {} : { object_ref: ref };
  return stubApp((call) => call.body.version === 1 ? { version: 1, title: "PR #15813", ...label } : JSON.stringify({ version: 3, items: [cardItem(label)] }));
}

async function enableFlag(db: Database, serverId: string) {
  await db.insert(featureFlags).values({ key: LINK_CARD_CHANGED_HINTS_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
  await db.insert(featureFlagRules).values({ id: randomUUID(), flagKey: LINK_CARD_CHANGED_HINTS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [serverId] });
}
async function disableFlag(db: Database) {
  await db.delete(featureFlagRules).where(eq(featureFlagRules.flagKey, LINK_CARD_CHANGED_HINTS_FEATURE_FLAG_KEY));
}

type Viewer = { id: string; headers: Record<string, string> };
const ownerOf = (fx: CardFixture): Viewer => ({ id: fx.owner.id, headers: fx.headers });
async function read(baseUrl: string, fx: CardFixture, viewer: Viewer, capabilities = CAPABILITIES) {
  const response = await fetch(`${baseUrl}/api/messages/${fx.message.id}/link-cards/read`, {
    method: "POST", headers: viewer.headers, body: JSON.stringify({ view_instance_id: randomUUID(), capabilities, locale: "en" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { items: Record<string, unknown>[] }).items;
}
/** A second member of the fixture's Server who consented to its App and can read the message. */
async function member(db: Database, seed: Parameters<typeof cardFixture>[1], fx: CardFixture): Promise<Viewer> {
  const person = await seed.human();
  await addMember(fx.server.id, person.id);
  await addHuman(fx.channel.id, person.id);
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: person.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  return { id: person.id, headers: { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(person.email)}` } };
}
async function changed(baseUrl: string, auth: { clientId: string; secret: string } | null, body: unknown, headers: Record<string, string> = {}) {
  const basic: Record<string, string> = auth ? { Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.secret}`).toString("base64")}` } : {};
  const response = await fetch(`${baseUrl}/api/oauth/link-preview/changed`, {
    method: "POST", headers: { "Content-Type": "application/json", ...basic, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  await __settleLinkCardReadersForTests();
  return { status: response.status, body: json, headers: response.headers };
}
/** A store that records what reaches it and keeps it in memory. */
function spyStore() {
  const inner = memoryLinkCardReaderStore();
  const records: { objectKeys: string[]; member: string }[] = [];
  const store: LinkCardReaderStore = { ...inner, record: async (objectKeys, member, nowMs) => { records.push({ objectKeys: [...objectKeys], member }); await inner.record(objectKeys, member, nowMs); } };
  return { store, records };
}

test("a read records its viewer for a card with object_ref, the client that declared card.changed.v1 gets the key, and changed nudges that viewer's own room with it", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  await enableFlag(db, fx.server.id);
  const spy = spyStore();
  __setLinkCardReaderStoreForTests(spy.store);
  const emits = recordEmits(app.io);
  const calls = answerWith(REF);
  const objectKey = keyOf(fx.client.id, REF);

  const [item] = await read(app.baseUrl, fx, ownerOf(fx));
  assert.equal(item?.kind, "v3");
  assert.equal(item?.object_key_sha256, objectKey, "the digest of (App id, object_ref)");
  assert.ok(!JSON.stringify(item).includes(REF), "the label itself never reaches the client");
  assert.ok((calls[0]?.body.client_capabilities as string[]).includes("card.changed.v1"));
  await __settleLinkCardReadersForTests();
  assert.deepEqual(spy.records, [{ objectKeys: [objectKey], member: `${fx.owner.id}:${fx.server.id}` }]);

  // A client that didn't declare it reads each item strictly: no field, but its viewer is still recorded.
  const [plain] = await read(app.baseUrl, fx, ownerOf(fx), ["card.v2", "button.v1", "preview.v3"]);
  assert.equal(plain?.kind, "v3");
  assert.ok(!("object_key_sha256" in plain!));
  await __settleLinkCardReadersForTests();
  assert.equal(spy.records.length, 2);

  // The version 1 GET: object_ref taken out before the strict schema, the key in `objectKeys`.
  const got = await (await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/app-link-previews`, { headers: fx.headers })).json() as Record<string, unknown>;
  assert.deepEqual(got.previews, [{ version: 1, title: "PR #15813", url: fx.url, appName: fx.client.clientId.replace("cards-", "Cards ") }]);
  assert.deepEqual(got.objectKeys, { [fx.url]: objectKey });
  await __settleLinkCardReadersForTests();
  assert.equal(spy.records.length, 3);

  const res = await changed(app.baseUrl, appAuth(fx), { objects: [REF, "pr:botiverse/slock#1", REF] });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(res.body, { accepted: 2 }, "repeats are one object; never a reader count");
  assert.deepEqual(nudges(emits), [[room(fx.owner.id, fx.server.id), { app: fx.client.id, object_key_sha256: objectKey }]], "one nudge, no content, to the reader's own room");
});

test("an invalid object_ref only loses the label: the card shows, without a key, and no reader is recorded", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  await enableFlag(db, fx.server.id);
  const spy = spyStore();
  __setLinkCardReaderStoreForTests(spy.store);
  for (const invalid of ["", "x".repeat(201), "café", "tab\there", 7, null]) {
    answerWith(invalid);
    const [item] = await read(app.baseUrl, fx, ownerOf(fx));
    assert.equal(item?.kind, "v3", JSON.stringify(invalid));
    assert.equal((item?.preview as { items: unknown[] }).items.length, 1);
    assert.ok(!("object_key_sha256" in item!), JSON.stringify(invalid));
  }
  answerWith(undefined);
  assert.ok(!("object_key_sha256" in (await read(app.baseUrl, fx, ownerOf(fx)))[0]!), "a card without object_ref behaves as before");
  await __settleLinkCardReadersForTests();
  assert.deepEqual(spy.records, []);
});

test("a failing or hanging reader store never fails or holds the read; the failure is logged without the object or the link", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  await enableFlag(db, fx.server.id);
  answerWith(REF);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failing = { ...memoryLinkCardReaderStore(), record: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:6379"); } };
  __setLinkCardReaderStoreForTests(failing);
  const [item] = await read(app.baseUrl, fx, ownerOf(fx));
  assert.equal(item?.object_key_sha256, keyOf(fx.client.id, REF), "the read answers as usual");
  await __settleLinkCardReadersForTests();
  const logged = JSON.stringify(warn.mock.calls);
  assert.match(logged, /reader record failed/);
  assert.match(logged, /ECONNREFUSED/, "the error, through serializeErrorForLog");
  for (const secret of [fx.url, REF, keyOf(fx.client.id, REF)]) assert.ok(!logged.includes(secret), "never the link, the label or the key");

  // A store that never answers: the read doesn't wait for it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  __setLinkCardReaderStoreForTests({ ...memoryLinkCardReaderStore(), record: () => held });
  const [again] = await read(app.baseUrl, fx, ownerOf(fx));
  assert.equal(again?.kind, "v3", "answered while the record is still pending");
  release();
});

test("the endpoint: Basic client credentials (401 otherwise), a strict body of 1-50 object_refs (400 naming the field), 413 past 16 KiB", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  for (const auth of [null, { clientId: fx.client.clientId, secret: "wrong" }, { clientId: "nobody", secret: fx.clientSecret }]) {
    const res = await changed(app.baseUrl, auth, { objects: [REF] });
    assert.equal(res.status, 401, JSON.stringify(auth));
    assert.equal(res.body.code, "INVALID_CLIENT");
  }
  await db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, fx.client.id));
  assert.equal((await changed(app.baseUrl, appAuth(fx), { objects: [REF] })).status, 401, "disabled credentials");
  await db.update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, fx.client.id));

  const bad: [unknown, RegExp][] = [
    ["not json", /strict JSON/],
    ['{"objects":["a"],"objects":["b"]}', /strict JSON/],
    [[REF], /strict JSON/],
    [{}, /objects must be an array/],
    [{ objects: [] }, /objects must be an array of 1 to 50/],
    [{ objects: Array.from({ length: 51 }, (_, i) => `pr:${i}`) }, /objects must be an array of 1 to 50/],
    [{ objects: REF }, /objects must be an array/],
    [{ objects: [REF, 7] }, /objects\[1\] must be an object_ref/],
    [{ objects: ["x".repeat(201)] }, /objects\[0\] must be an object_ref/],
    [{ objects: ["café"] }, /objects\[0\] must be an object_ref/],
    [{ objects: [""] }, /objects\[0\] must be an object_ref/],
    [{ objects: [REF], urls: [fx.url] }, /Only the field objects/],
  ];
  for (const [body, error] of bad) {
    const res = await changed(app.baseUrl, appAuth(fx), body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_REQUEST");
    assert.match(String(res.body.error), error, JSON.stringify(body));
    assert.ok(!String(res.body.error).includes("caf"), "never echoes the body");
  }
  const huge = await changed(app.baseUrl, appAuth(fx), { objects: ["x".repeat(LINK_CARD_CHANGED_MAX_BODY_BYTES)] });
  assert.equal(huge.status, 413);
  const fifty = await changed(app.baseUrl, appAuth(fx), { objects: Array.from({ length: 50 }, (_, i) => `pr:o/r#${i}`) });
  assert.deepEqual([fifty.status, fifty.body], [202, { accepted: 50 }]);
});

test("600 objects per App per minute: past it 429 RATE_LIMITED with Retry-After and retry_after; another App has its own budget", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  for (let call = 0; call < LINK_CARD_CHANGED_OBJECTS_PER_MINUTE / 50; call++) {
    const res = await changed(app.baseUrl, appAuth(fx), { objects: Array.from({ length: 50 }, (_, i) => `pr:${call}-${i}`) });
    assert.equal(res.status, 202, `call ${call}`);
  }
  const over = await changed(app.baseUrl, appAuth(fx), { objects: [REF] });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "RATE_LIMITED");
  const retryAfter = Number(over.headers.get("retry-after"));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, String(retryAfter));
  assert.equal(over.body.retry_after, retryAfter);

  const other = await cardFixture(db, seed);
  assert.equal((await changed(app.baseUrl, appAuth(other), { objects: [REF] })).status, 202);
  assert.ok(!(await admitLinkCardChangedObjects(fx.client.id, 1)).admitted, "the first App's window is still spent");
});

test("a reader removed from the Server gets nothing; one still a member does", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  await enableFlag(db, fx.server.id);
  answerWith(REF);
  const staying = await member(db, seed, fx);
  const leaving = await member(db, seed, fx);
  for (const viewer of [staying, leaving]) assert.equal((await read(app.baseUrl, fx, viewer))[0]?.object_key_sha256, keyOf(fx.client.id, REF));
  await __settleLinkCardReadersForTests();
  await removeMember(fx.server.id, leaving.id);
  const emits = recordEmits(app.io);
  assert.equal((await changed(app.baseUrl, appAuth(fx), { objects: [REF] })).status, 202);
  assert.deepEqual(nudges(emits), [[room(staying.id, fx.server.id), { app: fx.client.id, object_key_sha256: keyOf(fx.client.id, REF) }]]);
});

test("an App can't nudge another App's object: the same object_ref from another App is another key and reaches no one", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  await enableFlag(db, fx.server.id);
  answerWith(REF);
  await read(app.baseUrl, fx, ownerOf(fx));
  await __settleLinkCardReadersForTests();
  // Another App, eligible and installed on the same Server, with its own registration.
  const origin = `https://other-${randomUUID().slice(0, 8)}.example.test`;
  const { client, clientSecret } = await createOAuthClient({ serverId: fx.server.id, createdByUserId: fx.owner.id, clientId: `other-${randomUUID().slice(0, 8)}`, name: "Other", appType: "third_party_global" });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: fx.server.id, installedByUserId: fx.owner.id });
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, origin, endpoint: `${origin}/callback`, paths: ["/pr"] });
  const emits = recordEmits(app.io);
  const res = await changed(app.baseUrl, { clientId: client.clientId, secret: clientSecret }, { objects: [REF] });
  assert.deepEqual([res.status, res.body], [202, { accepted: 1 }], "the same answer: it learns nothing");
  assert.deepEqual(nudges(emits), []);
  assert.notEqual(keyOf(client.id, REF), keyOf(fx.client.id, REF));
  // The owning App still reaches its reader.
  await changed(app.baseUrl, appAuth(fx), { objects: [REF] });
  assert.equal(nudges(emits).length, 1);
});

test("the flag: off at the read records no one; off at the send (or the App suspended or unproven) sends nothing, and the App gets 202 all the same", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const spy = spyStore();
  __setLinkCardReaderStoreForTests(spy.store);
  const emits = recordEmits(app.io);
  // Each step names its own object: a repeat within 5 seconds would only mark the first one's window.
  const readRef = async (ref: string) => { answerWith(ref); const [item] = await read(app.baseUrl, fx, ownerOf(fx)); await __settleLinkCardReadersForTests(); return item; };
  const nudged = (ref: string) => [room(fx.owner.id, fx.server.id), { app: fx.client.id, object_key_sha256: keyOf(fx.client.id, ref) }];

  // Off at the read: the key is still on the item (inert), but no one is recorded, so changed reaches no one.
  assert.equal((await readRef("pr:1"))?.object_key_sha256, keyOf(fx.client.id, "pr:1"));
  assert.deepEqual(spy.records, []);
  assert.deepEqual([(await changed(app.baseUrl, appAuth(fx), { objects: ["pr:1"] })).status, nudges(emits)], [202, []]);

  // On at the read, off again at the send.
  await enableFlag(db, fx.server.id);
  await readRef("pr:2");
  assert.equal(spy.records.length, 1);
  await disableFlag(db);
  const off = await changed(app.baseUrl, appAuth(fx), { objects: ["pr:2", "pr:unread"] });
  assert.deepEqual([off.status, off.body, nudges(emits)], [202, { accepted: 2 }, []]);

  // On, but the App's registration suspended: accepted, nothing sent; resumed, the same change goes out.
  await enableFlag(db, fx.server.id);
  await readRef("pr:3");
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: new Date(), suspendedReason: "proof_mismatch" }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const suspended = await changed(app.baseUrl, appAuth(fx), { objects: ["pr:3"] });
  assert.deepEqual([suspended.status, suspended.body, nudges(emits)], [202, { accepted: 1 }, []]);
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: null, suspendedReason: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await changed(app.baseUrl, appAuth(fx), { objects: ["pr:3"] });
  assert.deepEqual(nudges(emits), [nudged("pr:3")], "the control: the same reader, flag on, App eligible");

  // Proven longer ago than the hard TTL: the same.
  await readRef("pr:4");
  const verifiedAt = new Date();
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date(Date.now() - 73 * 3600_000) }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.equal((await changed(app.baseUrl, appAuth(fx), { objects: ["pr:4"] })).status, 202);
  assert.deepEqual(nudges(emits), [nudged("pr:3")]);
  await db.update(oauthAppLinkPreviews).set({ verifiedAt }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await changed(app.baseUrl, appAuth(fx), { objects: ["pr:4"] });
  assert.deepEqual(nudges(emits), [nudged("pr:3"), nudged("pr:4")]);
});

test("20,000 nudges per App per minute: the ones past it are dropped and counted", async ({ app, db, seed }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const fx = await cardFixture(db, seed);
  await enableFlag(db, fx.server.id);
  answerWith(REF);
  const second = await member(db, seed, fx);
  for (const viewer of [ownerOf(fx), second]) await read(app.baseUrl, fx, viewer);
  await __settleLinkCardReadersForTests();
  assert.equal(await grantLinkCardChangedNudges(fx.client.id, LINK_CARD_CHANGED_NUDGES_PER_MINUTE - 1), LINK_CARD_CHANGED_NUDGES_PER_MINUTE - 1);
  const emits = recordEmits(app.io);
  assert.equal((await changed(app.baseUrl, appAuth(fx), { objects: [REF] })).status, 202);
  assert.equal(nudges(emits).length, 1, "one nudge left in the minute");
  const dropped = sink.getAllLogEvents().filter((event) => event.name === LINK_CARD_CHANGED_DROPPED_EVENT).map(({ attrs }) => [attrs?.app_key, attrs?.count]);
  assert.deepEqual(dropped, [[fx.client.clientId, 1]]);
  assert.equal(await grantLinkCardChangedNudges(fx.client.id, 5), 0, "the rest of the minute sends nothing");
});

test("the cap bounds the membership lookup too: with N nudges left only the first N readers are looked up, the rest dropped; a removed one among them still gets nothing", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  await enableFlag(db, fx.server.id);
  answerWith(REF);
  const leaving = await member(db, seed, fx);
  const second = await member(db, seed, fx);
  const cut = await member(db, seed, fx);
  // Read order is the store's order: the cut one read last.
  for (const viewer of [ownerOf(fx), leaving, second, cut]) await read(app.baseUrl, fx, viewer);
  await __settleLinkCardReadersForTests();
  await removeMember(fx.server.id, leaving.id);
  assert.equal(await grantLinkCardChangedNudges(fx.client.id, LINK_CARD_CHANGED_NUDGES_PER_MINUTE - 3), LINK_CARD_CHANGED_NUDGES_PER_MINUTE - 3);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const lookedUp: string[] = [];
  const sent: [string, unknown][] = [];
  const key = keyOf(fx.client.id, REF) as Parameters<typeof sendLinkCardChangedNudges>[1][number];
  await sendLinkCardChangedNudges(
    { id: fx.client.id, key: fx.client.clientId, hints: (reader, event) => { sent.push([reader.viewerId, event]); } }, [key], false,
    async (readers) => { lookedUp.push(...readers.map((reader) => reader.viewerId)); return linkCardReadersStillMembers(readers); },
  );
  assert.deepEqual(lookedUp, [fx.owner.id, leaving.id, second.id], "only the three the budget allows reach the membership query");
  assert.deepEqual(sent, [fx.owner.id, second.id].map((id) => [id, { app: fx.client.id, object_key_sha256: key }]), "the removed member spent a unit and got nothing");
  assert.match(JSON.stringify(warn.mock.calls), /"dropped":1/);
  assert.deepEqual([...await linkCardReadersStillMembers([{ viewerId: cut.id, serverId: fx.server.id }])], [`${cut.id}:${fx.server.id}`], "the control: the cut one is a member, dropped only by the cap");
});
