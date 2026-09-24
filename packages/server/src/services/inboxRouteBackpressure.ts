import {
  clearClockTimeout,
  currentTimeMs,
  setClockTimeout,
} from "@botiverse/raft-shared";

export type InboxBackpressureRejectReason = "queue_full" | "queue_timeout" | "request_aborted";

export class InboxBackpressureRejectedError extends Error {
  readonly code = "INBOX_BACKPRESSURE";

  constructor(readonly reason: InboxBackpressureRejectReason) {
    super(`Inbox request rejected by route backpressure: ${reason}`);
    this.name = "InboxBackpressureRejectedError";
  }
}

export type InboxBackpressureSnapshot = {
  active: number;
  queued: number;
  maxConcurrency: number;
  maxQueue: number;
  admittedTotal: number;
  queuedTotal: number;
  rejectedTotal: number;
  timedOutTotal: number;
  maxObservedActive: number;
  maxObservedQueued: number;
};

export type InboxBackpressureLease = {
  queued: boolean;
  waitMs: number;
  snapshot: InboxBackpressureSnapshot;
  release(): void;
};

type PendingAcquire = {
  enqueuedAt: number;
  resolve: (lease: InboxBackpressureLease) => void;
  reject: (error: InboxBackpressureRejectedError) => void;
  timeout: unknown;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type InboxRouteBackpressureOptions = {
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  now?: () => number;
};

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonnegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return value;
}

export class InboxRouteBackpressure {
  readonly maxConcurrency: number;
  readonly maxQueue: number;
  readonly queueTimeoutMs: number;
  private readonly now: () => number;
  private readonly pending: PendingAcquire[] = [];
  private active = 0;
  private admittedTotal = 0;
  private queuedTotal = 0;
  private rejectedTotal = 0;
  private timedOutTotal = 0;
  private maxObservedActive = 0;
  private maxObservedQueued = 0;

  constructor(options: InboxRouteBackpressureOptions) {
    this.maxConcurrency = requirePositiveInteger("maxConcurrency", options.maxConcurrency);
    this.maxQueue = requireNonnegativeInteger("maxQueue", options.maxQueue);
    this.queueTimeoutMs = requirePositiveInteger("queueTimeoutMs", options.queueTimeoutMs);
    this.now = options.now ?? currentTimeMs;
  }

  snapshot(): InboxBackpressureSnapshot {
    return {
      active: this.active,
      queued: this.pending.length,
      maxConcurrency: this.maxConcurrency,
      maxQueue: this.maxQueue,
      admittedTotal: this.admittedTotal,
      queuedTotal: this.queuedTotal,
      rejectedTotal: this.rejectedTotal,
      timedOutTotal: this.timedOutTotal,
      maxObservedActive: this.maxObservedActive,
      maxObservedQueued: this.maxObservedQueued,
    };
  }

  acquire(options: { signal?: AbortSignal } = {}): Promise<InboxBackpressureLease> {
    if (options.signal?.aborted) {
      this.rejectedTotal += 1;
      return Promise.reject(new InboxBackpressureRejectedError("request_aborted"));
    }
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      this.admittedTotal += 1;
      this.maxObservedActive = Math.max(this.maxObservedActive, this.active);
      return Promise.resolve(this.createLease(false, this.now()));
    }
    if (this.pending.length >= this.maxQueue) {
      this.rejectedTotal += 1;
      return Promise.reject(new InboxBackpressureRejectedError("queue_full"));
    }

    const enqueuedAt = this.now();
    this.queuedTotal += 1;
    return new Promise<InboxBackpressureLease>((resolve, reject) => {
      const pending: PendingAcquire = {
        enqueuedAt,
        resolve,
        reject,
        timeout: setClockTimeout(() => {
          if (!this.removePending(pending)) return;
          this.timedOutTotal += 1;
          this.rejectedTotal += 1;
          this.detachAbort(pending);
          reject(new InboxBackpressureRejectedError("queue_timeout"));
        }, this.queueTimeoutMs),
        signal: options.signal,
      };
      if (options.signal) {
        pending.onAbort = () => {
          if (!this.removePending(pending)) return;
          clearClockTimeout(pending.timeout);
          this.rejectedTotal += 1;
          this.detachAbort(pending);
          reject(new InboxBackpressureRejectedError("request_aborted"));
        };
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.push(pending);
      this.maxObservedQueued = Math.max(this.maxObservedQueued, this.pending.length);
    });
  }

  private createLease(queued: boolean, startedAt: number): InboxBackpressureLease {
    let released = false;
    return {
      queued,
      waitMs: queued ? Math.max(0, this.now() - startedAt) : 0,
      snapshot: this.snapshot(),
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrency) {
      const pending = this.pending.shift();
      if (!pending) return;
      clearClockTimeout(pending.timeout);
      this.detachAbort(pending);
      if (pending.signal?.aborted) {
        this.rejectedTotal += 1;
        pending.reject(new InboxBackpressureRejectedError("request_aborted"));
        continue;
      }
      this.active += 1;
      this.admittedTotal += 1;
      this.maxObservedActive = Math.max(this.maxObservedActive, this.active);
      pending.resolve(this.createLease(true, pending.enqueuedAt));
    }
  }

  private removePending(pending: PendingAcquire): boolean {
    const index = this.pending.indexOf(pending);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  private detachAbort(pending: PendingAcquire): void {
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function createDefaultInboxRouteBackpressure(): InboxRouteBackpressure {
  return new InboxRouteBackpressure({
    maxConcurrency: readBoundedInteger("INBOX_ROUTE_MAX_CONCURRENCY", 4, 1, 32),
    maxQueue: readBoundedInteger("INBOX_ROUTE_MAX_QUEUE", 16, 0, 256),
    queueTimeoutMs: readBoundedInteger("INBOX_ROUTE_QUEUE_TIMEOUT_MS", 1_000, 50, 10_000),
  });
}
