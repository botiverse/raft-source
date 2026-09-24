import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database, type DatabaseExecutor } from "../db/index.js";
import { channels, productFeedbackLocators } from "../db/schema.js";

export const FEEDBACK_LOCATOR_ARTIFACT_KIND = "raft-feedback-locator-v0" as const;
export const FEEDBACK_LOCATOR_EVENT_KIND = "feedback-locator:created" as const;
export const FEEDBACK_LOCATOR_SCHEMA_VERSION = "raft.feedback.locator.v0" as const;
export const FEEDBACK_LOCATOR_CONFIGURED_CHANNEL = "#proj-feedback" as const;

export type FeedbackLocatorRejectionReason =
  | "unknown_artifact_kind"
  | "unknown_event_kind"
  | "unknown_schema_version"
  | "invalid_payload"
  | "forbidden_field"
  | "invalid_route_ref"
  | "report_identity_conflict"
  | "storage_failed";

export class FeedbackLocatorIngestError extends Error {
  constructor(public readonly reasonCode: FeedbackLocatorRejectionReason) {
    super(reasonCode);
    this.name = "FeedbackLocatorIngestError";
  }
}

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const idSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonEmptySchema = z.string().trim().min(1).max(512);
const commandFamilySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const argumentSchema = strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  type: z.enum(["boolean", "string", "number", "json", "unknown"]),
  shape: z.enum(["flag", "scalar", "repeated", "positional", "stdin"]),
});

const lookupFailureReasonSchema = z.enum([
  "permission_denied",
  "io_error",
  "invalid_locator",
  "limit_exceeded",
]);
const nativeLookupMethodSchema = z.enum([
  "claude_jsonl",
  "codex_jsonl",
  "grok_session_jsonl",
  "kimi_sdk_index",
  "pi_jsonl",
  "builtin_jsonl",
]);
const nativeLocatorKindSchema = z.enum(["file", "directory"]);

const nativeProbeSchema = z.discriminatedUnion("status", [
  strictObject({
    status: z.literal("reachable"),
    lookup_method: nativeLookupMethodSchema,
    locator_kind: nativeLocatorKindSchema,
  }),
  strictObject({
    status: z.literal("unreachable"),
    lookup_method: nativeLookupMethodSchema,
    locator_kind: nativeLocatorKindSchema,
    reason_code: z.literal("not_found"),
  }),
  strictObject({
    status: z.literal("lookup_failed"),
    lookup_method: nativeLookupMethodSchema,
    locator_kind: nativeLocatorKindSchema,
    reason_code: lookupFailureReasonSchema,
  }),
  strictObject({
    status: z.literal("unsupported"),
    lookup_method: z.literal("none"),
    locator_kind: z.literal("none"),
    reason_code: z.literal("runtime_resolver_unsupported"),
  }),
]);

const handoffProbeSchema = z.discriminatedUnion("status", [
  strictObject({ status: z.literal("present") }),
  strictObject({ status: z.literal("absent") }),
  strictObject({ status: z.literal("lookup_failed"), reason_code: lookupFailureReasonSchema }),
]);

const runtimeSchema = z.enum(["claude", "codex", "grok", "kimi", "kimi-sdk", "pi", "builtin", "other"]);
const l0UnavailableSchema = strictObject({
  runtime: runtimeSchema,
  identity: strictObject({
    status: z.literal("unavailable"),
    reason_code: z.literal("session_identity_unavailable"),
  }),
  native: strictObject({
    status: z.literal("not_attempted"),
    reason_code: z.literal("session_identity_unavailable"),
  }),
  handoff: strictObject({
    status: z.literal("not_attempted"),
    reason_code: z.literal("session_identity_unavailable"),
  }),
});

