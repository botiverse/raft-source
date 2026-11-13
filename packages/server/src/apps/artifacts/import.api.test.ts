// Importing one Artifact of the standalone app (raft-artifacts.com) over HTTP,
// on both APIs, against a fake of the standalone app's import API (an
// injected fetch): the link is only parsed (a foreign host is refused with no
// request at all), the slug must be the caller's server's (a slug another
// server has now is refused, a renamed one's included), guests are refused,
// and so is a target conversation with guests (or open to them) and a joint
// one; without a target the home is the whole server. Limits and the upload
// cap are checked from the manifest before any file is fetched; a failed
// import (a file whose bytes don't hash to its manifest's sha256, or the
// whole import over its deadline) leaves nothing behind, not even the bytes
// it stored. A repeat answers the Artifact an earlier import made (again
// after a deleted one: a new import), a name taken in the home is reported
// with the Artifact that has it, the flag and the configuration gate it, and
// the success path writes the Artifact, its version 1 with the note, its
// files, the audit row and tells the standalone app where it went. The files
// it copies count against the monthly file upload quota (a Free server
// without room is refused before any file is fetched; files it has are free;
// a failed import's stored bytes stay counted, an unfinished store's don't).
// The author is the old Artifact's creator when Raft confirms it in the
// server (its type and id are hints), not the importer; otherwise the
// importer (on demand) or the ops actor (the per-server move). Each import is a
// span of its request with a span per step (manifest, blobs, commit).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { BasicTracer, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, MemoryTraceSink, artifactLinkId, asArtifactId, asServerId, parseAgentApiRateLimitedBody, type CompletedTraceSpan, type ServerId } from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { agents, channelHumans, channels, featureFlagRules, serverFileUploadUsageMonths, servers } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { reserveFileUpload } from "../../platform/fileUploadQuota";
import { refusalBody } from "../../platform/refusals";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateUserDM } from "../../services/channelService";
import { SERVER_GUEST_FEATURE_FLAG_KEY, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { billingUsageMonth } from "../../services/fileUploadQuotaService";
import { createMessage } from "../../services/messageService";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { capturePaywallHits } from "../../test/integration/paywallHits";
import type { createSeed } from "../../test/integration/seed";
import { deleteClaimedBlobs, storeBlob, type BlobClaim } from "./blobs";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { ARTIFACT_IMPORT_BUSY_RETRY_AFTER_SECONDS, ARTIFACT_IMPORT_RATE_LIMITER, ARTIFACT_IMPORTS_AT_ONCE, ARTIFACT_OPS_IMPORT_ACTOR, __clearImportSlotsForTests, __setImportDeadlineForTests, importLegacyArtifactAsOps } from "./import";
import { __setLegacyWorkerFetchForTests, __setLegacyWorkerTimeoutsForTests } from "./legacyWorker";
import { artifactAudit, artifactBlobs, artifactItems, artifactReadPositions, artifactSubscriptions, artifactVersionFiles, artifactVersions } from "./schema";
import { seedBoundGuest } from "../../test/guestFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const LEGACY_OTHER_SERVER_ERROR = "This link's server name now belongs to another server, and an import only brings in this server's artifacts: if it is that server's, ask someone there to import it.";


/** Records the app's traces from here on. */
function traced(app: { app: { set(key: string, value: unknown): unknown } }): MemoryTraceSink {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  return sink;
}

/** One import's spans: the import's (under its request's) and its steps (under it), as [name, status, attrs picked]. */
function importSpans(sink: MemoryTraceSink, keys: readonly string[]): Array<[string, string, Record<string, unknown>]> {
  const all = sink.getAllSpans();
  const imports = all.filter((span) => span.name === "server.artifacts.import");
  assert.equal(imports.length, 1, "one import span");
  const root = imports[0]!;
  assert.equal(all.find((span) => span.context.spanId === root.context.parentSpanId)?.name, "server.http.request");
  const steps = all.filter((span) => span.context.parentSpanId === root.context.spanId).sort((a, b) => a.startTimeMs - b.startTimeMs);
  const pick = (span: CompletedTraceSpan) => Object.fromEntries(keys.filter((key) => span.attrs?.[key] !== undefined).map((key) => [key, span.attrs![key]]));
  return [root, ...steps].map((span) => [span.name, span.status, pick(span)]);
}

const test = createApiTest();
const LEGACY_BASE = "https://legacy-import.example.test";
const LEGACY_TOKEN = "legacy-import-token-0123456789-abcdefghij";
const MiB = 1024 * 1024;
const label = () => randomUUID().slice(0, 8);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-import-tests-hmac-secret-0123456789");
  vi.stubEnv("ARTIFACTS_LEGACY_IMPORT_URL", LEGACY_BASE);
  vi.stubEnv("ARTIFACTS_LEGACY_IMPORT_TOKEN", LEGACY_TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setLegacyWorkerFetchForTests(undefined);
  __setArtifactR2StoreForTests(undefined);
  __setLegacyWorkerTimeoutsForTests(undefined);
  __setImportDeadlineForTests(undefined);
  __clearImportSlotsForTests();
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

// ---- the standalone app, faked ---------------------------------------------------

/** `hang`: the blob request never answers (until the request is aborted); `before`: runs before it answers. */
type LegacyFile = { path: string; bytes: Buffer; sha256?: string; size?: number; hang?: boolean; before?: () => Promise<void> };
interface LegacyArtifact {
  artifactId: string;
  name: string;
  title: string;
  description: string | null;
  entry: string;
  importedTo: string | null;
  version: number;
  files: LegacyFile[];
  /** Who published it there; absent: null. */
  creator?: { type: "agent" | "user"; raftId: string; name: string } | null;
}
type Request = { method: string; path: string; query: Record<string, string>; authorization: string | null; body: unknown };

/**
 * The standalone app's import API over an in-memory store, keyed by (Raft
 * server id, name) as the real one. Every request is recorded; `imported`
 * stores `newUrl` as the Artifact's `importedTo` (unless `failImported`).
 */
function fakeLegacyApp() {
  const artifacts = new Map<string, LegacyArtifact>();
  const requests: Request[] = [];
  const state = { failImported: false };
  const key = (server: string, name: string) => `${server}/${name}`;
  const notFound = () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request: Request = { method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: headers.get("authorization"), body };
    requests.push(request);
    assert.equal(url.origin, LEGACY_BASE, "only ever the configured address");
    if (request.authorization !== `Bearer ${LEGACY_TOKEN}`) return new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), { status: 401 });
    if (url.pathname === "/internal/raft-import/manifest") {
      const found = artifacts.get(key(request.query.server!, request.query.name!));
      if (!found) return notFound();
      return Response.json({
        artifactId: found.artifactId,
        name: found.name,
        title: found.title,
        description: found.description,
        entry: found.entry,
        importedTo: found.importedTo,
        creator: found.creator ?? null,
        version: {
          number: found.version,
          files: found.files.map((file) => ({ path: file.path, sha256: file.sha256 ?? sha(file.bytes), size: file.size ?? file.bytes.length, type: "text/html; charset=utf-8" })),
        },
      });
    }
    if (url.pathname === "/internal/raft-import/blob") {
      const found = artifacts.get(key(request.query.server!, request.query.name!));
      const file = found?.files.find((f) => (f.sha256 ?? sha(f.bytes)) === request.query.sha256);
      if (!file) return notFound();
      if (file.hang) {
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      await file.before?.();
      return new Response(new Uint8Array(file.bytes), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    if (url.pathname === "/internal/raft-import/imported" && request.method === "POST") {
      if (state.failImported) return new Response("boom", { status: 500 });
      const found = artifacts.get(key((body as { server: string }).server, (body as { name: string }).name));
      if (!found) return notFound();
      found.importedTo = (body as { newUrl: string }).newUrl;
      return new Response(null, { status: 204 });
    }
    return notFound();
  }) as typeof fetch;
  __setLegacyWorkerFetchForTests(fetcher);
  return {
    artifacts,
    requests,
    state,
    put(serverId: string, artifact: Omit<LegacyArtifact, "artifactId" | "importedTo" | "version"> & Partial<Pick<LegacyArtifact, "artifactId" | "importedTo" | "version">>) {
      const full: LegacyArtifact = { artifactId: `pt_${randomUUID()}`, importedTo: null, version: 3, ...artifact };
      artifacts.set(key(serverId, full.name), full);
      return full;
    },
    blobRequests: () => requests.filter((r) => r.path === "/internal/raft-import/blob"),
  };
}

// ---- the world -------------------------------------------------------------------

/**
 * A server, Artifacts on (unless `flag: false`): owner, a member and a
 * guest bound to #guested (people); agent A in #pub and #guested; #pub (owner, member), #guested
 * (owner, member, guest) and #priv (owner only); a thread in #pub; a joint
 * channel with the owner; and a peer server with its own owner.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { flag?: boolean } = {}) {
  const owner = await seed.human();
  const member = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [member, guest] });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.flag !== false);
  await getDb().insert(featureFlagRules).values([
    { flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] },
  ]);
  const agentA = await createAgent(server.id, `imp-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const pub = await createChannel(server.id, `pub-${label()}`);
  const guested = await createChannel(server.id, `guested-${label()}`);
  const priv = await createChannel(server.id, `priv-${label()}`, undefined, "private");
  for (const human of [owner, member]) await addHuman(pub.id, human.id);
  for (const human of [owner, member]) await addHuman(guested.id, human.id);
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: guested.id });
  await addHuman(priv.id, owner.id);
  await addAgent(pub.id, agentA.id);
  await addAgent(guested.id, agentA.id);
  const root = await createMessage(pub.id, "user", owner.id, `thread root ${label()}`);
  const joint = await seedJointChannel({ name: `joint-${label()}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  await addHuman(joint.projections[0]!.id, owner.id);
  const apiKey = (await mintAgentCredential({ agentId: agentA.id, scopes: ["read", "send"], name: `imp-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const as = async (userId: string, sid: string = server.id) => ({ token: await accessTokenForTest(userId), serverId: sid });
  return {
    server, serverId, peer, owner, member, guest, peerOwner, agentA, pub, guested, priv, root, joint: joint.projections[0]!, apiKey, r2,
    who: { owner: await as(owner.id), member: await as(member.id), guest: await as(guest.id), peerOwner: await as(peerOwner.id, peer.id) },
    link: (name: string, slug: string = server.slug) => `https://raft-artifacts.com/p/${slug}/${name}`,
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

type Reply = { status: number; body: any };
async function webImport(app: { baseUrl: string }, who: { token: string; serverId: string }, body: unknown): Promise<Reply & { retryAfter: string | null }> {
  const res = await fetch(`${app.baseUrl}/api/artifacts/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: text ? JSON.parse(text) : null };
}
async function agentImport(app: { baseUrl: string }, world: World, body: unknown): Promise<Reply & { retryAfter: string | null }> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${world.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: text ? JSON.parse(text) : null };
}

const itemsOf = (serverId: ServerId) => getDb().select().from(artifactItems).where(eq(artifactItems.serverId, serverId));
const blobsOf = (serverId: ServerId) => getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, serverId));

/** This month's file upload usage row, as if `usedBytes` were already uploaded this month. */
async function setUploadUsage(serverId: ServerId, usedBytes: number) {
  await getDb().insert(serverFileUploadUsageMonths)
    .values({ serverId, month: billingUsageMonth(), usedBytes, reservedBytes: 0 })
    .onConflictDoUpdate({ target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month], set: { usedBytes, reservedBytes: 0 } });
}
async function uploadUsage(serverId: ServerId): Promise<{ usedBytes: number; reservedBytes: number }> {
  const [row] = await getDb().select().from(serverFileUploadUsageMonths)
    .where(and(eq(serverFileUploadUsageMonths.serverId, serverId), eq(serverFileUploadUsageMonths.month, billingUsageMonth())));
  return { usedBytes: row?.usedBytes ?? 0, reservedBytes: row?.reservedBytes ?? 0 };
}
const page = (text: string) => Buffer.from(`<html><title>${text}</title><body>${text}</body></html>`);

