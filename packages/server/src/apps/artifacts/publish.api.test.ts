// Publishing through the Artifacts agent API (S1b), over HTTP with real agent
// credentials: creating (homes, names), new versions (carry-over, delete),
// missing bytes and uploads, auto-merge and BASE_MOVED, the comment hold
// (freshness v2 §3, acceptance 2–6), permissions, limits, replays, concurrent
// publishes, the per-server blobs with their cleanup, and a public
// Artifact's signed-out text stored after the push (publicText.ts), and a
// Markdown version's excerpt stored after the push (excerpt.ts).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { artifactLinkId, asArtifactId, asServerId, BasicTracer, MemoryTraceSink, RAFT_HINTS, type AgentMessage, type ArtifactAgentAppEvent } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { messages, objectEvents, thirdPartyAgentEvents } from "../../db/schema";
import { AgentOrchestrator } from "../../services/agentOrchestrator";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createMessage } from "../../services/messageService";
import { appOperationsTotal } from "../../metrics";
import { refusalBody, type RefusalInput } from "../../platform/refusals";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { ARTIFACTS_NOT_ENABLED, notVisible as notVisibleRefusal, storageUnavailable, takePartForbiddenError, TARGET_IS_TASK_ERROR, TARGET_NOT_FOUND_ERROR, targetNotFound, versionNotFound } from "./apiCommon";
import { pruneUnreferencedArtifactBlobs, storeBlob } from "./blobs";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { TITLE_REQUIRED_ERROR } from "./publish";
import { deleteArtifact } from "./manage";
import { ARTIFACT_NOTICE_TTL_MS } from "./notices";
import { __settlePublicTextFillsForTests } from "./publicText";
import { __setScrollLockCheckForTests } from "./scrollLock";
import {
  artifactBlobs,
  artifactComments,
  artifactItems,
  artifactReadPositions,
  artifactVersions,
  artifactVersionTexts,
} from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

// Keys verify by HMAC, not argon2 (64 MiB a verify): next to these tests'
// large bodies, argon2's allocation failing reads as a 401 (core's credential
// lookup treats a verify error as a mismatch).
beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-publish-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const MiB = 1024 * 1024;

/** A body as it arrives: undefined fields (a hint's unset arguments) dropped. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The refusal envelope the server answers for this input (lib/refusal.ts), as it arrives. */
const refusal = (input: RefusalInput) => wire(refusalBody(input));
/** TITLE_REQUIRED's step: each client's way to give a title, then push again (publish.ts). */
const TITLE_STEP = "Give the push a title people will recognise (--title on the CLI, title in a tool call), or give the entry page a <title>, then push again.";
const BLANK_TITLE = refusal({
  code: "TITLE_REQUIRED",
  error: "A title can't be blank: give one with words in it, then push again.",
  suggestedNextAction: TITLE_STEP,
  details: { blank: true },
});
const entryNotFound = (entry: string) => refusal({
  code: "ENTRY_NOT_FOUND",
  error: "The entry file isn't in the version this push would make: push that file too, or name an entry file that is in it.",
  details: { entry },
});

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      if (!bytes) return null;
      const { Readable } = await import("node:stream");
      return { stream: Readable.from([bytes]), size: bytes.length };
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

/**
 * A server, Artifacts on (unless `flag: false`): owner (human), agents A
 * and B in #pub (public) and #priv (private), agentOut in neither, a thread
 * in #pub, and an agent of another server.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { flag?: boolean } = {}) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const agentA = await createAgent(server.id, `pub-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentB = await createAgent(server.id, `pub-b-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentOut = await createAgent(server.id, `pub-out-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peer.id, `pub-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  const pub = await createChannel(server.id, `pub-${label()}`);
  const priv = await createChannel(server.id, `priv-${label()}`, undefined, "private");
  const peerChannel = await createChannel(peer.id, `peer-${label()}`);
  for (const channel of [pub, priv]) {
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agentA.id);
    await addAgent(channel.id, agentB.id);
  }
  await addAgent(peerChannel.id, peerAgent.id);
  const root = await createMessage(pub.id, "user", owner.id, `thread root ${label()}`);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.flag !== false);
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `pub-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  return {
    server, peer, serverId: asServerId(server.id), owner, agentA, agentB, agentOut, peerAgent,
    channels: { pub, priv, peer: peerChannel }, root, r2,
    keys: { a: await key(agentA.id), b: await key(agentB.id), out: await key(agentOut.id), peer: await key(peerAgent.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

/** Whether R2 holds an object for these bytes of the world's server (keys are per row: `…/blobs/<sha256>/<id>`). */
const hasObject = (world: World, sha256: string) => [...world.r2.keys()].some((key) => key.startsWith(`servers/${world.serverId}/blobs/${sha256}/`));

// ---- HTTP ----------------------------------------------------------------------

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

/**
 * A push. A create (a `target`, no `artifact`) without a `title` is sent with
 * one ("Untitled test page"): a new Artifact needs a title, and the tests of
 * that refusal send theirs with `call`.
 */
const publish = (app: { baseUrl: string }, apiKey: string, body: unknown) => {
  if (body && typeof body === "object" && "target" in body && !("artifact" in body) && !("title" in body)) {
    return call(app.baseUrl, "POST", "/artifacts/push", apiKey, { ...body, title: "Untitled test page" });
  }
  return call(app.baseUrl, "POST", "/artifacts/push", apiKey, body);
};
const read = (app: { baseUrl: string }, apiKey: string, artifact: string) => call(app.baseUrl, "GET", `/artifacts/${encodeURIComponent(artifact)}`, apiKey);

/** A PUT (or `method`) with raw bytes and headers exactly as given (`bytes` may be shorter than the declared length). */
function rawPut(baseUrl: string, path: string, apiKey: string, bytes: Buffer, headers: Record<string, string>, method: "PUT" | "POST" = "PUT"): Promise<Reply> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: `/internal/agent-api${path}`, headers: { Authorization: `Bearer ${apiKey}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        // Not every refusal is JSON (express's own 400 for a malformed body is HTML).
        let body: unknown = text || null;
        try { body = text ? JSON.parse(text) : null; } catch { /* the text as is */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(bytes);
    if (headers["Content-Length"] === undefined || Number(headers["Content-Length"]) === bytes.length) req.end();
  });
}

const upload = (app: { baseUrl: string }, apiKey: string, bytes: Buffer, sha256 = sha(bytes)) =>
  rawPut(app.baseUrl, `/artifacts/uploads/${sha256}`, apiKey, bytes, { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) });

// ---- helpers -------------------------------------------------------------------

const text = (path: string, content: string) => ({ path, content });

async function fileBytes(app: { baseUrl: string }, apiKey: string, artifact: string, path: string, version?: number): Promise<string> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${artifact}/files/${encodeURIComponent(path)}${version ? `?version=${version}` : ""}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const t = await res.text();
  assert.equal(res.status, 200, `${path}: ${res.status} ${t}`);
  return t;
}

async function filesOf(app: { baseUrl: string }, apiKey: string, artifact: string): Promise<Record<string, string>> {
  const res = await read(app, apiKey, artifact);
  const out: Record<string, string> = {};
  for (const file of res.body.version.files as Array<{ path: string }>) out[file.path] = await fileBytes(app, apiKey, artifact, file.path);
  return out;
}

async function readPosition(itemId: string, agentId: string): Promise<number | null> {
  const [row] = await getDb().select().from(artifactReadPositions).where(and(
    eq(artifactReadPositions.itemId, itemId), eq(artifactReadPositions.actorType, "agent"), eq(artifactReadPositions.actorId, agentId),
  ));
  return row?.position ?? null;
}

/** A comment as S1c will write one: the item's next position. */
async function addComment(itemId: string, author: { type: "user" | "agent"; id: string }, body: string, path: string | null = null) {
  const db = getDb();
  const [item] = await db.select().from(artifactItems).where(eq(artifactItems.id, itemId));
  const position = item!.lastPosition + 1;
  const [row] = await db.insert(artifactComments).values({
    id: `c_${randomUUID()}`, itemId, versionId: item!.currentVersionId!, path, authorType: author.type, authorId: author.id, body, position,
  }).returning();
  await db.update(artifactItems).set({ lastPosition: position }).where(eq(artifactItems.id, itemId));
  return row!;
}

/** A created artifact in #pub with a.html, b.html, c.html and index.html, v1 by A. */
async function createSite(world: World, app: { baseUrl: string }) {
  const res = await publish(app, world.keys.a, {
    target: `#${world.channels.pub.name}`,
    title: "Site",
    files: [text("index.html", "<h1>home</h1>"), text("a.html", "a1"), text("b.html", "b1"), text("c.html", "c1")],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.artifact.id as string;
}

// ---- tests ---------------------------------------------------------------------

