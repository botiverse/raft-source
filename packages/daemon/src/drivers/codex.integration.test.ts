/**
 * Codex app-server integration tests — spawn real `codex` binary, drive through
 * JSON-RPC, assert protocol-level invariants.
 *
 * These are GUARDED and SKIPPED by default. To run locally:
 *
 *   1. `codex` binary must be installed and on PATH (npm i -g @openai/codex)
 *   2. ChatGPT/OpenAI auth must be configured (one of):
 *        - `codex auth status` shows authenticated, OR
 *        - `~/.codex/auth.json` exists with valid tokens, OR
 *        - `OPENAI_API_KEY` env var set
 *   3. Set `RUN_CODEX_INTEGRATION_TESTS=1` to opt in (default CI skip)
 *
 *   Then: `RUN_CODEX_INTEGRATION_TESTS=1 pnpm --filter @botiverse/raft-daemon exec tsx --test src/drivers/codex.integration.test.ts`
 *
 * Why guarded:
 * - Local dev machines without `codex` installed shouldn't false-fail
 * - CI default skip avoids needing OpenAI auth setup in test infra
 * - Real API spend (~$0.001 per test turn); opt-in keeps it bounded
 * - Wall-time bounded (<30s per test) but spawn + auth handshake variable
 *
 * Scope: Phase 0 of `runtime/codex-cleanup-refactor` (per @Hao audit
 * msg=bc879a8f + @tygg endorse msg=7f9bc91b + @Huaihuai integration test lane
 * msg=c465eef1). Provides reusable `withCodexAppServer` harness + stat-field
 * assertions used by PR 3 telemetry sidecar acceptance. Later stack commits
 * use this harness to validate raw-event liveness replacement for transcript
 * mtime.
 *
 * Empirical findings backed by these tests (cite msg=c02143f1):
 * - `thread/tokenUsage/updated` is STANDARD (no experimentalApi opt-in)
 * - `account/rateLimits/updated` is STANDARD (no experimentalApi opt-in)
 * - `rawResponseItem/completed` is gated by `experimentalRawEvents` and tracks
 *   transcript-mtime-relevant progress when enabled
 *
 * The no-opt-in assertion remains a protocol guard: raw events are present only
 * when the daemon explicitly asks for them on thread/start.
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// --- Guard infrastructure --------------------------------------------------

function which(binName: string): string | null {
  const PATHs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of PATHs) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
    if (process.platform === "win32") {
      const winCandidate = candidate + ".cmd";
      try {
        if (existsSync(winCandidate)) return winCandidate;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function detectCodexAuth(): boolean {
  // Three sources, any one is enough:
  if (process.env.OPENAI_API_KEY) return true;
  const homeDir = os.homedir();
  const codexAuthPath = path.join(homeDir, ".codex", "auth.json");
  if (existsSync(codexAuthPath)) {
    try {
      const raw = readFileSync(codexAuthPath, "utf-8").trim();
      if (raw.length > 10) return true;
    } catch { /* ignore */ }
  }
  // ChatGPT login lives in a separate file:
  const chatgptAuthPath = path.join(homeDir, ".codex", "chatgpt-auth.json");
  if (existsSync(chatgptAuthPath)) {
    try {
      const raw = readFileSync(chatgptAuthPath, "utf-8").trim();
      if (raw.length > 10) return true;
    } catch { /* ignore */ }
  }
  return false;
}

const CODEX_BIN = which("codex");
const HAS_AUTH = detectCodexAuth();
const OPT_IN = process.env.RUN_CODEX_INTEGRATION_TESTS === "1";

const SKIP_REASON =
  !OPT_IN
    ? "skipped: set RUN_CODEX_INTEGRATION_TESTS=1 to opt in"
    : !CODEX_BIN
      ? "skipped: codex binary not found on PATH (install with `npm i -g @openai/codex`)"
      : !HAS_AUTH
        ? "skipped: no Codex auth detected (OPENAI_API_KEY env or ~/.codex/auth.json or ~/.codex/chatgpt-auth.json)"
        : null;

const integrationTest = SKIP_REASON
  ? test.skip.bind(test)
  : test;

// --- Reusable harness ------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code?: number; message?: string };
}

