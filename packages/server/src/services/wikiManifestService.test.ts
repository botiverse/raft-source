import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { getStorage, resetStorageForTests } from "./storageService.js";
import {
  parseWikiManifest,
  publishWikiManifest,
  readWikiArtifactMarkdown,
  readWikiManifest,
  wikiRevisionKey,
  WikiManifestConflictError,
  WikiManifestValidationError,
  type WikiManifest,
  type WikiManifestArtifact,
} from "./wikiManifestService.js";

function digest(markdown: string): string {
  return createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");
}

function artifact(input: {
  serverId: string;
  artifactType: WikiManifestArtifact["artifactType"];
  slug: string;
  markdown: string;
}): WikiManifestArtifact {
  const id = randomUUID();
  const revisionId = randomUUID();
  return {
    id,
    artifactType: input.artifactType,
    slug: input.slug,
    title: input.slug === "index" ? "Wiki Index" : input.slug === "log" ? "Wiki Log" : "Architecture",
    summary: "A concise summary",
    currentUnderstanding: "Current understanding",
    status: "current",
    confidence: "high",
    sourcePolicy: "cached_summary",
    sourceRefs: [],
    revision: {
      id: revisionId,
      key: wikiRevisionKey(input.serverId, id, revisionId),
      sha256: digest(input.markdown),
      bytes: Buffer.byteLength(input.markdown),
    },
    updatedAt: "2026-07-25T15:00:00.000Z",
  };
}

function manifestFixture() {
  const serverId = randomUUID();
  const wikiSpaceId = randomUUID();
  const coverageChannelId = randomUUID();
  const agentId = randomUUID();
  const markdown = {
    index: "# Wiki Index\n",
    log: "# Wiki Log\n",
    page: "# Architecture\n",
  };
  const index = artifact({ serverId, artifactType: "index", slug: "index", markdown: markdown.index });
  const log = artifact({ serverId, artifactType: "log", slug: "log", markdown: markdown.log });
  const page = artifact({ serverId, artifactType: "page", slug: "architecture", markdown: markdown.page });
  const manifest: WikiManifest = {
    schemaVersion: 1,
    serverId,
    wikiSpaceId,
    revision: 1,
    coverage: { [coverageChannelId]: [{ from: 0, to: 42 }] },
    publishedAt: "2026-07-25T15:00:00.000Z",
    publishedByAgentId: agentId,
    index,
    log,
    pages: [page],
    lastIngest: {
      receiptId: randomUUID(),
      added: [{ channelId: coverageChannelId, from: 0, to: 42, observedCount: 12 }],
      outcome: "published",
      publishedAt: "2026-07-25T15:00:00.000Z",
    },
    lastLint: null,
  };
  return { serverId, wikiSpaceId, agentId, coverageChannelId, markdown, manifest };
}

async function withLocalStorage(run: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-wiki-manifest-"));
  const envKeys = [
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_ATTACHMENTS_BUCKET",
    "UPLOADS_LOCAL",
    "UPLOADS_DIR",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_ATTACHMENTS_BUCKET;
    process.env.UPLOADS_LOCAL = "true";
    process.env.UPLOADS_DIR = dir;
    resetStorageForTests();
    await run();
  } finally {
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Wiki manifest publishes immutable revisions before one conditional cursor commit", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);

    const published = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: null,
      manifest: fixture.manifest,
      revisionBodies: [
        {
          artifactId: fixture.manifest.index.id,
          revisionId: fixture.manifest.index.revision.id,
          markdown: fixture.markdown.index,
        },
        {
          artifactId: fixture.manifest.log.id,
          revisionId: fixture.manifest.log.revision.id,
          markdown: fixture.markdown.log,
        },
        {
          artifactId: fixture.manifest.pages[0]!.id,
          revisionId: fixture.manifest.pages[0]!.revision.id,
          markdown: fixture.markdown.page,
        },
      ],
      storage,
    });
    assert.ok(published.etag);

    const readback = await readWikiManifest(fixture.serverId, storage);
    assert.equal(readback?.etag, published.etag);
    assert.deepEqual(readback?.manifest.coverage[fixture.coverageChannelId], [{ from: 0, to: 42 }]);
    const document = await readWikiArtifactMarkdown(
      readback!.manifest,
      fixture.manifest.pages[0]!.id,
      storage,
    );
    assert.equal(document.markdown, fixture.markdown.page);
  });
});

