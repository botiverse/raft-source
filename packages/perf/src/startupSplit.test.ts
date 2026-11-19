import { describe, expect, it } from "vitest";
import { type ApiTiming, type StartupLoad, blameTasks, endpointOf, isFirstPage, median, splitRequest, splitStartup, summarize, toPageClock, withinWindow } from "./startupSplit";

const api = (over: Partial<ApiTiming>): ApiTiming => ({ path: "/api/x", query: "", initiator: "xmlhttprequest", protocol: "h2", start: 0, requestStart: 0.5, responseStart: 100, responseEnd: 110, encodedBytes: 100, decodedBytes: 300, ...over });
const page = (over: Partial<ApiTiming>): ApiTiming => api({ path: "/api/messages/channel/:channel", query: "?limit", initiator: "fetch", ...over });
const load = (over: Partial<StartupLoad>): StartupLoad => ({ api: [], preflights: [], longTasks: [], contentMs: null, firstRowMs: null, paintedMs: null, socketOpenMs: null, commitSha: null, ...over });

describe("startupSplit", () => {
  it("cuts a request at the points the browser recorded", () => {
    expect(splitRequest(page({ start: 941, requestStart: 1157, responseStart: 1724, responseEnd: 2288, encodedBytes: 85_000, decodedBytes: 196_000, protocol: "h3" }))).toEqual({ start: 941, beforeSendMs: 216, firstByteMs: 567, downloadMs: 564, end: 2288, encodedBytes: 85_000, decodedBytes: 196_000, protocol: "h3", initiator: "fetch" });
  });
  it("gives no pieces when the browser hid the timing, instead of reading zeros as times", () => {
    const split = splitRequest(page({ start: 300, requestStart: 0, responseStart: 0, responseEnd: 900 }));
    expect([split.beforeSendMs, split.firstByteMs, split.downloadMs]).toEqual([null, null, null]);
    expect(split.end).toBe(900);
  });
  it("knows the opened channel's first page from a later page, from another channel's or a thread's page, and from other message endpoints", () => {
    expect(isFirstPage({ path: "/api/messages/channel/:channel", query: "?limit&threadPreviewChars" })).toBe(true);
    for (const cursor of ["before", "after", "around", "cursor", "since_seq"]) expect(isFirstPage({ path: "/api/messages/channel/:channel", query: `?limit&${cursor}` })).toBe(false);
    // a key that only starts like a cursor is not one
    expect(isFirstPage({ path: "/api/messages/channel/:channel", query: "?limit&afterglow" })).toBe(true);
    expect(isFirstPage({ path: "/api/messages/channel/:id", query: "?limit" })).toBe(false);
    expect(isFirstPage({ path: "/api/messages/sync", query: "?since_seq&channel_id" })).toBe(false);
    expect(isFirstPage({ path: "/api/messages/channel/:channel/pins", query: "" })).toBe(false);
  });
  it("splits a load: the first-page request, its preflight, what came before the first row, and the gap after the answer", () => {
    const split = splitStartup(
      load({
        api: [api({ path: "/api/auth/me", start: 60, responseEnd: 300 }), api({ path: "/api/servers", start: 60, responseEnd: 310 }), page({ start: 941, requestStart: 1157, responseStart: 1724, responseEnd: 2288 }), api({ path: "/api/agents", start: 2400, responseEnd: 2600 })],
        preflights: [{ path: "/api/auth/me", at: 61, ms: 240 }, { path: "/api/messages/channel/:channel", at: 942, ms: 214 }],
        longTasks: [{ start: 1000, ms: 120, from: "app-shell.js" }, { start: 2290, ms: 70, from: "app-shell.js" }, { start: 2500, ms: 90, from: "" }],
        contentMs: 2291,
        firstRowMs: 2366,
        paintedMs: 2407,
        socketOpenMs: 1600,
      }),
    );
    expect(split.messages).toMatchObject({ start: 941, beforeSendMs: 216, firstByteMs: 567, downloadMs: 564, end: 2288 });
    expect(split.messagesPreflightMs).toBe(214);
    expect([split.preflights, split.preflightTotalMs]).toEqual([2, 454]);
    expect(split.apiBeforeFirstRow).toBe(3);
    expect([split.responseToContentMs, split.responseToRowMs, split.responseToPaintMs]).toEqual([3, 78, 119]);
    // only the task that overlaps the gap between the answer (2288) and the paint (2407)
    expect(split.longTasksInGap).toEqual([{ start: 2290, ms: 70, from: "app-shell.js" }]);
    expect(split.longTaskMsInGap).toBe(70);
    expect(split.secondFirstPage).toBeNull();
    expect(split.shownBeforeAnswer).toBe(false);
  });
  it("says what came before the asking: long-task time up to it, and the answer that ended last before it", () => {
    const split = splitStartup(
      load({
        api: [api({ path: "/api/auth/me", start: 60, responseEnd: 300 }), api({ path: "/api/servers", start: 60, responseEnd: 550 }), api({ path: "/api/slow", start: 100, responseEnd: 2000 }), page({ start: 640, responseEnd: 1900 })],
        // the third task is still running at the asking (counts up to it: 40 of its 200 ms), the fourth is after it
        longTasks: [{ start: 150, ms: 80, from: "" }, { start: 250, ms: 55, from: "" }, { start: 600, ms: 200, from: "" }, { start: 1950, ms: 400, from: "" }],
      }),
    );
    expect(split.beforeAsk).toEqual({ longTaskMs: 175, lastAnswer: { endpoint: "/api/servers", endMs: 550, askedAfterMs: 90 } });
    // a reopen asks before any answer is in; a load that never asks has nothing to say
    expect(splitStartup(load({ api: [page({ start: 20, responseEnd: 400 }), api({ path: "/api/servers", start: 30, responseEnd: 300 })] })).beforeAsk).toEqual({ longTaskMs: 0, lastAnswer: null });
    expect(splitStartup(load({ api: [api({ path: "/api/servers", start: 30, responseEnd: 300 })] })).beforeAsk).toBeNull();
  });
  it("summarizes what came before the asking: the usual last answer and the median wait after it", () => {
    const one = (endpoint: string, end: number, ask: number, task: number) => splitStartup(load({ api: [api({ path: endpoint, start: 10, responseEnd: end }), page({ start: ask, responseEnd: ask + 500 })], longTasks: [{ start: 100, ms: task, from: "" }] }));
    const s = summarize([one("/api/servers", 500, 600, 200), one("/api/servers", 700, 780, 220), one("/api/auth/me", 400, 900, 600)]);
    expect(s.beforeAskLongTaskMs).toBe(220);
    expect(s.lastAnswerBeforeAsk).toEqual({ endpoint: "/api/servers", loads: 2, askedAfterMs: 90 });
    expect(summarize([splitStartup(load({}))]).lastAnswerBeforeAsk).toBeNull();
  });
  it("takes as a request's preflight the one for its path sent nearest to the asking, before the request left", () => {
    const first = page({ start: 1426, requestStart: 1667, responseStart: 2000, responseEnd: 3908 });
    const mine = { path: "/api/messages/channel/:channel", at: 1428, ms: 230 };
    const others = [{ path: "/api/messages/channel/:channel", at: 1622, ms: 400 }, { path: "/api/messages/channel/:channel", at: 300, ms: 90 }, { path: "/api/messages/channel/:channel", at: 1800, ms: 80 }, { path: "/api/channels/:channel", at: 1427, ms: 60 }];
    expect(splitStartup(load({ api: [first], preflights: [...others, mine] })).messagesPreflightMs).toBe(230);
    // none in the window: sent long before the asking, or after the request had left
    expect(splitStartup(load({ api: [first], preflights: [others[1], others[2]] })).messagesPreflightMs).toBeNull();
    // the window's edges: 50 ms of slack before the asking (1426) and after the request left (1667), no more
    const at = (ms: number) => splitStartup(load({ api: [first], preflights: [{ path: "/api/messages/channel/:channel", at: ms, ms: 7 }] })).messagesPreflightMs;
    expect([at(1375), at(1377), at(1716), at(1718)]).toEqual([null, 7, 7, null]);
    // timing hidden by the browser (requestStart 0): the window runs to the answer's end instead of closing at once
    expect(splitStartup(load({ api: [page({ start: 1426, requestStart: 0, responseStart: 0, responseEnd: 3908 })], preflights: [mine] })).messagesPreflightMs).toBe(230);
  });
  it("gives no answer-to-paint gap when the messages were on screen before this answer ended, and says so", () => {
    const split = splitStartup(load({ api: [page({ start: 1426, responseEnd: 3908 }), page({ start: 1500, responseEnd: 2100 })], contentMs: 2103, firstRowMs: 2180, paintedMs: 2220 }));
    expect([split.responseToContentMs, split.responseToRowMs, split.responseToPaintMs]).toEqual([null, null, null]);
    expect(split.shownBeforeAnswer).toBe(true);
    // the page had the messages (2103) before this answer ended (2150) though the row came after it (2180): still not this answer's gap
    const late = splitStartup(load({ api: [page({ start: 1426, responseEnd: 2150 }), page({ start: 1500, responseEnd: 2100 })], longTasks: [{ start: 2155, ms: 60, from: "" }], contentMs: 2103, firstRowMs: 2180, paintedMs: 2220 }));
    expect([late.responseToContentMs, late.responseToRowMs, late.responseToPaintMs, late.longTaskMsInGap, late.shownBeforeAnswer]).toEqual([null, null, null, 0, true]);
    // without the page's own time the row decides
    expect(splitStartup(load({ api: [page({ start: 20, responseEnd: 900 })], firstRowMs: 1000, paintedMs: 1040 })).shownBeforeAnswer).toBe(false);
  });
  it("joins the DevTools clock to the page's at the document request", () => {
    // the document request left 12 ms after the page's time origin; an event 0.5 s later on the protocol's clock is at 512 ms on the page's
    expect(toPageClock(1000.5, { timestamp: 1000, wallTime: 1_700_000_000.012 }, 1_700_000_000_000)).toBe(512);
  });
  it("counts only what happened inside the window a load is read over", () => {
    const cut = withinWindow(load({ api: [api({ start: 100 }), api({ start: 9000 })], preflights: [{ path: "/api/x", at: 90, ms: 5 }, { path: "/api/x", at: 8990, ms: 5 }], longTasks: [{ start: 50, ms: 60, from: "" }, { start: 9100, ms: 60, from: "" }] }), 8000);
    expect([cut.api.length, cut.preflights.length, cut.longTasks.length]).toEqual([1, 1, 1]);
  });
  it("tells a race (asked again before the first answered) from a refetch (asked again after)", () => {
    const raced = splitStartup(load({ api: [page({ start: 1426, responseEnd: 3908, initiator: "xmlhttprequest" }), page({ start: 1621, responseEnd: 5290 })] }));
    expect(raced.secondFirstPage).toEqual({ kind: "race", start: 1621, decodedBytes: 300 });
    const again = splitStartup(load({ api: [page({ start: 935, responseEnd: 1702 }), page({ start: 2083, responseEnd: 2703, initiator: "xmlhttprequest" })] }));
    expect(again.secondFirstPage?.kind).toBe("refetch");
    // a later page of the same channel is not the first page asked twice, and neither is the page of a thread or of another channel
    expect(splitStartup(load({ api: [page({ start: 20, responseEnd: 500 }), page({ start: 4000, responseEnd: 4300, query: "?limit&before" })] })).secondFirstPage).toBeNull();
    const withThread = splitStartup(load({ api: [page({ start: 20, responseEnd: 500 }), page({ start: 4000, responseEnd: 4300, path: "/api/messages/channel/:id" })] }));
    expect(withThread.secondFirstPage).toBeNull();
    expect(withThread.repeated).toEqual([]);
  });
  it("names the script of the frame a long task falls in, by overlap, whatever order the two were reported in", () => {
    const frames = [{ start: 2380, ms: 90, script: "app-shell.js render" }, { start: 900, ms: 400, script: "vendor.js parse" }];
    expect(blameTasks([{ start: 1000, ms: 120 }, { start: 2374, ms: 85 }, { start: 5000, ms: 60 }], frames)).toEqual([
      { start: 1000, ms: 120, from: "vendor.js parse" },
      { start: 2374, ms: 85, from: "app-shell.js render" },
      { start: 5000, ms: 60, from: "" },
    ]);
  });
  it("lists the endpoints a load asked more than once, most repeated first", () => {
    const split = splitStartup(load({ api: [api({ path: "/api/servers" }), api({ path: "/api/servers" }), api({ path: "/api/servers/unread-summary" }), api({ path: "/api/servers/unread-summary" }), api({ path: "/api/servers/unread-summary" }), api({ path: "/api/agents" })] }));
    expect(split.repeated).toEqual([{ endpoint: "/api/servers/unread-summary", times: 3 }, { endpoint: "/api/servers", times: 2 }]);
  });
  it("a load without a message row counts every request as before it and has no gap", () => {
    const split = splitStartup(load({ api: [page({ start: 20, responseEnd: 500 }), api({ start: 700 })] }));
    expect(split.apiBeforeFirstRow).toBe(2);
    expect([split.responseToRowMs, split.responseToPaintMs, split.longTaskMsInGap]).toEqual([null, null, 0]);
  });
  it("takes medians over the loads that have a value, and counts the loads that have none", () => {
    expect(median([3, null, 1, undefined, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([null])).toBeNull();
    const a = splitStartup(load({ api: [page({ start: 20, requestStart: 21, responseStart: 500, responseEnd: 900 }), api({ path: "/api/servers" }), api({ path: "/api/servers" })], firstRowMs: 1000, paintedMs: 1040 }));
    const b = splitStartup(load({ api: [page({ start: 30, requestStart: 31, responseStart: 700, responseEnd: 1100 }), page({ start: 1200, responseEnd: 1500 })], firstRowMs: 1190, paintedMs: 1260 }));
    const c = splitStartup(load({ api: [api({ path: "/api/servers" }), api({ path: "/api/servers" })] }));
    const summary = summarize([a, b, c]);
    expect(summary).toMatchObject({ loads: 3, messagesStartMs: 25, firstByteMs: 574, downloadMs: 400, paintedMs: 1150, responseToPaintMs: 150, raced: 0, refetched: 1, withoutRow: 1, withFirstPage: 2, withTiming: 2, withContent: 0, shownBeforeAnswer: 0 });
    // repeated in two of the three loads: listed; the first page asked twice in one load only: not listed
    expect(summary.repeatedInHalfOrMore).toEqual([{ endpoint: "/api/servers", times: 2, loads: 2 }]);
  });
  it("names a repeated endpoint's usual count: the most frequent, the higher on a tie", () => {
    const asked = (times: number) => splitStartup(load({ api: Array.from({ length: times }, () => api({ path: "/api/servers/unread-summary" })) }));
    expect(summarize([asked(3), asked(2), asked(3), asked(1)]).repeatedInHalfOrMore).toEqual([{ endpoint: "/api/servers/unread-summary", times: 3, loads: 3 }]);
    expect(summarize([asked(2), asked(3)]).repeatedInHalfOrMore[0].times).toBe(3);
  });
  it("names an API URL without its ids and without the values of its query, and marks the opened channel", () => {
    const channel = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
    expect(endpointOf(`https://api.example/api/messages/channel/${channel}?limit=50&before=someone%40example.com`, channel)).toEqual({ path: "/api/messages/channel/:channel", query: "?limit&before" });
    expect(endpointOf("https://api.example/api/messages/channel/11111111-2222-3333-4444-555555555555?limit=3", channel)).toEqual({ path: "/api/messages/channel/:id", query: "?limit" });
    expect(endpointOf(`https://api.example/api/messages/sync?since_seq=5&channel_id=${channel.toUpperCase()}&channel_id=x`, channel).query).toBe("?since_seq&channel_id");
    expect(endpointOf("https://api.example/api/artifacts/pt_bd5c5b41-2fc3-4008-b9ed-8c3d5be24016/open").path).toBe("/api/artifacts/:id/open");
    expect(endpointOf("https://api.example/api/servers").query).toBe("");
  });
});
