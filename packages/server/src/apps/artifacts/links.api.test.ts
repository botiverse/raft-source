// A version's links to other Artifacts and what each names for the reader
// (linkTargets.ts; #proj-workspace:#336), over HTTP at the paths the shared
// contract builds (artifactWebPaths.links, artifactPublicPaths.links), with
// Artifacts pushed through the agent API with real agent credentials and read
// with real user tokens. Proves: `ok` with the live title (a rename shows at
// once) and kind; a pinned version's existence as the viewer reads it (only
// the current one outside a public target's server); `deleted` exactly where
// a message card says so (the reader could see it, a delete on record, never
// a takedown, a public one only to its own server); one `unavailable` for
// every other reason, a target the reader can't see and one that doesn't
// exist alike; the signed-out route names only targets a visitor may view,
// never `deleted`; an older version's links read on the fly (nothing stored);
// the current version's filled when asked; no link to itself; at most 200,
// their targets in a constant number of queries; the source's own refusals
// as the viewer's; 503 when the links can't be read; the per-user limit; and
// `authorSees`: whether the version's author (its publisher) sees each target
// now, false once it lost sight of one or its account is gone, true for every
// link on the signed-out route.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import {
  ARTIFACT_CONTENT_LINKS_MAX,
  artifactLinkId,
  artifactPublicPaths,
  artifactWebPaths,
  asArtifactId,
  asServerId,
  type ArtifactContentLink,
  type ArtifactId,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, objectReferences } from "../../db/schema";
import { OBJECT_REFERENCES_MAX_PER_SOURCE } from "../../platform/references";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { createAgent } from "../../services/agentService";
import { addAgent, addHuman, createChannel, removeAgent } from "../../services/channelService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { CONTENT_LINKS_EXTRACTOR, CONTENT_LINKS_MAX, type ContentLink } from "./contentLinks";
import { linksAnswer } from "./linkTargets";
import { __settlePublicTextFillsForTests } from "./publicText";
import { artifactItems, artifactVersions } from "./schema";
import { takedownArtifact } from "./takedown";
import { webNotVisible } from "./webCommon";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.links": 2 } });

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-links-tests-hmac-secret-0123456789");
});
afterEach(async () => {
  // A push to a public Artifact fills its signed-out text in the background (publicText.ts).
  await __settlePublicTextFillsForTests();
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);
/** The one 404 every route answers for an Artifact the reader can't open (webCommon webNotVisible). */
const NOT_VISIBLE = webNotVisible().body;
/** A link to an Artifact on the canonical app host (every deployment's), in the short form Raft builds. */
const linkTo = (id: string, rest = "") => `https://app.raft.build/artifacts/${artifactLinkId(asArtifactId(id))}${rest}`;

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign() { return null; },
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
  };
}

type Who = { token: string; serverId: string };
type Reply = { status: number; headers: Headers; body: any };

