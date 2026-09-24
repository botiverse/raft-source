import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { refreshTokensWithDedupe } from "../src/utils/refreshCoordinator.js";

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

test("browser refresh sends the generated attempt id on the production request", async () => {
  const ls = stubLocalStorage({
    slock_access_token: "at_1",
    slock_refresh_token: "rt_1",
  });
  const originalAdapter = axios.defaults.adapter;
  const originalGetRandomValues = globalThis.crypto.getRandomValues;
  const expectedAttemptId = "arf_abababababababab";
  let requestAttemptId: unknown;

  try {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0xab);
        return array;
      },
    });
    axios.defaults.adapter = async (config) => {
      requestAttemptId = config.headers?.get("X-Slock-Auth-Refresh-Attempt-Id");
      return {
        config,
        data: { accessToken: "at_2", refreshToken: "rt_2" },
        headers: {},
        status: 200,
        statusText: "OK",
      };
    };

    assert.deepEqual(await refreshTokensWithDedupe(), {
      accessToken: "at_2",
      refreshToken: "rt_2",
    });
    assert.equal(requestAttemptId, expectedAttemptId);
  } finally {
    axios.defaults.adapter = originalAdapter;
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: originalGetRandomValues,
    });
    ls.restore();
  }
});

test("browser refresh fails open when attempt id entropy is unavailable", async () => {
  const ls = stubLocalStorage({
    slock_access_token: "at_1",
    slock_refresh_token: "rt_1",
  });
  const originalAdapter = axios.defaults.adapter;
  const originalGetRandomValues = globalThis.crypto.getRandomValues;
  let requestCount = 0;
  let requestHadAttemptHeader = false;

  try {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: () => {
        throw new Error("entropy unavailable");
      },
    });
    axios.defaults.adapter = async (config) => {
      requestCount += 1;
      requestHadAttemptHeader = config.headers?.has("X-Slock-Auth-Refresh-Attempt-Id") ?? false;
      return {
        config,
        data: { accessToken: "at_2", refreshToken: "rt_2" },
        headers: {},
        status: 200,
        statusText: "OK",
      };
    };

    assert.deepEqual(await refreshTokensWithDedupe(), {
      accessToken: "at_2",
      refreshToken: "rt_2",
    });
    assert.equal(requestCount, 1);
    assert.equal(requestHadAttemptHeader, false);
    assert.equal(localStorage.getItem("slock_access_token"), "at_2");
    assert.equal(localStorage.getItem("slock_refresh_token"), "rt_2");
  } finally {
    axios.defaults.adapter = originalAdapter;
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: originalGetRandomValues,
    });
    ls.restore();
  }
});
