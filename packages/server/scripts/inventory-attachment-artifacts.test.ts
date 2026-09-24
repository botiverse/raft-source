import assert from "node:assert/strict";
import { test } from "vitest";
import { parseAttachmentArtifactInventoryArgs } from "./inventory-attachment-artifacts.js";

test("inventory CLI is dry-run by default and production apply requires an explicit write acknowledgement", () => {
  assert.deepEqual(parseAttachmentArtifactInventoryArgs([], "production"), {
    apply: false,
    acknowledgeProductionWrite: false,
    runId: null,
    sourceRevision: null,
    evidenceSource: "attachment-inventory-cli",
    serverId: undefined,
    concurrency: 16,
  });
  assert.throws(
    () => parseAttachmentArtifactInventoryArgs(["--apply", "--source-revision", "head"], "production"),
    /--acknowledge-production-write is required/,
  );
  assert.equal(
    parseAttachmentArtifactInventoryArgs([
      "--apply",
      "--source-revision", "head",
      "--acknowledge-production-write",
    ], "production").apply,
    true,
  );
});
