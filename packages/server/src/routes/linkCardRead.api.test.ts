import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import type { createSeed } from "../test/integration/seed";
import { tokenForHuman } from "../test/integration/credentials";
import type { Database } from "../db";
import { channels, messages, oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthUserConsents, officialAppRegistry, servers } from "../db/schema";
import { createOAuthClient } from "../services/oauthService";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { addMember } from "../services/serverService";
import { createMessage } from "../services/messageService";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests, MAX_IN_FLIGHT_CALLBACKS_PER_USER } from "../services/appLinkPreviewService";
import type { PreviewHttpOptions } from "../services/appLinkPreviewHttp";
import { __resetLinkCardReadBudgetForTests, LINK_CARD_BADGE_COLOR_STRIPPED_EVENT, LINK_CARD_READ_MAX_BODY_BYTES, linkCardActionTier } from "../services/linkCardReadService";
import { signLinkCardReadTicket, verifyLinkCardHandle, verifyLinkCardReadTicket, type LinkCardReadTicketClaims } from "../services/linkCardTokens";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import { oidcIssuer } from "../services/oidcService";

// The batched interactive link-card read (RFC 076 §6.1; protocol v3.2.3 §4 and
// addenda 1, 2, 4): one request per message, at most ten links, one App call
// per distinct link, version 1 or 2 by the client's capabilities, strict
// v2 parsing, display stripping, stateless tickets and handles, a per-link
// budget, and no writes. The App is the substituted preview transport.
const test = createApiTest();
const limitedTest = createApiTest({ enforceMessageRateLimit: true, messageRateLimitMax: 1 });
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(async () => {
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  __resetLinkCardReadBudgetForTests();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

type Seed = ReturnType<typeof createSeed>;
const ALL = ["card.v2", "button.v1", "confirm.v1", "undo.v1"];
const v1Card = { version: 1, title: "Private PR", card: { root: "status", elements: { status: { type: "Badge", props: { text: "Approved" } } } } };
const approve = { type: "Button", props: { label: "Approve", action: { kind: "execute", action_id: "approve", undoWindowMs: 5000 } } };
const merge = { type: "Button", props: { label: "Merge", action: { kind: "execute", action_id: "merge", confirm: "prepare" } } };
const refresh = { type: "Button", props: { label: "Refresh", action: { kind: "read" } } };
const openButton = (origin: string) => ({ type: "Button", props: { label: "Open", variant: "ghost", action: { kind: "navigate", url: `${origin}/pr/1` } } });
const v2Answer = (elements: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  version: 2, display: "card", title: "PR #1 is ready", card_revision: "cr-1", business_revision: "br-1",
  card: { root: "root", elements: { root: { type: "Stack", props: {}, children: Object.keys(elements) }, ...elements } }, ...extra,
});
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Call = { url: string; body: Record<string, unknown>; claims: Record<string, unknown>; options: PreviewHttpOptions | undefined };
/** Substitutes the App: records each callback (proof fetches go to `proofs`) and answers with `answer`. */
function stubApp(answer: (call: Call) => unknown | Promise<unknown>, proofs: string[] = []) {
  const calls: Call[] = [];
  __setPreviewHttpForTests(async (url, body, assertion, options) => {
    if (body === undefined) { proofs.push(url); return { client_id: "someone-else" }; }
    const call = { url, body: JSON.parse(body) as Record<string, unknown>, claims: claimsOf(assertion!), options };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

/** A viewer, a message with `content`, and a consented, installed App registered for `origin` paths /pr. */
async function connected(db: Database, seed: Seed, options: { key: string; origin: string; content: string; actionEndpoint?: boolean; logo?: string; verifiedAt?: Date; previewVersions?: (1 | 2 | 3)[] }) {
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: options.content });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: options.key, name: `${options.key} App` });
  if (options.logo) await db.update(oauthClients).set({ logoUrl: options.logo }).where(eq(oauthClients.id, client.id));
  const [install] = await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).returning();
  await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ["openid", "profile"] });
  const [registration] = await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, origin: options.origin, endpoint: `${options.origin}/callback`, paths: ["/pr"], previewVersions: options.previewVersions ?? [1, 2, 3],
    actionEndpoint: options.actionEndpoint ? `${options.origin}/card-actions` : null, ...(options.verifiedAt ? { verifiedAt: options.verifiedAt, lastCheckedAt: options.verifiedAt } : {}) }).returning();
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  return { owner, server, channel, message, client, install: install!, registration: registration!, headers };
}
type Fixture = Awaited<ReturnType<typeof connected>>;

async function makeOfficial(db: Database, fx: Fixture) {
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = fx.server.id;
  await db.insert(officialAppRegistry).values({ oauthClientId: fx.client.id, clientKey: fx.client.clientId, publisherServerId: fx.server.id, purpose: "Link cards", status: "approved" });
}

type ReadBody = { view_instance_id?: string; capabilities?: unknown; locale?: string; urls?: string[]; tickets?: Record<string, string> } & Record<string, unknown>;
type Item = { url: string; kind: string; app?: { id: string; name: string; icon: string | null; reviewed?: false }; preview?: Record<string, unknown>; ticket?: string | null; actions?: { action_id: string; handle: string }[]; retry_after?: number };
const VIEW = randomUUID();
const readBody = (overrides: ReadBody = {}): ReadBody => ({ view_instance_id: VIEW, capabilities: ALL, locale: "zh-CN", ...overrides });

