import assert from "node:assert/strict";

import type { ExecutableInstallation, LoginProvider, OpencodeProviderAuth, ProviderAuthStatus, Runtime } from "@botiverse/oar";
import { OpencodeProviderAuthError } from "@botiverse/oar/runtimes/opencode";

import {
  OPENCODE_OAUTH_PROVIDERS,
  OPENCODE_STATUS_CACHE_MS,
  OpencodeDeadline,
  OpencodeQueueTimeout,
  OpencodeSignInClosed,
  OpencodeSignIn,
  opencodeFormAnswer,
  opencodeKeyEntry,
  opencodeLoginFailure,
  opencodeOAuthAllowed,
  opencodeOAuthFlow,
  opencodeOAuthMethods,
  opencodeProviderFailure,
  opencodeSignedInProviders,
  opencodeStatusOf,
  opencodeTraceErrorKind,
  opencodeWebProvider,
} from "./opencodeProviderSignIn";

/** A few of OpenCode 2's integrations, as OAR 0.100's `loginProviders()` gives them (no `subscription`). */
const COPILOT: LoginProvider = {
  providerId: "github-copilot",
  name: "GitHub Copilot",
  methods: [{ method: "oauth", name: "Login with GitHub" }, { method: "oauth", name: "Login with GitHub (device)" }],
};
const OPENAI: LoginProvider = {
  providerId: "openai",
  name: "OpenAI",
  methods: [
    { method: "oauth", name: "ChatGPT Pro/Plus (browser)" },
    { method: "oauth", name: "ChatGPT Pro/Plus (headless)" },
    { method: "api_key", name: "OpenAI API key" },
    { method: "api_key", name: "OPENAI_API_KEY", ambient: true },
  ],
};
const DEEPSEEK: LoginProvider = { providerId: "deepseek", name: "DeepSeek", methods: [{ method: "api_key", name: "DeepSeek API key" }] };
const AZURE: LoginProvider = { providerId: "azure", name: "Azure", methods: [{ method: "api_key", name: "Azure API key" }] };
/** An integration a plugin adds, with an account sign-in Raft has not reviewed, and a key. */
const GITLAB: LoginProvider = {
  providerId: "gitlab",
  name: "GitLab",
  methods: [{ method: "oauth", name: "GitLab OAuth" }, { method: "api_key", name: "GitLab Personal Access Token" }],
};
const BEDROCK: LoginProvider = { providerId: "amazon-bedrock", name: "Amazon Bedrock", methods: [{ method: "api_key", name: "AWS_ACCESS_KEY_ID, AWS_PROFILE", ambient: true }] };

test("device-code methods come first, by their label; the others keep OpenCode's order", () => {
  assert.equal(opencodeOAuthFlow("Login with GitHub (device)"), "device_code");
  assert.equal(opencodeOAuthFlow("ChatGPT Pro/Plus (headless)"), "device_code");
  assert.equal(opencodeOAuthFlow("ChatGPT Pro/Plus (browser)"), "link");
  assert.deepEqual(opencodeOAuthMethods(COPILOT), [
    { label: "Login with GitHub (device)", flow: "device_code" },
    { label: "Login with GitHub", flow: "link" },
  ]);
  assert.deepEqual(opencodeOAuthMethods(OPENAI).map((method) => method.label), ["ChatGPT Pro/Plus (headless)", "ChatGPT Pro/Plus (browser)"]);
  assert.deepEqual(opencodeOAuthMethods(DEEPSEEK), [], "a key-only provider has no account sign-in");
});

test("OAuth methods are offered only for the allowlisted providers: GitHub Copilot, OpenAI and xAI; a key stays as it was", () => {
  assert.deepEqual(Object.keys(OPENCODE_OAUTH_PROVIDERS).sort(), ["github-copilot", "openai", "xai"]);
  assert.equal(opencodeOAuthAllowed("xai"), true);
  assert.equal(opencodeOAuthAllowed("gitlab"), false);
  assert.equal(opencodeOAuthAllowed("toString"), false, "an own key only, never the prototype's");
  assert.deepEqual(opencodeOAuthMethods(GITLAB), []);
  assert.deepEqual(opencodeOAuthMethods({ providerId: "xai", name: "xAI", methods: [{ method: "oauth", name: "SuperGrok Subscription" }] }), [
    { label: "SuperGrok Subscription", flow: "link" },
  ]);
  assert.deepEqual(opencodeWebProvider(GITLAB, undefined)?.signIn, { apiKey: { label: "GitLab Personal Access Token", entry: "key" } });
});

