// GET /api/integrations/marketplace/listings: the Marketplace's Apps and
// Raft-recommended MCP App templates, ranked and paged, while
// GET /api/integrations/marketplace keeps answering its App array.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { MARKETPLACE_INSTALL_BUCKETS, type MarketplaceListingsResponse } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { managedMcpServers, mcpAppTemplates, oauthClientInstalls, oauthClients, users } from "../db/schema";
import { createOAuthClient } from "../services/oauthService";
import { addMember, createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;
/** The active rows of mcp_app_templates in a migrated database. */
const SEEDED_TEMPLATE_COUNT = 19;

type AppRecord = { id: string } & Record<string, unknown>;
type ListingsBody = MarketplaceListingsResponse<AppRecord>;

async function seedUser(label: string) {
  const email = `${label}-${randomUUID()}@slock.test`;
  const [user] = await getDb().insert(users).values({
    email,
    name: label,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return { ...user!, token: await tokenForHuman(email) };
}

async function seedApp(input: {
  sourceServerId: string;
  ownerId: string;
  name: string;
  publishReviewedAt: Date;
  installServerIds: string[];
  publicListing?: boolean;
  category?: string;
}) {
  const { client } = await createOAuthClient({
    serverId: input.sourceServerId,
    createdByUserId: input.ownerId,
    appType: "third_party_global",
    clientId: `mkt-${randomUUID().slice(0, 12)}`,
    name: input.name,
    description: `${input.name} does things.`,
    homepageUrl: "https://listing.example.test",
    returnUrl: "https://listing.example.test/callback",
    category: input.category ?? "Other",
  });
  const publicListing = input.publicListing ?? true;
  await getDb().update(oauthClients).set({
    publishStatus: publicListing ? "published" : "private",
    humanMarketplaceVisible: publicListing,
    publishReviewedAt: input.publishReviewedAt,
  }).where(eq(oauthClients.id, client.id));
  if (input.installServerIds.length > 0) {
    await getDb().insert(oauthClientInstalls).values(input.installServerIds.map((serverId) => ({
      serverId,
      clientId: client.id,
      installedByUserId: input.ownerId,
      status: "active" as const,
    })));
  }
  return client;
}

async function seedMcpApp(serverId: string, templateKey: string) {
  await getDb().insert(managedMcpServers).values({
    serverId,
    name: `${templateKey} ${randomUUID().slice(0, 6)}`,
    endpointUrl: `https://${templateKey}.example.test/mcp`,
    sourceKind: "template",
    templateKey,
  });
}

/**
 * Viewer server V, publishing server S, installing servers I1..I3 and C1..C10. Apps from S, with
 * installs on servers other than S and the days since their review:
 *
 * | App           | installs                   | count | bucket  | reviewed |
 * | Xray          | C1..C10                    | 10    | 10_plus | 15       |
 * | Zulu          | C1..C10, I1                | 11    | 10_plus | 20       |
 * | Yankee        | C1..C9                     | 9     | none    | 3        |
 * | Alpha         | V, I1, I2, I3              | 4     | none    | 10       |
 * | Bravo         | I1 (Developer Tools)       | 1     | none    | 1        |
 * | Twin, Twin    | I2 / I3                    | 1     | none    | 5 (same) |
 * | Private Share | V (private)                | 1     | none    | 2        |
 *
 * MCP: figma is used on C1..C10 (10_plus), linear on V and I1, notion on I1.
 * By exact count Zulu, Xray, Yankee, Alpha would lead; by bucket then newest it is Xray, Zulu, Bravo.
 */
async function seedMarketplace() {
  const owner = await seedUser("mkt-owner");
  const suffix = randomUUID().slice(0, 8);
  const viewer = await createServer("Marketplace Viewer", `mkt-viewer-${suffix}`, owner.id);
  const source = await createServer("Marketplace Source", `mkt-source-${suffix}`, owner.id);
  const installs = [];
  for (let index = 1; index <= 3; index += 1) {
    installs.push(await createServer(`Marketplace Install ${index}`, `mkt-install-${index}-${suffix}`, owner.id));
  }
  const [i1, i2, i3] = installs.map((server) => server.id) as [string, string, string];
  const crowd: string[] = [];
  for (let index = 1; index <= 10; index += 1) {
    crowd.push((await createServer(`Marketplace Crowd ${index}`, `mkt-crowd-${index}-${suffix}`, owner.id)).id);
  }
  const now = Date.now();
  const twinReviewedAt = new Date(now - 5 * DAY_MS);
  const app = (name: string, publishReviewedAt: Date, installServerIds: string[], publicListing?: boolean, category?: string) => seedApp({
    sourceServerId: source.id,
    ownerId: owner.id,
    name,
    publishReviewedAt,
    installServerIds,
    publicListing,
    category,
  });
  const alpha = await app("Alpha", new Date(now - 10 * DAY_MS), [viewer.id, i1, i2, i3]);
  const bravo = await app("Bravo", new Date(now - DAY_MS), [i1], true, "Developer Tools");
  const twinA = await app("Twin", twinReviewedAt, [i2]);
  const twinB = await app("Twin", twinReviewedAt, [i3]);
  const privateShare = await app("Private Share", new Date(now - 2 * DAY_MS), [viewer.id], false);
  const xray = await app("Xray", new Date(now - 15 * DAY_MS), crowd);
  const zulu = await app("Zulu", new Date(now - 20 * DAY_MS), [...crowd, i1]);
  const yankee = await app("Yankee", new Date(now - 3 * DAY_MS), crowd.slice(0, 9));
  await seedMcpApp(viewer.id, "linear");
  await seedMcpApp(i1, "linear");
  await seedMcpApp(i1, "notion");
  for (const serverId of crowd) await seedMcpApp(serverId, "figma");
  // Tie on installs, publish time and name: the listing id decides.
  const twins = twinA.id < twinB.id ? [twinA, twinB] as const : [twinB, twinA] as const;
  return { owner, viewer, source, alpha, bravo, twins, privateShare, xray, zulu, yankee, now };
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" };
}

/** Keys holding a number of installs (or anything counted) anywhere in a value. */
function countKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => countKeys(entry, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(/count/iu.test(key) ? [`${path}.${key}`] : []),
    ...countKeys(entry, `${path}.${key}`),
  ]);
}

/**
 * Install counts are buckets only (yezizp d7080dad): no count in an answer, and a cursor holds
 * nothing but its filters, sort and the last item's position, whose install part is a bucket rank.
 */
function assertNoExactCounts(body: ListingsBody) {
  assert.deepEqual(countKeys(body), [], "no count in the answer");
  for (const item of body.items) {
    assert.ok(item.installBucket === null || MARKETPLACE_INSTALL_BUCKETS.includes(item.installBucket), item.id);
  }
  if (body.nextCursor === null) return;
  const cursor = JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf8")) as { after: Record<string, unknown> };
  assert.deepEqual(Object.keys(cursor), ["type", "category", "sort", "q", "after"]);
  assert.deepEqual(Object.keys(cursor.after), ["installRank", "publishedAt", "name", "id"], "no count in the cursor");
  const last = body.items.at(-1)!;
  assert.equal(cursor.after.installRank, last.installBucket === null ? 0 : MARKETPLACE_INSTALL_BUCKETS.indexOf(last.installBucket) + 1);
}

async function getListings(baseUrl: string, token: string, serverId: string, params: Array<[string, string | number]> = []) {
  const url = new URL(`${baseUrl}/api/integrations/marketplace/listings`);
  for (const [name, value] of params) url.searchParams.append(name, String(value));
  const response = await fetch(url, { headers: headers(token, serverId) });
  const text = await response.text();
  const body = JSON.parse(text) as ListingsBody & { code?: string };
  if (response.status === 200) assertNoExactCounts(body);
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body };
}

