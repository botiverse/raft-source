// The host's test-slot queue (testSlot.ts): a cancelled run frees its slot
// and leaves no process behind, and a run waits while the slots are taken.
// Run by hand: pnpm exec vitest run scripts/vitest/testSlot.test.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { MACHINE_SLOT_DIR, holdTestSlotForThisRun } from "./testSlot";

const moduleUrl = new URL("./testSlot.ts", import.meta.url).href;
const hasFlock = spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
const it = test.skipIf(!hasFlock || process.platform === "win32");

let dir = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Is the slot file taken right now? (a non-blocking flock that holds nothing) */
function slotTaken(slot) {
  return spawnSync("flock", ["-n", "-E", "213", slot, "true"]).status === 213;
}

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return false;
}

/** A launcher like the web runner: one test command run in a slot. */
function launch(command, env) {
  const script = `import { runInTestSlot } from ${JSON.stringify(moduleUrl)};
const r = await runInTestSlot(${JSON.stringify(command[0])}, ${JSON.stringify(command.slice(1))}, { stdio: "inherit" });
process.exitCode = r.status ?? 1;`;
  return spawn(process.execPath, ["--import", "@oxc-node/core/register", "--input-type=module", "-e", script], {
    env: { ...process.env, CI: "", RAFT_TEST_NO_SLOT: "", RAFT_TEST_SLOTS: "1", RAFT_TEST_SLOT_DIR: dir, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

it("the slots live in one fixed directory for the whole machine", () => {
  expect(MACHINE_SLOT_DIR).toBe("/var/tmp/raft-tests/slots");
});

it("cancelling the launcher frees its slot and leaves no process of the run behind", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const slot = join(dir, "0.lock");
  // A run with a child of its own, as Vitest has workers.
  const marker = `${30 + Math.floor(Math.random() * 1000) / 1000}`;
  const launcher = launch(["sh", "-c", `sleep ${marker} & sleep ${marker}; wait`]);
  expect(await waitFor(() => slotTaken(slot))).toBe(true);
  launcher.kill("SIGTERM");
  expect(await waitFor(() => !slotTaken(slot))).toBe(true);
  // No sleep of the run is left (anchored: the launcher's -e script and the
  // watchdog's command line name the marker too).
  const left = () => spawnSync("pgrep", ["-f", `^sleep ${marker}`], { encoding: "utf8" }).stdout.trim();
  expect(await waitFor(() => left() === "", 3000)).toBe(true);
});

it("a launcher killed outright (SIGKILL) still frees its slot: the group's watchdog ends the run", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const slot = join(dir, "0.lock");
  const marker = `${30 + Math.floor(Math.random() * 1000) / 1000}`;
  const launcher = launch(["sh", "-c", `sleep ${marker} & sleep ${marker}; wait`]);
  expect(await waitFor(() => slotTaken(slot))).toBe(true);
  launcher.kill("SIGKILL");
  // The watchdog notices within a second, then gives the run its grace period.
  expect(await waitFor(() => !slotTaken(slot), 10000)).toBe(true);
  const left = () => spawnSync("pgrep", ["-f", `^sleep ${marker}`], { encoding: "utf8" }).stdout.trim();
  expect(await waitFor(() => left() === "", 3000)).toBe(true);
}, 20000);

it("a child that ignores SIGTERM is still ended (SIGKILL after the grace period)", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const slot = join(dir, "0.lock");
  const marker = `${30 + Math.floor(Math.random() * 1000) / 1000}`;
  const launcher = launch(["sh", "-c", `trap '' TERM; sleep ${marker}`]);
  expect(await waitFor(() => slotTaken(slot))).toBe(true);
  launcher.kill("SIGKILL");
  expect(await waitFor(() => !slotTaken(slot), 12000)).toBe(true);
  const left = () => spawnSync("pgrep", ["-f", `^sleep ${marker}`], { encoding: "utf8" }).stdout.trim();
  expect(await waitFor(() => left() === "", 3000)).toBe(true);
}, 25000);

it("waits while every slot is taken, then runs", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const slot = join(dir, "0.lock");
  const holder = spawn("flock", [slot, "sleep", "2"], { stdio: "ignore" });
  expect(await waitFor(() => slotTaken(slot))).toBe(true);
  const started = Date.now();
  const launcher = launch(["true"]);
  let stderr = "";
  launcher.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => launcher.on("exit", resolve));
  expect(code).toBe(0);
  expect(stderr).toContain("waiting for another test run to finish");
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  holder.kill();
});

