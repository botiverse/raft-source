import assert from "node:assert/strict";
import { DESKTOP_INPUT_PRESENCE_EVENT, PRESENCE_ACTIVITY_EVENT } from "@botiverse/raft-shared";
import {
  attachPresenceActivityHandler,
  PRESENCE_ACTIVITY_MIN_CHANGE_MS,
  PRESENCE_ACTIVITY_MIN_INTERVAL_MS,
} from "./presenceEvents";
import type { SocketClientKind } from "./platformScope";
import {
  __resetNotificationPresenceForTests,
  isPresenceActive,
  isPresenceOnline,
  loadNotificationPresence,
} from "../services/notifications/presence";

function fakeSocket(id?: string) {
  const handlers = new Map<string, (payload?: unknown) => void>();
  return {
    socket: { id, on: (event: string, handler: (payload?: unknown) => void) => { handlers.set(event, handler); } } as never,
    activity: (payload: unknown) => handlers.get(PRESENCE_ACTIVITY_EVENT)?.(payload),
    legacy: (payload: unknown) => handlers.get(DESKTOP_INPUT_PRESENCE_EVENT)?.(payload),
    disconnect: () => handlers.get("disconnect")?.(),
    listens: (event: string) => handlers.has(event),
  };
}

function attach(clientKind: SocketClientKind = "desktop", socketId = "sock") {
  const s = fakeSocket(socketId);
  const log: string[] = [];
  const clock = { now: 0 };
  attachPresenceActivityHandler(s.socket, { userId: "u1", clientKind }, {
    record: async (id, kind, report, at, sid) => {
      assert.equal(sid, socketId, "every write names this socket");
      log.push(`record:${id}:${kind}:${report.active}:${report.idleSeconds}:${at}`);
    },
    remove: async (id, kind, sid) => { log.push(`remove:${id}:${kind}:${sid}`); },
    now: () => clock.now,
  });
  return { s, log, clock };
}

test("presence:activity is accepted from desktop, web and mobile under the socket's kind; never from cli", () => {
  for (const clientKind of ["desktop", "web", "mobile"] as const) {
    const { s, log } = attach(clientKind);
    s.activity({ active: true, idleSeconds: 4, userId: "someone-else" });
    assert.deepEqual(log, [`record:u1:${clientKind}:true:4:0`], `${clientKind}: the payload cannot choose the subject`);
  }
  const cli = attach("cli");
  assert.equal(cli.s.listens(PRESENCE_ACTIVITY_EVENT), false);
  cli.s.activity({ active: true, idleSeconds: 0 });
  assert.deepEqual(cli.log, []);
});

test("malformed presence:activity payloads are dropped", () => {
  const { s, log } = attach("web");
  for (const bad of [undefined, null, "active", 1, {}, { active: "true" }, { active: true, idleSeconds: -1 }, { active: true, idleSeconds: "0" }, { active: true, idleSeconds: Number.NaN }]) {
    s.activity(bad);
  }
  assert.deepEqual(log, []);
  s.activity({ active: true, idleSeconds: null });
  assert.deepEqual(log, ["record:u1:web:true:null:0"], "idle unknown is well formed");
});

test("desktop:input-presence is an alias accepted from desktop sockets only", () => {
  for (const clientKind of ["web", "mobile", "cli"] as SocketClientKind[]) {
    const { s, log } = attach(clientKind);
    assert.equal(s.listens(DESKTOP_INPUT_PRESENCE_EVENT), false, clientKind);
    s.legacy({ attended: true, idleSeconds: 0 });
    assert.deepEqual(log, [], clientKind);
  }

  const { s, log, clock } = attach("desktop");
  for (const ignored of [undefined, null, "attended", 1]) s.legacy(ignored);
  assert.deepEqual(log, [], "a non-object is ignored");

  s.legacy({ attended: true, idleSeconds: 12 });
  assert.deepEqual(log, ["record:u1:desktop:true:12:0"]);

  // Not attended, unknown idle, too old or nonsense: not active.
  const inactive: Array<[unknown, number | null]> = [
    [{ attended: false, idleSeconds: 0 }, 0],
    [{ attended: true, idleSeconds: null }, null],
    [{ attended: true }, null],
    [{ attended: true, idleSeconds: -5 }, null],
    [{ attended: true, idleSeconds: "0" }, null],
    [{ attended: true, idleSeconds: 180 }, 180],
    [{ attended: "true", idleSeconds: 0 }, 0],
    [{}, null],
  ];
  for (const [payload, idle] of inactive) {
    log.length = 0;
    clock.now += PRESENCE_ACTIVITY_MIN_INTERVAL_MS;
    s.legacy({ attended: true, idleSeconds: 0 });
    s.legacy(payload);
    assert.deepEqual(log, [
      `record:u1:desktop:true:0:${clock.now}`,
      `record:u1:desktop:false:${idle}:${clock.now}`,
    ], JSON.stringify(payload));
  }
});

