import { describe, expect, it } from "vitest";
import { Fragment, createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl } from "react-intl";
import type { AgentMigrationLogEntry } from "@botiverse/raft-shared";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import {
  CLOUD_NODE, EMPTY_FILTERS, buildNodes, computerCodes, filterEntries, filtersFromSearch, journey, routeCells, searchFromFilters, stats,
  initiatedBy, withInitiator,
} from "../src/components/agentMigration/log/model";

const entry = (over: Partial<AgentMigrationLogEntry>): AgentMigrationLogEntry => ({
  migrationRef: "mig_x",
  agentId: "kirby",
  sourceMachineId: "m-a",
  sourceMachineName: "armbian-1",
  targetKind: "computer",
  targetMachineId: "m-b",
  targetMachineName: "hetzner-ex63-3",
  initiatedBy: null,
  outcome: "completed",
  startedAt: "2026-10-20T10:00:00.000Z",
  endedAt: "2026-10-20T10:10:00.000Z",
  bytes: null,
  files: null,
  failureKind: null,
  failureCode: null,
  ...over,
});

describe("computerCodes", () => {
  it("reads like airport codes and keeps a trailing number", () => {
    const codes = computerCodes([
      { id: "1", name: "hetzner-ex63-3" },
      { id: "2", name: "armbian-1" },
      { id: "3", name: "Alices-MacBook-Air.local" },
      { id: "4", name: "mesa" },
    ]);
    expect(codes.get("1")).toBe("HE3");
    expect(codes.get("2")).toBe("AR1");
    expect(codes.get("3")).toBe("AMA");
    expect(codes.get("4")).toBe("MES");
  });

  it("stays unique when two names give the same code, using letters", () => {
    const codes = computerCodes([{ id: "a", name: "Studio Mac Air" }, { id: "b", name: "Studio Mini Air" }]);
    expect(new Set(codes.values()).size).toBe(2);
    for (const c of codes.values()) expect(c).toMatch(/^[A-Z0-9]{3}$/);
  });
});

describe("buildNodes", () => {
  it("names a computer by its current name, groups by host, and adds the cloud", () => {
    const nodes = buildNodes(
      [entry({}), entry({ targetKind: "hosted", targetMachineId: null, targetMachineName: null })],
      [{ id: "m-a", name: "armbian-one", deviceClass: "sbc" }, { id: "m-b", name: "hetzner-ex63-3", hostProvider: "Hetzner" }],
    );
    expect(nodes.find((n) => n.id === "m-a")).toMatchObject({ name: "armbian-one", group: "sbc", known: true });
    expect(nodes.find((n) => n.id === "m-b")).toMatchObject({ group: "hetzner" });
    expect(nodes.at(-1)).toMatchObject({ id: CLOUD_NODE, group: "cloud" });
  });

  it("keeps a deleted computer under the name it last moved an agent with", () => {
    const nodes = buildNodes([entry({ targetMachineName: "old-box" })], [{ id: "m-a", name: "armbian-1" }]);
    expect(nodes.find((n) => n.id === "m-b")).toMatchObject({ name: "old-box", group: "removed", known: false });
  });

  it("includes a current computer that never moved an agent", () => {
    const nodes = buildNodes([entry({})], [{ id: "m-a", name: "armbian-1" }, { id: "m-b", name: "hetzner-ex63-3" }, { id: "m-z", name: "quiet-box" }]);
    expect(nodes.find((n) => n.id === "m-z")).toMatchObject({ name: "quiet-box", known: true });
    expect(nodes.find((n) => n.id === "m-z")?.code).toMatch(/^[A-Z0-9]{3}$/);
    expect(buildNodes([], [{ id: "m-z", name: "quiet-box" }]).map((n) => n.id)).toEqual(["m-z"]);
  });
});

