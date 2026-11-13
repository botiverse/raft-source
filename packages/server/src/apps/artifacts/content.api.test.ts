// The content origin (S2) over HTTP: the web frame route and the viewer's
// `frame` with real user tokens, their tickets signed by the server (checked
// here as the content Worker checks them, with a tripwire Worker that must
// never be called), and the Worker's internal routes (authorize, manifest)
// with its bearer tokens. Proves the frame route's checks in order (flag, one
// 404, version, kind, configuration) and exactly what a ticket says; that
// authorize follows sign-out, retirement, removal from the home, deletion and
// the version's Artifact; and that the manifest lists only bytes in R2. Both
// are spans of the request's trace (`server.artifacts.frame.issue`,
// `server.artifacts.content.authorize`).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { artifactWebPaths, asArtifactId, asServerId, BasicTracer, MemoryTraceSink, type ArtifactWebFrame, type CompletedTraceSpan, type ServerId } from "@botiverse/raft-shared";
import { ARTIFACT_CONTENT_TICKET_SECONDS, artifactContentTicketKey, verifyArtifactContentTicket, type ArtifactContentTicketClaims } from "@botiverse/raft-shared/src/artifactContentTicket";
import { getDb } from "../../db/index";
import { notificationOutbox, objectEvents, objectInboxStates, servers, users } from "../../db/schema";
import { addHuman, createChannel, removeHuman } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember, removeMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import { accessTokenForTest, signInForTest } from "../../test/integration/credentials";
import type { createSeed } from "../../test/integration/seed";
import { r2KeyOf } from "./blobStore";
import { artifactBlobs, artifactItems, artifactReadPositions, artifactVersionChecks, artifactVersionFiles, artifactVersions } from "./schema";
import { webNotVisible, webVersionNotFound } from "./webCommon";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.frame": 2 } });

const WORKER_TOKEN = "w".repeat(40);
/** The token WORKER_TOKEN is rotated to. */
const NEXT_WORKER_TOKEN = "x".repeat(40);
const RAFT_TOKEN = "r".repeat(40);
const NEXT_RAFT_TOKEN = "n".repeat(40);

afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);

/** Records the app's traces from here on. */
function traced(app: { app: { set(key: string, value: unknown): unknown } }): MemoryTraceSink {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  return sink;
}

/** The spans named `name`, each checked to be a child of its request's span and timed. */
function spansOf(sink: MemoryTraceSink, name: string): CompletedTraceSpan[] {
  const spans = sink.getAllSpans().filter((span) => span.name === name);
  for (const span of spans) {
    const parent = sink.getAllSpans().find((candidate) => candidate.context.spanId === span.context.parentSpanId);
    assert.equal(parent?.name, "server.http.request", `${name} is a child of its request's span`);
    assert.equal(typeof span.attrs?.duration_ms, "number");
  }
  return spans;
}

// ---- seeding -------------------------------------------------------------------

type Actor = { type: "user" | "agent"; id: string };

async function insertItem(input: { serverId: ServerId; homeChannelId?: string; author: Actor; deleted?: boolean; revoked?: boolean }) {
  const id = `pt_${randomUUID()}`;
  const [row] = await getDb().insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: `art-${label()}`,
    title: `Artifact ${id.slice(3, 11)}`,
    homeKind: input.homeChannelId ? "conversation" : "public",
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
  }).returning();
  return row!;
}

/** `pending`: a blob still uploading; `blobServer`: a blob of another server. */
type FileSpec = { path: string; bytes: Buffer; pending?: boolean; blobServer?: ServerId };

/** A published version (current unless `current: false`), each file a ready blob of the server unless the spec says otherwise. */
async function publish(serverId: ServerId, uploader: Actor, input: { itemId: string; number: number; files: FileSpec[]; title?: string; current?: boolean }) {
  const db = getDb();
  const versionId = `v_${randomUUID()}`;
  const [version] = await db.insert(artifactVersions).values({
    id: versionId,
    itemId: input.itemId,
    number: input.number,
    entry: input.files[0]!.path,
    title: input.title ?? null,
    fileCount: input.files.length,
    sizeBytes: input.files.reduce((sum, file) => sum + file.bytes.length, 0),
    publishDigest: "digest",
    status: "published",
    publisherType: uploader.type,
    publisherId: uploader.id,
    position: input.number,
  }).returning();
  for (const file of input.files) {
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const blobId = `b_${randomUUID()}`;
    const blobServer = file.blobServer ?? serverId;
    await db.insert(artifactBlobs).values({
      id: blobId, serverId: blobServer, sha256, sizeBytes: file.bytes.length, state: file.pending ? "pending" : "ready", r2Key: r2KeyOf(blobServer, sha256, blobId),
    });
    await db.insert(artifactVersionFiles).values({ versionId, path: file.path, sha256, sizeBytes: file.bytes.length, blobId });
  }
  if (input.current !== false) await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: input.number }).where(eq(artifactItems.id, input.itemId));
  return version!;
}

/**
 * A server (Artifacts on unless `enabled: false`) with #priv (owner and reader)
 * and #other (owner only), outsider a member of the server in neither; a peer
 * server whose only member is peerUser. Artifacts in #priv: page
 * (v1 with a pending blob and another server's blob; v2 current),
 * sheet (csv), deleted, revoked; secret in #other; memo, public (v1, v2
 * current).
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const serverId = asServerId(server.id);
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const priv = await createChannel(server.id, `art-priv-${label()}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  await addHuman(priv.id, reader.id);
  const other = await createChannel(server.id, `art-other-${label()}`, undefined, "private");
  await addHuman(other.id, owner.id);
  const author: Actor = { type: "user", id: owner.id };

  const page = await insertItem({ serverId, homeChannelId: priv.id, author });
  const v1 = await publish(serverId, author, { itemId: page.id, number: 1, title: "First title", files: [
    { path: "index.html", bytes: Buffer.from("<h1>v1</h1>") },
    { path: "assets/style.css", bytes: Buffer.from("h1{}") },
    { path: "assets/pending.js", bytes: Buffer.from("pending()"), pending: true },
    { path: "assets/foreign.js", bytes: Buffer.from("foreign()"), blobServer: asServerId(peer.id) },
  ] });
  const v2 = await publish(serverId, author, { itemId: page.id, number: 2, files: [{ path: "index.html", bytes: Buffer.from("<h1>v2</h1>") }] });
  const sheet = await insertItem({ serverId, homeChannelId: priv.id, author });
  const sheetV1 = await publish(serverId, author, { itemId: sheet.id, number: 1, files: [{ path: "data.csv", bytes: Buffer.from("a,b\n1,2\n") }] });
  const deleted = await insertItem({ serverId, homeChannelId: priv.id, author, deleted: true });
  const deletedV1 = await publish(serverId, author, { itemId: deleted.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("gone") }] });
  const revoked = await insertItem({ serverId, homeChannelId: priv.id, author, revoked: true });
  const revokedV1 = await publish(serverId, author, { itemId: revoked.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("revoked") }] });
  const secret = await insertItem({ serverId, homeChannelId: other.id, author });
  const secretV1 = await publish(serverId, author, { itemId: secret.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("secret") }] });
  const memo = await insertItem({ serverId, author });
  const memoV1 = await publish(serverId, author, { itemId: memo.id, number: 1, files: [{ path: "index.html", bytes: Buffer.from("memo v1") }] });
  const memoV2 = await publish(serverId, author, { itemId: memo.id, number: 2, files: [{ path: "index.html", bytes: Buffer.from("memo v2") }] });
  return {
    server, serverId, owner, reader, outsider, peer, peerUser, channels: { priv, other },
    items: { page, sheet, deleted, revoked, secret, memo },
    versions: { v1, v2, sheetV1, deletedV1, revokedV1, secretV1, memoV1, memoV2 },
  };
}

// ---- the content origin -----------------------------------------------------------

type WorkerCall = { authorization: string | undefined; path: string };

/**
 * The content origin configured through the environment (the token tickets are
 * signed with, the content domain), and a tripwire content Worker at
 * ARTIFACTS_CONTENT_WORKER_URL that records every call: the server never makes one.
 */
