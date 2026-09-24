export type TraceSurface = "server" | "daemon" | "web" | "computer";
export type TraceSpanKind = "server" | "client" | "internal" | "producer" | "consumer";
// `unset` is the OpenTelemetry-compatible neutral status used by browser
// producers that do not make an error/success judgment. Keep it distinct from
// `ok`: treating missing judgment as success would change the trace's meaning.
export type TraceStatus = "unset" | "ok" | "error" | "cancelled";
export type TraceAttributes = Record<string, unknown>;

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
}

export interface TraceEvent {
  name: string;
  timeMs: number;
  attrs?: TraceAttributes;
}

export interface CompletedTraceSpan {
  context: TraceContext;
  name: string;
  surface: TraceSurface;
  kind: TraceSpanKind;
  status: TraceStatus;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attrs?: TraceAttributes;
  events: readonly TraceEvent[];
}

export interface StartedTraceSpan {
  context: TraceContext;
  name: string;
  surface: TraceSurface;
  kind: TraceSpanKind;
  startTimeMs: number;
  attrs?: TraceAttributes;
}

export interface TraceEventRecord {
  span: StartedTraceSpan;
  event: TraceEvent;
  eventIndex: number;
}

export interface TraceSpanFactRecord {
  span: CompletedTraceSpan;
}

export interface StartSpanOptions {
  parent?: TraceContext | null;
  surface: TraceSurface;
  kind?: TraceSpanKind;
  attrs?: TraceAttributes;
  startTimeMs?: number;
}

export interface EndSpanOptions {
  attrs?: TraceAttributes;
}

export interface ActiveSpan {
  readonly context: TraceContext;
  addEvent(name: string, attrs?: TraceAttributes): void;
  end(status?: TraceStatus, options?: EndSpanOptions): void;
}

export interface Tracer {
  startSpan(name: string, options: StartSpanOptions): ActiveSpan;
}

export interface TraceSink {
  record(span: CompletedTraceSpan): void;
  recordEvent?(record: TraceEventRecord): void;
  recordSpanFact?(record: TraceSpanFactRecord): void;
}

export type TraceClock = () => number;
export type TraceIdGenerator = () => string;
export type SpanIdGenerator = () => string;

export const DEFAULT_TRACE_FLAGS = "00";
export const TRACEPARENT_VERSION = "00";
export const TRACE_ID_HEX_LENGTH = 32;
export const SPAN_ID_HEX_LENGTH = 16;
export const TRACE_FLAGS_HEX_LENGTH = 2;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_PATTERN = /^[0-9a-f]{2}$/;
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function isTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value) && value !== "0".repeat(TRACE_ID_HEX_LENGTH);
}

export function isSpanId(value: string): boolean {
  return SPAN_ID_PATTERN.test(value) && value !== "0".repeat(SPAN_ID_HEX_LENGTH);
}

export function isTraceFlags(value: string): boolean {
  return TRACE_FLAGS_PATTERN.test(value);
}

export function assertTraceContext(context: TraceContext): void {
  if (!isTraceId(context.traceId)) {
    throw new Error(`Invalid traceId: expected ${TRACE_ID_HEX_LENGTH} lowercase hex chars`);
  }
  if (!isSpanId(context.spanId)) {
    throw new Error(`Invalid spanId: expected ${SPAN_ID_HEX_LENGTH} lowercase hex chars`);
  }
  if (context.parentSpanId !== null && !isSpanId(context.parentSpanId)) {
    throw new Error(`Invalid parentSpanId: expected null or ${SPAN_ID_HEX_LENGTH} lowercase hex chars`);
  }
  if (!isTraceFlags(context.traceFlags)) {
    throw new Error(`Invalid traceFlags: expected ${TRACE_FLAGS_HEX_LENGTH} lowercase hex chars`);
  }
}