test("Artifacts off: publish and upload answer 403 ARTIFACTS_NOT_ENABLED and write nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, { flag: false });
  try {
    const res = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [text("index.html", "x")] });
    assert.deepEqual(res, { status: 403, body: wire(ARTIFACTS_NOT_ENABLED.body) });
    const up = await upload(app, world.keys.a, Buffer.from("x"));
    assert.equal(up.body.code, "ARTIFACTS_NOT_ENABLED");
    assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.serverId, world.serverId))).length, 0);
    assert.equal(world.r2.size, 0);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("Artifacts off: publish and upload answer 403 before reading their body (never parsed, not waited for)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const refused = { status: 403, body: wire(ARTIFACTS_NOT_ENABLED.body) };
    const json = { "Content-Type": "application/json" };
    // Not JSON: a parsed body is refused as malformed, as it is with Artifacts on.
    const notJson = Buffer.from("{not json");
    assert.equal((await rawPut(app.baseUrl, "/artifacts/push", world.keys.a, notJson, { ...json, "Content-Length": String(notJson.length) }, "POST")).status, 400);
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
    assert.deepEqual(await rawPut(app.baseUrl, "/artifacts/push", world.keys.a, notJson, { ...json, "Content-Length": String(notJson.length) }, "POST"), refused);
    // 32 MiB declared and a few bytes sent: the answer comes without the rest.
    assert.deepEqual(await rawPut(app.baseUrl, "/artifacts/push", world.keys.a, Buffer.from('{"target":'), { ...json, "Content-Length": String(32 * MiB) }, "POST"), refused);
    const bytes = Buffer.from("partial");
    assert.deepEqual(
      await rawPut(app.baseUrl, `/artifacts/uploads/${sha("whole")}`, world.keys.a, bytes, { "Content-Type": "application/octet-stream", "Content-Length": String(MiB) }),
      refused,
    );
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("create: inline text and base64 into a conversation; readable through the read routes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const res = await publish(app, world.keys.a, {
      target: `#${world.channels.pub.name}`,
      title: "Café Plan",
      note: "first",
      files: [text("index.html", "<h1>héllo</h1>"), { path: "img/logo.png", content_base64: png.toString("base64") }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const body = res.body;
    assert.match(body.artifact.id, /^pt_[0-9a-f-]{36}$/);
    assert.equal(body.artifact.title, "Café Plan");
    // No name (an Artifact is its id and its title): the deprecated field carries its short id for older CLIs.
    assert.equal(body.artifact.name, artifactLinkId(asArtifactId(body.artifact.id)));
    const [stored] = await getDb().select({ name: artifactItems.name }).from(artifactItems).where(eq(artifactItems.id, body.artifact.id));
    assert.equal(stored!.name, null);
    assert.equal(body.artifact.kind, "html");
    assert.equal(body.artifact.currentVersion, 1);
    assert.deepEqual(body.artifact.home, { kind: "conversation", conversation: { id: world.channels.pub.id, type: "channel", target: `#${world.channels.pub.name}` } });
    assert.deepEqual(body.artifact.author, { type: "agent", name: world.agentA.name });
    assert.deepEqual(body.version, { number: 1, filesFromYou: ["img/logo.png", "index.html"], deleted: [], base: null, previous: null, merged: [] });
    assert.deepEqual(body.unseen, { otherComments: 0 });
    assert.deepEqual(body.notified, []);
    assert.equal(body.replayed, false);
    assert.equal(body.unchanged, false);

    // The read side sees exactly what was published; bytes are per-server keys.
    const id = body.artifact.id as string;
    const shown = await read(app, world.keys.b, id);
    assert.equal(shown.body.version.entry, "index.html");
    assert.equal(shown.body.version.note, "first");
    assert.deepEqual(shown.body.version.files.map((file: { path: string; sizeBytes: number }) => [file.path, file.sizeBytes]), [["img/logo.png", 8], ["index.html", Buffer.byteLength("<h1>héllo</h1>")]]);
    assert.equal(await fileBytes(app, world.keys.b, id, "index.html"), "<h1>héllo</h1>");
    const logo = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${id}/files/img%2Flogo.png`, { headers: { Authorization: `Bearer ${world.keys.b}` } });
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), png);
    assert.ok(hasObject(world, sha(png)));
    // Its own version is nothing new to the publisher.
    assert.equal(await readPosition(id, world.agentA.id), 1);
    const own = await read(app, world.keys.a, id);
    assert.equal(own.body.unseen.versionCount, 0);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("create: a thread target homes the artifact in its parent; targets the agent can't see are refused", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const thread = `#${world.channels.pub.name}:${world.root.id.slice(0, 8)}`;
    const res = await publish(app, world.keys.a, { target: thread, title: "From the thread", files: [text("index.html", "t")] });
    assert.equal(res.status, 201);
    assert.equal(res.body.artifact.home.conversation.id, world.channels.pub.id);
    // Its original conversation (#75) is that parent too, the one a narrowing may return it to.
    const [made] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, res.body.artifact.id));
    assert.equal(made!.originalHomeChannelId, world.channels.pub.id);
    // Only file: it is the entry even without the name index.html.
    const single = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: "Notes", files: [text("notes.md", "# n")] });
    assert.equal(single.status, 201);
    assert.equal(single.body.artifact.kind, "markdown");
    assert.equal((await read(app, world.keys.a, single.body.artifact.id)).body.version.entry, "notes.md");

    const hidden = await publish(app, world.keys.out, { target: `#${world.channels.priv.name}`, files: [text("index.html", "x")] });
    assert.deepEqual(hidden, { status: 404, body: wire(targetNotFound({ target: `#${world.channels.priv.name}` }).body) });
    const otherServer = await publish(app, world.keys.peer, { target: `#${world.channels.pub.name}`, files: [text("index.html", "x")] });
    assert.equal(otherServer.body.code, "TARGET_NOT_FOUND");
    assert.equal((await publish(app, world.keys.a, { files: [text("index.html", "x")] })).body.code, "TARGET_REQUIRED");
    assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.homeChannelId, world.channels.priv.id))).length, 0);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

// A push posts no message, whatever its target: a card in a conversation is drawn from a link in a
// message's text, so the CLI's reply says to send the link (shared formatArtifactPublished). A
// thread target (a channel's or a DM's) homes the artifact in the thread's conversation, as is.
test("create: a channel or DM thread target homes the artifact in its conversation; neither it nor a later version posts any message", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const dm = (await findOrCreateDM(world.server.id, world.owner.id, world.agentA.id))!;
    const dmRoot = await createMessage(dm.id, "user", world.owner.id, `dm root ${label()}`);
    const agentMessages = async () => (await getDb().select({ id: messages.id }).from(messages).where(eq(messages.senderId, world.agentA.id))).length;
    const before = await agentMessages();

    const inThread = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}:${world.root.id.slice(0, 8)}`, title: "Demo", files: [text("x.md", "# x")] });
    assert.equal(inThread.status, 201, JSON.stringify(inThread.body));
    assert.deepEqual(inThread.body.artifact.home, { kind: "conversation", conversation: { id: world.channels.pub.id, type: "channel", target: `#${world.channels.pub.name}` } });

    const inDmThread = await publish(app, world.keys.a, { target: `dm:@${world.owner.name}:${dmRoot.id.slice(0, 8)}`, title: "Demo in a DM", files: [text("x.md", "# y")] });
    assert.equal(inDmThread.status, 201, JSON.stringify(inDmThread.body));
    assert.equal(inDmThread.body.artifact.home.conversation.id, dm.id);
    assert.equal(inDmThread.body.artifact.home.conversation.type, "dm");

    const v2 = await publish(app, world.keys.a, { artifact: inThread.body.artifact.id, base: 1, files: [text("x.md", "# x2")] });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    assert.equal(v2.body.version.number, 2);
    assert.equal(await agentMessages(), before, "no message posted for a create into a thread, nor for its v2");
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

