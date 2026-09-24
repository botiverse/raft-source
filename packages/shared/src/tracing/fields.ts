import {
  createScopedTracer,
  createSpanAttrContractTracer,
  projectTraceScopeAttrs,
  type TraceAttributes,
  type Tracer,
  type TraceScope,
  type TraceScopeTracerOptions,
} from "./index.js";

export type TraceFieldClass = "query_axis" | "family_query_axis" | "detail" | "content_safety";
export type TraceFieldPlacement = "span" | "event" | "span_or_event";
export type TraceFieldEnumBinding = "stable" | "pending_457" | "query_registry";

export interface TraceFieldDefinition {
  readonly key: string;
  readonly fieldClass: TraceFieldClass;
  readonly placement: TraceFieldPlacement;
  readonly valueKind: "closed_enum" | "identity" | "timestamp" | "numeric" | "boolean" | "route" | "detail" | "content";
  readonly scope?: `family:${string}`;
  readonly enumBinding?: TraceFieldEnumBinding;
  readonly enumValues?: readonly string[];
  readonly highCardinality?: boolean;
  readonly contentRule?: "drop" | "hash_only" | "scrub_and_short_retention";
}

export function defineTraceFields<const T extends readonly TraceFieldDefinition[]>(definitions: T): T {
  for (const definition of definitions) {
    if (definition.fieldClass === "content_safety" && !definition.contentRule) {
      throw new Error(`Trace content-safety field "${definition.key}" must define a contentRule`);
    }
    if ((definition.fieldClass === "query_axis" || definition.fieldClass === "family_query_axis") && definition.valueKind === "content") {
      throw new Error(`Trace query-axis field "${definition.key}" cannot be content`);
    }
    if (definition.fieldClass === "family_query_axis" && !definition.scope) {
      throw new Error(`Trace family query-axis field "${definition.key}" must define a family scope`);
    }
  }
  return definitions;
}

export const TRACE_LIFECYCLE_SHADOW_SIGNAL_SITE_VALUES = [
  "daemon_ingest",
  "delivery_ack",
  "hint_resolution",
  "lifecycle_plan",
  "preserve_rebroadcast",
  "ready_online",
  "runtime_error",
  "slock_action_status",
  "starting_resolve",
  "synthetic_repair",
] as const;

