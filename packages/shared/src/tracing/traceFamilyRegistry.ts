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
  | "slock.web.vitals"
  | "slock.web.shell_keep_failed"
  | "slock.web.message_receive"
  | "slock.web.sync_gap_recovered"
  | "slock.context_view"
  | "slock.open_in_app"
  | "slock.attachment.upload_finished"
  | "mobile.thread_open"
  | "mobile.thread_open.shift"
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
    family: "slock.web.vitals",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Real-user Web Vitals and long-task summary in the daily app report: LCP (with lcp_element), session-window CLS, INP (with inp_interaction), long-task count/max/total, and foreground page_visible_ms, joined to boot_timing via tabId and deduplicated per tab via MAX(report_seq) (#proj-frontend:#77)",
        how: "otel.logs query over events (message = 'slock.web.vitals') taking MAX(report_seq) per tabId, grouped by landing/nav_type/browser_family/form_factor/platform/releaseSha",
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
    family: "slock.web.message_receive",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Client-side live message push receive latency (now - createdAt, 5% sampled) by socket event, sender kind and page visibility, paired with server slock_message_push_lag_seconds to split server lag from network + client lag",
        how: "otel.logs query over sampled events (message = 'slock.web.message_receive') grouped by event/sender_kind/visibility/clock_skew/releaseSha, percentiles of lag_ms",
        whoRuns: "AndyLok",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "slock.web.sync_gap_recovered",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Missed live messages recovered after the fact by GET /messages/sync (syncGap) or Socket.IO sync:resume:response, plus failed gap reads and horizon resets",
        how: "otel.logs query over events (message = 'slock.web.sync_gap_recovered') grouped by source/outcome/had_pending_hole/has_more/horizon_reset/visibility, sum and distribution of recovered_count",
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
    family: "slock.open_in_app",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Whether opening a Raft link in the app works (#proj-mobile:#128, deep_links_v1 on for everyone 11-13): offers shown, Open taken, and the app taking over (handed_over vs not_handed), app_missing and downloads, by surface, platform and kind of link",
        how: "otel.logs query over 'slock.open_in_app' events grouped by step × surface × platform (× link, signed_in); funnel offered → open → handed_over per surface and platform",
        whoRuns: "AndyLok",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "slock.attachment.upload_finished",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Whether composer attachment uploads still hang (#triage:#545): how each upload ended (ok/error/timeout/cancelled), which step timed out, by route, size and client",
        how: "otel.logs query over 'slock.attachment.upload_finished' events grouped by route × outcome × timeout_phase (× size_bucket, client_scheme), with duration_ms percentiles",
        whoRuns: "AndyLok",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "mobile.thread_open",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "App open-path stability per sampled thread/channel open: milestones (first frame, cache rows, network applied, positioned, stable), end reason, jitter score (shift_count/sum/max dp, shift_vh, shifts_after_positioned, time_to_stable_ms), reopen_same_view_within_ms (#proj-mobile:#199)",
        how: "otel.traces query over spans (name = 'mobile.thread_open', service.name = 'slock-web', attrs.clientPlatform in android/ios) grouped by end/cache/surface_kind/open_kind/appVersion, weighted by 1/sample_rate",
        whoRuns: "Lagoon",
        runbook: "docs/observability/reading-telemetry.md",
      },
    ],
  },
  {
    family: "mobile.thread_open.shift",
    privacyTier: "fleet-detection",
    entityFilterableDimensions: [],
    consumers: [
      {
        what: "Which viewport owner or content change moved an opening thread list, and when (cause, phase, delta_dp, rows_resized, max_row_delta_dp, owner_attempt); at most 20 per open",
        how: "otel.logs query over events (message = 'mobile.thread_open.shift') joined to their mobile.thread_open span on trace_id/span_id, grouped by cause/phase",
        whoRuns: "Lagoon",
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
