// Saving an attachment as an Artifact through the agent API
// (`POST /internal/agent-api/artifacts/save-attachment`), over HTTP with real
// agent credentials. Proves what the agent route adds to the save the web
// shares (save.ts; its rule share.api.test.ts proves for a person): the flag
// first; an agent that sees the message saves it as an Artifact it owns and
// follows, homed in the conversation, answered as the agent names it, and the
// web's "Saved as Artifact" line for a person there (attachment-saves); the
// earlier save answered to the same or another agent that sees it; the
// refusals in the agent API's words (404 ATTACHMENT_NOT_FOUND, 409
// ALREADY_SAVED, 422 ATTACHMENT_NOT_SAVABLE, 503 CONTENT_UNAVAILABLE, 403
// FILE_UPLOAD_QUOTA_EXCEEDED with the attachments' fields; on Free, the
// upgrade card offered where the attachment was posted, to an agent whose
// Computer can post one), nothing saved;
// and a joint channel: each server saves on its own copy of the channel, and
// an earlier save of a server whose Artifacts are off is only ALREADY_SAVED.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import {
  ARTIFACT_SAVE_MAX_BINARY_BYTES,
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  artifactLinkId,
  artifactWebPaths,
  asArtifactId,
  type ArtifactWebAttachmentSaves,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { attachmentObjects, attachments, messages, serverFileUploadUsageMonths } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { billingUsageMonth } from "../../services/fileUploadQuotaService";
import { recordMachineComputerVersion, registerMachine } from "../../services/machineService";
import { createMessage } from "../../services/messageService";
import { __setStorageForTests, resetStorageForTests, type StorageBackend } from "../../services/storageService";
import { placeAgentOnMachine } from "../../test/agentMachineFixture";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { capturePaywallHits } from "../../test/integration/paywallHits";
import type { createSeed } from "../../test/integration/seed";
import { refusalBody } from "../../platform/refusals";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { ALREADY_SAVED_ERROR, ATTACHMENT_NOT_FOUND_ERROR, attachmentTooLargeError } from "./save";
import { artifactAttachmentSaves, artifactItems, artifactReadPositions, artifactSubscriptions, artifactVersionFiles, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { useStripeBillingConfigured } from "../../test/stripeBillingEnv";

const test = createApiTest();
useStripeBillingConfigured();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-save-agent-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
  resetStorageForTests();
});
const label = () => randomUUID().slice(0, 8);

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign() { return null; },
  };
}

function memoryStorage(objects: Map<string, Buffer>): StorageBackend {
  return {
    put: async () => {},
    delete: async () => {},
    get: async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error(`no object ${key}`), { name: "NoSuchKey" });
      return Readable.from([bytes]);
    },
  };
}

/**
 * A server (Artifacts on unless `enabled: false`): its owner and member, both
 * in #team (private) with agents A and B; #other (private, the owner only);
 * agent Out in no channel. Core's attachment storage and Artifacts' R2 are in
 * memory.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const make = (prefix: string) => createAgent(server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: owner.id });
  const agentA = await make("sv-a");
  const agentB = await make("sv-b");
  const agentOut = await make("sv-out");
  const team = await createChannel(server.id, `sv-team-${label()}`, undefined, "private");
  for (const human of [owner, member]) await addHuman(team.id, human.id);
  for (const agent of [agentA, agentB]) await addAgent(team.id, agent.id);
  const other = await createChannel(server.id, `sv-other-${label()}`, undefined, "private");
  await addHuman(other.id, owner.id);
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const stored = new Map<string, Buffer>();
  __setStorageForTests(memoryStorage(stored));
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `sv-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const message = await createMessage(team.id, "user", owner.id, "files");

  /** An attachment the owner posted on #team's message (or `messageId` in `channelId`), its bytes in core's storage. */
  const attach = async (filename: string, bytes: Buffer, at: { channelId: string; messageId: string; sizeBytes?: number } = { channelId: team.id, messageId: message.id }) => {
    const storageKey = `att/${randomUUID()}`;
    stored.set(storageKey, bytes);
    const size = at.sizeBytes ?? bytes.length;
    const [object] = await getDb().insert(attachmentObjects).values({
      originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey, mimeType: "application/octet-stream", sizeBytes: size,
    }).returning();
    const [row] = await getDb().insert(attachments).values({
      objectId: object!.id, messageId: at.messageId, channelId: at.channelId, uploaderId: owner.id, uploaderType: "user",
      filename,
    }).returning();
    return row!;
  };
  return {
    server, owner, member, agentA, agentB, team, other, r2, message, attach, key,
    keys: { a: await key(agentA.id), b: await key(agentB.id), out: await key(agentOut.id) },
  };
}