interface CodexHarness {
  proc: ChildProcessWithoutNullStreams;
  send: (method: string, params: Record<string, any>) => number;
  notify: (method: string, params: Record<string, any>) => void;
  recv: () => Promise<JsonRpcMessage>;
  recvUntil: (predicate: (msg: JsonRpcMessage) => boolean, timeoutMs?: number) => Promise<JsonRpcMessage>;
  collectFor: (durationMs: number) => Promise<JsonRpcMessage[]>;
  receivedMethods: Set<string>;
  receivedRawItemTypes: Set<string>;
  receivedById: Map<number | string, JsonRpcMessage>;
}

async function withCodexAppServer(
  cb: (harness: CodexHarness) => Promise<void>,
  opts: { cwd?: string } = {},
): Promise<void> {
  if (!CODEX_BIN) throw new Error("codex binary not found (guard should have skipped)");

  const cwd = opts.cwd ?? process.cwd();
  const proc = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });

  const inbox: JsonRpcMessage[] = [];
  const waiters: Array<(msg: JsonRpcMessage) => void> = [];
  const receivedMethods = new Set<string>();
  const receivedRawItemTypes = new Set<string>();
  const receivedById = new Map<number | string, JsonRpcMessage>();

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method) receivedMethods.add(msg.method);
    if (msg.method === "rawResponseItem/completed") {
      const item = msg.params?.item ?? msg.params?.responseItem ?? msg.params?.rawItem ?? msg.params;
      if (typeof item?.type === "string") receivedRawItemTypes.add(item.type);
    }
    if (msg.id !== undefined && (msg.result || msg.error)) receivedById.set(msg.id, msg);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });

  let nextId = 0;
  const harness: CodexHarness = {
    proc,
    receivedMethods,
    receivedRawItemTypes,
    receivedById,
    send(method, params) {
      nextId += 1;
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params }) + "\n");
      return nextId;
    },
    notify(method, params) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    recv() {
      return new Promise((resolve) => {
        const queued = inbox.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      });
    },
    async recvUntil(predicate, timeoutMs = 15000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const msg = await harness.recv();
        if (predicate(msg)) return msg;
      }
      throw new Error(`recvUntil timeout after ${timeoutMs}ms`);
    },
    async collectFor(durationMs) {
      const collected: JsonRpcMessage[] = [];
      const deadline = Date.now() + durationMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await Promise.race([
          (async () => {
            const msg = await harness.recv();
            collected.push(msg);
          })(),
          new Promise((resolve) => setTimeout(resolve, remaining)),
        ]);
      }
      return collected;
    },
  };

  try {
    await cb(harness);
  } finally {
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 2000);
      proc.on("exit", () => { clearTimeout(t); resolve(); });
    });
  }
}

// --- Tests -----------------------------------------------------------------

integrationTest("codex app-server: initialize returns standard handshake response", { timeout: 15_000 }, async () => {
  await withCodexAppServer(async (h) => {
    const initId = h.send("initialize", {
      clientInfo: { name: "slock-integration-test", version: "0.0.1" },
      capabilities: {},
    });
    const resp = await h.recvUntil((m) => m.id === initId);
    assert.ok(resp.result, "initialize should return result");
    assert.match(
      (resp.result as any).userAgent ?? "",
      /slock-integration-test/,
      "userAgent reflects client name",
    );
    assert.ok(
      typeof (resp.result as any).codexHome === "string",
      "codexHome path returned",
    );
  });
});

integrationTest(
  "codex app-server: thread/tokenUsage/updated fires WITHOUT experimentalApi (standard notification)",
  { timeout: 30_000 },
  async () => {
    await withCodexAppServer(async (h) => {
      // initialize WITHOUT experimentalApi
      const initId = h.send("initialize", {
        clientInfo: { name: "slock-integration-test", version: "0.0.1" },
        capabilities: {},
      });
      await h.recvUntil((m) => m.id === initId);
      h.notify("initialized", {});

      // thread/start WITHOUT experimentalRawEvents
      const threadStartId = h.send("thread/start", { cwd: "/tmp" });
      const threadStartResp = await h.recvUntil((m) => m.id === threadStartId);
      const threadId = (threadStartResp.result as any)?.thread?.id;
      assert.ok(typeof threadId === "string", "thread/start returns threadId");

      // turn/start with minimal prompt
      const turnId = h.send("turn/start", {
        threadId,
        input: [{ type: "text", text: "Say hi" }],
      });

      // Drain until turn/completed
      await h.recvUntil((m) => m.method === "turn/completed", 25_000);

      // Verify standard telemetry notifications observed:
      assert.ok(
        h.receivedMethods.has("thread/tokenUsage/updated"),
        "thread/tokenUsage/updated should fire as STANDARD notification (no experimentalApi needed)",
      );
      assert.ok(
        h.receivedMethods.has("account/rateLimits/updated"),
        "account/rateLimits/updated should fire as STANDARD notification (no experimentalApi needed)",
      );
    });
  },
);