export const TRACE_B0_FIELD_DEFINITIONS = defineTraceFields([
  { key: "row_kind", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "stable" },
  { key: "trace_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "span_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "parent_span_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "span_name", fieldClass: "query_axis", placement: "span", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "span_surface", fieldClass: "query_axis", placement: "span", valueKind: "closed_enum", enumBinding: "stable" },
  { key: "span_kind", fieldClass: "query_axis", placement: "span", valueKind: "closed_enum", enumBinding: "stable" },
  { key: "span_status", fieldClass: "query_axis", placement: "span", valueKind: "closed_enum", enumBinding: "stable" },
  { key: "event_name", fieldClass: "query_axis", placement: "event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "event_kind", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "event_index", fieldClass: "query_axis", placement: "event", valueKind: "identity" },
  { key: "event_time", fieldClass: "query_axis", placement: "event", valueKind: "timestamp" },
  { key: "event_time_ms", fieldClass: "query_axis", placement: "event", valueKind: "numeric" },
  { key: "lifecycle_observed_at_ms", fieldClass: "query_axis", placement: "span_or_event", valueKind: "numeric" },
  { key: "activity_observed_at_ms", fieldClass: "query_axis", placement: "span_or_event", valueKind: "numeric" },
  { key: "advances_observed_clock", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "duration_ms", fieldClass: "query_axis", placement: "span_or_event", valueKind: "numeric" },
  { key: "request_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "operation_id", fieldClass: "query_axis", placement: "span_or_event", valueKind: "identity", highCardinality: true },
  { key: "route_pattern", fieldClass: "query_axis", placement: "span", valueKind: "route" },
  { key: "caller_kind", fieldClass: "query_axis", placement: "span", valueKind: "closed_enum", enumBinding: "stable" },
  { key: "server_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "channel_id", fieldClass: "query_axis", placement: "span_or_event", valueKind: "identity", highCardinality: true },
  { key: "machine_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "agent_id", fieldClass: "query_axis", placement: "span_or_event", valueKind: "identity", highCardinality: true },
  { key: "job_id", fieldClass: "query_axis", placement: "span_or_event", valueKind: "identity", highCardinality: true },
  { key: "launch_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "session_id", fieldClass: "query_axis", placement: "span", valueKind: "identity", highCardinality: true },
  { key: "outcome", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "observation_class", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "action", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "source", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "served_from", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "authority", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "decided_by", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "router_reason", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "stale_owner_cleanup_result", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "stale_owner_cleanup_reason", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "error_class", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "query_name", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "query_registry" },
  { key: "phase", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "db_system", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "stable" },
  { key: "sqlstate", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "stable" },
  // Normalized SQL shape template with literals replaced by "?" (bounded 240
  // chars), never raw SQL text or parameter values.
  { key: "query_fingerprint", fieldClass: "query_axis", placement: "span_or_event", valueKind: "identity" },
  // Measured-duration bucket of the query, not the configured timeout: every
  // timed query lands in one of these four buckets, so there is no "none"
  // value; an absent (null) field means the duration was not measured.
  { key: "timeout_bucket", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "stable", enumValues: ["<1s", "1-5s", "5-15s", ">15s"] },
  { key: "retryable", fieldClass: "query_axis", placement: "span_or_event", valueKind: "closed_enum", enumBinding: "stable", enumValues: ["true", "false"] },
  { key: "eligibility_subcheck", fieldClass: "query_axis", placement: "event", valueKind: "closed_enum", enumBinding: "pending_457" },
  { key: "hint_source", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "candidate_activity", fieldClass: "family_query_axis", placement: "span_or_event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "served_activity", fieldClass: "family_query_axis", placement: "span_or_event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "write_action", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity", enumBinding: "stable", enumValues: ["none"] },
  { key: "arbitration_reason", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity", enumBinding: "stable", enumValues: ["trusted_snapshot", "owner_mirror_read_through"] },
  { key: "weak_source", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "competing_fact", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "resolved_activity", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "previous_activity", fieldClass: "family_query_axis", placement: "span_or_event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "next_activity", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "repair_kind", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "activity_write_site", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "activity_source", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "status_bucket", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:activity" },
  { key: "shadow_agent_id", fieldClass: "family_query_axis", placement: "event", valueKind: "identity", scope: "family:lifecycle_shadow", highCardinality: true },
  { key: "shadow_signal_site", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457", enumValues: TRACE_LIFECYCLE_SHADOW_SIGNAL_SITE_VALUES },
  { key: "shadow_observation_class", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "shadow_prior_projection", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "shadow_projection", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "shadow_legacy_outcome", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "shadow_action", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "shadow_reason", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "shadow_direction", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "shadow_plan_kind", fieldClass: "family_query_axis", placement: "event", valueKind: "closed_enum", scope: "family:lifecycle_shadow", enumBinding: "pending_457" },
  { key: "row_count", fieldClass: "detail", placement: "span_or_event", valueKind: "detail" },
  { key: "rows_copied", fieldClass: "detail", placement: "span_or_event", valueKind: "numeric" },
  { key: "batch_index", fieldClass: "detail", placement: "span_or_event", valueKind: "numeric" },
  { key: "retry_count", fieldClass: "detail", placement: "span_or_event", valueKind: "detail" },
  { key: "error_message", fieldClass: "detail", placement: "span_or_event", valueKind: "detail", contentRule: "scrub_and_short_retention" },
  { key: "query_text", fieldClass: "content_safety", placement: "span_or_event", valueKind: "content", contentRule: "scrub_and_short_retention" },
  { key: "raw_payload", fieldClass: "content_safety", placement: "span_or_event", valueKind: "content", contentRule: "drop" },
  { key: "token", fieldClass: "content_safety", placement: "span_or_event", valueKind: "content", contentRule: "drop" },
] as const);

export class TraceScopeStack {
  constructor(private readonly scopes: readonly TraceScope[] = []) {}

  push(scope: TraceScope): TraceScopeStack {
    return new TraceScopeStack([...this.scopes, scope]);
  }

  project(): TraceAttributes {
    return this.scopes.reduce<TraceAttributes>((attrs, scope) => ({
      ...attrs,
      ...projectTraceScopeAttrs(scope),
    }), {});
  }

  tracer(tracer: Tracer, options: TraceScopeTracerOptions = {}): Tracer {
    const scoped = createScopedTracer(tracer, this.project(), {
      attrPrecedence: options.scopeAttrPrecedence,
    });
    return options.spanAttrContracts ? createSpanAttrContractTracer(scoped, options.spanAttrContracts) : scoped;
  }
}

export function createTraceScopeStack(...scopes: readonly TraceScope[]): TraceScopeStack {
  return new TraceScopeStack(scopes);
}