type Reply = { status: number; body: any };

async function save(app: { baseUrl: string }, apiKey: string, attachmentId: string): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/save-attachment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ attachmentId }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const savesOf = (attachmentId: string) => getDb().select().from(artifactAttachmentSaves).where(eq(artifactAttachmentSaves.attachmentId, attachmentId));
const itemsIn = (channelId: string) => getDb().select().from(artifactItems).where(eq(artifactItems.homeChannelId, channelId));

test("an agent that sees the message saves the attachment: its Artifact, homed in the conversation, followed, and the web's \"Saved as Artifact\" line; again, or by another agent that sees it, the same Artifact", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const attachment = await world.attach("Q3 report.md", Buffer.from("# Q3 report\n\nnumbers"));

  const res = await save(app, world.keys.a, attachment.id);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { artifact } = res.body;
  assert.deepEqual([res.body.created, res.body.attachment], [true, { id: attachment.id, filename: "Q3 report.md" }]);
  assert.deepEqual(
    [artifact.title, artifact.kind, artifact.currentVersion, artifact.author, artifact.home],
    // Titled after the file without its known extension; the file keeps its name (artifactTitleFromFileName).
    ["Q3 report", "markdown", 1, { type: "agent", name: world.agentA.name }, { kind: "conversation", conversation: { id: world.team.id, type: "private", target: `#${world.team.name}` } }],
  );
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, artifact.id));
  assert.deepEqual([item!.createdByType, item!.createdById, item!.homeChannelId, item!.originalHomeChannelId], ["agent", world.agentA.id, world.team.id, world.team.id], "saved in #team, its original conversation (#75)");
  assert.equal(item!.name, null, "an Artifact is its id and its title: no name is stored");
  assert.equal(artifact.name, artifactLinkId(asArtifactId(artifact.id)), "the deprecated field still carries its short id for older CLIs");
  // The agent follows what it saved, read up to its last position.
  const [subscription] = await getDb().select().from(artifactSubscriptions)
    .where(and(eq(artifactSubscriptions.itemId, item!.id), eq(artifactSubscriptions.actorType, "agent"), eq(artifactSubscriptions.actorId, world.agentA.id)));
  assert.deepEqual([subscription!.reason, subscription!.unsubscribedAt], ["published", null]);
  const [position] = await getDb().select().from(artifactReadPositions)
    .where(and(eq(artifactReadPositions.itemId, item!.id), eq(artifactReadPositions.actorType, "agent"), eq(artifactReadPositions.actorId, world.agentA.id)));
  assert.equal(position!.position, item!.lastPosition);
  // The save, and the line a person in #team reads under the attachment.
  assert.deepEqual((await savesOf(attachment.id)).map((row) => row.itemId), [artifact.id]);
  const lines = await fetch(`${app.baseUrl}${artifactWebPaths.attachmentSaves([attachment.id])}`, {
    headers: { Authorization: `Bearer ${await accessTokenForTest(world.member.id)}`, "X-Server-Id": world.server.id },
  });
  const { saves } = await lines.json() as ArtifactWebAttachmentSaves;
  assert.deepEqual(saves.map((entry) => [entry.attachmentId, entry.savedAs.status === "ok" ? entry.savedAs.card.id : null]), [[attachment.id, artifact.id]]);

  // Again, then by agent B (who sees #team): the same Artifact, nothing new; B isn't made a follower.
  for (const key of [world.keys.a, world.keys.b]) {
    const again = await save(app, key, attachment.id);
    assert.deepEqual([again.status, again.body.created, again.body.artifact.id, again.body.attachment], [200, false, artifact.id, { id: attachment.id, filename: "Q3 report.md" }]);
  }
  assert.equal((await itemsIn(world.team.id)).length, 1);
  assert.deepEqual((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, item!.id))).map((row) => row.actorId), [world.agentA.id]);
});

