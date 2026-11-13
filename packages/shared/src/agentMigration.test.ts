import assert from "node:assert/strict";
import {
  MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  MAX_AGENT_MIGRATION_TRANSFER_BYTES,
  MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT,
  agentMigrationTransferSummarySchema,
} from "./agentMigration";

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

const IGNORED = {
  count: 5,
  fileCount: 40,
  bytes: 9_000,
  largest: [{ path: "datasets", bytes: 8_000 }],
};
const BY_SOURCE = {
  userFile: { count: 1, fileCount: 10, bytes: 1_000 },
  agentFile: { count: 3, fileCount: 25, bytes: 7_500 },
  legacyFile: { count: 1, fileCount: 5, bytes: 500 },
  wildcard: { count: 2, fileCount: 12, bytes: 300 },
};

test("migration transfer summary: excludedIgnoredBySource stays optional for older Computers", () => {
  const legacy = { ...VALID_SUMMARY, excludedIgnored: IGNORED };
  assert.deepEqual(agentMigrationTransferSummarySchema.parse(legacy), legacy);
  const withSources = { ...legacy, excludedIgnoredBySource: BY_SOURCE };
  assert.deepEqual(agentMigrationTransferSummarySchema.parse(withSources), withSources);
  const zero = { count: 0, fileCount: 0, bytes: 0 };
  assert.equal(agentMigrationTransferSummarySchema.safeParse({
    ...VALID_SUMMARY,
    excludedIgnored: { count: 0, fileCount: 0, bytes: 0, largest: [] },
    excludedIgnoredBySource: { userFile: zero, agentFile: zero, legacyFile: zero, wildcard: zero },
  }).success, true);
});

test("migration transfer summary: excludedIgnoredBySource is strict and bounded by excludedIgnored", () => {
  const base = { ...VALID_SUMMARY, excludedIgnored: IGNORED };
  for (const candidate of [
    { ...VALID_SUMMARY, excludedIgnoredBySource: BY_SOURCE },
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, extra: { count: 0, fileCount: 0, bytes: 0 } } },
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, userFile: { ...BY_SOURCE.userFile, path: "x" } } },
    { ...base, excludedIgnoredBySource: { agentFile: BY_SOURCE.agentFile, legacyFile: BY_SOURCE.legacyFile, userFile: BY_SOURCE.userFile } },
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, userFile: { ...BY_SOURCE.userFile, bytes: -1 } } },
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, userFile: { ...BY_SOURCE.userFile, count: 1.5 } } },
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, agentFile: { ...BY_SOURCE.agentFile, count: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT + 1 } } },
    // Sources partition the ignored paths: never more than the total.
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, agentFile: { ...BY_SOURCE.agentFile, count: 4 } } },
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, agentFile: { ...BY_SOURCE.agentFile, fileCount: 26 } } },
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, agentFile: { ...BY_SOURCE.agentFile, bytes: 7_501 } } },
    // Wildcard matches are a subset of the sourced paths.
    { ...base, excludedIgnoredBySource: { ...BY_SOURCE, wildcard: { ...BY_SOURCE.wildcard, count: 6 } } },
  ]) {
    assert.equal(agentMigrationTransferSummarySchema.safeParse(candidate).success, false, JSON.stringify(candidate.excludedIgnoredBySource));
  }
});
