import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { accessTokenForTest, signInForTest, tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as XLSX from "xlsx";
import jwt from "jsonwebtoken";
import { ATTACHMENT_PREVIEW_BRIDGE_SCRIPT } from "../services/attachmentPreviewBridge";
import { eq, inArray } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness";
import { getDb } from "../db/index";
import { insertAttachmentsWithObjects, insertLinkedAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { attachmentObjects, attachmentPreviewCache, attachments, jointChannels, jointChannelServers, machines, servers, users } from "../db/schema";
import { revokeAllUserSessions } from "../services/sessionService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { clearAuthCache, registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import { XLSX_PREVIEW_MAX_FILE_SIZE_BYTES, asServerId } from "@botiverse/raft-shared";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import {
  buildServerAttachmentStorageKey,
  createAttachmentStorageRouter,
  __setStorageForTests,
  resetStorageForTests,
  type StorageBackend,
} from "../services/storageService";
import { WorkerPoolBusy } from "../services/workerPool/errors";
import { setServerWorkerPoolForTests } from "../services/workerPool/serverWorkerPool";
import type { WorkerPoolService } from "../services/workerPool/workerPoolService";
import {
  ATTACHMENT_UPLOAD_DISABLED_MESSAGE,
  ATTACHMENT_MEDIA_PREVIEW_PRESIGNED_URL_TTL_SECONDS,
  ATTACHMENT_PRESIGNED_URL_TTL_SECONDS,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_ATTACHMENT_UPLOAD_FILES,
  getAttachmentStreamingBaseUrl,
  isHtmlAttachmentMimeType,
  resolveAttachmentMimeType,
  shouldStreamAttachmentThroughServerForRequest,
} from "./attachments";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * Regression tests for #proj-security task #10 (2026-04-19):
 *
 *   Prior to this fix, an authenticated user on server A could download an
 *   attachment UUID belonging to server B, because `canUserAccessChannel`
 *   returned true for any `type="channel"` without a serverId check, and the
 *   `/api/attachments/:id{/url}` download endpoints ran under `requireFlexAuth`
 *   alone (no `requireServer`). The fix:
 *     - `canUserAccessChannel` now takes a mandatory `serverId` and rejects
 *       channels that don't belong to it.
 *     - `requireServerForFlex` middleware enforces X-Server-Id (or `serverId`
 *       query param) + membership for user-auth on the attachment router.
 *
 * These tests assert both legs of the cross-server attack are now blocked.
 */




async function seedCrossServerFixture() {
  const db = getDb();

  const [userA] = await db
    .insert(users)
    .values({
      email: "cross-server-a@slock.test",
      name: "cross-server-a",
      displayName: "A",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();

  const [userB] = await db
    .insert(users)
    .values({
      email: "cross-server-b@slock.test",
      name: "cross-server-b",
      displayName: "B",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();

  const serverA = await createServer("Alpha", "cross-server-alpha", userA.id);
  const serverB = await createServer("Bravo", "cross-server-bravo", userB.id);

  const channelB = await createChannel(serverB.id, "secret-b", "channel");

  await addHuman(channelB.id, userB.id);
  const attachmentId = "00000000-0000-4000-8000-000000000001";
  await insertLinkedAttachmentsWithObjects({
    id: attachmentId,
    channelId: channelB.id,
    uploaderId: userB.id,
    uploaderType: "user",
    filename: "secret.txt",
    mimeType: "text/plain",
    sizeBytes: 42,
    storageKey: `${serverB.id}/secret.txt`,
    thumbnailKey: null,
    contentHash: "deadbeef",
  });

  return {
    userA,
    userB,
    serverA,
    serverB,
    channelB,
    attachmentId,
  };
}

test("attachment URL route passes the bounded five-minute TTL to storage", async ({ app }) => {

  try {
    const { userB, serverB, attachmentId } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const presignCalls: Array<{
      key: string;
      options: Parameters<NonNullable<StorageBackend["getPresignedUrl"]>>[1];
    }> = [];
    __setStorageForTests({
      async put() {},
      async get() {
        throw new Error("streaming is not expected");
      },
      async delete() {},
      async getPresignedUrl(key, options) {
        presignCalls.push({ key, options });
        return "https://storage.example.test/presigned";
      },
    });

    const res = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}/url`, {
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "X-Server-Id": serverB.id,
      },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(presignCalls, [
      {
        key: `${serverB.id}/secret.txt`,
        options: {
          expiresIn: ATTACHMENT_PRESIGNED_URL_TTL_SECONDS,
          responseContentDisposition: "attachment; filename=\"secret.txt\"; filename*=UTF-8''secret.txt",
          responseContentType: "text/plain; charset=utf-8",
        },
      },
    ]);
    assert.equal(presignCalls[0]?.options?.expiresIn, 300);
  } finally {
    await app.close();
    resetStorageForTests();
  }
});

test("inline video/audio preview URLs get the one-hour TTL; downloads and other types keep five minutes", async ({ app }) => {
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const files = [
      { id: "00000000-0000-4000-8000-0000000000a1", filename: "clip.mp4", mimeType: "video/mp4" },
      { id: "00000000-0000-4000-8000-0000000000a2", filename: "voice.mp3", mimeType: "audio/mpeg" },
      { id: "00000000-0000-4000-8000-0000000000a3", filename: "doc.pdf", mimeType: "application/pdf" },
    ];
    for (const file of files) {
      await insertLinkedAttachmentsWithObjects({
        id: file.id,
        channelId: channelB.id,
        uploaderId: userB.id,
        uploaderType: "user",
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: 42,
        storageKey: `${serverB.id}/${file.filename}`,
        thumbnailKey: null,
        contentHash: `hash-${file.filename}`,
      });
    }
    const presigned: number[] = [];
    __setStorageForTests({
      async put() {},
      async get() {
        throw new Error("streaming is not expected");
      },
      async delete() {},
      async getPresignedUrl(_key, options) {
        presigned.push(options?.expiresIn ?? -1);
        return "https://storage.example.test/presigned";
      },
    });

    const ttlFor = async (id: string, query: string) => {
      const before = presigned.length;
      const res = await fetch(`${app.baseUrl}/api/attachments/${id}/url${query}`, {
        headers: { Authorization: `Bearer ${tokenB}`, "X-Server-Id": serverB.id },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { expiresAt: string };
      assert.equal(presigned.length, before + 1);
      const expiresIn = presigned[before];
      const expiresAtDeltaSeconds = (Date.parse(body.expiresAt) - Date.now()) / 1000;
      assert.ok(Math.abs(expiresAtDeltaSeconds - expiresIn) < 30, "expiresAt matches the signed TTL");
      return expiresIn;
    };

    assert.equal(ATTACHMENT_MEDIA_PREVIEW_PRESIGNED_URL_TTL_SECONDS, 3600);
    assert.equal(await ttlFor(files[0].id, "?disposition=inline"), 3600);
    assert.equal(await ttlFor(files[1].id, "?disposition=inline"), 3600);
    assert.equal(await ttlFor(files[0].id, "?disposition=attachment"), 300);
    assert.equal(await ttlFor(files[0].id, "?disposition=inline&download=1"), 300);
    assert.equal(await ttlFor(files[0].id, ""), 300);
    assert.equal(await ttlFor(files[2].id, "?disposition=inline"), 300);
  } finally {
    await app.close();
    resetStorageForTests();
  }
});

test("attachment URL routing keeps CDN_BASE_URL out of original-file downloads", async ({ app }) => {
  const previousCdnBaseUrl = process.env.CDN_BASE_URL;
  try {
    process.env.CDN_BASE_URL = "https://cdn.raft.build";
    const { userB, serverB, channelB, attachmentId: legacyAttachmentId } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const currentAttachmentId = "00000000-0000-4000-8000-000000000002";
    const currentStorageKey = buildServerAttachmentStorageKey(
      serverB.id,
      currentAttachmentId,
      "00000000-0000-4000-8000-000000000003",
      ".txt",
    );
    await insertLinkedAttachmentsWithObjects({
      id: currentAttachmentId,
      channelId: channelB.id,
      uploaderId: userB.id,
      uploaderType: "user",
      filename: "current.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      storageKey: currentStorageKey,
      thumbnailKey: null,
      contentHash: "current-hash",
    });
    const backend = (url: string): StorageBackend => ({
      async put() {},
      async get() { throw new Error("streaming is not expected"); },
      async delete() {},
      async getPresignedUrl() { return url; },
    });
    __setStorageForTests(createAttachmentStorageRouter(
      backend("https://a699.example.test/legacy-original"),
      backend("https://a084.example.test/current-original"),
    ));

    const resolveUrl = async (id: string) => {
      const response = await fetch(`${app.baseUrl}/api/attachments/${id}/url`, {
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "X-Server-Id": serverB.id,
        },
      });
      assert.equal(response.status, 200);
      return (await response.json() as { url: string }).url;
    };

    assert.equal(await resolveUrl(legacyAttachmentId), "https://a699.example.test/legacy-original");
    assert.equal(await resolveUrl(currentAttachmentId), "https://a084.example.test/current-original");
  } finally {
    await app.close();
    resetStorageForTests();
    if (previousCdnBaseUrl === undefined) delete process.env.CDN_BASE_URL;
    else process.env.CDN_BASE_URL = previousCdnBaseUrl;
  }
});

test("attachment reads reject revoked sessions through both bearer and query authentication", async ({ app }) => {
  const { userB, serverB, attachmentId } = await seedCrossServerFixture();
  const { token } = await signInForTest(userB.id);
  let storageReads = 0;
  __setStorageForTests({
    async put() {}, async delete() {},
    async get() { throw new Error("unexpected streaming"); },
    async getPresignedUrl() { storageReads++; return "https://storage.example.test/private"; },
  });
  try {
    const read = (query: boolean) => fetch(
      `${app.baseUrl}/api/attachments/${attachmentId}/url${query ? `?token=${token}&serverId=${serverB.id}` : ""}`,
      { headers: query ? {} : { Authorization: `Bearer ${token}`, "X-Server-Id": serverB.id } },
    );
    for (const query of [false, true]) {
      const response = await read(query);
      assert.equal(response.status, 200);
      await response.json();
    }
    assert.equal(storageReads, 2);
    await revokeAllUserSessions(userB.id);
    for (const query of [false, true]) {
      const response = await read(query);
      assert.equal(response.status, 401, `revoked ${query ? "query" : "bearer"} session`);
      await response.json();
    }
    assert.equal(storageReads, 2, "revoked credentials must not reach storage");
  } finally {
    resetStorageForTests();
  }
});

test("attachment reads reject retired users even with a live session's access token", async ({ app }) => {
  const { userB, serverB, attachmentId } = await seedCrossServerFixture();
  const token = await accessTokenForTest(userB.id);
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, userB.id));
  for (const query of [false, true]) {
    const response = await fetch(
      `${app.baseUrl}/api/attachments/${attachmentId}/url${query ? `?token=${token}&serverId=${serverB.id}` : ""}`,
      { headers: query ? {} : { Authorization: `Bearer ${token}`, "X-Server-Id": serverB.id } },
    );
    assert.equal(response.status, 401);
    await response.json();
  }
});

test("attachment reads reject legacy machine keys, adopted or not", async ({ app }) => {
  const { userB, serverB, attachmentId } = await seedCrossServerFixture();
  const { machine, apiKey } = await registerMachine(serverB.id, userB.id, "attachment-migrated-machine");
  const read = () => fetch(`${app.baseUrl}/api/attachments/${attachmentId}/url`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  // Machine credentials no longer read attachments at all (#proj-raft-computer:8e6a4629).
  let response = await read();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "machine_key_route_retired");
  await getDb().update(machines).set({ legacyKeyMigratedAt: new Date() }).where(eq(machines.id, machine.id));
  clearAuthCache(machine.id);
  response = await read();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "machine_key_route_retired");
});

function signPreviewLikeToken(
  claims: {
    attachmentId: string;
    serverId: string;
    actorId: string;
    audience?: string;
    type?: string;
  },
  expiresIn: jwt.SignOptions["expiresIn"] = "5m",
) {
  const secret = process.env.JWT_SECRET;
  assert.ok(secret, "test harness should configure JWT_SECRET");
  return jwt.sign({
    sub: claims.actorId,
    type: claims.type ?? "attachment-html-preview",
    attachmentId: claims.attachmentId,
    serverId: claims.serverId,
    actorType: "user",
    actorId: claims.actorId,
  }, secret, {
    expiresIn,
    audience: claims.audience ?? "attachment-html-preview",
    issuer: "slock-server",
  });
}

test("single-id attachment reads cloak cross-server UUIDs as not found", async ({ app }) => {
  const { userA, serverA, attachmentId } = await seedCrossServerFixture();
  const tokenA = await tokenForHuman(userA.email);
  const headers = {
    Authorization: `Bearer ${tokenA}`,
    "X-Server-Id": serverA.id,
  };
  const singleIdPaths = (id: string) => [
    `/api/attachments/${id}`,
    `/api/attachments/${id}/url`,
    `/api/attachments/${id}/preview`,
    `/api/attachments/${id}/html-preview-url`,
    `/api/attachments/${id}/html-preview`,
  ];

  // A UUID from another server must be indistinguishable from a valid UUID
  // that does not exist. Returning 403 for the former and 404 for the latter
  // turns every single-id read surface into an attachment-existence oracle.
  for (const url of singleIdPaths(attachmentId)) {
    const res = await fetch(`${app.baseUrl}${url}`, { headers, redirect: "manual" });
    assert.equal(res.status, 404, `${url} must cloak cross-server existence`);
    assert.deepEqual(await res.json(), { error: "Attachment not found" });
  }

  // The HTML route has two token-specific rejection branches after lookup.
  // Neither may reintroduce the 403-vs-404 oracle for an authenticated caller.
  for (const query of ["previewToken=invalid", `token=${tokenA}`]) {
    const url = `/api/attachments/${attachmentId}/html-preview?${query}`;
    const res = await fetch(`${app.baseUrl}${url}`, { headers, redirect: "manual" });
    assert.equal(res.status, 404, `${url} must cloak cross-server existence`);
    assert.deepEqual(await res.json(), { error: "Attachment not found" });
  }
});

/**
 * Regression for the 2026-08-02 prod upload incident follow-up (owed with
 * @Tracey, kept out of the narrow fix in #5856).
 *
 * `attachments.id` is a `uuid` column, so a non-UUID path segment did not miss —
 * it raised a Postgres cast error that each route's catch turned into
 * `500 Failed to serve attachment`. A client-side typo was reported as a server
 * fault, and during the incident the 500-vs-404 split was the only evidence that
 * the ids were not UUID-shaped. The batch `POST /urls` route already filtered
 * ids through `ATTACHMENT_UUID_RE`; every single-id route did not.
 */
test("malformed attachment id is a typed 400, and a well-formed absent id is still 404", async ({ app }) => {
  const { userA, serverA } = await seedCrossServerFixture();
  const token = await tokenForHuman(userA.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": serverA.id };
  const singleIdPaths = (id: string) => [
    `/api/attachments/${id}`,
    `/api/attachments/${id}/url`,
    `/api/attachments/${id}/preview`,
    `/api/attachments/${id}/html-preview-url`,
    `/api/attachments/${id}/html-preview`,
  ];

  // Pre-fix these were 500s from the uuid cast. Includes a one-nibble-short
  // UUID, which is the shape a truncating client actually produces.
  for (const malformed of ["not-a-uuid", "00000000-0000-4000-8000-00000000000"]) {
    for (const url of singleIdPaths(malformed)) {
      const res = await fetch(`${app.baseUrl}${url}`, { headers, redirect: "manual" });
      assert.equal(res.status, 400, `${url} expected 400, got ${res.status}`);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, "invalid_attachment_id", `${url} expected typed code`);
    }
  }

  // The guard sits in front of the not-found path, so prove it did not
  // swallow it: a syntactically valid id that does not exist is still 404.
  for (const url of singleIdPaths("00000000-0000-4000-8000-0000000009ff")) {
    const res = await fetch(`${app.baseUrl}${url}`, { headers, redirect: "manual" });
    assert.equal(res.status, 404, `${url} expected 404, got ${res.status}`);
  }
});

test("missing attachment object is a 404, not a 500", async ({ app }) => {
  // Localizes the 2026-09-24 staging observation (trace 5edd937d): a preview
  // request for an attachment row whose storage object is gone surfaced the
  // AWS NoSuchKey error as a 500. A missing object is a not-found, mirroring
  // the row-missing branch of the same routes.
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "missing-object-owner@slock.test",
    name: "missing-object-owner",
    displayName: "Missing Object Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Missing Object Server", `missing-object-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "missing-object-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  const attachmentId = "00000000-0000-4000-8000-0000000000f1";
  await insertLinkedAttachmentsWithObjects({
    id: attachmentId,
    channelId: channel.id,
    uploaderId: owner.id,
    uploaderType: "user",
    filename: "gone.txt",
    mimeType: "text/plain",
    sizeBytes: 42,
    storageKey: `${server.id}/gone.txt`,
    thumbnailKey: null,
    contentHash: "deadbeef",
  });
  const noSuchKey = new Error("The specified key does not exist.");
  noSuchKey.name = "NoSuchKey";
  __setStorageForTests({
    async put() {},
    async delete() {},
    async get() { throw noSuchKey; },
    async getPresignedUrl() { return "https://storage.example.test/gone"; },
  });
  try {
    const token = await tokenForHuman(owner.email);
    const response = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}/preview`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(response.status, 404, `missing object must 404, got ${response.status}`);
    assert.deepEqual(await response.json(), { error: "Attachment not found" });
  } finally {
    resetStorageForTests();
  }
});

test("GET /api/attachments/:id refuses an sk_computer_* credential even for a same-server attachment", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "computer-attach-owner@slock.test",
    name: "computer-attach-owner",
    displayName: "Computer Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Computer Attach Server", `computer-attach-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "computer-attach-channel", undefined, "channel");

  const attachmentId = "00000000-0000-4000-8000-000000000201";
  await insertLinkedAttachmentsWithObjects({
    id: attachmentId,
    channelId: channel.id,
    uploaderId: owner.id,
    uploaderType: "user",
    filename: "computer-download.txt",
    mimeType: "text/plain",
    sizeBytes: 42,
    storageKey: `${server.id}/computer-download.txt`,
    thumbnailKey: null,
    contentHash: "computerdownload",
  });

  const ownerToken = await tokenForHuman(owner.email);
  const attachRes = await fetch(`${app.baseUrl}/api/computer/attach`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
  });
  assert.equal(attachRes.status, 201, `computer attach expected 201, got ${attachRes.status}`);
  const { apiKey } = (await attachRes.json()) as { apiKey: string };
  assert.ok(apiKey.startsWith("sk_computer_"), "expected sk_computer_* credential");

  // A machine credential used to read any attachment on its server, private
  // channels and DMs included; agents download with their own credential through
  // /internal/agent-api/attachments instead (#proj-raft-computer:8e6a4629).
  const downloadRes = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    redirect: "manual",
  });
  assert.equal(downloadRes.status, 403);
  assert.equal((await downloadRes.json() as { code?: string }).code, "machine_key_route_retired");
});

test("GET /api/attachments/:id/url allows linked joint attachments through sibling projections only", async ({ app }) => {
  const db = getDb();
  const [hostOwner] = await db.insert(users).values({
    email: "joint-attachment-host@slock.test",
    name: "joint-attachment-host",
    displayName: "Joint Host",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [peerOwner] = await db.insert(users).values({
    email: "joint-attachment-peer@slock.test",
    name: "joint-attachment-peer",
    displayName: "Joint Peer",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const hostServer = await createServer("Joint Attachment Host", "joint-attachment-host", hostOwner.id);
  const peerServer = await createServer("Joint Attachment Peer", "joint-attachment-peer", peerOwner.id);
  const canonical = await createChannel(hostServer.id, "joint-attachment-storage", undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, "partner-room", undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, "partner-room", undefined, "joint");
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(peerProjection.id, peerOwner.id);

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
  await fillJointMembersFromChannelHumans();

  const message = await createMessage(canonical.id, "user", hostOwner.id, "joint attachment message");
  await insertAttachmentsWithObjects(db, [
    {
      id: "00000000-0000-4000-8000-000000000101",
      channelId: hostProjection.id,
      messageId: message.id,
      uploaderId: hostOwner.id,
      uploaderType: "user",
      filename: "joint-linked.txt",
      mimeType: "text/plain",
      sizeBytes: 24,
      storageKey: `${hostServer.id}/joint-linked.txt`,
      thumbnailKey: null,
      contentHash: "jointlinked",
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      channelId: hostProjection.id,
      uploaderId: hostOwner.id,
      uploaderType: "user",
      filename: "joint-draft.txt",
      mimeType: "text/plain",
      sizeBytes: 23,
      storageKey: `${hostServer.id}/joint-draft.txt`,
      thumbnailKey: null,
      contentHash: "jointdraft",
    },
  ]);
  const peerToken = await tokenForHuman(peerOwner.email);

  const linkedRes = await fetch(`${app.baseUrl}/api/attachments/00000000-0000-4000-8000-000000000101/url`, {
    headers: {
      Authorization: `Bearer ${peerToken}`,
      "X-Server-Id": peerServer.id,
    },
  });
  assert.equal(linkedRes.status, 200, `linked joint attachment should be readable via peer projection, got ${linkedRes.status}`);

  const draftRes = await fetch(`${app.baseUrl}/api/attachments/00000000-0000-4000-8000-000000000102/url`, {
    headers: {
      Authorization: `Bearer ${peerToken}`,
      "X-Server-Id": peerServer.id,
    },
  });
  assert.equal(draftRes.status, 404, "unlinked draft attachment must stay existence-cloaked from sibling joint projections");
});

test("GET /api/attachments/:id rejects missing X-Server-Id header", async ({ app }) => {
  const { userA, attachmentId } = await seedCrossServerFixture();
  const tokenA = await tokenForHuman(userA.email);

  const res = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  // requireServerForFlex rejects missing scope before the resource lookup.
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
});

test("GET /api/attachments/:id rejects X-Server-Id the user is not a member of", async ({ app }) => {
  const { userA, serverB, attachmentId } = await seedCrossServerFixture();
  const tokenA = await tokenForHuman(userA.email);

  // User A lies about being in server B. Membership check fails.
  const res = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}`, {
    headers: {
      Authorization: `Bearer ${tokenA}`,
      "X-Server-Id": serverB.id,
    },
    redirect: "manual",
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
});

test("GET /api/attachments/:id/preview returns bounded XLSX data and typed failures", async ({ app }) => {
  try {
    const db = getDb();
    const [user] = await db.insert(users).values({
      email: "xlsx-preview-route@slock.test",
      name: "xlsx-preview-route",
      displayName: "XLSX Preview Route",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await createServer("XLSX Preview Route", "xlsx-preview-route", user.id);
    const channel = await createChannel(server.id, "xlsx-preview-route", "channel");
    const token = await tokenForHuman(user.email);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Name", "Score"],
      ["Alice", 10],
    ]), "Scores");
    const workbookBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const validId = "00000000-0000-4000-8000-000000000201";
    const corruptId = "00000000-0000-4000-8000-000000000202";
    const tooLargeId = "00000000-0000-4000-8000-000000000203";
    await insertLinkedAttachmentsWithObjects([
      {
        id: validId,
        channelId: channel.id,
        uploaderId: user.id,
        uploaderType: "user",
        filename: "scores.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: workbookBuffer.length,
        storageKey: `${server.id}/scores.xlsx`,
        thumbnailKey: null,
        contentHash: "xlsx-valid",
      },
      {
        id: corruptId,
        channelId: channel.id,
        uploaderId: user.id,
        uploaderType: "user",
        filename: "corrupt.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 12,
        storageKey: `${server.id}/corrupt.xlsx`,
        thumbnailKey: null,
        contentHash: "xlsx-corrupt",
      },
      {
        id: tooLargeId,
        channelId: channel.id,
        uploaderId: user.id,
        uploaderType: "user",
        filename: "large.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: XLSX_PREVIEW_MAX_FILE_SIZE_BYTES + 1,
        storageKey: `${server.id}/large.xlsx`,
        thumbnailKey: null,
        contentHash: "xlsx-too-large",
      },
    ]);
    let storageReads = 0;
    __setStorageForTests({
      async put() {},
      async get(key) {
        storageReads += 1;
        return Readable.from([key.endsWith("corrupt.xlsx") ? Buffer.from("not a zip") : workbookBuffer]);
      },
      async delete() {},
    });
    const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id };

    const validRes = await fetch(`${app.baseUrl}/api/attachments/${validId}/preview`, { headers });
    assert.equal(validRes.status, 200);
    assert.deepEqual(await validRes.json(), {
      status: "ok",
      data: {
        kind: "xlsx",
        sheets: [{
          name: "Scores",
          headers: ["Name", "Score"],
          rows: [["Alice", "10"]],
          rowCount: 1,
          columnCount: 2,
          truncated: false,
        }],
        sheetCount: 1,
        truncated: false,
      },
      truncated: false,
    });

    // XLSX previews are cached (task #19): a repeat is served without reading
    // the original again, and the cache never bypasses the access check.
    const readsAfterFirst = storageReads;
    const cachedRes = await fetch(`${app.baseUrl}/api/attachments/${validId}/preview`, { headers });
    assert.equal(cachedRes.status, 200);
    assert.equal((await cachedRes.json() as { status: string }).status, "ok");
    assert.equal(storageReads, readsAfterFirst);
    // The card's summary view (task #164) shares the build and cache but
    // carries only the kind, never the sheet contents.
    const summaryRes = await fetch(`${app.baseUrl}/api/attachments/${validId}/preview?view=summary`, { headers });
    assert.equal(summaryRes.status, 200);
    assert.deepEqual(await summaryRes.json(), { status: "ok", data: { kind: "xlsx" }, truncated: false });
    assert.equal(storageReads, readsAfterFirst);
    const [cacheRow] = await db.select().from(attachmentPreviewCache).where(eq(attachmentPreviewCache.attachmentId, validId));
    assert.ok(cacheRow);
    const { userB, serverB } = await seedCrossServerFixture();
    const outsiderRes = await fetch(`${app.baseUrl}/api/attachments/${validId}/preview`, {
      headers: { Authorization: `Bearer ${await tokenForHuman(userB.email)}`, "X-Server-Id": serverB.id },
    });
    assert.equal(outsiderRes.status, 404);

    const corruptRes = await fetch(`${app.baseUrl}/api/attachments/${corruptId}/preview`, { headers });
    assert.equal(corruptRes.status, 200);
    assert.deepEqual(await corruptRes.json(), { status: "unsupported", reason: "unreadable" });

    const tooLargeRes = await fetch(`${app.baseUrl}/api/attachments/${tooLargeId}/preview`, { headers });
    assert.equal(tooLargeRes.status, 200);
    assert.deepEqual(await tooLargeRes.json(), { status: "unsupported", reason: "too_large" });

    // Pool degradation is transient: the route answers the same degraded
    // preview (never a 5xx for an interactive caller), and the outage is not
    // pinned in the preview cache — the next request rebuilds.
    const degradedId = "00000000-0000-4000-8000-000000000204";
    await insertLinkedAttachmentsWithObjects({
      id: degradedId,
      channelId: channel.id,
      uploaderId: user.id,
      uploaderType: "user",
      filename: "degraded.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: workbookBuffer.length,
      storageKey: `${server.id}/degraded.xlsx`,
      thumbnailKey: null,
      contentHash: "xlsx-degraded",
    });
    const queueFull = new WorkerPoolBusy("attachment_preview.xlsx", "queue_full", "queue full");
    const failingPool: WorkerPoolService = {
      submit: () => Promise.reject(queueFull),
      submitDetailed: () => Promise.reject(queueFull),
      warmup: () => {},
      close: () => Promise.resolve(),
    };
    setServerWorkerPoolForTests(failingPool);
    try {
      const degradedRes = await fetch(`${app.baseUrl}/api/attachments/${degradedId}/preview`, { headers });
      assert.equal(degradedRes.status, 200);
      assert.deepEqual(await degradedRes.json(), { status: "unsupported", reason: "unavailable" });
      const [degradedCacheRow] = await db.select().from(attachmentPreviewCache).where(eq(attachmentPreviewCache.attachmentId, degradedId));
      assert.equal(degradedCacheRow, undefined);
    } finally {
      setServerWorkerPoolForTests(null);
    }
  } finally {
    resetStorageForTests();
  }
});

test("GET /api/attachments/:id accepts serverId from query (for <img src> fallback)", async ({ app }) => {
  const { userB, serverB, attachmentId } = await seedCrossServerFixture();
  const tokenB = await tokenForHuman(userB.email);

  // User B on server B reads their own attachment with serverId from query.
  // Local storage is not configured in the pglite harness, so the storage layer
  // answers 503 when it is unconfigured, and since #8209 a missing object is a
  // 404 rather than a server fault. Either one proves what this case cares
  // about: auth+scope passed before the storage layer ran.
  const res = await fetch(
    `${app.baseUrl}/api/attachments/${attachmentId}?serverId=${serverB.id}&token=${tokenB}`,
    { redirect: "manual" },
  );
  assert.notEqual(res.status, 400, "should not reject on missing scope");
  assert.notEqual(res.status, 403, "should not reject on membership");
  assert.ok(
    res.status === 404 || res.status === 503,
    `auth+scope must pass before storage (404 missing object or 503 unconfigured), got ${res.status}`,
  );
});

test("GET /api/attachments/:id serves both image and pdf attachments from local storage", async () => {
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-serve-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const [user] = await db
      .insert(users)
      .values({
        email: "attachment-serve@slock.test",
        name: "attachment-serve",
        displayName: "Attachment Serve",
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      })
      .returning();

    const server = await createServer("Attachment Serve", "attachment-serve", user.id);
    const channel = await createChannel(server.id, "serve-test", "channel");
    const token = await tokenForHuman(user.email);

    const imageId = "00000000-0000-4000-8000-000000000011";
    const pdfId = "00000000-0000-4000-8000-000000000012";
    fs.mkdirSync(path.join(uploadsDir, server.id), { recursive: true });
    const imageBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const pdfBuffer = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    fs.writeFileSync(path.join(uploadsDir, server.id, `${imageId}.jpg`), imageBuffer);
    fs.writeFileSync(path.join(uploadsDir, server.id, `${pdfId}.pdf`), pdfBuffer);

    await insertLinkedAttachmentsWithObjects([
      {
        id: imageId,
        channelId: channel.id,
        uploaderId: user.id,
        uploaderType: "user",
        filename: "image.jpg",
        mimeType: "image/jpeg",
        sizeBytes: imageBuffer.length,
        storageKey: `${server.id}/${imageId}.jpg`,
        thumbnailKey: null,
        contentHash: "hash-image",
      },
      {
        id: pdfId,
        channelId: channel.id,
        uploaderId: user.id,
        uploaderType: "user",
        filename: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdfBuffer.length,
        storageKey: `${server.id}/${pdfId}.pdf`,
        thumbnailKey: null,
        contentHash: "hash-pdf",
      },
    ]);

    const imageRes = await fetch(`${app.baseUrl}/api/attachments/${imageId}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    const pdfRes = await fetch(`${app.baseUrl}/api/attachments/${pdfId}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });

    assert.equal(imageRes.status, 200);
    assert.equal(imageRes.headers.get("content-type"), "image/jpeg");
    assert.match(imageRes.headers.get("content-disposition") ?? "", /^inline;/);
    // The web app may live on another origin (self-hosted, local dev, e2e):
    // an inline image must be embeddable cross-origin, a download need not be.
    assert.equal(imageRes.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(Buffer.from(await imageRes.arrayBuffer()), imageBuffer);

    const imageDownloadRes = await fetch(`${app.baseUrl}/api/attachments/${imageId}?download=1`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(imageDownloadRes.status, 200);
    assert.match(imageDownloadRes.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(imageDownloadRes.headers.get("cross-origin-resource-policy"), "same-origin");
    await imageDownloadRes.arrayBuffer();

    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
    assert.match(pdfRes.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(pdfRes.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual(Buffer.from(await pdfRes.arrayBuffer()), pdfBuffer);
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

test("attachment Range route releases its real upstream Agent socket when the client aborts", async ({ app }) => {
  const harness = await createHangingStorageTestHarness();
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const downloadId = "00000000-0000-4000-8000-000000000011";
    const sizeBytes = 1024 * 1024;
    await insertLinkedAttachmentsWithObjects({
      id: downloadId,
      channelId: channelB.id,
      uploaderId: userB.id,
      uploaderType: "user",
      filename: "hanging-download.bin",
      mimeType: "application/octet-stream",
      sizeBytes,
      storageKey: `${serverB.id}/hanging-download.bin`,
      contentHash: "hangingdownload",
    });
    __setStorageForTests(harness.storage);

    const auth = {
      Authorization: `Bearer ${tokenB}`,
      "X-Server-Id": serverB.id,
    };
    const unsatisfiable = await fetch(`${app.baseUrl}/api/attachments/${downloadId}`, {
      headers: { ...auth, Range: `bytes=${sizeBytes}-` },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${sizeBytes}`);

    await harness.abortDownload(
      `${app.baseUrl}/api/attachments/${downloadId}`,
      { headers: { ...auth, Range: `bytes=0-${sizeBytes - 1}` } },
      (response) => {
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("content-range"), `bytes 0-${sizeBytes - 1}/${sizeBytes}`);
        assert.equal(response.headers.get("content-length"), String(sizeBytes));
        assert.equal(response.headers.get("accept-ranges"), "bytes");
        assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
      },
    );
  } finally {
    await harness.close();
    resetStorageForTests();
  }
});

test("attachment HTML preview two-hop route releases its real upstream Agent socket when the client aborts", async ({ app }) => {
  const harness = await createHangingStorageTestHarness();
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const previewId = "00000000-0000-4000-8000-000000000012";
    await insertLinkedAttachmentsWithObjects({
      id: previewId,
      channelId: channelB.id,
      uploaderId: userB.id,
      uploaderType: "user",
      filename: "hanging-preview.html",
      mimeType: "text/html",
      sizeBytes: 1024 * 1024,
      storageKey: `${serverB.id}/hanging-preview.html`,
      contentHash: "hangingpreview",
    });
    __setStorageForTests(harness.storage);

    const previewUrlResponse = await fetch(
      `${app.baseUrl}/api/attachments/${previewId}/html-preview-url`,
      {
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "X-Server-Id": serverB.id,
        },
      },
    );
    assert.equal(previewUrlResponse.status, 200);
    const { url } = await previewUrlResponse.json() as { url: string };
    await harness.abortDownload(url, undefined, (response) => {
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("content-length"), null, "preview bridge bytes require chunked framing");
      assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
    });
  } finally {
    await harness.close();
    resetStorageForTests();
  }
});

