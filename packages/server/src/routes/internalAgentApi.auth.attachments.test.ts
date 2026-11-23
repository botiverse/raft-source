// Agent API auth suite: attachment upload and download.
// Shared fixtures: ./internalAgentApi.auth.testkit.ts.
import { createApiTest } from "../test/integration/apiTest";
import { insertAttachmentsWithObjects, insertLinkedAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { attachmentObjects, attachments, jointChannels, jointChannelServers, users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";
import {
  ATTACHMENT_STORAGE_KEY_PREFIX,
  __setStorageForTests,
  resetStorageForTests,
  type StorageBackend,
} from "../services/storageService";
import type {
  AttachmentUploadSessionContext,
  AttachmentUploadSessionResult,
  AttachmentUploadSessionService,
  CreateAttachmentUploadSessionInput,
} from "./attachmentUploadSessions";
import { jsonHeaders, mintAgentKey, seedAuthFixture } from "./internalAgentApi.auth.testkit";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("agent-api attachment upload uses the id-less route and bound agent identity", async () => {
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-api-upload-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fixture = await seedAuthFixture();
    const uploadBody = new FormData();
    uploadBody.append("channelId", fixture.channelId);
    uploadBody.append("mimeType", "text/plain");
    uploadBody.append("file", new Blob([Buffer.from("native agent upload")], { type: "text/plain" }), "native.txt");

    const res = await fetch(`${app.baseUrl}/internal/agent-api/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.agentApiKey}`,
      },
      body: uploadBody,
    });
    const responseText = await res.text();
    assert.equal(res.status, 200, `expected upload 200, got ${res.status}: ${responseText}`);
    const body = JSON.parse(responseText) as {
      id: string;
      filename: string;
      mimeType: string | null;
      sizeBytes: number;
      thumbnailUrl: string | null;
    };
    assert.equal(body.filename, "native.txt");
    assert.equal(body.mimeType, "text/plain");
    assert.equal(body.sizeBytes, "native agent upload".length);
    assert.equal(body.thumbnailUrl, null);

    const [row] = await getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.id, body.id))
      .limit(1);
    assert.ok(row, "uploaded attachment row should be inserted");
    assert.equal(row.channelId, fixture.channelId);
    assert.equal(row.uploaderId, fixture.agentId);
    assert.equal(row.uploaderType, "agent");
    const [object] = await getDb()
      .select()
      .from(attachmentObjects)
      .where(eq(attachmentObjects.id, row.objectId))
      .limit(1);
    assert.ok(object, "uploaded attachment object row should be inserted");
    assert.ok(object.storageKey.startsWith(`${ATTACHMENT_STORAGE_KEY_PREFIX}${fixture.serverId}/server/${body.id}/`));
    assert.ok(object.storageKey.endsWith(".txt"));
    assert.equal(fs.existsSync(path.join(uploadsDir, object.storageKey)), true);
  } finally {
    await app.close();
    resetStorageForTests();
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    if (previousUploadsLocal === undefined) delete process.env.UPLOADS_LOCAL;
    else process.env.UPLOADS_LOCAL = previousUploadsLocal;
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("agent-api exposes server-owned upload capability and binds direct sessions to the credential agent", async () => {
  const calls: Array<{ operation: string; context: AttachmentUploadSessionContext; uploadId?: string }> = [];
  const uploadId = "33333333-3333-4333-8333-333333333333";
  const attachmentId = "44444444-4444-4444-8444-444444444444";
  const fake: AttachmentUploadSessionService = {
    async listActive(_context, _channelId): Promise<AttachmentUploadSessionResult> {
      return { status: 200, body: { sessions: [] } };
    },
    async capabilities(context): Promise<AttachmentUploadSessionResult> {
      calls.push({ operation: "capabilities", context });
      return { status: 200, body: { directUploadEnabled: true, directUploadThresholdBytes: 1, maxBytes: 50 * 1024 * 1024, sessionExpiresInSeconds: 900 } };
    },
    async create(context, _input: CreateAttachmentUploadSessionInput): Promise<AttachmentUploadSessionResult> {
      calls.push({ operation: "create", context });
      return { status: 201, body: { uploadId, attachmentId, state: "pending", expiresAt: "2026-07-27T08:00:00.000Z", upload: { method: "PUT", url: "https://r2.example.test/presigned", headers: { "Content-Type": "text/plain", "If-None-Match": "*" } } } };
    },
    async complete(context, requestedUploadId): Promise<AttachmentUploadSessionResult> {
      calls.push({ operation: "complete", context, uploadId: requestedUploadId });
      return { status: 200, body: { uploadId, state: "completed", attachment: { id: attachmentId, filename: "agent.txt", mimeType: "text/plain", sizeBytes: 5, thumbnailUrl: null } } };
    },
    async cancel(context, requestedUploadId): Promise<AttachmentUploadSessionResult> {
      calls.push({ operation: "cancel", context, uploadId: requestedUploadId });
      return { status: 200, body: { uploadId, state: "canceled", expiresAt: "2026-07-27T08:00:00.000Z", attachment: null, terminalReason: "Canceled." } };
    },
    async status(context, requestedUploadId): Promise<AttachmentUploadSessionResult> {
      calls.push({ operation: "status", context, uploadId: requestedUploadId });
      return { status: 200, body: { uploadId, state: "pending", expiresAt: "2026-07-27T08:00:00.000Z", attachment: null, terminalReason: null } };
    },
  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, attachmentUploadSessionService: fake });
  try {
    const fixture = await seedAuthFixture();
    const headers = jsonHeaders(fixture.agentApiKey);
    const capability = await fetch(`${app.baseUrl}/internal/agent-api/attachment-upload-capabilities`, { headers });
    assert.equal(capability.status, 200);
    assert.equal((await capability.json() as { directUploadThresholdBytes: number }).directUploadThresholdBytes, 1);

    const created = await fetch(`${app.baseUrl}/internal/agent-api/attachment-upload-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        channelId: fixture.channelId,
        filename: "agent.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        clientRequestId: "22222222-2222-4222-8222-222222222222",
      }),
    });
    assert.equal(created.status, 201, await created.text());

    const completed = await fetch(`${app.baseUrl}/internal/agent-api/attachment-upload-sessions/${uploadId}/complete`, {
      method: "POST",
      headers,
    });
    assert.equal(completed.status, 200, await completed.text());
    assert.deepEqual(calls.map(({ operation, context }) => ({ operation, context })), [
      { operation: "capabilities", context: { serverId: fixture.serverId, agentId: fixture.agentId } },
      { operation: "create", context: { serverId: fixture.serverId, agentId: fixture.agentId } },
      { operation: "complete", context: { serverId: fixture.serverId, agentId: fixture.agentId } },
    ]);
  } finally {
    await app.close();
  }
});

test("agent-api still publishes the plan upload limit when direct sessions are hard-off", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const response = await fetch(`${app.baseUrl}/internal/agent-api/attachment-upload-capabilities`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    directUploadEnabled: false,
    directUploadThresholdBytes: null,
    maxBytes: 50 * 1024 * 1024,
    sessionExpiresInSeconds: null,
  });
});

test("agent-api attachment download serves unicode pdf filenames", async () => {
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-api-attachments-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fixture = await seedAuthFixture();
    const pdfId = "00000000-0000-4000-8000-000000000099";
    const pdfBuffer = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const storageDir = path.join(uploadsDir, fixture.serverId);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(storageDir, `${pdfId}.pdf`), pdfBuffer);

    const db = getDb();
    await insertLinkedAttachmentsWithObjects({
      id: pdfId,
      channelId: fixture.channelId,
      uploaderId: fixture.agentId,
      uploaderType: "agent",
      filename: "这文件里有什么.pdf",
      mimeType: "application/pdf",
      sizeBytes: pdfBuffer.length,
      storageKey: `${fixture.serverId}/${pdfId}.pdf`,
      thumbnailKey: null,
      contentHash: "hash-agent-unicode-pdf",
    });

    const res = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${pdfId}`, {
      headers: jsonHeaders(fixture.agentApiKey),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="/);
    assert.match(res.headers.get("content-disposition") ?? "", /filename\*=UTF-8''/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), pdfBuffer);
  } finally {
    await app.close();
    resetStorageForTests();
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    if (previousUploadsLocal === undefined) delete process.env.UPLOADS_LOCAL;
    else process.env.UPLOADS_LOCAL = previousUploadsLocal;
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("agent-api attachment download redirects only after cloaked access and keeps local streaming fallback", async ({ app }) => {

  const signedUrl = "https://objects.example.test/private/object?X-Amz-Signature=do-not-log-this";
  const consoleErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  try {
    const fixture = await seedAuthFixture();
    const attachmentId = randomUUID();
    const privateAttachmentId = randomUUID();
    const payload = Buffer.from("agent attachment direct-download bytes");
    await insertLinkedAttachmentsWithObjects({
      id: attachmentId,
      channelId: fixture.channelId,
      uploaderId: fixture.agentId,
      uploaderType: "agent",
      filename: "direct download.txt",
      mimeType: "text/plain",
      sizeBytes: payload.length,
      storageKey: `${fixture.serverId}/${attachmentId}.txt`,
      thumbnailKey: null,
      contentHash: "hash-agent-direct-download",
    });

    const privateChannel = await createChannel(
      fixture.serverId,
      `agent-api-private-direct-${randomUUID()}`,
      "private direct-download cloak",
      "private",
    );
    await addHuman(privateChannel.id, fixture.ownerId);
    await insertLinkedAttachmentsWithObjects({
      id: privateAttachmentId,
      channelId: privateChannel.id,
      uploaderId: fixture.ownerId,
      uploaderType: "user",
      filename: "private.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      storageKey: `${fixture.serverId}/${privateAttachmentId}.txt`,
      thumbnailKey: null,
      contentHash: "hash-agent-private-direct-download",
    });

    const presigns: Array<{
      key: string;
      options: {
        expiresIn?: number;
        responseContentDisposition?: string;
        responseContentType?: string;
      } | undefined;
    }> = [];
    let storageGets = 0;
    const redirectStorage: StorageBackend = {
      put: async () => {},
      get: async () => {
        storageGets += 1;
        return Readable.from(payload);
      },
      delete: async () => {},
      getPresignedUrl: async (key, options) => {
        presigns.push({ key, options });
        return signedUrl;
      },
    };
    __setStorageForTests(redirectStorage);

    const redirect = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${attachmentId}`, {
      headers: jsonHeaders(fixture.readOnlyApiKey),
      redirect: "manual",
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), signedUrl);
    assert.equal(redirect.headers.get("cache-control"), "private, no-store");
    assert.equal(await redirect.text(), "", "redirect response must not duplicate the signed URL in a body");
    assert.equal(storageGets, 0, "object storage bytes must not traverse the server on the direct path");
    assert.deepEqual(presigns, [{
      key: `${fixture.serverId}/${attachmentId}.txt`,
      options: {
        expiresIn: 300,
        responseContentDisposition: "attachment; filename=\"direct download.txt\"; filename*=UTF-8''direct%20download.txt",
        responseContentType: "text/plain; charset=utf-8",
      },
    }]);

    for (const hiddenId of [privateAttachmentId, randomUUID(), "e66f3b51"]) {
      const hidden = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${hiddenId}`, {
        headers: jsonHeaders(fixture.readOnlyApiKey),
        redirect: "manual",
      });
      assert.equal(hidden.status, 404);
      assert.deepEqual(await hidden.json(), AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE);
    }
    assert.equal(presigns.length, 1, "missing, malformed, and denied resources must never reach presigning");

    __setStorageForTests({
      ...redirectStorage,
      getPresignedUrl: async () => {
        throw new Error(`presign failed for ${signedUrl}`);
      },
    });
    console.error = (...args: unknown[]) => { consoleErrors.push(args); };
    const failed = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${attachmentId}`, {
      headers: jsonHeaders(fixture.readOnlyApiKey),
      redirect: "manual",
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Failed to serve attachment" });
    assert.doesNotMatch(JSON.stringify(consoleErrors), /X-Amz-Signature|do-not-log-this/);

    let localGets = 0;
    __setStorageForTests({
      put: async () => {},
      get: async () => {
        localGets += 1;
        return Readable.from(payload);
      },
      delete: async () => {},
    });
    const streamed = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${attachmentId}`, {
      headers: jsonHeaders(fixture.readOnlyApiKey),
    });
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get("content-length"), String(payload.length));
    assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), payload);
    assert.equal(localGets, 1);
  } finally {
    console.error = originalConsoleError;
    resetStorageForTests();
    await app.close();
  }
});

