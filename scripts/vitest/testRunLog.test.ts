// The host's test-run log (testRunLog.ts, written by testSlot.ts) and its
// per-branch report (test-run-report.ts). Every log here is in a scratch dir
// (RAFT_TEST_RUN_LOG_DIR), never /var/tmp/raft-tests.
// Run by hand: pnpm exec vitest run scripts/vitest/testRunLog.test.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { STAMP_MAX_BYTES, STAMP_MAX_RUNS, filterRuns, parseRunLines, readRunLogs, resolveHeadSha, stampDocument, summarize } from "./test-run-report";
import { MAX_LINE_BYTES, type TestRunLine, appendRunLine, buildRunLine, testArgsOf } from "./testRunLog";

const moduleUrl = new URL("./testSlot.ts", import.meta.url).href;
const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const hasFlock = spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
const posix = typeof process.getuid === "function";
const it = test.skipIf(!hasFlock || !posix);
const uid = posix ? process.getuid!() : -1;

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = (child: ReturnType<typeof spawn>) => new Promise<number | null>((resolve) => child.on("exit", resolve));

/** A scratch dir with the slots in it and the log dir below. */
function scratch() {
  dir = mkdtempSync(join(tmpdir(), "raft-run-log-"));
  const logDir = join(dir, "log");
  return { logDir, log: join(logDir, `runs.${uid}.jsonl`) };
}

