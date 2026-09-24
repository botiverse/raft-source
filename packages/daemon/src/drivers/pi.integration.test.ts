/**
 * Pi SDK integration tests — start the daemon's native Pi RuntimeSession,
 * drive prompt/steer through SDK methods, and assert driver/protocol
 * invariants that unit fixtures cannot prove.
 *
 * These tests are guarded and skipped by default. To run locally:
 *
 *   1. Pi auth/model config must be available to the SDK, for example
 *      `~/.pi/agent/auth.json` or `PI_CODING_AGENT_DIR/auth.json`.
 *   2. Set `RUN_PI_INTEGRATION_TESTS=1` to opt in.
 *   3. Set `PI_INTEGRATION_MODEL` to a configured `<provider>/<model>` id.
 *
 *   Then:
 *   `RUN_PI_INTEGRATION_TESTS=1 pnpm --filter @botiverse/raft-daemon exec tsx --test src/drivers/pi.integration.test.ts`
 *
 * The tests use temporary agent workspaces and session dirs so model sessions
 * are isolated from normal agent workspaces. They intentionally do not
 * override Pi's auth/config dir; auth remains whatever the local Pi SDK uses.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { PiDriver } from "./pi.js";
import type { ParsedEvent, RuntimeSession, SpawnContext } from "./types.js";

const PI_INTEGRATION_MODEL = process.env.PI_INTEGRATION_MODEL;

function hasPiAuth(): boolean {
  if (process.env.PI_CODING_AGENT_DIR) {
    const authPath = path.join(process.env.PI_CODING_AGENT_DIR, "auth.json");
    try {
      return readFileSync(authPath, "utf8").trim().length > 10;
    } catch {
      return false;
    }
  }

  const homeAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
  try {
    return readFileSync(homeAuthPath, "utf8").trim().length > 10;
  } catch {
    return false;
  }
}

async function hasPiModel(modelId: string): Promise<boolean> {
  const [provider, ...modelParts] = modelId.split("/");
  if (!provider || modelParts.length === 0) return false;
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    return Boolean(new ModelRegistry(modelRuntime).find(provider, modelParts.join("/")));
  } catch {
    return false;
  }
}

const HAS_AUTH = hasPiAuth();
const HAS_MODEL = PI_INTEGRATION_MODEL ? await hasPiModel(PI_INTEGRATION_MODEL) : false;
const OPT_IN = process.env.RUN_PI_INTEGRATION_TESTS === "1";

const SKIP_REASON =
  !OPT_IN
    ? "skipped: set RUN_PI_INTEGRATION_TESTS=1 to opt in"
    : !PI_INTEGRATION_MODEL
      ? "skipped: set PI_INTEGRATION_MODEL to a configured <provider>/<model> id"
    : !HAS_AUTH
      ? "skipped: no Pi auth detected (~/.pi/agent/auth.json or PI_CODING_AGENT_DIR/auth.json)"
      : !HAS_MODEL
        ? `skipped: Pi SDK model not available: ${PI_INTEGRATION_MODEL}`
        : null;

const integrationTest = SKIP_REASON ? test.skip.bind(test) : test;

interface PiSdkHarness {
  driver: PiDriver;
  runtime: RuntimeSession;
  stderr: string[];
  recv: () => Promise<ParsedEvent>;
  recvUntil: (
    predicate: (event: ParsedEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<ParsedEvent>;
}

function makeSpawnContext(workingDirectory: string, slockCliPath: string, prompt: string): SpawnContext {
  return {
    agentId: "pi-integration-agent",
    standingPrompt: "You are a concise runtime integration test agent. Follow exact-token instructions.",
    prompt,
    workingDirectory,
    slockCliPath,
    daemonApiKey: "daemon-token",
    config: {
      name: "Pi Integration Agent",
      displayName: null,
      description: null,
      runtime: "pi",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId: null,
      model: PI_INTEGRATION_MODEL ?? "default",
      reasoningEffort: null,
      envVars: null,
      runtimeContext: null,
    },
  };
}

async function withPiDriver(
  prompt: string,
  cb: (harness: PiSdkHarness) => Promise<void>,
): Promise<void> {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "slock-pi-sdk-"));
  const slockCliPath = path.join(workspaceDir, "slock-cli.js");
  writeFileSync(
    slockCliPath,
    "#!/usr/bin/env node\nconsole.log('slock integration test stub');\n",
    { mode: 0o755 },
  );

  const driver = new PiDriver();
  const stderr: string[] = [];
  const runtime = driver.createSession(makeSpawnContext(workspaceDir, slockCliPath, prompt));

  const inbox: ParsedEvent[] = [];
  const waiters: Array<(event: ParsedEvent) => void> = [];
  runtime.on("runtime_event", (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else inbox.push(event);
  });
  runtime.on("stderr", (text) => {
    stderr.push(text);
  });
  const startResult = await runtime.start({ text: prompt });
  assert.deepEqual(startResult, { ok: true, acceptedAs: "prompt" });

  const harness: PiSdkHarness = {
    driver,
    runtime,
    stderr,
    recv() {
      return new Promise((resolve) => {
        const queued = inbox.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      });
    },
    async recvUntil(predicate, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        let timeout: NodeJS.Timeout | undefined;
        const event = await Promise.race([
          harness.recv(),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), remaining);
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        if (!event) break;
        if (predicate(event)) return event;
      }
      throw new Error(`Timed out waiting for Pi SDK event. stderr=${stderr.join("").slice(-500)}`);
    },
  };

  try {
    await cb(harness);
  } finally {
    await runtime.stop({ signal: "SIGTERM", reason: "integration_test_cleanup" });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function collectTurnText(harness: PiSdkHarness, expectedToken: string): Promise<string> {
  let text = "";
  let sawTurnEnd = false;

  await harness.recvUntil((event) => {
    if (event.kind === "text") text += event.text;
    if (event.kind === "turn_end") sawTurnEnd = true;
    return sawTurnEnd;
  });

  assert.match(text, new RegExp(expectedToken));
  return text;
}

integrationTest("PiDriver SDK prompt and idle follow-up complete with configured model", { timeout: 240_000 }, async () => {
  const firstToken = `PI_SDK_FIRST_${randomUUID().slice(0, 8)}`;
  await withPiDriver(`Reply exactly ${firstToken} and no other text.`, async (harness) => {
    await collectTurnText(harness, firstToken);

    const secondToken = `PI_SDK_IDLE_${randomUUID().slice(0, 8)}`;
    assert.deepEqual(await harness.runtime.send({
      mode: "idle",
      text: `Reply exactly ${secondToken} and no other text.`,
    }), { ok: true, acceptedAs: "prompt" });

    await collectTurnText(harness, secondToken);
  });
});

integrationTest("PiDriver SDK accepts busy steering on the persistent session", { timeout: 180_000 }, async () => {
  const firstToken = `PI_SDK_STEER_START_${randomUUID().slice(0, 8)}`;
  await withPiDriver(
    [
      `Start by replying with ${firstToken}.`,
      "If you receive a steering update before your final answer, acknowledge it if possible.",
    ].join(" "),
    async (harness) => {
      await harness.recvUntil((event) => event.kind === "text", 120_000);

      assert.deepEqual(await harness.runtime.send({
        mode: "busy",
        text: "Steering update: include PI_SDK_STEER_OK if possible.",
      }), { ok: true, acceptedAs: "steer" });
    },
  );
});

test("pi integration test guard state", () => {
  console.log(`[pi.integration.test] PI_INTEGRATION_MODEL=${PI_INTEGRATION_MODEL}`);
  console.log(`[pi.integration.test] HAS_AUTH=${HAS_AUTH}`);
  console.log(`[pi.integration.test] HAS_MODEL=${HAS_MODEL}`);
  console.log(`[pi.integration.test] OPT_IN (RUN_PI_INTEGRATION_TESTS=1)=${OPT_IN}`);
  console.log(`[pi.integration.test] SKIP_REASON=${SKIP_REASON ?? "<none, tests will run>"}`);
  if (SKIP_REASON) {
    assert.ok(true, `integration tests skipped: ${SKIP_REASON}`);
  } else {
    assert.ok(HAS_AUTH && HAS_MODEL && OPT_IN, "all guards satisfied; integration tests will run");
  }
});
