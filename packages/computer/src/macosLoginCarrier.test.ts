import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  convergeCliHostLifecycle,
  readHostLifecycleMarker,
  retireCliLoginCarrier,
  retiredCliLoginCarrierPaths,
} from "./macosLoginCarrier";

async function withMacHome(
  fn: (paths: { root: string; userHome: string; slockHome: string; plist: string; label: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-host-lifecycle-"));
  const userHome = path.join(root, "home");
  const slockHome = path.join(userHome, ".slock");
  const { label, definitionPath: plist } = retiredCliLoginCarrierPaths(slockHome, userHome);
  try {
    await fn({ root, userHome, slockHome, plist, label });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** A leftover from the retired CLI LaunchAgent, as older releases wrote it. */
async function writeLeftoverCarrier(slockHome: string, plist: string): Promise<string[]> {
  const state = [
    path.join(slockHome, "computer", "host-lifecycle-pending-replace.json"),
    path.join(slockHome, "computer", "proxy-env.json"),
  ];
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, "<plist/>\n");
  await mkdir(path.join(slockHome, "computer"), { recursive: true });
  for (const file of state) await writeFile(file, "{}\n");
  return state;
}

test("the retired CLI LaunchAgent path is per home and outside the retired supervisor label family", () => {
  const a = retiredCliLoginCarrierPaths("/Users/example/.slock", "/Users/example");
  const b = retiredCliLoginCarrierPaths("/Users/example/.slock-dev", "/Users/example");
  assert.match(a.label, /^build\.raft\.computer\.login\.[0-9a-f]{16}$/u);
  assert.doesNotMatch(a.label, /^build\.raft\.computer\.[0-9a-f]{16}$/u);
  assert.notEqual(a.label, b.label);
  assert.equal(a.definitionPath, `/Users/example/Library/LaunchAgents/${a.label}.plist`);
});

test("CLI start on macOS deletes a leftover LaunchAgent and its state, installs nothing, and records the CLI owner", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    const state = await writeLeftoverCarrier(slockHome, plist);
    const result = await convergeCliHostLifecycle(slockHome, "enabled", { platform: "darwin", userHome });
    assert.equal(result.status, "not-applicable");
    assert.equal(result.owner, "cli");
    assert.equal(result.enabled, true);
    assert.equal(await exists(plist), false);
    for (const file of state) assert.equal(await exists(file), false, file);
    assert.deepEqual(await readdirOrEmpty(path.dirname(plist)), []);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), {
      formatVersion: 1,
      owner: "cli",
      enabled: true,
      dispatcherPath: null,
      label: null,
      definitionPath: null,
    });
  });
});

test("CLI stop on macOS records the disabled intent; a machine without a leftover is untouched", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    const result = await convergeCliHostLifecycle(slockHome, "disabled", { platform: "darwin", userHome });
    assert.equal(result.status, "not-applicable");
    assert.equal(await exists(plist), false);
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, false);
  });
});

test("CLI converge off macOS touches nothing", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    await writeLeftoverCarrier(slockHome, plist);
    const result = await convergeCliHostLifecycle(slockHome, "enabled", { platform: "linux", userHome });
    assert.equal(result.status, "not-applicable");
    assert.equal(await exists(plist), true);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  });
});

test("CLI converge keeps an App-owned record and only follows its enabled intent", async () => {
  await withMacHome(async ({ userHome, slockHome }) => {
    // The record an older Raft Desktop (embedded Computer) left behind.
    await mkdir(path.join(slockHome, "computer"), { recursive: true });
    await writeFile(path.join(slockHome, "computer", "host-lifecycle-owner.json"), JSON.stringify({
      formatVersion: 1, owner: "app", enabled: true, dispatcherPath: null, label: null, definitionPath: null,
    }));
    const result = await convergeCliHostLifecycle(slockHome, "disabled", { platform: "darwin", userHome });
    assert.equal(result.owner, "app");
    assert.equal((await readHostLifecycleMarker(slockHome))?.owner, "app");
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, false);
  });
});

test("retiring the leftover LaunchAgent only removes this home's definition", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    const other = retiredCliLoginCarrierPaths(path.join(userHome, ".slock-other"), userHome).definitionPath;
    const unrelated = path.join(path.dirname(plist), "com.example.Drafts.plist");
    await writeLeftoverCarrier(slockHome, plist);
    await writeFile(other, "<plist/>\n");
    await writeFile(unrelated, "<plist/>\n");
    assert.equal((await retireCliLoginCarrier(slockHome, { platform: "darwin", userHome })).removed, true);
    assert.equal(await exists(plist), false);
    assert.equal(await exists(other), true);
    assert.equal(await exists(unrelated), true);
    assert.equal((await retireCliLoginCarrier(slockHome, { platform: "darwin", userHome })).removed, false);
  });
});

test("a cleanup that cannot delete the leftover reports it and never throws; the CLI still records its owner", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    // A directory where the plist should be: stat succeeds, rm without
    // `recursive` fails.
    await mkdir(path.join(plist, "blocker"), { recursive: true });
    const retired = await retireCliLoginCarrier(slockHome, { platform: "darwin", userHome });
    assert.equal(retired.removed, false);
    assert.ok(retired.error);

    const cli = await convergeCliHostLifecycle(slockHome, "enabled", { platform: "darwin", userHome });
    assert.equal(cli.owner, "cli");
  });
});

test("an unreadable owner record fails instead of being overwritten", async () => {
  await withMacHome(async ({ userHome, slockHome }) => {
    await mkdir(path.join(slockHome, "computer"), { recursive: true });
    await writeFile(path.join(slockHome, "computer", "host-lifecycle-owner.json"), "not json\n");
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", { platform: "darwin", userHome }),
      (error: unknown) => (error as { code?: string }).code === "HOST_LIFECYCLE_OWNER_UNREADABLE",
    );
    assert.equal(
      await readFile(path.join(slockHome, "computer", "host-lifecycle-owner.json"), "utf8"),
      "not json\n",
    );
  });
});

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
