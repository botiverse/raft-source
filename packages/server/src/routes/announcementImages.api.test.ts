import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { announcementImageAssets, announcements, users } from "../db/schema";
import * as storageService from "../services/storageService";

const test = createApiTest();
const gif = Buffer.from("R0lGODlhEAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAKAAAACwAAAAAEAAIAAAIFQABCBxIsKDBgwgTKlzIsKHDhwgDAgAh+QQBKAABACwAAAAAEAAIAIEAAP8AAAAAAAAAAAAIFQABCBxIsKDBgwgTKlzIsKHDhwgDAgA7", "base64");
for (const [contentType, bytes] of [["image/png", Buffer.from([1, 2, 3])], ["image/gif", gif]] as const) {

test(`anonymous ${contentType} delivery rejects drafts and future publications while preserving published images`, async ({ app }) => {
  const db = getDb(); const id = randomUUID(); const userId = randomUUID(); const announcementId = randomUUID();
  await db.insert(users).values({ id: userId, email: "announcement-image@test.example", name: "image-test", passwordHash: "fixture" });
  await db.insert(announcementImageAssets).values({ id, storageKey: `announcements/images/${id}`, contentType, width: 1, height: 1, sizeBytes: bytes.length, createdByUserId: userId });
  await db.insert(announcements).values({ id: announcementId, title: "Image", pages: [{ body: "Body" }], localizedContent: { en: { title: "Image", pages: [{ body: "Body" }], image: { assetId: id, alt: "Example" } } }, status: "draft", publishedAt: null, startsAt: null });
  const get = async () => fetch(`${app.baseUrl}/api/announcements/images/${id}`);
  const storage = vi.spyOn(storageService, "getDirectUploadStorage").mockReturnValue({ get: async () => Readable.from(bytes) } as unknown as storageService.StorageBackend);
  try {
    assert.equal((await get()).status, 404); assert.equal(storage.mock.calls.length, 0);
    await db.update(announcements).set({ status: "published", publishedAt: new Date(), startsAt: new Date(Date.now() + 86400000) }).where(eq(announcements.id, announcementId));
    assert.equal((await get()).status, 404); assert.equal(storage.mock.calls.length, 0);
    await db.update(announcements).set({ startsAt: new Date(Date.now() - 60000) }).where(eq(announcements.id, announcementId));
    const published = await get(); assert.equal(published.status, 200); assert.equal(published.headers.get("content-type"), contentType);
    assert.equal(published.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(published.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(new Uint8Array(await published.arrayBuffer()), new Uint8Array(bytes));
    await db.update(announcements).set({ status: "expired", endsAt: new Date() }).where(eq(announcements.id, announcementId));
    assert.equal((await get()).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/api/announcements/images/${randomUUID()}`)).status, 404);
    storage.mockReturnValue(null); assert.equal((await get()).status, 503);
  } finally { storage.mockRestore(); }
});

}