test("a saved Markdown file has its excerpt with its version, without reading storage; another kind has none", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const excerptOf = async (artifact: string) => (await getDb().select({ excerpt: artifactVersions.excerpt }).from(artifactVersions).where(eq(artifactVersions.itemId, artifact)))[0]!.excerpt;
  const markdown = await save(app, world.keys.a, (await world.attach("Plan.md", Buffer.from("# Plan\n\nShip **it**."))).id);
  assert.equal(markdown.status, 201);
  assert.equal(await excerptOf(markdown.body.artifact.id), "Ship it.", "the heading repeating the title left out");
  const [{ excerptBlocks }] = await getDb().select({ excerptBlocks: artifactVersions.excerptBlocks }).from(artifactVersions).where(eq(artifactVersions.itemId, markdown.body.artifact.id));
  assert.deepEqual(excerptBlocks, [{ type: "paragraph", spans: [{ text: "Ship " }, { text: "it", bold: true }, { text: "." }] }], "its blocks with it");
  const page = await save(app, world.keys.a, (await world.attach("page.html", Buffer.from("<p>words</p>"))).id);
  assert.equal(await excerptOf(page.body.artifact.id), null);
});

test("an attachment named .git is saved under a name git doesn't own", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const attachment = await world.attach(".GIT", Buffer.from("gitdir: /elsewhere"));
  const res = await save(app, world.keys.a, attachment.id);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, res.body.artifact.id));
  const files = await getDb().select({ path: artifactVersionFiles.path }).from(artifactVersionFiles).where(eq(artifactVersionFiles.versionId, version!.id));
  assert.deepEqual(files.map((file) => file.path), ["_.GIT"]);
});

test("refused, nothing saved: a message the agent can't see (or no such attachment) 404, saved as an Artifact the agent can't see now 409, a file over an Artifact file's limit 422", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const file = await world.attach("notes.txt", Buffer.from("notes"));
  const elsewhere = await createMessage(world.other.id, "user", world.owner.id, "private file");
  const hidden = await world.attach("h.txt", Buffer.from("h"), { channelId: world.other.id, messageId: elsewhere.id });
  for (const [key, attachmentId] of [[world.keys.out, file.id], [world.keys.a, hidden.id], [world.keys.a, randomUUID()], [world.keys.a, "not-a-uuid"]] as const) {
    assert.deepEqual(await save(app, key, attachmentId), { status: 404, body: refusalBody({ code: "ATTACHMENT_NOT_FOUND", error: ATTACHMENT_NOT_FOUND_ERROR, details: { attachmentId } }) }, attachmentId);
  }
  assert.deepEqual([...await savesOf(file.id), ...await savesOf(hidden.id)], []);

  const big = await world.attach("big.bin", Buffer.from("x"), { channelId: world.team.id, messageId: world.message.id, sizeBytes: ARTIFACT_SAVE_MAX_BINARY_BYTES + 1 });
  assert.deepEqual(await save(app, world.keys.a, big.id), {
    status: 422,
    body: refusalBody({ code: "ATTACHMENT_NOT_SAVABLE", error: attachmentTooLargeError(ARTIFACT_SAVE_MAX_BINARY_BYTES), details: { attachmentId: big.id, reason: "too_large", limit: ARTIFACT_SAVE_MAX_BINARY_BYTES } }),
  });
  assert.deepEqual(await savesOf(big.id), []);

  // Saved by A, then moved to #other: B sees the attachment, not the Artifact.
  const first = await save(app, world.keys.a, file.id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await getDb().update(artifactItems).set({ homeChannelId: world.other.id }).where(eq(artifactItems.id, first.body.artifact.id));
  assert.deepEqual(await save(app, world.keys.b, file.id), { status: 409, body: refusalBody({ code: "ALREADY_SAVED", error: ALREADY_SAVED_ERROR, details: { attachmentId: file.id } }) });
  assert.deepEqual((await savesOf(file.id)).map((row) => row.itemId), [first.body.artifact.id]);
});

