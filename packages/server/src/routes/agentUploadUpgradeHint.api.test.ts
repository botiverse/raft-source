import { createApiTest } from "../test/integration/apiTest";
// An agent's upload refused by a Free limit Pro lifts offers the upgrade card
// as its next action, the way its 30-day read limit does (task #9
// #proj-commercial): the monthly quota on the agent API's multipart upload,
// upload sessions and the legacy daemon route; a file over the Free plan's
// per-file limit when the CLI declares it to an upload session, whether or not
// direct uploads are on. The card targets the conversation the upload named by
// id, written as the agent writes it. Only a client that can post the card
// gets it: one that declares PLAN_UPGRADE_CARD_CAPABILITY (the current CLI,
// which every case below is unless it says otherwise), or an agent whose
// Computer runs 1.0.53 or later (that CLI declares nothing). Without a card
// (a shared channel, an older client, a conversation in its upgrade-card
// cooldown) the quota refusal keeps its billing line, softened:
// say why, and a server owner can look at Settings > Billing. A person's web
// upload over the quota is told to ask a server owner instead. The route's
// session refusals carry `error`, the field the CLI prints.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  MANUAL_CONTEXT_CAPABILITY,
  PLAN_UPGRADE_CARD_CAPABILITY,
  RAFT_CLIENT_CAPABILITIES_HEADER,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { serverFileUploadUsageMonths, users } from "../db/schema";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { prepareActionCard } from "../services/actionCardsService";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { recordMachineComputerVersion, registerMachine } from "../services/machineService";
import * as channelService from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createMessage } from "../services/messageService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { billingUsageMonth, FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE } from "../services/fileUploadQuotaService";
import { resetStorageForTests } from "../services/storageService";
import { getLegacyAttachmentFileSizeLimitBytes } from "../services/attachmentUploadPolicy";
import type { AttachmentUploadSessionService } from "./attachmentUploadSessions";
import { useStripeBillingConfigured } from "../test/stripeBillingEnv";

// Every case here is refused before a session is made; a size refusal reads
// the service's capabilities (does it take direct uploads?) to know what Pro
// would take.
const unexpected = async (): Promise<never> => {
  throw new Error("no upload session should be made");
};
function sessionServiceWith(directUploadEnabled: boolean): AttachmentUploadSessionService {
  return {
    capabilities: async () => ({
      status: 200,
      body: directUploadEnabled
        ? { directUploadEnabled, directUploadThresholdBytes: 10 * 1024 * 1024, maxBytes: FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES, sessionExpiresInSeconds: 900 }
        : { directUploadEnabled, directUploadThresholdBytes: null, maxBytes: FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES, sessionExpiresInSeconds: null },
    }),
    listActive: unexpected,
    create: unexpected,
    complete: unexpected,
    cancel: unexpected,
    status: unexpected,
  };
}

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, attachmentUploadSessionService: sessionServiceWith(true) });
useStripeBillingConfigured();
// Pro's per-file limit where uploads go multipart (an upload session service without direct uploads).
const PRO_MULTIPART_LIMIT_BYTES = getLegacyAttachmentFileSizeLimitBytes("pro");

const REQUEST_TIMEOUT_MS = 120_000;
/** What the current CLI declares in `X-Raft-Client-Capabilities` (packages/cli client.ts), guide-app tokens aside. */
const CAPABLE_CLI = `${MANUAL_CONTEXT_CAPABILITY},${PLAN_UPGRADE_CARD_CAPABILITY}`;
/** A CLI from before the plan:upgrade token (Computer 1.0.53 and older). */
const UNDECLARED = MANUAL_CONTEXT_CAPABILITY;

/** The quota refusal's own next action, where no card is offered, spelled out. */
function billingLine(billingUrl: string | undefined): string {
  return `Say in the conversation that the file wasn't uploaded and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${billingUrl}`;
}

function assertBillingLine(refused: Refusal, serverSlug: string) {
  assert.match(refused.billingUrl ?? "", new RegExp(`/s/${serverSlug}/settings/billing$`));
  assert.equal(refused.suggestedNextAction, billingLine(refused.billingUrl));
  assert.doesNotMatch(refused.suggestedNextAction ?? "", /raft action prepare/);
}

