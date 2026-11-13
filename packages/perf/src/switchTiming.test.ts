import { describe, expect, it } from "vitest";
import { isMessageRoute, routeOf, switchTiming } from "./switchTiming";

const messages = (startMs: number, sentMs: number, responseMs: number, endMs: number, bytes = 7000) => ({ path: "/api/messages/channel/:id", message: true, startMs, sentMs, responseMs, endMs, bytes });
const other = (startMs: number, endMs: number, bytes = 300) => ({ path: "/api/channels/:id/members", message: false, startMs, sentMs: startMs, responseMs: endMs, endMs, bytes });

describe("switchTiming", () => {
  it("a miss: the paint waited for a message request, and the pieces add up to the total", () => {
    const t = switchTiming(1000, [messages(250, 260, 700, 900), other(250, 500)], [{ startMs: 20, durationMs: 200 }, { startMs: 920, durationMs: 300 }]);
    expect(t).toEqual({ totalMs: 1000, settledMs: 1000, cache: "miss", requests: 2, bytes: 7300, mainThreadMs: 280, inputDelayMs: 0, messageRequests: 1, appRequestDelayMs: 250, requestDelayMs: 250, waitedStartMs: 250, queueMs: 10, ttfbMs: 440, downloadMs: 200, renderMs: 100 });
    expect(t.waitedStartMs! + t.queueMs! + t.ttfbMs! + t.downloadMs! + t.renderMs!).toBe(t.totalMs);
  });

  it("stale: painted from local data while the message request was still out", () => {
    const t = switchTiming(250, [messages(236, 237, 620, 827)], [{ startMs: 30, durationMs: 195 }]);
    expect(t).toMatchObject({ totalMs: 250, settledMs: 827, cache: "stale", requests: 1, mainThreadMs: 195, requestDelayMs: 236, queueMs: 1, ttfbMs: 383, downloadMs: 207, renderMs: null });
    expect(t.waitedStartMs! + t.queueMs! + t.ttfbMs! + t.downloadMs!).toBe(t.settledMs);
  });

  it("stale also when the refresh is only sent after the paint; it is then not counted as a request of the switch", () => {
    const t = switchTiming(250, [messages(260, 261, 600, 800), other(100, 400)], []);
    expect(t).toMatchObject({ cache: "stale", settledMs: 800, requests: 1, bytes: 300, requestDelayMs: 260 });
  });

  it("hit: no message request at all", () => {
    expect(switchTiming(458, [other(337, 598)], [{ startMs: 0, durationMs: 451 }])).toMatchObject({ cache: "hit", totalMs: 458, settledMs: 458, requests: 1, requestDelayMs: null, mainThreadMs: 451 });
  });

  it("with several message requests, a miss is split on the one the paint waited for longest", () => {
    const t = switchTiming(1000, [messages(100, 100, 200, 300), messages(100, 150, 600, 800)], []);
    // asked for both at 100; the paint waited for the one that ended at 800
    expect(t).toMatchObject({ cache: "miss", messageRequests: 2, requestDelayMs: 100, waitedStartMs: 100, queueMs: 50, ttfbMs: 450, downloadMs: 200, renderMs: 200 });
  });

  it("rounds to whole milliseconds and never reports more main-thread time than the switch took", () => {
    const t = switchTiming(300.4, [messages(10.4, 12.6, 100.5, 200.5)], [{ startMs: -50, durationMs: 500 }]);
    expect(t.mainThreadMs).toBe(300);
    expect(t.waitedStartMs! + t.queueMs! + t.ttfbMs! + t.downloadMs! + t.renderMs!).toBe(300);
  });
  it("when the paint waited for a later request than the first one asked for, the split starts at that request and still adds up", () => {
    const t = switchTiming(1000, [messages(100, 100, 200, 300), messages(400, 450, 600, 800)], []);
    expect(t).toMatchObject({ cache: "miss", requestDelayMs: 100, waitedStartMs: 400, queueMs: 50, ttfbMs: 150, downloadMs: 200, renderMs: 200 });
    expect(t.waitedStartMs! + t.queueMs! + t.ttfbMs! + t.downloadMs! + t.renderMs!).toBe(1000);
  });

  it("of two message requests asked for at the same moment, a stale view is current when the later one is back", () => {
    expect(switchTiming(300, [messages(250, 250, 400, 500), messages(250, 250, 600, 900)], []).settledMs).toBe(900);
  });

  it("a top-up sent after a miss's paint moves neither settled nor the split", () => {
    const t = switchTiming(500, [messages(100, 100, 300, 400), messages(450, 450, 700, 900)], []);
    expect(t).toMatchObject({ cache: "miss", totalMs: 500, settledMs: 500, messageRequests: 2, requestDelayMs: 100, waitedStartMs: 100, renderMs: 100 });
  });

  it("after a stale paint the refresh is the first request asked for; a later top-up changes nothing but the count", () => {
    // the thread case: the refresh leaves 83 ms after the click, the after= top-up a second later
    const refresh = messages(83, 84, 500, 700), topUp = messages(1165, 1166, 1400, 1450, 300);
    const alone = switchTiming(420, [refresh], [], 79), both = switchTiming(420, [refresh, topUp], [], 79);
    expect(both).toMatchObject({ cache: "stale", requestDelayMs: 83, appRequestDelayMs: 4, waitedStartMs: 83, settledMs: 700, messageRequests: 2 });
    expect({ ...both, messageRequests: 1 }).toEqual(alone);
  });

  it("a request that is not the view's messages never decides the cache state", () => {
    expect(switchTiming(250, [other(50, 200)], [])).toMatchObject({ cache: "hit", settledMs: 250, requests: 1 });
  });

  it("decides miss or stale on whole milliseconds, like the split", () => {
    expect(switchTiming(300.45, [messages(10, 10, 100, 300.4)], [])).toMatchObject({ cache: "miss", renderMs: 0 });
  });
});

