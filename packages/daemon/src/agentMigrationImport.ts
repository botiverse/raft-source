import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, lstat, mkdir, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentDate } from "@botiverse/raft-shared";
import {
  AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION,
  buildAgentMigrationExportManifest,
  normalizeAgentMigrationSymlinkTarget,
  type AgentMigrationBundleFileEntry,
  type AgentMigrationExportManifest,
} from "./agentMigrationExport.js";
import { normalizeAgentMigrationWorkspaceRelativePath } from "./agentMigrationWorkspacePath.js";

export type AgentMigrationAdoptSourceKind = "staged_bundle" | "orphan_directory";

export interface AgentMigrationAdoptGeneration {
  grantKey: string;
  migrationGeneration: string;
  sourceMachineId: string;
  targetMachineId: string;
  localMachineId: string;
}

export interface AgentMigrationAdoptPlan {
  sourceKind: AgentMigrationAdoptSourceKind;
  agentId: string;
  slockHome: string;
  sourceWorkspacePath: string;
  finalWorkspacePath: string;
  reportPath: string;
  manifest: AgentMigrationExportManifest;
  manifestSha256: string;
  generation: AgentMigrationAdoptGeneration;
  attestationNonce?: string;
  observedAttestationNonce?: string;
}

export interface BuildAgentMigrationAdoptPlanInput {
  slockHome: string;
  generation: AgentMigrationAdoptGeneration;
  attestationNonce?: string;
  observedAttestationNonce?: string;
  finalWorkspacePath?: string;
  reportPath?: string;
  now?: Date;
}

export interface BuildStagedAgentMigrationAdoptPlanInput extends BuildAgentMigrationAdoptPlanInput {
  sourceKind: "staged_bundle";
  stagingWorkspacePath: string;
  manifest: AgentMigrationExportManifest;
  manifestSha256?: string;
}

export interface BuildOrphanAgentMigrationAdoptPlanInput extends BuildAgentMigrationAdoptPlanInput {
  sourceKind: "orphan_directory";
  orphanWorkspacePath: string;
  agentId: string;
  manifest?: AgentMigrationExportManifest;
  manifestSha256?: string;
}

export type BuildAgentMigrationAdoptPlanInputUnion =
  | BuildStagedAgentMigrationAdoptPlanInput
  | BuildOrphanAgentMigrationAdoptPlanInput;

export interface AgentMigrationVerificationSummary {
  fileCount: number;
  totalBytes: number;
}

export interface AgentMigrationRebindResult {
  grantKey?: string;
  migrationGeneration?: string;
  sourceMachineId?: string;
  targetMachineId?: string;
}

export interface AgentMigrationRebindClient {
  startTransfer(input: { grantKey: string; migrationGeneration: string }): Promise<AgentMigrationRebindResult | void>;
  flipMachine(input: { grantKey: string; migrationGeneration: string }): Promise<AgentMigrationRebindResult | void>;
  markArrived(input: {
    grantKey: string;
    migrationGeneration: string;
    reportPath: string;
    reportSha256: string;
  }): Promise<AgentMigrationRebindResult | void>;
}

export interface AgentMigrationArrivalReport {
  schemaVersion: "agent-arrival/v1";
  agentId: string;
  sourceKind: AgentMigrationAdoptSourceKind;
  grantKey: string;
  migrationGeneration: string;
  sourceMachineId: string;
  targetMachineId: string;
  manifestSha256: string;
  finalWorkspacePath: string;
  verified: AgentMigrationVerificationSummary;
  attestation: {
    noncePresent: boolean;
    nonceVerified: boolean;
  };
  arrivedAt: string;
}

export interface ExecuteAgentMigrationAdoptPlanResult {
  report: AgentMigrationArrivalReport;
  reportPath: string;
  reportSha256: string;
}

export interface AgentMigrationAdoptExecutionHooks {
  signal?: AbortSignal;
  onWorkspacePlacementStarting?: (finalWorkspacePath: string) => void | Promise<void>;
  onWorkspacePlaced?: (finalWorkspacePath: string) => void | Promise<void>;
  onFlipCommitted?: () => void | Promise<void>;
}