async function web(app: { baseUrl: string }, method: string, path: string, who: Who | null, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(who ? { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/**
 * A server with Artifacts on: #pub (owner, reader, the agent), #secret (owner,
 * the agent); stranger a member of the server in neither (it still sees #pub, a public channel); a peer server whose only member is
 * peerUser. The agent pushes; people read.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const reader = await seed.human();
  const stranger = await seed.human();
  const server = await seed.server({ owner, members: [reader, stranger] });
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const agent = await createAgent(server.id, `links-${label()}`, { runtime: "claude", model: "sonnet" });
  const pub = await createChannel(server.id, `links-pub-${label()}`);
  const secret = await createChannel(server.id, `links-secret-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(pub.id, human.id);
  await addHuman(secret.id, owner.id);
  for (const channel of [pub, secret]) await addAgent(channel.id, agent.id);
  const key = (await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: `links-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const as = async (userId: string, serverId: string = server.id): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId });
  return {
    server, peer, owner, reader, stranger, peerUser, agent, pub, secret, key, r2,
    who: { owner: await as(owner.id), reader: await as(reader.id), stranger: await as(stranger.id), peerUser: await as(peerUser.id, peer.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function agentCall(app: { baseUrl: string }, world: World, body: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${world.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** A new Artifact in `channel` (#pub unless given), one file; its id. */
async function create(app: { baseUrl: string }, world: World, input: { path: string; content: string; channel?: { name: string }; title?: string }): Promise<ArtifactId> {
  const res = await agentCall(app, world, { target: `#${(input.channel ?? world.pub).name}`, title: input.title ?? `Page ${label()}`, files: [{ path: input.path, content: input.content }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return asArtifactId(res.body.artifact.id as string);
}

/** A new version of `id` on `base`, one file replaced. */
async function update(app: { baseUrl: string }, world: World, id: string, base: number, file: { path: string; content: string }) {
  const res = await agentCall(app, world, { artifact: id, base, files: [file] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

/** An Artifact in #pub with one published version (v1, current), written straight to its tables: a target and nothing more. */
async function insertTarget(world: World): Promise<ArtifactId> {
  const id = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({
    id, serverId: asServerId(world.server.id), urlKey: id, name: `extra-${label()}`, title: `Extra ${id.slice(3, 11)}`,
    homeKind: "conversation", homeChannelId: world.pub.id, createdByType: "user", createdById: world.owner.id,
  });
  const versionId = `v_${randomUUID()}`;
  await getDb().insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.md", fileCount: 1, sizeBytes: 1,
    publishDigest: "digest", status: "published", publisherType: "user", publisherId: world.owner.id, position: 1,
  });
  await getDb().update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id));
  return asArtifactId(id);
}

const makePublic = (id: string) => getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, id));
const titleOf = async (id: string) => (await getDb().select({ title: artifactItems.title }).from(artifactItems).where(eq(artifactItems.id, id)))[0]!.title;
const removeAs = (app: { baseUrl: string }, who: Who, id: ArtifactId) => web(app, "DELETE", artifactWebPaths.artifact(id), who);
const linksAs = (app: { baseUrl: string }, who: Who, id: ArtifactId, version?: number) => web(app, "GET", artifactWebPaths.links(id, version), who);
const publicLinks = (app: { baseUrl: string }, id: ArtifactId) => web(app, "GET", artifactPublicPaths.links(id), null);

/** The source's reference rows, as [target id, href]. */
async function rowsOf(id: string) {
  const rows = await getDb().select().from(objectReferences)
    .where(and(eq(objectReferences.sourceKind, "artifact"), eq(objectReferences.sourceId, id)))
    .orderBy(objectReferences.position);
  return rows.map((row) => [row.targetId, row.targetDetail.href]);
}

/** Each version's links mark, by number. */
async function marksOf(itemId: string): Promise<Record<number, number | null>> {
  const rows = await getDb().select({ number: artifactVersions.number, extractor: artifactVersions.referencesExtractor }).from(artifactVersions).where(eq(artifactVersions.itemId, itemId));
  return Object.fromEntries(rows.map((row) => [row.number, row.extractor]));
}

/**
 * Targets of every kind, then a source in #pub (Markdown) linking to them
 * all, one a line: doc (#pub, v1 and v2), hidden (#secret), open (public, v1
 * and v2), gone (#pub, deleted by the owner), goneSecret (#secret, deleted by
 * the owner), goneQuiet (#pub, deleted with no delete on record), down (#pub,
 * taken down), goneOpen (public, deleted by the owner), an id that names
 * nothing, and the source itself.
 */
async function seedLinks(app: { baseUrl: string }, world: World) {
  const doc = await create(app, world, { path: "index.md", content: "# Doc v1" });
  await update(app, world, doc, 1, { path: "index.md", content: "# Doc v2" });
  const hidden = await create(app, world, { path: "index.md", content: "secret", channel: world.secret });
  const open = await create(app, world, { path: "index.html", content: "<h1>open v1</h1>" });
  await update(app, world, open, 1, { path: "index.html", content: "<h1>open v2</h1>" });
  await makePublic(open);
  const gone = await create(app, world, { path: "index.md", content: "gone" });
  const goneSecret = await create(app, world, { path: "index.md", content: "gone secret", channel: world.secret });
  const goneQuiet = await create(app, world, { path: "index.md", content: "gone quietly" });
  const down = await create(app, world, { path: "index.md", content: "down" });
  const goneOpen = await create(app, world, { path: "index.md", content: "gone open" });
  await makePublic(goneOpen);
  const missing = asArtifactId(`pt_${randomUUID()}`);
  const lines = [
    `[the doc](${linkTo(doc)})`,
    `<${linkTo(doc, "/v/1")}>`,
    linkTo(doc, "/v/9"),
    linkTo(hidden),
    linkTo(missing),
    linkTo(open),
    linkTo(open, "/v/1"),
    linkTo(gone),
    linkTo(goneSecret),
    linkTo(goneQuiet),
    linkTo(down),
    linkTo(goneOpen),
  ];
  const source = await create(app, world, { path: "index.md", content: lines.join("\n\n"), title: "Links source" });
  // The source links to itself too (a later version): never a link here.
  await update(app, world, source, 1, { path: "index.md", content: [...lines, linkTo(source)].join("\n\n") });
  // The targets' fates after the source was pushed: decided at each ask, never stored.
  for (const id of [gone, goneSecret, goneOpen]) assert.equal((await removeAs(app, world.who.owner, id)).status, 204);
  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, goneQuiet));
  assert.equal((await takedownArtifact({ kind: "ops", operator: "alice" }, down, "report")).kind, "done");
  return { doc, hidden, open, gone, goneSecret, goneQuiet, down, goneOpen, missing, source };
}

const UNAVAILABLE = { state: "unavailable" };
const DELETED = { state: "deleted" };
/** A link of the source's entry, as the route answers it. */
const linkOf = (id: string, rest: string, target: Record<string, unknown>, opts: { bare?: boolean; version?: number | null; authorSees?: boolean } = {}): ArtifactContentLink => ({
  href: linkTo(id, rest),
  path: "index.md",
  bare: opts.bare ?? true,
  id: asArtifactId(id),
  version: opts.version ?? null,
  target: target as ArtifactContentLink["target"],
  authorSees: opts.authorSees ?? true,
});

test("a member's links: `ok` with the live title and kind, a pinned version's existence, `deleted` where a card says so, one `unavailable` otherwise; private, no-store", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const t = await seedLinks(app, world);
  const [docTitle, openTitle] = [await titleOf(t.doc), await titleOf(t.open)];
  const res = await linksAs(app, world.who.reader, t.source);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(res.body, {
    version: 2,
    links: [
      linkOf(t.doc, "", { state: "ok", title: docTitle, kind: "markdown" }, { bare: false }),
      linkOf(t.doc, "/v/1", { state: "ok", title: docTitle, kind: "markdown", versionExists: true }, { version: 1 }),
      linkOf(t.doc, "/v/9", { state: "ok", title: docTitle, kind: "markdown", versionExists: false }, { version: 9 }),
      // The author (the agent, in #secret too) sees what the reader doesn't: `authorSees` is the author's alone.
      linkOf(t.hidden, "", UNAVAILABLE),
      linkOf(t.missing, "", UNAVAILABLE, { authorSees: false }),
      linkOf(t.open, "", { state: "ok", title: openTitle, kind: "html" }),
      linkOf(t.open, "/v/1", { state: "ok", title: openTitle, kind: "html", versionExists: true }, { version: 1 }),
      linkOf(t.gone, "", DELETED),
      linkOf(t.goneSecret, "", UNAVAILABLE),
      linkOf(t.goneQuiet, "", UNAVAILABLE),
      linkOf(t.down, "", UNAVAILABLE, { authorSees: false }),
      linkOf(t.goneOpen, "", DELETED),
    ],
  }, "in the page's order; no link to the source itself");

  // The owner (in #secret too) is told goneSecret was deleted; nothing else differs.
  const owners = (await linksAs(app, world.who.owner, t.source)).body.links as ArtifactContentLink[];
  assert.deepEqual(owners.find((link) => link.id === t.goneSecret)!.target, DELETED);
  assert.deepEqual(owners.find((link) => link.id === t.hidden)!.target, { state: "ok", title: await titleOf(t.hidden), kind: "markdown" });

  // A rename shows at the next ask: nothing is kept.
  const renamed = await web(app, "PATCH", artifactWebPaths.title(t.doc), world.who.owner, { title: "Renamed doc" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const again = (await linksAs(app, world.who.reader, t.source)).body.links as ArtifactContentLink[];
  assert.deepEqual(again.filter((link) => link.id === t.doc).map((link) => link.target.state === "ok" && link.target.title), ["Renamed doc", "Renamed doc", "Renamed doc"]);
  // Moved out of the reader's sight: unavailable, as one that never existed.
  await getDb().update(artifactItems).set({ homeChannelId: world.secret.id }).where(eq(artifactItems.id, t.doc));
  const moved = (await linksAs(app, world.who.reader, t.source)).body.links as ArtifactContentLink[];
  assert.deepEqual(moved.filter((link) => link.id === t.doc).map((link) => link.target), [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
});

test("one the reader can't see and one that doesn't exist answer alike, whatever the reason; nothing of a deleted one but its state", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const t = await seedLinks(app, world);
  const links = (await linksAs(app, world.who.reader, t.source)).body.links as ArtifactContentLink[];
  const targetOfId = (id: string) => links.find((link) => link.id === id)!.target;
  for (const id of [t.hidden, t.goneSecret, t.goneQuiet, t.down]) {
    assert.deepEqual(targetOfId(id), targetOfId(t.missing), `${id}: exactly a missing id's answer`);
    assert.deepEqual(Object.keys(targetOfId(id)), ["state"]);
  }
  assert.deepEqual(targetOfId(t.gone), { state: "deleted" }, "no title, who or when");
  // The viewer still answers a deleted target the one 404: the links route tells only its state.
  assert.deepEqual((await web(app, "GET", artifactWebPaths.viewer(t.gone), world.who.reader)).body, NOT_VISIBLE);
});

test("another server's reader of a public source: public targets `ok`, their current version only; a deleted public one `unavailable` (deleting withdraws what publishing opened)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const t = await seedLinks(app, world);
  await makePublic(t.source);
  const res = await linksAs(app, world.who.peerUser, t.source);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byHref = new Map((res.body.links as ArtifactContentLink[]).map((link) => [link.href, link.target]));
  const openTitle = await titleOf(t.open);
  assert.deepEqual(byHref.get(linkTo(t.open)), { state: "ok", title: openTitle, kind: "html" });
  assert.deepEqual(byHref.get(linkTo(t.open, "/v/1")), { state: "ok", title: openTitle, kind: "html", versionExists: false }, "an outsider opens its current version only");
  for (const id of [t.doc, t.hidden, t.gone, t.goneOpen, t.missing]) assert.deepEqual(byHref.get(linkTo(id)), UNAVAILABLE, id);
  // The source's own history is the members': an older version is the viewer's 404.
  const older = await linksAs(app, world.who.peerUser, t.source, 1);
  assert.equal(older.status, 404);
  assert.equal(older.body.code, "VERSION_NOT_FOUND");
});

test("signed out: a public source's current links, a target `ok` only when a visitor may view it, never `deleted`; any other source the public view's one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const t = await seedLinks(app, world);
  // Not public yet: the one 404, as for an id that names nothing.
  const closed = await publicLinks(app, t.source);
  assert.equal(closed.status, 404);
  assert.deepEqual(closed.body, NOT_VISIBLE);
  assert.deepEqual(closed.body, (await publicLinks(app, asArtifactId(`pt_${randomUUID()}`))).body);

  await makePublic(t.source);
  const res = await publicLinks(app, t.source);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("set-cookie"), null);
  const openTitle = await titleOf(t.open);
  assert.deepEqual(res.body, {
    version: 2,
    links: [
      linkOf(t.doc, "", UNAVAILABLE, { bare: false }),
      linkOf(t.doc, "/v/1", UNAVAILABLE, { version: 1 }),
      linkOf(t.doc, "/v/9", UNAVAILABLE, { version: 9 }),
      linkOf(t.hidden, "", UNAVAILABLE),
      linkOf(t.missing, "", UNAVAILABLE),
      linkOf(t.open, "", { state: "ok", title: openTitle, kind: "html" }),
      linkOf(t.open, "/v/1", { state: "ok", title: openTitle, kind: "html", versionExists: false }, { version: 1 }),
      linkOf(t.gone, "", UNAVAILABLE),
      linkOf(t.goneSecret, "", UNAVAILABLE),
      linkOf(t.goneQuiet, "", UNAVAILABLE),
      linkOf(t.down, "", UNAVAILABLE),
      linkOf(t.goneOpen, "", UNAVAILABLE),
    ],
  });
  // A credential changes nothing: the route reads none.
  const withToken = await fetch(`${app.baseUrl}${artifactPublicPaths.links(t.source)}`, { headers: { Authorization: `Bearer ${world.who.owner.token}`, "X-Server-Id": world.server.id } });
  assert.deepEqual(await withToken.json(), res.body);
  // A pinned current version exists for a visitor.
  await update(app, world, t.source, 2, { path: "index.md", content: `${linkTo(t.open, "/v/2")}` });
  assert.deepEqual((await publicLinks(app, t.source)).body.links, [linkOf(t.open, "/v/2", { state: "ok", title: openTitle, kind: "html", versionExists: true }, { version: 2 })]);
});