function appIds(body: ListingsBody, among: Array<{ id: string }>): string[] {
  const wanted = new Set(among.map((client) => client.id));
  return body.items.flatMap((item) => (item.kind === "app" && wanted.has(item.app.id) ? [item.app.id] : []));
}

test("GET /api/integrations/marketplace keeps its App array; listings carry the same App record", async ({ app }) => {
  const f = await seedMarketplace();
  const readArray = async (query: string) => {
    const response = await fetch(`${app.baseUrl}/api/integrations/marketplace${query}`, { headers: headers(f.owner.token, f.viewer.id) });
    assert.equal(response.status, 200);
    return await response.json() as AppRecord[];
  };

  const array = await readArray("");
  assert.ok(Array.isArray(array), "the no-parameter answer is a bare array");
  const alpha = array.find((client) => client.id === f.alpha.id);
  assert.ok(alpha);
  // The wire contract older Web builds read, key for key and in order (bytes follow key order).
  assert.deepEqual(Object.keys(alpha), [
    "id", "serverId", "clientId", "appType", "publishStatus", "category", "dataAccessSummary", "publishRejectionReason",
    "name", "description", "whenToUse", "homepageUrl", "returnUrl", "agentManifestUrl", "setupUrl", "setupDescription",
    "setupRevision", "allowedScopes", "logoUrl", "humanMarketplaceVisible", "enableBot", "createdByUserId", "createdAt",
    "updatedAt", "promptTextRevisionId", "promptTextPendingRevisionId", "installationId", "installedAt", "installStatus",
    "botGrant", "publisherName", "publisherServerName", "privateShared", "appNotificationGroups", "appNotificationEvents",
    "appNotificationReviewPending", "appNotificationPendingRevisionId", "appNotificationPendingGroups",
    "appNotificationPendingEvents", "official", "purpose", "permissionApprovalRequired", "promptTextConfirmationRequired",
    "marketplaceInstallBadge", "needsAdminReview",
  ]);
  assert.equal(array.some((client) => "kind" in client || "installCount" in client), false, "no listing fields leak into the array");
  assert.ok(array.some((client) => client.id === f.privateShare.id), "the array still lists a private share installed here");
  // The old route ignores the listing's parameters: still the same array.
  assert.deepEqual(await readArray("?type=mcp&sort=name&limit=1"), array);

  const listings = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["type", "app"], ["limit", 100]]);
  assert.equal(listings.status, 200);
  assert.equal(listings.cacheControl, "private, no-store");
  const alphaListing = listings.body.items.find((item) => item.kind === "app" && item.app.id === f.alpha.id);
  assert.ok(alphaListing && alphaListing.kind === "app");
  // `needsAdminReview` is an installed-App signal for admins (/marketplace and
  // /clients rows); listings do not carry it.
  const { needsAdminReview: _needsAdminReview, ...alphaRecord } = alpha;
  assert.deepEqual(alphaListing.app, alphaRecord, "a listing's app is the array's record, unchanged");
  assert.equal(alphaListing.id, `app:${f.alpha.id}`);
  assert.equal(alphaListing.name, "Alpha");
  assert.equal(alphaListing.publisherName, "Marketplace Source");
  assert.equal(alphaListing.installBucket, null, "4 installs: below the first bucket, as the badge shows none");
  assert.equal(alphaListing.installed, true);
  assert.equal(alphaListing.publishedAt, (await getDb().select({ at: oauthClients.publishReviewedAt }).from(oauthClients).where(eq(oauthClients.id, f.alpha.id)))[0]!.at!.toISOString());
  const bravoListing = listings.body.items.find((item) => item.kind === "app" && item.app.id === f.bravo.id);
  assert.equal(bravoListing?.installed, false);
  // Bucket boundary, and the bucket is the card's badge: 9 installs has none, 10 and 11 are 10+.
  const bucketOf = (client: { id: string }) => {
    const item = listings.body.items.find((entry) => entry.kind === "app" && entry.app.id === client.id);
    assert.ok(item && item.kind === "app");
    return { bucket: item.installBucket, badge: item.app.marketplaceInstallBadge };
  };
  assert.deepEqual(bucketOf(f.yankee), { bucket: null, badge: { kind: "new" } });
  assert.deepEqual(bucketOf(f.xray), { bucket: "10_plus", badge: { kind: "bucket", bucket: "10_plus" } });
  assert.deepEqual(bucketOf(f.zulu), { bucket: "10_plus", badge: { kind: "bucket", bucket: "10_plus" } });
  assert.equal(
    listings.body.items.some((item) => item.kind === "app" && item.app.id === f.privateShare.id),
    false,
    "a private share is Settings' installed list, never the Marketplace",
  );
});

