import assert from "node:assert/strict";
import net from "node:net";
import pg from "pg";
import { afterEach, test } from "vitest";
import {
  CONNECT_TRANSPORT_TIMEOUT,
  DEFAULT_PG_CONNECT_CONCURRENCY,
  DEFAULT_PG_CONNECT_TRANSPORT_TIMEOUT_MS,
  connectErrorCategory,
  connectPermitWaitMs,
  type ConnectAttemptFailure,
  createConnectGate,
  gatedClientClass,
  resolveConnectConcurrency,
  resolveConnectTransportTimeoutMs,
} from "./connectGate";

// A TCP server that accepts connections and never answers the startup packet,
// so every pg handshake stays in progress until the test ends it. It records
// how many handshakes were open at once, which is what Neon's proxy limits.
async function hangingServer() {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  let maxOpen = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    maxOpen = Math.max(maxOpen, sockets.size);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    // Read (and drop) what the client sends without ever answering: a socket
    // never read does not see the client's FIN, so it would not notice a
    // client that gave up and closed.
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgres://gate-test@127.0.0.1:${port}/none`,
    stats: () => ({ accepted, open: sockets.size, maxOpen }),
    /** Ends the oldest open handshakes, so those connects fail and free their permits. */
    dropOldest(n: number) {
      for (const socket of [...sockets].slice(0, n)) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const until = async (check: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("PG_CONNECT_CONCURRENCY defaults to 8 and 0 disables the cap", () => {
  assert.equal(resolveConnectConcurrency({}), DEFAULT_PG_CONNECT_CONCURRENCY);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "" }), DEFAULT_PG_CONNECT_CONCURRENCY);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "0" }), 0);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "3" }), 3);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "nope" }), DEFAULT_PG_CONNECT_CONCURRENCY);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "-1" }), DEFAULT_PG_CONNECT_CONCURRENCY);
});

test("the gate grants permits in arrival order and reports the wait", async () => {
  let clock = 1_000;
  const gate = createConnectGate(1, () => clock);
  const first = await gate.acquire();
  const order: string[] = [];
  const second = gate.acquire().then((permit) => { order.push("second"); return permit; });
  const third = gate.acquire().then((permit) => { order.push("third"); return permit; });
  assert.deepEqual(gate.state(), { connecting: 1, queued: 2 });

  clock = 1_250;
  first.release();
  first.release(); // a second release must not free another permit
  const secondPermit = await second;
  assert.equal(secondPermit.waitMs, 250);
  assert.deepEqual(gate.state(), { connecting: 1, queued: 1 });

  secondPermit.release();
  (await third).release();
  assert.deepEqual(order, ["second", "third"]);
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});

test("a pool with the gated client keeps at most N handshakes open at once", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const pool = new pg.Pool({ connectionString: server.url, max: 10, Client: gatedClientClass(createConnectGate(2)) });
  cleanups.push(() => pool.end().catch(() => {}));

  const results = Array.from({ length: 6 }, () => pool.connect().then(() => "ok", () => "failed"));
  await until(() => server.stats().accepted === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.stats().accepted, 2, "queued connects must not reach the server");

  // Each failed handshake frees a permit for the next queued connect.
  while (server.stats().accepted < 6) {
    const before = server.stats().accepted;
    server.dropOldest(2);
    await until(() => server.stats().accepted > before);
  }
  server.dropOldest(2);
  assert.deepEqual(await Promise.all(results), Array(6).fill("failed"));
  assert.equal(server.stats().maxOpen, 2);
});

test("cap 0 sends every handshake at once, like plain pg.Pool", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const pool = new pg.Pool({ connectionString: server.url, max: 10, Client: gatedClientClass(createConnectGate(0)) });
  cleanups.push(() => pool.end().catch(() => {}));

  const results = Array.from({ length: 5 }, () => pool.connect().catch(() => undefined));
  await until(() => server.stats().accepted === 5);
  server.dropOldest(5);
  await Promise.all(results);
});

