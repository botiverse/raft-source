import assert from "node:assert/strict";
import { ACTIVE_INPUT_WINDOW_MS, PRESENCE_FRESH_MS, PRESENCE_ONLINE_TTL_MS } from "@botiverse/raft-shared";
import type { NotificationDeviceKind, NotificationUserPresence } from "./types";

// A fake Redis (hashes with a key TTL) that the tests can switch on and
// break; off = the local fallback.
const fakeRedis = vi.hoisted(() => {
  const store = new Map<string, { fields: Map<string, string>; expiresAt: number }>();
  const state = { available: false, failing: false, now: 0 };
  const check = () => { if (state.failing) throw new Error("redis down"); };
  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry || entry.expiresAt <= state.now) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  const commands = {
    hset: (key: string, field: string, value: string) => {
      const entry = live(key) ?? { fields: new Map<string, string>(), expiresAt: Number.POSITIVE_INFINITY };
      entry.fields.set(field, value);
      store.set(key, entry);
      return 1;
    },
    pexpire: (key: string, ttl: number) => {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = state.now + ttl;
      return 1;
    },
    hdel: (key: string, ...fields: string[]) => {
      const entry = live(key);
      if (!entry) return 0;
      let removed = 0;
      for (const field of fields) if (entry.fields.delete(field)) removed += 1;
      if (entry.fields.size === 0) store.delete(key);
      return removed;
    },
    hgetall: (key: string) => Object.fromEntries(live(key)?.fields ?? []),
  };
  type Name = keyof typeof commands;
  const batch = () => {
    const queued: Array<() => unknown> = [];
    const chain: Record<string, unknown> = {
      exec: async () => { check(); return queued.map((run) => [null, run()]); },
    };
    for (const name of Object.keys(commands) as Name[]) {
      chain[name] = (...args: unknown[]) => { queued.push(() => (commands[name] as (...a: unknown[]) => unknown)(...args)); return chain; };
    }
    return chain;
  };
  const client = {
    multi: batch,
    pipeline: batch,
    hdel: async (key: string, ...fields: string[]) => { check(); return commands.hdel(key, ...fields); },
  };
  return { store, state, client };
});

vi.mock("../../redis", () => ({
  isRedisAvailable: () => fakeRedis.state.available,
  getRedis: () => fakeRedis.client,
}));

import {
  __resetNotificationPresenceForTests,
  isPresenceActive,
  isPresenceOnline,
  loadNotificationPresence,
  notificationPresenceKey,
  lastComputerInput,
  planNotificationDevices,
  recordPresenceActivity,
  removePresenceSocket,
  reportedInputAt,
  reportShowsActive,
  SAME_COMPUTER_INPUT_SLACK_MS,
  aggregatePresenceEntries,
} from "./presence";

/** Every computer path deliverable: browser "h" holds a stored subscription (the rule has its own tests below). */
const EVERY_PATH = { webPushEndpointHashes: new Set(["h"]), desktopSocket: true };
const NO_WEB_PUSH = { webPushEndpointHashes: new Set<string>(), desktopSocket: true };
/** A web entry reporting browser "h". */
const withPush = (presence: NotificationUserPresence | undefined): NotificationUserPresence | undefined =>
  presence?.web && !presence.web.pushEndpointHashes ? { ...presence, web: { ...presence.web, pushEndpointHashes: ["h"] } } : presence;
const planAll = (
  presence: Parameters<typeof planNotificationDevices>[0],
  now: number,
  delay: Parameters<typeof planNotificationDevices>[2] = "inactive",
) => planNotificationDevices(withPush(presence), now, delay, EVERY_PATH);


const T0 = 10_000_000;

// Writes move the fake Redis clock too (its key TTLs count from "now").
function recordAt(...args: Parameters<typeof recordPresenceActivity>) {
  fakeRedis.state.now = args[3]!;
  return recordPresenceActivity(...args);
}

function removeAt(...args: Parameters<typeof removePresenceSocket>) {
  fakeRedis.state.now = args[3]!;
  return removePresenceSocket(...args);
}

beforeEach(() => {
  __resetNotificationPresenceForTests();
  fakeRedis.store.clear();
  fakeRedis.state.available = false;
  fakeRedis.state.failing = false;
  fakeRedis.state.now = T0;
});

async function presenceOf(userId: string, now: number): Promise<NotificationUserPresence> {
  fakeRedis.state.now = now;
  const presence = (await loadNotificationPresence([userId], now)).get(userId);
  assert.ok(presence, "lookup succeeded");
  return presence;
}

async function activeKinds(userId: string, now: number): Promise<NotificationDeviceKind[]> {
  const presence = await presenceOf(userId, now);
  return (["desktop", "web", "mobile"] as const).filter((kind) => isPresenceActive(presence[kind], now));
}