async function startWorker() {
  const calls: WorkerCall[] = [];
  const server = http.createServer((req, res) => {
    calls.push({ authorization: req.headers.authorization, path: req.url ?? "" });
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_URL", url);
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", WORKER_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", CONTENT_DOMAIN);
  return {
    calls,
    url,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const CONTENT_DOMAIN = "content.example.test";
/** An Artifact's own content origin (`w-<uuid>`) under `domain`. */
const originOf = (artifact: string, domain = CONTENT_DOMAIN, scheme = "https") => `${scheme}://w-${artifact.replace(/^pt_/, "")}.${domain}`;

/**
 * A frame's ticket, checked as the content Worker checks it (shared
 * artifactContentTicket.ts) with the keys of `secrets` (the Worker's
 * RAFT_TOKENS; default the configured token alone): its claims, after the
 * frame's shape (`<origin>/_raft/open?ticket=…`, reports, and its door,
 * `<origin>/__porthole/door/_raft?ticket=…`: the same claims, `door: true`,
 * a nonce of its own; and `instanceVersion`, the tickets' version).
 */
async function claimsOf(frame: ArtifactWebFrame, secrets: string[] = [WORKER_TOKEN]): Promise<ArtifactContentTicketClaims> {
  assert.deepEqual(Object.keys(frame).sort(), ["door", "instanceVersion", "origin", "reports", "url"]);
  assert.equal(frame.reports, true);
  const keys = await Promise.all(secrets.map(artifactContentTicketKey));
  const ticketAt = async (at: string, path: string) => {
    const url = new URL(at);
    assert.equal(url.origin, frame.origin);
    assert.equal(url.pathname, path);
    assert.deepEqual([...url.searchParams.keys()], ["ticket"]);
    const verified = await verifyArtifactContentTicket(url.searchParams.get("ticket")!, keys, { origin: frame.origin });
    assert.ok(verified.ok, `the ticket verifies: ${JSON.stringify(verified)}`);
    return verified.claims;
  };
  const claims = await ticketAt(frame.url, "/_raft/open");
  assert.equal(claims.door, undefined, "the content's ticket opens no door");
  assert.deepEqual(Object.keys(frame.door!), ["url"]);
  const { door, nonce, ...doorClaims } = await ticketAt(frame.door!.url, "/__porthole/door/_raft");
  assert.equal(door, true);
  assert.notEqual(nonce, claims.nonce, "the door's nonce is its own");
  assert.deepEqual(doorClaims, (({ nonce: _nonce, ...rest }) => rest)(claims), "the door's claims are the content's");
  // The web mounts the frame's Porthole instance with it (#proj-workspace:#251): the version the tickets name.
  assert.equal(frame.instanceVersion, claims.version, "the frame names the version its tickets were signed for");
  return claims;
}

// ---- HTTP ------------------------------------------------------------------------

async function frame(baseUrl: string, input: { token: string; serverId: string; artifact: string; body?: unknown }) {
  const res = await fetch(`${baseUrl}/api/artifacts/${encodeURIComponent(input.artifact)}/frame`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "X-Server-Id": input.serverId, "Content-Type": "application/json" },
    body: JSON.stringify(input.body ?? {}),
  });
  return { status: res.status, cacheControl: res.headers.get("cache-control"), body: await res.json() as any };
}

async function viewer(baseUrl: string, input: { token: string; serverId: string; artifact: string; version?: number }) {
  const res = await fetch(`${baseUrl}${artifactWebPaths.viewer(asArtifactId(input.artifact), input.version)}`, {
    headers: { Authorization: `Bearer ${input.token}`, "X-Server-Id": input.serverId },
  });
  return { status: res.status, cacheControl: res.headers.get("cache-control"), body: await res.json() as any };
}

async function authorize(baseUrl: string, body: unknown, token: string | null = RAFT_TOKEN) {
  const res = await fetch(`${baseUrl}/internal/artifacts-content/authorize`, {
    method: "POST",
    headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function manifest(baseUrl: string, version: string, artifact: string | null, token: string | null = RAFT_TOKEN) {
  const query = artifact === null ? "" : `?artifact=${encodeURIComponent(artifact)}`;
  const res = await fetch(`${baseUrl}/internal/artifacts-content/versions/${encodeURIComponent(version)}${query}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() as any };
}

const subjectOf = (serverId: string, userId: string, familyId: string | null) => `v1:${serverId}:${userId}:${familyId ?? "-"}`;

// ---- the frame route -----------------------------------------------------------

test("frame: Artifacts off answers 403 ARTIFACTS_NOT_ENABLED and never asks the Worker", async ({ app, seed }) => {
  const world = await seedWorld(seed, { enabled: false });
  const worker = await startWorker();
  try {
    const res = await frame(app.baseUrl, { token: await accessTokenForTest(world.reader.id), serverId: world.server.id, artifact: world.items.page.id });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "ARTIFACTS_NOT_ENABLED");
    assert.equal(worker.calls.length, 0);
  } finally {
    await worker.close();
  }
});

test("frame: what the reader can't see is one 404 NOT_VISIBLE, whatever the reason", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const outsider = await accessTokenForTest(world.outsider.id);
    const reader = await accessTokenForTest(world.reader.id);
    const cases = [
      { token: outsider, artifact: world.items.page.id },
      { token: reader, artifact: world.items.secret.id },
      { token: reader, artifact: world.items.deleted.id },
      { token: reader, artifact: world.items.revoked.id },
      { token: reader, artifact: `pt_${randomUUID()}` },
      { token: reader, artifact: "not-an-id" },
    ];
    for (const entry of cases) {
      const res = await frame(app.baseUrl, { ...entry, serverId: world.server.id });
      assert.equal(res.status, 404, entry.artifact);
      assert.deepEqual(res.body, webNotVisible().body, entry.artifact);
    }
    assert.equal(worker.calls.length, 0);
    // Witness: the same reader sees the page.
    assert.equal((await frame(app.baseUrl, { token: reader, serverId: world.server.id, artifact: world.items.page.id })).status, 200);
  } finally {
    await worker.close();
  }
});

test("frame: an unknown version is 404 VERSION_NOT_FOUND, a malformed body 400, a csv 409 NOT_FRAMED", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const token = await accessTokenForTest(world.reader.id);
    const ask = (artifact: string, body: unknown) => frame(app.baseUrl, { token, serverId: world.server.id, artifact, body });
    const unknown = await ask(world.items.page.id, { version: 9 });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, webVersionNotFound(9, 2).body);
    for (const body of [{ version: "1" }, { version: 0 }, { version: 1.5 }, { version: 1, extra: true }, [1]]) {
      const res = await ask(world.items.page.id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, "INVALID_REQUEST");
    }
    const sheet = await ask(world.items.sheet.id, {});
    assert.equal(sheet.status, 409);
    assert.equal(sheet.body.code, "NOT_FRAMED");
    assert.equal(worker.calls.length, 0);
  } finally {
    await worker.close();
  }
});

test("frame: `path` opens the version at another of its pages (an HTML page, or the page made for a Markdown file or a PDF), both tickets naming it; the entry's path is the entry; no file path, a missing file and a file no frame shows are refused", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const author: Actor = { type: "user", id: world.owner.id };
    const site = await insertItem({ serverId: world.serverId, homeChannelId: world.channels.priv.id, author });
    // Each file its own bytes: a server's blobs are one per content (idx_blobs_server_sha256).
    const siteV1 = await publish(world.serverId, author, { itemId: site.id, number: 1, files: [
      { path: "index.html", bytes: Buffer.from("<h1>home, first</h1>") },
      { path: "old.html", bytes: Buffer.from("<h1>old</h1>") },
    ] });
    const siteV2 = await publish(world.serverId, author, { itemId: site.id, number: 2, files: [
      { path: "index.html", bytes: Buffer.from("<h1>home, second</h1>") },
      { path: "docs/about us.html", bytes: Buffer.from("<h1>about</h1>") },
      { path: "notes.md", bytes: Buffer.from("# notes") },
      { path: "report.pdf", bytes: Buffer.from("%PDF-") },
      { path: "data.csv", bytes: Buffer.from("a,b\n") },
      { path: "assets/app.js", bytes: Buffer.from("app()") },
    ] });
    const signIn = await signInForTest(world.reader.id);
    const sink = traced(app);
    const ask = (artifact: string, body: unknown) => frame(app.baseUrl, { token: signIn.token, serverId: world.server.id, artifact, body });

    const about = await ask(site.id, { path: "docs/about us.html" });
    assert.equal(about.status, 200, JSON.stringify(about.body));
    // claimsOf holds the door's claims to the content's: the door answers for the same page.
    const { expires: _expires, nonce: _nonce, ...signed } = await claimsOf(about.body);
    assert.deepEqual(signed, {
      artifact: site.id,
      version: siteV2.id,
      viewer: `user:${world.reader.id}`,
      subject: subjectOf(world.server.id, world.reader.id, signIn.familyId),
      origin: originOf(site.id),
      page: "docs/about%20us.html",
    });
    const [issued] = spansOf(sink, "server.artifacts.frame.issue");
    assert.deepEqual({ kind: issued?.attrs?.kind, outcome: issued?.attrs?.outcome }, { kind: "html", outcome: "issued" });
    assert.ok(!JSON.stringify(issued?.attrs).includes("about"), "never the page in the span");

    // A page of an older version, by that version.
    const old = await ask(site.id, { version: 1, path: "old.html" });
    assert.equal(old.status, 200, JSON.stringify(old.body));
    const oldClaims = await claimsOf(old.body);
    assert.deepEqual([oldClaims.version, oldClaims.page], [siteV1.id, "old.html"]);

    // The entry's own path is the entry: a ticket with no page, as without `path`.
    const entry = await ask(site.id, { path: "index.html" });
    assert.equal(entry.status, 200);
    assert.equal(Object.hasOwn(await claimsOf(entry.body), "page"), false);

    for (const body of [{ path: 1 }, { path: null }, { path: ["old.html"] }, { path: "old.html", extra: true }]) {
      const res = await ask(site.id, body);
      assert.deepEqual([res.status, res.body.code], [400, "INVALID_REQUEST"], JSON.stringify(body));
    }
    // The page's escaped address is no file path (a path has no `%`): the route takes the file's own path.
    for (const path of ["", "/index.html", "docs/../index.html", "docs//about us.html", "./old.html", "docs/about%20us.html"]) {
      const res = await ask(site.id, { path });
      assert.deepEqual([res.status, res.body.code], [400, "INVALID_PATH"], JSON.stringify(path));
    }
    // A file of another version, or of none: not this version's.
    for (const path of ["old.html", "missing.html", "docs/about us.htm"]) {
      const res = await ask(site.id, { path });
      assert.deepEqual([res.status, res.body.code, res.body.details], [404, "FILE_NOT_FOUND", { path, version: 2 }], path);
    }
    // A Markdown file or a PDF opens at the page the content Worker makes beside it (shared artifactFramedPagePath), the span saying its kind.
    for (const [path, page, kind] of [["notes.md", "notes.md.html", "markdown"], ["report.pdf", "report.pdf.html", "pdf"]] as const) {
      const res = await ask(site.id, { path });
      assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
      assert.equal((await claimsOf(res.body)).page, page, path);
      assert.equal(spansOf(sink, "server.artifacts.frame.issue").at(-1)?.attrs?.kind, kind, path);
    }
    // Any other kind opens in no frame.
    for (const path of ["data.csv", "assets/app.js"]) {
      const res = await ask(site.id, { path });
      assert.deepEqual([res.status, res.body.code, res.body.details], [409, "NOT_FRAMED", { path }], path);
    }
    // A version whose entry Raft draws itself frames nothing, whatever the path: checked before the path.
    const sheet = await ask(world.items.sheet.id, { path: "data.csv" });
    assert.deepEqual([sheet.status, sheet.body.code, sheet.body.details], [409, "NOT_FRAMED", undefined]);
    // What the reader can't see answers the one 404 before anything of its files.
    const hidden = await ask(world.items.secret.id, { path: "index.html" });
    assert.deepEqual(hidden.body, webNotVisible().body);
    assert.equal(worker.calls.length, 0, "no call to the Worker");
  } finally {
    await worker.close();
  }
});

test("frame: the content origin unconfigured or misconfigured is 503 CONTENT_UNAVAILABLE; a loopback content domain frames over http", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const token = await accessTokenForTest(world.reader.id);
  const ask = () => frame(app.baseUrl, { token, serverId: world.server.id, artifact: world.items.page.id });
  const unavailable = (res: Awaited<ReturnType<typeof ask>>, why: string) => {
    assert.equal(res.status, 503, why);
    assert.equal(res.body.code, "CONTENT_UNAVAILABLE", why);
  };

  // Not configured is an error span in a deployment (a misconfiguration), not in local development.
  vi.stubEnv("DEPLOYMENT_ENV", "staging");
  const deployedSink = traced(app);
  unavailable(await ask(), "not configured, deployed");
  const [deployed] = spansOf(deployedSink, "server.artifacts.frame.issue");
  assert.equal(deployed?.status, "error", "a deployment without a content origin is misconfigured");
  assert.equal(deployed?.attrs?.outcome, "not_configured");
  vi.stubEnv("DEPLOYMENT_ENV", "slockdev");

  const sink = traced(app);
  unavailable(await ask(), "not configured");
  const [notConfigured] = spansOf(sink, "server.artifacts.frame.issue");
  assert.equal(notConfigured?.status, "ok", "no content origin in local development is not an error");
  assert.equal(notConfigured?.attrs?.outcome, "not_configured");
  const worker = await startWorker();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", "too-short");
    unavailable(await ask(), "token shorter than 32 bytes");
    vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", "");
    unavailable(await ask(), "no token");
    // The content domain: missing or not a host[:port].
    vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", WORKER_TOKEN);
    vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", "");
    unavailable(await ask(), "no content domain");
    vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", "https://content.example.test/");
    unavailable(await ask(), "a content domain with a scheme");
    const problems = warn.mock.calls.filter(([message]) => String(message).includes("configuration is unusable")).map(([, fields]) => (fields as { problem: string }).problem);
    assert.deepEqual(problems, [
      "ARTIFACTS_CONTENT_WORKER_TOKEN is shorter than 32 bytes",
      "ARTIFACTS_CONTENT_WORKER_TOKEN is missing",
      "ARTIFACTS_CONTENT_DOMAIN is missing or not a host[:port]",
      "ARTIFACTS_CONTENT_DOMAIN is missing or not a host[:port]",
    ]);
    for (const [, fields] of warn.mock.calls) assert.ok(!JSON.stringify(fields ?? null).includes(WORKER_TOKEN), "never the token");

    // A loopback content domain (local development): http, on the Artifact's own label.
    vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", "content.localhost:8787");
    const loopback = await ask();
    assert.equal(loopback.status, 200);
    assert.equal(loopback.body.origin, originOf(world.items.page.id, "content.localhost:8787", "http"));
    assert.equal((await claimsOf(loopback.body)).origin, loopback.body.origin);
    // No URL for the Worker at all: frames are signed all the same.
    vi.stubEnv("ARTIFACTS_CONTENT_WORKER_URL", "");
    vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", CONTENT_DOMAIN);
    assert.equal((await ask()).status, 200, "the Worker's URL is not needed");
    assert.equal(worker.calls.length, 0, "the Worker is never called");
  } finally {
    warn.mockRestore();
    await worker.close();
  }

  // Each request's span: ok for a frame signed (and for none configured locally), an error for a bad configuration.
  const outcomes = spansOf(sink, "server.artifacts.frame.issue").map((span) => [span.attrs?.outcome, span.status]);
  assert.deepEqual(outcomes, [
    ...Array.from({ length: 5 }, () => ["not_configured", "ok"]),
    ["issued", "ok"],
    ["issued", "ok"],
  ]);
});

test("frame: signs a ticket for the version, the reader's viewer and subject and the Artifact's own origin, never calling the Worker", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const signIn = await signInForTest(world.reader.id);
    const token = signIn.token;
    const sink = traced(app);
    const before = Math.floor(Date.now() / 1000);
    const current = await frame(app.baseUrl, { token, serverId: world.server.id, artifact: world.items.page.id });
    assert.equal(current.status, 200);
    assert.match(current.cacheControl ?? "", /no-store/);
    const origin = originOf(world.items.page.id);
    assert.equal(current.body.origin, origin);
    const claims = await claimsOf(current.body);
    const { expires, nonce, ...signed } = claims;
    assert.deepEqual(signed, {
      artifact: world.items.page.id,
      version: world.versions.v2.id,
      viewer: `user:${world.reader.id}`,
      subject: subjectOf(world.server.id, world.reader.id, signIn.familyId),
      origin,
    });
    assert.ok(expires >= before + ARTIFACT_CONTENT_TICKET_SECONDS && expires <= Math.floor(Date.now() / 1000) + ARTIFACT_CONTENT_TICKET_SECONDS, "good for 60 seconds");
    assert.match(nonce, /^[A-Za-z0-9_-]{22}$/);
    const [issued, ...more] = spansOf(sink, "server.artifacts.frame.issue");
    assert.equal(more.length, 0);
    assert.equal(issued?.status, "ok");
    assert.deepEqual({ kind: issued?.attrs?.kind, outcome: issued?.attrs?.outcome }, { kind: "html", outcome: "issued" });
    const said = JSON.stringify(issued?.attrs);
    for (const secret of [world.items.page.id, world.versions.v2.id, current.body.url, nonce]) assert.ok(!said.includes(secret), "never the Artifact, its version or the ticket");

    // An older version. Every frame is a new ticket.
    const older = await frame(app.baseUrl, { token, serverId: world.server.id, artifact: world.items.page.id, body: { version: 1 } });
    assert.equal(older.status, 200);
    const olderClaims = await claimsOf(older.body);
    assert.deepEqual([olderClaims.version, olderClaims.subject], [world.versions.v1.id, subjectOf(world.server.id, world.reader.id, signIn.familyId)]);
    // A legacy token without a session family is refused before any ticket.
    const familyless = jwt.sign({ sub: world.reader.id, type: "access" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
    assert.equal((await frame(app.baseUrl, { token: familyless, serverId: world.server.id, artifact: world.items.page.id, body: { version: 1 } })).status, 401);
    assert.notEqual(olderClaims.nonce, nonce);
    assert.equal(worker.calls.length, 0, "no call to the Worker");
  } finally {
    await worker.close();
  }
});

test("frame: tickets signed before a rotation verify with the previous token's kid, after it with the current one's", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const reader = { token: await accessTokenForTest(world.reader.id), serverId: world.server.id, artifact: world.items.page.id };
    const before = await frame(app.baseUrl, reader);
    assert.equal(before.status, 200);
    // The Worker lists both tokens (RAFT_TOKENS: previous, current); then the server switches to the new one.
    vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", NEXT_WORKER_TOKEN);
    const after = await frame(app.baseUrl, reader);
    assert.equal(after.status, 200);
    const both = [WORKER_TOKEN, NEXT_WORKER_TOKEN];
    await claimsOf(before.body, both);
    await claimsOf(after.body, both);
    const [previousKey, currentKey] = await Promise.all(both.map(artifactContentTicketKey));
    const kidOf = (frame: ArtifactWebFrame) => new URL(frame.url).searchParams.get("ticket")!.split(".")[1];
    assert.equal(kidOf(before.body), previousKey!.kid);
    assert.equal(kidOf(after.body), currentKey!.kid, "the server signs with the current token's kid");
    // Once the previous token is gone from the Worker, its tickets are an unknown kid; the new ones still open.
    const ticketOf = (frame: ArtifactWebFrame) => new URL(frame.url).searchParams.get("ticket")!;
    assert.deepEqual(await verifyArtifactContentTicket(ticketOf(before.body), [currentKey!], { origin: before.body.origin }), { ok: false, reason: "unknown-kid" });
    assert.equal((await verifyArtifactContentTicket(ticketOf(after.body), [currentKey!], { origin: after.body.origin })).ok, true);
    assert.equal(worker.calls.length, 0);
  } finally {
    await worker.close();
  }
});

test("viewer: a framed version's answer carries the frame route's frame for the shown version; a kind the shell draws, none", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const readerSignIn = await signInForTest(world.reader.id);
  const reader = { token: readerSignIn.token, serverId: world.server.id };
  // Not configured: no frame, and the rest of the answer as ever.
  const plain = await viewer(app.baseUrl, { ...reader, artifact: world.items.page.id });
  assert.equal(plain.status, 200);
  assert.equal("frame" in plain.body, false, "no content origin: no frame");
  const worker = await startWorker();
  try {
    const current = await viewer(app.baseUrl, { ...reader, artifact: world.items.page.id });
    assert.equal(current.status, 200);
    assert.match(current.cacheControl ?? "", /no-store/);
    assert.deepEqual(Object.keys(current.body).filter((key) => !(key in plain.body)), ["frame"], "only `frame` is added");
    const claims = await claimsOf(current.body.frame);
    assert.deepEqual([claims.artifact, claims.version, claims.viewer, claims.subject, claims.origin], [
      world.items.page.id, world.versions.v2.id, `user:${world.reader.id}`, subjectOf(world.server.id, world.reader.id, readerSignIn.familyId), originOf(world.items.page.id),
    ]);
    // `?version=`: the frame is that version's.
    const older = await viewer(app.baseUrl, { ...reader, artifact: world.items.page.id, version: 1 });
    assert.equal(older.status, 200);
    assert.equal((await claimsOf(older.body.frame)).version, world.versions.v1.id);
    // A csv is drawn by the shell: no frame.
    const sheet = await viewer(app.baseUrl, { ...reader, artifact: world.items.sheet.id });
    assert.equal(sheet.status, 200);
    assert.equal("frame" in sheet.body, false);
    // A public Artifact's outsider: the current version's frame, for their own server's subject.
    const outsiderSignIn = await signInForTest(world.peerUser.id);
    const outsider = await viewer(app.baseUrl, { token: outsiderSignIn.token, serverId: world.peer.id, artifact: world.items.memo.id });
    assert.equal(outsider.status, 200);
    const outsiderClaims = await claimsOf(outsider.body.frame);
    assert.deepEqual([outsiderClaims.version, outsiderClaims.subject], [world.versions.memoV2.id, subjectOf(world.peer.id, world.peerUser.id, outsiderSignIn.familyId)]);
    assert.equal(worker.calls.length, 0, "no call to the Worker");
    // `details`: the same answer, never a frame.
    const details = await fetch(`${app.baseUrl}${artifactWebPaths.details(asArtifactId(world.items.page.id))}`, {
      headers: { Authorization: `Bearer ${reader.token}`, "X-Server-Id": reader.serverId },
    });
    assert.equal(details.status, 200);
    assert.equal("frame" in (await details.json() as any), false, "details signs no ticket");
  } finally {
    await worker.close();
  }
});

test("viewer: a reader who can't see the Artifact or the version gets no frame, only the one refusal", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const reader = await accessTokenForTest(world.reader.id);
    const cases = [
      { token: await accessTokenForTest(world.outsider.id), artifact: world.items.page.id },
      { token: reader, artifact: world.items.secret.id },
      { token: reader, artifact: world.items.deleted.id },
      { token: reader, artifact: world.items.revoked.id },
      { token: reader, artifact: `pt_${randomUUID()}` },
    ];
    for (const entry of cases) {
      const res = await viewer(app.baseUrl, { ...entry, serverId: world.server.id });
      assert.equal(res.status, 404, entry.artifact);
      assert.deepEqual(res.body, webNotVisible().body, entry.artifact);
    }
    // An outsider of a public Artifact asking for an older version: refused, no frame.
    const older = await viewer(app.baseUrl, { token: await accessTokenForTest(world.peerUser.id), serverId: world.peer.id, artifact: world.items.memo.id, version: 1 });
    assert.equal(older.status, 404);
    assert.equal(older.body.code, "VERSION_NOT_FOUND");
    assert.equal(older.body.frame, undefined);
    // Artifacts off: 403, no frame.
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
    const off = await viewer(app.baseUrl, { token: reader, serverId: world.server.id, artifact: world.items.page.id });
    assert.deepEqual([off.status, off.body.code, off.body.frame], [403, "ARTIFACTS_NOT_ENABLED", undefined]);
    assert.equal(worker.calls.length, 0);
  } finally {
    await worker.close();
  }
});

// ---- the Worker's routes: tokens ---------------------------------------------------

test("content routes: 404 without configured tokens, 401 for a missing or wrong token, every listed token accepted", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const body = { artifact: world.items.page.id, version: world.versions.v2.id, subject: subjectOf(world.server.id, world.reader.id, null) };

  assert.equal((await authorize(app.baseUrl, body)).status, 404, "no tokens: not there");
  assert.equal((await manifest(app.baseUrl, world.versions.v2.id, world.items.page.id)).status, 404);
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", "short-token");
  assert.equal((await authorize(app.baseUrl, body, "short-token")).status, 404, "a token under 32 bytes is ignored");

  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", ` ${RAFT_TOKEN} , ${NEXT_RAFT_TOKEN} ,short-token`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const token of [null, "", "x".repeat(40), `${RAFT_TOKEN}x`, "short-token", WORKER_TOKEN]) {
      assert.equal((await authorize(app.baseUrl, body, token)).status, 401, `authorize with ${token}`);
      assert.equal((await manifest(app.baseUrl, world.versions.v2.id, world.items.page.id, token)).status, 401, `manifest with ${token}`);
    }
    // A user's access token is not a Worker token either.
    assert.equal((await authorize(app.baseUrl, body, await accessTokenForTest(world.reader.id))).status, 401);
    const logged = warn.mock.calls.filter(([message]) => message === "[artifacts-content] refused token");
    assert.ok(logged.length > 0);
    for (const [, fields] of logged) {
      assert.deepEqual(Object.keys(fields as object).sort(), ["route", "source"]);
      assert.ok(!JSON.stringify(fields).includes("x".repeat(40)), "the token is never logged");
    }
  } finally {
    warn.mockRestore();
  }
  assert.deepEqual((await authorize(app.baseUrl, body, RAFT_TOKEN)).body, { allow: true });
  assert.deepEqual((await authorize(app.baseUrl, body, NEXT_RAFT_TOKEN)).body, { allow: true }, "the next token while rotating");
});

test("one token for both directions: both configurations are unusable (frame 503, content routes 404), with a warning", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const token = await accessTokenForTest(world.reader.id);
  const body = { artifact: world.items.page.id, version: world.versions.v2.id, subject: subjectOf(world.server.id, world.reader.id, null) };
  const worker = await startWorker();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", `${RAFT_TOKEN},${WORKER_TOKEN}`);
    const res = await frame(app.baseUrl, { token, serverId: world.server.id, artifact: world.items.page.id });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "CONTENT_UNAVAILABLE");
    assert.equal(worker.calls.length, 0, "the Worker is never asked with a shared token");
    assert.equal((await authorize(app.baseUrl, body, RAFT_TOKEN)).status, 404, "not even the other, unshared token is accepted");
    const problems = warn.mock.calls.map(([, fields]) => (fields as { problem?: string } | undefined)?.problem).filter(Boolean);
    assert.ok(problems.length >= 2 && problems.every((problem) => problem!.includes("each direction needs its own token")), JSON.stringify(problems));
    // Separate tokens again: both sides work.
    vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
    assert.equal((await frame(app.baseUrl, { token, serverId: world.server.id, artifact: world.items.page.id })).status, 200);
    assert.deepEqual((await authorize(app.baseUrl, body, RAFT_TOKEN)).body, { allow: true });
  } finally {
    warn.mockRestore();
    await worker.close();
  }
});

// ---- authorize ---------------------------------------------------------------------

test("authorize: allows a signed-in reader who can see a published version, and denies each reason with its code", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const signIn = await signInForTest(world.reader.id);
  const subject = subjectOf(world.server.id, world.reader.id, signIn.familyId);
  const page = { artifact: world.items.page.id, version: world.versions.v2.id };
  const decide = async (body: unknown) => (await authorize(app.baseUrl, body)).body;
  const sink = traced(app);

  assert.deepEqual(await decide({ ...page, subject }), { allow: true });
  assert.deepEqual(await decide({ ...page, subject: "" }), { allow: false, code: "bad-subject" });
  assert.equal((await authorize(app.baseUrl, { ...page })).status, 400);
  assert.deepEqual(spansOf(sink, "server.artifacts.content.authorize").map((span) => [span.status, span.attrs?.outcome]), [["ok", "allow"], ["ok", "bad-subject"], ["ok", "invalid_body"]]);
  assert.deepEqual(await decide({ artifact: world.items.page.id, version: world.versions.v1.id, subject }), { allow: true }, "an older published version");

  // Malformed subjects.
  for (const bad of [
    "",
    `v2:${world.server.id}:${world.reader.id}:-`,
    `v1:${world.server.id}:${world.reader.id}`,
    `v1:${world.server.id}:${world.reader.id}:-:extra`,
    `v1:${world.server.id.toUpperCase()}:${world.reader.id}:-`,
    `v1:not-a-server:${world.reader.id}:-`,
    `v1:${world.server.id}:${world.reader.id}:family`,
    ` ${subject}`,
  ]) {
    assert.deepEqual(await decide({ ...page, subject: bad }), { allow: false, code: "bad-subject" }, bad);
  }
  assert.equal((await authorize(app.baseUrl, { ...page })).status, 400, "no subject");
  assert.equal((await authorize(app.baseUrl, { ...page, subject: 1 })).status, 400);

  // The Artifact or version gone, or not of this Artifact.
  const gone = { allow: false, code: "deleted" };
  assert.deepEqual(await decide({ artifact: world.items.deleted.id, version: world.versions.deletedV1.id, subject }), gone);
  assert.deepEqual(await decide({ artifact: world.items.revoked.id, version: world.versions.revokedV1.id, subject }), gone);
  assert.deepEqual(await decide({ artifact: world.items.page.id, version: world.versions.sheetV1.id, subject }), gone, "another Artifact's version");
  assert.deepEqual(await decide({ artifact: `pt_${randomUUID()}`, version: world.versions.v2.id, subject }), gone);
  assert.deepEqual(await decide({ artifact: world.items.page.id, version: `v_${randomUUID()}`, subject }), gone);
  await getDb().update(artifactVersions).set({ revokedAt: new Date() }).where(eq(artifactVersions.id, world.versions.v1.id));
  assert.deepEqual(await decide({ artifact: world.items.page.id, version: world.versions.v1.id, subject }), gone, "a revoked version");

  // Not visible: another conversation's Artifact; a session family of someone else.
  assert.deepEqual(await decide({ artifact: world.items.secret.id, version: world.versions.secretV1.id, subject }), { allow: false, code: "not-visible" });
  const ownerSignIn = await signInForTest(world.owner.id);
  assert.deepEqual(await decide({ ...page, subject: subjectOf(world.server.id, world.reader.id, ownerSignIn.familyId) }), { allow: false, code: "signed-out" }, "another user's session family");
  assert.deepEqual(await decide({ ...page, subject: subjectOf(world.server.id, world.reader.id, randomUUID()) }), { allow: false, code: "signed-out" }, "an unknown session family");
  assert.deepEqual(await decide({ ...page, subject: subjectOf(world.server.id, randomUUID(), null) }), { allow: false, code: "signed-out" }, "an unknown user");

  // Still allowed until each of these happens.
  assert.deepEqual(await decide({ ...page, subject }), { allow: true });
});

test("authorize: removal from the home conversation denies at once", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const body = { artifact: world.items.page.id, version: world.versions.v2.id, subject: subjectOf(world.server.id, world.reader.id, null) };
  assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: true });
  await removeHuman(world.channels.priv.id, world.reader.id, { self: true });
  assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: false, code: "not-visible" });
  await addHuman(world.channels.priv.id, world.reader.id);
  assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: true }, "back in the conversation");
});

test("authorize: signing out (the session family revoked) and retirement deny", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const signIn = await signInForTest(world.reader.id);
  const page = { artifact: world.items.page.id, version: world.versions.v2.id };
  const signedIn = { ...page, subject: subjectOf(world.server.id, world.reader.id, signIn.familyId) };
  assert.deepEqual((await authorize(app.baseUrl, signedIn)).body, { allow: true });
  const logout = await fetch(`${app.baseUrl}/api/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: signIn.refreshToken }) });
  assert.equal(logout.status, 200);
  assert.deepEqual((await authorize(app.baseUrl, signedIn)).body, { allow: false, code: "signed-out" });

  // Retirement, with or without a session family.
  const other = await seed.human();
  await addMember(world.server.id, other.id);
  await addHuman(world.channels.priv.id, other.id);
  const otherSubject = { ...page, subject: subjectOf(world.server.id, other.id, null) };
  assert.deepEqual((await authorize(app.baseUrl, otherSubject)).body, { allow: true });
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, other.id));
  assert.deepEqual((await authorize(app.baseUrl, otherSubject)).body, { allow: false, code: "signed-out" });
});

