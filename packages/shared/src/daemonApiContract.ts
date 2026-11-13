import { z } from "zod";
import { lazySchema } from "./lazySchema";

import { AGENT_INBOX_FLAGS, type AgentInboxFlag } from "./agentInbox";
import { ATTENTION_HINT_SCHEMA } from "./attentionDependencyOracle";
import {
  EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES,
  RAFT_AGENT_STATUS_DETAIL_LIMIT,
  RAFT_AGENT_STATUS_VALUES,
} from "./agentStatusStandard";

export const DAEMON_API_BASE_PATH = "/internal/agent-api";

export const daemonApiMethods = ["GET", "POST"] as const;
export type DaemonApiMethod = (typeof daemonApiMethods)[number];

const optionalStringSchema = lazySchema("optionalStringSchema", () => z.string().trim().optional());
const optionalNonNegativeIntSchema = lazySchema("optionalNonNegativeIntSchema", () => z.number().int().nonnegative().optional());
const optionalQueryIntSchema = lazySchema("optionalQueryIntSchema", () => z.union([z.number().int().nonnegative(), z.string().trim().min(1)]).optional());
const nullableNumberSchema = lazySchema("nullableNumberSchema", () => z.number().finite().nullable());
const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

// Derived, never restated: a second hand-written copy of this list is what caused the
// 2026-09-06 inbox-check outage.
export const daemonApiKnownInboxFlagSchema = lazySchema("daemonApiKnownInboxFlagSchema", () => z.enum(AGENT_INBOX_FLAGS));

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
const daemonApiInboxFlagSchema: z.ZodType<AgentInboxFlag | (string & {})> = lazySchema("daemonApiInboxFlagSchema", () => z.union([
  daemonApiKnownInboxFlagSchema,
  z.string(),
]));
const daemonApiAttentionHintSchema = lazySchema("daemonApiAttentionHintSchema", () => passthroughObject({
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
}));

export const daemonApiInboxTargetRowSchema = lazySchema("daemonApiInboxTargetRowSchema", () => passthroughObject({
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
}));

const daemonApiInboxPrimaryActionSchema = lazySchema("daemonApiInboxPrimaryActionSchema", () => passthroughObject({
  kind: z.enum(["open_target", "run_command", "none"]),
  target: optionalStringSchema,
  commandId: optionalStringSchema,
}));

const daemonApiInboxSourceRefSchema = lazySchema("daemonApiInboxSourceRefSchema", () => z
  .object({
    kind: z.string().trim().min(1),
    id: z.string().trim().min(1),
    revision: z.string().trim().min(1).optional(),
  })
  .strict());

const daemonApiInboxAppItemSchema = lazySchema("daemonApiInboxAppItemSchema", () => passthroughObject({
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
  seal: passthroughObject({
    owner: z.string().trim().min(1),
    until: z.string().trim().min(1),
    sealedAtMs: z.number().int().nonnegative(),
  }).optional(),
}));
const daemonApiInboxAcknowledgedAppSourceSchema = lazySchema("daemonApiInboxAcknowledgedAppSourceSchema", () => passthroughObject({
  appId: z.string().trim().min(1),
  notificationClass: z.string().trim().min(1),
  sourceRef: daemonApiInboxSourceRefSchema,
  itemId: z.string().trim().min(1),
  acknowledgedAtMs: z.number().int().nonnegative(),
  ownerAgentId: optionalStringSchema,
}));
const daemonApiInboxSourceSealSchema = lazySchema("daemonApiInboxSourceSealSchema", () => passthroughObject({
  appId: z.string().trim().min(1),
  notificationClass: z.string().trim().min(1),
  sourceRef: daemonApiInboxSourceRefSchema,
  owner: z.string().trim().min(1),
  until: z.string().trim().min(1),
  sealedAtMs: z.number().int().nonnegative(),
}));
const daemonApiInboxMessageTargetItemSchema = lazySchema("daemonApiInboxMessageTargetItemSchema", () => passthroughObject({
  source: z.literal("message_target"),
  row: daemonApiInboxTargetRowSchema,
}));

