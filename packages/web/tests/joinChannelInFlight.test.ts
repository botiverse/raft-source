import assert from "node:assert/strict";
import type { Channel } from "../src/store/channelStore";

// One join per channel at a time, the Join button's joining state, and the
// click-to-joined span (#proj-frontend:#23, #proj-frontend:#25).

const spans = vi.hoisted(() => [] as Array<{ name: string; status?: string; attrs?: Record<string, unknown>; endTimeMs?: number }>);
vi.mock("../src/utils/webAuthTrace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/webAuthTrace")>()),
  startWebSpan: (name: string) => {
    const record: { name: string; status?: string; attrs?: Record<string, unknown>; endTimeMs?: number } = { name };
    spans.push(record);
    return {
      traceId: "t",
      spanId: "s",
      end: (status: string, attrs?: Record<string, unknown>, endTimeMs?: number) => {
        assert.equal(record.status, undefined, "a span ends once");
        record.status = status;
        record.attrs = attrs;
        record.endTimeMs = endTimeMs;
      },
    };
  },
}));

// channelStore's import chain reads `localStorage` at module load; stub it, then
// load the store via dynamic import (static imports hoist above this stub).
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { useChannelStore } = await import("../src/store/channelStore");
const { joinChannelOnce, SECONDARY_MAX_HOLD_MS } = await import("../src/store/channelJoin");
// The join's messages step imports the message store lazily; the app has it loaded long before.
await import("../src/store/messageStore");
const { holdJoinDeferred, releaseJoinDeferred, useJoinDeferredStore } = await import("../src/store/joinDeferred");
const { useServerStore } = await import("../src/store/serverStore");
const api = (await import("../src/api/client")).default;

function ch(id: string, over: Partial<Channel> = {}): Channel {
  return { id, name: id, description: null, type: "channel", createdAt: "1970-01-01T00:00:00.000Z", joined: false, ...over };
}

beforeEach(() => {
  spans.length = 0;
  // The joined channel's row is read again once the join is accepted.
  vi.spyOn(api, "get").mockImplementation(async (url: string) => ({ data: { ...ch(url.split("/").pop() ?? ""), joined: true } }));
  useChannelStore.setState({ channels: [ch("c1")], dmChannels: [], channelActivity: {}, channelLocalMembership: {}, joiningChannelIds: {} });
  useJoinDeferredStore.setState({ ids: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("a second click while joining shares the first request; the joining state clears when it lands", async () => {
  let release!: () => void;
  const posts: string[] = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string) => {
    posts.push(url);
    if (posts.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return { data: { ok: true } };
  });

  const first = useChannelStore.getState().joinChannel("c1");
  const second = useChannelStore.getState().joinChannel("c1");
  assert.equal(useChannelStore.getState().joiningChannelIds.c1, true, "the button shows it is joining");
  assert.deepEqual(posts, ["/channels/c1/join"], "one request for two clicks");

  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(useChannelStore.getState().channels[0]?.joined, true);
  assert.equal(useChannelStore.getState().joiningChannelIds.c1, undefined);

  await vi.waitFor(() => assert.equal(spans[0]?.status, "ok"));
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.name, "slock.channel.join");
  const { essentials_ms: essentialsMs, ...attrs } = spans[0]?.attrs ?? {};
  assert.deepEqual(attrs, { outcome: "joined", source: "channel_panel", painted: true, extra_clicks: 1 });
  assert.equal(typeof essentialsMs, "number", "click to messages + channel info back");

  // Once the first join is done, a new click is a new request.
  await useChannelStore.getState().joinChannel("c1");
  assert.equal(posts.length, 2);
});

test("a failed join clears the joining state and ends its span as an error", async () => {
  vi.spyOn(api, "post").mockRejectedValue(new Error("network down"));

  assert.equal(await useChannelStore.getState().joinChannel("c1"), false);
  assert.equal(useChannelStore.getState().joiningChannelIds.c1, undefined);
  assert.equal(useChannelStore.getState().channels[0]?.joined, false);
  assert.equal(spans[0]?.status, "error");
  assert.equal(spans[0]?.attrs?.outcome, "failed");
});

test("a join finishes without waiting for a paint: a hidden tab paints nothing", async () => {
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame; // never fires
  vi.useFakeTimers();
  try {
    vi.spyOn(api, "post").mockResolvedValue({ data: { ok: true } });
    assert.equal(await useChannelStore.getState().joinChannel("c1", "forward"), true);
    assert.equal(useChannelStore.getState().joiningChannelIds.c1, undefined, "the button is usable again");
    assert.equal(spans[0]?.status, undefined, "the span waits for the paint");
    await vi.advanceTimersByTimeAsync(1000);
    const { essentials_ms: _essentials, ...attrs } = spans[0]?.attrs ?? {};
    assert.deepEqual(attrs, { outcome: "joined", source: "forward", painted: false, extra_clicks: 0 });
  } finally {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = raf;
  }
});

test("a server switch forgets a join in flight: the next click sends its own request", async () => {
  const { triggerServerReset } = await import("../src/store/serverResetRegistry");
  let release!: () => void;
  const post = vi.spyOn(api, "post").mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { data: { ok: true } };
  }).mockResolvedValue({ data: { ok: true } });

  const stale = useChannelStore.getState().joinChannel("c1");
  triggerServerReset();
  useChannelStore.setState({ channels: [ch("c1")] });
  assert.equal(useChannelStore.getState().joiningChannelIds.c1, undefined);
  assert.equal(await useChannelStore.getState().joinChannel("c1"), true);
  assert.equal(post.mock.calls.length, 2);
  release();
  await stale;
});

