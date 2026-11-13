import assert from "node:assert/strict";
import "./helpers/domSetup";
import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";

// A machine API key must never be written to localStorage (it was kept
// as `slock_machine_apikey_<id>`, unscoped and surviving sign-out), and any copy
// an older build left behind is purged on load and on every sign-out path.

const PREFIX = "slock_machine_apikey_";
const KEY = "sk_machine_test_secret_key_value";

function storedMachineKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys.sort();
}

function machineRow(id: string) {
  return {
    id,
    name: "my-computer",
    description: null,
    status: "offline",
    statusVersion: 1,
    apiKeyPrefix: KEY.slice(0, 20),
    runtimes: [],
    hostname: null,
    os: null,
    daemonVersion: null,
    lastHeartbeat: null,
    createdAt: "2026-10-29T00:00:00.000Z",
  };
}

beforeEach(() => {
  useServerStore.setState({ current: { id: "server-1", slug: "acme", name: "Acme" } as never });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test("loading the machine store purges keys an older build stored", async () => {
  localStorage.setItem(`${PREFIX}stale-a`, "sk_machine_stale_a");
  localStorage.setItem(`${PREFIX}stale-b`, "sk_machine_stale_b");
  localStorage.setItem("unrelated_key", "kept");
  await import("../src/store/machineStore");
  assert.deepEqual(storedMachineKeys(), []);
  assert.equal(localStorage.getItem("unrelated_key"), "kept");
});

test("creating a machine returns the key but never stores it", async () => {
  const { useMachineStore } = await import("../src/store/machineStore");
  vi.spyOn(api, "post").mockResolvedValue({ data: { machine: machineRow("m-new"), apiKey: KEY } });

  const result = await useMachineStore.getState().registerMachine("my-computer");

  assert.equal(result.apiKey, KEY, "the caller still gets the key once");
  assert.deepEqual(storedMachineKeys(), []);
  assert.equal(JSON.stringify(useMachineStore.getState()).includes(KEY), false, "no copy kept in the store");
});

test("rotating a machine key returns the new key but never stores it", async () => {
  const { useMachineStore } = await import("../src/store/machineStore");
  useMachineStore.setState({ machines: [machineRow("m-rot") as never] });
  vi.spyOn(api, "post").mockResolvedValue({ data: { apiKey: KEY } });

  const rotated = await useMachineStore.getState().rotateApiKey("m-rot");

  assert.equal(rotated, KEY);
  assert.deepEqual(storedMachineKeys(), []);
  assert.equal(JSON.stringify(useMachineStore.getState()).includes(KEY), false, "no copy kept in the store");
  assert.equal(useMachineStore.getState().machines[0]?.apiKeyPrefix, KEY.slice(0, 20));
});

test("logout purges stored machine keys", async () => {
  const { useAuthStore } = await import("../src/store/authStore");
  localStorage.setItem(`${PREFIX}x`, "sk_machine_someone_else");
  useAuthStore.setState({ user: { id: "u1" } as never, accessToken: "at", refreshToken: null } as never);

  useAuthStore.getState().logout();

  assert.deepEqual(storedMachineKeys(), []);
});

test("a terminal 401 sign-out (clearAuthAndRedirect) purges stored machine keys", async () => {
  const { clearAuthAndRedirect } = await import("../src/api/client");
  localStorage.setItem(`${PREFIX}x`, "sk_machine_someone_else");
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { ...globalThis.window, location: { href: "http://localhost/s/acme" } },
  });
  try {
    await clearAuthAndRedirect();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
  }

  assert.deepEqual(storedMachineKeys(), []);
});
