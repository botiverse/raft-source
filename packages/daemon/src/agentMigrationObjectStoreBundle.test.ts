import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "vitest";
import { gunzipSync, createGzip } from "node:zlib";
import { extract, pack, type Headers } from "tar-stream";
import {
  AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION,
  AgentMigrationObjectStoreBundleTooLargeError,
  AgentMigrationObjectStoreEntryCountLimitError,
  AgentMigrationObjectStoreInsufficientDiskError,
  AgentMigrationObjectStoreManifestTooLargeError,
  assertAgentMigrationObjectStoreEntryLimit,
  buildAgentMigrationObjectStoreBundle,
  largestWorkspaceEntryCounts,
  largestWorkspaceEntries,
  stageAgentMigrationObjectStoreBundle,
} from "./agentMigrationObjectStoreBundle.js";
import { buildAgentMigrationExportManifest } from "./agentMigrationExport.js";
import { normalizeAgentMigrationWorkspaceRelativePath } from "./agentMigrationWorkspacePath.js";

test("streaming tar.gz round-trips workspace state without host tar/gzip on PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-roundtrip-"));
  const sourceHome = path.join(root, "source-home");
  const targetHome = path.join(root, "target-home");
  const workspace = path.join(sourceHome, "agents", "agent-tar");
  const previousPath = process.env.PATH;
  try {
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(workspace, "MEMORY.md"), "continuity-nonce=tar-v2\n");
    await writeFile(path.join(workspace, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    await writeFile(path.join(workspace, "payload.bin"), Buffer.alloc(4 * 1024 * 1024, 0x5a));
    await writeFile(path.join(workspace, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(workspace, "run.sh"), 0o755);
    await writeFile(path.join(workspace, "node_modules", "ignored", "index.js"), "regenerate me\n");
    await symlink("MEMORY.md", path.join(workspace, "memory-link"));
    process.env.PATH = "";

    const maxBytes = 64 * 1024;
    const built = await buildAgentMigrationObjectStoreBundle({
      agentId: "agent-tar",
      slockHome: sourceHome,
      workspacePath: workspace,
      maxBytes,
    });
    const archive = await readStream(built.bundle);
    assert.ok(built.contentBytes > maxBytes, "uncompressed workspace may exceed the upload limit");
    assert.ok(archive.byteLength < maxBytes, "the final compressed archive is the gated payload");
    assert.equal(gunzipSync(archive).subarray(257, 262).toString("ascii"), "ustar");
    const uncompressedArchive = gunzipSync(archive).toString("utf8");
    assert.doesNotMatch(uncompressedArchive, new RegExp(escapeRegExp(sourceHome)));
    assert.doesNotMatch(uncompressedArchive, new RegExp(escapeRegExp(workspace)));
    assert.ok(built.manifest.files.some((entry) => entry.workspaceRelativePath === ".git/config"));
    assert.ok(!built.manifest.files.some((entry) => entry.workspaceRelativePath?.startsWith("node_modules/")));

    const staged = await stageAgentMigrationObjectStoreBundle({
      bundle: Readable.from([archive]),
      slockHome: targetHome,
      sessionId: "session-tar",
      maxBytes,
    });
    assert.equal(staged.manifest.agentId, "agent-tar");
    assert.equal(
      await readFile(path.join(staged.stagingWorkspacePath, "MEMORY.md"), "utf8"),
      "continuity-nonce=tar-v2\n",
    );
    assert.equal(
      await readFile(path.join(staged.stagingWorkspacePath, ".git", "config"), "utf8"),
      "[core]\nrepositoryformatversion = 0\n",
    );
    assert.equal(
      await readFile(path.join(staged.stagingWorkspacePath, "memory-link"), "utf8"),
      "continuity-nonce=tar-v2\n",
    );
    assert.equal(
      await readlink(path.join(staged.stagingWorkspacePath, "memory-link")),
      "MEMORY.md",
    );
    assert.equal((await stat(path.join(staged.stagingWorkspacePath, "run.sh"))).mode & 0o777, 0o755);
    await assert.rejects(
      readFile(path.join(staged.stagingWorkspacePath, "node_modules", "ignored", "index.js")),
      /ENOENT/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("tar linknames conserve safe relative links and never carry source-root-bearing targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-link-safety-"));
  const workspace = path.join(root, "source-home", "agents", "agent-link-safety");
  const sourceLocalTarget = path.join(root, "source-local-secret");
  try {
    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await writeFile(path.join(workspace, "target-file"), "safe\n");
    await symlink("../target-file", path.join(workspace, "nested", "safe-link"));
    await symlink(sourceLocalTarget, path.join(workspace, "unsafe-link"));

    const built = await buildAgentMigrationObjectStoreBundle({
      agentId: "agent-link-safety",
      slockHome: path.join(root, "source-home"),
      workspacePath: workspace,
      maxBytes: 1024 * 1024,
    });
    const archive = await readStream(built.bundle);
    const headers = await readTarHeaders(archive);
    const safeLink = headers.find((header) => header.name === "workspace/nested/safe-link");

    assert.equal(safeLink?.type, "symlink");
    assert.equal(safeLink?.linkname, "../target-file");
    assert.equal(headers.some((header) => header.name === "workspace/unsafe-link"), false);
    assert.equal(headers.some((header) => header.linkname?.includes(sourceLocalTarget)), false);
    assert.equal(JSON.stringify(built.manifest).includes(sourceLocalTarget), false);
    assert.deepEqual(
      built.manifest.unreachable.filter((entry) => entry.reason === "unsafe_symlink_target").map((entry) => entry.path),
      ["unsafe-link"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compressed size gate rejects the final archive on both source and target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-size-"));
  const workspace = path.join(root, "agents", "agent-large");
  try {
    await mkdir(workspace, { recursive: true });
    const payload = deterministicBytes(256 * 1024);
    await writeFile(path.join(workspace, "state.bin"), payload);
    const maxBytes = 32 * 1024;
    const limited = await buildAgentMigrationObjectStoreBundle({
      agentId: "agent-large",
      slockHome: root,
      workspacePath: workspace,
      maxBytes,
    });
    await assert.rejects(
      readStream(limited.bundle),
      (error: unknown) => {
        assert.ok(error instanceof AgentMigrationObjectStoreBundleTooLargeError);
        assert.equal(error.code, "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE");
        assert.ok(error.actualBytes > maxBytes);
        assert.equal(error.maxBytes, maxBytes);
        assert.deepEqual(error.largestEntries, [{ path: "state.bin", sizeBytes: payload.byteLength }]);
        return true;
      },
    );

    const unrestricted = await buildAgentMigrationObjectStoreBundle({
      agentId: "agent-large",
      slockHome: root,
      workspacePath: workspace,
      maxBytes: 1024 * 1024,
    });
    const archive = await readStream(unrestricted.bundle);
    assert.ok(archive.byteLength > maxBytes);
    await assert.rejects(
      stageAgentMigrationObjectStoreBundle({
        bundle: Readable.from([archive]),
        slockHome: root,
        sessionId: "oversized-target",
        maxBytes,
      }),
      (error: unknown) =>
        error instanceof AgentMigrationObjectStoreBundleTooLargeError
        && error.actualBytes > maxBytes
        && error.maxBytes === maxBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target rejects a compressed bundle whose declared workspace cannot fit the adoption copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-disk-budget-"));
  const workspace = path.join(root, "agents", "agent-disk-budget");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "state.bin"), "fixture\n");
    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-disk-budget",
      slockHome: root,
      workspacePath: workspace,
      mode: "forensic",
    });
    const declaredContentBytes = 4 * 1024 ** 4;
    const oversizedManifest = {
      ...manifest,
      files: manifest.files.map((entry) => ({ ...entry, sizeBytes: declaredContentBytes })),
    };
    const archive = await makeArchive([{
      name: "manifest.json",
      body: Buffer.from(JSON.stringify({
        schemaVersion: AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION,
        manifest: oversizedManifest,
      })),
    }]);

    await assert.rejects(
      stageAgentMigrationObjectStoreBundle({
        bundle: Readable.from([archive]),
        slockHome: root,
        sessionId: "insufficient-disk",
        maxBytes: 1024 * 1024,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AgentMigrationObjectStoreInsufficientDiskError);
        assert.equal(error.code, "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK");
        assert.equal(error.contentBytes, declaredContentBytes);
        assert.ok(error.requiredBytes > error.availableBytes);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle size accounting reports the largest bounded top-level workspace paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-accounting-"));
  const workspace = path.join(root, "agents", "agent-accounting");
  try {
    await mkdir(path.join(workspace, ".git", "objects"), { recursive: true });
    await mkdir(path.join(workspace, "media", "video"), { recursive: true });
    await writeFile(path.join(workspace, ".git", "objects", "pack-a"), "git-a");
    await writeFile(path.join(workspace, ".git", "objects", "pack-b"), "git-bb");
    await writeFile(path.join(workspace, "media", "video", "clip.mov"), "media");
    await writeFile(path.join(workspace, "archive.tar"), "archive");
    await writeFile(path.join(workspace, "small.txt"), "x");
    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-accounting",
      slockHome: root,
      workspacePath: workspace,
      mode: "forensic",
    });

    assert.deepEqual(largestWorkspaceEntries(manifest), [
      { path: ".git/", sizeBytes: 11 },
      { path: "archive.tar", sizeBytes: 7 },
      { path: "media/", sizeBytes: 5 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest size diagnostics report bounded top-level entry counts", async () => {
  const manifest = await buildAgentMigrationExportManifest({
    agentId: "agent-counts",
    slockHome: "/tmp/slock",
    workspacePath: "/tmp/slock/agents/agent-counts",
    mode: "forensic",
    now: new Date("2026-07-06T10:00:00.000Z"),
  });
  const syntheticManifest = {
    ...manifest,
    files: [
      ...Array.from({ length: 4 }, (_, index) => ({
        kind: "file" as const,
        source: "workspace" as const,
        bundlePath: `workspace/.git/object-${index}`,
        workspaceRelativePath: `.git/object-${index}`,
        sizeBytes: 1,
      })),
      {
        kind: "file" as const,
        source: "workspace" as const,
        bundlePath: "workspace/src/index.ts",
        workspaceRelativePath: "src/index.ts",
        sizeBytes: 1,
      },
    ],
  };

  assert.deepEqual(largestWorkspaceEntryCounts(syntheticManifest), [
    { path: ".git/", entryCount: 4 },
    { path: "src/", entryCount: 1 },
  ]);

  const error = new AgentMigrationObjectStoreManifestTooLargeError(
    70 * 1024 * 1024,
    64 * 1024 * 1024,
    5,
    largestWorkspaceEntryCounts(syntheticManifest),
  );
  assert.equal(error.code, "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE");
  assert.match(error.message, /^MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE:manifestBytes=/);
  assert.match(error.message, /:entryCount=5/);
  assert.match(error.message, /:topPaths=\.git%2F,4;src%2F,1/);
  assert.ok(error.message.length < 500);
});

test("entry-count producer uses a strict 250,000-entry boundary and bounded recovery wire", () => {
  const entry = {
    kind: "file" as const,
    source: "workspace" as const,
    bundlePath: "workspace/src/index.ts",
    workspaceRelativePath: "src/index.ts",
    sizeBytes: 1,
  };
  assert.doesNotThrow(() => assertAgentMigrationObjectStoreEntryLimit(Array(249_999).fill(entry)));
  assert.doesNotThrow(() => assertAgentMigrationObjectStoreEntryLimit(Array(250_000).fill(entry)));

  assert.throws(
    () => assertAgentMigrationObjectStoreEntryLimit(Array(250_001).fill(entry)),
    (error: unknown) => {
      assert.ok(error instanceof AgentMigrationObjectStoreEntryCountLimitError);
      assert.equal(error.entryCount, 250_001);
      assert.equal(error.maxEntries, 250_000);
      assert.equal(
        error.message,
        "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=src%2F,250001",
      );
      assert.ok(error.message.length < 500);
      return true;
    },
  );
});

test("entry-count recovery wire redacts secret-shaped paths and bounds the top-path list", () => {
  const files = [
    ...Array(7).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/.env.production",
      workspaceRelativePath: ".env.production",
      sizeBytes: 1,
    }),
    ...Array(6).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/api-key-cache/value",
      workspaceRelativePath: "api-key-cache/value",
      sizeBytes: 1,
    }),
    ...Array(5).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/src/index.ts",
      workspaceRelativePath: "src/index.ts",
      sizeBytes: 1,
    }),
    ...Array(4).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/.git/config",
      workspaceRelativePath: ".git/config",
      sizeBytes: 1,
    }),
    ...Array(3).fill({
      kind: "file" as const,
      source: "workspace" as const,
      bundlePath: "workspace/docs/readme.md",
      workspaceRelativePath: "docs/readme.md",
      sizeBytes: 1,
    }),
  ];
  const error = new AgentMigrationObjectStoreEntryCountLimitError(
    250_001,
    250_000,
    largestWorkspaceEntryCounts({ files }),
  );

  assert.match(error.message, /:topPathCounts=other%2F,13;src%2F,5;.git%2F,4$/);
  assert.doesNotMatch(error.message, /\.env|api-key|secret|token|credential/i);
  assert.doesNotMatch(error.message, /\/Users\/|\\Users\\|agents\/agent-/);
  assert.equal(error.message.split(";").length, 3);
  assert.ok(error.message.length < 500);
});