test("type and category filter Apps and MCP App templates; q searches name and description; total counts the filtered listing", async ({ app }) => {
  const f = await seedMarketplace();
  const list = (params: Array<[string, string | number]>) => getListings(app.baseUrl, f.owner.token, f.viewer.id, [["limit", 100], ...params]);

  const mcp = await list([["type", "mcp"]]);
  assert.equal(mcp.status, 200);
  assert.equal(mcp.body.total, SEEDED_TEMPLATE_COUNT);
  assert.equal(mcp.body.items.length, SEEDED_TEMPLATE_COUNT);
  assert.ok(mcp.body.items.every((item) => item.kind === "mcp"));
  const linear = mcp.body.items.find((item) => item.kind === "mcp" && item.templateKey === "linear");
  assert.deepEqual(linear && { ...linear, publishedAt: typeof linear.publishedAt }, {
    id: "mcp:linear",
    kind: "mcp",
    name: "Linear",
    description: linear?.description,
    logoUrl: linear?.logoUrl,
    category: "Productivity & Collaboration",
    installBucket: null,
    publishedAt: "string",
    installed: true,
    templateKey: "linear",
    homepageUrl: "https://linear.app",
  });
  const notion = mcp.body.items.find((item) => item.id === "mcp:notion");
  assert.equal(notion?.installBucket, null);
  assert.equal(notion?.installed, false, "an MCP App on another server is not installed here");
  const figma = mcp.body.items.find((item) => item.id === "mcp:figma");
  assert.deepEqual([figma?.installBucket, figma?.installed], ["10_plus", false], "templates use the same buckets: 10 servers is 10+");

  const apps = await list([["type", "app"]]);
  assert.ok(apps.body.items.length >= 4);
  assert.ok(apps.body.items.every((item) => item.kind === "app"));

  const all = await list([]);
  assert.equal(all.body.total, apps.body.total + mcp.body.total, "type defaults to all");
  assert.ok(all.body.items.some((item) => item.kind === "app") && all.body.items.some((item) => item.kind === "mcp"));

  // Every seeded template is Productivity & Collaboration; an admin recategorizes one.
  await getDb().update(mcpAppTemplates).set({ category: "Developer Tools" }).where(eq(mcpAppTemplates.key, "sentry"));
  const productivity = await list([["type", "mcp"], ["category", "Productivity & Collaboration"]]);
  assert.ok(productivity.body.items.every((item) => item.category === "Productivity & Collaboration"));
  assert.equal(productivity.body.total, SEEDED_TEMPLATE_COUNT - 1);
  assert.equal(productivity.body.total, productivity.body.items.length);
  const developerTools = await list([["category", "Developer Tools"]]);
  assert.ok(developerTools.body.items.every((item) => item.category === "Developer Tools"));
  assert.ok(developerTools.body.items.some((item) => item.id === `app:${f.bravo.id}`));
  assert.ok(developerTools.body.items.some((item) => item.id === "mcp:sentry"));
  assert.equal(developerTools.body.items.some((item) => item.id === `app:${f.alpha.id}`), false);
  const developerToolsApps = await list([["category", "Developer Tools"], ["type", "app"]]);
  const developerToolsMcp = await list([["category", "Developer Tools"], ["type", "mcp"]]);
  assert.equal(developerTools.body.total, developerToolsApps.body.total + developerToolsMcp.body.total);
  const pagedDeveloperTools = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["category", "Developer Tools"], ["limit", 1]]);
  assert.equal(pagedDeveloperTools.body.items.length, 1);
  assert.equal(pagedDeveloperTools.body.total, developerTools.body.total, "total is before paging");

  const twin = await list([["q", "  tWiN  "]]);
  assert.deepEqual(twin.body.items.map((item) => item.id).sort(), f.twins.map((client) => `app:${client.id}`).sort());
  assert.equal(twin.body.total, 2);
  const description = await list([["q", "bravo does"]]);
  assert.deepEqual(description.body.items.map((item) => item.id), [`app:${f.bravo.id}`]);
  const linearIssues = await list([["q", "LINEAR ISSUES"]]);
  assert.deepEqual(linearIssues.body.items.map((item) => item.id), ["mcp:linear"], "templates match on their description too");
});