const runtimeProbeShape: Record<Exclude<z.infer<typeof runtimeSchema>, "other">, {
  method: z.infer<typeof nativeLookupMethodSchema>;
  kind: z.infer<typeof nativeLocatorKindSchema>;
}> = {
  claude: { method: "claude_jsonl", kind: "file" },
  codex: { method: "codex_jsonl", kind: "file" },
  grok: { method: "grok_session_jsonl", kind: "file" },
  kimi: { method: "kimi_sdk_index", kind: "directory" },
  "kimi-sdk": { method: "kimi_sdk_index", kind: "directory" },
  pi: { method: "pi_jsonl", kind: "file" },
  builtin: { method: "builtin_jsonl", kind: "file" },
};

const l0PresentSchema = strictObject({
  runtime: runtimeSchema,
  identity: strictObject({ status: z.literal("present"), session_id: nonEmptySchema }),
  native: nativeProbeSchema,
  handoff: handoffProbeSchema,
}).superRefine((value, context) => {
  if (value.runtime === "other") {
    if (value.native.status !== "unsupported") {
      context.addIssue({ code: "custom", path: ["native"], message: "other runtime must be unsupported" });
    }
    return;
  }
  if (value.native.status === "unsupported") {
    context.addIssue({ code: "custom", path: ["native"], message: "known runtime cannot be unsupported" });
    return;
  }
  const expected = runtimeProbeShape[value.runtime];
  if (value.native.lookup_method !== expected.method || value.native.locator_kind !== expected.kind) {
    context.addIssue({ code: "custom", path: ["native"], message: "runtime probe shape mismatch" });
  }
});

const l0FinalSchema = z.union([l0UnavailableSchema, l0PresentSchema]);
const l1Schema = strictObject({
  turn: strictObject({
    status: z.literal("unsupported"),
    reason_code: z.literal("runtime_turn_contract_unavailable"),
  }),
  trace: strictObject({
    status: z.literal("unsupported"),
    reason_code: z.literal("runtime_trace_contract_unavailable"),
  }),
});
const subjectCallSchema = z.discriminatedUnion("status", [
  strictObject({
    status: z.literal("available"),
    provenance: z.literal("reporter_declared"),
    command_family: commandFamilySchema,
    arguments: z.array(argumentSchema).max(64),
    canonical_shape_sha256: sha256Schema,
  }),
  strictObject({ status: z.literal("unavailable"), reason_code: z.literal("subject_call_anchor_missing") }),
  strictObject({ status: z.literal("unsupported"), reason_code: z.literal("subject_call_schema_unknown") }),
]);

const exactSchema = z.discriminatedUnion("status", [
  strictObject({
    surface: z.enum(["manual", "instruction"]),
    status: z.literal("retained"),
    provenance: z.literal("served"),
    sha256: sha256Schema,
    as_of: z.string().datetime({ offset: true }),
    retest_trigger: z.enum(["served_bytes_changed", "command_help_surface_changed"]),
  }),
  strictObject({
    surface: z.enum(["manual", "instruction"]),
    status: z.literal("not_retained"),
    provenance: z.literal("served"),
    reason_code: z.enum(["served_bytes_not_retained", "served_bytes_unavailable", "transform_failed"]),
  }),
  strictObject({
    surface: z.enum(["manual", "instruction"]),
    status: z.literal("not_applicable"),
  }),
]);

const unresolvedDeliverySchema = strictObject({
  status: z.literal("not_attempted"),
  reason_code: z.literal("route_unresolved"),
});
const resolvedDeliverySchema = z.discriminatedUnion("status", [
  strictObject({ status: z.literal("not_attempted"), reason_code: z.literal("consumer_not_configured") }),
  strictObject({ status: z.literal("dispatched_unconfirmed"), reason_code: z.literal("fire_and_forget_no_receipt") }),
  strictObject({ status: z.literal("accepted"), receipt_id: idSchema }),
  strictObject({
    status: z.literal("failed"),
    reason_code: z.enum(["queue_rejected", "api_rejected", "transport_error"]),
  }),
]);
const routeSchema = z.union([
  strictObject({
    resolution: strictObject({
      status: z.literal("unrouted"),
      reason_code: z.enum(["no_registry_match", "target_not_public", "target_not_visible"]),
    }),
    delivery: unresolvedDeliverySchema,
  }),
  strictObject({
    resolution: strictObject({
      status: z.literal("lookup_failed"),
      reason_code: z.enum(["channel_visibility_lookup_failed", "route_config_read_failed"]),
    }),
    delivery: unresolvedDeliverySchema,
  }),
  strictObject({
    resolution: strictObject({
      status: z.literal("resolved"),
      target: strictObject({ kind: z.literal("public_channel"), ref: z.string().trim().min(2).max(128) }),
      basis: z.enum(["explicit_public_channel", "configured_project_channel"]),
    }),
    delivery: resolvedDeliverySchema,
  }),
]);