test("a connected client records how long it waited for its permit", async () => {
  const gate = createConnectGate(1);
  const waits: number[] = [];
  const GatedClient = gatedClientClass(gate, (waitMs) => waits.push(waitMs));
  const held = await gate.acquire();
  // An unreachable port makes connect fail right after the permit is granted.
  const client = new GatedClient({ connectionString: "postgres://gate-test@127.0.0.1:1/none" });
  const connecting = client.connect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  held.release();
  await connecting;
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! >= 40, `waited ${waits[0]}ms`);
  assert.equal(connectPermitWaitMs(client), waits[0]);
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});

test("createPool installs the gate (the server's primary and search pools)", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const { createPool } = await import("./index");
  const pool = createPool(server.url, { label: "primary", connectConcurrency: 1 });
  cleanups.push(() => pool.end().catch(() => {}));

  const results = Array.from({ length: 3 }, () => pool.connect().catch(() => undefined));
  await until(() => server.stats().accepted === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.stats().accepted, 1);
  while (server.stats().accepted < 3) {
    const before = server.stats().accepted;
    server.dropOldest(1);
    await until(() => server.stats().accepted > before);
  }
  server.dropOldest(1);
  await Promise.all(results);
  assert.equal(server.stats().maxOpen, 1);
});

test("queued connects fail at their own deadline, without dialing, while the permit holder is still busy", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const gate = createConnectGate(1);
  const pool = new pg.Pool({
    connectionString: server.url,
    max: 10,
    connectionTimeoutMillis: 300,
    Client: gatedClientClass(gate),
  });
  cleanups.push(() => pool.end().catch(() => {}));

  // The only permit is held well past the queued connects' deadline.
  const held = await gate.acquire();
  const startedAt = Date.now();
  const errors = await Promise.all(Array.from({ length: 3 }, () => pool.connect().then(() => null, (err: Error) => err)));
  const elapsedMs = Date.now() - startedAt;
  assert.ok(errors.every((err) => err instanceof Error));
  assert.ok(elapsedMs < 600, `failed after ${elapsedMs}ms; must not wait for the permit holder`);
  assert.deepEqual(gate.state(), { connecting: 1, queued: 0 }, "the timed-out connects left the queue");

  held.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.stats().accepted, 0);
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});

test("an aborted acquire leaves the queue without taking a permit", async () => {
  const gate = createConnectGate(1);
  const held = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal);
  const next = gate.acquire();
  controller.abort(new Error("gone"));
  await assert.rejects(waiting, /gone/);
  assert.deepEqual(gate.state(), { connecting: 1, queued: 1 });
  held.release();
  (await next).release();
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});

test("a failed connect reports whether it stalled in the handshake or behind full permits", async () => {
  // o11y 2026-10-15: a task's new connects all failed at the 10 s pool timeout
  // and the trace could not say which side they were stuck on.
  const server = await hangingServer();
  cleanups.push(server.close);
  const gate = createConnectGate(1);
  const failures: ConnectAttemptFailure[] = [];
  const pool = new pg.Pool({
    connectionString: server.url,
    max: 10,
    connectionTimeoutMillis: 300,
    Client: gatedClientClass(gate, () => {}, (failure) => failures.push(failure)),
  });
  cleanups.push(() => pool.end().catch(() => {}));

  // One handshake holds the only permit and hangs; two more queue behind it.
  const errors = await Promise.all(Array.from({ length: 3 }, () => pool.connect().then(() => null, (err: Error) => err)));
  assert.ok(errors.every((err) => err instanceof Error));
  // What the checkout sees is the pool's deadline, or (for a queued client
  // whose permit deadline lands first) the permit deadline: a timer race, so
  // the checkout error alone cannot say where it was stuck. The attempt
  // report below can.
  for (const err of errors) {
    assert.ok(["pool_connect_timeout", "permit_wait_timeout"].includes(connectErrorCategory(err)));
  }
  await until(() => failures.length === 3);

  // The client that held the permit hung in the handshake until the pool gave up.
  const longHandshakes = failures.filter((failure) => failure.stage === "handshake" && failure.handshakeMs >= 250);
  assert.equal(longHandshakes.length, 1);
  assert.equal(longHandshakes[0]!.errorCategory, "connection_terminated");
  // The others spent their time queued behind the full gate: permitWaitMs
  // says so whether they were reported at the permit deadline or (timer
  // race) handed the permit at their own deadline and dialed for a few ms.
  const rest = failures.filter((failure) => !longHandshakes.includes(failure));
  assert.equal(rest.length, 2);
  for (const failure of rest) {
    assert.ok(failure.permitWaitMs >= 250, JSON.stringify(failure));
    if (failure.stage === "permit_wait") assert.equal(failure.handshakeMs, 0);
  }
});