test("attachment HTML preview preserves upstream storage error logging after headers start", async ({ app }) => {
  const logged: unknown[][] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const previewId = "00000000-0000-4000-8000-000000000013";
    await insertLinkedAttachmentsWithObjects({
      id: previewId,
      channelId: channelB.id,
      uploaderId: userB.id,
      uploaderType: "user",
      filename: "broken-preview.html",
      mimeType: "text/html",
      sizeBytes: 1024,
      storageKey: `${serverB.id}/broken-preview.html`,
      contentHash: "brokenpreview",
    });

    const upstreamError = Object.assign(new Error("injected upstream storage failure"), {
      code: "NoSuchKey",
    });
    let started = false;
    const storage: StorageBackend = {
      async put() {},
      async get() {
        return new Readable({
          read() {
            if (started) return;
            started = true;
            this.push(Buffer.from("<html>partial"));
            queueMicrotask(() => this.destroy(upstreamError));
          },
        });
      },
      async delete() {},
    };
    __setStorageForTests(storage);

    const previewUrlResponse = await fetch(
      `${app.baseUrl}/api/attachments/${previewId}/html-preview-url`,
      {
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "X-Server-Id": serverB.id,
        },
      },
    );
    assert.equal(previewUrlResponse.status, 200);
    const { url } = await previewUrlResponse.json() as { url: string };
    await assert.rejects(fetch(url).then((response) => response.arrayBuffer()));

    assert.equal(
      logged.some((args) => args[0] === "[Attachments] Failed to serve attachment"
        && args[2] === upstreamError),
      true,
      "a non-client pipeline failure must retain the preview route's storage diagnostic",
    );
  } finally {
    consoleError.mockRestore();
    resetStorageForTests();
  }
});

