// Signed-out viewing of public Artifacts over HTTP (`/api/public/artifacts/*`,
// publicRoutes.ts; contract: packages/shared publicArtifactsContract.ts), with
// the frame's ticket signed by the server (and a tripwire content Worker that
// must never be called), and the Worker's anonymous authorize
// (contentRoutes.ts decideAnonymous). Proves: one 404 for every case a
// visitor may not see; the view's keys are exactly the contract's; a
// credential on the request changes nothing and nothing names the caller;
// no cookie, `private, no-store`, noindex; the per-address limits, apart per
// address; exactly what an anonymous ticket says; that authorize allows
// an anonymous subject only for that Artifact's current version while it is
// public, so unpublishing or deleting it ends access; and that index.md and
// meta answer from the stored text (version_texts, publicText.ts) with no
// storage read and the same bytes, fill it on a miss (one read for both at
// once), never store a failed read, recompute a stale row, and never answer
// a stored row past the one 404.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES, artifactLinkId, artifactPublicPaths, artifactWebPaths, asArtifactId, asServerId, encodeArtifactShortId, objectWebPaths, type ArtifactPublicMeta, type ArtifactPublicView, type ArtifactWebFrame, type ServerId } from "@botiverse/raft-shared";
import { artifactContentTicketKey, verifyArtifactContentTicket, type ArtifactContentTicketClaims } from "@botiverse/raft-shared/src/artifactContentTicket";
import { getDb } from "../../db/index";
import { servers } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { appUrl } from "../../platform/links";
import { addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import { readStoredZip } from "../../test/storedZipReader";
import { appOperationsTotal } from "../../metrics";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { __settlePublicTextFillsForTests } from "./publicText";
import { READABLE_TEXT_EXTRACTOR } from "./readableText";
import { artifactBlobs, artifactItems, artifactVersionFiles, artifactVersions, artifactVersionTexts } from "./schema";
import { signContentFrame } from "./contentWorker";
import { takedownArtifact } from "./takedown";
import { webNotVisible } from "./webCommon";
import { __setPublicZipMaxOpenMsForTests, publicZipConcurrency, publicZipsInFlight } from "./zipSlots";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.public.view": 2, "artifacts.public.frame": 1 } });

const WORKER_TOKEN = "w".repeat(40);
const RAFT_TOKEN = "r".repeat(40);
const CONTENT_DOMAIN = "content.example.test";
const NOT_VISIBLE = webNotVisible().body;

afterEach(async () => {
  await __settlePublicTextFillsForTests();
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);

// ---- seeding -------------------------------------------------------------------

type Actor = { type: "user" | "agent"; id: string };

async function insertItem(input: { serverId: ServerId; author: Actor; home: "public" | "server" | { channelId: string }; deleted?: boolean; revoked?: boolean; name?: string }) {
  const id = `pt_${randomUUID()}`;
  const [row] = await getDb().insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: input.name ?? `art-${label()}`,
    title: `Artifact ${id.slice(3, 11)}`,
    homeKind: typeof input.home === "string" ? input.home : "conversation",
    homeChannelId: typeof input.home === "string" ? null : input.home.channelId,
    createdByType: input.author.type,
    createdById: input.author.id,
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
  }).returning();
  return row!;
}

/** Every blob `publish` wrote, by its key: the bytes behind memoryR2 (a test that reads content installs it). */
const storedObjects = new Map<string, Buffer>();
const memoryR2: ArtifactR2Store = {
  async put(key, bytes) { storedObjects.set(key, bytes); },
  async delete(key) { storedObjects.delete(key); },
  async read(blob) {
    const bytes = blob.r2Key ? storedObjects.get(blob.r2Key) : undefined;
    return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
  },
  async presign() { return null; },
};

/** A published version, current unless `current: false`; one ready file of the server. */
async function publish(serverId: ServerId, author: Actor, input: { itemId: string; number: number; path?: string; current?: boolean; bytes?: Buffer }) {
  const db = getDb();
  const versionId = `v_${randomUUID()}`;
  const path = input.path ?? "index.html";
  const bytes = input.bytes ?? Buffer.from(`${input.itemId} v${input.number}`);
  const [version] = await db.insert(artifactVersions).values({
    id: versionId, itemId: input.itemId, number: input.number, entry: path, title: null, fileCount: 1, sizeBytes: bytes.length,
    publishDigest: "digest", status: "published", publisherType: author.type, publisherId: author.id, position: input.number,
  }).returning();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobId = `b_${randomUUID()}`;
  const r2Key = r2KeyOf(serverId, sha256, blobId);
  storedObjects.set(r2Key, bytes);
  await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: bytes.length, state: "ready", r2Key });
  await db.insert(artifactVersionFiles).values({ versionId, path, sha256, sizeBytes: bytes.length, blobId });
  if (input.current !== false) await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: input.number }).where(eq(artifactItems.id, input.itemId));
  return version!;
}

/**
 * Artifacts on. A server whose owner made: open (public html, v1, v2
 * current), sheet (public csv), whole (server home), room (in private #room),
 * deleted and revoked (public), draft (public, never published); and a
 * peer server whose only member is peerUser.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const room = await createChannel(server.id, `pub-room-${label()}`, undefined, "private");
  await addHuman(room.id, owner.id);
  const author: Actor = { type: "user", id: owner.id };
  const make = async (home: "public" | "server" | { channelId: string }, opts: { path?: string; deleted?: boolean; revoked?: boolean } = {}) => {
    const item = await insertItem({ serverId, author, home, deleted: opts.deleted, revoked: opts.revoked });
    const version = await publish(serverId, author, { itemId: item.id, number: 1, path: opts.path });
    return { item, version };
  };
  const open = await make("public");
  const v2 = await publish(serverId, author, { itemId: open.item.id, number: 2 });
  const sheet = await make("public", { path: "data.csv" });
  const whole = await make("server");
  const inRoom = await make({ channelId: room.id });
  const deleted = await make("public", { deleted: true });
  const revoked = await make("public", { revoked: true });
  const draft = await insertItem({ serverId, author, home: "public" });
  return {
    owner, server, room, peer, peerUser,
    open: { item: (await getDb().select().from(artifactItems).where(eq(artifactItems.id, open.item.id)))[0]!, v1: open.version, v2 },
    sheet, whole, inRoom, deleted, revoked, draft,
  };
}

// ---- the content origin -----------------------------------------------------------

/** An Artifact's own content origin under CONTENT_DOMAIN. */
const originOf = (artifact: string) => `https://w-${artifact.replace(/^pt_/, "")}.${CONTENT_DOMAIN}`;

/**
 * The content origin configured through the environment, and a tripwire
 * content Worker at ARTIFACTS_CONTENT_WORKER_URL recording every call: the
 * server never makes one (it signs the ticket itself).
 */
