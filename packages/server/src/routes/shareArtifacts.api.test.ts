import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestApp } from "../test/integration/app.js";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness.js";
import { getDb } from "../db/index.js";
import { shareArtifacts, users } from "../db/schema.js";
import { createChannel } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import {
  __setCdnStorageForTests,
  resetStorageForTests,
} from "../services/storageService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);



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

test("share artifact creation is auth-gated and public URL serves OG metadata + non-expiring PNG", async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-artifacts-"));
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousShareBaseUrl = process.env.SHARE_BASE_URL;
  const previousCdnBaseUrl = process.env.CDN_BASE_URL;
  process.env.UPLOADS_DIR = uploadsDir;
  delete process.env.SHARE_BASE_URL;
  delete process.env.CDN_BASE_URL;
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await createVerifiedUser("share-owner@slock.test", "Share Owner");
    const server = await createServer("Share Server", "share-server", owner.id);
    const channel = await createChannel(server.id, "general", "channel");
    const token = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/share-artifacts/message-selection`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
      },
      body: pngForm(channel.id),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as { id: string; url: string; imageUrl: string };
    assert.match(created.url, new RegExp(`/share/${created.id}$`));
    assert.match(created.imageUrl, new RegExp(`/share/${created.id}\\.png$`));

    const pageRes = await fetch(created.url);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(pageRes.headers.get("x-robots-tag"), "noindex, nofollow");
    const html = await pageRes.text();
    assert.match(html, /name="robots" content="noindex, nofollow"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, new RegExp(`name="twitter:image" content="${created.imageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, /property="og:image:width" content="1"/);
    assert.match(html, /property="og:image:height" content="1"/);
    assert.match(html, /name="twitter:image:alt" content="Slock conversation screenshot"/);
    assert.match(html, /\.share-card \{ width: min\(100%, 960px\); margin-inline: auto; \}/);
    assert.match(html, /<div class="share-card">/);

    const imageRes = await fetch(created.imageUrl);
    assert.equal(imageRes.status, 200);
    assert.equal(imageRes.headers.get("content-type"), "image/png");
    assert.equal(imageRes.headers.get("cache-control"), "public, immutable, max-age=31536000");
    assert.deepEqual(Buffer.from(await imageRes.arrayBuffer()), PNG_1X1);
  } finally {
    await app.close();
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    if (previousShareBaseUrl === undefined) delete process.env.SHARE_BASE_URL;
    else process.env.SHARE_BASE_URL = previousShareBaseUrl;
    if (previousCdnBaseUrl === undefined) delete process.env.CDN_BASE_URL;
    else process.env.CDN_BASE_URL = previousCdnBaseUrl;
    resetStorageForTests();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("share artifact response and OG metadata use canonical share host and CDN image URL when configured", async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-artifacts-cdn-"));
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const previousShareBaseUrl = process.env.SHARE_BASE_URL;
  const previousCdnBaseUrl = process.env.CDN_BASE_URL;
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.SHARE_BASE_URL = "https://slock.ai/share";
  process.env.CDN_BASE_URL = "https://cdn.slock.ai";
  resetStorageForTests();

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await createVerifiedUser("share-canonical@slock.test", "Share Canonical");
    const server = await createServer("Share Canonical", "share-canonical", owner.id);
    const channel = await createChannel(server.id, "general", "channel");
    const token = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/share-artifacts/message-selection`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
      },
      body: pngForm(channel.id),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as { id: string; url: string; imageUrl: string };
    const expectedStorageKey = `${server.id}/share-artifacts/${created.id}.png`;
    assert.equal(created.url, `https://slock.ai/share/${created.id}`);
    assert.equal(created.imageUrl, `https://cdn.slock.ai/${expectedStorageKey}`);

    const pageRes = await fetch(`${app.baseUrl}/share/${created.id}`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.match(html, new RegExp(`property="og:url" content="https://slock\\.ai/share/${created.id}"`));
    assert.match(html, new RegExp(`property="og:image" content="https://cdn\\.slock\\.ai/${expectedStorageKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, new RegExp(`name="twitter:image" content="https://cdn\\.slock\\.ai/${expectedStorageKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.doesNotMatch(html, /slock-server-staging\.fly\.dev|fly\.dev/);

    const fallbackImageRes = await fetch(`${app.baseUrl}/share/${created.id}.png`);
    assert.equal(fallbackImageRes.status, 200);
    assert.deepEqual(Buffer.from(await fallbackImageRes.arrayBuffer()), PNG_1X1);
  } finally {
    await app.close();
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    if (previousShareBaseUrl === undefined) delete process.env.SHARE_BASE_URL;
    else process.env.SHARE_BASE_URL = previousShareBaseUrl;
    if (previousCdnBaseUrl === undefined) delete process.env.CDN_BASE_URL;
    else process.env.CDN_BASE_URL = previousCdnBaseUrl;
    resetStorageForTests();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("share artifact image releases its real upstream Agent socket when the client aborts", async ({ app }) => {
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
        assert.equal(response.headers.get("cache-control"), "public, immutable, max-age=31536000");
      },
    );
  } finally {
    await harness.close();
    resetStorageForTests();
  }
});

test("share artifact public routes return 404 for malformed artifact ids", async ({ app }) => {
  const pageRes = await fetch(`${app.baseUrl}/share/not-a-uuid`);
  assert.equal(pageRes.status, 404);
  assert.equal(await pageRes.text(), "Not found");

  const imageRes = await fetch(`${app.baseUrl}/share/not-a-uuid.png`);
  assert.equal(imageRes.status, 404);
  assert.equal(await imageRes.text(), "Not found");
});

test("share artifact creation rejects channels outside the active server membership", async ({ app }) => {
  const userA = await createVerifiedUser("share-a@slock.test", "Share A");
  const userB = await createVerifiedUser("share-b@slock.test", "Share B");
  const serverA = await createServer("Share A", "share-a", userA.id);
  const serverB = await createServer("Share B", "share-b", userB.id);
  const channelB = await createChannel(serverB.id, "secret", "channel");
  const tokenA = await tokenForHuman(userA.email);

  const res = await fetch(`${app.baseUrl}/api/share-artifacts/message-selection`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenA}`,
      "X-Server-Id": serverA.id,
    },
    body: pngForm(channelB.id),
  });
  assert.equal(res.status, 403);
});