for (const backend of ["local fallback", "redis"] as const) {
  describe(`presence store (${backend})`, () => {
    beforeEach(() => {
      fakeRedis.state.available = backend === "redis";
    });

    test("record: the window is 3 minutes after the last input, not after the report", async () => {
      assert.equal(ACTIVE_INPUT_WINDOW_MS, 3 * 60 * 1000);
      // Last input 1 minute ago: 2 minutes of activity left.
      await recordAt("u1", "desktop", { active: true, idleSeconds: 60 }, T0);
      assert.deepEqual(await activeKinds("u1", T0), ["desktop"]);
      assert.deepEqual(await activeKinds("u1", T0 + 120_000 - 1), ["desktop"]);
      assert.deepEqual(await activeKinds("u1", T0 + 120_000), [], "no further report: it lapses at lastInput + 3 min");

      // Already past the window, or not active: no input recorded, still online.
      await recordAt("u1", "web", { active: true, idleSeconds: 180 }, T0);
      await recordAt("u1", "mobile", { active: false, idleSeconds: 0 }, T0);
      const presence = await presenceOf("u1", T0);
      assert.equal(presence.web?.lastInputAt, null);
      assert.equal(presence.mobile?.lastInputAt, null);
      assert.equal(isPresenceOnline(presence.web, T0), true);

      // Unknown idle on an active report means "now" (mobile foreground).
      await recordAt("u1", "mobile", { active: true, idleSeconds: null }, T0);
      assert.equal((await presenceOf("u1", T0)).mobile?.lastInputAt, T0);

      // Removing an absent socket writes nothing.
      await removeAt("u2", "web", "nope", T0);
      assert.deepEqual(await presenceOf("u2", T0), {});
    });

    test("a stop clears the reporting socket's input at once", async () => {
      await recordAt("u1", "desktop", { active: true, idleSeconds: 0 }, T0, "d1");
      await recordAt("u1", "desktop", { active: false, idleSeconds: 5 }, T0 + 1_000, "d1");
      assert.deepEqual(await activeKinds("u1", T0 + 1_000), []);
    });

    test("online lasts PRESENCE_ONLINE_TTL_MS after the last report", async () => {
      await recordAt("u1", "desktop", { active: false, idleSeconds: null }, T0);
      assert.equal(isPresenceOnline((await presenceOf("u1", T0 + PRESENCE_ONLINE_TTL_MS - 1)).desktop, T0 + PRESENCE_ONLINE_TTL_MS - 1), true);
      assert.deepEqual(await presenceOf("u1", T0 + PRESENCE_ONLINE_TTL_MS), {}, "the record expires");
    });

    for (const kind of ["web", "desktop", "mobile"] as const) {
      test(`two sockets of ${kind}: an idle one never clears the one in use`, async () => {
        // A is in use; B (a background tab / a second computer) is idle and
        // re-reports active:false every heartbeat.
        await recordAt("u1", kind, { active: true, idleSeconds: 0 }, T0, "A");
        for (let i = 1; i <= 3; i += 1) {
          await recordAt("u1", kind, { active: false, idleSeconds: null }, T0 + i * 20_000, "B");
          assert.deepEqual(await activeKinds("u1", T0 + i * 20_000), [kind], `B's heartbeat ${i}`);
        }
        const merged = (await presenceOf("u1", T0 + 60_000))[kind];
        assert.deepEqual(merged, { lastSeenAt: T0 + 60_000, lastInputAt: T0 }, "newest report, newest input");

        // A stops: inactive at once, still online.
        await recordAt("u1", kind, { active: false, idleSeconds: 5 }, T0 + 61_000, "A");
        assert.deepEqual(await activeKinds("u1", T0 + 61_000), []);

        // A in use again, then disconnects while B is idle: online, not active.
        await recordAt("u1", kind, { active: true, idleSeconds: 0 }, T0 + 62_000, "A");
        assert.deepEqual(await activeKinds("u1", T0 + 62_000), [kind]);
        await removeAt("u1", kind, "A", T0 + 63_000);
        const afterA = await presenceOf("u1", T0 + 63_000);
        assert.equal(isPresenceOnline(afterA[kind], T0 + 63_000), true, "B keeps the kind online");
        assert.equal(isPresenceActive(afterA[kind], T0 + 63_000), false, "A's input left with A");

        // B disconnects too: offline.
        await removeAt("u1", kind, "B", T0 + 64_000);
        assert.deepEqual(await presenceOf("u1", T0 + 64_000), {});
      });
    }

    test("two devices of one kind: the newest input wins, an older one does not", async () => {
      await recordAt("u1", "desktop", { active: true, idleSeconds: 0 }, T0, "laptop");
      await recordAt("u1", "desktop", { active: true, idleSeconds: 90 }, T0 + 1_000, "office");
      const presence = await presenceOf("u1", T0 + 1_000);
      assert.equal(presence.desktop?.lastInputAt, T0, "the older input of the second device does not win");
      assert.equal(presence.desktop?.lastSeenAt, T0 + 1_000, "the newest report wins lastSeenAt");
    });

    test("a stale entry (older than the TTL, e.g. a crashed replica's socket) is ignored and pruned", async () => {
      // The ghost was active, then its replica died; the live tab stays idle.
      await recordAt("u1", "web", { active: true, idleSeconds: 0 }, T0, "ghost");
      const later = T0 + PRESENCE_ONLINE_TTL_MS;
      await recordAt("u1", "web", { active: false, idleSeconds: null }, later, "tab");
      const presence = await presenceOf("u1", later);
      assert.ok(T0 + ACTIVE_INPUT_WINDOW_MS > later, "the ghost's input alone would still be active");
      assert.deepEqual(presence.web, { lastSeenAt: later, lastInputAt: null }, "only the live entry counts");
      await new Promise((r) => setImmediate(r));
      if (backend === "redis") {
        const fields = [...(fakeRedis.store.get(notificationPresenceKey("u1", "web"))?.fields.keys() ?? [])];
        assert.deepEqual(fields, ["tab"], "stale entries are pruned");
      }
    });

    test("clock-skew guard: an input far in the future is not trusted and does not hide a real one", async () => {
      const future = T0 + 10 * 60 * 1000;
      // Written by a replica whose clock runs 10 minutes ahead (its lastSeenAt is near now).
      await recordAt("u1", "desktop", { active: true, idleSeconds: 0 }, future, "skewed");
      if (backend === "redis") {
        fakeRedis.store.get(notificationPresenceKey("u1", "desktop"))!.fields.set("skewed", JSON.stringify({ lastSeenAt: T0, lastInputAt: future }));
      }
      assert.equal(isPresenceActive({ lastSeenAt: T0, lastInputAt: future }, T0), false, "a future input is not active");
      assert.equal(isPresenceOnline({ lastSeenAt: future, lastInputAt: null }, T0), false, "a future report is not online");

      await recordAt("u1", "desktop", { active: true, idleSeconds: 30 }, T0, "real");
      assert.equal((await presenceOf("u1", T0)).desktop?.lastInputAt, T0 - 30_000, "the real input wins over the untrusted one");
    });

    test("one lookup returns every user; unknown users have empty presence", async () => {
      await recordAt("u1", "web", { active: true, idleSeconds: 0 }, T0);
      await recordAt("u2", "mobile", { active: true, idleSeconds: 0 }, T0);
      const map = await loadNotificationPresence(["u1", "u2", "u3", "u1"], T0);
      assert.deepEqual([...map.keys()], ["u1", "u2", "u3"]);
      assert.deepEqual(Object.keys(map.get("u1")!), ["web"]);
      assert.deepEqual(Object.keys(map.get("u2")!), ["mobile"]);
      assert.deepEqual(map.get("u3"), {});
      assert.equal((await loadNotificationPresence([], T0)).size, 0);
    });

    test("the disconnect of the last socket of a kind makes it offline and inactive; another socket keeps it", async () => {
      await recordAt("u8", "mobile", { active: true, idleSeconds: 0 }, T0, "s1");
      await recordAt("u8", "mobile", { active: true, idleSeconds: 0 }, T0, "s2");
      await removeAt("u8", "mobile", "s1", T0 + 1_000);
      assert.deepEqual(await activeKinds("u8", T0 + 1_000), ["mobile"], "the other socket is still there");
      // iOS tears the socket down before its active:false arrives.
      await removeAt("u8", "mobile", "s2", T0 + 2_000);
      const presence = await presenceOf("u8", T0 + 2_000);
      assert.equal(presence.mobile, undefined, "offline and inactive");
      assert.equal(planAll(presence, T0 + 2_000).mobileAlert, true, "the phone alerts again");
    });

    test("a desktop's last socket going away lets Web Push through again", async () => {
      await recordAt("u7", "desktop", { active: false, idleSeconds: null }, T0, "d1");
      assert.equal(planAll(await presenceOf("u7", T0), T0).webPush, false, "an online desktop holds Web Push back");
      await removeAt("u7", "desktop", "d1", T0 + 500);
      assert.equal(planAll(await presenceOf("u7", T0 + 500), T0 + 500).webPush, true);
    });
  });
}

