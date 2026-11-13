import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import {
  CODEX_PROBE_FAILURE_TTL_MS,
  clearCodexProbeCacheForTests,
  probeCodex,
  resolveCodexSpawn,
  resolveCodexSpawnAsync,
} from "./codex";
import { ProbeChildError, type runProbeChild } from "./probeChild";
import { classifySpawnFailure } from "../spawnFailureClassification";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";

// task #1358 — a failed probe is not a lasting verdict about the candidate: a
// timeout is about this moment, and a non-zero exit or EACCES/EPERM can clear
// without the file's mtime or size changing (chmod changes neither). Before
// this, every failure was cached by (candidate, mtime, size) with no expiry, so
// one slow `codex app-server --help` rejected an unchanged Codex until the
// daemon restarted. Every test here keeps the file's mtime and size fixed:
// only time moves.

const BIN = "/opt/haohao-1358/codex";
const SECRET_ENV_VALUE = "sk-haohao-1358-must-not-leak";

/** execFileSync's own shape for a child killed at its `timeout`. */
function syncTimeoutError(): Error {
  return Object.assign(new Error("spawnSync /opt/haohao-1358/codex ETIMEDOUT"), {
    code: "ETIMEDOUT",
    signal: "SIGTERM",
    status: null,
  });
}

function eaccesError(): Error {
  return Object.assign(new Error("spawnSync /opt/haohao-1358/codex EACCES"), { code: "EACCES", errno: -13 });
}

function exitStatusError(status: number): Error {
  return Object.assign(new Error(`exited with ${status}`), { status, signal: null });
}

type Behaviour = "timeout" | "exit1" | "eacces" | "ok";

function explicitSyncDeps(state: { behaviour: Behaviour; versionBehaviour?: "timeout" | "exit1" | "ok"; now: number; execs: string[] }) {
  return {
    platform: "darwin" as const,
    env: { PATH: "/empty", CODEX_BIN: BIN, OPENAI_API_KEY: SECRET_ENV_VALUE },
    existsSyncFn: (p: string) => String(p) === BIN,
    statSyncFn: () => ({ mtimeMs: 1_000, size: 4_096 }),
    nowFn: () => state.now,
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      const argv = [...(args ?? [])];
      state.execs.push([command, ...argv].join(" "));
      if (argv.includes("--version")) {
        if (state.versionBehaviour === "timeout") throw syncTimeoutError();
        if (state.versionBehaviour === "exit1") throw exitStatusError(1);
        return Buffer.from("codex-cli 0.162.1\n");
      }
      if (state.behaviour === "timeout") throw syncTimeoutError();
      if (state.behaviour === "exit1") throw exitStatusError(1);
      if (state.behaviour === "eacces") throw eaccesError();
      return Buffer.from("Usage\n");
    }) as unknown as typeof execFileSync,
  };
}

function explicitAsyncDeps(state: { behaviour: Behaviour; now: number; execs: string[] }) {
  const runProbeChildFn: typeof runProbeChild = async (command, args) => {
    state.execs.push([command, ...args].join(" "));
    if (args.includes("--version")) return { stdout: "codex-cli 0.162.1\n", stderr: "" };
    if (state.behaviour === "timeout") throw new ProbeChildError(`${command} probe exceeded 5000 ms`, { code: "ETIMEDOUT" });
    if (state.behaviour === "exit1") throw new ProbeChildError(`${command} exited with 1`, { status: 1 });
    if (state.behaviour === "eacces") throw new ProbeChildError(`spawn ${command} EACCES`, { code: "EACCES" });
    return { stdout: "Usage\n", stderr: "" };
  };
  return {
    platform: "darwin" as const,
    env: { PATH: "/empty", CODEX_BIN: BIN, OPENAI_API_KEY: SECRET_ENV_VALUE },
    existsSyncFn: (p: string) => String(p) === BIN,
    statSyncFn: () => ({ mtimeMs: 1_000, size: 4_096 }),
    nowFn: () => state.now,
    runProbeChildFn,
  };
}

const appServerProbes = (execs: string[]) => execs.filter((line) => line.includes("app-server")).length;

