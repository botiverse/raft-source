export type ComputerTraceSurface = "server" | "daemon" | "web" | "computer";
export type ComputerTraceSpanKind = "server" | "client" | "internal" | "producer" | "consumer";
export type ComputerTraceStatus = "ok" | "error" | "cancelled";
export type ComputerTraceAttributes = Record<string, unknown>;
export type ComputerTraceClientSource = "daemon" | "computer.cli" | "computer.menu-bar";

export interface ComputerTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
}

export interface ComputerStartSpanOptions {
  parent?: ComputerTraceContext | null;
  surface: ComputerTraceSurface;
  kind?: ComputerTraceSpanKind;
  attrs?: ComputerTraceAttributes;
  startTimeMs?: number;
}

export interface ComputerEndSpanOptions {
  attrs?: ComputerTraceAttributes;
}

export interface ComputerActiveSpan {
  readonly context: ComputerTraceContext;
  addEvent(name: string, attrs?: ComputerTraceAttributes): void;
  end(status?: ComputerTraceStatus, options?: ComputerEndSpanOptions): void;
}

export interface ComputerTracer {
  startSpan(name: string, options: ComputerStartSpanOptions): ComputerActiveSpan;
}
