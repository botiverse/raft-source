import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  buildAgentMigrationAdoptPlan,
  executeAgentMigrationAdoptPlan,
  hashAgentMigrationManifest,
  verifyAgentMigrationAdoptPlan,
  type AgentMigrationAdoptGeneration,
  type AgentMigrationRebindClient,
} from "./agentMigrationImport.js";
import type { AgentMigrationExportManifest } from "./agentMigrationExport.js";

function tempRoot(): string {
  return path.join(os.tmpdir(), `agent-migration-import-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generation(overrides: Partial<AgentMigrationAdoptGeneration> = {}): AgentMigrationAdoptGeneration {
  return {
    grantKey: "agent_migration:grant-1",
    migrationGeneration: "agent_migration:grant-1",
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    localMachineId: "target-machine",
    ...overrides,
  };
}

function manifest(input: { agentId: string; slockHome: string; workspace: string }): AgentMigrationExportManifest {
  return {
    schemaVersion: "agent-bundle/v2",
    agentId: input.agentId,
    mode: "forensic",
    createdAt: "2026-07-08T00:00:00.000Z",
    defaults: {
      unknownFiles: "include",
      excludePolicy: "regenerable_only",
      regenerableDirectoryNames: [".venv", "__pycache__", "dist", "node_modules", "target"],
    },
    files: [{
      kind: "file",
      source: "workspace",
      bundlePath: "workspace/notes.md",
      workspaceRelativePath: "notes.md",
      sizeBytes: Buffer.byteLength("hello\n"),
      sha256: sha256("hello\n"),
    }],
    excludedRegenerable: [],
    promotedIncludes: [],
    proposalRefusals: [],
    unreachable: [],
    secretsDisclosed: [],
    cleaned: [],
    crossTreeRefs: [],
  };
}

test("staged bundle and at-rest orphan directory inputs normalize into the same adopt core shape", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const staged = path.join(root, "staged-workspace");
    const orphan = path.join(root, "orphan-workspace");
    mkdirSync(staged, { recursive: true });
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(staged, "notes.md"), "hello\n");
    writeFileSync(path.join(orphan, "notes.md"), "hello\n");

    const stagedManifest = manifest({ agentId: "agent-1", slockHome, workspace: staged });
    const stagedPlan = await buildAgentMigrationAdoptPlan({
      sourceKind: "staged_bundle",
      slockHome,
      stagingWorkspacePath: staged,
      manifest: stagedManifest,
      manifestSha256: hashAgentMigrationManifest(stagedManifest),
      generation: generation(),
    });
    const orphanPlan = await buildAgentMigrationAdoptPlan({
      sourceKind: "orphan_directory",
      slockHome,
      orphanWorkspacePath: orphan,
      agentId: "agent-1",
      generation: generation(),
      now: new Date("2026-07-08T00:00:00.000Z"),
    });

    assert.equal(stagedPlan.agentId, orphanPlan.agentId);
    assert.equal(stagedPlan.finalWorkspacePath, path.join(slockHome, "agents", "agent-1"));
    assert.equal(orphanPlan.finalWorkspacePath, path.join(slockHome, "agents", "agent-1"));
    assert.deepEqual(
      stagedPlan.manifest.files.map((entry) => [entry.workspaceRelativePath, entry.sha256]),
      orphanPlan.manifest.files.map((entry) => [entry.workspaceRelativePath, entry.sha256]),
    );
    assert.deepEqual(await verifyAgentMigrationAdoptPlan(stagedPlan), { fileCount: 1, totalBytes: 6 });
    assert.deepEqual(await verifyAgentMigrationAdoptPlan(orphanPlan), { fileCount: 1, totalBytes: 6 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest hash mismatch fails before final workspace placement", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const staged = path.join(root, "staged-workspace");
    mkdirSync(staged, { recursive: true });
    writeFileSync(path.join(staged, "notes.md"), "hello\n");
    const sourceManifest = manifest({ agentId: "agent-2", slockHome, workspace: staged });

    await assert.rejects(
      () => buildAgentMigrationAdoptPlan({
        sourceKind: "staged_bundle",
        slockHome,
        stagingWorkspacePath: staged,
        manifest: sourceManifest,
        manifestSha256: "bad-sha",
        generation: generation(),
      }),
      /MIGRATION_MANIFEST_SHA_MISMATCH/,
    );
    assert.equal(existsSync(path.join(slockHome, "agents", "agent-2")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adopt execution verifies files, places workspace, runs rebind in order, and writes arrival report", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const staged = path.join(root, "staged-workspace");
    mkdirSync(staged, { recursive: true });
    writeFileSync(path.join(staged, "notes.md"), "hello\n");
    const sourceManifest = manifest({ agentId: "agent-3", slockHome, workspace: staged });
    const plan = await buildAgentMigrationAdoptPlan({
      sourceKind: "staged_bundle",
      slockHome,
      stagingWorkspacePath: staged,
      manifest: sourceManifest,
      manifestSha256: hashAgentMigrationManifest(sourceManifest),
      generation: generation(),
      attestationNonce: "nonce-123",
      observedAttestationNonce: "nonce-123",
    });

    const calls: string[] = [];
    const rebind: AgentMigrationRebindClient = {
      async startTransfer() {
        calls.push("startTransfer");
        return { migrationGeneration: "agent_migration:grant-1" };
      },
      async flipMachine() {
        calls.push("flipMachine");
        return { sourceMachineId: "source-machine", targetMachineId: "target-machine" };
      },
      async markArrived(input) {
        calls.push(`markArrived:${input.reportSha256.length}`);
        return { grantKey: "agent_migration:grant-1" };
      },
    };

    const result = await executeAgentMigrationAdoptPlan(plan, rebind, new Date("2026-07-08T00:05:00.000Z"));
    assert.deepEqual(calls, ["startTransfer", "flipMachine", "markArrived:64"]);
    assert.equal(readFileSync(path.join(slockHome, "agents", "agent-3", "notes.md"), "utf8"), "hello\n");
    assert.equal(result.report.verified.fileCount, 1);
    assert.deepEqual(result.report.attestation, { noncePresent: true, nonceVerified: true });
    assert.equal(result.report.arrivedAt, "2026-07-08T00:05:00.000Z");
    assert.equal(result.reportSha256, sha256(`${JSON.stringify(JSON.parse(readFileSync(result.reportPath, "utf8")))}\n`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged bundle adoption preserves relative symlinks after staging cleanup", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const staged = path.join(root, "staged-workspace");
    mkdirSync(staged, { recursive: true });
    writeFileSync(path.join(staged, "notes.md"), "hello\n");
    symlinkSync("notes.md", path.join(staged, "notes-link"));
    const baseManifest = manifest({ agentId: "agent-symlink", slockHome, workspace: staged });
    const sourceManifest: AgentMigrationExportManifest = {
      ...baseManifest,
      files: [
        ...baseManifest.files,
        {
          kind: "symlink",
          source: "workspace",
          bundlePath: "workspace/notes-link",
          workspaceRelativePath: "notes-link",
          linkTarget: "notes.md",
        },
      ],
    };
    const plan = await buildAgentMigrationAdoptPlan({
      sourceKind: "staged_bundle",
      slockHome,
      stagingWorkspacePath: staged,
      manifest: sourceManifest,
      manifestSha256: hashAgentMigrationManifest(sourceManifest),
      generation: generation(),
    });
    const rebind: AgentMigrationRebindClient = {
      async startTransfer() {},
      async flipMachine() {},
      async markArrived() {},
    };

    await executeAgentMigrationAdoptPlan(plan, rebind, new Date("2026-07-08T00:05:00.000Z"));
    rmSync(staged, { recursive: true, force: true });

    const finalWorkspace = path.join(slockHome, "agents", "agent-symlink");
    assert.equal(readlinkSync(path.join(finalWorkspace, "notes-link")), "notes.md");
    assert.equal(readFileSync(path.join(finalWorkspace, "notes-link"), "utf8"), "hello\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adopt execution carries server generation readback into subsequent callbacks", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const staged = path.join(root, "staged-workspace");
    mkdirSync(staged, { recursive: true });
    writeFileSync(path.join(staged, "notes.md"), "hello\n");
    const sourceManifest = manifest({ agentId: "agent-readback", slockHome, workspace: staged });
    const plan = await buildAgentMigrationAdoptPlan({
      sourceKind: "staged_bundle",
      slockHome,
      stagingWorkspacePath: staged,
      manifest: sourceManifest,
      manifestSha256: hashAgentMigrationManifest(sourceManifest),
      generation: generation({ migrationGeneration: "gen-ready" }),
    });

    const seen: string[] = [];
    const rebind: AgentMigrationRebindClient = {
      async startTransfer(input) {
        seen.push(`start:${input.migrationGeneration}`);
        return { migrationGeneration: "gen-in-transit" };
      },
      async flipMachine(input) {
        seen.push(`flip:${input.migrationGeneration}`);
        return { migrationGeneration: "gen-arriving" };
      },
      async markArrived(input) {
        seen.push(`arrive:${input.migrationGeneration}`);
        return { migrationGeneration: "gen-completed" };
      },
    };

    const result = await executeAgentMigrationAdoptPlan(plan, rebind, new Date("2026-07-08T00:06:00.000Z"));
    assert.deepEqual(seen, ["start:gen-ready", "flip:gen-in-transit", "arrive:gen-arriving"]);
    assert.equal(result.report.migrationGeneration, "gen-arriving");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan DR plan uses only local directory plus server-side generation metadata", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const orphan = path.join(root, "orphan-workspace");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, "notes.md"), "hello\n");

    const serverRecordGeneration = generation({
      grantKey: "server-record-grant",
      migrationGeneration: "server-record-generation",
    });
    const plan = await buildAgentMigrationAdoptPlan({
      sourceKind: "orphan_directory",
      slockHome,
      orphanWorkspacePath: orphan,
      agentId: "agent-dr",
      generation: serverRecordGeneration,
      now: new Date("2026-07-08T00:10:00.000Z"),
    });

    assert.equal(plan.agentId, "agent-dr");
    assert.equal(plan.generation.grantKey, "server-record-grant");
    assert.equal(plan.generation.migrationGeneration, "server-record-generation");
    assert.equal(plan.manifest.files[0]?.workspaceRelativePath, "notes.md");
    assert.deepEqual(await verifyAgentMigrationAdoptPlan(plan), { fileCount: 1, totalBytes: 6 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation guard rejects stale source execution before server callbacks", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const orphan = path.join(root, "orphan-workspace");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, "notes.md"), "hello\n");
    const plan = await buildAgentMigrationAdoptPlan({
      sourceKind: "orphan_directory",
      slockHome,
      orphanWorkspacePath: orphan,
      agentId: "agent-4",
      generation: generation({ localMachineId: "source-machine" }),
    });
    const calls: string[] = [];
    await assert.rejects(
      () => executeAgentMigrationAdoptPlan(plan, {
        async startTransfer() {
          calls.push("startTransfer");
        },
        async flipMachine() {
          calls.push("flipMachine");
        },
        async markArrived() {
          calls.push("markArrived");
        },
      }),
      /MIGRATION_TARGET_MACHINE_MISMATCH/,
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final staged adoption rejects Windows drive-relative manifest paths before rebind", async () => {
  const root = tempRoot();
  try {
    const slockHome = path.join(root, ".slock");
    const staged = path.join(root, "staged-workspace");
    const unsafePath = "C:drive-relative.txt";
    mkdirSync(staged, { recursive: true });
    if (process.platform !== "win32") {
      writeFileSync(path.join(staged, unsafePath), "hello\n");
    }
    const baseManifest = manifest({ agentId: "agent-portable-path", slockHome, workspace: staged });
    const sourceManifest: AgentMigrationExportManifest = {
      ...baseManifest,
      files: baseManifest.files.map((entry) => ({
        ...entry,
        bundlePath: `workspace/${unsafePath}`,
        workspaceRelativePath: unsafePath,
      })),
    };
    const plan = await buildAgentMigrationAdoptPlan({
      sourceKind: "staged_bundle",
      slockHome,
      stagingWorkspacePath: staged,
      manifest: sourceManifest,
      manifestSha256: hashAgentMigrationManifest(sourceManifest),
      generation: generation(),
    });
    const calls: string[] = [];

    await assert.rejects(
      () => executeAgentMigrationAdoptPlan(plan, {
        async startTransfer() {
          calls.push("startTransfer");
        },
        async flipMachine() {
          calls.push("flipMachine");
        },
        async markArrived() {
          calls.push("markArrived");
        },
      }),
      /MIGRATION_MANIFEST_UNSAFE_PATH/,
    );
    assert.deepEqual(calls, []);
    assert.equal(existsSync(path.join(slockHome, "agents", "agent-portable-path")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
