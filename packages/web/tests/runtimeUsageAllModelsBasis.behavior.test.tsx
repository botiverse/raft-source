import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import { allModelsUsageAccount, summarizeRuntimeUsage } from "../src/components/machine/bulkChangeModelPlan";
import { rackAgentModelGroups, rackRuntimeCell } from "../src/components/machine/rack/rackRuntimeColumns";
import { rackRemaining } from "../src/features/computer/computersRackSort";
import type { Machine } from "../src/store/machineStore";

// One basis for every usage summary (OAR window scope): the rack's cell and
// first line, the rack's sort and the bulk dialog count all models, never
// Claude's OAuth apps' window; a model's own window is the cell's second
// line, and counted on the first only when the account reports nothing else.

type Window = RuntimeAccountUsageSnapshot["accounts"][number]["windows"][number];

function read(windows: Window[], health: "ok" | "rate_limited" = "ok", provider: RuntimeAccountUsageSnapshot["provider"] = "claude") {
  const snapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider,
    collectedAt: "2026-11-12T12:00:00.000Z",
    staleAfter: "2099-11-12T12:30:00.000Z",
    collectorVersion: "test",
    accounts: [{ accountKey: "c".repeat(64), planLabel: "Max", health, windows }],
  };
  return { state: "fresh" as const, snapshot };
}

const machine = { id: "m1", runtimes: ["claude"] } as unknown as Machine;
const allModels: Window = { id: "w0_aaaaaaaaaaaa", label: "Current week (all models)", status: "ok", usedRatio: 0.6, scope: { kind: "account" } };
const oauthApps: Window = { id: "w1_bbbbbbbbbbbb", label: "Current week (OAuth apps)", status: "ok", usedRatio: 0.95 };
const opusUsedUp: Window = { id: "w2_cccccccccccc", label: "Current week (Opus)", status: "limit_reached", usedRatio: 1, scope: { kind: "model", name: "Opus" } };
const opus40: Window = { id: "w3_dddddddddddd", label: "Current week (Opus)", status: "ok", usedRatio: 0.4, scope: { kind: "model", name: "Opus" } };

test("cell, sort and bulk agree: all models (60%), not Opus's limit nor the OAuth apps' 95%", () => {
  const result = read([allModels, oauthApps, opusUsedUp], "rate_limited");
  const cell = rackRuntimeCell(machine, "claude", { claude: result });
  assert.equal(cell.kind, "value");
  if (cell.kind !== "value") return;
  assert.equal(cell.used, 60);
  assert.equal(cell.model?.name, "Opus");
  assert.equal(cell.model?.usedUp, true);
  assert.deepEqual(summarizeRuntimeUsage(result.snapshot), { kind: "used", plan: "Max", percent: 60 });
  assert.ok(Math.abs(rackRemaining(result)! - 0.4) < 1e-9, "the sort reads what the cell's first line shows");
});

test("only model and OAuth apps' windows: one line counting the model, never the same model twice", () => {
  const result = read([oauthApps, opus40]);
  const { account, modelLine } = allModelsUsageAccount(result.snapshot.accounts[0]!);
  assert.equal(modelLine, false);
  assert.deepEqual(account.windows, [opus40]);
  const cell = rackRuntimeCell(machine, "claude", { claude: result });
  assert.equal(cell.kind === "value" ? cell.used : null, 40);
  assert.equal(cell.kind === "value" ? cell.model : "not a value", null);
  assert.deepEqual(summarizeRuntimeUsage(result.snapshot), { kind: "used", plan: "Max", percent: 40 });
  assert.ok(Math.abs(rackRemaining(result)! - 0.6) < 1e-9);
});

test("without a model window: the OAuth apps' window is still never counted", () => {
  const result = read([allModels, oauthApps]);
  assert.deepEqual(summarizeRuntimeUsage(result.snapshot), { kind: "used", plan: "Max", percent: 60 });
  assert.ok(Math.abs(rackRemaining(result)! - 0.4) < 1e-9);
});