function readLines(log: string): TestRunLine[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const baseEnv = () => ({
  ...process.env,
  CI: "",
  GITHUB_ACTIONS: "",
  RAFT_TEST_NO_SLOT: "",
  RAFT_TEST_SLOT_HELD: "",
  RAFT_TEST_NO_RUN_LOG: "",
  RAFT_TEST_RUN_LOGGED: "",
  RAFT_TEST_SLOTS: "1",
  RAFT_DEV_CACHE: "0",
  RAFT_TEST_SLOT_DIR: dir!,
});

/** A launcher like the server/daemon runner (run-in-slot.ts), in the repo root. */
function launch(command: string[], env: Record<string, string>) {
  const script = `import { runInTestSlot } from ${JSON.stringify(moduleUrl)};
const r = await runInTestSlot(${JSON.stringify(command[0])}, ${JSON.stringify(command.slice(1))}, { stdio: "inherit" });
process.exitCode = r.status ?? 1;`;
  return spawn(process.execPath, ["--import", "@oxc-node/core/register", "--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: { ...baseEnv(), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** A Vitest started directly, as its config sees it: `run <args>`, then `body`. */
function direct(args: string[], body: string, env: Record<string, string>) {
  const script = `import { holdTestSlotForThisRun } from ${JSON.stringify(moduleUrl)};
process.argv.push("run", ...${JSON.stringify(args)});
await holdTestSlotForThisRun({ stdinIsTTY: false });
${body}`;
  return spawn(process.execPath, ["--import", "@oxc-node/core/register", "--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: { ...baseEnv(), ...env },
    stdio: "ignore",
  });
}

it("a run waits for the slot, then writes one line with its wait, duration and test files", async () => {
  const { logDir, log } = scratch();
  const holder = spawn("flock", [join(dir!, "0.lock"), "sleep", "2"], { stdio: "ignore" });
  await sleep(300);
  // A repo file, a path outside the repo (the script, /etc/passwd), a `..` path, a dotted flag's value.
  const runner = join(dir!, "run.sh");
  writeFileSync(runner, "sleep 1\n");
  const command = ["sh", runner, "scripts/vitest/testSlot.test.ts", "/etc/passwd", "scripts/../package.json", "--coverage.reporter", "html"];
  const code = await exited(launch(command, { RAFT_TEST_RUN_LOG_DIR: logDir }));
  holder.kill();
  expect(code).toBe(0);
  const lines = readLines(log);
  expect(lines).toHaveLength(1);
  const [line] = lines;
  expect(line).toMatchObject({ v: 1, via: "runInTestSlot", exitCode: 0, queued: true, package: "root" });
  expect(line!.lockWaitMs).toBeGreaterThanOrEqual(1000);
  expect(line!.runMs).toBeGreaterThanOrEqual(900);
  expect(line!.args).toEqual(["scripts/vitest/testSlot.test.ts"]);
  expect(line!.head).toMatch(/^[0-9a-f]{40}$/);
  expect(line!.worktreeHash).toMatch(/^[0-9a-f]{12}$/);
  expect(line!.worktree).not.toContain("/");
  // Created 0644 for its owner, not world-writable.
  expect(statSync(log).mode & 0o777).toBe(0o644);
}, 20000);

it("a failing run records its exit code", async () => {
  const { logDir, log } = scratch();
  const code = await exited(launch(["sh", "-c", "exit 3"], { RAFT_TEST_RUN_LOG_DIR: logDir }));
  expect(code).toBe(3);
  const lines = readLines(log);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ exitCode: 3, signal: null, lockWaitMs: 0 });
});

it("a cancelled run is logged from the launcher's exit, with its exit status", async () => {
  const { logDir, log } = scratch();
  const launcher = launch(["sleep", "30"], { RAFT_TEST_RUN_LOG_DIR: logDir });
  await sleep(1500);
  launcher.kill("SIGTERM");
  expect(await exited(launcher)).toBe(143);
  const lines = readLines(log);
  expect(lines).toHaveLength(1);
  // The launcher's 143, not the killed command's status (signal SIGTERM).
  expect(lines[0]).toMatchObject({ exitCode: 143, signal: null });
  expect(lines[0]!.runMs).toBeGreaterThan(500);
}, 15000);

it("RAFT_TEST_NO_RUN_LOG=1 and CI write nothing", async () => {
  const { logDir } = scratch();
  expect(await exited(launch(["true"], { RAFT_TEST_RUN_LOG_DIR: logDir, RAFT_TEST_NO_RUN_LOG: "1" }))).toBe(0);
  expect(await exited(launch(["true"], { RAFT_TEST_RUN_LOG_DIR: logDir, CI: "true" }))).toBe(0);
  expect(existsSync(logDir)).toBe(false);
});

it("an unwritable log path doesn't fail the run, and says once that the run was not recorded", async () => {
  scratch();
  // A dir below a regular file: every write fails (ENOTDIR), whoever runs it.
  writeFileSync(join(dir!, "file"), "");
  const launcher = launch(["sh", "-c", "exit 0"], { RAFT_TEST_RUN_LOG_DIR: join(dir!, "file", "log") });
  let stderr = "";
  launcher.stderr!.on("data", (chunk) => { stderr += chunk; });
  expect(await exited(launcher)).toBe(0);
  const warnings = stderr.split("\n").filter((line) => line.startsWith("raft test-run log: this run was not recorded"));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("ENOTDIR");
});

test.skipIf(!posix)("a symlink or hard link planted at the user's log file is not followed or changed", () => {
  const { logDir, log } = scratch();
  mkdirSync(logDir);
  const victim = join(dir!, "victim");
  writeFileSync(victim, "secret\n", { mode: 0o600 });
  symlinkSync(victim, log);
  expect(appendRunLine(makeLine({}), { env: { RAFT_TEST_RUN_LOG_DIR: logDir } })).toBe(false);
  rmSync(log);
  linkSync(victim, log);
  expect(appendRunLine(makeLine({}), { env: { RAFT_TEST_RUN_LOG_DIR: logDir } })).toBe(false);
  expect(readFileSync(victim, "utf8")).toBe("secret\n");
  expect(statSync(victim).mode & 0o777).toBe(0o600);
});

it("a FIFO planted at the user's log file doesn't hold up the run's exit", async () => {
  const { logDir, log } = scratch();
  mkdirSync(logDir);
  expect(spawnSync("mkfifo", [log]).status).toBe(0);
  const started = Date.now();
  const launcher = launch(["true"], { RAFT_TEST_RUN_LOG_DIR: logDir });
  // A blocking open would wait for a reader forever: kill it after 10 s.
  const timer = setTimeout(() => launcher.kill("SIGKILL"), 10000);
  const code = await exited(launcher);
  clearTimeout(timer);
  expect(code).toBe(0);
  // The run itself takes ~1 s (the watchdog's poll); the log step adds nothing to wait for.
  expect(Date.now() - started).toBeLessThan(5000);
  expect(statSync(log).isFIFO()).toBe(true);
}, 15000);

it("a run inside a logged run is not logged again, with the queue skipped (RAFT_TEST_NO_SLOT=1)", async () => {
  const { logDir, log } = scratch();
  const env = { RAFT_TEST_RUN_LOG_DIR: logDir, RAFT_TEST_NO_SLOT: "1" };
  // A launcher running a launcher.
  const inner = `import { runInTestSlot } from ${JSON.stringify(moduleUrl)}; await runInTestSlot("true", []);`;
  const nested = [process.execPath, "--import", "@oxc-node/core/register", "--input-type=module", "-e", inner];
  expect(await exited(launch(nested, env))).toBe(0);
  expect(readLines(log)).toHaveLength(1);
  // A Vitest started directly whose process starts another.
  rmSync(log);
  const child = `const { spawnSync } = await import("node:child_process");
spawnSync(process.execPath, ["--import", "@oxc-node/core/register", "--input-type=module", "-e", ${JSON.stringify(
    `import { holdTestSlotForThisRun } from ${JSON.stringify(moduleUrl)}; process.argv.push("run"); await holdTestSlotForThisRun({ stdinIsTTY: false });`,
  )}], { stdio: "ignore" });`;
  expect(await exited(direct([], child, env))).toBe(0);
  expect(readLines(log)).toHaveLength(1);
}, 20000);

it("a config loaded twice in one Vitest process logs its run once", async () => {
  const { logDir, log } = scratch();
  // Each load with its own env object taken before either ran: only the
  // per-process guard sees the second (the env marker is on the first's object).
  const script = `import { holdTestSlotForThisRun } from ${JSON.stringify(moduleUrl)};
process.argv.push("run");
const first = { ...process.env };
const second = { ...process.env };
await holdTestSlotForThisRun({ stdinIsTTY: false, env: first });
await holdTestSlotForThisRun({ stdinIsTTY: false, env: second });`;
  const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", "--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: { ...baseEnv(), RAFT_TEST_RUN_LOG_DIR: logDir, RAFT_TEST_NO_SLOT: "1" },
    stdio: "ignore",
  });
  expect(await exited(child)).toBe(0);
  expect(readLines(log)).toHaveLength(1);
});

