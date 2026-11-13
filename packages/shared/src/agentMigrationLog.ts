import { z } from "zod";
import { lazySchema } from "./lazySchema";

/**
 * The migration log of one server: every move of an agent between computers
 * (and to the cloud), for the server's owners and admins (GET
 * /api/agent-migrations/log). The web page draws the routes between computers
 * from it and filters it by agent, computer, outcome and time on the client.
 */
export const agentMigrationLogOutcomeSchema = lazySchema("agentMigrationLogOutcomeSchema", () => z.enum(["completed", "failed", "canceled", "in_progress"]));
export type AgentMigrationLogOutcome = z.infer<typeof agentMigrationLogOutcomeSchema>;

/**
 * Why a failed move failed, as a reason people can act on. `too_large`: the
 * workspace was over the size limit; `network`: the transfer lost its
 * connection; `other`: anything else (the raw code stays in `failureCode`).
 */
export const agentMigrationLogFailureKindSchema = lazySchema("agentMigrationLogFailureKindSchema", () => z.enum(["too_large", "network", "other"]));
export type AgentMigrationLogFailureKind = z.infer<typeof agentMigrationLogFailureKindSchema>;

export const agentMigrationLogEntrySchema = lazySchema("agentMigrationLogEntrySchema", () => z.object({
  migrationRef: z.string(),
  agentId: z.string(),
  sourceMachineId: z.string(),
  /** The source computer's name when the move started (it may be renamed or deleted since). */
  sourceMachineName: z.string().nullable(),
  targetKind: z.enum(["computer", "hosted"]),
  targetMachineId: z.string().nullable(),
  targetMachineName: z.string().nullable(),
  /** Who started it, while they are still a member of the server. */
  initiatedBy: z.object({ id: z.string(), name: z.string(), displayName: z.string().nullable() }).nullable(),
  outcome: agentMigrationLogOutcomeSchema,
  startedAt: z.string(),
  /** When it completed, failed or was canceled; null while it is in progress. */
  endedAt: z.string().nullable(),
  /** Uncompressed bytes and files packed from the source workspace, when the source reported them. */
  bytes: z.number().nullable(),
  files: z.number().nullable(),
  failureKind: agentMigrationLogFailureKindSchema.nullable(),
  failureCode: z.string().nullable(),
}));
export type AgentMigrationLogEntry = z.infer<typeof agentMigrationLogEntrySchema>;

export const agentMigrationLogResponseSchema = lazySchema("agentMigrationLogResponseSchema", () => z.object({
  /** Oldest first. */
  migrations: z.array(agentMigrationLogEntrySchema),
  /** True when the server holds more than the route returns (the newest are kept). */
  truncated: z.boolean(),
}));
export type AgentMigrationLogResponse = z.infer<typeof agentMigrationLogResponseSchema>;