beforeEach(() => clearCodexProbeCacheForTests());
afterEach(() => clearCodexProbeCacheForTests());

test("task #1358: sync — an unchanged file whose first app-server probe timed out is probed again once the short window passes, and then resolves", () => {
  const state = { behaviour: "timeout" as Behaviour, now: 10_000, execs: [] as string[] };
  const deps = explicitSyncDeps(state);
  assert.throws(() => resolveCodexSpawn(["app-server"], deps));
  assert.equal(appServerProbes(state.execs), 1);

  // The slowness is gone, the file is the same.
  state.behaviour = "ok";

  // Inside the window the timeout is reused (bounded: no probe storm)…
  state.now += CODEX_PROBE_FAILURE_TTL_MS - 1;
  assert.throws(() => resolveCodexSpawn(["app-server"], deps));
  assert.equal(appServerProbes(state.execs), 1, "a retry inside the window reuses the timeout without probing");

  // …and after it the candidate is probed again and resolves.
  state.now += 1;
  const launch = resolveCodexSpawn(["app-server"], deps);
  assert.equal(launch.command, BIN);
  assert.equal(appServerProbes(state.execs), 2);

  // The success is a verdict: it is reused with no expiry while the file is unchanged.
  state.now += CODEX_PROBE_FAILURE_TTL_MS * 100;
  resolveCodexSpawn(["app-server"], deps);
  assert.equal(appServerProbes(state.execs), 2);
});

test("task #1358: async — the same recovery on the launch path", async () => {
  const state = { behaviour: "timeout" as Behaviour, now: 10_000, execs: [] as string[] };
  const deps = explicitAsyncDeps(state);
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], deps));
  state.behaviour = "ok";
  state.now += CODEX_PROBE_FAILURE_TTL_MS - 1;
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], deps));
  assert.equal(appServerProbes(state.execs), 1);
  state.now += 1;
  const launch = await resolveCodexSpawnAsync(["app-server"], deps);
  assert.equal(launch.command, BIN);
  assert.equal(appServerProbes(state.execs), 2);
});

test("task #1358: sync and async share one cache — a timeout from detection expires for the launch path too", async () => {
  const syncState = { behaviour: "timeout" as Behaviour, now: 10_000, execs: [] as string[] };
  assert.throws(() => resolveCodexSpawn(["app-server"], explicitSyncDeps(syncState)));
  const asyncState = { behaviour: "ok" as Behaviour, now: 10_000 + CODEX_PROBE_FAILURE_TTL_MS - 1, execs: [] as string[] };
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], explicitAsyncDeps(asyncState)));
  assert.equal(appServerProbes(asyncState.execs), 0, "inside the window the async path reuses the sync timeout");
  asyncState.now += 1;
  const launch = await resolveCodexSpawnAsync(["app-server"], explicitAsyncDeps(asyncState));
  assert.equal(launch.command, BIN);
  assert.equal(appServerProbes(asyncState.execs), 1);
});

for (const behaviour of ["exit1", "eacces"] as const) {
  test(`task #1358: sync — ${behaviour} on an unchanged file also expires (chmod or a config fix changes neither mtime nor size)`, () => {
    const state = { behaviour: behaviour as Behaviour, now: 10_000, execs: [] as string[] };
    const deps = explicitSyncDeps(state);
    assert.throws(() => resolveCodexSpawn(["app-server"], deps));
    state.behaviour = "ok";
    state.now += CODEX_PROBE_FAILURE_TTL_MS - 1;
    assert.throws(() => resolveCodexSpawn(["app-server"], deps));
    assert.equal(appServerProbes(state.execs), 1, "inside the window the failure is reused");
    state.now += 1;
    assert.equal(resolveCodexSpawn(["app-server"], deps).command, BIN);
    assert.equal(appServerProbes(state.execs), 2);
  });

  test(`task #1358: async — ${behaviour} on an unchanged file also expires`, async () => {
    const state = { behaviour: behaviour as Behaviour, now: 10_000, execs: [] as string[] };
    const deps = explicitAsyncDeps(state);
    await assert.rejects(resolveCodexSpawnAsync(["app-server"], deps));
    state.behaviour = "ok";
    state.now += CODEX_PROBE_FAILURE_TTL_MS - 1;
    await assert.rejects(resolveCodexSpawnAsync(["app-server"], deps));
    assert.equal(appServerProbes(state.execs), 1);
    state.now += 1;
    assert.equal((await resolveCodexSpawnAsync(["app-server"], deps)).command, BIN);
    assert.equal(appServerProbes(state.execs), 2);
  });
}

