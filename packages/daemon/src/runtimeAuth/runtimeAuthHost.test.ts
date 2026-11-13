import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { BasicTracer, createSpanAttrContractTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import type { LoginProvider, ProviderAuthFacade, ProviderAuthStatus, ProviderLoginInteraction, Runtime } from "@botiverse/oar";
import { createPiProviderAuth } from "@botiverse/oar/runtimes/pi";
import { antigravityRuntime } from "@botiverse/oar/runtimes/antigravity";
import { grokRuntime } from "@botiverse/oar/runtimes/grok";
import { QwenProviderAuthError, qwenRuntime, type QwenProvider, type QwenProviderAuth, type QwenProviderConnectOptions } from "@botiverse/oar/runtimes/qwen";
import {
  RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS,
  RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS,
  RUNTIME_AUTH_RUNTIMES,
  RUNTIME_AUTH_V1_RUNTIMES,
  SERVER_CAPABILITY_RUNTIME_AUTH_V1,
  SERVER_CAPABILITY_RUNTIME_AUTH_V2,
  asRuntimeAuthLoginId,
  type RuntimeAuthLoginId,
  type RuntimeAuthRuntime,
} from "@botiverse/raft-shared";

import type { OarProviderAuth } from "../oarLoader";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import { ANTIGRAVITY_ENV_OVERRIDES } from "../drivers/antigravity.deprecated";
import type { KimiSdkAuth } from "./kimiSdkAuth";
import { PI_KEY_PROVIDERS_ASKING_MORE, PI_OAUTH_FLOWS } from "./piProviderSignIn";
import {
  RUNTIME_AUTH_LOGOUT_TIMEOUT_MS,
  RUNTIME_AUTH_OAR_ENV,
  RUNTIME_AUTH_PROVIDER_TIMEOUT_MS,
  RUNTIME_AUTH_STATUS_TIMEOUT_MS,
  RuntimeAuthHost,
  authLabelTraceValue,
  runtimeAuthRuntimesReadBy,
  type RuntimeAuthCredentialsChange,
  type RuntimeAuthHostMessage,
} from "./runtimeAuthHost";

const installation = { kind: "available", via: "executable", command: "/usr/bin/claude", version: "2.1.304" } as const;
const PASTED_CODE = "secret-one-time-code#state-xyz";

function loginId(suffix: string): RuntimeAuthLoginId {
  return asRuntimeAuthLoginId(`rtl_${suffix.padEnd(16, "0")}`)!;
}

function harness(runtime: Partial<Runtime>, options: {
  serverReads?: readonly RuntimeAuthRuntime[] | null;
  platform?: NodeJS.Platform;
  /** OAR's provider facade for Qwen Code; none by default. */
  providerAuth?: Partial<QwenProviderAuth>;
  onCredentialsChanged?: (runtime: RuntimeAuthRuntime, reason: RuntimeAuthCredentialsChange) => void;
  /** The bundled Kimi Code SDK's sign-in; signed out by default. */
  kimiAuth?: Partial<KimiSdkAuth>;
  /** OAR's Pi provider facade; none (Pi not wired) by default. */
  piAuth?: Partial<ProviderAuthFacade>;
} = {}) {
  const rescans: string[] = [];
  const sent: RuntimeAuthHostMessage[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const loads: string[] = [];
  const facadeOptions: unknown[] = [];
  const providerAuth: OarProviderAuth | null = options.providerAuth
    ? { create: async (_installation, facade) => { facadeOptions.push(facade); return options.providerAuth as QwenProviderAuth; } }
    : null;
  const host = new RuntimeAuthHost({
    loadRuntime: async (id) => {
      loads.push(id);
      return { installation: async () => installation, ...runtime } as Runtime;
    },
    loadProviderAuth: async (id) => {
      loads.push(`${id}:provider-auth`);
      return id === "qwen" ? providerAuth : null;
    },
    kimiStatus: async () => {
      loads.push("kimi-status");
      return { kind: "logged_out" };
    },
    loadKimiAuth: async () => {
      loads.push("kimi-sdk-auth");
      return {
        status: async () => { throw new Error("the daemon reads Kimi's status from its token files"); },
        login: async () => { throw new Error("no Kimi login in this test"); },
        logout: async () => ({ providerName: "managed:kimi-code", ok: true }),
        ...options.kimiAuth,
      } as KimiSdkAuth;
    },
    providerSettingsCwd: "/home/ada",
    send: (message) => sent.push(message),
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: () => 1_000,
    serverReads: () => (options.serverReads === undefined ? RUNTIME_AUTH_RUNTIMES : options.serverReads),
    platform: options.platform ?? "linux",
    ...(options.onCredentialsChanged ? { onCredentialsChanged: options.onCredentialsChanged } : {}),
    ...(options.piAuth ? {
      loadPiAuth: async () => {
        loads.push("pi-auth");
        return { loginProviders: () => PI_PROVIDERS, listProviders: async () => [], ...options.piAuth } as ProviderAuthFacade;
      },
      piDeviceId: () => "6f1c9d3e-2b7a-4c55-9e1d-0a2b3c4d5e6f",
      rescanModels: (runtime: RuntimeAuthRuntime) => { rescans.push(runtime); },
    } : {}),
  });
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { host, sent, events, loads, settle, facadeOptions, rescans };
}

/** A few of pi's own `/login` entries, as OAR's `loginProviders()` gives them. */
const PI_PROVIDERS: LoginProvider[] = [
  { providerId: "amazon-bedrock", name: "Amazon Bedrock", methods: [{ method: "api_key", name: "AWS credentials or bearer token" }] },
  { providerId: "anthropic", name: "Anthropic", methods: [{ method: "oauth", name: "Anthropic (Claude Pro/Max)", subscription: true }, { method: "api_key", name: "Anthropic API key" }] },
  { providerId: "deepseek", name: "DeepSeek", methods: [{ method: "api_key", name: "DeepSeek API key" }] },
  { providerId: "future-sso", name: "Future SSO", methods: [{ method: "oauth", name: "Future SSO", subscription: false }] },
  { providerId: "github-copilot", name: "GitHub Copilot", methods: [{ method: "oauth", name: "GitHub Copilot", subscription: true }, { method: "api_key", name: "GitHub Copilot token" }] },
  { providerId: "openrouter", name: "OpenRouter", methods: [{ method: "oauth", name: "OpenRouter OAuth", subscription: false, loginLabel: "Sign in with OpenRouter" }, { method: "api_key", name: "OpenRouter API key" }] },
];

test("task #17: status masks the account email, and a runtime detection did not find is never probed", async () => {
  const { host, loads } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "claude auth status", account: { email: "ada@example.com", plan: "max", method: "claude.ai" } }),
  });
  const report = await host.collectStatus(RUNTIME_AUTH_V1_RUNTIMES, ["claude"]);
  const claude = report.runtimes.claude;
  assert.ok(claude?.kind === "logged_in");
  assert.equal(claude.account?.planLabel, "max");
  assert.equal(claude.account?.methodLabel, "claude.ai");
  assert.ok(claude.account?.maskedLabel && !claude.account.maskedLabel.includes("ada@"), "masked on the Computer");
  assert.ok(!JSON.stringify(report).includes("ada@example.com"), "the full address never leaves the Computer");
  assert.deepEqual(report.runtimes.codex, { kind: "unavailable", reason: "not_installed" });
  assert.deepEqual(loads, ["claude"], "codex was not detected, so nothing ran for it");
});

test("task #17: a status query that throws reads unknown, never a guess", async () => {
  const { host } = harness({ authStatus: async () => { throw new Error("boom"); } });
  assert.deepEqual((await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["claude", "codex"])).runtimes.claude, { kind: "unknown" });
});

test("task #17: a Claude-style login relays the link and the code prompt, writes the pasted code to the prompt only, and reports the new status", async () => {
  let answered: string | null = null;
  let options: unknown;
  const { host, sent, events, settle } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "x", account: { email: "ada@example.com" } }),
    login: async (_installation, interaction, loginOptions) => {
      options = loginOptions;
      interaction.onEvent({ kind: "auth_url", url: "https://claude.ai/oauth/authorize?code=true&state=abc", instructions: "Open this link" });
      answered = await interaction.prompt({ kind: "manual_code", message: "Paste code here" });
      return { kind: "logged_in", account: { email: "ada@example.com", plan: "max" } };
    },
  });
  const id = loginId("claude");
  host.startLogin(id, "claude");
  await settle();
  assert.deepEqual(sent.map((message) => message.type), ["machine:runtime_auth:login:event", "machine:runtime_auth:login:event"]);
  assert.equal((sent[0] as { event: { kind: string } }).event.kind, "auth_url");
  assert.equal((sent[1] as { event: { kind: string } }).event.kind, "code_prompt");

  host.submitCode(id, PASTED_CODE);
  await settle();
  assert.equal(answered, PASTED_CODE, "the code reached the runtime's prompt");
  assert.deepEqual(options, { openBrowser: false }, "no browser opens on the Computer");
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: { kind: string } } | undefined;
  assert.equal(result?.result.kind, "logged_in");
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"), "a fresh status follows the login");

  // The pasted code is in no message Raft sends and in no trace event.
  assert.ok(!JSON.stringify(sent).includes(PASTED_CODE));
  assert.ok(!JSON.stringify(events).includes(PASTED_CODE));
  assert.ok(!JSON.stringify(events).includes("claude.ai/oauth"), "nor the link");
});

test("task #17: a second login for the same runtime is busy; cancel aborts the running one", async () => {
  const { host, sent, settle } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "x" }),
    login: (_installation, interaction) => new Promise((resolve) => {
      interaction.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
    }),
  });
  const first = loginId("first");
  host.startLogin(first, "codex");
  host.startLogin(loginId("second"), "codex");
  await settle();
  const results = () => sent.filter((message) => message.type === "machine:runtime_auth:login:result") as Array<{ loginId: string; result: { kind: string } }>;
  assert.deepEqual(results().map((message) => message.result.kind), ["busy"]);

  host.cancelLogin(first);
  await settle();
  assert.deepEqual(results().map((message) => [message.loginId === first, message.result.kind]), [[false, "busy"], [true, "cancelled"]]);
});

test("task #17: a link that is not https never reaches the web, and the login fails instead of waiting", async () => {
  let onEventThrew = false;
  const { host, sent, settle } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "x" }),
    login: async (_installation, interaction) => {
      try {
        interaction.onEvent({ kind: "auth_url", url: "http://insecure.example/login" });
      } catch {
        onEventThrew = true; // OAR turns this into interaction_failed
        return { kind: "failed", reason: "interaction_failed" };
      }
      return { kind: "logged_in" };
    },
  });
  host.startLogin(loginId("plain"), "claude");
  await settle();
  assert.ok(onEventThrew, "the host refused the link, so OAR ends the login");
  assert.ok(!sent.some((message) => message.type === "machine:runtime_auth:login:event"), "nothing relayed");
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: { kind: string; reason?: string } };
  assert.deepEqual(result.result, { kind: "failed", reason: "interaction_failed" });
});