it("a Vitest started directly logs its run when its process exits", async () => {
  const { logDir, log } = scratch();
  const body = `await new Promise((r) => setTimeout(r, 500)); process.exitCode = 1;`;
  const child = direct(["scripts/vitest/testRunLog.test.ts", "--maxWorkers", "1"], body, { RAFT_TEST_RUN_LOG_DIR: logDir });
  expect(await exited(child)).toBe(1);
  const lines = readLines(log);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ via: "holdTestSlotForThisRun", exitCode: 1, queued: true, args: ["scripts/vitest/testRunLog.test.ts"] });
  expect(lines[0]!.runMs).toBeGreaterThanOrEqual(400);
});

function makeLine(over: Partial<TestRunLine>): TestRunLine {
  return {
    v: 1,
    via: "runInTestSlot",
    startedAt: "2026-11-12T10:00:00.000Z",
    endedAt: "2026-11-12T10:01:00.000Z",
    lockWaitMs: 1000,
    runMs: 59000,
    exitCode: 0,
    signal: null,
    queued: true,
    package: "server",
    args: ["packages/server/src/a.test.ts"],
    branch: "agent/a",
    head: "a".repeat(40),
    worktree: "wt",
    worktreeHash: "0123456789ab",
    user: "u",
    agentId: null,
    ...over,
  };
}

test.skipIf(!posix)("a line stays within PIPE_BUF: strings capped, a bad agent id dropped, trailing args dropped, else skipped", () => {
  const { logDir, log } = scratch();
  const env = { RAFT_TEST_RUN_LOG_DIR: logDir, USER: "u".repeat(5000), SLOCK_AGENT_ID: "A".repeat(5000) };
  const line = buildRunLine({ via: "runInTestSlot", startedAt: 0, heldAt: 0, endedAt: 1, exitCode: 0, queued: false, cwd: repoRoot, args: [], package: "p".repeat(5000) }, env);
  expect(line.user).toHaveLength(256);
  expect(line.package).toHaveLength(256);
  expect(line.agentId).toBeNull();
  expect(buildRunLine({ via: "runInTestSlot", startedAt: 0, heldAt: 0, endedAt: 1, exitCode: 0, queued: false, cwd: repoRoot }, { SLOCK_AGENT_ID: "b41f36f6-803d" }).agentId).toBe("b41f36f6-803d");
  const args = Array.from({ length: 200 }, (_, i) => `packages/server/src/some/deep/path/file-${i}.test.ts`);
  expect(appendRunLine(makeLine({ args }), { env })).toBe(true);
  expect(Buffer.byteLength(readFileSync(log, "utf8"))).toBeLessThanOrEqual(MAX_LINE_BYTES);
  const [written] = readLines(log);
  expect(written!.args.length + written!.argsDropped!).toBe(200);
  // Too big even with no args: not written at all.
  expect(appendRunLine(makeLine({ args: [], user: "x".repeat(5000) }), { env })).toBe(false);
  expect(readLines(log)).toHaveLength(1);
});

