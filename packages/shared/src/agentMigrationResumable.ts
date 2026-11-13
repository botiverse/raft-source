import type { AgentMigrationTransferSummary } from "./agentMigration";
import { COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS } from "./computerUpgradeDrain";

// transferSummary is required on the v2 wire contract. Keep both the protocol
// and control schema versioned so a rolling deployment fails closed at start:
// an old Server rejects a v2 daemon, and a v2 Server rejects an old daemon,
// before migration state or transfer resources can be created.
export const AGENT_MIGRATION_RESUMABLE_PROTOCOL = "agent-migration/resumable-v2" as const;
export const AGENT_MIGRATION_CONTROL_SCHEMA_VERSION = "agent-migration-control/v2" as const;
/**
 * The one migration capability. A Computer advertises it in
 * `ready.migrationTransport.capabilities`; the Server starts a migration only
 * when both the source and the target advertise it. It covers the whole
 * protocol: streamed chunk upload/download, staged atomic commit, the transfer
 * summary, source workspace archive, active-lease reporting, and the
 * AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES limit. The control manifest names it as
 * the capability a target needs to import the bundle.
 */
export const AGENT_MIGRATION_CAPABILITY = "migration/v3" as const;
/**
 * Advertised in `ready.migrationTransport.capabilities` by a Computer whose
 * control-manifest schema accepts `excludedIgnoredBySource` in the transfer
 * summary when it is a migration target. The Server sets the source lease's
 * `targetAcceptsIgnoreSources` only when the target advertises it.
 */
export const AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY = "migration:target-ignore-sources-v1" as const;
/**
 * Advertised in `ready.migrationTransport.capabilities` by a Computer that, as a
 * migration source, writes the source lease's `userIgnoreAdditions` into the
 * agent's `.raftbackupignore.user` before it packs (./agentMigrationUserIgnore).
 */
export const AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY = "migration:source-user-ignore-v1" as const;
/**
 * Advertised in `ready.migrationTransport.capabilities` by a Computer whose
 * daemon and CLI let the agent retry, once, a migration that failed because
 * its workspace was too big (`raft migration retry`, ./agentMigrationRetry).
 * The Server accepts the retry only when the failed migration's SOURCE
 * advertises it (the agent runs and trims its workspace there), and only then
 * does the failed receipt tell the agent it can.
 */
export const AGENT_MIGRATION_AGENT_RETRY_CAPABILITY = "migration:agent-retry-v1" as const;
/**
 * Reconciler step 14 (Q-H). Advertised in `ready.migrationTransport.capabilities`
 * by a Computer that, as a migration source, stops the agent only once it is
 * quiet: it holds new deliveries and reminders for that agent and waits for
 * it to be idle (the step 13 drain, for one agent), at most
 * AGENT_MIGRATION_SOURCE_DRAIN_MAX_MS, then stops it. It waits only when the
 * source lease carries `sourceDrainUntil`: the Server sends that only for a
 * migration it gave the longer prep window (so an old Server's migration is
 * stopped at once, as before, and never aborted at its prep deadline while
 * the source still waits).
 */
export const AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY = "migration:source-drain-v1" as const;
/** The longest a migration source waits for its agent to be quiet: the step 13 drain cap (the daemon clamps to it too). */
export const AGENT_MIGRATION_SOURCE_DRAIN_MAX_MS = COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS;
export const AGENT_MIGRATION_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
export const AGENT_MIGRATION_MIN_CHUNK_BYTES = 1024 * 1024;
export const AGENT_MIGRATION_MAX_CHUNKS = 2_048;
export const AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES = 512 * 1024;
export const AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES = 2_000_000;
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
    required: readonly [typeof AGENT_MIGRATION_CAPABILITY];
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
