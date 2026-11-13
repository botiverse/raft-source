import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import express from "express";

import { closeDatabase, getDb, initDatabase } from "../db/index";
import {
  externalActorProjections,
  externalProjectionAvatarArtifacts,
  servers,
  users,
} from "../db/schema";
import {
  materializeExternalProjectionAvatar,
  normalizeExternalAvatarRaster,
  type ExternalAvatarSourceAdapter,
} from "./externalAvatarMaterializerService";
import { createSlackAvatarSourceAdapter } from "./slackAvatarSourceAdapter";
import type { StorageBackend } from "./storageService";
import { __setCdnStorageForTests, resetStorageForTests } from "./storageService";
import { externalAvatarPublicRouter } from "../routes/externalAvatars";

const NOW = new Date("2026-09-05T03:00:00.000Z");

class MemoryStorage implements StorageBackend {
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  async put(key: string, data: Buffer): Promise<void> { this.objects.set(key, Buffer.from(data)); }
  async get(key: string): Promise<Readable> {
    const value = this.objects.get(key);
    if (!value) throw new Error("missing object");
    return Readable.from(value);
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

beforeEach(async () => { await initDatabase("pglite://"); });
afterEach(async () => {
  resetStorageForTests();
  await closeDatabase();
});

async function raster(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 96, height: 80, channels: 3, background: color } }).png().toBuffer();
}

async function externalFixture() {
  const db = getDb();
  const [projection] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: "U_AVATAR",
    displayName: "Avatar User",
    handles: ["avatar-user"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  return { db, projection, storage: new MemoryStorage() };
}

function source(values: Record<string, Buffer>) {
  let calls = 0;
  const adapter: ExternalAvatarSourceAdapter = {
    provider: "slack",
    async readSource({ locator }) {
      calls += 1;
      const value = values[locator];
      if (!value) throw new Error("avatar_source_unavailable");
      return value;
    },
  };
  return { adapter, calls: () => calls };
}

test("external avatar normalization activates one controlled revision and same locator is zero-I/O idempotent", async () => {
  const state = await externalFixture();
  const locator = "https://avatars.slack-edge.com/avatar-a.png";
  const provider = source({ [locator]: await raster({ r: 20, g: 40, b: 60 }) });
  const first = await materializeExternalProjectionAvatar({
    db: state.db,
    storage: state.storage,
    source: provider.adapter,
    projectionId: state.projection.id,
    expectedProjectionRevision: 1,
    sourceLocator: locator,
    publicOrigin: "https://api.raft.test",
    now: () => NOW,
  });
  assert.equal(first.kind, "activated");
  if (first.kind !== "activated") return;
  assert.equal(provider.calls(), 1);
  assert.equal(first.artifact.publicUrl.includes(locator), false);
  assert.match(first.artifact.publicUrl, /^https:\/\/api\.raft\.test\/api\/external-avatars\/[0-9a-f-]+\.webp$/u);
  assert.equal(first.artifact.mimeType, "image/webp");
  assert.equal(first.artifact.width, 256);
  assert.equal(first.artifact.height, 256);
  assert.ok(first.artifact.storageKey && state.storage.objects.has(first.artifact.storageKey));
  const [actor] = await state.db.select().from(externalActorProjections)
    .where(eq(externalActorProjections.id, state.projection.id));
  assert.equal(actor.avatarArtifactId, first.artifact.id);
  assert.equal(actor.projectionRevision, 2);

  const replay = await materializeExternalProjectionAvatar({
    db: state.db,
    storage: state.storage,
    source: provider.adapter,
    projectionId: actor.id,
    expectedProjectionRevision: actor.projectionRevision,
    sourceLocator: locator,
    publicOrigin: "https://api.raft.test",
    now: () => NOW,
  });
  assert.equal(replay.kind, "unchanged");
  assert.equal(provider.calls(), 1);
  assert.equal((await state.db.select().from(externalProjectionAvatarArtifacts)).length, 1);
});

test("changed avatar atomically swaps revision, revokes old serving authority, and deletes old bytes", async () => {
  const state = await externalFixture();
  const firstLocator = "https://avatars.slack-edge.com/avatar-a.png";
  const secondLocator = "https://avatars.slack-edge.com/avatar-b.png";
  const rotatedLocator = "https://avatars.slack-edge.com/avatar-b-rotated.png";
  const secondRaster = await raster({ r: 90, g: 80, b: 70 });
  const provider = source({
    [firstLocator]: await raster({ r: 20, g: 40, b: 60 }),
    [secondLocator]: secondRaster,
    [rotatedLocator]: secondRaster,
  });
  const first = await materializeExternalProjectionAvatar({
    db: state.db, storage: state.storage, source: provider.adapter,
    projectionId: state.projection.id, expectedProjectionRevision: 1,
    sourceLocator: firstLocator, publicOrigin: "https://api.raft.test", now: () => NOW,
  });
  assert.equal(first.kind, "activated");
  if (first.kind !== "activated") return;
  const second = await materializeExternalProjectionAvatar({
    db: state.db, storage: state.storage, source: provider.adapter,
    projectionId: state.projection.id, expectedProjectionRevision: 2,
    sourceLocator: secondLocator, publicOrigin: "https://api.raft.test",
    now: () => new Date(NOW.getTime() + 1_000),
  });
  assert.equal(second.kind, "activated");
  if (second.kind !== "activated") return;
  assert.equal(second.artifact.artifactRevision, 2);
  const artifacts = await state.db.select().from(externalProjectionAvatarArtifacts)
    .orderBy(externalProjectionAvatarArtifacts.artifactRevision);
  assert.deepEqual(artifacts.map((artifact) => artifact.state), ["revoked", "active"]);
  assert.ok(first.artifact.storageKey);
  assert.equal(state.storage.objects.has(first.artifact.storageKey), false);
  assert.ok(state.storage.deleted.includes(first.artifact.storageKey));
  const sameBytes = await materializeExternalProjectionAvatar({
    db: state.db, storage: state.storage, source: provider.adapter,
    projectionId: state.projection.id, expectedProjectionRevision: 3,
    sourceLocator: rotatedLocator, publicOrigin: "https://api.raft.test",
    now: () => new Date(NOW.getTime() + 2_000),
  });
  assert.equal(sameBytes.kind, "unchanged");
  assert.equal((await state.db.select().from(externalProjectionAvatarArtifacts)).length, 2);
});

test("invalid raster leaves the prior artifact and projection revision unchanged", async () => {
  const state = await externalFixture();
  const [prior] = await state.db.insert(externalProjectionAvatarArtifacts).values({
    ownerType: "external_projection",
    ownerId: state.projection.id,
    sourceDigest: "a".repeat(64),
    sourceLocatorDigest: "b".repeat(64),
    storageKey: `external-avatars/external_projection/${state.projection.id}/${randomUUID()}.webp`,
    publicUrl: `https://api.raft.test/api/external-avatars/${randomUUID()}.webp`,
    mimeType: "image/webp",
    byteSize: 100,
    width: 256,
    height: 256,
    artifactRevision: 1,
    state: "active",
  }).returning();
  await state.db.update(externalActorProjections).set({ avatarArtifactId: prior.id })
    .where(eq(externalActorProjections.id, state.projection.id));
  const locator = "https://avatars.slack-edge.com/not-an-image.png";
  const provider = source({ [locator]: Buffer.from("<svg><script/></svg>") });
  const result = await materializeExternalProjectionAvatar({
    db: state.db, storage: state.storage, source: provider.adapter,
    projectionId: state.projection.id, expectedProjectionRevision: 1,
    sourceLocator: locator, publicOrigin: "https://api.raft.test", now: () => NOW,
  });
  assert.deepEqual(result, { kind: "source_unavailable", reason: "avatar_source_raster_invalid" });
  const [actor] = await state.db.select().from(externalActorProjections)
    .where(eq(externalActorProjections.id, state.projection.id));
  const artifacts = await state.db.select().from(externalProjectionAvatarArtifacts);
  assert.equal(actor.avatarArtifactId, prior.id);
  assert.equal(actor.projectionRevision, 1);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]!.state, "active");
});

