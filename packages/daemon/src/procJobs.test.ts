// `raft proc` (#proj-raft-computer:#59): jobs the daemon owns, with real
// processes (POSIX only; Windows runs no jobs in v1). RED proofs
// (reverse-verified): spawn without `detached` and the stopped job's group
// check fails (the job shares the test's group); drop the start-identity
// check in adoption and the reused-pid test adopts an unrelated process; drop
// the `isForeignChild` exclusion and the OAR pass records a job as a runtime.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseProcJobLedger, PROC_CAPABILITY, PROC_MEMORY_MAX_DEFAULT_BYTES } from "@botiverse/raft-shared";
import {
  __resetAgentCredentialProxyForTest,
  registerAgentCredentialProxy,
  setAgentProcJobManager,
} from "./agentCredentialProxy";
import { readProcessIdentity } from "./drivers/processTree";
import { RuntimeProcessLedger, type RuntimeProcessRecord } from "./drivers/runtimeProcessLedger";
import {
  cgroupV2Path,
  filterProcJobsFromRuntimeRecords,
  decideJobScope,
  detectUserSystemd,
  handleProcRequest,
  moveJobIntoCgroup,
  procJobToSnapshot,
  procJobToWire,
  procScopeArgv,
  procScopeUnitName,
  procStopReasonForAgentStop,
  readProcMemoryMaxBytes,
  sumGroupMemoryBytes,
  PROC_SCOPE_UNCONFIRMED_MESSAGE,
  procRuntimeRestrictedMessage,
  PROC_JOB_LEDGER_FILE,
  procJobEnvironment,
  ProcJobManager,
  type ProcJobManagerOptions,
  type ProcJobRecord,
} from "./procJobs";

const posix = process.platform !== "win32";
const AGENT = "agent-quant";
const OTHER = "agent-other";

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition not met in time");
}

const dirs: string[] = [];
const managers: ProcJobManager[] = [];
const strays: number[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "raft-proc-"));
  dirs.push(dir);
  return dir;
}

async function manager(options: Partial<ProcJobManagerOptions> & { machineDir: string }): Promise<ProcJobManager> {
  // User systemd stays off unless a test turns it on (a Linux CI host's own never runs a test's job).
  const opened = await ProcJobManager.open({ graceMs: 300, confirmMs: 2_000, rotateIntervalMs: 0, userSystemd: false, ...options });
  managers.push(opened);
  return opened;
}