// ---- refusals before any request -------------------------------------------------

test("SSRF: a link on any other host is refused without a single request to anyone", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  for (const from of [
    `https://evil.example/p/${world.server.slug}/notes`,
    `http://169.254.169.254/p/${world.server.slug}/notes`,
    `https://raft-artifacts.com.evil.example/p/${world.server.slug}/notes`,
    `https://user@evil.example/p/${world.server.slug}/notes`,
    "file:///etc/passwd",
    "notes",
    "https://raft-artifacts.com/a/some-version-token",
    `https://raft-artifacts.com/x/${world.server.slug}/notes`,
  ]) {
    const res = await webImport(app, world.who.owner, { from, conversationId: world.pub.id });
    assert.equal(res.status, 400, from);
    assert.equal(res.body.code, "NOT_A_LEGACY_LINK", from);
  }
  const agent = await agentImport(app, world, { from: `https://evil.example/p/${world.server.slug}/notes`, target: `#${world.pub.name}` });
  assert.equal(agent.status, 400);
  assert.deepEqual(agent.body.details, { from: `https://evil.example/p/${world.server.slug}/notes`, reason: "host" });
  assert.equal(legacy.requests.length, 0, "nothing was requested");
  assert.equal((await itemsOf(world.serverId)).length, 0);
});

test("a link naming another server's slug is refused before the standalone app is asked", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.peer.id, { name: "theirs", title: "Theirs", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("t") }] });
  const res = await webImport(app, world.who.owner, { from: world.link("theirs", world.peer.slug), conversationId: world.pub.id });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, refusalBody({ code: "LEGACY_OTHER_SERVER", error: LEGACY_OTHER_SERVER_ERROR, details: { server: world.peer.slug } }));
  const agent = await agentImport(app, world, { from: world.link("theirs", world.peer.slug), target: `#${world.pub.name}` });
  assert.equal(agent.body.code, "LEGACY_OTHER_SERVER");
  assert.equal(legacy.requests.length, 0);
});

test("renamed: S's old slug, now another server's, is refused as LEGACY_OTHER_SERVER (the link can't say it was S's)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const oldSlug = world.server.slug;
  await getDb().update(servers).set({ slug: `renamed-${label()}` }).where(eq(servers.id, world.server.id));
  await getDb().update(servers).set({ slug: oldSlug }).where(eq(servers.id, world.peer.id));
  const res = await webImport(app, world.who.owner, { from: world.link("notes", oldSlug) });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, refusalBody({ code: "LEGACY_OTHER_SERVER", error: LEGACY_OTHER_SERVER_ERROR, details: { server: oldSlug } }));
  assert.equal((await agentImport(app, world, { from: world.link("notes", oldSlug) })).body.code, "LEGACY_OTHER_SERVER");
  assert.equal(legacy.requests.length, 0, "the standalone app is not asked");
  assert.equal((await itemsOf(world.serverId)).length, 0);
});

test("a guest may not import, even into a channel it is in", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const res = await webImport(app, world.who.guest, { from: world.link("notes"), conversationId: world.guested.id });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "FORBIDDEN");
  assert.equal((await webImport(app, world.who.guest, { from: world.link("notes") })).body.code, "FORBIDDEN");
  assert.equal(legacy.requests.length, 0);
  // Witness: a member may; imported into #pub, that is its original conversation (#75).
  const imported = await webImport(app, world.who.member, { from: world.link("notes"), conversationId: world.pub.id });
  assert.equal(imported.status, 201);
  const [made] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, imported.body.card.id));
  assert.equal(made!.originalHomeChannelId, world.pub.id);
});

