import assert from "node:assert/strict";

import type { LoginProvider, OpencodeProviderAuth, ProviderLoginInteraction, Runtime } from "@botiverse/oar";
import { OpencodeProviderAuthError } from "@botiverse/oar/runtimes/opencode";
import { RUNTIME_AUTH_RUNTIMES, asRuntimeAuthLoginId, type RuntimeAuthLoginId, type RuntimeAuthRuntime } from "@botiverse/raft-shared";

import { OpencodeSignIn } from "./opencodeProviderSignIn";
import { RUNTIME_AUTH_STATUS_TIMEOUT_MS, RuntimeAuthHost, type RuntimeAuthHostMessage } from "./runtimeAuthHost";

/** OpenCode 2's sign-ins through the host (docs/contracts/runtime-auth.md §6c), on a fake OAR facade: no process, no network. */

const COPILOT: LoginProvider = {
  providerId: "github-copilot",
  name: "GitHub Copilot",
  methods: [{ method: "oauth", name: "Login with GitHub" }, { method: "oauth", name: "Login with GitHub (device)" }],
};
const OPENAI: LoginProvider = {
  providerId: "openai",
  name: "OpenAI",
  methods: [{ method: "oauth", name: "ChatGPT Pro/Plus (browser)" }, { method: "api_key", name: "OpenAI API key" }],
};
const DEEPSEEK: LoginProvider = { providerId: "deepseek", name: "DeepSeek", methods: [{ method: "api_key", name: "DeepSeek API key" }] };
const AZURE: LoginProvider = { providerId: "azure", name: "Azure", methods: [{ method: "api_key", name: "Azure API key" }] };

const KEY = "sk-opencode-secret-key-123";
const PASTED = "pasted-one-time-code-xyz";

function loginId(suffix: string): RuntimeAuthLoginId {
  return asRuntimeAuthLoginId(`rtl_${suffix.padEnd(16, "0")}`)!;
}

