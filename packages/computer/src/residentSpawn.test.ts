import assert from "node:assert/strict";

import { buildSelfExecArgv } from "./index";
import { buildResidentSpawn, currentResidentElectronFacts, type ResidentElectronFacts } from "./service";

// Every self re-exec of the Computer (`__service`, `__run <id>`, and the
// daemon's `__detect-runtimes`) goes through resolveSelfExec. These pin the
// resident spawn per host shape with injected process facts.

const NODE: ResidentElectronFacts = {};
const APP_MAIN: ResidentElectronFacts = { electronVersion: "44.7.0", electronProcessType: "browser" };

test("node script: execArgv (dev TS loader) + the entry script + mode", () => {
  assert.deepEqual(
    buildResidentSpawn("__run", "s1", "/repo/packages/computer/src/index.ts", ["--import", "@oxc-node/core/register"], false, "/unused", NODE),
    { command: process.execPath, args: ["--import", "@oxc-node/core/register", "/repo/packages/computer/src/index.ts", "__run", "s1"] },
  );
});

test("SEA: the live binary + mode, never the SEA's argv[1]", () => {
  assert.deepEqual(
    buildResidentSpawn("__service", null, "--version", [], true, "/home/u/.slock/computer/k/slots/stable/artifact.bin", NODE),
    { command: "/home/u/.slock/computer/k/slots/stable/artifact.bin", args: ["__service"] },
  );
});

test("packaged Electron app: the launcher + mode; the GUI's argv[1] is not forwarded", () => {
  // "" is what the packaged GUI passes (no argv[1]); a Windows/Linux deep-link
  // cold start has the link there. Neither is an entry script.
  for (const selfEntry of ["", "raft://open/channel"]) {
    assert.deepEqual(
      buildResidentSpawn("__run", "s1", selfEntry, [], false, "/unused", APP_MAIN),
      { command: process.execPath, args: ["__run", "s1"] },
      selfEntry,
    );
  }
});

test("dev Electron (`electron <appPath>`): the app path stays in front of the mode", () => {
  assert.deepEqual(
    buildResidentSpawn("__service", null, ".", [], false, "/unused", { ...APP_MAIN, electronDefaultApp: true }),
    { command: process.execPath, args: [".", "__service"] },
  );
});

test("Electron under ELECTRON_RUN_AS_NODE is a node-script host", () => {
  assert.deepEqual(
    buildResidentSpawn("__run", "s1", "/app.asar/node_modules/@botiverse/raft-computer/dist/index.js", [], false, "/unused", { electronVersion: "44.7.0" }),
    { command: process.execPath, args: ["/app.asar/node_modules/@botiverse/raft-computer/dist/index.js", "__run", "s1"] },
  );
});

test("under plain Node (this test process) the defaults keep today's node-script shape", () => {
  assert.deepEqual(currentResidentElectronFacts(), { electronVersion: undefined, electronProcessType: undefined, electronDefaultApp: undefined });
  const entry = process.argv[1];
  assert.deepEqual(buildSelfExecArgv(), [process.execPath, ...process.execArgv, ...(entry !== undefined ? [entry] : [])]);
});
