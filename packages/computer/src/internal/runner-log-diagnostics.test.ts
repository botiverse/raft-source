import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { readRunnerLogDiagnosticText, readRunnerLogTail } from "./runner-log-diagnostics.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "raft-runner-log-diag-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readRunnerLogDiagnosticText reads only the bounded suffix after child spawn offset", async () => {
  await withTmp(async (dir) => {
    const log = join(dir, "runner.log");
    await writeFile(
      log,
      [
        "old-prefix-that-belongs-to-an-earlier-child",
        "child-start",
        "x".repeat(128),
        "Another Slock daemon is already running (pid=1234). Lock: /tmp/daemon.lock.",
      ].join("\n"),
      { mode: 0o600 },
    );

    const diagnostic = await readRunnerLogDiagnosticText(
      log,
      "old-prefix-that-belongs-to-an-earlier-child\n".length,
      96,
    );

    assert.equal(diagnostic.includes("old-prefix"), false);
    assert.equal(diagnostic.includes("child-start"), false);
    assert.match(diagnostic, /Another Slock daemon is already running/);
    assert.ok(
      Buffer.byteLength(diagnostic, "utf8") <= 96,
      "diagnostic text must be capped before Buffer.toString() is called",
    );
  });
});

test("readRunnerLogTail concatenates bounded existing tails and ignores missing logs", async () => {
  await withTmp(async (dir) => {
    const first = join(dir, "runner.log");
    const second = join(dir, "server-runner.log");
    await writeFile(first, `${"a".repeat(80)}first-tail`, { mode: 0o600 });
    await writeFile(second, "second-tail", { mode: 0o600 });

    const tail = await readRunnerLogTail([join(dir, "missing.log"), first, second]);
    assert.match(tail, /first-tail\nsecond-tail/);
    assert.equal(tail.includes("missing.log"), false);
  });
});
