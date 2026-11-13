import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import {
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AgentMigrationChunkDigestMismatchError,
  AgentMigrationWholeBundleDigestMismatchError,
  AgentMigrationWorkspaceConflictError,
  classifyAgentMigrationTargetResidue,
  missingAgentMigrationChunks,
  pipeFileExactly,
  readFileExactly,
  stageAndCommitAgentMigrationResumableBundle,
  type AgentMigrationPlacementStep,
  streamAgentMigrationResumableBundle,
  validateAgentMigrationControlManifest,
  verifyAndStoreAgentMigrationChunk,
  type AgentMigrationControlChunk,
  type AgentMigrationControlManifest,
  type StreamAgentMigrationResumableBundleInput,
} from "./agentMigrationResumableBundle";
import { AgentMigrationObjectStoreEntryCountLimitError } from "./agentMigrationObjectStoreBundle";
import { archiveCompletedAgentMigrationSourceWorkspace } from "./agentMigrationWorkspaceArchive";

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
    const built = await buildBundle({
      agentId: "agent-1",
      migrationId: "migration-1",
      migrationGeneration: "generation-1",
      leaseId: "lease-1",
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      workspacePath: workspace,
      maxBytes: 8 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
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

    const rebuilt = await buildBundle({
      agentId: "agent-1",
      migrationId: "migration-1-next",
      migrationGeneration: "generation-1-next",
      leaseId: "lease-1-next",
      sourceMachineId: "target-machine",
      targetMachineId: "next-machine",
      workspacePath: finalWorkspace,
      maxBytes: 8 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
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
    const built = await buildBundle({
      agentId: "agent-2",
      migrationId: "migration-2",
      migrationGeneration: "generation-2",
      leaseId: "lease-2",
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      workspacePath: workspace,
      maxBytes: 4 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
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
    capability: { required: [AGENT_MIGRATION_CAPABILITY] },
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

test("bundle build reports progress in phase order with growing counts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-progress-"));
  const workspace = path.join(root, "source", "agents", "agent-3");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "a.bin"), randomBytes(600_000));
    await writeFile(path.join(workspace, "b.bin"), randomBytes(900_000));
    const reports: { phase: string; files: number; bytes: number }[] = [];
    await streamToMemory(workspace, { onProgress: (progress) => reports.push({ ...progress }) });
    const phases = ["scanning", "packing"];
    for (let index = 1; index < reports.length; index += 1) {
      const previous = reports[index - 1];
      const current = reports[index];
      const phaseOrder = phases.indexOf(current.phase) - phases.indexOf(previous.phase);
      assert.ok(phaseOrder >= 0, `phase went backwards at report ${index}`);
      if (phaseOrder === 0) {
        assert.ok(current.files >= previous.files && current.bytes >= previous.bytes, `counts shrank at report ${index}`);
      }
    }
    assert.ok(reports.every((report) => phases.includes(report.phase)), "nothing is re-read after packing");
    assert.deepEqual(reports.at(-1), { phase: "packing", files: 2, bytes: 1_500_000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const streamIdentity = {
  agentId: "agent-stream",
  migrationId: "migration-stream",
  migrationGeneration: "generation-stream",
  leaseId: "lease-stream",
  sourceMachineId: "source-machine",
  targetMachineId: "target-machine",
};

/** Streams a workspace and keeps every uploaded chunk, in upload order. */
async function streamToMemory(
  workspacePath: string,
  overrides: Partial<StreamAgentMigrationResumableBundleInput> = {},
  uploadDelayMs = 5,
) {
  const uploaded = new Map<number, Buffer>();
  const uploadOrder: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const streamed = await streamAgentMigrationResumableBundle({
    ...streamIdentity,
    workspacePath,
    maxBytes: 16 * 1024 * 1024,
    maxEntries: 100,
    chunkSizeBytes: 1024 * 1024,
    async uploadChunk(chunk: AgentMigrationControlChunk, bytes: Buffer) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, uploadDelayMs));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), chunk.sha256);
      assert.equal(bytes.byteLength, chunk.sizeBytes);
      uploaded.set(chunk.index, Buffer.from(bytes));
      uploadOrder.push(chunk.index);
      inFlight -= 1;
    },
    ...overrides,
  });
  return { ...streamed, uploaded, uploadOrder, maxInFlight };
}

