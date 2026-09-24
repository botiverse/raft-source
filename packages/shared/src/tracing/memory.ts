import type { CompletedTraceSpan, TraceSink } from "./index.js";

export class MemoryTraceSink implements TraceSink {
  private readonly spans: CompletedTraceSpan[] = [];

  record(span: CompletedTraceSpan): void {
    this.spans.push(span);
  }

  clear(): void {
    this.spans.length = 0;
  }

  getTrace(traceId: string): readonly CompletedTraceSpan[] {
    return this.spans.filter((span) => span.context.traceId === traceId);
  }

  getAllSpans(): readonly CompletedTraceSpan[] {
    return this.spans;
  }
}