export function formatTraceparent(context: TraceContext): string {
  assertTraceContext(context);
  return `${TRACEPARENT_VERSION}-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return null;

  const [, version, traceId, spanId, traceFlags] = match;
  if (version !== TRACEPARENT_VERSION) return null;
  if (!isTraceId(traceId) || !isSpanId(spanId) || !isTraceFlags(traceFlags)) return null;

  return {
    traceId,
    spanId,
    parentSpanId: null,
    traceFlags,
  };
}

export function createTraceContext({
  parent = null,
  traceId,
  spanId,
  traceFlags,
  traceIdGenerator = generateTraceId,
  spanIdGenerator = generateSpanId,
}: {
  parent?: TraceContext | null;
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  traceIdGenerator?: TraceIdGenerator;
  spanIdGenerator?: SpanIdGenerator;
} = {}): TraceContext {
  const context = {
    traceId: traceId ?? parent?.traceId ?? traceIdGenerator(),
    spanId: spanId ?? spanIdGenerator(),
    parentSpanId: parent?.spanId ?? null,
    traceFlags: traceFlags ?? parent?.traceFlags ?? DEFAULT_TRACE_FLAGS,
  };
  assertTraceContext(context);
  return context;
}

export class NoopTracer implements Tracer {
  startSpan(_name: string, options: StartSpanOptions): ActiveSpan {
    return new NoopActiveSpan(createTraceContext({ parent: options.parent ?? null }));
  }
}

class NoopActiveSpan implements ActiveSpan {
  readonly context: TraceContext;

  constructor(context: TraceContext) {
    this.context = context;
  }

  addEvent(): void {}

  end(): void {}
}

export const noopTracer: Tracer = new NoopTracer();

export type TraceScopeAttrCategory = "resource" | "request" | "actor";
export type TraceScopeAttrValueKind = "closed_enum" | "identity" | "presence" | "version" | "route" | "method";

export interface TraceScopeAttrDefinition {
  readonly key: string;
  readonly category: TraceScopeAttrCategory;
  readonly valueKind: TraceScopeAttrValueKind;
  /**
   * Whether the raw value can have high cardinality. This is a contract signal
   * for producers/reviewers; sinks still perform generic privacy filtering.
   */
  readonly highCardinality: boolean;
}

export const TRACE_SCOPE_ATTR_REGISTRY = {
  daemon_version: { key: "daemon_version", category: "resource", valueKind: "version", highCardinality: false },
  daemon_version_present: { key: "daemon_version_present", category: "resource", valueKind: "presence", highCardinality: false },
  computer_version: { key: "computer_version", category: "resource", valueKind: "version", highCardinality: false },
  computer_version_present: { key: "computer_version_present", category: "resource", valueKind: "presence", highCardinality: false },
  deployment_environment: { key: "deployment_environment", category: "resource", valueKind: "closed_enum", highCardinality: false },
  service_revision: { key: "service_revision", category: "resource", valueKind: "version", highCardinality: true },
  request_id: { key: "request_id", category: "request", valueKind: "identity", highCardinality: true },
  request_id_present: { key: "request_id_present", category: "request", valueKind: "presence", highCardinality: false },
  route_pattern: { key: "route_pattern", category: "request", valueKind: "route", highCardinality: false },
  method: { key: "method", category: "request", valueKind: "method", highCardinality: false },
  caller_kind: { key: "caller_kind", category: "request", valueKind: "closed_enum", highCardinality: false },
  user_id: { key: "user_id", category: "request", valueKind: "identity", highCardinality: true },
  user_id_present: { key: "user_id_present", category: "request", valueKind: "presence", highCardinality: false },
  server_id: { key: "server_id", category: "actor", valueKind: "identity", highCardinality: true },
  server_id_present: { key: "server_id_present", category: "actor", valueKind: "presence", highCardinality: false },
  machine_id: { key: "machine_id", category: "actor", valueKind: "identity", highCardinality: true },
  machine_id_present: { key: "machine_id_present", category: "actor", valueKind: "presence", highCardinality: false },
  agent_id: { key: "agent_id", category: "actor", valueKind: "identity", highCardinality: true },
  agent_id_present: { key: "agent_id_present", category: "actor", valueKind: "presence", highCardinality: false },
  launch_id: { key: "launch_id", category: "actor", valueKind: "identity", highCardinality: true },
  launch_id_present: { key: "launch_id_present", category: "actor", valueKind: "presence", highCardinality: false },
  session_id: { key: "session_id", category: "actor", valueKind: "identity", highCardinality: true },
  session_id_present: { key: "session_id_present", category: "actor", valueKind: "presence", highCardinality: false },
} satisfies Record<string, TraceScopeAttrDefinition>;

export type TraceScopeAttrKey = keyof typeof TRACE_SCOPE_ATTR_REGISTRY;

export interface ResourceTraceScope {
  daemonVersion?: string | null;
  computerVersion?: string | null;
  deploymentEnvironment?: "production" | "staging" | "development" | "test" | string | null;
  serviceRevision?: string | null;
}

export interface RequestTraceScope {
  requestId?: string | null;
  routePattern?: string | null;
  method?: string | null;
  callerKind?: "human" | "agent" | "system" | string | null;
  userId?: string | null;
  userIdPresent?: boolean | null;
}

export interface ActorTraceScope {
  serverId?: string | null;
  serverIdPresent?: boolean | null;
  machineId?: string | null;
  machineIdPresent?: boolean | null;
  agentId?: string | null;
  agentIdPresent?: boolean | null;
  launchId?: string | null;
  launchIdPresent?: boolean | null;
  sessionId?: string | null;
  sessionIdPresent?: boolean | null;
}

export interface TraceScope {
  resource?: ResourceTraceScope;
  request?: RequestTraceScope;
  actor?: ActorTraceScope;
}

export function projectTraceScopeAttrs(scope: TraceScope): TraceAttributes {
  const attrs: TraceAttributes = {};
  addOptionalStringAttr(attrs, "daemon_version", scope.resource?.daemonVersion);
  addPresenceAttr(attrs, "daemon_version_present", scope.resource?.daemonVersion);
  addOptionalStringAttr(attrs, "computer_version", scope.resource?.computerVersion);
  addPresenceAttr(attrs, "computer_version_present", scope.resource?.computerVersion);
  addOptionalStringAttr(attrs, "deployment_environment", scope.resource?.deploymentEnvironment);
  addOptionalStringAttr(attrs, "service_revision", scope.resource?.serviceRevision);

  addOptionalStringAttr(attrs, "request_id", scope.request?.requestId);
  addPresenceAttr(attrs, "request_id_present", scope.request?.requestId);
  addOptionalStringAttr(attrs, "route_pattern", scope.request?.routePattern);
  addOptionalStringAttr(attrs, "method", scope.request?.method);
  addOptionalStringAttr(attrs, "caller_kind", scope.request?.callerKind);
  addOptionalStringAttr(attrs, "user_id", scope.request?.userId);
  if (typeof scope.request?.userIdPresent === "boolean") {
    attrs.user_id_present = scope.request.userIdPresent;
  }

  addOptionalStringAttr(attrs, "server_id", scope.actor?.serverId);
  addPresenceAttr(attrs, "server_id_present", scope.actor?.serverId, scope.actor?.serverIdPresent);
  addOptionalStringAttr(attrs, "machine_id", scope.actor?.machineId);
  addPresenceAttr(attrs, "machine_id_present", scope.actor?.machineId, scope.actor?.machineIdPresent);
  addOptionalStringAttr(attrs, "agent_id", scope.actor?.agentId);
  addPresenceAttr(attrs, "agent_id_present", scope.actor?.agentId, scope.actor?.agentIdPresent);
  addOptionalStringAttr(attrs, "launch_id", scope.actor?.launchId);
  addPresenceAttr(attrs, "launch_id_present", scope.actor?.launchId, scope.actor?.launchIdPresent);
  addOptionalStringAttr(attrs, "session_id", scope.actor?.sessionId);
  addPresenceAttr(attrs, "session_id_present", scope.actor?.sessionId, scope.actor?.sessionIdPresent);

  return attrs;
}

export interface TraceSpanAttrContract {
  readonly spanAttrs?: readonly string[];
  readonly eventAttrs?: Readonly<Record<string, readonly string[]>>;
  readonly endAttrs?: readonly string[];
}

export type TraceSpanAttrContracts = Readonly<Record<string, TraceSpanAttrContract>>;

export interface TraceScopeTracerOptions {
  readonly spanAttrContracts?: TraceSpanAttrContracts;
  readonly scopeAttrPrecedence?: "scope" | "caller";
}

export function createTraceScopeTracer(tracer: Tracer, scope: TraceScope, options: TraceScopeTracerOptions = {}): Tracer {
  const scopedTracer = createScopedTracer(tracer, projectTraceScopeAttrs(scope), {
    attrPrecedence: options.scopeAttrPrecedence,
  });
  return options.spanAttrContracts ? createSpanAttrContractTracer(scopedTracer, options.spanAttrContracts) : scopedTracer;
}

export interface ScopedTracerOptions {
  readonly attrPrecedence?: "scope" | "caller";
}

export function createScopedTracer(tracer: Tracer, scopeAttrs: TraceAttributes, options: ScopedTracerOptions = {}): Tracer {
  if (!Object.keys(scopeAttrs).length) return tracer;
  return new ScopedTracer(tracer, scopeAttrs, options.attrPrecedence ?? "scope");
}

class ScopedTracer implements Tracer {
  constructor(
    private readonly tracer: Tracer,
    private readonly scopeAttrs: TraceAttributes,
    private readonly attrPrecedence: "scope" | "caller",
  ) {}

  startSpan(name: string, options: StartSpanOptions): ActiveSpan {
    const span = this.tracer.startSpan(name, {
      ...options,
      attrs: this.mergeScopeAttrs(options.attrs),
    });
    return new ScopedActiveSpan(span, this.scopeAttrs, this.attrPrecedence);
  }

  private mergeScopeAttrs(attrs: TraceAttributes | undefined): TraceAttributes | undefined {
    return this.attrPrecedence === "caller"
      ? mergeAttrs(this.scopeAttrs, attrs)
      : mergeAttrs(attrs, this.scopeAttrs);
  }
}

class ScopedActiveSpan implements ActiveSpan {
  readonly context: TraceContext;

  constructor(
    private readonly span: ActiveSpan,
    private readonly scopeAttrs: TraceAttributes,
    private readonly attrPrecedence: "scope" | "caller",
  ) {
    this.context = span.context;
  }

  addEvent(name: string, attrs?: TraceAttributes): void {
    this.span.addEvent(name, this.withoutInheritedScopeAttrs(attrs));
  }

  end(status?: TraceStatus, options?: EndSpanOptions): void {
    this.span.end(status, options ? {
      ...options,
      attrs: this.mergeScopeAttrs(options.attrs),
    } : undefined);
  }

  private mergeScopeAttrs(attrs: TraceAttributes | undefined): TraceAttributes | undefined {
    return this.attrPrecedence === "caller"
      ? mergeAttrs(this.scopeAttrs, attrs)
      : mergeAttrs(attrs, this.scopeAttrs);
  }

  private withoutInheritedScopeAttrs(attrs: TraceAttributes | undefined): TraceAttributes | undefined {
    if (!attrs) return undefined;

    const eventAttrs: TraceAttributes = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (!Object.hasOwn(this.scopeAttrs, key)) {
        eventAttrs[key] = value;
        continue;
      }

      if (this.attrPrecedence === "caller" && !Object.is(this.scopeAttrs[key], value)) {
        eventAttrs[key] = value;
      }
    }

    return Object.keys(eventAttrs).length > 0 ? eventAttrs : undefined;
  }
}

export function createSpanAttrContractTracer(tracer: Tracer, contracts: TraceSpanAttrContracts): Tracer {
  if (!Object.keys(contracts).length) return tracer;
  return new SpanAttrContractTracer(tracer, contracts);
}

class SpanAttrContractTracer implements Tracer {
  constructor(
    private readonly tracer: Tracer,
    private readonly contracts: TraceSpanAttrContracts,
  ) {}

  startSpan(name: string, options: StartSpanOptions): ActiveSpan {
    const contract = this.contracts[name];
    if (!contract) return this.tracer.startSpan(name, options);
    const span = this.tracer.startSpan(name, {
      ...options,
      attrs: filterTraceAttrs(options.attrs, contract.spanAttrs),
    });
    return new SpanAttrContractActiveSpan(span, contract);
  }
}

class SpanAttrContractActiveSpan implements ActiveSpan {
  readonly context: TraceContext;

  constructor(
    private readonly span: ActiveSpan,
    private readonly contract: TraceSpanAttrContract,
  ) {
    this.context = span.context;
  }

  addEvent(name: string, attrs?: TraceAttributes): void {
    this.span.addEvent(name, filterTraceAttrs(attrs, this.contract.eventAttrs?.[name]));
  }

  end(status?: TraceStatus, options?: EndSpanOptions): void {
    this.span.end(status, options ? {
      ...options,
      attrs: filterTraceAttrs(options.attrs, this.contract.endAttrs),
    } : undefined);
  }
}

export function filterTraceAttrs(attrs: TraceAttributes | undefined, allowedKeys: readonly string[] | undefined): TraceAttributes | undefined {
  if (!attrs || !allowedKeys) return attrs;
  const allowed = new Set(allowedKeys);
  const filtered: TraceAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (allowed.has(key)) filtered[key] = value;
  }
  return Object.keys(filtered).length ? filtered : undefined;
}

export interface BasicTracerOptions {
  sink: TraceSink;
  clock?: TraceClock;
  traceIdGenerator?: TraceIdGenerator;
  spanIdGenerator?: SpanIdGenerator;
}

export class BasicTracer implements Tracer {
  private readonly sink: TraceSink;
  private readonly clock: TraceClock;
  private readonly traceIdGenerator: TraceIdGenerator;
  private readonly spanIdGenerator: SpanIdGenerator;

  constructor({
    sink,
    clock = () => Date.now(),
    traceIdGenerator = generateTraceId,
    spanIdGenerator = generateSpanId,
  }: BasicTracerOptions) {
    this.sink = sink;
    this.clock = clock;
    this.traceIdGenerator = traceIdGenerator;
    this.spanIdGenerator = spanIdGenerator;
  }

  startSpan(name: string, options: StartSpanOptions): ActiveSpan {
    const startTimeMs = options.startTimeMs ?? this.clock();
    const context = createTraceContext({
      parent: options.parent ?? null,
      traceIdGenerator: this.traceIdGenerator,
      spanIdGenerator: this.spanIdGenerator,
    });
    return new RecordingActiveSpan({
      context,
      name,
      surface: options.surface,
      kind: options.kind ?? "internal",
      attrs: options.attrs,
      startTimeMs,
      clock: this.clock,
      sink: this.sink,
    });
  }
}

class RecordingActiveSpan implements ActiveSpan {
  readonly context: TraceContext;
  private readonly name: string;
  private readonly surface: TraceSurface;
  private readonly kind: TraceSpanKind;
  private readonly startTimeMs: number;
  private readonly clock: TraceClock;
  private readonly sink: TraceSink;
  private readonly events: TraceEvent[] = [];
  private attrs?: TraceAttributes;
  private ended = false;

  constructor({
    context,
    name,
    surface,
    kind,
    attrs,
    startTimeMs,
    clock,
    sink,
  }: {
    context: TraceContext;
    name: string;
    surface: TraceSurface;
    kind: TraceSpanKind;
    attrs?: TraceAttributes;
    startTimeMs: number;
    clock: TraceClock;
    sink: TraceSink;
  }) {
    this.context = context;
    this.name = name;
    this.surface = surface;
    this.kind = kind;
    this.attrs = attrs;
    this.startTimeMs = startTimeMs;
    this.clock = clock;
    this.sink = sink;
  }

  addEvent(name: string, attrs?: TraceAttributes): void {
    if (this.ended) return;
    const event: TraceEvent = {
      name,
      timeMs: this.clock(),
      ...(attrs ? { attrs } : {}),
    };
    const eventIndex = this.events.length;
    this.events.push(event);
    this.sink.recordEvent?.({
      span: {
        context: this.context,
        name: this.name,
        surface: this.surface,
        kind: this.kind,
        startTimeMs: this.startTimeMs,
        ...(this.attrs ? { attrs: this.attrs } : {}),
      },
      event,
      eventIndex,
    });
  }

  end(status: TraceStatus = "ok", options: EndSpanOptions = {}): void {
    if (this.ended) return;
    this.ended = true;
    const endTimeMs = this.clock();
    const attrs = mergeAttrs(this.attrs, options.attrs);
    const completed: CompletedTraceSpan = {
      context: this.context,
      name: this.name,
      surface: this.surface,
      kind: this.kind,
      status,
      startTimeMs: this.startTimeMs,
      endTimeMs,
      durationMs: Math.max(0, endTimeMs - this.startTimeMs),
      ...(attrs ? { attrs } : {}),
      events: [...this.events],
    };
    this.sink.recordSpanFact?.({ span: completed });
    this.sink.record(completed);
  }
}

function mergeAttrs(base: TraceAttributes | undefined, extra: TraceAttributes | undefined): TraceAttributes | undefined {
  if (!base) return extra;
  if (!extra) return base;
  return { ...base, ...extra };
}

function addOptionalStringAttr(attrs: TraceAttributes, key: TraceScopeAttrKey, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (!normalized) return;
  attrs[key] = normalized;
}

function addPresenceAttr(
  attrs: TraceAttributes,
  key: TraceScopeAttrKey,
  value: string | null | undefined,
  explicitPresent?: boolean | null,
): void {
  attrs[key] = typeof explicitPresent === "boolean" ? explicitPresent : Boolean(value?.trim());
}

function generateTraceId(): string {
  return randomNonZeroHex(TRACE_ID_HEX_LENGTH);
}

function generateSpanId(): string {
  return randomNonZeroHex(SPAN_ID_HEX_LENGTH);
}

function randomNonZeroHex(length: number): string {
  let value = randomHex(length);
  while (value === "0".repeat(length)) {
    value = randomHex(length);
  }
  return value;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
