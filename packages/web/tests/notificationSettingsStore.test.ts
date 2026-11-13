import assert from "node:assert/strict";
import "./helpers/domSetup";
import { useNotificationSettingsStore, serverNotificationLevel } from "../src/store/notificationSettingsStore";
import { useServerStore } from "../src/store/serverStore";
import { useChannelStore } from "../src/store/channelStore";
import { runTestNotification, TEST_NOTIFICATION_WAIT_MS } from "../src/notifications/notificationApi";
import { nextMorningNine, pausedUntilForMinutes, pausedUntilForPreset } from "../src/notifications/pause";

// The client half of contract §2.3 (notification_prefs:updated with a `type`,
// stale versions dropped), the legacy-boolean mirror, the test-notification
// wait (§6) and the pause presets.

const SETTINGS = {
  pausedUntil: null,
  quietHours: { enabled: false, startMinute: 1320, endMinute: 480, timeZone: "UTC" },
  previewMode: "full",
  sound: true,
  mobileDelay: "inactive",
};

afterEach(async () => {
  (await import("../src/store/notificationPrefsSyncDomain")).resetNotificationPrefsSyncCoreForTests();
  useNotificationSettingsStore.getState().reset();
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("account frames apply only when their version is newer than the one held", () => {
  const store = useNotificationSettingsStore.getState();
  assert.equal(store.applyPrefsUpdate({ type: "account", settings: { ...SETTINGS, sound: false, version: 2 } }), true);
  assert.equal(useNotificationSettingsStore.getState().account?.sound, false);
  assert.equal(store.applyPrefsUpdate({ type: "account", settings: { ...SETTINGS, sound: true, version: 2 } }), false, "same version dropped");
  assert.equal(store.applyPrefsUpdate({ type: "account", settings: { ...SETTINGS, sound: true, version: 1 } }), false, "older version dropped");
  assert.equal(useNotificationSettingsStore.getState().account?.sound, false);
  assert.equal(store.applyPrefsUpdate({ type: "account", settings: { ...SETTINGS, previewMode: "bogus", version: 9 } }), false, "malformed dropped");
});

test("server / channel / thread frames fold in by scope, with stale prefsVersion dropped", () => {
  const store = useNotificationSettingsStore.getState();
  assert.equal(store.applyPrefsUpdate({ type: "server", serverId: "s1", scopeId: "s1", level: "mentions", prefsVersion: 4 }), true);
  assert.equal(store.applyPrefsUpdate({ type: "server", serverId: "s1", scopeId: "s1", level: "all", prefsVersion: 3 }), false);
  assert.equal(useNotificationSettingsStore.getState().serverLevels.s1, "mentions");

  assert.equal(store.applyPrefsUpdate({ type: "channel", serverId: "s1", scopeId: "c1", level: "none", prefsVersion: 2 }), true);
  assert.equal(store.applyPrefsUpdate({ type: "thread", serverId: "s1", scopeId: "t1", level: "all", prefsVersion: 1 }), true);
  assert.equal(useNotificationSettingsStore.getState().explicit.s1?.channels.c1, "none");
  assert.equal(useNotificationSettingsStore.getState().explicit.s1?.threads.t1, "all");

  // default removes the explicit value.
  assert.equal(store.applyPrefsUpdate({ type: "channel", serverId: "s1", scopeId: "c1", level: "default", prefsVersion: 3 }), true);
  assert.equal(useNotificationSettingsStore.getState().explicit.s1?.channels.c1, undefined);
  // A server never takes default.
  assert.equal(store.applyPrefsUpdate({ type: "server", serverId: "s1", scopeId: "s1", level: "default", prefsVersion: 9 }), false);
});

test("a legacy boolean frame: muted = none, unmuted brings none back to all and keeps mentions", () => {
  const store = useNotificationSettingsStore.getState();
  store.noteLegacyServerMuted("s1", true);
  assert.equal(useNotificationSettingsStore.getState().serverLevels.s1, "none");
  store.noteLegacyServerMuted("s1", false);
  assert.equal(useNotificationSettingsStore.getState().serverLevels.s1, "all");
  store.applyPrefsUpdate({ type: "server", serverId: "s1", scopeId: "s1", level: "mentions" });
  store.noteLegacyServerMuted("s1", false);
  assert.equal(useNotificationSettingsStore.getState().serverLevels.s1, "mentions");
});

test("before levels load, a server row's legacy mute reads as none", () => {
  useServerStore.setState({ servers: [{ id: "s2", slug: "s2", name: "B", serverPushMuted: true }] } as never);
  assert.equal(serverNotificationLevel("s2"), "none");
  assert.equal(serverNotificationLevel("unknown"), "all");
});

test("socket bridge: typed frames reach the notification store and never the channel mute state", async () => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
  useChannelStore.setState({
    channels: [{ id: "c1", name: "c", type: "channel", createdAt: "", joined: true, activityMuteSupported: true, activityMuted: false, muteFromSeq: null, prefsVersion: 0 }],
    dmChannels: [],
  } as never);
  const binding = buildMainLayoutSocketBindings(
    { connected: true, emit: () => undefined, on: () => undefined, off: () => undefined, onAny: () => undefined, offAny: () => undefined, disconnect: () => undefined, connect: () => undefined },
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "notification_prefs:updated");
  assert.ok(binding);

  binding.handler({ type: "channel", serverId: "s1", scopeId: "c1", level: "none", prefsVersion: 5 });
  assert.equal(useNotificationSettingsStore.getState().explicit.s1?.channels.c1, "none");
  assert.equal(useChannelStore.getState().channels[0]?.activityMuted, false, "a level frame is not a mute");
  assert.equal(useChannelStore.getState().channels[0]?.prefsVersion, 0);

  binding.handler({ type: "account", settings: { ...SETTINGS, pausedUntil: "2030-01-01T00:00:00.000Z", version: 7 } });
  assert.equal(useNotificationSettingsStore.getState().account?.pausedUntil, "2030-01-01T00:00:00.000Z");

  useServerStore.setState({ servers: [{ id: "s1", slug: "s1", name: "A", serverPushMuted: false, notificationPrefsVersion: 0 }] } as never);
  binding.handler({ type: "server", serverId: "s1", scopeId: "s1", level: "none", prefs: { serverPushMode: "none" }, prefsVersion: 6 });
  assert.equal(useNotificationSettingsStore.getState().serverLevels.s1, "none");
  assert.equal(useServerStore.getState().servers[0]?.serverPushMuted, true, "the legacy boolean row follows");
});

test("the test notification resolves shown / not shown / failed, and not shown after 15 s with no ack", async () => {
  let clock = 0;
  const deps = { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
  const start = async () => ({ sent: true as const, testId: "t" });

  assert.deepEqual(await runTestNotification({ kind: "web", endpoint: "e" }, { ...deps, start, fetchStatus: async () => ({ status: "shown" as const }) }), { state: "shown" });

  let polls = 0;
  const lateNotShown = async () => (++polls < 3 ? { status: "pending" as const } : { status: "not_shown" as const });
  assert.deepEqual(await runTestNotification({ kind: "web", endpoint: "e" }, { ...deps, start, fetchStatus: lateNotShown }), { state: "not_shown" });

  clock = 0;
  assert.deepEqual(await runTestNotification({ kind: "web", endpoint: "e" }, { ...deps, start, fetchStatus: async () => ({ status: "pending" as const }) }), { state: "not_shown" });
  assert.ok(clock >= TEST_NOTIFICATION_WAIT_MS, "waited the whole window");

  assert.deepEqual(
    await runTestNotification({ kind: "desktop", socketId: "s" }, { ...deps, start: async () => ({ sent: false as const, testId: null, reason: "no_device" }) }),
    { state: "failed", reason: "no_device" },
  );
  assert.deepEqual(
    await runTestNotification({ kind: "web", endpoint: "e" }, { ...deps, start, fetchStatus: async () => ({ status: "failed" as const, reason: "provider_error" }) }),
    { state: "failed", reason: "provider_error" },
  );
});

test("pause presets: 30 min / 1 h / 2 h from now, and tomorrow at 9:00 local even before 9:00 today", () => {
  const now = new Date(2026, 9, 30, 7, 15, 0);
  assert.equal(pausedUntilForPreset("30m", now).getTime() - now.getTime(), 30 * 60_000);
  assert.equal(pausedUntilForPreset("2h", now).getTime() - now.getTime(), 120 * 60_000);
  const morning = nextMorningNine(now);
  assert.deepEqual([morning.getDate(), morning.getHours(), morning.getMinutes()], [31, 9, 0]);
  assert.equal(pausedUntilForMinutes(60, now)?.getTime(), now.getTime() + 60 * 60_000);
  assert.equal(pausedUntilForMinutes("tomorrow", now)?.getTime(), morning.getTime());
  assert.equal(pausedUntilForMinutes(0, now), null);
});

function prefsBinding(buildMainLayoutSocketBindings: typeof import("../src/store/socketBridge").buildMainLayoutSocketBindings) {
  const binding = buildMainLayoutSocketBindings(
    { connected: true, emit: () => undefined, on: () => undefined, off: () => undefined, onAny: () => undefined, offAny: () => undefined, disconnect: () => undefined, connect: () => undefined },
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "notification_prefs:updated");
  assert.ok(binding);
  return binding;
}

test("a channel's mute and its notification level are deduped apart: crossing versions both apply", async () => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
  useServerStore.setState({ current: { id: "s1", slug: "s1", name: "A" } } as never);
  useChannelStore.setState({
    channels: [{ id: "c1", name: "c", type: "channel", createdAt: "", joined: true, activityMuteSupported: true, activityMuted: false, muteFromSeq: null, prefsVersion: 0 }],
    dmChannels: [],
  } as never);
  const binding = prefsBinding(buildMainLayoutSocketBindings);
  const mute = (activityMuted: boolean, prefsVersion: number) =>
    binding.handler({ serverId: "s1", scopeId: "c1", prefs: { activityMuted, muteFromSeq: activityMuted ? 10 : null }, prefsVersion });
  const level = (value: string, prefsVersion: number) =>
    binding.handler({ type: "channel", serverId: "s1", scopeId: "c1", level: value, prefsVersion });

  // The mute line is far ahead of the level line, and then the reverse.
  mute(true, 40);
  level("none", 2);
  assert.equal(useChannelStore.getState().channels[0]?.activityMuted, true);
  assert.equal(useNotificationSettingsStore.getState().explicit.s1?.channels.c1, "none", "a newer mute version does not drop a level update");

  level("all", 50);
  mute(false, 41);
  assert.equal(useChannelStore.getState().channels[0]?.activityMuted, false, "a newer level version does not drop a mute update");
  assert.equal(useNotificationSettingsStore.getState().explicit.s1?.channels.c1, "all");

  // Each line still drops its own stale frames.
  mute(true, 41);
  level("mentions", 49);
  assert.equal(useChannelStore.getState().channels[0]?.activityMuted, false);
  assert.equal(useNotificationSettingsStore.getState().explicit.s1?.channels.c1, "all");
});

test("a thread level and an account frame keep their own version lines too", () => {
  const store = useNotificationSettingsStore.getState();
  assert.equal(store.applyPrefsUpdate({ type: "channel", serverId: "s1", scopeId: "x1", level: "none", prefsVersion: 9 }), true);
  assert.equal(store.applyPrefsUpdate({ type: "thread", serverId: "s1", scopeId: "x1", level: "all", prefsVersion: 1 }), true, "same id, other scope");
  assert.equal(store.applyPrefsUpdate({ type: "account", settings: { ...SETTINGS, version: 1 } }), true);
  assert.deepEqual(useNotificationSettingsStore.getState().scopeVersions, { "channel:x1": 9, "thread:x1": 1, account: 1 });
});

test("notificationLevel on channel and thread payloads seeds levels, never over a realtime frame", () => {
  const store = useNotificationSettingsStore.getState();
  store.applyPrefsUpdate({ type: "channel", serverId: "s1", scopeId: "c-live", level: "all", prefsVersion: 3 });
  store.seedLevelsFromPayloads("s1", "channel", [
    { id: "c-live", notificationLevel: "none" },
    { id: "c2", notificationLevel: "mentions" },
    { id: "c3", notificationLevel: null },
    { id: "c4" },
  ]);
  store.seedLevelsFromPayloads("s1", "thread", [{ id: "t1", notificationLevel: "none" }]);
  const explicit = useNotificationSettingsStore.getState().explicit.s1!;
  assert.deepEqual(explicit.channels, { "c-live": "all", c2: "mentions" });
  assert.deepEqual(explicit.threads, { t1: "none" });
});

// S9: overlapping level writes. Each PUT resolves when the test says so.
async function withControlledPuts(run: (puts: Array<{ body: { level: string }; resolve(v: number): void; reject(): void }>) => Promise<void>) {
  const api = (await import("../src/api/client")).default;
  const original = api.put;
  const puts: Array<{ body: { level: string }; resolve(v: number): void; reject(): void }> = [];
  api.put = ((_url: string, body: { scope: string; id: string; level: string }) => new Promise((resolve, reject) => {
    puts.push({
      body,
      resolve: (prefsVersion: number) => resolve({ data: { ...body, serverId: "s1", effective: body.level, muted: false, prefsVersion } }),
      reject: () => reject(new Error("boom")),
    });
  })) as typeof api.put;
  try {
    await run(puts);
  } finally {
    api.put = original;
  }
}

const channelLevel = () => useNotificationSettingsStore.getState().explicit.s1?.channels.c1 ?? "default";

test("level writes: responses in reverse order leave the latest choice", async () => {
  await withControlledPuts(async (puts) => {
    const store = useNotificationSettingsStore.getState();
    const first = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "none" });
    const second = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "all" });
    assert.equal(channelLevel(), "all", "optimistic");
    puts[1]!.resolve(8);
    await second;
    puts[0]!.resolve(7);
    await first;
    assert.equal(channelLevel(), "all", "the older response does not overwrite the latest");
    assert.equal(useNotificationSettingsStore.getState().scopeVersions["channel:c1"], 8);
  });
});