// A task ref (`#channel:#7`, `dm:@peer:#7`) is no conversation, so no home: the 404 says that and
// names the conversation the ref names, not "no conversation you can see" and the channel list
// (the agent may well see the task). By the ref's shape alone: the same for a task that doesn't exist.
test("create: a task ref as the target is refused as a task that can't be a home, with its conversation as the target to use", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const pub = `#${world.channels.pub.name}`;
    const items = async () => (await getDb().select().from(artifactItems).where(eq(artifactItems.homeChannelId, world.channels.pub.id))).length;
    const task = await publish(app, world.keys.a, { target: `${pub}:#26`, title: "Demo", files: [text("x.md", "# x")] });
    assert.deepEqual(task, {
      status: 404,
      body: refusal({ code: "TARGET_NOT_FOUND", error: TARGET_IS_TASK_ERROR, next: RAFT_HINTS.artifactPublish({ target: pub }), details: { target: `${pub}:#26` } }),
    });
    assert.equal(task.body.suggestedNextAction, `raft artifact push <dir> --target "${pub}"`);
    const dmTask = await publish(app, world.keys.a, { target: `dm:@${world.owner.name}:#3`, title: "Demo", files: [text("x.md", "# x")] });
    assert.equal(dmTask.status, 404);
    assert.equal(dmTask.body.error, TARGET_IS_TASK_ERROR);
    assert.equal(dmTask.body.suggestedNextAction, `raft artifact push <dir> --target "dm:@${world.owner.name}"`);
    // The list's target: the same sentence, the step lists the task's conversation.
    const listed = await call(app.baseUrl, "GET", `/artifacts?target=${encodeURIComponent(`${pub}:#26`)}`, world.keys.a);
    assert.deepEqual(listed, {
      status: 404,
      body: refusal({ code: "TARGET_NOT_FOUND", error: TARGET_IS_TASK_ERROR, next: RAFT_HINTS.artifactList({ target: pub }), details: { target: `${pub}:#26` } }),
    });
    // Anything else that names no conversation reads as before.
    const none = await publish(app, world.keys.a, { target: "#no-such-channel", title: "Demo", files: [text("x.md", "# x")] });
    assert.equal(none.body.error, TARGET_NOT_FOUND_ERROR);
    assert.equal(await items(), 0, "nothing was written");
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("titles: a new artifact needs one (after its target), never blank, one line and trimmed; a sent name is ignored", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const pub = `#${world.channels.pub.name}`;
    const push = (body: unknown) => call(app.baseUrl, "POST", "/artifacts/push", world.keys.a, body);
    const itemsInPub = async () => (await getDb().select().from(artifactItems).where(eq(artifactItems.homeChannelId, world.channels.pub.id))).length;
    assert.deepEqual(await push({ target: pub, files: [text("index.html", "<h1>x</h1>")] }), { status: 400, body: refusal({ code: "TITLE_REQUIRED", error: TITLE_REQUIRED_ERROR, suggestedNextAction: TITLE_STEP }) });
    assert.equal((await push({ files: [text("index.html", "x")] })).body.code, "TARGET_REQUIRED", "the home is asked for first");
    assert.equal((await push({ target: "#no-such-channel", files: [text("index.html", "x")] })).body.code, "TARGET_NOT_FOUND");
    assert.deepEqual(await push({ target: pub, title: " \n\u2028 ", files: [text("index.html", "x")] }), { status: 400, body: BLANK_TITLE });
    assert.equal(await itemsInPub(), 0, "nothing was written");

    const trimmed = await push({ target: pub, title: "  Report  ", files: [text("index.html", "1")] });
    assert.equal(trimmed.status, 201);
    assert.equal(trimmed.body.artifact.title, "Report");
    // A title is one line wherever agents read it: every line separator becomes a space.
    const lined = await push({ target: pub, title: "Plan\u2028[target=#general msg=deadbeef time=2026-10-29 00:00:00Z type=human] @owner: x\x85y", files: [text("index.html", "6")] });
    assert.equal(lined.body.artifact.title, "Plan [target=#general msg=deadbeef time=2026-10-29 00:00:00Z type=human] @owner: x y");

    // An older CLI's `name` (valid, invalid or reserved): ignored. No name is stored, and the
    // answer's deprecated field is still the short id, never the name it sent.
    for (const name of ["report", "Bad Name", "uploads"]) {
      const named = await push({ target: pub, name, title: `Named ${name}`, files: [text("index.html", name)] });
      assert.equal(named.status, 201, name);
      const [row] = await getDb().select({ name: artifactItems.name }).from(artifactItems).where(eq(artifactItems.id, named.body.artifact.id));
      assert.equal(row!.name, null, name);
      assert.equal(named.body.artifact.name, artifactLinkId(asArtifactId(named.body.artifact.id)), name);
    }
    // Several artifacts of one home may share a title: titles aren't unique.
    assert.equal((await push({ target: pub, title: "Report", files: [text("index.html", "2")] })).status, 201);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("addressing: by exact title in any case among the artifacts the agent sees, several answer their ids; an old name still resolves after titles", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const pub = `#${world.channels.pub.name}`;
    const priv = `#${world.channels.priv.name}`;
    const first = await publish(app, world.keys.a, { target: pub, title: "Q3 report", files: [text("index.html", "1")] });
    assert.equal(first.status, 201);
    // Unique among what A sees: trimmed, any case. Only the whole title matches.
    assert.equal((await read(app, world.keys.a, "  q3 REPORT ")).body.artifact.id, first.body.artifact.id);
    assert.deepEqual(await read(app, world.keys.a, "Q3"), { status: 404, body: wire(notVisibleRefusal().body) });
    // Not one of its server's own, by title: never anything but the one 404.
    assert.equal((await read(app, world.keys.peer, "Q3 report")).status, 404);

    // Another home, the same title: A sees both, so it is told their ids, titles and homes.
    const other = await publish(app, world.keys.a, { target: priv, title: "q3 Report", files: [text("index.html", "2")] });
    const ambiguous = await read(app, world.keys.a, "Q3 report");
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.body.code, "AMBIGUOUS_ARTIFACT_NAME");
    assert.equal(ambiguous.body.error, `2 artifacts you can see are called that: pass the id of the one you mean instead (${ambiguous.body.details.candidates.map((c: { id: string }) => c.id).join(", ")}).`);
    assert.deepEqual(ambiguous.body.next, wire(RAFT_HINTS.artifactRead({ artifact: ambiguous.body.details.candidates[0].id })));
    assert.equal(ambiguous.body.details.ref, "Q3 report");
    const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1);
    assert.deepEqual([...ambiguous.body.details.candidates].sort(byId), [
      { id: first.body.artifact.id, title: "Q3 report", home: first.body.artifact.home },
      { id: other.body.artifact.id, title: "q3 Report", home: other.body.artifact.home },
    ].sort(byId));
    // The same for a push naming it: nothing published.
    assert.equal((await publish(app, world.keys.a, { artifact: "Q3 report", base: 1, files: [text("index.html", "3")] })).body.code, "AMBIGUOUS_ARTIFACT_NAME");
    // agentOut sees only the #pub one: no ambiguity, no hint of the other.
    assert.equal((await read(app, world.keys.out, "Q3 report")).body.artifact.id, first.body.artifact.id);

    // Old names (an Artifact from before titles keeps its own): a fallback when no title matches.
    const legacy = await publish(app, world.keys.a, { target: pub, title: "Rollout", files: [text("index.html", "4")] });
    await getDb().update(artifactItems).set({ name: "q3-report" }).where(eq(artifactItems.id, legacy.body.artifact.id));
    assert.equal((await read(app, world.keys.a, "q3-report")).body.artifact.id, legacy.body.artifact.id);
    assert.equal((await read(app, world.keys.a, legacy.body.artifact.id)).body.artifact.name, "q3-report", "the old name, still sent for older CLIs");
    // A title wins over another artifact's old name.
    const titled = await publish(app, world.keys.a, { target: pub, title: "plan", files: [text("index.html", "5")] });
    const named = await publish(app, world.keys.a, { target: pub, title: "Something else", files: [text("index.html", "6")] });
    await getDb().update(artifactItems).set({ name: "plan" }).where(eq(artifactItems.id, named.body.artifact.id));
    assert.equal((await read(app, world.keys.a, "plan")).body.artifact.id, titled.body.artifact.id);

    // A title that reads as a short id (a digit, then 21 of Base58's digits and lowercase) no Artifact has: looked up as a title.
    const shortIdTitle = await publish(app, world.keys.a, { target: pub, title: "1abcdefghijkmnopqrstuv", files: [text("index.html", "7")] });
    assert.equal((await read(app, world.keys.a, "1abcdefghijkmnopqrstuv")).body.artifact.id, shortIdTitle.body.artifact.id);
    // A `pt_\u2026` id no Artifact has is never a title.
    assert.equal((await read(app, world.keys.a, "pt_00000000-0000-4000-8000-000000000000")).status, 404);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

/** The `system.artifacts` events queued for an agent (core's third_party_agent_events). */
const artifactEventsOf = (agentId: string) => getDb().select().from(thirdPartyAgentEvents)
  .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.artifacts")));

test("title alone: the item takes it with no new version, recorded as `renamed`, its other following agents told without a wake (queued, handed over on their next pull); the same title again changes nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // Notices pushed through the test app's orchestrator (a push is a wake).
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => {
    delivered.push({ agentId, message });
    return { status: "delivered" };
  };
  try {
    const id = await createSite(world, app);
    const renamed = await publish(app, world.keys.b, { artifact: id, base: 1, title: "Site, renamed", files: [text("a.html", "a1")] });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.unchanged, true);
    assert.deepEqual(renamed.body.titleChanged, { from: "Site" });
    assert.equal(renamed.body.artifact.title, "Site, renamed");
    assert.equal(renamed.body.artifact.currentVersion, 1);
    assert.deepEqual(renamed.body.version, { number: 1, filesFromYou: [], deleted: [], base: 1, previous: 1, merged: [] });
    const versions = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id));
    assert.equal(versions.length, 1, "no version for a title");
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
    assert.equal(item!.title, "Site, renamed");
    assert.equal(item!.lastPosition, 1, "no position taken");
    const events = await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id)).orderBy(objectEvents.seq);
    assert.deepEqual(events.map((e) => [e.eventKind, e.actorId, e.data]).at(-1), ["renamed", world.agentB.id, { from: "Site", to: "Site, renamed" }]);
    // A, which pushed it and follows it, is told who renamed it, from what to what (task #147); B, which renamed it, isn't.
    // A rename only changes what the Artifact is shown as: its notice is queued, never pushed, so it wakes no one (task #160).
    assert.deepEqual(delivered, [], "no push, no wake");
    const [queuedToA, ...moreToA] = await artifactEventsOf(world.agentA.id);
    assert.equal(moreToA.length, 0);
    assert.equal(queuedToA!.status, "queued");
    assert.equal(queuedToA!.expiresAt.getTime() - queuedToA!.createdAt.getTime(), ARTIFACT_NOTICE_TTL_MS, "dropped if still unread after its TTL");
    const queuedNotice = (queuedToA!.payload as { app_event: ArtifactAgentAppEvent }).app_event;
    assert.deepEqual([queuedNotice.reason, queuedNotice.renamed], ["subscribed", { by: { type: "agent", name: world.agentB.name }, from: "Site", to: "Site, renamed" }]);
    assert.deepEqual(await artifactEventsOf(world.agentB.id), []);
    // Found by its new title, no longer by the old one.
    assert.equal((await read(app, world.keys.a, "site, renamed")).body.artifact.id, id);
    assert.equal((await read(app, world.keys.a, "Site")).status, 404);

    // The same title again: nothing to change, nothing recorded.
    const again = await publish(app, world.keys.b, { artifact: id, base: 1, title: "Site, renamed", files: [] });
    assert.equal(again.status, 200);
    assert.equal(again.body.unchanged, true);
    assert.equal(again.body.titleChanged, undefined);
    assert.equal((await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, id))).length, events.length);
    assert.equal(delivered.length, 0, "nobody told again");
    assert.equal((await artifactEventsOf(world.agentA.id)).length, 1, "nothing queued again");
    // Blank: refused, the title kept.
    assert.deepEqual((await publish(app, world.keys.b, { artifact: id, base: 1, title: "   ", files: [] })).body, BLANK_TITLE);
    // With a file changed, a title rides in the new version as before.
    const v2 = await publish(app, world.keys.a, { artifact: id, base: 1, title: "Site v2", files: [text("a.html", "a2")] });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version.number, 2);
    assert.equal(v2.body.artifact.title, "Site v2");
    // Who may: as for a push (an agent of its server that sees it).
    assert.equal((await publish(app, world.keys.peer, { artifact: id, base: 2, title: "Theirs", files: [] })).status, 404);

    // The next time A wakes and pulls its events, the queued rename notice is handed over with them (a fresh process: rebuilt from the table).
    (app.app as unknown as { set(key: string, value: unknown): void }).set("agentOrchestrator", new AgentOrchestrator());
    const res = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, { headers: { Authorization: `Bearer ${world.keys.a}` } });
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const pulled = (JSON.parse(raw) as { events: AgentMessage[] }).events.find((event) => event.third_party_event?.id === queuedToA!.id);
    assert.ok(pulled, `A gets the rename notice on its next pull: ${raw.slice(0, 1500)}`);
    assert.deepEqual((pulled.app_event as ArtifactAgentAppEvent).renamed, { by: { type: "agent", name: world.agentB.name }, from: "Site", to: "Site, renamed" });
    assert.ok(pulled.content.includes(`@${world.agentB.name} renamed "Site" to "Site, renamed" (you follow it because you pushed v1). Its id is unchanged: raft artifact read ${id}.`), pulled.content);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("missing bytes: listed by sha256, answered with what is missing, uploaded, then published", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const page = Buffer.from("<h1>big page</h1>");
    const style = Buffer.from("body{}");
    const body = {
      target: `#${world.channels.pub.name}`,
      title: "uploaded",
      files: [{ path: "index.html", sha256: sha(page), size: page.length }, { path: "style.css", sha256: sha(style), size: style.length }],
    };
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const first = await publish(app, world.keys.a, body);
    assert.equal(first.status, 200);
    assert.deepEqual([...first.body.missing].sort(), [sha(page), sha(style)].sort());
    assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.homeChannelId, world.channels.pub.id))).length, 0, "nothing changed");

    // Upload: the bytes must hash to the sha256 named.
    const wrong = await upload(app, world.keys.a, page, sha(style));
    assert.deepEqual(wrong, {
      status: 400,
      body: refusal({
        code: "SHA256_MISMATCH",
        error: "The uploaded bytes don't hash to the sha256 in the address (the file may have changed while uploading): hash the exact bytes you send, then upload again.",
        details: { expected: sha(style), actual: sha(page) },
      }),
    });
    assert.equal((await upload(app, world.keys.a, page)).status, 204);
    assert.equal((await upload(app, world.keys.a, page)).status, 204, "the same bytes again");
    const half = await publish(app, world.keys.a, body);
    assert.deepEqual(half.body, { missing: [sha(style)] });
    assert.equal((await upload(app, world.keys.a, style)).status, 204);

    const done = await publish(app, world.keys.a, body);
    assert.equal(done.status, 201);
    assert.equal(await fileBytes(app, world.keys.a, done.body.artifact.id, "style.css"), "body{}");
    const blobs = await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId));
    assert.equal(blobs.length, 2, "one row per server and sha256");

    // A size the stored bytes don't have.
    const lying = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: "lying", files: [{ path: "index.html", sha256: sha(page), size: page.length + 1 }] });
    assert.deepEqual(lying.body, refusal({
      code: "SIZE_MISMATCH",
      error: `A file is listed as ${page.length + 1} bytes, but the bytes uploaded for its sha256 are ${page.length}: compute the size and the sha256 from the same bytes, then push again.`,
      details: { path: "index.html", sha256: sha(page), size: page.length + 1, actual: page.length },
    }));

    // Another server never learns that this one has the bytes.
    const peer = await publish(app, world.keys.peer, { target: `#${world.channels.peer.name}`, title: "peer", files: [{ path: "index.html", sha256: sha(page), size: page.length }] });
    assert.deepEqual(peer, { status: 200, body: { missing: [sha(page)] } });

    // Each publish is a span of its request: what was asked in buckets, what came of it.
    const spans = sink.getAllSpans().filter((span) => span.name === "server.artifacts.publish");
    assert.deepEqual(spans.map((span) => [span.attrs?.operation, span.attrs?.files_bucket, span.attrs?.inline_bytes_bucket, span.attrs?.outcome, span.attrs?.status_code, span.status]), [
      ["create", "2-5", "0", "missing", 200, "ok"],
      ["create", "2-5", "0", "missing", 200, "ok"],
      ["create", "2-5", "0", "published", 201, "ok"],
      ["create", "1", "0", "SIZE_MISMATCH", 400, "ok"],
      ["create", "1", "0", "missing", 200, "ok"],
    ]);
    assert.equal(spans[2]!.attrs?.kind, "html");
    assert.equal(spans[2]!.attrs?.check, "none", "the check flag is off here: no publish check recorded");
    for (const span of spans) {
      const parent = sink.getAllSpans().find((candidate) => candidate.context.spanId === span.context.parentSpanId);
      assert.equal(parent?.name, "server.http.request");
      assert.equal(typeof span.attrs?.duration_ms, "number");
      assert.ok(!JSON.stringify(span.attrs).includes(sha(page)) && !JSON.stringify(span.attrs).includes("uploaded"), "never a hash or a title");
    }
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

