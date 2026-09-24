export type EventBufferRejectReason =
  | "unauthorized"
  | "invalid_json"
  | "invalid_envelope"
  | "table_not_allowed"
  | "schema_mismatch"
  | "request_too_large"
  | "batch_too_large"
  | "row_too_large"
  | "queue_full"
  | "shutting_down";

export type EventBufferIngressRowRejectReason = "row_too_large";

export type EventBufferDropReason =
  | "export_failure"
  | "commit_mismatch"
  | "drain_timeout";

export type EventBufferOutcomeUnknownReason = "abandoned_in_flight";

export interface EventBufferMetricState {
  ingressAttemptedBatches: number;
  ingressAcceptedBatches: number;
  ingressAcceptedRows: number;
  rejectedBatches: Readonly<Record<EventBufferRejectReason, number>>;
  ingressRejectedRows: Readonly<Record<EventBufferIngressRowRejectReason, number>>;
  exportAttempts: number;
  attemptedRows: number;
  committedRows: number;
  droppedRows: Readonly<Record<EventBufferDropReason, number>>;
  outcomeUnknownRows: Readonly<Record<EventBufferOutcomeUnknownReason, number>>;
  rateLimitedAttempts: number;
}

export interface EventBufferQueueMetricState {
  depthRows: number;
  depthBytes: number;
  oldestAgeMs: number;
}

const REJECT_REASONS = [
  "unauthorized",
  "invalid_json",
  "invalid_envelope",
  "table_not_allowed",
  "schema_mismatch",
  "request_too_large",
  "batch_too_large",
  "row_too_large",
  "queue_full",
  "shutting_down",
] as const satisfies readonly EventBufferRejectReason[];

const INGRESS_ROW_REJECT_REASONS = [
  "row_too_large",
] as const satisfies readonly EventBufferIngressRowRejectReason[];

const DROP_REASONS = [
  "export_failure",
  "commit_mismatch",
  "drain_timeout",
] as const satisfies readonly EventBufferDropReason[];

const OUTCOME_UNKNOWN_REASONS = [
  "abandoned_in_flight",
] as const satisfies readonly EventBufferOutcomeUnknownReason[];

export class EventBufferMetrics {
  private ingressAttemptedBatches = 0;
  private ingressAcceptedBatches = 0;
  private ingressAcceptedRows = 0;
  private exportAttempts = 0;
  private attemptedRows = 0;
  private committedRows = 0;
  private rateLimitedAttempts = 0;
  private readonly rejectedBatches = counters(REJECT_REASONS);
  private readonly ingressRejectedRows = counters(INGRESS_ROW_REJECT_REASONS);
  private readonly droppedRows = counters(DROP_REASONS);
  private readonly outcomeUnknownRows = counters(OUTCOME_UNKNOWN_REASONS);

  recordIngressAttempt(): void {
    this.ingressAttemptedBatches += 1;
  }

  recordAccepted(rows: number): void {
    this.ingressAcceptedBatches += 1;
    this.ingressAcceptedRows += rows;
  }

  recordRejected(reason: EventBufferRejectReason): void {
    this.rejectedBatches[reason] += 1;
  }

  recordIngressRejectedRows(reason: EventBufferIngressRowRejectReason, rows: number): void {
    this.ingressRejectedRows[reason] += rows;
  }

  recordExportAttempt(rows: number): void {
    this.exportAttempts += 1;
    this.attemptedRows += rows;
  }

  recordCommitted(rows: number): void {
    this.committedRows += rows;
  }

  recordDropped(reason: EventBufferDropReason, rows: number): void {
    this.droppedRows[reason] += rows;
  }

  recordOutcomeUnknown(reason: EventBufferOutcomeUnknownReason, rows: number): void {
    this.outcomeUnknownRows[reason] += rows;
  }

  recordRateLimited(): void {
    this.rateLimitedAttempts += 1;
  }

  snapshot(): EventBufferMetricState {
    return {
      ingressAttemptedBatches: this.ingressAttemptedBatches,
      ingressAcceptedBatches: this.ingressAcceptedBatches,
      ingressAcceptedRows: this.ingressAcceptedRows,
      rejectedBatches: { ...this.rejectedBatches },
      ingressRejectedRows: { ...this.ingressRejectedRows },
      exportAttempts: this.exportAttempts,
      attemptedRows: this.attemptedRows,
      committedRows: this.committedRows,
      droppedRows: { ...this.droppedRows },
      outcomeUnknownRows: { ...this.outcomeUnknownRows },
      rateLimitedAttempts: this.rateLimitedAttempts,
    };
  }

  renderPrometheus(queue: EventBufferQueueMetricState): string {
    const state = this.snapshot();
    const lines = [
      counter("ingress_attempted_batches_total", state.ingressAttemptedBatches),
      counter("ingress_accepted_batches_total", state.ingressAcceptedBatches),
      counter("ingress_accepted_rows_total", state.ingressAcceptedRows),
      counter("export_attempts_total", state.exportAttempts),
      counter("export_attempted_rows_total", state.attemptedRows),
      counter("committed_rows_total", state.committedRows),
      counter("rate_limited_attempts_total", state.rateLimitedAttempts),
      gauge("queue_depth_rows", queue.depthRows),
      gauge("queue_depth_bytes", queue.depthBytes),
      gauge("queue_oldest_age_ms", queue.oldestAgeMs),
    ];
    lines.push(metricFamily(
      "counter",
      "ingress_rejected_batches_total",
      REJECT_REASONS.map((reason) => ({ value: state.rejectedBatches[reason], labels: { reason } })),
    ));
    lines.push(metricFamily(
      "counter",
      "ingress_rejected_rows_total",
      INGRESS_ROW_REJECT_REASONS.map((reason) => ({
        value: state.ingressRejectedRows[reason],
        labels: { reason },
      })),
    ));
    lines.push(metricFamily(
      "counter",
      "dropped_rows_total",
      DROP_REASONS.map((reason) => ({ value: state.droppedRows[reason], labels: { reason } })),
    ));
    lines.push(metricFamily(
      "counter",
      "outcome_unknown_rows_total",
      OUTCOME_UNKNOWN_REASONS.map((reason) => ({
        value: state.outcomeUnknownRows[reason],
        labels: { reason },
      })),
    ));
    return `${lines.join("\n")}\n`;
  }
}

function counters<const T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

function counter(name: string, value: number, labels?: Record<string, string>): string {
  return metric("counter", name, value, labels);
}

function gauge(name: string, value: number): string {
  return metric("gauge", name, value);
}

function metric(
  type: "counter" | "gauge",
  name: string,
  value: number,
  labels?: Record<string, string>,
): string {
  const fullName = `raft_event_buffer_${name}`;
  const renderedLabels = labels
    ? `{${Object.entries(labels).map(([key, label]) => `${key}="${label}"`).join(",")}}`
    : "";
  return `# TYPE ${fullName} ${type}\n${fullName}${renderedLabels} ${value}`;
}

function metricFamily(
  type: "counter" | "gauge",
  name: string,
  samples: ReadonlyArray<{ value: number; labels?: Record<string, string> }>,
): string {
  const fullName = `raft_event_buffer_${name}`;
  return [
    `# TYPE ${fullName} ${type}`,
    ...samples.map(({ value, labels }) => {
      const renderedLabels = labels
        ? `{${Object.entries(labels).map(([key, label]) => `${key}="${label}"`).join(",")}}`
        : "";
      return `${fullName}${renderedLabels} ${value}`;
    }),
  ].join("\n");
}
