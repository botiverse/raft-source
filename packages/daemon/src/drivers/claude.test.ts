import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { buildClaudeProviderIsolationEnv, ClaudeDriver } from "./claude.js";
import { buildClaudeManagedMcpConfig } from "./claudeLaunch.js";
import { CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS, LEGACY_CLAUDE_PROVIDER_CONFIG_DIR } from "./claudeProviderIsolation.js";
import { subscribeDaemonLogs, type DaemonLogEvent } from "../logger.js";
import type { SpawnContext } from "./types.js";

const driver = new ClaudeDriver();
const config = {
  name: "hao",
  displayName: "Hao",
  description: "runtime tester",
  model: "sonnet",
  runtime: "claude",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "https://api.slock.ai",
  authToken: null,
};

test("claude driver delegates parseLine to ClaudeEventNormalizer", () => {
  // Per-parse-case behavior lives in claudeEventNormalizer.test.ts. This test
  // pins only that `driver.parseLine` is a thin delegate to the normalizer —
  // a representative tool_result event round-trips through the public driver
  // surface to its normalized ParsedEvent shape.
  const events = driver.parseLine(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_delegation_check", content: "ok" }],
    },
  }));

  assert.deepEqual(events, [
    { kind: "tool_output", name: "toolu_delegation_check" },
  ]);
});

