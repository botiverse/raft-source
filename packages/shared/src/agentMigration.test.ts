import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  MAX_AGENT_MIGRATION_TRANSFER_BYTES,
  MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT,
  agentMigrationTransferSummarySchema,
} from "./agentMigration.js";

const VALID_SUMMARY = {
  includedFileCount: 2,
  includedBytes: 128,
  excludedRegenerableCount: 4,
  excludedRegenerableByCategory: {
    thirdPartyDependencies: 1,
    caches: 1,
    buildArtifacts: 1,
    otherRegenerable: 1,
  },
  keyWorkspaceEntries: {
    memoryMdPresent: true,
    notesPresent: false,
  },
} as const;

test("migration transfer summary accepts bounded pathless counts", () => {
  assert.equal(MAX_AGENT_MIGRATION_TRANSPORT_BYTES, 10 * 1024 * 1024 * 1024);
  assert.equal(MAX_AGENT_MIGRATION_TRANSFER_BYTES, MAX_AGENT_MIGRATION_TRANSPORT_BYTES);
  assert.deepEqual(agentMigrationTransferSummarySchema.parse(VALID_SUMMARY), VALID_SUMMARY);
  assert.equal(agentMigrationTransferSummarySchema.parse({
    ...VALID_SUMMARY,
    includedFileCount: MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT,
    includedBytes: MAX_AGENT_MIGRATION_TRANSFER_BYTES,
    excludedRegenerableCount: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
    excludedRegenerableByCategory: {
      thirdPartyDependencies: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
      caches: 0,
      buildArtifacts: 0,
      otherRegenerable: 0,
    },
  }).includedBytes, MAX_AGENT_MIGRATION_TRANSFER_BYTES);
});

test("migration transfer summary rejects paths, hints, secrets, invalid sums, and out-of-range values", () => {
  for (const candidate of [
    { ...VALID_SUMMARY, sourcePath: "/Users/alice/.slock/agents/secret" },
    { ...VALID_SUMMARY, hints: ["workspace/private"] },
    { ...VALID_SUMMARY, apiKey: "sk_agent_secret" },
    { ...VALID_SUMMARY, includedFileCount: -1 },
    { ...VALID_SUMMARY, includedFileCount: MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT + 1 },
    { ...VALID_SUMMARY, includedBytes: MAX_AGENT_MIGRATION_TRANSFER_BYTES + 1 },
    { ...VALID_SUMMARY, excludedRegenerableCount: 3 },
    {
      ...VALID_SUMMARY,
      excludedRegenerableByCategory: {
        ...VALID_SUMMARY.excludedRegenerableByCategory,
        path: "node_modules",
      },
    },
  ]) {
    assert.equal(agentMigrationTransferSummarySchema.safeParse(candidate).success, false);
  }
});