test("each sort is a total order: installs by bucket then newest, then name, then listing id", async ({ app }) => {
  const f = await seedMarketplace();
  const [twinLow, twinHigh] = f.twins;
  const fixture = [f.alpha, f.bravo, twinLow, twinHigh, f.xray, f.yankee, f.zulu];
  const order = async (params: Array<[string, string]>) => {
    const { status, body } = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["type", "app"], ["limit", 100], ...params]);
    assert.equal(status, 200);
    return appIds(body, fixture);
  };

  // 10+ first, newest first inside it (Xray before Zulu's 11), then the rest newest first, not by count.
  const byInstalls = [f.xray.id, f.zulu.id, f.bravo.id, f.yankee.id, twinLow.id, twinHigh.id, f.alpha.id];
  assert.deepEqual(await order([["sort", "installs"]]), byInstalls, "bucket, then newest; same time and name by id");
  assert.deepEqual(await order([]), byInstalls, "installs is the default");
  const byPublished = [f.bravo.id, f.yankee.id, twinLow.id, twinHigh.id, f.alpha.id, f.xray.id, f.zulu.id];
  assert.deepEqual(await order([["sort", "published"]]), byPublished, "newest first; same time and name by id");
  assert.deepEqual(await order([["sort", "name"]]), [f.alpha.id, f.bravo.id, twinLow.id, twinHigh.id, f.xray.id, f.yankee.id, f.zulu.id]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await order([["sort", "installs"]]), byInstalls, "the same order on every read");
  }

  const mcp = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["type", "mcp"], ["limit", 100]]);
  assert.equal(mcp.body.items[0]?.id, "mcp:figma", "the one 10+ template leads");
  const rest = mcp.body.items.slice(1);
  const newestThenName = [...rest].sort((a, b) => (Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))
    || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  assert.deepEqual(rest.map((item) => item.id), newestThenName.map((item) => item.id), "below a bucket, newest then name: linear's 2 servers do not count");
});