export const daemonApiInboxCheckResponseSchema = lazySchema("daemonApiInboxCheckResponseSchema", () => passthroughObject({
  rows: z.array(daemonApiInboxTargetRowSchema).optional(),
  items: z.array(z.union([daemonApiInboxMessageTargetItemSchema, daemonApiInboxAppItemSchema])).optional(),
  pending_targets: optionalNonNegativeIntSchema,
  pending_messages: optionalNonNegativeIntSchema,
  pending_app_items: optionalNonNegativeIntSchema,
  acknowledged_app_sources: z.array(daemonApiInboxAcknowledgedAppSourceSchema).optional(),
  seals: z.array(daemonApiInboxSourceSealSchema).optional(),
}));

export const daemonApiInboxAckBodySchema = lazySchema("daemonApiInboxAckBodySchema", () => z.object({
  itemId: z.string().trim().min(1),
  /**
   * The exact source, for an item the daemon does not hold (a lost store):
   * a server-authority source (a fired reminder) is then acked on the Server.
   * A daemon that does not read it answers item_not_found.
   */
  source: z.object({
    appId: z.string().trim().min(1),
    notificationClass: z.string().trim().min(1),
    sourceRef: daemonApiInboxSourceRefSchema,
  }).strict().optional(),
}).strict());

export const daemonApiInboxAckResponseSchema = lazySchema("daemonApiInboxAckResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  itemId: z.string().trim().min(1),
  remaining_app_items: z.number().int().nonnegative(),
}));

// Task #178 — application-layer ack for third-party app events served from the
// daemon Local Inbox. A `/events` request carrying `X-Raft-Events-Ack: lease`
// only leases the third-party events it returns; the CLI acks the batch here
// after it has written the bodies to stdout and flushed. Only then does the
// daemon consume them locally and report them delivered (task #175 reporter).
export const daemonApiThirdPartyEventsAckBodySchema = lazySchema("daemonApiThirdPartyEventsAckBodySchema", () => z.object({
  batchId: z.string().trim().min(1),
  eventIds: z.array(z.string().trim().min(1)).min(1).max(200),
}).strict());

export const daemonApiThirdPartyEventsAckResponseSchema = lazySchema("daemonApiThirdPartyEventsAckResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  batchId: z.string(),
  acked: z.array(z.string()),
}));

export const daemonApiInboxSealBodySchema = lazySchema("daemonApiInboxSealBodySchema", () => z.object({
  sources: z.array(passthroughObject({
    appId: z.string().trim().min(1),
    notificationClass: z.string().trim().min(1),
    sourceRef: daemonApiInboxSourceRefSchema,
  })).min(1),
  owner: z.string().trim().min(1).max(120),
  until: z.string().trim().min(1).max(500),
}).strict());

export const daemonApiInboxUnsealBodySchema = lazySchema("daemonApiInboxUnsealBodySchema", () => z.object({
  sources: z.array(passthroughObject({
    appId: z.string().trim().min(1),
    notificationClass: z.string().trim().min(1),
    sourceRef: daemonApiInboxSourceRefSchema,
  })).min(1),
}).strict());

export const daemonApiInboxSealResponseSchema = lazySchema("daemonApiInboxSealResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  affected: z.number().int().positive(),
}));

export const daemonApiRuntimeVersionResponseSchema = lazySchema("daemonApiRuntimeVersionResponseSchema", () => passthroughObject({
  daemonVersion: z.string().trim().min(1),
  computerVersion: z.string().trim().min(1).nullable(),
  observation: z.literal("live_daemon_process"),
  /** What this daemon build runs for its agents (e.g. `proc@1`); absent from older daemons. */
  capabilities: z.array(z.string()).optional(),
}));

// `raft proc` (procJobs.ts). Every response a daemon that runs jobs sends
// carries `capability: "proc@1"`; an older daemon forwards the path to the
// Server, whose answer has none, so the CLI tells the two apart.
const daemonApiProcCapabilitySchema = lazySchema("daemonApiProcCapabilitySchema", () => z.literal("proc@1"));

export const daemonApiProcJobSchema = lazySchema("daemonApiProcJobSchema", () => passthroughObject({
  name: z.string(),
  pid: z.number().int(),
  state: z.enum(["running", "exited"]),
  /** The command's basename, never its arguments. */
  command: z.string(),
  startedAt: z.string(),
  exitedAt: z.string().nullable(),
  /** Null when the exit could not be collected (an adopted job, a signal). */
  exitCode: z.number().int().nullable(),
  exitSignal: z.string().nullable(),
  logPath: z.string(),
  scope: z.enum(["none", "agent", "created"]),
  adopted: z.boolean(),
}));