test("authorize: the subject's user must still stand in the subject's server, for every home", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const { page, memo } = world.items;
  const ask = async (artifact: string, version: string, userId: string, serverId: string) =>
    (await authorize(app.baseUrl, { artifact, version, subject: subjectOf(serverId, userId, null) })).body;
  const allow = { allow: true };
  const hidden = { allow: false, code: "not-visible" };

  // A public Artifact: a member reads every version, an outsider (in its own server) the current one only.
  assert.deepEqual(await ask(memo.id, world.versions.memoV1.id, world.reader.id, world.server.id), allow);
  assert.deepEqual(await ask(memo.id, world.versions.memoV2.id, world.peerUser.id, world.peer.id), allow);
  assert.deepEqual(await ask(memo.id, world.versions.memoV1.id, world.peerUser.id, world.peer.id), hidden);
  // A subject naming a server its user was never in gets nothing, not even the public current version.
  assert.deepEqual(await ask(memo.id, world.versions.memoV1.id, world.peerUser.id, world.server.id), hidden);
  assert.deepEqual(await ask(memo.id, world.versions.memoV2.id, world.peerUser.id, world.server.id), hidden);

  // Removed from the server: denied for a conversation home and for the public Artifact's older version.
  assert.deepEqual(await ask(page.id, world.versions.v2.id, world.reader.id, world.server.id), allow);
  await removeMember(world.server.id, world.reader.id);
  assert.deepEqual(await ask(page.id, world.versions.v2.id, world.reader.id, world.server.id), hidden);
  assert.deepEqual(await ask(memo.id, world.versions.memoV1.id, world.reader.id, world.server.id), hidden);
  assert.deepEqual(await ask(memo.id, world.versions.memoV2.id, world.reader.id, world.server.id), hidden);
});