// #proj-frontend:#24: after a join only messages and channel info go first;
// the channel's other loads are held from the click until those are back, the
// channel is painted and the browser is idle, and never past the cap.
describe("secondary loads after a join", () => {
  let idle: Array<{ run: () => void; timeout?: number }>;
  const realIdle = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  const realRaf = globalThis.requestAnimationFrame;
  beforeEach(() => {
    idle = [];
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (run: () => void, options?: { timeout?: number }) => {
      idle.push({ run, timeout: options?.timeout });
      return idle.length;
    };
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
  });
  afterEach(() => {
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = realIdle;
    globalThis.requestAnimationFrame = realRaf;
  });

  const held = () => useJoinDeferredStore.getState().ids.c1 !== undefined;

  function harness(post: () => Promise<unknown>) {
    const log: string[] = [];
    const rereads: string[] = [];
    let essentialsDone!: () => void;
    const essentials = new Promise<void>((resolve) => { essentialsDone = resolve; });
    const joiner = joinChannelOnce({
      post,
      onJoined: () => {},
      loadEssentials: () => { log.push("essentials"); return essentials; },
      setJoining: () => {},
      rereadRow: async (id) => { rereads.push(id); },
    });
    return { joiner, log, rereads, essentialsDone };
  }

  test("held from the click; released only after the essentials, the paint and an idle moment within the cap", async () => {
    const h = harness(async () => ({}));
    const joined = h.joiner.join("c1");
    assert.equal(held(), true, "held from the click");
    assert.equal(await joined, true);
    await new Promise((r) => setTimeout(r, 10)); // painted
    assert.equal(idle.length, 0, "not before the essentials are back");
    assert.equal(held(), true);

    h.essentialsDone();
    await vi.waitFor(() => assert.equal(idle.length, 1));
    const timeout = idle[0]!.timeout ?? Infinity;
    assert.ok(timeout > 0 && timeout <= SECONDARY_MAX_HOLD_MS, `the idle wait only gets what is left of the cap (${timeout})`);
    assert.equal(held(), true, "still held until the browser is idle");
    idle.shift()!.run();
    assert.equal(held(), false);
    assert.deepEqual(h.rereads, [], "an accepted join reads the row with its essentials");

    await vi.waitFor(() => assert.equal(spans[0]?.status, "ok"));
    assert.equal(typeof spans[0]?.attrs?.essentials_ms, "number");
    assert.ok((spans[0]?.endTimeMs ?? 0) > 0, "the span keeps its end at the paint");
  });

  test("a failed join releases at once and re-reads the row (a members event it dropped is not lost)", async () => {
    const h = harness(async () => { throw new Error("nope"); });
    assert.equal(await h.joiner.join("c1"), false);
    assert.equal(held(), false);
    assert.equal(idle.length, 0);
    assert.deepEqual(h.rereads, ["c1"]);
    assert.equal(spans[0]?.attrs?.essentials_ms, undefined);
  });

  test("essentials that never come back: released at the cap without waiting for idle; the span goes then too", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(async () => ({}));
      await h.joiner.join("c1");
      await vi.advanceTimersByTimeAsync(SECONDARY_MAX_HOLD_MS - 1);
      assert.equal(held(), true);
      assert.equal(spans[0]?.status, undefined);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(held(), false, "released at the cap");
      assert.equal(idle.length, 0, "no idle wait past the cap");
      assert.equal(spans[0]?.status, "ok", "sent at the cap");
      assert.equal(spans[0]?.attrs?.essentials_ms, undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an earlier join's release does not end a newer hold of the same channel", async () => {
    const h = harness(async () => ({}));
    await h.joiner.join("c1");
    h.essentialsDone();
    await vi.waitFor(() => assert.equal(idle.length, 1));
    holdJoinDeferred("c1"); // left and joined again before the first release ran
    idle.shift()!.run();
    assert.equal(held(), true, "the newer hold stays");
  });

  test("the store's join re-reads the channel row (channel info) and holds the channel until idle", async () => {
    useServerStore.setState({ current: { id: "s1" } as never });
    vi.spyOn(api, "post").mockResolvedValue({ data: { ok: true } });
    const get = vi.mocked(api.get);
    assert.equal(await useChannelStore.getState().joinChannel("c1"), true);
    assert.equal(held(), true);
    await vi.waitFor(() => assert.equal(idle.length, 1));
    assert.deepEqual(get.mock.calls.map(([url]) => url), ["/channels/c1"], "not on screen: no messages page");
    idle.shift()!.run();
    assert.equal(held(), false);
  });

  test("a surface opened during the hold ends it whatever its token; a server switch forgets holds", async () => {
    holdJoinDeferred("c1");
    holdJoinDeferred("c2");
    releaseJoinDeferred("c1", -1);
    assert.equal(held(), true, "a wrong token leaves it");
    releaseJoinDeferred("c1");
    assert.deepEqual(Object.keys(useJoinDeferredStore.getState().ids), ["c2"]);
    const { triggerServerReset } = await import("../src/store/serverResetRegistry");
    triggerServerReset();
    assert.deepEqual(useJoinDeferredStore.getState().ids, {});
  });
});