test("level writes: an older request's failure does not roll back; the latest's restores what the server holds", async () => {
  await withControlledPuts(async (puts) => {
    const store = useNotificationSettingsStore.getState();
    const first = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "none" });
    const second = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "all" });
    puts[0]!.reject();
    assert.equal(await first, false);
    assert.equal(channelLevel(), "all", "an older failure leaves the newer choice");
    puts[1]!.reject();
    assert.equal(await second, false);
    assert.equal(channelLevel(), "default", "the latest failure restores the confirmed value");

    // An earlier success is what a later failure falls back to.
    const third = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "mentions" });
    const fourth = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "none" });
    puts[2]!.resolve(3);
    await third;
    puts[3]!.reject();
    await fourth;
    assert.equal(channelLevel(), "mentions");
  });
});

test("level writes: a response older than a realtime frame already held is not applied, nor rolled back over it", async () => {
  await withControlledPuts(async (puts) => {
    const store = useNotificationSettingsStore.getState();
    const write = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "none" });
    store.applyPrefsUpdate({ type: "channel", serverId: "s1", scopeId: "c1", level: "mentions", prefsVersion: 10 });
    puts[0]!.resolve(9);
    await write;
    assert.equal(channelLevel(), "mentions", "the newer frame stands");

    const failing = store.setLevel({ scope: "channel", id: "c1", serverId: "s1", level: "all" });
    store.applyPrefsUpdate({ type: "channel", serverId: "s1", scopeId: "c1", level: "none", prefsVersion: 11 });
    puts[1]!.reject();
    await failing;
    assert.equal(channelLevel(), "none", "no rollback over a frame that arrived meanwhile");
  });
});