function harness(overrides: Partial<OpencodeProviderAuth> = {}, options: { create?: () => Promise<OpencodeProviderAuth>; providers?: LoginProvider[] } = {}) {
  let creates = 0;
  const sent: RuntimeAuthHostMessage[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const rescans: RuntimeAuthRuntime[] = [];
  const calls: string[] = [];
  const facade: OpencodeProviderAuth = {
    listProviders: async (read) => { calls.push(`list:${JSON.stringify(read)}`); return [{ providerId: "github-copilot", configured: true, method: "oauth" }]; },
    loginProviders: () => options.providers ?? [COPILOT, OPENAI, DEEPSEEK, AZURE],
    status: async (providerId) => ({ providerId, configured: false }),
    login: async (providerId) => ({ providerId, configured: true, method: "oauth" }),
    setApiKey: async (providerId) => { calls.push(`key:${providerId}`); },
    logout: async (providerId) => { calls.push(`logout:${providerId}`); },
    close: async () => { calls.push("close"); },
    ...overrides,
  };
  const opencode = new OpencodeSignIn({
    loadRuntime: async () => ({ installation: async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode", version: "opencode v2.2.7" }) } as Runtime),
    create: async () => {
      creates += 1;
      return options.create ? options.create() : facade;
    },
    now: () => 1_000,
  });
  const host = new RuntimeAuthHost({
    loadRuntime: async () => { throw new Error("OpenCode signs in through its facade only"); },
    loadProviderAuth: async () => null,
    kimiStatus: async () => ({ kind: "logged_out" }),
    loadKimiAuth: async () => { throw new Error("no Kimi here"); },
    send: (message) => sent.push(message),
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: () => 1_000,
    serverReads: () => RUNTIME_AUTH_RUNTIMES,
    platform: "linux",
    rescanModels: (runtime) => { rescans.push(runtime); },
    opencode,
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const resultOf = <T extends RuntimeAuthHostMessage["type"]>(type: T) => sent.find((message) => message.type === type) as Extract<RuntimeAuthHostMessage, { type: T }> | undefined;
  const traced = (name: string) => events.find((event) => event.name === name)?.attrs;
  return { host, sent, events, rescans, calls, settle, resultOf, traced, creates: () => creates };
}

test("OpenCode's status lists each stored provider with no subscription claim, read without resolving", async () => {
  const { host, calls } = harness();
  const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["opencode"]);
  assert.deepEqual(report.runtimes.opencode, { kind: "logged_in", providers: [{ id: "github-copilot", label: "GitHub Copilot", method: "oauth" }] });
  assert.deepEqual(calls, ['list:{"resolve":false}']);
});

test("OpenCode 1 reports unavailable {version_unsupported}, and a login answers unsupported the same way", async () => {
  const { host, settle, resultOf } = harness({}, { create: async () => { throw new OpencodeProviderAuthError("version_unsupported", "OpenCode 1"); } });
  const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["opencode"]);
  assert.deepEqual(report.runtimes.opencode, { kind: "unavailable", reason: "version_unsupported" });
  host.startLogin(loginId("oc-v1"), "opencode", undefined, "github-copilot");
  await settle();
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "unsupported", reason: "version_unsupported" });
});

test("the provider list is OpenCode's registry: every OAuth method of an allowlisted provider, device code first, and each key entry", async () => {
  const { host, resultOf } = harness();
  await host.listProviders("req-oc-list", "opencode");
  const result = resultOf("machine:runtime_auth:providers:result")?.result;
  assert.ok(result?.kind === "listed");
  const copilot = result.providers.find((provider) => provider.id === "github-copilot");
  assert.deepEqual(copilot?.signIn, {
    oauthMethods: [{ label: "Login with GitHub (device)", flow: "device_code" }, { label: "Login with GitHub", flow: "link" }],
    stored: "oauth",
  });
  assert.equal(result.providers.find((provider) => provider.id === "azure")?.signIn?.apiKey?.entry, "more_fields");
});

test("a login answers OAR's method question with the method the person chose, relays the device code, and the models follow", async () => {
  const asked: string[] = [];
  const { host, sent, settle, resultOf, rescans } = harness({
    login: async (providerId, method, interaction: ProviderLoginInteraction) => {
      assert.equal(method, "oauth");
      const choice = await interaction.prompt({
        kind: "select",
        message: "Sign in to GitHub Copilot",
        options: [{ id: "github", label: "Login with GitHub" }, { id: "github-device", label: "Login with GitHub (device)" }],
      });
      asked.push(choice);
      interaction.onEvent({ kind: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
      return { providerId, configured: true, method: "oauth" };
    },
  });
  host.startLogin(loginId("oc-copilot"), "opencode", undefined, "github-copilot", "Login with GitHub (device)");
  await settle();
  assert.deepEqual(asked, ["github-device"]);
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:login:event" && message.event.kind === "device_code"));
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "logged_in" });
  assert.deepEqual(rescans, ["opencode"]);
});

test("without a chosen method the preferred one (device code) answers; a second question ends the login as interaction_failed", async () => {
  const asked: string[] = [];
  const { host, settle, resultOf } = harness({
    login: async (_providerId, _method, interaction: ProviderLoginInteraction) => {
      const options = [{ id: "github", label: "Login with GitHub" }, { id: "github-device", label: "Login with GitHub (device)" }];
      asked.push(await interaction.prompt({ kind: "select", message: "Sign in", options }));
      // A method's own form (an Enterprise domain): never answered from the web.
      await interaction.prompt({ kind: "text", message: "GitHub Enterprise domain" });
      throw new Error("unreachable");
    },
  });
  host.startLogin(loginId("oc-form"), "opencode", undefined, "github-copilot");
  await settle();
  assert.deepEqual(asked, ["github-device"]);
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "failed", reason: "interaction_failed" });
});

test("a sign-in only a browser on the Computer could finish ends as loopback_required, with no link relayed", async () => {
  const { host, sent, settle, resultOf } = harness({
    login: async () => { throw new OpencodeProviderAuthError("loopback_required", "returns the browser to localhost:1455"); },
  });
  host.startLogin(loginId("oc-loopback"), "opencode", undefined, "openai", "ChatGPT Pro/Plus (browser)");
  await settle();
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "failed", reason: "loopback_required" });
  assert.ok(!sent.some((message) => message.type === "machine:runtime_auth:login:event"));
});

