import assert from "node:assert/strict";
import argon2 from "argon2";
import { Readable } from "node:stream";

import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, test } from "vitest";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import { userAuthIdentities, users } from "../db/schema.js";
import { createSocialUser, findExistingSocialLoginUser, linkSocialIdentity } from "./userService.js";
import type { StorageBackend } from "./storageService.js";
import { __setCdnStorageForTests, __setStorageForTests, resetStorageForTests } from "./storageService.js";

const ONE_BY_ONE_GIF = Buffer.from(
  "R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
  "base64",
);

const LEGAL_ACCEPTANCE = {
  acceptTerms: true,
  termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
  privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
};

class MemoryStorage implements StorageBackend {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }

  async get(key: string): Promise<Readable> {
    const value = this.objects.get(key);
    if (!value) throw new Error("missing object");
    return Readable.from(value);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

beforeEach(async () => {
  await initDatabase("pglite://");
});

afterEach(async () => {
  resetStorageForTests();
  await closeDatabase();
});

async function seedUser(input: {
  email: string;
  name: string;
  avatarUrl?: string | null;
}) {
  const [user] = await getDb().insert(users).values({
    email: input.email,
    name: input.name,
    displayName: input.name,
    avatarUrl: input.avatarUrl ?? null,
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

function installAvatarStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  __setStorageForTests(storage);
  __setCdnStorageForTests(storage);
  return storage;
}

function installAvatarFetch(avatarUrl: string, body = ONE_BY_ONE_GIF): () => number {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === avatarUrl) {
      calls += 1;
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "image/gif",
          "Content-Length": String(body.byteLength),
        },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => calls;
}

function restoreFetch(fetchImpl: typeof fetch): void {
  globalThis.fetch = fetchImpl;
}

function assertStoredUserAvatarUrl(avatarUrl: string | null): asserts avatarUrl is string {
  assert.match(avatarUrl ?? "", /^\/api\/avatars\/users\/[0-9a-f]{32}\.webp$/);
}

test("social signup materializes provider avatar bytes into user avatar storage", async () => {
  const storage = installAvatarStorage();
  const originalFetch = globalThis.fetch;
  const avatarFetchCalls = installAvatarFetch("https://provider.example/avatar.gif");
  try {
    const user = await createSocialUser({
      provider: "google",
      providerUserId: "google-avatar-user",
      email: "social-avatar@slock.test",
      emailVerified: true,
      displayName: "Social Avatar",
      avatarUrl: "https://provider.example/avatar.gif",
    }, LEGAL_ACCEPTANCE, {}, "oauth", { deferProfileSetup: true });

    assertStoredUserAvatarUrl(user.avatarUrl);
    assert.equal(user.avatarUrl.includes("provider.example"), false);
    assert.equal(avatarFetchCalls(), 1);
    assert.equal(storage.objects.has(user.avatarUrl.replace(/^\/api\//, "")), true);

    const [stored] = await getDb().select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, user.id));
    assert.equal(stored?.avatarUrl, user.avatarUrl);
  } finally {
    restoreFetch(originalFetch);
  }
});

test("existing social login replaces an old provider hotlink on re-login", async () => {
  installAvatarStorage();
  const user = await seedUser({
    email: "social-existing@slock.test",
    name: "social-existing",
    avatarUrl: "https://old-provider.example/avatar.png",
  });
  await getDb().insert(userAuthIdentities).values({
    userId: user.id,
    provider: "github",
    providerUserId: "github-existing-avatar-user",
    providerEmail: user.email,
  });

  const originalFetch = globalThis.fetch;
  const avatarFetchCalls = installAvatarFetch("https://provider.example/new-avatar.gif");
  try {
    const loggedIn = await findExistingSocialLoginUser({
      provider: "github",
      providerUserId: "github-existing-avatar-user",
      email: user.email,
      emailVerified: true,
      displayName: "Social Existing",
      avatarUrl: "https://provider.example/new-avatar.gif",
    });

    assert.ok(loggedIn);
    assertStoredUserAvatarUrl(loggedIn.avatarUrl);
    assert.notEqual(loggedIn.avatarUrl, user.avatarUrl);
    assert.equal(avatarFetchCalls(), 1);

    const [stored] = await getDb().select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, user.id));
    assert.equal(stored?.avatarUrl, loggedIn.avatarUrl);
  } finally {
    restoreFetch(originalFetch);
  }
});

test("linking social identity preserves an existing stored user avatar", async () => {
  installAvatarStorage();
  const storedAvatarUrl = `/api/avatars/users/${"a".repeat(32)}.webp`;
  const user = await seedUser({
    email: "social-link@slock.test",
    name: "social-link",
    avatarUrl: storedAvatarUrl,
  });

  const originalFetch = globalThis.fetch;
  let avatarFetchCalls = 0;
  globalThis.fetch = (async () => {
    avatarFetchCalls += 1;
    throw new Error("provider avatar should not be fetched for stored user avatars");
  }) as typeof fetch;
  try {
    const linked = await linkSocialIdentity(user.id, {
      provider: "google",
      providerUserId: "google-link-avatar-user",
      email: user.email,
      emailVerified: true,
      displayName: "Social Link",
      avatarUrl: "https://provider.example/link-avatar.gif",
    });

    assert.equal(linked.avatarUrl, storedAvatarUrl);
    assert.equal(avatarFetchCalls, 0);
  } finally {
    restoreFetch(originalFetch);
  }
});

test("social signup does not persist provider hotlinks when avatar fetch fails", async () => {
  installAvatarStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://provider.example/missing-avatar.gif") {
      return new Response("not found", { status: 404 });
    }
    return originalFetch(input);
  }) as typeof fetch;
  try {
    const user = await createSocialUser({
      provider: "google",
      providerUserId: "google-missing-avatar-user",
      email: "social-missing-avatar@slock.test",
      emailVerified: true,
      displayName: "Social Missing Avatar",
      avatarUrl: "https://provider.example/missing-avatar.gif",
    }, LEGAL_ACCEPTANCE, {}, "oauth", { deferProfileSetup: true });

    assert.equal(user.avatarUrl, null);
    const [stored] = await getDb().select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, user.id));
    assert.equal(stored?.avatarUrl, null);
  } finally {
    restoreFetch(originalFetch);
  }
});
