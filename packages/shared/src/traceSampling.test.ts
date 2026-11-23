import { describe, expect, it } from "vitest";
import { parseTraceSampleRate, resolveTraceSampleRate, traceSampleKeys, traceSampled } from "./traceSampling";

const missing = (key: string) => ({ key, enabled: false, reason: "missing_flag" });

describe("trace sampling", () => {
  it("lists the keys for a trace, most specific first", () => {
    expect(traceSampleKeys("mobile.thread_open")).toEqual([
      "trace_sample.mobile.thread_open",
      "trace_sample.mobile",
      "trace_sample",
    ]);
  });

  it("reads rates and refuses anything that is not one", () => {
    expect(parseTraceSampleRate("0.1")).toBe(0.1);
    expect(parseTraceSampleRate(" 1 ")).toBe(1);
    expect(parseTraceSampleRate("0")).toBe(0);
    for (const bad of ["1.5", "-0.1", "0.l", "", "10%", "NaN", "1e-1", undefined, null]) {
      expect(parseTraceSampleRate(bad)).toBeNull();
    }
  });

  it("lets the most specific configured key decide", () => {
    const evaluations = [
      missing("trace_sample.mobile.thread_open"),
      { key: "trace_sample.mobile", enabled: true, reason: "platform_rule", variant: "0.25" },
      { key: "trace_sample", enabled: true, reason: "default", variant: "1" },
    ];
    expect(resolveTraceSampleRate("mobile.thread_open", evaluations, 0.5)).toBe(0.25);
  });

  it("maps off to 0, on without a variant to 1, and nothing configured to the client default", () => {
    expect(resolveTraceSampleRate("web.x", [{ key: "trace_sample.web.x", enabled: false, reason: "flag_disabled" }], 0.5)).toBe(0);
    expect(resolveTraceSampleRate("web.x", [{ key: "trace_sample.web.x", enabled: false, reason: "kill_switch" }], 0.5)).toBe(0);
    expect(resolveTraceSampleRate("web.x", [{ key: "trace_sample.web.x", enabled: true, reason: "default" }], 0.5)).toBe(1);
    expect(resolveTraceSampleRate("web.x", [missing("trace_sample.web.x"), missing("trace_sample.web")], 0.5)).toBe(0.5);
    expect(resolveTraceSampleRate("web.x", [], 0.05)).toBe(0.05);
  });

  it("falls back to the client default when the deciding variant is not a rate", () => {
    expect(resolveTraceSampleRate("web.x", [{ key: "trace_sample.web.x", enabled: true, reason: "default", variant: "0.l" }], 0.05)).toBe(0.05);
  });

  it("samples whole units by rate", () => {
    expect(traceSampled(0, () => 0)).toBe(false);
    expect(traceSampled(1, () => 0.99)).toBe(true);
    expect(traceSampled(0.1, () => 0.05)).toBe(true);
    expect(traceSampled(0.1, () => 0.5)).toBe(false);
  });
});