async function startWorker() {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url ?? "");
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", WORKER_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", CONTENT_DOMAIN);
  return {
    calls,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** A frame's ticket, checked as the content Worker checks it with the configured token's key: its claims (its door's the same, `door: true`). */
async function claimsOf(frame: ArtifactWebFrame): Promise<ArtifactContentTicketClaims> {
  const url = new URL(frame.url);
  assert.deepEqual([url.origin, url.pathname, frame.reports], [frame.origin, "/_raft/open", true]);
  const key = await artifactContentTicketKey(WORKER_TOKEN);
  const verified = await verifyArtifactContentTicket(url.searchParams.get("ticket")!, [key], { origin: frame.origin });
  assert.ok(verified.ok, JSON.stringify(verified));
  const door = new URL(frame.door!.url);
  assert.deepEqual([door.origin, door.pathname], [frame.origin, "/__porthole/door/_raft"]);
  const doorVerified = await verifyArtifactContentTicket(door.searchParams.get("ticket")!, [key], { origin: frame.origin });
  assert.ok(doorVerified.ok, JSON.stringify(doorVerified));
  const { door: isDoor, nonce: _doorNonce, ...doorClaims } = doorVerified.claims;
  const { nonce: _nonce, ...claims } = verified.claims;
  assert.deepEqual([isDoor, doorClaims], [true, claims], "the door's claims are the frame's");
  // The web mounts the frame's Porthole instance with it (#proj-workspace:#251): the version the tickets name.
  assert.equal(frame.instanceVersion, verified.claims.version, "the frame names the version its tickets were signed for");
  return verified.claims;
}

// ---- HTTP ------------------------------------------------------------------------

type Answer = { status: number; body: any; headers: Headers };

/** A signed-out request: `headers` adds what a test wants on it (a credential, an address). */
async function ask(baseUrl: string, method: "GET" | "POST", path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json", ...headers } : headers,
    body: method === "POST" ? "{}" : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const view = (baseUrl: string, id: string, headers?: Record<string, string>) => ask(baseUrl, "GET", artifactPublicPaths.view(asArtifactId(id)), headers);
const frame = (baseUrl: string, id: string, headers?: Record<string, string>) => ask(baseUrl, "POST", artifactPublicPaths.frame(asArtifactId(id)), headers);

/** What every answer of these routes carries: never stored by a shared cache, never indexed, no cookie. */
function assertPrivateAnswer(answer: Answer, message: string) {
  assert.equal(answer.headers.get("cache-control"), "private, no-store", message);
  assert.match(answer.headers.get("x-robots-tag") ?? "", /\bnoindex\b/, message);
  assert.equal(answer.headers.get("set-cookie"), null, message);
}

async function authorize(baseUrl: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/artifacts-content/authorize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RAFT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}
const anonymousSubject = (artifact: string, version: string) => `v1:anon:${artifact}:${version}`;

// ---- one 404 -------------------------------------------------------------------

test("every Artifact a visitor may not see, and every one with Artifacts off, is the same 404, for the view and the frame, and the Worker is never asked", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const cases: Array<[string, string]> = [
      ["a conversation home", world.inRoom.item.id],
      ["a server home", world.whole.item.id],
      ["deleted", world.deleted.item.id],
      ["revoked", world.revoked.item.id],
      ["never published", world.draft.id],
      ["no such id", `pt_${randomUUID()}`],
      ["a malformed id", "not-an-id"],
      ["an id in capitals", world.open.item.id.toUpperCase()],
    ];
    for (const [why, id] of cases) {
      for (const [route, answer] of [["view", await view(app.baseUrl, id)], ["frame", await frame(app.baseUrl, id)]] as const) {
        assert.deepEqual([answer.status, answer.body], [404, NOT_VISIBLE], `${route}: ${why}`);
        assertPrivateAnswer(answer, `${route}: ${why}`);
      }
    }
    // A segment that isn't valid percent-encoding names no Artifact either.
    for (const answer of [await ask(app.baseUrl, "GET", "/api/public/artifacts/%E0%A4%A"), await ask(app.baseUrl, "POST", "/api/public/artifacts/%E0%A4%A/frame")]) {
      assert.deepEqual([answer.status, answer.body], [404, NOT_VISIBLE], "undecodable");
      assertPrivateAnswer(answer, "undecodable");
    }
    assert.equal(worker.calls.length, 0);
    // Witness: the public one opens.
    assert.equal((await view(app.baseUrl, world.open.item.id)).status, 200);
    assert.equal((await frame(app.baseUrl, world.open.item.id)).status, 200);
    // Artifacts off: the public one is the same 404.
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
    for (const [route, answer] of [["view", await view(app.baseUrl, world.open.item.id)], ["frame", await frame(app.baseUrl, world.open.item.id)]] as const) {
      assert.deepEqual([answer.status, answer.body], [404, NOT_VISIBLE], `${route}: Artifacts off`);
      assertPrivateAnswer(answer, `${route}: Artifacts off`);
    }
    assert.equal(worker.calls.length, 0);
  } finally {
    await worker.close();
  }
});

// ---- the view ------------------------------------------------------------------

test("the view is exactly ArtifactPublicView of the current version: nothing of the server, home, history or author", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const answer = await view(app.baseUrl, world.open.item.id);
  assert.equal(answer.status, 200);
  assertPrivateAnswer(answer, "view");
  const expected = {
    id: asArtifactId(world.open.item.id),
    title: world.open.item.title,
    kind: "html",
    version: { number: 2, updatedAt: world.open.v2.createdAt.toISOString() },
    attribution: { kind: "raft" },
  } satisfies ArtifactPublicView;
  assert.deepEqual(answer.body, expected);
  assert.deepEqual(Object.keys(answer.body).sort(), ["attribution", "id", "kind", "title", "version"]);
  assert.deepEqual(Object.keys(answer.body.version).sort(), ["number", "updatedAt"]);
  assert.deepEqual(Object.keys(answer.body.attribution), ["kind"]);
  const text = JSON.stringify(answer.body);
  for (const secret of [world.server.id, world.server.slug, world.server.name, world.owner.id, ...(world.open.item.name === null ? [] : [world.open.item.name]), world.open.v2.id]) {
    assert.ok(!text.includes(secret), `the view names nothing else: ${secret}`);
  }
  // A shell-drawn kind is viewable too; its kind says the frame isn't for it.
  assert.equal((await view(app.baseUrl, world.sheet.item.id)).body.kind, "csv");
});

test("the short id a link carries opens the same public Artifact, view and frame; one that names nothing visible is the one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const short = artifactLinkId(asArtifactId(world.open.item.id));
    assert.match(short, /^[1-9A-HJ-NP-Za-km-z]{22}$/);
    const byShort = await view(app.baseUrl, short);
    assert.equal(byShort.status, 200);
    assert.deepEqual(byShort.body, (await view(app.baseUrl, world.open.item.id)).body, "the same answer; its id stays pt_…");
    assert.equal(byShort.body.id, world.open.item.id);
    const framed = await frame(app.baseUrl, short);
    assert.equal(framed.status, 200);
    assert.equal((await claimsOf(framed.body)).artifact, world.open.item.id);
    for (const [why, id] of [
      ["a server home's short id", artifactLinkId(asArtifactId(world.whole.item.id))],
      ["no such Artifact", artifactLinkId(asArtifactId(`pt_${randomUUID()}`))],
      ["over 16 bytes", "YcVfxkQb6JRzqk5kF2tNLw"],
    ] as const) {
      assert.deepEqual([(await view(app.baseUrl, id)).status, (await frame(app.baseUrl, id)).status], [404, 404], why);
    }
    assert.equal(worker.calls.length, 0);
  } finally {
    await worker.close();
  }
});

test("a credential on the request changes nothing: the same answer as anyone's, nothing naming the caller, no cookie", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const owner = await accessTokenForTest(world.owner.id);
    const credentials: Array<[string, Record<string, string>]> = [
      ["the owner's token", { Authorization: `Bearer ${owner}`, "X-Server-Id": world.server.id }],
      ["a cookie", { Cookie: `raft_session=${owner}; token=${owner}` }],
      ["a garbage token", { Authorization: "Bearer not-a-token" }],
    ];
    const anonymous = await view(app.baseUrl, world.open.item.id);
    const framedClaims: ArtifactContentTicketClaims[] = [];
    for (const [why, headers] of credentials) {
      const answer = await view(app.baseUrl, world.open.item.id, headers);
      assert.deepEqual([answer.status, answer.body], [anonymous.status, anonymous.body], why);
      assertPrivateAnswer(answer, why);
      // The owner sees their server-home Artifact signed in; here their token opens nothing more.
      const whole = await view(app.baseUrl, world.whole.item.id, headers);
      assert.deepEqual([whole.status, whole.body], [404, NOT_VISIBLE], `${why}: a server home`);
      const framed = await frame(app.baseUrl, world.open.item.id, headers);
      assert.equal(framed.status, 200, why);
      framedClaims.push(await claimsOf(framed.body));
      assertPrivateAnswer(framed, `${why}: frame`);
    }
    // Witness: the same token does open the server-home Artifact on the signed-in route.
    const signedIn = await fetch(`${app.baseUrl}${artifactWebPaths.viewer(asArtifactId(world.whole.item.id))}`, {
      headers: { Authorization: `Bearer ${owner}`, "X-Server-Id": world.server.id },
    });
    assert.equal(signedIn.status, 200);
    // Every frame is the anonymous one: no user anywhere in its ticket.
    assert.equal(framedClaims.length, credentials.length);
    for (const claims of framedClaims) {
      assert.equal(claims.viewer, "anonymous");
      assert.ok(!JSON.stringify(claims).includes(world.owner.id), "no user id in the ticket");
    }
    assert.equal(worker.calls.length, 0);
  } finally {
    await worker.close();
  }
});

// ---- the frame -----------------------------------------------------------------

test("the frame signs an anonymous ticket of the current version, exactly so, without calling the Worker", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const unconfigured = await frame(app.baseUrl, world.open.item.id);
  assert.deepEqual([unconfigured.status, unconfigured.body.code], [503, "CONTENT_UNAVAILABLE"], "no content origin configured");
  const worker = await startWorker();
  try {
    const answer = await frame(app.baseUrl, world.open.item.id);
    assert.equal(answer.status, 200);
    assertPrivateAnswer(answer, "frame");
    assert.equal(answer.body.origin, originOf(world.open.item.id));
    const { expires: _expires, nonce: _nonce, ...claims } = await claimsOf(answer.body);
    assert.deepEqual(claims, {
      artifact: world.open.item.id,
      version: world.open.v2.id,
      viewer: "anonymous",
      subject: anonymousSubject(world.open.item.id, world.open.v2.id),
      origin: originOf(world.open.item.id),
    });
    const sheet = await frame(app.baseUrl, world.sheet.item.id);
    assert.deepEqual([sheet.status, sheet.body.code], [409, "NOT_FRAMED"]);
    assert.equal(worker.calls.length, 0, "the Worker is never called");
  } finally {
    await worker.close();
  }
});

// ---- index.md and meta (AI tools, link previews) ------------------------------------

