import assert from "node:assert/strict";
import { test } from "vitest";
import { applyCgroupMemoryBounds, parseLinuxMeminfo, readCgroupMemoryBounds, readMachineMemoryStatus } from "./machineMemory";

test("Linux memory is MemAvailable over MemTotal, not MemFree", () => {
  const meminfo = [
    "MemTotal:       16303428 kB",
    "MemFree:          412376 kB",
    "MemAvailable:   11873544 kB",
    "Buffers:          302148 kB",
  ].join("\n");
  assert.deepEqual(parseLinuxMeminfo(meminfo), { availableBytes: 11873544 * 1024, totalBytes: 16303428 * 1024 });
});

test("meminfo without MemAvailable or with impossible values gives no report", () => {
  assert.equal(parseLinuxMeminfo("MemTotal:       16303428 kB\nMemFree:          412376 kB\n"), null);
  assert.equal(parseLinuxMeminfo("MemTotal:       100 kB\nMemAvailable:   200 kB\n"), null);
  assert.equal(parseLinuxMeminfo(""), null);
});

test("this machine reports a plausible memory status", async () => {
  const status = await readMachineMemoryStatus();
  assert.ok(status);
  assert.ok(status.totalBytes > 0 && status.availableBytes <= status.totalBytes);
});

const GIB = 1024 ** 3;

function files(entries: Record<string, string>) {
  return async (file: string) => entries[file] ?? null;
}

test("an Incus container's soft limit bounds the report: 16 GiB, not the host's 62", async () => {
  // Incus dev box: memory.high = 16 GiB on the container root, memory.max
  // unlimited, lxcfs shows the host's memory in /proc/meminfo.
  const bounds = await readCgroupMemoryBounds(files({
    "/proc/self/cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/raft-computer.service\n",
    "/sys/fs/cgroup/memory.max": "max\n",
    "/sys/fs/cgroup/memory.high": `${16 * GIB}\n`,
    "/sys/fs/cgroup/memory.current": `${3 * GIB}\n`,
  }));
  assert.deepEqual(bounds, [{ limitBytes: 16 * GIB, usageBytes: 3 * GIB }]);
  const status = applyCgroupMemoryBounds({ availableBytes: 60 * GIB, totalBytes: 62 * GIB }, bounds);
  assert.deepEqual(status, { availableBytes: 13 * GIB, totalBytes: 16 * GIB });
});

test("every finite limit up the tree counts; the tightest headroom wins", async () => {
  const bounds = await readCgroupMemoryBounds(files({
    "/proc/self/cgroup": "0::/a/b\n",
    "/sys/fs/cgroup/a/b/memory.max": `${4 * GIB}\n`,
    "/sys/fs/cgroup/a/b/memory.high": "max\n",
    "/sys/fs/cgroup/a/b/memory.current": `${1 * GIB}\n`,
    "/sys/fs/cgroup/a/memory.max": `${8 * GIB}\n`,
    "/sys/fs/cgroup/a/memory.current": `${7 * GIB}\n`,
  }));
  assert.deepEqual(bounds, [
    { limitBytes: 4 * GIB, usageBytes: 1 * GIB },
    { limitBytes: 8 * GIB, usageBytes: 7 * GIB },
  ]);
  // b has 3 GiB of room, but a only 1 GiB: a new agent gets at most 1 GiB.
  assert.deepEqual(
    applyCgroupMemoryBounds({ availableBytes: 20 * GIB, totalBytes: 32 * GIB }, bounds),
    { availableBytes: 1 * GIB, totalBytes: 4 * GIB },
  );
});

test("cgroup v1 limit_in_bytes counts, its 'unlimited' value does not", async () => {
  const limited = await readCgroupMemoryBounds(files({
    "/proc/self/cgroup": "12:pids:/x\n9:memory:/docker/abc\n",
    "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": `${2 * GIB}\n`,
    "/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes": `${512 * 1024 ** 2}\n`,
    "/sys/fs/cgroup/memory/docker/memory.limit_in_bytes": "9223372036854771712\n",
  }));
  assert.deepEqual(limited, [{ limitBytes: 2 * GIB, usageBytes: 512 * 1024 ** 2 }]);
});

test("no limits, or nothing readable, leaves meminfo as it is", async () => {
  const meminfo = { availableBytes: 10 * GIB, totalBytes: 16 * GIB };
  const bare = await readCgroupMemoryBounds(files({
    "/proc/self/cgroup": "0::/user.slice\n",
    "/sys/fs/cgroup/user.slice/memory.max": "max\n",
    "/sys/fs/cgroup/user.slice/memory.high": "max\n",
  }));
  assert.deepEqual(bare, []);
  assert.deepEqual(await readCgroupMemoryBounds(files({})), []);
  assert.deepEqual(applyCgroupMemoryBounds(meminfo, []), meminfo);
  // A cgroup already past its limit has no headroom, never a negative one.
  assert.deepEqual(
    applyCgroupMemoryBounds(meminfo, [{ limitBytes: 4 * GIB, usageBytes: 5 * GIB }]),
    { availableBytes: 0, totalBytes: 4 * GIB },
  );
});

test("reclaimable file cache is not counted as used", async () => {
  const bounds = await readCgroupMemoryBounds(files({
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.high": `${16 * GIB}\n`,
    "/sys/fs/cgroup/memory.current": `${15 * GIB}\n`,
    "/sys/fs/cgroup/memory.stat": `anon ${3 * GIB}\nfile ${12 * GIB}\ninactive_file ${10 * GIB}\nactive_file ${2 * GIB}\n`,
  }));
  assert.deepEqual(bounds, [{ limitBytes: 16 * GIB, usageBytes: 5 * GIB }]);
});

test("a hybrid host reads the v1 memory controller, not the empty v2 tree", async () => {
  const bounds = await readCgroupMemoryBounds(files({
    "/proc/self/cgroup": "12:memory:/docker/abc\n0::/docker/abc\n",
    "/sys/fs/cgroup/docker/abc/memory.max": `${1 * GIB}\n`,
    "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": `${2 * GIB}\n`,
    "/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes": `${1 * GIB}\n`,
    "/sys/fs/cgroup/memory/docker/abc/memory.stat": `inactive_file 9\ntotal_inactive_file ${512 * 1024 ** 2}\n`,
  }));
  assert.deepEqual(bounds, [{ limitBytes: 2 * GIB, usageBytes: 512 * 1024 ** 2 }]);
});

test("the walk stays inside the cgroup mount", async () => {
  const read: string[] = [];
  await readCgroupMemoryBounds(async (file) => {
    read.push(file);
    return file === "/proc/self/cgroup" ? "0::/\n" : null;
  });
  assert.deepEqual(read.filter((file) => !file.startsWith("/sys/fs/cgroup/") && file !== "/proc/self/cgroup"), []);
  const outside: string[] = [];
  await readCgroupMemoryBounds(async (file) => {
    outside.push(file);
    return file === "/proc/self/cgroup" ? "0::/../../host.slice\n" : null;
  });
  assert.deepEqual(outside, ["/proc/self/cgroup"]);
});