test("download-as-image attachment requests force same-origin streaming instead of presigned redirect", () => {
  const previous = process.env.DEPLOYMENT_ENV;
  try {
    delete process.env.DEPLOYMENT_ENV;
    assert.equal(shouldStreamAttachmentThroughServerForRequest({ query: { selectScreenshot: "1" } }), true);
    assert.equal(shouldStreamAttachmentThroughServerForRequest({ query: { selectScreenshot: "0" } }), false);
    assert.equal(shouldStreamAttachmentThroughServerForRequest({ query: {} }), false);

    process.env.DEPLOYMENT_ENV = "slockdev";
    assert.equal(shouldStreamAttachmentThroughServerForRequest({ query: {} }), true);
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = previous;
  }
});

test("slockdev attachment stream URLs use the incoming preview host instead of SERVER_URL", () => {
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  const previousServerUrl = process.env.SERVER_URL;
  const req = {
    protocol: "https",
    get: (name: string) => {
      const lower = name.toLowerCase();
      if (lower === "host") return "localhost:13006";
      if (lower === "x-forwarded-host") return "preview.trycloudflare.com";
      if (lower === "x-forwarded-proto") return "https";
      return undefined;
    },
  } as unknown as Parameters<typeof getAttachmentStreamingBaseUrl>[0];
  try {
    process.env.SERVER_URL = "http://localhost:13006";

    delete process.env.DEPLOYMENT_ENV;
    assert.equal(getAttachmentStreamingBaseUrl(req), "http://localhost:13006");

    process.env.DEPLOYMENT_ENV = "slockdev";
    assert.equal(getAttachmentStreamingBaseUrl(req), "https://preview.trycloudflare.com");
  } finally {
    if (previousDeploymentEnv === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
  }
});

test("POST /api/attachments/upload rejects zero-byte files", async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const tokenB = await tokenForHuman(userB.email);
  const body = new FormData();
  body.append("channelId", channelB.id);
  body.append("files", new Blob([], { type: "image/png" }), "empty.png");

  const res = await fetch(`${app.baseUrl}/api/attachments/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenB}`,
      "X-Server-Id": serverB.id,
    },
    body,
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  assert.deepEqual(await res.json(), { error: "Empty files are not allowed" });
});

