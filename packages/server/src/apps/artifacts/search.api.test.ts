// Artifact search (S9, title only) over HTTP with real agent credentials:
// the index follows the title in the publish's own transaction (also an
// auto-merged publish) and a rename's (indexArtifactSearch), a failed
// transaction leaves it as it was, Chinese titles are found by their
// sub-words and ASCII words by prefix, nothing but the title is searched,
// visibility is in the statement (a hidden best match never shows, on any
// page; deleted, revoked and another DM's Artifacts never do), the relevance
// cursor pages without gaps or repeats, and forged cursors are refused.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { asServerId, type AgentApiArtifactSearchMatch } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { channels } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { indexArtifactSearch } from "./routes";
import { artifactItems, artifactSearch, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-search-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);

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

/**
 * A server with the flag on: the owner, agent A in #pub and #priv and in a
 * DM with the owner, agent C in #pub only (it can't see #priv or that DM),
 * and an agent of another server.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const peer = await seed.server({ owner: await seed.human() });
  const agentA = await createAgent(server.id, `srch-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentC = await createAgent(server.id, `srch-c-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peer.id, `srch-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  const pub = await createChannel(server.id, `pub-${label()}`);
  const priv = await createChannel(server.id, `priv-${label()}`, undefined, "private");
  for (const channel of [pub, priv]) {
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agentA.id);
  }
  await addAgent(pub.id, agentC.id);
  const dm = (await findOrCreateDM(server.id, owner.id, agentA.id))!;
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `srch-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  __setArtifactR2StoreForTests(memoryR2(new Map()));
  return {
    server, serverId: asServerId(server.id), agentA, channels: { pub, priv, dm },
    keys: { a: await key(agentA.id), c: await key(agentC.id), peer: await key(peerAgent.id) },
  };
}

type Reply = { status: number; body: any };

async function call(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const text = (path: string, content: string) => ({ path, content });
const publish = (app: { baseUrl: string }, apiKey: string, body: Record<string, unknown>) => call(app.baseUrl, "POST", "/artifacts/push", apiKey, body);

async function create(app: { baseUrl: string }, apiKey: string, body: Record<string, unknown>): Promise<string> {
  const res = await publish(app, apiKey, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.artifact.id as string;
}

function search(app: { baseUrl: string }, apiKey: string, query: string, extra: Record<string, string> = {}): Promise<Reply> {
  return call(app.baseUrl, "GET", `/artifacts?${new URLSearchParams({ query, ...extra })}`, apiKey);
}

const ids = (reply: Reply): string[] => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return (reply.body.artifacts as Array<{ id: string }>).map((row) => row.id);
};

/**
 * Every page of a search, `limit` a page. Every page but the last is full:
 * a page filtered after LIMIT would come back short.
 */
async function allPages(app: { baseUrl: string }, apiKey: string, query: string, limit: number) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const reply: Reply = await search(app, apiKey, query, { limit: String(limit), ...(cursor ? { cursor } : {}) });
    const rows = ids(reply);
    cursor = reply.body.nextCursor;
    assert.ok(cursor ? rows.length === limit : rows.length >= 1 || page === 0, `page ${page}: ${rows.length} of ${limit}`);
    seen.push(...rows);
    if (!cursor) return seen;
  }
  throw new Error("more than 100 pages");
}

const highlighted = (match: AgentApiArtifactSearchMatch) =>
  match.highlights.map((h) => Array.from(match.snippet).slice(h.start, h.start + h.length).join(""));

async function searchRow(itemId: string) {
  const [row] = await getDb().select().from(artifactSearch).where(eq(artifactSearch.itemId, itemId));
  return row;
}

const INVALID_CURSOR = {
  error: "That cursor doesn't continue this list: a cursor only continues the list or search it came from, so leave it out to start over.",
  code: "agent_api_contract_invalid",
  errorCode: "agent_api_contract_invalid",
};
const cursorOf = (value: unknown[]) => Buffer.from(JSON.stringify(value)).toString("base64url");

