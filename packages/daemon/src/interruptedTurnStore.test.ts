import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStateFile } from "./agentStateFiles";
import { DEFAULT_INTERRUPTED_TURN_TTL_MS, InterruptedTurnStore } from "./interruptedTurnStore";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "interrupted-turn-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("InterruptedTurnStore", () => {
  it("writes non-secret drift kinds and consumes once within TTL", () => {
    const dir = makeTempDir();
    let nowMs = 1_700_000_000_000;
    const store = new InterruptedTurnStore(dir, () => nowMs);

    store.write("agent-1", ["model", "features", "env", "model", "credential_account"]);
    const first = store.take("agent-1");
    expect(first).toEqual({ interruptedAtMs: nowMs, drift: ["model", "env"] });

    // Consume-once: second take returns null.
    expect(store.take("agent-1")).toBeNull();
  });

  it("expires records past TTL and removes the file", () => {
    const dir = makeTempDir();
    let nowMs = 1_700_000_000_000;
    const store = new InterruptedTurnStore(dir, () => nowMs);

    store.write("agent-1", ["runtime"]);
    nowMs += DEFAULT_INTERRUPTED_TURN_TTL_MS + 1;
    expect(store.take("agent-1")).toBeNull();
  });

  it("clears records on delete", () => {
    const dir = makeTempDir();
    const store = new InterruptedTurnStore(dir, () => 1_700_000_000_000);

    store.write("agent-1", ["runtime_config"]);
    store.delete("agent-1");
    expect(store.take("agent-1")).toBeNull();
  });

  it("refuses symlinked files on read and write", () => {
    const dir = makeTempDir();
    const store = new InterruptedTurnStore(dir, () => 1_700_000_000_000);
    const target = path.join(dir, "secret.txt");
    writeFileSync(target, '{"interruptedAtMs":1700000000000,"drift":["model"]}\n', "utf-8");

    store.write("agent-1", ["model"]);
    const statePath = agentStateFile(dir, "agent-1", "interrupted-turn.json");
    rmSync(statePath, { force: true });
    symlinkSync(target, statePath);

    expect(store.take("agent-1")).toBeNull();
  });
});