test("a pasted code goes to OpenCode's attempt only: in no message, trace or result", async () => {
  const answers: string[] = [];
  const { host, sent, events, settle, resultOf } = harness({
    login: async (providerId, _method, interaction: ProviderLoginInteraction) => {
      interaction.onEvent({ kind: "auth_url", url: "https://auth.example.com/authorize?x=1", instructions: "Paste the code" });
      answers.push(await interaction.prompt({ kind: "manual_code", message: "Paste the authorization code" }));
      return { providerId, configured: true, method: "oauth" };
    },
  });
  host.startLogin(loginId("oc-paste"), "opencode", undefined, "openai", "ChatGPT Pro/Plus (browser)");
  await settle();
  host.submitCode(loginId("oc-paste"), PASTED);
  await settle();
  assert.deepEqual(answers, [PASTED]);
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "logged_in" });
  assert.ok(!JSON.stringify(sent).includes(PASTED));
  assert.ok(!JSON.stringify(events).includes(PASTED));
});

test("a method OpenCode does not list for that provider is never started", async () => {
  let started = false;
  const { host, settle, resultOf } = harness({ login: async (providerId) => { started = true; return { providerId, configured: true }; } });
  host.startLogin(loginId("oc-unknown"), "opencode", undefined, "github-copilot", "Login with Bitbucket");
  await settle();
  assert.equal(started, false);
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "unsupported", reason: "unsupported_installation" });
});

test("a login for a provider off the OAuth allowlist is refused before OpenCode is asked, whatever its method", async () => {
  const GITLAB: LoginProvider = { providerId: "gitlab", name: "GitLab", methods: [{ method: "oauth", name: "GitLab OAuth" }, { method: "api_key", name: "GitLab token" }] };
  let started = false;
  const { host, settle, resultOf } = harness({ login: async (providerId) => { started = true; return { providerId, configured: true }; } }, { providers: [GITLAB] });
  host.startLogin(loginId("oc-gitlab"), "opencode", undefined, "gitlab", "GitLab OAuth");
  await settle();
  assert.equal(started, false);
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "unsupported", reason: "unsupported_installation" });
});

test("the provider list offers no OAuth method for a provider off the allowlist; its key stays", async () => {
  const GITLAB: LoginProvider = { providerId: "gitlab", name: "GitLab", methods: [{ method: "oauth", name: "GitLab OAuth" }, { method: "api_key", name: "GitLab token" }] };
  const { host, resultOf } = harness({}, { providers: [COPILOT, GITLAB] });
  await host.listProviders("req-oc-allow", "opencode");
  const result = resultOf("machine:runtime_auth:providers:result")?.result;
  assert.ok(result?.kind === "listed");
  assert.deepEqual(result.providers.find((provider) => provider.id === "gitlab")?.signIn, { apiKey: { label: "GitLab token", entry: "key" } });
  assert.equal(result.providers.find((provider) => provider.id === "github-copilot")?.signIn?.oauthMethods?.length, 2);
});

test("a key is saved through setApiKey only when OpenCode keeps it literal and the provider takes one key; never logged", async () => {
  const { host, sent, events, calls, resultOf } = harness();
  await host.connectProvider("req-oc-key", "opencode", { providerId: "deepseek", apiKey: KEY });
  assert.deepEqual(resultOf("machine:runtime_auth:connect_provider:result")?.result, { kind: "connected" });
  assert.ok(calls.includes("key:deepseek"));
  assert.ok(!JSON.stringify(sent).includes(KEY));
  assert.ok(!JSON.stringify(events).includes(KEY));

  for (const [providerId, apiKey] of [["deepseek", "{env:DEEPSEEK_KEY}"], ["deepseek", "{file:~/.key}"], ["azure", KEY]] as const) {
    const refused = harness();
    await refused.host.connectProvider("req-oc-refused", "opencode", { providerId, apiKey });
    assert.deepEqual(refused.resultOf("machine:runtime_auth:connect_provider:result")?.result, { kind: "failed", reason: "rejected" }, `${providerId} ${apiKey}`);
    assert.ok(!refused.calls.some((call) => call.startsWith("key:")), "nothing stored");
  }
});

