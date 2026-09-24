import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { writeDurableTextFile } from "./durableFile.js";

test("durable writer isolates concurrent temporary files and leaves one complete generation", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-durable-write-"));
  try {
    const path = join(home, "upgrade-status.json");
    const values = Array.from({ length: 32 }, (_, index) => `${index}:${"x".repeat(256 * 1024)}\n`);
    const results = await Promise.allSettled(values.map((value) => writeDurableTextFile(path, value)));

    for (const result of results) {
      if (result.status === "fulfilled") continue;
      assert.match(
        String(result.reason),
        /DURABLE_WRITE_READBACK_MISMATCH/,
        "a competing final generation may win readback, but temp-path collisions must not occur",
      );
    }

    assert.ok(results.some((result) => result.status === "fulfilled"));
    assert.ok(values.includes(await readFile(path, "utf8")), "the final file must be one complete generation");
    assert.deepEqual(
      (await readdir(home)).filter((name) => name.endsWith(".tmp")),
      [],
      "each writer must clean only its owned temporary file",
    );
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
