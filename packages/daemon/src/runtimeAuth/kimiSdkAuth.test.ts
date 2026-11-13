import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Runtime } from "@botiverse/oar";
import {
  RUNTIME_AUTH_RUNTIMES,
  asRuntimeAuthLoginId,
  type RuntimeAuthLoginId,
  type RuntimeAuthRuntime,
  type RuntimeAuthStatus,
} from "@botiverse/raft-shared";

import { kimiSdkAuthLogin, loadKimiSdkAuth, readKimiCodeSignInStatus, type KimiSdkAuth } from "./kimiSdkAuth";
import { RuntimeAuthHost, type RuntimeAuthCredentialsChange, type RuntimeAuthHostMessage } from "./runtimeAuthHost";

type LoginOptions = NonNullable<Parameters<KimiSdkAuth["login"]>[1]>;
type DeviceAuthorization = Parameters<NonNullable<LoginOptions["onDeviceCode"]>>[0];

const DEVICE: DeviceAuthorization = {
  userCode: "WXYZ-1234",
  deviceCode: "device-secret-xyz",
  verificationUri: "https://www.kimi.com/code/authorize_device",
  verificationUriComplete: "https://www.kimi.com/code/authorize_device?user_code=WXYZ-1234",
  expiresIn: 900,
  interval: 5,
};
const LOGGED_IN = { providerName: "managed:kimi-code", ok: true, defaultModel: "kimi-for-coding", defaultThinking: true } as const;

function loginId(suffix: string): RuntimeAuthLoginId {
  return asRuntimeAuthLoginId(`rtl_${suffix.padEnd(16, "0")}`)!;
}

/** A Kimi error as the SDK throws it: an Error whose class name says what failed (the classes are not exported). */
function sdkError(name: string, message = "token=secret-in-message"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * A host whose Kimi sign-in is a fake SDK facade; OAR is loaded for no
 * runtime, and refuses `kimi` outright. Status is `options.status` (the token
 * files' reader in production), else follows the fake's logins and logouts.
 */
function kimiHost(kimiAuth: Partial<KimiSdkAuth>, options: { status?: () => Promise<RuntimeAuthStatus> } = {}) {
  const sent: RuntimeAuthHostMessage[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const oarLoads: string[] = [];
  const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
  let hasToken = false;
  let sdkLoads = 0;
  const auth: KimiSdkAuth = {
    status: async () => { throw new Error("the daemon never asks the SDK for a status"); },
    login: async () => { hasToken = true; return LOGGED_IN; },
    logout: async () => { hasToken = false; return { providerName: "managed:kimi-code", ok: true }; },
    ...kimiAuth,
  } as KimiSdkAuth;
  const host = new RuntimeAuthHost({
    loadRuntime: async (id) => {
      oarLoads.push(id);
      if (id === "kimi") throw new Error("OAR's kimi must not be loaded");
      return { installation: async () => ({ kind: "not_found" }) } as unknown as Runtime;
    },
    kimiStatus: options.status ?? (async () => ({ kind: hasToken ? "logged_in" : "logged_out" })),
    loadKimiAuth: async () => { sdkLoads += 1; return auth; },
    loadProviderAuth: async () => null,
    send: (message) => sent.push(message),
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: () => 1_000,
    serverReads: () => RUNTIME_AUTH_RUNTIMES,
    platform: "linux",
    onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]),
  });
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const loginResult = () => (sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: unknown } | undefined)?.result;
  const lastStatus = () => (sent.filter((message) => message.type === "machine:runtime_auth:status").at(-1) as { report: { runtimes: Record<string, unknown> } } | undefined)?.report.runtimes.kimi;
  return { host, sent, events, oarLoads, changes, settle, loginResult, lastStatus, setToken: (value: boolean) => { hasToken = value; }, sdkLoads: () => sdkLoads };
}

const TOKEN = { access_token: "a", refresh_token: "r", expires_at: 4_000_000_000, scope: "", token_type: "Bearer", expires_in: 900 };
const TOMBSTONE = { access_token: "", refresh_token: "", expires_at: 0, scope: "", token_type: "", expires_in: 0 };