/** A Vitest started directly, as far as its config sees: holds a slot, then works for `seconds`. */
function direct(seconds, env = {}, args = ["run"]) {
  const script = `import { holdTestSlotForThisRun } from ${JSON.stringify(moduleUrl)};
process.argv.push(...${JSON.stringify(args)});
const held = await holdTestSlotForThisRun({ stdinIsTTY: false });
console.log(held ? "held" : "unqueued");
await new Promise((r) => setTimeout(r, ${seconds * 1000}));`;
  const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", "--input-type=module", "-e", script], {
    env: { ...process.env, CI: "", RAFT_TEST_NO_SLOT: "", RAFT_TEST_SLOT_HELD: "", RAFT_TEST_SLOTS: "1", RAFT_TEST_SLOT_DIR: dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  return { child, out: () => out, err: () => err };
}

it("a Vitest started directly holds a slot while it runs and frees it when it exits", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const slot = join(dir, "0.lock");
  const run = direct(1);
  expect(await waitFor(() => run.out().includes("held"))).toBe(true);
  expect(slotTaken(slot)).toBe(true);
  await new Promise((resolve) => run.child.on("exit", resolve));
  expect(await waitFor(() => !slotTaken(slot), 3000)).toBe(true);
});

it("a second direct run waits for the slot, then starts", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const first = direct(2);
  expect(await waitFor(() => first.out().includes("held"))).toBe(true);
  const started = Date.now();
  const second = direct(0);
  expect(await waitFor(() => second.out().includes("held"), 10000)).toBe(true);
  expect(second.err()).toContain("waiting for another test run to finish");
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
}, 15000);

it("a direct run killed outright (SIGKILL) frees its slot within a few seconds", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const slot = join(dir, "0.lock");
  const run = direct(30);
  expect(await waitFor(() => run.out().includes("held"))).toBe(true);
  run.child.kill("SIGKILL");
  expect(await waitFor(() => !slotTaken(slot), 5000)).toBe(true);
});

it("takes no slot under a runner that holds one, in watch mode, or in CI", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const env = { RAFT_TEST_SLOT_DIR: dir, RAFT_TEST_SLOTS: "1" };
  expect(await holdTestSlotForThisRun({ env: { ...env, RAFT_TEST_SLOT_HELD: "1" }, argv: ["node", "vitest", "run"] })).toBe(false);
  expect(await holdTestSlotForThisRun({ env, argv: ["node", "vitest", "--watch"] })).toBe(false);
  expect(await holdTestSlotForThisRun({ env, argv: ["node", "vitest"], stdinIsTTY: true })).toBe(false);
  expect(await holdTestSlotForThisRun({ env: { ...env, CI: "true" }, argv: ["node", "vitest", "run"] })).toBe(false);
  expect(slotTaken(join(dir, "0.lock"))).toBe(false);
});

it("a run under runInTestSlot tells the Vitest inside that it already holds a slot", async () => {
  dir = mkdtempSync(join(tmpdir(), "raft-test-slot-"));
  const launcher = launch(["sh", "-c", 'test "$RAFT_TEST_SLOT_HELD" = 1']);
  const code = await new Promise((resolve) => launcher.on("exit", resolve));
  expect(code).toBe(0);
});