function post(baseUrl: string, fx: { headers: Record<string, string>; message: { id: string } }, body: unknown = readBody(), messageId = fx.message.id) {
  return fetch(`${baseUrl}/api/messages/${messageId}/link-cards/read`, { method: "POST", headers: fx.headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function read(baseUrl: string, fx: Parameters<typeof post>[1], body: unknown = readBody()) {
  const response = await post(baseUrl, fx, body);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return await response.json() as { items: Item[]; prompts: { url: string; app: { id: string; name: string; icon: string | null } }[] };
}
const elementIds = (item: Item | undefined) => Object.keys((item?.preview?.card as { elements: object } | undefined)?.elements ?? {}).sort();

test("a client without card.v2: the version 1 callback exactly as the GET sends it, version 1 items, nothing signed", async ({ app, db, seed }) => {
  const origin = "https://v1.example.test";
  const fx = await connected(db, seed, { key: "cards-v1", origin, content: `${origin}/pr/1 and ${origin}/pr/2`, logo: "https://cdn.example.test/v1.webp" });
  const calls = stubApp(() => v1Card);
  const { items, prompts } = await read(app.baseUrl, fx, readBody({ capabilities: [] }));
  assert.deepEqual(prompts, []);
  const appView = { id: fx.client.id, name: "cards-v1 App", icon: "https://cdn.example.test/v1.webp" };
  assert.deepEqual(items, [
    { url: `${origin}/pr/1`, kind: "v1", app: appView, preview: v1Card },
    { url: `${origin}/pr/2`, kind: "v1", app: appView, preview: v1Card },
  ], "no ticket, no handles");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.body).sort(), ["request_id", "url", "version"]);
    assert.equal(call.body.version, 1);
    assert.deepEqual(call.options, { response: "preview" }, "v1 answers get the C0-key check before JSON.parse, and no Accept-Language");
    assert.equal(call.claims.iss, oidcIssuer(undefined, fx.server.slug), "v1 keeps the slug issuer");
    assert.equal(call.claims.jti, call.body.request_id);
  }
  // Exactly what the GET sends for the same link.
  const getCalls = stubApp(() => v1Card);
  await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/app-link-previews`, { headers: fx.headers });
  assert.deepEqual(getCalls.map((call) => [Object.keys(call.body).sort(), call.body.version, call.claims.iss, call.options]), calls.map((call) => [Object.keys(call.body).sort(), 1, call.claims.iss, call.options]));
});

test("the version 2 callback carries capabilities and locale, Accept-Language and an issuer by Server id; without card.v2 the client stays on version 1", async ({ app, db, seed }) => {
  const origin = "https://v2.example.test";
  const fx = await connected(db, seed, { key: "cards-v2", origin, content: `see ${origin}/pr/1` });
  const calls = stubApp((call) => call.body.version === 2 ? JSON.stringify(v2Answer({ open: openButton(origin) })) : v1Card);
  const { items } = await read(app.baseUrl, fx, readBody({ capabilities: ["undo.v1", "card.v2", "relative_time.v1", "x.future", "button.v1", "card.v2"] }));
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.deepEqual(Object.keys(call!.body).sort(), ["client_capabilities", "locale", "request_id", "url", "version"]);
  assert.deepEqual(call!.body, { version: 2, url: `${origin}/pr/1`, request_id: call!.body.request_id, client_capabilities: ["button.v1", "card.v2", "undo.v1"], locale: "zh-CN" },
    "only known capabilities, deduplicated; relative_time.v1 and unknown values are ignored");
  assert.deepEqual(call!.options, { acceptLanguage: "zh-CN", response: "text" });
  assert.equal(call!.claims.iss, oidcIssuer(undefined, fx.server.id), "v2 names the Server by id (addendum 1 §5)");
  assert.notEqual(call!.claims.iss, oidcIssuer(undefined, fx.server.slug));
  assert.equal(call!.claims.server_role, "owner");
  assert.equal(call!.claims.token_use, "link_preview");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "v2");
  assert.deepEqual(items[0]!.preview, { ...v2Answer({ open: { ...openButton(origin) } }), card: { root: "root", elements: {
    root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["open"] }, open: openButton(origin) } } }, "schema defaults filled in");
  assert.equal(items[0]!.ticket, null); assert.deepEqual(items[0]!.actions, []);

  const legacy = await read(app.baseUrl, fx, readBody({ capabilities: ["button.v1"] }));
  assert.equal(calls.at(-1)!.body.version, 1, "no card.v2: version 1");
  assert.deepEqual(legacy.items.map((item) => item.kind), ["v1"]);
});

// A version 2 request goes only to an App that declared 2 (#proj-apps:#47): a
// version 1 App answers version 1, and verifies the slug issuer the public docs
// give it, whatever the reader.
test("a card.v2 client: an App that declared only 1 gets the version 1 callback, slug issuer, nothing signed; one read serves Apps on either side; a declaration applies from the next read, either way", async ({ app, db, seed }) => {
  const origin = "https://undeclared.example.test";
  const declaredOrigin = "https://declared.example.test";
  const fx = await connected(db, seed, { key: "cards-undeclared", origin, content: `${origin}/pr/1 ${declaredOrigin}/pr/2`, previewVersions: [1] });
  const other = await createOAuthClient({ serverId: fx.server.id, createdByUserId: fx.owner.id, clientId: "cards-declared", name: "Declared" });
  await db.insert(oauthClientInstalls).values({ clientId: other.client.id, serverId: fx.server.id, installedByUserId: fx.owner.id });
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: fx.owner.id, clientId: other.client.id, scopes: ["openid", "profile"] });
  await db.insert(oauthAppLinkPreviews).values({ clientId: other.client.id, origin: declaredOrigin, endpoint: `${declaredOrigin}/callback`, paths: ["/pr"], previewVersions: [1, 2] });
  const calls = stubApp((call) => call.body.version === 2 ? JSON.stringify(v2Answer({ open: openButton(new URL(call.url).origin) })) : v1Card);
  const callTo = (target: string) => calls.filter((call) => call.url === `${target}/callback`).at(-1)!;
  const kinds = (items: { url: string; kind: string }[]) => items.map((item) => [item.url, item.kind]);

  const { items } = await read(app.baseUrl, fx);
  assert.deepEqual(kinds(items), [[`${origin}/pr/1`, "v1"], [`${declaredOrigin}/pr/2`, "v2"]]);
  assert.deepEqual(callTo(origin).body, { version: 1, url: `${origin}/pr/1`, request_id: callTo(origin).body.request_id }, "no capabilities, no locale");
  assert.equal(callTo(origin).claims.iss, oidcIssuer(undefined, fx.server.slug), "the issuer the public docs give a version 1 App");
  assert.equal(callTo(declaredOrigin).claims.iss, oidcIssuer(undefined, fx.server.id));
  assert.equal("ticket" in items[0]!, false, "nothing signed for version 1");

  const registration = (versions: (1 | 2 | 3)[]) => db.update(oauthAppLinkPreviews).set({ previewVersions: versions }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await registration([1, 2, 3]);
  assert.deepEqual(kinds((await read(app.baseUrl, fx)).items), [[`${origin}/pr/1`, "v2"], [`${declaredOrigin}/pr/2`, "v2"]]);
  assert.equal(callTo(origin).body.version, 2);
  await registration([1]);
  assert.deepEqual(kinds((await read(app.baseUrl, fx)).items), [[`${origin}/pr/1`, "v1"], [`${declaredOrigin}/pr/2`, "v2"]], "going back applies at the next read");
  assert.equal(callTo(origin).body.version, 1);
});

test("one read covers ten distinct links in message order, one App call each; the eleventh is never requested; `urls` narrows it", async ({ app, db, seed }) => {
  const origin = "https://batch.example.test";
  const links = Array.from({ length: 12 }, (_, i) => `${origin}/pr/${i + 1}`);
  const content = [links[0], `${origin}:443/pr/1`, links[0], ...links.slice(1)].join(" ");
  const fx = await connected(db, seed, { key: "cards-batch", origin, content });
  const calls = stubApp(() => v1Card);
  const v1 = (overrides: ReadBody = {}) => readBody({ capabilities: [], ...overrides });
  const { items } = await read(app.baseUrl, fx, v1());
  assert.deepEqual(calls.map((call) => call.body.url), links.slice(0, 10), "duplicates (an explicit :443 too) are one link; links 11 and 12 are not requested");
  assert.deepEqual(items.map((item) => item.url), links.slice(0, 10));
  const narrowed = await read(app.baseUrl, fx, v1({ urls: [links[2]!, links[10]!, "https://elsewhere.example.test/pr/1", "not a url"] }));
  assert.deepEqual(narrowed.items.map((item) => item.url), [links[2]], "a subset of the message's first ten links; anything else is ignored");
  assert.deepEqual(calls.slice(10).map((call) => call.body.url), [links[2]]);
  assert.deepEqual((await read(app.baseUrl, fx, v1({ urls: [] }))).items, []);
  assert.equal(calls.length, 11);
});

// Raft's own objects' links (an Artifact's on Raft's app hosts, as the shared
// parseArtifactRef reads them) are read from core's object summaries, never
// from an App: the shared appLinkReadUrls leaves them out before the ten and
// the three.
test("Raft's own objects' links don't count toward the limit: after ten Artifact links an App link is read (the batched read and the GET); App links are still capped", async ({ app, db, seed }) => {
  const origin = "https://mixed.example.test";
  const artifacts = Array.from({ length: 12 }, (_, i) => i % 2 ? `https://app.raft.build/artifacts/pt_${randomUUID()}/v/${i}` : `https://app.raft.build/artifacts/pt_${randomUUID()}`);
  const appLink = `${origin}/pr/1`;
  const fx = await connected(db, seed, { key: "cards-mixed", origin, content: [...artifacts.slice(0, 10), appLink].join(" ") });
  // Twelve App links, each after an Artifact link: the ten (three) App links come first, whatever is between them.
  const links = Array.from({ length: 12 }, (_, i) => `${origin}/pr/${i + 2}`);
  const capped = { ...fx, message: await seed.message({ channel: fx.channel, author: fx.owner, content: links.flatMap((link, i) => [artifacts[i]!, link]).join(" ") }) };
  // The reverse: an Artifact-shaped link on a host that isn't Raft's is a link like any other and counts.
  const lookalike = { ...fx, message: await seed.message({ channel: fx.channel, author: fx.owner,
    content: [...Array.from({ length: 10 }, (_, i) => `https://lookalike.example.test/artifacts/pt_${i}`), appLink].join(" ") }) };
  const calls = stubApp(() => v1Card);
  const v1 = readBody({ capabilities: [] });
  const urlsOf = async (target: Fixture) => (await read(app.baseUrl, target, v1)).items.map((item) => item.url);
  const getUrls = async (target: Fixture) => {
    const response = await fetch(`${app.baseUrl}/api/messages/${target.message.id}/app-link-previews`, { headers: target.headers });
    assert.equal(response.status, 200);
    return ((await response.json()) as { previews: { url: string }[] }).previews.map((preview) => preview.url);
  };

  // The GET (old clients) covers three.
  assert.deepEqual(await getUrls(fx), [appLink], "the GET: the App link after ten Artifact links is read");
  assert.deepEqual(await getUrls(capped), links.slice(0, 3), "the GET: still three App links");
  assert.deepEqual(await getUrls(lookalike), [], "the GET: lookalike links count, the App link is the eleventh");

  calls.length = 0;
  assert.deepEqual(await urlsOf(fx), [appLink], "the batched read: the App link after ten Artifact links is read");
  assert.deepEqual(await urlsOf(capped), links.slice(0, 10), "the batched read: still ten App links; the eleventh and twelfth are not requested");
  assert.deepEqual(await urlsOf(lookalike), [], "the batched read: lookalike links count, the App link is the eleventh");
  assert.deepEqual(calls.map((call) => call.body.url), [appLink, ...links.slice(0, 10)], "no App is asked about an Artifact link or a link past the ten");
  assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities: [], urls: [artifacts[0]!, appLink] }))).items.map((item) => item.url), [appLink],
    "`urls` can't name an Artifact link");
});

test("the per-link budget: the 121st link in a minute comes back rate_limited with a retry hint, never as a whole-request 429", async ({ app, db, seed }) => {
  const origin = "https://budget.example.test";
  const fx = await connected(db, seed, { key: "cards-budget", origin, content: Array.from({ length: 10 }, (_, i) => `${origin}/pr/${i}`).join(" ") });
  const calls = stubApp(() => v1Card);
  const v1 = readBody({ capabilities: [] });
  for (let i = 0; i < 12; i++) assert.equal((await read(app.baseUrl, fx, v1)).items.filter((item) => item.kind === "v1").length, 10);
  assert.equal(calls.length, 120);
  const over = await read(app.baseUrl, fx, v1);
  assert.equal(calls.length, 120, "over budget: the App is not called");
  assert.equal(over.items.length, 10);
  for (const item of over.items) {
    assert.equal(item.kind, "rate_limited");
    assert.deepEqual(Object.keys(item).sort(), ["kind", "retry_after", "url"], "a rate-limited link tells nothing else");
    assert.ok(Number.isInteger(item.retry_after) && item.retry_after! >= 1 && item.retry_after! <= 60, String(item.retry_after));
  }
});

test("when other reads hold every callback slot, a link comes back rate_limited instead of being dropped", async ({ app, db, seed }) => {
  const origin = "https://slots.example.test";
  const fx = await connected(db, seed, { key: "cards-slots", origin, content: Array.from({ length: MAX_IN_FLIGHT_CALLBACKS_PER_USER }, (_, i) => `${origin}/pr/${i}`).join(" ") });
  const lone = { ...fx, message: await seed.message({ channel: fx.channel, author: fx.owner, content: `${origin}/pr/lone` }) };
  const v1 = readBody({ capabilities: [] });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let saturated!: () => void; const full = new Promise<void>((resolve) => { saturated = resolve; });
  let blocked = 0;
  const calls = stubApp(async (call) => {
    if (call.body.url === `${origin}/pr/lone`) return v1Card;
    if (++blocked === MAX_IN_FLIGHT_CALLBACKS_PER_USER) saturated();
    await gate; return v1Card;
  });
  const held = read(app.baseUrl, fx, v1);
  await full;
  assert.deepEqual((await read(app.baseUrl, lone, v1)).items, [{ url: `${origin}/pr/lone`, kind: "rate_limited", retry_after: 3 }]);
  release();
  assert.equal((await held).items.length, MAX_IN_FLIGHT_CALLBACKS_PER_USER, "one read never exceeds the slots it can use");
  assert.deepEqual((await read(app.baseUrl, lone, v1)).items.map((item) => item.kind), ["v1"]);
  assert.equal(calls.length, MAX_IN_FLIGHT_CALLBACKS_PER_USER + 1);
});