/** The next action of an upload a Free limit refused where the server allows a card (agentUpgradeCardHint), spelled out. */
function uploadCardHint(gate: "upload_monthly_quota" | "upload_file_size", target: string): string {
  const limit = gate === "upload_monthly_quota" ? "has used this month's upload allowance" : "the file is over the Free plan's per-file limit";
  return [
    `The file was not uploaded: this server is on the Free plan and ${limit}. Pro would take it. Say in the conversation that the file wasn't uploaded and why, then offer an upgrade card unless that is clearly out of place here (put what the file is for in place of the <…>):`,
    `raft action prepare --target "${target}" <<'RAFTACTION'`,
    `{"type":"plan:upgrade","gate":"${gate}","reason":"<one sentence: what the file is for>"}`,
    "RAFTACTION",
  ].join("\n");
}

async function seedWorld() {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `upload-owner-${suffix}@test.invalid`,
    name: `upload-owner-${suffix}`,
    displayName: "Upload owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Upload Hints", `upload-hints-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "upload-scout", { runtime: "claude" });
  const room = await channelService.createChannel(server.id, `upload-room-${randomUUID().slice(0, 6)}`);
  await channelService.addHuman(room.id, owner!.id);
  await channelService.addAgent(room.id, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "upload-hint", issuedVia: "computer", createdByUserId: null });
  return { owner: owner!, server, agent, room, apiKey };
}

async function useUpQuota(serverId: string) {
  await getDb().insert(serverFileUploadUsageMonths).values({
    serverId,
    month: billingUsageMonth(),
    usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
    reservedBytes: 0,
    updatedAt: new Date(),
  });
}

/** `capabilities`: the `X-Raft-Client-Capabilities` value, or null to send none (the SDK sends none). */
async function upload(baseUrl: string, apiKey: string, channelId: string, route = "/internal/agent-api/upload", capabilities: string | null = CAPABLE_CLI) {
  const form = new FormData();
  form.append("channelId", channelId);
  form.append("file", new Blob([Buffer.from("weekly report")], { type: "text/plain" }), "report.txt");
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, ...(capabilities !== null && { [RAFT_CLIENT_CAPABILITIES_HEADER]: capabilities }) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: form,
  });
}

async function createSession(baseUrl: string, apiKey: string, channelId: string, sizeBytes: number, capabilities: string | null = CAPABLE_CLI) {
  return fetch(`${baseUrl}/internal/agent-api/attachment-upload-sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(capabilities !== null && { [RAFT_CLIENT_CAPABILITIES_HEADER]: capabilities }) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ channelId, filename: "export.zip", mimeType: "application/zip", sizeBytes, clientRequestId: randomUUID() }),
  });
}

/** The agent's Computer, having reported `version` on connect (as its `ready` does). */
async function onComputer(serverId: string, ownerId: string, agentId: string, version: string) {
  const { machine, apiKey } = await registerMachine(serverId, ownerId, `upload-hint-computer-${randomUUID().slice(0, 6)}`);
  await placeAgentOnMachine(agentId, machine.id);
  await recordMachineComputerVersion(machine.id, version);
  return { machine, apiKey };
}

type Refusal = { code?: string; errorCode?: string; error?: string; message?: string; suggestedNextAction?: string; billingUrl?: string };

async function refusal(response: Response, status: number): Promise<Refusal> {
  assert.equal(response.status, status, await response.clone().text());
  return await response.json() as Refusal;
}

