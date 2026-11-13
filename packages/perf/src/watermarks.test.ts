import { describe, expect, it } from "vitest";
import { checkWatermarks, parseWatermarkFile } from "./watermarks";

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

describe("parseWatermarkFile", () => {
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