test("strip matrix: not official / official without an approved endpoint / official with one, by capabilities; a suspended registration is not called", async ({ app, db, seed }) => {
  const origin = "https://strip.example.test";
  const fx = await connected(db, seed, { key: "cards-strip", origin, content: `${origin}/pr/1` });
  const calls = stubApp(() => JSON.stringify(v2Answer({ approve, merge, open: openButton(origin), refresh })));
  const view = async (capabilities: string[]) => {
    const [item] = (await read(app.baseUrl, fx, readBody({ capabilities }))).items;
    return { ids: elementIds(item), ticket: item?.ticket ?? null, actions: item?.actions?.map((action) => action.action_id) ?? [] };
  };
  const undoOnly = ["card.v2", "button.v1", "undo.v1"];
  const confirmOnly = ["card.v2", "button.v1", "confirm.v1"];
  const noButtons = ["card.v2"];

  // Not an approved official App: navigate only, even read goes.
  for (const caps of [ALL, undoOnly]) assert.deepEqual(await view(caps), { ids: ["open", "root"], ticket: null, actions: [] });
  assert.deepEqual(await view(noButtons), { ids: ["root"], ticket: null, actions: [] });
  // An action endpoint without the official registry is still navigate only.
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${origin}/card-actions` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual(await view(ALL), { ids: ["open", "root"], ticket: null, actions: [] });

  // Official, no approved endpoint in force (a pending one does not count): navigate and read.
  await makeOfficial(db, fx);
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: null, pendingActionEndpoint: `${origin}/card-actions`, pendingActionEndpointRequestedAt: new Date() })
    .where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  for (const caps of [ALL, undoOnly]) assert.deepEqual(await view(caps), { ids: ["open", "refresh", "root"], ticket: null, actions: [] });
  assert.deepEqual(await view(noButtons), { ids: ["root"], ticket: null, actions: [] });

  // Official with an approved endpoint and a normal registration: every button the client can press.
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${origin}/card-actions`, pendingActionEndpoint: null, pendingActionEndpointRequestedAt: null })
    .where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const full = await view(ALL);
  assert.deepEqual([full.ids, full.actions], [["approve", "merge", "open", "refresh", "root"], ["approve", "merge"]]); assert.ok(full.ticket);
  const undo = await view(undoOnly);
  assert.deepEqual([undo.ids, undo.actions], [["approve", "open", "refresh", "root"], ["approve"]]); assert.ok(undo.ticket);
  const confirm = await view(confirmOnly);
  assert.deepEqual([confirm.ids, confirm.actions], [["merge", "open", "refresh", "root"], ["merge"]]); assert.ok(confirm.ticket);
  assert.deepEqual(await view(noButtons), { ids: ["root"], ticket: null, actions: [] });

  // Proof older than HARD_TTL: unverified even before the sweep suspends it, so no callback.
  const before72 = calls.length;
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date(Date.now() - 73 * 3600_000) }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual(await read(app.baseUrl, fx), { items: [], prompts: [] });
  assert.equal(calls.length, before72);
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date() }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));

  // Suspended: no callback at all (registration rows that are suspended are not candidates), so the link is plain.
  const before = calls.length;
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: new Date(), suspendedReason: "proof_unavailable" }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual((await read(app.baseUrl, fx)).items, []);
  assert.equal(calls.length, before);
  // Were a suspended registration's card shown, it would keep navigate and read only.
  assert.equal(linkCardActionTier({ official: true, ownServer: false, actionEndpoint: `${origin}/card-actions`, suspended: true }), "read");
  assert.equal(linkCardActionTier({ official: true, ownServer: false, actionEndpoint: null, suspended: false }), "read");
  assert.equal(linkCardActionTier({ official: false, ownServer: false, actionEndpoint: `${origin}/card-actions`, suspended: false }), "navigate");
  assert.equal(linkCardActionTier({ official: true, ownServer: false, actionEndpoint: `${origin}/card-actions`, suspended: false }), "execute");
  // RFC 076 §17: an App that is not official acts only where its own-Server actions are in force.
  assert.equal(linkCardActionTier({ official: false, ownServer: true, actionEndpoint: `${origin}/card-actions`, suspended: false }), "execute");
});

test("tokens: a ticket and one handle per enabled execute action, bound to this view; disabled actions stay visible without a handle", async ({ app, db, seed }) => {
  const origin = "https://tokens.example.test";
  const content = `Please look at ${origin}/pr/1`;
  const fx = await connected(db, seed, { key: "cards-tokens", origin, content, actionEndpoint: true });
  await makeOfficial(db, fx);
  let answer: unknown = v2Answer({ approve, merge: { ...merge, props: { ...merge.props, disabledReason: "Checks are still running" } }, open: openButton(origin) });
  stubApp(() => JSON.stringify(answer));
  const [item] = (await read(app.baseUrl, fx)).items;
  assert.equal(item!.kind, "v2");
  assert.deepEqual(elementIds(item), ["approve", "merge", "open", "root"], "the disabled merge button is still shown");
  assert.deepEqual(item!.actions!.map((action) => action.action_id), ["approve"], "but gets no handle");
  const now = new Date();
  const ticket = verifyLinkCardReadTicket(item!.ticket, now);
  assert.ok(ticket);
  assert.deepEqual(ticket.binding, {
    viewerId: fx.owner.id, serverId: fx.server.id, providerKind: "app", providerKey: fx.client.clientId, installationKey: fx.install.id,
    messageId: fx.message.id, urlSha256: sha256(`${origin}/pr/1`), registrationRevision: fx.registration.revision, capabilities: [...ALL].sort(),
  });
  assert.equal(ticket.viewInstanceId, VIEW); assert.equal(ticket.epoch, 1); assert.equal(ticket.exp - ticket.iat, 600);
  const handle = verifyLinkCardHandle(item!.actions![0]!.handle, now);
  assert.ok(handle);
  const { binding, viewNonce, viewInstanceId, epoch } = handle.claims;
  assert.deepEqual({ binding, viewNonce, viewInstanceId, epoch }, { binding: ticket.binding, viewNonce: ticket.viewNonce, viewInstanceId: VIEW, epoch: 1 });
  assert.equal(handle.claims.actionId, "approve"); assert.equal(handle.claims.requiresPrepare, false);
  assert.equal(handle.claims.cardRevision, "cr-1"); assert.equal(handle.claims.businessRevision, "br-1");
  assert.equal(handle.claims.messageContentSha256, sha256(content));
  assert.ok(handle.claims.exp - handle.claims.iat <= 600);
  // The descriptor digest covers the Button props after schema defaults (addendum 1 §3).
  const descriptor = { label: "Approve", variant: "default", action: { kind: "execute", action_id: "approve", undoWindowMs: 5000 } };
  assert.equal(handle.claims.descriptorSha256, canonicalJsonSha256(descriptor));
  answer = v2Answer({ approve: { ...approve, props: { ...approve.props, variant: "default" } }, merge });
  const explicit = (await read(app.baseUrl, fx)).items[0]!;
  const handles = Object.fromEntries(explicit.actions!.map((action) => [action.action_id, verifyLinkCardHandle(action.handle, new Date())!.claims]));
  assert.equal(handles.approve!.descriptorSha256, canonicalJsonSha256(descriptor), "an explicit default signs the same digest");
  assert.equal(handles.merge!.requiresPrepare, true);
  assert.equal(handles.merge!.descriptorSha256, canonicalJsonSha256({ label: "Merge", variant: "default", action: { kind: "execute", action_id: "merge", confirm: "prepare" } }));

  // Nothing to execute: no ticket, no handles. Navigate, read and connect prompts never get any.
  for (const shown of [v2Answer({ open: openButton(origin), refresh }), { version: 2, display: "connect_account", connect_url: `${origin}/s/team/auth/github` }]) {
    answer = shown;
    const [plain] = (await read(app.baseUrl, fx)).items;
    assert.equal(plain!.kind, "v2"); assert.equal(plain!.ticket, null); assert.deepEqual(plain!.actions, []);
  }
  assert.deepEqual((await read(app.baseUrl, fx)).items[0]!.preview, { version: 2, display: "connect_account", connect_url: `${origin}/s/team/auth/github` });
  // connect_account is Raft's fixed template, not an App Button: a client with
  // card.v2 but no button.v1 still gets it (RFC 076 §6.1).
  assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities: ["card.v2"] }))).items[0]!.preview,
    { version: 2, display: "connect_account", connect_url: `${origin}/s/team/auth/github` }, "capabilities don't strip connect_account");
});