test("bundle-too-large accounting payload stays bounded and contains relative paths only", () => {
  const longRelativePath = `${"大型目录".repeat(40)}/`;
  const error = new AgentMigrationObjectStoreBundleTooLargeError(
    4 * 1024 ** 3,
    3 * 1024 ** 3,
    [
      { path: longRelativePath, sizeBytes: 2 * 1024 ** 3 },
      { path: ".git/", sizeBytes: 1024 ** 3 },
      { path: "archive.tar", sizeBytes: 512 * 1024 ** 2 },
    ],
  );

  assert.ok(error.message.length < 500, `wire error must survive the server's 500-character bound: ${error.message.length}`);
  assert.match(error.message, /:topEntries=/);
  assert.doesNotMatch(error.message, /\/Users\/|\\Users\\|agents\/agent-/);
  assert.doesNotMatch(error.message, /大型目录大型目录大型目录大型目录大型目录大型目录大型目录大型目录大型目录大型目录/);
});

test("source stream propagates a file-change error instead of hanging the upload reader", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-source-error-"));
  const workspace = path.join(root, "agents", "agent-changing");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "a-hold.bin"), Buffer.alloc(8 * 1024 * 1024, 0x41));
    await writeFile(path.join(workspace, "z-changing.txt"), "before\n");
    const built = await buildAgentMigrationObjectStoreBundle({
      agentId: "agent-changing",
      slockHome: root,
      workspacePath: workspace,
      maxBytes: 16 * 1024 * 1024,
    });
    await writeFile(path.join(workspace, "z-changing.txt"), "changed after manifest\n");

    await assert.rejects(readStream(built.bundle), /MIGRATION_OBJECT_STORE_FILE_CHANGED:z-changing\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forensic defaults exclude mainstream regenerable trees but preserve .git", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-ignore-"));
  const workspace = path.join(root, "agents", "agent-ignore");
  const regenerable = [
    ".cache",
    ".gradle",
    ".pnpm-store",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
    "target",
    "vendor",
  ];
  try {
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
    for (const directory of regenerable) {
      await mkdir(path.join(workspace, directory), { recursive: true });
      await writeFile(path.join(workspace, directory, "artifact"), "rebuildable\n");
    }
    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-ignore",
      slockHome: root,
      workspacePath: workspace,
      mode: "forensic",
    });
    assert.deepEqual(
      manifest.excludedRegenerable.map((entry) => entry.path),
      [...regenerable].sort((left, right) => left.localeCompare(right)),
    );
    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), [".git/HEAD"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target rejects a mismatched tar bundle schema before writing workspace files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-schema-"));
  try {
    const archive = await makeArchive([
      {
        name: "manifest.json",
        body: Buffer.from(JSON.stringify({
          schemaVersion: "agent-object-store-bundle/v1",
          manifest: { schemaVersion: "agent-bundle/v2", files: [] },
        })),
      },
    ]);
    await assert.rejects(
      stageAgentMigrationObjectStoreBundle({
        bundle: Readable.from([archive]),
        slockHome: root,
        sessionId: "mixed-version",
        maxBytes: 1024 * 1024,
      }),
      /MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_UNSUPPORTED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 manifest and tar staging reject host-independent unsafe workspace paths", async () => {
  const unsafePaths = [
    "",
    ".",
    "./",
    "/posix-absolute.txt",
    "C:\\windows-absolute.txt",
    "C:/windows-absolute.txt",
    "C:drive-relative.txt",
    "\\\\server\\share\\unc.txt",
    "../escape.txt",
    "nested/../escape.txt",
    "nested\\..\\escape.txt",
    "nul\0byte.txt",
  ];
  for (const unsafePath of unsafePaths) {
    assert.throws(
      () => normalizeAgentMigrationWorkspaceRelativePath(
        unsafePath,
        "MIGRATION_OBJECT_STORE_UNSAFE_PATH",
      ),
      /MIGRATION_OBJECT_STORE_UNSAFE_PATH/,
      unsafePath,
    );
  }
  assert.equal(
    normalizeAgentMigrationWorkspaceRelativePath(
      "./nested\\safe//file.txt",
      "MIGRATION_OBJECT_STORE_UNSAFE_PATH",
    ),
    "nested/safe/file.txt",
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tar-v2-portable-path-"));
  const workspace = path.join(root, "source-home", "agents", "agent-portable-path");
  const body = Buffer.from("portable-path-fixture\n");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "fixture.txt"), body);
    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-portable-path",
      slockHome: path.join(root, "source-home"),
      workspacePath: workspace,
      mode: "forensic",
    });
    const unsafePath = "C:drive-relative.txt";
    const unsafeManifest = {
      ...manifest,
      files: manifest.files.map((entry) => ({
        ...entry,
        bundlePath: `workspace/${unsafePath}`,
        workspaceRelativePath: unsafePath,
      })),
    };
    const archive = await makeArchive([
      {
        name: "manifest.json",
        body: Buffer.from(JSON.stringify({
          schemaVersion: AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION,
          manifest: unsafeManifest,
        })),
      },
      { name: `workspace/${unsafePath}`, body },
    ]);

    await assert.rejects(
      stageAgentMigrationObjectStoreBundle({
        bundle: Readable.from([archive]),
        slockHome: path.join(root, "target-home"),
        sessionId: "portable-drive-relative",
        maxBytes: 1024 * 1024,
      }),
      /MIGRATION_OBJECT_STORE_UNSAFE_PATH/,
    );
    await assert.rejects(
      stat(path.join(root, "target-home", "migrations", "portable-drive-relative", "workspace")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readTarHeaders(archive: Buffer): Promise<Headers[]> {
  return new Promise((resolve, reject) => {
    const headers: Headers[] = [];
    const tarExtract = extract();
    tarExtract.on("entry", (header, stream, next) => {
      headers.push(header);
      stream.on("end", next);
      stream.resume();
    });
    tarExtract.on("finish", () => resolve(headers));
    tarExtract.on("error", reject);
    Readable.from([gunzipSync(archive)]).pipe(tarExtract).on("error", reject);
  });
}

function deterministicBytes(size: number): Buffer {
  const result = Buffer.alloc(size);
  for (let offset = 0, counter = 0; offset < size; counter += 1) {
    const block = createHash("sha256").update(`migration-fixture:${counter}`).digest();
    offset += block.copy(result, offset);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function makeArchive(entries: Array<{ name: string; body: Buffer }>): Promise<Buffer> {
  const tarPack = pack();
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      tarPack.entry({
        name: entry.name,
        type: "file",
        size: entry.body.byteLength,
        mode: 0o600,
      }, entry.body, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  tarPack.finalize();
  return readStream(tarPack.pipe(createGzip()));
}

assert.equal(
  AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION,
  "agent-object-store-tar/v2",
);