export const daemonApiProcListResponseSchema = lazySchema("daemonApiProcListResponseSchema", () => passthroughObject({
  capability: daemonApiProcCapabilitySchema,
  jobs: z.array(daemonApiProcJobSchema),
  maxJobs: z.number().int().positive(),
}));

export const daemonApiProcStartBodySchema = lazySchema("daemonApiProcStartBodySchema", () => passthroughObject({
  name: z.string().optional(),
  argv: z.array(z.string()).min(1),
  /** Absolute: the CLI resolves `--cwd` against its own working directory. */
  cwd: z.string().min(1),
  /** The CLI's own environment; the daemon swaps the per-session CLI variables for the agent's stable entry. */
  env: z.record(z.string(), z.string()),
  /** The CLI's pid: on Linux, the cgroup the agent's commands run in is read from it. */
  callerPid: z.number().int().positive().optional(),
}));

export const daemonApiProcStartResponseSchema = lazySchema("daemonApiProcStartResponseSchema", () => passthroughObject({
  capability: daemonApiProcCapabilitySchema,
  job: daemonApiProcJobSchema,
  /** The name was made from the command (no `--name`). */
  autoNamed: z.boolean(),
  /**
   * The job shares the Computer service's cgroup (Linux without user
   * systemd), so a restart of the service ends it. Absent: it doesn't, or an
   * older daemon didn't say.
   */
  stopsWithService: z.boolean().optional(),
}));

export const daemonApiProcStopBodySchema = lazySchema("daemonApiProcStopBodySchema", () => passthroughObject({
  name: z.string(),
  force: z.boolean().optional(),
}));

export const daemonApiProcStopResponseSchema = lazySchema("daemonApiProcStopResponseSchema", () => passthroughObject({
  capability: daemonApiProcCapabilitySchema,
  job: daemonApiProcJobSchema,
  /** `exited` after SIGTERM, `killed` by the SIGKILL that ends the grace (or at once with --force), `already_exited`. */
  outcome: z.enum(["exited", "killed", "already_exited"]),
  graceMs: z.number().int().nonnegative(),
}));

export const daemonApiProcLogsQuerySchema = lazySchema("daemonApiProcLogsQuerySchema", () => passthroughObject({
  name: z.string(),
  tail: optionalQueryIntSchema,
  /** Read from this byte offset on (`--follow`); the answer's `offset` is the next one. */
  offset: optionalQueryIntSchema,
}));

export const daemonApiProcLogsResponseSchema = lazySchema("daemonApiProcLogsResponseSchema", () => passthroughObject({
  capability: daemonApiProcCapabilitySchema,
  job: daemonApiProcJobSchema,
  text: z.string(),
  offset: z.number().int().nonnegative(),
  /** The log was rotated since the given offset; `text` starts at the new file's beginning. */
  rotated: z.boolean(),
}));

export const daemonApiWakeHintsQuerySchema = lazySchema("daemonApiWakeHintsQuerySchema", () => passthroughObject({
  since: z.union([z.literal("latest"), z.number().int().nonnegative(), z.string().trim().min(1)]).optional(),
  limit: optionalQueryIntSchema,
}));

export const daemonApiWakeHintSchema = lazySchema("daemonApiWakeHintSchema", () => passthroughObject({
  hintId: optionalStringSchema,
  hint_id: optionalStringSchema,
  eventId: optionalStringSchema,
  event_id: optionalStringSchema,
  messageId: z.string().nullable().optional(),
  message_id: z.string().nullable().optional(),
  seq: optionalNonNegativeIntSchema,
  id: optionalStringSchema,
  target: z.string().trim().nullable().optional(),
  targetType: optionalStringSchema,
  target_type: optionalStringSchema,
  reason: optionalStringSchema,
  wake_reason: optionalStringSchema,
  attention_hint: daemonApiAttentionHintSchema.optional(),
  createdAt: optionalStringSchema,
  created_at: optionalStringSchema,
}));