// This is intentionally a Server-owned consumer schema, not an import from the
// producer implementation. A producer regression therefore cannot weaken both
// ends of the acceptance seam in one edit.
export const feedbackLocatorPayloadSchema = strictObject({
  schema_version: z.literal(FEEDBACK_LOCATOR_SCHEMA_VERSION),
  report_id: idSchema,
  captured_at: z.string().datetime({ offset: true }),
  producer: strictObject({
    surface: z.literal("raft_cli"),
    server_id: nonEmptySchema,
    agent_id: nonEmptySchema,
    machine_id: nonEmptySchema.optional(),
    launch_id: nonEmptySchema.optional(),
  }),
  capture_invocation: strictObject({
    invocation_id: nonEmptySchema,
    command_family: z.literal("feedback"),
    arguments: z.array(argumentSchema).max(64),
    canonical_shape_sha256: sha256Schema,
  }),
  locators: strictObject({
    l0: l0FinalSchema,
    l1: l1Schema,
    l2: strictObject({ subject_call: subjectCallSchema }),
  }),
  exacts: z.array(exactSchema).max(16),
  route: routeSchema,
  transport: strictObject({
    artifact_kind: z.literal(FEEDBACK_LOCATOR_ARTIFACT_KIND),
    event_kind: z.literal(FEEDBACK_LOCATOR_EVENT_KIND),
  }),
});

export type FeedbackLocatorPayload = z.infer<typeof feedbackLocatorPayloadSchema>;

const FORBIDDEN_KEYS = new Set([
  "body",
  "content",
  "content_window",
  "context",
  "context_window",
  "feedback_body",
  "l3",
  "message_body",
  "path",
  "prompt",
  "raw",
  "raw_args",
  "raw_argv",
  "raw_error",
  "raw_value",
  "raw_values",
  "searched_paths",
  "searchedpaths",
  "session_content",
  "session_text",
  "stderr",
  "stdin",
  "stdout",
  "trajectory",
  "transcript",
  "value",
  "values",
  "wider_window",
  "window",
]);

function normalizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
    FORBIDDEN_KEYS.has(normalizeKey(key)) || containsForbiddenField(nested)
  ));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadDigest(payload: FeedbackLocatorPayload): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function isPublicChannelRef(ref: string): boolean {
  return /^#[a-z0-9][a-z0-9_-]{0,126}$/i.test(ref);
}

function rawRouteResolution(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const route = (payload as Record<string, unknown>).route;
  if (!route || typeof route !== "object") return null;
  const resolution = (route as Record<string, unknown>).resolution;
  return resolution && typeof resolution === "object" ? resolution as Record<string, unknown> : null;
}

function rawRouteTarget(payload: unknown): { kind?: unknown; ref?: unknown } | null {
  const resolution = rawRouteResolution(payload);
  const target = resolution?.target;
  return target && typeof target === "object" ? target as { kind?: unknown; ref?: unknown } : null;
}

