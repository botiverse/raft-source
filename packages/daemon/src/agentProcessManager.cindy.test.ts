import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { asAxSurfaceText } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager.js";
import { setDaemonFetchImplForTests } from "./daemonFetch.js";
import type { RuntimeDriver } from "./drivers/index.js";
import { promptConfig } from "./testing/promptFixture.js";
import { buildCindyMemoryMd, buildOnboardingPlaybookMd, buildOnboardingKnowledgeFaqMd, buildOnboardingObjectivesMd } from "./cindy.js";

class CindyChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
    // Real children exit after kill returns; let stopAgent install its waiter.
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
}

async function withCindyManager(
  run: (ctx: { manager: AgentProcessManager; dataDir: string }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-cindy-test-"));
  const driver: RuntimeDriver = {
    id: "prompt-test",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh" },
    model: { detectedModelsVerifiedAs: "suggestion_only" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: true,
    buildSystemPrompt: () => asAxSurfaceText("standing"),
    spawn: () => ({ process: new CindyChild() as unknown as ChildProcess }),
    parseLine: () => [],
    encodeStdinMessage: (text) => text,
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_prompt_test", credentialId: "prompt-test" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
  });
  try {
    await run({ manager, dataDir });
  } finally {
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

test("Cindy startup installs seed documents and restart preserves edited knowledge", async () => {
  await withCindyManager(async ({ manager, dataDir }) => {
    const config = promptConfig({
      name: "cindy",
      displayName: "Cindy",
      envVars: { SLOCK_ONBOARDING_MEMORY_SEED: "first-cindy" },
    });
    const files = [
      { relativePath: "MEMORY.md", content: buildCindyMemoryMd("Cindy") },
      { relativePath: "notes/onboarding_playbook.md", content: buildOnboardingPlaybookMd() },
      { relativePath: "notes/onboarding_knowledge_faq.md", content: buildOnboardingKnowledgeFaqMd() },
      { relativePath: "notes/onboarding_objectives.md", content: buildOnboardingObjectivesMd() },
    ];
    await manager.startAgent("cindy", config);
    for (const file of files) {
      const target = path.join(dataDir, "cindy", file.relativePath);
      expect(await readFile(target, "utf8")).toBe(file.content);
      await writeFile(target, `Updated knowledge: ${file.relativePath}`);
    }
    await manager.stopAgent("cindy", { wait: true });
    await manager.startAgent("cindy", config);
    for (const file of files) {
      expect(await readFile(path.join(dataDir, "cindy", file.relativePath), "utf8"))
        .toBe(`Updated knowledge: ${file.relativePath}`);
    }
  });
});
