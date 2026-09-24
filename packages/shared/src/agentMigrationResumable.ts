import type { AgentMigrationTransferSummary } from "./agentMigration.js";

// transferSummary is required on the v2 wire contract. Keep both the protocol
// and control schema versioned so a rolling deployment fails closed at start:
// an old Server rejects a v2 daemon, and a v2 Server rejects an old daemon,
// before migration state or transfer resources can be created.
export const AGENT_MIGRATION_RESUMABLE_PROTOCOL = "agent-migration/resumable-v2" as const;
export const AGENT_MIGRATION_CONTROL_SCHEMA_VERSION = "agent-migration-control/v2" as const;
export const AGENT_MIGRATION_RESUMABLE_CAPABILITIES = [
  "migration:chunk-upload-v1",
  "migration:chunk-download-v1",
  "migration:staged-atomic-commit-v1",
  "migration:transfer-summary-v1",
] as const;
export const AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY =
  "migration:source-workspace-archive-v1" as const;
export const AGENT_MIGRATION_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
export const AGENT_MIGRATION_MIN_CHUNK_BYTES = 1024 * 1024;
export const AGENT_MIGRATION_MAX_CHUNKS = 2_048;
export const AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES = 512 * 1024;
export const AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES = 250_000;
export const AGENT_MIGRATION_COMMIT_MARKER_PATH = ".raft-migration/commit-v1.json" as const;
export const AGENT_MIGRATION_BUNDLE_CONTENT_TYPE =
  "application/vnd.raft.agent-migration-bundle+tar+gzip" as const;

export interface AgentMigrationControlChunk {
  index: number;
  offsetBytes: number;
  sizeBytes: number;
  sha256: string;
}

export interface AgentMigrationControlManifest {
  schemaVersion: typeof AGENT_MIGRATION_CONTROL_SCHEMA_VERSION;
  protocol: typeof AGENT_MIGRATION_RESUMABLE_PROTOCOL;
  identity: {
    migrationId: string;
    migrationGeneration: string;
    leaseId: string;
    agentId: string;
    sourceMachineId: string;
    targetMachineId: string;
  };
  capability: {
    required: typeof AGENT_MIGRATION_RESUMABLE_CAPABILITIES;
  };
  bundle: {
    contentType: typeof AGENT_MIGRATION_BUNDLE_CONTENT_TYPE;
    totalBytes: number;
    sha256: string;
    chunkSizeBytes: number;
    chunks: AgentMigrationControlChunk[];
  };
  archive: {
    format: "tar+gzip";
    entryCount: number;
    expandedBytes: number;
    maxEntryBytes: number;
    allowedEntryTypes: ["file", "symlink"];
  };
  transferSummary: AgentMigrationTransferSummary;
  commit: {
    mode: "atomic-rename";
    markerPath: typeof AGENT_MIGRATION_COMMIT_MARKER_PATH;
    requireWholeBundleDigest: true;
    requireAllChunkDigests: true;
    existingWorkspace: "idle-or-same-commit";
  };
}

export interface AgentMigrationChunkReceipt {
  migrationId: string;
  migrationGeneration: string;
  leaseId: string;
  chunkIndex: number;
  sizeBytes: number;
  sha256: string;
  role: "source" | "target";
}

export interface AgentMigrationSourceQuiesceReceipt {
  schemaVersion: "agent-migration-quiesce/v1";
  migrationId: string;
  migrationGeneration: string;
  agentId: string;
  sourceMachineId: string;
  sourceRuntimeState: "stopped";
  stoppedAt: string;
  actor: "migration";
  launchSessionIdentity: string;
  expectedRuntimeRevision: string;
}