test("cursors walk every listing without duplicates or gaps and hold their place", async ({ app }) => {
  const f = await seedMarketplace();
  for (const sort of ["installs", "published", "name"]) {
    const whole = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["sort", sort], ["limit", 100]]);
    assert.equal(whole.status, 200);
    assert.equal(whole.body.nextCursor, null);
    assert.equal(whole.body.items.length, whole.body.total);
    assert.ok(whole.body.total > 5 * 4, "enough items for several pages");

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [
        ["sort", sort],
        ["limit", 5],
        ...(cursor ? [["cursor", cursor] as [string, string]] : []),
      ]);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.total, whole.body.total);
      assert.ok(page.body.items.length <= 5);
      walked.push(...page.body.items.map((item) => item.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    assert.equal(pages, Math.ceil(whole.body.total / 5), sort);
    assert.equal(new Set(walked).size, walked.length, `${sort}: no item twice`);
    assert.deepEqual(walked, whole.body.items.map((item) => item.id), `${sort}: the pages are the whole listing, in order`);
  }

  // A cursor is a position, not an offset: an App added ahead of it does not repeat the last item.
  const fixtureOnly: Array<[string, string]> = [["type", "app"], ["sort", "name"], ["q", "does things."], ["limit", "2"]];
  const first = await getListings(app.baseUrl, f.owner.token, f.viewer.id, fixtureOnly);
  assert.deepEqual(first.body.items.map((item) => item.name), ["Alpha", "Bravo"]);
  await seedApp({ sourceServerId: f.source.id, ownerId: f.owner.id, name: "Aardvark", publishReviewedAt: new Date(), installServerIds: [] });
  const second = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [...fixtureOnly, ["cursor", first.body.nextCursor!]]);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.items.map((item) => item.id), f.twins.map((client) => `app:${client.id}`), "continues after Bravo");
  assert.equal(second.body.total, first.body.total + 1, "total counts the new App");
  const restarted = await getListings(app.baseUrl, f.owner.token, f.viewer.id, fixtureOnly);
  assert.equal(restarted.body.items[0]?.name, "Aardvark");
});

