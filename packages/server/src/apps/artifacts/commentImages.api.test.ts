// Images in comments (#146 phase 1, commentImages.ts) over HTTP, on both
// surfaces: uploading one (web `POST /api/artifacts/:id/comment-images`,
// agent artifactCommentImageUpload), a comment, a review draft or an agent's
// review taking it, reading it (core's object file route, the agent's
// artifactCommentImage), and letting it go with what it hangs on. Proves
// Tenny's bounds: a draft's images are read by their uploader alone; a
// draft's images move to the posted comment (same Artifact, same uploader);
// what is kept is what the Server found (type, size, pixels, metadata
// removed), never the client's word; an agent claims only its own uploads
// and reads images as it reads comments; one image that isn't the writer's
// unused upload to this Artifact refuses the whole comment or review.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import {
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  artifactWebPaths,
  asArtifactId,
  asObjectFileId,
  objectWebPaths,
  type AgentMessage,
  type ArtifactId,
  type ObjectInboxItem,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectFiles, serverFileUploadUsageMonths } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { __setAgentApiWriteBudgetsForTests } from "../../services/agentApiWriteLimits";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { ASSISTANT_ROUTE_DECISIONS } from "../../services/assistantRouteAllowlist";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { billingUsageMonth } from "../../services/fileUploadQuotaService";
import { recordMachineComputerVersion, registerMachine } from "../../services/machineService";
import { OBJECT_FILE_MAX_BYTES, OBJECT_FILE_MAX_PIXELS, OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER, putObjectFile } from "../../services/objectFiles";
import { placeAgentOnMachine } from "../../test/agentMachineFixture";
import { createApiTest } from "../../test/integration/apiTest";
import { accessTokenForTest } from "../../test/integration/credentials";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { capturePaywallHits } from "../../test/integration/paywallHits";
import type { createSeed } from "../../test/integration/seed";
import { installMemoryObjectFilesStorage } from "../../test/memoryObjectFilesStorage";
import { pngChunk, pngChunksOf, testJpeg, testPng } from "../../test/objectFileTestImages";
import { __setArtifactR2StoreForTests } from "./blobStore";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactCommentDrafts, artifactComments, artifactItems } from "./schema";
import { purgeExpiredArtifactDrafts } from "./webReviews";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { useStripeBillingConfigured } from "../../test/stripeBillingEnv";

const test = createApiTest();
useStripeBillingConfigured();
/** The same world, with a person's image upload limit set to two. */
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.commentImages": 2 } });

let storage: ReturnType<typeof installMemoryObjectFilesStorage>;
beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-comment-image-tests-hmac-secret-0123456789");
  storage = installMemoryObjectFilesStorage();
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
  __setAgentApiWriteBudgetsForTests(null);
  storage.restore();
});
const label = () => randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;

type Reply = { status: number; body: any };
type Who = { token: string; serverId: string };
type App = { baseUrl: string };

/**
 * A server with the flag on: the owner and reader (people) and agents A and
 * B in #priv (private); outsider a member outside it; agentOut an agent
 * outside it. Site and Other: Artifacts in #priv pushed by A.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: App) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const make = (prefix: string) => createAgent(server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentA = await make("ci-a");
  const agentB = await make("ci-b");
  const agentOut = await make("ci-out");
  const priv = await createChannel(server.id, `ci-priv-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(priv.id, human.id);
  for (const agent of [agentA, agentB]) await addAgent(priv.id, agent.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  __setArtifactR2StoreForTests({ read: async () => null, presign: async () => null, put: async () => {}, delete: async () => {} });
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `ci-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const keys = { a: await key(agentA.id), b: await key(agentB.id), out: await key(agentOut.id) };
  const push = async (title: string) => {
    const published = await agentCall(app, "POST", "/artifacts/push", keys.a, { target: `#${priv.name}`, title, files: [{ path: "index.html", content: `<h1>${title}</h1>` }] });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    return asArtifactId(published.body.artifact.id as string);
  };
  const as = async (userId: string): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return {
    server, owner, reader, outsider, agentA, agentB, agentOut, priv, keys,
    site: await push("Site"),
    other: await push("Other"),
    who: { owner: await as(owner.id), reader: await as(reader.id), outsider: await as(outsider.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function parse(res: Response): Promise<Reply> {
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : text };
}

async function agentCall(app: App, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  return parse(await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function web(app: App, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  return parse(await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

/** A person's upload: the raw bytes, with the type the browser would send. */
const webUpload = async (app: App, who: Who, artifact: ArtifactId, bytes: Buffer, contentType = "image/png"): Promise<Reply> => parse(await fetch(`${app.baseUrl}${artifactWebPaths.commentImages(artifact)}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, "Content-Type": contentType },
  body: new Uint8Array(bytes),
}));

/** An agent's upload: the raw bytes as application/octet-stream. */
const agentUpload = async (app: App, apiKey: string, artifact: ArtifactId, bytes: Buffer): Promise<Reply> => parse(await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${artifact}/comment-images`, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/octet-stream" },
  body: new Uint8Array(bytes),
}));

/**
 * A POST that declares `declared` bytes and sends only a few: answered only
 * if the Server refuses it without waiting for the rest (its size decided
 * from Content-Length, before a byte is read).
 */
function declaredOnly(app: App, path: string, headers: Record<string, string>, declared: number): Promise<Reply> {
  const url = new URL(app.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: "POST", path, headers: { ...headers, "Content-Length": String(declared) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : null });
      });
      res.on("error", reject);
    });
    // The refusal closes the connection; what is still being written may be cut off, the answer came first.
    req.on("error", reject);
    req.write(testPng("the start"));
  });
}

