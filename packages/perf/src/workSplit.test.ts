import { describe, expect, it } from "vitest";
import { type TraceEvent, workSplit } from "./workSplit";

const MAIN = { pid: 7, tid: 1 };
/** One complete event on the main thread; times in ms from the trace start. */
const x = (name: string, atMs: number, durMs: number, more: Partial<TraceEvent> = {}): TraceEvent => ({ name, ph: "X", ...MAIN, ts: atMs * 1000, dur: durMs * 1000, ...more });
const click = (atMs: number) => x("EventDispatch", atMs, 1, { args: { data: { type: "click" } } });
const style = (atMs: number, durMs: number, elements: number, more: Partial<TraceEvent> = {}) => x("UpdateLayoutTree", atMs, durMs, { args: { elementCount: elements }, ...more });

describe("workSplit", () => {
  it("splits the window after the click into script, style and layout, and lists the large style passes", () => {
    const split = workSplit(
      [
        x("RunTask", 90, 5), // before the click: not counted
        click(100),
        x("RunTask", 100, 150),
        x("FunctionCall", 105, 60),
        x("FunctionCall", 110, 20), // called from the one above: the same script
        style(170, 30, 4742),
        x("Layout", 200, 40),
        x("RunTask", 900, 22),
        style(900, 20, 1168),
        style(1000, 1, 12),
      ],
      3000,
    );
    expect(split).toEqual({ windowMs: 3000, recordedMs: 901, taskMs: 172, scriptMs: 61, styleMs: 51, layoutMs: 40, forcedMs: 0, stylePasses: 3, styleElements: 5922, layouts: 1, largeStylePasses: [{ atMs: 70, ms: 30, elements: 4742 }, { atMs: 800, ms: 20, elements: 1168 }] });
  });

  it("style and layout forced from inside script are taken out of script and reported as forced", () => {
    const split = workSplit([click(0), x("FunctionCall", 10, 100), style(20, 15, 300), x("Layout", 35, 25), x("Layout", 200, 10)], 1000)!;
    // 100 ms of function and the click's own 1 ms of dispatch, less the 40 ms forced inside
    expect(split).toMatchObject({ scriptMs: 61, styleMs: 15, layoutMs: 35, forcedMs: 40 });
  });

  it("counts the task that dispatched the click from the click on, and a task inside a task once", () => {
    const split = workSplit([x("RunTask", 90, 160), click(100), x("RunTask", 120, 30), x("FunctionCall", 95, 105)], 1000)!;
    expect(split).toMatchObject({ taskMs: 150, scriptMs: 100 });
  });

  it("script is every entry into JavaScript: the microtask queue, an event's listeners, a timer, a response handler", () => {
    const split = workSplit([click(0), x("RunMicrotasks", 10, 200), x("FunctionCall", 20, 50), style(100, 30, 500), x("TimerFire", 300, 10), x("XHRLoad", 400, 20), x("FunctionCall", 405, 5)], 1000)!;
    // the click's own dispatch (1 ms) is script too
    expect(split).toMatchObject({ scriptMs: 201, styleMs: 30, forcedMs: 30 });
  });

  it("a style pass that only partly overlaps script is not forced by it", () => {
    expect(workSplit([click(0), x("FunctionCall", 10, 20), style(25, 20, 10)], 1000)).toMatchObject({ scriptMs: 21, styleMs: 20, forcedMs: 0 });
  });

  it("says how much of the window was recorded, from the last event of any thread", () => {
    expect(workSplit([click(0), x("RunTask", 10, 5), x("Other", 2400, 100, { pid: 9, tid: 3 })], 3000)!.recordedMs).toBe(2500);
    expect(workSplit([click(0), x("Other", 2990, 100, { pid: 9, tid: 3 })], 3000)!.recordedMs).toBe(3000);
  });

  it("counts only the click's thread, and an event that crosses the end of the window up to the end", () => {
    const split = workSplit([click(0), style(50, 10, 200, { tid: 2 }), style(70, 10, 200, { pid: 8 }), x("FunctionCall", 950, 200), x("Layout", 1000, 5)], 1000)!;
    expect(split).toMatchObject({ scriptMs: 51, styleMs: 0, stylePasses: 0, layoutMs: 0, layouts: 0 });
  });

  it("reads the style pass under either of Chrome's names, and starts at the first click", () => {
    const split = workSplit([click(500), click(100), x("RecalcStyle", 150, 8, { args: { elementCount: 150 } })], 1000)!;
    expect(split.largeStylePasses).toEqual([{ atMs: 50, ms: 8, elements: 150 }]);
  });

  it("starts at the press that became the click: work done on pointer down counts", () => {
    const press = (atMs: number, more: Partial<TraceEvent> = {}) => x("EventDispatch", atMs, 2, { args: { data: { type: "pointerdown" } }, ...more });
    // an earlier press (of another click), the press of this click with a style pass behind it, a press on another thread
    const split = workSplit([press(10), style(15, 5, 900), press(480), style(485, 10, 1163), press(495, { tid: 2 }), click(500), style(600, 30, 4742)], 1000)!;
    expect(split.largeStylePasses).toEqual([{ atMs: 5, ms: 10, elements: 1163 }, { atMs: 120, ms: 30, elements: 4742 }]);
    // without a press in the second before the click, the click starts the window
    expect(workSplit([press(100), style(105, 10, 1163), click(1200), style(1300, 30, 4742)], 1000)!.largeStylePasses).toEqual([{ atMs: 100, ms: 30, elements: 4742 }]);
  });

  it("is null without a click in the trace", () => {
    expect(workSplit([x("RunTask", 0, 10), x("EventDispatch", 5, 1, { args: { data: { type: "pointerdown" } } })], 1000)).toBeNull();
  });
});