export function parseFeedbackLocatorEnvelope(input: {
  artifact_kind: unknown;
  event_kind: unknown;
  payload: unknown;
}): FeedbackLocatorPayload {
  if (input.artifact_kind !== FEEDBACK_LOCATOR_ARTIFACT_KIND) {
    throw new FeedbackLocatorIngestError("unknown_artifact_kind");
  }
  if (input.event_kind !== FEEDBACK_LOCATOR_EVENT_KIND) {
    throw new FeedbackLocatorIngestError("unknown_event_kind");
  }
  if (containsForbiddenField(input.payload)) {
    throw new FeedbackLocatorIngestError("forbidden_field");
  }
  const target = rawRouteTarget(input.payload);
  const resolution = rawRouteResolution(input.payload);
  if (
    resolution
    && resolution.status !== "resolved"
    && ("target" in resolution || "ref" in resolution)
  ) {
    throw new FeedbackLocatorIngestError("invalid_route_ref");
  }
  if (
    target
    && (target.kind !== "public_channel" || typeof target.ref !== "string" || !isPublicChannelRef(target.ref))
  ) {
    throw new FeedbackLocatorIngestError("invalid_route_ref");
  }
  const rawSchemaVersion = input.payload && typeof input.payload === "object"
    ? (input.payload as Record<string, unknown>).schema_version
    : undefined;
  if (rawSchemaVersion !== FEEDBACK_LOCATOR_SCHEMA_VERSION) {
    throw new FeedbackLocatorIngestError("unknown_schema_version");
  }
  const parsed = feedbackLocatorPayloadSchema.safeParse(input.payload);
  if (!parsed.success) throw new FeedbackLocatorIngestError("invalid_payload");
  if (
    parsed.data.route.resolution.status === "resolved"
    && !isPublicChannelRef(parsed.data.route.resolution.target.ref)
  ) {
    throw new FeedbackLocatorIngestError("invalid_route_ref");
  }
  if (
    parsed.data.route.resolution.status === "resolved"
    && parsed.data.route.resolution.target.ref !== FEEDBACK_LOCATOR_CONFIGURED_CHANNEL
  ) {
    throw new FeedbackLocatorIngestError("invalid_route_ref");
  }
  return parsed.data;
}

function projection(payload: FeedbackLocatorPayload) {
  const native = payload.locators.l0.native;
  const resolution = payload.route.resolution;
  return {
    runtime: payload.locators.l0.runtime,
    nativeStatus: native.status,
    nativeLookupMethod: "lookup_method" in native ? native.lookup_method : "not_attempted",
    nativeLocatorKind: "locator_kind" in native ? native.locator_kind : "none",
    hasServedExact: payload.exacts.some((exact) => exact.status === "retained"),
    servedExactSha256: payload.exacts.flatMap((exact) => exact.status === "retained" ? [exact.sha256] : []),
    routeBasis: resolution.status === "resolved" ? resolution.basis : null,
    routeTarget: resolution.status === "resolved" ? resolution.target.ref : null,
  };
}

export type FeedbackLocatorAcceptance = {
  status: "accepted";
  receipt_id: string;
  report_id: string;
  duplicate: boolean;
};