integrationTest(
  "codex app-server: rawResponseItem/completed does NOT fire without experimentalRawEvents (regression guard)",
  { timeout: 30_000 },
  async () => {
    await withCodexAppServer(async (h) => {
      const initId = h.send("initialize", {
        clientInfo: { name: "slock-integration-test", version: "0.0.1" },
        capabilities: {}, // no experimentalApi
      });
      await h.recvUntil((m) => m.id === initId);
      h.notify("initialized", {});

      const threadStartId = h.send("thread/start", { cwd: "/tmp" }); // no experimentalRawEvents
      const threadStartResp = await h.recvUntil((m) => m.id === threadStartId);
      const threadId = (threadStartResp.result as any)?.thread?.id;

      h.send("turn/start", { threadId, input: [{ type: "text", text: "Say hi" }] });

      await h.recvUntil((m) => m.method === "turn/completed", 25_000);

      // Regression guard: we MUST NOT accidentally opt-in to experimental surface.
      assert.equal(
        h.receivedMethods.has("rawResponseItem/completed"),
        false,
        "rawResponseItem/completed should be GATED by experimentalRawEvents — if this fails, we have accidentally opted into the experimental API surface, increasing break-change risk per @Hao audit",
      );
    });
  },
);

integrationTest(
  "codex app-server: rawResponseItem/completed fires WITH experimentalRawEvents",
  { timeout: 45_000 },
  async () => {
    await withCodexAppServer(async (h) => {
      const initId = h.send("initialize", {
        clientInfo: { name: "slock-integration-test", version: "0.0.1" },
        capabilities: { experimentalApi: true },
      });
      await h.recvUntil((m) => m.id === initId);
      h.notify("initialized", {});

      const threadStartId = h.send("thread/start", {
        cwd: "/tmp",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        experimentalRawEvents: true,
      });
      const threadStartResp = await h.recvUntil((m) => m.id === threadStartId);
      const threadId = (threadStartResp.result as any)?.thread?.id;

      h.send("turn/start", {
        threadId,
        input: [{
          type: "text",
          text: "Use the shell to run `printf raw-events-probe` and then reply with exactly `done`.",
        }],
      });

      await h.recvUntil((m) => m.method === "turn/completed", 35_000);

      assert.ok(
        h.receivedMethods.has("rawResponseItem/completed"),
        "rawResponseItem/completed should fire when experimentalRawEvents is enabled",
      );
      assert.ok(h.receivedRawItemTypes.size > 0, "raw response item type should be observable without storing payload");
    });
  },
);

integrationTest(
  "codex app-server: tokenUsage payload contains expected stat fields (cache hit ratio computable)",
  { timeout: 30_000 },
  async () => {
    await withCodexAppServer(async (h) => {
      const initId = h.send("initialize", {
        clientInfo: { name: "slock-integration-test", version: "0.0.1" },
        capabilities: {},
      });
      await h.recvUntil((m) => m.id === initId);
      h.notify("initialized", {});

      const threadStartId = h.send("thread/start", { cwd: "/tmp" });
      const threadStartResp = await h.recvUntil((m) => m.id === threadStartId);
      const threadId = (threadStartResp.result as any)?.thread?.id;

      h.send("turn/start", { threadId, input: [{ type: "text", text: "Say hi" }] });

      const tokenUsageMsg = await h.recvUntil((m) => m.method === "thread/tokenUsage/updated", 25_000);
      const usage = (tokenUsageMsg.params as any)?.tokenUsage;
      assert.ok(usage?.total, "tokenUsage.total present");
      assert.equal(typeof usage.total.totalTokens, "number", "totalTokens is number");
      assert.equal(typeof usage.total.inputTokens, "number", "inputTokens is number");
      assert.equal(typeof usage.total.cachedInputTokens, "number", "cachedInputTokens is number (cache hit ratio computable)");
      assert.equal(typeof usage.total.outputTokens, "number", "outputTokens is number");
      assert.equal(typeof usage.modelContextWindow, "number", "modelContextWindow is number");
      assert.ok(usage.total.inputTokens >= usage.total.cachedInputTokens, "cachedInputTokens cannot exceed inputTokens");
    });
  },
);

