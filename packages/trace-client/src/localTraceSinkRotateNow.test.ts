import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalRotatingTraceSink } from "./localTraceSink";

// `rotateNow` lets the daemon flush telemetry before age or size would rotate
// the file (a failed agent start in a short session, shutdown).

function event(name: string) {
  return { name, surface: "daemon" as const, timeMs: Date.UTC(2026, 10, 17), context: null, attrs: { n: 1 } };
}

async function withSink(run: (sink: LocalRotatingTraceSink, traceDir: string) => Promise<void>): Promise<void> {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "raft-trace-rotate-now-"));
  try {
    await run(new LocalRotatingTraceSink({ machineDir, maxFiles: 8 }), path.join(machineDir, "traces"));
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
}

test("rotateNow closes the current file and the next write goes to a new file", async () => {
  await withSink(async (sink, traceDir) => {
    sink.recordLogEvent(event("before.rotate"));
    const first = sink.getCurrentFile();
    assert.ok(first);

    assert.equal(sink.rotateNow(), first, "returns the file it closed");
    assert.equal(sink.getCurrentFile(), null, "nothing is current until the next write");

    sink.recordLogEvent(event("after.rotate"));
    const second = sink.getCurrentFile();
    assert.ok(second);
    assert.notEqual(second, first);

    const files = (await readdir(traceDir)).sort();
    assert.equal(files.length, 2);
    const closed = await readFile(first, "utf8");
    const current = await readFile(second, "utf8");
    assert.ok(closed.includes("before.rotate") && !closed.includes("after.rotate"), "the closed file keeps only its records");
    assert.ok(current.includes("after.rotate") && !current.includes("before.rotate"));
  });
});

test("rotateNow does nothing without a file holding records (no empty files)", async () => {
  await withSink(async (sink, traceDir) => {
    assert.equal(sink.rotateNow(), null, "no file open yet");

    sink.recordLogEvent(event("one"));
    assert.ok(sink.rotateNow());
    // Closed, and nothing written since: a second call has nothing to close.
    assert.equal(sink.rotateNow(), null);
    assert.equal(sink.rotateNow(), null);
    assert.equal((await readdir(traceDir)).length, 1, "repeated calls leave no empty files");
  });
});