const excerptOf = async (artifact: string, number: number) => (await getDb().select({ excerpt: artifactVersions.excerpt }).from(artifactVersions)
  .where(and(eq(artifactVersions.itemId, artifact), eq(artifactVersions.number, number))))[0]!.excerpt;

test("excerpt: a Markdown version's, stored by the time the push answers, from inline bytes or the upload; each version's its own; none for a page, nor with nothing to show", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const target = `#${world.channels.pub.name}`;
    const inline = await publish(app, world.keys.a, { target, title: "Notes", files: [text("index.md", "# Notes\n\nFirst **words**.")] });
    assert.equal(inline.status, 201);
    const id = inline.body.artifact.id as string;
    assert.equal(await excerptOf(id, 1), "First words.", "the heading repeating the title left out");
    const [{ excerptBlocks }] = await getDb().select({ excerptBlocks: artifactVersions.excerptBlocks }).from(artifactVersions).where(eq(artifactVersions.itemId, id));
    assert.deepEqual(excerptBlocks, [{ type: "paragraph", spans: [{ text: "First " }, { text: "words", bold: true }, { text: "." }] }], "and as blocks, stored with it");

    // Listed by sha256 and uploaded, as the CLI pushes: read back from storage.
    const page = Buffer.from("Second [words](https://example.test).");
    const body = { artifact: id, base: 1, files: [{ path: "index.md", sha256: sha(page), size: page.length }] };
    assert.equal((await publish(app, world.keys.a, body)).status, 200, "missing first");
    assert.equal((await upload(app, world.keys.a, page)).status, 204);
    assert.equal((await publish(app, world.keys.a, body)).status, 201);
    assert.equal(await excerptOf(id, 2), "Second words.");
    assert.equal(await excerptOf(id, 1), "First words.", "an older version keeps its own");

    // A change to another file: the entry read again, the same words.
    assert.equal((await publish(app, world.keys.a, { artifact: id, base: 2, files: [text("extra.md", "other")] })).status, 201);
    assert.equal(await excerptOf(id, 3), "Second words.");

    const html = await publish(app, world.keys.a, { target, title: "Page", files: [text("index.html", "<p>words</p>")] });
    assert.equal(await excerptOf(html.body.artifact.id, 1), null, "HTML has none");
    const empty = await publish(app, world.keys.a, { target, title: "Empty", files: [text("index.md", "![only](a.png)\n\n---\n")] });
    assert.equal(empty.status, 201);
    assert.equal(await excerptOf(empty.body.artifact.id, 1), null, "nothing left to show");
    const [{ excerptBlocks: none }] = await getDb().select({ excerptBlocks: artifactVersions.excerptBlocks }).from(artifactVersions).where(eq(artifactVersions.itemId, empty.body.artifact.id));
    assert.equal(none, null, "no blocks without the text, though there is an image and a rule to draw");
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("excerpt: an entry that can't be read never fails the push; the version goes without one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const page = Buffer.from("Words nobody can read back.");
    assert.equal((await upload(app, world.keys.a, page)).status, 204);
    const healthy = memoryR2(world.r2);
    __setArtifactR2StoreForTests({ ...healthy, read: async () => { throw new Error("storage is down"); } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, title: "Unreadable", files: [{ path: "index.md", sha256: sha(page), size: page.length }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(await excerptOf(res.body.artifact.id, 1), null);
      assert.ok(!JSON.stringify(warn.mock.calls).includes("Words nobody"), "the log names no words of it");
    } finally {
      warn.mockRestore();
    }
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("upload: content type, Content-Length and size are checked before the body is read", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const bytes = Buffer.from("abc");
    const path = `/artifacts/uploads/${sha(bytes)}`;
    const json = await rawPut(app.baseUrl, path, world.keys.a, bytes, { "Content-Type": "text/plain", "Content-Length": "3" });
    assert.equal(json.status, 400);
    const chunked = await rawPut(app.baseUrl, path, world.keys.a, bytes, { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" });
    assert.deepEqual(chunked, {
      status: 411,
      body: refusal({
        code: "CONTENT_LENGTH_REQUIRED",
        error: "An upload needs a Content-Length header, and this one had none: this is a client bug, so send the file inline (content_base64) meanwhile.",
      }),
    });
    // Declares 16 MiB + 1 and sends 3 bytes: refused from the header alone.
    const huge = await rawPut(app.baseUrl, path, world.keys.a, bytes, { "Content-Type": "application/octet-stream", "Content-Length": String(16 * MiB + 1) });
    assert.deepEqual(huge, {
      status: 413,
      body: refusal({
        code: "FILE_TOO_LARGE",
        error: "A file is 16 MiB, over the 16 MiB a file of its kind may be: make it smaller, or leave it out of the artifact.",
        details: { path: null, size: 16 * MiB + 1, limit: 16 * MiB },
      }),
    });
    assert.equal((await rawPut(app.baseUrl, "/artifacts/uploads/not-a-sha", world.keys.a, bytes, { "Content-Type": "application/octet-stream", "Content-Length": "3" })).status, 400);
    assert.equal(world.r2.size, 0);

    // The cap on bytes no version uses: a server near it can't upload more.
    await getDb().insert(artifactBlobs).values({ id: `b_${randomUUID()}`, serverId: world.serverId, sha256: sha("filler"), sizeBytes: 1024 * MiB - 2, r2Key: "filler" });
    const over = await upload(app, world.keys.a, bytes);
    assert.deepEqual(over, {
      status: 413,
      body: refusal({
        code: "UPLOAD_QUOTA_EXCEEDED",
        error: "This server holds 1024 MiB of uploaded files no version uses yet, against a limit of 1024 MiB: try again later (unused uploads are removed after a day), or tell an admin of this server.",
        details: { used: 1024 * MiB - 2, limit: 1024 * MiB },
      }),
    });
    const inline = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [text("index.html", "abc")] });
    assert.equal(inline.body.code, "UPLOAD_QUOTA_EXCEEDED", "inline bytes count too");
    // Another server's cap is its own.
    assert.equal((await upload(app, world.keys.peer, bytes)).status, 204);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("new version: unlisted files carry over, listed ones replace, delete removes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    const v2 = await publish(app, world.keys.a, {
      artifact: id, base: 1, note: "edit", label: "draft",
      files: [text("a.html", "a2"), text("b.html", "b1"), text("d.html", "d2")],
      delete: ["c.html"],
    });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    // b.html was listed unchanged: no change of the caller's.
    assert.deepEqual(v2.body.version, { number: 2, filesFromYou: ["a.html", "d.html"], deleted: ["c.html"], base: 1, previous: 1, merged: [] });
    assert.deepEqual(await filesOf(app, world.keys.a, id), { "a.html": "a2", "b.html": "b1", "d.html": "d2", "index.html": "<h1>home</h1>" });
    assert.equal(await fileBytes(app, world.keys.a, id, "c.html", 1), "c1", "older versions keep their files");
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
    const versions = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id));
    assert.equal(item!.lastPosition, 2);
    assert.equal(item!.currentVersionId, versions.find((v) => v.number === 2)!.id);
    assert.deepEqual(versions.map((v) => [v.number, v.position]).sort(), [[1, 1], [2, 2]]);

    // By its title (any case), too; a setting alone other than the title is a version; and what it can't be.
    const byTitle = await publish(app, world.keys.a, { artifact: "site", base: 2, description: "Site 2", files: [] });
    assert.equal(byTitle.status, 201);
    assert.equal(byTitle.body.artifact.description, "Site 2");
    assert.equal(byTitle.body.version.number, 3);
    assert.deepEqual((await publish(app, world.keys.a, { artifact: id, files: [text("a.html", "x")] })).body, refusal({
      code: "BASE_REQUIRED",
      error: "A new version needs base, the version number your files were made from (the current one is 3): read the artifact, then push again with that base.",
      next: RAFT_HINTS.artifactRead({ artifact: id }),
      details: { currentVersion: 3 },
    }));
    assert.deepEqual((await publish(app, world.keys.a, { artifact: id, base: 9, files: [text("a.html", "x")] })).body, wire(versionNotFound(id, 9, 3).body));
    assert.deepEqual((await publish(app, world.keys.a, { artifact: id, base: 3, files: [], delete: ["c.html"] })).body, refusal({
      code: "FILE_NOT_FOUND",
      error: "A path to delete isn't a file of v3, the version this push is based on: delete only paths its file list shows.",
      next: RAFT_HINTS.artifactRead({ artifact: id, version: 3, files: true }),
      details: { path: "c.html", version: 3 },
    }));
    assert.deepEqual((await publish(app, world.keys.a, { artifact: id, base: 3, files: [], delete: ["index.html"] })).body, entryNotFound("index.html"));
    assert.equal((await publish(app, world.keys.a, { artifact: id, target: "#x", base: 3, files: [] })).status, 400);
    // An older CLI's `name` beside `artifact` is ignored, not refused.
    assert.equal((await publish(app, world.keys.a, { artifact: id, name: "site", base: 3, files: [text("a.html", "a3")] })).status, 201);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("acceptance 2: others changed other files since the base: published on top, their changes reported", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    const b = await publish(app, world.keys.b, { artifact: id, base: 1, files: [text("b.html", "b2")] });
    assert.equal(b.body.version.number, 2);
    const a = await publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "a2")] });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual(a.body.version, {
      number: 3,
      filesFromYou: ["a.html"],
      deleted: [],
      base: 1,
      previous: 2,
      merged: [{ path: "b.html", setting: null, version: 2, author: { type: "agent", name: world.agentB.name } }],
    });
    assert.deepEqual(await filesOf(app, world.keys.a, id), { "a.html": "a2", "b.html": "b2", "c.html": "c1", "index.html": "<h1>home</h1>" });
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("acceptance 3: others changed the same file: BASE_MOVED with only the overlapping changes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    await publish(app, world.keys.b, { artifact: id, base: 1, files: [text("a.html", "a-by-b"), text("c.html", "c2")] });
    await publish(app, world.keys.b, { artifact: id, base: 2, files: [], delete: ["b.html"] });
    const a = await publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "a-by-a"), text("d.html", "d")], delete: ["b.html"] });
    assert.equal(a.status, 409);
    assert.deepEqual(a.body, refusal({
      code: "BASE_MOVED",
      error: "Not pushed: since v1, the version this push is based on, others changed something you changed too, and the current version is v3: read v3, redo your change on it, and push again with base 3.",
      next: RAFT_HINTS.artifactRead({ artifact: id }),
      details: {
        base: 1,
        current: 3,
        // b.html: B deleted it too, the same outcome, so no collision.
        overlaps: [{ path: "a.html", setting: null, version: 2, author: { type: "agent", name: world.agentB.name } }],
      },
    }));
    assert.equal((await read(app, world.keys.a, id)).body.artifact.currentVersion, 3, "nothing published");
    // Its own later versions never conflict with it.
    const own = await publish(app, world.keys.b, { artifact: id, base: 2, files: [text("c.html", "c3")] });
    assert.equal(own.status, 201);
    assert.deepEqual(own.body.version.merged, []);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("settings: entry, title or description changed by others overlap the same setting only", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    // A title with a file is a version (a title alone is not: it takes no part in a base's freshness).
    const b = { type: "agent", name: world.agentB.name };
    await publish(app, world.keys.b, { artifact: id, base: 1, title: "B's title", files: [text("d.html", "d")] });
    const clash = await publish(app, world.keys.a, { artifact: id, base: 1, title: "A's title", files: [] });
    assert.deepEqual(clash.body.details.overlaps, [{ path: null, setting: "title", version: 2, author: b }]);
    const entry = await publish(app, world.keys.a, { artifact: id, base: 1, entry: "a.html", files: [] });
    assert.equal(entry.status, 201);
    assert.deepEqual(entry.body.version.merged, [{ path: "d.html", setting: null, version: 2, author: b }, { path: null, setting: "title", version: 2, author: b }]);
    assert.equal(entry.body.artifact.title, "B's title", "their title carries over");
    assert.equal((await read(app, world.keys.a, id)).body.version.entry, "a.html");
    const entryClash = await publish(app, world.keys.b, { artifact: id, base: 2, entry: "b.html", files: [] });
    assert.equal(entryClash.body.code, "BASE_MOVED");
    assert.deepEqual(entryClash.body.details.overlaps.map((o: { setting: string }) => o.setting), ["entry"]);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("acceptance 4–6: comments on other files are counted; on the files changed or the whole artifact they hold until read in full", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    const owner = { type: "user" as const, id: world.owner.id };
    // 4: a comment on b.html doesn't hold a publish of a.html; it isn't shown, so it stays unseen (task #71).
    const aboutB = await addComment(id, owner, "about b", "b.html");
    const a2 = await publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "a2")] });
    assert.equal(a2.status, 201);
    assert.deepEqual(a2.body.unseen, { otherComments: 1 });
    assert.equal(await readPosition(id, world.agentA.id), aboutB.position - 1, "its own version doesn't move it past what it wasn't shown");

    // 5: a comment on the whole artifact holds it; so does one on a.html.
    const whole = await addComment(id, owner, "x".repeat(320));
    const onA = await addComment(id, owner, "about a", "a.html");
    await addComment(id, owner, "about c", "c.html");
    await addComment(id, { type: "agent", id: world.agentA.id }, "my own, never news to me");
    const body = { artifact: id, base: 2, files: [text("a.html", "a3")] };
    const held = await publish(app, world.keys.a, body);
    assert.equal(held.status, 409);
    assert.equal(held.body.code, "UNSEEN_CHANGES");
    const comments = held.body.details.unseen.comments;
    assert.deepEqual(comments.map((c: { id: string; path: string | null }) => [c.id, c.path]), [[whole.id, null], [onA.id, "a.html"]]);
    // The same shape as artifactRead's unseen comments.
    assert.deepEqual(Object.keys(comments[0]).sort(), ["anchor", "author", "bodyChars", "createdAt", "excerpt", "id", "path", "truncated", "version"]);
    assert.equal(comments[0].anchor, null, "a comment on the whole artifact has no place");
    assert.equal(comments[0].truncated, true);
    assert.equal(comments[0].bodyChars, 320);
    assert.deepEqual(comments[1].author, { type: "user", name: world.owner.name });
    assert.equal(held.body.details.unseen.commentCount, 2);
    assert.equal(held.body.details.unseen.commentsCursor, null);
    // The position stops before b.html's comment, never shown (and so before
    // the whole-artifact one, cut short): both held comments stay unseen.
    assert.equal(held.body.details.seen, aboutB.position - 1);
    assert.equal(held.body.details.unseen.unread, 2);
    assert.equal(held.body.error, "Held, not pushed: since you last looked, others commented on what you're changing (2 comments); read the 2 comments still unseen in full first, then send the same request again if they don't change what you meant, or change it first.");
    assert.deepEqual(held.body.details.skipped, { versions: 0, otherComments: 0 });
    assert.equal((await read(app, world.keys.b, id)).body.artifact.currentVersion, 2, "nothing published");
    assert.equal(await readPosition(id, world.agentA.id), aboutB.position - 1, "not past what it didn't show in full");

    // 6: the same request again is held again, until A lists the comments in full; then it goes through.
    assert.equal((await publish(app, world.keys.a, body)).body.code, "UNSEEN_CHANGES");
    const listed = await call(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.a);
    assert.equal(listed.body.comments.length, 4, "about b, the whole-artifact one, about a, about c: in full");
    const again = await publish(app, world.keys.a, body);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.deepEqual(again.body.unseen, { otherComments: 0 }, "c.html's comment was listed");
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
    assert.equal(await readPosition(id, world.agentA.id), item!.lastPosition);

    // `seen` looks from where the caller says, not the stored position: from
    // 0 it stops before b.html's comment, not shown, so it stays held.
    const viaSeen = await publish(app, world.keys.a, { artifact: id, base: 3, seen: 0, files: [text("a.html", "a4")] });
    assert.equal(viaSeen.body.code, "UNSEEN_CHANGES");
    assert.deepEqual(viaSeen.body.details.skipped, { versions: 0, otherComments: 0 });
    assert.equal(viaSeen.body.details.seen, aboutB.position - 1);
    assert.equal(viaSeen.body.details.unseen.unread, 2);
    const withSeen = await publish(app, world.keys.a, { artifact: id, base: 3, seen: viaSeen.body.details.seen, files: [text("a.html", "a4")] });
    assert.equal(withSeen.body.code, "UNSEEN_CHANGES");
    const withNewer = await publish(app, world.keys.a, { artifact: id, base: 3, seen: item!.lastPosition, files: [text("a.html", "a4")] });
    assert.equal(withNewer.status, 201);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("who may publish: the artifact's server only; anything not visible is NOT_VISIBLE", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const priv = await publish(app, world.keys.a, { target: `#${world.channels.priv.name}`, title: "secret", files: [text("index.html", "s")] });
    const site = await createSite(world, app);
    // A public artifact: the peer agent sees it but isn't of its server.
    await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, site));
    const notVisible = { status: 404, body: wire(notVisibleRefusal().body) };
    assert.deepEqual(await publish(app, world.keys.out, { artifact: priv.body.artifact.id, base: 1, files: [text("a.html", "x")] }), notVisible);
    assert.deepEqual(await publish(app, world.keys.out, { artifact: "secret", base: 1, files: [text("a.html", "x")] }), notVisible);
    assert.deepEqual(await publish(app, world.keys.peer, { artifact: priv.body.artifact.id, base: 1, files: [text("a.html", "x")] }), notVisible);
    assert.deepEqual(await publish(app, world.keys.a, { artifact: "pt_00000000-0000-4000-8000-000000000000", base: 1, files: [] }), notVisible);
    assert.equal((await read(app, world.keys.peer, site)).status, 200);
    assert.deepEqual(await publish(app, world.keys.peer, { artifact: site, base: 1, files: [text("a.html", "x")] }), {
      status: 403, body: refusal({ code: "FORBIDDEN", error: takePartForbiddenError("push to it") }),
    });
    // Any agent of the server that sees it may (agentOut isn't in #pub, but #pub is public).
    await getDb().update(artifactItems).set({ homeKind: "conversation", homeChannelId: world.channels.pub.id }).where(eq(artifactItems.id, site));
    assert.equal((await publish(app, world.keys.out, { artifact: site, base: 1, files: [text("a.html", "x")] })).status, 201);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("limits: each with its code and limit; the JSON body may be large on this route only", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const target = `#${world.channels.pub.name}`;
    const refused = async (body: unknown) => (await publish(app, world.keys.a, body)).body;
    assert.deepEqual(await refused({ target, title: "t".repeat(301), files: [text("index.html", "x")] }), refusal({
      code: "FIELD_TOO_LONG",
      error: "The title can be at most 300 characters: shorten it and push again.",
      details: { field: "title", limit: 300 },
    }));
    assert.deepEqual((await refused({ target, label: "é".repeat(61), files: [text("index.html", "x")] })).details, { field: "label", limit: 60 });
    assert.deepEqual((await refused({ target, note: "n".repeat(501), files: [text("index.html", "x")] })).details, { field: "note", limit: 500 });
    assert.deepEqual((await refused({ target, description: "d".repeat(1001), files: [text("index.html", "x")] })).details, { field: "description", limit: 1000 });
    const many = Array.from({ length: 256 }, (_, n) => ({ path: `f${n}.txt`, sha256: sha(String(n)), size: 1 }));
    assert.deepEqual(await refused({ target, files: many }), refusal({
      code: "TOO_MANY_FILES",
      error: "A push lists at most 255 files and this one has 256: push part of the change first (files not listed carry over unchanged), then the rest.",
      details: { count: 256, limit: 255 },
    }));
    assert.deepEqual((await refused({ target, files: [{ path: "big.html", sha256: sha("x"), size: 16 * MiB + 1 }] })).details, { path: "big.html", size: 16 * MiB + 1, limit: 16 * MiB });
    assert.deepEqual((await refused({ target, files: [{ path: "big.png", sha256: sha("x"), size: 15 * MiB + 1 }] })).details, { path: "big.png", size: 15 * MiB + 1, limit: 15 * MiB });
    assert.deepEqual((await refused({ target, files: [text("index.html", "x"), text("../up.html", "x")] })).code, "INVALID_PATH");
    assert.deepEqual((await refused({ target, files: [text("a%2e.html", "x")] })).code, "INVALID_PATH");
    // git's own names: a pulled .git/config would run its commands on the next git command there.
    for (const path of [".git/config", "site/.GIT/HEAD", ".git", "git~1/config"]) {
      assert.deepEqual((await refused({ target, files: [text("index.html", "x"), text(path, "[core]")] })).code, "INVALID_PATH", path);
    }
    assert.deepEqual(await refused({ target, files: [text("index.html", "x"), text("index.html", "y")] }), refusal({
      code: "DUPLICATE_PATH",
      error: "A path is listed twice, or both sent and deleted, in this push: list each path once.",
      details: { path: "index.html" },
    }));
    assert.deepEqual(await refused({ target, files: [{ path: "x.png", content_base64: "not base64!" }] }), refusal({
      code: "INVALID_CONTENT",
      error: "A file's content_base64 isn't valid padded base64: send it base64-encoded, or as content if it is text.",
      details: { path: "x.png" },
    }));
    assert.deepEqual(await refused({ target, entry: "home.html", files: [text("index.html", "x")] }), entryNotFound("home.html"));
    assert.deepEqual(await refused({ target, files: [text("index.html", "x"), text("b.html", "y")], delete: ["c.html"] }), refusal({
      code: "FILE_NOT_FOUND",
      error: "A new artifact has no files to delete: leave the deletes out of its first push.",
      details: { path: "c.html", version: null },
    }));

    // Inline: 10 MiB a file, 24 MiB a request; bodies far over the global 100 KB parse.
    const inlineFile = await refused({ target, files: [text("index.html", "x".repeat(10 * MiB + 1))] });
    assert.deepEqual(inlineFile, refusal({
      code: "FILE_TOO_LARGE",
      error: "A file sent inline is 10 MiB, over the 10 MiB an inline file may be: upload it by its sha256 instead, or make it smaller.",
      details: { path: "index.html", size: 10 * MiB + 1, limit: 10 * MiB },
    }));
    const nine = "y".repeat(9 * MiB);
    const inlineTotal = await refused({ target, files: [text("a.txt", nine), text("b.txt", nine), text("c.txt", nine)] });
    assert.deepEqual(inlineTotal, refusal({
      code: "REQUEST_TOO_LARGE",
      error: "The files sent inline are over 24 MiB together: send fewer or smaller files per push (the rest can follow, since files not listed carry over), or upload the large ones by their sha256.",
      details: { limit: 24 * MiB },
    }));
    const tooBig = await publish(app, world.keys.a, { target, files: [text("a.txt", "z".repeat(34 * MiB))] });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.code, "REQUEST_TOO_LARGE");
    // Another route keeps the global limit.
    const elsewhere = await fetch(`${app.baseUrl}/internal/agent-api/prepare-action`, {
      method: "POST", headers: { Authorization: `Bearer ${world.keys.a}`, "Content-Type": "application/json" }, body: JSON.stringify({ x: "q".repeat(200_000) }),
    });
    assert.equal(elsewhere.status, 413);
    // The large-body parser runs after agent auth: a body over its limit
    // without credentials is refused as unauthenticated, never read.
    const anonymous = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/push`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: "a".repeat(34 * MiB) }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.serverId, world.serverId))).length, 0, "none of it was published");
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("R2 not configured: inline bytes can't be stored", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    __setArtifactR2StoreForTests(null);
    const res = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [text("index.html", "x")] });
    assert.deepEqual(res, { status: 503, body: wire(storageUnavailable().body) });
    assert.equal((await upload(app, world.keys.a, Buffer.from("x"))).body.code, "ARTIFACTS_STORAGE_UNAVAILABLE");
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("the same request again answers the version it made, never a second one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const create = { target: `#${world.channels.pub.name}`, title: "Again", files: [text("index.html", "1")] };
    const first = await publish(app, world.keys.a, create);
    const replay = await publish(app, world.keys.a, create);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.artifact.id, first.body.artifact.id);
    assert.deepEqual(replay.body.version, first.body.version);
    const id = first.body.artifact.id as string;

    await publish(app, world.keys.b, { artifact: id, base: 1, files: [text("b.html", "b")] });
    const update = { artifact: id, base: 1, note: "mine", files: [text("index.html", "2")] };
    const made = await publish(app, world.keys.a, update);
    assert.equal(made.status, 201);
    const again = await publish(app, world.keys.a, update);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.version, made.body.version, "reported as it was made, merge included");
    assert.equal((await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id))).length, 3);
    // Others published since: still that version, not a second one.
    await publish(app, world.keys.b, { artifact: id, base: 3, files: [text("c.html", "c")] });
    const later = await publish(app, world.keys.a, update);
    assert.equal(later.status, 200);
    assert.equal(later.body.replayed, true);
    assert.deepEqual(later.body.version, made.body.version);
    // A different request whose result is the current version exactly: nothing written.
    const other = await publish(app, world.keys.a, { ...update, note: "other" });
    assert.equal(other.status, 200);
    assert.deepEqual({ unchanged: other.body.unchanged, replayed: other.body.replayed, version: other.body.version }, {
      unchanged: true, replayed: false, version: { number: 4, filesFromYou: [], deleted: [], base: 1, previous: 4, merged: [] },
    });
    assert.equal((await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id))).length, 4);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("a request the agent later undid is not a replay: it is published again", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    const change = { artifact: id, base: 1, files: [text("a.html", "X")] };
    assert.equal((await publish(app, world.keys.a, change)).body.version.number, 2);
    const revert = await publish(app, world.keys.a, { artifact: id, base: 2, files: [text("a.html", "a1")] });
    assert.equal(revert.body.version.number, 3);
    const again = await publish(app, world.keys.a, change);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.replayed, false);
    assert.equal(again.body.version.number, 4);
    assert.equal(await fileBytes(app, world.keys.a, id, "a.html"), "X");
    // Label or note alone make no version.
    const noteOnly = await publish(app, world.keys.a, { artifact: id, base: 4, note: "just a note", label: "l", files: [] });
    assert.equal(noteOnly.status, 200);
    assert.equal(noteOnly.body.unchanged, true);
    assert.equal((await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id))).length, 4);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("concurrent publishes on one base: both land with every file, or one is told the base moved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    // Different files: both go through, in some order, and the last has both.
    const results = await Promise.all([
      publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "A")] }),
      publish(app, world.keys.b, { artifact: id, base: 1, files: [text("b.html", "B")] }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [201, 201]);
    assert.deepEqual(results.map((r) => r.body.version.number).sort(), [2, 3]);
    const files = await filesOf(app, world.keys.a, id);
    assert.equal(files["a.html"], "A");
    assert.equal(files["b.html"], "B");

    // The same file: one lands, the other learns whose change it overlaps.
    const clash = await Promise.all([
      publish(app, world.keys.a, { artifact: id, base: 3, files: [text("c.html", "A")] }),
      publish(app, world.keys.b, { artifact: id, base: 3, files: [text("c.html", "B")] }),
    ]);
    assert.deepEqual(clash.map((r) => r.status).sort(), [201, 409]);
    const lost = clash.find((r) => r.status === 409)!;
    assert.equal(lost.body.code, "BASE_MOVED");
    assert.deepEqual(lost.body.details.overlaps.map((o: { path: string; version: number }) => [o.path, o.version]), [["c.html", 4]]);

    // Positions and the current version moved together.
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
    const versions = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id));
    assert.deepEqual(versions.map((v) => v.position).sort(), [1, 2, 3, 4]);
    assert.equal(item!.lastPosition, 4);
    assert.equal(item!.currentVersionId, versions.find((v) => v.number === 4)!.id);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("unreferenced uploads are removed after a day, row and bytes; published ones stay", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const kept = Buffer.from("kept");
    const orphan = Buffer.from("orphan");
    const fresh = Buffer.from("fresh");
    for (const bytes of [kept, orphan, fresh]) assert.equal((await upload(app, world.keys.a, bytes)).status, 204);
    await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [{ path: "index.html", sha256: sha(kept), size: kept.length }] });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await getDb().update(artifactBlobs).set({ createdAt: old }).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha(kept))));
    await getDb().update(artifactBlobs).set({ createdAt: old }).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha(orphan))));

    const removed = await pruneUnreferencedArtifactBlobs();
    assert.ok(removed >= 1);
    const left = (await getDb().select({ sha256: artifactBlobs.sha256 }).from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId))).map((row) => row.sha256);
    assert.deepEqual(left.sort(), [sha(kept), sha(fresh)].sort());
    assert.equal(hasObject(world, sha(orphan)), false);
    assert.equal(hasObject(world, sha(kept)), true);
    // Uploading the same bytes again brings them back.
    assert.equal((await upload(app, world.keys.a, orphan)).status, 204);
    assert.equal(hasObject(world, sha(orphan)), true);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("inline base64 at the 10 MiB limit is accepted (checked without a regex)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const bytes = Buffer.alloc(10 * MiB, 0xa7);
    bytes[0] = 0x89;
    const res = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [{ path: "photo.png", content_base64: bytes.toString("base64") }] });
    assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300));
    assert.ok(hasObject(world, sha(bytes)));
    // Not canonical base64 (a stray character, or no padding): refused, not a 500.
    const bad = `${bytes.subarray(0, 3 * MiB).toString("base64").slice(0, -1)}!`;
    assert.equal((await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [{ path: "x.png", content_base64: bad }] })).body.code, "INVALID_CONTENT");
    assert.equal((await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [{ path: "x.png", content_base64: "YWJj ZA" }] })).body.code, "INVALID_CONTENT");
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("overlaps are about outcomes: the same bytes others wrote merge; deleting an entry others set is BASE_MOVED", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    const id = await createSite(world, app);
    await publish(app, world.keys.b, { artifact: id, base: 1, files: [text("a.html", "same")] });
    const same = await publish(app, world.keys.a, { artifact: id, base: 1, files: [text("a.html", "same"), text("c.html", "c2")] });
    assert.equal(same.status, 201, JSON.stringify(same.body));
    assert.deepEqual(same.body.version.merged.map((change: { path: string }) => change.path), ["a.html"]);

    // B moves the entry to b.html; A, from before that, deletes b.html.
    await publish(app, world.keys.b, { artifact: id, base: 3, entry: "b.html", files: [] });
    const gone = await publish(app, world.keys.a, { artifact: id, base: 3, files: [], delete: ["b.html"] });
    assert.equal(gone.body.code, "BASE_MOVED");
    assert.deepEqual(gone.body.details.overlaps, [{ path: null, setting: "entry", version: 4, author: { type: "agent", name: world.agentB.name } }]);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

test("blobs: pending ones aren't present; the sweep deletes rows before objects and survives a failing delete", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  try {
    // An upload that never finished: its row is pending, so a publish still asks for the bytes.
    const stuck = Buffer.from("stuck");
    await getDb().insert(artifactBlobs).values({ id: `b_${randomUUID()}`, serverId: world.serverId, sha256: sha(stuck), sizeBytes: stuck.length, state: "pending", r2Key: `servers/${world.serverId}/blobs/${sha(stuck)}/stale` });
    const asks = await publish(app, world.keys.a, { target: `#${world.channels.pub.name}`, files: [{ path: "index.html", sha256: sha(stuck), size: stuck.length }] });
    assert.deepEqual(asks.body, { missing: [sha(stuck)] });
    // Uploading it again finishes it.
    assert.equal((await upload(app, world.keys.a, stuck)).status, 204);
    const [row] = await getDb().select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha(stuck))));
    assert.equal(row!.state, "ready");
    assert.equal(world.r2.get(row!.r2Key!)?.toString(), "stuck");

    // Three old unreferenced blobs and a stale pending one; R2 fails to delete one object.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const doomed = ["one", "two", "three"].map((word) => Buffer.from(word));
    for (const bytes of doomed) assert.equal((await storeBlob(memoryR2(world.r2), world.serverId, sha(bytes), bytes)).kind, "stored");
    const pending = Buffer.from("never finished");
    await getDb().insert(artifactBlobs).values({ id: `b_${randomUUID()}`, serverId: world.serverId, sha256: sha(pending), sizeBytes: pending.length, state: "pending", r2Key: "pending-key", createdAt: old });
    await getDb().update(artifactBlobs).set({ createdAt: old }).where(and(eq(artifactBlobs.serverId, world.serverId), inArray(artifactBlobs.sha256, doomed.map((bytes) => sha(bytes)))));
    const flaky = memoryR2(world.r2);
    const failing = [...world.r2.keys()].find((key) => key.includes(sha(doomed[1]!)))!;
    const store: ArtifactR2Store = { ...flaky, async delete(key) { if (key === failing) throw new Error("R2 is down"); await flaky.delete(key); } };
    assert.equal(await pruneUnreferencedArtifactBlobs({ store }), 4);
    const left = (await getDb().select({ sha256: artifactBlobs.sha256 }).from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId))).map((r) => r.sha256);
    assert.deepEqual(left, [sha(stuck)], "every row went, including the one whose object stayed");
    assert.equal(hasObject(world, sha(doomed[0]!)), false);
    assert.equal(hasObject(world, sha(doomed[1]!)), true, "a leaked object, not a row without bytes");
    assert.equal(hasObject(world, sha(doomed[2]!)), false);
    // Uploading those bytes again makes a new row with its own key: the leaked object is never read.
    assert.equal((await upload(app, world.keys.a, doomed[1]!)).status, 204);
    const [again] = await getDb().select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha(doomed[1]!))));
    assert.notEqual(again!.r2Key, failing);
  } finally {
    __setArtifactR2StoreForTests(undefined);
  }
});