test("a failed Redis lookup fails open: the user is missing from the map and the plan alerts everywhere", async () => {
  fakeRedis.state.available = true;
  await recordAt("u1", "desktop", { active: true, idleSeconds: 0 }, T0);
  fakeRedis.state.failing = true;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const map = await loadNotificationPresence(["u1"], T0);
    assert.equal(map.has("u1"), false);
    assert.deepEqual(planAll(map.get("u1"), T0), {
      desktop: true,
      webPush: true,
      mobileAlert: true,
      mobileSocket: true,
      activeKinds: [], mobileDeferUntil: null,
    });
  } finally {
    console.warn = originalWarn;
  }
});

describe("planNotificationDevices", () => {
  const now = T0;
  const active = { lastSeenAt: now - 1_000, lastInputAt: now - 1_000 };
  const onlineIdle = { lastSeenAt: now - 1_000, lastInputAt: null };
  const staleInput = { lastSeenAt: now - 1_000, lastInputAt: now - ACTIVE_INPUT_WINDOW_MS };
  const offline = { lastSeenAt: now - PRESENCE_ONLINE_TTL_MS, lastInputAt: null };

  test("each single active kind alerts only there; the mobile socket always goes", () => {
    assert.deepEqual(planAll({ desktop: active, web: onlineIdle, mobile: onlineIdle }, now), {
      desktop: true, webPush: false, mobileAlert: false, mobileSocket: true, activeKinds: ["desktop"], mobileDeferUntil: null,
    });
    assert.deepEqual(planAll({ desktop: onlineIdle, web: active }, now), {
      desktop: false, webPush: true, mobileAlert: false, mobileSocket: true, activeKinds: ["web"], mobileDeferUntil: null,
    });
    assert.deepEqual(planAll({ mobile: active }, now), {
      desktop: false, webPush: false, mobileAlert: true, mobileSocket: true, activeKinds: ["mobile"], mobileDeferUntil: null,
    });
  });

  test("a computer and a phone in the foreground alert on both; desktop and browser in use alert once, on the desktop", () => {
    assert.deepEqual(planAll({ desktop: active, mobile: active, web: onlineIdle }, now), {
      desktop: true, webPush: false, mobileAlert: true, mobileSocket: true, activeKinds: ["desktop", "mobile"], mobileDeferUntil: null,
    });
    assert.deepEqual(planAll({ web: active, mobile: active }, now), {
      desktop: false, webPush: true, mobileAlert: true, mobileSocket: true, activeKinds: ["web", "mobile"], mobileDeferUntil: null,
    });
    // The desktop app reports system input, so a browser in use on its computer finds it active too.
    assert.deepEqual(planAll({ desktop: active, web: active }, now), {
      desktop: true, webPush: false, mobileAlert: false, mobileSocket: true, activeKinds: ["desktop", "web"], mobileDeferUntil: null,
    });
    assert.deepEqual(planAll({ desktop: active, web: active, mobile: active }, now).activeKinds, ["desktop", "web", "mobile"]);
  });

  test("none active: everything alerts, but web push yields to an online desktop", () => {
    assert.deepEqual(planAll({ desktop: onlineIdle, web: staleInput }, now), {
      desktop: true, webPush: false, mobileAlert: true, mobileSocket: true, activeKinds: [], mobileDeferUntil: null,
    });
    assert.deepEqual(planAll({ desktop: staleInput }, now).webPush, false, "online with stale input is still online");
    for (const presence of [{}, { desktop: offline }, { web: onlineIdle, mobile: onlineIdle }] as NotificationUserPresence[]) {
      assert.deepEqual(planAll(presence, now), {
        desktop: true, webPush: true, mobileAlert: true, mobileSocket: true, activeKinds: [], mobileDeferUntil: null,
      }, JSON.stringify(presence));
    }
  });

  test("undefined presence (failed lookup) fails open", () => {
    assert.deepEqual(planAll(undefined, now), {
      desktop: true, webPush: true, mobileAlert: true, mobileSocket: true, activeKinds: [], mobileDeferUntil: null,
    });
  });
});

