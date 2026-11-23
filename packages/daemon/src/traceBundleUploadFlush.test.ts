import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";

// `flushNow`: a Computer online for a few minutes uploaded nothing, because the
// sink's file was still open (or younger than the minimum age) when the session
// ended. A flush closes the file and uploads it now, under every guard a normal
// pass honours.

interface CapturedSpan {
  name: string;
  status?: string;
  attrs: Record<string, unknown>;
}

function capturingTracer(captured: CapturedSpan[]) {
  return {
    startSpan(name: string, options: { attrs?: Record<string, unknown> }) {
      const entry: CapturedSpan = { name, attrs: { ...(options.attrs ?? {}) } };
      captured.push(entry);
      return {
        end(status?: string, endOptions?: { attrs?: Record<string, unknown> }) {
          entry.status = status;
          Object.assign(entry.attrs, endOptions?.attrs ?? {});
        },
        addEvent() {},
        setAttributes() {},
      };
    },
  } as never;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Counts bundle creations; `gate` holds every create until it resolves. */
function countingFetch(gate?: Promise<void>) {
  const counts = { creates: 0 };
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/internal/machine/scope-attestation")) {
      return jsonResponse({
        attestation: "att",
        scope: "daemon-trace-bundle:create",
        audience: "worker",
        resource: "res",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (String(url).includes("/api/trace-bundles")) {
      counts.creates += 1;
      if (gate) await gate;
      return jsonResponse({ upload: { method: "PUT", url: "https://worker.test/object" } });
    }
    return jsonResponse({ ok: true });
  }) as never;
  return { counts, fetchImpl };
}

async function receipts(machineDir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(machineDir, "trace-uploads"))).filter((name) => name.endsWith(".uploaded.json")).sort();
  } catch {
    return [];
  }
}

function event(name: string) {
  return { name, surface: "daemon" as const, timeMs: Date.now(), context: null, attrs: { n: 1 } };
}

async function setup(opts: Record<string, unknown> = {}, gate?: Promise<void>) {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "raft-trace-flush-"));
  const sink = new LocalRotatingTraceSink({ machineDir, maxFiles: 8 });
  const captured: CapturedSpan[] = [];
  const { counts, fetchImpl } = countingFetch(gate);
  const clock = { nowMs: 1_000_000 };
  let rotations = 0;
  const uploader = new DaemonTraceBundleUploader({
    machineDir,
    serverUrl: "https://server.test",
    apiKey: "sk_machine_test",
    workerUrl: "https://worker.test/",
    // The production default: a file younger than a minute is not uploaded.
    minFileAgeMs: 60_000,
    tracer: capturingTracer(captured),
    fetchImpl,
    currentFileProvider: () => sink.getCurrentFile(),
    rotateCurrentFile: () => {
      rotations += 1;
      return sink.rotateNow();
    },
    nowMsProvider: () => clock.nowMs,
    ...opts,
  } as never);
  return {
    machineDir,
    sink,
    uploader,
    captured,
    counts,
    clock,
    rotations: () => rotations,
    flushSpans: () => captured.filter((span) => span.name === "daemon.bundle.flush"),
    cleanup: () => rm(machineDir, { recursive: true, force: true }),
  };
}

test("flushNow uploads the file it just closed despite the minimum age; other young files keep the rule", async () => {
  const t = await setup();
  try {
    // Another producer's file, written a moment ago: it may still be open.
    const young = path.join(t.machineDir, "traces", "daemon-trace-cli-transport-2026-11-17T00-00-00-000Z-9-0000.jsonl");
    t.sink.recordLogEvent(event("daemon.agent.spawn.failed"));
    await writeFile(young, '{"type":"event"}\n');
    const current = t.sink.getCurrentFile();
    assert.ok(current);

    // A normal pass takes neither: one is current, both are younger than a minute.
    assert.equal((await t.uploader.uploadOnce("manual")).uploaded, 0);

    const result = await t.uploader.flushNow("agent_start_failure");
    assert.deepEqual(result, { outcome: "flushed", rotated: true, uploaded: 1 });
    assert.deepEqual(await receipts(t.machineDir), [`${path.basename(current)}.uploaded.json`]);
    assert.equal(t.sink.getCurrentFile(), null, "the flushed file is no longer written to");

    const [span] = t.flushSpans();
    assert.equal(span?.status, "ok");
    assert.deepEqual(span?.attrs, { flush_reason: "agent_start_failure", outcome: "flushed", rotated: true, uploaded: 1 });
    const pass = t.captured.find((s) => s.name === "daemon.bundle.upload_pass" && s.attrs.upload_trigger === "flush");
    assert.ok(pass, "the flush's pass is recorded like any other");
  } finally {
    await t.cleanup();
  }
});