// ---- a public Artifact's signed-out text (publicText.ts) ----------------------------

/** The public_text fills counted so far (slock_app_operations_total). */
async function fillCounts(): Promise<{ filled: number; fill_failed: number }> {
  const { values } = await appOperationsTotal.get();
  const of = (outcome: string) => values.find((value) => value.labels.app === "artifacts" && value.labels.operation === "public_text" && value.labels.outcome === outcome)?.value ?? 0;
  return { filled: of("filled"), fill_failed: of("fill_failed") };
}

test("a push to a public Artifact stores its signed-out text from the inline entry, no storage read; to a private one nothing; a failing fill still answers 201", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // The scroll-lock check reads the other pages from storage too (scrollLock.api.test.ts); here only the text fill's reads count.
  __setScrollLockCheckForTests(false);
  try {
    let reads = 0;
    let failReads = false;
    const base = memoryR2(world.r2);
    __setArtifactR2StoreForTests({ ...base, async read(blob) { reads += 1; if (failReads) throw new Error("R2 is down"); return base.read(blob); } });
    const textOf = async (artifact: string) => {
      const [row] = await getDb().select({ text: artifactVersionTexts }).from(artifactVersionTexts)
        .innerJoin(artifactItems, eq(artifactItems.currentVersionId, artifactVersionTexts.versionId))
        .where(eq(artifactItems.id, artifact));
      return row?.text ?? null;
    };
    const id = await createSite(world, app);
    await __settlePublicTextFillsForTests();
    assert.equal(await textOf(id), null, "made in a conversation: nothing stored");
    const v2 = await publish(app, world.keys.a, { artifact: id, base: 1, files: [text("index.html", "<h1>Site</h1><p>Private still.</p>")] });
    assert.equal(v2.status, 201);
    await __settlePublicTextFillsForTests();
    assert.equal(await textOf(id), null, "a private push: nothing stored");

    await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, id));
    reads = 0;
    const before = await fillCounts();
    const v3 = await publish(app, world.keys.a, { artifact: id, base: 2, files: [text("index.html", "<h1>Site</h1><p>Now public.</p>")] });
    assert.equal(v3.status, 201, JSON.stringify(v3.body));
    await __settlePublicTextFillsForTests();
    const row = await textOf(id);
    // The title's own heading left out of the description (extractor 1); the body as index.md says it.
    assert.deepEqual([row?.kind, row?.description, row?.body, row?.truncated], ["html", "Now public.", "# Site\n\nNow public.", false]);
    assert.equal(reads, 0, "from the inline bytes");
    assert.deepEqual(await fillCounts(), { filled: before.filled + 1, fill_failed: before.fill_failed });

    // The entry not in the push (another file changed): read from storage; that read failing is counted, the push still 201.
    failReads = true;
    const v4 = await publish(app, world.keys.a, { artifact: id, base: 3, files: [text("a.html", "a2")] });
    assert.equal(v4.status, 201, JSON.stringify(v4.body));
    await __settlePublicTextFillsForTests();
    assert.equal(await textOf(id), null, "nothing stored for v4");
    assert.equal(reads, 1);
    assert.deepEqual(await fillCounts(), { filled: before.filled + 1, fill_failed: before.fill_failed + 1 });
  } finally {
    __setArtifactR2StoreForTests(undefined);
    __setScrollLockCheckForTests(undefined);
  }
});