export async function ingestFeedbackLocator(
  args: {
    serverId: string;
    agentId: string;
    artifactKind: unknown;
    eventKind: unknown;
    payload: unknown;
  },
  options: {
    db?: Database;
    beforeCommit?: () => void | Promise<void>;
  } = {},
): Promise<FeedbackLocatorAcceptance> {
  const payload = parseFeedbackLocatorEnvelope({
    artifact_kind: args.artifactKind,
    event_kind: args.eventKind,
    payload: args.payload,
  });
  if (payload.producer.server_id !== args.serverId || payload.producer.agent_id !== args.agentId) {
    throw new FeedbackLocatorIngestError("invalid_payload");
  }
  if (
    payload.route.resolution.status === "resolved"
    && (payload.route.delivery.status === "accepted" || payload.route.delivery.status === "failed")
  ) {
    throw new FeedbackLocatorIngestError("invalid_payload");
  }

  const db = options.db ?? getDb();
  const digest = payloadDigest(payload);
  const indexed = projection(payload);
  try {
    return await db.transaction(async (tx) => {
      if (payload.route.resolution.status === "resolved") {
        const [visiblePublicChannel] = await tx.select({ id: channels.id }).from(channels).where(and(
          eq(channels.serverId, args.serverId),
          eq(channels.name, payload.route.resolution.target.ref.slice(1)),
          eq(channels.type, "channel"),
          isNull(channels.deletedAt),
        )).limit(1);
        if (!visiblePublicChannel) throw new FeedbackLocatorIngestError("invalid_route_ref");
      }
      const receiptId = randomUUID();
      const [inserted] = await tx.insert(productFeedbackLocators).values({
        serverId: args.serverId,
        producerAgentId: args.agentId,
        reportId: payload.report_id,
        receiptId,
        artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
        eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
        schemaVersion: FEEDBACK_LOCATOR_SCHEMA_VERSION,
        capturedAt: new Date(payload.captured_at),
        ...indexed,
        payloadSha256: digest,
        payload,
      }).onConflictDoNothing({
        target: [productFeedbackLocators.serverId, productFeedbackLocators.reportId],
      }).returning({
        receiptId: productFeedbackLocators.receiptId,
        reportId: productFeedbackLocators.reportId,
      });

      if (inserted) {
        await options.beforeCommit?.();
        return {
          status: "accepted" as const,
          receipt_id: inserted.receiptId,
          report_id: inserted.reportId,
          duplicate: false,
        };
      }

      const [existing] = await tx.select({
        receiptId: productFeedbackLocators.receiptId,
        reportId: productFeedbackLocators.reportId,
        payloadSha256: productFeedbackLocators.payloadSha256,
      }).from(productFeedbackLocators).where(and(
        eq(productFeedbackLocators.serverId, args.serverId),
        eq(productFeedbackLocators.reportId, payload.report_id),
      )).limit(1);
      if (!existing || existing.payloadSha256 !== digest) {
        throw new FeedbackLocatorIngestError("report_identity_conflict");
      }
      await options.beforeCommit?.();
      return {
        status: "accepted" as const,
        receipt_id: existing.receiptId,
        report_id: existing.reportId,
        duplicate: true,
      };
    });
  } catch (error) {
    if (error instanceof FeedbackLocatorIngestError) throw error;
    throw new FeedbackLocatorIngestError("storage_failed");
  }
}

export type FeedbackLocatorQuery = {
  serverId: string;
  reportId?: string;
  runtime?: FeedbackLocatorPayload["locators"]["l0"]["runtime"];
  nativeStatus?: string;
  nativeLookupMethod?: string;
  hasServedExact?: boolean;
  servedExactSha256?: string;
  routeBasis?: "explicit_public_channel" | "configured_project_channel";
  limit?: number;
};

export async function queryFeedbackLocators(
  query: FeedbackLocatorQuery,
  executor: DatabaseExecutor = getDb(),
) {
  const predicates: SQL[] = [eq(productFeedbackLocators.serverId, query.serverId)];
  if (query.reportId) predicates.push(eq(productFeedbackLocators.reportId, query.reportId));
  if (query.runtime) predicates.push(eq(productFeedbackLocators.runtime, query.runtime));
  if (query.nativeStatus) predicates.push(eq(productFeedbackLocators.nativeStatus, query.nativeStatus));
  if (query.nativeLookupMethod) predicates.push(eq(productFeedbackLocators.nativeLookupMethod, query.nativeLookupMethod));
  if (query.hasServedExact !== undefined) predicates.push(eq(productFeedbackLocators.hasServedExact, query.hasServedExact));
  if (query.servedExactSha256) {
    predicates.push(sql`${query.servedExactSha256} = ANY(${productFeedbackLocators.servedExactSha256})`);
  }
  if (query.routeBasis) predicates.push(eq(productFeedbackLocators.routeBasis, query.routeBasis));
  return executor.select().from(productFeedbackLocators)
    .where(and(...predicates))
    .orderBy(desc(productFeedbackLocators.createdAt))
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 100));
}