test("a key save while a sign-in holds the facade is busy; the sign-out of one provider clears that provider only", async () => {
  let finishLogin!: () => void;
  const { host, settle, calls, resultOf, sent } = harness({
    login: async (providerId) => {
      await new Promise<void>((resolve) => { finishLogin = resolve; });
      return { providerId, configured: true, method: "oauth" };
    },
  });
  host.startLogin(loginId("oc-hold"), "opencode", undefined, "github-copilot", "Login with GitHub (device)");
  await settle();
  await host.connectProvider("req-oc-busy", "opencode", { providerId: "deepseek", apiKey: KEY });
  assert.deepEqual(resultOf("machine:runtime_auth:connect_provider:result")?.result, { kind: "busy" });
  finishLogin();
  await settle();
  await host.logout("req-oc-out", "opencode", "deepseek");
  assert.ok(calls.includes("logout:deepseek"));
  const logout = sent.find((message) => message.type === "machine:runtime_auth:logout:result");
  assert.deepEqual(logout && "result" in logout ? logout.result : null, { kind: "logged_out" });
});

test("daemon shutdown closes the one OpenCode facade", async () => {
  const { host, calls } = harness();
  await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["opencode"]);
  await host.close();
  assert.equal(calls.at(-1), "close");
});

/** A provider with one OAuth method whose own form asks a question (GitHub Copilot on OpenCode 2.2.7: deployment type). */
const COPILOT_ONE_METHOD: LoginProvider = { providerId: "github-copilot", name: "GitHub Copilot", methods: [{ method: "oauth", name: "Login with GitHub Copilot" }] };

test("Copilot's deployment type (OpenCode 2.2.7, required, no default) is answered GitHub.com, once; nothing else of its form is", async () => {
  const asked: string[] = [];
  const deployment = { kind: "select" as const, message: "Select GitHub deployment type", options: [{ id: "github.com", label: "GitHub.com" }, { id: "enterprise", label: "GitHub Enterprise" }] };
  const { host, settle, resultOf } = harness({
    login: async (providerId, _method, interaction: ProviderLoginInteraction) => {
      asked.push(await interaction.prompt(deployment));
      interaction.onEvent({ kind: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
      return { providerId, configured: true, method: "oauth" };
    },
  }, { providers: [COPILOT_ONE_METHOD] });
  host.startLogin(loginId("oc-copilot-gh"), "opencode", undefined, "github-copilot", "Login with GitHub Copilot");
  await settle();
  assert.deepEqual(asked, ["github.com"], "the same answer as Pi's Copilot: github.com");
  assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "logged_in" });

  // Asked twice, or followed by Enterprise's URL: refused.
  const twice = harness({
    login: async (_providerId, _method, interaction: ProviderLoginInteraction) => {
      await interaction.prompt(deployment);
      await interaction.prompt({ kind: "text", message: "Enter your GitHub Enterprise URL or domain" });
      throw new Error("unreachable");
    },
  }, { providers: [COPILOT_ONE_METHOD] });
  twice.host.startLogin(loginId("oc-copilot-ent"), "opencode", undefined, "github-copilot", "Login with GitHub Copilot");
  await twice.settle();
  assert.deepEqual(twice.resultOf("machine:runtime_auth:login:result")?.result, { kind: "failed", reason: "interaction_failed" });
});

test("with one OAuth method any other provider's form select is refused, and Copilot's without a GitHub.com option too", async () => {
  const XAI: LoginProvider = { providerId: "xai", name: "xAI", methods: [{ method: "oauth", name: "SuperGrok Subscription" }] };
  for (const [provider, options] of [
    [XAI, [{ id: "github.com", label: "GitHub.com" }]],
    [COPILOT_ONE_METHOD, [{ id: "enterprise", label: "GitHub Enterprise" }]],
  ] as const) {
    const { host, settle, resultOf } = harness({
      login: async (_providerId, _method, interaction: ProviderLoginInteraction) => {
        await interaction.prompt({ kind: "select", message: "A form question", options: [...options] });
        throw new Error("unreachable");
      },
    }, { providers: [provider] });
    host.startLogin(loginId(`oc-${provider.providerId.slice(0, 8)}`), "opencode", undefined, provider.providerId, provider.methods[0]!.name);
    await settle();
    assert.deepEqual(resultOf("machine:runtime_auth:login:result")?.result, { kind: "failed", reason: "interaction_failed" }, provider.providerId);
  }
});