test("a key is entered from the web only where OpenCode prompts for the key and nothing else", () => {
  assert.equal(opencodeKeyEntry(DEEPSEEK), "key");
  assert.equal(opencodeKeyEntry(OPENAI), "key", "a key prompt wins over the environment variables OpenCode also reads");
  assert.equal(opencodeKeyEntry(AZURE), "more_fields");
  assert.equal(opencodeKeyEntry(BEDROCK), "outside");
  assert.equal(opencodeKeyEntry(COPILOT), null);
});

test("the web provider carries every OAuth method, no subscription claim, the key entry and what is stored", () => {
  const stored: ProviderAuthStatus = { providerId: "openai", configured: true, method: "oauth", label: "OpenAI" };
  assert.deepEqual(opencodeWebProvider(OPENAI, stored), {
    id: "openai",
    label: "OpenAI",
    configured: true,
    endpoint: { kind: "fixed" },
    needsModelIds: false,
    signIn: {
      oauthMethods: [
        { label: "ChatGPT Pro/Plus (headless)", flow: "device_code" },
        { label: "ChatGPT Pro/Plus (browser)", flow: "link" },
      ],
      apiKey: { label: "OpenAI API key", entry: "key" },
      stored: "oauth",
    },
  });
  assert.equal(opencodeWebProvider({ providerId: "bad id!", name: "x", methods: [{ method: "api_key", name: "k" }] }, undefined), null);
});

test("stored sign-ins carry no subscription (OpenCode does not say); an unknown method reads as an account", () => {
  const rows = opencodeSignedInProviders([
    { providerId: "github-copilot", configured: true, method: "oauth" },
    { providerId: "deepseek", configured: true, method: "api_key", label: "DeepSeek" },
    { providerId: "external-thing", configured: true },
    { providerId: "openai", configured: false },
  ], [COPILOT, DEEPSEEK]);
  assert.deepEqual(rows, [
    { id: "github-copilot", label: "GitHub Copilot", method: "oauth" },
    { id: "deepseek", label: "DeepSeek", method: "api_key" },
    { id: "external-thing", label: "external-thing", method: "oauth" },
  ]);
  assert.deepEqual(opencodeStatusOf({ kind: "ready", stored: [], providers: [COPILOT] }), { kind: "logged_out" });
  assert.deepEqual(opencodeStatusOf({ kind: "unavailable", reason: "version_unsupported" }), { kind: "unavailable", reason: "version_unsupported" });
});

test("OAR's error kinds map to the web's reasons; the message is never read", () => {
  const error = (kind: ConstructorParameters<typeof OpencodeProviderAuthError>[0]) => new OpencodeProviderAuthError(kind, "sk-secret-in-a-message");
  assert.deepEqual(opencodeLoginFailure(error("loopback_required")), { kind: "failed", reason: "loopback_required" });
  assert.deepEqual(opencodeLoginFailure(error("authentication_failed")), { kind: "failed", reason: "process_failed" });
  assert.deepEqual(opencodeLoginFailure(error("version_unsupported")), { kind: "unsupported", reason: "version_unsupported" });
  assert.deepEqual(opencodeLoginFailure(error("expired")), { kind: "failed", reason: "timed_out" });
  assert.deepEqual(opencodeLoginFailure(error("rejected")), { kind: "failed", reason: "rejected" });
  assert.deepEqual(opencodeLoginFailure(new Error("plain")), { kind: "failed", reason: "process_failed" });
  assert.equal(opencodeProviderFailure(error("authentication_failed")).reason, "process_failed");
  assert.equal(opencodeProviderFailure(error("method_unavailable")).reason, "rejected");
  assert.equal(opencodeProviderFailure(error("version_unsupported")).kind, "unsupported");
  assert.equal(opencodeProviderFailure(new OpencodeQueueTimeout("busy")).reason, "timed_out");
  assert.ok(!JSON.stringify(opencodeProviderFailure(error("rejected"))).includes("sk-secret"));
  // Trace kinds: OAR's closed set, the queue's own, else "other"; never a message or a made-up kind.
  assert.equal(opencodeTraceErrorKind(error("startup_failed")), "startup_failed");
  assert.equal(opencodeTraceErrorKind(error("authentication_failed")), "authentication_failed");
  assert.equal(opencodeTraceErrorKind(new OpencodeQueueTimeout("x")), "queue_timeout");
  assert.equal(opencodeTraceErrorKind(new OpencodeDeadline("x")), "deadline");
  assert.equal(opencodeTraceErrorKind(Object.assign(new Error("sk-1"), { name: "OpencodeProviderAuthError", kind: "sk-secret-kind" })), "other");
  assert.equal(opencodeTraceErrorKind(new Error("sk-secret")), "other");
});

const INSTALLATION: ExecutableInstallation = { kind: "available", via: "executable", command: "/usr/local/bin/opencode", version: "opencode v2.2.7" };