test("Wiki lint repairs preserve ingest truth and a clean rerun cannot publish churn", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    const first = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: null,
      manifest: fixture.manifest,
      revisionBodies: [
        { artifactId: fixture.manifest.index.id, revisionId: fixture.manifest.index.revision.id, markdown: fixture.markdown.index },
        { artifactId: fixture.manifest.log.id, revisionId: fixture.manifest.log.revision.id, markdown: fixture.markdown.log },
        { artifactId: fixture.manifest.pages[0]!.id, revisionId: fixture.manifest.pages[0]!.revision.id, markdown: fixture.markdown.page },
      ],
      storage,
    });

    const repairedMarkdown = "# Architecture\n\nConverged, source-backed structure.\n";
    const lintManifest = structuredClone(fixture.manifest);
    const repairedRevisionId = randomUUID();
    lintManifest.revision = 2;
    lintManifest.publishedAt = "2026-07-25T15:05:00.000Z";
    lintManifest.pages[0]!.revision = {
      id: repairedRevisionId,
      key: wikiRevisionKey(fixture.serverId, lintManifest.pages[0]!.id, repairedRevisionId),
      sha256: digest(repairedMarkdown),
      bytes: Buffer.byteLength(repairedMarkdown),
    };
    lintManifest.pages[0]!.updatedAt = lintManifest.publishedAt;
    lintManifest.lastLint = {
      receiptId: randomUUID(),
      outcome: "repaired",
      repairedArtifactIds: [lintManifest.pages[0]!.id],
      publishedAt: lintManifest.publishedAt,
    };
    const repaired = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: first.etag,
      manifest: lintManifest,
      revisionBodies: [{
        artifactId: lintManifest.pages[0]!.id,
        revisionId: repairedRevisionId,
        markdown: repairedMarkdown,
      }],
      storage,
    });
    assert.deepEqual(repaired.manifest.coverage, fixture.manifest.coverage);
    assert.deepEqual(repaired.manifest.lastIngest, fixture.manifest.lastIngest);

    const churn = structuredClone(lintManifest);
    churn.revision = 3;
    churn.publishedAt = "2026-07-25T15:10:00.000Z";
    churn.lastLint = {
      receiptId: randomUUID(),
      outcome: "repaired",
      repairedArtifactIds: [churn.pages[0]!.id],
      publishedAt: churn.publishedAt,
    };
    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: repaired.etag,
        manifest: churn,
        revisionBodies: [],
        storage,
      }),
      /lint receipt must name exactly the artifacts changed by the repair/,
    );
    const readback = await readWikiManifest(fixture.serverId, storage);
    assert.equal(readback?.etag, repaired.etag);
    assert.equal(readback?.manifest.revision, 2);
  });
});

test("Wiki manifest rejects stale writers without advancing the committed cursor", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    const first = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: null,
      manifest: fixture.manifest,
      revisionBodies: [
        { artifactId: fixture.manifest.index.id, revisionId: fixture.manifest.index.revision.id, markdown: fixture.markdown.index },
        { artifactId: fixture.manifest.log.id, revisionId: fixture.manifest.log.revision.id, markdown: fixture.markdown.log },
        { artifactId: fixture.manifest.pages[0]!.id, revisionId: fixture.manifest.pages[0]!.revision.id, markdown: fixture.markdown.page },
      ],
      storage,
    });

    const secondManifest: WikiManifest = {
      ...fixture.manifest,
      revision: 2,
      coverage: { [fixture.coverageChannelId]: [{ from: 0, to: 50 }] },
      publishedAt: "2026-07-25T15:05:00.000Z",
      lastIngest: {
        receiptId: randomUUID(),
        added: [{ channelId: fixture.coverageChannelId, from: 0, to: 50, observedCount: 0 }],
        outcome: "no_changes",
        publishedAt: "2026-07-25T15:05:00.000Z",
      },
    };
    const reusedReceipt = structuredClone(secondManifest);
    reusedReceipt.lastIngest.receiptId = fixture.manifest.lastIngest.receiptId;
    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: first.etag,
        manifest: reusedReceipt,
        revisionBodies: [],
        storage,
      }),
      /ingest publication must use a new receipt id/,
    );
    const second = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: first.etag,
      manifest: secondManifest,
      revisionBodies: [],
      storage,
    });

    const staleManifest: WikiManifest = {
      ...secondManifest,
      revision: 3,
      coverage: { [fixture.coverageChannelId]: [{ from: 0, to: 60 }] },
      publishedAt: "2026-07-25T15:06:00.000Z",
      lastIngest: {
        receiptId: randomUUID(),
        added: [{ channelId: fixture.coverageChannelId, from: 0, to: 60, observedCount: 0 }],
        outcome: "no_changes",
        publishedAt: "2026-07-25T15:06:00.000Z",
      },
    };
    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: first.etag,
        manifest: staleManifest,
        revisionBodies: [],
        storage,
      }),
      WikiManifestConflictError,
    );
    const readback = await readWikiManifest(fixture.serverId, storage);
    assert.equal(readback?.etag, second.etag);
    assert.deepEqual(readback?.manifest.coverage[fixture.coverageChannelId], [{ from: 0, to: 50 }]);
  });
});

