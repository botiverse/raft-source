import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextViewRestoreFailure, restoreContextViewSource, type ContextViewRestoreRequest } from "./contextViewRestore";
import { encodeContextViewRestored, runContextViewRestore } from "./contextViewRestoreChild";
import { selfExecHostFromProcess } from "@botiverse/raft-shared/src/selfExec";
import { contextViewRestoreChildEnv, contextViewRestoreHeapLimitMb, contextViewRestoreHost, restoreContextViewInChild, type ContextViewRestoreRunnerDeps } from "./contextViewRestoreRunner";

const REQUEST: ContextViewRestoreRequest = {
  runtime: "claude",
  file: "/nowhere/session.jsonl",
  allowedRoots: ["/nowhere"],
  offset: 0,
  messageId: "m-1",
  sessionId: "s-1",
  maxBytes: 1024 * 1024,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ctxview-runner-"));
});

afterEach(() => {
  // A regression in the kill path must not leave a test's child running.
  try {
    process.kill(Number(readFileSync(path.join(dir, "pid"), "utf8")), "SIGKILL");
  } catch {
    // no pid file, or already gone
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A real child process, running `script` in place of this binary's restore mode. */
function childRunning(script: string): Pick<ContextViewRestoreRunnerDeps, "spawnFn" | "host" | "env"> {
  const file = path.join(dir, "child.cjs");
  writeFileSync(file, script);
  return {
    host: selfExecHostFromProcess(process, false, process.execPath),
    env: { PATH: process.env.PATH },
    spawnFn: ((_command: string, _args: string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath, [file], options)) as ContextViewRestoreRunnerDeps["spawnFn"],
  };
}

describe("restore child process", () => {
  it("returns the child's outcome, attributes and body, having sent it the request on stdin", async () => {
    const deps = childRunning(`
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const request = JSON.parse(input);
        process.stdout.write(JSON.stringify({ outcome: "ok", attrs: { seen: request.messageId } }) + "\\n" + JSON.stringify({ ok: true, line: "a\\nb" }));
      });
    `);

    const restored = await restoreContextViewInChild(REQUEST, {}, deps);

    expect(restored.outcome).toBe("ok");
    expect(restored.attrs).toMatchObject({ seen: "m-1", restore_child: true });
    expect(JSON.parse(restored.json)).toEqual({ ok: true, line: "a\nb" });
  });

  function pidFile(): string {
    return path.join(dir, "pid");
  }

  async function expectGone(): Promise<void> {
    const pid = Number(readFileSync(pidFile(), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  }

  it("kills a child past the timeout and answers read_failed, since a retry can help", async () => {
    const deps = childRunning(`require("node:fs").writeFileSync(${JSON.stringify(pidFile())}, String(process.pid)); setInterval(() => {}, 1000);`);

    const restored = await restoreContextViewInChild(REQUEST, { timeoutMs: 500 }, deps);

    expect(restored.outcome).toBe("read_failed");
    expect(restored.attrs.failure_detail).toBe("restore_child_timeout");
    expect(JSON.parse(restored.json)).toEqual({ ok: false, reason: "read_failed" });
    await expectGone();
  });

  it("kills the child when the daemon stops", async () => {
    const deps = childRunning(`require("node:fs").writeFileSync(${JSON.stringify(pidFile())}, String(process.pid)); setInterval(() => {}, 1000);`);
    const abort = new AbortController();

    const running = restoreContextViewInChild(REQUEST, { signal: abort.signal, timeoutMs: 30_000 }, deps);
    await vi.waitFor(() => expect(existsSync(pidFile()) && readFileSync(pidFile(), "utf8").length > 0).toBe(true));
    abort.abort();
    const restored = await running;

    expect(restored.attrs.failure_detail).toBe("restore_child_aborted");
    await expectGone();
  });

  it("the heap limit stops a child that runs out of memory, and that is too_large", async () => {
    const deps = childRunning("const held = []; for (;;) held.push(new Array(100000).fill({}));");

    const restored = await restoreContextViewInChild({ ...REQUEST, file: __filename }, { timeoutMs: 60_000 }, { ...deps, maxHeapMb: 32 });

    expect(restored.outcome).toBe("too_large");
    expect(restored.attrs.failure_detail).toBe("restore_child_out_of_memory");
    expect(restored.attrs.source_bytes).toEqual(expect.any(Number));
  }, 90_000);

  it.each([
    ["aborts", "process.abort();"],
    ["is killed from outside", "process.kill(process.pid, 'SIGKILL');"],
    ["exits non-zero", "process.exit(3);"],
    ["exits non-zero after a complete answer", "process.stdout.write(JSON.stringify({ outcome: 'ok', attrs: {} }) + String.fromCharCode(10) + '{}'); process.exitCode = 3;"],
    ["writes no header", "process.stdout.write('no newline here');"],
    ["writes a bad header", "process.stdout.write('not json' + String.fromCharCode(10) + '{}');"],
  ])("a child that %s is read_failed, not a claim about size", async (_name, script) => {
    const restored = await restoreContextViewInChild(REQUEST, {}, childRunning(script));

    expect(restored.outcome).toBe("read_failed");
    expect(restored.attrs.failure_detail).toBe("restore_child_failed");
  });

  it("stops a child whose output passes the cap", async () => {
    const deps = childRunning("setInterval(() => process.stdout.write('x'.repeat(1 << 20)), 1);");

    const restored = await restoreContextViewInChild({ ...REQUEST, maxBytes: 1024 }, { timeoutMs: 30_000 }, deps);

    expect(restored.attrs.failure_detail).toBe("restore_child_output_over_cap");
    expect(restored.outcome).toBe("too_large");
  });

  it("a binary that is gone is read_failed, through the spawn's error event", async () => {
    const restored = await restoreContextViewInChild(REQUEST, {}, {
      host: selfExecHostFromProcess(process, false, process.execPath),
      spawnFn: ((_command: string, _args: string[], options: Parameters<typeof spawn>[2]) => spawn("/no/such/raft-computer", [], options)) as ContextViewRestoreRunnerDeps["spawnFn"],
    });

    expect(restored.outcome).toBe("read_failed");
    expect(restored.attrs.failure_detail).toBe("restore_child_spawn_failed");
  });

  it("a child that can't be spawned is read_failed, and never rejects", async () => {
    const restored = await restoreContextViewInChild(REQUEST, {}, {
      host: selfExecHostFromProcess(process, false, process.execPath),
      spawnFn: (() => { throw new Error("no"); }) as unknown as ContextViewRestoreRunnerDeps["spawnFn"],
    });

    expect(restored.outcome).toBe("read_failed");
    expect(restored.attrs.failure_detail).toBe("restore_child_spawn_failed");
  });

  it("starts no child for a request that's already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    let spawned = 0;

    const restored = await restoreContextViewInChild(REQUEST, { signal: abort.signal }, {
      host: selfExecHostFromProcess(process, false, process.execPath),
      spawnFn: (() => { spawned += 1; throw new Error("no"); }) as unknown as ContextViewRestoreRunnerDeps["spawnFn"],
    });

    expect(spawned).toBe(0);
    expect(restored.attrs.failure_detail).toBe("restore_child_aborted");
  });

  it("a header with an outcome this build doesn't know is read_failed", async () => {
    const restored = await restoreContextViewInChild(REQUEST, {}, childRunning("process.stdout.write(JSON.stringify({ outcome: 'made_up', attrs: {} }) + String.fromCharCode(10) + '{}');"));

    expect(restored.outcome).toBe("read_failed");
  });

  it.each([
    [512 * 2 ** 20, 128],
    [2 * 2 ** 30, 512],
    [64 * 2 ** 30, 1024],
    [16 * 2 ** 20, 64],
  ])("the heap limit for %d bytes of memory is %d MB", (memory, limit) => {
    expect(contextViewRestoreHeapLimitMb(memory)).toBe(limit);
  });

  it("drops the daemon's own heap and inspector flags, and keeps the rest", () => {
    const host = selfExecHostFromProcess(process, false, process.execPath);

    const filtered = contextViewRestoreHost({ ...host, execArgv: ["--import", "x", "--max-old-space-size=8192", "--inspect-brk=0", "--inspect", "--trace-warnings"] });

    expect(filtered.execArgv).toEqual(["--import", "x", "--trace-warnings"]);
  });

  it("sets the heap limit through NODE_OPTIONS, and drops what the daemon inherited", () => {
    expect(contextViewRestoreChildEnv({}, 64).NODE_OPTIONS).toBe("--max-old-space-size=64");
    expect(contextViewRestoreChildEnv({ NODE_OPTIONS: "--require ./noisy.js" }, 64).NODE_OPTIONS).toBe("--max-old-space-size=64");
  });
});

describe("restore child's main", () => {
  it("runs the request and encodes the result as a header line and the body", async () => {
    const output = await runContextViewRestore(JSON.stringify(REQUEST), async (request) => contextViewRestoreFailure("not_found", request.messageId));
    const lineEnd = output.indexOf("\n");

    expect(JSON.parse(output.slice(0, lineEnd))).toEqual({
      outcome: "not_found",
      attrs: { failure_detail: "m-1", child_heap_limit_mb: expect.any(Number), child_max_rss_mb: expect.any(Number) },
    });
    expect(JSON.parse(output.slice(lineEnd + 1))).toEqual({ ok: false, reason: "not_found" });
  });

  it("answers read_failed on a request it can't parse or a restore that throws", async () => {
    expect(await runContextViewRestore("not json")).toContain('"outcome":"read_failed"');
    expect(await runContextViewRestore("{}", async () => { throw new Error("boom"); })).toContain('"outcome":"read_failed"');
  });

  it("answers too_large when a view passes V8's own limits", async () => {
    const output = await runContextViewRestore("{}", async () => { throw new RangeError("Invalid string length"); });

    expect(output).toContain('"outcome":"too_large"');
  });

  it("encodes a body with newlines so the first line stays the header", () => {
    const encoded = encodeContextViewRestored({ json: JSON.stringify({ text: "a\nb" }), outcome: "ok", attrs: {} });

    expect(encoded.split("\n")).toHaveLength(2);
  });
});

describe("restoreContextViewSource", () => {
  it("answers too_large when the serialized view is over the request's cap", async () => {
    const file = path.join(dir, "wire.jsonl");
    const lines = [
      { type: "llm.request", kind: "loop", model: "m" },
      { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "c", args: { command: "raft message send --target x" } } },
      { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "c", result: { output: "Message ID: m-1" } } },
    ];
    writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));

    const restored = await restoreContextViewSource(
      { ...REQUEST, runtime: "kimi-sdk", file, allowedRoots: [dir], offset: null, maxBytes: 10 },
      async () => () => ({
        status: "rebuilt",
        verification: "verified",
        request: { model: "m" },
        systemPrompt: "S",
        tools: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        response: { role: "assistant", content: [], toolCalls: [{ id: "c", name: "Bash", arguments: "{}" }] },
      }),
    );

    expect(restored.outcome).toBe("too_large");
    expect(restored.attrs.failure_detail).toBe("view_over_max_bytes");
  });
});