test("additional pair authority is rechecked after avatar upload and stale bytes are removed", async () => {
  const state = await externalFixture();
  const locator = "https://avatars.slack-edge.com/synthetic-pair-avatar.png";
  const provider = source({ [locator]: await raster({ r: 22, g: 33, b: 44 }) });
  let checks = 0;
  const result = await materializeExternalProjectionAvatar({ db: state.db, storage: state.storage, source: provider.adapter,
    projectionId: state.projection.id, expectedProjectionRevision: 1, sourceLocator: locator,
    publicOrigin: "https://api.raft.test", now: () => NOW, async lockAdditionalAuthority() { checks++; return checks === 1; } });
  assert.equal(result.kind, "authority_stale");
  assert.equal(checks, 2);
  const [actor] = await state.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, state.projection.id));
  assert.equal(actor.avatarArtifactId, null);
  assert.equal(state.storage.objects.size, 0);
  const artifacts = await state.db.select().from(externalProjectionAvatarArtifacts);
  assert.ok(artifacts.every(artifact => artifact.state === "revoked"));
});

test.each(["revision", "observation"])("projection %s drift during fetch creates no artifact or storage residue", async (drift) => {
  const state = await externalFixture();
  const image = await raster({ r: 44, g: 55, b: 66 });
  const sourceAdapter: ExternalAvatarSourceAdapter = {
    provider: "slack",
    async readSource() {
      await state.db.update(externalActorProjections).set(drift === "revision"
        ? { projectionRevision: 2 } : { observedAt: new Date(NOW.getTime() + 1) })
        .where(eq(externalActorProjections.id, state.projection.id));
      return image;
    },
  };
  const result = await materializeExternalProjectionAvatar({
    db: state.db,
    storage: state.storage,
    source: sourceAdapter,
    projectionId: state.projection.id,
    expectedProjectionRevision: 1,
    expectedObservedAt: NOW,
    sourceLocator: "https://avatars.slack-edge.com/drift.png",
    publicOrigin: "https://api.raft.test",
    now: () => NOW,
  });
  assert.deepEqual(result, { kind: "authority_stale" });
  assert.equal((await state.db.select().from(externalProjectionAvatarArtifacts)).length, 0);
  assert.equal(state.storage.objects.size, 0);
});