test("claude driver delegates buildClaudeArgs to launch config builder", () => {
  const args = driver.buildClaudeArgs(config as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.ok(args.includes("--append-system-prompt-file"));
  assert.equal(
    args[args.indexOf("--append-system-prompt-file") + 1],
    "/tmp/slock-agent/.slock/claude-system-prompt.md",
  );
  assert.ok(args.includes("--include-partial-messages"));
  // Inline fallback path is intentionally deleted; only file path is supported.
  assert.ok(!args.includes("--append-system-prompt"));
  assert.ok(!args.includes("--system-prompt-file"));
  assert.ok(!args.includes("--system-prompt"));
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--runtime-actions-only"));
});

test("claude managed MCP config preserves explicitly requested local MCP servers", () => {
  const configPath = "/tmp/private/claude-mcp.json";
  assert.deepEqual(buildClaudeManagedMcpConfig({
    name: "raftmanagedabc123",
    url: "http://127.0.0.1:43123/mcp/opaque",
  }), {
    mcpServers: {
      raftmanagedabc123: {
        type: "http",
        url: "http://127.0.0.1:43123/mcp/opaque",
      },
    },
  });
  const args = driver.buildClaudeArgs(config as any, {
    standingPromptFilePath: "/tmp/system.md",
    managedMcpConfigPath: configPath,
  });
  assert.deepEqual(args.slice(-2), ["--mcp-config", configPath]);
  assert.ok(!args.includes("--strict-mcp-config"));
});

test("claude driver spawn executes configured command wrapper with stream-json launch args", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-command-"));
  const capturePath = path.join(tmp, "capture.json");
  const fakeClaudePath = path.join(tmp, "fake-claude.mjs");
  try {
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  body += chunk;
  writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), stdin: body }));
  process.exit(0);
});
setTimeout(() => {
  writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), stdin: body, timeout: true }));
  process.exit(0);
}, 500);
`,
      { mode: 0o755 },
    );

    const result = await driver.spawn(makeSpawnContext(tmp, {
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "preset", id: "sonnet" },
        mode: { kind: "default" },
        command: fakeClaudePath,
      },
    }));
    await once(result.process, "exit");

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      argv: string[];
      stdin: string;
      timeout?: boolean;
    };
    assert.equal(capture.timeout, undefined);
    assert.equal(capture.argv[capture.argv.indexOf("--input-format") + 1], "stream-json");
    assert.equal(capture.argv[capture.argv.indexOf("--output-format") + 1], "stream-json");
    assert.equal(capture.argv[capture.argv.indexOf("--model") + 1], "sonnet");
    assert.equal(capture.argv.includes("-p"), false);

    const stdinMessage = JSON.parse(capture.stdin.trim());
    assert.equal(stdinMessage.type, "user");
    assert.deepEqual(stdinMessage.message.content, [{ type: "text", text: "hello" }]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude driver preserves an old carrier's visible Opus 5 rejection without fallback", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-opus-5-old-carrier-"));
  const capturePath = path.join(tmp, "capture.json");
  const fakeClaudePath = path.join(tmp, "fake-claude.mjs");
  try {
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.stdin.on("data", () => {
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2) }));
  process.stderr.write("Claude Code 2.1.204 does not support model claude-opus-5; upgrade to 2.1.219 or later\\n");
  process.exit(1);
});
`,
      { mode: 0o755 },
    );

    const result = await driver.spawn(makeSpawnContext(tmp, {
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "preset", id: "claude-opus-5" },
        mode: { kind: "default" },
        command: fakeClaudePath,
      },
    }));
    let stderr = "";
    result.process.stderr?.setEncoding("utf8");
    result.process.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [exitCode] = await once(result.process, "exit");

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { argv: string[] };
    assert.equal(capture.argv[capture.argv.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(capture.argv.includes("claude-opus-4-8"), false);
    assert.equal(exitCode, 1);
    assert.match(stderr, /2\.1\.204 does not support model claude-opus-5/);
    assert.match(stderr, /2\.1\.219 or later/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude launch continues without managed MCP config when discovery is forbidden", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-mcp-fail-soft-"));
  const capturePath = path.join(tmp, "capture.json");
  const fakeClaudePath = path.join(tmp, "fake-claude.mjs");
  const originalFetch = globalThis.fetch;
  const logEvents: DaemonLogEvent[] = [];
  const unsubscribe = subscribeDaemonLogs((event) => logEvents.push(event));
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: "capability_not_authorized",
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.stdin.on("data", () => {
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2) }));
  process.exit(0);
});
`,
      { mode: 0o755 },
    );

    const result = await driver.spawn(makeSpawnContext(tmp, {
      agentCredentialKey: "sk_agent_test",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "preset", id: "sonnet" },
        mode: { kind: "default" },
        command: fakeClaudePath,
      },
    }));
    await once(result.process, "exit");

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { argv: string[] };
    assert.equal(capture.argv.includes("--mcp-config"), false);
    assert.ok(logEvents.some((event) =>
      event.level === "WARN"
      && event.message.includes("Managed MCP discovery unavailable for this session")
      && event.message.includes("reason=discovery_failed,http_status=403")
      && !event.message.includes("sk_agent_test"),
    ));
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribe();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude driver blocks oversized daemon-owned startup payload before command launch", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-input-cap-"));
  const capturePath = path.join(tmp, "capture.json");
  const fakeClaudePath = path.join(tmp, "fake-claude.mjs");
  try {
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capturePath)}, "spawned");
process.exit(0);
`,
      { mode: 0o755 },
    );

    const ctx = makeSpawnContext(tmp, {
      model: "claude-fable-5",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "custom", name: "claude-fable-5" },
        mode: { kind: "default" },
        command: fakeClaudePath,
      },
    });
    ctx.prompt = "x".repeat(3_000_000);

    await assert.rejects(
      () => driver.spawn(ctx),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, "ClaudeStartupPayloadTooLargeError");
        assert.match(err.message, /INPUT_TOO_LARGE/);
        assert.match(err.message, /daemon-owned startup payload/);
        assert.match(err.message, /claude-fable-5/);
        return true;
      },
    );
    assert.throws(() => readFileSync(capturePath, "utf8"), /ENOENT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude custom provider spawn clears inherited Claude provider env", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-command-"));
  const capturePath = path.join(tmp, "capture.json");
  const fakeClaudePath = path.join(tmp, "fake-claude.mjs");
  const previousProviderEnv = new Map<string, string | undefined>();
  try {
    for (const key of CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS) {
      previousProviderEnv.set(key, process.env[key]);
      process.env[key] = `host-${key}`;
    }
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
const clearedKeys = ${JSON.stringify(CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS)};
process.stdin.on("data", () => {
  writeFileSync(capturePath, JSON.stringify({
    hostProviderEnvPresent: Object.fromEntries(clearedKeys.map((key) => [
      key,
      Object.prototype.hasOwnProperty.call(process.env, key),
    ])),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  }));
  process.exit(0);
});
`,
      { mode: 0o755 },
    );

    const result = await driver.spawn(makeSpawnContext(tmp, {
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
        model: { kind: "preset", id: "sonnet" },
        mode: { kind: "default" },
        reasoningEffort: null,
        command: fakeClaudePath,
      },
    }));
    await once(result.process, "exit");

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      hostProviderEnvPresent: Record<string, boolean>;
      anthropicApiKey?: string;
      anthropicBaseUrl?: string;
    };
    for (const key of CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS) {
      assert.equal(capture.hostProviderEnvPresent[key], false, `${key} should be absent`);
    }
    assert.equal(capture.anthropicApiKey, "sk-ant-test");
    assert.equal(capture.anthropicBaseUrl, "https://gateway.example.test/v1");
  } finally {
    for (const key of CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS) {
      const previous = previousProviderEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude custom provider warns once when legacy isolated config dir exists", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-command-"));
  const fakeClaudePath = path.join(tmp, "fake-claude.mjs");
  const legacyClaudeDir = path.join(tmp, LEGACY_CLAUDE_PROVIDER_CONFIG_DIR);
  const logEvents: DaemonLogEvent[] = [];
  const unsubscribe = subscribeDaemonLogs((event) => {
    logEvents.push(event);
  });
  try {
    mkdirSync(legacyClaudeDir, { recursive: true });
    writeFileSync(path.join(legacyClaudeDir, "settings.json"), "{}\n");
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
process.stdin.on("data", () => {
  process.exit(0);
});
`,
      { mode: 0o755 },
    );

    const spawnConfig = {
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
        model: { kind: "preset", id: "sonnet" },
        mode: { kind: "default" },
        reasoningEffort: null,
        command: fakeClaudePath,
      },
    };
    const first = await driver.spawn(makeSpawnContext(tmp, spawnConfig));
    await once(first.process, "exit");
    const second = await driver.spawn(makeSpawnContext(tmp, spawnConfig));
    await once(second.process, "exit");

    const warnings = logEvents.filter((event) =>
      event.level === "WARN"
      && event.message.includes(`Legacy Claude custom-provider config directory ${LEGACY_CLAUDE_PROVIDER_CONFIG_DIR} is no longer used`)
    );
    assert.equal(warnings.length, 1);
  } finally {
    unsubscribe();
    rmSync(tmp, { recursive: true, force: true });
  }
});