test("authorize: Artifacts off denies", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const body = { artifact: world.items.page.id, version: world.versions.v2.id, subject: subjectOf(world.server.id, world.reader.id, null) };
  assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: true });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: false, code: "not-visible" });
});

// A public Artifact is read from any server (Tenny, task #74): another
// server's reader gets its frame and the Worker's allow (the current version,
// as any outsider), only while it is public, and not with Artifacts off.
test("authorize and frame: a public Artifact opens for another server's reader, the current version only, while it is public; not with Artifacts off", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const { memo } = world.items;
    const outsiderSignIn = await signInForTest(world.peerUser.id);
    const body = { artifact: memo.id, version: world.versions.memoV2.id, subject: subjectOf(world.peer.id, world.peerUser.id, outsiderSignIn.familyId) };
    const outsider = { token: outsiderSignIn.token, serverId: world.peer.id, artifact: memo.id };
    // Read, the current version only.
    assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: true });
    const opened = await frame(app.baseUrl, outsider);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const claims = await claimsOf(opened.body);
    assert.deepEqual({ artifact: claims.artifact, version: claims.version, viewer: claims.viewer, subject: claims.subject }, { artifact: memo.id, version: world.versions.memoV2.id, viewer: `user:${world.peerUser.id}`, subject: body.subject });
    assert.equal(worker.calls.length, 0, "signed by the server, the Worker is not asked");
    const older = await frame(app.baseUrl, { ...outsider, body: { version: 1 } });
    assert.equal(older.status, 404, "an outsider's history stays the current version");
    assert.deepEqual((await authorize(app.baseUrl, { ...body, version: world.versions.memoV1.id })).body, { allow: false, code: "not-visible" });

    // Unpublished (back to its server's home): it is not theirs to see.
    await getDb().update(artifactItems).set({ homeKind: "server" }).where(eq(artifactItems.id, memo.id));
    assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: false, code: "not-visible" }, "no longer public");
    await getDb().update(artifactItems).set({ homeKind: "public" }).where(eq(artifactItems.id, memo.id));

    // Artifacts off: nobody reads it.
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
    assert.deepEqual((await authorize(app.baseUrl, body)).body, { allow: false, code: "not-visible" }, "Artifacts off");
    const calls = worker.calls.length;
    const hidden = await frame(app.baseUrl, outsider);
    assert.equal(hidden.status, 403, JSON.stringify(hidden.body));
    assert.equal(hidden.body.code, "ARTIFACTS_NOT_ENABLED");
    assert.equal(worker.calls.length, calls, "the Worker is not asked");
  } finally {
    await worker.close();
  }
});