/** A person reads an image the way the web does: core's object file route. */
const webRead = async (app: App, who: Who, artifact: ArtifactId, fileId: string) => {
  const res = await fetch(`${app.baseUrl}${objectWebPaths.file(ARTIFACT_OBJECT_KIND, artifact, asObjectFileId(fileId))}`, { headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } });
  return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()) };
};

const agentRead = async (app: App, apiKey: string, artifact: ArtifactId, fileId: string) => {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${artifact}/comment-images/${fileId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), bytes, code: res.headers.get("content-type")?.startsWith("application/json") ? (JSON.parse(bytes.toString()) as { code: string }).code : null };
};

const text = (value: string) => ({ type: "text" as const, text: value });
const comment = (images: string[] | undefined, body: unknown[] = [text("see this")], extra: Record<string, unknown> = {}) =>
  ({ body, version: 1, target: { scope: "artifact" }, replyTo: null, ...(images === undefined ? {} : { images }), ...extra });
const post = (app: App, world: World, who: Who, value: unknown, artifact = world.site) => web(app, "POST", artifactWebPaths.comments(artifact), who, value);
const commentsOf = (itemId: string) => getDb().select().from(artifactComments).where(eq(artifactComments.itemId, itemId));
const fileRow = async (id: string) => (await getDb().select().from(objectFiles).where(eq(objectFiles.id, id)))[0];
/** Neither claimed nor let go: still the uploader's unused upload. */
async function stillUnclaimed(id: string) {
  const row = (await fileRow(id))!;
  assert.deepEqual([row.state, row.parent], ["unclaimed", null], `${id} is still unclaimed`);
}

// ---- uploading -----------------------------------------------------------------

test("web upload: what the Server kept (the type from the bytes, the pixel size from the header, metadata gone), never the client's word; read by its uploader alone until a comment takes it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const photo = await testJpeg("photo", { width: 4, height: 2, orientation: 6, exif: { ImageDescription: "51.5N 0.1W" } });
  // The type it is sent as, and anything else the client claims, change nothing.
  const res = await fetch(`${app.baseUrl}${artifactWebPaths.commentImages(world.site)}?width=9999&height=1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${world.who.reader.token}`, "X-Server-Id": world.server.id, "Content-Type": "image/png", "X-Image-Width": "9999" },
    body: new Uint8Array(photo),
  });
  const uploaded = await parse(res);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const image = uploaded.body;
  assert.deepEqual(Object.keys(image).sort(), ["contentType", "fileId", "height", "sizeBytes", "width"]);
  assert.deepEqual([image.contentType, image.width, image.height], ["image/jpeg", 2, 4], "a JPEG, kept upright");
  const row = (await fileRow(image.fileId))!;
  assert.deepEqual([row.state, row.parent, row.uploadedByType, row.uploadedById, row.objectId, row.sizeBytes, row.width, row.height], ["unclaimed", null, "user", world.reader.id, world.site, image.sizeBytes, 2, 4]);

  const mine = await webRead(app, world.who.reader, world.site, image.fileId);
  assert.deepEqual([mine.status, mine.type, mine.bytes.length], [200, "image/jpeg", image.sizeBytes]);
  assert.equal((await sharp(mine.bytes).metadata()).exif, undefined, "served without its EXIF");
  assert.equal(mine.bytes.includes(Buffer.from("51.5N")), false);
  assert.equal((await webRead(app, world.who.owner, world.site, image.fileId)).status, 404, "nobody else reads an unused upload");

  // A PNG keeps only what drawing it needs.
  const png = await webUpload(app, world.who.reader, world.site, testPng("shot", { before: [pngChunk("tEXt", Buffer.from("Comment\0secret"))] }));
  assert.equal(png.status, 201);
  const keptPng = (await webRead(app, world.who.reader, world.site, png.body.fileId)).bytes;
  assert.deepEqual(pngChunksOf(keptPng).map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
});

test("web upload: refused before storing anything: outside the Artifact, too large (before reading), not an image, over the pixel cap, not raw bytes", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  // The contract's limit is core's: an image the route lets through, core keeps.
  assert.equal(ARTIFACT_COMMENT_IMAGE_MAX_BYTES, OBJECT_FILE_MAX_BYTES);
  const before = storage.objects.size;
  const notVisible = await webUpload(app, world.who.outsider, world.site, testPng("x"));
  assert.deepEqual([notVisible.status, notVisible.body.code], [404, "NOT_VISIBLE"], "one who can't see it");
  const tooLarge = await declaredOnly(app, artifactWebPaths.commentImages(world.site), { Authorization: `Bearer ${world.who.reader.token}`, "X-Server-Id": world.server.id, "Content-Type": "image/png" }, ARTIFACT_COMMENT_IMAGE_MAX_BYTES + 1);
  assert.deepEqual([tooLarge.status, tooLarge.body.code, tooLarge.body.details], [413, "IMAGE_REFUSED", { reason: "too_large", limit: ARTIFACT_COMMENT_IMAGE_MAX_BYTES }]);
  const svg = await webUpload(app, world.who.reader, world.site, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml");
  assert.deepEqual([svg.status, svg.body.code, svg.body.details.reason], [422, "IMAGE_REFUSED", "unsupported_type"]);
  // A small PNG whose header declares 50 megapixels: refused by its header (it is never decoded).
  const bomb = await webUpload(app, world.who.reader, world.site, testPng("bomb", { width: 10_000, height: 5000, header: true }));
  assert.deepEqual([bomb.status, bomb.body.code, bomb.body.details], [422, "IMAGE_REFUSED", { reason: "too_many_pixels", limit: OBJECT_FILE_MAX_PIXELS }]);
  const empty = await webUpload(app, world.who.reader, world.site, Buffer.alloc(0));
  assert.deepEqual([empty.status, empty.body.details?.reason], [422, "empty"]);
  const json = await web(app, "POST", artifactWebPaths.commentImages(world.site), world.who.reader, { image: "base64" });
  assert.deepEqual([json.status, json.body.code], [400, "INVALID_REQUEST"]);
  assert.equal(storage.objects.size, before, "nothing stored");
  assert.equal((await getDb().select().from(objectFiles).where(eq(objectFiles.objectId, world.site))).length, 0);
});

