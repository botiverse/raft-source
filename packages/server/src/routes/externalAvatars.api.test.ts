import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApiTest } from "../test/integration/apiTest";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness";
import { getDb } from "../db/index";
import { externalProjectionAvatarArtifacts } from "../db/schema";
import {
  __setCdnStorageForTests,
  resetStorageForTests,
} from "../services/storageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedActiveAvatarArtifact() {
  const db = getDb();
  const [artifact] = await db
    .insert(externalProjectionAvatarArtifacts)
    .values({
      id: randomUUID(),
      ownerType: "external_projection",
      ownerId: `ext-avatar-abort-${randomUUID()}`,
      sourceDigest: "0".repeat(64),
      sourceLocatorDigest: "1".repeat(64),
      storageKey: `external-avatars/${randomUUID()}.webp`,
      publicUrl: "https://cdn.example.test/external-avatar.webp",
      mimeType: "image/webp",
      // Schema cap is 5 MiB; the hanging harness streams far less before the
      // abort, so the declared Content-Length never conflicts with the bytes.
      byteSize: 5_000_000,
      width: 128,
      height: 128,
      artifactRevision: 1,
      state: "active",
    })
    .returning({ id: externalProjectionAvatarArtifacts.id });
  assert.ok(artifact?.id);
  return artifact.id;
}

test("GET /api/external-avatars releases its real upstream Agent socket when the client aborts", async ({ app }) => {
  const artifactId = await seedActiveAvatarArtifact();
  const harness = await createHangingStorageTestHarness();
  try {
    __setCdnStorageForTests(harness.storage);

    await harness.abortDownload(
      `${app.baseUrl}/api/external-avatars/${artifactId}.webp`,
      undefined,
      (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/webp");
        assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
      },
    );
  } finally {
    await harness.close();
    resetStorageForTests();
  }
});