describe("planNotificationDevices: the account's mobileDelay (contract §1.3)", () => {
  const now = T0;
  const desktopActive = { lastSeenAt: now - 1_000, lastInputAt: now - 30_000 };
  const webActive = { lastSeenAt: now - 1_000, lastInputAt: now - 10_000 };
  const phoneIdle = { lastSeenAt: now - 1_000, lastInputAt: null };

  test("inactive (default) is the plan before the setting: an active computer holds the phone", () => {
    const plan = planAll({ desktop: desktopActive, mobile: phoneIdle }, now, "inactive");
    assert.equal(plan.mobileAlert, false);
    assert.equal(plan.mobileDeferUntil, null);
    assert.deepEqual(plan, planAll({ desktop: desktopActive, mobile: phoneIdle }, now));
  });

  test("always alerts the phone even while a computer is active; desktop and web are unchanged", () => {
    const plan = planAll({ desktop: desktopActive, mobile: phoneIdle }, now, "always");
    assert.equal(plan.mobileAlert, true);
    assert.equal(plan.desktop, true);
    assert.equal(plan.webPush, false);
    assert.equal(plan.mobileDeferUntil, null);
  });

  test("a delay holds the phone until the last computer input plus the delay", () => {
    const plan = planAll({ desktop: desktopActive, web: webActive, mobile: phoneIdle }, now, "2m");
    assert.equal(plan.mobileAlert, false);
    assert.equal(plan.mobileDeferUntil, webActive.lastInputAt + 2 * 60_000, "the latest input of desktop and web");
    assert.equal(plan.desktop, true, "the computer still alerts at once");
  });

  test("a delay that has already passed alerts the phone now, even inside the 3-minute active window", () => {
    const plan = planAll({ desktop: { lastSeenAt: now - 1_000, lastInputAt: now - 90_000 }, mobile: phoneIdle }, now, "1m");
    assert.equal(plan.mobileAlert, true);
    assert.equal(plan.mobileDeferUntil, null);
  });

  test("a delay longer than the active window still holds the phone after the computer went idle", () => {
    const idleFourMinutes = { lastSeenAt: now - 1_000, lastInputAt: now - 4 * 60_000 };
    const plan = planAll({ desktop: idleFourMinutes, mobile: phoneIdle }, now, "5m");
    assert.deepEqual(plan.activeKinds, [], "no device counts as active");
    assert.equal(plan.mobileAlert, false);
    assert.equal(plan.mobileDeferUntil, idleFourMinutes.lastInputAt + 5 * 60_000);
  });

  test("no computer input, a phone in the foreground, or a failed lookup never waits", () => {
    assert.equal(planAll({ mobile: phoneIdle }, now, "10m").mobileDeferUntil, null);
    assert.equal(planAll({ mobile: phoneIdle }, now, "10m").mobileAlert, true);
    const phoneActive = { lastSeenAt: now - 1_000, lastInputAt: now - 1_000 };
    const foreground = planAll({ desktop: desktopActive, mobile: phoneActive }, now, "10m");
    assert.equal(foreground.mobileAlert, true);
    assert.equal(foreground.mobileDeferUntil, null);
    const failed = planAll(undefined, now, "10m");
    assert.equal(failed.mobileAlert, true);
    assert.equal(failed.mobileDeferUntil, null);
  });

  test("an input time from the future is ignored", () => {
    const future = { lastSeenAt: now, lastInputAt: now + 10 * 60_000 };
    assert.equal(lastComputerInput({ desktop: future }, now, EVERY_PATH), null);
  });
});