// ---- tests ---------------------------------------------------------------------

test("the title is searched, by sub-word and prefix, and nothing else; matches count code points", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const target = `#${world.channels.pub.name}`;
  const report = await create(app, world.keys.a, {
    target, title: "🚀 第三季度财务报告", description: "quarterly numbers",
    entry: "notes.md", files: [text("notes.md", "contentword"), text("pathword.md", "x")],
  });
  const minutes = await create(app, world.keys.a, { target, title: "会议纪要", files: [text("index.md", "x")] });
  const manual = await create(app, world.keys.a, { target, title: "使用手册", files: [text("index.md", "x")] });
  const planning = await create(app, world.keys.a, { target, title: "Planning notes", files: [text("index.md", "x")] });

  for (const word of ["报告", "季度", "财务", "第三季度财务报告"]) assert.deepEqual(ids(await search(app, world.keys.a, word)), [report], word);
  assert.deepEqual(ids(await search(app, world.keys.a, "纪要")), [minutes]);
  assert.deepEqual(ids(await search(app, world.keys.a, "手册")), [manual]);
  assert.deepEqual(ids(await search(app, world.keys.a, "plan")), [planning]);
  assert.deepEqual(ids(await search(app, world.keys.a, "PLANNING NOTES")), [planning]);
  assert.deepEqual(ids(await search(app, world.keys.a, "pl")), [], "two letters: no prefix");
  assert.deepEqual(ids(await search(app, world.keys.a, "plan budget")), [], "every word must match");
  // Title only: description, file contents and paths are not searched.
  for (const word of ["quarterly", "contentword", "pathword", "notes.md"]) assert.deepEqual(ids(await search(app, world.keys.a, word)), [], word);

  const found = await search(app, world.keys.a, "财务");
  const [hit] = found.body.artifacts;
  assert.equal(hit.title, "🚀 第三季度财务报告");
  assert.equal(hit.currentVersion, 1);
  // 🚀 is two UTF-16 units but one code point.
  assert.deepEqual(hit.matches, [{ field: "title", snippet: "🚀 第三季度财务报告", highlights: [{ start: 6, length: 2 }] }]);
  assert.deepEqual(highlighted((await search(app, world.keys.a, "plan")).body.artifacts[0].matches[0]), ["Planning"]);
  // Only punctuation: no words, nothing matches. Without query: no matches field.
  assert.deepEqual(await search(app, world.keys.a, "!!!"), { status: 200, body: { artifacts: [], nextCursor: null, target: null } });
  const plain = await call(app.baseUrl, "GET", "/artifacts", world.keys.a);
  assert.equal(plain.body.artifacts.length, 4);
  assert.equal("matches" in plain.body.artifacts[0], false);
  // Too long a query.
  const tooLong = await search(app, world.keys.a, "🚀".repeat(201));
  assert.equal(tooLong.status, 400);
  assert.deepEqual(tooLong.body.issues, [{ path: "query", message: "query is longer than 200 characters: use fewer words" }]);
});

test("a new version's title replaces the old one, also when the publish is auto-merged", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const id = await create(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: "Alpha draft", entry: "x.md", files: [text("x.md", "x1"), text("y.md", "y1")] });
  const v2 = await publish(app, world.keys.a, { artifact: id, base: 1, title: "Beta draft", files: [text("x.md", "x1b")] });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.deepEqual(ids(await search(app, world.keys.a, "alpha")), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "beta")), [id]);

  // A changes x.md (v3); C, still on v2, renames and changes y.md: merged on top of v3.
  assert.equal((await publish(app, world.keys.a, { artifact: id, base: 2, files: [text("x.md", "x2")] })).status, 201);
  const merged = await publish(app, world.keys.c, { artifact: id, base: 2, title: "Gamma final", files: [text("y.md", "y2")] });
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  assert.equal(merged.body.version.number, 4);
  assert.deepEqual(merged.body.version.merged.map((change: { path: string | null }) => change.path), ["x.md"]);
  assert.deepEqual(ids(await search(app, world.keys.a, "beta")), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "gamma")), [id]);

  // A title alone (no new version) replaces it too.
  const retitled = await publish(app, world.keys.a, { artifact: id, base: 4, title: "Delta final", files: [] });
  assert.equal(retitled.status, 200, JSON.stringify(retitled.body));
  assert.deepEqual(retitled.body.titleChanged, { from: "Gamma final" });
  assert.deepEqual(ids(await search(app, world.keys.a, "gamma")), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "delta")), [id]);
});

