/**
 * Claude Code stream-json integration tests — spawn real `claude`, drive the
 * same long-lived stdin/stdout shape the daemon uses, and assert progress
 * envelope invariants.
 *
 * These are GUARDED and SKIPPED by default. To run locally:
 *
 *   1. Claude Code must be installed and authenticated.
 *   2. Set `RUN_CLAUDE_INTEGRATION_TESTS=1` to opt in.
 *
 *   Then: `RUN_CLAUDE_INTEGRATION_TESTS=1 pnpm --filter @botiverse/raft-daemon exec tsx --test src/drivers/claude.integration.test.ts`
 *
 * Why guarded:
 * - Local dev machines without Claude Code should not fail CI/default tests.
 * - Real Claude auth and API spend are required.
 * - The test validates black-box stream shape, not unit-level parser fixtures.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "vitest";
import { ClaudeDriver, resolveClaudeCommand } from "./claude.js";

const OPT_IN = process.env.RUN_CLAUDE_INTEGRATION_TESTS === "1";
const CLAUDE_BIN = resolveClaudeCommand();
const SKIP_REASON = !OPT_IN
  ? "skipped: set RUN_CLAUDE_INTEGRATION_TESTS=1 to opt in"
  : !CLAUDE_BIN
    ? "skipped: Claude Code binary not found on PATH or known macOS app path"
    : null;
const integrationTest = SKIP_REASON
  ? test.skip.bind(test)
  : test;

const driver = new ClaudeDriver();

const config = {
  name: "claude-integration",
  displayName: "Claude Integration",
  description: "Claude Code integration test",
  model: "sonnet",
  runtime: "claude",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "https://api.slock.ai",
  authToken: null,
};

async function runClaudeTurn(prompt: string, timeoutMs = 45_000): Promise<string[]> {
  if (!CLAUDE_BIN) throw new Error("Claude Code binary not found (guard should have skipped)");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "slock-claude-integration-"));
  const standingPromptFilePath = path.join(cwd, "standing-prompt.md");
  writeFileSync(standingPromptFilePath, "You are running a Slock daemon integration test.\n", { mode: 0o600 });

  const args = driver.buildClaudeArgs(config as any, { standingPromptFilePath });
  const proc = spawn(CLAUDE_BIN, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });

  const lines: string[] = [];
  const stderrChunks: string[] = [];
  const rl = readline.createInterface({ input: proc.stdout });

  try {
    const resultSeen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for Claude result after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stderr.on("data", (chunk) => {
        stderrChunks.push(String(chunk));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("exit", (code, signal) => {
        if (lines.some((line) => {
          try { return JSON.parse(line)?.type === "result"; } catch { return false; }
        })) return;
        clearTimeout(timer);
        reject(new Error(`Claude exited before result (code=${code}, signal=${signal}, stderr=${stderrChunks.join("").slice(0, 1000)})`));
      });
      rl.on("line", (line) => {
        lines.push(line);
        try {
          if (JSON.parse(line)?.type === "result") {
            clearTimeout(timer);
            resolve();
          }
        } catch { /* ignore non-JSON noise */ }
      });
    });

    proc.stdin.write(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    }) + "\n");

    await resultSeen;
    return lines;
  } finally {
    try { proc.stdin.end(); } catch { /* ignore */ }
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    rl.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function parseJsonLines(lines: string[]): any[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function findSessionJsonl(root: string, filename: string): string | null {
  if (!existsSync(root)) return null;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name === filename) return fullPath;
    }
  }
  return null;
}