test("a test this device delivered but could not confirm reads as unconfirmed, not not-shown", async () => {
  let clock = 0;
  const deps = { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
  const start = async () => ({ sent: true as const, testId: "old-shell" });
  let polls = 0;
  const fetchStatus = async () => { polls += 1; return { status: "pending" as const }; };
  assert.deepEqual(
    await runTestNotification({ kind: "desktop", socketId: "s" }, { ...deps, start, fetchStatus, isUnconfirmed: (id) => id === "old-shell" }),
    { state: "unconfirmed" },
  );
  assert.equal(polls, 0, "answered at once: no ack will ever come");

  // The server's not_shown, for a test the gate recorded as unconfirmed.
  const { noteUnconfirmedTestNotification } = await import("../src/notifications/notificationApi");
  let noted = false;
  const lateNote = async () => { if (!noted) { noted = true; return { status: "pending" as const }; } return { status: "not_shown" as const }; };
  assert.deepEqual(await runTestNotification({ kind: "desktop", socketId: "s" }, { ...deps, start: async () => ({ sent: true as const, testId: "t-real" }), fetchStatus: lateNote }), { state: "not_shown" });
  noteUnconfirmedTestNotification("t-late");
  assert.deepEqual(await runTestNotification({ kind: "desktop", socketId: "s" }, { ...deps, start: async () => ({ sent: true as const, testId: "t-late" }), fetchStatus: async () => ({ status: "not_shown" as const }) }), { state: "unconfirmed" });
});