test("a target conversation with any guest in it is refused, for people and agents alike; guest_visible no longer counts", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const web = await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: world.guested.id });
  assert.equal(web.status, 403);
  assert.deepEqual(web.body, refusalBody({
    code: "TARGET_HAS_GUESTS",
    error: "That conversation has guests in it, and the old artifact was only for this server's members and agents, so nothing was imported: import it for the whole server instead, or into a conversation without guests.",
    details: { conversationId: world.guested.id, reason: "guest_members" },
  }));
  // An agent importing (on a guest's behalf or not) is refused the same.
  const agent = await agentImport(app, world, { from: world.link("notes"), target: `#${world.guested.name}` });
  assert.equal(agent.status, 403);
  assert.deepEqual(agent.body.details, { target: `#${world.guested.name}`, reason: "guest_members" });
  assert.equal(agent.body.code, "TARGET_HAS_GUESTS");
  // A thread of it means it.
  const guestedRoot = await createMessage(world.guested.id, "user", world.owner.id, `root ${label()}`);
  assert.equal((await agentImport(app, world, { from: world.link("notes"), target: `#${world.guested.name}:${guestedRoot.id.slice(0, 8)}` })).body.code, "TARGET_HAS_GUESTS");
  // A DM with a guest.
  const dm = (await findOrCreateUserDM(world.server.id, world.owner.id, world.guest.id))!;
  assert.equal((await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: dm.id })).body.code, "TARGET_HAS_GUESTS");
  assert.equal(legacy.requests.length, 0, "no request before the target passes");
  assert.equal((await itemsOf(world.serverId)).length, 0);
  // No guest in it: the old guest_visible flag no longer opens a channel to
  // guests (a guest reads only its one channel, #wg-rbac:#15), so it may be the home.
  const open = await createChannel(world.server.id, `open-${label()}`);
  await addHuman(open.id, world.owner.id);
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
  legacy.put(world.server.id, { name: "open", title: "Open", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("o") }] });
  const openRes = await webImport(app, world.who.owner, { from: world.link("open"), conversationId: open.id });
  assert.equal(openRes.status, 201, JSON.stringify(openRes.body));

  // Witness: the guest leaves the channel, and it may be the home.
  await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, world.guested.id), eq(channelHumans.userId, world.guest.id)));
  assert.equal((await agentImport(app, world, { from: world.link("notes"), target: `#${world.guested.name}` })).status, 201);
});

test("without a target the home is the whole server (as on raft-artifacts.com): agent and web; its names are the server home's", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  legacy.put(world.server.id, { name: "plan", title: "Plan", description: null, entry: "plan.md", files: [{ path: "plan.md", bytes: Buffer.from("# plan") }] });
  const agent = await agentImport(app, world, { from: world.link("notes") });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  assert.deepEqual(agent.body.artifact.home, { kind: "server", serverName: world.server.name });
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, agent.body.artifact.id));
  assert.equal(item!.homeKind, "server");
  assert.equal(item!.homeChannelId, null);
  assert.equal(item!.originalHomeChannelId, null, "imported into the whole server: no original conversation (#75)");
  const web = await webImport(app, world.who.member, { from: world.link("plan") });
  assert.equal(web.status, 201, JSON.stringify(web.body));
  assert.deepEqual(web.body.card.home, { kind: "server" });
  // The server home is the old Artifact's audience: members and agents, not guests.
  const seen = async (who: { token: string; serverId: string }) => (await fetch(`${app.baseUrl}/api/artifacts/${web.body.card.id}`, { headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } })).status;
  assert.equal(await seen(world.who.owner), 200);
  assert.notEqual(await seen(world.who.guest), 200);

  // A name is taken in the server home by another server-home Artifact, not by a conversation's.
  legacy.put(world.server.id, { name: "taken", title: "Taken", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("t") }] });
  const holder = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({ id: holder, serverId: world.serverId, urlKey: holder, name: "taken", title: "Other", homeKind: "server", createdByType: "user", createdById: world.owner.id });
  const taken = await agentImport(app, world, { from: world.link("taken") });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, "NAME_TAKEN");
  assert.deepEqual(taken.body.details, { name: "taken", existing: { id: holder, url: `${getAppUrl()}/artifacts/${artifactLinkId(asArtifactId(holder))}` } });
  assert.equal((await agentImport(app, world, { from: world.link("taken"), target: `#${world.pub.name}` })).status, 201, "a conversation is another home");

  // The web body: `from`, and `conversationId` only as a string.
  assert.equal((await webImport(app, world.who.member, { from: world.link("plan"), conversationId: 5 })).body.code, "INVALID_REQUEST");
});

test("targets: a joint channel is refused, an invisible or foreign one is not found, a thread means its conversation", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const joint = await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: world.joint.id });
  assert.equal(joint.status, 400);
  assert.deepEqual(joint.body.details, { conversationId: world.joint.id, reason: "joint" });
  assert.equal(joint.body.code, "TARGET_NOT_SUPPORTED");
  const invisible = await webImport(app, world.who.member, { from: world.link("notes"), conversationId: world.priv.id });
  assert.equal(invisible.body.code, "TARGET_NOT_FOUND");
  const foreign = await createChannel(world.peer.id, `peer-${label()}`);
  assert.equal((await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: foreign.id })).body.code, "TARGET_NOT_FOUND");
  assert.equal((await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: "not-a-uuid" })).body.code, "TARGET_NOT_FOUND");
  assert.equal((await agentImport(app, world, { from: world.link("notes"), target: `#${world.priv.name}` })).body.code, "TARGET_NOT_FOUND");
  assert.equal(legacy.requests.length, 0, "no target, no request");

  const viaThread = await agentImport(app, world, { from: world.link("notes"), target: `#${world.pub.name}:${world.root.id.slice(0, 8)}` });
  assert.equal(viaThread.status, 201);
  assert.equal(viaThread.body.artifact.home.conversation.id, world.pub.id);
});

test("Artifacts off, not configured, and no such artifact", async ({ app, seed }) => {
  const off = await seedWorld(seed, { flag: false });
  const legacy = fakeLegacyApp();
  legacy.put(off.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const refused = await webImport(app, off.who.owner, { from: off.link("notes"), conversationId: off.pub.id });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "ARTIFACTS_NOT_ENABLED");
  assert.equal((await agentImport(app, off, { from: off.link("notes"), target: `#${off.pub.name}` })).body.code, "ARTIFACTS_NOT_ENABLED");
  assert.equal(legacy.requests.length, 0);

  const world = await seedWorld(seed);
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const missing = await webImport(app, world.who.owner, { from: world.link("gone"), conversationId: world.pub.id });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body.details, { server: world.server.slug, name: "gone" });
  assert.equal(missing.body.code, "LEGACY_NOT_FOUND");

  vi.stubEnv("ARTIFACTS_LEGACY_IMPORT_URL", "");
  const unconfigured = await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: world.pub.id });
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(unconfigured.body.details, { reason: "not_configured" });
  vi.stubEnv("ARTIFACTS_LEGACY_IMPORT_URL", LEGACY_BASE);
  vi.stubEnv("ARTIFACTS_LEGACY_IMPORT_TOKEN", "too-short");
  assert.equal((await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: world.pub.id })).body.code, "IMPORT_UNAVAILABLE");
  assert.equal(legacy.requests.filter((r) => r.query.name === "notes").length, 0);
  assert.equal((await itemsOf(world.serverId)).length, 0);
});

// ---- limits, before any file --------------------------------------------------------