// Antigravity (OAR 0.103): four windows, weekly and 5-hour per model group,
// no account window. The account runs while any group has quota left (OAR
// says rate limited only once every group is used up and no credits are
// left), so it counts as its group with the most left; the second line is a
// group's, the one the Computer's agents' models count against when Raft can
// tell.
const agyMachine = { id: "m2", runtimes: ["antigravity"] } as unknown as Machine;
const group = (id: string, name: string, label: string, used: number | "up"): Window => (used === "up"
  ? { id, label: `${name} · ${label}`, status: "limit_reached", usedRatio: 1, scope: { kind: "models", name } }
  : { id, label: `${name} · ${label}`, status: "ok", usedRatio: used, scope: { kind: "models", name } });
const geminiUsedUp = [group("g5", "Gemini Models", "5-hour limit", "up"), group("gw", "Gemini Models", "Weekly limit", 0.7)];
const claudeGpt = [group("c5", "Claude and GPT models", "5-hour limit", 0.1), group("cw", "Claude and GPT models", "Weekly limit", 0.3)];

test("Antigravity: one group used up is not the account used up; the cell counts the group with the most left", () => {
  const result = read([...geminiUsedUp, ...claudeGpt], "ok", "antigravity");
  const { account, modelLine } = allModelsUsageAccount(result.snapshot.accounts[0]!);
  assert.equal(modelLine, true);
  assert.deepEqual(account.windows.map((window) => window.id), ["c5", "cw"]);
  assert.deepEqual(summarizeRuntimeUsage(result.snapshot), { kind: "used", plan: "Max", percent: 30 });
  assert.ok(Math.abs(rackRemaining(result)! - 0.7) < 1e-9, "the sort reads the same basis");
  const cell = rackRuntimeCell(agyMachine, "antigravity", { antigravity: result });
  assert.equal(cell.kind === "value" ? cell.usedUp : null, false);
  assert.deepEqual(cell.kind === "value" ? cell.model : null, { name: "Gemini", used: 100, usedUp: true, resetsAt: null }, "no agents' models known: the tightest group");
});

test("Antigravity: the second line is the group of the agents' models", () => {
  const result = read([...geminiUsedUp, ...claudeGpt], "ok", "antigravity");
  const onClaude = rackAgentModelGroups([{ runtime: "antigravity", model: "claude-sonnet-5" }, { runtime: "claude", model: "gemini-lookalike" }]);
  assert.deepEqual(onClaude, ["Claude and GPT models"]);
  const cell = rackRuntimeCell(agyMachine, "antigravity", { antigravity: result }, onClaude);
  assert.deepEqual(cell.kind === "value" ? cell.model : null, { name: "Claude and GPT", used: 30, usedUp: false, resetsAt: null });
  const onGemini = rackRuntimeCell(agyMachine, "antigravity", { antigravity: result }, rackAgentModelGroups([{ runtime: "antigravity", model: "gemini-3.8-flash" }]));
  assert.equal(onGemini.kind === "value" ? onGemini.model?.name : null, "Gemini");
});

test("Antigravity: every group used up and OAR says rate limited: the account is used up", () => {
  const result = read([...geminiUsedUp, group("c5", "Claude and GPT models", "5-hour limit", "up"), group("cw", "Claude and GPT models", "Weekly limit", 0.3)], "rate_limited", "antigravity");
  assert.equal(summarizeRuntimeUsage(result.snapshot)?.kind, "limit");
  const cell = rackRuntimeCell(agyMachine, "antigravity", { antigravity: result });
  assert.equal(cell.kind === "value" ? cell.usedUp : null, true);
});

test("Antigravity with one group only: one line, never the same group twice", () => {
  const result = read(claudeGpt, "ok", "antigravity");
  assert.equal(allModelsUsageAccount(result.snapshot.accounts[0]!).modelLine, false);
  const cell = rackRuntimeCell(agyMachine, "antigravity", { antigravity: result });
  assert.equal(cell.kind === "value" ? cell.used : null, 30);
  assert.equal(cell.kind === "value" ? cell.model : "not a value", null);
});
