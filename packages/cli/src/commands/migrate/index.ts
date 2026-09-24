import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { type AgentApiMigrationResponse, type AgentApiMigrationStatusResponse } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";

interface ExportOpts {
  mode?: string;
  target?: string;
  targetMachineId?: string;
  targetComputer?: string;
  to?: string;
  prepDeadlineMs?: string;
  transferDeadlineMs?: string;
  arrivalDeadlineMs?: string;
}

interface ImportOpts {
  targetMachineId?: string;
  to?: string;
  prepDeadlineMs?: string;
  transferDeadlineMs?: string;
  arrivalDeadlineMs?: string;
}

interface ReadyOpts {
  manifest?: string;
  manifestSha256?: string;
}

interface ArrivedOpts {
  report?: string;
  reportSha256?: string;
}

function requireNonEmpty(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw cliError("INVALID_ARG", `${flag} is required`);
  return trimmed;
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function formatMigration(migration: AgentApiMigrationResponse["migration"]): string {
  return [
    `Migration ${migration.id} (${migration.state})`,
    `Agent: ${migration.agentId}`,
    `Source machine: ${migration.sourceMachineId}`,
    `Target machine: ${migration.targetMachineId}`,
    `Prep deadline: ${migration.prepDeadlineAt}`,
    `Transfer deadline: ${migration.transferDeadlineAt}`,
    `Arrival deadline: ${migration.arrivalDeadlineAt}`,
    migration.manifestPath ? `Manifest: ${migration.manifestPath}` : null,
    migration.arrivalReportPath ? `Arrival report: ${migration.arrivalReportPath}` : null,
  ].filter(Boolean).join("\n");
}

function formatStatus(data: AgentApiMigrationStatusResponse): string {
  if (!data.migration) return "No active migration.\n";
  return `${formatMigration(data.migration)}\n`;
}

function migrationErrorCode(status: number, fallback: string): string {
  if (status >= 500) return "SERVER_5XX";
  return fallback;
}

async function ensureReadableFile(filePath: string, flag: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const fileStat = await stat(resolved).catch((cause) => {
    throw cliError("INVALID_ARG", `${flag} does not point to a readable file: ${filePath}`, { cause });
  });
  if (!fileStat.isFile()) {
    throw cliError("INVALID_ARG", `${flag} must point to a file: ${filePath}`);
  }
  return resolved;
}

export const migrateExportCommand = defineCommand(
  {
    name: "export",
    description: "Deprecated: agent-initiated migration export is not supported",
    options: [
      { flags: "--mode <mode>", description: "Export mode: cooperative or forensic" },
      { flags: "--target <target>", description: "Channel/DM/thread target to post the owner-commit card" },
      { flags: "--target-machine-id <id>", description: "Target computer UUID" },
      { flags: "--target-computer <name-or-id>", description: "Target computer name or UUID" },
      { flags: "--to <name-or-id>", description: "Alias for --target-computer" },
      { flags: "--prep-deadline-ms <n>", description: "Override prep deadline window in milliseconds" },
      { flags: "--transfer-deadline-ms <n>", description: "Override transfer deadline window in milliseconds" },
      { flags: "--arrival-deadline-ms <n>", description: "Override arrival deadline window in milliseconds" },
    ],
  },
  async (ctx, opts: ExportOpts) => {
    void ctx;
    void opts;
    throw cliError(
      "MIGRATE_EXPORT_NOT_SUPPORTED",
      "Agent-initiated migration export is not supported; start migration from the agent profile as its human creator, or with a role that includes `migrateAgents`.",
    );
  },
);

export const migrateImportCommand = defineCommand(
  {
    name: "import",
    description: "Begin migration of the current agent toward a target machine",
    options: [
      { flags: "--target-machine-id <id>", description: "Target machine UUID" },
      { flags: "--to <id>", description: "Alias for --target-machine-id" },
      { flags: "--prep-deadline-ms <n>", description: "Override prep deadline window in milliseconds" },
      { flags: "--transfer-deadline-ms <n>", description: "Override transfer deadline window in milliseconds" },
      { flags: "--arrival-deadline-ms <n>", description: "Override arrival deadline window in milliseconds" },
    ],
  },
  async (ctx, opts: ImportOpts) => {
    void ctx;
    void opts;
    throw cliError(
      "MIGRATE_IMPORT_NOT_SUPPORTED",
      "Agent-initiated migration is not supported; start migration from the agent profile as its human creator, or with a role that includes `migrateAgents`.",
    );
  },
);

export const migrateStatusCommand = defineCommand(
  {
    name: "status",
    description: "Show the active migration for the current agent",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const client = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await client.migrations.status();
    if (!res.ok || !res.data) {
      throw cliError(migrationErrorCode(res.status, "MIGRATE_STATUS_FAILED"), res.error ?? `HTTP ${res.status}`);
    }
    writeText(ctx.io, adoptCliReplyText(formatStatus(res.data)));
  },
);

export const migrateReadyCommand = defineCommand(
  {
    name: "ready",
    description: "Mark migration prep ready for the current agent",
    options: [
      { flags: "--manifest <path>", description: "Path to the prepared migration manifest" },
      { flags: "--manifest-sha256 <hash>", description: "Manifest SHA-256. Defaults to hashing --manifest when it is a readable local file." },
    ],
  },
  async (ctx, opts: ReadyOpts) => {
    const manifestPath = requireNonEmpty(opts.manifest, "--manifest");
    const localManifest = await ensureReadableFile(manifestPath, "--manifest");
    const manifestSha256 = opts.manifestSha256?.trim() || await sha256File(localManifest);
    const agentContext = ctx.loadAgentContext();
    const client = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await client.migrations.ready({ manifestPath, manifestSha256 });
    if (!res.ok || !res.data?.migration) {
      throw cliError(migrationErrorCode(res.status, "MIGRATE_READY_FAILED"), res.error ?? `HTTP ${res.status}`);
    }
    writeText(ctx.io, adoptCliReplyText(`${formatMigration(res.data.migration)}\n\nMigration prep marked ready.\n`));
  },
);

export const migrateArrivedCommand = defineCommand(
  {
    name: "arrived",
    description: "Mark migration arrival complete for the current agent",
    options: [
      { flags: "--report <path>", description: "Path to the arrival self-check report" },
      { flags: "--report-sha256 <hash>", description: "Report SHA-256. Defaults to hashing --report when provided." },
    ],
  },
  async (ctx, opts: ArrivedOpts) => {
    let reportSha256 = opts.reportSha256?.trim() || undefined;
    if (opts.report?.trim() && !reportSha256) {
      reportSha256 = await sha256File(await ensureReadableFile(opts.report, "--report"));
    }
    const agentContext = ctx.loadAgentContext();
    const client = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await client.migrations.arrived({
      ...(opts.report?.trim() ? { reportPath: opts.report.trim() } : {}),
      ...(reportSha256 ? { reportSha256 } : {}),
    });
    if (!res.ok || !res.data?.migration) {
      throw cliError(migrationErrorCode(res.status, "MIGRATE_ARRIVED_FAILED"), res.error ?? `HTTP ${res.status}`);
    }
    writeText(ctx.io, adoptCliReplyText(`${formatMigration(res.data.migration)}\n\nMigration arrival marked complete.\n`));
  },
);

export function registerMigrateCommands(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, migrateExportCommand, runtimeOptions);
  registerCliCommand(parent, migrateImportCommand, runtimeOptions);
  registerCliCommand(parent, migrateStatusCommand, runtimeOptions);
  registerCliCommand(parent, migrateReadyCommand, runtimeOptions);
  registerCliCommand(parent, migrateArrivedCommand, runtimeOptions);
}
