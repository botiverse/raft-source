import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeModelInfo } from "@botiverse/raft-shared";
import { canonicalizeCodexPresentation } from "../src/utils/codexModelOrder.js";

// Codex is a dynamic runtime source, but the web picker uses Raft's bundled
// fallback order to keep host presets ahead of older live catalog entries and to
// select the current bundled default when the machine has surfaced it.

const m = (id: string): RuntimeModelInfo => ({ id, label: id } as RuntimeModelInfo);

const LIVE_CODEX = ["gpt-5.5", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"].map(m);

test("codex default becomes gpt-6-astra even when the machine reports gpt-5.5", () => {
  const out = canonicalizeCodexPresentation("codex", LIVE_CODEX, "gpt-5.5");
  assert.equal(out.default, "gpt-6-astra");
});

test("Astra and the three GPT-5.6 variants are ordered before gpt-5.5", () => {
  const ids = canonicalizeCodexPresentation("codex", LIVE_CODEX, "gpt-5.5").models.map((x) => x.id);
  const idx = (id: string) => ids.indexOf(id);
  for (const v of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.ok(idx(v) < idx("gpt-5.5"), `${v} must sort before gpt-5.5 (got ${ids.join(", ")})`);
  }
  assert.deepEqual(ids.slice(0, 4), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
});

test("live-only models (not in static RUNTIME_MODELS) retain their relative order at the tail", () => {
  const ids = canonicalizeCodexPresentation("codex", LIVE_CODEX, "gpt-5.5").models.map((x) => x.id);
  // gpt-5.5, gpt-5.4, gpt-5.4-mini are live-only; their machine order is preserved.
  assert.ok(ids.indexOf("gpt-5.5") < ids.indexOf("gpt-5.4"));
  assert.ok(ids.indexOf("gpt-5.4") < ids.indexOf("gpt-5.4-mini"));
});

test("falls back to the machine default when Astra is absent", () => {
  const noAstra = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.4"].map(m);
  const out = canonicalizeCodexPresentation("codex", noAstra, "gpt-5.5");
  assert.equal(out.default, "gpt-5.5");
});

test("falls back to the first ordered model when neither Astra nor the machine default is present", () => {
  const noAstra = ["gpt-5.4", "gpt-5.6-sol", "gpt-5.4-mini"].map(m);
  const out = canonicalizeCodexPresentation("codex", noAstra, "gpt-5.5");
  assert.equal(out.default, "gpt-5.6-sol");
});

test("non-codex runtimes are passed through untouched (order + host-default)", () => {
  const claude = ["claude-b", "claude-a"].map(m);
  const out = canonicalizeCodexPresentation("claude", claude, "claude-b");
  assert.deepEqual(out.models.map((x) => x.id), ["claude-b", "claude-a"]);
  assert.equal(out.default, "claude-b");
});