/** Make every write of `table` raise (a statement-level trigger) while `run` runs. */
async function refusingWrites(table: string, events: string, run: () => Promise<void>) {
  await getDb().execute(sql.raw(`CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'write refused'; END $$`));
  await getDb().execute(sql.raw(`CREATE TRIGGER refuse_write BEFORE ${events} ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION refuse_write()`));
  try {
    await run();
  } finally {
    await getDb().execute(sql.raw(`DROP TRIGGER refuse_write ON ${table}`));
    await getDb().execute(sql.raw(`DROP FUNCTION refuse_write()`));
  }
}

test("index and version commit together: a failed index write fails the publish, a later failure undoes the index", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const id = await create(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: "Original title", files: [text("index.md", "x")] });
  const before = await searchRow(id);
  const versions = async () => (await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id))).length;

  // A new version, and a title alone (no version): the same transaction as the index either way.
  for (const files of [[text("index.md", "y")], []]) {
    await refusingWrites("app_artifacts.search", "INSERT OR UPDATE", async () => {
      assert.equal((await publish(app, world.keys.a, { artifact: id, base: 1, title: "Unindexed title", files })).status, 500);
    });
    assert.equal(await versions(), 1);
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
    assert.equal(item!.title, "Original title");
  }

  // A failure after the index is written (the object event comes later in the same transaction).
  for (const files of [[text("index.md", "y")], []]) {
    await refusingWrites("object_events", "INSERT", async () => {
      assert.equal((await publish(app, world.keys.a, { artifact: id, base: 1, title: "Replacement title", files })).status, 500);
    });
  }
  assert.equal(await versions(), 1);
  assert.deepEqual(await searchRow(id), before);
  assert.deepEqual(ids(await search(app, world.keys.a, "original")), [id]);
  assert.deepEqual(ids(await search(app, world.keys.a, "replacement")), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "unindexed")), []);
});

test("rename: indexArtifactSearch in the rename's transaction, rolled back with it; deleting the item removes the row", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const id = await create(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: "Old title", files: [text("index.md", "x")] });
  const rename = (title: string, fail: boolean) => getDb().transaction(async (tx) => {
    const [item] = await tx.update(artifactItems).set({ title }).where(eq(artifactItems.id, id)).returning();
    await indexArtifactSearch(tx, item!);
    if (fail) throw new Error("rename refused");
  });
  await assert.rejects(rename("Doomed title", true), /rename refused/);
  assert.deepEqual(ids(await search(app, world.keys.a, "doomed")), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "old")), [id]);
  await rename("Renamed thing", false);
  assert.deepEqual(ids(await search(app, world.keys.a, "old")), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "renamed")), [id]);
  await getDb().delete(artifactItems).where(eq(artifactItems.id, id));
  assert.equal(await searchRow(id), undefined);
});

