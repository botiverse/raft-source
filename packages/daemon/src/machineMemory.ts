import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isValidMachineMemoryStatus, type MachineMemoryStatus } from "@botiverse/raft-shared";

/**
 * The machine's memory for `machine:memory_status`. Linux reports
 * MemAvailable (what a new process can get without swapping, page cache
 * included), not MemFree, which is near zero on a busy box, bounded by the
 * cgroup limits this Computer runs under (`applyCgroupMemoryBounds`).
 * Elsewhere Node's os.freemem(): available physical memory on Windows, free +
 * no cache on macOS (an underestimate there).
 */
export async function readMachineMemoryStatus(): Promise<MachineMemoryStatus | null> {
  if (process.platform === "linux") {
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => null);
    const parsed = meminfo === null ? null : parseLinuxMeminfo(meminfo);
    if (parsed) return applyCgroupMemoryBounds(parsed, await readCgroupMemoryBounds());
  }
  const status = { availableBytes: os.freemem(), totalBytes: os.totalmem() };
  return isValidMachineMemoryStatus(status) ? status : null;
}

/** MemAvailable and MemTotal from /proc/meminfo (values in kB), or null if either is missing. */
export function parseLinuxMeminfo(meminfo: string): MachineMemoryStatus | null {
  const kib = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m").exec(meminfo);
    return match ? Number(match[1]) * 1024 : null;
  };
  const availableBytes = kib("MemAvailable");
  const totalBytes = kib("MemTotal");
  if (availableBytes === null || totalBytes === null) return null;
  const status = { availableBytes, totalBytes };
  return isValidMachineMemoryStatus(status) ? status : null;
}

/** A finite memory limit on one cgroup level, with that level's current usage. */
export interface CgroupMemoryBound {
  limitBytes: number;
  usageBytes: number;
}

/**
 * /proc/meminfo describes the host, or whatever a container's lxcfs makes of
 * it: an Incus container with only a soft limit (`memory.high`) still shows
 * the host's 62 GiB. The limits that apply are on the cgroups this Computer
 * runs in, so every finite one bounds the report: total is the smallest limit,
 * available the smallest headroom (limit minus that level's usage). No limit,
 * or none readable: meminfo as it is.
 */
export function applyCgroupMemoryBounds(
  meminfo: MachineMemoryStatus,
  bounds: readonly CgroupMemoryBound[],
): MachineMemoryStatus {
  let { availableBytes, totalBytes } = meminfo;
  for (const { limitBytes, usageBytes } of bounds) {
    totalBytes = Math.min(totalBytes, limitBytes);
    availableBytes = Math.min(availableBytes, Math.max(0, limitBytes - usageBytes));
  }
  availableBytes = Math.min(availableBytes, totalBytes);
  const status = { availableBytes, totalBytes };
  return isValidMachineMemoryStatus(status) ? status : meminfo;
}

type ReadText = (file: string) => Promise<string | null>;

const readText: ReadText = (file) => readFile(file, "utf8").catch(() => null);

// cgroup v1 reports "no limit" as a page-rounded LONG_MAX; anything this
// large is no limit.
const NO_LIMIT_BYTES = 2 ** 60;

function parseBytes(text: string | null): number | null {
  const value = text?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes < NO_LIMIT_BYTES ? bytes : null;
}

/**
 * The finite memory limits on this process's cgroup and each ancestor up to
 * the mount root (in a container, the container's own cgroup): cgroup v2's
 * `memory.max` and `memory.high` (a soft limit: reclaim and throttling past
 * it, so not memory to count on), or v1's `memory.limit_in_bytes`. Usage
 * leaves out inactive file cache, which the kernel reclaims first, as
 * MemAvailable does. Missing files, permissions and odd mounts read as no
 * limit on that level.
 */
export async function readCgroupMemoryBounds(
  read: ReadText = readText,
  root = "/sys/fs/cgroup",
): Promise<CgroupMemoryBound[]> {
  const membership = await read("/proc/self/cgroup");
  if (!membership) return [];
  const lines = membership.split("\n");
  const v2 = lines.find((line) => line.startsWith("0::"));
  const v1 = lines.find((line) => line.split(":")[1]?.split(",").includes("memory"));
  // A hybrid host lists both; there the memory controller is the v1 one (the
  // v2 tree at /sys/fs/cgroup/unified carries no memory files).
  const spec = v1
    ? {
      base: path.join(root, "memory"),
      relative: v1.split(":").slice(2).join(":"),
      limits: ["memory.limit_in_bytes"],
      usage: "memory.usage_in_bytes",
      inactiveFile: "total_inactive_file",
    }
    : v2
      ? { base: root, relative: v2.slice(3), limits: ["memory.max", "memory.high"], usage: "memory.current", inactiveFile: "inactive_file" }
      : null;
  if (!spec || !spec.relative.startsWith("/")) return [];
  const bounds: CgroupMemoryBound[] = [];
  // From this cgroup up to the mount root. A path outside the root (the
  // cgroup namespace hides it) is never read.
  for (let dir = path.join(spec.base, spec.relative); ; dir = path.dirname(dir)) {
    const above = path.relative(spec.base, dir);
    if (above.startsWith("..") || path.isAbsolute(above)) break;
    const limits = (await Promise.all(spec.limits.map((file) => read(path.join(dir, file))))).map(parseBytes);
    const finite = limits.filter((limit): limit is number => limit !== null);
    if (finite.length > 0) {
      const [usage, stat] = await Promise.all([read(path.join(dir, spec.usage)), read(path.join(dir, "memory.stat"))]);
      const inactiveFile = parseBytes(new RegExp(`^${spec.inactiveFile} (\\d+)$`, "m").exec(stat ?? "")?.[1] ?? null) ?? 0;
      bounds.push({ limitBytes: Math.min(...finite), usageBytes: Math.max(0, (parseBytes(usage) ?? 0) - inactiveFile) });
    }
    if (above === "") break;
  }
  return bounds;
}
