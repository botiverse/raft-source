import { z } from "zod";

import { AGENT_INBOX_FLAGS, type AgentInboxFlag } from "./agentInbox.js";
import { ATTENTION_HINT_SCHEMA } from "./attentionDependencyOracle.js";

export const DAEMON_API_BASE_PATH = "/internal/agent-api";

export const daemonApiMethods = ["GET", "POST"] as const;
export type DaemonApiMethod = (typeof daemonApiMethods)[number];

const optionalStringSchema = z.string().trim().optional();
const optionalNonNegativeIntSchema = z.number().int().nonnegative().optional();
const optionalQueryIntSchema = z.union([z.number().int().nonnegative(), z.string().trim().min(1)]).optional();
const nullableNumberSchema = z.number().finite().nullable();
const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

// Derived, never restated: a second hand-written copy of this list is what caused the
// 2026-09-06 inbox-check outage.
export const daemonApiKnownInboxFlagSchema = z.enum(AGENT_INBOX_FLAGS);

/**
 * Daemon and CLI are deployed independently -- the outage ran CLI 0.0.22 against daemon
 * 1.0.23 -- so a newer daemon WILL eventually emit a flag this build has never seen.
 * An exhaustive enum on that boundary is a future outage no matter how carefully the two
 * lists are kept in sync, so an unrecognised value must not reject the response: the row
 * schema is already `passthrough` for unknown KEYS, and this makes it consistent for
 * unknown VALUES. The cost is bounded (one row shows one badge it cannot name, and
 * formatAgentInboxFlag renders it as a bounded, JSON-quoted `unknown inbox flag: "..."`);
 * the alternative is the entire inbox becoming unreadable.
 *
 * The declared output type keeps the known literals for editor completion while still
 * admitting a future string -- `string` alone would silently drop every call site's
 * knowledge of what the real flags are.
 */
const daemonApiInboxFlagSchema: z.ZodType<AgentInboxFlag | (string & {})> = z.union([
  daemonApiKnownInboxFlagSchema,
  z.string(),
]);
const daemonApiAttentionHintSchema = passthroughObject({
  schema: z.literal(ATTENTION_HINT_SCHEMA),
  trigger: z.enum(["M2", "M3"]),
  scope: z.string().trim().min(1),
  suggested_command: z.string().trim().min(1),
  copy: z.string().trim().min(1),
  copy_version: z.literal("attention-hint-copy-v1"),
  epoch_ms: z.number().int().nonnegative(),
  thresholds: passthroughObject({
    K: optionalNonNegativeIntSchema,
    k: optionalNonNegativeIntSchema,
    window_ms: z.number().int().positive(),
  }),
});

export const daemonApiInboxTargetRowSchema = passthroughObject({
  target: z.string().trim().min(1),
  channelId: optionalStringSchema,
  channelType: optionalStringSchema,
  pendingCount: z.number().int().nonnegative(),
  firstPendingMsgId: optionalStringSchema,
  firstPendingSeq: optionalNonNegativeIntSchema,
  latestMsgId: optionalStringSchema,
  latestSeq: optionalNonNegativeIntSchema,
  latestSenderName: optionalStringSchema,
  latestSenderType: z.enum(["human", "agent", "system", "third_party_app"]).optional(),
  flags: z.array(daemonApiInboxFlagSchema),
  attentionHint: daemonApiAttentionHintSchema.optional(),
});

const daemonApiInboxPrimaryActionSchema = passthroughObject({
  kind: z.enum(["open_target", "run_command", "none"]),
  target: optionalStringSchema,
  commandId: optionalStringSchema,
});

const daemonApiInboxSourceRefSchema = z
  .object({
    kind: z.string().trim().min(1),
    id: z.string().trim().min(1),
    revision: z.string().trim().min(1).optional(),
  })
  .strict();