// A post-commit excerpt fill must not restore deleted text after deletion.
test("excerpt: deleting during the storage read cannot restore deleted text", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const bytes = Buffer.from("Confidential synthetic audit note.");
  assert.equal((await upload(app, world.keys.a, bytes)).status, 204);
  const title = `race-${label()}`;
  let release!: () => void;
  let entered!: (id: string) => void;
  const gate = new Promise<void>((done) => { release = done; });
  const started = new Promise<string>((done) => { entered = done; });
  const healthy = memoryR2(world.r2);
  __setArtifactR2StoreForTests({ ...healthy, read: async (blob) => {
    const snapshot = await healthy.read(blob);
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.title, title));
    if (item?.currentVersionId) {
      entered(item.id);
      await gate;
    }
    return snapshot;
  } });
  const pending = publish(app, world.keys.a, { target: `#${world.channels.priv.name}`, title, files: [{ path: "index.md", sha256: sha(bytes), size: bytes.length }] });
  try {
    const id = await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("excerpt read did not start")), 5000))]);
    const deleted = await deleteArtifact({ type: "user", id: world.owner.id, serverId: world.serverId }, id);
    assert.equal(deleted.kind, "deleted");
    assert.equal(await excerptOf(id, 1), null, "delete clears it before the read resumes");
    release();
    const response = await pending;
    assert.equal(response.status, 201);
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
    assert.notEqual(item!.deletedAt, null, "the item remains deleted");
    assert.equal((await read(app, world.keys.a, id)).status, 404, "the deleted Artifact remains unreadable");
    assert.equal(await excerptOf(id, 1), null, "a delayed fill must not reintroduce deleted text");
  } finally {
    release();
    await pending;
    __setArtifactR2StoreForTests(undefined);
  }
});
