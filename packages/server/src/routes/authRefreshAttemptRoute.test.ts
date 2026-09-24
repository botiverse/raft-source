/// <reference path="../../../web/src/vite-env.d.ts" />
import { createApiTest } from "../test/integration/apiTest.js";

import assert from "node:assert/strict";

import argon2 from "argon2";
import axios from "../../../web/node_modules/axios/index.js";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { refreshTokensWithDedupe } from "../../../web/src/utils/refreshCoordinator.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type StubStore = Record<string, string>;

function stubLocalStorage(initial: StubStore): { restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store: StubStore = { ...initial };
  const stub: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    getItem: (key) => store[key] ?? null,
    key: (index) => Object.keys(store)[index] ?? null,
    removeItem: (key) => {
      delete store[key];
    },
    setItem: (key, value) => {
      store[key] = value;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: stub,
  });
  return {
    restore: () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

test("one generated attempt id traverses the production browser request and server refresh trace", async ({ app }) => {

  const originalBaseUrl = axios.defaults.baseURL;
  const originalGetRandomValues = globalThis.crypto.getRandomValues;
  let localStorageStub: { restore: () => void } | undefined;

  try {
    await getDb().insert(users).values({
      email: "refresh-attempt-route@slock.test",
      name: "Refresh Attempt Route",
      displayName: "Refresh Attempt Route",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
    });
    const login = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "refresh-attempt-route@slock.test",
        password: "password123",
      }),
    });
    assert.equal(login.status, 200);
    const tokens = await login.json() as { accessToken: string; refreshToken: string };

    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    localStorageStub = stubLocalStorage({
      slock_access_token: tokens.accessToken,
      slock_refresh_token: tokens.refreshToken,
    });
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0xab);
        return array;
      },
    });
    axios.defaults.baseURL = app.baseUrl;

    await refreshTokensWithDedupe();

    const refreshEvents = sink.getAllSpans()
      .flatMap((span) => span.events)
      .filter((event) => event.name === "auth.refresh.completed");
    assert.equal(refreshEvents.length, 1);
    assert.equal(
      refreshEvents[0]?.attrs?.auth_refresh_attempt_id,
      "arf_abababababababab",
    );
  } finally {
    axios.defaults.baseURL = originalBaseUrl;
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: originalGetRandomValues,
    });
    localStorageStub?.restore();
    await app.close();
  }
});