test("computer-active reports: a lock or crossing the idle line is a stop recorded at once; focus changes are repeats", () => {
  const { s, log, clock } = attach("desktop");
  const report = (idleSeconds: number, locked: boolean, attended: boolean) =>
    ({ active: !locked && idleSeconds < 180, idleSeconds, locked, attended });
  s.activity(report(0, false, true));
  clock.now += 1;
  s.activity(report(1, false, false));
  assert.equal(log.length, 1, "blurring Raft is not a change of computer presence: throttled as a repeat");
  clock.now += 1;
  s.activity(report(2, true, false));
  assert.equal(log.length, 2, "the lock goes through at once");
  clock.now += PRESENCE_ACTIVITY_MIN_CHANGE_MS;
  s.activity(report(0, false, false));
  assert.equal(log.length, 3, "unlock: active again (unfocused)");
  clock.now += 1;
  s.activity({ active: true, idleSeconds: 180, locked: false, attended: true });
  assert.equal(log.length, 4, "idle at the window is a stop even when a client says active");
  // N1: idle past the window, then locked right after: a lock change is never a throttled repeat.
  clock.now += 1;
  s.activity(report(200, true, false));
  assert.equal(log.length, 5, "locking while already inactive still goes through");
  clock.now += 1;
  s.activity(report(201, false, false));
  assert.equal(log.length, 6, "unlocking (still idle, so still inactive) goes through too");
  clock.now += 1;
  s.activity(report(202, false, false));
  assert.equal(log.length, 6, "a true repeat is still throttled");
  // N2: a new push subscription, or the ack capability, is never a throttled repeat either.
  clock.now += 1;
  s.activity({ ...report(203, false, false), pushSubscribed: true, pushEndpointHash: "AbCdEfGh_-123456" });
  assert.equal(log.length, 7, "the browser's push subscription changed");
  clock.now += 1;
  s.activity({ ...report(204, false, false), pushSubscribed: true, pushEndpointHash: "AbCdEfGh_-123456", ackAlerts: true });
  assert.equal(log.length, 8, "the ack capability changed");
  clock.now += 1;
  s.activity({ ...report(205, false, false), pushSubscribed: true, pushEndpointHash: "AbCdEfGh_-123456", ackAlerts: true });
  assert.equal(log.length, 8, "and a true repeat is throttled again");
});