for (const versionBehaviour of ["timeout", "exit1"] as const) {
  test(`task #1358: a version read that failed (${versionBehaviour}) does not pin an unknown version forever`, () => {
    const state = { behaviour: "ok" as Behaviour, versionBehaviour: versionBehaviour as "timeout" | "exit1" | "ok", now: 10_000, execs: [] as string[] };
    const deps = explicitSyncDeps(state);
    assert.equal(probeCodex(deps).version, undefined);
    state.versionBehaviour = "ok";
    state.now += CODEX_PROBE_FAILURE_TTL_MS - 1;
    assert.equal(probeCodex(deps).version, undefined, "reused inside the window");
    state.now += 1;
    assert.equal(probeCodex(deps).version, "codex-cli 0.162.1");
  });
}

test("task #1358: async — a version read that failed expires too", async () => {
  const state = { behaviour: "ok" as Behaviour, now: 10_000, execs: [] as string[] };
  let versionFails = true;
  const base = explicitAsyncDeps(state);
  const deps = {
    ...base,
    runProbeChildFn: (async (command, args, options) => {
      if (args.includes("--version") && versionFails) throw new ProbeChildError(`${command} exited with 1`, { status: 1 });
      return base.runProbeChildFn(command, args, options);
    }) as typeof runProbeChild,
  };
  await resolveCodexSpawnAsync(["app-server"], deps);
  const versionReads = () => state.execs.filter((line) => line.includes("--version")).length;
  versionFails = false;
  state.now += CODEX_PROBE_FAILURE_TTL_MS;
  await resolveCodexSpawnAsync(["app-server"], deps);
  assert.equal(versionReads(), 1, "the version read is retried after the window");
});

test("task #1358: a cancelled probe is still never cached", async () => {
  const state = { behaviour: "ok" as Behaviour, now: 10_000, execs: [] as string[] };
  const deps = explicitAsyncDeps(state);
  const aborting: typeof runProbeChild = async (command, args) => {
    state.execs.push([command, ...args].join(" "));
    throw new ProbeChildError("aborted", { code: "ABORT_ERR" });
  };
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], { ...deps, runProbeChildFn: aborting }), (error: unknown) => (error as { code?: unknown }).code === "ABORT_ERR");
  const launch = await resolveCodexSpawnAsync(["app-server"], deps);
  assert.equal(launch.command, BIN);
});

// Typed outcome: "found but its check timed out" is not "not found".

function pathDiscoveryDeps(state: { behaviour: Behaviour; now: number }) {
  const runProbeChildFn: typeof runProbeChild = async (command, args) => {
    if (command === "which") return { stdout: `${BIN}\n`, stderr: "" };
    if (args.includes("--version")) return { stdout: "codex-cli 0.162.1\n", stderr: "" };
    if (state.behaviour === "timeout") throw new ProbeChildError(`${command} probe exceeded 5000 ms`, { code: "ETIMEDOUT" });
    if (state.behaviour === "exit1") throw new ProbeChildError(`${command} exited with 1`, { status: 1 });
    return { stdout: "Usage\n", stderr: "" };
  };
  const execFileSyncFn = ((command: string, args?: readonly string[]) => {
    const argv = [...(args ?? [])];
    if (command === "which") return Buffer.from(`${BIN}\n`);
    if (argv.includes("--version")) return Buffer.from("codex-cli 0.162.1\n");
    if (state.behaviour === "timeout") throw syncTimeoutError();
    if (state.behaviour === "exit1") throw exitStatusError(1);
    return Buffer.from("Usage\n");
  }) as unknown as typeof execFileSync;
  return {
    platform: "linux" as const,
    homeDir: "/nonexistent-home-1358",
    env: { PATH: "/opt/haohao-1358", OPENAI_API_KEY: SECRET_ENV_VALUE },
    existsSyncFn: (p: string) => String(p) === BIN,
    statSyncFn: () => ({ mtimeMs: 1_000, size: 4_096 }),
    nowFn: () => state.now,
    runProbeChildFn,
    execFileSyncFn,
  };
}