test("limits and the upload cap are checked from the manifest before any file is fetched", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const fake = (i: number, size: number) => ({ path: `f${i}.bin`, bytes: Buffer.alloc(0), sha256: sha(`fake-${i}`), size });
  legacy.put(world.server.id, { name: "huge-file", title: "Huge", description: null, entry: "f0.bin", files: [fake(0, 15 * MiB + 1)] });
  legacy.put(world.server.id, { name: "many-files", title: "Many", description: null, entry: "f0.bin", files: Array.from({ length: 501 }, (_, i) => fake(i, 1)) });
  legacy.put(world.server.id, { name: "over-cap", title: "Cap", description: null, entry: "f0.bin", files: Array.from({ length: 70 }, (_, i) => fake(i, 15 * MiB)) });

  const file = await webImport(app, world.who.owner, { from: world.link("huge-file"), conversationId: world.pub.id });
  assert.equal(file.status, 413);
  assert.deepEqual(file.body.details, { reason: "file", path: "f0.bin", size: 15 * MiB + 1, limit: 15 * MiB });
  const many = await webImport(app, world.who.owner, { from: world.link("many-files"), conversationId: world.pub.id });
  assert.deepEqual(many.body.details, { reason: "files", count: 501, limit: 500 });
  const cap = await agentImport(app, world, { from: world.link("over-cap"), target: `#${world.pub.name}` });
  assert.equal(cap.status, 413);
  assert.equal(cap.body.code, "IMPORT_TOO_LARGE");
  assert.deepEqual(cap.body.details, { reason: "quota", used: 0, needed: 70 * 15 * MiB, limit: 1024 * MiB });

  assert.equal(legacy.blobRequests().length, 0, "not one file was fetched");
  assert.equal((await itemsOf(world.serverId)).length, 0);
  assert.equal((await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId))).length, 0);
});

test("#114: the per-server move may raise a download's limit (maxFileBytes, at most 64 MiB): an archive entry too, not a shown entry, not a text file, and only there", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const fake = (path: string, size: number) => ({ path, bytes: Buffer.alloc(0), sha256: sha(`fake-${path}-${size}`), size });
  legacy.put(world.server.id, { name: "big-archive", title: "Archive", description: null, entry: "index.html", files: [fake("index.html", 10), fake("data.tar.xz", 46 * 1000 * 1000)] });
  // The 27 old pages: one file each, an archive that is also the entry (Raft only offers it to download).
  legacy.put(world.server.id, { name: "archive-entry", title: "Archive entry", description: null, entry: "bundle.part03", files: [fake("bundle.part03", 46 * 1000 * 1000)] });
  // An entry Raft shows keeps its limit.
  legacy.put(world.server.id, { name: "big-entry", title: "Entry", description: null, entry: "photo.png", files: [fake("photo.png", 20 * MiB)] });
  legacy.put(world.server.id, { name: "big-text", title: "Text", description: null, entry: "index.html", files: [fake("index.html", 10), fake("log.txt", 20 * MiB)] });
  legacy.put(world.server.id, { name: "too-big", title: "Too", description: null, entry: "index.html", files: [fake("index.html", 10), fake("part.zip", 64 * MiB + 1)] });
  const ops = (name: string, maxFileBytes?: number) => importLegacyArtifactAsOps({ serverId: world.serverId, serverSlug: world.server.slug, name, operator: "alice", ...(maxFileBytes ? { maxFileBytes } : {}) });

  // Without it, publishing's limit, as before.
  const plain = await ops("big-archive");
  assert.equal(plain.kind === "failed" && plain.code, "IMPORT_TOO_LARGE");
  assert.deepEqual(plain.kind === "failed" && plain.details, { reason: "file", path: "data.tar.xz", size: 46 * 1000 * 1000, limit: 15 * MiB });
  // With it, the download passes the manifest check (the fake has no bytes for it: the fetch is what fails next).
  const raised = await ops("big-archive", 64 * MiB);
  assert.notEqual(raised.kind === "failed" && raised.code, "IMPORT_TOO_LARGE");
  assert.ok(legacy.blobRequests().length > 0, "it went on to fetch the files");
  const archiveEntry = await ops("archive-entry", 64 * MiB);
  assert.notEqual(archiveEntry.kind === "failed" && archiveEntry.code, "IMPORT_TOO_LARGE", "an archive that is the entry is a download too");
  const archiveEntryPlain = await ops("archive-entry");
  assert.equal(archiveEntryPlain.kind === "failed" && archiveEntryPlain.code, "IMPORT_TOO_LARGE", "without the option, as before");
  for (const [name, path, limit] of [["big-entry", "photo.png", 15 * MiB], ["big-text", "log.txt", 16 * MiB], ["too-big", "part.zip", 64 * MiB]] as const) {
    const outcome = await ops(name, 64 * MiB);
    assert.equal(outcome.kind === "failed" && outcome.code, "IMPORT_TOO_LARGE", name);
    const details = (outcome.kind === "failed" ? outcome.details : {}) as { path?: string; limit?: number };
    assert.deepEqual([details.path, details.limit], [path, limit], name);
  }
  await assert.rejects(() => ops("big-archive", 64 * MiB + 1), /at most/);
  // The web and agent imports never raise it.
  const web = await webImport(app, world.who.owner, { from: world.link("big-archive"), conversationId: world.pub.id });
  assert.equal(web.body.code, "IMPORT_TOO_LARGE");
});

test("monthly file upload quota: a Free server without room is refused FILE_UPLOAD_QUOTA_EXCEEDED before any file is fetched, on both APIs, nothing created; files it has cost nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const fresh = page("new to this server");
  const had = page("the server had these before");
  await storeBlob(memoryR2(world.r2), world.serverId, sha(had), had);
  legacy.put(world.server.id, {
    name: "over-month", title: "Over", description: null, entry: "index.html",
    files: [{ path: "index.html", bytes: fresh }, { path: "had.html", bytes: had }],
  });
  // Room for one byte less than the new file (the file the server has needs none).
  const used = FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES - fresh.length + 1;
  await setUploadUsage(world.serverId, used);
  const captured = capturePaywallHits(app);

  const agent = await agentImport(app, world, { from: world.link("over-month") });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
  // The attachments' refusal, as publish answers it.
  assert.equal(agent.body.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(agent.body.details.requestedBytes, fresh.length, "only the new bytes are asked for");
  assert.equal(agent.body.details.quota.limitBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  assert.equal(agent.body.details.quota.usedBytes, used);
  assert.match(agent.body.details.billingUrl, /\/settings\/billing$/);
  assert.equal(agent.body.suggestedNextAction, `Say in the conversation that the file wasn't uploaded and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${agent.body.details.billingUrl}`);

  await captured.expect(1, "the agent's import");

  const web = await webImport(app, world.who.owner, { from: world.link("over-month"), conversationId: world.pub.id });
  assert.equal(web.status, 403);
  assert.equal(web.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(web.body.details.requestedBytes, fresh.length);
  assert.match(web.body.details.billingUrl, /\/settings\/billing$/);

  // Each refusal is one paywall hit: the agent's (no person) and the owner's, with the new bytes asked for and the month's use.
  await captured.expect(2, "the agent's and the person's import");
  const hit = { gate: "upload_monthly_quota", plan: "free", via: "artifact_import", requested_bytes: fresh.length, month_used_bytes: used };
  assert.deepEqual(captured.hits().map((h) => [h.properties, h.analyticsId === null, h.serverId]), [
    [{ ...hit, actor: "agent" }, true, world.server.id],
    [{ ...hit, actor: "person", viewer_role: "owner" }, false, world.server.id],
  ]);

  assert.equal(legacy.blobRequests().length, 0, "not one file was fetched");
  assert.equal((await itemsOf(world.serverId)).length, 0, "nothing created");
  assert.deepEqual((await blobsOf(world.serverId)).map((blob) => blob.sha256), [sha(had)]);
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: used, reservedBytes: 0 }, "nothing counted, nothing held");
  assert.equal(legacy.requests.filter((r) => r.path === "/internal/raft-import/imported").length, 0);

  // An artifact made only of bytes the server has costs nothing: imported however full the month is.
  legacy.put(world.server.id, { name: "only-had", title: "Had", description: null, entry: "had.html", files: [{ path: "had.html", bytes: had }] });
  const free = await agentImport(app, world, { from: world.link("only-had") });
  assert.equal(free.status, 201);
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: used, reservedBytes: 0 });
  await captured.expect(2, "an import that fits is no hit");
});