test("identical uploads create distinct attachment projections instead of hash-deduping", async () => {
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-no-hash-dedupe-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const uploadOnce = async () => {
      const body = new FormData();
      body.append("channelId", channelB.id);
      body.append("files", new Blob(["same attachment bytes"], { type: "text/plain" }), "repeat.txt");
      const response = await fetch(`${app.baseUrl}/api/attachments/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "X-Server-Id": serverB.id,
        },
        body,
      });
      assert.equal(response.status, 200, `expected 200, got ${response.status}`);
      const payload = await response.json() as { attachments: Array<{ id: string }> };
      assert.equal(payload.attachments.length, 1);
      return payload.attachments[0]!.id;
    };

    const firstId = await uploadOnce();
    const secondId = await uploadOnce();
    assert.notEqual(secondId, firstId, "each upload owns a distinct projection identity");

    const rows = await getDb()
      .select({ id: attachments.id, contentHash: attachmentObjects.contentHash })
      .from(attachments)
      .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
      .where(inArray(attachments.id, [firstId, secondId]));
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.contentHash)).size, 1, "precondition: bytes really hash identically");
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

test("POST /api/attachments/upload rejects files over 50MB", async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const tokenB = await tokenForHuman(userB.email);
  const body = new FormData();
  body.append("channelId", channelB.id);
  body.append("files", new Blob([Buffer.alloc(MAX_ATTACHMENT_FILE_SIZE_BYTES + 1)], { type: "application/octet-stream" }), "oversized.bin");

  const res = await fetch(`${app.baseUrl}/api/attachments/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenB}`,
      "X-Server-Id": serverB.id,
    },
    body,
  });
  assert.equal(res.status, 413, `expected 413, got ${res.status}`);
  assert.deepEqual(await res.json(), {
    error: "Max 50MB per file",
    errorCode: "ATTACHMENT_TOO_LARGE",
    maxBytes: MAX_ATTACHMENT_FILE_SIZE_BYTES,
  });
});

test("POST /api/attachments/upload accepts Pro files over the Free 50MB cap", async () => {
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-pro-size-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, serverB.id));
    const tokenB = await tokenForHuman(userB.email);
    const body = new FormData();
    body.append("channelId", channelB.id);
    body.append(
      "files",
      new Blob([Buffer.alloc(MAX_ATTACHMENT_FILE_SIZE_BYTES + 1)], { type: "application/octet-stream" }),
      "pro-sized.bin",
    );

    const res = await fetch(`${app.baseUrl}/api/attachments/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "X-Server-Id": serverB.id,
      },
      body,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);
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

test("POST /api/attachments/upload does not let the direct-upload threshold lower the legacy limit", async () => {
  const previousThreshold = process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
  process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = "64";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, serverB.id));
    const tokenB = await tokenForHuman(userB.email);
    const body = new FormData();
    body.append("channelId", channelB.id);
    // 65 bytes with the threshold pinned at 64: before the decoupling this was rejected,
    // because the legacy limit was min(plan, threshold, 90MiB). The threshold now only
    // selects the direct transport, so the legacy path must still accept this file.
    body.append("files", new Blob([Buffer.alloc(65)], { type: "application/octet-stream" }), "above-threshold.bin");

    const res = await fetch(`${app.baseUrl}/api/attachments/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "X-Server-Id": serverB.id,
      },
      body,
    });
    assert.equal(
      res.status,
      200,
      `a file above the direct-upload threshold must still be accepted by the legacy transport; got ${res.status}`,
    );
  } finally {
    await app.close();
    if (previousThreshold === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = previousThreshold;
  }
});

test("agent upload keeps the Pro plan limit when legacy multipart transport is capped", async () => {
  const previousThreshold = process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-agent-plan-limit-"));
  process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = "64";
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const agent = await createAgent(serverB.id, "attachment-plan-agent", { runtime: "codex" });
    const { machine, apiKey } = await registerMachine(serverB.id, userB.id, "attachment-plan-machine");
    await placeAgentOnMachine(agent.id, machine.id);
    await addAgent(channelB.id, agent.id);
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, serverB.id));

    const body = new FormData();
    body.append("channelId", channelB.id);
    body.append(
      "file",
      new Blob([Buffer.alloc((1024 * 1024) + 65)], { type: "application/octet-stream" }),
      "agent-over-legacy-cap.bin",
    );
    const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);
  } finally {
    await app.close();
    resetStorageForTests();
    if (previousThreshold === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = previousThreshold;
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    if (previousUploadsLocal === undefined) delete process.env.UPLOADS_LOCAL;
    else process.env.UPLOADS_LOCAL = previousUploadsLocal;
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("POST /api/attachments/upload accepts the full message attachment batch cap", async () => {
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-batch-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.UPLOADS_LOCAL = "true";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);
    const body = new FormData();
    body.append("channelId", channelB.id);
    for (let index = 0; index < MAX_ATTACHMENT_UPLOAD_FILES; index += 1) {
      body.append("files", new Blob([`file-${index}`], { type: "text/plain" }), `file-${index}.txt`);
    }

    const res = await fetch(`${app.baseUrl}/api/attachments/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "X-Server-Id": serverB.id,
      },
      body,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const json = await res.json() as { attachments: Array<{ id: string; filename: string }> };
    assert.equal(json.attachments.length, MAX_ATTACHMENT_UPLOAD_FILES);
    assert.deepEqual(
      json.attachments.map((attachment) => attachment.filename),
      Array.from({ length: MAX_ATTACHMENT_UPLOAD_FILES }, (_, index) => `file-${index}.txt`),
    );
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

test("ATTACHMENT_UPLOAD_ENABLED=false disables human and agent uploads", async () => {
  const previous = process.env.ATTACHMENT_UPLOAD_ENABLED;
  process.env.ATTACHMENT_UPLOAD_ENABLED = "false";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const tokenB = await tokenForHuman(userB.email);

    const humanBody = new FormData();
    humanBody.append("channelId", channelB.id);
    humanBody.append("files", new Blob([Buffer.from("hello")], { type: "text/plain" }), "hello.txt");
    const humanRes = await fetch(`${app.baseUrl}/api/attachments/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "X-Server-Id": serverB.id,
      },
      body: humanBody,
    });
    assert.equal(humanRes.status, 503, `expected human upload 503, got ${humanRes.status}`);
    assert.deepEqual(await humanRes.json(), {
      error: ATTACHMENT_UPLOAD_DISABLED_MESSAGE,
      errorCode: "ATTACHMENT_UPLOAD_DISABLED",
    });

    const agent = await createAgent(serverB.id, "attachment-disabled-agent", { runtime: "codex" });
    const { machine, apiKey } = await registerMachine(serverB.id, userB.id, "attachment-disabled-machine");
    await placeAgentOnMachine(agent.id, machine.id);
    await addAgent(channelB.id, agent.id);

    const agentBody = new FormData();
    agentBody.append("channelId", channelB.id);
    agentBody.append("file", new Blob([Buffer.from("hello")], { type: "text/plain" }), "hello.txt");
    const agentRes = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: agentBody,
    });
    assert.equal(agentRes.status, 503, `expected agent upload 503, got ${agentRes.status}`);
    assert.deepEqual(await agentRes.json(), {
      error: ATTACHMENT_UPLOAD_DISABLED_MESSAGE,
      errorCode: "ATTACHMENT_UPLOAD_DISABLED",
    });
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_UPLOAD_ENABLED;
    else process.env.ATTACHMENT_UPLOAD_ENABLED = previous;
    await app.close();
  }
});

test("GET /api/attachments/:id/url two-hop flow: query-token caller gets a URL carrying the query token", async ({ app }) => {
  const { userB, serverB, attachmentId } = await seedCrossServerFixture();
  const tokenB = await tokenForHuman(userB.email);

  // Hop 1: `<img src>` / fresh-tab callers cannot set Authorization. The
  // attachment service sends them to `/:id/url?token=...&serverId=...`.
  // Local storage is not configured in the pglite harness, so `/:id/url`
  // returns an absolute streaming URL (not a presigned CDN URL). That
  // returned URL MUST carry the token that got us through hop 1, or hop 2
  // re-fails with 401. (Regression guard for Cody's review on PR #945.)
  const hop1 = await fetch(
    `${app.baseUrl}/api/attachments/${attachmentId}/url?serverId=${serverB.id}&token=${tokenB}`,
  );
  assert.equal(hop1.status, 200, `hop 1 expected 200, got ${hop1.status}`);
  const { url: streamUrl, expiresAt } = (await hop1.json()) as { url: string; expiresAt: string | null };
  assert.equal(expiresAt, null, "local streaming URLs should be cacheable without a presigned expiry");

  const parsed = new URL(streamUrl);
  assert.equal(parsed.searchParams.get("token"), tokenB, "hop 1 must propagate query token to the stream URL");
  assert.equal(parsed.searchParams.get("serverId"), serverB.id, "hop 1 must propagate serverId to the stream URL");

  // Hop 2: fetch the URL that hop 1 handed back. Auth/scope must still pass
  // (we're not checking the body — local storage is not seeded in pglite, but
  // auth runs before storage). The key assertion is: not 401 / 400 / 403.
  //
  // A 404 is NOT a failure of this contract: since #8209 a missing storage
  // object is a not-found, which is exactly what an unseeded harness produces.
  // Requiring anything other than 404 here would re-assert the old 500.
  const hop2 = await fetch(streamUrl, { redirect: "manual" });
  assert.notEqual(hop2.status, 401, "hop 2 must not reject on auth");
  assert.notEqual(hop2.status, 400, "hop 2 must not reject on scope");
  assert.notEqual(hop2.status, 403, "hop 2 must not reject on membership");
  assert.ok(
    hop2.status === 404 || hop2.status === 503,
    `hop 2 must reach storage (404 missing object or 503 unconfigured), got ${hop2.status}`,
  );
});

test("GET /api/attachments/:id/html-preview-url returns scoped preview URL for HTML", async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const db = getDb();
  const htmlAttachmentId = "00000000-0000-4000-8000-0000000000ff";
  await insertLinkedAttachmentsWithObjects({
    id: htmlAttachmentId,
    channelId: channelB.id,
    uploaderId: userB.id,
    uploaderType: "user",
    filename: "diagram.html",
    mimeType: "application/octet-stream",
    sizeBytes: 64,
    storageKey: `${serverB.id}/diagram.html`,
    thumbnailKey: null,
    contentHash: "feedface",
  });
  const tokenB = await tokenForHuman(userB.email);

  const res = await fetch(`${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview-url`, {
    headers: {
      Authorization: `Bearer ${tokenB}`,
      "X-Server-Id": serverB.id,
    },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
  assert.ok(Date.parse(expiresAt) > Date.now(), "preview token should have a future expiry");

  const parsed = new URL(url);
  assert.equal(parsed.pathname, `/api/attachments/${htmlAttachmentId}/html-preview`);
  assert.equal(parsed.searchParams.get("token"), null, "must not leak the user's bearer token in iframe URL");
  assert.ok(parsed.searchParams.get("previewToken"), "expected scoped preview token");
  assert.notEqual(parsed.searchParams.get("previewToken"), tokenB);
  assert.equal(parsed.searchParams.get("serverId"), serverB.id);

  // Local storage is not seeded in this harness. A 404 here proves the
  // scoped preview token got past auth and failed only at the storage layer:
  // since #8209 a missing object is a not-found rather than a server fault.
  const previewRes = await fetch(url, { redirect: "manual" });
  assert.equal(previewRes.status, 404, `expected valid preview token to reach storage, got ${previewRes.status}`);
});

test("GET /api/attachments/:id/html-preview-url scoped token cannot be reused for another attachment", async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const db = getDb();
  const firstAttachmentId = "00000000-0000-4000-8000-0000000000a1";
  const secondAttachmentId = "00000000-0000-4000-8000-0000000000a2";
  await insertLinkedAttachmentsWithObjects([
    {
      id: firstAttachmentId,
      channelId: channelB.id,
      uploaderId: userB.id,
      uploaderType: "user",
      filename: "first.html",
      mimeType: "text/html",
      sizeBytes: 64,
      storageKey: `${serverB.id}/first.html`,
      thumbnailKey: null,
      contentHash: "feedface01",
    },
    {
      id: secondAttachmentId,
      channelId: channelB.id,
      uploaderId: userB.id,
      uploaderType: "user",
      filename: "second.html",
      mimeType: "text/html",
      sizeBytes: 64,
      storageKey: `${serverB.id}/second.html`,
      thumbnailKey: null,
      contentHash: "feedface02",
    },
  ]);
  const tokenB = await tokenForHuman(userB.email);

  const firstUrlRes = await fetch(`${app.baseUrl}/api/attachments/${firstAttachmentId}/html-preview-url`, {
    headers: {
      Authorization: `Bearer ${tokenB}`,
      "X-Server-Id": serverB.id,
    },
  });
  assert.equal(firstUrlRes.status, 200, `expected 200, got ${firstUrlRes.status}`);
  const { url } = (await firstUrlRes.json()) as { url: string };
  const previewToken = new URL(url).searchParams.get("previewToken");
  assert.ok(previewToken, "expected scoped preview token");

  const crossAttachmentRes = await fetch(
    `${app.baseUrl}/api/attachments/${secondAttachmentId}/html-preview?serverId=${serverB.id}&previewToken=${previewToken}`,
    { redirect: "manual" },
  );
  assert.equal(crossAttachmentRes.status, 401, `expected scoped token mismatch to 401, got ${crossAttachmentRes.status}`);
});

test("HTML preview token cannot authorize normal attachment download or URL endpoints", async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const db = getDb();
  const htmlAttachmentId = "00000000-0000-4000-8000-0000000000c1";
  await insertLinkedAttachmentsWithObjects({
    id: htmlAttachmentId,
    channelId: channelB.id,
    uploaderId: userB.id,
    uploaderType: "user",
    filename: "scoped.html",
    mimeType: "text/html",
    sizeBytes: 64,
    storageKey: `${serverB.id}/scoped.html`,
    thumbnailKey: null,
    contentHash: "feedface04",
  });
  const tokenB = await tokenForHuman(userB.email);

  const previewUrlRes = await fetch(`${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview-url`, {
    headers: {
      Authorization: `Bearer ${tokenB}`,
      "X-Server-Id": serverB.id,
    },
  });
  assert.equal(previewUrlRes.status, 200, `expected 200, got ${previewUrlRes.status}`);
  const { url } = (await previewUrlRes.json()) as { url: string };
  const previewToken = new URL(url).searchParams.get("previewToken");
  assert.ok(previewToken, "expected scoped preview token");

  const downloadRes = await fetch(
    `${app.baseUrl}/api/attachments/${htmlAttachmentId}?serverId=${serverB.id}&previewToken=${previewToken}`,
    { redirect: "manual" },
  );
  assert.equal(downloadRes.status, 401, `expected preview token not to authorize download, got ${downloadRes.status}`);

  const urlRes = await fetch(
    `${app.baseUrl}/api/attachments/${htmlAttachmentId}/url?serverId=${serverB.id}&previewToken=${previewToken}`,
    { redirect: "manual" },
  );
  assert.equal(urlRes.status, 401, `expected preview token not to authorize /url, got ${urlRes.status}`);

  const refreshRes = await fetch(
    `${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview-url?serverId=${serverB.id}&previewToken=${previewToken}`,
    { redirect: "manual" },
  );
  assert.equal(
    refreshRes.status,
    401,
    `expected leaked preview token not to mint a fresh preview URL, got ${refreshRes.status}`,
  );
});

test("HTML preview token rejects expired and wrong-audience tokens", async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const db = getDb();
  const htmlAttachmentId = "00000000-0000-4000-8000-0000000000c2";
  await insertLinkedAttachmentsWithObjects({
    id: htmlAttachmentId,
    channelId: channelB.id,
    uploaderId: userB.id,
    uploaderType: "user",
    filename: "invalid-token.html",
    mimeType: "text/html",
    sizeBytes: 64,
    storageKey: `${serverB.id}/invalid-token.html`,
    thumbnailKey: null,
    contentHash: "feedface05",
  });

  const expiredToken = signPreviewLikeToken({
    attachmentId: htmlAttachmentId,
    serverId: serverB.id,
    actorId: userB.id,
  }, -1);
  const expiredRes = await fetch(
    `${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview?serverId=${serverB.id}&previewToken=${expiredToken}`,
    { redirect: "manual" },
  );
  assert.equal(expiredRes.status, 401, `expected expired preview token to 401, got ${expiredRes.status}`);

  const wrongAudienceToken = signPreviewLikeToken({
    attachmentId: htmlAttachmentId,
    serverId: serverB.id,
    actorId: userB.id,
    audience: "attachment-download",
  });
  const wrongAudienceRes = await fetch(
    `${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview?serverId=${serverB.id}&previewToken=${wrongAudienceToken}`,
    { redirect: "manual" },
  );
  assert.equal(wrongAudienceRes.status, 401, `expected wrong-audience preview token to 401, got ${wrongAudienceRes.status}`);

  const wrongTypeToken = signPreviewLikeToken({
    attachmentId: htmlAttachmentId,
    serverId: serverB.id,
    actorId: userB.id,
    type: "access",
  });
  const wrongTypeRes = await fetch(
    `${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview?serverId=${serverB.id}&previewToken=${wrongTypeToken}`,
    { redirect: "manual" },
  );
  assert.equal(wrongTypeRes.status, 401, `expected wrong-type preview token to 401, got ${wrongTypeRes.status}`);
});

test("HTML preview response rejects leaked user bearer token query after URL minting", async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const db = getDb();
  const htmlAttachmentId = "00000000-0000-4000-8000-0000000000b1";
  await insertLinkedAttachmentsWithObjects({
    id: htmlAttachmentId,
    channelId: channelB.id,
    uploaderId: userB.id,
    uploaderType: "user",
    filename: "bearer.html",
    mimeType: "text/html",
    sizeBytes: 64,
    storageKey: `${serverB.id}/bearer.html`,
    thumbnailKey: null,
    contentHash: "feedface03",
  });
  const tokenB = await tokenForHuman(userB.email);

  const res = await fetch(
    `${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview?serverId=${serverB.id}&token=${tokenB}`,
    { redirect: "manual" },
  );
  assert.equal(res.status, 403, `expected user bearer query token not to authorize HTML preview, got ${res.status}`);
});

test("GET /api/attachments/:id/html-preview-url checks access before previewability", async ({ app }) => {
  const { userA, serverA, attachmentId } = await seedCrossServerFixture();
  const tokenA = await tokenForHuman(userA.email);

  const res = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}/html-preview-url`, {
    headers: {
      Authorization: `Bearer ${tokenA}`,
      "X-Server-Id": serverA.id,
    },
  });
  assert.equal(res.status, 404, `expected cloaked 404 before MIME checks, got ${res.status}`);
});

test("canUserAccessChannel returns false when channel belongs to another server", async ({ app }) => {
  const { userA, userB, serverA, channelB } = await seedCrossServerFixture();

  const { canUserAccessChannel } = await import("../services/channelService");

  // User A (server A member) asking about channel in server B, claiming
  // server A as active — must refuse (cross-server guard).
  assert.equal(
    await canUserAccessChannel(channelB.id, userA.id, asServerId(serverA.id)),
    false,
    "cross-server access should be refused",
  );

  // Same user looking at the same channel but claiming server B — still
  // refused because userA is not a member of server B. (The serverMembers
  // check happens upstream; this just proves the function doesn't
  // over-admit.)
  // User B legitimately accessing channel B on server B — should pass.
  assert.equal(
    await canUserAccessChannel(channelB.id, userB.id, asServerId(channelB.serverId)),
    true,
    "same-server access should be allowed",
  );
});

test("GET /api/attachments/:id/html-preview allows configured web origin framing", async ({ app }) => {

  let filePath: string | null = null;
  try {
    const { userB, serverB, channelB } = await seedCrossServerFixture();
    const db = getDb();
    const htmlAttachmentId = "00000000-0000-4000-8000-0000000000fe";
    const storageKey = `${serverB.id}/preview-frame.html`;
    const html = "<!doctype html><html><body><script>document.body.dataset.ok='1'</script>ok</body></html>";
    filePath = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads"), storageKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, html);
    await insertLinkedAttachmentsWithObjects({
      id: htmlAttachmentId,
      channelId: channelB.id,
      uploaderId: userB.id,
      uploaderType: "user",
      filename: "preview-frame.html",
      mimeType: "text/html",
      sizeBytes: Buffer.byteLength(html),
      storageKey,
      thumbnailKey: null,
      contentHash: "feedface2",
    });
    const tokenB = await tokenForHuman(userB.email);

    const previewUrlRes = await fetch(`${app.baseUrl}/api/attachments/${htmlAttachmentId}/html-preview-url`, {
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "X-Server-Id": serverB.id,
      },
    });
    assert.equal(previewUrlRes.status, 200, `expected preview URL 200, got ${previewUrlRes.status}`);
    const { url } = (await previewUrlRes.json()) as { url: string };

    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(res.headers.get("x-frame-options"), null, "HTML preview must not inherit Helmet SAMEORIGIN");
    assert.match(
      res.headers.get("content-security-policy") || "",
      /frame-ancestors 'self' http:\/\/127\.0\.0\.1:4173/,
    );
    // Original bytes stream unmodified; the static measurement bridge is
    // appended on this preview-only path (attachment comments task #16 —
    // full contract in attachmentPreviewBridge.api.test.ts).
    assert.equal(await res.text(), html + ATTACHMENT_PREVIEW_BRIDGE_SCRIPT);
  } finally {
    if (filePath) fs.rmSync(filePath, { force: true });
    await app.close();
  }
});

test("HTML preview MIME helper handles charset suffixes", () => {
  assert.equal(isHtmlAttachmentMimeType(resolveAttachmentMimeType("report.html", "text/html; charset=utf-8")), true);
});

test("authenticated preview forbids shared and persistent caches", async ({ app }) => {
  const { userB, serverB, attachmentId } = await seedCrossServerFixture();
  const token = await tokenForHuman(userB.email);
  __setStorageForTests({ async put() {}, async delete() {}, async get() { return Readable.from(["audit-private-preview"]); } });
  try {
  const response = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}/preview`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverB.id },
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  } finally { resetStorageForTests(); }
});

// Storage step 2c: every attachment projection is bound to an object; the
// database refuses one without (attachments.object_id is NOT NULL), so the
// objectless read path no longer exists.
test("the database refuses an attachment projection without an object", async ({ db }) => {
  const { attachmentId } = await seedCrossServerFixture();
  await assert.rejects(
    db.update(attachments).set({ objectId: null as unknown as string }).where(eq(attachments.id, attachmentId)),
  );
});

for (const denial of ["cannot-post", "quota"] as const) test(`legacy upload rejects ${denial} before storage`, async ({ app }) => {
  const { userB, serverB, channelB } = await seedCrossServerFixture();
  const schema = await import("../db/schema");
  const plan = await import("../services/planService");
  let writes = 0;
  const quota = vi.spyOn(plan, "isChannelReadOnlyByQuota").mockResolvedValue(denial === "quota");
  if (denial === "cannot-post") await getDb().delete(schema.channelHumans).where(eq(schema.channelHumans.channelId, channelB.id));
  __setStorageForTests({ async put() { writes++; }, async delete() {}, async get() { return Readable.from([]); } });
  try {
    const body = new FormData(); body.set("channelId", channelB.id); body.append("files", new Blob(["audit upload"]), "audit.txt");
    const response = await fetch(`${app.baseUrl}/api/attachments/upload`, {
      method: "POST", body, headers: { Authorization: `Bearer ${await accessTokenForTest(userB.id)}`, "X-Server-Id": serverB.id },
    });
    assert.equal(response.status, 403, await response.text());
    assert.equal(writes, 0);
  } finally { quota.mockRestore(); resetStorageForTests(); }
});
