/**
 * Unit tests for slockdev cluster mode (--replicas N) pure logic.
 *
 * Run: node --import tsx --test scripts/dev/slockdev-cluster.test.ts
 *
 * Covers the port-derivation + parse helpers that decide how N server
 * replicas are laid out. The invariants under test are the ones that keep
 * (a) N=1 byte-for-byte identical to the historical single-replica behavior
 * and (b) every replica's derived ports inside its own disjoint ≥100 band so
 * concurrent envs and concurrent replicas never collide.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReplicas,
  replicaServerPort,
  replicaMetricsPort,
  replicaWindowName,
  computeOffset,
  validateEnvironmentName,
} from "./raftdev.ts";

test("replica 1 keeps the canonical server port (13001+offset) for any offset", () => {
  for (const o of [0, 49, 68, 90, 99]) {
    assert.equal(replicaServerPort(o, 1), 13001 + o);
  }
});

test("replica 1 has no metrics port override (server default 9091 → byte-identical N=1)", () => {
  assert.equal(replicaMetricsPort(0, 1), null);
  assert.equal(replicaMetricsPort(68, 1), null);
});

test("extra replica server ports climb disjoint +100 bands", () => {
  const o = 68; // "clustertest"
  assert.equal(replicaServerPort(o, 2), 13101 + o);
  assert.equal(replicaServerPort(o, 3), 13201 + o);
  assert.equal(replicaServerPort(o, 8), 13701 + o);
});

test("extra replica metrics ports are derived + disjoint per replica", () => {
  const o = 68;
  assert.equal(replicaMetricsPort(o, 2), 12001 + o);
  assert.equal(replicaMetricsPort(o, 3), 12101 + o);
  assert.equal(replicaMetricsPort(o, 8), 12601 + o);
});

test("no port collisions across replicas/metrics within one env (any offset)", () => {
  for (const o of [0, 49, 68, 90, 99]) {
    const ports = new Set<number>();
    for (let k = 1; k <= 8; k++) {
      const sp = replicaServerPort(o, k);
      assert.ok(!ports.has(sp), `server port collision at offset ${o} replica ${k}`);
      ports.add(sp);
      const mp = replicaMetricsPort(o, k);
      if (mp !== null) {
        assert.ok(!ports.has(mp), `metrics port collision at offset ${o} replica ${k}`);
        ports.add(mp);
      }
    }
  }
});

test("extra-replica server band (131xx+) never overlaps base server band (130xx) across offsets", () => {
  // replica 1 max = 13001+99 = 13100; replica 2 min = 13101+0 = 13101.
  let r1max = -Infinity;
  let r2min = Infinity;
  for (let o = 0; o <= 99; o++) {
    r1max = Math.max(r1max, replicaServerPort(o, 1));
    r2min = Math.min(r2min, replicaServerPort(o, 2));
  }
  assert.ok(r1max < r2min, `base band max ${r1max} must be below replica-2 band min ${r2min}`);
});

test("parseReplicas: default / empty → 1", () => {
  assert.equal(parseReplicas(undefined), 1);
  assert.equal(parseReplicas(""), 1);
  assert.equal(parseReplicas("  "), 1);
});

test("parseReplicas: valid positive integers", () => {
  assert.equal(parseReplicas("1"), 1);
  assert.equal(parseReplicas("2"), 2);
  assert.equal(parseReplicas(" 8 "), 8);
});

test("parseReplicas: rejects non-integers, zero, negatives, over-cap", () => {
  assert.throws(() => parseReplicas("0"), /positive integer/);
  assert.throws(() => parseReplicas("-1"), /positive integer/);
  assert.throws(() => parseReplicas("2.5"), /positive integer/);
  assert.throws(() => parseReplicas("two"), /positive integer/);
  assert.throws(() => parseReplicas("9"), /capped at 8/);
  assert.throws(() => parseReplicas("100"), /capped at 8/);
});

test("replicaWindowName: window 1 is 'server', extras are 'server-k'", () => {
  assert.equal(replicaWindowName(1), "server");
  assert.equal(replicaWindowName(2), "server-2");
  assert.equal(replicaWindowName(3), "server-3");
});

test("offset sanity anchor (clustertest=68) for the boot-verify env", () => {
  assert.equal(computeOffset("clustertest"), 68);
});

test("environment names use one path-safe ASCII contract", () => {
  for (const name of ["dev", "dev-2", "_scratch", ".preview", "-local", "a.b_c-9"]) {
    assert.equal(validateEnvironmentName(name), name);
  }
  for (const name of ["", ".", "..", "two words", "nested/env", "测试", "a".repeat(129)]) {
    assert.throws(() => validateEnvironmentName(name), /environment name must be/);
  }
});
