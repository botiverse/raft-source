import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compare, measureDir, median, parseAllowances, summaryMarkdown } from "./heap-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const side = (node, runnerMB, liteMB, extra = {}) => ({
  node,
  runs: 3,
  bundles: {
    runner: { phase: "daemon", heapMB: runnerMB, samples: [runnerMB], zod: extra.runnerZod ?? 1011, sourceChars: 1 },
    lite: { phase: "cli", heapMB: liteMB, samples: [liteMB], zod: 199, sourceChars: 1 },
  },
  ...extra.fields,
});
const base = side("24.22.1", 45.3, 13.3, { fields: { release: "computer-v1.0.60", commit: "e3a6799f55aa", allowances: [] } });
const release = { baseRelease: "computer-v1.0.60" };
const allowance = (runnerMB, reason = "pi host loads at start") => ({ reason, runnerMB });

describe("heap-gate", () => {
  it("takes the median, so one noisy run cannot fail the check", () => {
    expect(median([45.2, 61.0, 45.4])).toBe(45.4);
    expect(median([45.2, 45.4])).toBe(45.3);
    expect(() => median([])).toThrow();
  });

  it("measures each bundle --runs times up to its own last phase", () => {
    const calls = [];
    const heaps = { "computer-bundle.cjs": [46, 45, 70], "computer-lite-bundle.cjs": [13, 14, 13] };
    const fake = (path, { phases }) => {
      const file = path.split("/").pop();
      calls.push([file, phases.map((p) => p.name).join(",")]);
      const heapMB = heaps[file].shift();
      return { phases: phases.map((p) => ({ phase: p.name, heapMB })), zod: { total: 7 }, source: { chars: 9 } };
    };
    const result = measureDir("/sea", 3, fake);
    expect(calls.filter(([f]) => f === "computer-bundle.cjs").every(([, p]) => p === "cli,daemon")).toBe(true);
    expect(calls.filter(([f]) => f === "computer-lite-bundle.cjs").every(([, p]) => p === "cli")).toBe(true);
    expect(calls).toHaveLength(6);
    expect(result.bundles.runner).toMatchObject({ phase: "daemon", heapMB: 46, samples: [46, 45, 70] });
    expect(result.bundles.lite).toMatchObject({ phase: "cli", heapMB: 13 });
    expect(() => measureDir("/sea", 0, fake)).toThrow(/--runs/);
  });

  it("allows 8 MB of runner growth and 3 MB of lite growth since the release", () => {
    expect(compare(side("24.22.1", 53.3, 16.3), base, release).ok).toBe(true);
    const runnerOver = compare(side("24.22.1", 53.4, 13.3), base, release);
    expect(runnerOver.ok).toBe(false);
    expect(runnerOver.rows.find((r) => r.name === "runner")).toMatchObject({ baseMB: 45.3, headMB: 53.4, deltaMB: 8.1, limitMB: 8, ok: false });
    const liteOver = compare(side("24.22.1", 45.3, 16.4), base, release);
    expect(liteOver.rows.find((r) => r.name === "lite")).toMatchObject({ deltaMB: 3.1, limitMB: 3, ok: false });
  });

  it("counts an allowance until the release contains it, however that release was cut", () => {
    const head = side("24.22.1", 60, 13.3);
    const entry = allowance(10);
    const c = compare(head, base, { ...release, allowances: [entry] });
    expect(c.ok).toBe(true);
    expect(c.rows[0]).toMatchObject({ allowanceMB: 10, limitMB: 18 });
    // A stable tag cut on a commit before the allowance landed still lacks it: it keeps counting.
    const cutBefore = { ...base, release: "computer-v1.0.61", allowances: [] };
    expect(compare(head, cutBefore, { baseRelease: "computer-v1.0.61", allowances: [entry] }).ok).toBe(true);
    // A release that contains the entry (key order aside) measured the increase: it stops counting.
    const contains = { ...side("24.22.1", 59, 13.3), release: "computer-v1.0.61", allowances: [{ runnerMB: 10, reason: entry.reason }] };
    const after = compare(head, contains, { baseRelease: "computer-v1.0.61", allowances: [entry] });
    expect(after.active).toEqual([]);
    expect(after.absorbed).toEqual([entry]);
    expect(after.rows[0]).toMatchObject({ allowanceMB: 0, limitMB: 8, ok: true });
  });

  it("refuses mismatched measurements", () => {
    expect(() => compare(side("24.23.0", 45, 13), base, release)).toThrow(/Node/);
    expect(() => compare(side("24.22.1", 45, 13), base, { baseRelease: "computer-v1.0.60-rc.1" })).toThrow(/stable tag/);
    expect(() => compare(side("24.22.1", 45, 13), base, { baseRelease: "computer-v1.0.59" })).toThrow(/computer-v1.0.60, not computer-v1.0.59/);
  });

  it("rejects allowances without a reason or with an invalid size", () => {
    expect(() => parseAllowances({})).toThrow();
    expect(() => parseAllowances({ allowances: ["x"] })).toThrow(/object/);
    expect(() => parseAllowances({ allowances: [{ runnerMB: 1, reason: " " }] })).toThrow(/reason/);
    expect(() => parseAllowances({ allowances: [{ runnerMB: -1, reason: "x" }] })).toThrow(/runnerMB/);
    expect(() => parseAllowances({ allowances: [{ liteMB: "2", reason: "x" }] })).toThrow(/liteMB/);
    expect(parseAllowances({ allowances: [allowance(4)] })).toHaveLength(1);
  });

  it("ships an allowance file the check accepts", () => {
    const json = JSON.parse(readFileSync(join(HERE, "heap-allowance.json"), "utf8"));
    expect(() => parseAllowances(json)).not.toThrow();
  });

  it("writes both sides, the change and the active allowance into the summary", () => {
    const c = compare(side("24.22.1", 70, 13.3, { runnerZod: 1300 }), base, { ...release, allowances: [allowance(10)] });
    const md = summaryMarkdown(c);
    expect(md).toContain("### Computer bundle heap vs computer-v1.0.60 (e3a6799f55), Node 24.22.1");
    expect(md).toContain("cumulative over everything merged since computer-v1.0.60");
    expect(md).toContain("| runner (to daemon) | 45.3 MB | 70 MB | +24.7 MB | +18 MB (incl. 10 allowed) | +289 | **over** |");
    expect(md).toContain("Allowance in effect: pi host loads at start");
    expect(md).toContain("adds an entry to packages/computer/scripts/native/heap-allowance.json");
  });
});