async function withKimiHome(run: (home: string, write: (name: string, value: unknown) => Promise<void>) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "kimi-sign-in-"));
  const write = async (name: string, value: unknown) => {
    await mkdir(path.join(home, "credentials"), { recursive: true });
    await writeFile(path.join(home, "credentials", name), typeof value === "string" ? value : JSON.stringify(value));
  };
  try {
    await run(home, write);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("Kimi Code's status is read from its token slots: a stored token in either region's slot is signed in; none, a revoked one or another file is not", async () => {
  await withKimiHome(async (home, write) => {
    assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: "logged_out" }, "no credentials dir");
    await write("kimi-code.json", TOMBSTONE);
    await write("kimi-code-env-0123456789abcdef.json", "not json");
    await write("other-provider.json", TOKEN);
    assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: "logged_out" }, "revoked, malformed and foreign files do not count");
    await write("kimi-code-env-0123456789abcdef.json", TOKEN);
    assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: "logged_in" }, "the global (scoped) slot");
  });
  await withKimiHome(async (home, write) => {
    await write("kimi-code.json", TOKEN);
    assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: "logged_in" }, "the mainland-cn (default) slot");
  });
  await withKimiHome(async (home) => {
    // A slot that cannot be read (here a directory in its place) is no claim either way.
    await mkdir(path.join(home, "credentials", "kimi-code.json"), { recursive: true });
    assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: "unknown" });
  });
});

test("a status report reads Kimi's token files and never loads the SDK or OAR's kimi", async () => {
  await withKimiHome(async (home, write) => {
    const { host, sent, oarLoads, sdkLoads } = kimiHost({}, { status: () => readKimiCodeSignInStatus(home) });
    await host.reportStatus("ready", ["kimi-sdk"]);
    await write("kimi-code.json", TOKEN);
    await host.reportStatus("ready", ["kimi-sdk"]);
    const reports = sent.filter((message) => message.type === "machine:runtime_auth:status") as Array<{ report: { runtimes: Record<string, unknown> } }>;
    assert.deepEqual(reports.map((message) => message.report.runtimes.kimi), [{ kind: "logged_out" }, { kind: "logged_in" }]);
    assert.equal(sdkLoads(), 0, "the SDK (~70 MB of heap) is loaded for a login or logout only");
    assert.deepEqual(oarLoads.filter((id) => id === "kimi"), [], "no Kimi Code CLI is needed");
  });

  const failing = kimiHost({}, { status: async () => { throw new Error("unreadable"); } });
  assert.deepEqual((await failing.host.collectStatus(["kimi"], ["kimi-sdk"])).runtimes.kimi, { kind: "unknown" });
});

test("a Kimi login relays the SDK's device code to the web, ends logged_in, releases the agents and reports the new status", async () => {
  const { host, sent, events, oarLoads, changes, settle, loginResult, lastStatus } = kimiHost({
    login: async (provider, options) => {
      assert.equal(provider, undefined, "the SDK's default provider, managed:kimi-code");
      await options?.onDeviceCode?.(DEVICE);
      return LOGGED_IN;
    },
  }, { status: async () => ({ kind: "logged_in" }) });
  host.startLogin(loginId("kimi-ok"), "kimi", "global");
  await settle();
  const event = sent.find((message) => message.type === "machine:runtime_auth:login:event") as { event: unknown } | undefined;
  assert.deepEqual(event?.event, {
    kind: "device_code",
    userCode: "WXYZ-1234",
    verificationUri: "https://www.kimi.com/code/authorize_device?user_code=WXYZ-1234",
    expiresInSeconds: 900,
  });
  assert.deepEqual(loginResult(), { kind: "logged_in" });
  assert.deepEqual(changes, [["kimi", "login"]], "held Kimi agents are released");
  assert.deepEqual(lastStatus(), { kind: "logged_in" });
  assert.ok(!JSON.stringify(sent).includes(DEVICE.deviceCode), "the polling code never leaves the Computer");
  assert.ok(!JSON.stringify(events).includes("WXYZ-1234"), "the user code is in no trace");
  assert.deepEqual(oarLoads.filter((id) => id === "kimi"), []);
});

