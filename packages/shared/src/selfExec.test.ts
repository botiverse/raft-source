import assert from "node:assert/strict";

import { resolveSelfExec, selfExecHostFromProcess, selfExecHostShape, type SelfExecHost } from "./selfExec";

const APP = "/Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop";

function host(overrides: Partial<SelfExecHost>): SelfExecHost {
  return { execPath: "/usr/local/bin/node", execArgv: [], argv: ["/usr/local/bin/node"], isSea: false, ...overrides };
}

test("node script: execArgv + the entry script + mode", () => {
  const h = host({ execArgv: ["--import", "@oxc-node/core/register"], argv: ["/usr/local/bin/node", "/repo/packages/computer/src/index.ts", "__run", "s1"] });
  assert.deepEqual(resolveSelfExec(["__detect-runtimes"], h), {
    command: "/usr/local/bin/node",
    args: ["--import", "@oxc-node/core/register", "/repo/packages/computer/src/index.ts", "__detect-runtimes"],
    shape: "node-script",
  });
});

test("SEA: the binary itself + mode; argv[1] is a user argument, never passed again", () => {
  const h = host({ execPath: "/home/u/.slock/computer/k/slots/stable/artifact.bin", argv: ["/home/u/.slock/computer/k/slots/experiment/artifact.bin", "__run", "s1"], isSea: true });
  assert.deepEqual(resolveSelfExec(["__detect-runtimes"], h), {
    command: "/home/u/.slock/computer/k/slots/stable/artifact.bin",
    args: ["__detect-runtimes"],
    shape: "sea",
  });
});

test("packaged Electron app: the launcher + mode; argv[1] (the mode or an empty slot) is not a script", () => {
  // What the packaged Desktop's `__run` really sees: the resident spawn passes
  // the GUI's missing argv[1] as "".
  for (const argv of [[APP, "", "__run", "s1"], [APP, "__service"], [APP, "raft://open/x", "__run", "s1"]]) {
    const h = host({ execPath: APP, argv, electronVersion: "44.7.0", electronProcessType: "browser" });
    assert.deepEqual(resolveSelfExec(["__detect-runtimes"], h), { command: APP, args: ["__detect-runtimes"], shape: "electron-app" }, JSON.stringify(argv));
  }
});

test("dev Electron (`electron <appPath>`): argv[1] is the app path and is kept", () => {
  const electron = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const h = host({ execPath: electron, argv: [electron, ".", "__run", "s1"], electronVersion: "44.7.0", electronProcessType: "browser", electronDefaultApp: true });
  assert.deepEqual(resolveSelfExec(["__run", "s2"], h), { command: electron, args: [".", "__run", "s2"], shape: "electron-app" });
});

test("Electron under ELECTRON_RUN_AS_NODE runs a script like Node", () => {
  const entry = `${APP}/../../Resources/app.asar/node_modules/@botiverse/raft-daemon/dist/index.js`;
  const h = host({ execPath: APP, argv: [APP, entry], electronVersion: "44.7.0" });
  assert.equal(selfExecHostShape(h), "node-script");
  assert.deepEqual(resolveSelfExec(["__detect-runtimes"], h).args, [entry, "__detect-runtimes"]);
});

test("selfExecHostFromProcess reads Electron's process.type / defaultApp and takes a live execPath", () => {
  const facts = { execPath: APP, execArgv: [], argv: [APP, "", "__run", "s1"], versions: { electron: "44.7.0" }, type: "browser" };
  const h = selfExecHostFromProcess(facts, false, "/live/path");
  assert.equal(h.execPath, "/live/path");
  assert.equal(selfExecHostShape(h), "electron-app");
  assert.equal(selfExecHostShape(selfExecHostFromProcess({ ...facts, type: undefined }, false)), "node-script");
  assert.equal(selfExecHostShape(selfExecHostFromProcess({ ...facts, versions: {} }, true)), "sea");
});
