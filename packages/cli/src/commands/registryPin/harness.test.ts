/**
 * The pin harness gives every run a fresh local state directory under the OS
 * temp dir; it must remove it afterwards, or every CLI test run leaves
 * `raft-registry-pin-*` directories behind (thousands of them on a shared host).
 */
import fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";

import { runPinned, runPinnedSequence } from "./harness";

afterEach(() => {
  vi.restoreAllMocks();
});

function watchStateDirs(): string[] {
  const made: string[] = [];
  const real = fs.mkdtempSync.bind(fs);
  vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string, options?: unknown) => {
    const dir = real(prefix, options as never) as string;
    if (prefix.includes("raft-registry-pin-")) made.push(dir);
    return dir;
  }) as typeof fs.mkdtempSync);
  return made;
}

test("a pinned run removes its local state directory", async () => {
  const made = watchStateDirs();
  await runPinned(["--help"], []);
  expect(made).toHaveLength(1);
  expect(fs.existsSync(made[0]!)).toBe(false);
});

test("a pinned sequence removes its local state directory, also when the body throws", async () => {
  const made = watchStateDirs();
  await expect(
    runPinnedSequence(async (run) => {
      await run(["--help"], []);
      throw new Error("step failed");
    }),
  ).rejects.toThrow("step failed");
  expect(made).toHaveLength(1);
  expect(fs.existsSync(made[0]!)).toBe(false);
});
