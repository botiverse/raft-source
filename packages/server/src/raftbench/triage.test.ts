import { describe, expect, test } from "vitest";
import { estimateTokens, packTriageBatches, parseTriageOutput, type TriageThread } from "./triage";

const id = (n: number, prefix = "a") => `${prefix.repeat(1)}${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = new Date("2026-07-20T09:05:00Z");
const thread = (target: string, count: number, start: number, content = "Synthetic triage text"): TriageThread => ({ target,
  messages: Array.from({ length: count }, (_, i) => ({ id: id(start + i), createdAt: at, sender: i % 2 ? "SyntheticAgent" : "synthetic-human", senderKind: i % 2 ? "agent" as const : "human" as const, content })) });

describe("RaftBench triage batches", () => {
  test("render bounded, scrubbed one-line messages under a thread header", () => {
    const [batch] = packTriageBatches([{ target: "#synthetic:aaaaaaaa", messages: [
      { id: id(1), createdAt: at, sender: "synthetic-human", senderKind: "human", content: "first line\nsecond line from 10.1.2.3" },
      { id: id(2), createdAt: at, sender: null, senderKind: "agent", content: "x".repeat(1_500) },
    ] }]);
    const lines = batch.text.split("\n");
    expect(lines[0]).toBe("=== thread #synthetic:aaaaaaaa (2 msgs)");
    expect(lines[1]).toBe(`[${id(1).slice(0, 8)}] 07-20 09:05 @synthetic-human (human): first line ⏎ second line from [redacted]`);
    expect(lines[2]).toBe(`[${id(2).slice(0, 8)}] 07-20 09:05 @unknown (agent): ${"x".repeat(1_200)}…[truncated]`);
    expect([...batch.messages.keys()]).toEqual([id(1), id(2)]);
  });

  test("keep threads whole within the character budget and continue only an oversized thread", () => {
    const small = [thread("#synthetic:aaaaaaaa", 3, 1), thread("#synthetic:bbbbbbbb", 3, 10), thread("#synthetic:cccccccc", 3, 20)];
    const oneLine = packTriageBatches([thread("#x", 1, 1)])[0].text.split("\n")[1].length + 1;
    const budget = 2 * (3 * oneLine + 60);
    const chars = (text: string) => text.length;
    const batches = packTriageBatches(small, budget, chars);
    expect(batches.map(batch => [...batch.messages.values()].map(m => m.target))).toEqual([
      ["#synthetic:aaaaaaaa", "#synthetic:aaaaaaaa", "#synthetic:aaaaaaaa", "#synthetic:bbbbbbbb", "#synthetic:bbbbbbbb", "#synthetic:bbbbbbbb"],
      ["#synthetic:cccccccc", "#synthetic:cccccccc", "#synthetic:cccccccc"],
    ]);
    for (const batch of batches) expect(batch.text.length).toBeLessThanOrEqual(budget);
    const oversized = packTriageBatches([thread("#synthetic:dddddddd", 9, 30)], 4 * oneLine, chars);
    expect(oversized.length).toBeGreaterThan(1);
    expect(oversized.flatMap(batch => [...batch.messages.keys()])).toEqual(thread("#x", 9, 30).messages.map(m => m.id));
    expect(oversized[1].text.split("\n")[0]).toBe("=== thread #synthetic:dddddddd (9 msgs, continued 2)");
    for (const batch of oversized) expect(batch.text.length).toBeLessThanOrEqual(4 * oneLine);
  });

  test("estimate tokens conservatively for CJK and bound batches by tokens", () => {
    expect(estimateTokens("abcdefghij")).toBe(5);
    expect(estimateTokens("受不了了")).toBe(6);
    const cjk = thread("#synthetic:ffffffff", 40, 50, "这个页面又打不开了".repeat(60));
    for (const batch of packTriageBatches([cjk], 5_000)) expect(estimateTokens(batch.text) + batch.text.split("\n").length).toBeLessThanOrEqual(5_000);
  });

  test("accept only well-formed labels that name exactly one message of the batch", () => {
    const [batch] = packTriageBatches([thread("#synthetic:aaaaaaaa", 2, 1), { target: "#synthetic:eeeeeeee", messages: [
      { id: `${id(1).slice(0, 8)}-ffff-4000-8000-000000000099`, createdAt: at, sender: "synthetic-human", senderKind: "human", content: "Same short prefix" },
    ] }]);
    const short = (n: number) => id(n).slice(0, 8);
    const output = [
      "Here are the labels:",
      JSON.stringify({ id: short(2), thread: "aaaaaaaa", label: "self_retract", why: "agent corrects its earlier claim" }),
      JSON.stringify({ id: short(2), thread: "aaaaaaaa", label: "self_retract", why: "duplicate" }),
      JSON.stringify({ id: id(2), thread: "aaaaaaaa", label: "failure", why: "full id accepted" }),
      JSON.stringify({ id: short(1), thread: "aaaaaaaa", label: "frustration", why: "ambiguous short id" }),
      JSON.stringify({ id: "99999999", thread: "aaaaaaaa", label: "failure", why: "invented id" }),
      JSON.stringify({ id: short(2), thread: "aaaaaaaa", label: "stuck", why: "unknown label" }),
      "{not json",
    ].join("\n");
    expect(parseTriageOutput(output, batch)).toEqual({ rejected: 4, labels: [
      { messageId: id(2), target: "#synthetic:aaaaaaaa", label: "self_retract", why: "agent corrects its earlier claim" },
      { messageId: id(2), target: "#synthetic:aaaaaaaa", label: "failure", why: "full id accepted" },
    ] });
  });
});