test("an older version's links are read on the fly and nothing is stored; the current version's are its rows", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const doc = await create(app, world, { path: "index.md", content: "# doc" });
  const other = await create(app, world, { path: "index.md", content: "# other" });
  const source = await create(app, world, { path: "index.md", content: `v1 names ${linkTo(doc)}` });
  await update(app, world, source, 1, { path: "index.md", content: `v2 names ${linkTo(other)}` });
  assert.deepEqual(await rowsOf(source), [[other, linkTo(other)]]);

  const v1 = await linksAs(app, world.who.reader, source, 1);
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  assert.deepEqual(v1.body, { version: 1, links: [linkOf(doc, "", { state: "ok", title: await titleOf(doc), kind: "markdown" })] });
  assert.deepEqual(await rowsOf(source), [[other, linkTo(other)]], "v1's links stored nowhere");
  assert.deepEqual(await marksOf(source), { 1: null, 2: CONTENT_LINKS_EXTRACTOR });

  const v2 = await linksAs(app, world.who.reader, source, 2);
  assert.deepEqual(v2.body, { version: 2, links: [linkOf(other, "", { state: "ok", title: await titleOf(other), kind: "markdown" })] });
  assert.deepEqual((await linksAs(app, world.who.reader, source)).body, v2.body, "the current version, asked for by number or not");
});