test("RFC 076 §17: a server_local App's execute buttons only on its own Server, only while the endpoint in force is the one its admins confirmed; a withdrawal strips them from the next read", async ({ app, db, seed }) => {
  const origin = "https://own-server.example.test";
  const fx = await connected(db, seed, { key: "cards-own-server", origin, content: `Review ${origin}/pr/1`, actionEndpoint: true });
  stubApp(() => JSON.stringify(v2Answer({ approve, open: openButton(origin) })));
  // A client that declared unreviewed_app.v1 (shows Raft's not-reviewed confirmation before every acting button), unless `capable` is false.
  const shown = async (capable = true) => {
    const [item] = (await read(app.baseUrl, fx, readBody({ capabilities: capable ? [...ALL, "unreviewed_app.v1"] : ALL }))).items;
    const reviewed = item!.app!.reviewed;
    return { elements: elementIds(item), actions: item!.actions!.map((action) => action.action_id), ticket: item!.ticket !== null, ...(reviewed === undefined ? {} : { reviewed }) };
  };
  const ownServerActions = (method: "PUT" | "DELETE", actionEndpoint = `${origin}/card-actions`) => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/action-endpoint/own-server-actions`, {
    method, headers: fx.headers, ...(method === "PUT" ? { body: JSON.stringify({ action_endpoint: actionEndpoint }) } : {}),
  });

  // Not official, not confirmed: navigate only, nothing signed.
  assert.deepEqual(await shown(), { elements: ["open", "root"], actions: [], ticket: false });
  // Confirmed by the App's own Server's owner: the execute button, its handle, and `reviewed: false`.
  assert.equal((await ownServerActions("PUT")).status, 200);
  assert.deepEqual(await shown(), { elements: ["approve", "open", "root"], actions: ["approve"], ticket: true, reviewed: false });
  // A client that didn't declare unreviewed_app.v1 (it may skip the confirmation): navigate only, and no `reviewed` field.
  assert.deepEqual(await shown(false), { elements: ["open", "root"], actions: [], ticket: false });
  // The App moved its endpoint: the confirmation no longer applies.
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${origin}/card-actions-v2` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual(await shown(), { elements: ["open", "root"], actions: [], ticket: false });
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${origin}/card-actions` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual((await shown()).actions, ["approve"]);
  // Withdrawn: the next read of a card already shown is navigate only again.
  assert.equal((await ownServerActions("DELETE")).status, 200);
  assert.deepEqual(await shown(), { elements: ["open", "root"], actions: [], ticket: false });
  // Published (no longer server_local): a confirmation it still carries does not apply.
  assert.equal((await ownServerActions("PUT")).status, 200);
  await db.update(oauthClients).set({ appType: "third_party_global" }).where(eq(oauthClients.id, fx.client.id));
  assert.deepEqual(await shown(), { elements: ["open", "root"], actions: [], ticket: false });
  // An official App never gets `reviewed`, with or without the capability.
  await db.update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, fx.client.id));
  await makeOfficial(db, fx);
  assert.deepEqual(await shown(), { elements: ["approve", "open", "root"], actions: ["approve"], ticket: true });
  assert.deepEqual(await shown(false), { elements: ["approve", "open", "root"], actions: ["approve"], ticket: true });
});

test("the ticket chain continues only from a valid ticket for this view and binding; tampered, expired or foreign tickets start a new nonce", async ({ app, db, seed }) => {
  const origin = "https://chain.example.test";
  const fx = await connected(db, seed, { key: "cards-chain", origin, content: `${origin}/pr/1 ${origin}/pr/2`, actionEndpoint: true });
  await makeOfficial(db, fx);
  stubApp(() => JSON.stringify(v2Answer({ approve })));
  const url = `${origin}/pr/1`;
  const ticketFor = async (body: ReadBody) => verifyLinkCardReadTicket((await read(app.baseUrl, fx, readBody({ urls: [url], ...body }))).items[0]!.ticket, new Date())!;
  const first = await ticketFor({});
  const firstRaw = (await read(app.baseUrl, fx, readBody({ urls: [url] }))).items[0]!.ticket!;
  const firstClaims = verifyLinkCardReadTicket(firstRaw, new Date())!;
  assert.notEqual(first.viewNonce, firstClaims.viewNonce, "no ticket presented: a new nonce every time");

  const next = await ticketFor({ tickets: { [url]: firstRaw } });
  assert.deepEqual([next.viewNonce, next.epoch], [firstClaims.viewNonce, 2], "same view and binding: same nonce, epoch + 1");
  const nextRaw = signLinkCardReadTicket(next);
  assert.deepEqual([(await ticketFor({ tickets: { [url]: nextRaw } })).epoch], [3]);

  const fresh = (claims: LinkCardReadTicketClaims, why: string) => async (body: ReadBody) => {
    const got = await ticketFor(body);
    assert.notEqual(got.viewNonce, claims.viewNonce, why); assert.equal(got.epoch, 1, why);
  };
  const tampered = `${firstRaw.slice(0, -2)}${firstRaw.endsWith("AA") ? "AB" : "AA"}`;
  await fresh(firstClaims, "tampered MAC")({ tickets: { [url]: tampered } });
  await fresh(firstClaims, "padding spelling")({ tickets: { [url]: `${firstRaw}=` } });
  const nowSeconds = Math.floor(Date.now() / 1000);
  await fresh(firstClaims, "expired")({ tickets: { [url]: signLinkCardReadTicket({ ...firstClaims, iat: nowSeconds - 700, exp: nowSeconds - 100 }) } });
  await fresh(firstClaims, "another view")({ view_instance_id: randomUUID(), tickets: { [url]: firstRaw } });
  await fresh(firstClaims, "other capabilities")({ capabilities: ["card.v2", "button.v1", "undo.v1"], tickets: { [url]: firstRaw } });
  await fresh(firstClaims, "another link's ticket")({ tickets: { [url]: (await read(app.baseUrl, fx, readBody({ urls: [`${origin}/pr/2`] }))).items[0]!.ticket! } });
  for (const [field, value] of [["registrationRevision", randomUUID()], ["installationKey", randomUUID()], ["messageId", randomUUID()], ["viewerId", randomUUID()], ["providerKey", "someone-else"]] as const) {
    await fresh(firstClaims, field)({ tickets: { [url]: signLinkCardReadTicket({ ...firstClaims, binding: { ...firstClaims.binding, [field]: value } }) } });
  }
  // The binding's revision is live: a new registration revision breaks the chain.
  await db.update(oauthAppLinkPreviews).set({ revision: randomUUID() as never }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await fresh(firstClaims, "registration revision moved")({ tickets: { [url]: firstRaw } });
});

test("inline labels: kept only for a client that declared inline.v1; inline on a link or connect answer makes it a plain link", async ({ app, db, seed }) => {
  const origin = "https://inline.example.test";
  const fx = await connected(db, seed, { key: "cards-inline", origin, content: `#1497 ${origin}/pr/1497 merged` });
  const inline = { title: "botiverse/stamp#1497", badge: { text: "Merged", tone: "success" } };
  let answer: unknown = v2Answer({ state: { type: "Badge", props: { text: "Merged", tone: "done" } } }, { inline });
  const calls = stubApp(() => JSON.stringify(answer));
  const withInline = (await read(app.baseUrl, fx, readBody({ capabilities: [...ALL, "inline.v1"] }))).items[0]!;
  assert.deepEqual(withInline.preview!.inline, inline);
  assert.deepEqual(calls[0]!.body.client_capabilities, ["button.v1", "card.v2", "confirm.v1", "inline.v1", "undo.v1"], "inline.tone.v2 is forwarded only when declared");
  const without = (await read(app.baseUrl, fx)).items[0]!;
  assert.equal(without.kind, "v2"); assert.ok(!("inline" in without.preview!), "dropped, card still shown");
  assert.equal(without.preview!.title, "PR #1 is ready");
  answer = { ...(answer as object), inline: { title: "x", badge: { text: "x", tone: "#ff0000" } } };
  assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities: [...ALL, "inline.v1"] }))).items, [], "an invalid inline invalidates the answer");
  for (const shown of [{ version: 2, display: "link", inline }, { version: 2, display: "connect_account", connect_url: `${origin}/auth`, inline }]) {
    answer = shown;
    assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities: [...ALL, "inline.v1"] }))).items, [], String(shown.display));
  }
  answer = { version: 2, display: "link" };
  assert.deepEqual((await read(app.baseUrl, fx)).items, [], "display link: the plain link (F11)");
});

test("inline badge tones: a client with inline.tone.v2 gets the App's tone; an older client gets the four first tones by meaning", async ({ app, db, seed }) => {
  const origin = "https://inline-tones.example.test";
  const fx = await connected(db, seed, { key: "cards-inline-tones", origin, content: `#1498 ${origin}/pr/1498 merged` });
  let tone = "done";
  const calls = stubApp(() => JSON.stringify(v2Answer({ state: { type: "Badge", props: { text: "Merged", tone: "done" } } }, { inline: { title: "#1498 Fix", badge: { text: "Merged", tone } } })));
  const newer = (await read(app.baseUrl, fx, readBody({ capabilities: [...ALL, "inline.v1", "inline.tone.v2"] }))).items[0]!;
  assert.deepEqual(newer.preview!.inline, { title: "#1498 Fix", badge: { text: "Merged", tone: "done" } });
  assert.ok((calls[0]!.body.client_capabilities as string[]).includes("inline.tone.v2"), "the App learns the client reads the new tones");
  // Older client (inline.v1 only): the same colours it showed before the new words (yanyongyu's table).
  const expected: Record<string, string> = { done: "success", action: "success", success: "success", warning: "warning", danger: "danger", closed: "neutral", progress: "neutral", review: "neutral", neutral: "neutral" };
  for (const [sent, shown] of Object.entries(expected)) {
    tone = sent;
    const older = (await read(app.baseUrl, fx, readBody({ capabilities: [...ALL, "inline.v1"] }))).items[0]!;
    assert.equal((older.preview!.inline as { badge?: { tone?: string } } | undefined)?.badge?.tone, shown, `${sent} reaches an older client as ${shown}`);
  }
  tone = "closed";
  const noInline = (await read(app.baseUrl, fx)).items[0]!;
  assert.ok(!("inline" in noInline.preview!), "no inline.v1: no inline at all");
});

