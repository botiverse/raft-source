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
        how: "Trace query over state-transition spans grouped by key.domain/key.event/key.outcome",
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
        how: "Trace query over coalesced violation spans grouped by domain/entity/kind/epoch/verdict basis",
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
        how: "Trace query over throttled client-error spans grouped by source/error/component",
        whoRuns: "Manjusaka",
        runbook: "Manjusaka daily-scan liveness ledger",
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