test("the current version without rows is filled when asked; a version without links answers none", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const doc = await create(app, world, { path: "index.md", content: "# doc" });
  const source = await create(app, world, { path: "index.html", content: `<p><a href="${linkTo(doc)}">the doc</a></p>` });
  // As a version from before links were read: no rows, no mark.
  await getDb().delete(objectReferences).where(eq(objectReferences.sourceId, source));
  await getDb().update(artifactVersions).set({ referencesExtractor: null }).where(eq(artifactVersions.itemId, source));

  const res = await linksAs(app, world.who.reader, source);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.links, [{ ...linkOf(doc, "", { state: "ok", title: await titleOf(doc), kind: "markdown" }, { bare: false }), path: "index.html" }]);
  assert.deepEqual(await rowsOf(source), [[doc, linkTo(doc)]], "stored by the ask");
  assert.deepEqual(await marksOf(source), { 1: CONTENT_LINKS_EXTRACTOR });

  const plain = await create(app, world, { path: "index.md", content: `No links, but one to itself later.` });
  assert.deepEqual((await linksAs(app, world.who.reader, plain)).body, { version: 1, links: [] });
  await update(app, world, plain, 1, { path: "index.md", content: `Only ${linkTo(plain)} here.` });
  assert.deepEqual((await linksAs(app, world.who.reader, plain)).body, { version: 2, links: [] }, "a link to itself is none");
});