test("a joint channel: the peer's agent saves on its own server's copy of the channel; an agent of the host in the joint gets that same Artifact; a third server's agent 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const peer = await seed.server({ owner: await seed.human() });
  const third = await seed.server({ owner: await seed.human() });
  const joint = await seedJointChannel({ name: `sv-joint-${label()}`, serverIds: [world.server.id, peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  const peerAgent = await createAgent(peer.id, `sv-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  await addAgent(peerProjection.id, peerAgent.id);
  const thirdAgent = await createAgent(third.id, `sv-third-${label()}`, { runtime: "claude", model: "sonnet" });
  const keys = { peer: await world.key(peerAgent.id), third: await world.key(thirdAgent.id) };
  // A message of the joint (its canonical stream), with a file.
  const message = await createMessage(joint.canonical.id, "user", world.owner.id, "a joint file");
  const attachment = await world.attach("joint.md", Buffer.from("# joint"), { channelId: joint.canonical.id, messageId: message.id });

  const made = await save(app, keys.peer, attachment.id);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, made.body.artifact.id));
  assert.deepEqual([item!.serverId, item!.homeChannelId, item!.createdByType, item!.createdById], [peer.id, peerProjection.id, "agent", peerAgent.id], "the peer's Artifact, on its copy of the channel");
  // The host's agent, in the joint, sees it: the same Artifact.
  const seen = await save(app, world.keys.a, attachment.id);
  assert.deepEqual([seen.status, seen.body.created, seen.body.artifact?.id], [200, false, item!.id], JSON.stringify(seen.body));

  // Not in the joint: no such attachment.
  assert.deepEqual(await save(app, keys.third, attachment.id), { status: 404, body: refusalBody({ code: "ATTACHMENT_NOT_FOUND", error: ATTACHMENT_NOT_FOUND_ERROR, details: { attachmentId: attachment.id } }) });
  assert.deepEqual((await savesOf(attachment.id)).map((row) => row.itemId), [item!.id], "nothing new saved");
});

test("storage: Artifacts' storage not configured 503 CONTENT_UNAVAILABLE; no room in the month's file upload quota 403 FILE_UPLOAD_QUOTA_EXCEEDED with the attachments' fields; nothing saved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const attachment = await world.attach("ten.txt", Buffer.from("ten bytes!"));
  __setArtifactR2StoreForTests(null);
  const unavailable = await save(app, world.keys.a, attachment.id);
  assert.deepEqual([unavailable.status, unavailable.body.code], [503, "CONTENT_UNAVAILABLE"]);
  __setArtifactR2StoreForTests(memoryR2(world.r2));

  await getDb().insert(serverFileUploadUsageMonths).values({ serverId: world.server.id, month: billingUsageMonth(), usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES - 4, reservedBytes: 0 });
  const captured = capturePaywallHits(app);
  const full = await save(app, world.keys.a, attachment.id);
  assert.equal(full.status, 403, JSON.stringify(full.body));
  assert.equal(full.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(full.body.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED", "the attachments' refusal body");
  assert.equal(full.body.details.requestedBytes, 10);
  assert.equal(full.body.details.quota.limitBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  assert.deepEqual(await savesOf(attachment.id), []);
  assert.deepEqual(await itemsIn(world.team.id), []);
  // One paywall hit, the agent's (no person), recorded by the server.
  await captured.expect(1, "the agent's save");
  assert.deepEqual(captured.hits(), [{
    properties: { gate: "upload_monthly_quota", actor: "agent", plan: "free", via: "artifact_save_attachment", requested_bytes: 10, month_used_bytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES - 4 },
    analyticsId: null,
    serverId: world.server.id,
  }]);
});

test("no room in the quota on Free, for an agent whose Computer can post an upgrade card: the card offered where the attachment was posted (a thread's too), nothing saved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { machine } = await registerMachine(world.server.id, world.owner.id, `sv-computer-${label()}`);
  await placeAgentOnMachine(world.agentA.id, machine.id);
  await recordMachineComputerVersion(machine.id, "1.0.53");
  await getDb().insert(serverFileUploadUsageMonths).values({ serverId: world.server.id, month: billingUsageMonth(), usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 });
  const cardHint = (target: string) => [
    "The file was not saved: this server is on the Free plan and has used this month's upload allowance. Pro would take it. Say in the conversation that the file wasn't saved and why, then offer an upgrade card unless that is clearly out of place here (put what the file is for in place of the <…>):",
    `raft action prepare --target "${target}" <<'RAFTACTION'`,
    '{"type":"plan:upgrade","gate":"upload_monthly_quota","reason":"<one sentence: what the file is for>"}',
    "RAFTACTION",
  ].join("\n");

  const inChannel = await world.attach("ten.txt", Buffer.from("ten bytes!"));
  const thread = await getOrCreateThread(world.message.id, world.owner.id, "user");
  const reply = await createMessage(thread.id, "user", world.owner.id, "a reply with a file");
  const inThread = await world.attach("notes.txt", Buffer.from("notes"), { channelId: thread.id, messageId: reply.id });
  for (const [attachment, target] of [[inChannel, `#${world.team.name}`], [inThread, `#${world.team.name}:${world.message.id.slice(0, 8)}`]] as const) {
    const full = await save(app, world.keys.a, attachment.id);
    assert.equal(full.status, 403, JSON.stringify(full.body));
    assert.equal(full.body.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
    assert.equal(full.body.suggestedNextAction, cardHint(target));
    assert.equal(full.body.details.upgradeHint, cardHint(target));
    assert.deepEqual(await savesOf(attachment.id), []);
  }
  // Agent B is on no Computer, so its CLI may not post the card: the billing line, no upgradeHint.
  const other = await save(app, world.keys.b, inChannel.id);
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.match(other.body.suggestedNextAction, /^Say in the conversation that the file wasn't uploaded and why\. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: /);
  assert.equal(other.body.details.upgradeHint, undefined);
  assert.deepEqual(await itemsIn(world.team.id), []);
});

test("an attachment deleted while it is being saved: 404 ATTACHMENT_NOT_FOUND, nothing saved", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const attachment = await world.attach("gone.txt", Buffer.from("gone"));
  // Core's storage hands out the bytes, and the attachment is hard-deleted before the save row is written.
  __setStorageForTests({
    put: async () => {},
    delete: async () => {},
    get: async () => {
      await getDb().delete(attachments).where(eq(attachments.id, attachment.id));
      return Readable.from([Buffer.from("gone")]);
    },
  });
  const res = await save(app, world.keys.a, attachment.id);
  assert.deepEqual([res.status, res.body.code], [404, "ATTACHMENT_NOT_FOUND"], JSON.stringify(res.body));
  assert.deepEqual(await savesOf(attachment.id), []);
  assert.deepEqual(await itemsIn(world.team.id), []);
});

test("Artifacts off: 403 ARTIFACTS_NOT_ENABLED, nothing saved", async ({ app, seed }) => {
  const world = await seedWorld(seed, { enabled: false });
  const attachment = await world.attach("a.txt", Buffer.from("a"));
  const res = await save(app, world.keys.a, attachment.id);
  assert.deepEqual([res.status, res.body.code], [403, "ARTIFACTS_NOT_ENABLED"]);
  assert.deepEqual(await savesOf(attachment.id), []);
});

async function readArtifact(app: { baseUrl: string }, apiKey: string, artifactId: string): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/${encodeURIComponent(artifactId)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("the agent read's origin: the attachment's message as the agent names its conversation (a thread's as its thread target), and null for an agent that can't read that conversation", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const attachment = await world.attach("report.md", Buffer.from("# report"));
  const saved = await save(app, world.keys.a, attachment.id);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const artifactId = saved.body.artifact.id as string;
  const read = await readArtifact(app, world.keys.b, artifactId);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.origin, { target: `#${world.team.name}`, messageId: world.message.id, via: "attachment" });

  // Moved to the whole server: an agent outside #team reads the Artifact, never where it came from.
  await getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, artifactId));
  const outside = await readArtifact(app, world.keys.out, artifactId);
  assert.equal(outside.status, 200, JSON.stringify(outside.body));
  assert.equal(outside.body.origin, null);
  assert.deepEqual((await readArtifact(app, world.keys.a, artifactId)).body.origin, read.body.origin);

  // A reply in a thread: the thread's target, `#channel:<root short id>`.
  const thread = await getOrCreateThread(world.message.id, world.owner.id, "user");
  const reply = await createMessage(thread.id, "user", world.owner.id, "a reply with a file");
  const inThread = await world.attach("notes.txt", Buffer.from("notes"), { channelId: thread.id, messageId: reply.id });
  const threaded = await save(app, world.keys.a, inThread.id);
  assert.equal(threaded.status, 201, JSON.stringify(threaded.body));
  assert.deepEqual((await readArtifact(app, world.keys.a, threaded.body.artifact.id)).body.origin, {
    target: `#${world.team.name}:${world.message.id.slice(0, 8)}`, messageId: reply.id, via: "attachment",
  });
  // The message deleted by core (no foreign key: the id stays on the Artifact): never shown.
  await getDb().delete(messages).where(eq(messages.id, reply.id));
  const [kept] = await getDb().select({ originMessageId: artifactItems.originMessageId }).from(artifactItems).where(eq(artifactItems.id, threaded.body.artifact.id));
  assert.equal(kept!.originMessageId, reply.id);
  assert.equal((await readArtifact(app, world.keys.a, threaded.body.artifact.id)).body.origin, null);
});
