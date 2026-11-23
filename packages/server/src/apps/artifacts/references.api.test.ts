// An Artifact's links to other Artifacts in core's object_references
// (references.ts; #proj-workspace:#336, step 1), over the agent API's push
// with real agent credentials. Proves: a push stores its version's links,
// from inline bytes or from storage, in order, with the target's facts and
// the version's mark; a new version's links replace the last one's (rows are
// the current version's only, and only it keeps a mark); a fill for a version
// that is no longer current writes nothing; a version without rows is filled
// when asked (ensureArtifactReferences), and only then; a file that can't be
// read never fails the push and stores nothing, and the next ask fills it; a
// delete and a takedown remove the rows, a restore reads them again; a link
// to the Artifact itself is none.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { artifactLinkId, asArtifactId, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectReferences } from "../../db/schema";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { createAgent } from "../../services/agentService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { storeBlob } from "./blobs";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { CONTENT_LINKS_EXTRACTOR } from "./contentLinks";
import { deleteArtifact } from "./manage";
import { ensureArtifactReferences, fillArtifactReferences } from "./references";
import { artifactItems, artifactVersions } from "./schema";
import { restoreArtifact, takedownArtifact } from "./takedown";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-references-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const T1 = asArtifactId(`pt_${randomUUID()}`);
const T2 = asArtifactId(`pt_${randomUUID()}`);
/** A link to an Artifact on the canonical app host, which every deployment recognises. */
const linkTo = (id: string, rest = "") => `https://app.raft.build/artifacts/${artifactLinkId(asArtifactId(id))}${rest}`;

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign(blob) {
      return `https://r2.example.test/${blob.r2Key}`;
    },
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** A server with Artifacts on: its owner and an agent in #pub. */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `refs-${label()}`, { runtime: "claude", model: "sonnet" });
  const pub = await createChannel(server.id, `refs-${label()}`);
  await addHuman(pub.id, owner.id);
  await addAgent(pub.id, agent.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const key = (await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: `refs-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const r2 = new Map<string, Buffer>();
  const store = memoryR2(r2);
  __setArtifactR2StoreForTests(store);
  return { owner, server, serverId: asServerId(server.id), agent, pub, key, r2, store };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function call(app: { baseUrl: string }, world: World, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${world.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const push = (app: { baseUrl: string }, world: World, body: Record<string, unknown>) =>
  call(app, world, "POST", "/artifacts/push", "artifact" in body ? body : { target: `#${world.pub.name}`, title: "Links", ...body });

/** The Artifact's reference rows, in order, as [target id, detail]. */
async function referencesOf(itemId: string) {
  const rows = await getDb().select().from(objectReferences)
    .where(and(eq(objectReferences.sourceKind, "artifact"), eq(objectReferences.sourceId, itemId)))
    .orderBy(objectReferences.position);
  return rows.map((row) => ({ server: row.serverId, position: row.position, kind: row.targetKind, id: row.targetId, detail: row.targetDetail }));
}

/** Each version's mark, by number. */
async function marksOf(itemId: string): Promise<Record<number, number | null>> {
  const rows = await getDb().select({ number: artifactVersions.number, extractor: artifactVersions.referencesExtractor }).from(artifactVersions).where(eq(artifactVersions.itemId, itemId));
  return Object.fromEntries(rows.map((row) => [row.number, row.extractor]));
}

const itemOf = async (id: string) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!;

test("a push stores its version's links in order, with their facts; a new version's replace them; a stale fill writes nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const md = `# Links\n\nSee ${linkTo(T1)} and [the plan](${linkTo(T2, "/v/3")}).\n\n\`${linkTo(T2, "/v/9")}\` https://example.test/elsewhere`;
  const created = await push(app, world, { entry: "index.md", files: [{ path: "index.md", content: md }, { path: "more.html", content: `<a href="${linkTo(T2)}">${linkTo(T2)}</a>` }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.artifact.id as string;
  assert.deepEqual(await referencesOf(id), [
    { server: world.serverId, position: 0, kind: "artifact", id: T1, detail: { version: null, href: linkTo(T1), bare: true, path: "index.md" } },
    { server: world.serverId, position: 1, kind: "artifact", id: T2, detail: { version: 3, href: linkTo(T2, "/v/3"), bare: false, path: "index.md" } },
    { server: world.serverId, position: 2, kind: "artifact", id: T2, detail: { version: null, href: linkTo(T2), bare: true, path: "more.html" } },
  ], "the entry first; code and other hosts left out");
  assert.deepEqual(await marksOf(id), { 1: CONTENT_LINKS_EXTRACTOR });

  // A new version, its entry stored before and listed by sha256 (read back from storage): its links in place of the last one's.
  const next = Buffer.from(`Now only [this one](${linkTo(T1, "/v/2")}).`);
  assert.equal((await storeBlob(world.store, world.serverId, sha(next), next)).kind, "stored");
  const second = await push(app, world, { artifact: id, base: 1, files: [{ path: "index.md", sha256: sha(next), size: next.length }], delete: ["more.html"] });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.deepEqual((await referencesOf(id)).map((row) => [row.id, row.detail]), [[T1, { version: 2, href: linkTo(T1, "/v/2"), bare: false, path: "index.md" }]]);
  assert.deepEqual(await marksOf(id), { 1: null, 2: CONTENT_LINKS_EXTRACTOR }, "only the current version keeps a mark");

  // Asked for version 1 now that it isn't current: nothing written.
  const [v1] = await getDb().select().from(artifactVersions).where(and(eq(artifactVersions.itemId, id), eq(artifactVersions.number, 1)));
  await fillArtifactReferences(await itemOf(id), { version: v1! });
  assert.deepEqual((await referencesOf(id)).map((row) => row.id), [T1]);
  assert.deepEqual(await marksOf(id), { 1: null, 2: CONTENT_LINKS_EXTRACTOR });

  // No links left: no rows, the mark still set (read, none found).
  assert.equal((await push(app, world, { artifact: id, base: 2, files: [{ path: "index.md", content: "No links now." }] })).status, 201);
  assert.deepEqual(await referencesOf(id), []);
  assert.deepEqual(await marksOf(id), { 1: null, 2: null, 3: CONTENT_LINKS_EXTRACTOR });
});

test("a version without rows is filled when asked, and only then", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await push(app, world, { files: [{ path: "index.html", content: `<p><a href="${linkTo(T1)}">one</a></p>` }] });
  const id = created.body.artifact.id as string;
  // As a version from before links were read: no rows, no mark.
  await getDb().delete(objectReferences).where(eq(objectReferences.sourceId, id));
  await getDb().update(artifactVersions).set({ referencesExtractor: null }).where(eq(artifactVersions.itemId, id));
  assert.deepEqual(await referencesOf(id), [], "nothing fills it unasked");

  assert.equal(await ensureArtifactReferences(await itemOf(id)), true);
  assert.deepEqual((await referencesOf(id)).map((row) => [row.id, row.detail.bare]), [[T1, false]]);
  assert.deepEqual(await marksOf(id), { 1: CONTENT_LINKS_EXTRACTOR });
  // Asked again: already the current version's, nothing read.
  const read = vi.fn();
  __setArtifactR2StoreForTests({ ...memoryR2(world.r2), read: async (...args) => { read(...args); return null; } });
  assert.equal(await ensureArtifactReferences(await itemOf(id)), true);
  assert.equal(read.mock.calls.length, 0);
});

test("a file that can't be read never fails the push and stores nothing; the next ask fills it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const page = Buffer.from(`Read me later: ${linkTo(T2)}`);
  assert.equal((await storeBlob(world.store, world.serverId, sha(page), page)).kind, "stored");
  const healthy = memoryR2(world.r2);
  __setArtifactR2StoreForTests({ ...healthy, read: async () => { throw new Error("storage is down"); } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let id: string;
  try {
    const res = await push(app, world, { files: [{ path: "index.md", sha256: sha(page), size: page.length }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    id = res.body.artifact.id as string;
      assert.ok(!JSON.stringify(warn.mock.calls).includes("Read me later"), "the log names no words of it");
  } finally {
    warn.mockRestore();
  }
  assert.deepEqual(await referencesOf(id), []);
  assert.deepEqual(await marksOf(id), { 1: null }, "not marked: tried again");

  __setArtifactR2StoreForTests(healthy);
  assert.equal(await ensureArtifactReferences(await itemOf(id)), true);
  assert.deepEqual((await referencesOf(id)).map((row) => row.id), [T2]);
});

test("a new version whose read fails leaves no rows, never the last version's", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await push(app, world, { entry: "index.md", files: [{ path: "index.md", content: `Old link: ${linkTo(T1)}` }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.artifact.id as string;
  assert.deepEqual((await referencesOf(id)).map((row) => row.id), [T1]);

  // v2's entry is stored, but storage fails when the fill reads it back.
  const next = Buffer.from(`New link: ${linkTo(T2)}`);
  assert.equal((await storeBlob(world.store, world.serverId, sha(next), next)).kind, "stored");
  const healthy = memoryR2(world.r2);
  __setArtifactR2StoreForTests({ ...healthy, read: async () => { throw new Error("storage is down"); } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const second = await push(app, world, { artifact: id, base: 1, files: [{ path: "index.md", sha256: sha(next), size: next.length }] });
    assert.equal(second.status, 201, JSON.stringify(second.body));
  } finally {
    warn.mockRestore();
    __setArtifactR2StoreForTests(healthy);
  }
  assert.deepEqual(await referencesOf(id), [], "v1's link went with the push");
  assert.deepEqual(await marksOf(id), { 1: null, 2: null }, "neither version marked: the next ask reads v2");

  assert.equal(await ensureArtifactReferences(await itemOf(id)), true);
  assert.deepEqual((await referencesOf(id)).map((row) => row.id), [T2]);
});

test("a delete and a takedown remove the rows; a restore reads them again", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const made = async () => {
    const res = await push(app, world, { files: [{ path: "index.md", content: `${linkTo(T1)}` }] });
      const id = res.body.artifact.id as string;
    assert.deepEqual((await referencesOf(id)).map((row) => row.id), [T1]);
    return id;
  };

  const deleted = await made();
  assert.equal((await deleteArtifact({ type: "user", id: world.owner.id, serverId: world.serverId }, deleted)).kind, "deleted");
  assert.deepEqual(await referencesOf(deleted), []);
  assert.deepEqual(await marksOf(deleted), { 1: null });
  assert.equal(await ensureArtifactReferences(await itemOf(deleted)), false, "never filled again");
  assert.deepEqual(await referencesOf(deleted), []);

  const down = await made();
  assert.equal((await takedownArtifact({ kind: "ops", operator: "alice" }, down, "report")).kind, "done");
  assert.deepEqual(await referencesOf(down), []);
  assert.equal(await ensureArtifactReferences(await itemOf(down)), false, "nor while taken down");
  assert.equal((await restoreArtifact({ kind: "ops", operator: "alice" }, down, "false positive")).kind, "done");
  assert.deepEqual((await referencesOf(down)).map((row) => row.id), [T1]);
  assert.deepEqual(await marksOf(down), { 1: CONTENT_LINKS_EXTRACTOR });
});

test("a link to the Artifact itself is no reference", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await push(app, world, { files: [{ path: "index.md", content: "first" }] });
  const id = created.body.artifact.id as string;
  assert.equal((await push(app, world, { artifact: id, base: 1, files: [{ path: "index.md", content: `${linkTo(id)} and ${linkTo(T1)}` }] })).status, 201);
  assert.deepEqual((await referencesOf(id)).map((row) => row.id), [T1]);
});