test("monthly file upload quota and a failed import: bytes it stored stay counted when deleted (as attachments'), an unfinished store gives its reservation back, a month filled meanwhile refuses", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const good = page("stored, then the import fails");
  const listed = page("what the manifest promised");
  const sent = Buffer.from(listed.toString("utf8").replace("promised", "tampered"));
  legacy.put(world.server.id, {
    name: "tampered", title: "Tampered", description: null, entry: "a.html",
    files: [{ path: "a.html", bytes: good }, { path: "b.html", bytes: sent, sha256: sha(listed), size: listed.length }],
  });
  assert.equal((await agentImport(app, world, { from: world.link("tampered") })).status, 502);
  assert.equal((await blobsOf(world.serverId)).length, 0, "a.html is deleted");
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: good.length, reservedBytes: 0 }, "a.html was uploaded this month: counted once, not refunded");

  // A store whose PUT fails: its reservation is given back, its pending row deleted.
  await setUploadUsage(world.serverId, 0);
  const objects = new Map<string, Buffer>();
  const failing = memoryR2(objects);
  __setArtifactR2StoreForTests({ ...failing, async put() { throw new Error("r2 put failed"); } });
  legacy.put(world.server.id, { name: "unstored", title: "Unstored", description: null, entry: "a.html", files: [{ path: "a.html", bytes: page("never stored") }] });
  assert.equal((await agentImport(app, world, { from: world.link("unstored") })).status, 500);
  assert.equal((await blobsOf(world.serverId)).length, 0, "the pending row is deleted");
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: 0, reservedBytes: 0 }, "nothing counted, nothing held");
  __setArtifactR2StoreForTests(memoryR2(world.r2));

  // The month fills between the check and a file's store: refused there, the files it stored deleted.
  const first = page("first file");
  const second = page("second file");
  legacy.put(world.server.id, {
    name: "raced-month", title: "Raced", description: null, entry: "a.html",
    files: [
      { path: "a.html", bytes: first },
      { path: "b.html", bytes: second, before: async () => { await setUploadUsage(world.serverId, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES); } },
    ],
  });
  const raced = await webImport(app, world.who.owner, { from: world.link("raced-month") });
  assert.equal(raced.status, 403);
  assert.equal(raced.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(raced.body.details.requestedBytes, second.length);
  assert.equal((await itemsOf(world.serverId)).length, 0);
  assert.equal((await blobsOf(world.serverId)).length, 0, "a.html is deleted");
  assert.equal(world.r2.size, 0);
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 });
});

test("deleteClaimedBlobs settles the monthly quota as the sweep does: a pending row's recorded reservation is released with it, a ready row's bytes stay counted", async ({ seed }) => {
  const world = await seedWorld(seed);
  const r2 = memoryR2(world.r2);
  await setUploadUsage(world.serverId, 0);
  // A ready row this "import" stored: its bytes were committed.
  const ready = page("stored and made ready");
  const claims: BlobClaim[] = [];
  assert.equal((await storeBlob(r2, world.serverId, sha(ready), ready, { onClaim: (claim) => claims.push(claim) })).kind, "stored");
  assert.equal(claims.length, 1, "the row it inserted is reported");
  // A pending row whose store never finished, its reservation recorded on it as storeBlob records it.
  const pending = page("never finished");
  const pendingId = `b_${randomUUID()}`;
  const [row] = await reserveFileUpload(world.serverId, pending.length, (tx, reservation) => tx.insert(artifactBlobs).values({
    id: pendingId, serverId: world.serverId, sha256: sha(pending), sizeBytes: pending.length, state: "pending", r2Key: `test/${pendingId}`,
    quotaMonth: reservation.month, quotaReservedBytes: reservation.bytes,
  }).returning({ createdAt: sql<string>`${artifactBlobs.createdAt}::text` }));
  claims.push({ id: pendingId, createdAt: row!.createdAt });
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: ready.length, reservedBytes: pending.length });

  assert.equal(await deleteClaimedBlobs(r2, world.serverId, claims), 2);
  assert.equal((await blobsOf(world.serverId)).length, 0);
  assert.equal(world.r2.size, 0);
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: ready.length, reservedBytes: 0 }, "the reservation released once, the committed bytes not refunded");
  // Again: nothing left to delete, nothing released twice.
  assert.equal(await deleteClaimedBlobs(r2, world.serverId, claims), 0);
  assert.deepEqual(await uploadUsage(world.serverId), { usedBytes: ready.length, reservedBytes: 0 });
});

test("a file that doesn't hash to its sha256 fails the whole import: no Artifact, no version, and the bytes it stored are deleted at once", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const good = page("good");
  const had = page("the server had these before");
  const listed = page("what the manifest promised");
  const sent = Buffer.from(listed.toString("utf8").replace("promised", "tampered"));
  assert.equal(sent.length, listed.length);
  // Bytes the server already holds (an upload no version uses yet): not this import's, they stay.
  await storeBlob(memoryR2(world.r2), world.serverId, sha(had), had);
  legacy.put(world.server.id, {
    name: "tampered", title: "Tampered", description: null, entry: "a.html",
    files: [{ path: "a.html", bytes: good }, { path: "had.html", bytes: had }, { path: "b.html", bytes: sent, sha256: sha(listed), size: listed.length }],
  });
  const sink = traced(app);
  const res = await webImport(app, world.who.owner, { from: world.link("tampered"), conversationId: world.pub.id });
  assert.equal(res.status, 502);
  assert.deepEqual(res.body.details, { path: "b.html", reason: "sha256" });
  assert.deepEqual(importSpans(sink, ["via", "outcome", "status_code", "code", "files_bucket"]), [
    ["server.artifacts.import", "error", { via: "web", outcome: "IMPORT_MISMATCH", status_code: 502 }],
    ["server.artifacts.import.manifest", "ok", { outcome: "found", files_bucket: "2-5" }],
    ["server.artifacts.import.blobs", "error", { code: "IMPORT_MISMATCH" }],
  ]);
  sink.clear();
  assert.equal(legacy.blobRequests().length, 2, "a.html was stored before b.html failed");
  assert.equal((await itemsOf(world.serverId)).length, 0);
  const blobs = await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId));
  // a.html, stored by this import, is deleted at once (it would hold the server's upload cap for a day); b.html never is stored.
  assert.deepEqual(blobs.map((blob) => blob.sha256), [sha(had)], "only the bytes the server had before");
  assert.deepEqual([...world.r2.values()], [had], "a.html's object is deleted too");
  assert.equal(legacy.requests.filter((r) => r.path === "/internal/raft-import/imported").length, 0, "nothing to tell");

  // Bytes this import stored that someone else uploaded meanwhile (their row refreshed) are theirs too now: left for the sweep.
  const shared = page("uploaded by a publish meanwhile");
  legacy.put(world.server.id, {
    name: "raced", title: "Raced", description: null, entry: "a.html",
    files: [
      { path: "a.html", bytes: shared },
      { path: "b.html", bytes: sent, sha256: sha(listed), size: listed.length, before: async () => { await storeBlob(memoryR2(world.r2), world.serverId, sha(shared), shared); } },
    ],
  });
  assert.equal((await webImport(app, world.who.owner, { from: world.link("raced"), conversationId: world.pub.id })).status, 502);
  const after = await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId));
  assert.deepEqual(after.map((blob) => blob.sha256).sort(), [sha(had), sha(shared)].sort());

  // More bytes than the manifest said: a mismatch too, read no further.
  legacy.put(world.server.id, { name: "longer", title: "Longer", description: null, entry: "a.html", files: [{ path: "a.html", bytes: good, size: good.length - 1, sha256: sha(good.subarray(0, good.length - 1)) }] });
  const longer = await webImport(app, world.who.owner, { from: world.link("longer"), conversationId: world.pub.id });
  assert.deepEqual(longer.body.details, { path: "a.html", reason: "size" });
  assert.equal((await itemsOf(world.serverId)).length, 0);
});