test("flushNow never uploads where a normal pass would not", async () => {
  const cases: Array<{ opts: Record<string, unknown>; reason: string; prep?: (u: DaemonTraceBundleUploader) => void }> = [
    { opts: { privacyMode: () => true }, reason: "privacy_mode" },
    { opts: { apiKey: "" }, reason: "no_credentials" },
    { opts: { workerUrl: null, runnerWorkerUrl: () => ({ url: null, serverProvided: false }) }, reason: "no_receiver" },
    { opts: {}, reason: "stopped", prep: (u) => u.stop() },
  ];
  for (const { opts, reason, prep } of cases) for (const flushReason of ["agent_start_failure", "daemon_stop"] as const) {
    const t = await setup(opts);
    try {
      t.sink.recordLogEvent(event("daemon.agent.spawn.failed"));
      prep?.(t.uploader);
      assert.deepEqual(await t.uploader.flushNow(flushReason), { outcome: "skipped", skippedReason: reason }, `${flushReason}: ${reason}`);
      assert.equal(t.counts.creates, 0, `${reason}: nothing uploaded`);
      assert.equal(t.rotations(), 0, `${reason}: the file is not even closed`);
      assert.equal(t.flushSpans()[0]?.attrs.skipped_reason, reason);
    } finally {
      await t.cleanup();
    }
  }
});

test("a second flush inside five minutes does nothing and is recorded", async () => {
  const t = await setup();
  try {
    t.sink.recordLogEvent(event("first"));
    assert.equal((await t.uploader.flushNow("agent_start_failure")).outcome, "flushed");

    t.sink.recordLogEvent(event("second"));
    t.clock.nowMs += 4 * 60_000;
    assert.deepEqual(await t.uploader.flushNow("agent_start_failure"), { outcome: "skipped", skippedReason: "rate_limited" });
    assert.equal(t.rotations(), 1);
    assert.equal(t.counts.creates, 1);
    assert.deepEqual(t.flushSpans().map((s) => s.attrs.outcome), ["flushed", "skipped"]);
    assert.equal(t.flushSpans()[1]?.attrs.skipped_reason, "rate_limited");

    t.clock.nowMs += 60_000;
    assert.deepEqual(await t.uploader.flushNow("agent_start_failure"), { outcome: "flushed", rotated: true, uploaded: 1 });
    assert.equal((await receipts(t.machineDir)).length, 2);
  } finally {
    await t.cleanup();
  }
});

test("a stop flush is not rate limited: a failure at minute 1 and shutdown at minute 4 both upload", async () => {
  const t = await setup();
  try {
    t.sink.recordLogEvent(event("daemon.agent.spawn.failed"));
    assert.deepEqual(await t.uploader.flushNow("agent_start_failure"), { outcome: "flushed", rotated: true, uploaded: 1 });

    t.sink.recordLogEvent(event("daemon.agent.spawn.failed"));
    t.clock.nowMs += 3 * 60_000;
    // A second failure inside the window still waits...
    assert.deepEqual(await t.uploader.flushNow("agent_start_failure"), { outcome: "skipped", skippedReason: "rate_limited" });
    const later = t.sink.getCurrentFile();
    assert.ok(later);
    // ...but shutdown takes what was recorded since the first flush.
    assert.deepEqual(await t.uploader.flushNow("daemon_stop"), { outcome: "flushed", rotated: true, uploaded: 1 });
    assert.ok((await receipts(t.machineDir)).includes(`${path.basename(later)}.uploaded.json`));
    assert.deepEqual(
      t.flushSpans().map((s) => [s.attrs.flush_reason, s.attrs.outcome]),
      [["agent_start_failure", "flushed"], ["agent_start_failure", "skipped"], ["daemon_stop", "flushed"]],
      "the stop flush records its span",
    );
  } finally {
    await t.cleanup();
  }
});