export async function buildAgentMigrationAdoptPlan(input: BuildAgentMigrationAdoptPlanInputUnion): Promise<AgentMigrationAdoptPlan> {
  const slockHome = path.resolve(input.slockHome);
  let manifest: AgentMigrationExportManifest;
  if (input.sourceKind === "orphan_directory" && !input.manifest) {
    manifest = await buildAgentMigrationExportManifest({
      agentId: input.agentId,
      slockHome,
      workspacePath: path.resolve(input.orphanWorkspacePath),
      mode: "forensic",
      now: input.now,
    });
  } else if (input.manifest) {
    manifest = input.manifest;
  } else {
    throw new Error("MIGRATION_MANIFEST_MISSING");
  }

  assertManifestIdentity({
    manifest,
    expectedAgentId: input.sourceKind === "orphan_directory" ? input.agentId : manifest.agentId,
  });

  const sourceWorkspacePath = path.resolve(
    input.sourceKind === "staged_bundle" ? input.stagingWorkspacePath : input.orphanWorkspacePath,
  );
  const finalWorkspacePath = path.resolve(input.finalWorkspacePath ?? path.join(slockHome, "agents", manifest.agentId));
  const reportPath = path.resolve(input.reportPath ?? path.join(
    slockHome,
    "migrations",
    sanitizePathSegment(input.generation.grantKey),
    "arrival-report.json",
  ));
  const manifestSha256 = hashAgentMigrationManifest(manifest);
  if (input.manifestSha256 && input.manifestSha256 !== manifestSha256) {
    throw new Error("MIGRATION_MANIFEST_SHA_MISMATCH");
  }

  return {
    sourceKind: input.sourceKind,
    agentId: manifest.agentId,
    slockHome,
    sourceWorkspacePath,
    finalWorkspacePath,
    reportPath,
    manifest,
    manifestSha256,
    generation: input.generation,
    attestationNonce: input.attestationNonce,
    observedAttestationNonce: input.observedAttestationNonce,
  };
}

export async function verifyAgentMigrationAdoptPlan(plan: AgentMigrationAdoptPlan): Promise<AgentMigrationVerificationSummary> {
  assertGeneration(plan.generation);
  assertManifestIdentity({ manifest: plan.manifest, expectedAgentId: plan.agentId });
  const actualManifestSha256 = hashAgentMigrationManifest(plan.manifest);
  if (actualManifestSha256 !== plan.manifestSha256) {
    throw new Error("MIGRATION_MANIFEST_SHA_MISMATCH");
  }

  let totalBytes = 0;
  let fileCount = 0;
  for (const entry of plan.manifest.files) {
    await verifyManifestFileEntry(plan.sourceWorkspacePath, entry);
    if (entry.kind === "file") {
      fileCount += 1;
      totalBytes += entry.sizeBytes ?? 0;
    }
  }

  return { fileCount, totalBytes };
}

export async function executeAgentMigrationAdoptPlan(
  plan: AgentMigrationAdoptPlan,
  rebind: AgentMigrationRebindClient,
  now: Date = currentDate(),
  hooks: AgentMigrationAdoptExecutionHooks = {},
): Promise<ExecuteAgentMigrationAdoptPlanResult> {
  hooks.signal?.throwIfAborted();
  assertGeneration(plan.generation);
  await assertFinalWorkspaceAvailable(plan.sourceWorkspacePath, plan.finalWorkspacePath);
  const verified = await verifyAgentMigrationAdoptPlan(plan);
  hooks.signal?.throwIfAborted();
  let migrationGeneration = plan.generation.migrationGeneration;

  migrationGeneration = await assertRebindResult(plan, migrationGeneration, await rebind.startTransfer({
    grantKey: plan.generation.grantKey,
    migrationGeneration,
  }));

  hooks.signal?.throwIfAborted();
  await hooks.onWorkspacePlacementStarting?.(plan.finalWorkspacePath);
  await placeWorkspace(plan.sourceWorkspacePath, plan.finalWorkspacePath);
  await hooks.onWorkspacePlaced?.(plan.finalWorkspacePath);
  hooks.signal?.throwIfAborted();

  migrationGeneration = await assertRebindResult(plan, migrationGeneration, await rebind.flipMachine({
    grantKey: plan.generation.grantKey,
    migrationGeneration,
  }));
  await hooks.onFlipCommitted?.();
  hooks.signal?.throwIfAborted();

  const report: AgentMigrationArrivalReport = {
    schemaVersion: "agent-arrival/v1",
    agentId: plan.agentId,
    sourceKind: plan.sourceKind,
    grantKey: plan.generation.grantKey,
    migrationGeneration,
    sourceMachineId: plan.generation.sourceMachineId,
    targetMachineId: plan.generation.targetMachineId,
    manifestSha256: plan.manifestSha256,
    finalWorkspacePath: plan.finalWorkspacePath,
    verified,
    attestation: {
      noncePresent: Boolean(plan.attestationNonce),
      nonceVerified: Boolean(plan.attestationNonce && plan.observedAttestationNonce === plan.attestationNonce),
    },
    arrivedAt: now.toISOString(),
  };
  const reportSha256 = await writeArrivalReport(plan.reportPath, report);

  await assertRebindResult(plan, migrationGeneration, await rebind.markArrived({
    grantKey: plan.generation.grantKey,
    migrationGeneration,
    reportPath: plan.reportPath,
    reportSha256,
  }));

  return { report, reportPath: plan.reportPath, reportSha256 };
}

export function hashAgentMigrationManifest(manifest: AgentMigrationExportManifest): string {
  return sha256Buffer(Buffer.from(canonicalJson(manifest), "utf8"));
}

