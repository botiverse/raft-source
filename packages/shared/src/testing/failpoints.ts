export type MaybePromise<T> = T | Promise<T>;

export type FailpointMode = "off" | "once" | "n_times" | "always";
export type FailpointEffect = "throw" | "delay" | "drop" | "return";

export interface FailpointSpec {
  mode?: FailpointMode;
  effect: FailpointEffect;
  payload?: unknown;
  count?: number;
}

export interface FailpointTraceEntry<TContext = unknown> {
  seq: number;
  key: string;
  mode: Exclude<FailpointMode, "off">;
  effect: FailpointEffect;
  payload?: unknown;
  context: TContext;
  remainingAfterHit: number | null;
}

export interface FailpointRegistry {
  readonly enabled: boolean;
  isEnabled(key?: string): boolean;
  configure(key: string, spec: FailpointSpec): void;
  clear(key?: string): void;
  getTrace(): readonly FailpointTraceEntry[];
  hit<T>(key: string, context?: unknown, fallback?: () => MaybePromise<T>): MaybePromise<T | undefined>;
}

interface ActiveFailpointSpec {
  mode: Exclude<FailpointMode, "off">;
  effect: FailpointEffect;
  payload?: unknown;
  remaining: number | null;
}

export interface InMemoryFailpointRegistryOptions {
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_DELAY_MS = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFailpointSpec(spec: FailpointSpec): ActiveFailpointSpec | null {
  const mode = spec.mode ?? "once";
  switch (mode) {
    case "off":
      return null;
    case "once":
      return { mode, effect: spec.effect, payload: spec.payload, remaining: 1 };
    case "always":
      return { mode, effect: spec.effect, payload: spec.payload, remaining: null };
    case "n_times": {
      const count = typeof spec.count === "number" && Number.isInteger(spec.count) ? spec.count : 0;
      if (count <= 0) {
        return null;
      }
      return { mode, effect: spec.effect, payload: spec.payload, remaining: count };
    }
  }
}

function toThrownError(key: string, payload: unknown): Error {
  if (payload instanceof Error) {
    return payload;
  }
  if (typeof payload === "string" && payload.length > 0) {
    return new Error(payload);
  }
  return new Error(`Failpoint "${key}" triggered throw`);
}

function toDelayMs(payload: unknown): number {
  return typeof payload === "number" && Number.isFinite(payload) && payload >= 0 ? payload : DEFAULT_DELAY_MS;
}

class NoopFailpointRegistry implements FailpointRegistry {
  get enabled(): boolean {
    return false;
  }

  isEnabled(): boolean {
    return false;
  }

  configure(): void {}

  clear(): void {}

  getTrace(): readonly FailpointTraceEntry[] {
    return [];
  }

  hit<T>(_key: string, _context?: unknown, fallback?: () => MaybePromise<T>): MaybePromise<T | undefined> {
    return fallback ? fallback() : undefined;
  }
}

export const noopFailpointRegistry: FailpointRegistry = new NoopFailpointRegistry();

export class InMemoryFailpointRegistry implements FailpointRegistry {
  private readonly specs = new Map<string, ActiveFailpointSpec>();
  private readonly trace: FailpointTraceEntry[] = [];
  private nextSeq = 1;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: InMemoryFailpointRegistryOptions = {}) {
    this.sleepImpl = options.sleep ?? sleep;
  }

  get enabled(): boolean {
    return this.specs.size > 0;
  }

  isEnabled(key?: string): boolean {
    if (!key) {
      return this.enabled;
    }
    return this.specs.has(key);
  }

  configure(key: string, spec: FailpointSpec): void {
    const normalized = normalizeFailpointSpec(spec);
    if (!normalized) {
      this.specs.delete(key);
      return;
    }
    this.specs.set(key, normalized);
  }

  clear(key?: string): void {
    if (key) {
      this.specs.delete(key);
      return;
    }
    this.specs.clear();
    this.trace.length = 0;
    this.nextSeq = 1;
  }

  getTrace(): readonly FailpointTraceEntry[] {
    return this.trace;
  }

  hit<T>(key: string, context?: unknown, fallback?: () => MaybePromise<T>): MaybePromise<T | undefined> {
    const spec = this.specs.get(key);
    if (!spec) {
      return fallback ? fallback() : undefined;
    }

    const remainingAfterHit = spec.remaining == null ? null : Math.max(0, spec.remaining - 1);

    this.trace.push({
      seq: this.nextSeq++,
      key,
      mode: spec.mode,
      effect: spec.effect,
      payload: spec.payload,
      context,
      remainingAfterHit,
    });

    if (spec.remaining != null) {
      if (remainingAfterHit === 0) {
        this.specs.delete(key);
      } else {
        spec.remaining = remainingAfterHit;
      }
    }

    switch (spec.effect) {
      case "throw":
        throw toThrownError(key, spec.payload);
      case "drop":
        return undefined;
      case "return":
        return spec.payload as T;
      case "delay": {
        const ms = toDelayMs(spec.payload);
        return (async () => {
          await this.sleepImpl(ms);
          return fallback ? await fallback() : undefined;
        })();
      }
    }
  }
}

export let failpoints: FailpointRegistry = noopFailpointRegistry;

export function __setFailpointsForTests(registry: FailpointRegistry): void {
  failpoints = registry;
}

export function __resetFailpointsForTests(): void {
  failpoints = noopFailpointRegistry;
}