test("concurrent flushes join one flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = await setup({}, gate);
  try {
    t.sink.recordLogEvent(event("daemon.agent.spawn.failed"));
    const a = t.uploader.flushNow("agent_start_failure");
    const b = t.uploader.flushNow("daemon_stop");
    assert.equal(a, b, "the second call joins the first");
    release();
    assert.deepEqual(await a, { outcome: "flushed", rotated: true, uploaded: 1 });
    assert.equal(t.rotations(), 1);
    assert.equal(t.counts.creates, 1);
    assert.equal(t.flushSpans().length, 1, "a join records nothing of its own");
  } finally {
    await t.cleanup();
  }
});

test("a flush waits for a pass in flight instead of uploading the same files twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = await setup({}, gate);
  try {
    const old = path.join(t.machineDir, "traces", "daemon-trace-2026-11-17T00-00-00-000Z-9-0000.jsonl");
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, '{"type":"event"}\n');
    await utimes(old, new Date("2026-05-08T00:00:00Z"), new Date("2026-05-08T00:00:00Z"));
    // Start a scheduled pass the way the timer would, and hold its upload.
    const scheduled = (t.uploader as unknown as { runScheduledPass(trigger: string): Promise<void> }).runScheduledPass("interval");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(t.counts.creates, 1);

    t.sink.recordLogEvent(event("daemon.agent.spawn.failed"));
    const flush = t.uploader.flushNow("agent_start_failure");
    release();
    await scheduled;
    assert.deepEqual(await flush, { outcome: "flushed", rotated: true, uploaded: 1 });
    assert.equal(t.counts.creates, 2, "the old file once (by the pass), the flushed file once");
    assert.equal((await receipts(t.machineDir)).length, 2);
  } finally {
    t.uploader.stop();
    await t.cleanup();
  }
});

test("a flush that waited past its caller's bound does nothing once the uploader is stopped", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = await setup({}, gate);
  try {
    const old = path.join(t.machineDir, "traces", "daemon-trace-2026-11-17T00-00-00-000Z-9-0000.jsonl");
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, '{"type":"event"}\n');
    await utimes(old, new Date("2026-05-08T00:00:00Z"), new Date("2026-05-08T00:00:00Z"));
    const scheduled = (t.uploader as unknown as { runScheduledPass(trigger: string): Promise<void> }).runScheduledPass("interval");
    await new Promise((resolve) => setTimeout(resolve, 20));

    t.sink.recordLogEvent(event("daemon.agent.spawn.failed"));
    const flush = t.uploader.flushNow("daemon_stop");
    // The shutdown bound passed while the flush waited; the daemon stopped the uploader.
    t.uploader.stop();
    release();
    await scheduled;
    assert.deepEqual(await flush, { outcome: "skipped", skippedReason: "stopped" });
    assert.equal(t.rotations(), 0, "nothing rotated after stop");
    assert.equal(t.counts.creates, 1, "only the pass that was already running");
  } finally {
    await t.cleanup();
  }
});

test("stopScheduling ends the periodic passes but a flush still runs until stop()", async () => {
  const t = await setup();
  try {
    t.uploader.stopScheduling();
    t.sink.recordLogEvent(event("daemon.lifecycle.stop"));
    assert.deepEqual(await t.uploader.flushNow("daemon_stop"), { outcome: "flushed", rotated: true, uploaded: 1 });
    t.uploader.stop();
    t.sink.recordLogEvent(event("after"));
    assert.deepEqual(await t.uploader.flushNow("daemon_stop"), { outcome: "skipped", skippedReason: "stopped" });
  } finally {
    await t.cleanup();
  }
});