test("connect error categories are codes or fixed labels, never message text", () => {
  assert.equal(connectErrorCategory(Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:5432"), { code: "ETIMEDOUT" })), "ETIMEDOUT");
  assert.equal(connectErrorCategory(Object.assign(new Error("sorry, too many clients already"), { code: "53300" })), "53300");
  assert.equal(connectErrorCategory(new Error("timeout exceeded when trying to connect")), "pool_connect_timeout");
  assert.equal(connectErrorCategory(new Error("Connection terminated due to connection timeout")), "pool_connect_timeout");
  assert.equal(connectErrorCategory(new Error("Connection terminated unexpectedly")), "connection_terminated");
  assert.equal(connectErrorCategory(new Error("remaining connection slots are reserved")), "too_many_connections");
  assert.equal(connectErrorCategory(new Error("something with a secret host db.internal")), "other");
  assert.equal(connectErrorCategory("not an error"), "other");
});

test("PG_CONNECT_TRANSPORT_TIMEOUT_MS defaults to 2500 and 0 disables the deadline", () => {
  assert.equal(resolveConnectTransportTimeoutMs({}), DEFAULT_PG_CONNECT_TRANSPORT_TIMEOUT_MS);
  assert.equal(resolveConnectTransportTimeoutMs({ PG_CONNECT_TRANSPORT_TIMEOUT_MS: "0" }), 0);
  assert.equal(resolveConnectTransportTimeoutMs({ PG_CONNECT_TRANSPORT_TIMEOUT_MS: "1500" }), 1500);
  assert.equal(resolveConnectTransportTimeoutMs({ PG_CONNECT_TRANSPORT_TIMEOUT_MS: "nope" }), DEFAULT_PG_CONNECT_TRANSPORT_TIMEOUT_MS);
});

test("a handshake stuck in its transport (TLS never answered) gives up at the transport deadline, its socket closed before the permit moves on", async () => {
  // #triage:e17fe621 (10-29): one task opened no connection for 4 minutes;
  // hung handshakes held every permit for the full pool timeout.
  const server = await hangingServer();
  cleanups.push(server.close);
  const failures: ConnectAttemptFailure[] = [];
  const clients: pg.Client[] = [];
  // A socket that dialed (connecting, or connected to the server) and is not
  // destroyed. A queued client's socket was never dialed: no remote address.
  type Stream = { destroyed?: boolean; connecting?: boolean; remoteAddress?: string };
  const liveSockets = () => clients.filter((client) => {
    const stream = (client as unknown as { connection?: { stream?: Stream } }).connection?.stream;
    return stream && !stream.destroyed && (stream.connecting || stream.remoteAddress !== undefined);
  }).length;
  // Checked at every permit grant, before that client dials: with a gate of 1
  // no other handshake's socket may still be open. (The server's own count
  // can lag: it may accept the next connection before reading the old FIN.)
  const liveAtGrant: number[] = [];
  const Gated = gatedClientClass(createConnectGate(1), () => liveAtGrant.push(liveSockets()), (failure) => failures.push(failure), 200);
  class Recorded extends Gated {
    constructor(...args: ConstructorParameters<typeof pg.Client>) {
      super(...args);
      clients.push(this);
    }
  }
  const pool = new pg.Pool({
    connectionString: server.url,
    ssl: { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 5_000,
    Client: Recorded,
  });
  cleanups.push(() => pool.end().catch(() => {}));

  const startedAt = Date.now();
  const errors = await Promise.all(Array.from({ length: 3 }, () => pool.connect().then(() => null, (err: Error) => err)));
  const elapsed = Date.now() - startedAt;
  assert.ok(errors.every((err) => err instanceof Error));
  // Three in a row at ~200 ms each, far below the 5 s pool timeout.
  assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
  await until(() => failures.length === 3);
  for (const failure of failures) {
    assert.equal(failure.stage, "handshake");
    assert.equal(failure.errorCategory, CONNECT_TRANSPORT_TIMEOUT);
    assert.equal(failure.handshakeStage, "tls");
    assert.equal(typeof failure.phases?.tcpMs, "number", "TCP had connected");
  }
  assert.equal(server.stats().accepted, 3);
  assert.deepEqual(liveAtGrant, [0, 0, 0], "each socket was destroyed before its permit went to the next connect");
  await until(() => server.stats().open === 0);
});

test("a handshake slow after its transport (startup/auth) is not cut by the transport deadline", async () => {
  // 11-02: Neon slow but handshakes completing; the deadline must not turn
  // slow into failed. Without TLS the transport is done at TCP connect.
  const server = await hangingServer();
  cleanups.push(server.close);
  const failures: ConnectAttemptFailure[] = [];
  const pool = new pg.Pool({
    connectionString: server.url,
    max: 10,
    connectionTimeoutMillis: 600,
    Client: gatedClientClass(createConnectGate(1), () => {}, (failure) => failures.push(failure), 100),
  });
  cleanups.push(() => pool.end().catch(() => {}));

  const err = await pool.connect().then(() => null, (error: Error) => error);
  assert.ok(err instanceof Error);
  await until(() => failures.length === 1);
  const [failure] = failures;
  assert.equal(failure!.handshakeStage, "auth");
  assert.notEqual(failure!.errorCategory, CONNECT_TRANSPORT_TIMEOUT, "the pool timeout ended it, not the transport deadline");
  assert.ok(failure!.handshakeMs >= 500, `ran to the pool timeout, ${failure!.handshakeMs} ms`);
});

test("a handshake whose TLS stalls after the server accepted it gives up at the transport deadline, closing the TLS socket", async () => {
  // The server answers the SSLRequest with 'S' and then never speaks TLS: pg
  // has swapped in its TLS socket, and that is the one destroyed at the
  // deadline (Tenny's review of #12970, #proj-data:#10).
  const sockets = new Set<net.Socket>();
  let closedOnServer = 0;
  // A TLS ClientHello (record type 0x16) after the 'S': pg had built its TLS
  // socket, so the socket the deadline destroyed was that one, not the raw
  // TCP socket (which the test above covers).
  let sawClientHello = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); closedOnServer += 1; });
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (!answered) {
        answered = true;
        socket.write("S");
      } else if (chunk[0] === 0x16) {
        sawClientHello = true;
      }
    });
    // Read (and drop) the rest without answering, so the client's FIN is seen.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as net.AddressInfo).port;
  const failures: ConnectAttemptFailure[] = [];
  const pool = new pg.Pool({
    connectionString: `postgres://gate-test@127.0.0.1:${port}/none`,
    ssl: { rejectUnauthorized: false },
    max: 4,
    connectionTimeoutMillis: 5_000,
    Client: gatedClientClass(createConnectGate(1), () => {}, (failure) => failures.push(failure), 200),
  });
  cleanups.push(() => pool.end().catch(() => {}));

  const startedAt = Date.now();
  const err = await pool.connect().then(() => null, (error: Error) => error);
  assert.ok(err instanceof Error);
  assert.ok(Date.now() - startedAt < 2_000, "gave up at the transport deadline, not the pool timeout");
  await until(() => failures.length === 1);
  assert.equal(failures[0]!.errorCategory, CONNECT_TRANSPORT_TIMEOUT);
  assert.equal(failures[0]!.handshakeStage, "tls");
  assert.ok(sawClientHello, "pg had switched to its TLS socket before the deadline");
  // The connection is gone on the server side too.
  await until(() => closedOnServer === 1 && sockets.size === 0);
});