test.skipIf(!posix)("over the size cap the file is rotated to a unique name; the newest 3 rotated files are kept", async () => {
  const { logDir, log } = scratch();
  const env = { RAFT_TEST_RUN_LOG_DIR: logDir };
  for (let i = 0; i < 6; i += 1) {
    expect(appendRunLine(makeLine({ runMs: i }), { env, maxBytes: 10 })).toBe(true);
    await sleep(3);
  }
  const rotated = readdirSync(logDir).filter((name) => new RegExp(`^runs\\.${uid}\\.\\d+\\.${process.pid}\\.jsonl$`).test(name));
  expect(rotated).toHaveLength(3);
  expect(readLines(log).map((l) => l.runMs)).toEqual([5]);
  // The report reads the rotated files too: runs 2, 3, 4 and 5.
  expect(readRunLogs(logDir).runs.map((r) => r.runMs).sort()).toEqual([2, 3, 4, 5]);
});

test("test args: flags, flag values and subcommands dropped; paths repo-relative, none outside or with ..", () => {
  expect(
    testArgsOf(
      ["run", "-t", "name", "src/a.test.ts", "--bail", "1", "--sequence.seed", "7", "--maxWorkers", "2", "/abs/out.ts", "/r/packages/web/x.test.ts", "../b.test.ts", "src/../c.test.ts"],
      "/r",
      "/r/packages/server",
    ),
  ).toEqual(["packages/server/src/a.test.ts", "packages/web/x.test.ts"]);
});

test("the report validates lines and drops the invalid ones", () => {
  const good = makeLine({});
  const bad = [
    { ...good, args: "a.test.ts" },
    { ...good, args: [1] },
    { ...good, exitCode: 1.5 },
    { ...good, head: "abc" },
    { ...good, runMs: -1 },
    { ...good, lockWaitMs: "5" },
    { ...good, v: 2 },
  ];
  const text = [good, ...bad].map((l) => JSON.stringify(l)).concat("{torn").join("\n");
  const { lines, invalid } = parseRunLines(text);
  expect(lines).toHaveLength(1);
  expect(invalid).toBe(bad.length + 1);
});

test.skipIf(!posix)("the report reads every user's file and attributes runs by the file's owner", () => {
  scratch();
  writeFileSync(join(dir!, `runs.${uid}.jsonl`), `${JSON.stringify(makeLine({}))}\n`);
  // A file named for another uid but owned by us: skipped.
  writeFileSync(join(dir!, `runs.${uid + 1}.jsonl`), `${JSON.stringify(makeLine({ branch: "agent/planted" }))}\n`);
  const { runs, skippedFiles } = readRunLogs(dir!);
  expect(runs.map((r) => [r.branch, r.uid])).toEqual([["agent/a", uid]]);
  expect(skippedFiles).toBe(1);
  expect(filterRuns(runs, { uid: uid + 1 })).toEqual([]);
});

test("the report sums runs per branch; a detached HEAD is (detached)", () => {
  const lines = [
    makeLine({}),
    makeLine({ startedAt: "2026-11-12T11:00:00.000Z", exitCode: 1, lockWaitMs: 500, runMs: 1000, args: ["packages/server/src/a.test.ts", "packages/server/src/b.test.ts"] }),
    makeLine({ branch: null, startedAt: "2026-11-12T09:00:00.000Z", args: [] }),
    makeLine({ startedAt: "2026-11-11T09:00:00.000Z" }),
  ];
  const branches = summarize(filterRuns(lines, { since: "2026-11-12T00:00:00Z" }));
  expect(branches).toEqual([
    { branch: "agent/a", runs: 2, failures: 1, lockWaitMs: 1500, runMs: 60000, distinctFiles: 2, firstRunAt: "2026-11-12T10:00:00.000Z", lastRunAt: "2026-11-12T11:00:00.000Z" },
    { branch: "(detached)", runs: 1, failures: 0, lockWaitMs: 1000, runMs: 59000, distinctFiles: 1, firstRunAt: "2026-11-12T09:00:00.000Z", lastRunAt: "2026-11-12T09:00:00.000Z" },
  ]);
});

