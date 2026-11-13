export type TracePrivacyTier =
  | "fleet-detection"
  | "bisect"
  | "client-error";

export interface TraceFamilyConsumer {
  readonly what: string;
  readonly how: string;
  readonly whoRuns: string;
  readonly runbook: string;
}

export interface TraceFamilyRegistration {
  readonly family: TraceFamilyName;
  readonly consumers: readonly TraceFamilyConsumer[];
  readonly privacyTier: TracePrivacyTier;
  readonly joinKeys?: readonly TraceJoinKey[];
  readonly entityFilterableDimensions: readonly TraceEntityFilterableDimension[];
}

export type TraceFamilyName =
  | "slock.state.transition"
  | "slock.state.violation"
  | "slock.client_error"
  | "slock.media_preview.error"
  | "slock.web.boot_timing"
  | "slock.web.shell_keep_failed"
  | "slock.context_view"
  | "server.db.query";

export const TRACE_JOIN_KEYS = ["clientEventId"] as const;

export type TraceJoinKey = (typeof TRACE_JOIN_KEYS)[number];

export const TRACE_ENTITY_FILTERABLE_DIMENSIONS = ["entityId"] as const;

export type TraceEntityFilterableDimension = (typeof TRACE_ENTITY_FILTERABLE_DIMENSIONS)[number];

export const TRACE_FAMILY_REGISTRY = [
  {
    family: "slock.state.transition",
    privacyTier: "bisect",
    joinKeys: TRACE_JOIN_KEYS,
    entityFilterableDimensions: TRACE_ENTITY_FILTERABLE_DIMENSIONS,
    consumers: [
      {
        what: "S1 three-signal acceptance readback and incident bisect",
        how: "otel.logs query over state-transition events (message = 'slock.state.transition') grouped by key.domain/key.event/key.outcome, joined on join.clientEventId",
        whoRuns: "Tiegen",
        runbook: "Manjusaka daily-scan liveness ledger",
      },
    ],
  },
  {
    family: "slock.state.violation",
    privacyTier: "bisect",
    joinKeys: TRACE_JOIN_KEYS,
    entityFilterableDimensions: TRACE_ENTITY_FILTERABLE_DIMENSIONS,
    consumers: [
      {
        what: "SRE threshold alerts for producer-contract breaches",
        how: "otel.logs query over coalesced violation events grouped by domain/entity/kind/epoch/verdict basis",
        whoRuns: "Manjusaka",
        runbook: "Manjusaka daily-scan liveness ledger",
      },
    ],
  },
  {
    family: "slock.client_error",
    privacyTier: "client-error",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Client crash daily scan and React crash incident detection",
        how: "otel.logs query over throttled client-error events grouped by source/error/component; error_boundary, window_onerror and unhandled_rejection rows by errorFingerprint/topFrame, one crash found by clientTraceId",
        whoRuns: "Manjusaka",
        runbook: "Manjusaka daily-scan liveness ledger",
      },
    ],
  },
  {
    family: "slock.media_preview.error",
    privacyTier: "client-error",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Daily count of inline media preview failures, checking that expired-link failures no longer show the codec warning (bug-triage task #14)",
        how: "otel.logs query over throttled media-preview error events (message = 'slock.media_preview.error') grouped by error_class/browser_family/url_refreshed",
        whoRuns: "AndyLok",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "slock.web.boot_timing",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Web boot timing in the daily app report: p50/p90 of content_ms (and bundle/auth_sent/auth/servers/frame/messages_sent/messages) by landing x browser_family x form_factor x platform, split by token_refreshed_first and nav_type; before/after for the load-time work (task #3 in #proj-frontend)",
        how: "otel.logs query over one event per page load (message = 'slock.web.boot_timing') grouped by landing/browser_family/nav_type/outcome/releaseSha",
        whoRuns: "AndyLok",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "slock.web.shell_keep_failed",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Browsers whose service worker can't keep a new release's HTML, so they keep opening an older release (#triage:#165, a HarmonyOS browser stuck on web 1.21.42): which step fails, on which browsers",
        how: "otel.logs query over events (message = 'slock.web.shell_keep_failed') grouped by step/browser_family/harmonyos/served_kept/releaseSha",
        whoRuns: "AndyLok",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "slock.context_view",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Why View Context sometimes looks unresponsive (#wg-ax:#28): the check's state when the menu opens and how long it took, clicks, and each answer's outcome and time from the click",
        how: "otel.logs query over 'slock.context_view' events grouped by step/status/outcome, with wait_ms and total_ms percentiles; joined by time with server.agent_context_view.answered",
        whoRuns: "AndyLok",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "server.db.query",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "G2 15-second-knee query-failure battery and DB-failure incident triage (e.g. /api/channels/inbox 500s)",
        how: "trace_events_v2 query over server.db.query span_facts and db.query.* events grouped by db_system/query_name/phase/sqlstate/timeout_bucket/retryable",
        whoRuns: "Leiysky",
        runbook: "docs/observability/raft-tracing-v2-event-rows.md query-proof section",
      },
    ],
  },
] as const satisfies readonly TraceFamilyRegistration[];

export function traceFamilyRegistration(family: TraceFamilyName): TraceFamilyRegistration {
  const registration = TRACE_FAMILY_REGISTRY.find((entry) => entry.family === family);
  if (!registration) throw new Error(`Missing trace family registration: ${family}`);
  return registration;
}

export class InvalidTraceEntityDimensionError extends Error {
  readonly code = "invalid-dimension" as const;

  constructor(readonly family: TraceFamilyName, readonly dimension: string) {
    super("invalid-dimension: not entity-filterable; use producer_fact_id or a bisect-tier family");
    this.name = "InvalidTraceEntityDimensionError";
  }
}

/** Reader/query gate: an undeclared entity filter is invalid, never an empty result. */
export function assertTraceFamilyEntityFilterable(
  family: TraceFamilyName,
  dimension: string,
): asserts dimension is TraceEntityFilterableDimension {
  const registration = traceFamilyRegistration(family);
  if (!(registration.entityFilterableDimensions as readonly string[]).includes(dimension)) {
    throw new InvalidTraceEntityDimensionError(family, dimension);
  }
}