test("frame: a public Artifact gives an outsider the current version only; a removed member gets nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const { memo } = world.items;
    const outsider = { token: await accessTokenForTest(world.peerUser.id), serverId: world.peer.id, artifact: memo.id };
    assert.equal((await frame(app.baseUrl, outsider)).status, 200);
    assert.equal((await claimsOf((await frame(app.baseUrl, outsider)).body)).version, world.versions.memoV2.id);
    assert.equal((await frame(app.baseUrl, { ...outsider, body: { version: 2 } })).status, 200, "the current version by number");
    const older = await frame(app.baseUrl, { ...outsider, body: { version: 1 } });
    assert.equal(older.status, 404);
    assert.deepEqual(older.body, webVersionNotFound(1, 2).body);

    const member = { token: await accessTokenForTest(world.reader.id), serverId: world.server.id, artifact: memo.id };
    const history = await frame(app.baseUrl, { ...member, body: { version: 1 } });
    assert.equal(history.status, 200, "a member reads the history");
    assert.equal((await claimsOf(history.body)).version, world.versions.memoV1.id);
    const calls = worker.calls.length;
    await removeMember(world.server.id, world.reader.id);
    // requireServer refuses a reader who no longer stands in the server, before the route.
    assert.equal((await frame(app.baseUrl, { ...member, body: { version: 1 } })).status, 403);
    assert.equal((await frame(app.baseUrl, member)).status, 403);
    assert.equal(worker.calls.length, calls);
  } finally {
    await worker.close();
  }
});