test("at most 200 links, and their targets in a constant number of queries however many", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.equal(CONTENT_LINKS_MAX, ARTIFACT_CONTENT_LINKS_MAX);
  assert.equal(OBJECT_REFERENCES_MAX_PER_SOURCE, ARTIFACT_CONTENT_LINKS_MAX);
  const ids = Array.from({ length: 250 }, () => `pt_${randomUUID()}`);
  const source = await create(app, world, { path: "index.md", content: ids.map((id) => linkTo(id)).join("\n\n") });
  const res = await linksAs(app, world.who.reader, source);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.links.length, ARTIFACT_CONTENT_LINKS_MAX);
  assert.deepEqual(res.body.links.map((link: ArtifactContentLink) => link.id), ids.slice(0, ARTIFACT_CONTENT_LINKS_MAX), "the first ones, in order");

  // The targets of few links and of 200, every kind among them (seen, pinned, deleted, hidden, missing): the same queries.
  const t = await seedLinks(app, world);
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, t.source));
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.id, item!.currentVersionId!));
  const reader = { userId: world.reader.id, serverId: asServerId(world.server.id), sessionFamilyId: null };
  const link = (id: string, targetVersion: number | null = null): ContentLink => ({ path: "index.md", href: linkTo(id, targetVersion === null ? "" : `/v/${targetVersion}`), targetId: asArtifactId(id), targetVersion, bare: true });
  // One of every kind of target (a home of each kind among them); then as many links as a version keeps, to 40 more
  // Artifacts the reader sees (each also pinned, to a version it has and one it hasn't) and to ids that name nothing.
  const few = [link(t.doc), link(t.doc, 1), link(t.open), link(t.open, 1), link(t.gone), link(t.goneOpen), link(t.goneSecret), link(t.goneQuiet), link(t.down), link(t.hidden), link(t.missing)];
  const many = [...few, ...few.map((entry) => ({ ...entry, path: "more.md" }))];
  for (let n = 0; n < 40; n += 1) {
    const extra = await insertTarget(world);
    many.push(link(extra), link(extra, 1), link(extra, 5));
  }
  while (many.length < ARTIFACT_CONTENT_LINKS_MAX) many.push(link(`pt_${randomUUID()}`, many.length % 3 === 0 ? many.length : null));
  const small = await countQueries(() => linksAnswer(reader, item!, version!, few));
  const large = await countQueries(() => linksAnswer(reader, item!, version!, many));
  assert.equal(small.value.links.filter((entry) => entry.target.state === "ok").length, 4);
  assert.equal(small.value.links.filter((entry) => entry.target.state === "deleted").length, 2);
  assert.equal(large.value.links.length, ARTIFACT_CONTENT_LINKS_MAX);
  assert.equal(large.value.links.filter((entry) => entry.target.state === "ok").length, 8 + 120, "the 40 more, each three ways");
  assert.equal(large.value.links.filter((entry) => entry.target.state === "ok" && entry.target.versionExists === false).length, 40);
  assert.equal(large.queries, small.queries, `${small.queries} queries for ${few.length} links, ${large.queries} for ${many.length}`);
});