export const daemonApiWakeHintsFetchResponseSchema = lazySchema("daemonApiWakeHintsFetchResponseSchema", () => passthroughObject({
  hints: z.array(daemonApiWakeHintSchema).optional(),
  wake_hints: z.array(daemonApiWakeHintSchema).optional(),
  last_seen_hint_seq: nullableNumberSchema.optional(),
  last_hint_seq: nullableNumberSchema.optional(),
  has_more: z.boolean().optional(),
}));

const daemonApiActivityEventSchema = lazySchema("daemonApiActivityEventSchema", () => passthroughObject({
  schema: optionalStringSchema,
  // raft-agent-status.v1 status (or a legacy hook-outcome value) and its detail.
  status: z.enum([...RAFT_AGENT_STATUS_VALUES, ...EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES]).optional(),
  detail: z.string().max(RAFT_AGENT_STATUS_DETAIL_LIMIT).optional(),
}));

export const daemonApiActivityForwardBodySchema = lazySchema("daemonApiActivityForwardBodySchema", () => passthroughObject({
  schema: z.literal("raft-agent-activity-ingest.v1"),
  coreSessionId: optionalStringSchema,
  adapterInstance: optionalStringSchema,
  events: z.array(daemonApiActivityEventSchema),
  dropped: optionalNonNegativeIntSchema,
}));

export const daemonApiActivityForwardResponseSchema = lazySchema("daemonApiActivityForwardResponseSchema", () => passthroughObject({
  ok: z.literal(true).optional(),
  acceptedCount: z.number().int().nonnegative().optional(),
  rejectedCount: z.number().int().nonnegative().optional(),
  droppedCount: z.number().int().nonnegative().optional(),
}));

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
  thirdPartyEventsAck: route({
    key: "thirdPartyEventsAck",
    method: "POST",
    path: "/third-party-events/ack",
    client: { resource: "thirdPartyEvents", method: "ack" },
    description: "Acknowledge a leased batch of third-party app events after the CLI has written them out; intercepted locally by the daemon proxy.",
    request: { body: daemonApiThirdPartyEventsAckBodySchema },
    response: { body: daemonApiThirdPartyEventsAckResponseSchema },
  }),
  inboxSeal: route({
    key: "inboxSeal",
    method: "POST",
    path: "/inbox/seal",
    client: { resource: "inbox", method: "seal" },
    description: "Register one or more local app source seals against destructive actions.",
    request: { body: daemonApiInboxSealBodySchema },
    response: { body: daemonApiInboxSealResponseSchema },
  }),
  inboxUnseal: route({
    key: "inboxUnseal",
    method: "POST",
    path: "/inbox/unseal",
    client: { resource: "inbox", method: "unseal" },
    description: "Remove local seals from one or more app source identities.",
    request: { body: daemonApiInboxUnsealBodySchema },
    response: { body: daemonApiInboxSealResponseSchema },
  }),
  procList: route({
    key: "procList",
    method: "GET",
    path: "/proc",
    client: { resource: "proc", method: "list" },
    description: "List the calling agent's background jobs; answered by the daemon itself (proc@1).",
    request: {},
    response: { body: daemonApiProcListResponseSchema },
  }),
  procStart: route({
    key: "procStart",
    method: "POST",
    path: "/proc/start",
    client: { resource: "proc", method: "start" },
    description: "Start a background job the daemon owns for the calling agent (proc@1).",
    request: { body: daemonApiProcStartBodySchema },
    response: { body: daemonApiProcStartResponseSchema },
  }),
  procStop: route({
    key: "procStop",
    method: "POST",
    path: "/proc/stop",
    client: { resource: "proc", method: "stop" },
    description: "Stop one of the calling agent's background jobs: group SIGTERM, the stop grace, then SIGKILL (proc@1).",
    request: { body: daemonApiProcStopBodySchema },
    response: { body: daemonApiProcStopResponseSchema },
  }),
  procLogs: route({
    key: "procLogs",
    method: "GET",
    path: "/proc/logs",
    client: { resource: "proc", method: "logs" },
    description: "Read the tail of, or what follows an offset in, one of the calling agent's job logs (proc@1).",
    request: { query: daemonApiProcLogsQuerySchema },
    response: { body: daemonApiProcLogsResponseSchema },
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
