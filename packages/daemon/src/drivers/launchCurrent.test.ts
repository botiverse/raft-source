import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeDriver } from "./claude";
import type { SpawnContext } from "./types";

// task #365: `SpawnContext.assertLaunchCurrent` is called by the driver after
// its last await and right before the runtime exists, so a launch whose
// server connection changed during the driver's own preparation gets no
// process.

function claudeContext(tmp: string, command: string, assertLaunchCurrent: () => void): SpawnContext {
  return {
    agentId: "agent-1",
    launchId: "launch-1",
    config: {
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
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "preset", id: "sonnet" },
        mode: { kind: "default" },
        command,
      },
    } as any,
    standingPrompt: "standing prompt",
    prompt: "hello",
    workingDirectory: tmp,
    slockHome: path.join(tmp, "home"),
    slockCliPath: "/fake/slock-cli.js",
    daemonApiKey: "daemon-key",
    assertLaunchCurrent,
  };
}

test.skipIf(process.platform === "win32")(
  "task #365: the real claude driver creates no child when the launch turns stale during its async preparation",
  async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-launch-current-"));
    try {
      const marker = path.join(tmp, "ran");
      const command = path.join(tmp, "claude");
      // Read the prompt line the driver writes before exiting: a child that
      // exits first turns that write into an EPIPE on an unlistened stdin.
      writeFileSync(command, `#!/bin/sh\nread -r _prompt\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
      let stale = false;
      const refused = new Error("launch claimed against an earlier connection");
      const ctx = claudeContext(tmp, command, () => { if (stale) throw refused; });

      // Positive control: while current, the same driver and command run.
      const control = await new ClaudeDriver().spawn(ctx);
      await new Promise<void>((resolve) => control.process.on("close", () => resolve()));
      assert.equal(existsSync(marker), true, "the command runs when the launch is current");
      rmSync(marker);

      // The connection changes after spawn() began, while it awaits its preparation.
      const pending = new ClaudeDriver().spawn(ctx);
      stale = true;
      await assert.rejects(pending, (err) => err === refused);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(marker), false, "no child was created");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
