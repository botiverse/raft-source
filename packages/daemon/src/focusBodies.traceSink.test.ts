import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTracer, type AgentMessage } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { focusedBodyTraceAttrs } from "./focusBodies";

// The local trace sink drops an attribute whose name has a word such as
// `body` or `message` in it, unless the name ends in an allowed suffix
// (`_count`, ...). On staging (2026-11-20) two of the four Focus attributes
// never reached the traces for that reason, while every test that read them
// off the tracer passed. This one reads what the sink wrote.
test("every Focus trace attribute of a write reaches the trace file", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "raft-focus-attrs-"));
  try {
    const attrs = focusedBodyTraceAttrs(
      [{ content: "hello" } as AgentMessage],
      [{ limit: "message" }, { limit: "write" }, { limit: "write" }],
    );
    assert.equal(Object.keys(attrs).length, 4, "the write carries all four attributes");

    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    new BasicTracer({ sink }).startSpan("daemon.probe", { surface: "daemon", kind: "internal", attrs: attrs as never }).end("ok");

    let written: Record<string, unknown> = {};
    const dir = path.join(machineDir, "traces");
    for (const name of readdirSync(dir)) {
      for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n").filter((l) => l.length > 0)) {
        const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
        if (record.name === "daemon.probe") written = record.attrs ?? {};
      }
    }
    for (const [key, value] of Object.entries(attrs)) {
      assert.equal(written[key], value, `${key} must be written, not dropped by the sink`);
    }
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
