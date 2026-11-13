import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { afterEach, test } from "vitest";
import type { AgentMigrationControlManifest } from "@botiverse/raft-shared";
import { __setAgentRuntimeProviderTransportForTests } from "./agentRuntimeProviderService";
import { resumableChunkStorageKey } from "./agentMigrationService";
import { HostedImportBuildError, buildHostedImportFileSet, hostedMigrationFileSetKey, hostedMigrationFileSetStorage } from "./hostedAgentMigrationImporter";
import type { HostedImportClaim } from "./hostedAgentMigrationService";
import type { StorageBackend } from "./storageService";

const config = { baseUrl: "http://provider.test", token: "t" };
const limits = { maxTotalBytes: 1000, maxFiles: 10, maxFileBytes: 200 };

type Entry = { name: string; content?: string | Buffer; type?: "symlink"; linkname?: string };

async function bundleOf(entries: Entry[]): Promise<{ bytes: Buffer; expanded: number }> {
  const tar = pack();
  const parts: Buffer[] = [];
  tar.on("data", (chunk: Buffer) => parts.push(chunk));
  const done = new Promise<void>((resolve) => tar.on("end", () => resolve()));
  let expanded = 0;
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      if (entry.type === "symlink") {
        tar.entry({ name: entry.name, type: "symlink", linkname: entry.linkname }, (e) => e ? reject(e) : resolve());
      } else {
        const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "");
        expanded += data.byteLength;
        tar.entry({ name: entry.name, mode: 0o644 }, data, (e) => e ? reject(e) : resolve());
      }
    });
  }
  tar.finalize();
  await done;
  return { bytes: gzipSync(Buffer.concat(parts)), expanded };
}

async function claimFor(entries: Entry[]): Promise<{ claim: HostedImportClaim; storage: StorageBackend }> {
  const { bytes, expanded } = await bundleOf(entries);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const control = {
    bundle: { totalBytes: bytes.byteLength, sha256, chunks: [{ index: 0, offsetBytes: 0, sizeBytes: bytes.byteLength, sha256 }] },
    archive: { entryCount: entries.length, expandedBytes: expanded, maxEntryBytes: 10_000 },
  } as unknown as AgentMigrationControlManifest;
  const migration = {
    id: "m1", supportRef: "mig_abcdefghijklmnopqrstuv", serverId: "s1",
    transportSessionId: "sess", transportGeneration: "gen", transportControlManifest: control,
  };
  const key = resumableChunkStorageKey("sess", "gen", 0);
  const storage = {
    get: async (k: string) => {
      assert.equal(k, key);
      return Readable.from([bytes]);
    },
  } as unknown as StorageBackend;
  const claim = { migration, hosted: { importLimits: limits, provider: "antiproton" }, leaseId: "l" } as unknown as HostedImportClaim;
  return { claim, storage };
}

function providerRefusing(paths: (path: string) => string | null) {
  const bodies: Array<{ files: Array<{ path: string }> }> = [];
  __setAgentRuntimeProviderTransportForTests({
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { files: Array<{ path: string }> };
      bodies.push(body);
      const rejected = body.files.flatMap((file, index) => {
        const reason = paths(file.path);
        return reason ? [{ index, path: reason === "credential_in_path" ? null : file.path, reason, param: `files[${index}]` }] : [];
      });
      return Response.json({ ok: rejected.length === 0, rejected, more: 0, totals: { files: body.files.length - rejected.length, bytes: 0 }, limits });
    }) as typeof globalThis.fetch,
  });
  return bodies;
}

afterEach(() => __setAgentRuntimeProviderTransportForTests(null));

