import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "vitest";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import {
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AgentMigrationChunkDigestMismatchError,
  AgentMigrationWholeBundleDigestMismatchError,
  AgentMigrationWorkspaceConflictError,
  buildAgentMigrationResumableBundle,
  classifyAgentMigrationTargetResidue,
  missingAgentMigrationChunks,
  stageAndCommitAgentMigrationResumableBundle,
  validateAgentMigrationControlManifest,
  verifyAndStoreAgentMigrationChunk,
  type AgentMigrationControlManifest,
} from "./agentMigrationResumableBundle.js";
import { archiveCompletedAgentMigrationSourceWorkspace } from "./agentMigrationWorkspaceArchive.js";

test("resumable chunks reuse verified receipts and commit the staged workspace atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-roundtrip-"));
  const sourceHome = path.join(root, "source");
  const targetHome = path.join(root, "target");
  const workspace = path.join(sourceHome, "agents", "agent-1");
  const finalWorkspace = path.join(targetHome, "agents", "agent-1");
  try {
    await mkdir(path.join(workspace, "notes"), { recursive: true });
    await writeFile(path.join(workspace, "MEMORY.md"), "resume-nonce=phase-b\n");
    await writeFile(path.join(workspace, "notes", "payload.bin"), randomBytes(2_500_000));
    await writeFile(path.join(workspace, "notes", "small.txt"), "small\n");
    await symlink("../MEMORY.md", path.join(workspace, "notes", "memory-link"));
    const built = await buildAgentMigrationResumableBundle({
      agentId: "agent-1",
      migrationId: "migration-1",
      migrationGeneration: "generation-1",
      leaseId: "lease-1",
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      slockHome: sourceHome,
      workspacePath: workspace,
      maxBytes: 8 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
      spoolParentPath: path.join(root, "spool"),
    });
    assert.ok(built.control.bundle.chunks.length >= 3);
    assert.equal(built.control.archive.entryCount, 4);
    assert.equal(built.control.transferSummary.includedFileCount, built.control.archive.entryCount);
    assert.equal(built.control.transferSummary.includedBytes, built.control.archive.expandedBytes);
    assert.deepEqual(Object.keys(built.control.transferSummary).sort(), [
      "excludedRegenerableByCategory",
      "excludedRegenerableCount",
      "includedBytes",
      "includedFileCount",
      "keyWorkspaceEntries",
    ]);
    assert.ok(built.controlBytes < AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES);

    const initialResidue = await classifyAgentMigrationTargetResidue({
      control: built.control,
      controlSha256: built.controlSha256,
      slockHome: targetHome,
      finalWorkspacePath: finalWorkspace,
    });
    assert.equal(initialResidue.classification, "idle");
    const chunksDirectory = path.join(initialResidue.generationRootPath, "chunks");

    const first = await verifyAndStoreAgentMigrationChunk({
      control: built.control,
      chunkIndex: 0,
      chunk: built.openChunk(0),
      chunksDirectory,
    });
    assert.equal(first.outcome, "stored");
    const duplicate = await verifyAndStoreAgentMigrationChunk({
      control: built.control,
      chunkIndex: 0,
      chunk: Readable.from([Buffer.from("this body is never consumed")]),
      chunksDirectory,
    });
    assert.equal(duplicate.outcome, "reused");
    assert.deepEqual(
      await missingAgentMigrationChunks({ control: built.control, chunksDirectory }),
      built.control.bundle.chunks.slice(1).map((chunk) => chunk.index),
    );

    for (const chunk of built.control.bundle.chunks.slice(1).reverse()) {
      await verifyAndStoreAgentMigrationChunk({
        control: built.control,
        chunkIndex: chunk.index,
        chunk: built.openChunk(chunk.index),
        chunksDirectory,
      });
    }
    assert.deepEqual(await missingAgentMigrationChunks({ control: built.control, chunksDirectory }), []);
    assert.equal((await classifyAgentMigrationTargetResidue({
      control: built.control,
      slockHome: targetHome,
      finalWorkspacePath: finalWorkspace,
    })).classification, "failed-residue");

    const committed = await stageAndCommitAgentMigrationResumableBundle({
      control: built.control,
      controlSha256: built.controlSha256,
      slockHome: targetHome,
      chunksDirectory,
      finalWorkspacePath: finalWorkspace,
      now: new Date("2026-07-26T00:00:00.000Z"),
    });
    assert.equal(committed.outcome, "committed");
    assert.equal(await readFile(path.join(finalWorkspace, "MEMORY.md"), "utf8"), "resume-nonce=phase-b\n");
    assert.deepEqual(
      await readFile(path.join(finalWorkspace, "notes", "payload.bin")),
      await readFile(path.join(workspace, "notes", "payload.bin")),
    );
    assert.equal(await readlink(path.join(finalWorkspace, "notes", "memory-link")), "../MEMORY.md");
    assert.equal(await readFile(path.join(finalWorkspace, "notes", "memory-link"), "utf8"), "resume-nonce=phase-b\n");
    assert.equal(
      JSON.parse(await readFile(path.join(finalWorkspace, ...AGENT_MIGRATION_COMMIT_MARKER_PATH.split("/")), "utf8")).controlSha256,
      built.controlSha256,
    );

    const replay = await stageAndCommitAgentMigrationResumableBundle({
      control: built.control,
      controlSha256: built.controlSha256,
      slockHome: targetHome,
      chunksDirectory,
      finalWorkspacePath: finalWorkspace,
    });
    assert.equal(replay.outcome, "already-committed");
    assert.equal((await classifyAgentMigrationTargetResidue({
      control: built.control,
      slockHome: targetHome,
      finalWorkspacePath: finalWorkspace,
    })).classification, "complete-old-copy");

    assert.equal(await archiveCompletedAgentMigrationSourceWorkspace({
      slockHome: sourceHome,
      dataDir: path.join(sourceHome, "agents"),
      agentId: "agent-1",
      migrationId: "migration-1",
    }), "archived");

    const rebuilt = await buildAgentMigrationResumableBundle({
      agentId: "agent-1",
      migrationId: "migration-1-next",
      migrationGeneration: "generation-1-next",
      leaseId: "lease-1-next",
      sourceMachineId: "target-machine",
      targetMachineId: "next-machine",
      slockHome: targetHome,
      workspacePath: finalWorkspace,
      maxBytes: 8 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
      spoolParentPath: path.join(root, "next-spool"),
    });
    assert.equal(rebuilt.control.archive.entryCount, 4, "prior transport marker is never copied as user content");

    const returnResidue = await classifyAgentMigrationTargetResidue({
      control: rebuilt.control,
      controlSha256: rebuilt.controlSha256,
      slockHome: sourceHome,
      finalWorkspacePath: workspace,
    });
    assert.equal(returnResidue.classification, "idle", "source archive must free the exact A workspace path for return migration");
    const returnChunksDirectory = path.join(returnResidue.generationRootPath, "chunks");
    for (const chunk of rebuilt.control.bundle.chunks) {
      await verifyAndStoreAgentMigrationChunk({
        control: rebuilt.control,
        chunkIndex: chunk.index,
        chunk: rebuilt.openChunk(chunk.index),
        chunksDirectory: returnChunksDirectory,
      });
    }
    assert.equal((await stageAndCommitAgentMigrationResumableBundle({
      control: rebuilt.control,
      controlSha256: rebuilt.controlSha256,
      slockHome: sourceHome,
      chunksDirectory: returnChunksDirectory,
      finalWorkspacePath: workspace,
      now: new Date("2026-07-26T01:00:00.000Z"),
    })).outcome, "committed");
    assert.equal(await readFile(path.join(workspace, "MEMORY.md"), "utf8"), "resume-nonce=phase-b\n");
    assert.equal(
      JSON.parse(await readFile(path.join(workspace, ...AGENT_MIGRATION_COMMIT_MARKER_PATH.split("/")), "utf8")).migrationId,
      "migration-1-next",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk verification rejects a bad digest and never creates a reusable receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-bad-chunk-"));
  const workspace = path.join(root, "source", "agents", "agent-2");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "payload.bin"), randomBytes(1_500_000));
    const built = await buildAgentMigrationResumableBundle({
      agentId: "agent-2",
      migrationId: "migration-2",
      migrationGeneration: "generation-2",
      leaseId: "lease-2",
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      slockHome: path.join(root, "source"),
      workspacePath: workspace,
      maxBytes: 4 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
      spoolParentPath: path.join(root, "spool"),
    });
    const chunksDirectory = path.join(root, "chunks");
    await assert.rejects(
      verifyAndStoreAgentMigrationChunk({
        control: built.control,
        chunkIndex: 0,
        chunk: Readable.from([Buffer.alloc(built.control.bundle.chunks[0].sizeBytes, 0x78)]),
        chunksDirectory,
      }),
      AgentMigrationChunkDigestMismatchError,
    );
    assert.deepEqual(
      await missingAgentMigrationChunks({ control: built.control, chunksDirectory }),
      built.control.bundle.chunks.map((chunk) => chunk.index),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streamed archive validation rejects traversal and unsafe symlink headers", async () => {
  for (const malicious of [
    { name: "workspace/../escape.txt", type: "file" as const, body: Buffer.from("escape") },
    { name: "workspace/link", type: "symlink" as const, linkname: "../../escape", body: Buffer.alloc(0) },
    { name: "workspace/drive-absolute", type: "symlink" as const, linkname: "C:\\Users\\alice\\source-local-secret", body: Buffer.alloc(0) },
    { name: "workspace/drive-relative", type: "symlink" as const, linkname: "C:source-local-secret", body: Buffer.alloc(0) },
    { name: "workspace/unc", type: "symlink" as const, linkname: "\\\\server\\share\\source-local-secret", body: Buffer.alloc(0) },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-unsafe-"));
    try {
      const archive = await tarGzip(malicious);
      const control = controlForBundle(archive, {
        entryCount: 1,
        expandedBytes: malicious.type === "file" ? malicious.body.byteLength : 0,
        maxEntryBytes: malicious.type === "file" ? malicious.body.byteLength : 0,
      });
      const residue = await classifyAgentMigrationTargetResidue({
        control,
        slockHome: path.join(root, "home"),
        finalWorkspacePath: path.join(root, "home", "agents", "agent"),
      });
      const chunksDirectory = path.join(residue.generationRootPath, "chunks");
      await verifyAndStoreAgentMigrationChunk({
        control,
        chunkIndex: 0,
        chunk: Readable.from([archive]),
        chunksDirectory,
      });
      await assert.rejects(
        stageAndCommitAgentMigrationResumableBundle({
          control,
          slockHome: path.join(root, "home"),
          chunksDirectory,
          finalWorkspacePath: path.join(root, "home", "agents", "agent"),
        }),
        /MIGRATION_OBJECT_STORE_UNSAFE_(?:PATH|LINK)/,
      );
      assert.equal((await classifyAgentMigrationTargetResidue({
        control,
        slockHome: path.join(root, "home"),
        finalWorkspacePath: path.join(root, "home", "agents", "agent"),
      })).classification, "failed-residue");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("streamed archive validation rejects unsupported entry types and declared entry-size overflow", async () => {
  for (const malicious of [
    {
      entry: { name: "workspace/hard-link", type: "link" as const, linkname: "workspace/source", body: Buffer.alloc(0) },
      archive: { entryCount: 1, expandedBytes: 0, maxEntryBytes: 0 },
      expected: /MIGRATION_ARCHIVE_ENTRY_TYPE_UNSUPPORTED/,
    },
    {
      entry: { name: "workspace/too-large", type: "file" as const, body: Buffer.from("too large") },
      archive: { entryCount: 1, expandedBytes: 9, maxEntryBytes: 0 },
      expected: /MIGRATION_ARCHIVE_ENTRY_SIZE_INVALID/,
    },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-entry-contract-"));
    try {
      const bundle = await tarGzip(malicious.entry);
      const control = controlForBundle(bundle, malicious.archive);
      const residue = await classifyAgentMigrationTargetResidue({
        control,
        slockHome: root,
        finalWorkspacePath: path.join(root, "agents", "agent"),
      });
      const chunksDirectory = path.join(residue.generationRootPath, "chunks");
      await verifyAndStoreAgentMigrationChunk({
        control,
        chunkIndex: 0,
        chunk: Readable.from([bundle]),
        chunksDirectory,
      });
      await assert.rejects(
        stageAndCommitAgentMigrationResumableBundle({
          control,
          slockHome: root,
          chunksDirectory,
          finalWorkspacePath: path.join(root, "agents", "agent"),
        }),
        malicious.expected,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("whole-bundle verification is independent from per-chunk receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-whole-digest-"));
  try {
    const bundle = await tarGzip({ name: "workspace/file.txt", type: "file", body: Buffer.from("ok") });
    const control = controlForBundle(bundle, { entryCount: 1, expandedBytes: 2, maxEntryBytes: 2 });
    control.bundle.sha256 = "f".repeat(64);
    const residue = await classifyAgentMigrationTargetResidue({
      control,
      slockHome: root,
      finalWorkspacePath: path.join(root, "agents", "agent"),
    });
    const chunksDirectory = path.join(residue.generationRootPath, "chunks");
    await verifyAndStoreAgentMigrationChunk({
      control,
      chunkIndex: 0,
      chunk: Readable.from([bundle]),
      chunksDirectory,
    });
    await assert.rejects(
      stageAndCommitAgentMigrationResumableBundle({
        control,
        slockHome: root,
        chunksDirectory,
        finalWorkspacePath: path.join(root, "agents", "agent"),
      }),
      AgentMigrationWholeBundleDigestMismatchError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target residue classification distinguishes user-owned and complete old copies without deleting either", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-residue-classes-"));
  const archive = gzipSync(Buffer.from("not-read-in-this-test"));
  const control = controlForBundle(archive, { entryCount: 0, expandedBytes: 0, maxEntryBytes: 0 });
  try {
    const userOwned = path.join(root, "user-owned");
    await mkdir(userOwned, { recursive: true });
    await writeFile(path.join(userOwned, "MEMORY.md"), "user data\n");
    assert.equal((await classifyAgentMigrationTargetResidue({
      control,
      slockHome: root,
      finalWorkspacePath: userOwned,
    })).classification, "user-owned");
    await assert.rejects(
      stageAndCommitAgentMigrationResumableBundle({
        control,
        slockHome: root,
        chunksDirectory: path.join(root, "missing-chunks"),
        finalWorkspacePath: userOwned,
      }),
      AgentMigrationWorkspaceConflictError,
    );
    assert.equal(await readFile(path.join(userOwned, "MEMORY.md"), "utf8"), "user data\n");

    const oldCopy = path.join(root, "old-copy");
    await mkdir(path.join(oldCopy, ".raft-migration"), { recursive: true });
    await writeFile(path.join(oldCopy, AGENT_MIGRATION_COMMIT_MARKER_PATH), JSON.stringify({
      schemaVersion: "agent-migration-commit/v1",
      migrationId: "old",
      migrationGeneration: "old-generation",
      leaseId: "old-lease",
      agentId: "agent",
      sourceMachineId: "source",
      targetMachineId: "target",
      controlSha256: "a".repeat(64),
      bundleSha256: "b".repeat(64),
      committedAt: "2026-07-25T00:00:00.000Z",
    }));
    assert.equal((await classifyAgentMigrationTargetResidue({
      control,
      slockHome: root,
      finalWorkspacePath: oldCopy,
    })).classification, "complete-old-copy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit rejects a target workspace created after the earlier idle classification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-late-workspace-conflict-"));
  const finalWorkspacePath = path.join(root, "agents", "agent");
  try {
    const bundle = await tarGzip({
      name: "workspace/MEMORY.md",
      type: "file",
      body: Buffer.from("incoming\n"),
    });
    const control = controlForBundle(bundle, {
      entryCount: 1,
      expandedBytes: 9,
      maxEntryBytes: 9,
    });
    const residue = await classifyAgentMigrationTargetResidue({
      control,
      slockHome: root,
      finalWorkspacePath,
    });
    assert.equal(residue.classification, "idle", "earlier residue classification should observe no workspace");
    const chunksDirectory = path.join(residue.generationRootPath, "chunks");
    await verifyAndStoreAgentMigrationChunk({
      control,
      chunkIndex: 0,
      chunk: Readable.from([bundle]),
      chunksDirectory,
    });

    await assert.rejects(
      stageAndCommitAgentMigrationResumableBundle({
        control,
        slockHome: root,
        chunksDirectory,
        finalWorkspacePath,
      }, {
        renameWorkspace: async (sourcePath, targetPath) => {
          await mkdir(targetPath, { recursive: true });
          await writeFile(path.join(targetPath, "MEMORY.md"), "late user data\n");
          await rename(sourcePath, targetPath);
        },
      }),
      AgentMigrationWorkspaceConflictError,
    );
    assert.equal(
      await readFile(path.join(finalWorkspacePath, "MEMORY.md"), "utf8"),
      "late user data\n",
      "commit-time TOCTOU fence must preserve the late workspace",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a 10GB-shaped bundle keeps the O(chunks) control manifest inside its fixed budget", () => {
  const chunkSizeBytes = 8 * 1024 * 1024;
  const totalBytes = 10 * 1024 * 1024 * 1024;
  const chunkCount = totalBytes / chunkSizeBytes;
  const chunks = Array.from({ length: chunkCount }, (_, index) => ({
    index,
    offsetBytes: index * chunkSizeBytes,
    sizeBytes: chunkSizeBytes,
    sha256: createHash("sha256").update(`chunk-${index}`).digest("hex"),
  }));
  const control: AgentMigrationControlManifest = {
    ...baseControl(),
    bundle: {
      contentType: "application/vnd.raft.agent-migration-bundle+tar+gzip",
      totalBytes,
      sha256: "f".repeat(64),
      chunkSizeBytes,
      chunks,
    },
    archive: {
      format: "tar+gzip",
      entryCount: 250_000,
      expandedBytes: totalBytes,
      maxEntryBytes: totalBytes,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: transferSummaryForArchive(250_000, totalBytes),
  };
  const validated = validateAgentMigrationControlManifest(control);
  assert.equal(chunkCount, 1_280);
  assert.ok(validated.bytes < AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES);
  assert.throws(
    () => validateAgentMigrationControlManifest({
      ...control,
      transferSummary: { ...control.transferSummary, includedBytes: totalBytes - 1 },
    }),
    /MIGRATION_CONTROL_TRANSFER_SUMMARY_INVALID/,
  );
  assert.throws(
    () => validateAgentMigrationControlManifest({
      ...control,
      schemaVersion: "agent-migration-control/v1",
    } as unknown as AgentMigrationControlManifest),
    /MIGRATION_CONTROL_MANIFEST_SCHEMA_UNSUPPORTED/,
  );
});

function baseControl(): Omit<AgentMigrationControlManifest, "bundle" | "archive" | "transferSummary"> {
  return {
    schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    identity: {
      migrationId: "migration",
      migrationGeneration: "generation",
      leaseId: "lease",
      agentId: "agent",
      sourceMachineId: "source",
      targetMachineId: "target",
    },
    capability: { required: AGENT_MIGRATION_RESUMABLE_CAPABILITIES },
    commit: {
      mode: "atomic-rename",
      markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
      requireWholeBundleDigest: true,
      requireAllChunkDigests: true,
      existingWorkspace: "idle-or-same-commit",
    },
  };
}

function controlForBundle(
  bundle: Buffer,
  archive: Pick<AgentMigrationControlManifest["archive"], "entryCount" | "expandedBytes" | "maxEntryBytes">,
): AgentMigrationControlManifest {
  return {
    ...baseControl(),
    bundle: {
      contentType: "application/vnd.raft.agent-migration-bundle+tar+gzip",
      totalBytes: bundle.byteLength,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      chunkSizeBytes: 1024 * 1024,
      chunks: [{
        index: 0,
        offsetBytes: 0,
        sizeBytes: bundle.byteLength,
        sha256: createHash("sha256").update(bundle).digest("hex"),
      }],
    },
    archive: {
      format: "tar+gzip",
      ...archive,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: transferSummaryForArchive(archive.entryCount, archive.expandedBytes),
  };
}

function transferSummaryForArchive(includedFileCount: number, includedBytes: number) {
  return {
    includedFileCount,
    includedBytes,
    excludedRegenerableCount: 0,
    excludedRegenerableByCategory: {
      thirdPartyDependencies: 0,
      caches: 0,
      buildArtifacts: 0,
      otherRegenerable: 0,
    },
    keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
  };
}

async function tarGzip(entry: {
  name: string;
  type: "file" | "symlink" | "link";
  linkname?: string;
  body: Buffer;
}): Promise<Buffer> {
  const tarPack = pack();
  const chunks: Buffer[] = [];
  const completion = new Promise<Buffer>((resolve, reject) => {
    tarPack.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    tarPack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    tarPack.on("error", reject);
  });
  tarPack.entry({
    name: entry.name,
    type: entry.type,
    linkname: entry.linkname,
    size: entry.body.byteLength,
  }, entry.body);
  tarPack.finalize();
  return await completion;
}