test("`authorSees`: the version's author sees the target now, by the reader's notion of sight; one removed from its conversation, or gone, sees none of them", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const t = await seedLinks(app, world);
  const linksOfOwner = async () => (await linksAs(app, world.who.owner, t.source)).body.links as ArtifactContentLink[];
  const of = (links: readonly ArtifactContentLink[], id: string) => links.find((link) => link.href === linkTo(id))!;

  // The source's author, the agent, is in #pub and #secret: it sees what the owner sees, a deleted one on the home it had;
  // never a taken-down one, nor an id that names nothing.
  const before = await linksOfOwner();
  for (const id of [t.doc, t.hidden, t.open, t.gone, t.goneSecret, t.goneQuiet, t.goneOpen]) assert.equal(of(before, id).authorSees, true, id);
  for (const id of [t.down, t.missing]) assert.equal(of(before, id).authorSees, false, id);

  // Removed from #secret: the owner (in #secret) still sees `hidden` and is told `goneSecret` was deleted, but the author
  // can't see either any more, so neither may be labelled in its page. Targets both see stay true.
  await removeAgent(world.secret.id, world.agent.id);
  const removed = await linksOfOwner();
  assert.deepEqual(of(removed, t.hidden).target, { state: "ok", title: await titleOf(t.hidden), kind: "markdown" });
  assert.equal(of(removed, t.hidden).authorSees, false);
  assert.deepEqual(of(removed, t.goneSecret).target, DELETED);
  assert.equal(of(removed, t.goneSecret).authorSees, false);
  for (const id of [t.doc, t.open, t.gone]) assert.equal(of(removed, id).authorSees, true, id);

  // The author's account gone: none, a public target included; the reader's own answer is as it was.
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, world.agent.id));
  const gone = await linksOfOwner();
  assert.deepEqual(gone.map((link) => link.authorSees), gone.map(() => false));
  assert.deepEqual(of(gone, t.open).target, of(removed, t.open).target);
});