describe("filters", () => {
  const all = [
    entry({ migrationRef: "1", agentId: "kirby", outcome: "failed", failureKind: "too_large" }),
    entry({ migrationRef: "2", agentId: "kirby", startedAt: "2026-10-01T00:00:00.000Z" }),
    entry({ migrationRef: "3", agentId: "scout", sourceMachineId: "m-c", targetMachineId: "m-d", outcome: "canceled" }),
  ];
  const now = Date.parse("2026-10-28T00:00:00.000Z");

  it("matches agents, a computer on either end, results and the time window", () => {
    expect(filterEntries(all, { ...EMPTY_FILTERS, agents: ["kirby"] }, now).map((e) => e.migrationRef)).toEqual(["1", "2"]);
    expect(filterEntries(all, { ...EMPTY_FILTERS, computers: ["m-b"] }, now).map((e) => e.migrationRef)).toEqual(["1", "2"]);
    expect(filterEntries(all, { ...EMPTY_FILTERS, outcomes: ["failed", "canceled"] }, now).map((e) => e.migrationRef)).toEqual(["1", "3"]);
    expect(filterEntries(all, { ...EMPTY_FILTERS, days: 14 }, now).map((e) => e.migrationRef)).toEqual(["1", "3"]);
  });

  it("reads from and to as the direction of a move, together with the other filters", () => {
    const moves = [
      entry({ migrationRef: "ab", sourceMachineId: "m-a", targetMachineId: "m-b" }),
      entry({ migrationRef: "ba", sourceMachineId: "m-b", targetMachineId: "m-a" }),
      entry({ migrationRef: "ac", sourceMachineId: "m-a", targetKind: "hosted", targetMachineId: null }),
      entry({ migrationRef: "cb", sourceMachineId: "m-c", targetMachineId: "m-b", agentId: "scout" }),
    ];
    const refs = (f: Partial<typeof EMPTY_FILTERS>) => filterEntries(moves, { ...EMPTY_FILTERS, ...f }, now).map((e) => e.migrationRef);
    expect(refs({ from: ["m-a"] })).toEqual(["ab", "ac"]);
    expect(refs({ to: ["m-b"] })).toEqual(["ab", "cb"]);
    expect(refs({ to: [CLOUD_NODE] })).toEqual(["ac"]);
    // A route is one direction only; the reverse is its own filter.
    expect(refs({ from: ["m-a"], to: ["m-b"] })).toEqual(["ab"]);
    expect(refs({ from: ["m-b"], to: ["m-a"] })).toEqual(["ba"]);
    // AND with the other filters.
    expect(refs({ to: ["m-b"], agents: ["scout"] })).toEqual(["cb"]);
    expect(refs({ from: ["m-a"], computers: ["m-c"] })).toEqual([]);
  });

  it("round-trips through the address so a filtered view can be shared", () => {
    const f = { agents: ["kirby", "scout"], computers: ["m-b"], from: ["m-a"], to: ["m-b", CLOUD_NODE], outcomes: ["failed" as const], days: 30 };
    expect(filtersFromSearch(searchFromFilters(f))).toEqual(f);
    expect(searchFromFilters(f).get("to")).toBe(`m-b,${CLOUD_NODE}`);
    expect(filtersFromSearch(new URLSearchParams("outcome=bogus&days=-3"))).toEqual(EMPTY_FILTERS);
  });
});