// ---------------------------------------------------------------------------
// The computer-active protocol: `locked` present, focus never matters
// ---------------------------------------------------------------------------

describe("reportedInputAt: computer active vs Raft attended (contract §1.3)", () => {
  const now = T0;
  const report = (idleSeconds: number | null, extra: { locked?: boolean; attended?: boolean; active?: boolean } = {}) => ({
    active: extra.active ?? (idleSeconds !== null && idleSeconds < 180 && !extra.locked),
    idleSeconds,
    locked: extra.locked ?? false,
    attended: extra.attended ?? false,
  });

  test("Raft unfocused on a computer in use is active (system input decides, not focus)", () => {
    assert.equal(reportedInputAt(report(20, { attended: false }), now), now - 20_000);
    assert.equal(reportShowsActive(report(20, { attended: false }), now), true);
    assert.equal(reportShowsActive(report(20, { attended: true }), now), true, "attended changes nothing");
  });

  test("a locked screen is never active and proves no input, however recent", () => {
    assert.equal(reportedInputAt(report(0, { locked: true }), now), null);
    assert.equal(reportShowsActive(report(0, { locked: true, active: true }), now), false, "a stray active: true does not win over the lock");
  });

  test("idle below the threshold is active; at or above it is not, but the input time is kept for longer delays", () => {
    assert.equal(reportShowsActive(report(179), now), true);
    assert.equal(reportShowsActive(report(180), now), false);
    assert.equal(reportedInputAt(report(180), now), now - 180_000);
    assert.equal(reportedInputAt(report(7 * 60), now), now - 7 * 60_000, "a 10m delay is measured from it");
  });

  test("idle unknown proves nothing", () => {
    assert.equal(reportedInputAt(report(null), now), null);
    assert.equal(reportShowsActive(report(null, { active: true }), now), false);
  });

  test("an older client (no `locked`) keeps today's rules: input only while active and within the window", () => {
    assert.equal(reportedInputAt({ active: true, idleSeconds: 20 }, now), now - 20_000);
    assert.equal(reportedInputAt({ active: false, idleSeconds: 20 }, now), null, "an unfocused old client proves nothing");
    assert.equal(reportedInputAt({ active: true, idleSeconds: 180 }, now), null);
    assert.equal(reportedInputAt({ active: true, idleSeconds: null }, now), now, "mobile foreground");
  });

  test("end to end: unfocused, locked, idle and old-client reports through the store into the plan", async () => {
    const plan = async (delay: Parameters<typeof planNotificationDevices>[2] = "inactive") =>
      planAll(await presenceOf("u9", T0), T0, delay);
    // Raft in the background, typing elsewhere: desktop alerts, the phone stays quiet.
    await recordAt("u9", "desktop", report(10, { attended: false }), T0, "d");
    await recordAt("u9", "mobile", { active: false, idleSeconds: null }, T0, "m");
    assert.deepEqual(await plan(), {
      desktop: true, webPush: false, mobileAlert: false, mobileSocket: true, activeKinds: ["desktop"], mobileDeferUntil: null,
    });
    // Locked: nothing active, everything alerts (Web Push yields to the online desktop).
    await recordAt("u9", "desktop", report(5, { locked: true }), T0, "d");
    assert.deepEqual(await plan(), {
      desktop: true, webPush: false, mobileAlert: true, mobileSocket: true, activeKinds: [], mobileDeferUntil: null,
    });
    assert.equal((await plan("10m")).mobileDeferUntil, null, "locked proves no input: a delay does not wait");
    // Idle 4 minutes: not active; the inactive setting rings the phone, a 10m delay waits 6 more minutes.
    await recordAt("u9", "desktop", report(240), T0, "d");
    assert.equal((await plan()).mobileAlert, true);
    assert.deepEqual([(await plan("10m")).mobileAlert, (await plan("10m")).mobileDeferUntil], [false, T0 - 240_000 + 10 * 60_000]);
    assert.equal((await plan("2m")).mobileAlert, true, "away longer than 2 minutes: rings now");
    // An older desktop that is unfocused reports active: false: today's behaviour (nothing active).
    await recordAt("u9", "desktop", { active: false, idleSeconds: 10 }, T0, "d");
    assert.equal((await plan()).mobileAlert, true);
    assert.deepEqual((await plan()).activeKinds, []);
  });
});

