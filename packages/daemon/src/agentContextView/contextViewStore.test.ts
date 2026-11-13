import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentContextDir,
  appendContextViewIndexLine,
  clearContextViewOff,
  compactContextViewIndex,
  contextViewServerDir,
  findContextViewIndexLine,
  hasContextViewData,
  listContextViewAgents,
  markContextViewOff,
  readContextViewIndex,
  readContextViewOffSince,
  removeContextViewData,
  type ContextViewIndexLine,
  type ContextViewServerDir,
} from "./contextViewStore";

let raftHome: string;
let dir: ContextViewServerDir;

beforeEach(() => {
  raftHome = mkdtempSync(path.join(os.tmpdir(), "ctxview-store-"));
  dir = contextViewServerDir(raftHome, "srv_A-1")!;
});

afterEach(() => {
  rmSync(raftHome, { recursive: true, force: true });
});

function line(messageId: string, sentAt: string): ContextViewIndexLine {
  return { messageId, sentAt, runtime: "claude", sessionId: "s1", transcript: "proj/s1.jsonl", offset: 123 };
}

describe("context view store", () => {
  it("appends lines under <raftHome>/agent-context/<serverId>/<encoded id>, 0700 / 0600", () => {
    appendContextViewIndexLine(dir, "agent/1", line("m1", "2026-11-01T00:00:00.000Z"));
    appendContextViewIndexLine(dir, "agent/1", line("m2", "2026-11-02T00:00:00.000Z"));
    const agentDir = agentContextDir(dir, "agent/1");
    expect(agentDir).toBe(path.join(raftHome, "agent-context", "srv_A-1", "agent%2F1"));
    for (const made of [path.join(raftHome, "agent-context"), dir, agentDir]) expect(statSync(made).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(agentDir, "index.jsonl")).mode & 0o777).toBe(0o600);
    expect(readContextViewIndex(dir, "agent/1").map((l) => l.messageId)).toEqual(["m1", "m2"]);
    expect(findContextViewIndexLine(dir, "agent/1", "m2")?.sentAt).toBe("2026-11-02T00:00:00.000Z");
    expect(findContextViewIndexLine(dir, "agent/1", "m3")).toBeNull();
    expect(listContextViewAgents(dir)).toEqual(["agent/1"]);
    expect(() => agentContextDir(dir, "..")).toThrow();
  });

  it("skips a torn line and keeps the first line of a message indexed twice", () => {
    appendContextViewIndexLine(dir, "a", { ...line("m1", "2026-11-01T00:00:00.000Z"), offset: 1 });
    appendFileSync(path.join(agentContextDir(dir, "a"), "index.jsonl"), "{\"messageId\":\"m");
    appendFileSync(path.join(agentContextDir(dir, "a"), "index.jsonl"), "\n");
    appendContextViewIndexLine(dir, "a", { ...line("m1", "2026-11-01T00:00:01.000Z"), offset: 2 });
    expect(readContextViewIndex(dir, "a")).toHaveLength(2);
    expect(findContextViewIndexLine(dir, "a", "m1")?.offset).toBe(1);
  });

  it("never writes or reads through a link", () => {
    const outside = path.join(raftHome, "outside.txt");
    writeFileSync(outside, "keep");
    mkdirSync(agentContextDir(dir, "a"), { recursive: true });
    symlinkSync(outside, path.join(agentContextDir(dir, "a"), "index.jsonl"));
    expect(() => appendContextViewIndexLine(dir, "a", line("m1", "2026-11-01T00:00:00.000Z"))).toThrow();
    expect(() => readContextViewIndex(dir, "a")).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("keep");

    mkdirSync(path.join(raftHome, "elsewhere"));
    symlinkSync(path.join(raftHome, "elsewhere"), agentContextDir(dir, "b"));
    expect(() => appendContextViewIndexLine(dir, "b", line("m1", "2026-11-01T00:00:00.000Z"))).toThrow();
    expect(listContextViewAgents(dir)).toEqual(["a"]);
  });

  it("drops lines older than the retention cutoff and removes an empty index", () => {
    appendContextViewIndexLine(dir, "a", line("old", "2026-10-01T00:00:00.000Z"));
    appendContextViewIndexLine(dir, "a", line("new", "2026-11-03T00:00:00.000Z"));
    expect(compactContextViewIndex(dir, "a", Date.parse("2026-11-01T00:00:00.000Z")))
      .toEqual({ kept: 1, dropped: 1, oldestSentAt: "2026-11-03T00:00:00.000Z" });
    expect(readContextViewIndex(dir, "a").map((l) => l.messageId)).toEqual(["new"]);
    expect(statSync(path.join(agentContextDir(dir, "a"), "index.jsonl")).mode & 0o777).toBe(0o600);
    expect(compactContextViewIndex(dir, "a", Date.parse("2026-12-01T00:00:00.000Z")))
      .toEqual({ kept: 0, dropped: 1, oldestSentAt: null });
    expect(readContextViewIndex(dir, "a")).toEqual([]);
  });

  it("marks off once (the first time seen off counts) and clears the mark", () => {
    expect(markContextViewOff(dir, "a", 1_000)).toBe(false); // no data: nothing to mark
    appendContextViewIndexLine(dir, "a", line("m", "2026-11-01T00:00:00.000Z"));
    expect(markContextViewOff(dir, "a", Date.parse("2026-11-04T00:00:00.000Z"))).toBe(true);
    expect(markContextViewOff(dir, "a", Date.parse("2026-11-04T05:00:00.000Z"))).toBe(false);
    expect(readContextViewOffSince(dir, "a")).toBe(Date.parse("2026-11-04T00:00:00.000Z"));
    expect(clearContextViewOff(dir, "a")).toBe(true);
    expect(readContextViewOffSince(dir, "a")).toBeNull();
  });

  it("keeps each server's agents apart and takes only a server id that is one path segment", () => {
    const other = contextViewServerDir(raftHome, "srv_B")!;
    appendContextViewIndexLine(dir, "a1", line("m1", "2026-11-01T00:00:00.000Z"));
    appendContextViewIndexLine(other, "b1", line("m2", "2026-11-01T00:00:00.000Z"));
    expect(listContextViewAgents(dir)).toEqual(["a1"]);
    expect(listContextViewAgents(other)).toEqual(["b1"]);
    expect(hasContextViewData(other, "a1")).toBe(false);
    expect(markContextViewOff(other, "a1", 1_000)).toBe(false);
    expect(readContextViewOffSince(dir, "a1")).toBeNull();
    // Nothing in the old flat layout.
    expect(readdirSync(path.join(raftHome, "agent-context")).sort()).toEqual(["srv_A-1", "srv_B"]);

    for (const bad of ["", ".", "..", "a/b", "../x", "a b", "srv%2F", "x".repeat(129), null, undefined]) {
      expect(contextViewServerDir(raftHome, bad)).toBeNull();
    }
    expect(contextViewServerDir(raftHome, "x".repeat(128))).not.toBeNull();
  });

  it("does nothing through a linked server directory", () => {
    const elsewhere = path.join(raftHome, "elsewhere");
    mkdirSync(path.join(elsewhere, "a1"), { recursive: true });
    writeFileSync(path.join(elsewhere, "a1", "index.jsonl"), `${JSON.stringify(line("m1", "2026-11-01T00:00:00.000Z"))}\n`);
    mkdirSync(path.join(raftHome, "agent-context"));
    symlinkSync(elsewhere, dir);
    expect(listContextViewAgents(dir)).toEqual([]);
    expect(hasContextViewData(dir, "a1")).toBe(false);
    expect(markContextViewOff(dir, "a1", 1_000)).toBe(false);
    expect(() => appendContextViewIndexLine(dir, "a1", line("m2", "2026-11-01T00:00:00.000Z"))).toThrow();
    removeContextViewData(dir, "a1");
    expect(readFileSync(path.join(elsewhere, "a1", "index.jsonl"), "utf8")).toContain("m1");
  });
});
