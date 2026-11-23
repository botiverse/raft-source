import assert from "node:assert/strict";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

import { RuntimeModelSourceCache, type RuntimeModelDetect } from "./modelSourceCache";

function live(id: string): RuntimeModelSourceOutcome {
  return { kind: "live", value: { models: [{ id, label: id, verified: "launchable" }] } };
}

/** A detector that answers from a queue and records each call's mode. */
function scripted(...answers: Array<RuntimeModelSourceOutcome | Error>) {
  const calls: Array<"foreground" | "background"> = [];
  const detect: RuntimeModelDetect = async (mode) => {
    calls.push(mode);
    const next = answers.shift();
    if (!next) throw new Error("detector called more often than scripted");
    if (next instanceof Error) throw next;
    return next;
  };
  return { detect, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the first read waits for a detection (miss); a read inside the fresh window runs none", async () => {
  let now = 0;
  const cache = new RuntimeModelSourceCache(() => now, 60_000);
  const { detect, calls } = scripted(live("a"));
  assert.deepEqual(await cache.read("codex", detect), { outcome: live("a"), cache: "miss" });
  now = 59_999;
  assert.deepEqual(await cache.read("codex", detect), { outcome: live("a"), cache: "fresh" });
  assert.deepEqual(calls, ["foreground"]);
});

test("a stale read answers with the old list at once and refreshes in the background", async () => {
  let now = 0;
  const cache = new RuntimeModelSourceCache(() => now, 60_000);
  const { detect, calls } = scripted(live("old"), live("new"));
  await cache.read("codex", detect);
  now = 60_000;
  assert.deepEqual(await cache.read("codex", detect), { outcome: live("old"), cache: "stale" });
  await settle();
  assert.deepEqual(calls, ["foreground", "background"]);
  assert.deepEqual(await cache.read("codex", detect), { outcome: live("new"), cache: "fresh" });
});

