import assert from "node:assert/strict";
import axios from "axios";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

const { default: api } = await import("../src/api/client");
const { useAuthStore } = await import("../src/store/authStore");

function jwt(expSecondsFromNow: number, sub = "user-1"): string {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub, type: "access", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

type Call = { method: string; url: string; auth?: string };
let calls: Call[] = [];
let freshAccess = "";

function installAdapter(validTokens: () => string[]) {
  const adapter = async (config: any) => {
    const url = String(config.url);
    const auth = config.headers?.Authorization ?? config.headers?.get?.("Authorization");
    calls.push({ method: String(config.method).toUpperCase(), url, auth });
    const respond = (status: number, data: unknown) => {
      const response = { data, status, statusText: String(status), headers: {}, config, request: {} };
      if (status >= 400) {
        const error: any = new Error(`status ${status}`);
        error.config = config;
        error.response = response;
        error.isAxiosError = true;
        throw error;
      }
      return response;
    };
    if (url.endsWith("/auth/refresh")) return respond(200, { accessToken: freshAccess, refreshToken: "refresh-2" });
    if (url.endsWith("/auth/me")) {
      return validTokens().includes(String(auth).replace(/^Bearer /, ""))
        ? respond(200, { id: "user-1", emailVerified: true })
        : respond(401, { error: "expired" });
    }
    return respond(404, {});
  };
  axios.defaults.adapter = adapter as never;
  api.defaults.adapter = adapter as never;
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
});

afterEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false });
});

test("boot with an expired access token refreshes before /auth/me instead of eating a 401", async () => {
  const stale = jwt(-60);
  freshAccess = jwt(900);
  localStorage.setItem("slock_access_token", stale);
  localStorage.setItem("slock_refresh_token", "refresh-1");
  useAuthStore.setState({ accessToken: stale, refreshToken: "refresh-1", user: null, initialized: false });
  installAdapter(() => [freshAccess]);

  await useAuthStore.getState().loadUser();

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api/, "")}`), ["POST /auth/refresh", "GET /auth/me"]);
  assert.equal(calls[1].auth, `Bearer ${freshAccess}`);
  assert.equal(useAuthStore.getState().user?.id, "user-1");
  assert.equal(localStorage.getItem("slock_access_token"), freshAccess);
});

test("boot with a valid access token goes straight to /auth/me", async () => {
  const valid = jwt(600);
  localStorage.setItem("slock_access_token", valid);
  localStorage.setItem("slock_refresh_token", "refresh-1");
  useAuthStore.setState({ accessToken: valid, refreshToken: "refresh-1", user: null, initialized: false });
  installAdapter(() => [valid]);

  await useAuthStore.getState().loadUser();

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api/, "")}`), ["GET /auth/me"]);
  assert.equal(useAuthStore.getState().user?.id, "user-1");
});

test("the boot refresh started at module start is shared with loadUser's: one refresh, then /auth/me (web perf)", async () => {
  const { refreshExpiredTokenAtBoot } = await import("../src/store/authStore");
  const stale = jwt(-60);
  freshAccess = jwt(900);
  localStorage.setItem("slock_access_token", stale);
  localStorage.setItem("slock_refresh_token", "refresh-1");
  useAuthStore.setState({ accessToken: stale, refreshToken: "refresh-1", user: null, initialized: false });
  installAdapter(() => [freshAccess]);

  const early = refreshExpiredTokenAtBoot();
  const load = useAuthStore.getState().loadUser();
  assert.equal(await early, true, "new tokens stored: the early requests can go");
  await load;

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api/, "")}`), ["POST /auth/refresh", "GET /auth/me"]);
  assert.equal(calls[1].auth, `Bearer ${freshAccess}`);
  assert.equal(useAuthStore.getState().user?.id, "user-1");
});

test("no boot refresh for a valid token or no session", async () => {
  const { refreshExpiredTokenAtBoot } = await import("../src/store/authStore");
  installAdapter(() => []);
  useAuthStore.setState({ accessToken: jwt(900), refreshToken: "refresh-1" });
  assert.equal(await refreshExpiredTokenAtBoot(), false);
  useAuthStore.setState({ accessToken: null, refreshToken: null });
  assert.equal(await refreshExpiredTokenAtBoot(), false);
  assert.deepEqual(calls, []);
});
