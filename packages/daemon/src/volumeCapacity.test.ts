import assert from "node:assert/strict";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { test, vi } from "vitest";
import { readVolumeCapacity, type VolumeCapacityDeps } from "./volumeCapacity";

// 19.4 GB free of 245 GB by statfs; Finder (important usage) says 123.76 GB.
const fakeStatfs = async () => ({ bsize: 4096, bavail: 4_736_328, blocks: 59_840_624 });
const STATFS_AVAILABLE = 4096 * 4_736_328;
const TOTAL = 4096 * 59_840_624;

function osascript(result: { error?: Error; stdout?: string }) {
  return vi.fn<NonNullable<VolumeCapacityDeps["execFile"]>>((_file, _args, _options, callback) => {
    callback(result.error ?? null, result.stdout ?? "");
  });
}

test("darwin reports the important-usage capacity Finder shows, not statfs's bavail", async () => {
  const execFile = osascript({ stdout: "123760000000\n" });
  const capacity = await readVolumeCapacity("/Users/me/.slock/agents", { platform: "darwin", statfs: fakeStatfs, execFile });
  assert.deepEqual(capacity, { availableBytes: 123_760_000_000, totalBytes: TOTAL });
  const [file, args, options] = execFile.mock.calls[0]!;
  assert.equal(file, "osascript");
  assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.deepEqual(args.slice(4), ["--", "/Users/me/.slock/agents"], "the path is an argv entry after --, never an option or part of the script");
  assert.ok(options.timeout > 0);
});

test("darwin keeps statfs's figure when osascript fails or answers nonsense", async () => {
  for (const result of [
    { error: Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" }) },
    { error: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }) },
    { stdout: "undefined\n" },
    { stdout: "" },
    { stdout: "-5" },
    { stdout: "1e12" },
    { stdout: String(TOTAL + 1) },
    // A volume without the key can answer 0: never below what statfs sees.
    { stdout: "0\n" },
    { stdout: String(STATFS_AVAILABLE - 1) },
  ]) {
    const capacity = await readVolumeCapacity("/x", { platform: "darwin", statfs: fakeStatfs, execFile: osascript(result) });
    assert.deepEqual(capacity, { availableBytes: STATFS_AVAILABLE, totalBytes: TOTAL }, JSON.stringify(result));
  }
  const throwing = vi.fn(() => { throw new Error("EAGAIN"); });
  assert.deepEqual(
    await readVolumeCapacity("/x", { platform: "darwin", statfs: fakeStatfs, execFile: throwing }),
    { availableBytes: STATFS_AVAILABLE, totalBytes: TOTAL },
  );
});

test("Linux and Windows use statfs alone and never spawn osascript", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const execFile = osascript({ stdout: "123760000000" });
    assert.deepEqual(
      await readVolumeCapacity("/x", { platform, statfs: fakeStatfs, execFile }),
      { availableBytes: STATFS_AVAILABLE, totalBytes: TOTAL },
    );
    assert.equal(execFile.mock.calls.length, 0);
  }
});

test("an unreadable volume gives null without spawning osascript", async () => {
  const execFile = osascript({ stdout: "1" });
  const failing = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  assert.equal(await readVolumeCapacity("/missing", { platform: "darwin", statfs: failing, execFile }), null);
  assert.equal(execFile.mock.calls.length, 0);
});

test.skipIf(process.platform !== "darwin")("this Mac's important-usage capacity is read through osascript", async () => {
  const home = os.homedir();
  const info = await statfs(home);
  const capacity = await readVolumeCapacity(home);
  assert.ok(capacity);
  assert.equal(capacity.totalBytes, info.blocks * info.bsize);
  assert.ok(capacity.availableBytes <= capacity.totalBytes);
  // Purgeable space only adds to what statfs reports; allow for writes in between.
  assert.ok(capacity.availableBytes >= info.bavail * info.bsize * 0.9);
});