test("a status read that outlasts the status bound answers unknown; it runs on and fills the cache for the next report", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let finish!: () => void;
    const { host, calls } = harness({
      listProviders: async () => {
        calls.push("list");
        await new Promise<void>((resolve) => { finish = resolve; });
        return [{ providerId: "deepseek", configured: true, method: "api_key" }];
      },
    });
    const first = host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["opencode", "claude"]);
    await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_STATUS_TIMEOUT_MS);
    assert.deepEqual((await first).runtimes.opencode, { kind: "unknown" }, "a cold opencode serve does not hold up the report");
    finish();
    await vi.advanceTimersByTimeAsync(0);
    const second = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["opencode"]);
    assert.deepEqual(second.runtimes.opencode, { kind: "logged_in", providers: [{ id: "deepseek", label: "DeepSeek", method: "api_key" }] });
    assert.deepEqual(calls, ["list"], "the second report read the cache the first one filled");
  } finally {
    vi.useRealTimers();
  }
});

test("OAR's error kind reaches the traces of a list, a key save, a logout and a login; never its message", async () => {
  const failing = new OpencodeProviderAuthError("startup_failed", "opencode serve exited: sk-secret-in-stderr");
  const { host, settle, traced, events } = harness({
    listProviders: async () => { throw failing; },
    setApiKey: async () => { throw new OpencodeProviderAuthError("authentication_failed", "401"); },
    logout: async () => { throw new OpencodeProviderAuthError("server_failed", "no answer"); },
    login: async () => { throw new OpencodeProviderAuthError("authentication_failed", "401"); },
  });
  await host.listProviders("req-oc-list-fail", "opencode");
  assert.equal(traced("daemon.runtime_auth.providers.result")?.error_kind, "startup_failed");
  await host.connectProvider("req-oc-key-fail", "opencode", { providerId: "deepseek", apiKey: KEY });
  assert.equal(traced("daemon.runtime_auth.connect_provider.result")?.error_kind, "authentication_failed");
  await host.logout("req-oc-out-fail", "opencode", "deepseek");
  assert.equal(traced("daemon.runtime_auth.logout.result")?.error_kind, "server_failed");
  host.startLogin(loginId("oc-auth-fail"), "opencode", undefined, "github-copilot", "Login with GitHub (device)");
  await settle();
  assert.deepEqual(traced("daemon.runtime_auth.login.result"), {
    runtime: "opencode", provider_id: "github-copilot", outcome: "failed", reason: "process_failed", error_kind: "authentication_failed", code_prompts: 0, duration_ms: 0,
  });
  assert.ok(!JSON.stringify(events).includes("sk-secret"), "no message in any trace");
});

test("a sign-out while a sign-in runs or waits is busy at once; so is a key save", async () => {
  let finishLogin!: () => void;
  const { host, settle, calls, sent, resultOf } = harness({
    login: async (providerId) => {
      await new Promise<void>((resolve) => { finishLogin = resolve; });
      return { providerId, configured: true, method: "oauth" };
    },
  });
  host.startLogin(loginId("oc-busy"), "opencode", undefined, "github-copilot", "Login with GitHub (device)");
  await settle();
  await host.logout("req-oc-busy-out", "opencode", "deepseek");
  const logout = sent.find((message) => message.type === "machine:runtime_auth:logout:result");
  assert.deepEqual(logout && "result" in logout ? logout.result : null, { kind: "failed", reason: "busy" });
  await host.connectProvider("req-oc-busy-key", "opencode", { providerId: "deepseek", apiKey: KEY });
  assert.deepEqual(resultOf("machine:runtime_auth:connect_provider:result")?.result, { kind: "busy" });
  assert.ok(!calls.some((call) => call.startsWith("logout:") || call.startsWith("key:")), "neither reached OpenCode");
  finishLogin();
  await settle();
});

test("a runtime rescan drops the facade, so the next read takes OpenCode's new installation and registry", async () => {
  const { host, creates, calls } = harness();
  await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["opencode"]);
  assert.equal(creates(), 1);
  await host.reportStatus("ready", ["opencode"]);
  assert.ok(calls.includes("close"), "the idle facade was closed");
  assert.equal(creates(), 2, "the report after the rescan read through a new one");
});