test("a Kimi device code without a usable https link falls back to the plain link, and with none fails the login as interaction_failed", async () => {
  const fallback = kimiHost({
    login: async (_provider, options) => {
      await options?.onDeviceCode?.({ ...DEVICE, verificationUriComplete: "", expiresIn: null });
      return LOGGED_IN;
    },
  });
  fallback.host.startLogin(loginId("kimi-plain"), "kimi", "mainland-cn");
  await fallback.settle();
  const event = fallback.sent.find((message) => message.type === "machine:runtime_auth:login:event") as { event: unknown } | undefined;
  assert.deepEqual(event?.event, { kind: "device_code", userCode: "WXYZ-1234", verificationUri: "https://www.kimi.com/code/authorize_device" });

  let polled = false;
  const unusable = kimiHost({
    login: async (_provider, options) => {
      await options?.onDeviceCode?.({ ...DEVICE, verificationUri: "http://insecure.example/device", verificationUriComplete: "http://insecure.example/device?c=1" });
      polled = true;
      return LOGGED_IN;
    },
  });
  unusable.host.startLogin(loginId("kimi-http"), "kimi", "global");
  await unusable.settle();
  assert.equal(polled, false, "the SDK's login stops before it polls");
  assert.deepEqual(unusable.loginResult(), { kind: "failed", reason: "interaction_failed", detail: "Could not present the Kimi device code" });
  assert.deepEqual(unusable.changes, []);
});

test("cancelling a Kimi login aborts the SDK's login and answers cancelled at once; another Kimi login is busy until the SDK's has ended", async () => {
  let signal: AbortSignal | undefined;
  let rejectLate!: (error: Error) => void;
  let logins = 0;
  const { host, sent, changes, settle, loginResult } = kimiHost({
    login: (_provider, options) => {
      logins += 1;
      if (logins > 1) return Promise.resolve(LOGGED_IN);
      signal = options?.signal;
      // The SDK sleeps between polls without watching the signal: it rejects only later.
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    },
  });
  const resultOf = (id: RuntimeAuthLoginId) => (sent.find((message) => message.type === "machine:runtime_auth:login:result" && message.loginId === id) as { result: unknown } | undefined)?.result;
  const id = loginId("kimi-cancel");
  host.startLogin(id, "kimi", "global");
  await settle();
  assert.equal(loginResult(), undefined, "still running");
  host.cancelLogin(id);
  await settle();
  assert.equal(signal?.aborted, true, "the SDK's login got the abort");
  assert.deepEqual(resultOf(id), { kind: "cancelled" });
  assert.deepEqual(changes, []);

  // The SDK's login could still save a token and rewrite Kimi's config: a new one waits for it.
  const early = loginId("kimi-early");
  host.startLogin(early, "kimi", "global");
  await settle();
  assert.deepEqual(resultOf(early), { kind: "busy" });
  assert.equal(logins, 1, "the SDK was not asked for a second login");

  // Its own rejection, when it comes, changes nothing, is not unhandled, and frees Kimi's login.
  rejectLate(sdkError("OAuthError", "Login aborted by caller"));
  await settle();
  const later = loginId("kimi-later");
  host.startLogin(later, "kimi", "global");
  await settle();
  assert.deepEqual(resultOf(later), { kind: "logged_in" });
  assert.equal(logins, 2);
});

test("a Kimi login the SDK fails reads failed by the error's class, never its message", async () => {
  const cases = [
    ["OAuthAccessDeniedError", { kind: "failed", reason: "rejected", detail: "Kimi reported that the sign-in was denied" }],
    ["OAuthUnauthorizedError", { kind: "failed", reason: "rejected", detail: "Kimi did not accept the sign-in" }],
    ["DeviceCodeTimeoutError", { kind: "failed", reason: "timed_out", detail: "The Kimi device code was not approved in time" }],
    ["OAuthConnectionError", { kind: "failed", reason: "process_failed", detail: "Kimi's sign-in service could not be reached" }],
    ["Error", { kind: "failed", reason: "process_failed", detail: "Kimi sign-in did not complete" }],
  ] as const;
  for (const [name, expected] of cases) {
    const { host, sent, events, changes, settle, loginResult } = kimiHost({ login: async () => { throw sdkError(name); } });
    host.startLogin(loginId(`kimi-${name}`), "kimi", "global");
    await settle();
    assert.deepEqual(loginResult(), expected, name);
    assert.deepEqual(changes, [], name);
    assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.login.sdk_error")?.attrs, { runtime: "kimi", error_kind: name === "Error" ? "other" : name });
    assert.ok(!JSON.stringify([sent, events]).includes("secret-in-message"), `${name}: the SDK's message is never relayed or traced`);
  }

  // The SDK could not even be loaded: a failed login, not a hang.
  const sent: RuntimeAuthHostMessage[] = [];
  const unloadable = new RuntimeAuthHost({
    loadRuntime: async () => { throw new Error("no OAR"); },
    kimiStatus: async () => ({ kind: "unknown" }),
    loadKimiAuth: async () => { throw new Error("bundled SDK missing"); },
    loadProviderAuth: async () => null,
    send: (message) => sent.push(message),
    recordEvent: () => undefined,
    now: () => 0,
    serverReads: () => null,
    platform: "linux",
  });
  unloadable.startLogin(loginId("kimi-nosdk"), "kimi", "global");
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((sent[0] as { result: unknown }).result, { kind: "failed", reason: "process_failed" });
});