test("task #17: any prompt but Claude's code is refused", async () => {
  let refused = false;
  const { host, settle } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "x" }),
    login: async (_installation, interaction) => {
      await interaction.prompt({ kind: "secret", message: "API key" }).catch(() => { refused = true; });
      return { kind: "failed", reason: "interaction_failed" };
    },
  });
  host.startLogin(loginId("secret"), "claude");
  await settle();
  assert.ok(refused);
});

test("task #17: a repeated start for a running login changes nothing; busy leaves the running login reachable", async () => {
  let logins = 0;
  const { host, sent, settle } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "x" }),
    login: (_installation, interaction) => {
      logins += 1;
      return new Promise((resolve) => {
        interaction.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
      });
    },
  });
  const first = loginId("again");
  host.startLogin(first, "claude");
  host.startLogin(first, "claude");
  host.startLogin(loginId("other"), "claude");
  await settle();
  assert.equal(logins, 1, "one OAR login, not two");
  host.cancelLogin(first);
  await settle();
  const results = sent.filter((message) => message.type === "machine:runtime_auth:login:result") as Array<{ loginId: string; result: { kind: string } }>;
  assert.deepEqual(results.map((message) => [message.loginId === first, message.result.kind]), [[false, "busy"], [true, "cancelled"]]);
});

test("task #17: a code prompt still open when the login settles is closed", async () => {
  let promptSettled: string | null = null;
  const { host, settle } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "x" }),
    login: async (_installation, interaction) => {
      void interaction.prompt({ kind: "manual_code", message: "Paste" }).then(() => { promptSettled = "resolved"; }, () => { promptSettled = "rejected"; });
      return { kind: "logged_in" }; // the browser redirect won before any paste
    },
  });
  host.startLogin(loginId("moot"), "claude");
  await settle();
  assert.equal(promptSettled, "rejected");
});

test("task #17: overlapping status reports run one at a time and the last one sent is the newest", async () => {
  let state: "logged_out" | "logged_in" = "logged_out";
  let release: () => void = () => {};
  let firstQuery = true;
  const { host, sent, settle } = harness({
    authStatus: async () => {
      const read = state;
      if (firstQuery) {
        firstQuery = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { kind: read, source: "x" } as never;
    },
  });
  const slow = host.reportStatus("ready", ["claude"]);
  await settle();
  state = "logged_in";
  const fresh = host.reportStatus("login");
  release();
  await Promise.all([slow, fresh]);
  await settle();
  const reports = sent.filter((message) => message.type === "machine:runtime_auth:status") as Array<{ report: { runtimes: { claude?: { kind: string } } } }>;
  assert.equal(reports.at(-1)?.report.runtimes.claude?.kind, "logged_in");
});

test("reconciler step 15: reportFreshStatus answers from a query started after the call, never from one already running", async () => {
  let state: "logged_out" | "logged_in" = "logged_out";
  let release: () => void = () => {};
  let firstQuery = true;
  const { host, settle } = harness({
    authStatus: async () => {
      const read = state;
      if (firstQuery) {
        firstQuery = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { kind: read, source: "x" } as never;
    },
  });
  const slow = host.reportStatus("ready", ["claude"]);
  await settle();
  // The sign-in lands while the older query runs: its answer is stale.
  state = "logged_in";
  const fresh = host.reportFreshStatus("credentials_changed_on_disk", "claude");
  release();
  await slow;
  assert.deepEqual(await fresh, { kind: "logged_in" });

  const none = harness({ authStatus: async () => ({ kind: "logged_in", source: "x" }) }, { serverReads: null });
  assert.equal(await none.host.reportFreshStatus("credentials_changed_on_disk", "claude"), null, "no server reads a report: no status");
});

test("task #17: a code for an unknown or finished login is dropped without being recorded", async () => {
  const { host, events } = harness({});
  host.submitCode(loginId("nobody"), PASTED_CODE);
  assert.deepEqual(events.map((event) => [event.name, event.attrs.reason]), [["daemon.runtime_auth.login.code_dropped", "unknown_login"]]);
  assert.ok(!JSON.stringify(events).includes(PASTED_CODE));
});

test("browser_suppression_unavailable reaches the web as an unsupported installation", async () => {
  // Only Kimi's login answers this today; the runtime here just carries it to pin the translation.
  const { host, sent, settle } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "x" }),
    login: async () => ({ kind: "unsupported", reason: "browser_suppression_unavailable", detail: "no browser helper" }),
    logout: async () => ({ kind: "unsupported", reason: "browser_suppression_unavailable" }),
  });
  host.startLogin(loginId("nobrowser"), "claude");
  await settle();
  const login = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: unknown };
  assert.deepEqual(login.result, { kind: "unsupported", reason: "unsupported_installation", detail: "no browser helper" });

  await host.logout("req-nobrowser", "claude");
  const logout = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: unknown };
  assert.deepEqual(logout.result, { kind: "unsupported", reason: "unsupported_installation" });
});

test("task #17: logout relays OAR's result, still_logged_in included, and reports the status after", async () => {
  const { host, sent } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "x" }),
    logout: async () => ({ kind: "failed", reason: "still_logged_in", detail: "ANTHROPIC_API_KEY is set" }),
  });
  await host.logout("req-1", "claude");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { requestId: string; result: unknown };
  assert.deepEqual(result, { type: "machine:runtime_auth:logout:result", requestId: "req-1", result: { kind: "failed", reason: "still_logged_in", detail: "ANTHROPIC_API_KEY is set" } });
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"));
});

test("the status trace names each runtime's sign-in method and plan, never the account", async () => {
  const { host, events } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "claude auth status", account: { email: "ada@example.com", plan: "max", method: "claude.ai" } }),
  });
  await host.reportStatus("ready", ["claude"]);
  const reported = events.find((event) => event.name === "daemon.runtime_auth.status.reported");
  assert.equal(reported?.attrs.claude, "logged_in");
  assert.equal(reported?.attrs.claude_method, "claude.ai");
  assert.equal(reported?.attrs.claude_plan, "max");
  assert.equal(reported?.attrs.codex_method, undefined, "codex was not detected");
  assert.ok(!JSON.stringify(events).includes("ada"), "neither the address nor its masked form");
});

test("the status trace keeps method, plan and OAR's sign-in / billing kinds through the real contract and local sink (#oar-raft:eea998ea)", async () => {
  const { host, events } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "claude auth status", account: { email: "ada@example.com", plan: "max", method: "claude.ai", credential: "account", metering: "plan" } }),
  });
  await host.reportStatus("ready", ["claude"]);
  const reported = events.find((event) => event.name === "daemon.runtime_auth.status.reported")!;
  const machineDir = await mkdtemp(path.join(tmpdir(), "auth-trace-"));
  try {
    // Production path: the daemon's contract tracer in front of the local rotating sink.
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 2 });
    const tracer = createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS);
    tracer.emitEvent(reported.name, { surface: "daemon", attrs: reported.attrs as never });
    let written: Record<string, unknown> = {};
    for (const name of readdirSync(path.join(machineDir, "traces"))) {
      for (const line of (await readFile(path.join(machineDir, "traces", name), "utf8")).split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
        if (record.name === reported.name) written = record.attrs ?? {};
      }
    }
    assert.equal(written.claude, "logged_in");
    assert.equal(written.claude_method, "claude.ai");
    assert.equal(written.claude_plan, "max");
    assert.equal(written.claude_sign_in_kind, "account");
    assert.equal(written.claude_billing_kind, "plan");
    assert.ok(!JSON.stringify(written).includes("ada"));
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("a runtime signed in on one report and signed out on the next carries no sign-in kinds on the second", async () => {
  let status: "logged_in" | "logged_out" = "logged_in";
  const { host, events } = harness({
    authStatus: async () => (status === "logged_in"
      ? { kind: "logged_in", source: "x", account: { credential: "api_key", method: "apiKey" } }
      : { kind: "logged_out", source: "x" }),
  });
  await host.reportStatus("ready", ["claude"]);
  status = "logged_out";
  await host.reportStatus("again", ["claude"]);
  const reports = events.filter((event) => event.name === "daemon.runtime_auth.status.reported");
  assert.equal(reports[0]?.attrs.claude_sign_in_kind, "api_key");
  assert.equal(reports[1]?.attrs.claude, "logged_out");
  assert.equal(reports[1]?.attrs.claude_sign_in_kind, undefined);
  assert.equal(reports[1]?.attrs.claude_method, undefined);
});

test("authLabelTraceValue keeps short label tokens and folds anything else into other", () => {
  assert.equal(authLabelTraceValue("Claude Max"), "claude max");
  assert.equal(authLabelTraceValue("api_key"), "api_key");
  assert.equal(authLabelTraceValue("ada@example.com"), "other");
  assert.equal(authLabelTraceValue("x".repeat(41)), "other");
  assert.equal(authLabelTraceValue(undefined), undefined);
});

test("a V1 server is sent exactly Claude Code and Codex; a V2 server every runtime, Kimi read for Kimi Code", async () => {
  const authStatus = async () => ({ kind: "logged_out", source: "x" }) as const;
  const v1 = harness({ authStatus }, { serverReads: RUNTIME_AUTH_V1_RUNTIMES });
  await v1.host.reportStatus("ready", ["claude", "codex", "kimi-sdk", "qoder"]);
  const v1Report = v1.sent.find((message) => message.type === "machine:runtime_auth:status") as { report: { runtimes: object } };
  assert.deepEqual(Object.keys(v1Report.report.runtimes).sort(), ["claude", "codex"], "an older server refuses a report naming anything else");
  assert.deepEqual(v1.loads.sort(), ["claude", "codex"]);

  const v2 = harness({ authStatus }, { serverReads: RUNTIME_AUTH_RUNTIMES });
  await v2.host.reportStatus("ready", ["kimi-sdk", "qoder"]);
  const v2Report = v2.sent.find((message) => message.type === "machine:runtime_auth:status") as { report: { runtimes: object } };
  assert.deepEqual(v2Report.report.runtimes, {
    claude: { kind: "unavailable", reason: "not_installed" },
    codex: { kind: "unavailable", reason: "not_installed" },
    kimi: { kind: "logged_out" },
    qoder: { kind: "logged_out" },
    // A V2 server from before Qwen Code drops this key and keeps the rest (shared runtimeAuth.ts).
    qwen: { kind: "unavailable", reason: "not_installed" },
    antigravity: { kind: "unavailable", reason: "not_installed" },
    // Pi is in-process and always detected; not detected here, so its sign-ins are not read.
    pi: { kind: "unavailable", reason: "not_installed" },
    grok: { kind: "unavailable", reason: "not_installed" },
    opencode: { kind: "unavailable", reason: "not_installed" },
    codebuddy: { kind: "unavailable", reason: "not_installed" },
  });
  assert.deepEqual(v2.loads.sort(), ["kimi-status", "qoder"], "Kimi Code's status is read from its token files: neither OAR's kimi nor the SDK is loaded");

  // The Kimi CLI alone brings in no sign-in: its ~/.kimi is not Kimi Code's home.
  const cliOnly = harness({ authStatus }, { serverReads: RUNTIME_AUTH_RUNTIMES });
  assert.deepEqual((await cliOnly.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["kimi"])).runtimes.kimi, { kind: "unavailable", reason: "not_installed" });
  assert.deepEqual(cliOnly.loads, []);
  const traced = v2.events.find((event) => event.name === "daemon.runtime_auth.status.reported");
  assert.equal(traced?.attrs.kimi, "logged_out");
  assert.equal(traced?.attrs.qoder, "logged_out");
});

