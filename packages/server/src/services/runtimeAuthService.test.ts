import assert from "node:assert/strict";

import { RuntimeAuthService, type RuntimeAuthStoreBackend } from "./runtimeAuthService";

function memoryBackend(options: { failSessionWrite: boolean }): RuntimeAuthStoreBackend & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    get: async (key) => keys.get(key) ?? null,
    set: async (key, value) => {
      if (options.failSessionWrite && key.startsWith("slock:runtime-auth-login:")) throw new Error("store unavailable");
      keys.set(key, value);
    },
    setIfAbsent: async (key, value) => {
      if (keys.has(key)) return false;
      keys.set(key, value);
      return true;
    },
    del: async (key) => {
      keys.delete(key);
    },
    delIfEquals: async (key, value) => {
      if (keys.get(key) === value) keys.delete(key);
    },
    incrementWindow: async (key) => {
      const next = Number(keys.get(key) ?? 0) + 1;
      keys.set(key, String(next));
      return next;
    },
  };
}

// Tenny (#10487 review): the lock is taken before the session record is written.
test("task #17: a login whose record cannot be written frees its runtime at once", async () => {
  const options = { failSessionWrite: true };
  const backend = memoryBackend(options);
  const service = new RuntimeAuthService(backend);
  const input = { serverId: "server-1", machineId: "computer-1", runtime: "claude" as const, userId: "user-1" };
  await assert.rejects(service.startLogin(input), /store unavailable/);
  assert.ok(![...backend.keys.keys()].some((key) => key.startsWith("slock:runtime-auth-login-active:")), "no lock left behind");
  options.failSessionWrite = false;
  assert.equal((await service.startLogin(input)).kind, "started", "the next start is not refused as already running");
});
