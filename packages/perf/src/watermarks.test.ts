import { describe, expect, it } from "vitest";
import { checkWatermarks, parseWatermarkFile, readValues } from "./watermarks";

const file = { marks: { scroll_slow_frame_pct: { max: 30 }, channel_switch_ms: { max: 800 } } };

describe("checkWatermarks", () => {
  it("passes at or under the line", () => {
    expect(checkWatermarks({ scroll_slow_frame_pct: 30, channel_switch_ms: 400 }, file)).toMatchObject({ ok: true, checked: 2, breaches: [], missing: [] });
  });
  it("reports each metric over its line and by how much", () => {
    const r = checkWatermarks({ scroll_slow_frame_pct: 41.5, channel_switch_ms: 400 }, file);
    expect(r.ok).toBe(false);
    expect(r.breaches).toEqual([{ metric: "scroll_slow_frame_pct", value: 41.5, max: 30, overBy: 11.5 }]);
  });
  it("a watermarked metric with no value fails: not measured is not a pass", () => {
    const r = checkWatermarks({ scroll_slow_frame_pct: 10, channel_switch_ms: null }, file);
    expect(r).toMatchObject({ ok: false, missing: ["channel_switch_ms"] });
  });
  it("no watermarks at all is not ok", () => {
    expect(checkWatermarks({ a: 1 }, { marks: {} }).ok).toBe(false);
  });
});

describe("checkWatermarks: the page the lines were set on", () => {
  const paged = { page: { server: "qa", channel: "busy" }, marks: { channel_switch_ms: { max: 350 } } };
  it("holds the lines against values of the same page; the values may name more than the lines do", () => {
    expect(checkWatermarks({ channel_switch_ms: 375 }, paged, { server: "qa", channel: "busy", other: "all" })).toMatchObject({ ok: false, checked: 1, pageMatch: "same", pageDiffers: [], breaches: [{ metric: "channel_switch_ms", overBy: 25 }] });
    expect(checkWatermarks({ channel_switch_ms: 300 }, paged, { server: "qa", channel: "busy" })).toMatchObject({ ok: true, pageMatch: "same" });
  });
  it("values of another page neither pass nor fail: nothing is checked, and it is not ok", () => {
    // under the line, and still not a pass
    expect(checkWatermarks({ channel_switch_ms: 100 }, paged, { server: "qa", channel: "small" })).toEqual({ ok: false, checked: 0, breaches: [], missing: [], pageMatch: "different", pageDiffers: [{ key: "channel", lines: "busy", values: "small" }] });
    // over the line, and not a breach
    expect(checkWatermarks({ channel_switch_ms: 900 }, paged, { channel: "busy" })).toMatchObject({ ok: false, breaches: [], pageMatch: "different", pageDiffers: [{ key: "server", lines: "qa", values: null }] });
    // a value of another type is reported as it is
    expect(checkWatermarks({ channel_switch_ms: 100 }, paged, { server: "qa", channel: 7 }).pageDiffers).toEqual([{ key: "channel", lines: "busy", values: 7 }]);
  });
  it("without a page on either side the lines are held as before, and the result says the page is unknown", () => {
    expect(checkWatermarks({ channel_switch_ms: 300 }, paged)).toMatchObject({ ok: true, checked: 1, pageMatch: "unknown" });
    expect(checkWatermarks({ channel_switch_ms: 300, scroll_slow_frame_pct: 20 }, file, { server: "qa", channel: "busy" })).toMatchObject({ ok: true, pageMatch: "unknown" });
  });
});

describe("readValues", () => {
  it("a report gives its metrics and its page", () => {
    expect(readValues({ tool: "raft-perf interact", page: { server: "qa", channel: "busy" }, metrics: { channel_switch_ms: 300 } })).toEqual({ values: { channel_switch_ms: 300 }, page: { server: "qa", channel: "busy" } });
  });
  it("a flat object of values may carry a page too, and it is compared: it cannot pass as 'no page'", () => {
    const read = readValues({ page: { server: "x", channel: "y" }, channel_switch_ms: 300 });
    expect(read).toEqual({ values: { channel_switch_ms: 300 }, page: { server: "x", channel: "y" } });
    expect(checkWatermarks(read.values, { page: { server: "qa", channel: "busy" }, marks: { channel_switch_ms: { max: 350 } } }, read.page)).toMatchObject({ ok: false, pageMatch: "different" });
  });
  it("no page, or a page that is not an object, is no page; values that are not an object are refused", () => {
    expect(readValues({ channel_switch_ms: 300 }).page).toBeNull();
    expect(readValues({ page: "wa-main", metrics: { a: 1 } })).toEqual({ values: { a: 1 }, page: null });
    expect(() => readValues([1])).toThrow(/not a JSON object/);
    expect(() => readValues(null)).toThrow(/not a JSON object/);
  });
});

describe("parseWatermarkFile", () => {
  it("reads the page the lines were set on, and refuses one that names nothing", () => {
    expect(parseWatermarkFile({ page: { server: "qa", channel: "busy" }, marks: { a: { max: 1 } } }).page).toEqual({ server: "qa", channel: "busy" });
    expect(() => parseWatermarkFile({ page: {}, marks: { a: { max: 1 } } })).toThrow(/"page" must be/);
    expect(() => parseWatermarkFile({ page: { channel: 7 }, marks: { a: { max: 1 } } })).toThrow(/"page" must be/);
    expect(() => parseWatermarkFile({ page: "busy", marks: { a: { max: 1 } } })).toThrow(/"page" must be/);
    expect(() => parseWatermarkFile({ page: { channel: " " }, marks: { a: { max: 1 } } })).toThrow(/"page" must be/);
    expect(() => parseWatermarkFile({ page: null, marks: { a: { max: 1 } } })).toThrow(/"page" must be/);
    expect(() => parseWatermarkFile({ page: ["busy"], marks: { a: { max: 1 } } })).toThrow(/"page" must be/);
  });
  it("accepts numeric lines", () => {
    expect(parseWatermarkFile({ runner: "r", marks: { a_ms: { max: 5, note: "n" } } })).toEqual({ runner: "r", marks: { a_ms: { max: 5, note: "n" } } });
  });
  it("refuses a mark whose max is missing, mistyped or not a number: it would never be crossed", () => {
    expect(() => parseWatermarkFile({ marks: { a: { Max: 25 } } })).toThrow(/numeric "max"/);
    expect(() => parseWatermarkFile({ marks: { a: { max: "160ms" } } })).toThrow(/numeric "max"/);
    expect(() => parseWatermarkFile({ marks: { a: null } })).toThrow(/numeric "max"/);
    expect(() => parseWatermarkFile({})).toThrow(/no "marks"/);
  });
});