test("no status query runs and no report is sent while no server reads one", async () => {
  const { host, sent, loads } = harness({ authStatus: async () => ({ kind: "logged_out", source: "x" }) }, { serverReads: null });
  await host.reportStatus("ready", ["claude"]);
  assert.deepEqual(sent, []);
  assert.deepEqual(loads, []);
});

test("Qoder is never run on Windows: reported unsupported, and a login or logout there answers so", async () => {
  const { host, sent, loads, settle } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "x" }),
    login: async () => ({ kind: "logged_in" }),
    logout: async () => ({ kind: "logged_out" }),
  }, { platform: "win32" });
  const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["qoder"]);
  assert.deepEqual(report.runtimes.qoder, { kind: "unavailable", reason: "unsupported_installation" });
  host.startLogin(loginId("winqoder"), "qoder");
  await settle();
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: unknown };
  assert.deepEqual(result.result, { kind: "unsupported", reason: "unsupported_installation" });
  await host.logout("req-winqoder", "qoder");
  const logout = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: unknown };
  assert.deepEqual(logout.result, { kind: "unsupported", reason: "unsupported_installation" });
  assert.ok(!loads.includes("qoder"), "OAR's qoder was never loaded");
});

test("Kimi signs in to the region the person chose; its device code reaches the web, the region only a trace", async () => {
  for (const region of ["mainland-cn", "global"] as const) {
    let options: Parameters<KimiSdkAuth["login"]>[1];
    const { host, sent, events, loads, settle } = harness({}, {
      kimiAuth: {
        login: async (_provider, loginOptions) => {
          options = loginOptions;
          await loginOptions?.onDeviceCode?.({
            userCode: "WXYZ-1234",
            deviceCode: "device-secret",
            verificationUri: "https://www.kimi.com/code/authorize_device",
            verificationUriComplete: "https://www.kimi.com/code/authorize_device?user_code=WXYZ-1234",
            expiresIn: 1800,
            interval: 5,
          });
          return { providerName: "managed:kimi-code", ok: true, defaultModel: "kimi-for-coding", defaultThinking: true };
        },
      },
    });
    host.startLogin(loginId(`kimi-${region}`), "kimi", region);
    await settle();
    assert.equal(options?.region, region, "the SDK's login gets the region");
    const event = sent.find((message) => message.type === "machine:runtime_auth:login:event") as { event: unknown };
    assert.deepEqual(event.event, {
      kind: "device_code",
      userCode: "WXYZ-1234",
      verificationUri: "https://www.kimi.com/code/authorize_device?user_code=WXYZ-1234",
      expiresInSeconds: 1800,
    });
    assert.ok(!JSON.stringify(sent).includes("device-secret"), "the device code the SDK polls with never leaves the Computer");
    assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.login.started")?.attrs, { runtime: "kimi", region });
    assert.ok(!JSON.stringify(events).includes("WXYZ-1234"), "the device code is in no trace");
    assert.ok(!JSON.stringify(events).includes("kimi.com"), "nor the link");
    assert.ok(!loads.includes("kimi"), "OAR's kimi was never loaded");
  }
});

test("a runtime OAR has no logout for (Qoder's case) answers unsupported", async () => {
  const { host, sent } = harness({ authStatus: async () => ({ kind: "logged_in", source: "x" }) });
  await host.logout("req-qoder", "qoder");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: unknown };
  assert.deepEqual(result.result, { kind: "unsupported", reason: "unsupported_installation" });
});

test("status queries and the logout carry bounds that fit the server's logout relay", async () => {
  const seen: { status: Array<{ timeoutMs?: number } | undefined>; logout?: unknown } = { status: [] };
  const { host } = harness({
    authStatus: async (_installation, options) => { seen.status.push(options); return { kind: "logged_out", source: "x" }; },
    logout: async (_installation, options) => { seen.logout = options; return { kind: "logged_out" }; },
  });
  await host.logout("req-codex", "codex");
  assert.deepEqual(seen.logout, { timeoutMs: RUNTIME_AUTH_LOGOUT_TIMEOUT_MS });
  assert.ok(seen.status.length > 0);
  // Every runtime's status query in the report after it (Antigravity's also carries its env).
  for (const options of seen.status) assert.equal(options?.timeoutMs, RUNTIME_AUTH_STATUS_TIMEOUT_MS);
  // After its installation check (normally well under a second, not bounded
  // here) OAR 0.100 runs the logout and its confirming status read inside this
  // one bound (the read takes what is left, at least 1s, and may end slightly
  // late): it leaves at least 10s of the server's relay budget for the check.
  assert.ok(RUNTIME_AUTH_LOGOUT_TIMEOUT_MS + 1_000 + 10_000 <= RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS);
});

test("the runtimes a server reads follow its capabilities", () => {
  assert.equal(runtimeAuthRuntimesReadBy([]), null);
  assert.equal(runtimeAuthRuntimesReadBy([SERVER_CAPABILITY_RUNTIME_AUTH_V2]), null, "V2 alone is not a reader");
  assert.deepEqual(runtimeAuthRuntimesReadBy([SERVER_CAPABILITY_RUNTIME_AUTH_V1]), ["claude", "codex"]);
  // A V2 server reads every runtime this daemon knows, Pi included (a server from before Pi drops the
  // key and keeps the rest); what the server may send back is the daemon's capabilities' say, not this.
  assert.deepEqual(runtimeAuthRuntimesReadBy([SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2]), ["claude", "codex", "kimi", "qoder", "qwen", "antigravity", "pi", "grok", "opencode", "codebuddy"]);
});

// ─── Antigravity: status and login (OAR 0.97), logout (OAR 0.98) ───

const GOOGLE_URL = "https://accounts.google.com/o/oauth2/auth?client_id=agy&redirect_uri=http%3A%2F%2Flocalhost%3A8085&state=s1";
/** What a person pastes when they copy the page their browser landed on: it carries the code as a query value. */
const LANDING_URL = "http://localhost:8085/?state=s1&code=4%2F0Agoogle-auth-code-secret&scope=email";

test("Antigravity's status is agy's own (OAR authStatus), read without the SSH session agy would move its sign-in for", async () => {
  const seen: unknown[] = [];
  const { host, loads } = harness({
    authStatus: async (_installation, options) => { seen.push(options); return { kind: "logged_out", source: "agy models" }; },
  });
  const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["antigravity"]);
  assert.deepEqual(report.runtimes.antigravity, { kind: "logged_out" });
  assert.deepEqual(seen, [{ timeoutMs: RUNTIME_AUTH_STATUS_TIMEOUT_MS, env: { SSH_CLIENT: null, SSH_CONNECTION: null, SSH_TTY: null } }]);
  assert.deepEqual(loads, ["antigravity"]);
  assert.deepEqual(Object.keys(RUNTIME_AUTH_OAR_ENV.antigravity ?? {}).sort(), Object.keys(ANTIGRAVITY_ENV_OVERRIDES).sort(), "the same variables its agents are started without");

  const absent = harness({ authStatus: async () => ({ kind: "logged_in", source: "agy models" }) });
  assert.deepEqual((await absent.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["claude"])).runtimes.antigravity, { kind: "unavailable", reason: "not_installed" });
  assert.ok(!absent.loads.includes("antigravity"), "agy not detected: nothing ran for it");
});

test("Antigravity's login relays the Google link and the paste step; the pasted code or landing address reaches agy's prompt only", async () => {
  let answered: string | null = null;
  let options: unknown;
  const { host, sent, events, settle } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "agy models" }),
    login: async (_installation, interaction, loginOptions) => {
      options = loginOptions;
      // OAR's own words (0.97 runtimes/antigravity/auth.js).
      interaction.onEvent({ kind: "auth_url", url: GOOGLE_URL, instructions: "Open this URL and sign in with Google, then paste the code the page shows (or its full address)." });
      answered = await interaction.prompt({ kind: "manual_code", message: "Paste the authorization code, or the full URL of the page you land on after signing in" });
      return { kind: "logged_in" };
    },
  });
  const id = loginId("agy");
  host.startLogin(id, "antigravity");
  await settle();
  assert.deepEqual(sent.map((message) => message.type), ["machine:runtime_auth:login:event", "machine:runtime_auth:login:event"]);
  assert.deepEqual((sent[0] as { event: unknown }).event, { kind: "auth_url", url: GOOGLE_URL, instructions: "Open this URL and sign in with Google, then paste the code the page shows (or its full address)." });
  assert.deepEqual((sent[1] as { event: unknown }).event, { kind: "code_prompt" }, "the web words the paste step itself");

  host.submitCode(id, LANDING_URL);
  await settle();
  assert.equal(answered, LANDING_URL, "the landing address reached agy's prompt as pasted");
  assert.deepEqual(options, { openBrowser: false, env: { SSH_CLIENT: null, SSH_CONNECTION: null, SSH_TTY: null } }, "no browser opens on the Computer; signed in where its agents read");
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: unknown } | undefined;
  assert.deepEqual(result?.result, { kind: "logged_in" });
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"), "a fresh status follows the login");
  assert.ok(!JSON.stringify(sent).includes("google-auth-code-secret"), "the pasted code is in no message Raft sends");
  assert.ok(!JSON.stringify(events).includes("google-auth-code-secret"), "nor in a trace");
  assert.ok(!JSON.stringify(events).includes("accounts.google.com"), "nor the link");
  assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.login.result")?.attrs, { runtime: "antigravity", outcome: "logged_in", reason: undefined, code_prompts: 1, duration_ms: 0 });
});

