import assert from "node:assert/strict";
import { test } from "vitest";
import { parseRuntimeDetectionChildLine, runRuntimeDetectionChildMain } from "./runtimeDetectionChild";
import { defaultRuntimeDetectionSelfExec, runRuntimeDetectionRound, runtimeDetectionDeadlineMs, RUNTIME_DETECTION_ROUND_DEADLINE_MS } from "./runtimeDetectionRound";

const KNOWN = ["claude", "codex", "grok"];

/** A real Node child that speaks the line protocol (`-e` script), so the kill/deadline paths are exercised for real. */
function nodeChild(script: string) {
  return { command: process.execPath, args: ["-e", script] };
}

const emit = (obj: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(obj))} + "\\n");`;

test("task #1268: parseRuntimeDetectionChildLine accepts checked/done/error and rejects noise", () => {
  assert.deepEqual(parseRuntimeDetectionChildLine('{"event":"checked","runtime":"claude","available":true,"version":"1.2.3"}'), { event: "checked", runtime: "claude", available: true, version: "1.2.3" });
  assert.deepEqual(parseRuntimeDetectionChildLine('{"event":"done","detection":{"ids":["claude"],"versions":{}}}'), { event: "done", detection: { ids: ["claude"], versions: {} } });
  assert.deepEqual(parseRuntimeDetectionChildLine('{"event":"error","message":"boom"}'), { event: "error", message: "boom" });
  assert.equal(parseRuntimeDetectionChildLine("npm WARN something"), null);
  assert.equal(parseRuntimeDetectionChildLine('{"event":"checked","runtime":5}'), null);
  assert.equal(parseRuntimeDetectionChildLine(""), null);
});

test("task #1268: child main streams one checked line per runtime then done, exit 0; a throwing round reports error, exit 1", async () => {
  const lines: string[] = [];
  const code = await runRuntimeDetectionChildMain({
    write: (line) => lines.push(line),
    detect: (hooks) => {
      hooks.onRuntimeChecked({ runtime: "claude", available: true, version: "1.0.0" });
      hooks.onRuntimeChecked({ runtime: "codex", available: false, unavailableReason: "not_installed" });
      return { ids: ["claude"], versions: { claude: "1.0.0" }, unavailableReasons: { codex: "not_installed" } };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(lines.map((line) => parseRuntimeDetectionChildLine(line)?.event), ["checked", "checked", "done"]);
  const failing: string[] = [];
  const failCode = await runRuntimeDetectionChildMain({ write: (line) => failing.push(line), detect: () => { throw new Error("probe exploded"); } });
  assert.equal(failCode, 1);
  assert.deepEqual(parseRuntimeDetectionChildLine(failing[0] ?? ""), { event: "error", message: "probe exploded" });
});

test("task #1268: a complete round returns the child's final detection", async () => {
  const script = [
    emit({ event: "checked", runtime: "claude", available: true, version: "2.0.0" }),
    emit({ event: "checked", runtime: "codex", available: false, unavailableReason: "not_installed" }),
    emit({ event: "checked", runtime: "grok", available: false }),
    emit({ event: "done", detection: { ids: ["claude"], versions: { claude: "2.0.0" }, unavailableReasons: { codex: "not_installed" } } }),
  ].join("");
  const result = await runRuntimeDetectionRound({ knownRuntimeIds: KNOWN, selfExec: nodeChild(script), deadlineMs: 20_000 }).result;
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.detection, { ids: ["claude"], versions: { claude: "2.0.0" }, unavailableReasons: { codex: "not_installed" } });
  assert.ok(result.durationMs >= 0);
});

test("task #1268: the deadline kills a stalled child, keeps the runtimes it did report, and names the unfinished ones", async () => {
  const script = [
    emit({ event: "checked", runtime: "claude", available: true, version: "2.0.0" }),
    "setTimeout(() => {}, 60000);",
  ].join("");
  const killed: number[] = [];
  const handle = runRuntimeDetectionRound({
    knownRuntimeIds: KNOWN,
    selfExec: nodeChild(script),
    deadlineMs: 1500,
    killTree: (pid, platform) => {
      killed.push(pid);
      try { process.platform === "win32" ? process.kill(pid) : process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      void platform;
    },
  });
  const startedAt = Date.now();
  const result = await handle.result;
  assert.equal(result.status, "incomplete");
  if (result.status !== "incomplete") return;
  assert.equal(result.reason, "deadline");
  assert.deepEqual(result.detection.ids, ["claude"]);
  assert.deepEqual(result.unfinishedRuntimes, ["codex", "grok"]);
  assert.equal(killed.length, 1, "the child's process tree is killed exactly once");
  assert.ok(Date.now() - startedAt < 10_000, "settles at the deadline, not when the child would have ended");
});

test("task #1268: a child that exits without done is child_failed with the partial inventory and its error line", async () => {
  const script = [
    emit({ event: "checked", runtime: "claude", available: false, unavailableReason: "probe_timeout" }),
    emit({ event: "error", message: "detector threw" }),
    "process.exit(1);",
  ].join("");
  const result = await runRuntimeDetectionRound({ knownRuntimeIds: KNOWN, selfExec: nodeChild(script), deadlineMs: 20_000 }).result;
  assert.equal(result.status, "incomplete");
  if (result.status !== "incomplete") return;
  assert.equal(result.reason, "child_failed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.detail, "detector threw");
  assert.deepEqual(result.detection.unavailableReasons, { claude: "probe_timeout" });
  assert.deepEqual(result.unfinishedRuntimes, ["codex", "grok"]);
});

test("task #1268: an unspawnable child is child_failed with every runtime unfinished", async () => {
  const result = await runRuntimeDetectionRound({
    knownRuntimeIds: KNOWN,
    selfExec: { command: "/nonexistent/raft-daemon-detect-child", args: [] },
    deadlineMs: 20_000,
  }).result;
  assert.equal(result.status, "incomplete");
  if (result.status !== "incomplete") return;
  assert.equal(result.reason, "child_failed");
  assert.match(result.detail ?? "", /spawn (error|threw) ENOENT/);
  assert.deepEqual(result.unfinishedRuntimes, KNOWN);
});

test("task #1268: cancel kills the tree and settles as cancelled; a late done never flips the result", async () => {
  const script = [
    emit({ event: "checked", runtime: "claude", available: true }),
    "setTimeout(() => { " + emit({ event: "done", detection: { ids: ["claude", "codex", "grok"], versions: {} } }) + " }, 3000);",
  ].join("");
  const killed: number[] = [];
  const handle = runRuntimeDetectionRound({
    knownRuntimeIds: KNOWN,
    selfExec: nodeChild(script),
    deadlineMs: 20_000,
    killTree: (pid) => { killed.push(pid); try { process.platform === "win32" ? process.kill(pid) : process.kill(-pid, "SIGKILL"); } catch { /* gone */ } },
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  handle.cancel();
  const result = await handle.result;
  assert.equal(result.status, "incomplete");
  if (result.status !== "incomplete") return;
  assert.equal(result.reason, "cancelled");
  assert.deepEqual(result.detection.ids, ["claude"]);
  assert.deepEqual(result.unfinishedRuntimes, ["codex", "grok"]);
  assert.equal(killed.length, 1);
  handle.cancel(); // idempotent
  assert.equal(killed.length, 1);
});

test("task #1268: deadline default and env override; self-exec re-runs this entry in child mode", () => {
  assert.equal(RUNTIME_DETECTION_ROUND_DEADLINE_MS, 90_000);
  assert.equal(runtimeDetectionDeadlineMs({}), 90_000);
  assert.equal(runtimeDetectionDeadlineMs({ RAFT_RUNTIME_DETECTION_DEADLINE_MS: "15000" }), 15_000);
  assert.equal(runtimeDetectionDeadlineMs({ RAFT_RUNTIME_DETECTION_DEADLINE_MS: "5" }), 90_000);
  const selfExec = defaultRuntimeDetectionSelfExec();
  assert.equal(selfExec.command, process.execPath);
  assert.equal(selfExec.args[selfExec.args.length - 1], "__detect-runtimes");
});

// The detection child is the running program again, and argv[1] means a
// different thing per host. Packaged Raft Desktop's `__run` has argv
// `[<app>, "", "__run", <id>]`; replaying argv[1] made the child
// `<app> "" __detect-runtimes`, which the app's argv guard did not route, so it
// booted (or, with the GUI open, quit as) a second GUI instance: child_failed.
test("detection self-exec per host: node script, SEA, packaged and dev Electron app, Electron as Node", () => {
  const APP = "/Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop";
  const base = { execArgv: [] as string[], isSea: false };
  assert.deepEqual(
    defaultRuntimeDetectionSelfExec({ ...base, execPath: "/usr/bin/node", execArgv: ["--import", "@oxc-node/core/register"], argv: ["/usr/bin/node", "/repo/src/index.ts", "__run", "s"] }),
    { command: "/usr/bin/node", args: ["--import", "@oxc-node/core/register", "/repo/src/index.ts", "__detect-runtimes"] },
  );
  assert.deepEqual(
    defaultRuntimeDetectionSelfExec({ ...base, execPath: "/opt/raft-computer", argv: ["/opt/raft-computer", "__run", "s"], isSea: true }),
    { command: "/opt/raft-computer", args: ["__detect-runtimes"] },
  );
  assert.deepEqual(
    defaultRuntimeDetectionSelfExec({ ...base, execPath: APP, argv: [APP, "", "__run", "s"], electronVersion: "44.7.0", electronProcessType: "browser" }),
    { command: APP, args: ["__detect-runtimes"] },
  );
  assert.deepEqual(
    defaultRuntimeDetectionSelfExec({ ...base, execPath: "/e/Electron", argv: ["/e/Electron", ".", "__run", "s"], electronVersion: "44.7.0", electronProcessType: "browser", electronDefaultApp: true }),
    { command: "/e/Electron", args: [".", "__detect-runtimes"] },
  );
  assert.deepEqual(
    defaultRuntimeDetectionSelfExec({ ...base, execPath: APP, argv: [APP, "/app.asar/node_modules/@botiverse/raft-daemon/dist/index.js"], electronVersion: "44.7.0" }),
    { command: APP, args: ["/app.asar/node_modules/@botiverse/raft-daemon/dist/index.js", "__detect-runtimes"] },
  );
});

// Reviewer acceptance (Huaihuai, #9665): cleanup must be observed with the
// production helper on a real child + grandchild, and "kill requested" must
// never be reported as "cleaned up".
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function processAlive(pid: number): boolean {
  if (process.platform === "win32") {
    const listed = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
    return new RegExp(`\\b${pid}\\b`).test(listed);
  }
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processAlive(pid);
}

/** A child that spawns a sleeping grandchild, records its pid to a file, reports one runtime, then stalls. */
function childWithGrandchild(pidFile: string): { command: string; args: string[] } {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    emit({ event: "checked", runtime: "claude", available: true }),
    "setTimeout(() => {}, 60000);",
  ].join("");
  return nodeChild(script);
}

async function readGrandchildPid(pidFile: string): Promise<number> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("grandchild pid not recorded");
}

for (const mode of ["deadline", "cancelled"] as const) {
  test(`task #1268 (reviewer): ${mode} kills the real child AND its grandchild with the production tree kill, and reports the observed exit`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "raft-detect-tree-"));
    const pidFile = path.join(dir, "grandchild.pid");
    let grandchild = 0;
    try {
      const handle = runRuntimeDetectionRound({
        knownRuntimeIds: KNOWN,
        selfExec: childWithGrandchild(pidFile),
        deadlineMs: mode === "deadline" ? 1500 : 60_000,
      });
      grandchild = await readGrandchildPid(pidFile);
      assert.ok(processAlive(grandchild), "grandchild is running before the kill");
      if (mode === "cancelled") handle.cancel();
      const result = await handle.result;
      assert.equal(result.status, "incomplete");
      if (result.status !== "incomplete") return;
      assert.equal(result.reason, mode);
      assert.deepEqual(result.detection.ids, ["claude"]);
      assert.deepEqual(result.unfinishedRuntimes, ["codex", "grok"]);
      assert.deepEqual(result.cleanup, { childExited: true, waitedMs: result.cleanup!.waitedMs }, "the child's exit was observed, not assumed");
      assert.ok(result.cleanup!.waitedMs < 5000);
      assert.equal(await waitUntilGone(grandchild, 5000), true, "the grandchild is gone too");
    } finally {
      if (grandchild) { try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("task #1268 (reviewer): a kill that does not take effect is reported as unconfirmed cleanup, not as success", async () => {
  const script = [emit({ event: "checked", runtime: "claude", available: true }), "setTimeout(() => {}, 60000);"].join("");
  let childPid = 0;
  const handle = runRuntimeDetectionRound({
    knownRuntimeIds: KNOWN,
    selfExec: nodeChild(script),
    deadlineMs: 500,
    cleanupVerifyMs: 300,
    killTree: (pid) => { childPid = pid; /* deliberately does nothing: simulates a kill that fails silently */ },
  });
  try {
    const result = await handle.result;
    assert.equal(result.status, "incomplete");
    if (result.status !== "incomplete") return;
    assert.equal(result.reason, "deadline");
    assert.equal(result.cleanup?.childExited, false, "the exit was not observed within the verification window");
    // Not observed → waitedMs is the configured window itself (the timer that
    // ended the wait defines it), never a wall-clock reading that libuv's
    // coarse timer clock can leave at 299 (CI run 38414371846).
    assert.equal(result.cleanup?.waitedMs, 300);
    assert.ok(processAlive(childPid), "and indeed the child is still alive");
  } finally {
    if (childPid) { try { process.platform === "win32" ? process.kill(childPid) : process.kill(-childPid, "SIGKILL"); } catch { /* gone */ } }
  }
});