test("upload: counted against the uploader's own server's monthly file upload quota (the attachments' one; here the Artifact's, theirs too); none left, refused as attachments are", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const month = billingUsageMonth();
  const usage = async () => (await getDb().select().from(serverFileUploadUsageMonths)
    .where(and(eq(serverFileUploadUsageMonths.serverId, world.server.id), eq(serverFileUploadUsageMonths.month, month))))[0]?.usedBytes ?? 0;
  const before = await usage();
  const kept = await webUpload(app, world.who.reader, world.site, testPng("counted"));
  assert.equal(kept.status, 201);
  assert.equal(await usage(), before + kept.body.sizeBytes);
  const byAgent = await agentUpload(app, world.keys.a, world.site, testPng("agent's"));
  assert.equal(await usage(), before + kept.body.sizeBytes + byAgent.body.sizeBytes);

  await getDb().update(serverFileUploadUsageMonths).set({ usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 })
    .where(and(eq(serverFileUploadUsageMonths.serverId, world.server.id), eq(serverFileUploadUsageMonths.month, month)));
  const keys = storage.objects.size;
  const captured = capturePaywallHits(app);
  const person = await webUpload(app, world.who.reader, world.site, testPng("over"));
  assert.deepEqual([person.status, person.body.code], [403, "FILE_UPLOAD_QUOTA_EXCEEDED"]);
  assert.ok(person.body.details.billingUrl);
  await captured.expect(1, "the person's image");
  const agent = await agentUpload(app, world.keys.a, world.site, testPng("over"));
  assert.deepEqual([agent.status, agent.body.code], [403, "FILE_UPLOAD_QUOTA_EXCEEDED"]);
  assert.equal(storage.objects.size, keys, "nothing stored");
  // One paywall hit each: the person's (with their role) and the agent's (no person).
  await captured.expect(2, "the agent's image");
  const hit = { gate: "upload_monthly_quota", plan: "free", via: "artifact_comment_image", month_used_bytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES };
  // The bytes asked for are the image as kept (encoded again), so only their being there is checked.
  assert.deepEqual(captured.hits().map((h) => {
    const { requested_bytes: requested, ...rest } = h.properties;
    assert.ok(typeof requested === "number" && requested > 0, JSON.stringify(h.properties));
    return [{ ...rest, viewer_role: rest.viewer_role ?? null }, h.serverId];
  }), [
    [{ ...hit, actor: "person", viewer_role: "member" }, world.server.id],
    [{ ...hit, actor: "agent", viewer_role: null }, world.server.id],
  ]);
});

test("upload: over the quota on Free, an agent whose Computer can post an upgrade card is offered one in the Artifact's home conversation (none for one homed in the whole server)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const { machine } = await registerMachine(world.server.id, world.owner.id, `ci-computer-${label()}`);
  await placeAgentOnMachine(world.agentA.id, machine.id);
  await recordMachineComputerVersion(machine.id, "1.0.53");
  await getDb().insert(serverFileUploadUsageMonths).values({ serverId: world.server.id, month: billingUsageMonth(), usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 })
    .onConflictDoUpdate({ target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month], set: { usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 } });
  const hint = [
    "The image was not stored: this server is on the Free plan and has used this month's upload allowance. Pro would take it. Say in the conversation that the image wasn't stored and why, then offer an upgrade card unless that is clearly out of place here (put what the image is for in place of the <…>):",
    `raft action prepare --target "#${world.priv.name}" <<'RAFTACTION'`,
    '{"type":"plan:upgrade","gate":"upload_monthly_quota","reason":"<one sentence: what the image is for>"}',
    "RAFTACTION",
  ].join("\n");
  const over = await agentUpload(app, world.keys.a, world.site, testPng("over"));
  assert.deepEqual([over.status, over.body.code], [403, "FILE_UPLOAD_QUOTA_EXCEEDED"]);
  assert.equal(over.body.suggestedNextAction, hint);
  assert.equal(over.body.details.upgradeHint, hint);

  await getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, world.other));
  const serverWide = await agentUpload(app, world.keys.a, world.other, testPng("over"));
  assert.deepEqual([serverWide.status, serverWide.body.code], [403, "FILE_UPLOAD_QUOTA_EXCEEDED"]);
  assert.match(serverWide.body.suggestedNextAction, /^Say in the conversation that the file wasn't uploaded and why\. /);
  assert.equal(serverWide.body.details.upgradeHint, undefined);
});

/**
 * A second server joined to the world's by a joint channel; `peer` a person
 * of the second server only, in its projection; `artifact` homed in the
 * joint (the world's server's), pushed by agent A.
 */
async function seedJointPeer(seed: ReturnType<typeof createSeed>, app: App, world: World) {
  const peer = await seed.human();
  const peerServer = await seed.server({ owner: peer });
  const joint = await seedJointChannel({ name: `ci-joint-${label()}`, serverIds: [world.server.id, peerServer.id], createdByUserId: world.owner.id });
  const [host, peerSide] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(host.id, world.agentA.id);
  await addHuman(peerSide.id, peer.id);
  const pushed = await agentCall(app, "POST", "/artifacts/push", world.keys.a, { target: `#${host.name}`, title: "Joint", files: [{ path: "index.html", content: "<h1>joint</h1>" }] });
  assert.equal(pushed.status, 201, JSON.stringify(pushed.body));
  const who: Who = { token: await accessTokenForTest(peer.id), serverId: peerServer.id };
  return { peer, peerServer, artifact: asArtifactId(pushed.body.artifact.id as string), who };
}

