import { isDeepStrictEqual } from "node:util";

// One sampler owns IPC reads and display polling. Invalidating a sample never
// starts an overlapping read: wait for it, discard it, then sample again.
export function createStatusMonitor<T>(options: {
  read: () => Promise<T>;
  publish: (status: T) => void;
  intervalMs: number;
}) {
  let pending: { revision: number; value: Promise<T> } | null = null;
  let revision = 0;
  let lastPublished: T | undefined;
  let hasPublished = false;
  let active = false;
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function requestRead(): { revision: number; value: Promise<T> } {
    if (pending) return pending;
    const request: { revision: number; value: Promise<T> } = {
      revision,
      value: Promise.resolve().then(() => {
        request.revision = revision;
        return options.read();
      }),
    };
    pending = request;
    const clear = () => { if (pending === request) pending = null; };
    void request.value.then(clear, clear);
    return request;
  }

  // Validate at consumption, after the promise settles. Poll publications and
  // IPC responses must use the same boundary: invalidation can happen between
  // the underlying read completing and its promise continuation running.
  async function consumeCurrent<R>(consume: (status: T) => R): Promise<R> {
    for (;;) {
      const request = requestRead();
      let status: T;
      try {
        status = await request.value;
      } catch (error) {
        if (request.revision !== revision) continue;
        throw error;
      }
      if (request.revision === revision) return consume(status);
    }
  }

  function read(): Promise<T> { return consumeCurrent((status) => status); }

  async function tick() {
    if (polling || !active) return;
    polling = true;
    try {
      await consumeCurrent((status) => {
        if (!active) return;
        if (!hasPublished || !isDeepStrictEqual(lastPublished, status)) {
          options.publish(status);
          lastPublished = status;
          hasPublished = true;
        }
      });
    } catch {
      // Transient failures must not end polling or poison subsequent IPC pulls.
    } finally {
      polling = false;
      if (active) timer = setTimeout(() => void tick(), options.intervalMs);
    }
  }

  function refresh() {
    revision += 1;
    clearTimeout(timer);
    timer = undefined;
    if (active) void tick();
  }

  function setActive(next: boolean) {
    if (active === next) return;
    active = next;
    clearTimeout(timer);
    timer = undefined;
    if (active) {
      // A restored/new window needs fresh data even if a pre-hide read exists.
      hasPublished = false;
      refresh();
    }
  }

  async function afterOperation<R>(operation: () => Promise<R>): Promise<R> {
    try {
      return await operation();
    } finally {
      // Failed operations can also have changed part of the service state.
      refresh();
    }
  }

  return { read, setActive, refresh, afterOperation };
}