const daemonApiInboxAppItemSchema = passthroughObject({
  source: z.literal("app"),
  itemId: z.string().trim().min(1),
  appId: z.string().trim().min(1),
  notificationClass: z.string().trim().min(1),
  /** Structured typed source identity/revision — not an opaque freeform string. */
  sourceRef: daemonApiInboxSourceRefSchema,
  primaryAction: daemonApiInboxPrimaryActionSchema,
  /** Exact closed CLI from registry action-builder at mint (never freeform shell). */
  actionCli: z.string().trim().min(1),
  retention: z.enum(["until_source_read", "until_explicit_ack", "transient"]),
  title: optionalStringSchema,
  summary: optionalStringSchema,
  createdAtMs: optionalNonNegativeIntSchema,
});
const daemonApiInboxAcknowledgedAppSourceSchema = passthroughObject({
  appId: z.string().trim().min(1),
  notificationClass: z.string().trim().min(1),
  sourceRef: daemonApiInboxSourceRefSchema,
  itemId: z.string().trim().min(1),
  acknowledgedAtMs: z.number().int().nonnegative(),
  ownerAgentId: optionalStringSchema,
});
const daemonApiInboxMessageTargetItemSchema = passthroughObject({
  source: z.literal("message_target"),
  row: daemonApiInboxTargetRowSchema,
});

export const daemonApiInboxCheckResponseSchema = passthroughObject({
  rows: z.array(daemonApiInboxTargetRowSchema).optional(),
  items: z.array(z.union([daemonApiInboxMessageTargetItemSchema, daemonApiInboxAppItemSchema])).optional(),
  pending_targets: optionalNonNegativeIntSchema,
  pending_messages: optionalNonNegativeIntSchema,
  pending_app_items: optionalNonNegativeIntSchema,
  acknowledged_app_sources: z.array(daemonApiInboxAcknowledgedAppSourceSchema).optional(),
});

export const daemonApiInboxAckBodySchema = z.object({
  itemId: z.string().trim().min(1),
}).strict();

export const daemonApiInboxAckResponseSchema = passthroughObject({
  ok: z.literal(true),
  itemId: z.string().trim().min(1),
  remaining_app_items: z.number().int().nonnegative(),
});

export const daemonApiRuntimeVersionResponseSchema = passthroughObject({
  daemonVersion: z.string().trim().min(1),
  computerVersion: z.string().trim().min(1).nullable(),
  observation: z.literal("live_daemon_process"),
});

export const daemonApiWakeHintsQuerySchema = passthroughObject({
  since: z.union([z.literal("latest"), z.number().int().nonnegative(), z.string().trim().min(1)]).optional(),
  limit: optionalQueryIntSchema,
});

export const daemonApiWakeHintSchema = passthroughObject({
  hintId: optionalStringSchema,
  hint_id: optionalStringSchema,
  eventId: optionalStringSchema,
  event_id: optionalStringSchema,
  messageId: z.string().nullable().optional(),
  message_id: z.string().nullable().optional(),
  seq: optionalNonNegativeIntSchema,
  id: optionalStringSchema,
  target: optionalStringSchema,
  targetType: optionalStringSchema,
  target_type: optionalStringSchema,
  reason: optionalStringSchema,
  wake_reason: optionalStringSchema,
  attention_hint: daemonApiAttentionHintSchema.optional(),
  createdAt: optionalStringSchema,
  created_at: optionalStringSchema,
});

export const daemonApiWakeHintsFetchResponseSchema = passthroughObject({
  hints: z.array(daemonApiWakeHintSchema).optional(),
  wake_hints: z.array(daemonApiWakeHintSchema).optional(),
  last_seen_hint_seq: nullableNumberSchema.optional(),
  last_hint_seq: nullableNumberSchema.optional(),
  has_more: z.boolean().optional(),
});

const daemonApiActivityEventSchema = passthroughObject({
  schema: optionalStringSchema,
});

export const daemonApiActivityForwardBodySchema = passthroughObject({
  schema: z.literal("raft-agent-activity-ingest.v1"),
  coreSessionId: optionalStringSchema,
  adapterInstance: optionalStringSchema,
  events: z.array(daemonApiActivityEventSchema),
  dropped: optionalNonNegativeIntSchema,
});

export const daemonApiActivityForwardResponseSchema = passthroughObject({
  ok: z.literal(true).optional(),
  acceptedCount: z.number().int().nonnegative().optional(),
  rejectedCount: z.number().int().nonnegative().optional(),
  droppedCount: z.number().int().nonnegative().optional(),
});