test("task #1358: a found Codex whose app-server check timed out fails as a typed timeout, never as not-installed, and the message carries no environment", async () => {
  const state = { behaviour: "timeout" as Behaviour, now: 10_000 };
  const deps = pathDiscoveryDeps(state);
  let thrown: unknown;
  try {
    await resolveCodexSpawnAsync(["app-server"], deps);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof RuntimeExecutableNotFoundError);
  assert.equal(thrown.reason, "probe_timeout");
  assert.match(thrown.message, /did not finish within 5000 ms/);
  assert.match(thrown.message, /not evidence that Codex is missing/);
  for (const forbidden of [SECRET_ENV_VALUE, "PATH=", "/opt/haohao-1358"]) {
    assert.ok(!thrown.message.includes(forbidden), `message must not carry ${forbidden}: ${thrown.message}`);
  }
  const classified = classifySpawnFailure(thrown);
  assert.equal(classified.reason, "runtime_not_found");
  assert.equal(classified.lookupReason, "lookup_timed_out");
  assert.equal(classified.userMessage, thrown.message);

  // A cache hit says so, in the same typed shape.
  state.now += 1;
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], deps), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === "probe_timeout");

  // Detection reports the same verdict.
  clearCodexProbeCacheForTests();
  const probed = probeCodex(deps);
  assert.equal(probed.available, false);
  assert.equal(probed.unavailableReason, "probe_timeout");
});

test("task #1358 negative control: a definite rejection keeps the existing untyped outcome", async () => {
  const state = { behaviour: "exit1" as Behaviour, now: 10_000 };
  const deps = pathDiscoveryDeps(state);
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], deps), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === undefined);
  clearCodexProbeCacheForTests();
  assert.equal(probeCodex(deps).unavailableReason, "probe_failed");
});

test("task #1358: a cache hit is named in the diagnostic, with its age and no environment values", () => {
  const state = { behaviour: "timeout" as Behaviour, now: 10_000 };
  const deps = pathDiscoveryDeps(state);
  const first = probeCodex(deps);
  assert.doesNotMatch(first.diagnostic ?? "", /cached/);
  state.now += 2_000;
  const second = probeCodex(deps);
  assert.match(second.diagnostic ?? "", /app-server probe ETIMEDOUT \(cached result from 2 s ago; checked again after \d+ s\)/);
  assert.ok(!(second.diagnostic ?? "").includes(SECRET_ENV_VALUE));
});

// #oar-raft:#7 — right after a Computer restart a busy Windows machine timed
// out the PATH Codex 0.165 and started agents on Codex Desktop's 0.130, which
// could not read the newer config. A timed-out candidate now gets one longer
// check before the start settles for another, older one.
const PATH_BIN = "/opt/new/codex";
const DESKTOP_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";

function discoveryAsyncDeps(state: { pathSlowMs: number; now: number; probes: Array<{ command: string; timeoutMs: number }> }) {
  const runProbeChildFn: typeof runProbeChild = async (command, args, options) => {
    if (command === "which" || command.endsWith("/which")) return { stdout: `${PATH_BIN}\n`, stderr: "" };
    if (args.includes("--version")) return { stdout: command === PATH_BIN ? "codex-cli 0.165.0\n" : "codex-cli 0.130.0-alpha.5\n", stderr: "" };
    state.probes.push({ command, timeoutMs: options.timeoutMs });
    if (command === PATH_BIN && options.timeoutMs < state.pathSlowMs) {
      throw new ProbeChildError(`${command} probe exceeded ${options.timeoutMs} ms`, { code: "ETIMEDOUT" });
    }
    return { stdout: "Usage\n", stderr: "" };
  };
  return {
    platform: "darwin" as const,
    env: { PATH: "/opt/new", HOME: "/Users/tester" },
    existsSyncFn: (p: string) => String(p) === PATH_BIN || String(p) === DESKTOP_BIN,
    statSyncFn: () => ({ mtimeMs: 1_000, size: 4_096 }),
    nowFn: () => state.now,
    runProbeChildFn,
  };
}