test("repeats are throttled, a change back to active at most once a second, but stopping is never dropped", () => {
  const { s, log, clock } = attach("desktop");
  s.activity({ active: true, idleSeconds: 0 });
  clock.now = PRESENCE_ACTIVITY_MIN_INTERVAL_MS - 1;
  s.activity({ active: true, idleSeconds: 0 });
  assert.equal(log.length, 1, "a faster repeat is dropped");
  clock.now = PRESENCE_ACTIVITY_MIN_INTERVAL_MS;
  s.activity({ active: true, idleSeconds: 3 });
  assert.equal(log.length, 2);

  // Active with input already past the window is a stop, even right after a report.
  clock.now += 1;
  s.activity({ active: true, idleSeconds: 180 });
  assert.match(log.at(-1)!, /^record:u1:desktop:true:180:/, "idle at the window is recorded at once as a stop");
  assert.equal(log.length, 3);

  clock.now += PRESENCE_ACTIVITY_MIN_CHANGE_MS;
  s.activity({ active: true, idleSeconds: 0 });
  assert.equal(log.length, 4);
  clock.now += 1;
  s.legacy({ attended: false, idleSeconds: 3 });
  assert.equal(log.length, 5, "a stop right after active is never dropped (alias shares the limit)");
  clock.now += 1;
  s.activity({ active: false, idleSeconds: 3 });
  assert.equal(log.length, 5, "a repeated stop is throttled");

  clock.now += PRESENCE_ACTIVITY_MIN_CHANGE_MS - 2;
  s.activity({ active: true, idleSeconds: 0 });
  assert.equal(log.length, 5, "flapping back faster than once a second is dropped");
  clock.now += 1;
  s.activity({ active: true, idleSeconds: 0 });
  assert.equal(log.length, 6);
});

test("a disconnect drops this socket's entry once, whatever it last reported", () => {
  const active = attach("web", "tab-a");
  active.s.activity({ active: true, idleSeconds: 0 });
  active.s.disconnect();
  active.s.disconnect();
  assert.deepEqual(active.log, ["record:u1:web:true:0:0", "remove:u1:web:tab-a"]);

  const stopped = attach("mobile", "phone");
  stopped.s.activity({ active: true, idleSeconds: 0 });
  stopped.clock.now = 5;
  stopped.s.activity({ active: false, idleSeconds: null });
  stopped.s.disconnect();
  assert.deepEqual(stopped.log, ["record:u1:mobile:true:0:0", "record:u1:mobile:false:null:5", "remove:u1:mobile:phone"]);

  const silent = attach("desktop");
  silent.s.disconnect();
  assert.deepEqual(silent.log, [], "a socket that never reported has no entry");
});

test("two sockets of one kind on the real store (sockets without an id get their own entry)", async () => {
  __resetNotificationPresenceForTests();
  const clock = { now: 1_000_000 };
  const tabA = fakeSocket();
  const tabB = fakeSocket();
  for (const tab of [tabA, tabB]) attachPresenceActivityHandler(tab.socket, { userId: "u1", clientKind: "web" }, { now: () => clock.now });
  const settle = () => new Promise((r) => setImmediate(r));
  const web = async () => (await loadNotificationPresence(["u1"], clock.now)).get("u1")?.web;
  try {
    tabA.activity({ active: true, idleSeconds: 0 });
    for (let i = 0; i < 3; i += 1) {
      clock.now += PRESENCE_ACTIVITY_MIN_INTERVAL_MS;
      tabB.activity({ active: false, idleSeconds: null });
      await settle();
      assert.equal(isPresenceActive(await web(), clock.now), true, `the background tab's heartbeat ${i} does not clear tab A`);
    }
    clock.now += 1;
    tabA.activity({ active: false, idleSeconds: null });
    await settle();
    assert.equal(isPresenceActive(await web(), clock.now), false, "tab A stopping is immediate");

    clock.now += PRESENCE_ACTIVITY_MIN_CHANGE_MS;
    tabA.activity({ active: true, idleSeconds: 0 });
    await settle();
    tabA.disconnect();
    await settle();
    assert.equal(isPresenceActive(await web(), clock.now), false, "tab A's input left with it");
    assert.equal(isPresenceOnline(await web(), clock.now), true, "tab B keeps web online");
    tabB.disconnect();
    await settle();
    assert.equal(await web(), undefined, "offline");
  } finally {
    __resetNotificationPresenceForTests();
  }
});

test("store errors are logged and swallowed", async () => {
  const s = fakeSocket();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    attachPresenceActivityHandler(s.socket, { userId: "u1", clientKind: "desktop" }, {
      record: async () => { throw new Error("redis down"); },
      remove: async () => { throw new Error("redis down"); },
      now: () => 0,
    });
    assert.doesNotThrow(() => s.activity({ active: true, idleSeconds: 0 }));
    assert.doesNotThrow(() => s.disconnect());
    await new Promise((r) => setImmediate(r));
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});
