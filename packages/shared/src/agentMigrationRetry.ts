// An agent's own retry of a migration to another Computer that just failed
// because its workspace was too big (Artea, product; Tenny, CTO; thread
// #wg-agent-migration 7746de27 msg f607ea47). The agent trims its workspace
// (deletes files or lists them in its ignore file) and asks the Server once,
// with no parameters, to start the same migration again on behalf of the
// person who started the failed one:
// `POST /internal/agent-api/migrations/retry` (agentApiContract
// `migrationRetry`, CLI `raft migration retry`).
import { z } from "zod";
import { lazySchema } from "./lazySchema";

/** How long after a size failure the agent may still retry it (from when it failed). */
export const AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Why the Server refused an agent's retry (the refusal envelope's `code`;
 * informative codes, not in REFUSAL_CODES: clients show `error` as sent). A
 * refused retry does not use up the one retry.
 */
export const AGENT_MIGRATION_RETRY_REFUSAL_CODES = {
  /** The agent's latest migration is not a size failure of a move to another Computer, or the agent was moved since. */
  NO_RETRYABLE_MIGRATION: "NO_RETRYABLE_MIGRATION",
  /** That migration was already retried once, or it is itself the retry. */
  ALREADY_RETRIED: "ALREADY_RETRIED",
  /** It failed more than AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS ago. */
  RETRY_WINDOW_EXPIRED: "RETRY_WINDOW_EXPIRED",
  /** The source Computer does not advertise AGENT_MIGRATION_AGENT_RETRY_CAPABILITY (or is not connected). */
  SOURCE_UNSUPPORTED: "SOURCE_UNSUPPORTED",
  /** The person who started it may no longer migrate this agent (or left the server). */
  STARTER_NOT_AUTHORIZED: "STARTER_NOT_AUTHORIZED",
  /** The target Computer cannot take the agent now (gone, offline, outdated, still detecting runtimes, lacks the runtime). */
  TARGET_UNAVAILABLE: "TARGET_UNAVAILABLE",
  /** The server is no longer on a plan with agent migration. */
  PLAN_REQUIRED: "PLAN_REQUIRED",
  /** Another migration of this agent is in progress. */
  MIGRATION_ACTIVE: "MIGRATION_ACTIVE",
} as const;

export type AgentMigrationRetryRefusalCode =
  (typeof AGENT_MIGRATION_RETRY_REFUSAL_CODES)[keyof typeof AGENT_MIGRATION_RETRY_REFUSAL_CODES];

/** The `note` of an accepted retry. */
export const AGENT_MIGRATION_RETRY_NOTE = "The source will stop you once you are idle, then move you." as const;

/** `POST /internal/agent-api/migrations/retry` → 200. */
export const agentApiMigrationRetryResponseSchema = lazySchema("agentApiMigrationRetryResponseSchema", () => z.object({
  /** The new migration's id. */
  migrationId: z.string().uuid(),
  /** Its support ref (`mig_...`), as receipts and the owner's view name it. */
  supportRef: z.string().min(1),
  /** The Computer it moves the agent to (the failed migration's target), by its name when the migration started. */
  targetMachineName: z.string().min(1),
  note: z.string().min(1),
}).passthrough());

export type AgentApiMigrationRetryResponse = z.infer<typeof agentApiMigrationRetryResponseSchema>;
