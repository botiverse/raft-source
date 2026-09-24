/**
 * Unit tests for slockdev's latency profile parser. Run locally:
 *   node --import tsx --test scripts/dev/slockdev-latency.test.ts
 *
 * The parser is the only piece of slockdev's latency support that is pure
 * logic — the proxy itself is exercised by manual / Sammy's
 * Windows verification (Sammy review checklist on the PR). Tests cover the
 * accept/reject matrix Sammy asked for: clear bounded range, reject
 * malformed values early.
 */
import assert from "node:assert/strict";
import test from "node:test";
// Matches the .js-extension convention used elsewhere in the repo for
// relative test imports; tsx resolves it to raftdev.ts at runtime.
import {
  packageManagerCommand,
  packageManagerSpawnShell,
  parseLatencyProfile,
} from "./raftdev.js";

test("parseLatencyProfile: single integer is treated as a fixed delay", () => {
  const p = parseLatencyProfile("250");
  assert.equal(p.minMs, 250);
  assert.equal(p.maxMs, 250);
  assert.match(p.label, /250ms \(fixed\)/);
});

test("parseLatencyProfile: <min>-<max> form parses as a uniform range", () => {
  const p = parseLatencyProfile("100-300");
  assert.equal(p.minMs, 100);
  assert.equal(p.maxMs, 300);
  assert.match(p.label, /100-300ms \(uniform\)/);
});

test("parseLatencyProfile: leading/trailing whitespace is tolerated", () => {
  const p = parseLatencyProfile("  300-800 ");
  assert.equal(p.minMs, 300);
  assert.equal(p.maxMs, 800);
});

test("parseLatencyProfile: zero is allowed (effectively no delay, but explicit)", () => {
  const p = parseLatencyProfile("0");
  assert.equal(p.minMs, 0);
  assert.equal(p.maxMs, 0);
});

test("parseLatencyProfile: non-numeric input is rejected", () => {
  assert.throws(() => parseLatencyProfile("fast"), /must be/);
  assert.throws(() => parseLatencyProfile("100ms"), /must be/);
});

test("parseLatencyProfile: malformed range syntax is rejected", () => {
  assert.throws(() => parseLatencyProfile("100-"), /must be/);
  assert.throws(() => parseLatencyProfile("-300"), /must be/);
  assert.throws(() => parseLatencyProfile("100--300"), /must be/);
  assert.throws(() => parseLatencyProfile("100-300-500"), /must be/);
});

test("parseLatencyProfile: negative numbers are rejected (regex blocks the '-' as prefix)", () => {
  assert.throws(() => parseLatencyProfile("-100"), /must be/);
});

test("parseLatencyProfile: reversed range (max < min) is rejected", () => {
  assert.throws(() => parseLatencyProfile("300-100"), />= min/);
});

test("parseLatencyProfile: upper bound is capped at 10000ms", () => {
  // Accepts 10000 exactly.
  const p = parseLatencyProfile("0-10000");
  assert.equal(p.maxMs, 10000);
  // Rejects anything beyond.
  assert.throws(() => parseLatencyProfile("10001"), /capped at 10000ms/);
  assert.throws(() => parseLatencyProfile("100-10001"), /capped at 10000ms/);
});

test("parseLatencyProfile: empty string is rejected", () => {
  assert.throws(() => parseLatencyProfile(""), /must be/);
  assert.throws(() => parseLatencyProfile("   "), /must be/);
});

test("slockdev package manager commands use Windows .cmd shims", () => {
  assert.equal(packageManagerCommand("npx", "win32"), "npx.cmd");
  assert.equal(packageManagerCommand("pnpm", "win32"), "pnpm.cmd");
  assert.equal(packageManagerCommand("npx", "linux"), "npx");
  assert.equal(packageManagerCommand("pnpm", "darwin"), "pnpm");
});

test("slockdev package manager subprocesses use shell only on Windows", () => {
  assert.equal(packageManagerSpawnShell("win32"), true);
  assert.equal(packageManagerSpawnShell("linux"), false);
  assert.equal(packageManagerSpawnShell("darwin"), false);
});