test("the source's refusals are the viewer's: the flag's 403, the one 404 whatever the reason, a malformed or unknown version; reads move no read position", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const t = await seedLinks(app, world);
  // #pub is a public channel, so every member of its server (the stranger too) can open the source: the one 404 comes from #secret.
  const viewer404 = await web(app, "GET", artifactWebPaths.viewer(t.hidden), world.who.stranger);
  assert.equal(viewer404.status, 404);
  for (const [who, id] of [
    [world.who.stranger, t.hidden],
    [world.who.peerUser, t.source],
    [world.who.reader, t.hidden],
    [world.who.reader, t.gone],
    [world.who.reader, t.down],
    [world.who.reader, t.missing],
    [world.who.reader, asArtifactId("not-an-id")],
  ] as Array<[Who, ArtifactId]>) {
    const res = await linksAs(app, who, id);
    assert.equal(res.status, 404, id);
    assert.deepEqual(res.body, viewer404.body, `${id}: the viewer's one 404`);
  }
  const malformed = await web(app, "GET", `${artifactWebPaths.links(t.source)}?version=abc`, world.who.reader);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "INVALID_REQUEST");
  const unknown = await linksAs(app, world.who.reader, t.source, 7);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body.details, { version: 7, currentVersion: 2 });
  assert.equal(unknown.body.code, "VERSION_NOT_FOUND");

  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  for (const id of [t.source, t.missing]) {
    const off = await linksAs(app, world.who.reader, id);
    assert.equal(off.status, 403);
    assert.equal(off.body.code, "ARTIFACTS_NOT_ENABLED");
  }
});

test("links that can't be read now are 503 CONTENT_UNAVAILABLE, never a half answer; the next ask reads them", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const doc = await create(app, world, { path: "index.md", content: "# doc" });
  const source = await create(app, world, { path: "index.md", content: `v1 ${linkTo(doc)}` });
  await update(app, world, source, 1, { path: "index.md", content: `v2 ${linkTo(doc)}` });
  await getDb().delete(objectReferences).where(eq(objectReferences.sourceId, source));
  await getDb().update(artifactVersions).set({ referencesExtractor: null }).where(eq(artifactVersions.itemId, source));
  const healthy = memoryR2(world.r2);
  __setArtifactR2StoreForTests({ ...healthy, read: async () => { throw new Error("storage is down"); } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const version of [undefined, 1]) {
      const res = await linksAs(app, world.who.reader, source, version);
      assert.equal(res.status, 503, `version ${version}`);
      assert.equal(res.body.code, "CONTENT_UNAVAILABLE");
    }
  } finally {
    warn.mockRestore();
  }
  __setArtifactR2StoreForTests(healthy);
  for (const version of [undefined, 1]) assert.equal((await linksAs(app, world.who.reader, source, version)).body.links.length, 1, `version ${version}`);
});

limitedTest("the links route is limited per user on its own budget (429 RATE_LIMITED past it, other users unaffected)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const source = await create(app, world, { path: "index.md", content: "no links" });
  assert.equal((await linksAs(app, world.who.reader, source)).status, 200);
  assert.equal((await linksAs(app, world.who.reader, source)).status, 200);
  const limited = await linksAs(app, world.who.reader, source);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await linksAs(app, world.who.owner, source)).status, 200, "another user's own budget");
  assert.equal((await web(app, "GET", artifactWebPaths.viewer(source), world.who.reader)).status, 200, "not the viewer's");
});

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** The queries `fn` sends, counted at the client (as web.api.test.ts). */
async function countQueries<T>(fn: () => Promise<T>): Promise<{ queries: number; value: T }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let queries = 0;
  pg.query = ((...args: unknown[]) => {
    queries += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    const value = await fn();
    return { queries, value };
  } finally {
    pg.query = originalQuery;
  }
}