/** A signed-out GET of `path`: the raw text, not parsed. */
async function askText(baseUrl: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
// Written out, not artifactPublicPaths.markdown (which writes the short id): the route must keep reading the pt_ form too.
const markdown = (baseUrl: string, id: string) => askText(baseUrl, `/api/public/artifacts/${encodeURIComponent(id)}/index.md`);
const meta = (baseUrl: string, id: string) => ask(baseUrl, "GET", artifactPublicPaths.meta(asArtifactId(id)));

/** Public Artifacts of `world.server`, each with one entry file of these bytes, current. */
async function publicWith(world: Awaited<ReturnType<typeof seedWorld>>, path: string, body: string, home: "public" | "server" | { channelId: string } = "public") {
  const serverId = asServerId(world.server.id);
  const author: Actor = { type: "user", id: world.owner.id };
  const item = await insertItem({ serverId, author, home });
  const version = await publish(serverId, author, { itemId: item.id, number: 1, path, bytes: Buffer.from(body, "utf8") });
  return { item, version };
}

const API = "https://api.example.test";

/** index.md's header and Files section for an Artifact whose one file is its entry. */
const headerOf = (world: Awaited<ReturnType<typeof seedWorld>>, made: { item: { id: string; title: string }; version: { createdAt: Date; entry: string; sizeBytes: number } }) => [
  `# ${made.item.title}`,
  "",
  `Updated ${made.version.createdAt.toISOString().slice(0, 10)}`,
  "",
  // The link a person would share: the short id (artifactLinkId), never pt_.
  `Source: ${appUrl()}/artifacts/${artifactLinkId(asArtifactId(made.item.id))}`,
  "",
  "## Files",
  "",
  // Where each file is, in words: an AI tool's summary may drop the links below.
  `Each file is at ${API}/api/public/artifacts/${artifactLinkId(asArtifactId(made.item.id))}/files/<path>, for example ${API}/api/public/artifacts/${artifactLinkId(asArtifactId(made.item.id))}/files/${made.version.entry}.`,
  "",
  // The file links write the id the same way.
  `- [All files (zip)](${API}/api/public/artifacts/${artifactLinkId(asArtifactId(made.item.id))}/download.zip)`,
  `- [${made.version.entry}](${API}/api/public/artifacts/${artifactLinkId(asArtifactId(made.item.id))}/files/${made.version.entry}) — ${made.version.sizeBytes} B (entry file)`,
  "",
  "---",
  "",
  "",
].join("\n");

test("index.md: a Markdown entry as is under the header, as text/plain (ChatGPT's fetch refuses text/markdown) that never renders, never cached, noindex, naming no one", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  vi.stubEnv("SERVER_URL", `${API}/`);
  const world = await seedWorld(seed);
  const body = "## Plan\n\nShip it **today**. <script>alert(1)</script>\n";
  const doc = await publicWith(world, "README.md", body);
  const answer = await markdown(app.baseUrl, doc.item.id);
  assert.equal(answer.status, 200);
  assert.equal(answer.text, `${headerOf(world, doc)}${body}`);
  assert.equal(answer.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
  assert.equal(answer.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(answer.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(answer.headers.get("cache-control"), "private, no-store");
  assert.equal(answer.headers.get("set-cookie"), null);
  for (const name of [world.owner.displayName!, world.owner.name, world.server.name, world.server.slug]) {
    assert.ok(!answer.text.includes(name), `names no one and no server: ${name}`);
  }
  // A text and a CSV entry: their text.
  const csv = await publicWith(world, "data.csv", "a,b\n1,2\n");
  assert.equal((await markdown(app.baseUrl, csv.item.id)).text, `${headerOf(world, csv)}a,b\n1,2\n`);
  const txt = await publicWith(world, "notes.txt", "  hello notes  ");
  assert.equal((await markdown(app.baseUrl, txt.item.id)).text, `${headerOf(world, txt)}hello notes\n`);
});

test("index.md: an HTML entry's readable text, never its markup, scripts or styles; anything else a stub", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  vi.stubEnv("SERVER_URL", API);
  const world = await seedWorld(seed);
  const html = [
    "<!doctype html><html><head><title>Ignored</title><style>body{color:red}</style>",
    "<script>var secret = '<p>not text</p>';</script></head><body>",
    "<h1>Quarterly &amp; report</h1><p>Revenue grew <b>12%</b>.</p>",
    "<noscript>Enable JS</noscript><template><p>hidden</p></template>",
    "<svg><text>chart label</text><g><text>more</text></g></svg>",
    "<ul><li>One</li><li>Two</li></ul><!-- a comment --></body></html>",
  ].join("");
  const page = await publicWith(world, "index.html", html);
  const answer = await markdown(app.baseUrl, page.item.id);
  assert.equal(answer.status, 200);
  const extract = "## Text\n\n_An extract of the page's readable text. The original is the entry file under Files._\n\n";
  assert.equal(answer.text, `${headerOf(world, page)}${extract}# Quarterly & report\n\nRevenue grew 12%.\n\n- One\n- Two\n`);
  for (const absent of ["<", "secret", "color:red", "Enable JS", "hidden", "chart label", "Ignored", "comment"]) {
    assert.ok(!answer.text.slice(headerOf(world, page).length).includes(absent), `no ${absent}`);
  }
  // An image: a stub naming what it is, with the page's address.
  const image = await publicWith(world, "photo.png", "\x89PNG");
  const stub = await markdown(app.baseUrl, image.item.id);
  assert.equal(stub.status, 200);
  assert.equal(stub.text, `${headerOf(world, image)}_This Artifact is an image, which has no text version: download it from Files above, or open ${appUrl()}/artifacts/${artifactLinkId(asArtifactId(image.item.id))}._\n`);
});

test("index.md is at most 200 KB, cut at a character with a note", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const long = await publicWith(world, "long.md", "é".repeat(300 * 1024));
  const answer = await markdown(app.baseUrl, long.item.id);
  assert.equal(answer.status, 200);
  assert.ok(Buffer.byteLength(answer.text, "utf8") <= ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES, "within the cap");
  assert.ok(!answer.text.includes("�"), "no character split");
  assert.match(answer.text, /_\[Truncated\. The full file is under Files; the Artifact is at .+\]_\n$/);
});

/** A public Artifact of several files (an HTML entry, a stylesheet, an image, a nested path with a space), current. */
async function publicSite(world: Awaited<ReturnType<typeof seedWorld>>) {
  const serverId = asServerId(world.server.id);
  const author: Actor = { type: "user", id: world.owner.id };
  const item = await insertItem({ serverId, author, home: "public" });
  const files = [
    { path: "index.html", bytes: Buffer.from("<h1>Site</h1><script>alert(1)</script>") },
    { path: "style.css", bytes: Buffer.from("body { color: red }") },
    { path: "img/logo (1).png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 7]) },
  ];
  const db = getDb();
  const versionId = `v_${randomUUID()}`;
  const [version] = await db.insert(artifactVersions).values({
    id: versionId, itemId: item.id, number: 1, entry: "index.html", title: null, fileCount: files.length, sizeBytes: files.reduce((n, f) => n + f.bytes.length, 0),
    publishDigest: "digest", status: "published", publisherType: author.type, publisherId: author.id, position: 1,
  }).returning();
  for (const file of files) {
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const blobId = `b_${randomUUID()}`;
    const r2Key = r2KeyOf(serverId, sha256, blobId);
    storedObjects.set(r2Key, file.bytes);
    await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: file.bytes.length, state: "ready", r2Key });
    await db.insert(artifactVersionFiles).values({ versionId, path: file.path, sha256, sizeBytes: file.bytes.length, blobId });
  }
  await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, item.id));
  return { item, version: version!, files };
}

/**
 * A signed-out GET of one file, the path sent exactly as written (node:http,
 * not fetch, whose URL parsing would resolve `%2e%2e` before sending): its
 * bytes as they came.
 */
function download(baseUrl: string, id: string, rawPath: string): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname, port, path: `/api/public/artifacts/${id}/files/${rawPath}` }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") headers.set(name, value);
        resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks), headers });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

test("files: a text file and a binary download as published, as attachments that never render or run on the API origin", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  const cases: Array<[string, string, Buffer, string, string]> = [
    ["the HTML entry", "index.html", site.files[0]!.bytes, "text/plain; charset=utf-8", "index.html"],
    ["a stylesheet", "style.css", site.files[1]!.bytes, "text/plain; charset=utf-8", "style.css"],
    ["a nested binary", "img/logo%20(1).png", site.files[2]!.bytes, "application/octet-stream", "logo (1).png"],
  ];
  for (const [why, rawPath, bytes, type, name] of cases) {
    const answer = await download(app.baseUrl, site.item.id, rawPath);
    assert.equal(answer.status, 200, why);
    assert.deepEqual(answer.bytes, bytes, `${why}: bytes intact`);
    assert.equal(answer.headers.get("content-type"), type, why);
    assert.equal(answer.headers.get("content-disposition"), `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`, why);
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff", why);
    assert.equal(answer.headers.get("content-security-policy"), "default-src 'none'; sandbox", why);
    assert.equal(answer.headers.get("x-robots-tag"), "noindex, nofollow", why);
    assert.equal(answer.headers.get("cache-control"), "private, no-store", why);
    assert.equal(answer.headers.get("set-cookie"), null, why);
  }
  // The contract's path builder reaches the same file.
  const built = await fetch(`${app.baseUrl}${artifactPublicPaths.file(asArtifactId(site.item.id), "img/logo (1).png")}`);
  assert.deepEqual([built.status, Buffer.from(await built.arrayBuffer())], [200, site.files[2]!.bytes]);
});