// The run's temp dir (scripts/dev/raftdev-cache.ts): runInTestSlot gives the
// command TMPDIR=<root>/j/<agent>/<run>/tmp and removes it when the run ends,
// normally or cancelled; a nested launcher reuses its parent's. The root is a
// scratch dir (RAFT_DEV_CACHE_DIR); no queue (RAFT_TEST_NO_SLOT=1).
function launchWithRunDir(command, env) {
  const script = `import { runInTestSlot } from ${JSON.stringify(moduleUrl)};
const r = await runInTestSlot(${JSON.stringify(command[0])}, ${JSON.stringify(command.slice(1))}, { stdio: "inherit" });
process.exitCode = r.status ?? 1;`;
  const childEnv = { ...process.env, CI: "", GITHUB_ACTIONS: "", RAFT_DEV_CACHE: "", RAFT_TEST_NO_SLOT: "1", ...env };
  for (const name of ["TMPDIR", "NODE_COMPILE_CACHE", "RAFT_DEV_RUN_DIR"]) if (!(name in env)) delete childEnv[name];
  return spawn(process.execPath, ["--import", "@oxc-node/core/register", "--input-type=module", "-e", script], {
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

const reportTmp = (out, then = "") => ["sh", "-c", `printf '%s|%s' "$TMPDIR" "$RAFT_DEV_RUN_DIR" > ${out}.part && mv ${out}.part ${out}${then}`];
const readReport = (out) => readFileSync(out, "utf8").split("|");
// Short scratch root: a root too long for AF_UNIX socket paths keeps TMPDIR.
const runDirTest = (name, fn) => test.skipIf(process.platform !== "linux" || join(tmpdir(), "rs-XXXXXX").length > 40)(name, fn);

runDirTest("the run gets its own TMPDIR on disk, removed when it ends", async () => {
  dir = mkdtempSync(join(tmpdir(), "rs-"));
  const out = join(dir, "out");
  const launcher = launchWithRunDir(reportTmp(out), { RAFT_DEV_CACHE_DIR: dir });
  const code = await new Promise((resolve) => launcher.on("exit", resolve));
  expect(code).toBe(0);
  const [tmp, runDir] = readReport(out);
  expect(tmp).toBe(join(runDir, "tmp"));
  expect(runDir.startsWith(join(dir, "j") + "/")).toBe(true);
  expect(existsSync(runDir)).toBe(false);
});

runDirTest("a cancelled run's TMPDIR is removed too", async () => {
  dir = mkdtempSync(join(tmpdir(), "rs-"));
  const out = join(dir, "out");
  const launcher = launchWithRunDir(reportTmp(out, "; sleep 30"), { RAFT_DEV_CACHE_DIR: dir });
  expect(await waitFor(() => existsSync(out))).toBe(true);
  const [, runDir] = readReport(out);
  expect(existsSync(runDir)).toBe(true);
  launcher.kill("SIGTERM");
  await new Promise((resolve) => launcher.on("exit", resolve));
  expect(existsSync(runDir)).toBe(false);
});

runDirTest("a launcher inside a run reuses the parent's TMPDIR and leaves it in place", async () => {
  dir = mkdtempSync(join(tmpdir(), "rs-"));
  const out = join(dir, "out");
  const parent = join(dir, "parent");
  mkdirSync(join(parent, "tmp"), { recursive: true });
  const launcher = launchWithRunDir(reportTmp(out), { RAFT_DEV_CACHE_DIR: dir, RAFT_DEV_RUN_DIR: parent, TMPDIR: join(parent, "tmp") });
  const code = await new Promise((resolve) => launcher.on("exit", resolve));
  expect(code).toBe(0);
  expect(readReport(out)).toEqual([join(parent, "tmp"), parent]);
  expect(existsSync(join(parent, "tmp"))).toBe(true);
  expect(existsSync(join(dir, "j"))).toBe(false);
});