function env(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function startOk(m: ProcJobManager, agentId: string, argv: string[], extra: { name?: string; cwd?: string } = {}): Promise<ProcJobRecord> {
  const result = await m.start(agentId, { argv, cwd: extra.cwd ?? tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null, ...(extra.name ? { name: extra.name } : {}) });
  assert.ok(result.ok, JSON.stringify(result));
  strays.push(result.job.pid);
  return result.job;
}

afterEach(async () => {
  for (const m of managers.splice(0)) m.close();
  for (const pid of strays.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }
  await __resetAgentCredentialProxyForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!posix)("a job started through the proxy outlives the CLI process that started it, is listed, and its whole group is gone once stopped", async () => {
  const machineDir = tempDir();
  const m = await manager({ machineDir });
  setAgentProcJobManager(m);
  let forwarded = 0;
  const upstream = http.createServer((_req, res) => { forwarded += 1; res.writeHead(404).end(); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const address = upstream.address() as { port: number };
    const proxy = await registerAgentCredentialProxy({
      agentId: AGENT,
      launchId: "launch-1",
      serverUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "sk_agent_test",
      activeCapabilities: "read",
      stableEntryPath: null,
      runtime: "claude",
    });
    // The "CLI": a separate process that asks for the job, prints the answer and exits.
    const script = `
      const res = await fetch(${JSON.stringify(`${proxy.proxyUrl}/internal/agent-api/proc/start`)}, {
        method: "POST",
        headers: { authorization: "Bearer ${proxy.proxyToken}", "x-agent-id": "${AGENT}", "content-type": "application/json" },
        body: JSON.stringify({ name: "web", argv: ["sh", "-c", "sleep 60 & sleep 60"], cwd: ${JSON.stringify(tmpdir())}, env: { PATH: process.env.PATH } }),
      });
      process.stdout.write(JSON.stringify({ status: res.status, body: await res.json() }));
    `;
    const cliOut = await new Promise<string>((resolve, reject) => {
      const cli = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      cli.stdout.on("data", (chunk) => { out += chunk; });
      cli.once("error", reject);
      cli.once("exit", () => resolve(out));
    });
    const answer = JSON.parse(cliOut) as { status: number; body: { capability: string; job: { pid: number; name: string; state: string } } };
    assert.equal(answer.status, 200);
    assert.equal(answer.body.capability, PROC_CAPABILITY);
    const pid = answer.body.job.pid;
    strays.push(pid);
    // The CLI is gone; the job runs on, a child of the daemon, leading its own group.
    assert.equal(pidAlive(pid), true);
    assert.equal(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()), process.pid);
    const identity = await readProcessIdentity(pid);
    assert.equal(identity?.pgid, pid);

    const listed = await m.list(AGENT);
    assert.deepEqual(listed.map((job) => [job.name, job.state, job.command]), [["web", "running", "sh"]]);
    assert.equal(forwarded, 0, "proc routes are never forwarded to the Server");

    const stopped = await m.stop(AGENT, "web");
    assert.ok(stopped.ok);
    assert.equal(stopped.outcome, "exited");
    assert.equal(groupAlive(pid), false, "the background sleep in the job's group is gone too");
    assert.equal((await m.list(AGENT))[0]?.state, "exited");
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("the proxy declares proc@1 only while jobs run here, and never forwards a proc route", async () => {
  const seenCaps: string[] = [];
  const upstream = http.createServer((req, res) => {
    seenCaps.push(String(req.headers["x-raft-client-capabilities"] ?? ""));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const proxy = await registerAgentCredentialProxy({
      agentId: AGENT,
      launchId: "launch-1",
      serverUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      apiKey: "sk_agent_test",
      activeCapabilities: "read",
      daemonVersion: "1.0.30",
    });
    const call = (pathname: string) => fetch(`${proxy.proxyUrl}${pathname}`, {
      headers: { authorization: `Bearer ${proxy.proxyToken}`, "x-agent-id": AGENT },
    });
    // No job manager (Windows, v1): refused locally, nothing declared.
    const unsupported = await call("/internal/agent-api/proc");
    assert.equal(unsupported.status, 501);
    assert.equal(((await unsupported.json()) as { code: string }).code, "proc_unsupported");
    assert.equal(((await (await call("/internal/agent-api/runtime-version")).json()) as { capabilities?: string[] }).capabilities, undefined);
    await call("/internal/agent-api/server");
    assert.equal(seenCaps.at(-1)?.split(",").includes(PROC_CAPABILITY), false);

    setAgentProcJobManager(await manager({ machineDir: tempDir() }));
    assert.deepEqual(((await (await call("/internal/agent-api/runtime-version")).json()) as { capabilities?: string[] }).capabilities, [PROC_CAPABILITY]);
    const list = await call("/internal/agent-api/proc");
    assert.deepEqual(await list.json(), { capability: PROC_CAPABILITY, jobs: [], maxJobs: 8 });
    await call("/internal/agent-api/server");
    assert.equal(seenCaps.at(-1)?.split(",").includes(PROC_CAPABILITY), true);
    assert.equal(seenCaps.length, 2, "only the two /server requests reached the Server");
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test.skipIf(!posix)("another agent neither sees nor stops a job", async () => {
  const m = await manager({ machineDir: tempDir() });
  const job = await startOk(m, AGENT, ["sleep", "60"], { name: "bot" });
  assert.deepEqual(await m.list(OTHER), []);
  const refused = await m.stop(OTHER, "bot");
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.code, "proc_not_found");
  const logs = await m.logs(OTHER, "bot");
  assert.equal(!logs.ok && logs.code, "proc_not_found");
  assert.equal(pidAlive(job.pid), true);
});

test.skipIf(!posix)("names: the pattern, a running duplicate is refused, an automatic name is made unique; the per-agent cap", async () => {
  const m = await manager({ machineDir: tempDir(), maxJobsPerAgent: 3 });
  for (const name of ["", "a b", "../x", "x".repeat(41), "web;rm"]) {
    const result = await m.start(AGENT, { name, argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
    assert.equal(!result.ok && result.code, "proc_invalid_name", name);
  }
  await startOk(m, AGENT, ["sleep", "60"], { name: "web" });
  const duplicate = await m.start(AGENT, { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.equal(!duplicate.ok && duplicate.message, "A job named web is already running; stop it (raft proc stop web) or pick another --name");

  const auto1 = await m.start(AGENT, { argv: ["/bin/sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  const auto2 = await m.start(AGENT, { argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.ok(auto1.ok && auto2.ok);
  strays.push(auto1.job.pid, auto2.job.pid);
  assert.deepEqual([auto1.job.name, auto1.autoNamed, auto2.job.name], ["sleep", true, "sleep-2"]);

  const capped = await m.start(AGENT, { name: "fourth", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.equal(!capped.ok && capped.code, "proc_limit");
  // Another agent has its own cap.
  await startOk(m, OTHER, ["sleep", "60"], { name: "web" });

  const missingCwd = await m.start(AGENT, { argv: ["sleep", "1"], cwd: path.join(tmpdir(), "no-such-dir-raft-proc"), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.equal(!missingCwd.ok && missingCwd.code, "proc_invalid_cwd");
});

// #proj-raft-computer:#59 (AX42-1): the CLI ran from /root, which the
// Computer's OS user can't enter; the spawn failed with a bare EACCES. The
// refusal names the directory and nothing is recorded. Root can enter any
// directory, so the case can't be built when the suite runs as root.
test.skipIf(!posix || process.getuid?.() === 0)("a working directory the Computer can't enter is refused by name", async () => {
  const m = await manager({ machineDir: tempDir() });
  const locked = path.join(tempDir(), "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const result = await m.start(AGENT, { argv: ["sleep", "1"], cwd: locked, env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
    assert.equal(!result.ok && result.code, "proc_invalid_cwd");
    assert.match(!result.ok ? result.message : "", /can't enter the working directory .*locked.*--cwd/);
    assert.deepEqual(await m.list(AGENT), []);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test.skipIf(!posix)("a missing command is refused as such and records nothing", async () => {
  const m = await manager({ machineDir: tempDir() });
  const result = await m.start(AGENT, { argv: ["raft-proc-no-such-command"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.equal(!result.ok && result.code, "proc_spawn_failed");
  assert.deepEqual(await m.list(AGENT), []);
});

test.skipIf(!posix)("stop: a job that ignores SIGTERM is killed after the grace; --force skips it", async () => {
  const m = await manager({ machineDir: tempDir(), graceMs: 400 });
  await startOk(m, AGENT, ["sh", "-c", "trap '' TERM; sleep 60"], { name: "stubborn" });
  await startOk(m, AGENT, ["sh", "-c", "trap '' TERM; sleep 60"], { name: "stubborn2" });
  // Let the shells install their trap.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const graced = Date.now();
  const stopped = await m.stop(AGENT, "stubborn");
  assert.ok(stopped.ok);
  assert.equal(stopped.outcome, "killed");
  assert.ok(Date.now() - graced >= 400);
  assert.equal(groupAlive(stopped.job.pid), false);

  const forced = await m.stop(AGENT, "stubborn2", { force: true });
  assert.ok(forced.ok);
  assert.equal(forced.outcome, "killed");
  assert.equal(forced.graceMs, 0);
  assert.equal(groupAlive(forced.job.pid), false);
});

test.skipIf(!posix)("a daemon restart adopts live jobs by start identity, stops them, and never adopts a reused pid", async () => {
  const machineDir = tempDir();
  const first = await manager({ machineDir });
  const job = await startOk(first, AGENT, ["sleep", "60"], { name: "web" });
  const done = await startOk(first, AGENT, ["sh", "-c", "exit 3"], { name: "done" });
  await waitFor(() => !pidAlive(done.pid));
  await waitFor(() => (JSON.parse(readFileSync(path.join(machineDir, PROC_JOB_LEDGER_FILE), "utf8")) as { jobs: ProcJobRecord[] })
    .jobs.some((record) => record.name === "done" && record.state === "exited"));
  first.close();

  // An unrelated live process now holds a pid the ledger names, with another start identity.
  const unrelated = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  strays.push(unrelated.pid!);
  const ledgerFile = path.join(machineDir, PROC_JOB_LEDGER_FILE);
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8")) as { version: 1; jobs: ProcJobRecord[] };
  ledger.jobs.push({ ...ledger.jobs.find((record) => record.name === "web")!, name: "reused", pid: unrelated.pid!, pgid: unrelated.pid!, startIdentity: "ps:Mon Jan  1 00:00:00 2001" });
  writeFileSync(ledgerFile, JSON.stringify(ledger));

  const traces: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const second = await manager({ machineDir, trace: (name, attrs) => traces.push({ name, attrs }) });
  const listed = Object.fromEntries((await second.list(AGENT)).map((record) => [record.name, record]));
  assert.equal(listed.web?.state, "running");
  assert.equal(listed.web?.adopted, true);
  assert.equal(listed.done?.state, "exited");
  assert.equal(listed.done?.exitCode, 3);
  assert.equal(listed.reused?.state, "exited");
  assert.equal(listed.reused?.exitCode, null);
  assert.deepEqual(traces.find((trace) => trace.name === "daemon.proc.adopted")?.attrs, {
    recorded_count: 3, adopted_count: 1, gone_count: 1, agent_count: 1,
  });
  assert.equal(JSON.stringify(traces).includes("sleep"), false, "traces never carry the command");

  assert.equal(pidAlive(unrelated.pid!), true, "the reused pid was never signalled");
  const reusedStop = await second.stop(AGENT, "reused");
  assert.ok(reusedStop.ok && reusedStop.outcome === "already_exited");
  assert.equal(pidAlive(unrelated.pid!), true);

  const stopped = await second.stop(AGENT, "web");
  assert.ok(stopped.ok && stopped.outcome === "exited");
  await waitFor(() => !pidAlive(job.pid));
});

test.skipIf(!posix)("the runtime orphan sweep leaves proc jobs alone: OAR's children pass skips them, and leftover records naming a job are dropped", async () => {
  const machineDir = tempDir();
  const m = await manager({ machineDir });
  const job = await startOk(m, AGENT, ["sleep", "60"], { name: "web" });
  const runtimeLedger = RuntimeProcessLedger.inMachineDir(machineDir, {
    tree: { listProcesses: async () => [{ pid: job.pid, ppid: process.pid, pgid: job.pid }] },
    isForeignChild: (pid) => m.ownsPid(pid),
  });
  await runtimeLedger.recordUnrecordedChildren({ agentId: AGENT, launchId: null });
  assert.equal(runtimeLedger.has(job.pid), false);

  const records: RuntimeProcessRecord[] = [
    { pid: job.pid, pgid: job.pid, startIdentity: job.startIdentity!, agentId: AGENT, launchId: null, host: "oar", recordedAtMs: 0 },
    { pid: 999_999, pgid: 999_999, startIdentity: "ps:x", agentId: AGENT, launchId: null, host: "legacy", recordedAtMs: 0 },
  ];
  assert.deepEqual(filterProcJobsFromRuntimeRecords(machineDir, records).map((record) => record.pid), [999_999]);
});

test.skipIf(!posix)("the log gets the job's stdout and stderr; logs tails it, reads on from an offset, and rotates once past the cap", async () => {
  const machineDir = tempDir();
  const m = await manager({ machineDir, logMaxBytes: 64 });
  const job = await startOk(m, AGENT, ["sh", "-c", "echo one; echo two >&2; echo three; sleep 60"], { name: "chatty" });
  assert.equal(job.logPath, path.join(machineDir, "proc", AGENT, "chatty.log"));
  await waitFor(() => existsSync(job.logPath) && readFileSync(job.logPath, "utf8").includes("three"));
  const tail = await m.logs(AGENT, "chatty", { tail: 2 });
  assert.ok(tail.ok);
  assert.equal(tail.text, "two\nthree\n");
  const from = await m.logs(AGENT, "chatty", { offset: 4 });
  assert.ok(from.ok);
  assert.equal(from.text, "two\nthree\n");
  assert.equal(from.offset, "one\ntwo\nthree\n".length);

  writeFileSync(job.logPath, "x".repeat(100), { flag: "a" });
  m.sweep();
  assert.equal(readFileSync(`${job.logPath}.1`, "utf8").startsWith("one\n"), true);
  assert.equal(readFileSync(job.logPath, "utf8"), "");
  const after = await m.logs(AGENT, "chatty", { offset: 200 });
  assert.ok(after.ok && after.rotated && after.text === "");
});

test("the job's environment: the per-session CLI channel becomes the agent's stable entry", () => {
  const home = "/home/q/.slock";
  const launch = `${home}/cli-transport/${AGENT}/launch-7`;
  const stable = `${home}/cli-transport/${AGENT}/current`;
  const out = procJobEnvironment({
    PATH: `${launch}:/usr/bin:/bin`,
    HOME: "/home/q",
    SLOCK_HOME: home,
    SLOCK_AGENT_ID: AGENT,
    SLOCK_SERVER_URL: "https://raft.example",
    SLOCK_CLI_TRANSPORT_DIR: launch,
    SLOCK_AGENT_LAUNCH_DIR: "launch-7",
    SLOCK_AGENT_LAUNCH_ID: "launch-7",
    SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:1",
    SLOCK_AGENT_PROXY_TOKEN_FILE: `${home}/agent-proxy-tokens/${AGENT}/launch-7.token`,
    SLOCK_AGENT_ACTIVE_CAPABILITIES: "read",
    RAFT_CLI_ENTRY: "stable_entry",
    MY_APP_SETTING: "kept",
  }, stable, "linux");
  assert.deepEqual(out, {
    PATH: `${stable}:/usr/bin:/bin`,
    HOME: "/home/q",
    SLOCK_HOME: home,
    SLOCK_AGENT_ID: AGENT,
    SLOCK_SERVER_URL: "https://raft.example",
    SLOCK_CLI_TRANSPORT_DIR: stable,
    SLOCK_AGENT_LAUNCH_DIR: "current",
    MY_APP_SETTING: "kept",
  });
  // A job started by a job (its CLI ran through the stable entry): no second copy.
  const nested = procJobEnvironment({ PATH: `${stable}:/usr/bin`, SLOCK_CLI_TRANSPORT_DIR: launch }, stable, "linux");
  assert.equal(nested.PATH, `${stable}:/usr/bin`);
  // No stable entry (a launch without a runner credential): the session's channel is only dropped.
  const none = procJobEnvironment({ PATH: `${launch}:/bin`, SLOCK_CLI_TRANSPORT_DIR: launch, SLOCK_AGENT_LAUNCH_DIR: "launch-7" }, null, "linux");
  assert.deepEqual(none, { PATH: "/bin" });
});

test.skipIf(!posix)("a real job sees the swapped environment", async () => {
  const machineDir = tempDir();
  const stable = path.join(machineDir, "cli-transport", AGENT, "current");
  const launch = path.join(machineDir, "cli-transport", AGENT, "launch-1");
  mkdirSync(stable, { recursive: true });
  const m = await manager({ machineDir });
  const result = await m.start(AGENT, {
    name: "envcheck",
    argv: ["sh", "-c", "echo \"$SLOCK_CLI_TRANSPORT_DIR|${SLOCK_AGENT_PROXY_TOKEN_FILE:-unset}|${PATH%%:*}\"; sleep 60"],
    cwd: tmpdir(),
    env: { PATH: `${launch}:/usr/bin:/bin`, SLOCK_CLI_TRANSPORT_DIR: launch, SLOCK_AGENT_PROXY_TOKEN_FILE: "/secret/launch-1.token" },
    stableEntryDir: stable,
    runtime: "claude",
    launchId: null,
  });
  assert.ok(result.ok);
  strays.push(result.job.pid);
  await waitFor(() => existsSync(result.job.logPath) && readFileSync(result.job.logPath, "utf8").includes("|"));
  assert.equal(readFileSync(result.job.logPath, "utf8"), `${stable}|unset|${stable}\n`);
});

// A fake Linux /proc: the daemon (900) in its service cgroup; agent A's
// runtime (1000) in a scope of its own, with a tool shell (1002) and the CLI
// (1003) below it; agent B's runtime (2000) and a process of it (2005); a
// stray process (3000) under pid 1.
const DAEMON_CG = "/system.slice/raft-computer.service";
const A_SCOPE = "/user.slice/agent-a.scope";
function fakeLinux(overrides: { aRuntimeCgroup?: string; callerCgroup?: string; refuseMove?: boolean } = {}) {
  const procs: Record<number, { ppid: number; cgroup: string; start: string }> = {
    1: { ppid: 0, cgroup: "/init.scope", start: "1" },
    900: { ppid: 1, cgroup: DAEMON_CG, start: "90" },
    1000: { ppid: 900, cgroup: overrides.aRuntimeCgroup ?? A_SCOPE, start: "500" },
    1002: { ppid: 1000, cgroup: overrides.aRuntimeCgroup ?? A_SCOPE, start: "501" },
    1003: { ppid: 1002, cgroup: overrides.callerCgroup ?? `${A_SCOPE}/bash-1.scope`, start: "502" },
    2000: { ppid: 900, cgroup: "/user.slice/agent-b.scope", start: "600" },
    2005: { ppid: 2000, cgroup: "/user.slice/agent-b.scope", start: "601" },
    3000: { ppid: 1, cgroup: "/user.slice/stray.scope", start: "700" },
  };
  const writes: Array<[string, string]> = [];
  const cgroupOf = (file: string) => {
    const pid = file === "/proc/self/cgroup" ? 900 : Number(/^\/proc\/(\d+)\/cgroup$/.exec(file)?.[1]);
    const proc = procs[pid];
    if (!proc) throw new Error(`ENOENT ${file}`);
    return `0::${proc.cgroup}\n`;
  };
  return {
    writes,
    cgroup: {
      root: "/sys/fs/cgroup",
      read: cgroupOf,
      write: (file: string, text: string) => {
        if (overrides.refuseMove) throw new Error("EACCES");
        writes.push([file, text]);
      },
    },
    tree: { listProcesses: async () => Object.entries(procs).map(([pid, proc]) => ({ pid: Number(pid), ppid: proc.ppid, pgid: Number(pid) })) },
    identity: {
      readProcStat: (pid: number) => {
        const proc = procs[pid];
        if (!proc) throw new Error("ENOENT");
        return `${pid} (x) S ${proc.ppid} ${pid} ${Array(16).fill("0").join(" ")} ${proc.start}`;
      },
    },
    roots: {
      [AGENT]: [{ pid: 1000, startIdentity: "linux:500", launchId: "launch-a" }],
      [OTHER]: [{ pid: 2000, startIdentity: "linux:600", launchId: "launch-b" }],
    } as Record<string, Array<{ pid: number; startIdentity: string; launchId: string | null }>>,
  };
}

test("Linux scope: a genuine descendant of the agent's runtime joins its own cgroup inside the agent's scope", async () => {
  const fake = fakeLinux();
  const decide = (callerPid: number | undefined, launchId: string | null = "launch-a") =>
    decideJobScope({ callerPid, launchId, roots: fake.roots[AGENT]!, platform: "linux" }, fake);
  assert.deepEqual(await decide(1003), { kind: "agent", cgroup: `${A_SCOPE}/bash-1.scope` });
  // The runtime itself, or a launch the ledger names without an id.
  assert.deepEqual(await decide(1000, null), { kind: "agent", cgroup: A_SCOPE });
  // A descendant that sits outside the runtime's cgroup gets the runtime's own.
  const moved = fakeLinux({ callerCgroup: "/user.slice/agent-b.scope" });
  assert.deepEqual(await decideJobScope({ callerPid: 1003, launchId: "launch-a", roots: moved.roots[AGENT]!, platform: "linux" }, moved), { kind: "agent", cgroup: A_SCOPE });
  assert.equal(moveJobIntoCgroup(`${A_SCOPE}/bash-1.scope`, 77, fake.cgroup), true);
  assert.deepEqual(fake.writes, [[`/sys/fs/cgroup${A_SCOPE}/bash-1.scope/cgroup.procs`, "77"]]);
});

test("Linux scope: where the agent has a scope of its own, a caller that doesn't descend from its runtime is refused", async () => {
  const fake = fakeLinux();
  const decide = (callerPid: number | undefined) =>
    decideJobScope({ callerPid, launchId: "launch-a", roots: fake.roots[AGENT]!, platform: "linux" }, fake);
  assert.deepEqual(await decide(2005), { kind: "refuse" }, "another agent's process");
  assert.deepEqual(await decide(2000), { kind: "refuse" }, "another agent's runtime");
  assert.deepEqual(await decide(3000), { kind: "refuse" }, "a chain that never reaches the runtime");
  assert.deepEqual(await decide(1), { kind: "refuse" }, "pid 1");
  assert.deepEqual(await decide(900), { kind: "refuse" }, "the daemon itself");
  assert.deepEqual(await decide(undefined), { kind: "refuse" }, "no caller pid");
  // Another launch's runtime record does not confirm this launch's caller.
  assert.deepEqual(await decideJobScope({ callerPid: 1003, launchId: "launch-z", roots: fake.roots[AGENT]!, platform: "linux" }, fake), { kind: "none" });
  assert.deepEqual(fake.writes, []);
});

test("Linux scope: where the agent runs in the daemon's cgroup, every caller gets none and nothing is moved", async () => {
  const fake = fakeLinux({ aRuntimeCgroup: DAEMON_CG });
  for (const callerPid of [1003, 2005, 3000, 1, undefined]) {
    assert.deepEqual(await decideJobScope({ callerPid, launchId: "launch-a", roots: fake.roots[AGENT]!, platform: "linux" }, fake), { kind: "none" }, String(callerPid));
  }
  // A recorded runtime that is gone, or whose pid was reused: no scope to confirm.
  const stale = fakeLinux();
  assert.deepEqual(await decideJobScope({ callerPid: 2005, launchId: null, roots: [{ pid: 1000, startIdentity: "linux:1", launchId: null }], platform: "linux" }, stale), { kind: "none" });
  assert.deepEqual(await decideJobScope({ callerPid: 1003, launchId: null, roots: fake.roots[AGENT]!, platform: "darwin" }, fake), { kind: "none" });
  assert.deepEqual(fake.writes, []);
});

test.skipIf(!posix)("start (Linux, agent scope): an unconfirmed caller is refused before anything runs; a confirmed one runs in the scope; a refused move kills the job", async () => {
  const fake = fakeLinux();
  const m = await manager({
    machineDir: tempDir(),
    platform: "linux",
    cgroup: fake.cgroup,
    tree: fake.tree,
    identity: fake.identity,
    runtimeRoots: (agentId) => fake.roots[agentId] ?? [],
  });
  const input = (callerPid: number) => ({ name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: "launch-a", callerPid });
  const refused = await m.start(AGENT, input(2005));
  assert.equal(!refused.ok && refused.code, "proc_scope_unconfirmed");
  assert.equal(!refused.ok && refused.message, PROC_SCOPE_UNCONFIRMED_MESSAGE);
  assert.deepEqual(await m.list(AGENT), []);

  const accepted = await m.start(AGENT, input(1003));
  assert.ok(accepted.ok, JSON.stringify(accepted));
  strays.push(accepted.job.pid);
  assert.equal(accepted.job.scope, "agent");
  assert.deepEqual(fake.writes, [[`/sys/fs/cgroup${A_SCOPE}/bash-1.scope/cgroup.procs`, String(accepted.job.pid)]]);

  const refusing = fakeLinux({ refuseMove: true });
  const m2 = await manager({
    machineDir: tempDir(),
    platform: "linux",
    cgroup: refusing.cgroup,
    tree: refusing.tree,
    identity: refusing.identity,
    runtimeRoots: (agentId) => refusing.roots[agentId] ?? [],
  });
  const before = new Set(execFileSync("ps", ["-A", "-o", "pid="], { encoding: "utf8" }).split("\n").map((line) => line.trim()));
  const failedMove = await m2.start(AGENT, { ...input(1003), argv: ["sleep", "61"] });
  assert.equal(!failedMove.ok && failedMove.code, "proc_scope_unconfirmed");
  assert.deepEqual(await m2.list(AGENT), []);
  // No `sleep 61` was left running in the daemon's cgroup.
  await waitFor(() => !execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n")
    .some((line) => /\bsleep 61\b/.test(line) && !before.has(line.trim().split(/\s+/)[0]!)));
});

test.skipIf(!posix)("start refuses an agent whose runtime isn't known to run with full access (an OAR-only runtime, an unknown or missing one)", async () => {
  const m = await manager({ machineDir: tempDir() });
  for (const runtime of ["qwen", "qoder", "something-new", null]) {
    const result = await m.start(AGENT, { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime, launchId: null });
    assert.equal(!result.ok && result.code, "proc_runtime_restricted", String(runtime));
    assert.equal(!result.ok && result.message, procRuntimeRestrictedMessage(runtime));
  }
  assert.equal(procRuntimeRestrictedMessage("qwen"), "This agent's runtime (qwen) isn't known to run with full access, and a job would run with more access than the agent has, so this Computer won't start it; start it with nohup inside your own process group and stop it with kill -- -<pgid>");
  assert.equal(procRuntimeRestrictedMessage("a\nb"), procRuntimeRestrictedMessage(null));
  assert.deepEqual(await m.list(AGENT), []);
});

// Step 2: a job of an agent without a scope of its own runs in a user systemd
// scope of its own (Linux). A fake `systemctl` reports the manager's state; a
// fake `systemd-run` records its argv and execs the command after `--`, as
// `systemd-run --scope` does (no fork: the pid stays the command's). RED
// proofs (reverse-verified): spawn the job directly and the recorded argv is
// missing; record systemd-run's own basename and `command` is wrong; drop the
// agent-id check and a non-hex id reaches the unit name.
const UUID_AGENT = "6a37f503-aa11-499f-ae44-c25280e9451a";

function fakeSystemd(state: string, version = 259): { dir: string; record: string } {
  const dir = tempDir();
  const record = path.join(dir, "systemd-run.argv");
  writeFileSync(path.join(dir, "systemctl"), `#!/bin/sh\necho ${state}\n[ "${state}" = running ]\n`);
  writeFileSync(path.join(dir, "systemd-run"), [
    "#!/bin/sh",
    `[ "$1" = --version ] && { echo "systemd ${version} (${version})"; echo "+PAM +AUDIT"; exit 0; }`,
    // Written whole, then renamed: a reader never sees a half-written record.
    `printf '%s\\n' "$@" > '${record}.tmp' && mv '${record}.tmp' '${record}'`,
    'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
    "shift",
    'exec "$@"',
    "",
  ].join("\n"));
  chmodSync(path.join(dir, "systemctl"), 0o755);
  chmodSync(path.join(dir, "systemd-run"), 0o755);
  return { dir, record };
}

function psCommand(pid: number): string {
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

test("agent:stop reasons: owner_stop, deleted and migrated stop the agent's jobs; lifecycle, none or anything else do not", () => {
  assert.equal(procStopReasonForAgentStop("owner_stop"), "owner_stop");
  assert.equal(procStopReasonForAgentStop("deleted"), "agent_deleted");
  assert.equal(procStopReasonForAgentStop("migrated"), "migrated");
  for (const reason of ["lifecycle", undefined, null, "", "OWNER_STOP", 1, {}]) {
    assert.equal(procStopReasonForAgentStop(reason), null, String(reason));
  }
});

test("the scope unit name: raft-proc-<the agent id's first 8 hex>-<valid name>, nothing else", () => {
  assert.equal(procScopeUnitName(UUID_AGENT, "web"), "raft-proc-6a37f503-web");
  assert.equal(procScopeUnitName(UUID_AGENT.toUpperCase(), "dev_server-2"), "raft-proc-6a37f503-dev_server-2");
  assert.equal(procScopeUnitName("agent-quant", "web"), null, "not hex");
  assert.equal(procScopeUnitName("6a37f5", "web"), null, "too short");
  for (const name of ["", "a b", "../x", "x.scope", "a;b", "x".repeat(41)]) {
    assert.equal(procScopeUnitName(UUID_AGENT, name), null, name);
  }
});

test.skipIf(!posix)("user systemd: answered by a running or degraded manager with systemd-run on the PATH; not otherwise", async () => {
  for (const state of ["running", "degraded"]) {
    const fake = fakeSystemd(state);
    assert.equal(await detectUserSystemd(fake.dir), path.join(fake.dir, "systemd-run"), state);
  }
  for (const state of ["offline", "unknown"]) assert.equal(await detectUserSystemd(fakeSystemd(state).dir), null, state);
  const noRun = fakeSystemd("running");
  rmSync(path.join(noRun.dir, "systemd-run"));
  assert.equal(await detectUserSystemd(noRun.dir), null, "no systemd-run");
  assert.equal(await detectUserSystemd(tempDir()), null, "neither");
});

test.skipIf(!posix)("start with user systemd: the job runs through systemd-run --user --scope as an argv, keeps the command's pid and group, is recorded created, and stops and is adopted as before", async () => {
  const fake = fakeSystemd("degraded");
  const machineDir = tempDir();
  const m = await manager({ machineDir, userSystemd: { pathEnv: fake.dir } });
  const result = await m.start(UUID_AGENT, { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.ok(result.ok, JSON.stringify(result));
  strays.push(result.job.pid);
  assert.equal(result.stopsWithService, false);
  assert.equal(result.job.scope, "created");
  assert.equal(result.job.command, "sleep", "the command's basename, not systemd-run's");
  // The shell creates the argv file before writing it. Once it has exec'd sleep,
  // the write is complete and the recorded pid is the command, leading its own group.
  await waitFor(() => psCommand(result.job.pid) === "sleep 60");
  // A capped scope has a unit name of its own (the start time), so a failed one never blocks the next start.
  assert.match(result.job.scopeUnit ?? "", /^raft-proc-6a37f503-web-[0-9a-z]+$/);
  assert.deepEqual(readFileSync(fake.record, "utf8").trimEnd().split("\n"), [
    "--user", "--scope", "--unit", result.job.scopeUnit,
    "-p", `MemoryMax=${PROC_MEMORY_MAX_DEFAULT_BYTES}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=kill",
    "--", "sleep", "60",
  ]);
  // The fake runs no real scope: the cap isn't seen on the job's cgroup, so the daemon samples it.
  assert.equal(result.job.memoryEnforcedBy, "sampler");
  const identity = await readProcessIdentity(result.job.pid);
  assert.equal(identity?.pgid, result.job.pid);
  assert.equal(result.job.pgid, result.job.pid);
  assert.equal(result.job.startIdentity, identity?.startIdentity);
  const ledger = JSON.parse(readFileSync(path.join(machineDir, PROC_JOB_LEDGER_FILE), "utf8")) as { jobs: ProcJobRecord[] };
  assert.equal(ledger.jobs[0]?.scope, "created");

  m.close();
  const next = await manager({ machineDir, userSystemd: { pathEnv: fake.dir } });
  const [adopted] = await next.list(UUID_AGENT);
  assert.equal(adopted?.adopted, true);
  assert.equal(adopted?.state, "running");
  const stopped = await next.stop(UUID_AGENT, "web", { reason: "owner_stop" });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  await waitFor(() => !groupAlive(result.job.pid));
});

test.skipIf(!posix)("start with user systemd: an agent id that can't name a unit, or a missing command, is refused before anything runs", async () => {
  const fake = fakeSystemd("running");
  const m = await manager({ machineDir: tempDir(), userSystemd: { pathEnv: fake.dir } });
  const input = { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null };
  const badAgent = await m.start("agent-quant", input);
  assert.equal(!badAgent.ok && badAgent.code, "proc_spawn_failed");
  const missing = await m.start(UUID_AGENT, { ...input, argv: ["raft-proc-no-such-command-xyz"] });
  assert.equal(!missing.ok && missing.message, "Could not start raft-proc-no-such-command-xyz: command not found");
  assert.equal(existsSync(fake.record), false, "systemd-run never ran");
  assert.deepEqual(await m.list("agent-quant"), []);
  assert.deepEqual(await m.list(UUID_AGENT), []);
});

test.skipIf(!posix)("without user systemd the job stays in the service's cgroup and start says a service restart ends it; off Linux it says nothing", async () => {
  const fake = fakeSystemd("offline");
  const m = await manager({ machineDir: tempDir(), userSystemd: { pathEnv: fake.dir } });
  const body = Buffer.from(JSON.stringify({ name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env() }));
  const request = { agentId: UUID_AGENT, stableEntryPath: null, launchId: null, runtime: "claude", method: "POST", pathname: "/internal/agent-api/proc/start", query: new URLSearchParams(), body };
  const started = await handleProcRequest(m, request);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const job = started.body.job as { pid: number; scope: string };
  strays.push(job.pid);
  assert.equal(job.scope, "none");
  assert.equal(started.body.stopsWithService, true);
  assert.equal(existsSync(fake.record), false);

  const off = await manager({ machineDir: tempDir() });
  const quiet = await handleProcRequest(off, request);
  assert.equal(quiet.status, 200);
  strays.push((quiet.body.job as { pid: number }).pid);
  assert.equal("stopsWithService" in quiet.body, false);
});

// #proj-raft-computer:#114 step 3: every job runs under a memory cap. RED
// proofs (reverse-verified): stop after the first sample over the cap and the
// "one sample alone" check fails; drop the Result read and the kernel case
// records no memory_limit; keep --collect with a cap and the argv check fails.
const GB = 1024 * 1024 * 1024;

test("the scope argv: with a cap the kernel enforces it on the whole scope (OOMPolicy where scopes take it) and the unit is kept to read why; without one it is collected", () => {
  assert.deepEqual(procScopeArgv("/usr/bin/systemd-run", "raft-proc-6a37f503-web", ["node", "a.js"], 4 * GB, { oomPolicy: true }), [
    "/usr/bin/systemd-run", "--user", "--scope", "--unit", "raft-proc-6a37f503-web",
    "-p", `MemoryMax=${4 * GB}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=kill", "--", "node", "a.js",
  ]);
  assert.deepEqual(procScopeArgv("/usr/bin/systemd-run", "u", ["node"], GB), ["/usr/bin/systemd-run", "--user", "--scope", "--unit", "u", "-p", `MemoryMax=${GB}`, "-p", "MemorySwapMax=0", "--", "node"], "systemd older than 253");
  assert.deepEqual(procScopeArgv("/usr/bin/systemd-run", "u", ["node"], null), ["/usr/bin/systemd-run", "--user", "--scope", "--unit", "u", "--collect", "--", "node"]);
});

test("the owner's cap: <Raft home>/computer/proc.json memoryMaxMb, 0 for none; no file or a bad one is the 4 GB default", () => {
  const home = tempDir();
  assert.equal(readProcMemoryMaxBytes(home), PROC_MEMORY_MAX_DEFAULT_BYTES);
  assert.equal(PROC_MEMORY_MAX_DEFAULT_BYTES, 4 * GB);
  mkdirSync(path.join(home, "computer"));
  const file = path.join(home, "computer", "proc.json");
  writeFileSync(file, JSON.stringify({ memoryMaxMb: 8192 }));
  assert.equal(readProcMemoryMaxBytes(home), 8 * GB);
  writeFileSync(file, JSON.stringify({ memoryMaxMb: 0 }));
  assert.equal(readProcMemoryMaxBytes(home), null);
  for (const bad of ["{", "null", JSON.stringify({ memoryMaxMb: Number.MAX_SAFE_INTEGER }), JSON.stringify({ memoryMaxMb: -1 }), JSON.stringify({ memoryMaxMb: 1.5 }), JSON.stringify({ memoryMaxMb: "8192" }), JSON.stringify({})]) {
    writeFileSync(file, bad);
    assert.equal(readProcMemoryMaxBytes(home), PROC_MEMORY_MAX_DEFAULT_BYTES, bad);
  }
});

test.skipIf(!posix)("sampled jobs: stopped at once after two samples in a row over the cap, recorded memory_limit, one notice; one sample alone or an under-cap sample in between does not", async () => {
  let used = new Map<number, number>();
  const noticed: string[] = [];
  const m = await manager({
    machineDir: tempDir(),
    memoryMaxBytes: () => GB,
    memoryUsage: async (pgids) => new Map(pgids.filter((pgid) => used.has(pgid)).map((pgid) => [pgid, used.get(pgid)!])),
    onMemoryLimit: (job) => noticed.push(job.name),
  });
  const big = await startOk(m, AGENT, ["sleep", "60"], { name: "big" });
  const calm = await startOk(m, AGENT, ["sleep", "60"], { name: "calm" });
  assert.equal(big.memoryMaxBytes, GB);
  used = new Map([[big.pgid, 2 * GB], [calm.pgid, GB / 2]]);
  await m.sampleMemory();
  assert.equal(big.state, "running", "one sample alone");
  used = new Map([[big.pgid, GB / 2]]);
  await m.sampleMemory();
  used = new Map([[big.pgid, 2 * GB]]);
  await m.sampleMemory();
  assert.equal(big.state, "running", "the under-cap sample reset the count");
  await m.sampleMemory();
  await waitFor(() => !groupAlive(big.pgid));
  const [listedBig, listedCalm] = await m.list(AGENT);
  assert.equal(listedBig?.state, "exited");
  assert.equal(listedBig?.exitReason, "memory_limit");
  assert.equal(listedCalm?.state, "running");
  assert.deepEqual(noticed, ["big"]);
  const wire = procJobToWire(listedBig!);
  assert.equal(wire.exitReason, "memory_limit");
  assert.equal(wire.memoryMaxBytes, GB);
  await m.sampleMemory();
  assert.deepEqual(noticed, ["big"], "an exited job is not sampled again");
});

test.skipIf(!posix)("no cap (memoryMaxMb 0): the job is never sampled", async () => {
  const asked: number[][] = [];
  const m = await manager({ machineDir: tempDir(), memoryMaxBytes: () => null, memoryUsage: async (pgids) => { asked.push([...pgids]); return new Map(); } });
  const job = await startOk(m, AGENT, ["sleep", "60"], { name: "web" });
  assert.equal(job.memoryMaxBytes, null);
  await m.sampleMemory();
  assert.deepEqual(asked, []);
});

const SCOPED_AT_MS = 1_000; // the unit's suffix: (1000).toString(36) = "rs"

/** A job cgroup for any pid: the capped scope's own, carrying `memoryMax`. */
function scopeCgroup(unit: string, memoryMax: string) {
  return {
    root: "/sys/fs/cgroup",
    read: (file: string) => {
      if (/^\/proc\/\d+\/cgroup$/.test(file)) return `0::/user.slice/app.slice/${unit}.scope\n`;
      if (file === `/sys/fs/cgroup/user.slice/app.slice/${unit}.scope/memory.max`) return `${memoryMax}\n`;
      throw new Error(`unexpected read ${file}`);
    },
    write: () => {},
  };
}

test.skipIf(!posix)("a capped job in a scope of its own: the kernel holds it once its cgroup carries the cap; its unit's Result then says whether the OOM kill ended it, and the unit is reset either way", async () => {
  for (const [result, expected] of [["oom-kill", "memory_limit"], ["success", null]] as const) {
    const fake = fakeSystemd("running");
    const calls: string[] = [];
    const sampled: number[][] = [];
    const noticed: string[] = [];
    const m = await manager({
      machineDir: tempDir(),
      now: () => SCOPED_AT_MS,
      userSystemd: { pathEnv: fake.dir },
      cgroup: scopeCgroup("raft-proc-6a37f503-web-rs", String(GB)),
      memoryMaxBytes: () => GB,
      memoryUsage: async (pgids) => { sampled.push([...pgids]); return new Map(); },
      scopeUnits: {
        result: async (unit) => { calls.push(`result ${unit}`); return result; },
        resetFailed: async (unit) => { calls.push(`reset ${unit}`); },
      },
      onMemoryLimit: (job) => noticed.push(job.name),
    });
    await m.settled();
    assert.deepEqual(calls, ["reset raft-proc-*"], "the start's sweep of failed scopes");
    calls.length = 0;
    const started = await m.start(UUID_AGENT, { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
    assert.ok(started.ok, JSON.stringify(started));
    strays.push(started.job.pid);
    assert.equal(started.job.scopeUnit, "raft-proc-6a37f503-web-rs");
    assert.equal(started.job.memoryEnforcedBy, "kernel");
    await waitFor(() => psCommand(started.job.pid) === "sleep 60");
    await m.sampleMemory();
    assert.deepEqual(sampled, [], "a kernel-held job is not sampled");
    process.kill(-started.job.pid, "SIGKILL");
    await waitFor(() => started.job.state === "exited");
    await m.settled();
    assert.equal(started.job.exitReason, expected, result);
    assert.deepEqual(calls, ["result raft-proc-6a37f503-web-rs", "reset raft-proc-6a37f503-web-rs"], result);
    assert.deepEqual(noticed, expected ? ["web"] : [], result);
  }
});

test.skipIf(!posix)("a scope that doesn't hold the cap is sampled: systemd older than 253 (no OOMPolicy on scopes), or a cgroup without the cap", async () => {
  const older = fakeSystemd("running", 249);
  const m = await manager({
    machineDir: tempDir(),
    now: () => SCOPED_AT_MS,
    userSystemd: { pathEnv: older.dir },
    cgroup: scopeCgroup("raft-proc-6a37f503-web-rs", String(GB)),
    memoryMaxBytes: () => GB,
  });
  const started = await m.start(UUID_AGENT, { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.ok(started.ok, JSON.stringify(started));
  strays.push(started.job.pid);
  await waitFor(() => existsSync(older.record) && psCommand(started.job.pid) === "sleep 60");
  assert.equal(readFileSync(older.record, "utf8").includes("OOMPolicy"), false);
  assert.equal(started.job.memoryEnforcedBy, "sampler");

  const uncapped = fakeSystemd("running");
  const n = await manager({
    machineDir: tempDir(),
    now: () => SCOPED_AT_MS,
    userSystemd: { pathEnv: uncapped.dir },
    cgroup: scopeCgroup("raft-proc-6a37f503-web-rs", "max"),
    memoryMaxBytes: () => GB,
  });
  const ignored = await n.start(UUID_AGENT, { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.ok(ignored.ok, JSON.stringify(ignored));
  strays.push(ignored.job.pid);
  assert.equal(ignored.job.memoryEnforcedBy, "sampler");
});

test("ps rows: resident KiB summed per wanted process group, in bytes", () => {
  const out = "  100   2048\n  100  1024\n  200 4096\n garbage\n  300\n";
  assert.deepEqual([...sumGroupMemoryBytes(out, [100, 300])], [[100, 3072 * 1024]]);
});

test("the ledger's memory fields: kept when well formed, dropped otherwise", () => {
  const base = { agentId: "a", name: "web", pid: 5, pgid: 5, startIdentity: null, command: "x", startedAtMs: 1, logPath: "/l", scope: "created", state: "exited", exitCode: null, exitSignal: null, exitedAtMs: 2, adopted: false };
  const [good, bad] = parseProcJobLedger(JSON.stringify({ version: 1, jobs: [
    { ...base, memoryMaxBytes: GB, exitReason: "memory_limit", memoryEnforcedBy: "kernel", scopeUnit: "raft-proc-6a37f503-web-rs" },
    { ...base, name: "bot", memoryMaxBytes: -1, exitReason: "other", memoryEnforcedBy: "x", scopeUnit: "../../etc" },
  ] }));
  assert.equal(good?.memoryMaxBytes, GB);
  assert.equal(good?.exitReason, "memory_limit");
  assert.equal(good?.memoryEnforcedBy, "kernel");
  assert.equal(good?.scopeUnit, "raft-proc-6a37f503-web-rs");
  for (const field of ["memoryMaxBytes", "exitReason", "memoryEnforcedBy", "scopeUnit"]) assert.equal(field in bad!, false, field);
});

test.skipIf(!posix)("a daemon start drops failed job scopes nothing reset, after the exits it found are classified", async () => {
  const calls: string[] = [];
  const machineDir = tempDir();
  const fake = fakeSystemd("running");
  const ops = {
    result: async (unit: string) => { calls.push(`result ${unit}`); return "oom-kill"; },
    resetFailed: async (unit: string) => { calls.push(`reset ${unit}`); },
  };
  const first = await manager({ machineDir, now: () => SCOPED_AT_MS, userSystemd: { pathEnv: fake.dir }, cgroup: scopeCgroup("raft-proc-6a37f503-web-rs", String(GB)), memoryMaxBytes: () => GB, scopeUnits: ops });
  await first.settled();
  calls.length = 0;
  const started = await first.start(UUID_AGENT, { name: "web", argv: ["sleep", "60"], cwd: tmpdir(), env: env(), stableEntryDir: null, runtime: "claude", launchId: null });
  assert.ok(started.ok, JSON.stringify(started));
  strays.push(started.job.pid);
  await waitFor(() => psCommand(started.job.pid) === "sleep 60");
  first.close();
  process.kill(-started.job.pid, "SIGKILL");
  await waitFor(() => !groupAlive(started.job.pid));
  await first.settled();
  calls.length = 0;
  const next = await manager({ machineDir, userSystemd: { pathEnv: fake.dir }, scopeUnits: ops });
  await next.settled();
  assert.deepEqual(calls, ["result raft-proc-6a37f503-web-rs", "reset raft-proc-6a37f503-web-rs", "reset raft-proc-*"]);
  const [job] = await next.list(UUID_AGENT);
  assert.equal(job?.exitReason, "memory_limit", "an OOM while no daemon watched is still recorded");
});

test.skipIf(!posix)("the owner's Stop: named by (agent, name), recorded owner_stop by the stopper, one notice; another agent's name, an unknown one and an exited job are told apart", async () => {
  const owners: Array<{ name: string; stoppedBy: string | null | undefined }> = [];
  let changes = 0;
  const machineDir = tempDir();
  const m = await manager({
    machineDir,
    onOwnerStop: (job) => owners.push({ name: job.name, stoppedBy: job.stoppedBy }),
    onChange: () => { changes += 1; },
  });
  const web = await startOk(m, AGENT, ["sleep", "60"], { name: "web" });
  assert.ok(changes > 0, "a start is a change");
  assert.equal(await m.stopByOwner(OTHER, "web", "tygg"), "not_found");
  assert.equal(await m.stopByOwner(AGENT, "nope", "tygg"), "not_found");
  assert.equal(await m.stopByOwner(AGENT, "../web", "tygg"), "not_found");
  assert.equal(groupAlive(web.pgid), true);
  assert.equal(await m.stopByOwner(AGENT, "web", "tygg"), "stopped");
  assert.equal(groupAlive(web.pgid), false);
  const [listed] = await m.list(AGENT);
  assert.equal(listed?.exitReason, "owner_stop");
  assert.equal(listed?.stoppedBy, "tygg");
  assert.equal(procJobToWire(listed!).stoppedBy, "tygg");
  assert.deepEqual(owners, [{ name: "web", stoppedBy: "tygg" }]);
  assert.equal(await m.stopByOwner(AGENT, "web", "tygg"), "already_exited");
  assert.equal(owners.length, 1);
  // The ledger keeps it for raft-computer and the next daemon.
  const [recorded] = parseProcJobLedger(readFileSync(path.join(machineDir, PROC_JOB_LEDGER_FILE), "utf8"));
  assert.equal(recorded?.stoppedBy, "tygg");
  // A stopper that isn't a handle is not kept: "stopped by a person".
  await startOk(m, AGENT, ["sleep", "60"], { name: "bot" });
  assert.equal(await m.stopByOwner(AGENT, "bot", "a b; rm -rf"), "stopped");
  const bot = (await m.list(AGENT)).find((job) => job.name === "bot");
  assert.equal(bot?.exitReason, "owner_stop");
  assert.equal(bot?.stoppedBy, undefined);
});

test.skipIf(!posix)("the owner's snapshot: name, state, times, exit and memory only, never the command, its arguments, directory, environment, log or pid", async () => {
  const cwd = tempDir();
  let used = new Map<number, number>();
  const m = await manager({
    machineDir: tempDir(),
    memoryMaxBytes: () => GB,
    memoryUsage: async (pgids) => new Map(pgids.filter((pgid) => used.has(pgid)).map((pgid) => [pgid, used.get(pgid)!])),
  });
  const job = await startOk(m, AGENT, ["sleep", "60", "--secret-token=hunter2"], { name: "web", cwd });
  used = new Map([[job.pgid, 300 * 1024 * 1024]]);
  await m.sampleMemory();
  const [snap] = m.snapshotJobs();
  assert.deepEqual(Object.keys(snap!).sort(), ["agentId", "exitCode", "exitReason", "exitSignal", "exitedAt", "memoryMaxBytes", "name", "rssBytes", "startedAt", "state", "stoppedBy"]);
  assert.equal(snap?.rssBytes, 300 * 1024 * 1024);
  assert.equal(snap?.memoryMaxBytes, GB);
  const text = JSON.stringify(m.snapshotJobs());
  for (const secret of ["sleep", "hunter2", cwd, job.logPath, "PATH"]) {
    assert.ok(!text.includes(secret), `snapshot leaks ${secret}`);
  }
  // Shared strict schema reads it as sent.
  const { safeParseProcJobsSnapshot } = await import("@botiverse/raft-shared");
  assert.ok(safeParseProcJobsSnapshot({ protocolVersion: 1, reportedAt: new Date().toISOString(), jobs: m.snapshotJobs() }).success);
  // An exited job carries no memory reading.
  assert.equal("rssBytes" in procJobToSnapshot({ ...job, state: "exited" }, 1), false);
});