describe("the \"Phone alerts\" setting semantics (mobileDelay)", () => {
  const now = T0;
  const computerInUse = { lastSeenAt: now - 1_000, lastInputAt: now - 20_000 };
  const phoneIdle = { lastSeenAt: now - 1_000, lastInputAt: null };

  test("only when I'm not active on a computer (inactive): decided at send time, never held", () => {
    const plan = planAll({ desktop: computerInUse, mobile: phoneIdle }, now, "inactive");
    assert.deepEqual([plan.mobileAlert, plan.mobileDeferUntil], [false, null], "no alert and nothing held for later");
    const away = planAll({ desktop: { ...computerInUse, lastInputAt: now - ACTIVE_INPUT_WINDOW_MS }, mobile: phoneIdle }, now, "inactive");
    assert.equal(away.mobileAlert, true);
  });

  test("if I'm away for N min and it's still unread: held until last input + N", () => {
    for (const [delay, ms] of [["1m", 60_000], ["2m", 120_000], ["5m", 300_000], ["10m", 600_000]] as const) {
      const plan = planAll({ desktop: computerInUse, mobile: phoneIdle }, now, delay);
      assert.deepEqual([plan.mobileAlert, plan.mobileDeferUntil, plan.desktop], [false, computerInUse.lastInputAt + ms, true], delay);
    }
  });

  test("always, even when I'm active on a computer", () => {
    const plan = planAll({ desktop: computerInUse, mobile: phoneIdle }, now, "always");
    assert.deepEqual([plan.mobileAlert, plan.desktop, plan.mobileDeferUntil], [true, true, null]);
  });

  test("a phone in the foreground always gets its in-app banner; unknown presence fails open, whatever the setting", () => {
    const foreground = { lastSeenAt: now - 1_000, lastInputAt: now - 1_000 };
    for (const delay of ["inactive", "1m", "10m", "always"] as const) {
      assert.equal(planAll({ desktop: computerInUse, mobile: foreground }, now, delay).mobileAlert, true, delay);
      assert.deepEqual(planAll(undefined, now, delay), {
        desktop: true, webPush: true, mobileAlert: true, mobileSocket: true, activeKinds: [], mobileDeferUntil: null,
      }, delay);
    }
  });
});