async function withLocalUploads<T>(work: () => Promise<T>): Promise<T> {
  const previousDir = process.env.UPLOADS_DIR;
  const previousLocal = process.env.UPLOADS_LOCAL;
  process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-upload-hint-"));
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();
  try {
    return await work();
  } finally {
    if (previousDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousDir;
    if (previousLocal === undefined) delete process.env.UPLOADS_LOCAL;
    else process.env.UPLOADS_LOCAL = previousLocal;
    resetStorageForTests();
  }
}

test("an upload over the monthly quota offers the upgrade card for the channel or thread it named", async ({ app }) => {
  await withLocalUploads(async () => {
    const { owner, server, agent, room, apiKey } = await seedWorld();
    await useUpQuota(server.id);

    const inRoom = await refusal(await upload(app.baseUrl, apiKey, room.id), 403);
    assert.equal(inRoom.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
    assert.equal(inRoom.error, FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE);
    const roomHint = uploadCardHint("upload_monthly_quota", `#${room.name}`);
    assert.equal(inRoom.suggestedNextAction, roomHint);

    const root = await createMessage(room.id, "user", owner.id, "Can you attach the weekly report?");
    const thread = await channelService.getOrCreateThreadForChannel(room.id, root.id, agent.id, "agent");
    const inThread = await refusal(await upload(app.baseUrl, apiKey, thread.id), 403);
    assert.equal(inThread.suggestedNextAction, uploadCardHint("upload_monthly_quota", `#${room.name}:${root.id.slice(0, 8)}`));

    // An older daemon uploads through the legacy route, with its computer's key.
    const { machine, apiKey: computerKey } = await registerMachine(server.id, owner.id, "upload-hint-computer");
    await placeAgentOnMachine(agent.id, machine.id);
    const legacy = await refusal(await upload(app.baseUrl, computerKey, room.id, `/internal/agent/${agent.id}/upload`), 403);
    assert.equal(legacy.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
    assert.equal(legacy.suggestedNextAction, roomHint);
  });
});

test("over the quota, a person's web upload is told to ask a server owner; the agent's upload says why and may suggest Pro", async ({ app }) => {
  await withLocalUploads(async () => {
    const { owner, server, room, apiKey } = await seedWorld();
    await useUpQuota(server.id);

    // (i) The web app's upload route: a person's line.
    const form = new FormData();
    form.append("channelId", room.id);
    form.append("files", new Blob([Buffer.from("weekly report")], { type: "text/plain" }), "report.txt");
    const web = await refusal(await fetch(`${app.baseUrl}/api/attachments/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: form,
    }), 403);
    assert.equal(web.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
    assert.equal(web.error, FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE);
    assert.match(web.billingUrl ?? "", new RegExp(`/s/${server.slug}/settings/billing$`));
    assert.equal(web.suggestedNextAction, `Ask a server owner to open Settings > Billing and upgrade to Pro: ${web.billingUrl}`);

    // The agent's, from a client that can't post a card: the agent's line, same link.
    const agent = await refusal(await upload(app.baseUrl, apiKey, room.id, undefined, UNDECLARED), 403);
    assert.equal(agent.billingUrl, web.billingUrl);
    assertBillingLine(agent, server.slug);
  });
});

test("over the quota in a conversation in its upgrade-card cooldown, the refusal keeps the billing line", async ({ app }) => {
  await withLocalUploads(async () => {
    const { owner, server, agent, room, apiKey } = await seedWorld();
    await useUpQuota(server.id);
    const other = await channelService.createChannel(server.id, `upload-other-${randomUUID().slice(0, 6)}`);
    await channelService.addHuman(other.id, owner.id);
    await channelService.addAgent(other.id, agent.id);

    // An upgrade card the agent offered there earlier, for another limit.
    await prepareActionCard({
      serverId: server.id,
      requesterAgentId: agent.id,
      targetChannelId: room.id,
      action: { type: "plan:upgrade", gate: "history_30d", reason: "You asked for last quarter's launch notes, which are older than 30 days." },
    });
    // (g) Prepare would refuse another card there: the non-card line, on the multipart and session routes.
    assertBillingLine(await refusal(await upload(app.baseUrl, apiKey, room.id), 403), server.slug);
    assertBillingLine(await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024), 403), server.slug);
    // A file over the per-file limit gets no card either.
    assert.equal((await refusal(await createSession(app.baseUrl, apiKey, room.id, FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES + 1), 413)).suggestedNextAction, undefined);
    // Another conversation still gets the card.
    assert.equal((await refusal(await upload(app.baseUrl, apiKey, other.id), 403)).suggestedNextAction, uploadCardHint("upload_monthly_quota", `#${other.name}`));
  });
});

test("an upload session refused by a Free limit says which one and offers the card", async ({ app }) => {
  const { server, room, apiKey } = await seedWorld();

  // Over the Free plan's per-file limit (the CLI declares such a file): 413
  // with the multipart route's size refusal and the file-size card.
  const tooLarge = await refusal(await createSession(app.baseUrl, apiKey, room.id, FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES + 1), 413);
  assert.equal(tooLarge.code, "UPLOAD_TOO_LARGE");
  assert.equal(tooLarge.errorCode, "ATTACHMENT_TOO_LARGE");
  assert.equal(tooLarge.error, tooLarge.message);
  const fileSizeHint = uploadCardHint("upload_file_size", `#${room.name}`);
  assert.equal(tooLarge.suggestedNextAction, fileSizeHint);
  // With direct uploads, Pro takes a file past the multipart cap too.
  const pastMultipartCap = await refusal(await createSession(app.baseUrl, apiKey, room.id, PRO_MULTIPART_LIMIT_BYTES + 1), 413);
  assert.equal(pastMultipartCap.suggestedNextAction, fileSizeHint);

  // Over the monthly quota: the quota refusal with the card, not "cannot upload to this channel".
  await useUpQuota(server.id);
  const overQuota = await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024), 403);
  assert.equal(overQuota.code, "UPLOAD_FORBIDDEN");
  assert.equal(overQuota.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(overQuota.error, FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE);
  assert.equal(overQuota.suggestedNextAction, uploadCardHint("upload_monthly_quota", `#${room.name}`));

  // A channel the agent can't post to stays a plain refusal, now with an `error` the CLI shows.
  const elsewhere = await channelService.createChannel(server.id, `upload-elsewhere-${randomUUID().slice(0, 6)}`);
  const forbidden = await refusal(await createSession(app.baseUrl, apiKey, elsewhere.id, 1024), 403);
  assert.equal(forbidden.code, "UPLOAD_FORBIDDEN");
  assert.equal(forbidden.error, "The agent cannot upload to this channel.");
  assert.equal(forbidden.suggestedNextAction, undefined);
});

test("over the quota, a DM gets the card with the DM target the agent writes; a shared channel gets the billing line", async ({ app }) => {
  const { owner, server, agent, apiKey } = await seedWorld();
  await useUpQuota(server.id);

  const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  const inDm = await refusal(await createSession(app.baseUrl, apiKey, dm.id, 1024), 403);
  assert.equal(inDm.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(inDm.suggestedNextAction, uploadCardHint("upload_monthly_quota", `dm:@${owner.name}`));

  // No card in a conversation shared with another server: prepare would refuse it there.
  const peer = await createServer("Upload Hint Peer", `upload-hint-peer-${randomUUID().slice(0, 8)}`, owner.id);
  const joint = await seedJointChannel({ name: `upload-joint-${randomUUID().slice(0, 6)}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  await channelService.addHuman(local.id, owner.id);
  await channelService.addAgent(local.id, agent.id);
  const inJoint = await refusal(await createSession(app.baseUrl, apiKey, local.id, 1024), 403);
  assert.equal(inJoint.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assertBillingLine(inJoint, server.slug);
});

test("over the quota, the card goes only to a client that can post it: one that declares so, or an agent on Computer 1.0.53 or later", async ({ app }) => {
  await withLocalUploads(async () => {
    const { owner, server, agent, room, apiKey } = await seedWorld();
    await useUpQuota(server.id);
    const roomHint = uploadCardHint("upload_monthly_quota", `#${room.name}`);

    // (a) The current CLI declares it; the agent has no Computer, so its version is unknown.
    assert.equal((await refusal(await upload(app.baseUrl, apiKey, room.id), 403)).suggestedNextAction, roomHint, "multipart, declared");
    assert.equal((await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024), 403)).suggestedNextAction, roomHint, "session, declared");

    // (d) No declaration and no known Computer: the billing line, on every route; no header at all is the same.
    assertBillingLine(await refusal(await upload(app.baseUrl, apiKey, room.id, undefined, UNDECLARED), 403), server.slug);
    assertBillingLine(await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024, UNDECLARED), 403), server.slug);
    assertBillingLine(await refusal(await upload(app.baseUrl, apiKey, room.id, undefined, null), 403), server.slug);
    assertBillingLine(await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024, null), 403), server.slug);

    // (c) No declaration, on Computer 1.0.52 (its CLI refuses plan:upgrade locally): the billing line.
    const { machine, apiKey: computerKey } = await onComputer(server.id, owner.id, agent.id, "1.0.52");
    assertBillingLine(await refusal(await upload(app.baseUrl, apiKey, room.id, undefined, UNDECLARED), 403), server.slug);
    assertBillingLine(await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024, UNDECLARED), 403), server.slug);
    assertBillingLine(await refusal(await upload(app.baseUrl, computerKey, room.id, `/internal/agent/${agent.id}/upload`, UNDECLARED), 403), server.slug);
    // A prerelease of 1.0.53 sorts below it, as a staging build from before the type may: still the billing line.
    await recordMachineComputerVersion(machine.id, "1.0.53-rc.1");
    assertBillingLine(await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024, UNDECLARED), 403), server.slug);

    // (b) No declaration, on Computer 1.0.53 (it posts plan:upgrade but declares nothing): the card.
    await recordMachineComputerVersion(machine.id, "1.0.53");
    assert.equal((await refusal(await upload(app.baseUrl, apiKey, room.id, undefined, UNDECLARED), 403)).suggestedNextAction, roomHint, "multipart, 1.0.53");
    assert.equal((await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024, UNDECLARED), 403)).suggestedNextAction, roomHint, "session, 1.0.53");
    assert.equal((await refusal(await upload(app.baseUrl, computerKey, room.id, `/internal/agent/${agent.id}/upload`, UNDECLARED), 403)).suggestedNextAction, roomHint, "legacy route, 1.0.53");

    // (f) A prerelease of a later version counts.
    await recordMachineComputerVersion(machine.id, "1.0.54-rc.1");
    assert.equal((await refusal(await createSession(app.baseUrl, apiKey, room.id, 1024, UNDECLARED), 403)).suggestedNextAction, roomHint, "1.0.54-rc.1");
  });
});