test("agent-api attachment download allows linked joint attachments through the agent's local projection", async () => {
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-api-joint-attachments-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const suffix = randomUUID();
    const [hostOwner] = await db.insert(users).values({
      email: `agent-api-joint-host-${suffix}@slock.test`,
      name: `agent-api-joint-host-${suffix}`,
      displayName: "Agent API Joint Host",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [peerOwner] = await db.insert(users).values({
      email: `agent-api-joint-peer-${suffix}@slock.test`,
      name: `agent-api-joint-peer-${suffix}`,
      displayName: "Agent API Joint Peer",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const hostServer = await createServer("Agent API Joint Host", `agent-api-joint-host-${suffix}`, hostOwner.id);
    const peerServer = await createServer("Agent API Joint Peer", `agent-api-joint-peer-${suffix}`, peerOwner.id);
    const hostAgent = await createAgent(hostServer.id, "host-joint-agent", { runtime: "claude", model: "sonnet" });
    const peerAgent = await createAgent(peerServer.id, "peer-joint-agent", { runtime: "claude", model: "sonnet" });
    const peerReadKey = await mintAgentKey(peerAgent.id, ["read"]);

    const canonical = await createChannel(hostServer.id, `joint-storage-${suffix}`, undefined, "channel");
    const hostProjection = await createChannel(hostServer.id, `joint-host-${suffix}`, undefined, "joint");
    const peerProjection = await createChannel(peerServer.id, `joint-peer-${suffix}`, undefined, "joint");

    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonical.id,
      createdByServerId: hostServer.id,
      createdByUserId: hostOwner.id,
    }).returning();
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: joint.id,
        serverId: hostServer.id,
        localChannelId: hostProjection.id,
        role: "host",
        joinedByUserId: hostOwner.id,
      },
      {
        jointChannelId: joint.id,
        serverId: peerServer.id,
        localChannelId: peerProjection.id,
        role: "participant",
        joinedByUserId: peerOwner.id,
      },
    ]);
    await addAgent(hostProjection.id, hostAgent.id);
    await addAgent(peerProjection.id, peerAgent.id);

    const message = await createMessage(canonical.id, "agent", hostAgent.id, "joint attachment from host agent");
    const attachmentId = "00000000-0000-4000-8000-000000000199";
    const draftAttachmentId = "00000000-0000-4000-8000-000000000198";
    const payload = Buffer.from("joint attachment bytes");
    const storageDir = path.join(uploadsDir, hostServer.id);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(storageDir, `${attachmentId}.txt`), payload);
    fs.writeFileSync(path.join(storageDir, `${draftAttachmentId}.txt`), payload);

    await insertAttachmentsWithObjects(getDb(), [
      {
        id: attachmentId,
        messageId: message.id,
        channelId: hostProjection.id,
        uploaderId: hostAgent.id,
        uploaderType: "agent",
        filename: "joint-agent.txt",
        mimeType: "text/plain",
        sizeBytes: payload.length,
        storageKey: `${hostServer.id}/${attachmentId}.txt`,
        thumbnailKey: null,
        contentHash: "hash-agent-joint-linked",
      },
      {
        id: draftAttachmentId,
        channelId: hostProjection.id,
        uploaderId: hostAgent.id,
        uploaderType: "agent",
        filename: "joint-agent-draft.txt",
        mimeType: "text/plain",
        sizeBytes: payload.length,
        storageKey: `${hostServer.id}/${draftAttachmentId}.txt`,
        thumbnailKey: null,
        contentHash: "hash-agent-joint-draft",
      },
    ]);

    const res = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${attachmentId}`, {
      headers: jsonHeaders(peerReadKey),
    });
    assert.equal(res.status, 200, `linked joint attachment should be readable by peer agent, got ${res.status}`);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), payload);

    const draftRes = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${draftAttachmentId}`, {
      headers: jsonHeaders(peerReadKey),
    });
    assert.equal(draftRes.status, 404, "unlinked joint draft attachment must stay cloaked from peer agents");
  } finally {
    await app.close();
    resetStorageForTests();
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    if (previousUploadsLocal === undefined) delete process.env.UPLOADS_LOCAL;
    else process.env.UPLOADS_LOCAL = previousUploadsLocal;
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("agent-api attachment download releases its real upstream Agent socket when the client aborts", async ({ app }) => {
  const harness = await createHangingStorageTestHarness();
  try {
    const fixture = await seedAuthFixture();
    const message = await createMessage(
      fixture.channelId,
      "user",
      fixture.ownerId,
      "agent API hanging attachment",
    );
    const attachmentId = randomUUID();
    await insertLinkedAttachmentsWithObjects({
      id: attachmentId,
      messageId: message.id,
      channelId: fixture.channelId,
      uploaderId: fixture.ownerId,
      uploaderType: "user",
      filename: "hanging-agent-download.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1024 * 1024,
      storageKey: `${fixture.serverId}/${attachmentId}.bin`,
      contentHash: "hangingagentdownload",
    });
    __setStorageForTests(harness.storage);

    await harness.abortDownload(
      `${app.baseUrl}/internal/agent-api/attachments/${attachmentId}`,
      { headers: jsonHeaders(fixture.readOnlyApiKey) },
      (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "application/octet-stream");
        assert.equal(response.headers.get("content-length"), String(1024 * 1024));
        assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
      },
    );
  } finally {
    await harness.close();
    resetStorageForTests();
  }
});