limitedTest("frame: limited per user (429 RATE_LIMITED past the limit, other users unaffected)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const reader = { token: await accessTokenForTest(world.reader.id), serverId: world.server.id, artifact: world.items.page.id };
    assert.equal((await frame(app.baseUrl, reader)).status, 200);
    assert.equal((await frame(app.baseUrl, reader)).status, 200);
    const third = await frame(app.baseUrl, reader);
    assert.equal(third.status, 429);
    assert.equal(third.body.code, "RATE_LIMITED");
    assert.equal(worker.calls.length, 0);
    assert.equal((await frame(app.baseUrl, { ...reader, token: await accessTokenForTest(world.owner.id) })).status, 200, "another user's own budget");
  } finally {
    await worker.close();
  }
});

limitedTest("viewer: in the frame route's budget, since its answer signs a ticket too (429 RATE_LIMITED past it, together with the frame route)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const worker = await startWorker();
  try {
    const reader = { token: await accessTokenForTest(world.reader.id), serverId: world.server.id, artifact: world.items.page.id };
    const first = await viewer(app.baseUrl, reader);
    assert.equal(first.status, 200);
    assert.ok(first.body.frame, "a ticket signed");
    assert.equal((await frame(app.baseUrl, reader)).status, 200);
    // Two tickets this minute: neither route signs a third.
    const third = await viewer(app.baseUrl, reader);
    assert.equal(third.status, 429);
    assert.equal(third.body.code, "RATE_LIMITED");
    assert.equal(third.body.frame, undefined);
    assert.equal((await frame(app.baseUrl, reader)).status, 429);
    // `details` signs none: outside the budget.
    const details = await fetch(`${app.baseUrl}${artifactWebPaths.details(asArtifactId(reader.artifact))}`, {
      headers: { Authorization: `Bearer ${reader.token}`, "X-Server-Id": reader.serverId },
    });
    assert.equal(details.status, 200, "details is not in the frame budget");
    assert.equal((await viewer(app.baseUrl, { ...reader, token: await accessTokenForTest(world.owner.id) })).status, 200, "another user's own budget");
  } finally {
    await worker.close();
  }
});