// ---------------------------------------------------------------------------
// A message never alerts nowhere: only a deliverable computer keeps the phone quiet
// ---------------------------------------------------------------------------

describe("planNotificationDevices: deliverability (the never-alert-nowhere invariant)", () => {
  const now = T0;
  const inUse = { lastSeenAt: now - 1_000, lastInputAt: now - 5_000 };
  const phoneIdle = { lastSeenAt: now - 1_000, lastInputAt: null };
  const delivered = (plan: ReturnType<typeof planNotificationDevices>) => plan.desktop || plan.webPush || plan.mobileAlert || plan.mobileDeferUntil !== null;

  test("B1: a browser in use without a Web Push subscription does not keep the phone quiet", () => {
    for (const delay of ["inactive", "1m", "2m", "5m", "10m"] as const) {
      const plan = planNotificationDevices({ web: inUse, mobile: phoneIdle }, now, delay, NO_WEB_PUSH);
      assert.equal(plan.mobileAlert, true, delay);
      assert.equal(plan.mobileDeferUntil, null, `${delay}: nothing is held for a browser that cannot be alerted`);
      assert.deepEqual(plan.activeKinds, [], "the browser does not count");
    }
    const subscribed = planNotificationDevices({ web: { ...inUse, pushEndpointHashes: ["h"] }, mobile: phoneIdle }, now, "inactive", EVERY_PATH);
    assert.deepEqual([subscribed.webPush, subscribed.mobileAlert], [true, false], "with a subscription the browser is the computer in use");
  });

  test("a desktop app with no reachable socket does not keep the phone quiet; the default assumes nothing is deliverable", () => {
    assert.equal(planNotificationDevices({ desktop: inUse, mobile: phoneIdle }, now, "inactive", { webPushEndpointHashes: new Set(["h"]), desktopSocket: false }).mobileAlert, true);
    assert.equal(planNotificationDevices({ desktop: inUse, mobile: phoneIdle }, now).mobileAlert, true);
  });

  test("every combination of presence, delay and deliverability alerts somewhere (or holds a phone alert)", () => {
    const states = [undefined, { lastSeenAt: now - 1_000, lastInputAt: now - 1_000 }, { lastSeenAt: now - 1_000, lastInputAt: now - 4 * 60_000 }, { lastSeenAt: now - 1_000, lastInputAt: null }];
    for (const desktop of states) for (const web of states) for (const mobile of states) {
      for (const delay of ["inactive", "1m", "10m", "always"] as const) {
        for (const webPush of [true, false]) for (const desktopSocket of [true, false]) {
          const presence = { ...(desktop && { desktop }), ...(web && { web: { ...web, pushEndpointHashes: ["h"] } }), ...(mobile && { mobile }) };
          const plan = planNotificationDevices(presence, now, delay, { webPushEndpointHashes: new Set(webPush ? ["h"] : []), desktopSocket });
          const label = JSON.stringify({ presence, delay, webPush, desktopSocket });
          assert.ok(delivered(plan), label);
          // The phone is quiet only while a deliverable computer path alerts.
          if (!plan.mobileAlert && plan.mobileDeferUntil === null) {
            assert.ok((plan.desktop && desktopSocket) || (plan.webPush && webPush), label);
          }
        }
      }
    }
  });

  test("S1: a browser on another computer than the desktop app in use also gets Web Push", () => {
    const desktop = { lastSeenAt: now - 1_000, lastInputAt: now - 150_000 };
    const elsewhere = planNotificationDevices({ desktop, web: { lastSeenAt: now - 1_000, lastInputAt: now - 1_000, pushEndpointHashes: ["h"] } }, now, "inactive", EVERY_PATH);
    assert.deepEqual([elsewhere.desktop, elsewhere.webPush], [true, true], "browser input far newer than the desktop's: two computers");
    const sameComputer = planNotificationDevices({ desktop, web: { lastSeenAt: now - 1_000, lastInputAt: desktop.lastInputAt + SAME_COMPUTER_INPUT_SLACK_MS, pushEndpointHashes: ["h"] } }, now, "inactive", EVERY_PATH);
    assert.deepEqual([sameComputer.desktop, sameComputer.webPush], [true, false], "within the slack: one computer, the desktop alerts once");
  });
});