test("the region the person chose reaches the SDK's login; a start without one passes none", async () => {
  const seen: LoginOptions[] = [];
  const auth = { login: async (_provider: unknown, options: LoginOptions) => { seen.push(options); return LOGGED_IN; } } as unknown as KimiSdkAuth;
  const signal = new AbortController().signal;
  for (const region of ["mainland-cn", "global", undefined] as const) {
    assert.deepEqual((await kimiSdkAuthLogin(auth, { region, signal, relay: () => true })).result, { kind: "logged_in" });
  }
  assert.deepEqual(seen.map((options) => options.region), ["mainland-cn", "global", undefined]);
  assert.ok(!("region" in seen[2]!), "no region key at all, so the SDK keeps its own choice");
  assert.ok(seen.every((options) => options.signal === signal));

  const aborted = new AbortController();
  aborted.abort();
  let called = false;
  const never = { login: async () => { called = true; return LOGGED_IN; } } as unknown as KimiSdkAuth;
  assert.deepEqual((await kimiSdkAuthLogin(never, { region: "global", signal: aborted.signal, relay: () => true })).result, { kind: "cancelled" });
  assert.equal(called, false, "a login cancelled before it started never reaches the SDK");
});

test("a Kimi logout goes through the SDK: logged_out tells the agent hosts and reports the status; a failure says so", async () => {
  const { host, sent, oarLoads, changes, lastStatus, setToken } = kimiHost({});
  setToken(true);
  await host.logout("req-kimi-out", "kimi");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { requestId: string; result: unknown };
  assert.deepEqual(result, { type: "machine:runtime_auth:logout:result", requestId: "req-kimi-out", result: { kind: "logged_out" } });
  assert.deepEqual(changes, [["kimi", "logout"]]);
  assert.deepEqual(lastStatus(), { kind: "logged_out" });
  assert.deepEqual(oarLoads.filter((id) => id === "kimi"), []);

  const failing = kimiHost({ logout: async () => { throw sdkError("Error", "EACCES /home/ada/.kimi-code/credentials"); } });
  await failing.host.logout("req-kimi-fail", "kimi");
  const failed = failing.sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: unknown };
  assert.deepEqual(failed.result, { kind: "failed", reason: "process_failed", detail: "Kimi sign-out did not complete" });
  assert.deepEqual(failing.changes, []);
  assert.ok(!JSON.stringify(failing.sent).includes(".kimi-code"), "no path reaches the web");
});

// SDK upgrade check: the real bundled facade, on a temporary Kimi home, agrees
// with the token-file status the daemon reports (the SDK's default slot,
// `<home>/credentials/kimi-code.json`), and its logout clears that slot.
test("SDK upgrade check: the bundled SDK's hasToken and the token-file status agree, and its logout clears the slot agents read", async () => {
  await withKimiHome(async (home, write) => {
    const sdkHasToken = async () => (await (await loadKimiSdkAuth(home)).status()).providers.some((provider) => provider.hasToken);
    const credential = path.join(home, "credentials", "kimi-code.json");
    const cases: Array<[unknown, RuntimeAuthStatus["kind"]]> = [
      [TOKEN, "logged_in"],
      [{ ...TOKEN, refresh_token: undefined, expires_at: 1 }, "logged_in"],
      [TOMBSTONE, "logged_out"],
      [{ ...TOKEN, access_token: "" }, "logged_out"],
      ["[]", "logged_out"],
      ["not json", "logged_out"],
    ];
    assert.equal(await sdkHasToken(), false);
    assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: "logged_out" });
    for (const [content, expected] of cases) {
      await write("kimi-code.json", content);
      assert.equal(await sdkHasToken(), expected === "logged_in", JSON.stringify(content));
      assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: expected }, JSON.stringify(content));
    }

    await write("kimi-code.json", TOKEN);
    await (await loadKimiSdkAuth(home)).logout();
    await assert.rejects(readFile(credential), "the logout removed the token agents would use");
    assert.deepEqual(await readKimiCodeSignInStatus(home), { kind: "logged_out" });
  });
});
