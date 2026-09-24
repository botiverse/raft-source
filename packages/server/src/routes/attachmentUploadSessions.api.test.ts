import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  PLAN_CONFIG,
  type ServerId,
} from "@botiverse/raft-shared";
import { ATTACHMENT_UPLOAD_MAX_SIZE_BYTES } from "@botiverse/raft-shared/src/attachmentUploadContract.js";
import { getDb } from "../db/index.js";
import {
  attachments,
  channels,
  jointChannels,
  jointChannelServers,
  serverFileUploadUsageMonths,
  servers,
  users,
} from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import {
  addHuman,
  canUserAccessChannel,
  canUserPostToChannel,
  createChannel,
} from "../services/channelService.js";
import { isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService.js";
import { addMember, createServer } from "../services/serverService.js";
import { billingUsageMonth } from "../services/fileUploadQuotaService.js";
import { openTestApp } from "../test/integration/app.js";
import type {
  AttachmentUploadSessionContext,
  AttachmentUploadSessionResult,
  AttachmentUploadSessionService,
  CreateAttachmentUploadSessionInput,
} from "./attachmentUploadSessions.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type StoredSession = {
  context: AttachmentUploadSessionContext;
  input: CreateAttachmentUploadSessionInput;
  uploadId: string;
  attachmentId: string;
  state: "pending" | "completed" | "canceled";
  expiresAt: string;
};

class FakeAttachmentUploadSessionService implements AttachmentUploadSessionService {
  readonly calls = { capabilities: 0, create: 0, complete: 0, cancel: 0, status: 0 };
  readonly sessions = new Map<string, StoredSession>();
  readonly requestKeys = new Map<string, string>();
  nextResult: AttachmentUploadSessionResult | null = null;
  nextCompleteResult: AttachmentUploadSessionResult | null = null;

  async capabilities(): Promise<AttachmentUploadSessionResult> {
    this.calls.capabilities += 1;
    return {
      status: 200,
      body: {
        directUploadEnabled: true,
        directUploadThresholdBytes: 90 * 1024 * 1024,
        maxBytes: ATTACHMENT_UPLOAD_MAX_SIZE_BYTES,
        sessionExpiresInSeconds: 900,
      },
    };
  }

