import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

const INVALID_DESKTOP_RUNTIME_ENVIRONMENT = "INVALID_DESKTOP_RUNTIME_ENVIRONMENT";

declare global {
  var __desktopRuntimeTokenReads: number | undefined;
  var __desktopRuntimeSocketConstructs: number | undefined;
  var __desktopRuntimeSocketConnects: number | undefined;
}

class CountingStorage {
  private readonly values = new Map<string, string>([["slock_access_token", "token-fixture"]]);

  getItem(key: string): string | null {
    if (key === "slock_access_token") globalThis.__desktopRuntimeTokenReads = (globalThis.__desktopRuntimeTokenReads ?? 0) + 1;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
  configurable: true,
  value: { invoke: () => undefined },
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new CountingStorage(),
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "socket.io-client") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export class Socket {} export function io(origin, options) { globalThis.__desktopRuntimeSocketConstructs = (globalThis.__desktopRuntimeSocketConstructs ?? 0) + 1; return { auth: options?.auth, connected: false, close() {}, disconnect() {}, removeAllListeners() {}, on() {}, off() {}, connect() { globalThis.__desktopRuntimeSocketConnects = (globalThis.__desktopRuntimeSocketConnects ?? 0) + 1; } }; }",
      };
    }
    return nextResolve(specifier, context);
  },
});

function isInvalidDesktopRuntimeError(error: unknown): boolean {
  return error instanceof Error &&
    error.name === "InvalidDesktopRuntimeEnvironmentError" &&
    "code" in error &&
    error.code === INVALID_DESKTOP_RUNTIME_ENVIRONMENT;
}

test("invalid Desktop runtime blocks axios token reads and adapter dispatch", async () => {
  const { default: api } = await import("../src/api/client.js");
  let adapterCalls = 0;
  globalThis.__desktopRuntimeTokenReads = 0;

  await assert.rejects(
    api.get("/agents", {
      adapter: async (config) => {
        adapterCalls += 1;
        return { data: {}, status: 200, statusText: "OK", headers: {}, config };
      },
    }),
    isInvalidDesktopRuntimeError,
  );

  assert.equal(globalThis.__desktopRuntimeTokenReads, 0);
  assert.equal(adapterCalls, 0);
});

test("invalid Desktop runtime blocks socket construction and connect", async () => {
  const { getSocket } = await import("../src/api/socket.js");
  globalThis.__desktopRuntimeTokenReads = 0;
  globalThis.__desktopRuntimeSocketConstructs = 0;
  globalThis.__desktopRuntimeSocketConnects = 0;

  assert.throws(
    () => getSocket(),
    isInvalidDesktopRuntimeError,
  );

  assert.equal(globalThis.__desktopRuntimeTokenReads, 0);
  assert.equal(globalThis.__desktopRuntimeSocketConstructs, 0);
  assert.equal(globalThis.__desktopRuntimeSocketConnects, 0);
});
