# Raft Event Buffer

Thin, single-process decision-support telemetry buffer core.

## V0 contract

- The authenticated ingress accepts only
  `{table, schemaFingerprint, rows}` for the code-owned
  `raft.trace_events_v2` schema. Rows are opaque to the buffer. During an
  additive projection rollout the immediately preceding fingerprint is also
  accepted, then exported under the current fingerprint; this lets old and new
  producers overlap without rejecting nullable legacy rows.
- Accepted rows live only in a bounded in-memory queue. A `202` receipt means
  `queued` and explicitly does not mean `committed`.
- Batches flush on row count, JSON-encoded row-payload byte count, or
  oldest-row age. `maxBatchBytes` excludes envelope/array/comma framing; Phase
  1B exporter wiring owns the final serialized request-byte ceiling.
- A single-token bucket caps export attempts at 3 qps. A 429 requeues the old
  batch ahead of rows accepted during backoff so the next bounded attempt can
  coalesce both generations.
- Metrics account for ingress attempted/accepted/rejected, export attempted,
  committed, rate-limited, confirmed-dropped, and outcome-unknown in-flight
  rows plus queue depth/bytes/oldest age. An oversized row is rejected in
  isolation without discarding valid siblings from the same envelope.
- SIGTERM/SIGINT integration performs a bounded best-effort drain and reports
  whether the pending memory-only tail emptied or timed out. Timeout receipts
  split confirmed queued-row drops from outcome-unknown in-flight rows.
  A second signal during drain is ignored; the process supervisor's bounded
  termination/SIGKILL policy remains the final hard-stop boundary.

## Non-goals

V0 has no persistence, disk WAL, SQS/Camus, HA or leader election, DLQ,
idempotency layer, schema-registry service, migration framework, observer-hook
framework, or pluggable queue adapter. A process crash may lose a small,
bounded telemetry tail; the accepted/committed/dropped ledger makes managed
loss visible but cannot make an abrupt crash durable.