// Task #184: a joint channel's member of another server used to fill the
// Artifact's server's images and spend its monthly upload quota.
test("upload: a joint channel's member of another server is billed to their own server (its monthly quota, its caps), never the Artifact's; a refusal names their server's billing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const joint = await seedJointPeer(seed, app, world);
  const month = billingUsageMonth();
  const used = async (serverId: string) => (await getDb().select().from(serverFileUploadUsageMonths)
    .where(and(eq(serverFileUploadUsageMonths.serverId, serverId), eq(serverFileUploadUsageMonths.month, month))))[0]?.usedBytes ?? 0;
  const [hostBefore, peerBefore] = [await used(world.server.id), await used(joint.peerServer.id)];

  const kept = await webUpload(app, joint.who, joint.artifact, testPng("from the peer"));
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  const row = (await fileRow(kept.body.fileId))!;
  assert.deepEqual([row.serverId, row.billedServerId, row.quota, row.quotaMonth], [world.server.id, joint.peerServer.id, "monthly", month], "kept with the Artifact, billed to the peer's server");
  assert.equal(await used(joint.peerServer.id), peerBefore + kept.body.sizeBytes);
  assert.equal(await used(world.server.id), hostBefore, "the Artifact's server pays nothing");

  // The peer's server has no room this month: refused with its billing, while the Artifact's server has plenty.
  await getDb().insert(serverFileUploadUsageMonths).values({ serverId: joint.peerServer.id, month, usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 })
    .onConflictDoUpdate({ target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month], set: { usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 } });
  const over = await webUpload(app, joint.who, joint.artifact, testPng("over"));
  assert.deepEqual([over.status, over.body.code], [403, "FILE_UPLOAD_QUOTA_EXCEEDED"]);
  assert.ok(String(over.body.details.billingUrl).includes(`/s/${encodeURIComponent(joint.peerServer.slug)}/settings/billing`), over.body.details.billingUrl);
  assert.equal(await used(world.server.id), hostBefore);
  // The Artifact's own server's people still upload, on their own server.
  assert.equal((await webUpload(app, world.who.reader, world.site, testPng("host"))).status, 201);
});

test("upload: one person's or agent's images unposted at once are capped on their server: 413 IMAGE_REFUSED uploader_quota_exceeded, saying posting or deleting drafts frees room", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  // Drafts already there, standing for earlier uploads (the reader's, then agent A's), just under the cap.
  const filler = (uploader: { type: "user" | "agent"; id: string }) => {
    const id = randomUUID();
    return {
      id, serverId: world.server.id, billedServerId: world.server.id, quota: "monthly" as const, objectKind: ARTIFACT_OBJECT_KIND, objectId: world.site, parent: null, state: "unclaimed" as const,
      uploadedByType: uploader.type, uploadedById: uploader.id, contentType: "image/png" as const, sizeBytes: OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER - 100, storageKey: `servers/${world.server.id}/files/${id}`,
    };
  };
  await getDb().insert(objectFiles).values([filler({ type: "user", id: world.reader.id }), filler({ type: "agent", id: world.agentA.id })]);
  const keys = storage.objects.size;
  const big = testPng("big", { padTo: 300 });
  const person = await webUpload(app, world.who.reader, world.site, big);
  assert.deepEqual([person.status, person.body.code, person.body.details.reason, person.body.details.scope, person.body.details.limit], [413, "IMAGE_REFUSED", "uploader_quota_exceeded", "drafts", OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER]);
  assert.match(person.body.error, /Posting or deleting drafts frees room/);
  const agent = await agentUpload(app, world.keys.a, world.site, big);
  assert.deepEqual([agent.status, agent.body.code, agent.body.details.reason, agent.body.details.scope], [413, "IMAGE_REFUSED", "uploader_quota_exceeded", "drafts"]);
  assert.equal(storage.objects.size, keys, "nothing stored");
  // Someone else on the same server has their own room.
  assert.equal((await webUpload(app, world.who.owner, world.site, big)).status, 201);
  assert.equal((await agentUpload(app, world.keys.b, world.site, big)).status, 201);
});

limitedTest("upload: 30 a minute per person (set to two here); an agent's are among its writes with its comments (set to three here)", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  // After the world's pushes: setting the budgets forgets the counts.
  __setAgentApiWriteBudgetsForTests({ artifactWrites: { perAgent: 3, perServer: 100 } });
  for (const at of [1, 2]) assert.equal((await webUpload(app, world.who.reader, world.site, testPng(`p${at}`))).status, 201);
  const person = await webUpload(app, world.who.reader, world.site, testPng("p3"));
  assert.deepEqual([person.status, person.body.code], [429, "RATE_LIMITED"]);
  // Another person, and an agent, have budgets of their own.
  assert.equal((await webUpload(app, world.who.owner, world.site, testPng("o1"))).status, 201);
  for (const at of [1, 2]) assert.equal((await agentUpload(app, world.keys.a, world.site, testPng(`a${at}`))).status, 201);
  // A comment is one of the same writes.
  assert.equal((await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.a, { body: "the third write", seen: 1_000_000 })).status, 201);
  const agent = await agentUpload(app, world.keys.a, world.site, testPng("a3"));
  assert.deepEqual([agent.status, agent.body.code, agent.body.details.operation, agent.body.details.limit], [429, "RATE_LIMITED", "artifactCommentImageUpload", 3]);
  assert.match(agent.body.error, /^This agent made too many artifact changes: the limit is 3 a minute\. Retry in \d+ seconds?\.$/);
  // Another agent's are its own.
  assert.equal((await agentUpload(app, world.keys.b, world.site, testPng("b1"))).status, 201);
});