test("concurrent stale reads start one background refresh", async () => {
  let now = 0;
  const cache = new RuntimeModelSourceCache(() => now, 60_000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const detect: RuntimeModelDetect = async (mode) => {
    calls.push(mode);
    if (mode === "background") await gate;
    return live(mode);
  };
  await cache.read("codex", detect);
  now = 120_000;
  await cache.read("codex", detect);
  await cache.read("codex", detect);
  release();
  await settle();
  assert.deepEqual(calls, ["foreground", "background"]);
});

test("force bypasses a fresh entry and waits for a new detection", async () => {
  const cache = new RuntimeModelSourceCache(() => 0, 60_000);
  const { detect, calls } = scripted(live("a"), live("b"));
  await cache.read("codex", detect);
  assert.deepEqual(await cache.read("codex", detect, { force: true }), { outcome: live("b"), cache: "forced" });
  assert.deepEqual(calls, ["foreground", "foreground"]);
});

test("a definitive non-live answer drops the cached list, so it is never offered again", async () => {
  let now = 0;
  const cache = new RuntimeModelSourceCache(() => now, 60_000);
  const signedOut: RuntimeModelSourceOutcome = { kind: "error", retryable: true, code: "runtime_not_authenticated" };
  const { detect, calls } = scripted(live("a"), signedOut, signedOut);
  await cache.read("codex", detect);
  now = 60_000;
  await cache.read("codex", detect); // stale: old list, refresh learns the user signed out
  await settle();
  assert.deepEqual(await cache.read("codex", detect), { outcome: signedOut, cache: "miss" });
  assert.deepEqual(calls, ["foreground", "background", "foreground"]);
});

test("non-live answers are never cached", async () => {
  const cache = new RuntimeModelSourceCache(() => 0, 60_000);
  const { detect, calls } = scripted({ kind: "no_models" }, live("a"));
  assert.deepEqual(await cache.read("opencode", detect), { outcome: { kind: "no_models" }, cache: "miss" });
  assert.deepEqual(await cache.read("opencode", detect), { outcome: live("a"), cache: "miss" });
  assert.deepEqual(calls, ["foreground", "foreground"]);
});

test("a transient refresh failure (timeout, failed probe, codeless error, throw) keeps the previous list", async () => {
  for (const failure of [
    { kind: "error", retryable: true, code: "detect_timeout" } as const,
    { kind: "error", retryable: true, code: "detect_failed" } as const,
    { kind: "error", retryable: true } as const,
    { kind: "error", retryable: true, code: "runtime_not_found", reason: "probe_timeout" } as const,
    { kind: "error", retryable: true, code: "runtime_not_found", reason: "probe_failed" } as const,
    { kind: "error", retryable: true, code: "runtime_not_found", reason: "permission_denied" } as const,
    new Error("spawn failed"),
  ]) {
    let now = 0;
    const cache = new RuntimeModelSourceCache(() => now, 60_000);
    const { detect } = scripted(live("a"), failure);
    await cache.read("grok", detect);
    now = 60_000;
    await cache.read("grok", detect);
    await settle();
    assert.deepEqual((await cache.read("grok", detect)).outcome, live("a"), `after ${JSON.stringify(failure)}`);
  }
});

test("store() from the connect-time push warms the cache", async () => {
  const cache = new RuntimeModelSourceCache(() => 0, 60_000);
  cache.store("kimi-sdk", live("pushed"));
  const { detect, calls } = scripted();
  assert.deepEqual(await cache.read("kimi-sdk", detect), { outcome: live("pushed"), cache: "fresh" });
  assert.deepEqual(calls, []);
});

test("runtimes are cached independently", async () => {
  const cache = new RuntimeModelSourceCache(() => 0, 60_000);
  const { detect } = scripted(live("codex-model"), live("grok-model"));
  await cache.read("codex", detect);
  assert.deepEqual((await cache.read("grok", detect)).outcome, live("grok-model"));
});

test("a confirmed absence (runtime_not_found: not_installed, or no reason) drops the list", async () => {
  for (const gone of [
    { kind: "error", retryable: true, code: "runtime_not_found", reason: "not_installed" } as const,
    { kind: "error", retryable: true, code: "runtime_not_found" } as const,
  ]) {
    let now = 0;
    const cache = new RuntimeModelSourceCache(() => now, 60_000);
    const { detect } = scripted(live("a"), gone, gone);
    await cache.read("grok", detect);
    now = 60_000;
    await cache.read("grok", detect);
    await settle();
    assert.deepEqual(await cache.read("grok", detect), { outcome: gone, cache: "miss" }, `after ${JSON.stringify(gone)}`);
  }
});

test("Antigravity's list (one agy session per listing) stays fresh for a day; other runtimes keep the short window", async () => {
  let now = 0;
  const cache = new RuntimeModelSourceCache(() => now);
  const agy = scripted(live("a"), live("b"), live("e"));
  const codex = scripted(live("c"), live("d"));
  await cache.read("antigravity", agy.detect);
  await cache.read("codex", codex.detect);
  now = 24 * 60 * 60_000 - 1;
  assert.deepEqual(await cache.read("antigravity", agy.detect), { outcome: live("a"), cache: "fresh" });
  assert.equal((await cache.read("codex", codex.detect)).cache, "stale");
  now = 24 * 60 * 60_000;
  assert.deepEqual(await cache.read("antigravity", agy.detect), { outcome: live("a"), cache: "stale" });
  await settle();
  assert.deepEqual(agy.calls, ["foreground", "background"]);
  assert.deepEqual(await cache.read("antigravity", agy.detect, { force: true }), { outcome: live("e"), cache: "forced" }, "the form's refresh still bypasses the window");
});

test("peek returns the last live list at any age without a detection, and nothing once it is dropped", async () => {
  let now = 0;
  const cache = new RuntimeModelSourceCache(() => now, 60_000);
  assert.equal(cache.peek("antigravity"), null);
  cache.store("antigravity", live("a"));
  now = 10 * 24 * 60 * 60_000;
  assert.deepEqual(cache.peek("antigravity"), (live("a") as Extract<RuntimeModelSourceOutcome, { kind: "live" }>).value);
  cache.store("antigravity", { kind: "unsupported" });
  assert.equal(cache.peek("antigravity"), null);
});
