/**
 * Guarded real-binary Grok Build ACP integration test.
 *
 * Run with an authenticated `grok` on PATH:
 *
 *   RUN_GROK_INTEGRATION_TESTS=1 pnpm --filter @botiverse/raft-daemon exec \
 *     vitest run src/drivers/grok.integration.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { AgentConfig } from "@botiverse/raft-shared";
import { GrokDriver, resolveGrokCommand } from "./grok.js";
import { waitForCount, waitForState } from "../testing/drydock.js";
import type { ParsedEvent, SpawnContext } from "./types.js";

function hasGrokAuth(): boolean {
  const authPath = path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json");
  try {
    return existsSync(authPath) && readFileSync(authPath, "utf8").trim().length > 10;
  } catch {
    return false;
  }
}

const OPT_IN = process.env.RUN_GROK_INTEGRATION_TESTS === "1";
const GROK_BIN = resolveGrokCommand();
const SKIP_REASON = !OPT_IN
  ? "skipped: set RUN_GROK_INTEGRATION_TESTS=1 to opt in"
  : !GROK_BIN
    ? "skipped: grok binary not found on PATH"
    : !hasGrokAuth()
      ? "skipped: no Grok auth found under GROK_HOME or ~/.grok/auth.json"
      : null;
const integrationTest = SKIP_REASON ? test.skip.bind(test) : test;

function config(sessionId: string | null): AgentConfig {
  return {
    name: "grok-integration",
    displayName: "Grok Integration",
    description: "guarded ACP integration test",
    model: "grok-4.5",
    runtime: "grok",
    reasoningEffort: "low",
    envVars: null,
    sessionId,
    serverUrl: "https://api.raft.ai",
    authToken: "sk_machine_test",
  };
}

function context(
  sessionId: string | null,
  standingPrompt: string,
  prompt: string,
): SpawnContext {
  return {
    agentId: "grok-integration-agent",
    config: config(sessionId),
    standingPrompt,
    prompt,
    workingDirectory: process.cwd(),
    slockCliPath: process.execPath,
    daemonApiKey: "sk_machine_test",
    launchId: `grok-integration-${Date.now()}`,
  };
}

function collectEvents(driver: GrokDriver, proc: ChildProcess): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let buffer = "";
  proc.stdout?.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) events.push(...driver.parseLine(line));
    }
  });
  return events;
}

// Real child process on a real Grok CLI: generous bound, coarse sampling.
const GROK_WAIT = { timeoutMs: 45_000, pollIntervalMs: 25 } as const;

async function stop(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => proc.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 2_000)),
  ]);
}

integrationTest("grok driver supports fresh, same-turn steering, idle follow-up, and resumed standing prompt", {
  timeout: 120_000,
}, async () => {
  const firstDriver = new GrokDriver();
  let firstProc: ChildProcess | null = null;
  let sessionId: string | null = null;
  try {
    const spawned = await firstDriver.spawn(context(
      null,
      "The standing token is STANDING_V1. If asked for the standing token, return it exactly.",
      "Use the shell to run `sleep 5`. After it finishes, include the exact token ORIGINAL_DONE in your final answer.",
    ));
    firstProc = spawned.process;
    const events = collectEvents(firstDriver, firstProc);

    await waitForState(
      () => events.some((event) => event.kind === "tool_call") || events.some((event) => event.kind === "thinking"),
      "active Grok turn",
      GROK_WAIT,
    );
    sessionId = firstDriver.currentSessionId;
    assert.ok(sessionId);

    const steer = firstDriver.encodeStdinMessage(
      "Before finishing this same turn, also include the exact token STEERED_DONE.",
      sessionId,
      { mode: "busy" },
    );
    assert.ok(steer, "active prompt must accept busy interjection");
    firstProc.stdin?.write(`${steer}\n`);
    await waitForCount(() => events.filter((event) => event.kind === "turn_end").length, 1, "steered Grok turn_end", GROK_WAIT);

    const firstText = events.filter((event) => event.kind === "text").map((event) => event.text).join("");
    assert.match(firstText, /ORIGINAL_DONE/);
    assert.match(firstText, /STEERED_DONE/);
    assert.ok(events.some((event) =>
      event.kind === "internal_progress" && event.itemType === "pending_interaction"
    ), "terminal permission must expose bounded pending-interaction progress");
    assert.ok(events.some((event) =>
      event.kind === "internal_progress" && event.itemType === "interaction_resolved"
    ), "terminal permission must expose bounded interaction-resolved progress");
    assert.equal(
      events.some((event) => event.kind === "runtime_diagnostic"),
      false,
      "automatically resolved terminal permissions must not emit warning diagnostics",
    );
    assert.equal(events.some((event) => event.kind === "error" || event.kind === "delivery_error"), false);

    const idle = firstDriver.encodeStdinMessage("Reply with the exact token IDLE_DONE.", sessionId, { mode: "idle" });
    assert.ok(idle, "completed prompt must accept idle follow-up");
    firstProc.stdin?.write(`${idle}\n`);
    await waitForCount(() => events.filter((event) => event.kind === "turn_end").length, 2, "idle Grok turn_end", GROK_WAIT);
    assert.match(events.filter((event) => event.kind === "text").map((event) => event.text).join(""), /IDLE_DONE/);
  } finally {
    await stop(firstProc);
  }

  assert.ok(sessionId);
  const resumedDriver = new GrokDriver();
  let resumedProc: ChildProcess | null = null;
  try {
    const spawned = await resumedDriver.spawn(context(
      sessionId,
      "The standing token is STANDING_V2. If asked for the standing token, return it exactly.",
      "What is the standing token? Reply with only that token.",
    ));
    resumedProc = spawned.process;
    const events = collectEvents(resumedDriver, resumedProc);
    await waitForState(() => events.some((event) => event.kind === "turn_end"), "resumed Grok turn_end", GROK_WAIT);

    assert.equal(resumedDriver.currentSessionId, sessionId);
    assert.match(events.filter((event) => event.kind === "text").map((event) => event.text).join(""), /STANDING_V2/);
    assert.equal(events.some((event) => event.kind === "runtime_recovery"), false);
    assert.equal(events.some((event) => event.kind === "error"), false);
  } finally {
    await stop(resumedProc);
  }
});