// ---- comments ------------------------------------------------------------------

test("a person's comment takes their uploads in order, as the Server stored them; an image-only comment is one; neither text nor image is refused", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const first = (await webUpload(app, world.who.reader, world.site, testPng("first", { width: 3, height: 2 }))).body;
  const second = (await webUpload(app, world.who.reader, world.site, await testJpeg("second"))).body;
  const posted = await post(app, world, world.who.reader, comment([second.fileId, first.fileId]));
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual(posted.body.comment.images, [second, first], "in the order given, core's metadata");
  for (const image of [first, second]) {
    const row = (await fileRow(image.fileId))!;
    assert.deepEqual([row.state, row.parent], ["claimed", `comment:${posted.body.comment.id}`]);
    assert.equal((await webRead(app, world.who.owner, world.site, image.fileId)).status, 200, "every reader of the Artifact reads it now");
  }
  const [stored] = await commentsOf(world.site);
  assert.deepEqual(stored!.images, [second, first]);
  const page = await web(app, "GET", artifactWebPaths.comments(world.site), world.who.owner);
  assert.deepEqual(page.body.comments[0].images, [second, first]);

  const only = (await webUpload(app, world.who.reader, world.site, testPng("only"))).body;
  const imageOnly = await post(app, world, world.who.reader, comment([only.fileId], []));
  assert.equal(imageOnly.status, 201);
  assert.deepEqual([imageOnly.body.comment.body, imageOnly.body.comment.images], [[], [only]]);
  const nothing = await post(app, world, world.who.reader, comment([], [text("  ")]));
  assert.deepEqual([nothing.status, nothing.body.code], [400, "INVALID_REQUEST"]);
  const tooMany = await post(app, world, world.who.reader, comment([1, 2, 3, 4, 5].map(() => randomUUID())));
  assert.deepEqual([tooMany.status, tooMany.body.code], [400, "INVALID_REQUEST"], "more than four");
  // A comment without images keeps the shape it had.
  const plain = await post(app, world, world.who.reader, comment(undefined));
  assert.equal(plain.status, 201);
  assert.equal("images" in plain.body.comment, false);
});

test("one image that isn't the writer's unused upload to this Artifact refuses the whole comment: nothing written, nothing claimed", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const mine = (await webUpload(app, world.who.reader, world.site, testPng("mine"))).body;
  const elsewhere = (await webUpload(app, world.who.reader, world.other, testPng("elsewhere"))).body;
  const theirs = (await webUpload(app, world.who.owner, world.site, testPng("theirs"))).body;
  const agents = (await agentUpload(app, world.keys.a, world.site, testPng("agent's"))).body;
  const used = (await webUpload(app, world.who.reader, world.site, testPng("used"))).body;
  assert.equal((await post(app, world, world.who.reader, comment([used.fileId]))).status, 201);
  const before = (await commentsOf(world.site)).length;

  for (const [bad, why] of [
    [elsewhere.fileId, "another Artifact's"],
    [theirs.fileId, "another person's"],
    [agents.fileId, "an agent's"],
    [used.fileId, "already another comment's"],
    [randomUUID(), "no such upload"],
    ["not-a-uuid", "not an id"],
  ] as const) {
    const refused = await post(app, world, world.who.reader, comment([mine.fileId, bad]));
    assert.deepEqual([refused.status, refused.body.code, refused.body.details], [400, "IMAGE_NOT_FOUND", { fileId: bad }], why);
    assert.equal((await commentsOf(world.site)).length, before, `${why}: no comment written`);
    await stillUnclaimed(mine.fileId);
  }
  await stillUnclaimed(theirs.fileId);
  await stillUnclaimed(agents.fileId);
  await stillUnclaimed(elsewhere.fileId);
  // The same image twice: once only.
  const twice = await post(app, world, world.who.reader, comment([mine.fileId, mine.fileId]));
  assert.deepEqual([twice.status, twice.body.code], [400, "IMAGE_NOT_FOUND"]);
  await stillUnclaimed(mine.fileId);
  // And the good one is still the writer's to use.
  assert.equal((await post(app, world, world.who.reader, comment([mine.fileId]))).status, 201);
});

test("an edit changes the text only: the images stay, and a comment with images may lose its text", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const image = (await webUpload(app, world.who.reader, world.site, testPng("kept"))).body;
  const spare = (await webUpload(app, world.who.reader, world.site, testPng("spare"))).body;
  const posted = (await post(app, world, world.who.reader, comment([image.fileId]))).body.comment;
  const edited = await web(app, "PATCH", artifactWebPaths.comment(world.site, posted.id), world.who.reader, { body: [], images: [spare.fileId] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.comment.body, edited.body.comment.images], [[], [image]], "the images as they were; `images` in an edit is not read");
  await stillUnclaimed(spare.fileId);
  // Without images, an edit still needs text.
  const plain = (await post(app, world, world.who.reader, comment(undefined))).body.comment;
  const emptied = await web(app, "PATCH", artifactWebPaths.comment(world.site, plain.id), world.who.reader, { body: [] });
  assert.deepEqual([emptied.status, emptied.body.code], [400, "INVALID_REQUEST"]);
});