test("a file over the Free per-file limit from a client that can't post the card is refused without one", async ({ app }) => {
  const { owner, server, agent, room, apiKey } = await seedWorld();
  const fileSizeHint = uploadCardHint("upload_file_size", `#${room.name}`);
  const size = FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES + 1;

  const unknown = await refusal(await createSession(app.baseUrl, apiKey, room.id, size, UNDECLARED), 413);
  assert.equal(unknown.code, "UPLOAD_TOO_LARGE");
  assert.equal(unknown.suggestedNextAction, undefined, "no known Computer");
  const { machine } = await onComputer(server.id, owner.id, agent.id, "1.0.52");
  assert.equal((await refusal(await createSession(app.baseUrl, apiKey, room.id, size, UNDECLARED), 413)).suggestedNextAction, undefined, "Computer 1.0.52");

  await recordMachineComputerVersion(machine.id, "1.0.53");
  assert.equal((await refusal(await createSession(app.baseUrl, apiKey, room.id, size, UNDECLARED), 413)).suggestedNextAction, fileSizeHint, "Computer 1.0.53");
  assert.equal((await refusal(await createSession(app.baseUrl, apiKey, room.id, size), 413)).suggestedNextAction, fileSizeHint, "declared");
});

// An upload session service without direct uploads: uploads go multipart, so Pro's limit is the multipart cap.
const testMultipartOnly = createApiTest({ attachmentUploadSessionService: sessionServiceWith(false) });