test("agent-api attachment download cloaks inaccessible attachment ids", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const privateChannel = await createChannel(
    fixture.serverId,
    `agent-api-private-attachments-${randomUUID()}`,
    "private attachment ids",
    "private",
  );
  await addHuman(privateChannel.id, fixture.ownerId);
  const privateMessage = await createMessage(
    privateChannel.id,
    "user",
    fixture.ownerId,
    "private attachment holder",
  );
  const privateAttachmentId = randomUUID();
  await insertLinkedAttachmentsWithObjects({
    id: privateAttachmentId,
    messageId: privateMessage.id,
    channelId: privateChannel.id,
    uploaderId: fixture.ownerId,
    uploaderType: "user",
    filename: "private.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    storageKey: `${fixture.serverId}/${privateAttachmentId}.txt`,
    thumbnailKey: null,
    contentHash: "hash-agent-private-cloak",
  });

  const inaccessible = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${privateAttachmentId}`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(inaccessible.status, 404);
  const inaccessibleBody = await inaccessible.json();
  assert.deepEqual(inaccessibleBody, AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE);

  const missing = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${randomUUID()}`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.deepEqual(missingBody, AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE);

  const malformed = await fetch(`${app.baseUrl}/internal/agent-api/attachments/e66f3b51`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(malformed.status, 404);
  const malformedBody = await malformed.json();
  assert.deepEqual(malformedBody, AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE);
  assert.deepEqual(inaccessibleBody, missingBody);
  assert.deepEqual(missingBody, malformedBody);
});
