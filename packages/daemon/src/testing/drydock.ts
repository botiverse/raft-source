import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";

export { FakeClock } from "./fakeClock.js";

const DEFAULT_EVENT_TIMEOUT_MS = 1_000;
const DEFAULT_CHILD_EVENT_TIMEOUT_MS = 15_000;

export interface EventProbe<T> {
  readonly events: readonly T[];
  record(event: T): void;
  waitFor(predicate: (event: T) => boolean, label: string): Promise<T>;
}

export interface EventProbeOptions {
  timeoutMs?: number;
}

export interface ChildProcessEventProbeOptions extends EventProbeOptions {
  processName?: string;
}

interface EventProbeLifecycle {
  child: ChildProcess;
  processName: string;
}

function createEventProbeInternal<T>(
  timeoutMs: number,
  lifecycle: EventProbeLifecycle | null,
): EventProbe<T> {
  const events: T[] = [];
  const emitter = new EventEmitter();

  return {
    events,
    record(event) {
      events.push(event);
      emitter.emit("event", event);
    },
    waitFor(predicate, label) {
      const existingIndex = events.findIndex(predicate);
      if (existingIndex >= 0) return Promise.resolve(events[existingIndex]);

      return new Promise<T>((resolve, reject) => {
        let timer: unknown = null;

        const cleanup = (): void => {
          if (timer !== null) clearClockTimeout(timer);
          emitter.off("event", onEvent);
          lifecycle?.child.off("error", onError);
          lifecycle?.child.off("close", onClose);
        };
        const succeed = (event: T): void => {
          cleanup();
          resolve(event);
        };
        const fail = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onEvent = (event: T): void => {
          try {
            if (predicate(event)) succeed(event);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const onError = (error: Error): void => {
          fail(error);
        };
        const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          fail(new Error(`${lifecycle?.processName ?? "Child process"} closed before ${label} (code=${code}, signal=${signal})`));
        };

        emitter.on("event", onEvent);
        lifecycle?.child.once("error", onError);
        lifecycle?.child.once("close", onClose);

        if (lifecycle && (lifecycle.child.exitCode !== null || lifecycle.child.signalCode !== null)) {
          onClose(lifecycle.child.exitCode, lifecycle.child.signalCode);
          return;
        }

        timer = setClockTimeout(() => {
          fail(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
      });
    },
  };
}

/**
 * Records semantic events and waits on their emission boundary rather than
 * polling shared state. Events recorded before a waiter is armed are replayed.
 */
export function createEventProbe<T>(options: EventProbeOptions = {}): EventProbe<T> {
  return createEventProbeInternal(options.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS, null);
}

/**
 * Event probe for a real child process. Missing events fail closed on child
 * error, child exit, or a generous real-time upper bound.
 */
export function createChildProcessEventProbe<T>(
  child: ChildProcess,
  options: ChildProcessEventProbeOptions = {},
): EventProbe<T> {
  return createEventProbeInternal(options.timeoutMs ?? DEFAULT_CHILD_EVENT_TIMEOUT_MS, {
    child,
    processName: options.processName ?? "Child process",
  });
}

const DEFAULT_STATE_TIMEOUT_MS = 1_000;
const DEFAULT_STATE_POLL_MS = 5;

export interface StateWaiterOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Complement to the event probe, for the case where the event stream is not
 * ours to control: the test already owns the state (an array the driver
 * appends to, a flag a callback flips) and wiring every producer into
 * `record()` would cost more than the wait is worth. Event-boundary
 * observation above remains the preferred form — this is the fallback, not a
 * replacement for it.
 *
 * The predicate MUST be monotone: once true it stays true. Sampling cannot see
 * a condition that holds only between two samples, and no amount of diagnostic
 * cleverness recovers it after the fact — so a non-monotone predicate is a
 * defect at the call site, not something this waiter can rescue. For counting
 * waits use `waitForCount` / `waitForExactCount` below, which are monotone by
 * construction or say so when they are not.
 */
export async function waitForState(
  predicate: () => boolean,
  label: string,
  options: StateWaiterOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STATE_POLL_MS;
  const deadline = currentTimeMs() + timeoutMs;

  for (;;) {
    if (predicate()) return;
    if (currentTimeMs() >= deadline) {
      throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms, predicate never observed true)`);
    }
    await new Promise<void>((resolve) => { setClockTimeout(() => resolve(), pollIntervalMs); });
  }
}

/**
 * Monotone counting wait: `>= atLeast` cannot become false again on an
 * append-only source, so a slow sampler can never step over the window in
 * which it was true.
 */
export async function waitForCount(
  getCount: () => number,
  atLeast: number,
  label: string,
  options: StateWaiterOptions = {},
): Promise<void> {
  await waitForState(() => getCount() >= atLeast, `${label} (count >= ${atLeast})`, options);
}

/**
 * Exact-count wait that refuses to fail silently.
 *
 * `count === N` is NOT monotone on a growing source: the (N+1)th arrival makes
 * it false again, and if both land inside one poll interval the true window is
 * never sampled. The wait then times out looking exactly like "the events
 * never happened" — the failure this whole primitive exists to prevent.
 *
 * So this waits on the monotone `>= expected` and only then compares. If the
 * source overshot, the error says the count was exceeded and reports what was
 * observed, which distinguishes "never reached" from "sampled past it". A
 * caller that sees the overshoot message has a real defect — either the
 * expectation is wrong or the wait is racing a producer — and is told which.
 */
export async function waitForExactCount(
  getCount: () => number,
  expected: number,
  label: string,
  options: StateWaiterOptions = {},
): Promise<void> {
  try {
    await waitForState(() => getCount() >= expected, `${label} (count >= ${expected})`, options);
  } catch {
    throw new Error(
      `Timed out waiting for ${label}: count never reached ${expected} (last observed ${getCount()})`,
    );
  }
  const observed = getCount();
  if (observed !== expected) {
    // Deliberately does not say WHEN the count passed `expected`: this waiter
    // samples, so it cannot know whether the overshoot happened before its
    // first read or between the two. Reporting a moment it did not observe
    // would be the same overclaim this primitive exists to prevent.
    throw new Error(
      `${label}: observed ${observed}, expected exactly ${expected}. `
        + `A sampling wait cannot tell an overshoot that happened before its first `
        + `read from one that happened between reads, so exact counts are reported `
        + `here rather than left to time out.`,
    );
  }
}