  async create(
    context: AttachmentUploadSessionContext,
    input: CreateAttachmentUploadSessionInput,
  ): Promise<AttachmentUploadSessionResult> {
    this.calls.create += 1;
    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = null;
      return result;
    }
    const requestKey = `${context.serverId}:${context.userId}:${input.clientRequestId}`;
    const existingUploadId = this.requestKeys.get(requestKey);
    if (existingUploadId) {
      const existing = this.sessions.get(existingUploadId)!;
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) {
        return {
          status: 409,
          body: {
            code: "UPLOAD_IDEMPOTENCY_CONFLICT",
            message: "The request id was used for a different upload.",
            retryable: false,
          },
        };
      }
      return { status: 201, body: this.createBody(existing) };
    }
    const session: StoredSession = {
      context,
      input,
      uploadId: randomUUID(),
      attachmentId: randomUUID(),
      state: "pending",
      expiresAt: "2026-07-25T15:00:00.000Z",
    };
    this.sessions.set(session.uploadId, session);
    this.requestKeys.set(requestKey, session.uploadId);
    return { status: 201, body: this.createBody(session) };
  }

  async complete(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult> {
    this.calls.complete += 1;
    if (this.nextCompleteResult) {
      const result = this.nextCompleteResult;
      this.nextCompleteResult = null;
      return result;
    }
    const session = this.owned(context, uploadId);
    if (!session) {
      return {
        status: 403,
        body: { code: "UPLOAD_FORBIDDEN", message: "The member cannot complete this upload.", retryable: false },
      };
    }
    session.state = "completed";
    return {
      status: 200,
      body: {
        uploadId,
        state: "completed",
        attachment: this.attachment(session),
      },
    };
  }

  async cancel(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult> {
    this.calls.cancel += 1;
    const session = this.owned(context, uploadId);
    if (!session) return this.notFound();
    session.state = "canceled";
    return { status: 200, body: this.sessionBody(session) };
  }

  async status(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult> {
    this.calls.status += 1;
    const session = this.owned(context, uploadId);
    return session ? { status: 200, body: this.sessionBody(session) } : this.notFound();
  }

  private owned(context: AttachmentUploadSessionContext, uploadId: string): StoredSession | null {
    const session = this.sessions.get(uploadId);
    return session?.context.serverId === context.serverId && session.context.userId === context.userId
      ? session
      : null;
  }

  private notFound(): AttachmentUploadSessionResult {
    return {
      status: 404,
      body: { code: "UPLOAD_SESSION_NOT_FOUND", message: "The upload session does not exist.", retryable: false },
    };
  }

  private attachment(session: StoredSession) {
    return {
      id: session.attachmentId,
      filename: session.input.filename,
      mimeType: session.input.mimeType,
      sizeBytes: session.input.sizeBytes,
      thumbnailUrl: null,
    };
  }

  private sessionBody(session: StoredSession) {
    return {
      uploadId: session.uploadId,
      state: session.state,
      expiresAt: session.expiresAt,
      attachment: session.state === "completed" ? this.attachment(session) : null,
      terminalReason: session.state === "canceled" ? "Canceled by member." : null,
    };
  }

  private createBody(session: StoredSession) {
    return {
      uploadId: session.uploadId,
      attachmentId: session.attachmentId,
      state: "pending",
      expiresAt: session.expiresAt,
      upload: {
        method: "PUT",
        url: `https://upload.invalid/${session.uploadId}`,
        headers: { "Content-Type": session.input.mimeType, "If-None-Match": "*" },
      },
    };
  }
}

async function seedVerifiedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}_${randomUUID().replaceAll("-", "")}`,
    displayName: label,
    passwordHash: "test-only-unused-password-hash",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function seedMemberFixture() {
  const owner = await seedVerifiedUser("Upload Owner");
  const server = await createServer("Upload Sessions", `upload-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "uploads", undefined, "channel");
  await addHuman(channel.id, owner.id);
  return {
    owner,
    server: { ...server, id: server.id as ServerId },
    channel,
    headers: {
      Authorization: `Bearer ${signAccessToken(owner.id)}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
  };
}

function createInput(channelId: string, overrides: Partial<CreateAttachmentUploadSessionInput> = {}) {
  return {
    channelId,
    filename: "evidence.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1024,
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

test("default createApp keeps disabled P2 mutation paths typed instead of falling through", async ({ app }) => {
  const fixture = await seedMemberFixture();
  const paths = [
    ["POST", "/api/attachments/upload-sessions"],
    ["POST", `/api/attachments/upload-sessions/${randomUUID()}/complete`],
    ["DELETE", `/api/attachments/upload-sessions/${randomUUID()}`],
    ["GET", `/api/attachments/upload-sessions/${randomUUID()}`],
  ] as const;
  for (const [method, path] of paths) {
    const actual = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers: fixture.headers,
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(actual.status, 403, `${method} ${path} status is typed disabled`);
    assert.deepEqual(await json(actual), {
      code: "UPLOAD_FORBIDDEN",
      message: "The member cannot upload to this channel.",
      retryable: false,
    });
  }
});

test("enabled fake declines legacy upload and computer-auth download before P2 middleware", async () => {
  const fake = new FakeAttachmentUploadSessionService();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, attachmentUploadSessionService: fake });
  try {
    const fixture = await seedMemberFixture();

    const legacyUpload = await fetch(`${app.baseUrl}/api/attachments/upload`, {
      method: "POST",
      headers: fixture.headers,
      body: "{}",
    });
    assert.equal(legacyUpload.status, 400, "legacy upload still reaches its canonical no-file boundary");
    assert.equal(fake.calls.create, 0, "legacy upload never enters the P2 service");

    const attachmentId = randomUUID();
    await getDb().insert(attachments).values({
      id: attachmentId,
      channelId: fixture.channel.id,
      uploaderId: fixture.owner.id,
      uploaderType: "user",
      filename: "computer-download.txt",
      mimeType: "text/plain",
      sizeBytes: 42,
      storageKey: `${fixture.server.id}/computer-download.txt`,
      thumbnailKey: null,
      contentHash: "computerdownload",
    });

    const attach = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: {
        Authorization: fixture.headers.Authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverSlug: fixture.server.slug, name: "p2-regression-computer" }),
    });
    assert.equal(attach.status, 201);
    const { apiKey } = await json(attach) as { apiKey: string };
    assert.match(apiKey, /^sk_computer_/);

    const download = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "manual",
    });
    assert.notEqual(download.status, 401, "legacy download still reaches canonical requireFlexAuth");
    assert.notEqual(download.status, 403, "computer credential keeps canonical same-server scope");
    assert.equal(fake.calls.status, 0, "legacy attachment UUID never enters the P2 service");
  } finally {
    await app.close();
  }
});

test("enabled fake uses canonical admission and P1 response schemas for the lifecycle", async () => {
  const fake = new FakeAttachmentUploadSessionService();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, attachmentUploadSessionService: fake });
  try {
    const fixture = await seedMemberFixture();
    const input = createInput(fixture.channel.id);
    const capabilities = await fetch(`${app.baseUrl}/api/attachments/upload-capabilities`, {
      headers: fixture.headers,
    });
    assert.equal(capabilities.status, 200);
    assert.deepEqual(await json(capabilities), {
      directUploadEnabled: true,
      directUploadThresholdBytes: 90 * 1024 * 1024,
      maxBytes: ATTACHMENT_UPLOAD_MAX_SIZE_BYTES,
      sessionExpiresInSeconds: 900,
    });
    assert.equal(fake.calls.capabilities, 1);
    const unauthenticated = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(unauthenticated.status, 401);
    const missingServer = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: {
        Authorization: fixture.headers.Authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    assert.equal(missingServer.status, 400);
    const wrongServer = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: { ...fixture.headers, "X-Server-Id": randomUUID() },
      body: JSON.stringify(input),
    });
    assert.equal(wrongServer.status, 403);
    assert.equal(fake.calls.create, 0, "shared auth boundary stops before P2 service");

    const create = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(input),
    });
    assert.equal(create.status, 201);
    const created = await json(create) as { uploadId: string; upload: { url: string } };
    assert.match(created.upload.url, /^https:\/\/upload\.invalid\//);

    const replay = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(input),
    });
    assert.equal(replay.status, 201);
    assert.equal((await json(replay) as { uploadId: string }).uploadId, created.uploadId);

    const conflict = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ ...input, filename: "changed.mp4" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await json(conflict) as { code: string }).code, "UPLOAD_IDEMPOTENCY_CONFLICT");

    const status = await fetch(`${app.baseUrl}/api/attachments/upload-sessions/${created.uploadId}`, {
      headers: fixture.headers,
    });
    assert.equal(status.status, 200);
    const cancel = await fetch(`${app.baseUrl}/api/attachments/upload-sessions/${created.uploadId}`, {
      method: "DELETE",
      headers: fixture.headers,
    });
    assert.equal(cancel.status, 200);
    assert.equal((await json(cancel) as { state: string }).state, "canceled");

    const secondInput = createInput(fixture.channel.id);
    const secondCreate = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(secondInput),
    });
    const second = await json(secondCreate) as { uploadId: string };
    const complete = await fetch(`${app.baseUrl}/api/attachments/upload-sessions/${second.uploadId}/complete`, {
      method: "POST",
      headers: fixture.headers,
      body: "{}",
    });
    assert.equal(complete.status, 200);
    assert.equal((await json(complete) as { state: string }).state, "completed");

    const completeOutcomes: AttachmentUploadSessionResult[] = [
      {
        status: 404,
        body: {
          code: "UPLOAD_OBJECT_NOT_FOUND",
          message: "The uploaded object is not visible yet.",
          retryable: true,
          retryAfterMs: 500,
        },
      },
      {
        status: 409,
        body: {
          code: "UPLOAD_VERIFICATION_IN_PROGRESS",
          message: "Verification is already in progress.",
          retryable: true,
          retryAfterMs: 1000,
        },
      },
      {
        status: 410,
        body: { code: "UPLOAD_SESSION_EXPIRED", message: "The upload session expired.", retryable: false },
      },
      {
        status: 422,
        body: {
          code: "UPLOAD_OBJECT_MISMATCH",
          message: "The uploaded object does not match the reservation.",
          retryable: false,
        },
      },
    ];
    for (const outcome of completeOutcomes) {
      fake.nextCompleteResult = outcome;
      const response = await fetch(`${app.baseUrl}/api/attachments/upload-sessions/${second.uploadId}/complete`, {
        method: "POST",
        headers: fixture.headers,
        body: "{}",
      });
      assert.equal(response.status, outcome.status);
      assert.equal((await json(response) as { code: string }).code, (outcome.body as { code: string }).code);
    }

    for (const [method, operation] of [["GET", "status"], ["DELETE", "cancel"]] as const) {
      const response = await fetch(`${app.baseUrl}/api/attachments/upload-sessions/${randomUUID()}`, {
        method,
        headers: fixture.headers,
      });
      assert.equal(response.status, 404, `${operation} hides unknown sessions`);
      assert.equal((await json(response) as { code: string }).code, "UPLOAD_SESSION_NOT_FOUND");
    }

    const invalid = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ ...createInput(fixture.channel.id), sizeBytes: 0 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid) as { code: string }).code, "UPLOAD_INVALID_REQUEST");

    const tooLarge = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(fixture.channel.id, { sizeBytes: ATTACHMENT_UPLOAD_MAX_SIZE_BYTES })),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await json(tooLarge) as { code: string }).code, "UPLOAD_TOO_LARGE");

    const usageBeforeQuotaFixture = await getDb()
      .select({ month: serverFileUploadUsageMonths.month })
      .from(serverFileUploadUsageMonths)
      .where(eq(serverFileUploadUsageMonths.serverId, fixture.server.id));
    assert.deepEqual(usageBeforeQuotaFixture, [], "P2 create never mutates the durable quota aggregate");

    await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, fixture.channel.id));
    const archived = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(fixture.channel.id)),
    });
    assert.equal(archived.status, 403);
    assert.equal((await json(archived) as { code: string }).code, "UPLOAD_FORBIDDEN");
    await getDb().update(channels).set({ archivedAt: null }).where(eq(channels.id, fixture.channel.id));

    await getDb().insert(serverFileUploadUsageMonths).values({
      serverId: fixture.server.id,
      month: billingUsageMonth(),
      usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
      reservedBytes: 0,
    });
    const quotaDenied = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(fixture.channel.id)),
    });
    assert.equal(quotaDenied.status, 403);
    assert.equal((await json(quotaDenied) as { code: string }).code, "UPLOAD_FORBIDDEN");

    const [privateChannel] = await getDb().insert(channels).values({
      serverId: fixture.server.id,
      name: `private-${randomUUID()}`,
      type: "private",
    }).returning();
    const forbidden = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(privateChannel.id)),
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await json(forbidden) as { code: string }).code, "UPLOAD_FORBIDDEN");
    assert.equal(fake.calls.create, 4, "invalid and denied requests never reach the fake");

    const statusCallsBeforeMalformed = fake.calls.status;
    const malformed = await fetch(`${app.baseUrl}/api/attachments/upload-sessions/not-a-uuid`, {
      headers: fixture.headers,
    });
    assert.equal(malformed.status, 404, "malformed uploadId stays on the framework routing boundary");
    assert.equal(fake.calls.status, statusCallsBeforeMalformed);
  } finally {
    await app.close();
  }
});

test("enabled fake exercises distinct post, channel quota, Joint entitlement, and Pro size admission", async () => {
  const fake = new FakeAttachmentUploadSessionService();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, attachmentUploadSessionService: fake });
  try {
    const fixture = await seedMemberFixture();
    const expectDenied = async (channelId: string, label: string) => {
      const callsBefore = fake.calls.create;
      const response = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify(createInput(channelId)),
      });
      assert.equal(response.status, 403, label);
      assert.equal((await json(response) as { code: string }).code, "UPLOAD_FORBIDDEN", label);
      assert.equal(fake.calls.create, callsBefore, `${label} stops before the fake`);
    };

    const visibleWithoutPost = await createChannel(
      fixture.server.id,
      `visible-without-post-${randomUUID()}`,
      undefined,
      "channel",
    );
    assert.equal(
      await canUserAccessChannel(visibleWithoutPost.id, fixture.owner.id, fixture.server.id),
      true,
      "public visibility is present",
    );
    assert.equal(
      await canUserPostToChannel(visibleWithoutPost.id, fixture.owner.id),
      false,
      "visibility does not imply channel post membership",
    );
    await expectDenied(visibleWithoutPost.id, "missing post authority is denied independently of visibility");

    const originalMaxChannels = PLAN_CONFIG.free.limits.maxChannels;
    try {
      PLAN_CONFIG.free.limits.maxChannels = 0;
      assert.equal(
        await isChannelReadOnlyByQuota(fixture.channel.id, fixture.server.id),
        true,
        "the canonical quota service marks the channel read-only",
      );
      await expectDenied(fixture.channel.id, "channel-quota read-only is denied");
    } finally {
      PLAN_CONFIG.free.limits.maxChannels = originalMaxChannels;
    }

    const freeCanonical = await createChannel(fixture.server.id, `free-joint-canonical-${randomUUID()}`);
    await getDb().insert(jointChannels).values({
      canonicalChannelId: freeCanonical.id,
      createdByServerId: fixture.server.id,
      createdByUserId: fixture.owner.id,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const canonical = await createChannel(fixture.server.id, `joint-canonical-${randomUUID()}`);
    const projection = await createChannel(
      fixture.server.id,
      `joint-projection-${randomUUID()}`,
      undefined,
      "joint",
    );
    await addHuman(projection.id, fixture.owner.id);
    const [joint] = await getDb().insert(jointChannels).values({
      canonicalChannelId: canonical.id,
      createdByServerId: fixture.server.id,
      createdByUserId: fixture.owner.id,
      createdAt: new Date("2026-08-02T00:00:00Z"),
    }).returning();
    await getDb().insert(jointChannelServers).values({
      jointChannelId: joint.id,
      serverId: fixture.server.id,
      localChannelId: projection.id,
      role: "host",
      joinedByUserId: fixture.owner.id,
    });
    assert.equal(
      await canUserAccessChannel(projection.id, fixture.owner.id, fixture.server.id),
      true,
      "the Joint projection is visible",
    );
    assert.equal(await canUserPostToChannel(projection.id, fixture.owner.id), true, "the member can post to the Joint projection");
    assert.equal(
      await isChannelReadOnlyByBillingFeature(
        projection.id,
        fixture.server.id,
        new Date("2040-01-01T00:00:00Z"),
      ),
      true,
      "a second Free-hosted Joint projection is read-only even far in the future",
    );
    await expectDenied(projection.id, "Joint entitlement read-only is denied");

    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fixture.server.id));
    const proSize = FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES + 1;
    const proCreate = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(fixture.channel.id, { sizeBytes: proSize })),
    });
    assert.equal(proCreate.status, 201, "Pro accepts a file above the Free 50 MiB single-file limit");
    assert.match((await json(proCreate) as { uploadId: string }).uploadId, /^[0-9a-f-]{36}$/);
    assert.equal(fake.calls.create, 1, "only the Pro success reaches the fake");
  } finally {
    await app.close();
  }
});

test("existing sessions are non-disclosing across actors and servers and malformed UUIDs never reach the fake", async () => {
  const fake = new FakeAttachmentUploadSessionService();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, attachmentUploadSessionService: fake });
  try {
    const fixture = await seedMemberFixture();
    const create = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(fixture.channel.id)),
    });
    assert.equal(create.status, 201);
    const { uploadId } = await json(create) as { uploadId: string };

    const otherActor = await seedVerifiedUser("Upload Other Actor");
    await addMember(fixture.server.id, otherActor.id);
    const otherActorHeaders = {
      ...fixture.headers,
      Authorization: `Bearer ${signAccessToken(otherActor.id)}`,
    };
    const otherServer = await createServer(
      "Upload Other Server",
      `upload-other-${randomUUID()}`,
      fixture.owner.id,
    );
    const otherServerHeaders = { ...fixture.headers, "X-Server-Id": otherServer.id };

    const existingSessionOperations = [
      { label: "status", method: "GET", suffix: "" },
      { label: "cancel", method: "DELETE", suffix: "" },
    ] as const;
    for (const identity of [
      { label: "wrong actor", headers: otherActorHeaders },
      { label: "wrong server", headers: otherServerHeaders },
    ]) {
      for (const operation of existingSessionOperations) {
        const response = await fetch(
          `${app.baseUrl}/api/attachments/upload-sessions/${uploadId}${operation.suffix}`,
          { method: operation.method, headers: identity.headers },
        );
        assert.equal(response.status, 404, `${identity.label} ${operation.label} hides an existing session`);
        assert.equal(
          (await json(response) as { code: string }).code,
          "UPLOAD_SESSION_NOT_FOUND",
          `${identity.label} ${operation.label} uses the non-disclosing envelope`,
        );
      }
    }

    const ownerStatus = await fetch(`${app.baseUrl}/api/attachments/upload-sessions/${uploadId}`, {
      headers: fixture.headers,
    });
    assert.equal(ownerStatus.status, 200);
    assert.equal((await json(ownerStatus) as { state: string }).state, "pending", "cross-scope probes do not mutate the session");

    const malformedOperations = [
      { label: "status", method: "GET", suffix: "" },
      { label: "cancel", method: "DELETE", suffix: "" },
      { label: "complete", method: "POST", suffix: "/complete" },
    ] as const;
    for (const operation of malformedOperations) {
      const callsBefore = { ...fake.calls };
      const response = await fetch(
        `${app.baseUrl}/api/attachments/upload-sessions/not-a-uuid${operation.suffix}`,
        { method: operation.method, headers: fixture.headers, body: operation.method === "POST" ? "{}" : undefined },
      );
      assert.equal(response.status, 404, `malformed UUID stays outside the ${operation.label} contract route`);
      assert.deepEqual(fake.calls, callsBefore, `malformed UUID never calls fake ${operation.label}`);
    }
  } finally {
    await app.close();
  }
});

test("bad fake output fails closed without returning the invalid body", async () => {
  const fake = new FakeAttachmentUploadSessionService();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, attachmentUploadSessionService: fake });
  try {
    const fixture = await seedMemberFixture();
    fake.nextResult = { status: 201, body: { url: "https://secret.invalid/leak" } };
    const res = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(fixture.channel.id)),
    });
    assert.equal(res.status, 500);
    const body = await json(res) as { code: string; url?: string };
    assert.equal(body.code, "attachment_upload_contract_violation");
    assert.equal(body.url, undefined);
  } finally {
    await app.close();
  }
});

test("capabilities returns typed disabled response instead of falling through to attachment serve when service is absent", async ({ app }) => {
  const fixture = await seedMemberFixture();
  const res = await fetch(`${app.baseUrl}/api/attachments/upload-capabilities`, {
    headers: fixture.headers,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    directUploadEnabled: false,
    directUploadThresholdBytes: null,
    maxBytes: FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
    sessionExpiresInSeconds: null,
  });
});

test("disabled direct upload advertises the legacy-safe limit without applying the direct threshold", async () => {
  const previous = process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
  process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = String(10 * 1024 * 1024);
  let app: Awaited<ReturnType<typeof openTestApp>> | undefined;
  try {
    app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const fixture = await seedMemberFixture();
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fixture.server.id));
    const res = await fetch(`${app.baseUrl}/api/attachments/upload-capabilities`, {
      headers: fixture.headers,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), {
      directUploadEnabled: false,
      directUploadThresholdBytes: null,
      maxBytes: 90 * 1024 * 1024,
      sessionExpiresInSeconds: null,
    });
  } finally {
    await app?.close();
    if (previous === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = previous;
  }
});

test("disabled direct upload session mutation paths fail typed instead of reaching broad attachment routes", async ({ app }) => {
  const fixture = await seedMemberFixture();
  const create = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
    method: "POST",
    headers: fixture.headers,
    body: JSON.stringify(createInput(fixture.channel.id)),
  });
  assert.equal(create.status, 403);
  assert.deepEqual(await json(create), {
    code: "UPLOAD_FORBIDDEN",
    message: "The member cannot upload to this channel.",
    retryable: false,
  });
});

test("dedicated create limiter emits the declared typed 429 and does not reach the fake", async () => {
  const fake = new FakeAttachmentUploadSessionService();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, attachmentUploadSessionService: fake });
  try {
    const fixture = await seedMemberFixture();
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify(createInput(fixture.channel.id)),
      });
      assert.equal(response.status, 201);
    }
    const limited = await fetch(`${app.baseUrl}/api/attachments/upload-sessions`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(createInput(fixture.channel.id)),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await json(limited), {
      code: "UPLOAD_RATE_LIMITED",
      message: "Too many upload sessions were created.",
      retryable: true,
      retryAfterMs: 60_000,
    });
    assert.equal(fake.calls.create, 10);
  } finally {
    await app.close();
  }
});