describe("routes, journeys and stats", () => {
  const path = [
    entry({ migrationRef: "1", sourceMachineId: "a", targetMachineId: "b" }),
    entry({ migrationRef: "2", sourceMachineId: "b", targetMachineId: "c", outcome: "failed" }),
    entry({ migrationRef: "3", sourceMachineId: "b", targetMachineId: "c", outcome: "canceled" }),
    entry({ migrationRef: "4", sourceMachineId: "b", targetMachineId: "c" }),
    entry({ migrationRef: "5", sourceMachineId: "c", targetMachineId: "d", outcome: "failed" }),
  ];

  it("counts successes and failures per route, leaving cancels out", () => {
    expect(routeCells(path)).toEqual([
      { src: "a", dst: "b", ok: 1, failed: 0 },
      { src: "b", dst: "c", ok: 1, failed: 1 },
      { src: "c", dst: "d", ok: 0, failed: 1 },
    ]);
  });

  it("folds failed tries into the move they led to and keeps the ones after the last move", () => {
    const j = journey(path, "kirby");
    expect(j.start).toBe("a");
    expect(j.legs.map((l) => [l.entry.migrationRef, l.tries.map((t) => t.migrationRef)])).toEqual([["1", []], ["4", ["2", "3"]]]);
    expect(j.pending.map((t) => t.migrationRef)).toEqual(["5"]);
  });

  it("excludes cancels from the success rate", () => {
    expect(stats(path)).toEqual({ total: 5, successRate: 50, agents: 1, computers: 4 });
    expect(stats([]).successRate).toBeNull();
  });
});

describe("who started a move", () => {
  const t = createIntl({ locale: "en", messages: en }).formatMessage;
  const kirby = { id: "u-kirby", name: "kirby", displayName: "WA kirby" };
  const remy = { id: "u-remy", name: "remy", displayName: null };

  it("follows a row's route with the person's display name, else their handle", () => {
    expect(withInitiator(t, "CMA → ODM", entry({ initiatedBy: kirby }))).toBe("CMA → ODM · Initiated by WA kirby");
    expect(withInitiator(t, "CMA → ODM · Workspace too large", entry({ initiatedBy: remy }))).toBe("CMA → ODM · Workspace too large · Initiated by remy");
  });

  it("names someone no longer on the server instead of leaving it out", () => {
    expect(withInitiator(t, "CMA → AR1", entry({ initiatedBy: null }))).toBe("CMA → AR1 · Initiated by a member no longer on this server");
  });

  it("names each record's own initiator, so moves on one route can differ", () => {
    const moves = [entry({ initiatedBy: kirby }), entry({ initiatedBy: null }), entry({ initiatedBy: remy })];
    expect(moves.map((e) => withInitiator(t, "CMA → ODM", e))).toEqual([
      "CMA → ODM · Initiated by WA kirby",
      "CMA → ODM · Initiated by a member no longer on this server",
      "CMA → ODM · Initiated by remy",
    ]);
  });

  it("names who started a computer's most recent move on a line of its own", () => {
    expect(initiatedBy(t, entry({ initiatedBy: kirby }))).toBe("Initiated by WA kirby");
    expect(initiatedBy(t, entry({ initiatedBy: null }))).toBe("Initiated by a member no longer on this server");
    expect(initiatedBy(createIntl({ locale: "zh-cn", messages: zhCn }).formatMessage, entry({ initiatedBy: kirby }))).toBe("由 WA kirby 发起");
  });

  it("hands only a present person's name to the renderer (the page links it); a former member stays the plain string", () => {
    const seen: string[] = [];
    const render = (person: { id: string }, label: string) => { seen.push(`${person.id}:${label}`); return createElement("a", null, label); };
    const html = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node));
    expect(html(withInitiator(t, "CMA → ODM", entry({ initiatedBy: kirby }), render))).toBe("CMA → ODM · Initiated by <a>WA kirby</a>");
    expect(html(initiatedBy(t, entry({ initiatedBy: remy }), render))).toBe("Initiated by <a>remy</a>");
    expect(initiatedBy(t, entry({ initiatedBy: null }), render)).toBe("Initiated by a member no longer on this server");
    expect(seen).toEqual(["u-kirby:WA kirby", "u-remy:remy"]);
  });

  it("is translated", () => {
    const zh = createIntl({ locale: "zh-cn", messages: zhCn }).formatMessage;
    expect(withInitiator(zh, "CMA → AR1", entry({ initiatedBy: null }))).toBe("CMA → AR1 · 由 已不在此服务器的成员 发起");
  });
});
