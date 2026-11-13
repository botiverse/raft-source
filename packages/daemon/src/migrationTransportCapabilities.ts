import {
  AGENT_MIGRATION_AGENT_RETRY_CAPABILITY,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY,
  AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY,
  AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY,
} from "@botiverse/raft-shared";

/**
 * What this daemon advertises in `ready.migrationTransport.capabilities`
 * (core.ts). Other daemon code that depends on one of them (the Cleaner's
 * size-failure reminder naming `raft migration retry`) reads it here, so
 * dropping a capability also drops what relies on it.
 */
export const DAEMON_MIGRATION_TRANSPORT_CAPABILITIES: readonly string[] = [
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY,
  AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY,
  AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY,
  // `raft migration retry` (the bundled CLI) and the Cleaner reminder that names it.
  AGENT_MIGRATION_AGENT_RETRY_CAPABILITY,
];

/** Whether this daemon lets its agents retry a size-failed migration themselves. */
export function daemonOffersAgentMigrationRetry(): boolean {
  return DAEMON_MIGRATION_TRANSPORT_CAPABILITIES.includes(AGENT_MIGRATION_AGENT_RETRY_CAPABILITY);
}