async function runClaudeActiveThinkingSteering(timeoutMs = 150_000): Promise<{
  lines: string[];
  stderr: string;
  steeringToken: string;
  triggered: boolean;
  sessionRows: any[];
}> {
  if (!CLAUDE_BIN) throw new Error("Claude Code binary not found (guard should have skipped)");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "slock-claude-direct-steering-"));
  const standingPromptFilePath = path.join(cwd, "standing-prompt.md");
  const sessionId = randomUUID();
  const steeringToken = `RAFT_DIRECT_STEERING_${randomUUID()}`;
  writeFileSync(standingPromptFilePath, "You are running a Raft daemon transport test.\n", { mode: 0o600 });

  const args = [
    ...driver.buildClaudeArgs(config as any, { standingPromptFilePath }),
    "--effort", "max",
    "--permission-mode", "bypassPermissions",
    "--tools", "Bash",
    "--safe-mode",
    "--session-id", sessionId,
    "--max-turns", "20",
  ];
  const proc = spawn(CLAUDE_BIN, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const lines: string[] = [];
  const stderrChunks: string[] = [];
  const rl = readline.createInterface({ input: proc.stdout });
  let triggered = false;

  const writeFrame = (text: string) => {
    proc.stdin.write(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      session_id: sessionId,
    })}\n`);
  };

  try {
    const resultSeen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for steered Claude result after ${timeoutMs}ms`)), timeoutMs);
      proc.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
      proc.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.on("exit", (code, signal) => {
        if (lines.some((line) => {
          try { return JSON.parse(line)?.type === "result"; } catch { return false; }
        })) return;
        clearTimeout(timer);
        reject(new Error(`Claude exited before steered result (code=${code}, signal=${signal})`));
      });
      rl.on("line", (line) => {
        lines.push(line);
        let value: any;
        try { value = JSON.parse(line); } catch { return; }
        if (
          !triggered
          && value?.type === "stream_event"
          && value?.event?.type === "content_block_delta"
          && value?.event?.delta?.type === "thinking_delta"
        ) {
          triggered = true;
          writeFrame(`${steeringToken} Continue all four Bash calls, but change only the final marker to STEERED_DONE.`);
        }
        if (value?.type === "result") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    writeFrame([
      "Before visible output, privately calculate and double-check 987654321^1234567 modulo 97 without a tool.",
      "Then use Bash exactly four times, sequentially, running sleep 1; printf 'CONTROL_STEP_N\\n' for N=1..4.",
      "After all four results answer with exactly BASE_DONE unless a later user message changes the marker.",
    ].join(" "));
    await resultSeen;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sessionPath = findSessionJsonl(path.join(os.homedir(), ".claude", "projects"), `${sessionId}.jsonl`);
    const sessionRows = sessionPath
      ? readFileSync(sessionPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        })
      : [];
    return { lines, stderr: stderrChunks.join(""), steeringToken, triggered, sessionRows };
  } finally {
    try { proc.stdin.end(); } catch { /* ignore */ }
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    rl.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function runClaudeCompactionSteering(timeoutMs = 300_000): Promise<{
  lines: string[];
  stderr: string;
  duringToken: string;
  afterToken: string;
  compactionStarted: boolean;
  compactionFinished: boolean;
  sessionRows: any[];
}> {
  if (!CLAUDE_BIN) throw new Error("Claude Code binary not found (guard should have skipped)");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "slock-claude-compaction-steering-"));
  const standingPromptFilePath = path.join(cwd, "standing-prompt.md");
  const sessionId = randomUUID();
  const duringToken = `RAFT_COMPACTION_DURING_${randomUUID()}`;
  const afterToken = `RAFT_COMPACTION_AFTER_${randomUUID()}`;
  writeFileSync(standingPromptFilePath, "You are running a Raft daemon transport test.\n", { mode: 0o600 });

  const args = [
    ...driver.buildClaudeArgs(config as any, { standingPromptFilePath }),
    "--autocompact", "100k",
    "--permission-mode", "bypassPermissions",
    "--tools", "",
    "--safe-mode",
    "--session-id", sessionId,
    "--max-turns", "20",
  ];
  const proc = spawn(CLAUDE_BIN, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
    },
  });
  const lines: string[] = [];
  const stderrChunks: string[] = [];
  const rl = readline.createInterface({ input: proc.stdout });
  let fillTurns = 0;
  let compactionStarted = false;
  let compactionFinished = false;
  let wroteDuring = false;
  let wroteAfter = false;
  let lastCompletedFill = 0;

  const writeFrame = (text: string) => {
    proc.stdin.write(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      session_id: sessionId,
    })}\n`);
  };
  const writeFillTurn = () => {
    fillTurns += 1;
    const word = fillTurns % 2 === 0 ? "beta" : "alpha";
    writeFrame(`${word} `.repeat(12_000) + `\nThis is context-fill turn ${fillTurns}. Reply with exactly FILL_${fillTurns}.`);
  };

  try {
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for Claude compaction steering after ${timeoutMs}ms`)), timeoutMs);
      proc.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
      proc.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.on("exit", (code, signal) => {
        if (compactionFinished && lines.some((line) => line.includes("COMPACTION_STEERED_DONE"))) return;
        clearTimeout(timer);
        reject(new Error(`Claude exited before compaction steering completed (code=${code}, signal=${signal})`));
      });
      rl.on("line", (line) => {
        lines.push(line);
        let value: any;
        try { value = JSON.parse(line); } catch { return; }
        if (
          !wroteDuring
          && value?.type === "system"
          && value?.subtype === "status"
          && value?.status === "compacting"
        ) {
          compactionStarted = true;
          wroteDuring = true;
          writeFrame(`After compaction finishes, reply with exactly ${duringToken}.`);
        }
        if (!wroteAfter && value?.type === "system" && value?.subtype === "compact_boundary") {
          compactionFinished = true;
          wroteAfter = true;
          writeFrame(`${afterToken} Reply with exactly COMPACTION_STEERED_DONE.`);
        }
        const assistantText = value?.type === "assistant" && Array.isArray(value?.message?.content)
          ? value.message.content
              .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
              .map((block: any) => block.text)
              .join("\n")
          : "";
        if (assistantText === "COMPACTION_STEERED_DONE" || (value?.type === "result" && value?.result === "COMPACTION_STEERED_DONE")) {
          if (compactionFinished) {
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (!compactionStarted && assistantText === `FILL_${fillTurns}` && lastCompletedFill < fillTurns) {
          lastCompletedFill = fillTurns;
          if (fillTurns < 8) writeFillTurn();
          else {
            clearTimeout(timer);
            reject(new Error("eight 12k-word turns completed without a compaction event"));
          }
        }
      });
    });

    writeFillTurn();
    await completed;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sessionPath = findSessionJsonl(path.join(os.homedir(), ".claude", "projects"), `${sessionId}.jsonl`);
    const sessionRows = sessionPath
      ? readFileSync(sessionPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        })
      : [];
    return {
      lines,
      stderr: stderrChunks.join(""),
      duringToken,
      afterToken,
      compactionStarted,
      compactionFinished,
      sessionRows,
    };
  } finally {
    try { proc.stdin.end(); } catch { /* ignore */ }
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    rl.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

integrationTest("claude code stream-json exposes metadata-only internal progress envelopes", { timeout: 60_000 }, async () => {
  const lines = await runClaudeTurn("Reply with exactly: CLAUDE-INTERNAL-PROGRESS-OK");
  const parsed = lines.flatMap((line) => driver.parseLine(line));
  const internalProgress = parsed.filter((event) => event.kind === "internal_progress");

  assert.ok(
    internalProgress.some((event) => event.source === "claude_system_status" && event.itemType === "requesting"),
    "Claude should emit a requesting system status that maps to internal progress",
  );
  assert.ok(
    internalProgress.some((event) => event.source === "claude_stream_event" && event.itemType === "message_start"),
    "Claude should emit stream_event envelopes that map to internal progress",
  );
  assert.ok(
    parsed.some((event) => event.kind === "text" && event.text.includes("CLAUDE-INTERNAL-PROGRESS-OK")),
    "full assistant text still comes from final assistant message, not partial stream envelopes",
  );

  for (const event of internalProgress) {
    assert.ok(
      typeof event.payloadBytes === "number" && event.payloadBytes > 0,
      "internal progress records only positive byte-size metadata",
    );
    assert.equal("text" in event, false, "internal progress must not retain partial text");
    assert.equal("input" in event, false, "internal progress must not retain partial tool input");
  }
});

integrationTest("claude code longer generation emits repeated progress envelopes", { timeout: 75_000 }, async () => {
  const lines = await runClaudeTurn(
    "Write one sentence, then list the numbers 1 through 80 separated by commas, then end with exactly: CLAUDE-LONG-GENERATION-OK",
    60_000,
  );
  const rawEvents = parseJsonLines(lines);
  const parsed = lines.flatMap((line) => driver.parseLine(line));
  const internalProgress = parsed.filter((event) => event.kind === "internal_progress");
  const streamEventTypes = rawEvents
    .filter((event) => event.type === "stream_event")
    .map((event) => event.event?.type);
  const deltaCount = streamEventTypes.filter((type) => type === "content_block_delta").length;

  assert.ok(
    deltaCount >= 3,
    `longer generation should produce repeated content_block_delta progress envelopes, got ${deltaCount}`,
  );
  assert.ok(
    internalProgress.some((event) => event.source === "claude_system_status" && event.itemType === "requesting"),
    "longer generation should still refresh progress from requesting status envelopes",
  );
  assert.ok(
    internalProgress.some((event) => event.source === "claude_stream_event"),
    "longer generation should still refresh progress from stream_event envelopes",
  );
  assert.ok(
    parsed.some((event) => event.kind === "text" && event.text.includes("CLAUDE-LONG-GENERATION-OK")),
    "assistant final text should still arrive after longer generation",
  );

  for (const event of internalProgress) {
    assert.equal("text" in event, false, "internal progress must not retain partial text");
    assert.equal("input" in event, false, "internal progress must not retain partial tool input");
  }
});

integrationTest("claude code queues stdin written during active signed thinking", { timeout: 180_000 }, async () => {
  const result = await runClaudeActiveThinkingSteering();
  const rows = parseJsonLines(result.lines);
  const finalResult = rows.filter((row) => row?.type === "result").at(-1)?.result;
  const toolUseRows = rows.filter((row) =>
    row?.type === "assistant"
    && Array.isArray(row?.message?.content)
    && row.message.content.some((block: any) => block?.type === "tool_use")
  ).length;
  const toolResultRows = rows.filter((row) =>
    row?.type === "user"
    && Array.isArray(row?.message?.content)
    && row.message.content.some((block: any) => block?.type === "tool_result")
  ).length;
  const combinedOutput = `${result.lines.join("\n")}\n${result.stderr}`;
  const queuedRows = result.sessionRows.filter((row) =>
    row?.attachment?.type === "queued_command"
    && JSON.stringify(row).includes(result.steeringToken)
  );

  assert.equal(result.triggered, true, "the write must occur on a real thinking_delta, not after thinking ends");
  assert.equal(queuedRows.length >= 1, true, "Claude must persist the injected token as a native queued_command");
  assert.equal(toolUseRows >= 4, true, "the steered turn must complete all four tool calls");
  assert.equal(toolResultRows >= 4, true, "the steered turn must observe all four tool results");
  assert.equal(finalResult, "STEERED_DONE");
  assert.doesNotMatch(combinedOutput, /API Error[^\n]*400|(?:thinking|redacted_thinking)[^\n]{0,200}cannot be modified/i);
});

integrationTest("claude code accepts stdin across a proven compaction boundary", { timeout: 330_000 }, async () => {
  const result = await runClaudeCompactionSteering();
  const combinedOutput = `${result.lines.join("\n")}\n${result.stderr}`;
  const compactBoundaryIndex = result.sessionRows.findIndex((row) =>
    row?.type === "system" && row?.subtype === "compact_boundary"
  );
  const duringIndex = result.sessionRows.findIndex((row) => JSON.stringify(row).includes(result.duringToken));
  const afterIndex = result.sessionRows.findIndex((row) => JSON.stringify(row).includes(result.afterToken));
  const postBoundaryDuringAssistantIndex = result.sessionRows.findIndex((row, index) => {
    if (index <= compactBoundaryIndex || row?.type !== "assistant" || !Array.isArray(row?.message?.content)) return false;
    const assistantText = row.message.content
      .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
      .map((block: any) => block.text)
      .join("\n");
    return assistantText === result.duringToken;
  });

  assert.equal(result.compactionStarted, true, "the run must emit the signed compacting status");
  assert.equal(result.compactionFinished, true, "the run must emit the signed compact_boundary event");
  assert.equal(compactBoundaryIndex >= 0, true, "the session receipt must persist the compact_boundary event");
  assert.equal(duringIndex >= 0 && duringIndex < compactBoundaryIndex, true, "stdin written on compacting must persist before the boundary");
  assert.equal(postBoundaryDuringAssistantIndex > compactBoundaryIndex, true, "the model must echo the during-compaction token after the boundary");
  assert.equal(afterIndex > compactBoundaryIndex, true, "stdin written after compact_boundary must persist after the boundary");
  assert.match(combinedOutput, /COMPACTION_STEERED_DONE/);
  assert.doesNotMatch(combinedOutput, /API Error[^\n]*400|(?:thinking|redacted_thinking)[^\n]{0,200}cannot be modified/i);
});

test("claude integration test guard state (always runs; reports skip reason if any)", () => {
  console.log(`[claude.integration.test] CLAUDE_BIN=${CLAUDE_BIN ?? "<not found>"}`);
  console.log(`[claude.integration.test] OPT_IN (RUN_CLAUDE_INTEGRATION_TESTS=1)=${OPT_IN}`);
  console.log(`[claude.integration.test] SKIP_REASON=${SKIP_REASON ?? "<none, tests will run>"}`);
  if (SKIP_REASON) {
    assert.ok(true, `integration tests skipped: ${SKIP_REASON}`);
  } else {
    assert.ok(CLAUDE_BIN && OPT_IN, "all guards satisfied; integration tests will run");
  }
});