test("#oar-raft:#7: a newer candidate whose check timed out passes a longer check and wins over an older one", async () => {
  const state = { pathSlowMs: 8_000, now: 10_000, probes: [] as Array<{ command: string; timeoutMs: number }> };
  const launch = await resolveCodexSpawnAsync(["app-server"], discoveryAsyncDeps(state));
  assert.equal(launch.command, PATH_BIN);
  assert.equal(launch.rejectedCandidateCount, 0);
  assert.deepEqual(state.probes.filter((probe) => probe.command === PATH_BIN).map((probe) => probe.timeoutMs), [5_000, 15_000]);
});

test("#oar-raft:#7: a candidate that also fails the longer check is retried once per failure window and reported as a timeout", async () => {
  const state = { pathSlowMs: Number.POSITIVE_INFINITY, now: 10_000, probes: [] as Array<{ command: string; timeoutMs: number }> };
  const deps = discoveryAsyncDeps(state);
  const first = await resolveCodexSpawnAsync(["app-server"], deps);
  assert.equal(first.command, DESKTOP_BIN);
  assert.equal(first.rejectedCandidateCount, 1);
  assert.equal(first.rejectionKind, "timeout");
  const second = await resolveCodexSpawnAsync(["app-server"], deps);
  assert.equal(second.command, DESKTOP_BIN);
  // Both resolutions together: one short and one long check of the PATH Codex.
  assert.deepEqual(state.probes.filter((probe) => probe.command === PATH_BIN).map((probe) => probe.timeoutMs), [5_000, 15_000]);
  state.now += CODEX_PROBE_FAILURE_TTL_MS;
  await resolveCodexSpawnAsync(["app-server"], deps);
  assert.deepEqual(state.probes.filter((probe) => probe.command === PATH_BIN).map((probe) => probe.timeoutMs), [5_000, 15_000, 5_000, 15_000]);
});

test("#oar-raft:#7: the longer check also gives the version read the longer budget, so the retried newer Codex is not ranked unknown", async () => {
  const state = { pathSlowMs: 8_000, now: 10_000, probes: [] as Array<{ command: string; timeoutMs: number }> };
  const deps = discoveryAsyncDeps(state);
  const slowVersion: typeof runProbeChild = async (command, args, options) => {
    if (command === PATH_BIN && args.includes("--version") && options.timeoutMs < state.pathSlowMs) {
      throw new ProbeChildError(`${command} probe exceeded ${options.timeoutMs} ms`, { code: "ETIMEDOUT" });
    }
    return deps.runProbeChildFn(command, args, options);
  };
  const launch = await resolveCodexSpawnAsync(["app-server"], { ...deps, runProbeChildFn: slowVersion });
  assert.equal(launch.command, PATH_BIN);
});

test("#oar-raft:#7: a candidate that passes only on the longer check keeps its discovery place on equal versions", async () => {
  const state = { pathSlowMs: 8_000, now: 10_000, probes: [] as Array<{ command: string; timeoutMs: number }> };
  const deps = discoveryAsyncDeps(state);
  const sameVersion: typeof runProbeChild = async (command, args, options) =>
    args.includes("--version") ? { stdout: "codex-cli 0.165.0\n", stderr: "" } : deps.runProbeChildFn(command, args, options);
  const first = await resolveCodexSpawnAsync(["app-server"], { ...deps, runProbeChildFn: sameVersion });
  const cached = await resolveCodexSpawnAsync(["app-server"], { ...deps, runProbeChildFn: sameVersion });
  assert.equal(first.command, PATH_BIN);
  assert.equal(cached.command, PATH_BIN);
});
