import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  BasicTracer,
  MemoryTraceSink,
  type CompletedTraceSpan,
} from "@botiverse/raft-shared";

import { createComputerApi } from "./api.js";

// Span-based replacement for the deleted file-trace tests. The single-writer
// ops (reset / upgrade routing) now emit spans through the caller-injected
// tracer; we assert on the in-memory sink rather than a file trace.

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-api-trace-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function findSpan(spans: readonly CompletedTraceSpan[], name: string): CompletedTraceSpan {
  const span = spans.find((s) => s.name === name);
  assert.ok(span, `expected a span named "${name}", got ${spans.map((s) => s.name).join(", ")}`);
  return span;
}

function routeDecision(span: CompletedTraceSpan): unknown {
  const event = span.events.find((e) => e.name === "route-decided");
  assert.ok(event, `expected a "route-decided" event on span "${span.name}"`);
  return (event.attrs as Record<string, unknown> | undefined)?.decision;
}

test("resetService on a fresh home (no service) emits a via-disk reset-service span", async () => {
  await withHome(async (home) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });

    // Fresh tmp home: no service socket → connectService fails → disk path.
    const result = await createComputerApi(home, { tracer }).resetService();
    assert.equal(result.status, "ok");

    const span = findSpan(sink.getAllSpans(), "reset-service");
    assert.equal(span.surface, "computer");
    assert.equal(span.kind, "internal");
    assert.equal(span.status, "ok");
    assert.equal(routeDecision(span), "via-disk");
  });
});

test("tryUpgradeViaService on a fresh home routes standalone and emits an upgrade span", async () => {
  await withHome(async (home) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });

    // Fresh tmp home: no service socket AND no live pidfile → connectService
    // fails → standalone with reason "no-service" (cold boot; safe to swap).
    // #wg-raft-computer task #100.
    const routing = await createComputerApi(home, { tracer }).tryUpgradeViaService("1.2.3");
    assert.equal(routing.routed, false);
    assert.equal(routing.routed === false && routing.reason, "no-service");

    const span = findSpan(sink.getAllSpans(), "upgrade");
    assert.equal(span.surface, "computer");
    assert.equal(span.kind, "internal");
    assert.equal(span.status, "ok");
    assert.equal(routeDecision(span), "standalone");
  });
});

test("tryUpgradeViaService with a live service pidfile but unreachable socket → reason 'unreachable' (fail-loud, NOT standalone) — task #100", async () => {
  await withHome(async (home) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });

    // Plant a service pidfile pointing at a LIVE process (our own pid) with NO
    // IPC socket listening → connectService fails, but the read-only liveness
    // probe sees a live pid → must report "unreachable" so the CLI/menu-bar
    // fail loud instead of swapping the binary under a running service (the
    // exact silent-strand bug task #100 kills).
    const { servicePidPath, serviceRunDir } = await import("../paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(serviceRunDir(home), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid), { mode: 0o600 });

    const routing = await createComputerApi(home, { tracer }).tryUpgradeViaService("1.2.3");
    assert.equal(routing.routed, false);
    assert.equal(routing.routed === false && routing.reason, "unreachable");

    // route-decided span still emitted, carrying the reason.
    const span = findSpan(sink.getAllSpans(), "upgrade");
    assert.equal(span.status, "ok");
    assert.equal(routeDecision(span), "standalone");
  });
});

test("createComputerApi defaults to a zero-side-effect tracer (no tracer arg)", async () => {
  await withHome(async (home) => {
    // No tracer injected → noopTracer → resetService still works, no throw.
    const result = await createComputerApi(home).resetService();
    assert.equal(result.status, "ok");
  });
});