test("visibility is in the query: a hidden best match is never returned, on any page; target narrows", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const hidden = await create(app, world.keys.a, { target: `#${world.channels.priv.name}`, title: "Migration migration migration", files: [text("index.md", "x")] });
  const visible: string[] = [];
  for (let n = 0; n < 5; n += 1) {
    visible.push(await create(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: `Migration note ${n}`, files: [text("index.md", "x")] }));
  }
  // A sees both homes, the hidden one first: it is the best match.
  const forA = await allPages(app, world.keys.a, "migration", 2);
  assert.equal(forA[0], hidden);
  assert.deepEqual([...forA].sort(), [hidden, ...visible].sort());
  // C can't see #priv: not on the first page with limit 1, nor on any later page, by word or by prefix.
  for (const query of ["migration", "migr"]) {
    const first = await search(app, world.keys.c, query, { limit: "1" });
    assert.equal(ids(first).length, 1);
    assert.notEqual(ids(first)[0], hidden);
    const forC = await allPages(app, world.keys.c, query, 1);
    assert.deepEqual([...forC].sort(), [...visible].sort(), query);
  }
  assert.deepEqual(ids(await search(app, world.keys.peer, "migration")), [], "another server's agent");
  const inPriv = await search(app, world.keys.a, "migration", { target: `#${world.channels.priv.name}` });
  assert.deepEqual(ids(inPriv), [hidden]);
  assert.deepEqual(inPriv.body.target, { target: `#${world.channels.priv.name}`, conversationId: world.channels.priv.id, homeFromThread: null });
  assert.equal((await search(app, world.keys.c, "migration", { target: `#${world.channels.priv.name}` })).status, 404);
});

test("deleted and revoked Artifacts, and one homed in another's DM, are never found", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const target = `#${world.channels.pub.name}`;
  const deleted = await create(app, world.keys.a, { target, title: "Zanzibar deleted", files: [text("index.md", "x")] });
  const revoked = await create(app, world.keys.a, { target, title: "Zanzibar revoked", files: [text("index.md", "x")] });
  const inDm = await create(app, world.keys.a, { target, title: "Zanzibar private", files: [text("index.md", "x")] });
  assert.deepEqual(ids(await search(app, world.keys.c, "zanzibar")).sort(), [deleted, revoked, inDm].sort());
  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, deleted));
  await getDb().update(artifactItems).set({ revokedAt: new Date() }).where(eq(artifactItems.id, revoked));
  // Homed in the owner's DM with agent A: C, a third member of the server, doesn't see it.
  await getDb().update(artifactItems).set({ homeChannelId: world.channels.dm.id }).where(eq(artifactItems.id, inDm));
  for (const key of [world.keys.a, world.keys.c]) {
    assert.deepEqual(ids(await search(app, key, "deleted")), []);
    assert.deepEqual(ids(await search(app, key, "revoked")), []);
  }
  assert.deepEqual(ids(await search(app, world.keys.c, "zanzibar")), []);
  assert.deepEqual(ids(await search(app, world.keys.c, "private")), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "zanzibar")), [inDm], "A is in that DM");
});

test("an orphan (its home channel hard-deleted) is in no list and no search, even its author's; its author still reads it by id", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const doomed = await createChannel(world.server.id, `doomed-${label()}`, undefined, "private");
  await addAgent(doomed.id, world.agentA.id);
  const orphan = await create(app, world.keys.a, { target: `#${doomed.name}`, title: "Quarterly orphanage", files: [text("index.md", "x")] });
  const kept = await create(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: "Quarterly orphanage kept", files: [text("index.md", "x")] });
  assert.deepEqual(ids(await search(app, world.keys.a, "orphanage")).sort(), [orphan, kept].sort());

  await getDb().delete(channels).where(eq(channels.id, doomed.id));
  assert.deepEqual(ids(await search(app, world.keys.a, "orphanage")), [kept]);
  assert.ok(!ids(await call(app.baseUrl, "GET", "/artifacts", world.keys.a)).includes(orphan), "not in the plain list");
  const read = await call(app.baseUrl, "GET", `/artifacts/${orphan}`, world.keys.a);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.artifact.home, { kind: "conversation", conversation: { id: null, type: null, target: null } });
  assert.equal((await call(app.baseUrl, "GET", `/artifacts/${orphan}`, world.keys.c)).status, 404, "not its author: not visible");
});