test("deleting a comment lets its images go in the same transaction, the bytes after; a placeholder keeps none", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const keyOf = async (id: string) => (await fileRow(id))!.storageKey;
  const alone = (await webUpload(app, world.who.reader, world.site, testPng("alone"))).body;
  const threaded = (await webUpload(app, world.who.reader, world.site, testPng("threaded"))).body;
  const [aloneKey, threadedKey] = [await keyOf(alone.fileId), await keyOf(threaded.fileId)];
  const a = (await post(app, world, world.who.reader, comment([alone.fileId]))).body.comment;
  const b = (await post(app, world, world.who.reader, comment([threaded.fileId]))).body.comment;
  assert.equal((await post(app, world, world.who.owner, comment(undefined, [text("a reply")], { replyTo: b.id }))).status, 201);

  assert.equal((await web(app, "DELETE", artifactWebPaths.comment(world.site, a.id), world.who.reader)).status, 204);
  assert.equal(await fileRow(alone.fileId), undefined, "its file went, row and bytes");
  assert.equal(storage.objects.has(aloneKey), false);

  // With a reply: a placeholder, with no images, and its files gone too.
  assert.equal((await web(app, "DELETE", artifactWebPaths.comment(world.site, b.id), world.who.reader)).status, 204);
  const placeholder = (await commentsOf(world.site)).find((row) => row.id === b.id)!;
  assert.ok(placeholder.deletedAt);
  assert.deepEqual(placeholder.images, []);
  assert.equal(await fileRow(threaded.fileId), undefined);
  assert.equal(storage.objects.has(threadedKey), false);
  const page = await web(app, "GET", artifactWebPaths.comments(world.site), world.who.owner);
  assert.equal("images" in page.body.comments.find((entry: { id: string }) => entry.id === b.id), false);
  assert.equal((await webRead(app, world.who.reader, world.site, threaded.fileId)).status, 404);
});

// ---- review drafts ---------------------------------------------------------------

test("a draft's images are its author's alone until the review posts them; submitting moves them to the comment, read by everyone who sees the Artifact", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const image = (await webUpload(app, world.who.reader, world.site, testPng("drafted"))).body;
  const made = await web(app, "POST", artifactWebPaths.reviewDrafts(world.site), world.who.reader, comment([image.fileId], []));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const draft = made.body.draft;
  assert.deepEqual(draft.images, [image]);
  const row = (await fileRow(image.fileId))!;
  assert.deepEqual([row.state, row.parent], ["claimed", `draft:${draft.id}`]);
  const [stored] = await getDb().select().from(artifactCommentDrafts).where(eq(artifactCommentDrafts.id, draft.id));
  assert.deepEqual(stored!.images, [image]);

  // Claimed by the draft, it is still read by its author alone: another full reader of the Artifact
  // (its owner) gets the 404 of no file at all, through the web and as an agent.
  assert.equal((await webRead(app, world.who.reader, world.site, image.fileId)).status, 200);
  assert.equal((await webRead(app, world.who.owner, world.site, image.fileId)).status, 404);
  const asAgent = await agentRead(app, world.keys.a, world.site, image.fileId);
  assert.deepEqual([asAgent.status, asAgent.code], [404, "IMAGE_NOT_FOUND"]);
  // The draft listed, its images with it; an edit keeps them (and may leave no text).
  const listed = await web(app, "GET", artifactWebPaths.reviewDrafts(world.site), world.who.reader);
  assert.deepEqual(listed.body.drafts[0].images, [image]);
  const edited = await web(app, "PATCH", artifactWebPaths.reviewDraft(world.site, draft.id), world.who.reader, { body: [text("now with words")] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.draft.images, [image]);
  // A draft's image can't go in another comment.
  const reused = await post(app, world, world.who.reader, comment([image.fileId]));
  assert.deepEqual([reused.status, reused.body.code], [400, "IMAGE_NOT_FOUND"]);

  const submitted = await web(app, "POST", artifactWebPaths.reviewSubmit(world.site), world.who.reader, { version: 1, summary: null, clientKey: randomUUID() });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const posted = submitted.body.comments[0];
  assert.deepEqual(posted.images, [image]);
  const moved = (await fileRow(image.fileId))!;
  assert.deepEqual([moved.state, moved.parent, moved.uploadedById, moved.objectId], ["claimed", `comment:${posted.id}`, world.reader.id, world.site], "the same file, the same uploader and Artifact");
  assert.equal((await webRead(app, world.who.owner, world.site, image.fileId)).status, 200, "now the Artifact's readers read it");
  assert.equal((await agentRead(app, world.keys.a, world.site, image.fileId)).status, 200);
  assert.equal((await getDb().select().from(artifactCommentDrafts).where(eq(artifactCommentDrafts.itemId, world.site))).length, 0);
});

test("a draft takes only the author's unused uploads to this Artifact (nothing saved otherwise); deleting it, discarding all and the expiry purge let its images go", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const upload = async (name: string) => (await webUpload(app, world.who.reader, world.site, testPng(name))).body;
  const draft = async (images: string[]) => web(app, "POST", artifactWebPaths.reviewDrafts(world.site), world.who.reader, comment(images));
  const theirs = (await webUpload(app, world.who.owner, world.site, testPng("theirs"))).body;
  const mine = await upload("mine");
  const refused = await draft([mine.fileId, theirs.fileId]);
  assert.deepEqual([refused.status, refused.body.code], [400, "IMAGE_NOT_FOUND"]);
  assert.equal((await getDb().select().from(artifactCommentDrafts).where(eq(artifactCommentDrafts.itemId, world.site))).length, 0, "no draft saved");
  await stillUnclaimed(mine.fileId);

  const gone = async (fileId: string) => {
    assert.equal(await fileRow(fileId), undefined, `${fileId} let go, its bytes deleted`);
  };
  // Deleting one draft.
  const one = (await draft([mine.fileId])).body.draft;
  assert.equal((await web(app, "DELETE", artifactWebPaths.reviewDraft(world.site, one.id), world.who.reader)).status, 204);
  await gone(mine.fileId);
  // Discarding them all.
  const [x, y] = [await upload("x"), await upload("y")];
  await draft([x.fileId]);
  await draft([y.fileId]);
  assert.equal((await web(app, "DELETE", artifactWebPaths.reviewDrafts(world.site), world.who.reader)).status, 204);
  await gone(x.fileId);
  await gone(y.fileId);
  // Expired and purged by the hourly maintenance.
  const z = await upload("z");
  await draft([z.fileId]);
  assert.equal(await purgeExpiredArtifactDrafts({ now: new Date(Date.now() + 31 * DAY) }), 1);
  await gone(z.fileId);
});

