import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { appHosts } from "../platform/links";
import { setPrivacyModeForTest } from "../config/privacyMode";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// GET /api/public/client-config: the per-deploy client config every client reads (the web at
// each page load, signed in or not; the mobile App). Deploy config only, so no login, credentials
// ignored, one cacheable answer per URL. Its shape is announced to the App and only grows.
test("public client config: answers without auth, the same body with or without credentials, cacheable", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const [owner] = await getDb().insert(users).values({
      email: "client-config-owner@slock.test",
      name: "client-config-owner",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const token = await tokenForHuman(owner.email);

    const anonymous = await fetch(`${baseUrl}/api/public/client-config`);
    assert.equal(anonymous.status, 200, await anonymous.clone().text());
    assert.equal(anonymous.headers.get("cache-control"), "public, max-age=300");
    const body = await anonymous.json();
    assert.deepEqual(body, { appHosts: appHosts(), artifactsEmbedOrigin: null }, "deploy config only: nothing per person or per server");

    const credentialed: Array<Record<string, string>> = [
      { Authorization: `Bearer ${token}` },
      { Cookie: `slock_access_token=${token}; session=${token}` },
      { Authorization: "Bearer not-a-token" },
      { Authorization: `Bearer ${token}`, "X-Server-Id": "00000000-0000-4000-8000-000000000000" },
    ];
    for (const headers of credentialed) {
      const withCredentials = await fetch(`${baseUrl}/api/public/client-config`, { headers });
      assert.equal(withCredentials.status, 200, JSON.stringify(headers));
      assert.equal(withCredentials.headers.get("cache-control"), "public, max-age=300", JSON.stringify(headers));
      assert.deepEqual(await withCredentials.json(), body, `credentials are ignored: ${JSON.stringify(headers)}`);
    }
  } finally {
    await close();
  }
});

// The web splits a message's links and recognises Raft permalinks on the hosts the server's own
// reads use (platform/links appHosts()). Deploy config, so APP_URL and APP_PERMALINK_HOSTS
// (staging lists more hosts there) must reach clients as they are.
test("public client config: appHosts is exactly this deployment's appHosts(), APP_URL's and APP_PERMALINK_HOSTS included", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  const before = { APP_URL: process.env.APP_URL, APP_PERMALINK_HOSTS: process.env.APP_PERMALINK_HOSTS };
  try {
    process.env.APP_URL = "https://chat.example.test";
    process.env.APP_PERMALINK_HOSTS = "https://raft-staging.pages.dev, Staging.Example.Dev";
    const response = await fetch(`${baseUrl}/api/public/client-config`);
    assert.equal(response.status, 200, await response.clone().text());
    const { appHosts: answered } = (await response.json()) as { appHosts: unknown };
    assert.deepEqual(answered, appHosts(), "exactly the hosts the server's own reads use");
    assert.deepEqual(answered, [
      "app.raft.build",
      "chat.example.test",
      "app.slock.ai",
      "staging.slock.ai",
      "raft-staging.pages.dev",
      "staging.example.dev",
    ], "the canonical host, APP_URL's, Raft's earlier hosts and every APP_PERMALINK_HOSTS host, as hostnames");
  } finally {
    if (before.APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = before.APP_URL;
    if (before.APP_PERMALINK_HOSTS === undefined) delete process.env.APP_PERMALINK_HOSTS;
    else process.env.APP_PERMALINK_HOSTS = before.APP_PERMALINK_HOSTS;
    await close();
  }
});

// RAFT_PRIVACY_MODE: the web learns it here and then sends no telemetry. Off sends no field, so
// the answer above is unchanged.
test("public client config: privacyMode is true under RAFT_PRIVACY_MODE and absent otherwise", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    assert.equal("privacyMode" in await (await fetch(`${baseUrl}/api/public/client-config`)).json(), false);
    setPrivacyModeForTest(true);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/public/client-config`)).json(), { appHosts: appHosts(), artifactsEmbedOrigin: null, privacyMode: true });
  } finally {
    setPrivacyModeForTest(false);
    await close();
  }
});

// The web's Share → Embed (#proj-workspace:#260) builds an Artifact's embed code from the content
// Worker's embed host, deploy config: exactly an origin, or null (no Embed offered).
test("public client config: artifactsEmbedOrigin is ARTIFACTS_EMBED_ORIGIN when it is exactly an origin, else null", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  const before = process.env.ARTIFACTS_EMBED_ORIGIN;
  try {
    const read = async () => ((await (await fetch(`${baseUrl}/api/public/client-config`)).json()) as { artifactsEmbedOrigin: unknown }).artifactsEmbedOrigin;
    process.env.ARTIFACTS_EMBED_ORIGIN = "https://embed-staging.raftusercontent.com";
    assert.equal(await read(), "https://embed-staging.raftusercontent.com");
    process.env.ARTIFACTS_EMBED_ORIGIN = "http://embed.localhost:8788";
    assert.equal(await read(), "http://embed.localhost:8788");
    for (const bad of ["", "embed.raftusercontent.com", "http://embed.raftusercontent.com", "https://embed.raftusercontent.com/", "https://embed.raftusercontent.com/x", "https://u:p@embed.raftusercontent.com", "javascript:alert(1)"]) {
      process.env.ARTIFACTS_EMBED_ORIGIN = bad;
      assert.equal(await read(), null, bad);
    }
  } finally {
    if (before === undefined) delete process.env.ARTIFACTS_EMBED_ORIGIN;
    else process.env.ARTIFACTS_EMBED_ORIGIN = before;
    await close();
  }
});