const AGY_ENV = { SSH_CLIENT: null, SSH_CONNECTION: null, SSH_TTY: null };

test("Antigravity's logout (OAR 0.98) runs agy's own, without the SSH session, and reports the status after", async () => {
  const seen: unknown[] = [];
  const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
  const { host, sent, events } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "agy models" }),
    logout: async (_installation, options) => { seen.push(options); return { kind: "logged_out" }; },
  }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });
  await host.logout("req-agy", "antigravity");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { requestId: string; result: unknown };
  assert.deepEqual(result, { type: "machine:runtime_auth:logout:result", requestId: "req-agy", result: { kind: "logged_out" } });
  assert.deepEqual(seen, [{ timeoutMs: RUNTIME_AUTH_LOGOUT_TIMEOUT_MS, env: AGY_ENV }], "signed out of the store its agents read, within the relay's bound");
  // OAR 0.100 re-reads Antigravity's status with `agy models` inside the same bound.
  assert.ok(RUNTIME_AUTH_LOGOUT_TIMEOUT_MS + 1_000 + 10_000 <= RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS);
  assert.deepEqual(changes, [["antigravity", "logout"]]);
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"), "a fresh status follows the logout");
  assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.logout.result")?.attrs, { runtime: "antigravity", outcome: "logged_out", reason: undefined, duration_ms: 0 });
});

test("Antigravity's logout from an agy build without ACP logout answers version_unsupported", async () => {
  const { host, sent } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "agy models" }),
    // OAR's own words (0.98 runtimes/antigravity/logout.js).
    logout: async () => ({ kind: "unsupported", reason: "version_unsupported", detail: "This agy build has no ACP logout" }),
  });
  await host.logout("req-agy-old", "antigravity");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: unknown };
  assert.deepEqual(result.result, { kind: "unsupported", reason: "version_unsupported", detail: "This agy build has no ACP logout" });
});

test("Antigravity still signed in after its logout (another sign-in active) answers failed still_logged_in, and nothing is released", async () => {
  const changes: unknown[] = [];
  const { host, sent } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "agy models" }),
    logout: async () => ({ kind: "failed", reason: "still_logged_in", detail: "agy acp logout ran, but agy models still reports a sign-in" }),
  }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });
  await host.logout("req-agy-still", "antigravity");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: { kind: string; reason?: string } };
  assert.equal(result.result.kind, "failed");
  assert.equal(result.result.reason, "still_logged_in");
  assert.deepEqual(changes, []);
});

test("OAR upgrade check: OAR's real antigravity runtime has a status, a login and a logout", () => {
  assert.equal(typeof antigravityRuntime.authStatus, "function");
  assert.equal(typeof antigravityRuntime.login, "function");
  assert.equal(typeof (antigravityRuntime as Runtime).logout, "function");
});

test("a server that does not read Antigravity never receives it: V1 gets Claude Code and Codex, a V2 server from before it keeps the rest", async () => {
  const authStatus = async () => ({ kind: "logged_in", source: "agy models" }) as const;
  const v1 = harness({ authStatus }, { serverReads: RUNTIME_AUTH_V1_RUNTIMES });
  await v1.host.reportStatus("ready", ["claude", "antigravity"]);
  const v1Report = v1.sent.find((message) => message.type === "machine:runtime_auth:status") as { report: { runtimes: object } };
  assert.deepEqual(Object.keys(v1Report.report.runtimes).sort(), ["claude", "codex"]);
  assert.ok(!v1.loads.includes("antigravity"), "no agy status query for a server that would not read it");

  const v2 = harness({ authStatus });
  await v2.host.reportStatus("ready", ["claude", "antigravity"]);
  const report = (v2.sent.find((message) => message.type === "machine:runtime_auth:status") as { report: unknown }).report;
  // The report schema of a V2 server from before Antigravity (shared runtimeAuth.ts at #12002): runtimes not strict.
  const status = z.object({ kind: z.string() }).passthrough();
  const beforeAntigravity = z.strictObject({
    collectedAt: z.string(),
    runtimes: z.object({ claude: status.optional(), codex: status.optional(), kimi: status.optional(), qoder: status.optional(), qwen: status.optional() }),
  });
  const parsed = beforeAntigravity.safeParse(report);
  assert.ok(parsed.success, "the older server reads the report");
  assert.deepEqual(parsed.data.runtimes.claude, { kind: "logged_in" }, "Claude Code's status survives");
  assert.ok(!("antigravity" in parsed.data.runtimes), "and it drops the key it does not know");
});

test("the status trace carries Antigravity's keys through the real contract", async () => {
  const { host, events } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "agy models", account: { credential: "account", metering: "plan", method: "google" } }),
  });
  await host.reportStatus("ready", ["antigravity"]);
  const reported = events.find((event) => event.name === "daemon.runtime_auth.status.reported")!;
  assert.equal(reported.attrs.antigravity, "logged_in");
  const spanAttrs = DAEMON_CORE_TRACE_ATTR_CONTRACTS["daemon.runtime_auth.status.reported"]?.spanAttrs ?? [];
  for (const key of ["antigravity", "antigravity_method", "antigravity_plan", "antigravity_sign_in_kind", "antigravity_billing_kind"]) {
    assert.ok(spanAttrs.includes(key), key);
  }
  assert.equal(reported.attrs.antigravity_method, "google");
  assert.equal(reported.attrs.antigravity_sign_in_kind, "account");
  assert.equal(reported.attrs.antigravity_billing_kind, "plan");
});

// ─── Grok Build: status, device-code login and logout (OAR 0.99) ───

/** OAR 0.99's `device_code` from `grok login --device-auth`: the code is the link's `user_code`. */
const GROK_DEVICE_URL = "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234";

// ─── CodeBuddy Code (OAR-only): status, link login, logout ───

test("CodeBuddy's status, link login and logout run on OAR's codebuddy, with no browser on the Computer; never on Windows", async () => {
  const CODEBUDDY_URL = "https://www.codebuddy.ai/login?state=s1";
  let loginOptions: unknown;
  const logoutOptions: unknown[] = [];
  const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
  const { host, sent, events, loads, settle } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "codebuddy stream-json initialize.account" }),
    login: async (_installation, interaction, options) => {
      loginOptions = options;
      interaction.onEvent({ kind: "auth_url", url: CODEBUDDY_URL, instructions: "Open this URL to sign in to CodeBuddy." });
      return { kind: "logged_in" };
    },
    logout: async (_installation, options) => { logoutOptions.push(options); return { kind: "logged_out" }; },
  }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });

  const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["codebuddy"]);
  assert.deepEqual(report.runtimes.codebuddy, { kind: "logged_in" }, "signed in, no account (OAR exposes none)");
  assert.deepEqual(loads, ["codebuddy"], "detected as the Raft runtime codebuddy");

  host.startLogin(loginId("codebuddy"), "codebuddy");
  await settle();
  assert.deepEqual(loginOptions, { openBrowser: false });
  const event = sent.find((message) => message.type === "machine:runtime_auth:login:event") as { event: { kind: string; url?: string } } | undefined;
  assert.equal(event?.event.kind, "auth_url");
  assert.equal(event?.event.url, CODEBUDDY_URL);
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: unknown } | undefined;
  assert.deepEqual(result?.result, { kind: "logged_in" });
  assert.ok(!JSON.stringify(events).includes("codebuddy.ai"), "the link is in no trace");

  await host.logout("req-codebuddy", "codebuddy");
  const logout = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: unknown };
  assert.deepEqual(logout.result, { kind: "logged_out" });
  assert.deepEqual(logoutOptions, [{ timeoutMs: RUNTIME_AUTH_LOGOUT_TIMEOUT_MS }]);
  assert.deepEqual(changes, [["codebuddy", "login"], ["codebuddy", "logout"]], "CodeBuddy agents on the Computer's sign-in are released");

  // The OAR host, and so CodeBuddy, does not run on Windows.
  const windows = harness({ authStatus: async () => ({ kind: "logged_in", source: "x" }), login: async () => ({ kind: "logged_in" }) }, { platform: "win32" });
  assert.deepEqual((await windows.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["codebuddy"])).runtimes.codebuddy, { kind: "unavailable", reason: "unsupported_installation" });
  windows.host.startLogin(loginId("codebuddywin"), "codebuddy");
  await windows.settle();
  const winResult = windows.sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: unknown };
  assert.deepEqual(winResult.result, { kind: "unsupported", reason: "unsupported_installation" });
  assert.ok(!windows.loads.includes("codebuddy"), "OAR's codebuddy was never loaded there");
});

test("Grok's status is grok's own (OAR authStatus, `grok models`): signed in names its method; signed out and unknown pass through", async () => {
  const seen: unknown[] = [];
  const { host, loads } = harness({
    authStatus: async (_installation, options) => { seen.push(options); return { kind: "logged_in", source: "grok models", account: { method: "grok.com" } }; },
  });
  const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["grok"]);
  assert.deepEqual(report.runtimes.grok, { kind: "logged_in", account: { methodLabel: "grok.com" } });
  assert.deepEqual(seen, [{ timeoutMs: RUNTIME_AUTH_STATUS_TIMEOUT_MS }], "the daemon's own environment, as both hosts start grok in");
  assert.deepEqual(loads, ["grok"]);

  const out = harness({ authStatus: async () => ({ kind: "logged_out", source: "grok models" }) });
  assert.deepEqual((await out.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["grok"])).runtimes.grok, { kind: "logged_out" });
  const unknown = harness({ authStatus: async () => ({ kind: "unknown", source: "grok models", detail: "grok models failed" }) });
  assert.deepEqual((await unknown.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["grok"])).runtimes.grok, { kind: "unknown" });
  const absent = harness({ authStatus: async () => ({ kind: "logged_in", source: "grok models" }) });
  assert.deepEqual((await absent.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["claude"])).runtimes.grok, { kind: "unavailable", reason: "not_installed" });
  assert.ok(!absent.loads.includes("grok"), "grok not detected: nothing ran for it");
  // The legacy driver runs Grok on Windows: its status is read there too (only the OAR host's own runtimes are skipped).
  const windows = harness({ authStatus: async () => ({ kind: "logged_out", source: "grok models" }) }, { platform: "win32" });
  assert.deepEqual((await windows.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["grok"])).runtimes.grok, { kind: "logged_out" });
});

