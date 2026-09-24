import { createHash } from "node:crypto";
import {
  clearClockTimeout,
  currentTimeMs,
  setClockTimeout,
} from "@botiverse/raft-shared";
import type { AppId } from "./rapRegistry.js";
import {
  getInstalledApp,
  raiseDueEvent,
  type HookDispatch,
} from "./rapRegistryStore.js";
import type {
  RapTimerCancelInput,
  RapTimerScheduleInput,
  RapTimerScheduleReceipt,
  RapTimerSeam,
} from "./rapSyscalls.js";

export const RAP_TIMER_MAX_DATA_BYTES = 4_096;
const RAP_TIMER_MAX_SOURCE_ID_BYTES = 512;
const MAX_PLATFORM_DELAY_MS = 2_147_483_647;

export interface RapTimerClock {
  now(): number;
  arm(callback: () => void, delayMs: number): unknown;
  disarm(handle: unknown): void;
}

export interface RapTimerDispatch {
  raiseDue(input: {
    serverId: string;
    appId: AppId;
    subjectAgentId: string;
    data: unknown;
  }): Promise<HookDispatch | void>;
}

export interface RapTimerDispatchReceipt {
  readonly timerId: RapTimerScheduleReceipt["timerId"];
  readonly serverId: string;
  readonly appId: AppId;
  readonly subjectAgentId: string;
  readonly hook: "onDue";
  readonly outcome: HookDispatch;
}

interface TimerEntry {
  readonly key: string;
  readonly timerId: RapTimerScheduleReceipt["timerId"];
  readonly input: Omit<RapTimerScheduleInput, "data">;
  readonly serializedData: string;
  handle?: unknown;
}

export interface RapTimerRuntimeOptions {
  clock?: RapTimerClock;
  dispatch?: RapTimerDispatch;
  onError?: (error: unknown) => void;
  /** Observation seam for the completed real timer callback. */
  onDueDispatch?: (receipt: RapTimerDispatchReceipt) => void;
}

/**
 * Server-internal timer runtime. `isArmed` is an observation surface for the
 * reconciliation pass; it is deliberately not part of the App-facing
 * `RapTimerSeam` / manifest syscall contract.
 */
export interface RapTimerRuntime extends RapTimerSeam {
  isArmed(input: RapTimerScheduleInput): boolean;
}

const productionClock: RapTimerClock = {
  now: currentTimeMs,
  arm(callback, delayMs) {
    const handle = setClockTimeout(callback, delayMs);
    if (
      typeof handle === "object"
      && handle !== null
      && "unref" in handle
      && typeof handle.unref === "function"
    ) {
      handle.unref();
    }
    return handle;
  },
  disarm: clearClockTimeout,
};

const productionDispatch: RapTimerDispatch = {
  async raiseDue(input) {
    const installed = await getInstalledApp(input.serverId, input.appId);
    if (!installed) throw new Error("RAP_TIMER_APP_NOT_INSTALLED_AT_FIRE");
    const outcome = await raiseDueEvent(
      input.serverId,
      input.appId,
      installed.manifest,
      { subjectAgentId: input.subjectAgentId, data: input.data },
    );
    if (outcome.kind !== "called") {
      throw new Error(`RAP_TIMER_DUE_DISPATCH_${outcome.kind.toUpperCase()}`);
    }
    return outcome;
  },
};

function timerKey(input: RapTimerCancelInput): string {
  // JSON length-prefixes/escapes every component, including sourceId. A naked
  // NUL-joined tuple would collide if a caller supplied a NUL in sourceId.
  return JSON.stringify([
    input.serverId,
    input.appId,
    input.subjectAgentId,
    input.sourceId,
  ]);
}

function timerIdForKey(key: string): RapTimerScheduleReceipt["timerId"] {
  const digest = createHash("sha256").update("rap-timer-v1\0").update(key).digest("hex");
  return `rap_timer_${digest}` as RapTimerScheduleReceipt["timerId"];
}

function assertScheduleInput(input: RapTimerScheduleInput): string {
  if (!Number.isSafeInteger(input.fireAtMs) || input.fireAtMs < 0) {
    throw new Error("RAP_TIMER_FIRE_AT_INVALID");
  }
  assertSourceId(input.sourceId);
  if (!isJsonValue(input.data, new Set(), 0)) {
    throw new Error("RAP_TIMER_DATA_INVALID");
  }
  const serialized = JSON.stringify(input.data);
  if (Buffer.byteLength(serialized, "utf8") > RAP_TIMER_MAX_DATA_BYTES) {
    throw new Error("RAP_TIMER_DATA_TOO_LARGE");
  }
  return serialized;
}