test("files: traversal, a malformed path, a path not in the version and a non-public Artifact are all the one 404", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  for (const [why, rawPath] of [
    ["not in the version", "secret.txt"],
    ["a directory, not a file", "img"],
    ["a different case", "INDEX.html"],
    ["an encoded traversal", "%2e%2e/%2e%2e/etc/passwd"],
    ["a traversal inside the version", "img/%2e%2e/index.html"],
    ["a doubly encoded traversal", "%252e%252e/index.html"],
    ["a backslash", "img%5Clogo%20(1).png"],
    ["a raw traversal", "../../../etc/passwd"],
    ["a raw traversal to another file", "img/../index.html"],
    ["an undecodable segment", "%E0%A4%A"],
  ] as const) {
    const answer = await download(app.baseUrl, site.item.id, rawPath);
    assert.equal(answer.status, 404, why);
    assert.deepEqual(JSON.parse(answer.bytes.toString("utf8")), NOT_VISIBLE, why);
  }
  for (const [why, id] of [
    ["a server home", world.whole.item.id],
    ["a conversation home", world.inRoom.item.id],
    ["deleted", world.deleted.item.id],
    ["no such id", `pt_${randomUUID()}`],
  ] as const) {
    const answer = await download(app.baseUrl, id, "index.html");
    assert.deepEqual([answer.status, JSON.parse(answer.bytes.toString("utf8"))], [404, NOT_VISIBLE], why);
  }
  // Witness: the version's own file answers.
  assert.equal((await download(app.baseUrl, site.item.id, "index.html")).status, 200);
});

test("index.md's Files section lists every file of the current version, linked to its download, the entry marked", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  vi.stubEnv("SERVER_URL", API);
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  const answer = await markdown(app.baseUrl, site.item.id);
  assert.equal(answer.status, 200);
  const files = /## Files\n\n([\s\S]*?)\n\n---/.exec(answer.text)?.[1];
  const short = artifactLinkId(asArtifactId(site.item.id));
  assert.notEqual(short, site.item.id, "a real pt_<uuid>: its links write the short id");
  const base = `${API}/api/public/artifacts/${short}/files`;
  assert.equal(files, [
    `Each file is at ${base}/<path>, for example ${base}/index.html.`,
    "",
    `- [All files (zip)](${API}/api/public/artifacts/${short}/download.zip)`,
    `- [img/logo (1).png](${base}/img/logo%20%281%29.png) — 11 B`,
    `- [index.html](${base}/index.html) — ${site.files[0]!.bytes.length} B (entry file)`,
    `- [style.css](${base}/style.css) — ${site.files[1]!.bytes.length} B`,
  ].join("\n"));
  // Each link downloads its file.
  const link = `${app.baseUrl}${`/api/public/artifacts/${short}/files/img/logo%20%281%29.png`}`;
  const res = await fetch(link);
  assert.deepEqual([res.status, Buffer.from(await res.arrayBuffer())], [200, site.files[2]!.bytes]);
  // Without SERVER_URL the links are relative to index.md.
  vi.stubEnv("SERVER_URL", "");
  assert.match((await markdown(app.baseUrl, site.item.id)).text, /\n- \[index\.html\]\(files\/index\.html\) — /);
});

test("meta lists every file of the current version, the entry marked", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  const answer = await meta(app.baseUrl, site.item.id);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.files, [
    { path: "img/logo (1).png", size: 11, entry: false },
    { path: "index.html", size: site.files[0]!.bytes.length, entry: true },
    { path: "style.css", size: site.files[1]!.bytes.length, entry: false },
  ]);
});