test("relevance cursor: pages in rank, then updatedAt, then id order, without gaps or repeats, bound to its query", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const made: string[] = [];
  // Ties in rank (the same title) and different ranks.
  for (let n = 0; n < 7; n += 1) {
    made.push(await create(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: n % 3 === 0 ? "Budget budget review" : "Budget plan", files: [text("index.md", `x ${n}`)] }));
  }
  const whole = ids(await search(app, world.keys.a, "budget", { limit: "50" }));
  assert.deepEqual([...whole].sort(), [...made].sort());
  for (const limit of [1, 2, 3]) assert.deepEqual(await allPages(app, world.keys.a, "budget", limit), whole, `limit ${limit}`);
  const rows = await getDb().execute(sql`SELECT s.item_id AS id, ts_rank_cd(s.search_vector, plainto_tsquery('simple', 'budget')) AS rank
    FROM app_artifacts.search s JOIN app_artifacts.items i ON i.id = s.item_id WHERE s.server_id = ${world.serverId}
    ORDER BY rank DESC, date_trunc('milliseconds', i.updated_at) DESC, i.id DESC`);
  assert.deepEqual(whole, (rows.rows as Array<{ id: string }>).map((row) => row.id));

  const page = await search(app, world.keys.a, "budget", { limit: "2" });
  const cursor = page.body.nextCursor as string;
  assert.deepEqual(await search(app, world.keys.a, "plan", { cursor }), { status: 400, body: INVALID_CURSOR }, "another query's cursor");
  assert.deepEqual(await call(app.baseUrl, "GET", `/artifacts?cursor=${cursor}`, world.keys.a), { status: 400, body: INVALID_CURSOR }, "a search cursor without its query");
  const plainCursor = (await call(app.baseUrl, "GET", "/artifacts?limit=1", world.keys.a)).body.nextCursor as string;
  assert.deepEqual(await search(app, world.keys.a, "budget", { cursor: plainCursor }), { status: 400, body: INVALID_CURSOR }, "a plain list's cursor with a query");
  // The same words written differently are the same query.
  assert.deepEqual(ids(await search(app, world.keys.a, "  BUDGET ", { cursor, limit: "2" })), whole.slice(2, 4));

  // Forged cursors: the digest is no secret, so its other parts are checked.
  const [digest, rank, at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, number, string, string];
  assert.equal(Math.fround(rank), rank, "a real rank is a float4 value");
  for (const forged of [
    [digest, 1e300, at, id],
    [digest, -1e300, at, id],
    [digest, 1e-50, at, id],
    [digest, -1, at, id],
    [digest, "0.5", at, id],
    [digest, rank, "+275760-09-13T00:00:00.000Z", id],
    [digest, rank, "0000-01-01T00:00:00.000Z", id],
    [digest, rank, "not a date", id],
    [digest, rank, at, "pt_\u0000x"],
    [digest, rank, at, "not-an-artifact"],
  ]) {
    assert.deepEqual(await search(app, world.keys.a, "budget", { cursor: cursorOf(forged) }), { status: 400, body: INVALID_CURSOR }, JSON.stringify(forged));
  }
  for (const forged of [["+275760-09-13T00:00:00.000Z", id], ["0000-01-01T00:00:00.000Z", id], [at, "pt_\u0000x"], [at, "not-an-artifact"]]) {
    assert.deepEqual(await call(app.baseUrl, "GET", `/artifacts?cursor=${cursorOf(forged)}`, world.keys.a), { status: 400, body: INVALID_CURSOR }, JSON.stringify(forged));
  }
  // A forged cursor that passes the checks only moves within what the caller sees.
  assert.deepEqual(ids(await search(app, world.keys.a, "budget", { cursor: cursorOf([digest, 0, "9999-12-31T00:00:00.000Z", "pt_ffffffff-ffff-ffff-ffff-ffffffffffff"]) })), []);
  assert.deepEqual(ids(await search(app, world.keys.a, "budget", { cursor: cursorOf([digest, Math.fround(1e30), at, id]), limit: "50" })), whole);
});
