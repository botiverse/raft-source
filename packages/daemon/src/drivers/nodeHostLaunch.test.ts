import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectNodeHostKind, ELECTRON_NODE_SCRIPT_EXEC_ARGV, NodeHostUnavailableError, resolveNodeHostLaunch, seaDetected } from "./nodeHostLaunch";

/**
 * The defect this pins: `exec_path_is_node: !versions.electron` inferred "is
 * node" from "is not Electron", so a SEA host — the shape every official
 * installer ships — reported as node. The diagnostic said healthy on exactly
 * the configuration that was broken.
 *
 * These assert the SEA case explicitly rather than only node/electron,
 * because a two-way test passes for a two-way implementation.
 */
test("host kind distinguishes SEA from node rather than inferring it from Electron", () => {
  // The regression: not Electron, but not node either.
  assert.equal(detectNodeHostKind({ execIsElectron: false, execIsSea: true }), "sea");

  // A plain Node host stays node — the branch that was already correct and
  // therefore has no other guard.
  assert.equal(detectNodeHostKind({ execIsElectron: false, execIsSea: false }), "node");

  // Electron keeps winning, and is never reported as SEA.
  assert.equal(detectNodeHostKind({ execIsElectron: true, execIsSea: false }), "electron");
  assert.equal(detectNodeHostKind({ execIsElectron: true, execIsSea: true }), "electron");
});

test("host kind never reports a non-Electron host as node without checking SEA", () => {
  // Stated as its own case because this is the exact inference that shipped:
  // "not electron" must not be sufficient to conclude "node".
  const seaHost = detectNodeHostKind({ execIsElectron: false, execIsSea: true });
  assert.notEqual(seaHost, "node", "a SEA host must never be classified as node");
});

test("an unrecognised host is reported as unknown, never as node", () => {
  // The residue trap: "not Electron and not SEA" must not conclude node.
  // A three-way version of the shipped defect would put every host we have
  // not enumerated back onto the branch that assumes a JS entry runs.
  assert.equal(
    detectNodeHostKind({ execIsElectron: false, execIsSea: false, hasNodeRuntime: false }),
    "unknown",
  );

  // node still requires its own positive signal, not the absence of the others.
  assert.equal(
    detectNodeHostKind({ execIsElectron: false, execIsSea: false, hasNodeRuntime: true }),
    "node",
  );
});

test("a SEA host fails with a named capability error instead of returning execPath", () => {
  // The shipped behaviour: return process.execPath for a .js entry, and let
  // the spawn fail downstream with an OS-level message. That is what made the
  // original report read as an inscrutable startup failure.
  assert.throws(
    () => resolveNodeHostLaunch({
      env: {}, execPath: "C:\\Program Files\\raft-computer.exe",
      execIsElectron: false, execIsSea: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof NodeHostUnavailableError);
      assert.equal(error.kind, "node_host_unavailable");
      assert.equal(error.hostKind, "sea");
      return true;
    },
  );
});

test("an unknown host fails closed rather than trying execPath", () => {
  assert.throws(
    () => resolveNodeHostLaunch({
      env: {}, execPath: "/opt/mystery",
      execIsElectron: false, execIsSea: false, hasNodeRuntime: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof NodeHostUnavailableError);
      assert.equal(error.hostKind, "unknown");
      return true;
    },
  );
});

test("NODE NEGATIVE CONTROL: a plain Node host is untouched", () => {
  // The branch that was already correct, and therefore the one with no other
  // guard. Making SEA work must not disturb it.
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", EXISTING: "kept" };
  const launch = resolveNodeHostLaunch({
    env, execPath: "/usr/local/bin/node",
    execIsElectron: false, execIsSea: false, hasNodeRuntime: true,
  });
  assert.equal(launch.command, "/usr/local/bin/node");
  assert.deepEqual(launch.env, env);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined, "plain Node must not gain the Electron flag");
  assert.deepEqual(launch.execArgv, [], "plain Node runs the entry with no extra options");
});

test("Electron still gets Node mode and keeps the rest of the environment", () => {
  const launch = resolveNodeHostLaunch({
    env: { PATH: "/usr/bin", EXISTING: "kept" },
    execPath: "/Applications/Raft.app/Contents/MacOS/Raft",
    execIsElectron: true,
  });
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(launch.env.EXISTING, "kept");
  assert.deepEqual(launch.execArgv, [...ELECTRON_NODE_SCRIPT_EXEC_ARGV]);
});