function fakeFacade(overrides: Partial<OpencodeProviderAuth> = {}) {
  const calls: string[] = [];
  const facade: OpencodeProviderAuth = {
    listProviders: async () => { calls.push("list"); return [{ providerId: "deepseek", configured: true, method: "api_key" }]; },
    loginProviders: () => [COPILOT, DEEPSEEK],
    status: async (providerId) => ({ providerId, configured: false }),
    login: async (providerId) => { calls.push(`login:${providerId}`); return { providerId, configured: true, method: "oauth" }; },
    setApiKey: async (providerId) => { calls.push(`key:${providerId}`); },
    logout: async (providerId) => { calls.push(`logout:${providerId}`); },
    close: async () => { calls.push("close"); },
    ...overrides,
  };
  return { facade, calls };
}

function signIn(facade: OpencodeProviderAuth, options: { installation?: Awaited<ReturnType<NonNullable<Runtime["installation"]>>>; create?: () => Promise<OpencodeProviderAuth> } = {}) {
  let nowMs = 0;
  const creates: ExecutableInstallation[] = [];
  const subject = new OpencodeSignIn({
    loadRuntime: async () => ({ installation: async () => options.installation ?? INSTALLATION } as Runtime),
    create: async (installation) => {
      creates.push(installation);
      return options.create ? options.create() : facade;
    },
    now: () => nowMs,
  });
  return { subject, creates, advance: (ms: number) => { nowMs += ms; } };
}

test("one facade per Computer: created once on the installation OAR found, its status cached until a change", async () => {
  const { facade, calls } = fakeFacade();
  const { subject, creates, advance } = signIn(facade);
  const first = await subject.snapshot();
  assert.equal(first?.kind, "ready");
  await subject.snapshot();
  assert.deepEqual(calls, ["list"], "the second read is the cache: no cold start of opencode serve");
  advance(OPENCODE_STATUS_CACHE_MS);
  await subject.snapshot();
  assert.deepEqual(calls, ["list", "list"], "a stale cache is read again");
  await subject.withFacade("change", (auth) => auth.logout("deepseek"));
  await subject.snapshot();
  assert.deepEqual(calls, ["list", "list", "logout:deepseek", "list"], "a change clears the cache");
  assert.deepEqual(creates, [INSTALLATION], "one facade for all of them");
});