function assertSourceId(sourceId: string): void {
  if (
    sourceId.length === 0
    || Buffer.byteLength(sourceId, "utf8") > RAP_TIMER_MAX_SOURCE_ID_BYTES
  ) {
    throw new Error("RAP_TIMER_SOURCE_ID_INVALID");
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    // JSON.stringify turns holes into null and ignores extra/symbol properties.
    // Reject both rather than storing bytes different from the caller's value.
    const keys = Object.keys(value);
    valid = Object.getOwnPropertySymbols(value).length === 0
      && keys.length === value.length
      && keys.every((key) => /^(0|[1-9][0-9]*)$/.test(key))
      && value.every((child, index) =>
        Object.prototype.hasOwnProperty.call(value, index)
        && isJsonValue(child, ancestors, depth + 1));
  } else {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    valid = (prototype === Object.prototype || prototype === null)
      && Object.getOwnPropertySymbols(value).length === 0
      && Object.values(descriptors).every((descriptor) =>
        descriptor.enumerable === true
        && "value" in descriptor
        && isJsonValue(descriptor.value, ancestors, depth + 1));
  }
  ancestors.delete(value);
  return valid;
}

export function createRapTimerRuntime(options: RapTimerRuntimeOptions = {}): RapTimerRuntime {
  const clock = options.clock ?? productionClock;
  const dispatch = options.dispatch ?? productionDispatch;
  const onError = options.onError ?? ((error: unknown) => {
    console.error("[rapTimerRuntime] due dispatch failed:", error);
  });
  const entries = new Map<string, TimerEntry>();

  const arm = (entry: TimerEntry): void => {
    const remaining = Math.max(0, entry.input.fireAtMs - clock.now());
    entry.handle = clock.arm(() => {
      void wake(entry).catch(onError);
    }, Math.min(remaining, MAX_PLATFORM_DELAY_MS));
  };

  const wake = async (entry: TimerEntry): Promise<void> => {
    // Disarming is not a fence: an old callback may already be queued when
    // an upsert replaces it. Object identity proves this is still the current
    // entry for the four-tuple.
    if (entries.get(entry.key) !== entry) return;
    if (clock.now() < entry.input.fireAtMs) {
      arm(entry);
      return;
    }

    // Delete before the side effect. Even if the app hook throws, this logical
    // one-shot cannot fire twice. Durable recovery/progression belongs to the
    // app row plus boot reconciliation, not this local callback.
    entries.delete(entry.key);
    const outcome = await dispatch.raiseDue({
      serverId: entry.input.serverId,
      appId: entry.input.appId,
      subjectAgentId: entry.input.subjectAgentId,
      data: JSON.parse(entry.serializedData) as unknown,
    });
    if (outcome) {
      options.onDueDispatch?.({
        timerId: entry.timerId,
        serverId: entry.input.serverId,
        appId: entry.input.appId,
        subjectAgentId: entry.input.subjectAgentId,
        hook: "onDue",
        outcome,
      });
    }
  };

  return {
    isArmed(input) {
      const serializedData = assertScheduleInput(input);
      const entry = entries.get(timerKey(input));
      return entry?.input.fireAtMs === input.fireAtMs
        && entry.serializedData === serializedData;
    },
    async schedule(input) {
      const serializedData = assertScheduleInput(input);
      const key = timerKey(input);
      const previous = entries.get(key);
      if (previous?.handle !== undefined) clock.disarm(previous.handle);
      const entry: TimerEntry = {
        key,
        timerId: timerIdForKey(key),
        input: {
          serverId: input.serverId,
          appId: input.appId,
          subjectAgentId: input.subjectAgentId,
          fireAtMs: input.fireAtMs,
          sourceId: input.sourceId,
        },
        serializedData,
      };
      entries.set(key, entry);
      arm(entry);
      return { timerId: entry.timerId, nextFireAt: input.fireAtMs };
    },
    async cancel(input) {
      assertSourceId(input.sourceId);
      const key = timerKey(input);
      const entry = entries.get(key);
      if (!entry) return "not_found";
      entries.delete(key);
      if (entry.handle !== undefined) clock.disarm(entry.handle);
      return "cancelled";
    },
  };
}

export const productionRapTimerRuntime = createRapTimerRuntime();
export const productionRapTimerSeam: RapTimerSeam = productionRapTimerRuntime;