test("download.zip: every file of the current version, paths and bytes intact, as an attachment never cached; non-public the one 404", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  const res = await fetch(`${app.baseUrl}${artifactPublicPaths.downloadZip(asArtifactId(site.item.id))}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition") ?? "", new RegExp(`^attachment; filename="Artifact ${site.item.id.slice(3, 11)}\\.zip"`));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const zip = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get("content-length")), zip.length);
  const entries = readStoredZip(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ["img/logo (1).png", "index.html", "style.css"]);
  const byPath = new Map(site.files.map((file) => [file.path, file.bytes]));
  for (const entry of entries) assert.deepEqual(entry.bytes, byPath.get(entry.name), entry.name);
  for (const [why, id] of [
    ["a server home", world.whole.item.id],
    ["a conversation home", world.inRoom.item.id],
    ["deleted", world.deleted.item.id],
    ["revoked", world.revoked.item.id],
    ["no such id", `pt_${randomUUID()}`],
  ] as const) {
    const refused = await ask(app.baseUrl, "GET", artifactPublicPaths.downloadZip(asArtifactId(id)));
    assert.deepEqual([refused.status, refused.body], [404, NOT_VISIBLE], why);
  }
  // Unpublished: the next download is refused at once (nothing cached).
  const owner = { Authorization: `Bearer ${await accessTokenForTest(world.owner.id)}`, "X-Server-Id": world.server.id };
  assert.equal((await fetch(`${app.baseUrl}${artifactWebPaths.unpublish(asArtifactId(site.item.id))}`, { method: "POST", headers: owner })).status, 200);
  for (const path of [artifactPublicPaths.downloadZip(asArtifactId(site.item.id)), artifactPublicPaths.markdown(asArtifactId(site.item.id)), artifactPublicPaths.meta(asArtifactId(site.item.id)), artifactPublicPaths.file(asArtifactId(site.item.id), "index.html")]) {
    assert.equal((await fetch(`${app.baseUrl}${path}`)).status, 404, `after unpublish: ${path}`);
  }
});

test("the short id reaches index.md, meta, a file and download.zip, the same answers as the pt_ id", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  const short = artifactLinkId(asArtifactId(site.item.id));
  assert.match(short, /^[1-9A-HJ-NP-Za-km-z]{22}$/);
  const [byShort, byId] = [await markdown(app.baseUrl, short), await markdown(app.baseUrl, site.item.id)];
  assert.equal(byShort.status, 200);
  assert.equal(byShort.text, byId.text, "index.md");
  assert.match(byShort.text, new RegExp(`\\nSource: [^\\n]*/artifacts/${short}\\n`), "its Source is the short link");
  const shortMeta = await meta(app.baseUrl, short);
  assert.equal(shortMeta.status, 200);
  assert.deepEqual(shortMeta.body, (await meta(app.baseUrl, site.item.id)).body, "meta");
  const file = await download(app.baseUrl, short, "img/logo%20(1).png");
  assert.deepEqual([file.status, file.bytes], [200, site.files[2]!.bytes], "a file");
  // Without `files/`, as an AI tool guesses from a path: the same file; the named routes still win.
  const guessed = await fetch(`${app.baseUrl}/api/public/artifacts/${short}/img/logo%20(1).png`);
  assert.equal(guessed.status, 200, "a file at its path");
  assert.deepEqual(Buffer.from(await guessed.arrayBuffer()), site.files[2]!.bytes);
  assert.equal(guessed.headers.get("content-disposition"), file.headers.get("content-disposition"), "an attachment, as from files/");
  assert.equal((await fetch(`${app.baseUrl}/api/public/artifacts/${short}/nothing-here.txt`)).status, 404, "a path that isn't a file: the one 404");
  const zip = await fetch(`${app.baseUrl}/api/public/artifacts/${short}/download.zip`);
  assert.equal(zip.status, 200, "download.zip");
  assert.deepEqual(readStoredZip(Buffer.from(await zip.arrayBuffer())).map((entry) => entry.name), ["img/logo (1).png", "index.html", "style.css"]);
  // A short id naming an Artifact a visitor may not see: the same one 404 on each.
  const hidden = artifactLinkId(asArtifactId(world.whole.item.id));
  assert.deepEqual(
    [(await markdown(app.baseUrl, hidden)).status, (await meta(app.baseUrl, hidden)).status, (await download(app.baseUrl, hidden, "index.html")).status, (await fetch(`${app.baseUrl}/api/public/artifacts/${hidden}/download.zip`)).status, (await fetch(`${app.baseUrl}/api/public/artifacts/${hidden}/index.html`)).status],
    [404, 404, 404, 404, 404],
  );
});

// ---- download.zip: archives built at once (zipSlots.ts) ----------------------------------

/** The zip outcomes counted so far (slock_app_operations_total, operation public_zip). */
async function zipCounts(): Promise<Record<string, number>> {
  const { values } = await appOperationsTotal.get();
  return Object.fromEntries(values
    .filter((value) => value.labels.app === "artifacts" && value.labels.operation === "public_zip")
    .map((value) => [String(value.labels.outcome), value.value]));
}
const grew = (before: Record<string, number>, after: Record<string, number>, outcome: string) => (after[outcome] ?? 0) - (before[outcome] ?? 0);

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** memoryR2, but a read of the blob of these bytes waits for `open()`; `waiting` resolves when one does. */
function gatedR2(gatedBytes: Buffer, blockedAt: "request" | "body" = "request") {
  const gatedSha = sha256Of(gatedBytes);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  const store: ArtifactR2Store = {
    ...memoryR2,
    async read(blob) {
      // The key is r2KeyOf's, `servers/<server>/blobs/<sha256>/<blob id>`.
      if (blob.r2Key.includes(`/blobs/${gatedSha}/`)) {
        if (blockedAt === "body") {
          const body = new Readable({ read() { reached(); } });
          void gate.then(() => { body.push(gatedBytes); body.push(null); });
          return { stream: body, size: gatedBytes.length };
        }
        reached();
        await gate;
      }
      return memoryR2.read(blob);
    },
  };
  return { store, open, waiting };
}

/** Polls until `check` holds (the server frees a slot when the stream closes, just after the client sees the end). */
async function eventually(check: () => boolean, what: string) {
  const until = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("download.zip: with the cap at 1, a second download at once is 429 BUSY with Retry-After; the slot frees when the first ends", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_PUBLIC_ZIP_CONCURRENCY", "1");
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  // The archive's first file (by path) waits, so the first download is in flight.
  const gated = gatedR2(site.files[2]!.bytes);
  __setArtifactR2StoreForTests(gated.store);
  const url = `${app.baseUrl}${artifactPublicPaths.downloadZip(asArtifactId(site.item.id))}`;
  const before = await zipCounts();

  const first = fetch(url).then(async (res) => ({ status: res.status, zip: Buffer.from(await res.arrayBuffer()) }));
  await gated.waiting;
  assert.equal(publicZipsInFlight(), 1);
  const busy = await fetch(url);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.equal(busy.headers.get("cache-control"), "private, no-store");
  assert.equal(busy.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(((await busy.json()) as { code: string }).code, "BUSY");

  gated.open();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(readStoredZip(done.zip).length, 3);
  await eventually(() => publicZipsInFlight() === 0, "the slot freed after completion");
  assert.equal((await fetch(url)).status, 200, "the next download is built");
  await eventually(() => publicZipsInFlight() === 0, "and freed again");

  const after = await zipCounts();
  assert.equal(grew(before, after, "started"), 2);
  assert.equal(grew(before, after, "busy"), 1);
  assert.equal(grew(before, after, "failed"), 0);
});

test("download.zip: the slot frees after a failed archive and after the client goes away mid-download", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_PUBLIC_ZIP_CONCURRENCY", "1");
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const site = await publicSite(world);
  const url = `${app.baseUrl}${artifactPublicPaths.downloadZip(asArtifactId(site.item.id))}`;
  const before = await zipCounts();

  // A file whose bytes are gone from storage: the archive fails part-way (the answer is cut).
  const missingSha = sha256Of(site.files[1]!.bytes);
  __setArtifactR2StoreForTests({ ...memoryR2, read: async (blob) => (blob.r2Key.includes(`/blobs/${missingSha}/`) ? null : memoryR2.read(blob)) });
  await assert.rejects(fetch(url).then((res) => res.arrayBuffer()), "the answer is cut, never a whole-looking archive");
  await eventually(() => publicZipsInFlight() === 0, "the slot freed after the failure");
  assert.equal(grew(before, await zipCounts(), "failed"), 1);

  // The client goes away while the archive waits on a file.
  const gated = gatedR2(site.files[2]!.bytes);
  __setArtifactR2StoreForTests(gated.store);
  const controller = new AbortController();
  const abandoned = fetch(url, { signal: controller.signal }).then((res) => res.arrayBuffer()).catch(() => null);
  await gated.waiting;
  assert.equal(publicZipsInFlight(), 1);
  controller.abort();
  await abandoned;
  gated.open();
  await eventually(() => publicZipsInFlight() === 0, "the slot freed after the client left");
  __setArtifactR2StoreForTests(memoryR2);
  assert.equal((await fetch(url)).status, 200, "the next download is built");
  await eventually(() => publicZipsInFlight() === 0, "and freed again");
});

for (const blockedAt of ["request", "body"] as const) {
  test(`download.zip: an archive holding its slot past the limit (a ${blockedAt} read that never returns) is ended, counted as a timeout, and the slot frees`, async ({ app, seed }) => {
    vi.stubEnv("ARTIFACTS_PUBLIC_ZIP_CONCURRENCY", "1");
    __setPublicZipMaxOpenMsForTests(200);
    onTestFinished(() => __setPublicZipMaxOpenMsForTests(null));
    const world = await seedWorld(seed);
    const site = await publicSite(world);
    const gated = gatedR2(site.files[2]!.bytes, blockedAt);
    __setArtifactR2StoreForTests(gated.store);
    onTestFinished(() => gated.open());
    const url = `${app.baseUrl}${artifactPublicPaths.downloadZip(asArtifactId(site.item.id))}`;
    const before = await zipCounts();

    const stuck = fetch(url).then((res) => res.arrayBuffer());
    await gated.waiting;
    assert.equal(publicZipsInFlight(), 1);
    // Bound the regression itself: Readable.from can wait for its pending
    // generator read before closing, even after destroy(). A missing close
    // must fail this assertion rather than hang the file with no timeout.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        stuck.then(() => "complete", () => "cut"),
        new Promise<"still open">((resolve) => { deadline = setTimeout(() => resolve("still open"), 2_000); }),
      ]);
      assert.equal(outcome, "cut", "the server cuts the HTTP answer without waiting for storage");
    } finally {
      if (deadline) clearTimeout(deadline);
      gated.open();
      await stuck.catch(() => undefined);
    }
    await eventually(() => publicZipsInFlight() === 0, "the overdue slot freed");
    const counted = await zipCounts();
    assert.equal(grew(before, counted, "timeout"), 1);
    assert.equal(grew(before, counted, "failed"), 0, "ended, not a failed file");

    gated.open();
    __setArtifactR2StoreForTests(memoryR2);
    const next = await fetch(url);
    assert.equal(next.status, 200, "the next download is built");
    assert.equal(readStoredZip(Buffer.from(await next.arrayBuffer())).length, 3);
    await eventually(() => publicZipsInFlight() === 0, "and freed again");
    assert.equal(grew(before, await zipCounts(), "timeout"), 1, "a download within the limit is not ended");
  });
}

test("ARTIFACTS_PUBLIC_ZIP_CONCURRENCY is clamped to 1..32, the default 4", () => {
  for (const [raw, expected] of [[undefined, 4], ["", 4], ["x", 4], ["0", 1], ["-3", 1], ["2.7", 2], ["8", 8], ["1000", 32]] as const) {
    assert.equal(publicZipConcurrency(raw), expected, String(raw));
  }
});

test("index.md and meta answer the view's one 404 for every Artifact a visitor may not see, and for every one with Artifacts off, and meta names nothing of them", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const cases: Array<[string, string]> = [
    ["a conversation home", world.inRoom.item.id],
    ["a server home", world.whole.item.id],
    ["deleted", world.deleted.item.id],
    ["revoked", world.revoked.item.id],
    ["never published", world.draft.id],
    ["no such id", `pt_${randomUUID()}`],
    ["a malformed id", "not-an-id"],
  ];
  for (const [why, id] of cases) {
    const md = await markdown(app.baseUrl, id);
    assert.deepEqual([md.status, JSON.parse(md.text)], [404, NOT_VISIBLE], `index.md: ${why}`);
    assert.equal(md.headers.get("cache-control"), "private, no-store", `index.md: ${why}: a refusal is never cached`);
    assert.match(md.headers.get("content-type") ?? "", /^application\/json/, `index.md: ${why}`);
    const described = await meta(app.baseUrl, id);
    assert.deepEqual([described.status, described.body], [404, NOT_VISIBLE], `meta: ${why}`);
    assertPrivateAnswer(described, `meta: ${why}`);
  }
  // A signed-in owner's credential opens nothing more.
  const owner = { Authorization: `Bearer ${await accessTokenForTest(world.owner.id)}`, "X-Server-Id": world.server.id };
  assert.equal((await ask(app.baseUrl, "GET", artifactPublicPaths.meta(asArtifactId(world.whole.item.id)), owner)).status, 404);
  assert.equal((await askText(app.baseUrl, artifactPublicPaths.markdown(asArtifactId(world.whole.item.id)), owner)).status, 404);
  // Witness: the public one answers both.
  assert.equal((await markdown(app.baseUrl, world.open.item.id)).status, 200);
  assert.equal((await meta(app.baseUrl, world.open.item.id)).status, 200);
  // Artifacts off: the public one is the same 404 for both.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const md = await markdown(app.baseUrl, world.open.item.id);
  assert.deepEqual([md.status, JSON.parse(md.text)], [404, NOT_VISIBLE], "index.md: Artifacts off");
  const described = await meta(app.baseUrl, world.open.item.id);
  assert.deepEqual([described.status, described.body], [404, NOT_VISIBLE], "meta: Artifacts off");
});

test("meta: exactly ArtifactPublicMeta, its description the start of the text, cut at a word with …", async ({ app, seed }) => {
  __setArtifactR2StoreForTests(memoryR2);
  const world = await seedWorld(seed);
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const page = await publicWith(world, "index.html", `<html><head><script>x()</script></head><body><h1>Hello</h1><p>${words}</p></body></html>`);
  const answer = await meta(app.baseUrl, page.item.id);
  assert.equal(answer.status, 200);
  assertPrivateAnswer(answer, "meta");
  assert.deepEqual(Object.keys(answer.body).sort(), ["description", "entry", "files", "kind", "title", "updatedAt"]);
  const { description, ...rest } = answer.body as ArtifactPublicMeta;
  assert.deepEqual(rest, {
    title: page.item.title,
    updatedAt: page.version.createdAt.toISOString(),
    kind: "html",
    entry: "index.html",
    files: [{ path: "index.html", size: page.version.sizeBytes, entry: true }],
  });
  for (const name of [world.owner.displayName!, world.owner.name, world.server.name, world.server.slug]) {
    assert.ok(!JSON.stringify(answer.body).includes(name), `names no one and no server: ${name}`);
  }
  assert.ok(description.endsWith("…"), description);
  assert.ok(description.length <= 161, description);
  assert.ok(description.startsWith("Hello word0 word1"), description);
  assert.match(description.slice(0, -1), /word\d+$/, "cut at a word");
  // Short Markdown: whole, its markup dropped, no "…".
  const doc = await publicWith(world, "notes.md", "# Title\n\n- **Bold** point\n");
  assert.equal((await meta(app.baseUrl, doc.item.id)).body.description, "Title Bold point");
  // No text: a line saying what it is.
  const image = await publicWith(world, "photo.png", "\x89PNG");
  assert.equal((await meta(app.baseUrl, image.item.id)).body.description, "An Artifact shared from Raft: an image.");
});

// ---- index.md and meta from the stored text (version_texts, publicText.ts) ------------

/** `base`, counting every read of a blob's bytes. */
function countingR2(base: ArtifactR2Store = memoryR2) {
  const counter = { reads: 0 };
  const store: ArtifactR2Store = { ...base, async read(blob) { counter.reads += 1; return base.read(blob); } };
  return { store, counter };
}

const textRowOf = async (versionId: string) => (await getDb().select().from(artifactVersionTexts).where(eq(artifactVersionTexts.versionId, versionId)))[0] ?? null;

/** A row for `versionId` as a test wants it (a planted or stale one). */
async function plantText(versionId: string, row: Partial<typeof artifactVersionTexts.$inferInsert> & { description: string }) {
  await getDb().insert(artifactVersionTexts).values({ versionId, extractor: READABLE_TEXT_EXTRACTOR, kind: "markdown", body: row.description, truncated: false, ...row })
    .onConflictDoUpdate({ target: artifactVersionTexts.versionId, set: { extractor: row.extractor ?? READABLE_TEXT_EXTRACTOR, kind: row.kind ?? "markdown", description: row.description, body: row.body ?? row.description } });
}

/** The public_text outcomes counted so far (slock_app_operations_total). */
async function textCounts(): Promise<Record<string, number>> {
  const { values } = await appOperationsTotal.get();
  return Object.fromEntries(values
    .filter((value) => value.labels.app === "artifacts" && value.labels.operation === "public_text")
    .map((value) => [String(value.labels.outcome), value.value]));
}
const grewBy = (before: Record<string, number>, after: Record<string, number>) =>
  Object.fromEntries(["hit", "miss", "filled", "fill_failed"].map((outcome) => [outcome, (after[outcome] ?? 0) - (before[outcome] ?? 0)]));

test("index.md and meta: the first views read the entry once for both and store it; later ones read no storage and answer the same bytes", async ({ app, seed }) => {
  const r2 = countingR2();
  __setArtifactR2StoreForTests(r2.store);
  vi.stubEnv("SERVER_URL", API);
  const world = await seedWorld(seed);
  const made = [
    await publicWith(world, "README.md", "## Plan\n\nShip it **today**. <script>alert(1)</script>\n"),
    await publicWith(world, "index.html", "<h1>Hello</h1><p>Revenue <img src=c.png alt='by quarter'> grew.</p><script>x()</script>"),
    await publicWith(world, "data.csv", "a,b\n1,2\n"),
    await publicWith(world, "notes.txt", "  hello notes  "),
    await publicWith(world, "empty.md", "  \n\n"),
    // Cut on reading, and cut again to the cap: the same cut from the row.
    await publicWith(world, "long.md", "é".repeat(300 * 1024)),
    await publicWith(world, "page.html", `<p>${"word ".repeat(60 * 1024)}</p>`),
  ];
  for (const { item, version } of made) {
    const what = version.entry;
    r2.counter.reads = 0;
    // The edge Worker asks both at once: they share one read.
    const [md, described] = await Promise.all([markdown(app.baseUrl, item.id), meta(app.baseUrl, item.id)]);
    assert.deepEqual([md.status, described.status], [200, 200], what);
    assert.equal(r2.counter.reads, 1, `${what}: one read for both`);
    await __settlePublicTextFillsForTests();
    const row = await textRowOf(version.id);
    assert.ok(row, `${what}: stored`);
    assert.equal(row.extractor, READABLE_TEXT_EXTRACTOR, what);
    assert.equal(row.kind, described.body.kind, what);
    assert.ok(Buffer.byteLength(row.body, "utf8") <= ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES, `${what}: at most the cap`);

    // From the row: no storage read, the same bytes.
    const before = await textCounts();
    r2.counter.reads = 0;
    const again = { md: await markdown(app.baseUrl, item.id), meta: await meta(app.baseUrl, item.id) };
    assert.equal(r2.counter.reads, 0, `${what}: no storage read`);
    assert.equal(again.md.text, md.text, `${what}: index.md byte for byte`);
    assert.equal(again.md.headers.get("cache-control"), "private, no-store", what);
    assert.deepEqual(again.meta.body, described.body, `${what}: meta`);
    assert.deepEqual(grewBy(before, await textCounts()), { hit: 2, miss: 0, filled: 0, fill_failed: 0 }, what);
  }
  // What they say (the storage path's answers, unchanged but for extractor 1's alt text).
  assert.equal((await markdown(app.baseUrl, made[1]!.item.id)).text.slice(headerOf(world, made[1]!).length), "## Text\n\n_An extract of the page's readable text. The original is the entry file under Files._\n\n# Hello\n\nRevenue by quarter grew.\n");
  assert.equal((await meta(app.baseUrl, made[1]!.item.id)).body.description, "Hello Revenue by quarter grew.");
  assert.equal((await meta(app.baseUrl, made[4]!.item.id)).body.description, "An Artifact shared from Raft: a document.");
  assert.match((await markdown(app.baseUrl, made[5]!.item.id)).text, /_\[Truncated\. The full file is under Files; the Artifact is at .+\]_\n$/);
  // A kind with no text has nothing to store and reads nothing.
  const image = await publicWith(world, "photo.png", "\x89PNG");
  r2.counter.reads = 0;
  assert.equal((await meta(app.baseUrl, image.item.id)).body.description, "An Artifact shared from Raft: an image.");
  await __settlePublicTextFillsForTests();
  assert.deepEqual([r2.counter.reads, await textRowOf(image.version.id)], [0, null]);
});

test("a view whose read fails answers as before (the stub) and stores nothing; the next view reads again and stores it", async ({ app, seed }) => {
  vi.stubEnv("SERVER_URL", API);
  const world = await seedWorld(seed);
  const doc = await publicWith(world, "notes.md", "Keep this.\n");
  const before = await textCounts();
  // The bytes missing, then storage not configured.
  for (const store of [{ ...memoryR2, async read() { return null; } } satisfies ArtifactR2Store, null]) {
    __setArtifactR2StoreForTests(store);
    assert.equal((await meta(app.baseUrl, doc.item.id)).body.description, "An Artifact shared from Raft: a document.");
    assert.equal((await markdown(app.baseUrl, doc.item.id)).text, `${headerOf(world, doc)}_This Artifact has no text to show here. Open ${appUrl()}/artifacts/${artifactLinkId(asArtifactId(doc.item.id))} to view it._\n`);
    await __settlePublicTextFillsForTests();
    assert.equal(await textRowOf(doc.version.id), null, "nothing stored");
  }
  assert.deepEqual(grewBy(before, await textCounts()), { hit: 0, miss: 4, filled: 0, fill_failed: 4 });
  const r2 = countingR2();
  __setArtifactR2StoreForTests(r2.store);
  assert.equal((await meta(app.baseUrl, doc.item.id)).body.description, "Keep this.");
  assert.equal(r2.counter.reads, 1);
  await __settlePublicTextFillsForTests();
  assert.equal((await textRowOf(doc.version.id))?.description, "Keep this.");
  assert.equal((await markdown(app.baseUrl, doc.item.id)).text, `${headerOf(world, doc)}Keep this.\n`);
  assert.equal(r2.counter.reads, 1, "index.md from the row");
});

test("a row of an older extractor or another kind is computed again and written over; one of this extractor (or newer) and kind is answered as stored", async ({ app, seed }) => {
  const r2 = countingR2();
  __setArtifactR2StoreForTests(r2.store);
  const world = await seedWorld(seed);
  const doc = await publicWith(world, "notes.md", "Fresh text.\n");
  for (const stale of [{ extractor: READABLE_TEXT_EXTRACTOR - 1 }, { kind: "text" }]) {
    await plantText(doc.version.id, { description: "STALE", ...stale });
    r2.counter.reads = 0;
    const answer = await meta(app.baseUrl, doc.item.id);
    assert.equal(answer.body.description, "Fresh text.", JSON.stringify(stale));
    assert.ok(!(await markdown(app.baseUrl, doc.item.id)).text.includes("STALE"), JSON.stringify(stale));
    await __settlePublicTextFillsForTests();
    const row = await textRowOf(doc.version.id);
    assert.deepEqual([row?.extractor, row?.kind, row?.description, row?.body], [READABLE_TEXT_EXTRACTOR, "markdown", "Fresh text.", "Fresh text."], JSON.stringify(stale));
    assert.ok(r2.counter.reads >= 1, `${JSON.stringify(stale)}: read again`);
  }
  // A current row is what they answer (the witness that the rows below are read), a newer one too, never overwritten.
  for (const extractor of [READABLE_TEXT_EXTRACTOR, READABLE_TEXT_EXTRACTOR + 1]) {
    await plantText(doc.version.id, { description: `FROM ROW ${extractor}`, extractor });
    r2.counter.reads = 0;
    assert.equal((await meta(app.baseUrl, doc.item.id)).body.description, `FROM ROW ${extractor}`);
    assert.match((await markdown(app.baseUrl, doc.item.id)).text, new RegExp(`FROM ROW ${extractor}\n$`));
    assert.equal(r2.counter.reads, 0);
  }
  await __settlePublicTextFillsForTests();
  assert.equal((await textRowOf(doc.version.id))?.extractor, READABLE_TEXT_EXTRACTOR + 1);
});

test("with rows stored, every Artifact a visitor may not see is still the one 404 for index.md and meta, nothing of its row", async ({ app, seed }) => {
  const r2 = countingR2();
  __setArtifactR2StoreForTests(r2.store);
  const world = await seedWorld(seed);
  const owner = { Authorization: `Bearer ${await accessTokenForTest(world.owner.id)}`, "X-Server-Id": world.server.id };
  const planted = async (why: string, made: { item: { id: string }; version: { id: string } }) => {
    await plantText(made.version.id, { description: `SECRET ${why}` });
    return [why, made.item.id] as [string, string];
  };
  // Witness: a planted row is what a public one answers.
  const witness = await publicWith(world, "w.md", "real");
  await plantText(witness.version.id, { description: "PLANTED" });
  assert.equal((await meta(app.baseUrl, witness.item.id)).body.description, "PLANTED");

  const unpublished = await publicWith(world, "u.md", "unpublished");
  const narrowed = await publicWith(world, "n.md", "narrowed");
  const takenDown = await publicWith(world, "t.md", "taken down");
  const revokedVersion = await publicWith(world, "r.md", "revoked version");
  const cases = [
    await planted("a conversation home", world.inRoom),
    await planted("a server home", world.whole),
    await planted("deleted", world.deleted),
    await planted("revoked", world.revoked),
    await planted("unpublished", unpublished),
    await planted("narrowed", narrowed),
    await planted("taken down", takenDown),
    await planted("its current version revoked", revokedVersion),
  ];
  assert.equal((await fetch(`${app.baseUrl}${artifactWebPaths.unpublish(asArtifactId(unpublished.item.id))}`, { method: "POST", headers: owner })).status, 200);
  await getDb().update(artifactItems).set({ homeKind: "conversation", homeChannelId: world.room.id }).where(eq(artifactItems.id, narrowed.item.id));
  assert.equal((await takedownArtifact({ kind: "ops", operator: "test" }, takenDown.item.id, "report")).kind, "done");
  await getDb().update(artifactVersions).set({ revokedAt: new Date() }).where(eq(artifactVersions.id, revokedVersion.version.id));
  const refuses = async (why: string, id: string) => {
    const md = await markdown(app.baseUrl, id);
    assert.deepEqual([md.status, JSON.parse(md.text)], [404, NOT_VISIBLE], `index.md: ${why}`);
    const described = await meta(app.baseUrl, id);
    assert.deepEqual([described.status, described.body], [404, NOT_VISIBLE], `meta: ${why}`);
    assertPrivateAnswer(described, `meta: ${why}`);
  };
  for (const [why, id] of cases) await refuses(why, id);
  // Artifacts off: the witness too.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  await refuses("Artifacts off", witness.item.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  // Its server deleted (the rows stay): the witness too.
  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, world.server.id));
  await refuses("its server deleted", witness.item.id);
  await __settlePublicTextFillsForTests();
  assert.equal(r2.counter.reads, 0, "no storage read for any of them");
  // Kept, not erased (Q4), and nothing new written.
  assert.equal((await textRowOf(takenDown.version.id))?.description, "SECRET taken down");
  assert.equal((await getDb().select().from(artifactVersionTexts)).length, cases.length + 1);
});

// ---- limits --------------------------------------------------------------------

limitedTest("each route is limited per client address: 429 past it, another address has its own budget, a credential no other", async ({ app, seed }) => {
  vi.stubEnv("TRUST_CLOUDFRONT_VIEWER_HEADERS", "true");
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const from = (ip: string, extra: Record<string, string> = {}) => ({ "CloudFront-Viewer-Address": `${ip}:443`, ...extra });
    const a = from("203.0.113.10");
    assert.equal((await view(app.baseUrl, world.open.item.id, a)).status, 200);
    // A refused lookup spends the budget too: the limit is ahead of the lookup.
    assert.equal((await view(app.baseUrl, `pt_${randomUUID()}`, a)).status, 404);
    const limited = await view(app.baseUrl, world.open.item.id, a);
    assert.deepEqual([limited.status, limited.body.code], [429, "RATE_LIMITED"]);
    assertPrivateAnswer(limited, "429");
    // Signing in buys no other bucket.
    const withToken = await view(app.baseUrl, world.open.item.id, from("203.0.113.10", { Authorization: `Bearer ${await accessTokenForTest(world.owner.id)}` }));
    assert.equal(withToken.status, 429, "a credential shares the address's bucket");
    // Another address is not limited by the first's requests.
    assert.equal((await view(app.baseUrl, world.open.item.id, from("198.51.100.20"))).status, 200);
    // The frame has its own budget: the view's spent one doesn't touch it.
    assert.equal((await frame(app.baseUrl, world.open.item.id, a)).status, 200);
    assert.equal((await frame(app.baseUrl, world.open.item.id, a)).status, 429);
    assert.equal((await frame(app.baseUrl, world.open.item.id, from("198.51.100.20"))).status, 200);
    assert.equal(worker.calls.length, 0, "the Worker is never called");
  } finally {
    await worker.close();
  }
});

// ---- the Worker's anonymous authorize ---------------------------------------------

test("authorize allows an anonymous subject only for its own Artifact's current version while public and Artifacts are on; unpublishing or deleting ends it", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const decide = async (artifact: string, version: string, subject = anonymousSubject(artifact, version)) =>
    (await authorize(app.baseUrl, { artifact, version, subject })).body;
  const { item: open, v1, v2 } = world.open;

  assert.deepEqual(await decide(open.id, v2.id), { allow: true }, "the current version, public");
  // The subject is bound to one Artifact and one version.
  assert.deepEqual(await decide(world.sheet.item.id, world.sheet.version.id, anonymousSubject(open.id, v2.id)), { allow: false, code: "bad-subject" }, "another Artifact's subject");
  assert.deepEqual(await decide(open.id, v1.id, anonymousSubject(open.id, v2.id)), { allow: false, code: "bad-subject" }, "another version's subject");
  for (const subject of [`v1:anon:${open.id}`, `v1:anon:${open.id}:${v2.id}:x`, `v1:anon:${open.id.toUpperCase()}:${v2.id}`, `v1:anonymous:${open.id}:${v2.id}`]) {
    assert.deepEqual(await decide(open.id, v2.id, subject), { allow: false, code: "bad-subject" }, subject);
  }
  assert.deepEqual(await decide(open.id, v1.id), { allow: false, code: "not-current" }, "an older version");
  assert.deepEqual(await decide(world.whole.item.id, world.whole.version.id), { allow: false, code: "not-public" }, "a server home");
  assert.deepEqual(await decide(world.inRoom.item.id, world.inRoom.version.id), { allow: false, code: "not-public" }, "a conversation home");
  assert.deepEqual(await decide(world.deleted.item.id, world.deleted.version.id), { allow: false, code: "deleted" }, "deleted");
  assert.deepEqual(await decide(world.revoked.item.id, world.revoked.version.id), { allow: false, code: "deleted" }, "revoked");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual(await decide(open.id, v2.id), { allow: false, code: "not-visible" }, "Artifacts off");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);

  // The owner makes it private again: the next authorize and the view refuse it.
  const owner = { Authorization: `Bearer ${await accessTokenForTest(world.owner.id)}`, "X-Server-Id": world.server.id };
  const unpublished = await fetch(`${app.baseUrl}${artifactWebPaths.unpublish(asArtifactId(open.id))}`, { method: "POST", headers: owner });
  assert.equal(unpublished.status, 200);
  assert.deepEqual(await decide(open.id, v2.id), { allow: false, code: "not-public" }, "after unpublish");
  assert.deepEqual([(await view(app.baseUrl, open.id)).status, (await frame(app.baseUrl, open.id)).status], [404, 404], "after unpublish");

  // Deleting a public one does the same.
  assert.deepEqual(await decide(world.sheet.item.id, world.sheet.version.id), { allow: true }, "witness: public sheet");
  const deleted = await fetch(`${app.baseUrl}${artifactWebPaths.artifact(asArtifactId(world.sheet.item.id))}`, { method: "DELETE", headers: owner });
  assert.equal(deleted.status, 204);
  assert.deepEqual(await decide(world.sheet.item.id, world.sheet.version.id), { allow: false, code: "deleted" }, "after delete");
  assert.equal((await view(app.baseUrl, world.sheet.item.id)).status, 404, "after delete");
});

test("a public Artifact of a deleted server opens for no one: not signed out, not from another server", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const { item: open, v2 } = world.open;
    const peerReader = { Authorization: `Bearer ${await accessTokenForTest(world.peerUser.id)}`, "X-Server-Id": world.peer.id, "Content-Type": "application/json" };
    const signedIn = async () => {
      const viewer = await fetch(`${app.baseUrl}${artifactWebPaths.viewer(asArtifactId(open.id))}`, { headers: peerReader });
      const framed = await fetch(`${app.baseUrl}${artifactWebPaths.frame(asArtifactId(open.id))}`, { method: "POST", headers: peerReader, body: "{}" });
      const located = await fetch(`${app.baseUrl}${artifactWebPaths.locate(asArtifactId(open.id))}`, { headers: peerReader });
      const summaries = await fetch(`${app.baseUrl}${objectWebPaths.summaries()}`, { method: "POST", headers: peerReader, body: JSON.stringify({ kind: "artifact", refs: [{ id: open.id }] }) });
      return {
        viewer: viewer.status,
        frame: framed.status,
        locate: located.status,
        summary: ((await summaries.json()) as { summaries: Array<{ ok: boolean }> }).summaries[0]!.ok,
        authorize: (await authorize(app.baseUrl, { artifact: open.id, version: v2.id, subject: `v1:${world.peer.id}:${world.peerUser.id}:-` })).body,
      };
    };
    const anonymous = async () => ({
      view: (await view(app.baseUrl, open.id)).status,
      frame: (await frame(app.baseUrl, open.id)).status,
      authorize: (await authorize(app.baseUrl, { artifact: open.id, version: v2.id, subject: anonymousSubject(open.id, v2.id) })).body,
    });
    // Witness: before, it opens signed out and from the peer server.
    assert.deepEqual(await anonymous(), { view: 200, frame: 200, authorize: { allow: true } });
    assert.deepEqual(await signedIn(), { viewer: 200, frame: 200, locate: 200, summary: true, authorize: { allow: true } });

    // Its server is soft-deleted: the item rows stay.
    await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, world.server.id));
    assert.deepEqual(await anonymous(), { view: 404, frame: 404, authorize: { allow: false, code: "not-visible" } });
    const after = await view(app.baseUrl, open.id);
    assert.deepEqual(after.body, NOT_VISIBLE, "the one 404");
    assert.deepEqual(await signedIn(), { viewer: 404, frame: 404, locate: 404, summary: false, authorize: { allow: false, code: "not-visible" } });
  } finally {
    await worker.close();
  }
});

// ---- embeds (#proj-workspace:#260, Porthole P143) ----------------------------------

async function embeddable(baseUrl: string, artifact: string, token: string | null = RAFT_TOKEN) {
  const res = await fetch(`${baseUrl}/internal/artifacts-content/embeds/${encodeURIComponent(artifact)}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() as any };
}
const embedSubject = (artifact: string, version: string) => `v1:embed:${artifact}:${version}`;

