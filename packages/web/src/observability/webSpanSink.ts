import type { CompletedTraceSpan, TraceSink } from "@botiverse/raft-shared";
import { buildWebTraceRecord, emitWebTraceRecord } from "../utils/webAuthTrace";
import type { WebSpanName } from "../utils/webAuthTrace";

/** Send a span a BasicTracer completed as a web trace record (its ids and times kept). */
export function recordCompletedWebSpan(span: CompletedTraceSpan): void {
  emitWebTraceRecord(buildWebTraceRecord(span.name as WebSpanName, span.attrs ?? {}, {
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    parentSpanId: span.context.parentSpanId,
    kind: span.kind,
    status: span.status,
    startTime: new Date(span.startTimeMs).toISOString(),
    endTime: new Date(span.endTimeMs).toISOString(),
    surface: span.surface as "web",
  }));
}

/** The default sink of the web's BasicTracers: the trace upload queue. */
export const webTraceSink: TraceSink = { record: recordCompletedWebSpan };