// ---- agents --------------------------------------------------------------------

test("an agent uploads, comments and reviews with its own uploads only; one that isn't refuses the whole comment or review", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const upload = async (apiKey: string, name: string) => {
    const reply = await agentUpload(app, apiKey, world.site, testPng(name, { width: 3, height: 2 }));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body;
  };
  const own = await upload(world.keys.a, "own");
  assert.deepEqual(Object.keys(own).sort(), ["contentType", "fileId", "height", "sizeBytes", "width"]);
  assert.deepEqual([own.contentType, own.width, own.height], ["image/png", 3, 2]);
  const bs = await upload(world.keys.b, "b's");
  const persons = (await webUpload(app, world.who.reader, world.site, testPng("person's"))).body;
  const agentComment = (body: Record<string, unknown>) => agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.a, { seen: 1_000_000, ...body });

  // Only its own: another agent's or a person's upload refuses the comment, nothing written.
  for (const [bad, why] of [[bs.fileId, "another agent's"], [persons.fileId, "a person's"], [randomUUID(), "no such upload"]] as const) {
    const refused = await agentComment({ body: "look", images: [own.fileId, bad] });
    assert.deepEqual([refused.status, refused.body.code, refused.body.details], [400, "IMAGE_NOT_FOUND", { fileId: bad }], why);
    assert.equal((await commentsOf(world.site)).length, 0);
    await stillUnclaimed(own.fileId);
  }
  await stillUnclaimed(bs.fileId);
  await stillUnclaimed(persons.fileId);
  // Neither text nor image: as an empty body always was.
  assert.deepEqual((await agentComment({ body: "  " })).body.code, "agent_api_contract_invalid");
  assert.equal((await agentComment({ images: [] })).status, 400);

  const posted = await agentComment({ images: [own.fileId] });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual([posted.body.comment.body, posted.body.comment.images], ["", [own]], "an image-only comment");
  assert.equal((await fileRow(own.fileId))!.parent, `comment:${posted.body.comment.id}`);

  // A review: every comment's images, or none of the review.
  const [r1, r2] = [await upload(world.keys.a, "r1"), await upload(world.keys.a, "r2")];
  const review = (comments: unknown[]) => agentCall(app, "POST", `/artifacts/${world.site}/reviews`, world.keys.a, { seen: 1_000_000, comments });
  const refused = await review([{ body: "one", images: [r1.fileId] }, { body: "two", path: "index.html", images: [persons.fileId] }]);
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [400, "IMAGE_NOT_FOUND", { fileId: persons.fileId, index: 1, path: "index.html" }]);
  assert.equal((await commentsOf(world.site)).length, 1, "nothing of the review written");
  await stillUnclaimed(r1.fileId);
  const reviewed = await review([{ body: "one", images: [r1.fileId] }, { images: [r2.fileId] }, { body: "three" }]);
  assert.equal(reviewed.status, 201, JSON.stringify(reviewed.body));
  assert.deepEqual(reviewed.body.comments.map((entry: { images?: unknown }) => entry.images), [[r1], [r2], undefined]);
  for (const [index, image] of [r1, r2].entries()) assert.equal((await fileRow(image.fileId))!.parent, `comment:${reviewed.body.comments[index].id}`);

  // The comments list carries them; another agent's read counts them in its excerpts.
  const listed = await agentCall(app, "GET", `/artifacts/${world.site}/comments?all=1`, world.keys.a);
  assert.deepEqual(listed.body.comments.map((entry: { images?: unknown }) => entry.images), [[own], [r1], [r2], undefined]);
  const read = await agentCall(app, "GET", `/artifacts/${world.site}`, world.keys.b);
  assert.deepEqual(read.body.unseen.comments.map((entry: { imageCount?: number }) => entry.imageCount), [1, 1, 1, undefined]);
});