test("the whole import has a deadline, not only each request: past it, IMPORT_UNAVAILABLE timeout, and the bytes it stored are deleted", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  // Each request alone would wait far longer than the deadline.
  __setLegacyWorkerTimeoutsForTests({ request: 60_000, blob: 60_000 });
  __setImportDeadlineForTests(400);
  legacy.put(world.server.id, {
    name: "slow", title: "Slow", description: null, entry: "a.html",
    files: [{ path: "a.html", bytes: page("a") }, { path: "b.html", bytes: page("b"), hang: true }],
  });
  const started = Date.now();
  const res = await agentImport(app, world, { from: world.link("slow"), target: `#${world.pub.name}` });
  assert.ok(Date.now() - started < 10_000, "answered at the deadline, not at a request's timeout");
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "IMPORT_UNAVAILABLE");
  assert.deepEqual(res.body.details, { reason: "timeout" });
  assert.equal(legacy.blobRequests().length, 2);
  assert.equal((await itemsOf(world.serverId)).length, 0);
  assert.equal((await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId))).length, 0, "a.html is deleted");
  assert.equal(world.r2.size, 0);
  assert.equal(legacy.requests.filter((r) => r.path === "/internal/raft-import/imported").length, 0);

  // Witness: within the deadline it is imported.
  __setImportDeadlineForTests(undefined);
  legacy.put(world.server.id, { name: "quick", title: "Quick", description: null, entry: "a.html", files: [{ path: "a.html", bytes: page("a") }] });
  assert.equal((await webImport(app, world.who.owner, { from: world.link("quick") })).status, 201);
});

// ---- imports at once ----------------------------------------------------------------

test("at most two imports run at once in a server, people's and agents' together: a third is 429 RATE_LIMITED (the rate limits' body, Retry-After, the span's limiter) before anything is asked of the standalone app; a slot comes back when an import finishes, fails or times out", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  /** An import whose one file waits until `open()`: its slot is held meanwhile. */
  const gate = () => {
    let open!: () => void;
    let reached!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    return { open, waiting, before: async () => { reached(); await opened; } };
  };
  const put = (name: string, file: Partial<LegacyFile> = {}) =>
    legacy.put(world.server.id, { name, title: name, description: null, entry: "index.html", files: [{ path: "index.html", bytes: page(name), ...file }] });
  const asked = (name: string) => legacy.requests.filter((r) => r.query.name === name).length;
  const [one, two] = [gate(), gate()];
  put("one", { before: one.before });
  put("two", { before: two.before });
  put("three");

  // A person's import and an agent's, both running.
  const first = webImport(app, world.who.owner, { from: world.link("one") });
  const second = agentImport(app, world, { from: world.link("two") });
  await Promise.all([one.waiting, two.waiting]);
  const sink = traced(app);
  const busy = await webImport(app, world.who.member, { from: world.link("three") });
  assert.equal(busy.status, 429, JSON.stringify(busy.body));
  const wait = ARTIFACT_IMPORT_BUSY_RETRY_AFTER_SECONDS;
  const refused = refusalBody({
    code: "RATE_LIMITED",
    error: `This server already has ${ARTIFACT_IMPORTS_AT_ONCE} imports running, the most at once, so nothing was imported: try the same import again in ${wait} seconds.`,
    details: { operation: "artifactImport", limit: ARTIFACT_IMPORTS_AT_ONCE, windowSeconds: wait, retryAfterSeconds: wait },
    retryAfterSeconds: wait,
  });
  assert.deepEqual(busy.body, refused);
  assert.ok(parseAgentApiRateLimitedBody(busy.body), "the body rate-limited clients parse");
  assert.equal(busy.retryAfter, String(wait));
  const agentBusy = await agentImport(app, world, { from: world.link("three") });
  assert.equal(agentBusy.status, 429);
  assert.deepEqual(agentBusy.body, refused);
  assert.equal(agentBusy.retryAfter, String(wait));
  assert.equal(asked("three"), 0, "the standalone app was never asked");
  // Another server's imports are its own.
  legacy.put(world.peer.id, { name: "theirs", title: "Theirs", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("t") }] });
  assert.equal((await webImport(app, world.who.peerOwner, { from: `https://raft-artifacts.com/p/${world.peer.slug}/theirs` })).status, 201);

  // Finished: its slot comes back.
  one.open();
  assert.equal((await first).status, 201);
  // (Read once later requests have ended.) Each refusal's request span names the limiter, as core's limiters do.
  const limited = sink.getAllSpans().filter((span) => span.name === "server.http.request" && span.attrs?.rate_limiter === ARTIFACT_IMPORT_RATE_LIMITER);
  assert.equal(limited.length, 2);
  assert.equal((await webImport(app, world.who.member, { from: world.link("three") })).status, 201);

  // Failed (its bytes aren't what the manifest lists): its slot comes back too.
  put("bad", { sha256: sha("something else") });
  put("four");
  assert.equal((await webImport(app, world.who.owner, { from: world.link("bad") })).status, 502);
  assert.equal((await webImport(app, world.who.owner, { from: world.link("four") })).status, 201, "two holds one slot, the failed import gave its back");

  // Timed out: its slot comes back.
  __setLegacyWorkerTimeoutsForTests({ request: 60_000, blob: 60_000 });
  __setImportDeadlineForTests(300);
  put("slow", { hang: true });
  assert.equal((await webImport(app, world.who.owner, { from: world.link("slow") })).body.details?.reason, "timeout");
  __setImportDeadlineForTests(undefined);
  put("five");
  assert.equal((await webImport(app, world.who.owner, { from: world.link("five") })).status, 201);

  two.open();
  assert.equal((await second).status, 201);
});

// ---- success, repeats, names ---------------------------------------------------------

test("success (agent): the Artifact, version 1 with its note, the files (reusing bytes the server has), the audit row, and the standalone app told", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const index = page("Rollout plan");
  const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  // The server already holds the logo's bytes (published before): not fetched again.
  await storeBlob(memoryR2(world.r2), world.serverId, sha(logo), logo);
  const old = legacy.put(world.server.id, {
    name: "rollout-plan", title: "Rollout plan", description: "the plan", entry: "index.html", version: 7,
    files: [{ path: "index.html", bytes: index }, { path: "assets/logo.png", bytes: logo }],
  });
  const sink = traced(app);
  const res = await agentImport(app, world, { from: `https://www.raft-artifacts.com/p/${world.server.slug}/rollout-plan/v/2`, target: `#${world.pub.name}` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // The import and its steps, timed: counts and sizes in buckets, never a name, link or hash.
  assert.deepEqual(importSpans(sink, ["via", "outcome", "status_code", "files_bucket", "bytes_bucket", "created"]), [
    ["server.artifacts.import", "ok", { via: "agent", outcome: "created", status_code: 201 }],
    ["server.artifacts.import.manifest", "ok", { outcome: "found", files_bucket: "2-5", bytes_bucket: "<10KiB" }],
    ["server.artifacts.import.blobs", "ok", { files_bucket: "1", bytes_bucket: "<10KiB" }],
    ["server.artifacts.import.commit", "ok", { created: true }],
  ]);
  for (const span of sink.getAllSpans().filter((s) => s.name.startsWith("server.artifacts.import"))) {
    assert.equal(typeof span.attrs?.duration_ms, "number");
    assert.ok(!/rollout|raft-artifacts|[0-9a-f]{64}/.test(JSON.stringify(span.attrs)), "no name, link or hash");
  }
  const from = world.link("rollout-plan");
  assert.equal(res.body.created, true);
  assert.equal(res.body.from, from);
  const a = res.body.artifact;
  assert.equal(a.name, "rollout-plan");
  assert.equal(a.title, "Rollout plan");
  assert.equal(a.description, "the plan");
  assert.equal(a.kind, "html");
  assert.equal(a.currentVersion, 1);
  assert.equal(a.url, `${getAppUrl()}/artifacts/${artifactLinkId(asArtifactId(a.id))}`);
  assert.deepEqual(a.home, { kind: "conversation", conversation: { id: world.pub.id, type: "channel", target: `#${world.pub.name}` } });

  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, a.id));
  assert.equal(item!.createdByType, "agent");
  assert.equal(item!.createdById, world.agentA.id);
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, a.id));
  assert.equal(version!.number, 1);
  assert.equal(version!.entry, "index.html");
  assert.equal(version!.note, `Imported from ${from}`);
  assert.equal(version!.position, 1);
  assert.equal(item!.currentVersionId, version!.id);
  const files = await getDb().select().from(artifactVersionFiles).where(eq(artifactVersionFiles.versionId, version!.id));
  assert.deepEqual(files.map((f) => [f.path, f.sha256, f.sizeBytes]).sort(), [["assets/logo.png", sha(logo), logo.length], ["index.html", sha(index), index.length]]);
  const objects = [...world.r2.entries()].filter(([key]) => key.startsWith(`servers/${world.serverId}/blobs/${sha(index)}/`));
  assert.deepEqual(objects.map(([, bytes]) => bytes), [index]);
  const audit = await getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, a.id));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, "import");
  assert.deepEqual(audit[0]!.after, { legacyArtifactId: old.artifactId, from, server: world.server.slug, name: "rollout-plan", version: 7, legacyCreator: null });

  // The requests: the manifest for (server id, name), only the missing file, then `imported`; all with the token.
  assert.deepEqual(legacy.requests.map((r) => [r.method, r.path]), [
    ["GET", "/internal/raft-import/manifest"],
    ["GET", "/internal/raft-import/blob"],
    ["POST", "/internal/raft-import/imported"],
  ]);
  assert.deepEqual(legacy.requests[0]!.query, { server: world.server.id, name: "rollout-plan" });
  assert.equal(legacy.requests[1]!.query.sha256, sha(index));
  assert.deepEqual(legacy.requests[2]!.body, { server: world.server.id, name: "rollout-plan", newUrl: a.url, importedBy: world.agentA.name, public: false });
  assert.ok(legacy.requests.every((r) => r.authorization === `Bearer ${LEGACY_TOKEN}`));

  // A repeat answers the same Artifact (the standalone app now names it): nothing new.
  const again = await agentImport(app, world, { from, target: `#${world.pub.name}` });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.artifact.id, a.id);
  assert.equal((await itemsOf(world.serverId)).length, 1);
});