testMultipartOnly("where uploads go multipart, a file Pro would refuse too gets no card", async ({ app }) => {
  const { room, apiKey } = await seedWorld();
  const fileSizeHint = uploadCardHint("upload_file_size", `#${room.name}`);
  const withinPro = await refusal(await createSession(app.baseUrl, apiKey, room.id, FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES + 1), 413);
  assert.equal(withinPro.suggestedNextAction, fileSizeHint);
  const pastPro = await refusal(await createSession(app.baseUrl, apiKey, room.id, PRO_MULTIPART_LIMIT_BYTES + 1), 413);
  assert.equal(pastPro.code, "UPLOAD_TOO_LARGE");
  assert.equal(pastPro.suggestedNextAction, undefined, "upgrading would not take it");
});

// No upload session service: the agent API uploads multipart at the plan's own limit.
const testWithoutDirectUploads = createApiTest();

testWithoutDirectUploads("a file over the Free plan's per-file limit is refused with the card where there is no upload session service", async ({ app }) => {
  const { room, apiKey } = await seedWorld();
  const fileSizeHint = uploadCardHint("upload_file_size", `#${room.name}`);
  const tooLarge = await refusal(await createSession(app.baseUrl, apiKey, room.id, FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES + 1), 413);
  assert.equal(tooLarge.code, "UPLOAD_TOO_LARGE");
  assert.equal(tooLarge.suggestedNextAction, fileSizeHint);
  // The agent API's multipart upload takes Pro's own limit (not the browser's multipart cap).
  const pastMultipartCap = await refusal(await createSession(app.baseUrl, apiKey, room.id, PRO_MULTIPART_LIMIT_BYTES + 1), 413);
  assert.equal(pastMultipartCap.suggestedNextAction, fileSizeHint);
  // A file the plan takes still learns that direct uploads are off.
  const fits = await createSession(app.baseUrl, apiKey, room.id, 1024);
  assert.equal(fits.status, 404);
  assert.equal(((await fits.json()) as Refusal).code, "UPLOAD_SESSION_NOT_FOUND");
});

// A service whose capabilities read fails: the size refusal stands, without the card.
const testCapabilitiesFailing = createApiTest({
  attachmentUploadSessionService: { ...sessionServiceWith(true), capabilities: async () => { throw new Error("capabilities unavailable"); } },
});

testCapabilitiesFailing("a size refusal that can't tell what Pro would take still refuses, with no card", async ({ app }) => {
  const { room, apiKey } = await seedWorld();
  const tooLarge = await refusal(await createSession(app.baseUrl, apiKey, room.id, FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES + 1), 413);
  assert.equal(tooLarge.code, "UPLOAD_TOO_LARGE");
  assert.equal(tooLarge.suggestedNextAction, undefined);
});
