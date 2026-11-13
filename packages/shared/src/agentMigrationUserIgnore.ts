import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { makeIsMember } from "./typeGuards";

/**
 * Paths the user picked to leave behind (a migration over the limit), carried
 * on the source lease (`machine:migration_transport:lease`, role "source"). The
 * source Computer appends them to the agent's `.raftbackupignore.user` before it
 * reads the ignore files and packs. Only a Computer that advertises
 * AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY is sent it.
 */
export type AgentMigrationUserIgnoreAdditions = {
  /** Workspace-relative paths or `**\/<name>` lines, as `.raftbackupignore.user` reads them. */
  paths: string[];
  /** Display name of the user who picked them; written into a comment line. */
  addedBy: string;
  /** When they were picked (ISO). */
  addedAt: string;
};

export const MAX_AGENT_MIGRATION_USER_IGNORE_PATHS = 200;
export const MAX_AGENT_MIGRATION_USER_IGNORE_PATH_BYTES = 1024;
/** Rejected paths listed in a receipt; the rest are only counted. */
export const MAX_AGENT_MIGRATION_USER_IGNORE_RECEIPT_REJECTED = 20;

const utf8Encoder = new TextEncoder();

export const agentMigrationUserIgnoreAdditionsSchema = lazySchema("agentMigrationUserIgnoreAdditionsSchema", () => z.object({
  paths: z.array(
    z.string().refine(
      (value) => utf8Encoder.encode(value).length <= MAX_AGENT_MIGRATION_USER_IGNORE_PATH_BYTES,
      { message: `each path is at most ${MAX_AGENT_MIGRATION_USER_IGNORE_PATH_BYTES} bytes (UTF-8)` },
    ),
  ).max(MAX_AGENT_MIGRATION_USER_IGNORE_PATHS),
  addedBy: z.string(),
  addedAt: z.string(),
}));

export type AgentMigrationUserIgnoreAdditionsRead =
  | { kind: "absent" }
  | { kind: "present"; additions: AgentMigrationUserIgnoreAdditions }
  /** Present on a source lease but malformed: the migration fails (the user expects the write). */
  | { kind: "invalid" };

/**
 * Reads `userIgnoreAdditions` off a lease. The field is untrusted wire data
 * whatever its declared type. A target lease never carries it, so there it is
 * ignored rather than judged.
 */
export function readAgentMigrationUserIgnoreAdditions(lease: {
  role: "source" | "target";
  userIgnoreAdditions?: unknown;
}): AgentMigrationUserIgnoreAdditionsRead {
  if (lease.role !== "source" || lease.userIgnoreAdditions === undefined) return { kind: "absent" };
  const parsed = agentMigrationUserIgnoreAdditionsSchema.safeParse(lease.userIgnoreAdditions);
  return parsed.success ? { kind: "present", additions: parsed.data } : { kind: "invalid" };
}

/** The source could not write the user's ignore additions; the migration fails with this code. */
export const MIGRATION_USER_IGNORE_WRITE_FAILED = "MIGRATION_USER_IGNORE_WRITE_FAILED" as const;

export const AGENT_MIGRATION_USER_IGNORE_WRITE_FAILURE_REASONS = [
  /** `.raftbackupignore.user` is a symlink; it is never followed. */
  "symlink",
  /** Something other than a regular file (a directory, a socket) is at that path. */
  "not_regular_file",
  /** Reading the file or writing it back failed. */
  "write_failed",
  /** Every path was rejected: nothing was or already is in the file. */
  "all_rejected",
  /** The lease's `userIgnoreAdditions` is malformed. */
  "invalid",
] as const;
export type AgentMigrationUserIgnoreWriteFailureReason =
  (typeof AGENT_MIGRATION_USER_IGNORE_WRITE_FAILURE_REASONS)[number];
export const isAgentMigrationUserIgnoreWriteFailureReason = makeIsMember(AGENT_MIGRATION_USER_IGNORE_WRITE_FAILURE_REASONS);

export const AGENT_MIGRATION_USER_IGNORE_REJECT_REASONS = [
  /** Not a line `.raftbackupignore.user` would apply: unsafe, absolute, a pattern other than `**\/<name>`, a comment, several lines. */
  "invalid_line",
  /** A path that always moves (MEMORY.md, the ignore files, `.raft/activity` and its parents). */
  "forced_keep",
] as const;
export type AgentMigrationUserIgnoreRejectReason = (typeof AGENT_MIGRATION_USER_IGNORE_REJECT_REASONS)[number];

/** What the source did with the lease's `userIgnoreAdditions`. */
export type AgentMigrationUserIgnoreAdditionsReceipt = {
  /** Lines appended to `.raftbackupignore.user`. */
  written: number;
  /** Lines the file already had (a re-sent lease, a retried migration). */
  alreadyPresent: number;
  /** At most MAX_AGENT_MIGRATION_USER_IGNORE_RECEIPT_REJECTED; paths cut to MAX_AGENT_MIGRATION_USER_IGNORE_PATH_BYTES characters. */
  rejected: Array<{ path: string; reason: AgentMigrationUserIgnoreRejectReason }>;
};

const receiptCountSchema = lazySchema("agentMigrationUserIgnoreReceiptCountSchema", () => z.number().int().nonnegative().max(MAX_AGENT_MIGRATION_USER_IGNORE_PATHS));

export const agentMigrationUserIgnoreAdditionsReceiptSchema = lazySchema("agentMigrationUserIgnoreAdditionsReceiptSchema", () => z.object({
  written: receiptCountSchema,
  alreadyPresent: receiptCountSchema,
  rejected: z.array(z.object({
    path: z.string().max(MAX_AGENT_MIGRATION_USER_IGNORE_PATH_BYTES),
    reason: z.enum(AGENT_MIGRATION_USER_IGNORE_REJECT_REASONS),
  }).strict()).max(MAX_AGENT_MIGRATION_USER_IGNORE_RECEIPT_REJECTED),
}).strict());