describe("SF1 / SF2: per-browser Web Push and fresh desktop entries", () => {
  const now = T0;
  const phoneIdle = { lastSeenAt: now - 1_000, lastInputAt: null };

  test("SF2: a tab whose own browser holds no stored subscription does not count, even when another browser of the user does", () => {
    const tabA = { lastSeenAt: now - 1_000, lastInputAt: now - 2_000, pushEndpointHashes: ["browserA"] };
    const subscriptionsInB = { webPushEndpointHashes: new Set(["browserB"]), desktopSocket: true };
    const plan = planNotificationDevices({ web: tabA, mobile: phoneIdle }, now, "inactive", subscriptionsInB);
    assert.deepEqual([plan.webPush, plan.mobileAlert], [true, true], "nothing active: Web Push to B and the phone");
    assert.deepEqual(plan.activeKinds, []);
    const tabWithoutPush = { lastSeenAt: now - 1_000, lastInputAt: now - 2_000 };
    assert.equal(planNotificationDevices({ web: tabWithoutPush, mobile: phoneIdle }, now, "inactive", subscriptionsInB).mobileAlert, true, "a tab reporting no subscription");
    const tabB = { lastSeenAt: now - 1_000, lastInputAt: now - 2_000, pushEndpointHashes: ["browserB"] };
    assert.equal(planNotificationDevices({ web: tabB, mobile: phoneIdle }, now, "inactive", subscriptionsInB).mobileAlert, false, "the subscribed browser in use");
  });

  test("SF1 / N1: an older desktop must have a fresh active entry; one that acks is judged by its ack, not by freshness", () => {
    const active = { lastSeenAt: now - 5_000, lastInputAt: now - 5_000 };
    assert.equal(planNotificationDevices({ desktop: active, mobile: phoneIdle }, now, "inactive", EVERY_PATH).mobileAlert, false);
    const plan = planNotificationDevices({ desktop: { ...active, stale: true }, mobile: phoneIdle }, now, "inactive", EVERY_PATH);
    assert.deepEqual([plan.desktop, plan.mobileAlert, plan.activeKinds], [true, true, []], "stale older client: still tried, the phone alerts");
    const throttled = { ...active, stale: true as const, confirmable: true as const, ackSocketIds: ["a"] };
    assert.equal(planNotificationDevices({ desktop: throttled, mobile: phoneIdle }, now, "inactive", EVERY_PATH).mobileAlert, false, "a late-reporting renderer that acks stays the computer in use; its ack decides");
  });

  test("S2: staleness and ack sockets come from the active entries, not the kind's newest report", () => {
    const halfOpenLaptop = { socketId: "laptop", lastSeenAt: now - PRESENCE_FRESH_MS - 5_000, lastInputAt: now - PRESENCE_FRESH_MS - 6_000, ackAlerts: true as const };
    const idleHome = { socketId: "home", lastSeenAt: now - 1_000, lastInputAt: now - 60 * 60_000, ackAlerts: true as const };
    const merged = aggregatePresenceEntries([halfOpenLaptop, idleHome], now)!;
    assert.equal(merged.lastSeenAt, now - 1_000, "the kind looks fresh");
    assert.equal(merged.stale, true, "but its only active entry is not");
    assert.deepEqual(merged.ackSocketIds, ["laptop"], "only the active laptop's ack can confirm");
  });

  test("aggregation: confirmable only when every active entry acks; hashes from active entries only", () => {
    const active = (extra: object) => ({ lastSeenAt: now, lastInputAt: now - 1_000, ...extra });
    assert.equal(aggregatePresenceEntries([active({ ackAlerts: true }), active({ ackAlerts: true })], now)?.confirmable, true);
    assert.equal(aggregatePresenceEntries([active({ ackAlerts: true }), active({})], now)?.confirmable, undefined, "an older client among them: trusted as before");
    assert.equal(aggregatePresenceEntries([active({ ackAlerts: true }), { lastSeenAt: now, lastInputAt: null }], now)?.confirmable, true, "an idle legacy socket does not matter");
    assert.deepEqual(aggregatePresenceEntries([active({ pushEndpointHash: "a" }), { lastSeenAt: now, lastInputAt: now - 10 * 60_000, pushEndpointHash: "b" }], now)?.pushEndpointHashes, ["a"]);
  });

  test("the store keeps ackAlerts and the push endpoint hash per socket", async () => {
    await recordAt("u10", "desktop", { active: true, idleSeconds: 1, locked: false, ackAlerts: true }, T0, "d");
    await recordAt("u10", "web", { active: true, idleSeconds: 1, locked: false, pushSubscribed: true, pushEndpointHash: "AbCdEfGh_-123456" }, T0, "w");
    await recordAt("u10", "web", { active: true, idleSeconds: 1, locked: false, pushSubscribed: false, pushEndpointHash: "zzzzzzzzzzzzzzzz" }, T0, "w2");
    const presence = await presenceOf("u10", T0);
    assert.equal(presence.desktop?.confirmable, true);
    assert.deepEqual(presence.web?.pushEndpointHashes, ["AbCdEfGh_-123456"], "pushSubscribed: false carries no hash");
  });
});
