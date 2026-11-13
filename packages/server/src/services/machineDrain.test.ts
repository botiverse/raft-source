import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_DRAIN_POLL_INTERVAL_MS, DRAIN_PROBE_TIMEOUT_MS } from "./drainCoordinator";
import {
  DEFAULT_DRAIN_CLOSE_SPREAD_MS,
  DRAIN_SPREAD_MARGIN_MS,
  MACHINE_DRAIN_CLOSE_CODE,
  MACHINE_DRAIN_CLOSE_REASON,
  closeConnectionsForDrain,
  spreadClosesForDrain,
  type DrainClosableSocket,
} from "./machineDrain";

/**
 * The going-away close is what lets a daemon learn about a drain minutes
 * before the ALB hard cut instead of through its 70s inbound watchdog
 * (task #261). These tests pin the wire contract (1001 server_draining) and,
 * after the #8638 batching defect (25-per-batch sends the whole first batch
 * at t=0 at production's ~29 connections per task), the pacing contract:
 * closes spread evenly at ANY connection count.
 */

function fakeSocket(readyState: number) {
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket: DrainClosableSocket = {
    readyState,
    OPEN: 1,
    close(code, reason) {
      closes.push({ code, reason });
    },
  };
  return { socket, closes };
}

/** Virtual clock advanced only by the injected sleep. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
}

function connections(n: number) {
  return Array.from({ length: n }, (_, index) => {
    const s = fakeSocket(1);
    return { machineId: `m${index}`, ws: s.socket, closes: s.closes };
  });
}

/** Connections whose sockets record the (virtual) time of each close. The
 * pacing loop reads the clock more than once per iteration, so close times
 * must be taken at the socket, not from the clock's call log. */
function timedConnections(n: number, clock: { now: () => number }) {
  const closeTimes: number[] = [];
  const conns = Array.from({ length: n }, (_, index) => {
    const ws: DrainClosableSocket = {
      readyState: 1,
      OPEN: 1,
      close() {
        closeTimes.push(clock.now());
      },
    };
    return { machineId: `m${index}`, ws };
  });
  return { conns, closeTimes };
}

