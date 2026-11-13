import assert from "node:assert/strict";
import { test } from "vitest";
import { asObjectFileId, OBJECT_SUMMARIES_MAX_REFS, objectWebPaths } from "./webObjectsContract";

test("summaries: one core path for every kind, at most 50 references a request", () => {
  assert.equal(objectWebPaths.summaries(), "/api/objects/summaries");
  assert.equal(OBJECT_SUMMARIES_MAX_REFS, 50);
});

test("an object's file: one core path for every kind, each segment encoded", () => {
  const fileId = asObjectFileId("5f0c2d7e-8a1b-4c3d-9e4f-0a1b2c3d4e5f");
  assert.equal(objectWebPaths.file("artifact", "pt_1", fileId), `/api/objects/artifact/pt_1/files/${fileId}`);
  assert.equal(objectWebPaths.file("artifact", "a/b c", fileId), `/api/objects/artifact/a%2Fb%20c/files/${fileId}`);
});