test("success (web): a person imports, the answer is the card", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "", description: null, entry: "notes.md", files: [{ path: "notes.md", bytes: Buffer.from("# notes") }] });
  const res = await webImport(app, world.who.member, { from: world.link("notes"), conversationId: world.pub.id });
  assert.equal(res.status, 201);
  assert.equal(res.body.created, true);
  assert.equal(res.body.card.title, "notes", "an empty title takes the name");
  assert.equal(res.body.card.kind, "markdown");
  assert.equal(res.body.card.version, 1);
  assert.equal(res.body.card.author.id, world.member.id);
  assert.deepEqual(res.body.card.home, { kind: "conversation", conversation: { id: world.pub.id, name: world.pub.name, type: "channel" } });
  assert.equal((await webImport(app, world.who.member, { conversationId: world.pub.id })).body.code, "INVALID_REQUEST");
});

test("idempotency: the audit finds an earlier import when the standalone app wasn't told; a deleted one is imported again; one the caller can't see is not revealed", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.state.failImported = true;
  const old = legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const first = await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: world.pub.id });
  assert.equal(first.status, 201, "the import stands though the standalone app refused the notice");
  assert.equal(old.importedTo, null);
  const blobFetches = legacy.blobRequests().length;

  const repeat = await webImport(app, world.who.member, { from: world.link("notes"), conversationId: world.pub.id });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.created, false);
  assert.equal(repeat.body.card.id, first.body.card.id);
  assert.equal(legacy.blobRequests().length, blobFetches, "no file fetched again");
  // The repeat tells the standalone app again (it doesn't name it yet).
  legacy.state.failImported = false;
  await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: world.priv.id });
  assert.equal(old.importedTo, `${getAppUrl()}/artifacts/${artifactLinkId(first.body.card.id)}`);

  // Moved out of the member's sight: refused without naming it.
  await getDb().update(artifactItems).set({ homeChannelId: world.priv.id }).where(eq(artifactItems.id, first.body.card.id));
  const hidden = await webImport(app, world.who.member, { from: world.link("notes"), conversationId: world.pub.id });
  assert.equal(hidden.status, 409);
  assert.deepEqual(hidden.body, refusalBody({
    code: "ALREADY_IMPORTED",
    error: "That artifact was already imported, and the result is somewhere you can't see: ask whoever imported it, or a member of where it lives, to share it with you.",
    details: { server: world.server.slug, name: "notes" },
  }));

  // Deleted: imported again, as a new Artifact.
  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, first.body.card.id));
  const fresh = await webImport(app, world.who.member, { from: world.link("notes"), conversationId: world.pub.id });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.body.card.id, first.body.card.id);
  assert.equal(old.importedTo, `${getAppUrl()}/artifacts/${artifactLinkId(fresh.body.card.id)}`);
});

test("a name taken in the home is reported with the Artifact that has it, before any file is fetched", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const id = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({
    id, serverId: world.serverId, urlKey: id, name: "notes", title: "Other notes", homeKind: "conversation", homeChannelId: world.pub.id, createdByType: "user", createdById: world.owner.id,
  });
  const res = await agentImport(app, world, { from: world.link("notes"), target: `#${world.pub.name}` });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NAME_TAKEN");
  assert.deepEqual(res.body.details, { name: "notes", existing: { id, url: `${getAppUrl()}/artifacts/${artifactLinkId(asArtifactId(id))}` } });
  assert.equal(legacy.blobRequests().length, 0);
  assert.equal((await itemsOf(world.serverId)).length, 1);
  // Another home is free.
  assert.equal((await webImport(app, world.who.owner, { from: world.link("notes"), conversationId: world.priv.id })).status, 201);
});

test("a slug no server has now (renamed since: Raft keeps no slug history) is taken as the caller's server, asked by its id", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("n") }] });
  const oldSlug = `renamed-${label()}`;
  const res = await webImport(app, world.who.owner, { from: world.link("notes", oldSlug), conversationId: world.pub.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.from, world.link("notes", oldSlug));
  assert.deepEqual(legacy.requests[0]!.query, { server: world.server.id, name: "notes" });
  // Not the caller's Artifact under that slug: the standalone app (asked by S's id) has none.
  const other = await webImport(app, world.who.owner, { from: world.link("not-ours", oldSlug), conversationId: world.pub.id });
  assert.equal(other.body.code, "LEGACY_NOT_FOUND");
});

test("idempotency from importedTo alone: the Artifact the standalone app names is returned when it stands and the caller sees it, imported again when deleted", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  // An Artifact of S with a version, which no audit row ties to the old one.
  const id = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({
    id, serverId: world.serverId, urlKey: id, name: "moved-notes", title: "Moved notes", homeKind: "conversation", homeChannelId: world.pub.id, createdByType: "user", createdById: world.owner.id,
  });
  const versionId = `v_${randomUUID()}`;
  const bytes = page("m");
  await storeBlob(memoryR2(world.r2), world.serverId, sha(bytes), bytes);
  const [blob] = await getDb().select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha(bytes))));
  await getDb().insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: bytes.length, publishDigest: "d", status: "published", publisherType: "user", publisherId: world.owner.id, position: 1,
  });
  await getDb().insert(artifactVersionFiles).values({ versionId, path: "index.html", sha256: sha(bytes), sizeBytes: bytes.length, blobId: blob!.id });
  await getDb().update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id));
  // The standalone app normalises the URL it stores (a trailing slash): parsed, not compared as a string.
  const old = legacy.put(world.server.id, { name: "notes", title: "Notes", description: null, entry: "index.html", importedTo: `${getAppUrl()}/artifacts/${id}/`, files: [{ path: "index.html", bytes: page("n") }] });

  const res = await agentImport(app, world, { from: world.link("notes"), target: `#${world.pub.name}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, false);
  assert.equal(res.body.artifact.id, id);
  assert.equal(legacy.blobRequests().length, 0);
  assert.equal(legacy.requests.filter((r) => r.path === "/internal/raft-import/imported").length, 0, "it already names that one");

  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, id));
  const fresh = await agentImport(app, world, { from: world.link("notes"), target: `#${world.pub.name}` });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.body.artifact.id, id);
  assert.equal(old.importedTo, fresh.body.artifact.url);
});