test("Wiki manifest refuses to publish a cursor when revision receipts do not match bytes", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    const invalid = structuredClone(fixture.manifest);
    invalid.pages[0]!.revision.sha256 = "0".repeat(64);

    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: null,
        manifest: invalid,
        revisionBodies: [
          { artifactId: invalid.index.id, revisionId: invalid.index.revision.id, markdown: fixture.markdown.index },
          { artifactId: invalid.log.id, revisionId: invalid.log.revision.id, markdown: fixture.markdown.log },
          { artifactId: invalid.pages[0]!.id, revisionId: invalid.pages[0]!.revision.id, markdown: fixture.markdown.page },
        ],
        storage,
      }),
      WikiManifestValidationError,
    );
    assert.equal(await readWikiManifest(fixture.serverId, storage), null);
  });
});

test("Wiki manifest cannot reuse a published revision id with a different receipt", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    const first = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: null,
      manifest: fixture.manifest,
      revisionBodies: [
        { artifactId: fixture.manifest.index.id, revisionId: fixture.manifest.index.revision.id, markdown: fixture.markdown.index },
        { artifactId: fixture.manifest.log.id, revisionId: fixture.manifest.log.revision.id, markdown: fixture.markdown.log },
        { artifactId: fixture.manifest.pages[0]!.id, revisionId: fixture.manifest.pages[0]!.revision.id, markdown: fixture.markdown.page },
      ],
      storage,
    });
    const invalid = structuredClone(fixture.manifest);
    invalid.revision = 2;
    invalid.coverage = { [fixture.coverageChannelId]: [{ from: 0, to: 43 }] };
    invalid.publishedAt = "2026-07-25T15:01:00.000Z";
    invalid.pages[0]!.revision.sha256 = "0".repeat(64);
    invalid.lastIngest = {
      receiptId: randomUUID(),
      added: [{ channelId: fixture.coverageChannelId, from: 0, to: 43, observedCount: 1 }],
      outcome: "published",
      publishedAt: invalid.publishedAt,
    };

    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: first.etag,
        manifest: invalid,
        revisionBodies: [],
        storage,
      }),
      /cannot be reused with different identity or receipt/,
    );
  });
});

test("Wiki manifest keeps revision metadata immutable and artifact timestamps monotonic", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    const first = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: null,
      manifest: fixture.manifest,
      revisionBodies: [
        { artifactId: fixture.manifest.index.id, revisionId: fixture.manifest.index.revision.id, markdown: fixture.markdown.index },
        { artifactId: fixture.manifest.log.id, revisionId: fixture.manifest.log.revision.id, markdown: fixture.markdown.log },
        { artifactId: fixture.manifest.pages[0]!.id, revisionId: fixture.manifest.pages[0]!.revision.id, markdown: fixture.markdown.page },
      ],
      storage,
    });

    const metadataMutation = structuredClone(fixture.manifest);
    metadataMutation.revision = 2;
    metadataMutation.publishedAt = "2026-07-25T15:01:00.000Z";
    metadataMutation.pages[0]!.summary = "Changed without a new immutable revision";
    metadataMutation.lastIngest = {
      receiptId: randomUUID(),
      added: [],
      outcome: "published",
      publishedAt: metadataMutation.publishedAt,
    };
    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: first.etag,
        manifest: metadataMutation,
        revisionBodies: [],
        storage,
      }),
      /must reuse the complete artifact entry/,
    );

    const staleTimestamp = structuredClone(fixture.manifest);
    const newRevisionId = randomUUID();
    staleTimestamp.revision = 2;
    staleTimestamp.publishedAt = "2026-07-25T15:01:00.000Z";
    staleTimestamp.pages[0]!.revision = {
      id: newRevisionId,
      key: wikiRevisionKey(fixture.serverId, staleTimestamp.pages[0]!.id, newRevisionId),
      sha256: digest("# Updated architecture\n"),
      bytes: Buffer.byteLength("# Updated architecture\n"),
    };
    staleTimestamp.lastIngest = {
      receiptId: randomUUID(),
      added: [],
      outcome: "published",
      publishedAt: staleTimestamp.publishedAt,
    };
    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: first.etag,
        manifest: staleTimestamp,
        revisionBodies: [{
          artifactId: staleTimestamp.pages[0]!.id,
          revisionId: newRevisionId,
          markdown: "# Updated architecture\n",
        }],
        storage,
      }),
      /must move forwards with a new revision/,
    );
  });
});