test("Grok's login relays the device code and its accounts.x.ai link, asks nothing back, and opens no browser on the Computer", async () => {
  let options: unknown;
  const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
  const { host, sent, events, settle } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "grok models", account: { method: "grok.com" } }),
    login: async (_installation, interaction, loginOptions) => {
      options = loginOptions;
      interaction.onEvent({ kind: "device_code", userCode: "WXYZ-1234", verificationUri: GROK_DEVICE_URL });
      return { kind: "logged_in" };
    },
  }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });
  host.startLogin(loginId("grok"), "grok");
  await settle();
  assert.deepEqual(options, { openBrowser: false }, "no browser opens on the Computer; nothing else in the environment changes");
  const event = sent.find((message) => message.type === "machine:runtime_auth:login:event") as { event: unknown } | undefined;
  assert.deepEqual(event?.event, { kind: "device_code", userCode: "WXYZ-1234", verificationUri: GROK_DEVICE_URL });
  assert.ok(!sent.some((message) => message.type === "machine:runtime_auth:login:event" && (message as { event: { kind: string } }).event.kind === "code_prompt"), "nothing to paste back");
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: unknown } | undefined;
  assert.deepEqual(result?.result, { kind: "logged_in" });
  assert.deepEqual(changes, [["grok", "login"]], "Grok agents on the Computer's sign-in are released");
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"), "a fresh status follows the login");
  assert.ok(!JSON.stringify(events).includes("WXYZ-1234"), "the device code is in no trace");
  assert.ok(!JSON.stringify(events).includes("accounts.x.ai"), "nor the link");
});

test("Grok's login on Windows (OAR: browser_suppression_unavailable) answers unsupported, as other runtimes' do there", async () => {
  const { host, sent, settle } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "grok models" }),
    // OAR's own words (0.99 runtimes/grok/auth.js).
    login: async () => ({ kind: "unsupported", reason: "browser_suppression_unavailable", detail: "OAR has not verified that Grok honours BROWSER on Windows; allow local browser opening" }),
  }, { platform: "win32" });
  host.startLogin(loginId("grokwin"), "grok");
  await settle();
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: { kind: string; reason?: string } } | undefined;
  assert.equal(result?.result.kind, "unsupported");
  assert.equal(result?.result.reason, "unsupported_installation", "the web's existing unsupported copy");
});

test("Grok's logout runs grok's own with one bound that covers OAR's `grok models` re-read (OAR 0.100) inside the relay", async () => {
  const seen: unknown[] = [];
  const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
  const { host, sent, events } = harness({
    authStatus: async () => ({ kind: "logged_out", source: "grok models" }),
    logout: async (_installation, options) => { seen.push(options); return { kind: "logged_out" }; },
  }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });
  await host.logout("req-grok", "grok");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { requestId: string; result: unknown };
  assert.deepEqual(result, { type: "machine:runtime_auth:logout:result", requestId: "req-grok", result: { kind: "logged_out" } });
  assert.deepEqual(seen, [{ timeoutMs: RUNTIME_AUTH_LOGOUT_TIMEOUT_MS }]);
  // OAR 0.100 confirms `grok logout` with `grok models` on what is left of the
  // same deadline (at least 1s); the installation check comes before both.
  assert.ok(RUNTIME_AUTH_LOGOUT_TIMEOUT_MS + 1_000 + 10_000 <= RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS);
  assert.deepEqual(changes, [["grok", "logout"]]);
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"), "a fresh status follows the logout");
  assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.logout.result")?.attrs, { runtime: "grok", outcome: "logged_out", reason: undefined, duration_ms: 0 });
});

test("Grok still signed in after its logout (an xAI API key in the environment) answers failed still_logged_in, and nothing is released", async () => {
  const changes: unknown[] = [];
  const { host, sent } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "grok models", account: { method: "api key" } }),
    logout: async () => ({ kind: "failed", reason: "still_logged_in", detail: "grok logout succeeded, yet grok models still reads logged in (api key)" }),
  }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });
  await host.logout("req-grok-still", "grok");
  const result = sent.find((message) => message.type === "machine:runtime_auth:logout:result") as { result: { kind: string; reason?: string } };
  assert.equal(result.result.kind, "failed");
  assert.equal(result.result.reason, "still_logged_in");
  assert.deepEqual(changes, []);
});

test("OAR upgrade check: OAR's real grok runtime has a status, a login and a logout (OAR 0.99)", () => {
  assert.equal(typeof grokRuntime.authStatus, "function");
  assert.equal(typeof grokRuntime.login, "function");
  assert.equal(typeof (grokRuntime as Runtime).logout, "function");
});

test("a V2 server from before Grok's sign-in reads the report and drops the grok key", async () => {
  const { host, sent } = harness({ authStatus: async () => ({ kind: "logged_in", source: "grok models", account: { method: "grok.com" } }) });
  await host.reportStatus("ready", ["claude", "grok"]);
  const report = (sent.find((message) => message.type === "machine:runtime_auth:status") as { report: unknown }).report;
  // The report schema of a V2 server from before Grok (shared runtimeAuth.ts at OAR 0.98): runtimes not strict.
  const status = z.object({ kind: z.string() }).passthrough();
  const beforeGrok = z.strictObject({
    collectedAt: z.string(),
    runtimes: z.object({ claude: status.optional(), codex: status.optional(), kimi: status.optional(), qoder: status.optional(), qwen: status.optional(), antigravity: status.optional(), pi: status.optional() }),
  });
  const parsed = beforeGrok.safeParse(report);
  assert.ok(parsed.success, "the older server reads the report");
  assert.ok(!("grok" in parsed.data.runtimes), "and drops the key it does not know");
});

test("the status trace carries Grok's keys through the real contract", async () => {
  const { host, events } = harness({ authStatus: async () => ({ kind: "logged_in", source: "grok models", account: { method: "grok.com" } }) });
  await host.reportStatus("ready", ["grok"]);
  const reported = events.find((event) => event.name === "daemon.runtime_auth.status.reported")!;
  assert.equal(reported.attrs.grok, "logged_in");
  const spanAttrs = DAEMON_CORE_TRACE_ATTR_CONTRACTS["daemon.runtime_auth.status.reported"]?.spanAttrs ?? [];
  for (const key of ["grok", "grok_method", "grok_plan", "grok_sign_in_kind", "grok_billing_kind"]) assert.ok(spanAttrs.includes(key), key);
  assert.equal(reported.attrs.grok_method, "grok.com");
});

// ─── Qwen Code: a provider's API key instead of a sign-in ───

const API_KEY = "sk-qwen-provider-secret-0123456789";

/** Entries as Qwen 0.26's `qwen/providers/list` serves them (trimmed). */
const QWEN_MENU: QwenProvider[] = [
  {
    id: "deepseek", label: "DeepSeek API Key", description: "Quick setup for DeepSeek", protocol: "openai",
    baseUrl: "https://api.deepseek.com", defaultModelIds: ["deepseek-v4-pro"], uiGroup: "third-party",
    // Qwen's stored settings: never relayed, only that there are some.
    existingConfig: { protocol: "openai", baseUrl: "https://api.deepseek.com", hasApiKey: true, modelIds: ["deepseek-v4-pro"] },
  },
  {
    id: "coding-plan", label: "Coding Plan", description: "For individual developers", protocol: "openai",
    baseUrl: [
      { id: "aliyun", label: "China (Beijing)", url: "https://coding.dashscope.aliyuncs.com/v1", documentationUrl: "https://help.aliyun.com/" },
      { id: "alibabacloud", label: "Singapore (International)", url: "https://coding-intl.dashscope.aliyuncs.com/v1" },
    ],
    defaultModelIds: ["qwen3.6-plus"], uiGroup: "alibaba", uiLabels: { flowTitle: "Alibaba ModelStudio", baseUrlStepTitle: "Region" },
  },
  {
    id: "custom-openai-compatible", label: "Custom Provider", description: "Manually connect a local server, proxy, or unsupported provider",
    protocol: "openai", protocolOptions: ["openai", "anthropic", "gemini"], baseUrlPlaceholder: "https://api.openai.com/v1",
    defaultModelIds: [], uiGroup: "custom",
  },
];

test("Qwen Code's providers reach the web as a choice: endpoint, model and whether configured, never the stored settings", async () => {
  const { host, sent, events, facadeOptions } = harness({}, { providerAuth: { listProviders: async () => QWEN_MENU } });
  await host.listProviders("req-list", "qwen");
  const result = sent.find((message) => message.type === "machine:runtime_auth:providers:result") as { requestId: string; result: unknown };
  assert.deepEqual(result, {
    type: "machine:runtime_auth:providers:result",
    requestId: "req-list",
    result: {
      kind: "listed",
      providers: [
        { id: "deepseek", label: "DeepSeek API Key", description: "Quick setup for DeepSeek", group: { id: "third-party" }, configured: true, endpoint: { kind: "fixed" }, needsModelIds: false },
        {
          id: "coding-plan", label: "Coding Plan", description: "For individual developers", group: { id: "alibaba", label: "Alibaba ModelStudio" }, configured: false,
          endpoint: { kind: "choice", options: [
            { id: "aliyun", label: "China (Beijing)", url: "https://coding.dashscope.aliyuncs.com/v1" },
            { id: "alibabacloud", label: "Singapore (International)", url: "https://coding-intl.dashscope.aliyuncs.com/v1" },
          ] },
          needsModelIds: false,
        },
        {
          id: "custom-openai-compatible", label: "Custom Provider", description: "Manually connect a local server, proxy, or unsupported provider",
          group: { id: "custom" }, configured: false, endpoint: { kind: "custom", placeholder: "https://api.openai.com/v1" }, needsModelIds: true,
        },
      ],
    },
  });
  assert.ok(!JSON.stringify(sent).includes("hasApiKey"), "Qwen's stored settings stay on the Computer");
  assert.deepEqual(facadeOptions, [{ cwd: "/home/ada", timeoutMs: RUNTIME_AUTH_PROVIDER_TIMEOUT_MS }]);
  assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.providers.result")?.attrs, {
    runtime: "qwen", outcome: "listed", reason: undefined, error_kind: undefined, provider_count: 3, duration_ms: 0,
  });
});