test("--json: Stamp's document for one branch, the 50 most recent runs, oldest first, compact", () => {
  const lines = Array.from({ length: 60 }, (_, i) =>
    makeLine({ startedAt: new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString(), exitCode: i === 59 ? null : 0, signal: i === 59 ? "SIGTERM" : null }),
  );
  lines.push(makeLine({ branch: "agent/other" }));
  const { doc, text, notes } = stampDocument(filterRuns(lines, { branch: "agent/a" }), { branch: "agent/a", headSha: "b".repeat(40) });
  expect(text).toBe(`${JSON.stringify(doc)}\n`);
  expect(doc.version).toBe(1);
  expect(doc.head_sha).toBe("b".repeat(40));
  expect(doc.runs).toHaveLength(STAMP_MAX_RUNS);
  expect(doc.runs[0]!.started_at).toBe("2026-11-12T00:10:00.000Z");
  expect(doc.runs.at(-1)).toEqual({
    started_at: "2026-11-12T00:59:00.000Z",
    duration_ms: 59000,
    lock_wait_ms: 1000,
    exit_code: 143,
    head_sha: "a".repeat(40),
    files: ["packages/server/src/a.test.ts"],
  });
  expect(notes.join("\n")).toContain("dropped the 10 oldest runs");
});

test("--json: the 256 KB cap applies to the exact printed text", () => {
  const long = (i: number, j: number) => `packages/server/src/some/deeper/path/${"x".repeat(80)}-${i}-${j}.test.ts`;
  const lines = Array.from({ length: 50 }, (_, i) =>
    makeLine({ startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), args: Array.from({ length: 40 }, (_, j) => long(i, j)) }),
  );
  const { text, notes } = stampDocument(lines, { branch: "agent/a", headSha: null });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(STAMP_MAX_BYTES);
  expect(notes.join("\n")).toContain("under 262144 bytes");
});

test("--json: head_sha is --head, else HEAD on that branch, else its local tip, else null with a note", () => {
  const here = { branch: "agent/a", head: "a".repeat(40) };
  const tips: Record<string, string> = { "agent/b": "b".repeat(40) };
  const tipOf = (branch: string) => tips[branch] ?? null;
  expect(resolveHeadSha("agent/gone", { explicit: "c".repeat(40), current: here, tipOf })).toEqual({ headSha: "c".repeat(40), note: null });
  expect(resolveHeadSha("agent/a", { explicit: null, current: here, tipOf })).toEqual({ headSha: "a".repeat(40), note: null });
  // Another branch: never the HEAD checked out here.
  const other = resolveHeadSha("agent/b", { explicit: null, current: here, tipOf });
  expect(other.headSha).toBe("b".repeat(40));
  expect(other.note).toContain("local tip of agent/b");
  const gone = resolveHeadSha("agent/gone", { explicit: null, current: here, tipOf });
  expect(gone.headSha).toBe(null);
  expect(gone.note).toContain("pass --head");
});

test("--head: only with --json, and only a full sha", async () => {
  const { main } = await import("./test-run-report");
  const err = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  const dir = mkdtempSync(join(tmpdir(), "trr-head-"));
  try {
    expect(main(["--branch", "agent/a", "--head", "a".repeat(40)])).toBe(2);
    expect(errors.join("\n")).toContain("only with --json");
    errors.length = 0;
    expect(main(["--branch", "agent/a", "--json", "--head", "abc123"])).toBe(2);
    expect(errors.join("\n")).toContain("not a full 40-hex commit sha");
    errors.length = 0;
    expect(main(["--branch", "agent/a", "--json", "--head"])).toBe(2);
    expect(errors.join("\n")).toContain("--head needs a commit sha");
    // A valid --head reaches the document, upper case read as lower case.
    expect(main(["--branch", "agent/a", "--json", "--head", "C".repeat(40), "--dir", dir])).toBe(0);
    expect(JSON.parse(out).head_sha).toBe("c".repeat(40));
  } finally {
    console.error = err;
    process.stdout.write = write;
    rmSync(dir, { recursive: true, force: true });
  }
});