test("Wiki manifest cannot activate an empty document inventory", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    const empty = structuredClone(fixture.manifest);
    empty.pages = [];

    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: null,
        manifest: empty,
        revisionBodies: [
          { artifactId: empty.index.id, revisionId: empty.index.revision.id, markdown: fixture.markdown.index },
          { artifactId: empty.log.id, revisionId: empty.log.revision.id, markdown: fixture.markdown.log },
        ],
        storage,
      }),
      /must contain at least one Wiki page/,
    );
  });
});

test("Wiki manifest cannot leave Active with only archived Pages", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    fixture.manifest.pages[0]!.status = "archived";

    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: null,
        manifest: fixture.manifest,
        revisionBodies: [
          { artifactId: fixture.manifest.index.id, revisionId: fixture.manifest.index.revision.id, markdown: fixture.markdown.index },
          { artifactId: fixture.manifest.log.id, revisionId: fixture.manifest.log.revision.id, markdown: fixture.markdown.log },
          { artifactId: fixture.manifest.pages[0]!.id, revisionId: fixture.manifest.pages[0]!.revision.id, markdown: fixture.markdown.page },
        ],
        storage,
      }),
      /must contain at least one non-archived Wiki page/,
    );
  });
});

test("Wiki manifest keeps retired Pages as archived redirects to preserve topic identity", async () => {
  await withLocalStorage(async () => {
    const fixture = manifestFixture();
    const storage = getStorage();
    assert.ok(storage);
    const duplicateMarkdown = "# Architecture Notes\n";
    const duplicate = artifact({
      serverId: fixture.serverId,
      artifactType: "page",
      slug: "architecture-notes",
      markdown: duplicateMarkdown,
    });
    fixture.manifest.pages.push(duplicate);
    const first = await publishWikiManifest({
      serverId: fixture.serverId,
      wikiSpaceId: fixture.wikiSpaceId,
      agentId: fixture.agentId,
      expectedEtag: null,
      manifest: fixture.manifest,
      revisionBodies: [
        { artifactId: fixture.manifest.index.id, revisionId: fixture.manifest.index.revision.id, markdown: fixture.markdown.index },
        { artifactId: fixture.manifest.log.id, revisionId: fixture.manifest.log.revision.id, markdown: fixture.markdown.log },
        { artifactId: fixture.manifest.pages[0]!.id, revisionId: fixture.manifest.pages[0]!.revision.id, markdown: fixture.markdown.page },
        { artifactId: duplicate.id, revisionId: duplicate.revision.id, markdown: duplicateMarkdown },
      ],
      storage,
    });

    const removed = structuredClone(fixture.manifest);
    removed.revision = 2;
    removed.publishedAt = "2026-07-25T15:05:00.000Z";
    removed.pages = [removed.pages[0]!];
    removed.lastIngest = {
      receiptId: randomUUID(),
      added: [],
      outcome: "published",
      publishedAt: removed.publishedAt,
    };
    await assert.rejects(
      publishWikiManifest({
        serverId: fixture.serverId,
        wikiSpaceId: fixture.wikiSpaceId,
        agentId: fixture.agentId,
        expectedEtag: first.etag,
        manifest: removed,
        revisionBodies: [],
        storage,
      }),
      /cannot be removed; publish an archived redirect to preserve topic identity/,
    );
  });
});
