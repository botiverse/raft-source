import type { CompletedTraceSpan, TraceEvent } from "./index.js";
import type { MemoryTraceSink } from "./memory.js";

export function getTrace(sink: MemoryTraceSink, traceId: string): readonly CompletedTraceSpan[] {
  return sink.getTrace(traceId);
}

export function spanNames(sink: MemoryTraceSink, traceId: string): string[] {
  return getTrace(sink, traceId).map((span) => span.name);
}

export function eventsForSpan(sink: MemoryTraceSink, traceId: string, spanName: string): readonly TraceEvent[] {
  const span = getTrace(sink, traceId).find((candidate) => candidate.name === spanName);
  if (!span) {
    throw new Error(`Trace ${traceId} does not contain span "${spanName}"`);
  }
  return span.events;
}

export function assertSpanOrder(sink: MemoryTraceSink, traceId: string, expectedNames: string[]): void {
  const actualNames = spanNames(sink, traceId);
  let searchIndex = 0;

  for (const expectedName of expectedNames) {
    const foundIndex = actualNames.indexOf(expectedName, searchIndex);
    if (foundIndex === -1) {
      throw new Error(`Expected trace ${traceId} to contain span order ${JSON.stringify(expectedNames)}, got ${JSON.stringify(actualNames)}`);
    }
    searchIndex = foundIndex + 1;
  }
}

export function assertSpanEvent(sink: MemoryTraceSink, traceId: string, spanName: string, eventName: string): void {
  const events = eventsForSpan(sink, traceId, spanName);
  if (!events.some((event) => event.name === eventName)) {
    throw new Error(`Expected span "${spanName}" in trace ${traceId} to contain event "${eventName}"`);
  }
}
