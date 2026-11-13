import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach } from "vitest";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { shareArtifacts, users } from "../db/schema";
import { createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import {
  __setCdnStorageForTests,
  resetStorageForTests,
  type StorageBackend,
} from "../services/storageService";
import { __setShareArtifactsRetiredForTests, SHARE_ARTIFACTS_RETIRED } from "./shareArtifacts";

// Share to X was retired on 2026-11-09 (docs/contracts/share-artifacts.md):
// nothing makes, lists or deletes a share link any more, and the links made
// before answer "no longer available" while SHARE_ARTIFACTS_RETIRED is on.
// Their rows and stored images stay, so turning it off serves them again.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

afterEach(() => {
  __setShareArtifactsRetiredForTests(null);
  resetStorageForTests();
});

async function createVerifiedUser(email: string, name: string) {
  const [user] = await getDb()
    .insert(users)
    .values({
      email,
      name,
      displayName: name,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();
  return user;
}

function pngForm(channelId: string) {
  const form = new FormData();
  form.append("channelId", channelId);
  form.append("image", new Blob([PNG_1X1], { type: "image/png" }), "raft-thread.png");
  return form;
}

/** The CDN bucket in memory: what is stored, and every key deleted. */
function memoryCdnStorage() {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  const storage: StorageBackend = {
    async put(key, data) { objects.set(key, Buffer.from(data)); },
    async get(key) {
      const data = objects.get(key);
      if (!data) throw new Error("File not found on disk");
      return Readable.from([data]);
    },
    async delete(key) {
      deleted.push(key);
      objects.delete(key);
    },
  };
  return { storage, objects, deleted };
}

/** A share made before the retirement: its row, and its image in the (in-memory) CDN bucket. */
async function seedExistingShare(tag: string) {
  const owner = await createVerifiedUser(`share-${tag}@slock.test`, `Share ${tag}`);
  const server = await createServer(`Share ${tag}`, `share-${tag}`, owner.id);
  const channel = await createChannel(server.id, "general", "channel");
  const cdn = memoryCdnStorage();
  __setCdnStorageForTests(cdn.storage);
  const id = randomUUID();
  const storageKey = `${server.id}/share-artifacts/${id}.png`;
  await cdn.storage.put(storageKey, PNG_1X1, "image/png");
  await getDb().insert(shareArtifacts).values({
    id,
    serverId: server.id,
    channelId: channel.id,
    createdByUserId: owner.id,
    storageKey,
    mimeType: "image/png",
    sizeBytes: PNG_1X1.length,
    width: 1,
    height: 1,
  });
  return { owner, server, channel, cdn, id, storageKey, token: await tokenForHuman(owner.email) };
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("existing share links are retired by default", () => {
  assert.equal(SHARE_ARTIFACTS_RETIRED, true);
});

test("creating a share link answers 410 SHARE_ARTIFACT_RETIRED to older clients and stores nothing", async ({ app }) => {
  const owner = await createVerifiedUser("share-create@slock.test", "Share Create");
  const server = await createServer("Share Create", "share-create", owner.id);
  const channel = await createChannel(server.id, "general", "channel");
  const cdn = memoryCdnStorage();
  __setCdnStorageForTests(cdn.storage);

  const res = await fetch(`${app.baseUrl}/api/share-artifacts/message-selection`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id },
    body: pngForm(channel.id),
  });

  assert.equal(res.status, 410);
  const body = (await res.json()) as { code: string; errorCode: string; error: string };
  assert.equal(body.code, "SHARE_ARTIFACT_RETIRED");
  assert.equal(body.errorCode, "SHARE_ARTIFACT_RETIRED");
  assert.match(body.error, /retired/);
  assert.deepEqual(await getDb().select({ id: shareArtifacts.id }).from(shareArtifacts), []);
  assert.equal(cdn.objects.size, 0);

  const anonymous = await fetch(`${app.baseUrl}/api/share-artifacts/message-selection`, {
    method: "POST",
    body: pngForm(channel.id),
  });
  assert.equal(anonymous.status, 401, "the stub stays behind sign-in");
});

test("the list and delete routes are gone, and a delete attempt leaves the row and the stored image", async ({ app }) => {
  const share = await seedExistingShare("gone");
  const headers = { Authorization: `Bearer ${share.token}`, "X-Server-Id": share.server.id };

  const list = await fetch(`${app.baseUrl}/api/share-artifacts?scope=all`, { headers });
  assert.equal(list.status, 404);
  const del = await fetch(`${app.baseUrl}/api/share-artifacts/${share.id}`, { method: "DELETE", headers });
  assert.equal(del.status, 404);

  assert.equal((await getDb().select({ id: shareArtifacts.id }).from(shareArtifacts).where(eq(shareArtifacts.id, share.id))).length, 1);
  assert.equal(share.cdn.objects.has(share.storageKey), true);
  assert.deepEqual(share.cdn.deleted, []);
});

test("an existing link's page answers 410 'no longer available' with no image and no card image", async ({ app }) => {
  const share = await seedExistingShare("retired-page");

  await withEnv({ SHARE_BASE_URL: "https://slock.ai/share", CDN_BASE_URL: "https://cdn.raft.build" }, async () => {
    const page = await fetch(`${app.baseUrl}/share/${share.id}`);
    assert.equal(page.status, 410);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(page.headers.get("cache-control"), "public, max-age=60");
    assert.match(page.headers.get("vary") ?? "", /Accept-Language/i);
    const html = await page.text();
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<p>This shared link is no longer available\.<\/p>/);
    assert.match(html, /name="robots" content="noindex, nofollow"/);
    assert.match(html, /name="twitter:card" content="summary"/);
    assert.doesNotMatch(html, /og:image|twitter:image|<img|summary_large_image/);
    assert.doesNotMatch(html, new RegExp(share.storageKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(html, /cdn\.raft\.build|share-artifacts/);
  });

  const zh = await fetch(`${app.baseUrl}/share/${share.id}`, { headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } });
  assert.equal(zh.status, 410);
  const zhHtml = await zh.text();
  assert.match(zhHtml, /<html lang="zh-CN">/);
  assert.match(zhHtml, /<p>这个分享链接已失效。<\/p>/);

  const image = await fetch(`${app.baseUrl}/share/${share.id}.png`);
  assert.equal(image.status, 410);
  assert.equal(image.headers.get("cache-control"), "public, max-age=60");
  assert.doesNotMatch(image.headers.get("content-type") ?? "", /image\/png/);
  await image.arrayBuffer();

  // Kept, so the link can be brought back: the row and the stored image.
  assert.equal((await getDb().select({ id: shareArtifacts.id }).from(shareArtifacts).where(eq(shareArtifacts.id, share.id))).length, 1);
  assert.equal(share.cdn.objects.has(share.storageKey), true);
  assert.deepEqual(share.cdn.deleted, []);
});

test("a link that never existed still answers 404, page and image", async ({ app }) => {
  const missing = "00000000-0000-4000-8000-000000000000";
  const page = await fetch(`${app.baseUrl}/share/${missing}`);
  assert.equal(page.status, 404);
  assert.equal(await page.text(), "Not found");
  const image = await fetch(`${app.baseUrl}/share/${missing}.png`);
  assert.equal(image.status, 404);
  assert.equal(await image.text(), "Not found");
});

test("share artifact public routes return 404 for malformed artifact ids", async ({ app }) => {
  const pageRes = await fetch(`${app.baseUrl}/share/not-a-uuid`);
  assert.equal(pageRes.status, 404);
  assert.equal(await pageRes.text(), "Not found");

  const imageRes = await fetch(`${app.baseUrl}/share/not-a-uuid.png`);
  assert.equal(imageRes.status, 404);
  assert.equal(await imageRes.text(), "Not found");
});

// Restoring: with the switch off, an existing link is served exactly as before.

test("restored: the page serves its OG and card metadata on the canonical host, with the CDN image", async ({ app }) => {
  __setShareArtifactsRetiredForTests(false);
  const share = await seedExistingShare("restored-cdn");

  await withEnv({ SHARE_BASE_URL: "https://slock.ai/share", CDN_BASE_URL: "https://cdn.slock.ai" }, async () => {
    const pageRes = await fetch(`${app.baseUrl}/share/${share.id}`);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(pageRes.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(pageRes.headers.get("cache-control"), "public, max-age=60");
    const html = await pageRes.text();
    const escapedKey = share.storageKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(html, new RegExp(`property="og:url" content="https://slock\\.ai/share/${share.id}"`));
    assert.match(html, new RegExp(`property="og:image" content="https://cdn\\.slock\\.ai/${escapedKey}"`));
    assert.match(html, new RegExp(`name="twitter:image" content="https://cdn\\.slock\\.ai/${escapedKey}"`));
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /property="og:image:width" content="1"/);
    assert.match(html, /property="og:image:height" content="1"/);
    assert.match(html, /<div class="share-card">/);
  });
});

test("restored: without a CDN the page points at, and the server serves, its own copy of the PNG", async ({ app }) => {
  __setShareArtifactsRetiredForTests(false);
  const share = await seedExistingShare("restored-local");

  await withEnv({ SHARE_BASE_URL: undefined, CDN_BASE_URL: undefined }, async () => {
    const html = await (await fetch(`${app.baseUrl}/share/${share.id}`)).text();
    assert.match(html, new RegExp(`name="twitter:image" content="[^"]*/share/${share.id}\\.png"`));

    const imageRes = await fetch(`${app.baseUrl}/share/${share.id}.png`);
    assert.equal(imageRes.status, 200);
    assert.equal(imageRes.headers.get("content-type"), "image/png");
    assert.equal(imageRes.headers.get("cache-control"), "public, max-age=60");
    assert.deepEqual(Buffer.from(await imageRes.arrayBuffer()), PNG_1X1);
  });
});

test("restored: the share image releases its real upstream Agent socket when the client aborts", async ({ app }) => {
  __setShareArtifactsRetiredForTests(false);
  const harness = await createHangingStorageTestHarness();
  try {
    const owner = await createVerifiedUser("share-abort@slock.test", "Share Abort");
    const server = await createServer("Share Abort", "share-abort", owner.id);
    const channel = await createChannel(server.id, "general", "channel");
    const [artifact] = await getDb().insert(shareArtifacts).values({
      serverId: server.id,
      channelId: channel.id,
      createdByUserId: owner.id,
      storageKey: `${server.id}/share-artifacts/hanging.png`,
      mimeType: "image/png",
      sizeBytes: 1024 * 1024,
    }).returning();
    __setCdnStorageForTests(harness.storage);

    await harness.abortDownload(
      `${app.baseUrl}/share/${artifact.id}.png`,
      undefined,
      (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.equal(response.headers.get("content-length"), String(1024 * 1024));
        assert.equal(response.headers.get("cache-control"), "public, max-age=60");
      },
    );
  } finally {
    await harness.close();
  }
});