test("Slack avatar source accepts only exact image hosts and never forwards authorization", async () => {
  const image = await raster({ r: 1, g: 2, b: 3 });
  const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  const adapter = createSlackAvatarSourceAdapter({
    fetch: (async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      return new Response(new Uint8Array(image), { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch,
  });
  const value = await adapter.readSource({
    locator: "https://avatars.slack-edge.com/2026/avatar.png",
    signal: new AbortController().signal,
  });
  assert.deepEqual(value, image);
  assert.deepEqual(requests, [{
    url: "https://avatars.slack-edge.com/2026/avatar.png",
    authorization: null,
    redirect: "error",
  }]);
  await assert.rejects(adapter.readSource({
    locator: "https://avatars.slack-edge.com.evil.test/avatar.png",
    signal: new AbortController().signal,
  }), /avatar_source_locator_invalid/u);
  assert.equal(requests.length, 1);
});

test("Slack avatar redirect and declared oversize are rejected without following or decoding", async () => {
  let calls = 0;
  const redirected = createSlackAvatarSourceAdapter({
    fetch: (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/avatar.png" },
      });
    }) as typeof fetch,
  });
  await assert.rejects(redirected.readSource({
    locator: "https://avatars.slack-edge.com/redirect.png",
    signal: new AbortController().signal,
  }), /avatar_source_unavailable/u);
  assert.equal(calls, 1);

  const oversized = createSlackAvatarSourceAdapter({
    fetch: (async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(5 * 1024 * 1024 + 1),
      },
    })) as typeof fetch,
  });
  await assert.rejects(oversized.readSource({
    locator: "https://secure.gravatar.com/avatar/oversized",
    signal: new AbortController().signal,
  }), /avatar_source_size_invalid/u);
});
test("explicit external avatar removal clears the projection and serving authority while transient failure preserves it", async () => {
  const state = await externalFixture();
  const locator = "https://avatars.slack-edge.com/served.png";
  const provider = source({ [locator]: await raster({ r: 33, g: 66, b: 99 }) });
  const result = await materializeExternalProjectionAvatar({
    db: state.db, storage: state.storage, source: provider.adapter,
    projectionId: state.projection.id, expectedProjectionRevision: 1,
    sourceLocator: locator, publicOrigin: "https://api.raft.test", now: () => NOW,
  });
  assert.equal(result.kind, "activated");
  if (result.kind !== "activated") return;
  __setCdnStorageForTests(state.storage);
  const app = express();
  app.use("/api/external-avatars", externalAvatarPublicRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/external-avatars/${result.artifact.id}.webp`;
    const active = await fetch(url);
    assert.equal(active.status, 200);
    assert.equal(active.headers.get("content-type"), "image/webp");
    assert.equal(active.headers.get("cache-control"), "public, no-cache, must-revalidate");
    assert.equal(active.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.ok((await active.arrayBuffer()).byteLength > 0);
    const input = {
      db: state.db, storage: state.storage, source: provider.adapter,
      projectionId: state.projection.id, expectedProjectionRevision: 2,
      publicOrigin: "https://api.raft.test", now: () => NOW,
    };
    const unavailable = await materializeExternalProjectionAvatar({
      ...input, sourceLocator: "https://avatars.slack-edge.com/unavailable.png",
    });
    assert.equal(unavailable.kind, "source_unavailable");
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await materializeExternalProjectionAvatar({
      ...input, expectedProjectionRevision: 1, sourceLocator: null,
    })).kind, "authority_stale");
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await materializeExternalProjectionAvatar({
      ...input, sourceLocator: null,
    })).kind, "cleared");
    const [cleared] = await state.db.select().from(externalActorProjections)
      .where(eq(externalActorProjections.id, state.projection.id));
    assert.equal(cleared.avatarArtifactId, null);
    assert.equal(cleared.projectionRevision, 3);
    assert.equal(state.storage.objects.has(result.artifact.storageKey!), false);
    assert.equal((await materializeExternalProjectionAvatar({
      ...input, expectedProjectionRevision: 3, sourceLocator: null,
    })).kind, "cleared");
    const [replay] = await state.db.select().from(externalActorProjections)
      .where(eq(externalActorProjections.id, state.projection.id));
    assert.equal(replay.projectionRevision, 3, "clear replay does not churn actor authority");
    const revoked = await fetch(url);
    assert.equal(revoked.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