test("the streamed summary carries excludedIgnoredBySource only for a Server that accepts it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-ignore-sources-"));
  const workspace = path.join(root, "agents", "agent-ignore-sources");
  try {
    await mkdir(path.join(workspace, "scratch"), { recursive: true });
    await mkdir(path.join(workspace, "repo", "checkout"), { recursive: true });
    await writeFile(path.join(workspace, "MEMORY.md"), "memory\n");
    await writeFile(path.join(workspace, "scratch", "big.log"), "ignored\n");
    await writeFile(path.join(workspace, "repo", "checkout", "x"), "abc");
    await writeFile(path.join(workspace, ".raftmigrateignore"), "scratch\n");
    await writeFile(path.join(workspace, ".raftbackupignore"), "**/checkout\n");
    const excludedIgnored = {
      count: 2,
      fileCount: 2,
      bytes: 11,
      largest: [{ path: "scratch", bytes: 8 }, { path: "repo/checkout", bytes: 3 }],
    };

    const older = await streamToMemory(workspace, {}, 0);
    assert.deepEqual(older.control.transferSummary.excludedIgnored, excludedIgnored);
    assert.equal("excludedIgnoredBySource" in older.control.transferSummary, false);

    const current = await streamToMemory(workspace, { reportIgnoredBySource: () => true }, 0);
    assert.deepEqual(current.control.transferSummary.excludedIgnored, excludedIgnored);
    assert.deepEqual(current.control.transferSummary.excludedIgnoredBySource, {
      userFile: { count: 0, fileCount: 0, bytes: 0 },
      agentFile: { count: 1, fileCount: 1, bytes: 3 },
      legacyFile: { count: 1, fileCount: 1, bytes: 8 },
      wildcard: { count: 1, fileCount: 1, bytes: 3 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Streams a workspace to memory and serves its chunks back, for target-side tests. */
async function buildBundle(input: Partial<StreamAgentMigrationResumableBundleInput> & { workspacePath: string }) {
  const streamed = await streamToMemory(input.workspacePath, input, 0);
  return {
    ...streamed,
    openChunk: (chunkIndex: number) => Readable.from([streamed.uploaded.get(chunkIndex)!]),
  };
}

test("a streamed bundle commits on the target with its transfer summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-roundtrip-"));
  const sourceHome = path.join(root, "source");
  const targetHome = path.join(root, "target");
  const workspace = path.join(sourceHome, "agents", "agent-stream");
  const finalWorkspace = path.join(targetHome, "agents", "agent-stream");
  try {
    await mkdir(path.join(workspace, "notes"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules", "dep"), { recursive: true });
    await mkdir(path.join(workspace, "scratch"), { recursive: true });
    await mkdir(path.join(workspace, ".raft-migration"), { recursive: true });
    await writeFile(path.join(workspace, "MEMORY.md"), "streamed\n");
    await writeFile(path.join(workspace, "notes", "payload.bin"), randomBytes(2_500_000));
    await writeFile(path.join(workspace, "notes", "empty.txt"), "");
    await symlink("../MEMORY.md", path.join(workspace, "notes", "memory-link"));
    await writeFile(path.join(workspace, "node_modules", "dep", "index.js"), "regenerable\n");
    await writeFile(path.join(workspace, "scratch", "big.log"), "ignored\n");
    await writeFile(path.join(workspace, ".raftmigrateignore"), "scratch\n");
    // A past migration's commit marker is never moved.
    await writeFile(path.join(workspace, ...AGENT_MIGRATION_COMMIT_MARKER_PATH.split("/")), "{}");

    const reports: { phase: string; files: number; bytes: number }[] = [];
    // Slow uploads, so packing runs ahead until every upload slot is taken.
    const streamed = await streamToMemory(workspace, { onProgress: (progress) => reports.push({ ...progress }) }, 300);

    assert.ok(streamed.control.bundle.chunks.length >= 3);
    assert.ok(streamed.maxInFlight > 1, "chunks upload concurrently");
    assert.ok(streamed.maxInFlight <= 3, "at most three chunks are held for upload");
    assert.deepEqual([...streamed.uploaded.keys()].sort((a, b) => a - b), streamed.control.bundle.chunks.map((chunk) => chunk.index));
    assert.equal(streamed.control.archive.entryCount, 5);
    assert.deepEqual(streamed.control.transferSummary, {
      includedFileCount: 5,
      includedBytes: streamed.control.archive.expandedBytes,
      excludedRegenerableCount: 1,
      excludedRegenerableByCategory: { thirdPartyDependencies: 1, caches: 0, buildArtifacts: 0, otherRegenerable: 0 },
      keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: true },
      excludedIgnored: { count: 1, fileCount: 1, bytes: 8, largest: [{ path: "scratch", bytes: 8 }] },
    });
    assert.equal(streamed.resizedEntryCount, 0);
    const wholeBundle = Buffer.concat(streamed.control.bundle.chunks.map((chunk) => streamed.uploaded.get(chunk.index)!));
    assert.equal(createHash("sha256").update(wholeBundle).digest("hex"), streamed.control.bundle.sha256);
    assert.equal(wholeBundle.byteLength, streamed.control.bundle.totalBytes);
    assert.deepEqual(reports.filter((report) => report.phase === "packing").at(-1), {
      phase: "packing",
      files: 5,
      bytes: streamed.control.archive.expandedBytes,
    });
    assert.equal(reports.some((report) => report.phase === "hashing"), false, "nothing is re-read after packing");

    const residue = await classifyAgentMigrationTargetResidue({
      control: streamed.control,
      controlSha256: streamed.controlSha256,
      slockHome: targetHome,
      finalWorkspacePath: finalWorkspace,
    });
    const chunksDirectory = path.join(residue.generationRootPath, "chunks");
    const steps: string[] = [];
    const traceStep = async <T>(step: AgentMigrationPlacementStep, work: () => Promise<T>): Promise<T> => {
      try {
        const result = await work();
        steps.push(`${step}:ok`);
        return result;
      } catch (error) {
        steps.push(`${step}:failed`);
        throw error;
      }
    };
    const stage = () => stageAndCommitAgentMigrationResumableBundle({
      control: streamed.control,
      controlSha256: streamed.controlSha256,
      slockHome: targetHome,
      chunksDirectory,
      finalWorkspacePath: finalWorkspace,
    }, { traceStep });
    await assert.rejects(stage(), /MIGRATION_CHUNKS_MISSING/);
    assert.deepEqual(steps, ["verify:failed"], "nothing is unpacked while chunks are missing");
    steps.length = 0;
    for (const chunk of streamed.control.bundle.chunks) {
      await verifyAndStoreAgentMigrationChunk({
        control: streamed.control,
        chunkIndex: chunk.index,
        chunk: Readable.from([streamed.uploaded.get(chunk.index)!]),
        chunksDirectory,
      });
    }
    const committed = await stage();
    assert.equal(committed.outcome, "committed");
    assert.deepEqual(steps, ["verify:ok", "unpack:ok", "commit:ok"]);
    assert.equal(await readFile(path.join(finalWorkspace, "MEMORY.md"), "utf8"), "streamed\n");
    assert.deepEqual(
      await readFile(path.join(finalWorkspace, "notes", "payload.bin")),
      await readFile(path.join(workspace, "notes", "payload.bin")),
    );
    assert.equal(await readFile(path.join(finalWorkspace, "notes", "empty.txt"), "utf8"), "");
    assert.equal(await readlink(path.join(finalWorkspace, "notes", "memory-link")), "../MEMORY.md");
    await assert.rejects(readFile(path.join(finalWorkspace, "scratch", "big.log")), /ENOENT/);
    await assert.rejects(readFile(path.join(finalWorkspace, "node_modules", "dep", "index.js")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe symlink targets are never bundled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-unsafe-link-"));
  const workspace = path.join(root, "workspace");
  const unsafeTargets = [
    path.join(root, "source-local-secret"),
    "C:\\Users\\alice\\source-local-secret",
    "C:source-local-secret",
    "\\\\server\\share\\source-local-secret",
  ];
  try {
    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await writeFile(path.join(workspace, "target-file"), "content\n");
    await symlink("../target-file", path.join(workspace, "nested", "safe-link"));
    for (const [index, target] of unsafeTargets.entries()) {
      await symlink(target, path.join(workspace, `unsafe-link-${index}`));
    }
    const streamed = await streamToMemory(workspace);
    assert.equal(streamed.control.archive.entryCount, 2);
    const tarBytes = gunzipSync(Buffer.concat(streamed.control.bundle.chunks.map((chunk) => streamed.uploaded.get(chunk.index)!)));
    assert.ok(tarBytes.includes("workspace/nested/safe-link"));
    assert.ok(tarBytes.includes("../target-file"));
    assert.equal(tarBytes.includes("unsafe-link-"), false);
    for (const target of unsafeTargets) assert.equal(tarBytes.includes(target), false, target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming the same workspace twice yields the same chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-deterministic-"));
  try {
    await mkdir(path.join(root, "b"), { recursive: true });
    await writeFile(path.join(root, "a.bin"), randomBytes(1_500_000));
    await writeFile(path.join(root, "b", "c.txt"), "c\n");
    await symlink("a.bin", path.join(root, "link"));
    const first = await streamToMemory(root);
    const second = await streamToMemory(root);
    assert.deepEqual(second.control.bundle, first.control.bundle);
    assert.equal(second.controlSha256, first.controlSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a streamed bundle over the entry limit fails with the exact count before reading or uploading anything", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-limit-"));
  const unreadable = path.join(root, "a", "1");
  try {
    await mkdir(path.join(root, "a"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    for (const name of ["1", "2", "3"]) await writeFile(path.join(root, "a", name), name);
    await writeFile(path.join(root, "node_modules", "x.js"), "x");
    await writeFile(path.join(root, "MEMORY.md"), "m");
    // The first file walked is unreadable: over the limit nothing may be read.
    await chmod(unreadable, 0o000);
    let uploads = 0;
    const reports: { phase: string; files: number; bytes: number }[] = [];
    await assert.rejects(
      streamAgentMigrationResumableBundle({
        ...streamIdentity,
        workspacePath: root,
        maxBytes: 1024 * 1024,
        maxEntries: 3,
        onProgress: (progress) => reports.push({ ...progress }),
        async uploadChunk() {
          uploads += 1;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AgentMigrationObjectStoreEntryCountLimitError);
        assert.equal(error.entryCount, 4);
        assert.equal(error.maxEntries, 3);
        return true;
      },
    );
    assert.equal(uploads, 0);
    assert.equal(reports.some((report) => report.phase !== "scanning"), false);
  } finally {
    await chmod(unreadable, 0o644).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a streamed bundle over the byte limit names the largest top-level paths in the whole workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-too-large-"));
  try {
    await mkdir(path.join(root, "a"), { recursive: true });
    await mkdir(path.join(root, "z"), { recursive: true });
    // Incompressible, so the limit trips inside a/ and z/ is never packed:
    // the largest path is still reported, by its uncompressed size.
    await writeFile(path.join(root, "a", "1.bin"), randomBytes(2_500_000));
    await writeFile(path.join(root, "z", "1.bin"), randomBytes(2_500_000));
    await writeFile(path.join(root, "z", "2.bin"), randomBytes(2_500_000));
    await writeFile(path.join(root, "MEMORY.md"), "m");
    await writeFile(path.join(root, ".env"), "SECRET=1");
    await assert.rejects(
      streamToMemory(root, { maxBytes: 2_000_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=\d+:maxBytes=2000000:topEntries=z%2F,5000000;a%2F,2500000;(MEMORY\.md|other%2F),\d+$/,
        );
        assert.doesNotMatch(error.message, /\.env/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a workspace that compresses under the byte limit but is over the summary's uncompressed cap fails as too large, not as a validation error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-expanded-too-large-"));
  try {
    await mkdir(path.join(root, "a"), { recursive: true });
    await mkdir(path.join(root, "z"), { recursive: true });
    // Zeros compress to almost nothing, so only the uncompressed total is over.
    await writeFile(path.join(root, "a", "1.bin"), Buffer.alloc(1_500_000));
    await writeFile(path.join(root, "z", "1.bin"), Buffer.alloc(1_500_000));
    await writeFile(path.join(root, "z", "2.bin"), Buffer.alloc(1_500_000));
    await writeFile(path.join(root, "MEMORY.md"), "m");
    await assert.rejects(
      streamToMemory(root, { maxBytes: 100_000_000, maxExpandedBytes: 2_000_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=4500001:maxBytes=2000000:topEntries=z%2F,3000000;a%2F,1500000;MEMORY\.md,1$/,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed chunk upload fails the streamed bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-upload-failure-"));
  try {
    await writeFile(path.join(root, "payload.bin"), randomBytes(4_000_000));
    await assert.rejects(
      streamToMemory(root, {
        async uploadChunk(chunk) {
          if (chunk.index === 1) throw new Error("MIGRATION_CHUNK_UPLOAD_FAILED:503");
        },
      }),
      /MIGRATION_CHUNK_UPLOAD_FAILED:503/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file whose size changed after it was listed is cut or zero-padded to the size in its tar header", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-resized-"));
  try {
    const file = path.join(root, "file.txt");
    await writeFile(file, "0123456789");
    const collect = async (sizeBytes: number) => {
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on("data", (chunk: Buffer) => chunks.push(chunk));
      const handle = await open(file, "r");
      try {
        const result = await pipeFileExactly(handle, sizeBytes, sink);
        return { ...result, bytes: Buffer.concat(chunks) };
      } finally {
        await handle.close();
      }
    };
    const grown = await collect(4);
    assert.equal(grown.bytes.toString("utf8"), "0123");
    assert.equal(grown.sizeAfterRead, 10);
    const shrunk = await collect(14);
    assert.deepEqual(shrunk.bytes, Buffer.concat([Buffer.from("0123456789"), Buffer.alloc(4)]));
    assert.equal(shrunk.readBytes, 10);
    const unchanged = await collect(10);
    assert.equal(unchanged.bytes.toString("utf8"), "0123456789");
    assert.equal(unchanged.readBytes, 10);
    assert.equal(unchanged.sizeAfterRead, 10);
    // Small files take the in-memory path with the same rule.
    assert.deepEqual(await readFileExactly(file, 4), { bytes: Buffer.from("0123"), resized: true });
    assert.deepEqual(await readFileExactly(file, 12), { bytes: Buffer.from("0123456789\0\0"), resized: true });
    assert.deepEqual(await readFileExactly(file, 10), { bytes: Buffer.from("0123456789"), resized: false });
    assert.equal(await readFileExactly(path.join(root, "vanished.txt"), 3), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive validation rejects an entry under a symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-symlink-ancestor-"));
  try {
    const tarPack = pack();
    const parts: Buffer[] = [];
    const tarDone = new Promise<Buffer>((resolve, reject) => {
      tarPack.on("data", (chunk: Buffer) => parts.push(Buffer.from(chunk)));
      tarPack.on("end", () => resolve(gzipSync(Buffer.concat(parts))));
      tarPack.on("error", reject);
    });
    tarPack.entry({ name: "workspace/dir/link", type: "symlink", linkname: "elsewhere", size: 0 }, Buffer.alloc(0));
    tarPack.entry({ name: "workspace/dir/link/inside.txt", type: "file", size: 1 }, Buffer.from("x"));
    tarPack.finalize();
    const archive = await tarDone;
    const control = controlForBundle(archive, { entryCount: 2, expandedBytes: 1, maxEntryBytes: 1 });
    const residue = await classifyAgentMigrationTargetResidue({
      control,
      slockHome: path.join(root, "home"),
      finalWorkspacePath: path.join(root, "home", "agents", "agent"),
    });
    const chunksDirectory = path.join(residue.generationRootPath, "chunks");
    await verifyAndStoreAgentMigrationChunk({ control, chunkIndex: 0, chunk: Readable.from([archive]), chunksDirectory });
    await assert.rejects(
      stageAndCommitAgentMigrationResumableBundle({
        control,
        slockHome: path.join(root, "home"),
        chunksDirectory,
        finalWorkspacePath: path.join(root, "home", "agents", "agent"),
      }),
      /MIGRATION_ARCHIVE_SYMLINK_ANCESTOR/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a large file deleted after it was listed is skipped, like a small one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-streamed-vanished-"));
  try {
    await writeFile(path.join(root, "a.txt"), "a\n");
    await writeFile(path.join(root, "b-large.bin"), randomBytes(1_500_000));
    await writeFile(path.join(root, "c.txt"), "c\n");
    // Delete the large file once packing has started (after the first entry).
    let deleted = false;
    const streamed = await streamToMemory(root, {
      onProgress(progress) {
        if (progress.phase === "packing" && !deleted) {
          deleted = true;
          unlinkSync(path.join(root, "b-large.bin"));
        }
      },
    });
    assert.ok(deleted);
    assert.equal(streamed.control.archive.entryCount, 2);
    assert.equal(streamed.control.archive.expandedBytes, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a chunk stream that breaks mid-body leaves no partial file; a digest mismatch keeps its partial", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-resumable-partial-"));
  const workspace = path.join(root, "source", "agents", "agent-1");
  const chunksDirectory = path.join(root, "chunks");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "payload.bin"), randomBytes(1_500_000));
    const built = await buildBundle({ workspacePath: workspace, chunkSizeBytes: 1024 * 1024 });
    const listPartials = async () => (await readdir(chunksDirectory)).filter((name) => name.includes(".partial-"));

    // The connection drops after some bytes: the caller retries this chunk, so
    // each failed attempt must not leave its partial behind.
    // The break comes from the stream itself, never from a timer: a timer can
    // fire before the reader is attached, and the error then has no listener
    // (unhandled "socket hang up" on slow CI). It waits until the first bytes
    // are on disk, so the break really is mid-body.
    const partialHasData = async () => {
      for (const name of await listPartials()) {
        if ((await stat(path.join(chunksDirectory, name))).size > 0) return true;
      }
      return false;
    };
    const dropped = Readable.from((async function* () {
      yield randomBytes(4096);
      while (!(await partialHasData())) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("socket hang up");
    })());
    await assert.rejects(
      verifyAndStoreAgentMigrationChunk({ control: built.control, chunkIndex: 0, chunk: dropped, chunksDirectory }),
      /socket hang up/,
    );
    assert.deepEqual(await listPartials(), []);

    // Wrong bytes of the right length are corrupt, not a network blip: keep them.
    const expected = built.control.bundle.chunks[0]!;
    await assert.rejects(
      verifyAndStoreAgentMigrationChunk({
        control: built.control,
        chunkIndex: 0,
        chunk: Readable.from([Buffer.alloc(expected.sizeBytes)]),
        chunksDirectory,
      }),
      AgentMigrationChunkDigestMismatchError,
    );
    assert.equal((await listPartials()).length, 1);

    const stored = await verifyAndStoreAgentMigrationChunk({
      control: built.control,
      chunkIndex: 0,
      chunk: built.openChunk(0),
      chunksDirectory,
    });
    assert.equal(stored.outcome, "stored");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