test("block placement: kept only for a client that declared block.v1, which the App gets in client_capabilities; the stripped card, ticket and handles are byte-identical with and without it (RFC 076 §13)", async ({ app, db, seed }) => {
  const origin = "https://block.example.test";
  const url = `${origin}/pr/1`;
  const fx = await connected(db, seed, { key: "cards-block", origin, content: `Please approve ${url}`, actionEndpoint: true });
  await makeOfficial(db, fx);
  let answer: unknown = v2Answer({ approve, merge, open: openButton(origin), refresh }, { inline: { title: "PR #1" }, placement: "block" });
  const calls = stubApp(() => JSON.stringify(answer));
  // No confirm.v1, so the merge button is stripped either way; inline.v1 so the
  // inline label is kept either way. The only difference is block.v1.
  const chip = ["card.v2", "button.v1", "undo.v1", "inline.v1"];
  const block = [...chip, "block.v1"];
  // One second for every read, so the tickets' iat agrees.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const first = (await read(app.baseUrl, fx, readBody({ capabilities: chip }))).items[0]!;
    const tickets = { [url]: first.ticket! };
    const without = (await read(app.baseUrl, fx, readBody({ capabilities: chip, tickets }))).items[0]!;
    const withBlock = (await read(app.baseUrl, fx, readBody({ capabilities: block, tickets }))).items[0]!;
    assert.deepEqual(calls.map((call) => call.body.client_capabilities), [[...chip].sort(), [...chip].sort(), [...block].sort()],
      "block.v1 is forwarded to the App like the others, and only when declared");

    assert.equal(withBlock.kind, "v2"); assert.equal(without.kind, "v2");
    assert.equal(withBlock.preview!.placement, "block", "kept for block.v1");
    assert.ok(!("placement" in without.preview!), "no block.v1: no placement, so the client keeps the chip");
    const { placement: _placement, ...card } = withBlock.preview!;
    assert.equal(JSON.stringify(card), JSON.stringify(without.preview), "the same stripped card, byte for byte");
    assert.deepEqual(elementIds(withBlock), ["approve", "open", "refresh", "root"], "and it is stripped (merge needs confirm.v1)");
    assert.deepEqual((withBlock.preview!.inline as { title: string }).title, "PR #1");

    assert.ok(withBlock.ticket && without.ticket);
    assert.equal(withBlock.ticket, without.ticket, "the same ticket, byte for byte");
    assert.deepEqual(withBlock.actions!.map((action) => action.action_id), ["approve"]);
    assert.deepEqual(withBlock.actions, without.actions, "the same handles, byte for byte");
    const ticket = verifyLinkCardReadTicket(withBlock.ticket, new Date())!;
    const firstTicket = verifyLinkCardReadTicket(first.ticket, new Date())!;
    assert.deepEqual([ticket.viewNonce, ticket.epoch], [firstTicket.viewNonce, 2], "a block.v1 read continues the chain a chip read started");
    assert.deepEqual(ticket.binding.capabilities, [...chip].sort(), "block.v1 is not bound: it only moves where the card is drawn");
    assert.deepEqual(verifyLinkCardHandle(withBlock.actions![0]!.handle, new Date())!.claims.binding, ticket.binding);
  } finally {
    vi.useRealTimers();
  }

  // Any other value, or placement on link / connect_account, invalidates the answer: the plain link.
  for (const shown of [
    v2Answer({ open: openButton(origin) }, { placement: "inline" }), v2Answer({ open: openButton(origin) }, { placement: null }),
    { version: 2, display: "link", placement: "block" }, { version: 2, display: "connect_account", connect_url: `${origin}/auth`, placement: "block" },
  ]) {
    answer = shown;
    assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities: block }))).items, [], JSON.stringify(shown).slice(0, 120));
  }
});

// Version 3 (RFC 076 §14, protocol addendum 7): the App may answer version 2
// or 3 whatever the client declared; a preview.v3 client reads version 3, any
// other version 2. The conversion never changes what is signed.
test("preview.v3: forwarded only when declared and never bound; a version 2 and a version 3 answer, read by a version 2 and a version 3 client, give byte-identical stripped card, ticket and handles (Tenny e1375827)", async ({ app, db, seed }) => {
  const origin = "https://v3.example.test";
  const url = `${origin}/pr/1`;
  const fx = await connected(db, seed, { key: "cards-v3", origin, content: `Please approve ${url}`, actionEndpoint: true });
  await makeOfficial(db, fx);
  const inline = { title: "PR #1", badge: { text: "Open", tone: "neutral" } };
  const elements = { approve, merge, open: openButton(origin), refresh };
  const v2 = v2Answer(elements, { inline, placement: "block" });
  const { version: _version, display: _display, ...card } = v2Answer(elements);
  const v3 = { version: 3, items: [{ type: "inline", ...inline }, { type: "card", placement: "block", ...card }] };
  let answer: unknown = v2;
  const calls = stubApp(() => JSON.stringify(answer));
  // No confirm.v1, so merge is stripped either way; inline.v1 and block.v1, so
  // a version 2 client keeps the label and the placement. The only difference
  // between the two clients is preview.v3.
  const v2Client = ["card.v2", "button.v1", "undo.v1", "inline.v1", "block.v1"];
  const v3Client = [...v2Client, "preview.v3"];
  // One second for every read, so the tickets' iat agrees.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const first = (await read(app.baseUrl, fx, readBody({ capabilities: v2Client }))).items[0]!;
    const tickets = { [url]: first.ticket! };
    const reads: Item[] = [];
    for (const sent of [v2, v3]) {
      answer = sent;
      for (const capabilities of [v2Client, v3Client]) reads.push((await read(app.baseUrl, fx, readBody({ capabilities, tickets }))).items[0]!);
    }
    assert.deepEqual(calls.map((call) => (call.body.client_capabilities as string[]).includes("preview.v3")), [false, false, true, false, true],
      "preview.v3 is forwarded to the App only when the client declared it");
    assert.deepEqual(calls.at(-1)!.body.client_capabilities, [...v3Client].sort());
    const [v2ForV2, v2ForV3, v3ForV2, v3ForV3] = reads as [Item, Item, Item, Item];
    assert.deepEqual(reads.map((item) => item.kind), ["v2", "v3", "v2", "v3"], "the client's version, whichever version the App answered");

    const stripped = { root: "root", elements: {
      root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["approve", "open", "refresh"] },
      approve: { type: "Button", props: { label: "Approve", variant: "default", action: approve.props.action } },
      open: openButton(origin), refresh: { type: "Button", props: { label: "Refresh", variant: "default", action: { kind: "read" } } },
    } };
    assert.deepEqual(v2ForV2.preview, { ...v2, card: stripped });
    assert.deepEqual(v3ForV3.preview, { version: 3, items: [{ type: "inline", ...inline }, { type: "card", placement: "block", ...card, card: stripped }] });
    assert.equal(JSON.stringify(v3ForV2.preview), JSON.stringify(v2ForV2.preview), "a version 3 answer converted down is the version 2 answer, byte for byte");
    assert.equal(JSON.stringify(v2ForV3.preview), JSON.stringify(v3ForV3.preview), "a version 2 answer converted up is the version 3 answer, byte for byte");

    const cardOf = (item: Item) => (item.kind === "v3" ? (item.preview!.items as Record<string, unknown>[]).find((entry) => entry.type === "card") : item.preview)!;
    const signed = (item: Item) => JSON.stringify([cardOf(item).title, cardOf(item).card_revision, cardOf(item).business_revision, cardOf(item).card]);
    assert.ok(v2ForV2.ticket);
    assert.deepEqual(v2ForV2.actions!.map((action) => action.action_id), ["approve"]);
    for (const [item, why] of [[v2ForV3, "a version 2 answer for a preview.v3 client"], [v3ForV2, "a version 3 answer for a version 2 client"], [v3ForV3, "a version 3 answer for a preview.v3 client"]] as const) {
      assert.equal(signed(item), signed(v2ForV2), `${why}: the same stripped card, title and revisions, byte for byte`);
      assert.equal(item.ticket, v2ForV2.ticket, `${why}: the same ticket, byte for byte`);
      assert.deepEqual(item.actions, v2ForV2.actions, `${why}: the same handles, byte for byte`);
    }
    const ticket = verifyLinkCardReadTicket(v3ForV3.ticket, new Date())!;
    const firstTicket = verifyLinkCardReadTicket(first.ticket, new Date())!;
    assert.deepEqual([ticket.viewNonce, ticket.epoch], [firstTicket.viewNonce, 2], "a preview.v3 read continues the chain a version 2 read started");
    assert.deepEqual(ticket.binding.capabilities, ["button.v1", "card.v2", "inline.v1", "undo.v1"], "neither preview.v3 nor block.v1 is bound");
    const handle = verifyLinkCardHandle(v3ForV3.actions![0]!.handle, new Date())!;
    assert.deepEqual(handle.claims.binding, ticket.binding);
    assert.deepEqual([handle.claims.cardRevision, handle.claims.businessRevision], ["cr-1", "br-1"], "signed with the card item's revisions");
  } finally {
    vi.useRealTimers();
  }
});