test("a Qwen provider's key goes to OAR's connect in user scope and nowhere else; the status follows", async () => {
  let connected: QwenProviderConnectOptions | null = null;
  const { host, sent, events, facadeOptions } = harness({
    authStatus: async () => ({ kind: "unknown", source: "Qwen user/system credential configuration", configured: ["user settings: security.auth.apiKey (openai)"] }),
  }, { providerAuth: { connect: async (options) => { connected = options; return { success: true, providerId: options.providerId, providerLabel: "Coding Plan", authType: "openai" }; } } });
  const input = { providerId: "coding-plan", apiKey: API_KEY, baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1" };
  await host.reportStatus("ready", ["qwen"]);
  sent.length = 0;
  await host.connectProvider("req-connect", "qwen", input);
  assert.deepEqual(connected, { providerId: "coding-plan", apiKey: API_KEY, scope: "user", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1" });
  assert.deepEqual(facadeOptions, [{ cwd: "/home/ada", timeoutMs: RUNTIME_AUTH_PROVIDER_TIMEOUT_MS }]);
  assert.deepEqual(sent[0], { type: "machine:runtime_auth:connect_provider:result", requestId: "req-connect", result: { kind: "connected" } });
  const status = sent.find((message) => message.type === "machine:runtime_auth:status") as { report: { runtimes: { qwen?: unknown } } } | undefined;
  assert.deepEqual(status?.report.runtimes.qwen, { kind: "logged_in" }, "a fresh status follows: a provider is configured");
  assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.connect_provider.result")?.attrs, {
    runtime: "qwen", provider_id: "coding-plan", outcome: "connected", reason: undefined, error_kind: undefined, duration_ms: 0,
  });
  assert.ok(!JSON.stringify(sent).includes(API_KEY), "the key is in no message back");
  assert.ok(!JSON.stringify(events).includes(API_KEY), "nor in a trace");
  assert.ok(!JSON.stringify(events).includes("dashscope"), "nor the endpoint");
  assert.ok(!Object.values(host).some((value) => JSON.stringify(value ?? null)?.includes(API_KEY)), "the host keeps no reference to it");
});

test("a Qwen connect that fails says why by OAR's error kind, never by its text; a second one at once is busy", async () => {
  const cases: Array<[QwenProviderAuthError | Error, string, string]> = [
    [new QwenProviderAuthError("native", "qwen/providers/connect", -32602), "rejected", "native"],
    [new QwenProviderAuthError("timeout", "qwen/providers/connect"), "timed_out", "timeout"],
    [new QwenProviderAuthError("launch_failed", "qwen/providers/connect"), "process_failed", "launch_failed"],
    [new QwenProviderAuthError("process_exited", "qwen/providers/connect"), "process_failed", "process_exited"],
    [new QwenProviderAuthError("invalid_response", "qwen/providers/connect"), "invalid_response", "invalid_response"],
    [new Error(`unexpected: ${API_KEY}`), "process_failed", "other"],
  ];
  for (const [error, reason, errorKind] of cases) {
    const { host, sent, events } = harness({ authStatus: async () => ({ kind: "logged_out", source: "x" }) }, { providerAuth: { connect: async () => { throw error; } } });
    await host.connectProvider("req-fail", "qwen", { providerId: "deepseek", apiKey: API_KEY });
    const result = sent.find((message) => message.type === "machine:runtime_auth:connect_provider:result") as { result: unknown };
    assert.deepEqual(result.result, { kind: "failed", reason }, errorKind);
    assert.equal(events.find((event) => event.name === "daemon.runtime_auth.connect_provider.result")?.attrs.error_kind, errorKind);
    assert.ok(!JSON.stringify([sent, events]).includes(API_KEY), errorKind);
    // A connect that ran out of time may have saved: the status is read again; a refused one changed nothing.
    assert.equal(sent.some((message) => message.type === "machine:runtime_auth:status"), reason === "timed_out", errorKind);
  }

  let release: (() => void) | null = null;
  const { host, sent, settle } = harness({}, { providerAuth: { connect: () => new Promise((resolve) => { release = () => resolve({ success: true, providerId: "deepseek", providerLabel: "DeepSeek", authType: "openai" }); }) } });
  const first = host.connectProvider("req-first", "qwen", { providerId: "deepseek", apiKey: API_KEY });
  await settle();
  assert.ok(release, "the first connect is running in OAR");
  await host.connectProvider("req-second", "qwen", { providerId: "deepseek", apiKey: API_KEY });
  (release as () => void)();
  await first;
  const results = sent.filter((message) => message.type === "machine:runtime_auth:connect_provider:result") as Array<{ requestId: string; result: { kind: string } }>;
  assert.deepEqual(results.map((message) => [message.requestId, message.result.kind]), [["req-second", "busy"], ["req-first", "connected"]]);
});

test("Qwen Code is never run on Windows: status, providers and connect answer unsupported without starting anything", async () => {
  let started = false;
  const { host, sent, loads } = harness({ authStatus: async () => { started = true; return { kind: "logged_out", source: "x" }; } }, {
    platform: "win32",
    providerAuth: { listProviders: async () => { started = true; return []; }, connect: async () => { started = true; throw new Error("no"); } },
  });
  assert.deepEqual((await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["qwen"])).runtimes.qwen, { kind: "unavailable", reason: "unsupported_installation" });
  await host.listProviders("req-win-list", "qwen");
  await host.connectProvider("req-win-connect", "qwen", { providerId: "deepseek", apiKey: API_KEY });
  assert.deepEqual(sent.map((message) => "result" in message ? message.result : null), [
    { kind: "unsupported", reason: "unsupported_installation" },
    { kind: "unsupported", reason: "unsupported_installation" },
  ]);
  assert.equal(started, false);
  assert.deepEqual(loads, [], "neither OAR's qwen nor its provider facade was loaded");
});

test("Qwen Code without a provider facade, or not installed, answers unsupported", async () => {
  const none = harness({});
  await none.host.listProviders("req-none", "qwen");
  assert.deepEqual((none.sent[0] as { result: unknown }).result, { kind: "unsupported", reason: "unsupported_installation" });

  const sent: RuntimeAuthHostMessage[] = [];
  let started = false;
  const missing = new RuntimeAuthHost({
    loadRuntime: async () => ({ installation: async () => ({ kind: "not_found" }) }) as unknown as Runtime,
    kimiStatus: async () => ({ kind: "unknown" }),
    loadKimiAuth: async () => { throw new Error("no Kimi in this test"); },
    loadProviderAuth: async () => ({ create: async () => { started = true; throw new Error("must not start"); } }),
    send: (message) => sent.push(message),
    recordEvent: () => undefined,
    now: () => 0,
    serverReads: () => null,
    platform: "linux",
  });
  await missing.connectProvider("req-missing", "qwen", { providerId: "deepseek", apiKey: API_KEY });
  assert.equal(started, false);
  assert.deepEqual((sent[0] as { result: unknown }).result, { kind: "unsupported", reason: "not_installed" });
});

test("Qwen's status reads configured only for a provider key in Qwen's own settings; anything else is no claim", async () => {
  const unknown = (...configured: string[]) => ({ kind: "unknown", source: "s", configured, detail: "OAR's text, never read" }) as const;
  const statuses = [
    [unknown("user settings: security.auth.apiKey (openai)"), { kind: "logged_in" }],
    [unknown("system settings: security.auth.apiKey"), { kind: "logged_in" }],
    [unknown("user .env or settings.env: DEEPSEEK_API_KEY"), { kind: "logged_in" }],
    [unknown("environment: OPENAI_API_KEY", "user .env or settings.env: custom modelProviders envKey"), { kind: "logged_in" }],
    [unknown("environment: OPENAI_API_KEY"), { kind: "unknown" }],
    [unknown("legacy Qwen OAuth credential file exists; free tier discontinued 2026-04-15"), { kind: "unknown" }],
    [unknown("user settings: selectedType (qwen-oauth); cached or external credentials are not validated"), { kind: "unknown" }],
    [unknown("user settings: security.auth.apiKey (qwen-oauth)", "user settings: selectedType (qwen-oauth); cached or external credentials are not validated"), { kind: "unknown" }],
    [unknown("user settings: security.auth.apiKey (vertex-ai)", "user settings: selectedType (vertex-ai); cached or external credentials are not validated"), { kind: "unknown" }],
    [unknown("GOOGLE_APPLICATION_CREDENTIALS file not found; contents and validity were not read"), { kind: "unknown" }],
    [unknown("user settings: external authentication configured"), { kind: "unknown" }],
    [{ kind: "logged_out", source: "s", detail: "No user/system provider credential found." }, { kind: "logged_out" }],
    [{ kind: "unknown", source: "s", detail: "Qwen local credential inspection timed out" }, { kind: "unknown" }],
    // Only the labels count, never OAR's detail text.
    [{ kind: "unknown", source: "s", detail: "Configured sources: user settings: security.auth.apiKey (openai). No credential was validated." }, { kind: "unknown" }],
    [{ kind: "unknown", source: "s" }, { kind: "unknown" }],
  ] as const;
  for (const [oar, web] of statuses) {
    const { host } = harness({ authStatus: async () => oar });
    assert.deepEqual((await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["qwen"])).runtimes.qwen, web, JSON.stringify(oar));
  }
});

/** OAR's real Qwen status on a home made for the test; the daemon's own environment counts for nothing. */
async function realQwenStatus(setUp: (home: string) => Promise<Record<string, string>>) {
  const home = await mkdtemp(path.join(tmpdir(), "raft-qwen-status-"));
  try {
    await mkdir(path.join(home, ".qwen"), { recursive: true });
    const env = {
      HOME: home,
      USERPROFILE: home,
      QWEN_HOME: path.join(home, ".qwen"),
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, "system-settings.json"),
      ...await setUp(home),
    };
    const { host } = harness({ authStatus: (installed, options) => qwenRuntime.authStatus(installed, { ...options, env }) });
    const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["qwen"]);
    assert.ok(!JSON.stringify(report).includes(API_KEY));
    return report.runtimes.qwen;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
const writeSettings = (home: string, value: unknown) => writeFile(path.join(home, ".qwen", "settings.json"), JSON.stringify(value));

// The OAR upgrade checks run providerKeyStatus on OAR's actual check for the
// main case of each rule: if OAR renames those `configured` labels, these fail
// instead of every Qwen card silently changing. The remaining labels (other
// settings layers and protocols, Vertex ADC, QWEN_OAUTH) are covered by the
// table test above only, with labels copied from OAR.
test("OAR upgrade check: OAR's real Qwen status names a provider key in Qwen's settings the way the daemon reads it", async () => {
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeSettings(home, { security: { auth: { selectedType: "openai", apiKey: API_KEY } } });
    return {};
  }), { kind: "logged_in" }, "security.auth.apiKey");
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeSettings(home, { security: { auth: { selectedType: "anthropic", apiKey: API_KEY } } });
    return {};
  }), { kind: "logged_in" }, "security.auth.apiKey with the anthropic protocol");
  assert.deepEqual(await realQwenStatus(async (home) => {
    // realQwenStatus points QWEN_CODE_SYSTEM_SETTINGS_PATH here.
    await writeFile(path.join(home, "system-settings.json"), JSON.stringify({ security: { auth: { apiKey: API_KEY } } }));
    return {};
  }), { kind: "logged_in" }, "a plain security.auth.apiKey in the system settings");
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeSettings(home, { env: { DEEPSEEK_API_KEY: API_KEY } });
    return {};
  }), { kind: "logged_in" }, "a key in settings.env, as Qwen's provider connect writes it");
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeFile(path.join(home, ".qwen", ".env"), `DEEPSEEK_API_KEY=${API_KEY}\n`);
    return {};
  }), { kind: "logged_in" }, "a key in a .env file Qwen reads");
});