test("embeds: a public, current Artifact of a framed kind answers its version, kind and title; every other case is the one 404, the same body", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  vi.stubEnv("ARTIFACTS_EMBED_ORIGIN", "https://embed.example.test");
  const world = await seedWorld(seed);
  const { item: open, v2 } = world.open;
  const counted = async (outcome: string) => ((await appOperationsTotal.get()).values.find((value) => value.labels.operation === "content_embed" && value.labels.outcome === outcome)?.value ?? 0);
  const [embedsBefore, missesBefore] = [await counted("embeds"), await counted("not_embeddable")];
  const answer = await embeddable(app.baseUrl, open.id);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { artifact: open.id, version: v2.id, kind: "html", title: open.title });

  // A takedown, the same as every other case below.
  const takenDown = await insertItem({ serverId: asServerId(world.server.id), author: { type: "user", id: world.owner.id }, home: "public" });
  await publish(asServerId(world.server.id), { type: "user", id: world.owner.id }, { itemId: takenDown.id, number: 1 });
  assert.equal((await embeddable(app.baseUrl, takenDown.id)).status, 200, "witness: before its takedown");
  assert.equal((await takedownArtifact({ kind: "ops", operator: "test" }, takenDown.id, "report")).kind, "done");

  const cases: Array<[string, string]> = [
    ["a kind the shell draws (csv)", world.sheet.item.id],
    ["a server home", world.whole.item.id],
    ["a conversation home", world.inRoom.item.id],
    ["deleted", world.deleted.item.id],
    ["revoked", world.revoked.item.id],
    ["taken down", takenDown.id],
    ["never published", world.draft.id],
    ["no such id", `pt_${randomUUID()}`],
    ["a malformed id", "not-an-id"],
    ["an id in capitals", open.id.toUpperCase()],
  ];
  const first = await embeddable(app.baseUrl, cases[0]![1]);
  assert.equal(first.status, 404);
  for (const [why, id] of cases) assert.deepEqual(await embeddable(app.baseUrl, id), first, why);
  assert.equal(await counted("embeds"), embedsBefore + 2);
  assert.equal(await counted("not_embeddable"), missesBefore + cases.length + 1);

  // Embeds off on the server (no ARTIFACTS_EMBED_ORIGIN, the switch that hides the web's item): nothing embeds.
  vi.stubEnv("ARTIFACTS_EMBED_ORIGIN", "");
  assert.deepEqual(await embeddable(app.baseUrl, open.id), first, "embeds off on the server");
  vi.stubEnv("ARTIFACTS_EMBED_ORIGIN", "https://embed.example.test");
  assert.equal((await embeddable(app.baseUrl, open.id)).status, 200, "on again");

  // Artifacts off: nothing embeds.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual(await embeddable(app.baseUrl, open.id), first, "Artifacts off");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  assert.equal((await embeddable(app.baseUrl, open.id)).status, 200, "Artifacts on again");

  // Unpublished: the next question is the one 404.
  const owner = { Authorization: `Bearer ${await accessTokenForTest(world.owner.id)}`, "X-Server-Id": world.server.id };
  assert.equal((await fetch(`${app.baseUrl}${artifactWebPaths.unpublish(asArtifactId(open.id))}`, { method: "POST", headers: owner })).status, 200);
  assert.deepEqual(await embeddable(app.baseUrl, open.id), first, "after unpublish");

  // The Worker's token only.
  for (const token of [null, "x".repeat(40), await accessTokenForTest(world.owner.id)]) assert.equal((await embeddable(app.baseUrl, world.sheet.item.id, token)).status, 401);
});

