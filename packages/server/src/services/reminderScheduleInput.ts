const REMINDER_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
const REMINDER_MAX_DELAY_SECONDS = Math.floor(REMINDER_MAX_HORIZON_MS / 1000);
const REMINDER_FIRE_AT_WARN_HORIZON_MS = 24 * 60 * 60 * 1000;

export interface ScheduleInput {
  delaySeconds?: unknown;
  fireAt?: unknown;
}

export type ScheduleInputResult =
  | { ok: true; fireAt: Date; warning?: string }
  | { ok: false; error: string };

/**
 * Resolve `delay_seconds | fire_at` into an authoritative UTC fire time.
 *
 * Agent local clocks are not trusted as UTC — if both `delaySeconds` and
 * `fireAt` are supplied we reject (XOR). When only `fireAt` is supplied and
 * it lands > 24h out, we attach a non-blocking warning so the caller can
 * self-check for timezone mistakes (e.g. local time serialized as `Z`).
 */
export function resolveScheduleInput(
  input: ScheduleInput,
  nowMs: number,
): ScheduleInputResult {
  const hasDelay = input.delaySeconds !== undefined && input.delaySeconds !== null;
  const hasFireAt = input.fireAt !== undefined && input.fireAt !== null;

  if (hasDelay && hasFireAt) {
    return { ok: false, error: "Provide either delaySeconds or fireAt, not both" };
  }
  if (!hasDelay && !hasFireAt) {
    return {
      ok: false,
      error: "Provide delaySeconds (preferred for relative times) or fireAt (ISO-8601 UTC)",
    };
  }

  if (hasDelay) {
    const d = input.delaySeconds;
    if (typeof d !== "number" || !Number.isFinite(d) || !Number.isInteger(d)) {
      return { ok: false, error: "delaySeconds must be an integer" };
    }
    if (d <= 0) {
      return { ok: false, error: "delaySeconds must be positive" };
    }
    if (d > REMINDER_MAX_DELAY_SECONDS) {
      return { ok: false, error: "delaySeconds must be within 1 year" };
    }
    return { ok: true, fireAt: new Date(nowMs + d * 1000) };
  }

  if (typeof input.fireAt !== "string") {
    return { ok: false, error: "fireAt must be an ISO-8601 UTC string" };
  }
  const fireAtDate = new Date(input.fireAt);
  if (Number.isNaN(fireAtDate.getTime())) {
    return { ok: false, error: "fireAt must be a valid ISO-8601 timestamp" };
  }
  const delta = fireAtDate.getTime() - nowMs;
  if (delta <= 0) {
    return { ok: false, error: "fireAt must be in the future" };
  }
  if (delta > REMINDER_MAX_HORIZON_MS) {
    return { ok: false, error: "fireAt must be within 1 year" };
  }
  if (delta > REMINDER_FIRE_AT_WARN_HORIZON_MS) {
    return {
      ok: true,
      fireAt: fireAtDate,
      warning: `fireAt is ${Math.round(delta / 3600_000)}h in the future — if this was meant to be relative ("in N seconds/minutes"), use delaySeconds instead; agent local clock is not trusted as UTC.`,
    };
  }
  return { ok: true, fireAt: fireAtDate };
}
