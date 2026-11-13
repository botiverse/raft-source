import { z } from "zod";
import { lazySchema } from "./lazySchema";

export const RAFTBENCH_PATTERN_KINDS = ["repeated_clarification", "repeated_attempt", "unsupported_completion", "successful_practice"] as const;
export type RaftbenchPatternKind = typeof RAFTBENCH_PATTERN_KINDS[number];
export type RaftbenchFindingFilter = { kind?: RaftbenchPatternKind; channelId?: string; period?: "recent" | "history" };
export function emptyRaftbenchKindCounts(): Record<RaftbenchPatternKind, number> {
  return { repeated_clarification: 0, repeated_attempt: 0, unsupported_completion: 0, successful_practice: 0 };
}

export const raftbenchEvidenceSchema = lazySchema("raftbenchEvidenceSchema", () => z.object({
  target: z.string().regex(/^#[^\s:#]+(?::[0-9a-f]{8})?$/, "Copy the target exactly from the material you were given."),
  messageId: z.string().regex(/^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, "Copy the 8-character or full msg ID exactly from the material you were given."),
}).strict());
const raftbenchReportBaseSchema = lazySchema("raftbenchReportBaseSchema", () => z.object({
  runId: z.string().uuid(),
  revision: z.number().int().positive(),
  status: z.enum(["complete", "incomplete"]),
  reason: z.string().trim().max(1000).optional(),
  patterns: z.array(z.object({
    kind: z.enum(RAFTBENCH_PATTERN_KINDS),
    explanation: z.string().trim().min(1).max(1000),
    evidence: z.array(raftbenchEvidenceSchema).min(1).max(12),
    counterevidence: z.array(raftbenchEvidenceSchema).max(12),
    // Tool/state evidence is not in the initial source reader. Do not invent it.
    evidenceLevel: z.enum(["conversation_only", "insufficient"]),
    intent: z.enum(["active", "deliberately_paused", "unknown"]),
    suggestion: z.string().trim().max(1000),
  }).strict()).max(20),
  gaps: z.array(z.enum(["budget", "history_limit", "missing_tool_outcomes", "inaccessible_source", "partial_scan"])).max(5),
}).strict());
/** The model-facing result schema deliberately has no execution-failure field. */
export const raftbenchModelReportSchema = lazySchema("raftbenchModelReportSchema", () => raftbenchReportBaseSchema.refine(value => value.status !== "incomplete" || !!value.reason, {
  path: ["reason"], message: "Explain why this run is incomplete.",
}));
/** The credential API additionally accepts a typed harness execution failure. */
export const raftbenchReportSchema = lazySchema("raftbenchReportSchema", () => raftbenchReportBaseSchema.extend({ failure: z.literal(true).optional() }).superRefine((value, ctx) => {
  if (value.failure && (value.status !== "incomplete" || value.patterns.length !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "Execution failure requires incomplete, a reason and no findings." });
  }
  if (value.status === "incomplete" && !value.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Explain why this run is incomplete; nothing will be saved without a reason." });
  }
}));
export type RaftbenchReport = z.infer<typeof raftbenchReportSchema>;

export const raftbenchContextQuerySchema = lazySchema("raftbenchContextQuerySchema", () => z.object({
  runId: z.string().uuid().optional(),
  cursor: z.string().max(512).optional(),
}).strict());
// Responses are parsed permissively: unknown fields are ignored and lengths are
// not capped, so a Server that adds a field or a note does not break clients
// already running (Tenny). Requests and the model's result stay strict.
export const raftbenchCoverageSchema = lazySchema("raftbenchCoverageSchema", () => z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  fetchedMessages: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  skippedChunks: z.number().int().nonnegative().optional(),
  stopReason: z.enum(["more_pages", "message_limit", "char_limit", "window_end"]),
  notRead: z.array(z.string()),
}));
export const raftbenchContextResponseSchema = lazySchema("raftbenchContextResponseSchema", () => z.object({
  runId: z.string().uuid(),
  revision: z.number().int().positive(),
  sourceText: z.string(),
  sources: z.array(z.object({ target: z.string(), messageId: z.string() })),
  coverage: raftbenchCoverageSchema,
  nextCursor: z.string().nullable(),
}));
export const raftbenchSubmitResponseSchema = lazySchema("raftbenchSubmitResponseSchema", () => z.object({
  runId: z.string().uuid(),
  revision: z.number().int().positive(),
  status: z.enum(["complete", "incomplete"]),
  receiptId: z.string().uuid(),
  coverage: raftbenchCoverageSchema,
}));
export type RaftbenchContextQuery = z.infer<typeof raftbenchContextQuerySchema>;
export type RaftbenchContextResponse = z.infer<typeof raftbenchContextResponseSchema>;
export type RaftbenchSubmitResponse = z.infer<typeof raftbenchSubmitResponseSchema>;

/** Delivered to the hosted plugin, never offered as a model-facing operation. */
export const raftbenchRunAssignedSchema = lazySchema("raftbenchRunAssignedSchema", () => z.object({
  kind: z.literal("raftbench_run_assigned"),
  runId: z.string().uuid(),
  revision: z.number().int().positive(),
  text: z.literal("This run is handled automatically by the system. You do not need to take any action or reply."),
}).strict());
export type RaftbenchRunAssigned = z.infer<typeof raftbenchRunAssignedSchema>;

/** Interactive readers use their own credentials and explicit server-admin grants. */
export const raftbenchFindingsQuerySchema = lazySchema("raftbenchFindingsQuerySchema", () => z.object({
  kind: z.enum(RAFTBENCH_PATTERN_KINDS).optional()
    .describe("Only this kind: repeated_clarification (the same goal or constraint clarified again and again), repeated_attempt (the same attempt repeated without adjusting to feedback), unsupported_completion (claimed done or verified, but the visible messages do not support it; not proof that it failed), successful_practice (a reusable way of working that led to progress). Omit for all kinds."),
  channelId: z.string().uuid().optional()
    .describe("Optional channel UUID (not a #name or thread target): only findings citing this source channel. Omit for all findings available to you. Evidence names channels as #name, so look the UUID up with channels.info if that tool is available; otherwise omit it."),
  period: z.enum(["recent", "history"]).optional()
    .describe("By the newest cited message (evidence or counterevidence): recent = within the last 30 days, history = older. Omit for both."),
  limit: z.coerce.number().int().min(1).max(20).default(5)
    .describe("Findings per page, 1-20 (default 5)."),
  cursor: z.string().max(2000).optional()
    .describe("The previous page's nextCursor, sent with the same kind, channelId, period and limit as that page. Omit for the first page."),
}).strict());
export const raftbenchFindingsResponseSchema = lazySchema("raftbenchFindingsResponseSchema", () => z.object({
  revision: z.number().int().positive(),
  findings: z.array(z.object({
    id: z.string().uuid(),
    evidenceAt: z.string().nullable(),
    pattern: raftbenchReportBaseSchema.shape.patterns.element,
  })),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  coverage: z.object({ historyFrom: z.string().nullable(), scannedThroughAt: z.string().nullable(), note: z.string() }),
}));
export type RaftbenchFindingsQuery = z.infer<typeof raftbenchFindingsQuerySchema>;
export type RaftbenchFindingsResponse = z.infer<typeof raftbenchFindingsResponseSchema>;
