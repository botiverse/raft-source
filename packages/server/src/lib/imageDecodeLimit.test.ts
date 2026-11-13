import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_IMAGE_DECODE_CONCURRENCY,
  imageDecodeConcurrency,
  MAX_IMAGE_DECODE_CONCURRENCY,
  withImageDecodeSlot,
} from "./imageDecodeLimit";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Run `count` calls through `slot`, each held until the test lets it go; counts the peak in flight. */
function heldCalls(slot: typeof withImageDecodeSlot, count: number, failing: number[] = []) {
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  const releases = new Map<number, () => void>();
  const results = Array.from({ length: count }, (_, id) => slot(async () => {
    started.push(id);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => releases.set(id, resolve));
    inFlight -= 1;
    if (failing.includes(id)) throw new Error(`decode ${id} failed`);
    return id;
  }));
  return { results, started, releases, peak: () => peak, inFlight: () => inFlight };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("IMAGE_DECODE_CONCURRENCY is an integer clamped to 1..16, the default 2 when unset or not a number", () => {
  assert.equal(DEFAULT_IMAGE_DECODE_CONCURRENCY, 2);
  assert.equal(MAX_IMAGE_DECODE_CONCURRENCY, 16);
  assert.equal(imageDecodeConcurrency(undefined), 2);
  assert.equal(imageDecodeConcurrency(""), 2);
  assert.equal(imageDecodeConcurrency("  "), 2);
  assert.equal(imageDecodeConcurrency("many"), 2);
  assert.equal(imageDecodeConcurrency("3"), 3);
  assert.equal(imageDecodeConcurrency(" 4 "), 4);
  assert.equal(imageDecodeConcurrency("2.9"), 2);
  assert.equal(imageDecodeConcurrency("0"), 1);
  assert.equal(imageDecodeConcurrency("-5"), 1);
  assert.equal(imageDecodeConcurrency("1000"), 16);
});

test("withImageDecodeSlot runs at most the default number of calls at once, in call order", async () => {
  const calls = heldCalls(withImageDecodeSlot, 6);
  await tick();
  assert.deepEqual(calls.started, [0, 1]);
  for (let id = 0; id < 6; id += 1) {
    calls.releases.get(id)!();
    await calls.results[id];
    await tick();
  }
  assert.deepEqual(await Promise.all(calls.results), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(calls.started, [0, 1, 2, 3, 4, 5]);
  assert.equal(calls.peak(), DEFAULT_IMAGE_DECODE_CONCURRENCY);
});

test("a failed decode rejects its own call and gives its slot to the next", async () => {
  const calls = heldCalls(withImageDecodeSlot, 3, [0]);
  await tick();
  assert.deepEqual(calls.started, [0, 1]);
  calls.releases.get(0)!();
  await assert.rejects(calls.results[0]!, /decode 0 failed/);
  await tick();
  assert.deepEqual(calls.started, [0, 1, 2]);
  calls.releases.get(1)!();
  calls.releases.get(2)!();
  assert.deepEqual(await Promise.all(calls.results.slice(1)), [1, 2]);
  assert.equal(calls.inFlight(), 0);
});

test("the shared limit is sized by IMAGE_DECODE_CONCURRENCY when the module loads", async () => {
  vi.stubEnv("IMAGE_DECODE_CONCURRENCY", "3");
  vi.resetModules();
  const { withImageDecodeSlot: slot } = await import("./imageDecodeLimit");
  const calls = heldCalls(slot, 5);
  await tick();
  assert.deepEqual(calls.started, [0, 1, 2]);
  for (const release of calls.releases.values()) release();
  while (calls.started.length < 5) {
    await tick();
    for (const release of calls.releases.values()) release();
  }
  await Promise.all(calls.results);
  assert.equal(calls.peak(), 3);
});

test("a call made from inside a slot runs in it rather than waiting for another (no deadlock at 1)", async () => {
  vi.stubEnv("IMAGE_DECODE_CONCURRENCY", "1");
  vi.resetModules();
  const { withImageDecodeSlot: slot } = await import("./imageDecodeLimit");
  const nested = await slot(async () => slot(async () => "inner"));
  assert.equal(nested, "inner");
  // The outer slot was given back: the next call runs.
  assert.equal(await slot(async () => "after"), "after");
});

test("the in-slot exemption ends with the slot: work started there and run later waits like any call", async () => {
  vi.stubEnv("IMAGE_DECODE_CONCURRENCY", "1");
  vi.resetModules();
  const { withImageDecodeSlot: slot } = await import("./imageDecodeLimit");
  const order: string[] = [];
  let late: Promise<void> | undefined;
  await slot(async () => {
    // Not awaited: it runs after this slot is given back.
    setTimeout(() => { late = slot(async () => { order.push("late"); }); }, 0);
  });
  let releaseHolder!: () => void;
  const holder = slot(() => new Promise<void>((resolve) => { order.push("holder"); releaseHolder = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["holder"], "the late call waits for the one slot");
  releaseHolder();
  await holder;
  await late;
  assert.deepEqual(order, ["holder", "late"]);
});

test("each call records how long it waited for a slot on the current trace", async () => {
  vi.stubEnv("IMAGE_DECODE_CONCURRENCY", "1");
  vi.resetModules();
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  vi.doMock("../tracing/semanticTrace", () => ({
    safeAddTraceEvent: (name: string, getAttrs: () => Record<string, unknown>) => { events.push({ name, attrs: getAttrs() }); },
  }));
  try {
    const { withImageDecodeSlot: slot } = await import("./imageDecodeLimit");
    await slot(async () => "one");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.name, "image_decode.slot");
    assert.equal(typeof events[0]!.attrs.wait_ms, "number");
    assert.equal(events[0]!.attrs.concurrency, 1);
  } finally {
    vi.doUnmock("../tracing/semanticTrace");
  }
});

test("every server module that runs sharp goes through withImageDecodeSlot", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Test helpers build fixtures with sharp; they never run in the server.
        if (full !== path.join(src, "test")) walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(full, "utf8");
      if (/from "sharp"/.test(source) && !/withImageDecodeSlot\(/.test(source)) offenders.push(path.relative(src, full));
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});
