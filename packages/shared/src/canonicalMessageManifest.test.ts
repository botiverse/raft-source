import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CANONICAL_MESSAGE_MANIFEST,
  CANONICAL_REQUIRED_MESSAGE_FIELDS,
  OPTIONAL_AGGREGATE_MESSAGE_FIELDS,
  TASK_STATUS_FAMILY_PRESENT_AGGREGATES,
  canonicalMessageManifestJson,
} from "./canonicalMessageManifest.js";

const here = dirname(fileURLToPath(import.meta.url));

test("canonical message manifest: generated JSON snapshot matches the typed source", () => {
  const snapshot = readFileSync(join(here, "canonicalMessageManifest.json"), "utf8");
  assert.equal(
    snapshot,
    canonicalMessageManifestJson(),
    "canonicalMessageManifest.json drifted from the typed source — regenerate it from canonicalMessageManifestJson()",
  );
});

test("canonical message manifest: field counts are pinned (10 + 10 = 20)", () => {
  assert.equal(CANONICAL_REQUIRED_MESSAGE_FIELDS.length, 10);
  assert.equal(OPTIONAL_AGGREGATE_MESSAGE_FIELDS.length, 10);
  const all = new Set<string>([
    ...CANONICAL_REQUIRED_MESSAGE_FIELDS,
    ...OPTIONAL_AGGREGATE_MESSAGE_FIELDS,
  ]);
  assert.equal(all.size, 20, "canonical field classes must be disjoint and total 20");
});

test("canonical message manifest: task-status family present set is producer-realistic", () => {
  assert.deepEqual(
    [...TASK_STATUS_FAMILY_PRESENT_AGGREGATES].sort(),
    ["actionMetadata", "senderName"],
  );
  for (const field of TASK_STATUS_FAMILY_PRESENT_AGGREGATES) {
    assert.ok(
      (OPTIONAL_AGGREGATE_MESSAGE_FIELDS as ReadonlyArray<string>).includes(field),
      `${field} must be classified OptionalAggregate`,
    );
  }
});

test("canonical message manifest: classes are declaration-sorted for stable JSON hashing", () => {
  assert.deepEqual([...CANONICAL_REQUIRED_MESSAGE_FIELDS], [...CANONICAL_REQUIRED_MESSAGE_FIELDS].sort());
  assert.deepEqual([...OPTIONAL_AGGREGATE_MESSAGE_FIELDS], [...OPTIONAL_AGGREGATE_MESSAGE_FIELDS].sort());
  for (const fields of Object.values(CANONICAL_MESSAGE_MANIFEST.nestedWireShapes)) {
    const names = fields.map((f) => f.name);
    assert.deepEqual(names, [...names].sort());
  }
  assert.equal(CANONICAL_MESSAGE_MANIFEST.version, 5);
});

test("canonical message manifest v2: descriptors carry type/nullability/family presence", () => {
  for (const d of CANONICAL_MESSAGE_MANIFEST.fields) {
    assert.ok(d.wireType.length > 0, `${d.name} needs a wireType`);
    assert.equal(typeof d.nullable, "boolean");
    assert.equal(d.presence.messageNew, "present", `${d.name}: message:new always carries every canonical key`);
    if (d.class === "canonicalRequired") {
      assert.equal(d.presence.enrichedUpdated, "present", `${d.name}: required fields are present on all surfaces`);
      assert.equal(d.presence.taskStatusUpdated, "present", `${d.name}: required fields are present on all surfaces`);
    }
  }
  const attachment: readonly string[] = CANONICAL_MESSAGE_MANIFEST.nestedWireShapes.attachment.map((f) => f.name);
  assert.ok(!attachment.includes("rasterPreviewUrl") && !attachment.includes("localPreviewUrl"),
    "attachment nested shape is the message producer wire — raster/local previews are not message wire");
  assert.ok(!attachment.includes("sizeLabel"), "formatted labels are projection-only");
  assert.ok(!attachment.includes("commentCount"), "commentCount is viewer-scoped — excluded from canonical shared facts");
  assert.equal(attachment.length, 7);
});

test("canonical message manifest v2: raw string unions are marked unknown-preserving everywhere", () => {
  const topRaw = CANONICAL_MESSAGE_MANIFEST.fields
    .filter((d) => d.wireType === "string-union-raw").map((d) => d.name).sort();
  assert.deepEqual(topRaw, ["messageType", "senderMembershipStatus", "senderType"]);
  const nestedRaw: string[] = [];
  for (const [shape, fields] of Object.entries(CANONICAL_MESSAGE_MANIFEST.nestedWireShapes)) {
    for (const f of fields) if (f.wireType === "string-union-raw") nestedRaw.push(`${shape}.${f.name}`);
  }
  assert.deepEqual(nestedRaw.sort(), [
    "commentRefHostSource.routeKind",
    "commentRefHostSource.type",
    "conversationContext.channelType",
    "conversationContext.parentChannelType",
    "externalAuthor.actorKind",
    "mention.type",
  ]);
});

test("canonical message manifest v4: merge policies and exclusion ledger are complete", () => {
  for (const d of CANONICAL_MESSAGE_MANIFEST.fields) {
    if (d.class === "canonicalRequired") assert.equal(d.mergePolicy, "overwrite", d.name);
    else if (d.name === "commentRef") assert.equal(d.mergePolicy, "shared-null-preserve");
    else assert.equal(d.mergePolicy, "present-overwrite", d.name);
  }
  const ex = CANONICAL_MESSAGE_MANIFEST.exclusions;
  assert.deepEqual([...ex.taskDomainProjection.fields].sort(), [
    "taskAssigneeId", "taskAssigneeName", "taskAssigneeType", "taskClaimedAt", "taskCompletedAt", "taskCurrentProjection", "taskNumber", "taskStatus",
  ]);
  assert.deepEqual([...ex.emittedUnconsumed.fields], ["updatedAt"]);
  assert.deepEqual([...ex.storageOnlySealed.fields].sort(), ["agentSendKey", "searchText", "searchVector"]);
  for (const entry of Object.values(ex)) {
    assert.ok(entry.migrationStatus.length > 0, "every exclusion entry carries migration status");
  }
  assert.match(CANONICAL_MESSAGE_MANIFEST.producerRegistryAnchor, /^slock#4593@b0fcdfd9/);
});