// ---- the manifest ------------------------------------------------------------------

// ---- a publish check's subject (task #130) -------------------------------------------

const checkSubjectOf = (artifact: string, version: string) => `v1:check:${artifact}:${version}`;

/** A check Worker's token of its own: what makes a deployment run publish checks (checkWorkerToken.ts checksConfigured). */
const CHECK_WORKER_TOKEN = "check-worker-token-".padEnd(40, "c");

/** The world on a deployment with a check Worker (and the content Worker's token configured). */
async function seedCheckWorld(seed: ReturnType<typeof createSeed>) {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", CHECK_WORKER_TOKEN);
  return seedWorld(seed);
}

test("authorize: a check subject reads exactly its version, in any home and not only the current one, while its check runs", async ({ app, seed }) => {
  const world = await seedCheckWorld(seed);
  const { page, secret, memo } = world.items;
  const { v1, v2, secretV1, memoV1 } = world.versions;
  const decide = async (artifact: string, version: string, subject = checkSubjectOf(artifact, version)) => (await authorize(app.baseUrl, { artifact, version, subject })).body;
  const lease = () => new Date(Date.now() + 60_000);
  const setStatus = (versionId: string, status: "running" | "done", leaseExpiresAt: Date | null = status === "running" ? lease() : null) =>
    getDb().update(artifactVersionChecks).set({ status, finishedAt: status === "done" ? new Date() : null, leaseExpiresAt }).where(eq(artifactVersionChecks.versionId, versionId));
  const sink = traced(app);

  assert.deepEqual(await decide(page.id, v2.id), { allow: false, code: "not-checking" }, "no check at all");
  await getDb().insert(artifactVersionChecks).values({ versionId: v2.id, status: "pending" });
  assert.deepEqual(await decide(page.id, v2.id), { allow: false, code: "not-checking" }, "recorded, not running yet");
  await setStatus(v2.id, "running");
  assert.deepEqual(await decide(page.id, v2.id), { allow: true });
  // A check whose task died stays running, but its lease runs out (Tenny): the door closes by itself.
  await setStatus(v2.id, "running", new Date(Date.now() - 1000));
  assert.deepEqual(await decide(page.id, v2.id), { allow: false, code: "not-checking" }, "lease expired");
  await setStatus(v2.id, "running");
  assert.deepEqual(spansOf(sink, "server.artifacts.content.authorize").map((span) => span.attrs?.outcome), ["not-checking", "not-checking", "allow", "not-checking"]);

  // Any home (a private conversation no reader is asked about), and a version that isn't current.
  await getDb().insert(artifactVersionChecks).values([{ versionId: secretV1.id, status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) }, { versionId: memoV1.id, status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) }, { versionId: v1.id, status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) }]);
  assert.deepEqual(await decide(secret.id, secretV1.id), { allow: true }, "a private conversation's Artifact");
  assert.deepEqual(await decide(memo.id, memoV1.id), { allow: true }, "an older version of a public one");
  assert.deepEqual(await decide(page.id, v1.id), { allow: true });

  // Exactly the version and Artifact the subject names, written exactly.
  assert.deepEqual(await decide(page.id, v2.id, checkSubjectOf(page.id, v1.id)), { allow: false, code: "bad-subject" }, "another version's subject");
  assert.deepEqual(await decide(page.id, v1.id, checkSubjectOf(memo.id, v1.id)), { allow: false, code: "bad-subject" }, "another Artifact's subject");
  for (const bad of [
    `v1:check:${page.id}`,
    `v1:check:${page.id}:${v2.id}:extra`,
    `v1:check:${page.id.toUpperCase()}:${v2.id}`,
    `v1:CHECK:${page.id}:${v2.id}`,
    `v1:check:${v2.id}:${page.id}`,
    ` ${checkSubjectOf(page.id, v2.id)}`,
  ]) assert.deepEqual(await decide(page.id, v2.id, bad), { allow: false, code: "bad-subject" }, bad);
  // A check's subject never passes as a reader's, nor a reader's for a check's.
  assert.deepEqual(await decide(page.id, v2.id, subjectOf(world.server.id, world.reader.id, null)), { allow: true }, "the reader's own subject is decided as a reader's");
  assert.deepEqual(await decide(page.id, v2.id, `v1:anon:${page.id}:${v2.id}`), { allow: false, code: "not-public" }, "an anonymous subject is decided as one");

  // Its check finished: no more reads.
  await setStatus(v2.id, "done");
  assert.deepEqual(await decide(page.id, v2.id), { allow: false, code: "not-checking" }, "done");
});