// ---- the author ------------------------------------------------------------------

const followersOf = async (itemId: string) => (await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, itemId)))
  .map((r) => `${r.actorType}:${r.actorId}`).sort();
const readersOf = async (itemId: string) => (await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, itemId)))
  .map((r) => `${r.actorType}:${r.actorId}@${r.position}`).sort();

test("author (per-server move): the creator agent of S is the author, follows it with nothing unread, and publishes another version of it by name afterwards (D9); the audit row is the ops actor's", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  legacy.put(world.server.id, {
    name: "my-report", title: "My report", description: null, entry: "index.html", files: [{ path: "index.html", bytes: page("report") }],
    creator: { type: "agent", raftId: world.agentA.id, name: "Old agent name" },
  });
  const outcome = await importLegacyArtifactAsOps({ serverId: world.serverId, serverSlug: world.server.slug, name: "my-report", operator: "alice" });
  assert.equal(outcome.kind, "imported");
  assert.equal(outcome.kind === "imported" && outcome.author, "creator");
  const [item] = await itemsOf(world.serverId);
  assert.deepEqual({ type: item!.createdByType, id: item!.createdById }, { type: "agent", id: world.agentA.id });
  assert.equal(item!.homeKind, "server");
  assert.deepEqual(await followersOf(item!.id), [`agent:${world.agentA.id}`]);
  assert.deepEqual(await readersOf(item!.id), [`agent:${world.agentA.id}@${item!.lastPosition}`]);
  const [audit] = await getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, item!.id));
  assert.deepEqual({ type: audit!.actorType, id: audit!.actorId }, ARTIFACT_OPS_IMPORT_ACTOR);
  assert.deepEqual((audit!.after as Record<string, unknown>).legacyCreator, { type: "agent", raftId: world.agentA.id, name: "Old agent name", author: true });

  // "Publish another version of my-report": its own Artifact, by the old name an import keeps (its title is "My report").
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${world.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ artifact: "my-report", base: 1, files: [{ path: "index.html", content: "<h1>report v2</h1>" }] }),
  });
  const body = await res.json() as any;
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.version.number, 2);
  assert.equal(body.artifact.id, item!.id);
});

test("author (per-server move): a creator Raft doesn't confirm (an agent of another server, a type that doesn't match its id, a deleted agent) is no author: the ops actor, followed by the server's owner instead (nothing unread)", async ({ seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const foreign = await createAgent(world.peer.id, `foreign-${label()}`, { runtime: "claude", model: "sonnet" });
  const gone = await createAgent(world.server.id, `gone-${label()}`, { runtime: "claude", model: "sonnet" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));
  const creators = {
    "by-foreign": { type: "agent" as const, raftId: foreign.id, name: "Foreign" },
    "by-mismatch": { type: "agent" as const, raftId: world.member.id, name: "A person, said to be an agent" },
    "by-gone": { type: "agent" as const, raftId: gone.id, name: "Gone" },
  };
  for (const [name, creator] of Object.entries(creators)) {
    legacy.put(world.server.id, { name, title: name, description: null, entry: "index.html", files: [{ path: "index.html", bytes: page(name) }], creator });
    const outcome = await importLegacyArtifactAsOps({ serverId: world.serverId, serverSlug: world.server.slug, name, operator: "alice" });
    assert.equal(outcome.kind === "imported" && outcome.author, "ops", name);
    const [item] = (await itemsOf(world.serverId)).filter((row) => row.name === name);
    assert.deepEqual({ type: item!.createdByType, id: item!.createdById }, ARTIFACT_OPS_IMPORT_ACTOR, name);
    assert.deepEqual(await followersOf(item!.id), [`user:${world.owner.id}`], name);
    assert.deepEqual(await readersOf(item!.id), [`user:${world.owner.id}@1`], name);
    const [audit] = await getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, item!.id));
    assert.deepEqual((audit!.after as Record<string, unknown>).legacyCreator, { ...creator, author: false }, name);
  }
});

test("author (on demand): the original creator Raft confirms is the author, not the importer; both follow it with nothing unread; one it doesn't confirm leaves the importer the author; a creator not in the target conversation is the author but doesn't follow it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const legacy = fakeLegacyApp();
  const put = (name: string, creator: LegacyArtifact["creator"]) =>
    legacy.put(world.server.id, { name, title: name, description: null, entry: "index.html", files: [{ path: "index.html", bytes: page(name) }], creator });

  // A member imports what agent A published there: agent A is the author.
  put("agent-made", { type: "agent", raftId: world.agentA.id, name: "Agent A" });
  const res = await webImport(app, world.who.member, { from: world.link("agent-made"), conversationId: world.pub.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.card.author.id, world.agentA.id);
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, res.body.card.id));
  assert.deepEqual({ type: item!.createdByType, id: item!.createdById }, { type: "agent", id: world.agentA.id });
  assert.deepEqual(await followersOf(item!.id), [`agent:${world.agentA.id}`, `user:${world.member.id}`].sort());
  assert.deepEqual(await readersOf(item!.id), [`agent:${world.agentA.id}@1`, `user:${world.member.id}@1`].sort());
  const [audit] = await getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, item!.id));
  assert.deepEqual({ type: audit!.actorType, id: audit!.actorId }, { type: "user", id: world.member.id }, "the importer did it");
  assert.deepEqual((audit!.after as Record<string, unknown>).legacyCreator, { type: "agent", raftId: world.agentA.id, name: "Agent A", author: true });

  // An agent imports what the owner published there: the owner is the author.
  put("owner-made", { type: "user", raftId: world.owner.id, name: "Owner" });
  const byAgent = await agentImport(app, world, { from: world.link("owner-made") });
  assert.equal(byAgent.status, 201, JSON.stringify(byAgent.body));
  const [ownerMade] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, byAgent.body.artifact.id));
  assert.deepEqual({ type: ownerMade!.createdByType, id: ownerMade!.createdById }, { type: "user", id: world.owner.id });
  assert.deepEqual(await followersOf(ownerMade!.id), [`agent:${world.agentA.id}`, `user:${world.owner.id}`].sort());

  // Not confirmed (another server's person, a type that doesn't match, no creator): the importer is the author.
  for (const [name, creator] of [
    ["peer-made", { type: "user" as const, raftId: world.peerOwner.id, name: "Peer owner" }],
    ["mismatch-made", { type: "agent" as const, raftId: world.owner.id, name: "Owner, said to be an agent" }],
    ["nobody-made", null],
  ] as const) {
    put(name, creator);
    const imported = await webImport(app, world.who.member, { from: world.link(name) });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, imported.body.card.id));
    assert.deepEqual({ type: row!.createdByType, id: row!.createdById }, { type: "user", id: world.member.id }, name);
    assert.deepEqual(await followersOf(row!.id), [`user:${world.member.id}`], name);
  }

  // Into #priv (the owner only): agent A is the author, but it doesn't see #priv, so it follows nothing there.
  put("private-made", { type: "agent", raftId: world.agentA.id, name: "Agent A" });
  const priv = await webImport(app, world.who.owner, { from: world.link("private-made"), conversationId: world.priv.id });
  assert.equal(priv.status, 201, JSON.stringify(priv.body));
  const [privRow] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, priv.body.card.id));
  assert.deepEqual({ type: privRow!.createdByType, id: privRow!.createdById }, { type: "agent", id: world.agentA.id });
  assert.deepEqual(await followersOf(privRow!.id), [`user:${world.owner.id}`]);
  assert.deepEqual(await readersOf(privRow!.id), [`user:${world.owner.id}@1`]);
});
