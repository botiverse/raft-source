// Artifact uploads count against the server's monthly file upload quota, the
// same one attachments count against (Free: 100 MB a month,
// fileUploadQuotaService). Every path that stores new bytes goes through
// blobs.ts storeBlob: inline files of a publish and the raw upload route here
// (import and save-attachment, on their branches, too). Bytes the server
// already has cost nothing; Pro is not limited; a failed store gives its
// reservation back; and attachments and Artifacts share one monthly total.
// The reservation is kept on the pending blob row (as an attachment's is on
// its upload session), so a store that dies before it finishes doesn't hold
// the bytes until the month ends: the blob sweep gives them back. A push
// that lists files the server lacks is checked by their declared sizes
// before it is answered `{ missing }`, so the CLI's push (it lists every
// file) is refused before any upload; the upload route checks again. A Free
// server's refusal of an agent's push offers the upgrade card in the
// Artifact's home conversation, as an attachment upload's does, where the
// agent's Computer runs a CLI that can post it (task #22 #proj-commercial).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { serverFileUploadUsageMonths, servers } from "../../db/schema";
import { agentQuotaUpgradeHint } from "../../platform/fileUploadQuota";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { billingUsageMonth, FileUploadQuotaExceededError } from "../../services/fileUploadQuotaService";
import { recordMachineComputerVersion, registerMachine } from "../../services/machineService";
import { __setStorageForTests, resetStorageForTests, type StorageBackend } from "../../services/storageService";
import { placeAgentOnMachine } from "../../test/agentMachineFixture";
import { createApiTest } from "../../test/integration/apiTest";
import { capturePaywallHits } from "../../test/integration/paywallHits";
import type { createSeed } from "../../test/integration/seed";
import { pruneUnreferencedArtifactBlobs, storeBlob, UNREFERENCED_BLOB_TTL_MS } from "./blobs";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { artifactBlobs, artifactItems } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { useStripeBillingConfigured } from "../../test/stripeBillingEnv";

const test = createApiTest();
useStripeBillingConfigured();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-upload-quota-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
  resetStorageForTests();
});