test("bad type, sort, limit, q or cursor answer 400 with a code", async ({ app }) => {
  const f = await seedMarketplace();
  const expect400 = async (params: Array<[string, string]>, code: string) => {
    const response = await getListings(app.baseUrl, f.owner.token, f.viewer.id, params);
    assert.equal(response.status, 400, JSON.stringify(params));
    assert.equal(response.body.code, code, JSON.stringify(params));
  };
  await expect400([["type", "plugin"]], "INVALID_REQUEST");
  await expect400([["sort", "popular"]], "INVALID_REQUEST");
  await expect400([["sort", "INSTALLS"]], "INVALID_REQUEST");
  await expect400([["category", "Productivity"]], "INVALID_REQUEST");
  for (const limit of ["0", "101", "-1", "1.5", "ten", ""]) await expect400([["limit", limit]], "INVALID_REQUEST");
  await expect400([["type", "app"], ["type", "mcp"]], "INVALID_REQUEST");
  await expect400([["q", "x".repeat(201)]], "INVALID_REQUEST");
  await expect400([["cursor", "not-a-cursor"]], "INVALID_CURSOR");
  const forged = (after: Record<string, unknown>) => Buffer.from(JSON.stringify({ type: "all", category: null, sort: "installs", q: null, after })).toString("base64url");
  await expect400([["cursor", forged({ installRank: 0, publishedAt: null, name: "x", id: "nope:x" })]], "INVALID_CURSOR");
  // A cursor carries a bucket rank, never a count: an exact count is not a cursor.
  await expect400([["cursor", forged({ installCount: 11, publishedAt: null, name: "x", id: "app:x" })]], "INVALID_CURSOR");
  await expect400([["cursor", forged({ installRank: 11, publishedAt: null, name: "x", id: "app:x" })]], "INVALID_CURSOR");
  await expect400([["cursor", forged({ installRank: 1, installCount: 11, publishedAt: null, name: "x", id: "app:x" })]], "INVALID_CURSOR");
  const okForged = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["cursor", forged({ installRank: 1, publishedAt: null, name: "x", id: "app:x" })]]);
  assert.equal(okForged.status, 200, "a rank in range is a cursor");

  const page = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["sort", "name"], ["limit", 3]]);
  const cursor = page.body.nextCursor!;
  assert.ok(cursor);
  await expect400([["sort", "installs"], ["limit", "3"], ["cursor", cursor]], "INVALID_CURSOR");
  await expect400([["sort", "name"], ["type", "app"], ["cursor", cursor]], "INVALID_CURSOR");
  await expect400([["sort", "name"], ["q", "twin"], ["cursor", cursor]], "INVALID_CURSOR");
  await expect400([["sort", "name"], ["category", "Other"], ["cursor", cursor]], "INVALID_CURSOR");
  const resumed = await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["sort", "name"], ["limit", 7], ["cursor", cursor]]);
  assert.equal(resumed.status, 200, "limit may change between pages");
  assert.equal(await getListings(app.baseUrl, f.owner.token, f.viewer.id, [["limit", "100"], ["q", "   "]]).then((r) => r.status), 200, "a blank q lists everything");
});

test("any member sees MCP templates in the Marketplace; adding one stays a manageIntegrations action", async ({ app }) => {
  const f = await seedMarketplace();
  const member = await seedUser("mkt-member");
  await addMember(f.viewer.id, member.id, "member");
  const outsider = await seedUser("mkt-outsider");

  const memberView = await getListings(app.baseUrl, member.token, f.viewer.id, [["type", "mcp"], ["limit", 100]]);
  assert.equal(memberView.status, 200);
  assert.equal(memberView.body.total, SEEDED_TEMPLATE_COUNT);
  const figma = memberView.body.items.find((item) => item.id === "mcp:figma");
  assert.ok(figma && figma.kind === "mcp");
  assert.equal(figma.installed, false);
  assert.equal("endpointUrl" in figma, false, "the listing carries no endpoint");

  // Unchanged gates: the template picker and adding an MCP App need manageIntegrations.
  assert.equal((await fetch(`${app.baseUrl}/api/mcp/app-templates`, { headers: headers(member.token, f.viewer.id) })).status, 403);
  // The editor's template flow, from the listing alone: the key, and the Profile it prefills.
  const addAs = (token: string) => fetch(`${app.baseUrl}/api/mcp/apps`, {
    method: "POST",
    headers: headers(token, f.viewer.id),
    body: JSON.stringify({
      source: { kind: "template", templateKey: figma.templateKey },
      profile: { name: figma.name, description: figma.description, homepageUrl: figma.homepageUrl, category: figma.category },
    }),
  });
  assert.equal((await addAs(member.token)).status, 403);
  const added = await addAs(f.owner.token);
  assert.equal(added.status, 201, await added.clone().text());
  const afterAdd = await getListings(app.baseUrl, member.token, f.viewer.id, [["type", "mcp"], ["q", "figma"]]);
  assert.deepEqual(afterAdd.body.items.map((item) => [item.id, item.installed, item.installBucket]), [["mcp:figma", true, "10_plus"]]);

  assert.equal((await getListings(app.baseUrl, outsider.token, f.viewer.id)).status, 403, "not a member of the server");
  const anonymous = await fetch(`${app.baseUrl}/api/integrations/marketplace/listings`, { headers: { "X-Server-Id": f.viewer.id } });
  assert.equal(anonymous.status, 401);
});