function assertManifestIdentity(input: { manifest: AgentMigrationExportManifest; expectedAgentId: string }): void {
  if (input.manifest.schemaVersion !== AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION) {
    throw new Error("MIGRATION_MANIFEST_SCHEMA_UNSUPPORTED");
  }
  if (input.manifest.agentId !== input.expectedAgentId) {
    throw new Error("MIGRATION_MANIFEST_AGENT_MISMATCH");
  }
}

function assertGeneration(generation: AgentMigrationAdoptGeneration): void {
  if (generation.localMachineId !== generation.targetMachineId) {
    throw new Error("MIGRATION_TARGET_MACHINE_MISMATCH");
  }
  if (generation.sourceMachineId === generation.targetMachineId) {
    throw new Error("MIGRATION_SOURCE_TARGET_MACHINE_MATCH");
  }
  if (!generation.grantKey || !generation.migrationGeneration) {
    throw new Error("MIGRATION_GENERATION_MISSING");
  }
}

async function assertRebindResult(
  plan: AgentMigrationAdoptPlan,
  expectedGeneration: string,
  result: AgentMigrationRebindResult | void,
): Promise<string> {
  if (!result) return expectedGeneration;
  if (result.grantKey && result.grantKey !== plan.generation.grantKey) {
    throw new Error("MIGRATION_REBIND_GRANT_MISMATCH");
  }
  if (result.migrationGeneration !== undefined && result.migrationGeneration.length === 0) {
    throw new Error("MIGRATION_REBIND_GENERATION_MISMATCH");
  }
  if (result.sourceMachineId && result.sourceMachineId !== plan.generation.sourceMachineId) {
    throw new Error("MIGRATION_REBIND_SOURCE_MACHINE_MISMATCH");
  }
  if (result.targetMachineId && result.targetMachineId !== plan.generation.targetMachineId) {
    throw new Error("MIGRATION_REBIND_TARGET_MACHINE_MISMATCH");
  }
  return result.migrationGeneration ?? expectedGeneration;
}

async function verifyManifestFileEntry(sourceWorkspacePath: string, entry: AgentMigrationBundleFileEntry): Promise<void> {
  if (entry.source !== "workspace") {
    throw new Error("MIGRATION_MANIFEST_ENTRY_NOT_WORKSPACE");
  }
  const relative = normalizeAgentMigrationWorkspaceRelativePath(
    entry.workspaceRelativePath,
    "MIGRATION_MANIFEST_UNSAFE_PATH",
  );
  const entryPath = path.join(sourceWorkspacePath, relative);
  const info = await lstat(entryPath).catch(() => null);
  if (!info) throw new Error("MIGRATION_MANIFEST_FILE_MISSING");

  if (entry.kind === "symlink") {
    if (!info.isSymbolicLink()) throw new Error("MIGRATION_MANIFEST_KIND_MISMATCH");
    if (entry.linkTarget === undefined) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
    const expectedLinkTarget = normalizeAgentMigrationSymlinkTarget(relative, entry.linkTarget);
    if (expectedLinkTarget !== entry.linkTarget) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
    const linkTarget = await readlink(entryPath);
    if (expectedLinkTarget !== linkTarget) throw new Error("MIGRATION_MANIFEST_LINK_MISMATCH");
    return;
  }

  if (!info.isFile()) throw new Error("MIGRATION_MANIFEST_KIND_MISMATCH");
  if (entry.sizeBytes !== undefined && entry.sizeBytes !== info.size) {
    throw new Error("MIGRATION_MANIFEST_FILE_SIZE_MISMATCH");
  }
  if (entry.sha256) {
    const actual = await sha256File(entryPath);
    if (actual !== entry.sha256) throw new Error("MIGRATION_MANIFEST_FILE_SHA_MISMATCH");
  }
}

async function assertFinalWorkspaceAvailable(sourceWorkspacePath: string, finalWorkspacePath: string): Promise<void> {
  if (path.resolve(sourceWorkspacePath) === path.resolve(finalWorkspacePath)) return;
  try {
    await access(finalWorkspacePath);
    throw new Error("MIGRATION_WORKSPACE_ALREADY_EXISTS");
  } catch (err) {
    if (err instanceof Error && err.message === "MIGRATION_WORKSPACE_ALREADY_EXISTS") throw err;
  }
}

async function placeWorkspace(sourceWorkspacePath: string, finalWorkspacePath: string): Promise<void> {
  if (path.resolve(sourceWorkspacePath) === path.resolve(finalWorkspacePath)) return;
  // Accepted ambient clock: this suffix is only a same-process uniqueness guard for temp paths, not business time.
  const stagingPath = `${finalWorkspacePath}.migration-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(finalWorkspacePath), { recursive: true });
  await cp(sourceWorkspacePath, stagingPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  await rename(stagingPath, finalWorkspacePath);
}

async function writeArrivalReport(reportPath: string, report: AgentMigrationArrivalReport): Promise<string> {
  const payload = `${canonicalJson(report)}\n`;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, payload, { mode: 0o600 });
  return sha256Buffer(Buffer.from(payload, "utf8"));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "migration";
}
