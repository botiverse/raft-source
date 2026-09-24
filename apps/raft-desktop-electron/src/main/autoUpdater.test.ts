import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("automatic updater loading waits for startup delay; manual check loads immediately", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "raft-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "dev-app-update.yml"), "provider: generic\n");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let wired = 0;
  let checks = 0;
  t.mock.module("electron", { namedExports: {
    app: { isPackaged: false, getAppPath: () => root }, dialog: {},
  } });
  t.mock.module("electron-updater", { namedExports: { autoUpdater: {
    on: () => { wired++; },
    checkForUpdates: async () => { checks++; return null; },
  } } });
  const updater = await import("./autoUpdater.ts");
  updater.initializeAutoUpdater({ markQuitting() {} });
  // Let any accidentally eager dynamic import settle before inspecting it.
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(wired, 0, "automatic startup must not configure/load the SDK yet");
  t.mock.timers.tick(2999);
  assert.equal(checks, 0);
  await updater.triggerBackgroundCheck({ markQuitting() {} });
  assert.ok(wired > 0, "an explicit check does not wait for the startup delay");
  assert.equal(checks, 1);
  t.mock.timers.tick(1);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(checks, 2, "scheduled initial check still runs at 3 seconds");
  t.mock.timers.tick(30 * 60 * 1000 - 3000);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(checks, 3, "periodic checks are preserved");
});