test("operations run one at a time; a status read while a sign-in holds the facade answers from the cache, or not at all", async () => {
  let finishLogin!: () => void;
  const { facade } = fakeFacade({
    login: async (providerId) => {
      await new Promise<void>((resolve) => { finishLogin = resolve; });
      return { providerId, configured: true, method: "oauth" };
    },
  });
  const { subject } = signIn(facade);
  const login = subject.withFacade("login", (auth) => auth.login("github-copilot", "oauth", { onEvent: () => undefined, prompt: async () => "" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.loginPending(), true);
  assert.equal(await subject.snapshot(), null, "no cache yet, and the read does not wait ten minutes behind a sign-in");
  await assert.rejects(subject.withFacade("change", (auth) => auth.logout("deepseek"), { waitMs: 10 }), OpencodeQueueTimeout);
  finishLogin();
  await login;
  assert.equal(subject.loginPending(), false);
  assert.equal((await subject.snapshot())?.kind, "ready");
});

test("OpenCode 1 reads as unavailable {version_unsupported}, and the facade is tried again after a rescan", async () => {
  let attempts = 0;
  const { facade } = fakeFacade();
  const { subject } = signIn(facade, {
    create: async () => {
      attempts += 1;
      if (attempts === 1) throw new OpencodeProviderAuthError("version_unsupported", "OpenCode 1");
      return facade;
    },
  });
  assert.deepEqual(await subject.snapshot(), { kind: "unavailable", reason: "version_unsupported" });
  assert.deepEqual(await subject.snapshot(), { kind: "unavailable", reason: "version_unsupported" }, "cached: no `--version` on every report");
  assert.equal(attempts, 1);
  subject.markStale();
  assert.equal((await subject.snapshot())?.kind, "ready", "upgraded to OpenCode 2 meanwhile");
  assert.equal(attempts, 2);
});

test("a missing OpenCode reads as not installed without creating a facade", async () => {
  const { facade } = fakeFacade();
  const { subject, creates } = signIn(facade, { installation: { kind: "not_found" } });
  assert.deepEqual(await subject.snapshot(), { kind: "unavailable", reason: "not_installed" });
  assert.deepEqual(creates, []);
});

test("a facade whose server cannot start is dropped and closed; close() on shutdown stops the one kept", async () => {
  let failNext = true;
  const { facade, calls } = fakeFacade({
    listProviders: async () => {
      calls.push("list");
      if (failNext) {
        failNext = false;
        throw new OpencodeProviderAuthError("startup_failed", "opencode serve exited");
      }
      return [];
    },
  });
  const { subject, creates } = signIn(facade);
  await assert.rejects(subject.read(), (error: unknown) => (error as { kind?: string }).kind === "startup_failed");
  assert.deepEqual(calls, ["list", "close"]);
  await subject.read();
  assert.equal(creates.length, 2, "a new facade after the failed one");
  await subject.close();
  assert.equal(calls.at(-1), "close");
  await assert.rejects(subject.read(), /closed/u, "nothing starts after shutdown");
});

/** A promise and its resolver, for an operation the test ends when it chooses. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

test("a waiter whose wait runs out gives up its turn; the one behind it runs after the holder, and in order", async () => {
  const { facade } = fakeFacade();
  const { subject } = signIn(facade);
  const order: string[] = [];
  const holder = gate();
  const first = subject.withFacade("change", async () => { order.push("A starts"); await holder.opened; order.push("A ends"); });
  await new Promise((resolve) => setImmediate(resolve));
  const timedOut = subject.withFacade("change", async () => { order.push("B ran"); }, { waitMs: 5 });
  const third = subject.withFacade("change", async () => { order.push("C runs"); });
  await assert.rejects(timedOut, OpencodeQueueTimeout);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["A starts"], "C does not jump the holder because B gave up");
  holder.open();
  await Promise.all([first, third]);
  assert.deepEqual(order, ["A starts", "A ends", "C runs"], "B never ran; C ran once A ended");
  // And the queue keeps going after it.
  await subject.withFacade("change", async () => { order.push("D runs"); }, { waitMs: 5 });
  assert.equal(order.at(-1), "D runs");
});

test("a queued login counts as pending, as a running one does", async () => {
  const { facade } = fakeFacade();
  const { subject } = signIn(facade);
  const holder = gate();
  const read = subject.withFacade("read", async () => { await holder.opened; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.loginPending(), false);
  const login = subject.withFacade("login", async () => undefined);
  assert.equal(subject.loginPending(), true, "waiting behind a read");
  holder.open();
  await Promise.all([read, login]);
  assert.equal(subject.loginPending(), false);
});

test("a total deadline answers before the relay gives up, while the work keeps its turn until it ends", async () => {
  const { facade } = fakeFacade();
  const { subject } = signIn(facade);
  const work = gate();
  const order: string[] = [];
  await assert.rejects(subject.withFacade("change", async () => { await work.opened; order.push("work ended"); }, { deadlineMs: 5 }), OpencodeDeadline);
  const next = subject.withFacade("change", async () => { order.push("next"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "the next operation waits for the work past its deadline");
  work.open();
  await next;
  assert.deepEqual(order, ["work ended", "next"]);
});

test("a rescan drops an idle facade at once, and a busy one before the next operation", async () => {
  const { facade, calls } = fakeFacade();
  const { subject, creates } = signIn(facade);
  await subject.read();
  subject.markStale();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1), "close", "idle: closed at once");
  await subject.read();
  assert.equal(creates.length, 2, "the next read starts afresh (new installation, new registry)");

  const holder = gate();
  const running = subject.withFacade("change", async () => { await holder.opened; });
  await new Promise((resolve) => setImmediate(resolve));
  subject.markStale();
  assert.notEqual(calls.at(-1), "close", "not closed under a running operation");
  holder.open();
  await running;
  await subject.read();
  assert.equal(creates.length, 3, "dropped before the next operation");
  assert.ok(calls.includes("close"));
});

test("close() during a queue wait: the waiter starts nothing", async () => {
  const { facade } = fakeFacade();
  const { subject, creates } = signIn(facade);
  const holder = gate();
  const running = subject.withFacade("read", async () => { await holder.opened; });
  await new Promise((resolve) => setImmediate(resolve));
  const waiter = subject.withFacade("change", async (auth) => auth.logout("deepseek"));
  const closing = subject.close();
  holder.open();
  await running;
  await closing;
  await assert.rejects(waiter, OpencodeSignInClosed);
  assert.equal(creates.length, 1, "no facade was created after close()");
});

test("the one form answer: Copilot's deployment type select with a GitHub.com option, nothing else", () => {
  const deployment = { kind: "select", options: [{ id: "github.com" }, { id: "enterprise" }] };
  assert.equal(opencodeFormAnswer("github-copilot", deployment), "github.com");
  assert.equal(opencodeFormAnswer("github-copilot", { kind: "select", options: [{ id: "enterprise" }] }), null, "Enterprise is not offered from the web");
  assert.equal(opencodeFormAnswer("github-copilot", { kind: "text" }), null, "Enterprise's URL is never answered");
  assert.equal(opencodeFormAnswer("snowflake-cortex", deployment), null, "another provider's form is refused");
});