test("open sockets are closed with 1001 server_draining; non-open sockets are skipped", async () => {
  const open = fakeSocket(1);
  const connecting = fakeSocket(0);
  const alreadyClosed = fakeSocket(3);
  const clock = fakeClock();

  const result = await closeConnectionsForDrain(
    [
      { machineId: "m-open", ws: open.socket },
      { machineId: "m-connecting", ws: connecting.socket },
      { machineId: "m-closed", ws: alreadyClosed.socket },
    ],
    { sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.closed, 1);
  assert.deepEqual(open.closes, [{ code: MACHINE_DRAIN_CLOSE_CODE, reason: MACHINE_DRAIN_CLOSE_REASON }]);
  assert.equal(MACHINE_DRAIN_CLOSE_CODE, 1001);
  assert.deepEqual(connecting.closes, []);
  assert.deepEqual(alreadyClosed.closes, []);
});

test("production scale (n=30, spread=120s): closes spread across the window, peak 10s-window count <= 3", async () => {
  // The 10s window is the acceptance shape, not an arbitrary constant: the
  // pool's time constant (a reconcile holds a connection ~20-25s, measured
  // 2026-09-29 prod) is the same order of magnitude, so the count inside a
  // ~10s window is what decides whether the pool fills. A 60s window would
  // pass the same code trivially while no longer measuring pool pressure.
  const clock = fakeClock();
  const { conns, closeTimes } = timedConnections(30, clock);

  const result = await closeConnectionsForDrain(conns, { spreadMs: 120_000, sleep: clock.sleep, now: clock.now });

  assert.equal(result.closed, 30);
  // One close every 120s/30 = 4s: first at t=0, last at t=116s.
  assert.equal(result.spanMs, 116_000);
  assert.ok(result.spanMs >= 100_000, `span ${result.spanMs}ms must cover most of the 120s budget`);
  let peak = 0;
  for (const start of closeTimes) {
    peak = Math.max(peak, closeTimes.filter((t) => t >= start && t < start + 10_000).length);
  }
  assert.ok(peak <= 3, `peak 10s-window close count ${peak} exceeds 3`);
});

test("production scale as measured (n=200, spread=120s): ~1.7 closes/s, peak 10s-window count <= 17", async () => {
  // NotZZ measured the 1.19.1 prod deploy (2026-09-29 17:01Z): 100-220
  // machine connections per task, median ~193 across 11 long-running tasks,
  // ~2,083 machines in total. The n=30 case above was sized from an earlier
  // "~29 per task" estimate; this case pins the real cardinality so the
  // pacing is evaluated where it actually runs (Stone's #8638 lesson).
  const clock = fakeClock();
  const { conns, closeTimes } = timedConnections(200, clock);

  const result = await closeConnectionsForDrain(conns, { spreadMs: 120_000, sleep: clock.sleep, now: clock.now });

  assert.equal(result.closed, 200);
  // One close every 120s/200 = 600ms: first at t=0, last at t=119.4s.
  assert.equal(result.spanMs, 119_400);
  let peak = 0;
  for (const start of closeTimes) {
    peak = Math.max(peak, closeTimes.filter((t) => t >= start && t < start + 10_000).length);
  }
  // 10s / 600ms = 16.7 closes per window: ~1.7 reconnects/s per task,
  // ~20/s across 12 tasks. Above 17 means the pacing collapsed into bursts.
  assert.ok(peak <= 17, `peak 10s-window close count ${peak} exceeds 17`);
});

test("staging scale (n=4, spread=120s): span ~= 90s, so staging can actually measure the spread", async () => {
  const conns = connections(4);
  const clock = fakeClock();

  const result = await closeConnectionsForDrain(
    conns.map(({ machineId, ws }) => ({ machineId, ws })),
    { spreadMs: 120_000, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.closed, 4);
  // One close every 30s: first at t=0, last at t=90s.
  assert.equal(result.spanMs, 90_000);
});

test("a single connection is closed immediately with no waiting", async () => {
  const conns = connections(1);
  const clock = fakeClock();

  const result = await closeConnectionsForDrain(
    conns.map(({ machineId, ws }) => ({ machineId, ws })),
    { spreadMs: 120_000, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.closed, 1);
  assert.equal(clock.elapsed(), 0);
  assert.equal(result.spanMs, 0);
});

test("under the SIGTERM-fallback budget every connection is closed before the deadline", async () => {
  // The signal trigger gets a budget smaller than the shutdown deadline
  // (server.ts: min(spread, deadline - 5s)). This pins that the pacing
  // always completes within the budget it is given: a 120s spread must
  // never be cut in half by process.exit, turning the tail into 1006s.
  const conns = connections(30);
  const clock = fakeClock();

  const result = await closeConnectionsForDrain(
    conns.map(({ machineId, ws }) => ({ machineId, ws })),
    { spreadMs: 20_000, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.closed, 30);
  assert.ok(clock.elapsed() <= 20_000, `pacing took ${clock.elapsed()}ms, over the 20_000ms budget`);
  for (const c of conns) assert.equal(c.closes.length, 1);
});

test("a socket that throws on close is reported and does not stop the pacing", async () => {
  const failing: DrainClosableSocket = {
    readyState: 1,
    OPEN: 1,
    close() {
      throw new Error("boom");
    },
  };
  const healthy = fakeSocket(1);
  const warnings: string[] = [];
  const clock = fakeClock();

  const result = await closeConnectionsForDrain(
    [
      { machineId: "m-failing", ws: failing },
      { machineId: "m-healthy", ws: healthy.socket },
    ],
    { warn: (message) => warnings.push(message), sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.closed, 1);
  assert.equal(healthy.closes.length, 1);
  assert.equal(warnings.length, 1);
});

// Reads private infra Terraform that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));
test.skipIf(inSourceSnapshot)("drain window invariant: every target group's deregistration_delay covers the spread default + margin", () => {
  // Cross-side invariant (Manjusaka's gate): this test reads BOTH the
  // Terraform target groups AND the server's spread default, so a change to
  // either side without the other turns CI red. Unset deregistration_delay
  // means the AWS default of 300s — that default is asserted, not assumed
  // silently. The terraform-side twin (drain-window.tftest.hcl) pins the
  // same floor at plan time for both target groups.
  const mainTf = readFileSync(
    fileURLToPath(new URL("../../../../infra/aws-server/modules/server-service/main.tf", import.meta.url)),
    "utf8",
  );
  const requiredSeconds = (DEFAULT_DRAIN_CLOSE_SPREAD_MS + DRAIN_SPREAD_MARGIN_MS) / 1000;
  for (const group of ["server", "server_alternate"]) {
    const blockStart = mainTf.indexOf(`resource "aws_lb_target_group" "${group}" {`);
    assert.notEqual(blockStart, -1, `target group ${group} must exist in server-service/main.tf`);
    const blockEnd = mainTf.indexOf("\nresource ", blockStart);
    const block = mainTf.slice(blockStart, blockEnd === -1 ? undefined : blockEnd);
    const explicit = block.match(/deregistration_delay\s*=\s*(\d+)/);
    const delaySeconds = explicit ? Number(explicit[1]) : 300; // unset = AWS default 300
    assert.ok(
      delaySeconds >= requiredSeconds,
      `target group ${group}: deregistration_delay ${delaySeconds}s must cover the drain spread ` +
        `${DEFAULT_DRAIN_CLOSE_SPREAD_MS / 1000}s + margin ${DRAIN_SPREAD_MARGIN_MS / 1000}s = ${requiredSeconds}s`,
    );
  }

  // Detection budget (task #268): the control-plane probe runs every
  // DEFAULT_DRAIN_POLL_INTERVAL_MS with a DRAIN_PROBE_TIMEOUT_MS timeout, so
  // the first going-away can lag deregistration by up to poll + timeout.
  // The whole chain must fit the delay; a poll interval bumped to 30s
  // without touching the delay turns this red.
  const budgetSeconds = (DEFAULT_DRAIN_POLL_INTERVAL_MS + DRAIN_PROBE_TIMEOUT_MS + DEFAULT_DRAIN_CLOSE_SPREAD_MS + DRAIN_SPREAD_MARGIN_MS) / 1000;
  for (const group of ["server", "server_alternate"]) {
    const blockStart = mainTf.indexOf(`resource "aws_lb_target_group" "${group}" {`);
    const blockEnd = mainTf.indexOf("\nresource ", blockStart);
    const block = mainTf.slice(blockStart, blockEnd === -1 ? undefined : blockEnd);
    const explicit = block.match(/deregistration_delay\s*=\s*(\d+)/);
    const delaySeconds = explicit ? Number(explicit[1]) : 300;
    assert.ok(
      budgetSeconds <= delaySeconds,
      `target group ${group}: poll ${DEFAULT_DRAIN_POLL_INTERVAL_MS / 1000}s + probe timeout ${DRAIN_PROBE_TIMEOUT_MS / 1000}s + spread ` +
        `${DEFAULT_DRAIN_CLOSE_SPREAD_MS / 1000}s + margin ${DRAIN_SPREAD_MARGIN_MS / 1000}s = ${budgetSeconds}s ` +
        `must fit inside deregistration_delay ${delaySeconds}s`,
    );
  }

  // The plan-time twin (drain-window.tftest.hcl) asserts the floor against
  // var.drain_spread_seconds (task #263: one owner of the number), so the
  // remaining cross-side checks are: the variable's default equals the code
  // constant, the margin literal equals DRAIN_SPREAD_MARGIN_MS, and no copied
  // spread literal has crept back into the tftest.
  const variablesTf = readFileSync(
    fileURLToPath(new URL("../../../../infra/aws-server/modules/server-service/variables.tf", import.meta.url)),
    "utf8",
  );
  const spreadVar = variablesTf.slice(variablesTf.indexOf('variable "drain_spread_seconds" {'));
  const spreadDefault = spreadVar.match(/default\s*=\s*(\d+)/);
  assert.ok(spreadDefault, "variables.tf must declare a default for drain_spread_seconds");
  assert.equal(Number(spreadDefault![1]), DEFAULT_DRAIN_CLOSE_SPREAD_MS / 1000, "var.drain_spread_seconds default must equal DEFAULT_DRAIN_CLOSE_SPREAD_MS");

  const tftest = readFileSync(
    fileURLToPath(
      new URL("../../../../infra/aws-server/modules/server-service/tests/drain-window.tftest.hcl", import.meta.url),
    ),
    "utf8",
  );
  const margins = [...tftest.matchAll(/>=\s*var\.drain_spread_seconds\s*\+\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(margins.length >= 2, "drain-window.tftest.hcl must assert the floor against var.drain_spread_seconds (all-groups run + no-canary run)");
  for (const marginSeconds of margins) {
    assert.equal(marginSeconds, DRAIN_SPREAD_MARGIN_MS / 1000, "tftest margin literal must equal DRAIN_SPREAD_MARGIN_MS");
  }
  assert.ok(
    !/>=\s*\d+\s*\+\s*\d+/.test(tftest),
    "the drain-window invariant must compare against var.drain_spread_seconds, not a copied literal",
  );
});

test("browser and SSE closes use the same even spread, and skipped items keep their slot", async () => {
  // ~911 browser sockets on one task at v1.21.19; they used to close in one
  // tick. Every 4th one is already gone and returns false.
  const clock = fakeClock();
  const closeTimes: number[] = [];
  const items = Array.from({ length: 912 }, (_, index) => index);
  const result = await spreadClosesForDrain(items, (index) => {
    if (index % 4 === 3) return false;
    closeTimes.push(clock.now());
    return true;
  }, { spreadMs: 120_000, sleep: clock.sleep, now: clock.now });

  assert.equal(result.closed, 684);
  assert.equal(closeTimes[0], 0);
  // The last closed item is index 910: due at 120000 * 910 / 912.
  assert.equal(closeTimes.at(-1), (120_000 * 910) / 912);
  assert.equal(result.spanMs, (120_000 * 910) / 912);
  // No more than one close in any 100 ms: nothing bunches up.
  const perBucket = new Map<number, number>();
  for (const at of closeTimes) perBucket.set(Math.floor(at / 100), (perBucket.get(Math.floor(at / 100)) ?? 0) + 1);
  assert.ok(Math.max(...perBucket.values()) <= 1);
});

test("a close that throws is warned and skipped; later connections still close and the promise resolves", async () => {
  const clock = fakeClock();
  const closedItems: number[] = [];
  const warnings: string[] = [];
  const result = await spreadClosesForDrain([0, 1, 2, 3], (index) => {
    if (index === 1) throw new Error("socket already destroyed");
    closedItems.push(index);
    return true;
  }, { spreadMs: 4_000, sleep: clock.sleep, now: clock.now, warn: (message) => warnings.push(message) });

  assert.deepEqual(closedItems, [0, 2, 3]);
  assert.equal(result.closed, 3);
  assert.equal(warnings.length, 1);
});