test("conversions: a version 3 answer converted down per RFC 076 §14's table and a version 2 answer converted up, for clients with and without inline.v1 and block.v1", async ({ app, db, seed }) => {
  const origin = "https://v3-convert.example.test";
  const url = `${origin}/pr/1`;
  const fx = await connected(db, seed, { key: "cards-v3-convert", origin, content: `see ${url}` });
  let answer: unknown;
  stubApp(() => JSON.stringify(answer));
  const appView = { id: fx.client.id, name: "cards-v3-convert App", icon: null };
  const inline = { title: "PR #1", badge: { text: "Open", tone: "neutral" } };
  const inlineItem = { type: "inline", ...inline };
  const fields = { title: "PR #1 is ready", card_revision: "cr-1", business_revision: "br-1" };
  const sentCard = v2Answer({ open: openButton(origin) }).card;
  const shownCard = { root: "root", elements: { root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["open"] }, open: openButton(origin) } };
  const cardItem = (placement: string, card: unknown = shownCard) => ({ type: "card", placement, ...fields, card });
  const connectUrl = `${origin}/s/team/auth/github`;
  const connect = { type: "connect_account", connect_url: connectUrl };
  const v2Connect = { version: 2, display: "connect_account", connect_url: connectUrl };
  type Has = { inline: boolean; block: boolean };
  const v2Card = (has: Has, sent: { inline?: boolean; block?: boolean }) => ({ version: 2, display: "card", ...fields, card: shownCard,
    ...(sent.inline && has.inline ? { inline } : {}), ...(sent.block && has.block ? { placement: "block" } : {}) });
  // [name, the App's answer, what a client without preview.v3 gets (null: omitted), what a preview.v3 client gets]
  const cases: [string, unknown, (has: Has) => unknown, unknown[] | null][] = [
    ["v3 []", { version: 3, items: [] }, () => null, null],
    ["v3 [connect_account]", { version: 3, items: [connect] }, () => v2Connect, [connect]],
    ["v3 [inline]", { version: 3, items: [inlineItem] }, () => null, [inlineItem]],
    ["v3 [card hover]", { version: 3, items: [cardItem("hover", sentCard)] }, (has) => v2Card(has, {}), [cardItem("hover")]],
    ["v3 [inline, card hover]", { version: 3, items: [inlineItem, cardItem("hover", sentCard)] }, (has) => v2Card(has, { inline: true }), [inlineItem, cardItem("hover")]],
    ["v3 [inline, card block]", { version: 3, items: [inlineItem, cardItem("block", sentCard)] }, (has) => v2Card(has, { inline: true, block: true }), [inlineItem, cardItem("block")]],
    ["v3 [card block, inline]", { version: 3, items: [cardItem("block", sentCard), inlineItem] }, (has) => v2Card(has, { inline: true, block: true }), [cardItem("block"), inlineItem]],
    ["v3 [card block] and an unknown item", { version: 3, items: [{ type: "future.gallery", images: [{ src: "https://elsewhere.example.test/a.png" }] }, cardItem("block", sentCard)] },
      (has) => v2Card(has, { block: true }), [cardItem("block")]],
    ["v3 an unknown item only", { version: 3, items: [{ type: "future.gallery" }] }, () => null, null],
    ["v2 link", { version: 2, display: "link" }, () => null, null],
    ["v2 connect_account", v2Connect, () => v2Connect, [connect]],
    ["v2 card", v2Answer({ open: openButton(origin) }), (has) => v2Card(has, {}), [cardItem("hover")]],
    ["v2 card + inline", v2Answer({ open: openButton(origin) }, { inline }), (has) => v2Card(has, { inline: true }), [inlineItem, cardItem("hover")]],
    ["v2 card + inline + block", v2Answer({ open: openButton(origin) }, { inline, placement: "block" }), (has) => v2Card(has, { inline: true, block: true }), [inlineItem, cardItem("block")]],
  ];
  for (const [name, sent, v2Expected, v3Expected] of cases) {
    answer = sent;
    for (const has of [{ inline: false, block: false }, { inline: true, block: false }, { inline: false, block: true }, { inline: true, block: true }]) {
      const capabilities = ["card.v2", "button.v1", ...(has.inline ? ["inline.v1"] : []), ...(has.block ? ["block.v1"] : [])];
      const why = `${name}; ${capabilities.join(" ")}`;
      const preview = v2Expected(has);
      assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities }))).items,
        preview === null ? [] : [{ url, kind: "v2", app: appView, preview, ticket: null, actions: [] }], why);
      assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities: [...capabilities, "preview.v3"] }))).items,
        v3Expected === null ? [] : [{ url, kind: "v3", app: appView, preview: { version: 3, items: v3Expected }, ticket: null, actions: [] }], `${why} preview.v3`);
    }
  }
});

test("version 3 answers are parsed like version 2: strictly from the raw text, any failure a plain link for every client; a preview.v3 client without inline.tone.v2 gets the inline tone downgraded", async ({ app, db, seed }) => {
  const origin = "https://v3-strict.example.test";
  const fx = await connected(db, seed, { key: "cards-v3-strict", origin, content: `${origin}/pr/1` });
  const card = { type: "card", placement: "hover", title: "PR #1 is ready", card_revision: "cr-1", business_revision: "br-1", card: v2Answer({ open: openButton(origin) }).card };
  const valid = JSON.stringify({ version: 3, items: [{ type: "inline", title: "PR #1", badge: { text: "Merged", tone: "done" } }, card] });
  let answer = valid;
  const calls = stubApp(() => answer);
  const v3Client = ["card.v2", "button.v1", "inline.v1", "preview.v3"];
  const badge = async (capabilities: string[]) => ((await read(app.baseUrl, fx, readBody({ capabilities }))).items[0]!.preview!.items as { badge?: unknown }[])[0]!.badge;
  assert.deepEqual(await badge(v3Client), { text: "Merged", tone: "success" }, "no inline.tone.v2: done reaches it as success, as for version 2");
  assert.deepEqual(await badge([...v3Client, "inline.tone.v2"]), { text: "Merged", tone: "done" });
  const failures: [string, string][] = [
    [`{"version":3,"items":[],"items":${valid.slice(valid.indexOf("["), -1)}}`, "a duplicate key"],
    [valid.replace('"title":"PR #1"', '"title":"PR #1","\\u0007":"x"'), "a C0 key in an item"],
    [JSON.stringify({ version: 3, items: [card, card] }), "a second card"],
    [JSON.stringify({ version: 3, items: [{ ...card, placement: "inline" }] }), "another placement"],
    [JSON.stringify({ version: 3, items: [{ ...card, card: v2Answer({ open: { ...openButton(origin), props: { ...openButton(origin).props, action: { kind: "navigate", url: "https://evil.example.test/x" } } } }).card }] }),
      "a navigate URL off the origin"],
    [JSON.stringify({ version: 3, items: [{ type: "connect_account", connect_url: "https://evil.example.test/auth" }] }), "a connect URL off the origin"],
    [JSON.stringify({ version: 3, display: "card", items: [card] }), "a version 2 field"],
  ];
  for (const [bad, why] of failures) {
    answer = bad;
    for (const capabilities of [v3Client, ["card.v2", "button.v1", "inline.v1"]]) {
      const before = calls.length;
      assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities }))).items, [], `${why}; ${capabilities.join(" ")}`);
      assert.equal(calls.length, before + 1, `${why}: one call, no retry`);
    }
  }
});

// Card Badge colours (RFC 076 §15; #proj-apps:#51): cosmetic, so never a
// reason to refuse a card. Dropped when invalid, and for a client without
// badge.color.v1. The inline badge has none (Tenny, #51 0658886f).
test("card Badge colours: badge.color.v1 forwarded only when declared; kept, lowercased, for a client that declared it, version 2 and 3; dropped for any other client (undeclared) and when invalid (invalid), the card still served, each drop a trace event; never bound; an inline badge colour is refused as before", async ({ app, db, seed }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const strips = () => sink.getAllLogEvents().filter((event) => event.name === LINK_CARD_BADGE_COLOR_STRIPPED_EVENT)
    .map(({ attrs }) => ({ app_id: attrs?.app_id, count: attrs?.count, reason: attrs?.reason }));
  const origin = "https://badge-color.example.test";
  const url = `${origin}/pr/1`;
  const fx = await connected(db, seed, { key: "cards-badge-color", origin, content: `Please approve ${url}`, actionEndpoint: true });
  await makeOfficial(db, fx);
  let colors: { state: unknown; done: unknown } = { state: "#00FF00", done: "#8250DF" };
  let version: 2 | 3 = 2;
  let inline: Record<string, unknown> = { title: "PR #1", badge: { text: "Merged", tone: "done" } };
  const answer = () => {
    const elements = {
      state: { type: "Badge", props: { text: "In review", tone: "review", color: colors.state } },
      done: { type: "Badge", props: { text: "Checks", tone: "done", color: colors.done } },
      ci: { type: "Badge", props: { text: "CI" } }, approve,
    };
    if (version === 2) return v2Answer(elements, { inline });
    const { version: _version, display: _display, ...card } = v2Answer(elements);
    return { version: 3, items: [{ type: "inline", ...inline }, { type: "card", placement: "hover", ...card }] };
  };
  const calls = stubApp(() => JSON.stringify(answer()));
  const base = [...ALL, "inline.v1", "inline.tone.v2"];
  const declared = [...base, "badge.color.v1"];
  const badges = (item: Item) => {
    const preview = item.preview!;
    const card = (item.kind === "v3" ? (preview.items as Record<string, unknown>[]).find((entry) => entry.type === "card")!.card : preview.card) as { elements: Record<string, { props: unknown }> };
    return { state: card.elements.state!.props, done: card.elements.done!.props, ci: card.elements.ci!.props };
  };
  const readAs = async (capabilities: string[]) => {
    sink.clear();
    const items = (await read(app.baseUrl, fx, readBody({ capabilities }))).items;
    return { items, strips: strips(), sent: calls.at(-1)!.body.client_capabilities as string[] };
  };
  const toned = { state: { text: "In review", tone: "review" }, done: { text: "Checks", tone: "done" }, ci: { text: "CI", tone: "neutral" } };
  const appId = fx.client.id;

  for (const v of [2, 3] as const) {
    version = v;
    for (const v3 of [false, true]) {
      const why = `version ${v} answer, ${v3 ? "preview.v3" : "version 2"} client`;
      const withV3 = (capabilities: string[]) => v3 ? [...capabilities, "preview.v3"] : capabilities;
      colors = { state: "#00FF00", done: "#8250DF" };
      // Declared: the App learns it, and the colours reach the client, lowercased.
      const kept = await readAs(withV3(declared));
      assert.equal(kept.items.length, 1, why);
      assert.equal(kept.items[0]!.kind, v3 ? "v3" : "v2", why);
      assert.ok(kept.sent.includes("badge.color.v1"), `${why}: forwarded when declared`);
      assert.deepEqual(badges(kept.items[0]!), { state: { ...toned.state, color: "#00ff00" }, done: { ...toned.done, color: "#8250df" }, ci: toned.ci }, why);
      assert.deepEqual(kept.strips, [], `${why}: nothing stripped`);
      // Not declared, read right after by the same viewer: nothing carries over from the read before.
      const older = await readAs(withV3(base));
      assert.ok(!older.sent.includes("badge.color.v1"), `${why}: not forwarded when not declared`);
      assert.ok(!JSON.stringify(older.items.map((item) => item.preview)).includes('"color"'), `${why}: no colour key reaches a client that didn't declare badge.color.v1`);
      assert.deepEqual(badges(older.items[0]!), toned, `${why}: the tone stays`);
      assert.deepEqual(older.strips, [{ app_id: appId, count: 2, reason: "undeclared" }], why);
      // Invalid: dropped for every client, the card still served.
      colors = { state: "purple", done: null };
      for (const capabilities of [declared, base]) {
        const invalid = await readAs(withV3(capabilities));
        assert.deepEqual(badges(invalid.items[0]!), toned, `${why}: invalid, ${capabilities.at(-1)}`);
        assert.deepEqual(invalid.strips, [{ app_id: appId, count: 2, reason: "invalid" }], `${why}: invalid, ${capabilities.at(-1)}`);
      }
      // One of each: the invalid one dropped as invalid, the valid one as undeclared.
      colors = { state: "#8250d", done: "#8250df" };
      const mixed = await readAs(withV3(base));
      assert.deepEqual(mixed.strips, [{ app_id: appId, count: 1, reason: "invalid" }, { app_id: appId, count: 1, reason: "undeclared" }], `${why}: mixed`);
      assert.ok(!JSON.stringify(mixed.items.map((item) => item.preview)).includes('"color"'), `${why}: mixed`);
      const mixedKept = await readAs(withV3(declared));
      assert.deepEqual(badges(mixedKept.items[0]!), { ...toned, done: { ...toned.done, color: "#8250df" } }, `${why}: mixed, declared`);
      assert.deepEqual(mixedKept.strips, [{ app_id: appId, count: 1, reason: "invalid" }], `${why}: mixed, declared`);
      // The inline badge takes no colour: one there is an unknown field, as before this, and the link is plain for every client.
      colors = { state: "#00ff00", done: "#8250df" };
      for (const color of ["#8250df", "purple"]) {
        inline = { title: "PR #1", badge: { text: "Merged", tone: "done", color } };
        for (const capabilities of [declared, base]) {
          const refused = await readAs(withV3(capabilities));
          assert.deepEqual(refused.items, [], `${why}: inline colour ${color}, ${capabilities.at(-1)}`);
          assert.deepEqual(refused.strips, [], `${why}: inline colour ${color}: refused, not stripped`);
        }
      }
      inline = { title: "PR #1", badge: { text: "Merged", tone: "done" } };
    }
  }

  // Not bound: a read with badge.color.v1 continues the chain one without it started, with the same binding.
  version = 2;
  const first = (await read(app.baseUrl, fx, readBody({ capabilities: base }))).items[0]!;
  const next = (await read(app.baseUrl, fx, readBody({ capabilities: declared, tickets: { [url]: first.ticket! } }))).items[0]!;
  const [firstTicket, nextTicket] = [verifyLinkCardReadTicket(first.ticket, new Date())!, verifyLinkCardReadTicket(next.ticket, new Date())!];
  assert.deepEqual([nextTicket.viewNonce, nextTicket.epoch], [firstTicket.viewNonce, 2], "a badge.color.v1 read continues the chain");
  assert.deepEqual(nextTicket.binding.capabilities, firstTicket.binding.capabilities);
  assert.ok(!nextTicket.binding.capabilities.includes("badge.color.v1"), "badge.color.v1 only changes how a Badge is drawn");
  assert.deepEqual(next.actions!.map((action) => action.action_id), ["approve"]);
});