// task #159: commander's argument-less parse() and yargs' hideBin read
// `process.versions.electron` without `process.defaultApp` as "argv[1] is a
// user argument", so `<electron> <script> list` saw the script path as the
// command. Run that exact decision in a child that looks like Electron's Node
// mode, without and with the launch options.
test("Electron Node mode: the exec options make argv[1] the script for commander/yargs-style parsers", () => {
  const fakeElectron = "Object.defineProperty(process.versions, 'electron', { value: '44.0.0' });";
  // Same rule as commander's _prepareUserArgs (from: "electron") and yargs' hideBin.
  const probe = "const skip = process.versions.electron && !process.defaultApp ? 1 : 2;"
    + "process.stdout.write(JSON.stringify(process.argv.slice(skip)));";
  const dir = mkdtempSync(path.join(tmpdir(), "electron-node-argv-"));
  try {
    const script = path.join(dir, "cli.mjs");
    writeFileSync(script, probe);
    const runScript = (execArgv: readonly string[]) => {
      const result = spawnSync(process.execPath, [
        "--import", `data:text/javascript,${encodeURIComponent(fakeElectron)}`,
        ...execArgv, script, "list",
      ], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as string[];
    };
    assert.deepEqual(runScript([]), [script, "list"], "control: without the options the script path leaks in as the first argument");
    assert.deepEqual(runScript(ELECTRON_NODE_SCRIPT_EXEC_ARGV), ["list"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REAL PROBE: the SEA check actually runs on this ESM host and returns a usable answer", () => {
  // Every other test here injects execIsSea, so none of them exercise the
  // production probe. That is how the first version shipped a bare `require`
  // in a "type": "module" package: the ReferenceError would have been caught
  // and reported as "not a SEA", silently reproducing the defect this file
  // fixes. Drive detectNodeHostKind with NO sea override so the real probe runs.
  const kind = detectNodeHostKind({ execIsElectron: false });

  // This test process is plain Node, not a SEA and not Electron. If the probe
  // is broken the honest outcomes are "unknown"; the one thing it must never
  // do is answer by accident.
  assert.equal(kind, "node", "a plain Node test host must classify as node via the real probe");

  // And the probe must be answering, not failing into a default: with the
  // node runtime signal removed, a working probe still says "not SEA" and the
  // classifier reports unknown rather than sea.
  assert.equal(detectNodeHostKind({ execIsElectron: false, hasNodeRuntime: false }), "unknown");
});

test("a probe that cannot answer yields unknown, never node", () => {
  // The guard this pins was previously unreachable: the real probe returns a
  // definite false on this host, and `execIsSea ?? probe()` cannot express
  // "explicitly unknown" — an injected undefined is indistinguishable from an
  // omitted field. Deleting the guard used to leave the whole suite green.
  assert.equal(
    detectNodeHostKind({ execIsElectron: false, hasNodeRuntime: true, seaProbe: () => undefined }),
    "unknown",
    "a probe that could not answer must not be read as a working Node host",
  );

  // A probe that answers keeps working normally, so the guard is not just
  // swallowing every path.
  assert.equal(
    detectNodeHostKind({ execIsElectron: false, hasNodeRuntime: true, seaProbe: () => false }),
    "node",
  );
  assert.equal(
    detectNodeHostKind({ execIsElectron: false, hasNodeRuntime: true, seaProbe: () => true }),
    "sea",
  );
});

test("the probe separates a missing node:sea module from a probe it could not run", () => {
  const missing = Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
  const unknownBuiltin = Object.assign(new Error("no such builtin"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });

  // No node:sea at all => this runtime cannot be a SEA. That is real evidence.
  assert.equal(seaDetected(() => { throw missing; }), false);
  assert.equal(seaDetected(() => { throw unknownBuiltin; }), false);

  // Anything else means the probe failed, which is not an answer. A bare
  // `require` in this ESM package threw exactly this shape and was reported
  // as false, silently recreating the defect the file exists to fix.
  assert.equal(seaDetected(() => { throw new ReferenceError("require is not defined"); }), undefined);
  assert.equal(seaDetected(() => ({ isSea() { throw new Error("boom"); } })), undefined);

  // And a working probe passes its answer through untouched.
  assert.equal(seaDetected(() => ({ isSea: () => true })), true);
  assert.equal(seaDetected(() => ({ isSea: () => false })), false);
});