test("an agent reads a comment's image as it reads the comments (artifactCommentImage); anyone else's draft, another Artifact's or none: one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const image = (await webUpload(app, world.who.reader, world.site, await testJpeg("photo", { exif: { ImageDescription: "51.5N" } }))).body;
  assert.equal((await post(app, world, world.who.reader, comment([image.fileId]))).status, 201);

  const read = await agentRead(app, world.keys.b, world.site, image.fileId);
  assert.deepEqual([read.status, read.type, read.bytes.length], [200, "image/jpeg", image.sizeBytes]);
  assert.equal((await sharp(read.bytes).metadata()).exif, undefined);
  // An agent that can't see the Artifact: its one 404, as for the comments.
  const outside = await agentRead(app, world.keys.out, world.site, image.fileId);
  assert.deepEqual([outside.status, outside.code], [404, "NOT_VISIBLE"]);
  // Another Artifact's file id, an unused upload of someone else's, no such file: IMAGE_NOT_FOUND.
  const unused = (await webUpload(app, world.who.reader, world.site, testPng("unused"))).body;
  for (const [artifact, fileId] of [[world.other, image.fileId], [world.site, unused.fileId], [world.site, randomUUID()], [world.site, "nope"]] as const) {
    const missing = await agentRead(app, world.keys.b, artifact, fileId);
    assert.deepEqual([missing.status, missing.code], [404, "IMAGE_NOT_FOUND"], `${artifact} ${fileId}`);
  }
  // Its own unused upload, the agent reads.
  const mine = (await agentUpload(app, world.keys.b, world.site, testPng("b's"))).body;
  assert.equal((await agentRead(app, world.keys.b, world.site, mine.fileId)).status, 200);
  // The Artifact's other files (a check shot, on a `version:` part) are never served here.
  const shot = await putObjectFile({ object: { kind: ARTIFACT_OBJECT_KIND, id: world.site }, parent: `version:${randomUUID()}`, bytes: testPng("shot"), uploadedBy: { type: "user", id: world.owner.id }, quota: "exempt" });
  const notComment = await agentRead(app, world.keys.b, world.site, shot.id);
  assert.deepEqual([notComment.status, notComment.code], [404, "IMAGE_NOT_FOUND"], "only a comment's or a draft's image");
  // No assistant reaches either route (Artifacts is no assistant's app).
  assert.deepEqual([ASSISTANT_ROUTE_DECISIONS.artifactCommentImage.allow, ASSISTANT_ROUTE_DECISIONS.artifactCommentImageUpload.allow], [false, false]);
});

test("an agent's upload: only one who takes part in the Artifact, raw bytes with a Content-Length within the limit", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const outside = await agentUpload(app, world.keys.out, world.site, testPng("x"));
  assert.deepEqual([outside.status, outside.body.code], [404, "NOT_VISIBLE"]);
  const tooLarge = await declaredOnly(app, `/internal/agent-api/artifacts/${world.site}/comment-images`, { Authorization: `Bearer ${world.keys.a}`, "Content-Type": "application/octet-stream" }, ARTIFACT_COMMENT_IMAGE_MAX_BYTES + 1);
  assert.deepEqual([tooLarge.status, tooLarge.body.code, tooLarge.body.details.limit], [413, "FILE_TOO_LARGE", ARTIFACT_COMMENT_IMAGE_MAX_BYTES]);
  const notImage = await agentUpload(app, world.keys.a, world.site, Buffer.from("%PDF-1.7"));
  assert.deepEqual([notImage.status, notImage.body.code, notImage.body.details.reason], [422, "IMAGE_REFUSED", "unsupported_type"]);
  const asJson = await agentCall(app, "POST", `/artifacts/${world.site}/comment-images`, world.keys.a, { bytes: "x" });
  assert.equal(asJson.status, 400);
  assert.equal((await getDb().select().from(objectFiles).where(inArray(objectFiles.objectId, [world.site, world.other]))).length, 0);
});

// ---- what agents and people are told (#146 phase 3) --------------------------------

test("a notice counts the comment's images in the summary every client reads: after its text, or alone", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const delivered: Array<{ agentId: string; content: string }> = [];
  const orchestrator = (app as unknown as { app: { get(key: string): unknown } }).app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => {
    delivered.push({ agentId, content: message.content });
    return { status: "delivered" };
  };
  const upload = async () => (await agentUpload(app, world.keys.b, world.site, testPng(label()))).body.fileId as string;
  const agentComment = (body: Record<string, unknown>) => agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.b, { seen: 1_000_000, ...body });
  // A pushed the Artifact, so it follows it: B's comments reach it.
  assert.equal((await agentComment({ images: [await upload(), await upload()] })).status, 201);
  assert.equal((await agentComment({ body: "looks off here", images: [await upload()] })).status, 201);
  const toA = delivered.filter((entry) => entry.agentId === world.agentA.id).map((entry) => entry.content);
  assert.equal(toA.length, 2, JSON.stringify(toA));
  assert.ok(toA[0]!.includes(`on "Site" (the whole artifact; you follow it because you pushed v1): (2 images). To answer`), toA[0]);
  assert.ok(toA[1]!.includes(`: "looks off here" (+1 image). `), toA[1]);
});

test("a person's Activity row counts the comment's images in its preview: an image-only comment's text is empty", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await web(app, "PUT", artifactWebPaths.subscription(world.site), world.who.reader)).status, 200);
  const previewOf = async () => {
    const inbox = await web(app, "GET", "/api/channels/inbox?filter=all&limit=100", world.who.reader);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    const row = (inbox.body.items as Array<{ kind: string }>).find((item): item is ObjectInboxItem => item.kind === "object");
    assert.ok(row, "the reader has the Artifact's row");
    return row.preview;
  };
  const upload = async () => (await agentUpload(app, world.keys.b, world.site, testPng(label()))).body.fileId as string;
  const agentComment = (body: Record<string, unknown>) => agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.b, { seen: 1_000_000, ...body });

  assert.equal((await agentComment({ images: [await upload()] })).status, 201);
  let preview = await previewOf();
  assert.deepEqual([preview?.text, preview?.images], ["", 1], "images alone: no text, one image");
  assert.equal((await agentComment({ body: "see  these", images: [await upload(), await upload()] })).status, 201);
  preview = await previewOf();
  assert.deepEqual([preview?.text, preview?.images], ["see these", 2]);
  assert.equal((await agentComment({ body: "words only" })).status, 201);
  preview = await previewOf();
  assert.equal(preview?.text, "words only");
  assert.ok(preview && !("images" in preview), "no images: no count, as from Servers before them");
});