describe("input delay", () => {
  it("splits the request delay into the browser being busy and the app's own share", () => {
    const t = switchTiming(1000, [messages(120, 121, 600, 800)], [], 85.4);
    expect(t).toMatchObject({ requestDelayMs: 120, inputDelayMs: 85, appRequestDelayMs: 35 });
    // the split of the whole switch still starts at the click event: the pieces add up as before
    expect(t.waitedStartMs! + t.queueMs! + t.ttfbMs! + t.downloadMs! + t.renderMs!).toBe(1000);
  });
  it("is reported for a hit too, and never exceeds the switch or goes negative", () => {
    expect(switchTiming(300, [], [], 40)).toMatchObject({ cache: "hit", inputDelayMs: 40, appRequestDelayMs: null });
    expect(switchTiming(300, [], [], 900).inputDelayMs).toBe(300);
    expect(switchTiming(300, [messages(10, 11, 100, 200)], [], 60)).toMatchObject({ inputDelayMs: 60, appRequestDelayMs: 0 });
    expect(switchTiming(300, [], [], -5).inputDelayMs).toBe(0);
  });
});

describe("isMessageRoute", () => {
  it("is a channel's page or a message's context, and nothing else under the prefix", () => {
    expect(["/api/messages/channel/:id", "/api/messages/context/:id"].every(isMessageRoute)).toBe(true);
    expect(["/api/messages/sync", "/api/messages/search", "/api/messages/channel/:id/human-outline", "/api/messages/channel/:id/by-activity", "/api/messages"].some(isMessageRoute)).toBe(false);
  });
});

describe("routeOf", () => {
  it("names the route, never the channel", () => {
    expect(routeOf("/api/messages/channel/9cebcb07-30d5-4970-bae6-a1ba5a5d4c2a")).toBe("/api/messages/channel/:id");
    expect(routeOf("/api/channels/9CEBCB07-30D5-4970-BAE6-A1BA5A5D4C2A/members")).toBe("/api/channels/:id/members");
  });
});