test("v2 answers are parsed strictly from the raw text; any failure is a plain link and is never retried as version 1", async ({ app, db, seed }) => {
  const origin = "https://strict.example.test";
  const fx = await connected(db, seed, { key: "cards-strict", origin, content: `${origin}/pr/1` });
  const valid = JSON.stringify(v2Answer({ open: openButton(origin) }));
  let answer: unknown = valid;
  const calls = stubApp(() => { if (answer instanceof Error) throw answer; return answer; });
  assert.equal((await read(app.baseUrl, fx)).items.length, 1, "control: the valid answer is shown");
  const failures: [unknown, string][] = [
    [`${valid.slice(0, -1)},"\\u001b":"x"}`, "a C0 key (addendum 4 §4)"],
    [valid.replace('"open":{', '"open\\t":{'), "a C0 key inside the card"],
    [`{"version":2,"display":"link","display":"card"${valid.slice(valid.indexOf(',"title"'))}`, "a duplicate key that JSON.parse would let through as a card"],
    [valid.replace("PR #1 is ready", "PR \\ud83d is ready"), "a lone surrogate"],
    [`﻿${valid}`, "a BOM"],
    [JSON.parse(valid), "a parsed object instead of text"],
    [JSON.stringify(v1Card), "a version 1 answer"],
    [JSON.stringify(v2Answer({ open: { ...openButton(origin), props: { ...openButton(origin).props, action: { kind: "navigate", url: "https://evil.example.test/x" } } } })), "a navigate URL off the origin"],
    [JSON.stringify({ version: 2, display: "connect_account", connect_url: "https://evil.example.test/auth" }), "a connect URL off the origin"],
    ["not json", "not JSON"],
  ];
  for (const [bad, why] of failures) {
    answer = bad;
    const before = calls.length;
    assert.deepEqual((await read(app.baseUrl, fx)).items, [], why);
    assert.equal(calls.length, before + 1, `${why}: one call, no version 1 retry`);
    assert.equal(calls.at(-1)!.body.version, 2);
  }
  answer = new Error("Preview timeout");
  assert.deepEqual((await read(app.baseUrl, fx)).items, [], "a failed callback (timeout, non-200, an App's 429) is a plain link");
});

