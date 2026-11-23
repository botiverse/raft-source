import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { InventoryOptions, SkillEntry } from "@botiverse/oar";

import { AgentProcessManager } from "./agentProcessManager";
import { OarSkillCatalog } from "./runtimeSkills/oarSkills";

async function withManager(
  catalog: OarSkillCatalog | undefined,
  run: (manager: AgentProcessManager, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-skills-test-"));
  try {
    const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
      dataDir,
      serverUrl: "https://daemon.invalid",
      ...(catalog ? { oarSkills: catalog } : {}),
    });
    await run(manager, dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function writeWorkspaceSkill(dataDir: string, agentId: string, name: string, description: string): Promise<void> {
  const dir = path.join(dataDir, agentId, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
}

// Skills come only from OAR (xxchan, #oar-raft:7e06ebc9): Raft reads no
// runtime folders of its own, adds nothing to OAR's list and falls back to
// nothing when OAR cannot read.

test("listSkills shows OAR's list as it is: a skill folder Raft could read adds nothing", async () => {
  const calls: Array<InventoryOptions | undefined> = [];
  const catalog = new OarSkillCatalog({
    resolveSource: async () => ({
      installation: { kind: "available", via: "executable", command: "claude" },
      read: async (_installation, options) => {
        calls.push(options);
        const items: SkillEntry[] = [{ name: "simplify", source: "built-in", scope: "builtin" }, { name: "deploy", source: "projectSettings", scope: "project" }];
        return { kind: "ok", scope: { kind: "workspace", cwd: options?.cwd ?? "" }, observedAt: "2026-11-16T00:00:00Z", view: "context", items, partial: false };
      },
    }),
  });
  await withManager(catalog, async (manager, dataDir) => {
    await writeWorkspaceSkill(dataDir, "agent-1", "deploy", "Ship it");
    await writeWorkspaceSkill(dataDir, "agent-1", "only-on-disk", "Not reported by OAR");
    const lists = await manager.listSkills("agent-1", "claude");
    assert.equal(calls[0]?.cwd, path.join(dataDir, "agent-1"));
    assert.deepEqual(lists.builtin?.map((skill) => skill.name), ["simplify"]);
    assert.deepEqual(lists.workspace.map((skill) => [skill.name, skill.description]), [["deploy", ""]]);
    assert.equal(lists.unavailable, undefined);
  });
});

test("listSkills: a failed OAR read is unavailable with its reason and empty lists; no catalog, or a runtime OAR does not cover, lists nothing", async () => {
  const unsupported = new OarSkillCatalog({
    resolveSource: async () => ({
      installation: { kind: "available", via: "executable", command: "claude" },
      read: async () => ({ kind: "unsupported", code: "native_query_unavailable", reason: "old claude" }),
    }),
  });
  await withManager(unsupported, async (manager, dataDir) => {
    await writeWorkspaceSkill(dataDir, "agent-1", "deploy", "Ship it");
    assert.deepEqual(await manager.listSkills("agent-1", "claude"), { global: [], workspace: [], unavailable: { reason: "unsupported:native_query_unavailable" } });
    assert.deepEqual(await manager.listSkills("agent-1", "builtin"), { global: [], workspace: [] });
  });
  await withManager(undefined, async (manager, dataDir) => {
    await writeWorkspaceSkill(dataDir, "agent-1", "deploy", "Ship it");
    assert.deepEqual(await manager.listSkills("agent-1", "claude"), { global: [], workspace: [] });
  });
});