test("authorize: a check subject is denied once the Artifact or version is gone, without a check Worker, with Artifacts off, or once its server is deleted", async ({ app, seed }) => {
  const world = await seedCheckWorld(seed);
  const { page, deleted, revoked } = world.items;
  const { v1, v2, deletedV1, revokedV1 } = world.versions;
  await getDb().insert(artifactVersionChecks).values([v1, v2, deletedV1, revokedV1].map((version) => ({ versionId: version.id, status: "running" as const, leaseExpiresAt: new Date(Date.now() + 60_000) })));
  const decide = async (artifact: string, version: string) => (await authorize(app.baseUrl, { artifact, version, subject: checkSubjectOf(artifact, version) })).body;

  assert.deepEqual(await decide(deleted.id, deletedV1.id), { allow: false, code: "deleted" });
  assert.deepEqual(await decide(revoked.id, revokedV1.id), { allow: false, code: "deleted" });
  assert.deepEqual(await decide(page.id, world.versions.sheetV1.id), { allow: false, code: "deleted" }, "another Artifact's version");
  await getDb().update(artifactVersions).set({ revokedAt: new Date() }).where(eq(artifactVersions.id, v1.id));
  assert.deepEqual(await decide(page.id, v1.id), { allow: false, code: "deleted" }, "a revoked version");

  assert.deepEqual(await decide(page.id, v2.id), { allow: true });
  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", "");
  assert.deepEqual(await decide(page.id, v2.id), { allow: false, code: "not-visible" }, "a deployment without a check Worker");
  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", CHECK_WORKER_TOKEN);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual(await decide(page.id, v2.id), { allow: false, code: "not-visible" }, "Artifacts off");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  assert.deepEqual(await decide(page.id, v2.id), { allow: true });
  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, world.server.id));
  assert.deepEqual(await decide(page.id, v2.id), { allow: false, code: "not-visible" }, "its server deleted");
});

test("authorize: a check subject is nobody: allowing it writes no read position, presence, Activity or notice", async ({ app, seed }) => {
  const world = await seedCheckWorld(seed);
  const { page } = world.items;
  const { v2 } = world.versions;
  await getDb().insert(artifactVersionChecks).values({ versionId: v2.id, status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) });
  const counts = async () => ({
    readPositions: (await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, page.id))).length,
    events: (await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, page.id))).length,
    inbox: (await getDb().select().from(objectInboxStates)).length,
    notices: (await getDb().select().from(notificationOutbox)).length,
  });
  const before = await counts();
  for (let at = 0; at < 3; at += 1) {
    assert.deepEqual((await authorize(app.baseUrl, { artifact: page.id, version: v2.id, subject: checkSubjectOf(page.id, v2.id) })).body, { allow: true });
  }
  assert.deepEqual(await counts(), before);
  // The answer is the bare allow every subject gets: no level, capability or viewer in it.
  const res = await authorize(app.baseUrl, { artifact: page.id, version: v2.id, subject: checkSubjectOf(page.id, v2.id) });
  assert.deepEqual(Object.keys(res.body), ["allow"]);
});

test("manifest: a framed published version with only its R2 files and their keys; 404 otherwise", async ({ app, seed }) => {
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  const world = await seedWorld(seed);
  const { page } = world.items;
  const res = await manifest(app.baseUrl, world.versions.v1.id, page.id);
  assert.equal(res.status, 200);
  const files = await getDb().select({ path: artifactVersionFiles.path, key: artifactBlobs.r2Key, sha256: artifactBlobs.sha256 })
    .from(artifactVersionFiles).innerJoin(artifactBlobs, eq(artifactBlobs.id, artifactVersionFiles.blobId))
    .where(eq(artifactVersionFiles.versionId, world.versions.v1.id));
  const r2 = (path: string) => files.find((file) => file.path === path)!;
  assert.deepEqual(res.body, {
    artifact: page.id,
    version: world.versions.v1.id,
    number: 1,
    kind: "html",
    entry: "index.html",
    spa: false,
    title: "First title",
    // Left out: the blob still uploading, and the blob of another server.
    files: [
      { path: "assets/style.css", size: 4, sha256: r2("assets/style.css").sha256, key: r2("assets/style.css").key },
      { path: "index.html", size: 11, sha256: r2("index.html").sha256, key: r2("index.html").key },
    ],
  });
  // Relative keys only, in the row and in the manifest: the Worker adds the fixed apps/artifacts/ itself.
  const relativeKey = /^servers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/blobs\/([0-9a-f]{64})\/b_[0-9a-f-]{36}$/;
  for (const file of res.body.files as Array<{ key: string; sha256: string }>) assert.equal(relativeKey.exec(file.key)?.[1], file.sha256, file.key);
  assert.match(r2("index.html").key ?? "", new RegExp(`^servers/${world.server.id}/blobs/[0-9a-f]{64}/b_`));
  assert.equal((await manifest(app.baseUrl, world.versions.v2.id, page.id)).body.title, page.title, "a version that set no title has the Artifact's");

  for (const [version, artifact, why] of [
    [world.versions.sheetV1.id, world.items.sheet.id, "csv is not framed"],
    [world.versions.v1.id, world.items.sheet.id, "another Artifact's version"],
    [world.versions.v1.id, null, "no artifact"],
    [`v_${randomUUID()}`, page.id, "unknown version"],
    [world.versions.deletedV1.id, world.items.deleted.id, "deleted Artifact"],
  ] as const) {
    const miss = await manifest(app.baseUrl, version, artifact);
    assert.equal(miss.status, 404, why);
  }
  assert.equal((await manifest(app.baseUrl, world.versions.v1.id, page.id, null)).status, 401, "no token");
});
