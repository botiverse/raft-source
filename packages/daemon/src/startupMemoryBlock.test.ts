import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RECOMMENDED_MEMORY_MD_BYTES,
  applyStartupMemoryBlock,
  buildStartupMemoryBlock,
  resolveStartupMemoryBlockConfig,
} from "./startupMemoryBlock";
import { planWakeSessionRecycle } from "./wakeSessionRecycle";
import { asAxSurfaceText, type AgentConfig } from "@botiverse/raft-shared";

function workspaceWithMemory(content: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-block-"));
  if (content !== null) writeFileSync(path.join(dir, "MEMORY.md"), content);
  return dir;
}

test("the block is on by default, independent of the retired server field; env =0 turns it off; per-agent env beats process env", () => {
  const defaults = resolveStartupMemoryBlockConfig(null, {});
  assert.equal(defaults.enabled, true, "no env: on");
  assert.equal(defaults.budgetTokens, 4_000);
  assert.equal(resolveStartupMemoryBlockConfig(null, { RAFT_STARTUP_MEMORY_BLOCK: "0" }).enabled, false, "daemon process env =0 turns it off");
  assert.equal(resolveStartupMemoryBlockConfig({ RAFT_STARTUP_MEMORY_BLOCK: "0" }, {}).enabled, false, "per-agent env =0 turns it off");

  const fromProcess = resolveStartupMemoryBlockConfig(null, { RAFT_STARTUP_MEMORY_BLOCK: "1", RAFT_STARTUP_MEMORY_BLOCK_TOKENS: "2000" });
  assert.equal(fromProcess.enabled, true);
  assert.equal(fromProcess.budgetTokens, 2_000);

  const agentWins = resolveStartupMemoryBlockConfig(
    { RAFT_STARTUP_MEMORY_BLOCK: "0" },
    { RAFT_STARTUP_MEMORY_BLOCK: "1" },
  );
  assert.equal(agentWins.enabled, false);
});

test("missing, empty, and whitespace-only MEMORY.md yield no block", async () => {
  assert.equal(await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(null) }), null);
  assert.equal(await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory("") }), null);
  assert.equal(await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory("  \n\n  ") }), null);
});

test("a small index is injected in full with a no-re-read note", async () => {
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory("# Memory\n- [note](notes/a.md)\n") });
  assert.ok(block);
  assert.match(block!, /^<memory-index file="MEMORY\.md"/);
  assert.match(block!, /- \[note\]\(notes\/a\.md\)/);
  assert.match(block!, /complete="true" note="no need to re-read MEMORY\.md/);
  assert.doesNotMatch(block!, /Recommended index size|notes\/ /);
});

test("an oversize-but-within-budget index gets the same facts-only full note", async () => {
  const content = "# Memory\n" + "x".repeat(RECOMMENDED_MEMORY_MD_BYTES + 512);
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(content), budgetTokens: 8_000 });
  assert.ok(block);
  assert.match(block!, /complete="true"/);
  assert.doesNotMatch(block!, /recommended|Move detail|Cleaner/i);
});

test("an over-budget file is head-truncated with exact sizes and the recommendation", async () => {
  const lines = Array.from({ length: 3_000 }, (_, i) => `- line ${i} of the memory index`);
  const content = lines.join("\n");
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(content), budgetTokens: 1_000 });
  assert.ok(block);
  assert.match(block!, /- line 0 of the memory index/);
  assert.doesNotMatch(block!, /- line 2999 of/);
  assert.match(block!, /shown="first \d+\.\d KB" note="read the file for the rest"/);
  assert.doesNotMatch(block!, /Recommended index size|Move detail|Cleaner/i);
  // Truncation must land on a line boundary, so no half line precedes the
  // closing tag.
  const shown = block!.split("\n</memory-index>")[0]!;
  const lastContentLine = shown.trimEnd().split("\n").at(-1)!;
  assert.match(lastContentLine, /^- line \d+ of the memory index$/);
  // Budget is respected in bytes (4 bytes/token estimate).
  assert.ok(Buffer.byteLength(shown, "utf8") <= 1_000 * 4 + 200);
});

test("multibyte content is never split mid code point", async () => {
  const content = "# 记忆\n" + "记忆索引条目。".repeat(2_000);
  const block = await buildStartupMemoryBlock({ workspacePath: workspaceWithMemory(content), budgetTokens: 500 });
  assert.ok(block);
  assert.doesNotMatch(block!, /�/);
});

test("applyStartupMemoryBlock prepends and marks the prompt source, and is a no-op without a block", () => {
  const wake = asAxSurfaceText("wake");
  const untouched = applyStartupMemoryBlock(null, wake, "cold_start");
  assert.deepEqual(untouched, { prompt: "wake", promptSource: "cold_start" });

  const applied = applyStartupMemoryBlock(asAxSurfaceText("## MEMORY.md ..."), wake, "cold_start");
  assert.equal(applied.prompt, "## MEMORY.md ...\n\nwake");
  assert.equal(applied.promptSource, "cold_start_with_memory");
});

test("recycled briefing orders chrome, then memory block, then constructed panel", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "memory-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lastTurnAt = Date.now() - 3 * 3_600_000;
  const records = [
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(lastTurnAt).toISOString(),
      message: { usage: { input_tokens: 5, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 1_500 } },
    }),
  ];
  for (let i = 0; i < 6; i += 1) {
    records.push(JSON.stringify({
      type: "assistant",
      timestamp: new Date(lastTurnAt).toISOString(),
      message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }] },
    }));
    records.push(JSON.stringify({
      type: "user",
      timestamp: new Date(lastTurnAt).toISOString(),
      message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `${i}` }] },
    }));
  }
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), records.join("\n") + "\n");
  const workspacePath = workspaceWithMemory("# Memory index marker\n- durable fact\n");

  const config = {
    runtime: "claude",
    sessionId,
    envVars: null,
    runtimeContext: { workspacePath },
  } as unknown as AgentConfig;
  const plan = await planWakeSessionRecycle({ config, hasResumePrompt: false, homeDir: home, processEnv: {} });
  assert.equal(plan.action, "recycle");
  if (plan.action !== "recycle") return;
  const memoryFirst = plan.briefing.startsWith("<memory-index");
  const memoryAt = plan.briefing.indexOf("## MEMORY.md (your memory index");
  const panelAt = plan.briefing.indexOf("<recent-actions");
  assert.ok(memoryFirst && panelAt > memoryAt, `order broken: first=${memoryFirst} ${memoryAt}/${panelAt}`);
  assert.match(plan.briefing, /Memory index marker/);

  // Kill switch => briefing unchanged apart from the panel.
  const offPlan = await planWakeSessionRecycle({
    config: { ...config, envVars: { RAFT_STARTUP_MEMORY_BLOCK: "0" } } as unknown as AgentConfig,
    hasResumePrompt: false,
    homeDir: home,
    processEnv: {},
  });
  assert.equal(offPlan.action, "recycle");
  if (offPlan.action === "recycle") assert.doesNotMatch(offPlan.briefing, /<memory-index/);
});