type DaemonApiContractResponse = {
  body: z.ZodType;
};

type DaemonApiContractRoute = {
  key: string;
  method: DaemonApiMethod;
  path: string;
  fullPath: string;
  client: {
    resource: string;
    method: string;
  };
  description: string;
  request: {
    query?: z.ZodType;
    body?: z.ZodType;
  };
  response: DaemonApiContractResponse;
};

function route<const T extends Omit<DaemonApiContractRoute, "fullPath">>(input: T): T & { fullPath: string } {
  return {
    ...input,
    fullPath: `${DAEMON_API_BASE_PATH}${input.path}`,
  };
}

/**
 * CLI routes owned by the local daemon/proxy runtime surface.
 *
 * These routes deliberately reuse the id-less `/internal/agent-api/*` shape so
 * command code can keep one credential/proxy entry point. They are still not
 * part of `agentApiContract`: that contract is the server-router manifest and
 * is checked against `internalAgentApiRouter` registration.
 *
 * Route ownership here is mixed by design: `inbox` is intercepted locally by
 * the daemon proxy, while `wake-hints` and `activity` are existing bridge paths
 * reached through that proxy. The shared contract only types the CLI-facing
 * daemon/proxy surface; it must not imply new server route registration.
 */
export const daemonApiContract = {
  runtimeVersion: route({
    key: "runtimeVersion",
    method: "GET",
    path: "/runtime-version",
    client: { resource: "runtime", method: "version" },
    description: "Read versions from the daemon process currently serving this managed runner.",
    request: {},
    response: { body: daemonApiRuntimeVersionResponseSchema },
  }),
  inboxCheck: route({
    key: "inboxCheck",
    method: "GET",
    path: "/inbox",
    client: { resource: "inbox", method: "check" },
    description: "Read the managed-runner daemon inbox snapshot without draining message content.",
    request: {},
    response: { body: daemonApiInboxCheckResponseSchema },
  }),
  inboxAck: route({
    key: "inboxAck",
    method: "POST",
    path: "/inbox/ack",
    client: { resource: "inbox", method: "ack" },
    description: "Acknowledge one managed-runner app Inbox item after its source read succeeds.",
    request: { body: daemonApiInboxAckBodySchema },
    response: { body: daemonApiInboxAckResponseSchema },
  }),
  wakeHintsFetch: route({
    key: "wakeHintsFetch",
    method: "GET",
    path: "/wake-hints",
    client: { resource: "wakeHints", method: "fetch" },
    description: "Peek content-free wake hints without advancing delivery cursors.",
    request: { query: daemonApiWakeHintsQuerySchema },
    response: { body: daemonApiWakeHintsFetchResponseSchema },
  }),
  activityForward: route({
    key: "activityForward",
    method: "POST",
    path: "/activity",
    client: { resource: "activity", method: "forward" },
    description: "Forward plugin-observed activity from a local bridge to the daemon/server activity ingest path.",
    request: { body: daemonApiActivityForwardBodySchema },
    response: { body: daemonApiActivityForwardResponseSchema },
  }),
} as const;

export type DaemonApiContract = typeof daemonApiContract;
export type DaemonApiRouteKey = keyof DaemonApiContract;

export type DaemonApiRequestQueryByRoute = {
  [K in DaemonApiRouteKey]: DaemonApiContract[K]["request"] extends { query: infer S extends z.ZodType }
    ? z.infer<S>
    : never;
};

export type DaemonApiRequestBodyByRoute = {
  [K in DaemonApiRouteKey]: DaemonApiContract[K]["request"] extends { body: infer S extends z.ZodType }
    ? z.infer<S>
    : never;
};

export type DaemonApiResponseByRoute = {
  [K in DaemonApiRouteKey]: z.infer<DaemonApiContract[K]["response"]["body"]>;
};

export function parseDaemonApiResponse<K extends DaemonApiRouteKey>(
  routeKey: K,
  data: unknown,
): DaemonApiResponseByRoute[K] {
  return daemonApiContract[routeKey].response.body.parse(data) as DaemonApiResponseByRoute[K];
}