test("the file set keeps text files by priority and records why the rest stayed behind", async () => {
  const { claim, storage } = await claimFor([
    { name: "workspace/src/z.ts", content: "z".repeat(100) },
    { name: "workspace/MEMORY.md", content: "memory" },
    { name: "workspace/notes/a.md", content: "note" },
    { name: "workspace/repo/.git/HEAD", content: "ref" },
    { name: "workspace/image.png", content: Buffer.from([0x89, 0x50, 0x00, 0x47]) },
    { name: "workspace/big.log", content: "b".repeat(300) },
    { name: "workspace/link", type: "symlink", linkname: "notes/a.md" },
    { name: "workspace/keys.env", content: "API_KEY=..." },
  ]);
  const bodies = providerRefusing((path) => path === "keys.env" ? "credential_in_path" : null);
  const set = await buildHostedImportFileSet({ claim, storage, config });
  assert.deepEqual(set.body.files.map((f) => f.path), ["MEMORY.md", "notes/a.md", "src/z.ts"]);
  assert.equal(set.body.migrationId, "mig_abcdefghijklmnopqrstuv");
  const reasons = Object.fromEntries(set.skipped.map((s) => [s.path, s.reason]));
  assert.deepEqual(reasons, {
    "repo/.git/HEAD": "git",
    "big.log": "file_too_large",
    link: "symlink",
    "image.png": "not_text",
    "keys.env": "provider_rejected",
  });
  // Checked twice: once with keys.env, then without it.
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0]!.files.some((f) => f.path === "keys.env"));
  assert.ok(!bodies[1]!.files.some((f) => f.path === "keys.env"));
});

test("the same bundle gives the same import body", async () => {
  const entries: Entry[] = [{ name: "workspace/b.md", content: "b" }, { name: "workspace/MEMORY.md", content: "m" }, { name: "workspace/a.md", content: "a" }];
  providerRefusing(() => null);
  const first = await buildHostedImportFileSet(await claimFor(entries).then((c) => ({ ...c, config })));
  const second = await buildHostedImportFileSet(await claimFor([...entries].reverse()).then((c) => ({ ...c, config })));
  assert.deepEqual(first.body, second.body);
});

test("a MEMORY.md the provider refuses fails the build before the switch", async () => {
  const { claim, storage } = await claimFor([{ name: "workspace/MEMORY.md", content: "m" }, { name: "workspace/a.md", content: "a" }]);
  providerRefusing((path) => path === "MEMORY.md" ? "credential_in_text" : null);
  await assert.rejects(
    buildHostedImportFileSet({ claim, storage, config }),
    (error: unknown) => error instanceof HostedImportBuildError && error.code === "HOSTED_IMPORT_MEMORY_UNIMPORTABLE",
  );
});

test("a tampered bundle is refused by the shared reader", async () => {
  const { claim, storage } = await claimFor([{ name: "workspace/MEMORY.md", content: "m" }]);
  const tampered = { ...storage, get: async () => Readable.from([Buffer.from("not the bundle")]) } as unknown as StorageBackend;
  providerRefusing(() => null);
  await assert.rejects(buildHostedImportFileSet({ claim, storage: tampered, config }), /MIGRATION_CHUNK_DIGEST_MISMATCH/);
});

test("a refused MEMORY.md fails the build even when it is the only file", async () => {
  const { claim, storage } = await claimFor([{ name: "workspace/MEMORY.md", content: "m" }]);
  providerRefusing(() => "credential_in_text");
  await assert.rejects(
    buildHostedImportFileSet({ claim, storage, config }),
    (error: unknown) => error instanceof HostedImportBuildError && error.code === "HOSTED_IMPORT_MEMORY_UNIMPORTABLE",
  );
});

test("file set: a new one is keyed under agent-migrations/v2 in the dedicated bucket; an older key is read from the main storage", () => {
  const dedicated = { put: async () => {}, get: async () => Readable.from([]), delete: async () => {} } as unknown as StorageBackend;
  const main = { put: async () => {}, get: async () => Readable.from([]), delete: async () => {} } as unknown as StorageBackend;
  assert.equal(hostedMigrationFileSetKey("m1", true), "agent-migrations/v2/hosted/m1/file-set.json");
  assert.equal(hostedMigrationFileSetKey("m1", false), "agent-migrations/hosted/m1/file-set.json");
  assert.equal(hostedMigrationFileSetStorage(hostedMigrationFileSetKey("m1", true), { dedicated, main }), dedicated);
  // Written before the move (or where there is no dedicated bucket): the main storage.
  assert.equal(hostedMigrationFileSetStorage(hostedMigrationFileSetKey("m1", false), { dedicated, main }), main);
});