test("the read writes nothing and never starts a proof recheck; the GET's recheck is the positive control", async ({ app, db, seed }) => {
  const origin = "https://nowrite.example.test";
  const stale = new Date(Date.now() - 25 * 3600_000); // past SOFT_TTL, within HARD_TTL
  const fx = await connected(db, seed, { key: "cards-nowrite", origin, content: `${origin}/pr/1 ${origin}/pr/2`, actionEndpoint: true, verifiedAt: stale });
  await makeOfficial(db, fx);
  // Every write statement on any table bumps a sequence (nextval is not rolled
  // back), so a write inside a transaction counts too.
  await db.execute(sql.raw("CREATE SEQUENCE link_card_read_write_probe"));
  await db.execute(sql.raw("CREATE FUNCTION link_card_read_write_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('link_card_read_write_probe'); RETURN NULL; END $$"));
  await db.execute(sql.raw(`DO $$ DECLARE t record; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('CREATE TRIGGER link_card_read_write_probe AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION link_card_read_write_probe()', t.tablename);
    END LOOP;
  END $$`));
  const writes = async () => Number(((await db.execute(sql.raw("SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM link_card_read_write_probe"))) as unknown as { rows: { n: string | number }[] }).rows[0]!.n);
  const proofs: string[] = [];
  stubApp((call) => call.body.version === 2 ? JSON.stringify(v2Answer({ approve, merge, refresh })) : v1Card, proofs);
  const lastChecked = async () => (await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, fx.client.id)))[0]!.lastCheckedAt?.getTime();
  const checkedBefore = await lastChecked();

  const start = await writes();
  assert.deepEqual((await read(app.baseUrl, fx, readBody({ capabilities: [] }))).items.map((item) => item.kind), ["v1", "v1"]);
  await __settleAppLinkPreviewRechecksForTests();
  assert.equal(await writes(), start, "version 1: no INSERT / UPDATE / DELETE");
  const v2 = await read(app.baseUrl, fx);
  assert.deepEqual(v2.items.map((item) => [item.kind, item.actions?.length]), [["v2", 2], ["v2", 2]], "tickets and handles are signed, not stored");
  await __settleAppLinkPreviewRechecksForTests();
  assert.equal(await writes(), start, "version 2: no INSERT / UPDATE / DELETE");
  assert.deepEqual(proofs, [], "no proof recheck from the read path");
  assert.equal(await lastChecked(), checkedBefore, "last_checked_at untouched");

  // Positive control: the v1 GET starts the background recheck, which writes.
  await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/app-link-previews`, { headers: fx.headers });
  await __settleAppLinkPreviewRechecksForTests();
  assert.deepEqual(proofs, [`${origin}/.well-known/raft-link-preview.json`]);
  assert.ok(await writes() > start, "the probe sees the GET's recheck write");
});

test("a slow callback cannot outlive an edit, a delete, a consent revocation, an uninstall or a suspension", async ({ app, db, seed }) => {
  const origin = "https://race.example.test";
  const fx = await connected(db, seed, { key: "cards-race", origin, content: `${origin}/pr/1` });
  for (const change of ["none", "edit", "revoke", "uninstall", "suspend", "reregister", "delete"] as const) {
    await db.update(messages).set({ content: `${origin}/pr/1` }).where(eq(messages.id, fx.message.id));
    await db.update(oauthUserConsents).set({ revokedAt: null }).where(eq(oauthUserConsents.clientId, fx.client.id));
    await db.update(oauthClientInstalls).set({ status: "active" }).where(eq(oauthClientInstalls.clientId, fx.client.id));
    await db.update(oauthAppLinkPreviews).set({ suspendedAt: null, suspendedReason: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
    let called = false;
    stubApp(async () => {
      called = true;
      if (change === "edit") await db.update(messages).set({ content: `${origin}/pr/1 edited` }).where(eq(messages.id, fx.message.id));
      if (change === "delete") await db.delete(messages).where(eq(messages.id, fx.message.id));
      if (change === "revoke") await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.clientId, fx.client.id));
      if (change === "uninstall") await db.update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.clientId, fx.client.id));
      if (change === "suspend") await db.update(oauthAppLinkPreviews).set({ suspendedAt: new Date(), suspendedReason: "proof_mismatch" }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
      if (change === "reregister") await db.update(oauthAppLinkPreviews).set({ revision: randomUUID() as never }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
      return JSON.stringify(v2Answer({ open: openButton(origin) }));
    });
    const response = await post(app.baseUrl, fx);
    assert.equal(response.status, 200, change);
    assert.deepEqual((await response.json()).items.length, change === "none" ? 1 : 0, change);
    assert.ok(called, change);
  }
});

test("the same 404s as the GET (other Server, no channel access, joint channel, history cutoff, non-chat); strict bodies are 400, oversized ones 413", async ({ app, db, seed }) => {
  const origin = "https://gate.example.test";
  const fx = await connected(db, seed, { key: "cards-gate", origin, content: `${origin}/pr/1` });
  const calls = stubApp(() => v1Card);
  const both = async (headers: Record<string, string>, messageId: string) => [
    (await fetch(`${app.baseUrl}/api/messages/${messageId}/app-link-previews`, { headers })).status,
    (await post(app.baseUrl, { headers, message: { id: messageId } })).status,
  ];
  const outsider = await seed.human();
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: outsider.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  const privateChannel = await seed.channel({ server: fx.server, members: [fx.owner], visibility: "private" });
  const privateMessage = await seed.message({ channel: privateChannel, author: fx.owner, content: `${origin}/pr/2` });
  await addMember(fx.server.id, outsider.id);
  const outsiderHeaders = { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(outsider.email)}` };
  assert.deepEqual(await both(outsiderHeaders, privateMessage.id), [404, 404], "no access to the channel");
  const guest = await seed.human();
  await seedBoundGuest({ serverId: fx.server.id, userId: guest.id }, db);
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: guest.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  assert.deepEqual(await both({ ...fx.headers, Authorization: `Bearer ${await tokenForHuman(guest.email)}` }, fx.message.id), [404, 404], "a guest outside the channel");
  const otherServer = await seed.server({ owner: fx.owner });
  assert.deepEqual(await both({ ...fx.headers, "X-Server-Id": otherServer.id }, fx.message.id), [404, 404], "another Server");
  const joint = await createChannel(fx.server.id, `joint-${randomUUID().slice(0, 8)}`, undefined, "joint");
  await addHuman(joint.id, fx.owner.id);
  const jointMessage = await createMessage(joint.id, "user", fx.owner.id, `${origin}/pr/3`);
  assert.deepEqual(await both(fx.headers, jointMessage.id), [404, 404], "joint channel");
  const old = await seed.message({ channel: fx.channel, author: fx.owner, content: `${origin}/pr/4` });
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, fx.server.id));
  await db.update(messages).set({ createdAt: new Date(Date.now() - 40 * 86400_000) }).where(eq(messages.id, old.id));
  assert.deepEqual(await both(fx.headers, old.id), [404, 404], "older than the plan's history window");
  assert.deepEqual(await both(fx.headers, randomUUID()), [404, 404], "unknown message");
  assert.equal((await post(app.baseUrl, fx, readBody(), "not-a-uuid")).status, 404);
  assert.equal(calls.length, 0, "no App call for any of these");

  for (const [body, why] of [
    [readBody({ view_instance_id: undefined }), "missing view_instance_id"], [readBody({ view_instance_id: "view-1" }), "view_instance_id not a UUID"],
    [readBody({ capabilities: "card.v2" }), "capabilities not a list"], [readBody({ capabilities: [1] }), "a capability not a string"],
    [readBody({ capabilities: Array.from({ length: 17 }, (_, i) => `c${i}`) }), "too many capabilities"], [readBody({ capabilities: undefined }), "missing capabilities"],
    [readBody({ locale: "zh_CN!" }), "bad locale"], [readBody({ locale: undefined }), "missing locale"],
    [readBody({ url: `${origin}/pr/1` }), "an unknown field"], [readBody({ urls: Array.from({ length: 11 }, (_, i) => `${origin}/pr/${i}`) }), "more than ten urls"],
    [readBody({ urls: `${origin}/pr/1` as never }), "urls not a list"], [readBody({ tickets: [] as never }), "tickets not an object"],
    [readBody({ tickets: { [`${origin}/pr/1`]: 1 } as never }), "a ticket not a string"], [[readBody()], "not an object"],
    [`{"view_instance_id":"${VIEW}","capabilities":[],"locale":"en","__proto__":{"urls":[]}}`, "a __proto__ field is an unknown field"],
    ["{not json", "malformed JSON"],
  ] as const) {
    const response = await post(app.baseUrl, fx, body);
    assert.equal(response.status, 400, why);
    assert.equal(response.headers.get("cache-control"), "private, no-store", why);
  }
  const huge = JSON.stringify(readBody({ tickets: { [`${origin}/pr/1`]: "t".repeat(LINK_CARD_READ_MAX_BODY_BYTES) } }));
  assert.equal((await post(app.baseUrl, fx, huge)).status, 413, "refused before parsing");
  assert.equal(calls.length, 0);
  assert.equal((await post(app.baseUrl, fx, readBody({ capabilities: [], urls: [`${origin}/pr/1`], tickets: {} }))).status, 200, "the smallest valid body");
});

test("canView decides for every conversation kind: a thread follows its private parent, a DM its participants, a member reads", async ({ app, db, seed }) => {
  const origin = "https://kinds.example.test";
  const fx = await connected(db, seed, { key: "cards-kinds", origin, content: `${origin}/pr/1` });
  stubApp(() => v1Card);
  const both = async (headers: Record<string, string>, messageId: string) => [
    (await fetch(`${app.baseUrl}/api/messages/${messageId}/app-link-previews`, { headers })).status,
    (await post(app.baseUrl, { headers, message: { id: messageId } })).status,
  ];
  const member = await seed.human();
  await addMember(fx.server.id, member.id);
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: member.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  const memberHeaders = { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(member.email)}` };

  const privateChannel = await seed.channel({ server: fx.server, members: [fx.owner], visibility: "private" });
  const parent = await seed.message({ channel: privateChannel, author: fx.owner, content: "parent" });
  const thread = await getOrCreateThread(parent.id, fx.owner.id, "user");
  const threadMessage = await createMessage(thread.id, "user", fx.owner.id, `${origin}/pr/2`);
  const [dm] = await db.insert(channels).values({ serverId: fx.server.id, name: `dm-${randomUUID().slice(0, 8)}`, type: "dm" }).returning();
  await addHuman(dm!.id, fx.owner.id);
  const dmMessage = await createMessage(dm!.id, "user", fx.owner.id, `${origin}/pr/3`);

  assert.deepEqual(await both(memberHeaders, threadMessage.id), [404, 404], "a thread of a private channel the viewer is not in");
  assert.deepEqual(await both(memberHeaders, dmMessage.id), [404, 404], "a DM the viewer is not in");
  assert.deepEqual(await both(fx.headers, threadMessage.id), [200, 200], "the private channel's member reads its thread");
  assert.deepEqual(await both(fx.headers, dmMessage.id), [200, 200], "the DM's participant reads it");
  await addHuman(privateChannel.id, member.id);
  assert.deepEqual(await both(memberHeaders, threadMessage.id), [200, 200], "joining the private channel opens its thread");
});

test("prompts are the GET's prompts, and the App icon is the one Raft stores", async ({ app, db, seed }) => {
  const origin = "https://prompt.example.test";
  const fx = await connected(db, seed, { key: "cards-prompt", origin, content: "", logo: "https://cdn.example.test/cards.webp" });
  const other = await createOAuthClient({ serverId: fx.server.id, createdByUserId: fx.owner.id, clientId: "cards-unasked", name: "Unasked" });
  await db.update(oauthClients).set({ logoUrl: "https://cdn.example.test/unasked.webp" }).where(eq(oauthClients.id, other.client.id));
  await db.insert(oauthClientInstalls).values({ clientId: other.client.id, serverId: fx.server.id, installedByUserId: fx.owner.id });
  await db.insert(oauthAppLinkPreviews).values({ clientId: other.client.id, origin: "https://unasked.example.test", endpoint: "https://unasked.example.test/callback", paths: ["/pr"] });
  const message = await seed.message({ channel: fx.channel, author: fx.owner, content: `https://unasked.example.test/pr/1 ${origin}/pr/1 https://unasked.example.test/pr/2` });
  const calls = stubApp(() => v1Card);
  const get = await (await fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers: fx.headers })).json() as { prompts: unknown[] };
  const posted = await read(app.baseUrl, { ...fx, message }, readBody({ capabilities: [] }));
  assert.deepEqual(posted.prompts, get.prompts);
  assert.deepEqual(posted.prompts, [{ url: "https://unasked.example.test/pr/1", app: { id: other.client.id, name: "Unasked", icon: "https://cdn.example.test/unasked.webp" } }]);
  assert.ok(calls.every((call) => call.url === `${origin}/callback`), "a prompt never calls its App");
  assert.deepEqual(posted.items.map((item) => item.app), [{ id: fx.client.id, name: "cards-prompt App", icon: "https://cdn.example.test/cards.webp" }]);
});

limitedTest("reads do not spend the message-sending budget", async ({ app, db, seed }) => {
  const origin = "https://budget-free.example.test";
  const fx = await connected(db, seed, { key: "cards-budget-free", origin, content: `${origin}/pr/1` });
  stubApp(() => v1Card);
  for (let i = 0; i < 3; i++) assert.equal((await post(app.baseUrl, fx)).status, 200);
  const sent = await fetch(`${app.baseUrl}/api/messages`, { method: "POST", headers: fx.headers, body: JSON.stringify({ channelId: fx.channel.id, content: "hello" }) });
  assert.ok(sent.status === 200 || sent.status === 201, `${sent.status} ${await sent.clone().text()}`);
});
