import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Server as SocketServer } from "socket.io";
import { AgentOrchestrator } from "../../services/agentOrchestrator";
import { closeTestDatabase, discardParkedTestDatabase, openCaseDatabase, openTestPglite } from "./database";
import { enterIntegrationCase, IntegrationLifecycle } from "./lifecycle";
import { closePgliteWhenIdle, runningPgliteCalls, trackPgliteActivity } from "./pgliteClose";
import type { ReuseCounts } from "./reuseProbe";

// A test PGlite closes only once nothing runs on it (pgliteClose.ts). Closing PGlite under a
// running statement spins forever, synchronously: two server files never finished in CI
// (#triage:#516). Each case below hung that way before this. A regression here can show up as
// this file hanging, not failing.

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

async function trackedPglite(): Promise<PGlite> {
  const client = trackPgliteActivity(await PGlite.create());
  await client.exec("CREATE TABLE probe (id serial PRIMARY KEY, v int)");
  return client;
}

test("a close waits for the query in flight; a call made after the close begins is refused before it reaches PGlite", async () => {
  const client = await trackedPglite();
  const inFlight = client.query("UPDATE probe SET v = 1 RETURNING id");
  const closing = closePgliteWhenIdle(client, 5_000);
  await assert.rejects(client.query("SELECT 1"), /PGlite is closing/);
  await inFlight;
  assert.equal(await closing, "closed");
  assert.equal(client.closed, true);
  await assert.rejects(client.query("SELECT 1"), /PGlite is closed/);
});

test("a transaction the close caught between statements finishes first, then the close", async () => {
  const client = await trackedPglite();
  const between = gate();
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const transaction = client.transaction(async (tx) => {
    await tx.query("INSERT INTO probe (v) VALUES (1)");
    entered();
    await between.wait;
    await tx.query("INSERT INTO probe (v) VALUES (2)");
  });
  await inside;
  const closing = closePgliteWhenIdle(client, 5_000);
  await delay(20);
  assert.equal(client.closed, false, "not closed under the open transaction");
  between.open();
  await transaction;
  assert.equal(await closing, "closed");
});

test("a transaction that never settles: the close gives up at its bound and leaves PGlite open", async () => {
  const client = await trackedPglite();
  const stuck = gate();
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const transaction = client.transaction(async (tx) => {
    await tx.query("INSERT INTO probe (v) VALUES (1)");
    entered();
    await stuck.wait;
    await tx.query("INSERT INTO probe (v) VALUES (2)");
  });
  await inside;
  assert.equal(await closePgliteWhenIdle(client, 100), "abandoned");
  assert.equal(client.closed, false);
  assert.equal(runningPgliteCalls(client), 1);
  // Its next statement runs on an open PGlite (it would spin on a closed one). It commits, and then it can close.
  stuck.open();
  await transaction;
  assert.equal(await closePgliteWhenIdle(client, 5_000), "closed");
});

// ---- Through closeTestDatabase, as dbTest cases close ----

function fakeIo(): SocketServer {
  const operator: Record<string, unknown> = {};
  Object.assign(operator, { in: () => operator, to: () => operator, except: () => operator, socketsJoin: () => undefined, emit: () => true });
  return { in: () => operator, to: () => operator } as unknown as SocketServer;
}

/** A case whose database closes inside it (the file's afterEach(closeTestDatabase)), then its lifecycle closes. */
async function caseClosingItsDatabase(work: (client: PGlite) => Promise<void>): Promise<ReuseCounts> {
  const lifecycle = new IntegrationLifecycle();
  const leave = enterIntegrationCase(lifecycle);
  let counts: ReuseCounts = {};
  try {
    await openCaseDatabase({
      measure: (phase, run) => lifecycle.measure(phase, run),
      caseFailed: () => false,
      closedByCase: () => !lifecycle.closing,
      report: (reported) => { counts = reported; },
    });
    const client = openTestPglite();
    assert.ok(client);
    await work(client);
    await closeTestDatabase();
  } finally {
    await lifecycle.close();
    leave();
  }
  return counts;
}

test("the CI hang: an orchestrator's setIO sweeps are still querying when the case closes its database", async () => {
  await discardParkedTestDatabase();
  // agentOrchestrator.runtimeErrorVisibility / onboardingHeldWakes: setIO starts sweeps nobody awaits,
  // shutdown() doesn't wait for them, and the afterEach closes the database at once. Before, offset 28
  // spun forever. Each offset lands the close at a different point of the sweeps.
  for (let offset = 0; offset < 40; offset += 1) {
    const counts = await caseClosingItsDatabase(async () => {
      const orchestrator = new AgentOrchestrator();
      orchestrator.setIO(fakeIo());
      for (let i = 0; i < offset; i += 1) await null;
      if (offset % 4 === 3) await new Promise((resolve) => setImmediate(resolve));
      await orchestrator.shutdown();
    });
    assert.equal(counts["drop.closedByCase"], 1, `offset ${offset}: ${JSON.stringify(counts)}`);
    assert.equal(counts.closeTimeout, undefined, `offset ${offset}: the sweeps finish or are refused well within the bound`);
  }
});

test("a case that closes its database under a transaction it never settles costs that database, not the file", async () => {
  await discardParkedTestDatabase();
  const stuck = gate();
  const stuckCase: { client?: PGlite } = {};
  const started = performance.now();
  const counts = await caseClosingItsDatabase(async (client) => {
    stuckCase.client = client;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    void client.transaction(async (tx) => {
      await tx.query("SELECT 1");
      entered();
      await stuck.wait;
    }).catch(() => {});
    await inside;
  });
  assert.ok(performance.now() - started < 15_000, "bounded");
  assert.equal(counts.closeTimeout, 1, JSON.stringify(counts));
  assert.equal(stuckCase.client?.closed, false, "left open, not closed under the transaction");
  // The next case gets a fresh database.
  const next = await caseClosingItsDatabase(async (client) => {
    assert.notEqual(client, stuckCase.client);
    await client.query("SELECT 1");
  });
  assert.equal(next.restored, 1, JSON.stringify(next));
  stuck.open();
  await discardParkedTestDatabase();
});