function makeSpawnContext(workDir: string, configOverrides: Record<string, unknown> = {}): SpawnContext {
  return {
    agentId: "agent-1",
    launchId: "launch-1",
    config: {
      ...config,
      ...configOverrides,
    } as any,
    standingPrompt: "standing prompt",
    prompt: "hello",
    workingDirectory: workDir,
    slockCliPath: "/fake/slock-cli.js",
    daemonApiKey: "daemon-key",
  };
}

test("claude custom provider launch only clears inherited provider env", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-provider-"));
  try {
    const env = buildClaudeProviderIsolationEnv(makeSpawnContext(tmp, {
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
        model: { kind: "preset", id: "opus" },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars: null,
      },
    }));

    assert.equal(Object.prototype.hasOwnProperty.call(env, "HOME"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "USERPROFILE"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "CLAUDE_CONFIG_DIR"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"), false);
    for (const key of CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(env, key), true, `${key} should be cleared`);
      assert.equal(env[key], undefined);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude custom provider launch preserves explicit provider env overrides", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-provider-"));
  try {
    const env = buildClaudeProviderIsolationEnv(makeSpawnContext(tmp, {
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
        model: { kind: "preset", id: "opus" },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars: {
          ANTHROPIC_AUTH_TOKEN: "explicit-token",
          CLAUDE_CODE_USE_BEDROCK: "1",
          ANTHROPIC_MODEL: "explicit-model",
        },
      },
    }));

    assert.equal(Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_AUTH_TOKEN"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_USE_BEDROCK"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_MODEL"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "AWS_BEARER_TOKEN_BEDROCK"), true);
    assert.equal(env.AWS_BEARER_TOKEN_BEDROCK, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude default provider launch keeps host Claude account state available", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-provider-"));
  try {
    const env = buildClaudeProviderIsolationEnv(makeSpawnContext(tmp, {
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "preset", id: "opus" },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars: null,
      },
    }));

    assert.deepEqual(env, {});
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
