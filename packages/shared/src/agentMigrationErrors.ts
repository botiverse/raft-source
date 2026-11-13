/**
 * Closed set of migration errors that can reach an owner-facing API/UI.
 *
 * The Server imports this type at every response boundary and the Web imports
 * the same type for exhaustive copy coverage. Adding a new user-visible code
 * therefore cannot compile until the UI supplies an actionable presentation.
 */
export const AGENT_MIGRATION_TERMINAL_FAILURE_CODES = [
  "MIGRATION_TRANSPORT_LOST",
  /** A Computer got no response from object storage for minutes (proxy, firewall, outage). */
  "MIGRATION_OBJECT_STORE_UNREACHABLE",
  "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
  "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE",
  "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK",
  "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  "MIGRATION_WORKSPACE_ALREADY_EXISTS",
  "MIGRATION_WORKSPACE_COMPLETE_OLD_COPY",
  "MIGRATION_CHUNK_DIGEST_MISMATCH",
  "MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH",
  "MIGRATION_LEASE_EXPIRED",
  "MIGRATION_GENERATION_STALE",
  "MIGRATION_CONTROL_MANIFEST_INVALID",
  "MIGRATION_CONTROL_MANIFEST_TOO_LARGE",
  /** The owner of the source or target Computer asked to delete their account; its keys are revoked, so the move can never finish. */
  "MIGRATION_COMPUTER_OWNER_DELETED",
  /** The target Computer's key was revoked (detached) before the agent moved onto it; it stays on its source. */
  "MIGRATION_TARGET_COMPUTER_DETACHED",
  /**
   * The source's own transfer summary failed validation (Computer 1.0.59 and older counted more
   * than a million files under ignored paths). The Server derives it from the daemon's JS_ZodError.
   */
  "MIGRATION_TRANSFER_SUMMARY_INVALID",
  /**
   * The source could not write the paths the user chose to leave out to
   * `.raftbackupignore.user` (MIGRATION_USER_IGNORE_WRITE_FAILED in
   * ./agentMigrationUserIgnore); the detail code carries the reason.
   */
  "MIGRATION_USER_IGNORE_WRITE_FAILED",
] as const;

export type AgentMigrationTerminalFailureCode =
  (typeof AGENT_MIGRATION_TERMINAL_FAILURE_CODES)[number];

export const AGENT_MIGRATION_USER_ERROR_CODES = [
  "not_supported",
  "AGENT_NOT_FOUND",
  "TARGET_COMPUTER_REQUIRED",
  "AGENT_HAS_NO_SOURCE_MACHINE",
  "TARGET_COMPUTER_NOT_IN_SERVER",
  "TARGET_COMPUTER_MATCHES_SOURCE",
  "COMPUTER_CAPABILITY_INSUFFICIENT",
  "TARGET_COMPUTER_OFFLINE",
  /** task #1268: the target is still detecting (or never probed) the agent's runtime; retryable. */
  "TARGET_RUNTIME_DETECTION_PENDING",
  "MIGRATION_ALREADY_IN_PROGRESS",
  "MIGRATION_PRO_PLAN_REQUIRED",
  "MIGRATION_TRANSPORT_NOT_PROVISIONED",
  "MIGRATION_TRANSPORT_PROVISION_FAILED",
  "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
  /** Raft hosted is not enabled or configured for this server, or its import limits could not be read. */
  "HOSTED_TARGET_UNAVAILABLE",
  /** This agent already has a hosted runtime record (the provider keys hosted agents by Raft agent id). */
  "HOSTED_TARGET_ALREADY_USED",
  /** The hosted model picked for the migration is not one this server may use. */
  "HOSTED_TARGET_MODEL_INVALID",
  /** The hosted migration is not waiting for the user's confirmation (not built yet, already switched, or ended). */
  "HOSTED_REVIEW_NOT_READY",
  /** The workspace has a MEMORY.md the hosted import could not keep (too large, not text, or refused by the provider). */
  "HOSTED_IMPORT_MEMORY_UNIMPORTABLE",
  /** A hosted migration that already switched cannot be canceled: the agent runs at the provider. */
  "MIGRATION_NOT_CANCELABLE",
  ...AGENT_MIGRATION_TERMINAL_FAILURE_CODES,
  "MIGRATION_REF_INVALID",
  "MIGRATION_REVISION_INVALID",
  "MIGRATION_NOT_FOUND",
  "MIGRATION_REVISION_STALE",
  "MIGRATION_CONCURRENT_UPDATE",
  "MIGRATION_CANCEL_FAILED",
  "MIGRATION_START_FAILED",
  "MIGRATION_STATUS_FAILED",
] as const;

export type AgentMigrationUserErrorCode = (typeof AGENT_MIGRATION_USER_ERROR_CODES)[number];