const LIMIT = FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES;
const label = () => randomUUID().slice(0, 8);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function memoryR2(objects: Map<string, Buffer>, opts: { failPut?: () => boolean } = {}): ArtifactR2Store {
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign(blob) {
      return `https://r2.example.test/${blob.r2Key}`;
    },
    async put(key, bytes) {
      if (opts.failPut?.()) throw new Error("r2 put failed");
      objects.set(key, bytes);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** Core's attachment storage, in memory, for an attachment upload through the agent API. */
function memoryAttachmentStorage(): StorageBackend {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, data) {
      objects.set(key, data);
    },
    async get(key) {
      return Readable.from([objects.get(key) ?? Buffer.alloc(0)]);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** A Free server (unless `plan`) with the flag on, agent A in #pub, its key and an in-memory R2. */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { plan?: "free" | "pro" | "founder" | "partner"; failPut?: () => boolean } = {}) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agentA = await createAgent(server.id, `quota-a-${label()}`, { runtime: "claude", model: "sonnet" });
  // After the agent: a Pro server without a subscription has one seat.
  if (opts.plan && opts.plan !== "free") await getDb().update(servers).set({ plan: opts.plan }).where(eq(servers.id, server.id));
  const pub = await createChannel(server.id, `pub-${label()}`);
  await addHuman(pub.id, owner.id);
  await addAgent(pub.id, agentA.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const key = (await mintAgentCredential({ agentId: agentA.id, scopes: ["read", "send"], name: `quota-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2, { failPut: opts.failPut }));
  return { owner, server, serverId: asServerId(server.id), agentA, pub, key, r2 };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

/** This month's usage row for the server, as if `usedBytes` were already uploaded this month. */
async function setUsage(world: World, usedBytes: number) {
  await getDb().insert(serverFileUploadUsageMonths)
    .values({ serverId: world.server.id, month: billingUsageMonth(), usedBytes, reservedBytes: 0 })
    .onConflictDoUpdate({ target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month], set: { usedBytes, reservedBytes: 0 } });
}

async function usage(world: World): Promise<{ usedBytes: number; reservedBytes: number }> {
  const [row] = await getDb().select().from(serverFileUploadUsageMonths).where(and(
    eq(serverFileUploadUsageMonths.serverId, world.server.id),
    eq(serverFileUploadUsageMonths.month, billingUsageMonth()),
  ));
  return { usedBytes: row?.usedBytes ?? 0, reservedBytes: row?.reservedBytes ?? 0 };
}

/** An R2 whose PUT never returns: a store stopped between reserving and committing, as a crash leaves it. */
function stalledR2(objects: Map<string, Buffer>): { store: ArtifactR2Store; putStarted: Promise<void> } {
  let started!: () => void;
  const putStarted = new Promise<void>((resolve) => { started = resolve; });
  return {
    store: { ...memoryR2(objects), put: () => { started(); return new Promise<void>(() => {}); } },
    putStarted,
  };
}

/** After the sweep's TTL: the time the sweep takes stale pending rows. */
const afterTtl = () => new Date(Date.now() + UNREFERENCED_BLOB_TTL_MS + 60_000);

const blobsOf = (world: World) => getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, world.serverId));
const itemsOf = (world: World) => getDb().select().from(artifactItems).where(eq(artifactItems.serverId, world.serverId));

type Reply = { status: number; body: any };

async function publish(app: { baseUrl: string }, world: World, body: Record<string, unknown>): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${world.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target: `#${world.pub.name}`, title: "Quota page", ...body }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function upload(app: { baseUrl: string }, world: World, bytes: Buffer): Promise<Reply> {
  const url = new URL(app.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method: "PUT",
      path: `/internal/agent-api/artifacts/uploads/${sha(bytes)}`,
      headers: { Authorization: `Bearer ${world.key}`, "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

async function uploadAttachment(app: { baseUrl: string }, world: World, bytes: Buffer): Promise<Reply> {
  const form = new FormData();
  form.append("channelId", world.pub.id);
  form.append("mimeType", "text/plain");
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "text/plain" }), "notes.txt");
  const res = await fetch(`${app.baseUrl}/internal/agent-api/upload`, { method: "POST", headers: { Authorization: `Bearer ${world.key}` }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The attachments' refusal, as `buildFileUploadQuotaExceededResponse` makes it, and the Artifacts' `code` and `details` beside it. */
function assertQuotaRefusal(res: Reply, world: World, requestedBytes: number) {
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(res.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.match(res.body.error, /^Monthly file upload quota exceeded\. Free includes 100 MB of file uploads per month/);
  assert.equal(res.body.requestedBytes, requestedBytes);
  assert.equal(res.body.quota.plan, "free");
  assert.equal(res.body.quota.enforced, true);
  assert.equal(res.body.quota.limitBytes, LIMIT);
  assert.match(res.body.billingUrl, new RegExp(`/s/${world.server.slug}/settings/billing$`));
  assert.equal(res.body.suggestedNextAction, `Say in the conversation that the file wasn't uploaded and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${res.body.billingUrl}`);
  assert.deepEqual(res.body.details, { requestedBytes, quota: res.body.quota, billingUrl: res.body.billingUrl });
}

test("Free server over its monthly quota: a publish with new inline bytes is refused as attachments are, and nothing is stored", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await setUsage(world, LIMIT - 4);
  const res = await publish(app, world, { files: [{ path: "index.html", content: "<h1>new</h1>" }] });
  assertQuotaRefusal(res, world, "<h1>new</h1>".length);
  assert.equal(world.r2.size, 0, "no bytes in R2");
  assert.equal((await blobsOf(world)).length, 0, "no blob row");
  assert.equal((await itemsOf(world)).length, 0, "no artifact");
  assert.deepEqual(await usage(world), { usedBytes: LIMIT - 4, reservedBytes: 0 });
});

test("Free server over its monthly quota: the raw upload is refused (before the body is read), and nothing is stored", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await setUsage(world, LIMIT - 4);
  const bytes = Buffer.from("five!");
  assertQuotaRefusal(await upload(app, world, bytes), world, bytes.length);
  assert.equal(world.r2.size, 0);
  assert.equal((await blobsOf(world)).length, 0);
  assert.deepEqual(await usage(world), { usedBytes: LIMIT - 4, reservedBytes: 0 });
  // Under the quota the same upload goes through and counts.
  await setUsage(world, LIMIT - bytes.length);
  assert.equal((await upload(app, world, bytes)).status, 204);
  assert.deepEqual(await usage(world), { usedBytes: LIMIT, reservedBytes: 0 });
});

test("a refusal is a paywall hit (upload_monthly_quota), recorded by the server as the agent's: one per refused write, with its via and the numbers; the answer is unchanged", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const captured = capturePaywallHits(app);
  const used = LIMIT - 4;
  await setUsage(world, used);
  const page = "<h1>new</h1>";
  assertQuotaRefusal(await publish(app, world, { files: [{ path: "index.html", content: page }] }), world, page.length);
  await captured.expect(1, "the publish");
  const bytes = Buffer.from("five!");
  assertQuotaRefusal(await upload(app, world, bytes), world, bytes.length);
  await captured.expect(2, "the upload");
  // An agent's: no person, so no viewer_role or analytics_id; the server's own row.
  assert.deepEqual(captured.hits(), [
    { properties: { gate: "upload_monthly_quota", actor: "agent", plan: "free", via: "artifact_publish", requested_bytes: page.length, month_used_bytes: used }, analyticsId: null, serverId: world.server.id },
    { properties: { gate: "upload_monthly_quota", actor: "agent", plan: "free", via: "artifact_upload", requested_bytes: bytes.length, month_used_bytes: used }, analyticsId: null, serverId: world.server.id },
  ]);
  // Refused again the same day: counted once a day.
  assertQuotaRefusal(await upload(app, world, bytes), world, bytes.length);
  await captured.expect(2, "the same refusal again");
});

test("Pro and the internal plans: no quota refusal, so no paywall hit", async ({ app, seed }) => {
  for (const plan of ["pro", "founder", "partner"] as const) {
    const world = await seedWorld(seed, { plan });
    const captured = capturePaywallHits(app);
    await setUsage(world, LIMIT);
    assert.equal((await publish(app, world, { files: [{ path: "index.html", content: `<h1>${plan}</h1>` }] })).status, 201);
    assert.equal((await upload(app, world, Buffer.from(`${plan} bytes`))).status, 204);
    // A listed file the server lacks: asked for, as on any plan without a quota.
    const listed = Buffer.from(`${plan} listed`);
    assert.deepEqual(await publish(app, world, { title: "listed", files: [{ path: "a.txt", sha256: sha(listed), size: listed.length }] }), { status: 200, body: { missing: [sha(listed)] } });
    await captured.expect(0, plan);
  }
});

test("new bytes count once, by their size; bytes the server already has cost nothing, even over the quota", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const page = "<h1>kept</h1>";
  // Each its own title: the same request again would be answered as a replay of the first.
  const first = await publish(app, world, { title: "kept", files: [{ path: "index.html", content: page }] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(await usage(world), { usedBytes: page.length, reservedBytes: 0 });

  // The same bytes again (inline in another Artifact, and uploaded): no new bytes, no new usage.
  const again = await publish(app, world, { title: "again", files: [{ path: "index.html", content: page }] });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal((await upload(app, world, Buffer.from(page))).status, 204);
  assert.deepEqual(await usage(world), { usedBytes: page.length, reservedBytes: 0 });

  // Over the quota: what the server already has still publishes (inline and listed); anything new doesn't.
  await setUsage(world, LIMIT);
  const inline = await publish(app, world, { title: "inline-existing", files: [{ path: "index.html", content: page }] });
  assert.equal(inline.status, 201, JSON.stringify(inline.body));
  const listed = await publish(app, world, { title: "listed-existing", files: [{ path: "index.html", sha256: sha(page), size: page.length }] });
  assert.equal(listed.status, 201, JSON.stringify(listed.body));
  assert.equal((await upload(app, world, Buffer.from(page))).status, 204);
  const mixed = await publish(app, world, { title: "mixed", files: [{ path: "index.html", content: page }, { path: "new.css", content: "b{}" }] });
  assertQuotaRefusal(mixed, world, 3);
  assert.deepEqual(await usage(world), { usedBytes: LIMIT, reservedBytes: 0 });
  assert.equal((await blobsOf(world)).length, 1, "only the bytes stored before");
});

test("a publish whose new files together exceed the quota stores none of them", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await setUsage(world, LIMIT - 5);
  const res = await publish(app, world, { entry: "a.txt", files: [{ path: "a.txt", content: "aaaa" }, { path: "b.txt", content: "bbbb" }] });
  assertQuotaRefusal(res, world, 8);
  assert.equal(world.r2.size, 0);
  assert.equal((await blobsOf(world)).length, 0);
  assert.deepEqual(await usage(world), { usedBytes: LIMIT - 5, reservedBytes: 0 });
});

test("Pro servers are not limited and not counted", async ({ app, seed }) => {
  const world = await seedWorld(seed, { plan: "pro" });
  await setUsage(world, LIMIT);
  const res = await publish(app, world, { files: [{ path: "index.html", content: "<h1>pro</h1>" }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await upload(app, world, Buffer.from("pro bytes"))).status, 204);
  assert.deepEqual(await usage(world), { usedBytes: LIMIT, reservedBytes: 0 });
});

test("a failed store gives its reservation back: nothing is counted, and the retry counts once", async ({ app, seed }) => {
  let failing = true;
  const world = await seedWorld(seed, { failPut: () => failing });
  const page = "<h1>retry</h1>";
  const failed = await publish(app, world, { files: [{ path: "index.html", content: page }] });
  assert.equal(failed.status, 500);
  assert.deepEqual(await usage(world), { usedBytes: 0, reservedBytes: 0 });
  const bytes = Buffer.from("upload retry");
  assert.equal((await upload(app, world, bytes)).status, 500);
  assert.deepEqual(await usage(world), { usedBytes: 0, reservedBytes: 0 });
  // The pending rows went with their reservations.
  assert.equal((await blobsOf(world)).length, 0);

  failing = false;
  assert.equal((await publish(app, world, { files: [{ path: "index.html", content: page }] })).status, 201);
  assert.equal((await upload(app, world, bytes)).status, 204);
  assert.deepEqual(await usage(world), { usedBytes: page.length + bytes.length, reservedBytes: 0 });
});

test("concurrent stores of the same new bytes count them once", async ({ seed }) => {
  const world = await seedWorld(seed);
  const store = memoryR2(world.r2);
  const bytes = Buffer.from("raced bytes");
  const outcomes = await Promise.all([1, 2, 3].map(() => storeBlob(store, world.serverId, sha(bytes), bytes)));
  assert.deepEqual(outcomes.map((o) => o.kind), ["stored", "stored", "stored"]);
  assert.deepEqual(await usage(world), { usedBytes: bytes.length, reservedBytes: 0 });
  const rows = await blobsOf(world);
  assert.deepEqual(rows.map((row) => [row.state, row.quotaMonth, row.quotaReservedBytes]), [["ready", null, null]], "one ready row, its reservation committed");
});

test("a store that stops between reserving and committing (a crash): its pending row holds the reservation, and the sweep gives it back", async ({ seed }) => {
  const world = await seedWorld(seed);
  const bytes = Buffer.from("never committed");
  const stalled = stalledR2(world.r2);
  void storeBlob(stalled.store, world.serverId, sha(bytes), bytes);
  await stalled.putStarted;
  // The reservation is on the pending row, in the same transaction that inserted it.
  assert.deepEqual(await usage(world), { usedBytes: 0, reservedBytes: bytes.length });
  const [row] = await blobsOf(world);
  assert.deepEqual([row!.state, row!.quotaMonth, row!.quotaReservedBytes], ["pending", billingUsageMonth(), bytes.length]);

  // Within the TTL the sweep leaves it; after, it deletes the row and gives the bytes back.
  await pruneUnreferencedArtifactBlobs({ store: memoryR2(world.r2) });
  assert.equal((await blobsOf(world)).length, 1);
  assert.deepEqual(await usage(world), { usedBytes: 0, reservedBytes: bytes.length });
  await pruneUnreferencedArtifactBlobs({ now: afterTtl(), store: memoryR2(world.r2) });
  assert.equal((await blobsOf(world)).length, 0);
  assert.deepEqual(await usage(world), { usedBytes: 0, reservedBytes: 0 });
});

test("a store of bytes a stopped store left pending commits that reservation: counted once, nothing left reserved", async ({ seed }) => {
  const world = await seedWorld(seed);
  const bytes = Buffer.from("finished by the retry");
  const stalled = stalledR2(world.r2);
  void storeBlob(stalled.store, world.serverId, sha(bytes), bytes);
  await stalled.putStarted;
  assert.equal((await storeBlob(memoryR2(world.r2), world.serverId, sha(bytes), bytes)).kind, "stored");
  assert.deepEqual(await usage(world), { usedBytes: bytes.length, reservedBytes: 0 });
  const rows = await blobsOf(world);
  assert.deepEqual(rows.map((row) => [row.state, row.quotaMonth, row.quotaReservedBytes]), [["ready", null, null]]);
});

test("the sweep of stored bytes no version uses gives nothing back: they were counted when stored", async ({ seed }) => {
  const world = await seedWorld(seed);
  const bytes = Buffer.from("stored, never published");
  assert.equal((await storeBlob(memoryR2(world.r2), world.serverId, sha(bytes), bytes)).kind, "stored");
  assert.deepEqual(await usage(world), { usedBytes: bytes.length, reservedBytes: 0 });
  await pruneUnreferencedArtifactBlobs({ now: afterTtl(), store: memoryR2(world.r2) });
  assert.equal((await blobsOf(world)).length, 0);
  assert.deepEqual(await usage(world), { usedBytes: bytes.length, reservedBytes: 0 });
});

test("attachments and Artifacts share one monthly total: an attachment upload and an Artifact upload together over it are refused", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  __setStorageForTests(memoryAttachmentStorage());
  await setUsage(world, LIMIT - 100);

  const attachment = await uploadAttachment(app, world, Buffer.alloc(60, "a"));
  assert.equal(attachment.status, 200, JSON.stringify(attachment.body));
  assert.deepEqual(await usage(world), { usedBytes: LIMIT - 40, reservedBytes: 0 });

  // 60 bytes would fit alone, but not after the attachment's 60.
  const tooMuch = Buffer.alloc(60, "b");
  assertQuotaRefusal(await upload(app, world, tooMuch), world, 60);
  assertQuotaRefusal(await publish(app, world, { entry: "big.txt", files: [{ path: "big.txt", content: tooMuch.toString() }] }), world, 60);
  const fits = Buffer.alloc(40, "c");
  assert.equal((await upload(app, world, fits)).status, 204);
  assert.deepEqual(await usage(world), { usedBytes: LIMIT, reservedBytes: 0 });

  // And the other way: the Artifact bytes leave no room for an attachment.
  const after = await uploadAttachment(app, world, Buffer.from("one more"));
  assert.equal(after.status, 403);
  assert.equal(after.body.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
});

/** Agent A on a Computer that reported `version` (1.0.53 and later post upgrade cards); its machine, to report another. */
async function onComputer(world: World, version: string) {
  const { machine } = await registerMachine(world.server.id, world.owner.id, `quota-computer-${label()}`);
  await placeAgentOnMachine(world.agentA.id, machine.id);
  await recordMachineComputerVersion(machine.id, version);
  return machine;
}

/** The upgrade-card offer an agent's push over the monthly quota gets (agentUpgradeCardHint, its files), spelled out. */
function quotaCardHint(target: string): string {
  return [
    "The files were not stored: this server is on the Free plan and has used this month's upload allowance. Pro would take them. Say in the conversation that the files weren't stored and why, then offer an upgrade card unless that is clearly out of place here (put what the files are for in place of the <…>):",
    `raft action prepare --target "${target}" <<'RAFTACTION'`,
    '{"type":"plan:upgrade","gate":"upload_monthly_quota","reason":"<one sentence: what the files are for>"}',
    "RAFTACTION",
  ].join("\n");
}

/** A quota refusal offering the card in `target`: the next action, and `details.upgradeHint` for the CLI. */
function assertCardOffered(res: Reply, target: string) {
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(res.body.suggestedNextAction, quotaCardHint(target));
  assert.equal(res.body.details.upgradeHint, quotaCardHint(target));
  assert.deepEqual(Object.keys(res.body.details).sort(), ["billingUrl", "quota", "requestedBytes", "upgradeHint"]);
}

test("a Free server's push refused for the quota offers the upgrade card in the Artifact's home conversation, to an agent whose Computer can post it", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await onComputer(world, "1.0.53");
  const home = `#${world.pub.name}`;

  // A new Artifact: its target, the conversation it would be homed in.
  await setUsage(world, LIMIT - 4);
  assertCardOffered(await publish(app, world, { files: [{ path: "index.html", content: "<h1>new</h1>" }] }), home);
  assert.equal((await itemsOf(world)).length, 0, "nothing made");

  // A new version of one: its home conversation.
  await setUsage(world, 0);
  const made = await publish(app, world, { title: "Homed", files: [{ path: "index.html", content: "<h1>v1</h1>" }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await setUsage(world, LIMIT);
  const version = { artifact: made.body.artifact.id, base: 1, target: undefined, title: undefined, files: [{ path: "index.html", content: "<h1>v2</h1>" }] };
  assertCardOffered(await publish(app, world, version), home);
});

test("no upgrade card where the agent can't post one or there is no conversation for it: the billing line, no upgradeHint", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const machine = await onComputer(world, "1.0.52");
  const page = "<h1>new</h1>";
  await setUsage(world, LIMIT);
  // A Computer whose CLI refuses plan:upgrade (before 1.0.53): inline, and listed (the declare step).
  assertQuotaRefusal(await publish(app, world, { files: [{ path: "index.html", content: page }] }), world, page.length);
  assertQuotaRefusal(await publish(app, world, { files: [{ path: "index.html", sha256: sha(page), size: page.length }] }), world, page.length);

  // An Artifact homed in the whole server: no conversation to offer it in.
  await recordMachineComputerVersion(machine.id, "1.0.53");
  await setUsage(world, 0);
  const made = await publish(app, world, { title: "Server-wide", files: [{ path: "index.html", content: "<h1>v1</h1>" }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, made.body.artifact.id));
  await setUsage(world, LIMIT);
  const version = { artifact: made.body.artifact.id, base: 1, target: undefined, title: undefined, files: [{ path: "index.html", content: page }] };
  assertQuotaRefusal(await publish(app, world, version), world, page.length);

  // A refusal of a paying plan's quota (AppSumo is Pro with a monthly allowance): never a card, whatever the conversation.
  const free = { month: billingUsageMonth(), plan: "free" as const, limited: true, enforced: true, limitBytes: LIMIT, usedBytes: LIMIT, reservedBytes: 0, remainingBytes: 0 };
  const appsumo = { ...free, plan: "pro" as const, appsumo: { tier: 1 as const, lifetime: true as const } };
  const hintFor = (summary: typeof free | typeof appsumo) => agentQuotaUpgradeHint({ serverId: world.serverId, agentId: world.agentA.id, channelId: world.pub.id, subject: "files", error: new FileUploadQuotaExceededError(summary, 1) });
  assert.equal(await hintFor(appsumo), null);
  // The same refusal on Free (this server) is offered one there.
  assert.equal(await hintFor(free), quotaCardHint(`#${world.pub.name}`));
});

test("the declare step: a push whose listed files the server lacks don't fit by their declared sizes is refused before any upload, with the card and one paywall hit (artifact_publish); one that fits answers missing and goes through as before; files the server has never count", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  await onComputer(world, "1.0.53");
  // The server already has `kept`; `fresh` is new, listed under two paths (the same bytes, counted once).
  const kept = Buffer.from("<h1>kept</h1>");
  const fresh = Buffer.from("fresh!");
  assert.equal((await upload(app, world, kept)).status, 204);
  const files = [
    { path: "index.html", sha256: sha(kept), size: kept.length },
    { path: "a.txt", sha256: sha(fresh), size: fresh.length },
    { path: "copy.txt", sha256: sha(fresh), size: fresh.length },
  ];
  const captured = capturePaywallHits(app);

  // One byte short of the new bytes: refused at the declare step, nothing asked for, uploaded or made.
  await setUsage(world, LIMIT - fresh.length + 1);
  const refused = await publish(app, world, { files });
  assertCardOffered(refused, `#${world.pub.name}`);
  assert.equal(refused.body.requestedBytes, fresh.length, "only the new bytes, once");
  assert.equal(refused.body.missing, undefined);
  await captured.expect(1, "the declare step");
  assert.deepEqual(captured.hits(), [
    { properties: { gate: "upload_monthly_quota", actor: "agent", plan: "free", via: "artifact_publish", requested_bytes: fresh.length, month_used_bytes: LIMIT - fresh.length + 1 }, analyticsId: null, serverId: world.server.id },
  ]);
  assert.equal(world.r2.size, 1, "only the bytes stored before");
  assert.equal((await itemsOf(world)).length, 0);
  assert.deepEqual(await usage(world), { usedBytes: LIMIT - fresh.length + 1, reservedBytes: 0 });
  // A client that uploads anyway meets the upload route's own check (a size is only declared there; no Artifact, so no card).
  assertQuotaRefusal(await upload(app, world, fresh), world, fresh.length);
  assert.equal(world.r2.size, 1);

  // Room for exactly the new bytes: asked for as before, then uploaded and pushed.
  await setUsage(world, LIMIT - fresh.length);
  assert.deepEqual(await publish(app, world, { files }), { status: 200, body: { missing: [sha(fresh)] } });
  assert.equal((await upload(app, world, fresh)).status, 204);
  const pushed = await publish(app, world, { files });
  assert.equal(pushed.status, 201, JSON.stringify(pushed.body));
  assert.deepEqual(await usage(world), { usedBytes: LIMIT, reservedBytes: 0 });
  // Now full, a push of what the server has goes through: nothing is missing, nothing is checked.
  const again = await publish(app, world, { title: "again", files });
  assert.equal(again.status, 201, JSON.stringify(again.body));
});