test("OAR upgrade check: OAR's real Qwen status for sources that are no provider key reads as no claim", async () => {
  const noClaim = { kind: "unknown" };
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeFile(path.join(home, ".qwen", "oauth_creds.json"), "{}");
    return {};
  }), noClaim, "the legacy Qwen OAuth file");
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeSettings(home, { security: { auth: { selectedType: "qwen-oauth" } } });
    return {};
  }), noClaim, "selectedType qwen-oauth");
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeSettings(home, { security: { auth: { selectedType: "qwen-oauth", apiKey: API_KEY } } });
    return {};
  }), noClaim, "a key Qwen does not use while its OAuth is selected");
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeSettings(home, { security: { auth: { selectedType: "vertex-ai", apiKey: API_KEY } } });
    return {};
  }), noClaim, "a key Qwen does not use while Vertex is selected");
  assert.deepEqual(await realQwenStatus(async (home) => {
    await writeSettings(home, { security: { auth: { useExternal: true } } });
    return {};
  }), noClaim, "external authentication");
  assert.deepEqual(await realQwenStatus(async (home) => ({ GOOGLE_APPLICATION_CREDENTIALS: path.join(home, "missing.json") })), noClaim, "a credentials file that is not there");
  assert.deepEqual(await realQwenStatus(async () => ({ OPENAI_API_KEY: API_KEY })), noClaim, "a key in the daemon's own environment");
});

test("a Qwen provider operation's bound fits the server's provider relay", () => {
  // After OAR's installation check (`qwen --version`, normally well under a
  // second) the operation runs with this bound; about 10s stay for the check.
  assert.ok(RUNTIME_AUTH_PROVIDER_TIMEOUT_MS + 10_000 <= RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS);
});

// #proj-raft-computer:#46 stop-gap: the agent hosts hear about a credentials
// change only once it succeeded; a failed, cancelled or busy one changed nothing.
test("the agent hosts are told once after a login, logout or provider connect that succeeded, never after one that did not", async () => {
  const outcomes: Array<{ login: "logged_in" | "failed" | "cancelled" }> = [{ login: "logged_in" }, { login: "failed" }, { login: "cancelled" }];
  for (const { login } of outcomes) {
    const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
    const { host, sent, settle } = harness({
      authStatus: async () => ({ kind: "logged_in", source: "x" }),
      login: async () => (login === "failed" ? { kind: "failed", reason: "interaction_failed" } : login === "cancelled" ? { kind: "cancelled" } : { kind: "logged_in" }),
    }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });
    host.startLogin(loginId(`codex-${login}`), "codex");
    await settle();
    assert.ok(sent.some((message) => message.type === "machine:runtime_auth:login:result"), login);
    assert.deepEqual(changes, login === "logged_in" ? [["codex", "login"]] : [], login);
  }

  for (const logout of [{ kind: "logged_out" as const }, { kind: "failed" as const, reason: "still_logged_in" as const }]) {
    const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
    const { host } = harness({
      authStatus: async () => ({ kind: "logged_out", source: "x" }),
      logout: async () => logout,
    }, { onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]) });
    await host.logout("req-logout", "claude");
    assert.deepEqual(changes, logout.kind === "logged_out" ? [["claude", "logout"]] : [], logout.kind);
  }

  for (const connect of ["saved", "timed_out"] as const) {
    const changes: Array<[RuntimeAuthRuntime, RuntimeAuthCredentialsChange]> = [];
    const { host } = harness({ authStatus: async () => ({ kind: "logged_out", source: "x" }) }, {
      providerAuth: {
        connect: async (options) => {
          if (connect === "timed_out") throw new QwenProviderAuthError("timeout", "qwen/providers/connect");
          return { success: true, providerId: options.providerId, providerLabel: "DeepSeek", authType: "openai" };
        },
      },
      onCredentialsChanged: (runtime, reason) => changes.push([runtime, reason]),
    });
    await host.connectProvider("req-connect", "qwen", { providerId: "deepseek", apiKey: API_KEY });
    assert.deepEqual(changes, connect === "saved" ? [["qwen", "connect_provider"]] : [], connect);
  }
});

test("a credentials listener that throws does not change the login result already sent", async () => {
  const { host, sent, events, settle } = harness({
    authStatus: async () => ({ kind: "logged_in", source: "x" }),
    login: async () => ({ kind: "logged_in" }),
  }, { onCredentialsChanged: () => { throw new Error("listener broke"); } });
  host.startLogin(loginId("throws"), "codex");
  await settle();
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: { kind: string } } | undefined;
  assert.equal(result?.result.kind, "logged_in");
  assert.deepEqual(events.find((event) => event.name === "daemon.runtime_auth.credentials_changed.listener_failed")?.attrs, { runtime: "codex", reason: "login" });
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"), "the status report still follows");
});

// ---------------------------------------------------------------- Pi (per-provider sign-ins)

const PI_KEY = "sk-or-v1-0123456789abcdef";

test("Pi's status names each stored sign-in from a read that resolves nothing, and says signed out with none", async () => {
  const reads: unknown[] = [];
  const stored: ProviderAuthStatus[] = [
    { providerId: "anthropic", configured: true, method: "oauth", subscription: true },
    { providerId: "deepseek", configured: true, method: "api_key", subscription: false },
    { providerId: "custom-local", configured: true, method: "api_key" },
  ];
  const { host } = harness({}, { piAuth: { listProviders: async (options) => { reads.push(options); return stored; } } });
  const report = await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["pi"]);
  assert.deepEqual(report.runtimes.pi, {
    kind: "logged_in",
    providers: [
      { id: "anthropic", label: "Anthropic", method: "oauth", subscription: true },
      { id: "deepseek", label: "DeepSeek", method: "api_key" },
      // A provider from Pi's models.json, not in its /login list: named by its id.
      { id: "custom-local", label: "custom-local", method: "api_key" },
    ],
  });
  assert.deepEqual(reads, [{ resolve: false }], "no OAuth refresh and no key command on a status read");

  const none = harness({}, { piAuth: { listProviders: async () => [] } });
  assert.deepEqual((await none.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["pi"])).runtimes.pi, { kind: "logged_out" });
  const unwired = harness({});
  assert.deepEqual((await unwired.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["pi"])).runtimes.pi, { kind: "unknown" });
  const windows = harness({}, { platform: "win32", piAuth: { listProviders: async () => [] } });
  assert.deepEqual((await windows.host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["pi"])).runtimes.pi, { kind: "logged_out" }, "Pi is in-process: read on Windows too");
});

test("Pi's provider list is pi's own /login list, with how each signs in from the web and what is stored", async () => {
  const { host, sent } = harness({}, { piAuth: { listProviders: async () => [{ providerId: "anthropic", configured: true, method: "oauth", subscription: true }] } });
  await host.listProviders("req-pi-list", "pi");
  const result = sent.find((message) => message.type === "machine:runtime_auth:providers:result") as { result: { kind: string; providers: unknown[] } };
  const fixed = { endpoint: { kind: "fixed" }, needsModelIds: false } as const;
  assert.deepEqual(result.result, {
    kind: "listed",
    providers: [
      { id: "amazon-bedrock", label: "Amazon Bedrock", configured: false, ...fixed, signIn: { apiKey: { label: "AWS credentials or bearer token", entry: "more_fields" } } },
      {
        id: "anthropic", label: "Anthropic", configured: true, ...fixed,
        signIn: { oauth: { label: "Anthropic (Claude Pro/Max)", subscription: true, flow: "paste_code" }, apiKey: { label: "Anthropic API key", entry: "key" }, stored: "oauth" },
      },
      { id: "deepseek", label: "DeepSeek", configured: false, ...fixed, signIn: { apiKey: { label: "DeepSeek API key", entry: "key" } } },
      // A flow Raft does not know how to run without a browser on the Computer: listed, never started.
      { id: "future-sso", label: "Future SSO", configured: false, ...fixed, signIn: { oauth: { label: "Future SSO", subscription: false, flow: "computer_only" } } },
      {
        id: "github-copilot", label: "GitHub Copilot", configured: false, ...fixed,
        signIn: { oauth: { label: "GitHub Copilot", subscription: true, flow: "device_code" }, apiKey: { label: "GitHub Copilot token", entry: "key" } },
      },
      {
        id: "openrouter", label: "OpenRouter", configured: false, ...fixed,
        signIn: { oauth: { label: "OpenRouter OAuth", subscription: false, flow: "paste_address" }, apiKey: { label: "OpenRouter API key", entry: "key" } },
      },
    ],
  });
});

test("Anthropic signs in from the web in its copy-code mode: the daemon picks it, relays the link, and the pasted code goes to pi only", async () => {
  const answers: string[] = [];
  let loginOptions: unknown = null;
  const { host, sent, events, settle, rescans } = harness({}, {
    piAuth: {
      login: async (providerId, method, interaction: ProviderLoginInteraction, options) => {
        assert.equal(providerId, "anthropic");
        assert.equal(method, "oauth");
        loginOptions = options;
        answers.push(await interaction.prompt({ kind: "select", message: "Select Anthropic login method:", options: [{ id: "browser", label: "Browser login (default)" }, { id: "copy_code", label: "Copy code login (headless)" }] }));
        interaction.onEvent({ kind: "auth_url", url: "https://claude.ai/oauth/authorize?code=true", instructions: "Open this URL" });
        answers.push(await interaction.prompt({ kind: "manual_code", message: "Paste the authorization code:" }));
        return { providerId, configured: true, method: "oauth", subscription: true };
      },
    },
  });
  host.startLogin(loginId("pi-anthropic"), "pi", undefined, "anthropic");
  await settle();
  host.submitCode(loginId("pi-anthropic"), PASTED_CODE);
  await settle();
  assert.deepEqual(answers, ["copy_code", PASTED_CODE]);
  assert.equal(typeof (loginOptions as { getDeviceId?: unknown })?.getDeviceId, "function", "pi's device id is there for the flow that needs it");
  assert.deepEqual(sent.filter((message) => message.type.startsWith("machine:runtime_auth:login")).map((message) => ("event" in message ? message.event.kind : "result" in message ? message.result.kind : null)), [
    "auth_url", "code_prompt", "logged_in",
  ]);
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"), "a fresh status follows");
  assert.deepEqual(rescans, ["pi"], "and Pi's models are detected again");
  assert.equal(events.find((event) => event.name === "daemon.runtime_auth.login.result")?.attrs.provider_id, "anthropic");
  assert.ok(!JSON.stringify([sent, events]).includes(PASTED_CODE), "the code is in no message back and no trace");
});

