#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LegacyAgentMigrationRepairPreview,
  LegacyAgentMigrationRepairResult,
  LegacyAgentMigrationRepairTarget,
} from "./agentMigrationLegacyRepairService.js";

const APPLY_CONFIRMATION = "task39-john-migration-completion";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const JOHN_MIGRATION_REPAIR_TARGET = {
  migrationId: "51fa7e35-4275-4ce3-81da-965d6a79eb1d",
  serverId: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
  agentId: "9c3b3d7f-291a-4a21-862b-37e754186cdf",
  targetMachineId: "0e4be332-1000-4a91-b01e-10b2d54cb46a",
  expectedRevision: 9,
} as const;

export type JohnMigrationRepairOptions =
  | { mode: "preview" }
  | { mode: "apply"; expectedPrestateSha256: string };

export function parseJohnMigrationRepairArgs(argv: string[]): JohnMigrationRepairOptions {
  let apply = false;
  let confirm: string | null = null;
  let expectedPrestateSha256: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--confirm" && argv[index + 1]) {
      confirm = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (arg === "--prestate-sha256" && argv[index + 1]) {
      expectedPrestateSha256 = argv[index + 1]!;
      index += 1;
      continue;
    }
    throw new Error("JOHN_MIGRATION_REPAIR_INVALID_ARGUMENTS");
  }

  if (!apply) {
    if (confirm !== null || expectedPrestateSha256 !== null) {
      throw new Error("JOHN_MIGRATION_REPAIR_INVALID_ARGUMENTS");
    }
    return { mode: "preview" };
  }
  if (
    confirm !== APPLY_CONFIRMATION
    || !expectedPrestateSha256
    || !SHA256_PATTERN.test(expectedPrestateSha256)
  ) {
    throw new Error("JOHN_MIGRATION_REPAIR_CONFIRMATION_REQUIRED");
  }
  return { mode: "apply", expectedPrestateSha256 };
}

const EXPOSED_ERROR_CODES = new Set([
  "JOHN_MIGRATION_REPAIR_INVALID_ARGUMENTS",
  "JOHN_MIGRATION_REPAIR_CONFIRMATION_REQUIRED",
  "JOHN_MIGRATION_REPAIR_DATABASE_URL_REQUIRED",
  "MIGRATION_LEGACY_REPAIR_SCHEMA_NOT_READY",
  "MIGRATION_LEGACY_REPAIR_NOT_FOUND",
  "MIGRATION_LEGACY_REPAIR_HOLDER_DRIFT",
  "MIGRATION_LEGACY_REPAIR_ACTIVE_SET_DRIFT",
  "MIGRATION_LEGACY_REPAIR_RECEIPT_CONTEXT_MISSING",
  "MIGRATION_LEGACY_REPAIR_RECEIPT_SURFACE_DRIFT",
  "MIGRATION_LEGACY_REPAIR_RECEIPT_AUDIENCE_DRIFT",
  "MIGRATION_LEGACY_REPAIR_PRESTATE_NOT_ELIGIBLE",
  "MIGRATION_LEGACY_REPAIR_TERMINAL_EVIDENCE_DRIFT",
  "MIGRATION_LEGACY_REPAIR_RECEIPT_ALREADY_EXISTS",
  "MIGRATION_LEGACY_REPAIR_PRESTATE_DRIFT",
  "MIGRATION_LEGACY_REPAIR_CONCURRENT_UPDATE",
]);

export function normalizeJohnMigrationRepairError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return EXPOSED_ERROR_CODES.has(message) ? message : "JOHN_MIGRATION_REPAIR_FAILED";
}

export type JohnMigrationRepairDependencies = {
  initDatabase: (databaseUrl: string) => Promise<unknown>;
  closeDatabase: () => Promise<void>;
  preview: (target: LegacyAgentMigrationRepairTarget) => Promise<LegacyAgentMigrationRepairPreview>;
  apply: (
    target: LegacyAgentMigrationRepairTarget & { expectedPrestateSha256: string; now?: Date },
  ) => Promise<LegacyAgentMigrationRepairResult>;
};

async function loadDefaultDependencies(): Promise<JohnMigrationRepairDependencies> {
  const [database, repair] = await Promise.all([
    import("../../../../src/db/index.js"),
    import("./agentMigrationLegacyRepairService.js"),
  ]);
  return {
    initDatabase: database.initDatabase,
    closeDatabase: database.closeDatabase,
    preview: repair.previewLegacyAgentMigrationCompletion,
    apply: repair.applyLegacyAgentMigrationCompletion,
  };
}

export async function runJohnMigrationRepair(input: {
  argv: string[];
  databaseUrl: string | undefined;
  writeStdout?: (line: string) => void;
  dependencies?: JohnMigrationRepairDependencies;
}): Promise<void> {
  const options = parseJohnMigrationRepairArgs(input.argv);
  if (!input.databaseUrl) throw new Error("JOHN_MIGRATION_REPAIR_DATABASE_URL_REQUIRED");
  const writeStdout = input.writeStdout ?? console.log;
  const dependencies = input.dependencies ?? await loadDefaultDependencies();
  await dependencies.initDatabase(input.databaseUrl);
  try {
    if (options.mode === "preview") {
      const preview = await dependencies.preview(JOHN_MIGRATION_REPAIR_TARGET);
      if (preview.status === "already_repaired") {
        writeStdout("JOHN_MIGRATION_REPAIR_ALREADY_APPLIED");
        return;
      }
      writeStdout(`JOHN_MIGRATION_REPAIR_PREVIEW_READY prestate_sha256=${preview.prestateSha256}`);
      return;
    }
    const result = await dependencies.apply({
      ...JOHN_MIGRATION_REPAIR_TARGET,
      expectedPrestateSha256: options.expectedPrestateSha256,
    });
    if (result.status === "already_repaired") {
      writeStdout("JOHN_MIGRATION_REPAIR_ALREADY_APPLIED");
      return;
    }
    writeStdout(`JOHN_MIGRATION_REPAIR_APPLIED revision=${result.revision}`);
  } finally {
    await dependencies.closeDatabase();
  }
}

async function main(): Promise<void> {
  try {
    await runJohnMigrationRepair({
      argv: process.argv.slice(2),
      databaseUrl: process.env.DATABASE_URL,
    });
  } catch (error) {
    console.error(normalizeJohnMigrationRepairError(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