integrationTest(
  "codex app-server: rateLimits payload contains plan + window + reset",
  { timeout: 30_000 },
  async () => {
    await withCodexAppServer(async (h) => {
      const initId = h.send("initialize", {
        clientInfo: { name: "slock-integration-test", version: "0.0.1" },
        capabilities: {},
      });
      await h.recvUntil((m) => m.id === initId);
      h.notify("initialized", {});

      const threadStartId = h.send("thread/start", { cwd: "/tmp" });
      const threadStartResp = await h.recvUntil((m) => m.id === threadStartId);
      const threadId = (threadStartResp.result as any)?.thread?.id;

      h.send("turn/start", { threadId, input: [{ type: "text", text: "Say hi" }] });

      const rateLimitMsg = await h.recvUntil((m) => m.method === "account/rateLimits/updated", 25_000);
      const rateLimits = (rateLimitMsg.params as any)?.rateLimits;
      assert.ok(rateLimits, "rateLimits payload present");
      assert.equal(typeof rateLimits.limitId, "string", "limitId is string");
      assert.ok(rateLimits.primary, "primary rate limit window present");
      assert.equal(typeof rateLimits.primary.usedPercent, "number", "usedPercent is number");
      assert.equal(typeof rateLimits.primary.windowDurationMins, "number", "windowDurationMins is number");
      assert.equal(typeof rateLimits.primary.resetsAt, "number", "resetsAt is number (epoch seconds)");
      assert.equal(typeof rateLimits.planType, "string", "planType is string");
    });
  },
);

integrationTest(
  "codex app-server: app event timing measurable (turn_started → turn_completed gap)",
  { timeout: 30_000 },
  async () => {
    await withCodexAppServer(async (h) => {
      const initId = h.send("initialize", {
        clientInfo: { name: "slock-integration-test", version: "0.0.1" },
        capabilities: {},
      });
      await h.recvUntil((m) => m.id === initId);
      h.notify("initialized", {});

      const threadStartId = h.send("thread/start", { cwd: "/tmp" });
      const threadStartResp = await h.recvUntil((m) => m.id === threadStartId);
      const threadId = (threadStartResp.result as any)?.thread?.id;

      h.send("turn/start", { threadId, input: [{ type: "text", text: "Say hi" }] });

      const turnStartedAt = Date.now();
      await h.recvUntil((m) => m.method === "turn/started", 25_000);
      const turnEndedAt = (await h.recvUntil((m) => m.method === "turn/completed", 25_000), Date.now());

      const gap = turnEndedAt - turnStartedAt;
      assert.ok(gap >= 0, "gap is non-negative");
      assert.ok(gap < 30_000, "turn completes within 30s for minimum prompt");
      // This timing is the primary signal RuntimeProgressMonitor will consume
      // (per @Hao audit msg=bc879a8f) — stat-field assertion confirms it's measurable.
    });
  },
);

// --- Skip placeholder (always runs, surfaces guard state in test output) ---

test("codex integration test guard state (always runs; reports skip reason if any)", () => {
  console.log(`[codex.integration.test] CODEX_BIN=${CODEX_BIN ?? "<not found>"}`);
  console.log(`[codex.integration.test] HAS_AUTH=${HAS_AUTH}`);
  console.log(`[codex.integration.test] OPT_IN (RUN_CODEX_INTEGRATION_TESTS=1)=${OPT_IN}`);
  console.log(`[codex.integration.test] SKIP_REASON=${SKIP_REASON ?? "<none, tests will run>"}`);
  if (SKIP_REASON) {
    assert.ok(true, `integration tests skipped: ${SKIP_REASON}`);
  } else {
    assert.ok(CODEX_BIN && HAS_AUTH && OPT_IN, "all guards satisfied; integration tests will run");
  }
});