test("GitHub Copilot signs in by device code for github.com; any other question ends a Pi login as interaction_failed", async () => {
  const { host, sent, settle } = harness({}, {
    piAuth: {
      login: async (providerId, _method, interaction: ProviderLoginInteraction) => {
        assert.equal(await interaction.prompt({ kind: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" }), "");
        interaction.onEvent({ kind: "device_code", userCode: "8F3C-21KD", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 });
        await interaction.prompt({ kind: "text", message: "Anything else?" });
        return { providerId, configured: true };
      },
    },
  });
  host.startLogin(loginId("pi-copilot"), "pi", undefined, "github-copilot");
  await settle();
  const login = sent.filter((message) => message.type.startsWith("machine:runtime_auth:login"));
  assert.deepEqual(login.map((message) => ("event" in message ? message.event : "result" in message ? message.result : null)), [
    { kind: "device_code", userCode: "8F3C-21KD", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 },
    { kind: "failed", reason: "interaction_failed" },
  ]);
});

test("a Pi provider with no flow Raft can run from here, or none at all, is never started", async () => {
  let started = false;
  const { host, sent, settle, rescans } = harness({}, { piAuth: { login: async () => { started = true; return { providerId: "x", configured: true }; } } });
  host.startLogin(loginId("pi-future"), "pi", undefined, "future-sso");
  await settle();
  host.startLogin(loginId("pi-deepseek"), "pi", undefined, "deepseek");
  await settle();
  assert.equal(started, false);
  const results = sent.filter((message) => message.type === "machine:runtime_auth:login:result").map((message) => ("result" in message ? message.result : null));
  assert.deepEqual(results, [{ kind: "unsupported", reason: "unsupported_installation" }, { kind: "unsupported", reason: "unsupported_installation" }]);
  assert.deepEqual(rescans, []);
});

test("a Pi key is saved through setApiKey only when pi would keep it literal and the provider takes one key", async () => {
  const saved: Array<[string, string]> = [];
  const { host, sent, events, rescans } = harness({}, { piAuth: { setApiKey: async (providerId, apiKey) => { saved.push([providerId, apiKey]); } } });
  for (const [requestId, input] of [
    ["req-bang", { providerId: "openrouter", apiKey: "!op read op://vault/openrouter" }],
    ["req-env", { providerId: "openrouter", apiKey: "$OPENROUTER_API_KEY" }],
    ["req-wide", { providerId: "openrouter", apiKey: "sk-\u2028x" }],
    ["req-more", { providerId: "amazon-bedrock", apiKey: PI_KEY }],
    ["req-unknown", { providerId: "nope", apiKey: PI_KEY }],
    ["req-url", { providerId: "openrouter", apiKey: PI_KEY, baseUrl: "https://example.com" }],
  ] as const) {
    await host.connectProvider(requestId, "pi", input);
  }
  assert.deepEqual(saved, [], "nothing reached pi");
  await host.connectProvider("req-ok", "pi", { providerId: "openrouter", apiKey: PI_KEY });
  assert.deepEqual(saved, [["openrouter", PI_KEY]]);
  const results = sent.filter((message) => message.type === "machine:runtime_auth:connect_provider:result") as Array<{ requestId: string; result: { kind: string } }>;
  assert.deepEqual(results.map((message) => [message.requestId, message.result.kind]), [
    ["req-bang", "failed"], ["req-env", "failed"], ["req-wide", "failed"], ["req-more", "failed"], ["req-unknown", "failed"], ["req-url", "failed"], ["req-ok", "connected"],
  ]);
  assert.deepEqual(rescans, ["pi"], "the model list follows the saved key");
  assert.ok(!JSON.stringify([sent, events]).includes(PI_KEY), "the key is in no message back and no trace");
  assert.ok(!JSON.stringify([sent, events]).includes("op://"), "nor a refused one");
});

test("Pi's sign-out clears that provider only, then the status and the models follow", async () => {
  const cleared: string[] = [];
  const { host, sent, rescans } = harness({}, { piAuth: { logout: async (providerId) => { cleared.push(providerId); } } });
  await host.logout("req-pi-out", "pi", "anthropic");
  assert.deepEqual(cleared, ["anthropic"]);
  assert.deepEqual(sent[0], { type: "machine:runtime_auth:logout:result", requestId: "req-pi-out", result: { kind: "logged_out" } });
  assert.ok(sent.some((message) => message.type === "machine:runtime_auth:status"));
  assert.deepEqual(rescans, ["pi"]);
});

test("OAR upgrade: every OAuth flow pi lists is one the daemon knows how to run from the web, and the multi-field key providers are pi's", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raft-pi-sign-in-"));
  try {
    const auth = await createPiProviderAuth({ authPath: path.join(dir, "auth.json"), modelsPath: null });
    const providers = auth.loginProviders();
    const oauth = providers.filter((provider) => provider.methods.some((method) => method.method === "oauth")).map((provider) => provider.providerId).sort();
    assert.deepEqual(oauth, Object.keys(PI_OAUTH_FLOWS).sort(), "a new pi OAuth flow needs its web flow decided in piProviderSignIn.ts");
    const askingMore: string[] = [];
    for (const provider of providers) {
      if (!provider.methods.some((method) => method.method === "api_key" && !("ambient" in method && method.ambient))) continue;
      try {
        await auth.setApiKey(provider.providerId, "raft-test-not-a-key");
        await auth.logout(provider.providerId);
      } catch {
        askingMore.push(provider.providerId);
      }
    }
    assert.deepEqual(askingMore.sort(), [...PI_KEY_PROVIDERS_ASKING_MORE].sort());
    assert.deepEqual(await auth.listProviders({ resolve: false }), [], "nothing left behind");

    // Anthropic's copy-code mode is still the option the daemon picks, and runs with no local server.
    const controller = new AbortController();
    const seen: string[] = [];
    await auth.login("anthropic", "oauth", {
      signal: controller.signal,
      onEvent: (event) => { seen.push(event.kind); },
      prompt: async (prompt) => {
        seen.push(prompt.kind === "select" ? `select:${prompt.options.map((option) => option.id).join("|")}` : prompt.kind);
        if (prompt.kind === "select") return PI_OAUTH_FLOWS.anthropic!.select!;
        controller.abort();
        throw new Error("stop before any sign-in");
      },
    }).catch(() => undefined);
    assert.deepEqual(seen, ["select:browser|copy_code", "auth_url", "manual_code"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi's status keeps every provider when one name is odd: control characters are dropped, and an empty name falls back to the id", async () => {
  const stored: ProviderAuthStatus[] = [
    { providerId: "anthropic", configured: true, method: "oauth", subscription: true },
    { providerId: "custom-bell", configured: true, method: "api_key" },
    { providerId: "custom-blank", configured: true, method: "api_key" },
  ];
  const providers: LoginProvider[] = [
    ...PI_PROVIDERS,
    { providerId: "custom-bell", name: "Local\u0007 LLM\n", methods: [{ method: "api_key", name: "Key" }] },
    { providerId: "custom-blank", name: "\u0000\u001b", methods: [{ method: "api_key", name: "Key" }] },
  ];
  const { host } = harness({}, { piAuth: { loginProviders: () => providers, listProviders: async () => stored } });
  assert.deepEqual((await host.collectStatus(RUNTIME_AUTH_RUNTIMES, ["pi"])).runtimes.pi, {
    kind: "logged_in",
    providers: [
      { id: "anthropic", label: "Anthropic", method: "oauth", subscription: true },
      { id: "custom-bell", label: "Local LLM", method: "api_key" },
      { id: "custom-blank", label: "custom-blank", method: "api_key" },
    ],
  });
});

test("OpenRouter's paste step: the landing page's address goes to pi's prompt, and the link is relayed first", async () => {
  const LANDING = "http://localhost:3000/callback?code=7Hq2abc&state=9b1e";
  let answered: string | null = null;
  const { host, sent, events, settle } = harness({}, {
    piAuth: {
      login: async (providerId, _method, interaction: ProviderLoginInteraction) => {
        interaction.onEvent({ kind: "auth_url", url: "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000", instructions: "Paste the final redirect URL" });
        answered = await interaction.prompt({ kind: "manual_code", message: "Paste the redirect URL:", signal: new AbortController().signal });
        return { providerId, configured: true, method: "oauth" };
      },
    },
  });
  host.startLogin(loginId("pi-openrouter"), "pi", undefined, "openrouter");
  await settle();
  host.submitCode(loginId("pi-openrouter"), LANDING);
  await settle();
  assert.equal(answered, LANDING);
  const login = sent.filter((message) => message.type.startsWith("machine:runtime_auth:login"));
  assert.deepEqual(login.map((message) => ("event" in message ? message.event.kind : "result" in message ? message.result.kind : null)), ["auth_url", "code_prompt", "logged_in"]);
  assert.ok(!JSON.stringify([sent, events]).includes("7Hq2abc"), "the pasted address is in no message back and no trace");
});

test("when pi's localhost callback wins, its paste prompt closes: a late paste is dropped, and the login still signs in", async () => {
  const callbackWon = new AbortController();
  let promptClosed = false;
  const { host, sent, events, settle } = harness({}, {
    piAuth: {
      // pi lists OpenAI's "Sign in with ChatGPT"; the shared fixture leaves it out.
      loginProviders: () => [...PI_PROVIDERS, { providerId: "openai", name: "OpenAI", methods: [{ method: "oauth", name: "OpenAI (ChatGPT subscription)", subscription: true, loginLabel: "Sign in with ChatGPT" }] }],
      login: async (providerId, _method, interaction: ProviderLoginInteraction) => {
        interaction.onEvent({ kind: "auth_url", url: "https://auth.openai.com/oauth/authorize?x=1" });
        const manual = interaction.prompt({ kind: "manual_code", message: "Paste the final redirect URL here:", signal: callbackWon.signal })
          .catch(() => { promptClosed = true; return null; });
        // The browser reached 127.0.0.1:1455 on the Computer itself: pi closes its prompt.
        callbackWon.abort();
        await manual;
        return { providerId, configured: true, method: "oauth", subscription: true };
      },
    },
  });
  host.startLogin(loginId("pi-chatgpt"), "pi", undefined, "openai");
  await settle();
  assert.equal(promptClosed, true, "the prompt the web was answering is closed");
  host.submitCode(loginId("pi-chatgpt"), "http://127.0.0.1:1455/auth/callback?code=late");
  await settle();
  const result = sent.find((message) => message.type === "machine:runtime_auth:login:result") as { result: { kind: string } } | undefined;
  assert.equal(result?.result.kind, "logged_in");
  assert.ok(events.some((event) => event.name === "daemon.runtime_auth.login.code_dropped"), "the late paste reached no prompt");
});
