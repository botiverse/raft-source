import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import type { InstallPlan, InstallResult, Runtime } from "@botiverse/oar";
import type { RuntimeInstallPlan, RuntimeInstallResult } from "@botiverse/raft-shared";

import { RuntimeAuthHost } from "./runtimeAuth/runtimeAuthHost";
import { dshRuntime } from "@botiverse/oar/runtimes/dsh";
import { installResultForServer, RuntimeInstallHost, runtimeInstallable } from "./runtimeInstall";

// Install on the web (docs/contracts/runtime-auth.md §6e): the plan's display
// strings go to the person who asked and nowhere else, the installer's output
// never leaves the Computer, a rescan follows an install, one install per
// runtime at a time, and nothing is offered or run for Kimi Code or Pi.

const SECRET_OUTPUT = "installing to /home/someone/.local/bin with token=abc123";
const HOME_STEP = "curl -fsSL https://claude.ai/install.sh | bash   # installs to /home/someone/.local/bin";

type Sent =
  | { type: "machine:runtime:install_plan:result"; requestId: string; result: RuntimeInstallPlan }
  | { type: "machine:runtime:install:result"; requestId: string; result: RuntimeInstallResult };

function host(runtime: Partial<Runtime> | (() => Promise<Runtime>), options: { runsHere?: (id: string) => boolean } = {}) {
  const sent: Sent[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const loads: string[] = [];
  let rescans = 0;
  const installHost = new RuntimeInstallHost({
    loadRuntime: async (id) => {
      loads.push(id);
      return typeof runtime === "function" ? runtime() : runtime as Runtime;
    },
    send: (message) => sent.push(message),
    rescan: () => { rescans += 1; },
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: () => 1_000,
    ...(options.runsHere ? { runsHere: options.runsHere } : {}),
  });
  return { installHost, sent, events, loads, rescans: () => rescans };
}

const notFound = async () => ({ kind: "not_found" as const });
const executable = { kind: "available" as const, via: "executable" as const, command: "/home/someone/.local/bin/claude", version: "2.1.0" };
const PLAN: InstallPlan = {
  kind: "plan",
  steps: [{ command: ["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"], display: HOME_STEP }],
  source: "https://docs.anthropic.com/en/docs/claude-code/setup",
  network: true,
  privileges: false,
};

test("the plan passes OAR's display strings and source to the person, and traces only its kind and step count", async () => {
  const t = host({ installation: notFound, installPlan: async () => PLAN, install: async () => assert.fail("a plan runs nothing") });
  await t.installHost.plan("p1", "claude");
  assert.deepEqual(t.sent, [{
    type: "machine:runtime:install_plan:result",
    requestId: "p1",
    result: { kind: "plan", steps: [HOME_STEP], source: "https://docs.anthropic.com/en/docs/claude-code/setup" },
  }]);
  assert.equal(t.events[0]!.name, "daemon.runtime.install.plan");
  assert.equal(t.events[0]!.attrs.step_count, 1);
  assert.ok(!JSON.stringify(t.events).includes("/home/someone"), "a step is never traced");
  assert.ok(!JSON.stringify(t.sent).includes("bash\",\"-c"), "the argv is not sent, only the display string");
});

test("an unsupported plan carries OAR's reason, detail and manual steps; a refused one carries none", async () => {
  const privileges = host({
    installation: notFound,
    install: async () => assert.fail("never run"),
    installPlan: async () => ({ kind: "unsupported", reason: "requires_privileges", detail: "The installer writes to /usr/local.", steps: PLAN.steps, source: PLAN.source }),
  });
  await privileges.installHost.plan("p2", "qoder");
  assert.deepEqual(privileges.sent[0]!.result, {
    kind: "unsupported",
    reason: "requires_privileges",
    detail: "The installer writes to /usr/local.",
    steps: [HOME_STEP],
    source: PLAN.source,
  });

  // Lines, none of them the one Raft installs: no line is passed, OAR answers `line_required`.
  const given: unknown[] = [];
  const lines = host({ installation: notFound, installLines: [{ line: "v3", description: "OpenCode 3" }], install: async () => assert.fail("never run"), installPlan: async (options) => { given.push(options); return { kind: "unsupported", reason: "line_required" }; } });
  await lines.installHost.plan("p3", "opencode");
  assert.deepEqual(lines.sent[0]!.result, { kind: "unsupported", reason: "line_required" }, "Raft never picks another line");
  assert.deepEqual(given, [undefined]);
});

test("OpenCode is planned and installed on its 2.x line; an OpenCode 1.x already there stays", async () => {
  const LINES = [{ line: "v1", description: "OpenCode 1" }, { line: "v2", description: "OpenCode 2" }];
  const plans: unknown[] = [];
  const installs: unknown[] = [];
  const t = host({
    installation: notFound,
    installLines: LINES,
    installPlan: async (options) => { plans.push(options); return PLAN; },
    install: async (options) => { installs.push(options); return { kind: "already_installed", installation: { ...executable, version: "1.19.6" }, line: "v1" }; },
  });
  await t.installHost.plan("p", "opencode");
  await t.installHost.install("i", "opencode");
  assert.deepEqual(plans, [{ line: "v2" }]);
  assert.deepEqual(installs, [{ timeoutMs: 10 * 60_000, line: "v2" }]);
  assert.deepEqual(t.sent[1]!.result, { kind: "already_installed", version: "1.19.6" }, "OAR replaced nothing");
});

test("OpenCode 2.x's printed version (`opencode v2.0.27`) is answered as its release version", () => {
  assert.deepEqual(
    installResultForServer({ kind: "installed", installation: { ...executable, version: "opencode v2.0.27" }, output: "", line: "v2" }),
    { kind: "installed", version: "2.0.27" },
  );
});

test("a plan the shared schema refuses (a source that is not https) is an internal error, with nothing of it sent", async () => {
  const t = host({ installation: notFound, install: async () => assert.fail("never run"), installPlan: async () => ({ ...PLAN, source: "javascript:alert(1)" }) as InstallPlan });
  await t.installHost.plan("p4", "claude");
  assert.deepEqual(t.sent[0]!.result, { kind: "error", code: "internal" });
});

test("an install answers its kind and version only, rescans, and traces the output's length, never the output", async () => {
  const t = host({ installation: notFound, installPlan: async () => PLAN, install: async () => ({ kind: "installed", installation: executable, output: SECRET_OUTPUT }) });
  await t.installHost.install("i1", "claude");
  assert.deepEqual(t.sent, [{ type: "machine:runtime:install:result", requestId: "i1", result: { kind: "installed", version: "2.1.0" } }]);
  assert.equal(t.rescans(), 1);
  assert.equal(t.events[0]!.name, "daemon.runtime.install");
  assert.equal(t.events[0]!.attrs.output_length, SECRET_OUTPUT.length);
  const wire = JSON.stringify([t.sent, t.events]);
  assert.ok(!wire.includes("token=abc123"));
  assert.ok(!wire.includes("/home/someone"), "neither the output nor the installation's command path");
});

test("each OAR outcome maps without output or detail; already_installed rescans too, failed and unsupported do not", async () => {
  const cases: Array<[InstallResult, RuntimeInstallResult, number]> = [
    [{ kind: "already_installed", installation: executable }, { kind: "already_installed", version: "2.1.0" }, 1],
    [{ kind: "installed", installation: { kind: "available", via: "bundled" }, output: "" }, { kind: "installed" }, 1],
    [{ kind: "failed", exitCode: 1, output: SECRET_OUTPUT }, { kind: "failed", exitCode: 1 }, 0],
    [{ kind: "failed", exitCode: null, output: SECRET_OUTPUT }, { kind: "failed", exitCode: null }, 0],
    [{ kind: "unsupported", reason: "missing_tool", detail: "npm is not on PATH at /home/someone", steps: PLAN.steps, source: PLAN.source }, { kind: "unsupported", reason: "missing_tool" }, 0],
  ];
  for (const [outcome, expected, rescans] of cases) {
    const t = host({ installation: notFound, installPlan: async () => PLAN, install: async () => outcome });
    await t.installHost.install("i", "qwen");
    assert.deepEqual(t.sent[0]!.result, expected, outcome.kind);
    assert.equal(t.rescans(), rescans, outcome.kind);
    assert.ok(!JSON.stringify(t.sent).includes("/home/someone"), outcome.kind);
  }
});

test("the installer gets the 10 min bound and, for a runtime without release lines, no line", async () => {
  const given: unknown[] = [];
  const t = host({ installation: notFound, installPlan: async () => PLAN, install: async (options) => { given.push(options); return { kind: "already_installed", installation: executable }; } });
  await t.installHost.install("i", "claude");
  assert.deepEqual(given, [{ timeoutMs: 10 * 60_000 }]);
});

test("Kimi Code and Pi answer unsupported without loading anything; so does a runtime with no installer or not run on this platform", async () => {
  for (const runtime of ["kimi", "pi"] as const) {
    const t = host(async () => assert.fail("nothing to load"));
    await t.installHost.plan("p", runtime);
    await t.installHost.install("i", runtime);
    assert.deepEqual(t.sent.map((message) => message.result), [{ kind: "unsupported", reason: "bundled" }, { kind: "unsupported", reason: "bundled" }], runtime);
    assert.equal(t.rescans(), 0);
  }

  const noInstaller = host({ installation: notFound });
  await noInstaller.installHost.install("i", "codex");
  assert.deepEqual(noInstaller.sent[0]!.result, { kind: "unsupported", reason: "bundled" });

  const windows = host(async () => assert.fail("nothing to load"), { runsHere: (id) => id !== "qwen" });
  await windows.installHost.install("i", "qwen");
  assert.deepEqual(windows.sent[0]!.result, { kind: "unsupported", reason: "platform" });
});

test("a throw is an internal error with nothing of it sent, and releases the per-runtime guard", async () => {
  let calls = 0;
  const t = host(async () => {
    calls += 1;
    if (calls === 1) throw new Error("load failed at /secret/path");
    return { installation: notFound, installPlan: async () => PLAN, install: async () => ({ kind: "installed", installation: executable, output: "" }) } as unknown as Runtime;
  });
  await t.installHost.install("first", "claude");
  await t.installHost.install("second", "claude");
  assert.deepEqual(t.sent.map((message) => message.result), [{ kind: "error", code: "internal" }, { kind: "installed", version: "2.1.0" }]);
  assert.ok(!JSON.stringify([t.sent, t.events]).includes("/secret/path"));
});

test("one install per runtime at a time: a second request while one runs answers in_progress", async () => {
  let finish!: (result: InstallResult) => void;
  const t = host({ installation: notFound, installPlan: async () => PLAN, install: () => new Promise<InstallResult>((resolve) => { finish = resolve; }) });
  const first = t.installHost.install("first", "claude");
  await new Promise((resolve) => setImmediate(resolve));
  await t.installHost.install("second", "claude");
  assert.deepEqual(t.sent, [{ type: "machine:runtime:install:result", requestId: "second", result: { kind: "error", code: "in_progress" } }]);
  finish({ kind: "installed", installation: executable, output: SECRET_OUTPUT });
  await first;
  assert.deepEqual(t.sent[1]!.result, { kind: "installed", version: "2.1.0" });
  assert.equal(t.rescans(), 1, "only the install that ran rescans");
});

test("a version that is not a plain release version is left out", () => {
  assert.deepEqual(
    installResultForServer({ kind: "installed", installation: { ...executable, version: "/home/someone/bin/claude 2.1" }, output: "" }),
    { kind: "installed" },
  );
});

test("installable: an installer, a planner and a probe, and no release lines or the one Raft installs; never Kimi Code or Pi", () => {
  const full = { installation: notFound, installPlan: async () => PLAN, install: async () => assert.fail("never run") };
  assert.equal(runtimeInstallable("claude", full), true);
  assert.equal(runtimeInstallable("kimi", full), false);
  assert.equal(runtimeInstallable("pi", full), false);
  assert.equal(runtimeInstallable("codex", { installation: notFound }), false);
  assert.equal(runtimeInstallable("opencode", { ...full, installLines: [{ line: "v1", description: "OpenCode 1" }, { line: "v2", description: "OpenCode 2" }] }), true);
  assert.equal(runtimeInstallable("opencode", { ...full, installLines: [{ line: "v3", description: "OpenCode 3" }] }), false, "not the line Raft installs");
  assert.equal(runtimeInstallable("grok", { ...full, installLines: [{ line: "v2", description: "two" }] }), false, "lines, none chosen for it");
});

function authHost(serverReadsInstallable: boolean, platform: NodeJS.Platform = "linux") {
  const loads: string[] = [];
  const full = { installation: notFound, installPlan: async () => assert.fail("a report plans nothing"), install: async () => assert.fail("a report runs nothing") };
  const runtimes: Record<string, Partial<Runtime>> = {
    claude: { ...full, installation: async () => executable, authStatus: async () => ({ kind: "logged_out", source: "x" }) },
    grok: { ...full, authStatus: async () => ({ kind: "logged_out", source: "x" }) },
    qwen: { ...full },
    // Detection missed it, but OAR's probe finds it: not offered.
    qoder: { ...full, installation: async () => executable },
    codex: { installation: notFound },
    opencode: { ...full, installLines: [{ line: "v2", description: "OpenCode 2" }] },
    // Lines, none of them one Raft installs: not offered.
    antigravity: { ...full, installLines: [{ line: "v9", description: "nine" }] },
  };
  const instance = new RuntimeAuthHost({
    loadRuntime: async (id) => { loads.push(id); return (runtimes[id] ?? {}) as Runtime; },
    loadProviderAuth: async () => null,
    kimiStatus: async () => ({ kind: "logged_out" }),
    loadKimiAuth: async () => assert.fail("no Kimi sign-in here"),
    send: () => {},
    recordEvent: () => {},
    now: () => 1_000,
    serverReads: () => ["claude", "codex", "kimi", "grok", "qwen", "qoder", "opencode", "antigravity", "pi"],
    serverReadsInstallable: () => serverReadsInstallable,
    platform,
  });
  return { instance, loads };
}

test("a status report names the not-installed runtimes this Computer can install, only for a server that reads it", async () => {
  const all = ["claude", "codex", "kimi", "grok", "qwen", "qoder", "opencode", "antigravity", "pi"] as const;
  const reading = authHost(true);
  const report = await reading.instance.collectStatus(all, ["claude", "kimi-sdk"]);
  assert.deepEqual(report.installable, ["grok", "qwen", "opencode"], "claude is installed, codex has no installer, Kimi Code and Pi never, qoder's probe finds it, opencode on its 2.x line, antigravity's lines are none Raft installs");
  assert.ok(!reading.loads.includes("kimi") && !reading.loads.includes("pi"), "Kimi Code and Pi are never loaded for it");

  const windows = authHost(true, "win32");
  const onWindows = await windows.instance.collectStatus(all, ["claude", "kimi-sdk"]);
  assert.deepEqual(onWindows.installable, ["grok", "opencode"], "Qwen Code does not run on Windows; OpenCode does");

  const older = authHost(false);
  const plain = await older.instance.collectStatus(["claude", "grok"], ["claude"]);
  assert.equal("installable" in plain, false, "an older server's strict schema would refuse the field");
});

test("DeepSeek Harness (OAR's real dsh runtime: an npm installer, no release lines) is offered for Install where OAR finds no dsh; never on Windows", async () => {
  assert.equal(runtimeInstallable("dsh", dshRuntime), true);
  const previous = process.env.OAR_DSH_BIN;
  process.env.OAR_DSH_BIN = path.join(os.tmpdir(), `raft-no-such-dsh-${process.pid}`);
  const host = (platform: NodeJS.Platform) => new RuntimeAuthHost({
    loadRuntime: async (id) => (id === "dsh" ? dshRuntime : assert.fail(`only dsh is read here, not ${id}`)),
    loadProviderAuth: async () => null,
    kimiStatus: async () => ({ kind: "logged_out" }),
    loadKimiAuth: async () => assert.fail("no Kimi sign-in here"),
    send: () => {},
    recordEvent: () => {},
    now: () => 1_000,
    serverReads: () => ["dsh"],
    serverReadsInstallable: () => true,
    platform,
  });
  try {
    const report = await host("linux").collectStatus(["dsh"], []);
    assert.deepEqual(report.runtimes.dsh, { kind: "unavailable", reason: "not_installed" });
    assert.deepEqual(report.installable, ["dsh"]);
    assert.deepEqual((await host("win32").collectStatus(["dsh"], [])).installable, [], "the OAR host, and so DSH, does not run on Windows");
  } finally {
    if (previous === undefined) delete process.env.OAR_DSH_BIN; else process.env.OAR_DSH_BIN = previous;
  }
});