test("authorize decides an embed subject exactly as a signed-out visitor's: its own Artifact's current version while public and Artifacts are on", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const decide = async (artifact: string, version: string, subject = embedSubject(artifact, version)) =>
    (await authorize(app.baseUrl, { artifact, version, subject })).body;
  const { item: open, v1, v2 } = world.open;
  assert.deepEqual(await decide(open.id, v2.id), { allow: true });
  assert.deepEqual(await decide(open.id, v1.id, embedSubject(open.id, v2.id)), { allow: false, code: "bad-subject" }, "another version's subject");
  assert.deepEqual(await decide(world.sheet.item.id, world.sheet.version.id, embedSubject(open.id, v2.id)), { allow: false, code: "bad-subject" }, "another Artifact's subject");
  for (const subject of [`v1:embed:${open.id}`, `v1:embed:${open.id}:${v2.id}:x`, `v1:embed:${open.id.toUpperCase()}:${v2.id}`, `v1:embeds:${open.id}:${v2.id}`]) {
    assert.deepEqual(await decide(open.id, v2.id, subject), { allow: false, code: "bad-subject" }, subject);
  }
  assert.deepEqual(await decide(open.id, v1.id), { allow: false, code: "not-current" });
  assert.deepEqual(await decide(world.whole.item.id, world.whole.version.id), { allow: false, code: "not-public" });
  assert.deepEqual(await decide(world.inRoom.item.id, world.inRoom.version.id), { allow: false, code: "not-public" });
  assert.deepEqual(await decide(world.deleted.item.id, world.deleted.version.id), { allow: false, code: "deleted" });
  assert.deepEqual(await decide(world.revoked.item.id, world.revoked.version.id), { allow: false, code: "deleted" });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual(await decide(open.id, v2.id), { allow: false, code: "not-visible" }, "Artifacts off");
});

test("no frame route signs an embed subject: the server never mints an embed session", async () => {
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", WORKER_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", CONTENT_DOMAIN);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const artifact = `pt_${randomUUID()}`;
    const version = `v_${randomUUID()}`;
    for (const viewer of ["anonymous", "embed", `user:${randomUUID()}`]) {
      assert.equal(await signContentFrame({ artifact, version, viewer, subject: embedSubject(artifact, version) }, { kind: "html" }), null, viewer);
    }
    // Witness: the visitor's subject signs.
    assert.ok(await signContentFrame({ artifact, version, viewer: "anonymous", subject: anonymousSubject(artifact, version) }, { kind: "html" }));
  } finally {
    warn.mockRestore();
  }
});
